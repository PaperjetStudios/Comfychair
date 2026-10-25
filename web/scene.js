// 3D tab: block out a shot (soft mannequins, boxes, a room, a camera move) and render it as a depth
// video for H3's Fun ControlNet (deck-h3-ctrl2v). Near is white and far is black, like Depth
// Anything, and the range is fixed over the whole clip so the depth doesn't flicker.
// It works like the Editor: a layer list (Camera, Room, objects), the selected layer's settings under
// it, and a gizmo on the selected object (Move / Rotate / Scale; tap it again to switch). The view is
// the shot camera. Anything with keyframes is animated, and changing it writes a key at the playhead.
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import * as FIGURE from './figure.js';
import { $, h, store, uid, clone, api, busy as busyBar, toast, undoToast, openSheet, closeSheet, sheetOpen, button, iconBtn, seg, field,
  section, hint, rangeField, propNum, layerRowsEl, panelTop, nameSheet } from './ui.js';

let C;  // app state and actions handed over by app.js (see sceneModule there)
const FPS = 24;
// the same length as the H3 templates' "Seconds to frames (24 fps, 17k+5 grid)" node
const framesFor = (sec) => { const n = Math.max(5, Math.round(sec * FPS)); return n + (((5 - n % 17) % 17) + 17) % 17; };
const OBJ = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
const CAM = ['px', 'py', 'pz', 'tx', 'ty', 'tz', 'fov'];
const SIZES = [[768, 448], [448, 768], [1024, 576], [576, 1024], [832, 480], [480, 832], [1280, 720], [720, 1280], [768, 768]];
const TYPES = {
  person: { label: 'Person', icon: '🧍', size: [0.45, 1.75, 0.28] },
  child: { label: 'Child', icon: '🧒', size: [0.32, 1.2, 0.2], geo: 'person' },
  box: { label: 'Box', icon: '▭', size: [1.2, 0.75, 0.7] },
  ball: { label: 'Ball', icon: '●', size: [0.6, 0.6, 0.6] },
  cylinder: { label: 'Cylinder', icon: '⬮', size: [0.5, 1, 0.5] },
  wall: { label: 'Wall', icon: '▯', size: [3, 2.6, 0.12], geo: 'box' },
  // these two scale evenly (sx = sy = sz): a posable figure (figure.js) and a picture as a mesh (MoGe)
  figure: { label: 'Posable person', icon: '🤸', size: [1, 1, 1] },
  photo: { label: 'Photo', icon: '🖼', size: [1, 1, 1] },
};
const EVEN = new Set(['figure', 'photo']);
// what's keyed: a figure's keys also hold its pose (j: joint rotations, m: parameters on top)
const FIG = [...OBJ, 'j', 'm', 'pn'];  // pn: the pose's name, for a prompt
const namesFor = (o) => (o.type === 'figure' ? FIG : OBJ);
const MODES = [['translate', '✥ Move', 'w'], ['rotate', '⟳ Rotate', 'e'], ['scale', '⤢ Scale', 'r']];
const ROOM = 'room';  // R.sel for the room; null is the camera
// where the gizmo sits on an object (what it turns and scales around), in the object's own space
const PIVOTS = {
  figure: [['feet', 'Feet'], ['hips', 'Hips'], ['com', 'Centre of mass'], ['head', 'Head']],
  photo: [['origin', 'Lens'], ['center', 'Centre']],
  other: [['base', 'Base'], ['center', 'Centre'], ['top', 'Top']],
};
const pivotsFor = (o) => PIVOTS[o.type] || PIVOTS.other;
const pivotOf = (o) => (pivotsFor(o).some(([k]) => k === o.pivot) || (o.type === 'figure' && FIGURE.JOINTS[o.pivot]) ? o.pivot
  : o.type === 'figure' ? 'hips' : o.type === 'photo' ? 'center' : 'base');

// ---- scene data ------------------------------------------------------------
let SC;   // the scene (persisted per project)
const R = { f: 0, sel: null, joint: null, figTab: 'pose', poseCat: 'stand', mask: 'all', sym: false, speed: 1, inPlace: false, mode: 'translate', playing: false, depth: false, autoKey: true, meshes: new Map(), room: [], applying: false, lastRender: null };

const newRoom = () => ({ w: 8, d: 8, h: 2.8, walls: true, ceiling: true, hidden: false });
function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, blur: 2, room: newRoom(),
    camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, keys: [], ease: 'smooth' },
    objects: [newObject('person', { x: 0, z: 0 }, [])],
  };
}

function newObject(type, at = {}, others = SC.objects) {
  const t = TYPES[type];
  const n = others.filter((o) => o.type === type).length + 1;
  const o = { id: uid(), type, name: `${t.label} ${n}`, ease: 'smooth', keys: [], hidden: false,
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
  if (type === 'figure') { o.base.j = FIGURE.preset('stand').j; o.ground = true; }
  return o;
}

// scenes saved before rotation on all axes, hiding and a deletable room
function upgrade(sc) {
  for (const o of sc.objects) {
    o.base = { rx: 0, rz: 0, ...o.base }; o.hidden = !!o.hidden;
    if (o.type === 'figure' && o.ground == null) o.ground = false;  // planted on the floor: older figures kept their own height
  }
  if (sc.room) sc.room = { ceiling: false, hidden: false, ...sc.room };
  return sc;
}

const sceneKey = () => `deck.scene.${C.S.project ?? 'none'}`;
function load() {
  const sc = store.get(sceneKey(), null);
  SC = sc && sc.v === 1 ? upgrade(sc) : defaultScene();
  R.sel = null; R.f = Math.min(R.f, frames() - 1);
  resetHistory();
}

// undo / redo: the scene as JSON after each saved change
const HIST = { undo: [], redo: [], cur: null };
function resetHistory() { TEMP.clear(); HIST.undo = []; HIST.redo = []; HIST.cur = JSON.stringify(SC); renderToolbar(); }
function remember() {
  const s = JSON.stringify(SC);
  if (s === HIST.cur) return;
  HIST.undo.push(HIST.cur);
  if (HIST.undo.length > 100) HIST.undo.shift();
  HIST.redo = []; HIST.cur = s;
  renderToolbar();
}
function undo(back = true) {
  const [from, to] = back ? [HIST.undo, HIST.redo] : [HIST.redo, HIST.undo];
  if (!from.length) return;
  stopPlay();
  to.push(HIST.cur); HIST.cur = from.pop();
  SC = JSON.parse(HIST.cur); TEMP.clear(); R.joint = null;
  if (R.sel === ROOM ? !SC.room : R.sel && !selItem()) R.sel = null;
  R.f = Math.min(R.f, frames() - 1);
  save(true); rebuildRoom(); refresh(); renderToolbar(); renderTransport(); renderPanel(); fit();
}

let saveTimer;
function save(now = false) {  // the key and scene are taken now, so a project switch can't misfile it
  remember();
  clearTimeout(saveTimer);
  const key = sceneKey(), sc = SC;
  if (now) store.set(key, sc); else saveTimer = setTimeout(() => store.set(key, sc), 300);
}

const frames = () => framesFor(SC.seconds);
const ease = (t) => t * t * (3 - 2 * t);
const pick = (o, names) => Object.fromEntries(names.map((n) => [n, o[n]]));

// an item's values at frame f: its keys eased in between, held before the first and after the last
function sample(item, names, f) {
  const k = item.keys;
  if (!k.length) return pick(item.base, names);
  if (f <= k[0].f) return pick({ ...item.base, ...k[0] }, names);
  const last = k[k.length - 1];
  if (f >= last.f) return pick({ ...item.base, ...last }, names);
  let i = 0;
  while (k[i + 1].f <= f) i++;
  const a = { ...item.base, ...k[i] }, b = { ...item.base, ...k[i + 1] };
  const t = (f - a.f) / (b.f - a.f), e = (k[i].ease || item.ease) === 'linear' ? t : ease(t);  // a key can set its own ease
  return Object.fromEntries(names.map((n) => [n, n === 'j' ? FIGURE.slerpPose(a.j, b.j, e) : n === 'm' ? FIGURE.lerpParams(a.m, b.m, e)
    : n === 'pn' ? (e < 0.5 ? a.pn : b.pn) : a[n] + (b[n] - a[n]) * e]));
}

// With auto key off, a change to an animated item isn't saved: it's held here (by item, for the
// frame it was made on) until the playhead moves, and ◆ Key keeps it.
const TEMP = new Map();
// an item's values at frame f, with a held change on top
function current(item, names, f = R.f) {
  const t = item.keys.length ? TEMP.get(item) : null;
  return t && t.f === f ? pick(t.v, names) : sample(item, names, f);
}

// write values: into the key at the playhead when the item is animated, else into its base
function write(item, names, vals) {
  if (!item.keys.length) { Object.assign(item.base, vals); return; }
  if (!R.autoKey) { TEMP.set(item, { f: R.f, v: { ...current(item, names), ...vals } }); return; }
  let k = item.keys.find((x) => x.f === R.f);
  if (!k) { k = { f: R.f, ...sample(item, names, R.f) }; item.keys.push(k); item.keys.sort((a, b) => a.f - b.f); }
  Object.assign(k, vals);
}

function addKey(item, names, vals = current(item, names)) {
  TEMP.delete(item);
  if (!item.keys.length) Object.assign(item.base, vals);
  const k = item.keys.find((x) => x.f === R.f);
  if (k) Object.assign(k, vals); else { item.keys.push({ f: R.f, ...vals }); item.keys.sort((a, b) => a.f - b.f); }
}

const selItem = () => SC.objects.find((o) => o.id === R.sel) || null;
// what ◆ Key acts on: the selected object, else the camera (the room isn't animated)
const keyTarget = () => { const o = selItem(); return o ? [o, namesFor(o)] : R.sel === ROOM ? [null, null] : [SC.camera, CAM]; };

// ---- geometry ----------------------------------------------------------------
// A soft, featureless figure turned on a lathe: feet, legs as one column, hips, waist, chest,
// neck and head in one smooth outline. Unit size (1 wide, 1 tall, base at y=0), scaled per object.
const PERSON_PROFILE = [[0, 0], [0.27, 0], [0.29, 0.02], [0.25, 0.08], [0.28, 0.27], [0.36, 0.45], [0.4, 0.52],
  [0.33, 0.63], [0.44, 0.73], [0.5, 0.8], [0.4, 0.83], [0.11, 0.855], [0.12, 0.875], [0.18, 0.91], [0.185, 0.95],
  [0.13, 0.99], [0, 1]];
let GEO;
function geometries() {
  if (GEO) return GEO;
  const curve = new THREE.SplineCurve(PERSON_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
  GEO = {
    person: new THREE.LatheGeometry(curve.getPoints(80), 48),
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    ball: new THREE.SphereGeometry(0.5, 40, 24).translate(0, 0.5, 0),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 40).translate(0, 0.5, 0),
  };
  return GEO;
}

// ---- three.js ------------------------------------------------------------------
let renderer, scene, camera, controls, gizmo, grid, canvas, viewer;
const clay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9 });
const claySel = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x5c5c5c, roughness: 1, side: THREE.DoubleSide });
const wallMat = new THREE.MeshStandardMaterial({ color: 0x7c7c7c, roughness: 1, side: THREE.DoubleSide });
const roomSel = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 1, side: THREE.DoubleSide });
const figClay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9, flatShading: true });
const figSel = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8, flatShading: true });
const dotMat = new THREE.MeshBasicMaterial({ color: 0x4cc3ff, depthTest: false, transparent: true, opacity: 0.85 });
const dotSel = new THREE.MeshBasicMaterial({ color: 0xff4c8a, depthTest: false, transparent: true, opacity: 0.95 });
const ikTarget = new THREE.Object3D();  // what the gizmo drags when a hand or foot is moved (IK)
// what the gizmo holds for a whole object: at its pivot, turned and scaled with it. pivotAt is the
// pivot in the object's own space, kept still while dragging.
const pivot = new THREE.Object3D(), pivotAt = new THREE.Vector3();
const VERT = 'varying float vz; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }';
const depthMat = new THREE.ShaderMaterial({
  uniforms: { near: { value: 0.5 }, far: { value: 20 } }, side: THREE.DoubleSide, vertexShader: VERT,
  fragmentShader: 'uniform float near; uniform float far; varying float vz;'
    + 'void main() { float d = (1.0 / max(vz, 1e-3) - 1.0 / far) / (1.0 / near - 1.0 / far);'
    + ' gl_FragColor = vec4(vec3(pow(clamp(d, 0.0, 1.0), 0.8)), 1.0); }',
});
// first export pass: linear depth packed into RGB (alpha 1 marks a hit), to find the clip's
// nearest and farthest points
const RANGE = 400;
const rangeMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide, vertexShader: VERT,
  fragmentShader: `varying float vz; void main() { float d = clamp(vz / ${RANGE}.0, 0.0, 0.9999);`
    + ' vec3 e = fract(d * vec3(1.0, 255.0, 65025.0)); e -= e.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);'
    + ' gl_FragColor = vec4(e, 1.0); }',
});

function setup() {
  viewer = $('#sceneViewer');
  canvas = $('#sceneCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(1);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x24272e);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  grid = new THREE.GridHelper(40, 40, 0x3c4048, 0x30333a);
  grid.position.y = 0.002;
  scene.add(grid);
  camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 500);
  camera.layers.enable(1);  // layer 1: a figure's joint dots (picked on their own, never rendered out)
  scene.add(ikTarget, pivot);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.addEventListener('change', () => { if (!R.applying) draw(); });
  controls.addEventListener('end', () => {
    if (R.playing) return;
    const c = readCamera(), was = current(SC.camera, CAM);
    if (CAM.every((n) => Math.abs(c[n] - was[n]) < 1e-6)) return;  // a tap, not a move: no key
    write(SC.camera, CAM, c);  // with auto key off on an animated camera, only held (see TEMP)
    save(); renderKeys(); if (!R.sel) renderPanel();
  });

  gizmo = new TransformControls(camera, canvas);
  gizmo.setSize(1.15);
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('change', () => { if (!R.applying) draw(); });
  gizmo.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (!e.value) { save(); renderKeys(); renderPanel(); }
  });
  gizmo.addEventListener('objectChange', () => {
    const o = selItem(), m = gizmo.object;
    if (!o || !m) return;
    if (R.joint) return jointChanged(o);
    const p = pivot;
    if (EVEN.has(o.type)) {  // scaled evenly: follow whichever axis was dragged
      const was = current(o, OBJ).sy, s = [p.scale.x, p.scale.y, p.scale.z].find((v) => Math.abs(v - was) > 1e-6) ?? was;
      p.scale.setScalar(Math.max(0.01, s));
    }
    // the object follows the pivot: turned and scaled around it
    m.quaternion.copy(p.quaternion); m.scale.copy(p.scale);
    m.position.copy(p.position).sub(pivotAt.clone().multiply(p.scale).applyQuaternion(p.quaternion));
    const d = THREE.MathUtils.radToDeg;
    write(o, namesFor(o), { x: m.position.x, y: m.position.y, z: m.position.z,
      rx: d(m.rotation.x), ry: d(m.rotation.y), rz: d(m.rotation.z),
      sx: Math.max(0.01, m.scale.x), sy: Math.max(0.01, m.scale.y), sz: Math.max(0.01, m.scale.z) });
  });

  // a tap (not a drag, not on a gizmo handle) selects what's under it; tapping the selected
  // object again switches the gizmo between Move, Rotate and Scale. On a selected figure, a tap on
  // a joint dot picks the joint; a tap on its body goes back to the whole figure.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, onGizmo: gizmo.dragging || gizmo.axis != null }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || down.onGizmo || R.playing || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
    down = null;
    const joint = jointAt(e);
    if (joint) return selectJoint(joint);
    const id = hitAt(e);
    if (id && id === R.sel && R.joint) selectJoint(null);
    else if (id && id === R.sel && id !== ROOM) setMode(MODES[(MODES.findIndex(([m]) => m === R.mode) + 1) % MODES.length][0]);
    else select(id);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  viewer.append(h('div', { id: 'sceneToolbar', class: 'layer-toolbar scene-toolbar', role: 'toolbar', 'aria-label': 'Gizmo' },
    ...MODES.map(([m, label, key]) => h('button', { type: 'button', 'data-mode': m, title: `${label.slice(2)} (${key.toUpperCase()})`,
      onclick: () => setMode(m) }, label)),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-depth': '', title: 'Show the depth the render will use',
      onclick: () => { R.depth = !R.depth; draw(); renderToolbar(); } }, '◐ Depth'),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-undo': '', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => undo() }, '↶'),
    h('button', { type: 'button', 'data-redo': '', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => undo(false) }, '↷')));

  document.addEventListener('keydown', (e) => {
    if (!$('#tab-scene').classList.contains('active') || sheetOpen()
      || e.target.closest('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') { e.preventDefault(); undo(k === 'z' && !e.shiftKey); }
      return;
    }
    const m = MODES.find(([, , k]) => k === e.key.toLowerCase());
    if (m) { e.preventDefault(); setMode(m[0]); }
    else if (e.key.toLowerCase() === 'k') { e.preventDefault(); setAutoKey(!R.autoKey); }
    else if (e.key === 'Escape') { if (R.joint) selectJoint(null); else select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {  // a frame; with Shift, to the next key
      e.preventDefault(); stopPlay();
      const fwd = e.key === 'ArrowRight', [item] = keyTarget();
      const k = e.shiftKey && item ? (fwd ? item.keys.find((x) => x.f > R.f) : item.keys.findLast((x) => x.f < R.f)) : null;
      seek(k ? k.f : e.shiftKey ? R.f : R.f + (fwd ? 1 : -1));
    }
  });

  new ResizeObserver(() => fit()).observe(viewer);
}

function readCamera() {
  return { px: camera.position.x, py: camera.position.y, pz: camera.position.z,
    tx: controls.target.x, ty: controls.target.y, tz: controls.target.z, fov: camera.fov };
}

// the canvas keeps the output's aspect, as large as fits in the viewer
function fit() {
  if (!viewer) return;
  const vw = viewer.clientWidth, vh = viewer.clientHeight;
  if (!vw || !vh) return;
  const a = SC.width / SC.height;
  const w = Math.min(vw, vh * a), hh = w / a;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${w}px`; canvas.style.height = `${hh}px`;
  canvas.style.left = `${(vw - w) / 2}px`; canvas.style.top = `${(vh - hh) / 2}px`;
  renderer.setSize(Math.round(w * dpr), Math.round(hh * dpr), false);
  camera.aspect = a; camera.updateProjectionMatrix();
  draw();
}

function rebuildRoom() {
  for (const m of R.room) scene.remove(m);
  R.room = [];
  const rm = SC.room;
  if (!rm) return;
  const { w, d, h } = rm;
  R.room.push(new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), floorMat));
  if (rm.walls) {
    R.room.push(
      new THREE.Mesh(new THREE.PlaneGeometry(w, h).translate(0, h / 2, -d / 2), wallMat),
      new THREE.Mesh(new THREE.PlaneGeometry(d, h).rotateY(Math.PI / 2).translate(-w / 2, h / 2, 0), wallMat),
      new THREE.Mesh(new THREE.PlaneGeometry(d, h).rotateY(-Math.PI / 2).translate(w / 2, h / 2, 0), wallMat));
    if (rm.ceiling) R.room.push(new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2).translate(0, h, 0), wallMat));
  }
  for (const m of R.room) { m.userData.id = ROOM; scene.add(m); }
}

// a layer's three.js object: a mesh, a figure's rig (userData.rig, its root group), or a group the
// photo's mesh loads into
function makeObject(o) {
  let m;
  if (o.type === 'figure') {
    const rig = FIGURE.buildFigure(figClay, dotMat);
    m = rig.root; m.userData.rig = rig;
    for (const p of rig.meshes) p.userData.id = o.id;
  } else if (o.type === 'photo') {
    m = new THREE.Group(); loadPhoto(o, m);
  } else m = new THREE.Mesh(geometries()[TYPES[o.type].geo || o.type], clay);
  m.userData.id = o.id; scene.add(m); R.meshes.set(o.id, m);
  return m;
}
function paint(m, on) {  // a photo keeps its picture
  if (m.userData.rig) for (const p of m.userData.rig.meshes) p.material = on ? figSel : figClay;
  else if (m.isMesh) m.material = on ? claySel : clay;
}

// ---- photos: a picture as a mesh (MoGe, made by /api/scene/photo), in glTF axes: the photo's camera
// at the object's origin looking down its -Z, so placing the object places that camera
const gltf = new GLTFLoader();
const photoScenes = new Map();  // url: Promise of the loaded mesh, shared by every copy
function photoScene(url) {
  if (!photoScenes.has(url)) {
    photoScenes.set(url, gltf.loadAsync(url).then((g) => {
      g.scene.traverse((c) => {  // the picture as it is: unlit, both sides
        if (c.isMesh) c.material = new THREE.MeshBasicMaterial({ map: c.material.map, side: THREE.DoubleSide });
      });
      return g.scene;
    }).catch((e) => { photoScenes.delete(url); throw e; }));
  }
  return photoScenes.get(url);
}
function loadPhoto(o, group) {
  photoScene(o.url).then((src) => {
    if (R.meshes.get(o.id) !== group) return;
    const s = src.clone();
    s.traverse((c) => { if (c.isMesh) { c.userData.id = o.id; c.userData.photo = true; } });
    group.add(s); draw();
  }).catch((e) => toast(`${o.name}: ${e.message}`, true));
}
// the photo's vertical field of view and how far its middle is, from the mesh (camera at the origin)
function photoLens(src) {
  let t = 0;
  const p = new THREE.Vector3(), box = new THREE.Box3().setFromObject(src);
  src.traverse((c) => {
    const a = c.isMesh && c.geometry.attributes.position;
    if (a) for (let i = 0; i < a.count; i += 7) { p.fromBufferAttribute(a, i); if (p.z < -1e-4) t = Math.max(t, Math.abs(p.y / p.z)); }
  });
  return { fov: t ? THREE.MathUtils.radToDeg(2 * Math.atan(t)) : 50, dist: Math.max(0.3, -box.getCenter(p).z) };
}
// the shot camera where the photo was taken (and with its lens)
function lookThrough(o) {
  const v = current(o, OBJ), r = THREE.MathUtils.degToRad;
  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(r(v.rx), r(v.ry), r(v.rz)));
  const t = fwd.multiplyScalar((o.dist || 3) * v.sy).add(new THREE.Vector3(v.x, v.y, v.z));
  write(SC.camera, CAM, { px: v.x, py: v.y, pz: v.z, tx: t.x, ty: t.y, tz: t.z, fov: o.fov || 50 });
}

// put a "3d photo" generation into the scene where the shot camera is, seen through its lens
export async function addPhoto(g) {
  if (!ready) { load(); setup(); ready = true; showAll(); }
  const out = g.outputs.find((x) => /\.glb$/i.test(x.filename));
  if (!out) return toast('That run has no 3D mesh', true);
  let lens;
  try { lens = photoLens(await photoScene(out.url)); } catch (e) { return toast(e.message, true); }
  const d = THREE.MathUtils.radToDeg, c = camera;
  const o = newObject('photo', { x: c.position.x, y: c.position.y, z: c.position.z,
    rx: d(c.rotation.x), ry: d(c.rotation.y), rz: d(c.rotation.z) });
  Object.assign(o, { url: out.url, gen: g.id, image: g.params.image, fov: +lens.fov.toFixed(2), dist: +lens.dist.toFixed(3) });
  o.name = `Photo #${g.id}`;
  SC.objects.push(o);
  lookThrough(o);
  save(); select(o.id);
  toast('Photo added: small camera moves look best (nothing is behind what the picture shows)');
}

// picture in, MoGe in ComfyUI, mesh into the scene
async function makePhoto(name) {
  const bar = busyBar('Making 3D from the picture…');
  try {
    let g = await api('/api/scene/photo', { method: 'POST', body: { image: name, project_id: C.S.project } });
    for (let i = 0; i < 300 && !['done', 'error', 'interrupted'].includes(g.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      g = await api(`/api/generations/${g.id}`, { busy: false });
    }
    if (g.status !== 'done') throw new Error(g.error || 'MoGe didn\'t finish');
    await addPhoto(g);
  } catch (e) { toast(e.message, true); } finally { bar.done(); }
}

// ---- figures: a joint picked on the selected figure (R.joint) gets the gizmo: Rotate turns it,
// Move on a hand or foot drags the limb with IK
const jointMode = () => (FIGURE.IK[R.joint] && R.mode === 'translate' ? 'translate' : 'rotate');
const selRig = () => R.meshes.get(R.sel)?.userData.rig || null;
function selectJoint(name) {
  R.joint = name;
  if (name) R.figTab = 'joint';
  if (name) R.mode = FIGURE.IK[name] ? 'translate' : 'rotate';
  refresh(); renderToolbar(); renderPanel();
}
function placeIkTarget() {
  const rig = selRig();
  if (!rig) return;
  rig.root.updateMatrixWorld(true);
  rig.bones[R.joint].getWorldPosition(ikTarget.position);
  ikTarget.updateMatrixWorld();
}
// the selected object's pivot, in its own space (the figure's pose and the photo's mesh move it)
function pivotPoint(o, m) {
  const k = pivotOf(o), rig = m.userData.rig;
  m.updateMatrixWorld(true);
  if (rig) {
    if (k === 'feet') return new THREE.Vector3();
    return m.worldToLocal(k === 'com' ? FIGURE.centerOfMass(rig) : rig.bones[k].getWorldPosition(new THREE.Vector3()));
  }
  if (o.type === 'photo') {
    const box = new THREE.Box3().setFromObject(m);
    return k === 'center' && !box.isEmpty() ? m.worldToLocal(box.getCenter(new THREE.Vector3())) : new THREE.Vector3();
  }
  return new THREE.Vector3(0, { base: 0, center: 0.5, top: 1 }[k], 0);  // the shapes are 1 tall, base at 0
}
function placePivot() {
  const o = selItem(), m = o && R.meshes.get(o.id);
  if (!m) return;
  pivotAt.copy(pivotPoint(o, m));
  pivot.position.copy(m.localToWorld(pivotAt.clone()));
  pivot.quaternion.copy(m.quaternion); pivot.scale.copy(m.scale);
  pivot.updateMatrixWorld();
}
function jointChanged(o) {
  const rig = selRig();
  if (!rig) return;
  const names = gizmo.object === ikTarget ? FIGURE.solveIK(rig, R.joint, ikTarget.position) : [R.joint];
  const j = { ...current(o, FIG).j };
  for (const n of names) j[n] = FIGURE.readJoint(rig, n);
  if (R.sym) {  // the other side follows, mirrored
    for (const n of names) {
      const opp = FIGURE.opposite(n);
      if (opp && !names.includes(opp)) { j[opp] = FIGURE.mirrorQ(j[n]); FIGURE.setJoint(rig, opp, j[opp]); }
    }
  }
  write(o, FIG, { j });
}

function syncMeshes() {
  const ids = new Set(SC.objects.map((o) => o.id));
  for (const [id, m] of R.meshes) if (!ids.has(id)) { scene.remove(m); R.meshes.delete(id); }
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id) || makeObject(o);
    paint(m, o.id === R.sel);
    m.visible = !o.hidden;
  }
  for (const m of R.room) {
    m.visible = !SC.room.hidden;
    m.material = R.sel === ROOM ? roomSel : m === R.room[0] ? floorMat : wallMat;
  }
  const o = selItem();
  const m = o && !o.hidden ? R.meshes.get(o.id) : null;
  if (R.joint && !m?.userData.rig) R.joint = null;
  const target = !m ? null : !R.joint ? pivot : jointMode() === 'translate' ? ikTarget : m.userData.rig.bones[R.joint];
  if (target) {
    if (gizmo.object !== target) gizmo.attach(target);
    gizmo.setMode(R.joint ? jointMode() : R.mode);
    gizmo.setSpace(R.joint && jointMode() === 'rotate' ? 'local' : 'world');
  } else gizmo.detach();
}

// a figure's walk or run steps along with how far it has moved (unless set by hand), so its feet
// don't slide: the step phase is the distance covered over the stride length
const PATHS = new Map();  // figure: { sig, d: metres covered by each frame }
function travelled(o, f) {
  const sig = o.ease + o.keys.map((k) => `${k.f},${k.x},${k.z},${k.ease || ''}`).join('|');
  let p = PATHS.get(o);
  if (!p || p.sig !== sig || p.d.length < frames()) {
    const d = [0];
    let prev = sample(o, OBJ, 0);
    for (let i = 1; i < frames(); i++) { const v = sample(o, OBJ, i); d.push(d[i - 1] + Math.hypot(v.x - prev.x, v.z - prev.z)); prev = v; }
    p = { sig, d }; PATHS.set(o, p);
  }
  return p.d[Math.min(f, p.d.length - 1)] || 0;
}
function stepped(o, m, f) {
  if (!m || !(m.walk || m.run) || o.stepsFollow === false) return m;
  return { ...m, phase: travelled(o, f) / (FIGURE.strideLength(m) * current(o, OBJ, f).sy) };
}

// put every object and the camera where they are at frame f
function pose(f) {
  const r = THREE.MathUtils.degToRad;
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id);
    if (!m) continue;
    const v = current(o, namesFor(o), f);
    m.position.set(v.x, v.y, v.z);
    m.rotation.set(r(v.rx), r(v.ry), r(v.rz));
    if (EVEN.has(o.type)) m.scale.setScalar(Math.max(0.01, v.sy));
    else m.scale.set(Math.max(0.01, v.sx), Math.max(0.01, v.sy), Math.max(0.01, v.sz));
    if (m.userData.rig) FIGURE.applyPose(m.userData.rig, v.j, stepped(o, v.m, f), o.ground);
  }
  if (gizmo.object === ikTarget && !gizmo.dragging) placeIkTarget();
  if (gizmo.object === pivot && !gizmo.dragging) placePivot();
  const c = current(SC.camera, CAM, f);
  R.applying = true;
  camera.position.set(c.px, c.py, c.pz);
  controls.target.set(c.tx, c.ty, c.tz);
  camera.fov = c.fov; camera.updateProjectionMatrix();
  controls.update();
  R.applying = false;
}

// helpers (grid, gizmo) only in the editing view, never in a render
function draw(forRender = false) {
  if (!renderer) return;
  const depth = R.depth || forRender === 'depth';
  scene.overrideMaterial = depth ? depthMat : null;
  scene.background.set(depth ? 0x000000 : 0x24272e);
  grid.visible = !forRender && !depth;
  gizmo.getHelper().visible = !forRender && !R.playing && !!gizmo.object;
  const dots = !forRender && !depth && !R.playing;
  for (const [id, m] of R.meshes) {
    for (const d of m.userData.rig?.dots || []) { d.visible = dots && id === R.sel; d.material = d.userData.joint === R.joint ? dotSel : dotMat; }
  }
  if (!forRender) {
    if (depth) setRange(roughRange());
    renderer.render(scene, camera);
  }
}

function refresh() { syncMeshes(); pose(R.f); draw(); }

const visibleMeshes = () => [...[...R.meshes.values()].filter((m) => m.visible), ...R.room.filter((m) => m.visible)];

// a rough near/far for the live depth view (the export measures the real one)
function roughRange() {
  const box = new THREE.Box3();
  for (const m of visibleMeshes()) box.expandByObject(m);
  if (box.isEmpty()) return [0.3, 10];
  const p = camera.position, corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(p.distanceTo(new THREE.Vector3(x, y, z)));
  return [Math.max(0.3, box.distanceToPoint(p) * 0.8 || 0.3), Math.max(...corners, 1)];
}
function setRange([near, far]) { depthMat.uniforms.near.value = near; depthMat.uniforms.far.value = far; }

const ray = new THREE.Raycaster();
function hitAt(e) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  // the room and photos only block: tapping them deselects (pick them in the layer list)
  const hit = ray.intersectObjects(visibleMeshes(), true)[0];
  return hit && hit.object.userData.id !== ROOM && !hit.object.userData.photo ? hit.object.userData.id : null;
}
// the selected figure's joint dot under the pointer (within a finger's reach). Where dots overlap,
// the one nearest the camera wins; anything else in front of it takes the tap instead. Turn the view
// to get at one that's covered.
function jointAt(e) {
  const rig = selRig();
  if (!rig || !rig.root.visible) return null;
  const r = canvas.getBoundingClientRect(), reach = e.pointerType === 'touch' ? 28 : 18;
  rig.root.updateMatrixWorld(true);
  let best = null;
  for (const d of rig.dots) {
    const w = d.getWorldPosition(new THREE.Vector3()), v = w.clone().project(camera);
    if (v.z > 1) continue;
    const dist = Math.hypot(r.left + (v.x + 1) / 2 * r.width - e.clientX, r.top + (1 - v.y) / 2 * r.height - e.clientY);
    const depth = camera.position.distanceTo(w);
    if (dist < reach && (!best || depth < best.depth)) best = { joint: d.userData.joint, depth };
  }
  if (!best) return null;
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const front = ray.intersectObjects(visibleMeshes().filter((m) => m !== rig.root), true)[0];
  return front && front.distance < best.depth ? null : best.joint;
}

// ---- selection, layers ------------------------------------------------------------
function select(id) { R.sel = id; R.joint = null; refresh(); renderToolbar(); renderKeys(); renderPanel(); }
function setMode(m) { R.mode = m; refresh(); renderToolbar(); }
function setAutoKey(on) {
  R.autoKey = on; store.set('deck.scene.autokey', on);
  const b = $('#sceneAutoKey');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
}

function changed() { save(); refresh(); renderKeys(); renderPanel(); }

function removeSelected() {
  const before = clone(SC), sel = R.sel;
  let name;
  if (sel === ROOM) { name = 'Room'; SC.room = null; rebuildRoom(); }
  else { const o = selItem(); if (!o) return; name = o.name; SC.objects = SC.objects.filter((x) => x !== o); }
  R.sel = null; R.joint = null; changed(); renderToolbar();
  undoToast(`${name} deleted`, () => { SC = before; R.sel = sel; rebuildRoom(); changed(); renderToolbar(); });
}

function addObject(type) {
  closeSheet();
  if (type === ROOM) { SC.room = newRoom(); rebuildRoom(); select(ROOM); save(); return; }
  const c = controls.target;
  const o = newObject(type, { x: +c.x.toFixed(2), z: +(type === 'wall' ? c.z - 2 : c.z).toFixed(2) });
  SC.objects.push(o); save(); select(o.id);
}

function layerList() {
  const keys = (it) => (it.keys.length ? `${it.keys.length} key${it.keys.length > 1 ? 's' : ''}` : '');
  const hideBtn = (it, after) => iconBtn(it.hidden ? 'Show' : 'Hide', it.hidden ? '◌' : '◉', () => { it.hidden = !it.hidden; after(); });
  const rows = [{ sel: !R.sel, thumb: h('span', { class: 'scene-icon' }, '🎥'), name: 'Camera',
    hint: [`${SC.width}×${SC.height} · ${SC.seconds} s`, keys(SC.camera)].filter(Boolean).join(' · '), onclick: () => select(null) }];
  if (SC.room) {
    rows.push({ sel: R.sel === ROOM, off: SC.room.hidden, thumb: h('span', { class: 'scene-icon' }, '⌂'), name: 'Room',
      hint: `${SC.room.w}×${SC.room.d} m${SC.room.hidden ? ' · hidden' : ''}`, onclick: () => select(R.sel === ROOM ? null : ROOM),
      buttons: [hideBtn(SC.room, changed)] });
  }
  for (const o of [...SC.objects].reverse()) {
    rows.push({ sel: o.id === R.sel, off: o.hidden, thumb: h('span', { class: 'scene-icon' }, TYPES[o.type].icon), name: o.name,
      hint: [TYPES[o.type].label, keys(o), o.hidden ? 'hidden' : ''].filter(Boolean).join(' · '),
      onclick: () => select(o.id === R.sel ? null : o.id), buttons: [hideBtn(o, changed)] });
  }
  return layerRowsEl(rows);
}

// ---- playback ----------------------------------------------------------------------
let raf = 0;
function play() {
  if (R.playing) return stopPlay();
  R.playing = true; TEMP.clear();
  let t0 = performance.now(), f0 = R.f >= frames() - 1 ? 0 : R.f;
  const step = (now) => {
    if (!R.playing) return;
    R.f = Math.floor(f0 + (now - t0) / 1000 * FPS);
    if (R.f >= frames()) { R.f = 0; f0 = 0; t0 = now; }
    pose(R.f); draw(); renderTime();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  renderTransport();
}
function stopPlay() { if (!R.playing) return; R.playing = false; cancelAnimationFrame(raf); renderTransport(); renderPanel(); draw(); }
function seek(f) {
  f = Math.max(0, Math.min(frames() - 1, Math.round(f)));
  if (f !== R.f) TEMP.clear();  // held changes (auto key off) stay on their frame
  R.f = f; pose(R.f); draw(); renderTime(); renderKeys(); renderPanel();
}

// ---- export ----------------------------------------------------------------------
const decodeDepth = (r, g, b) => r / 255 + g / 65025 + b / 16581375;  // rangeMat's packing, undone

function measureRange() {
  const W = 128, H = Math.max(8, Math.round(128 * SC.height / SC.width));
  const rt = new THREE.WebGLRenderTarget(W, H);
  const buf = new Uint8Array(W * H * 4);
  draw('range');
  const bg = scene.background; scene.background = null;
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = rangeMat;
  let near = Infinity, far = 0;
  for (let f = 0; f < frames(); f++) {
    pose(f);
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] < 128) continue;  // nothing drawn here
      const z = decodeDepth(buf[i], buf[i + 1], buf[i + 2]) * RANGE;
      if (z < near) near = z;
      if (z > far) far = z;
    }
  }
  renderer.setRenderTarget(null); rt.dispose();
  scene.background = bg;
  if (!isFinite(near)) throw new Error('Nothing in view');
  return [Math.max(0.05, near * 0.97), far * 1.03];
}

function targetToBlob(rt, W, H, gray) {
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {  // WebGL rows run bottom-up
    const src = (H - 1 - y) * W * 4, dst = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      img.data[dst + x] = buf[src + x];
      img.data[dst + x + 1] = gray ? buf[src + x] : buf[src + x + 1];
      img.data[dst + x + 2] = gray ? buf[src + x] : buf[src + x + 2];
      img.data[dst + x + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

let busy = false;
async function renderDepthVideo() {
  if (busy) return;
  busy = true; stopPlay(); TEMP.clear(); renderPanel();  // only what's keyed goes in the render
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering depth frames…');
  try {
    setRange(measureRange());
    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.NoColorSpace });
    draw('depth');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData();
    for (let f = 0; f < frames(); f++) {
      pose(f);
      renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
      form.append('frames', await targetToBlob(rt, W, H, true), `f${String(f).padStart(5, '0')}.png`);
      if (f % 12 === 0) setStatus(`Rendering ${f + 1}/${frames()}…`);
      bar.set(null, (f + 1) / frames());
    }
    rt.dispose();
    await sendVideo(form, 'depth', SC.blur);
  } catch (e) {
    setStatus(''); toast(e.message, true);
  } finally {
    bar.done();
    busy = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

async function sendVideo(form, kind, blur) {
  form.append('fps', FPS); form.append('blur', blur); form.append('kind', kind); form.append('scene', JSON.stringify(SC));
  if (C.S.project != null) form.append('project_id', C.S.project);
  setStatus('Encoding…');
  R.lastRender = await api('/api/scene/render', { method: 'POST', form });
  const what = kind === 'pose' ? 'Pose video' : 'Depth video';
  setStatus(`${what} #${R.lastRender.id} is in History`);
  toast(`${what} saved`, false, { label: 'Use in H3 control', fn: () => C.useControlVideo(R.lastRender, SC) });
}

// the posable people as OpenPose stick figures (COCO 18, the colours ControlNet pose models expect)
async function renderPoseVideo() {
  const figs = SC.objects.filter((o) => o.type === 'figure' && !o.hidden);
  if (busy || !figs.length) return;
  busy = true; stopPlay(); TEMP.clear(); renderPanel();
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering pose frames…');
  try {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData();
    for (let f = 0; f < frames(); f++) {
      pose(f);
      camera.updateMatrixWorld();
      const people = figs.map((o) => FIGURE.keypoints(R.meshes.get(o.id).userData.rig).map((p) => {
        const v = p.project(camera);
        return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
      }));
      FIGURE.drawPose(ctx, people, W, H);
      form.append('frames', await new Promise((res) => cv.toBlob(res, 'image/png')), `f${String(f).padStart(5, '0')}.png`);
      if (f % 12 === 0) setStatus(`Rendering ${f + 1}/${frames()}…`);
      bar.set(null, (f + 1) / frames());
    }
    await sendVideo(form, 'pose', 0);
  } catch (e) {
    setStatus(''); toast(e.message, true);
  } finally {
    bar.done();
    busy = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

// a lit clay frame at the output size, as an input image (a start frame to restyle, for example)
async function saveFrame() {
  const W = SC.width, H = SC.height;
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
  const wasDepth = R.depth; R.depth = false;
  draw('clay');
  for (const m of R.meshes.values()) paint(m, false);
  for (const m of R.room) m.material = m === R.room[0] ? floorMat : wallMat;
  camera.aspect = W / H; camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const blob = await targetToBlob(rt, W, H, false);
  rt.dispose();
  R.depth = wasDepth; fit(); refresh();
  try {
    const r = await C.uploadImage(blob, { source: 'scene', filename: 'scene.png' });
    toast(`Saved frame as ${r.name.split('/').pop()}`);
  } catch (e) { toast(e.message, true); }
}

// ---- UI ----------------------------------------------------------------------
let statusText = '';
function setStatus(t) { statusText = t; const s = $('#sceneStatus'); if (s) s.textContent = t; }

function renderToolbar() {
  const tb = $('#sceneToolbar');
  if (!tb) return;
  const can = !!selItem();
  // a joint turns (Rotate); a hand or foot can also be dragged (Move, with IK)
  const ok = (m) => can && (!R.joint || m === 'rotate' || (m === 'translate' && !!FIGURE.IK[R.joint]));
  const mode = R.joint ? jointMode() : R.mode;
  tb.querySelectorAll('[data-mode]').forEach((b) => { b.classList.toggle('on', ok(b.dataset.mode) && b.dataset.mode === mode); b.disabled = !ok(b.dataset.mode); });
  tb.querySelector('[data-depth]').classList.toggle('on', R.depth);
  tb.querySelector('[data-undo]').disabled = !HIST.undo.length;
  tb.querySelector('[data-redo]').disabled = !HIST.redo.length;
}

function renderTime() {
  const t = $('#sceneTime');
  if (t) t.textContent = `${(R.f / FPS).toFixed(2)} s · ${R.f + 1}/${frames()}`;
  const ph = $('#scenePlayhead');
  if (ph) ph.style.left = lanePos(R.f);
}

// ---- key sheet: a row per layer (the camera, then the objects) with its keys on it. Drag a key
// along its row to retime it; tap or drag anywhere else on a row (or the ruler) to scrub.
const PAD = 8;  // px at each end of a row, so the first and last keys aren't cut off
const lanePos = (f) => `calc(${PAD}px + (100% - ${2 * PAD}px) * ${f / Math.max(1, frames() - 1)})`;
const tracks = () => [[SC.camera, null, '🎥 Camera'], ...SC.objects.map((o) => [o, o.id, `${TYPES[o.type].icon} ${o.name}`])];

function frameAt(e) {
  const r = $('#sceneLanes').getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - PAD) / (r.width - 2 * PAD))) * (frames() - 1));
}

let drag = null;
function laneDown(e) {
  if (e.button > 0 || busy) return;
  e.preventDefault();
  stopPlay();
  const lane = e.target.closest('[data-track]'), keyEl = e.target.closest('[data-key]');
  const [item, id] = lane ? tracks()[+lane.dataset.track] : [];
  e.currentTarget.setPointerCapture(e.pointerId);
  drag = keyEl ? { item, key: item.keys[+keyEl.dataset.key], x: e.clientX, moved: false } : { scrub: true };
  if (lane && id !== R.sel) select(id);
  if (!keyEl) seek(frameAt(e));
}
function laneMove(e) {
  if (!drag) return;
  const f = frameAt(e);
  if (drag.scrub) { if (f !== R.f) seek(f); return; }
  if (!drag.moved && Math.abs(e.clientX - drag.x) < 4) return;
  drag.moved = true;
  const { item, key } = drag;
  if (f === key.f || item.keys.some((k) => k !== key && k.f === f)) return;  // one key per frame
  key.f = f; item.keys.sort((a, b) => a.f - b.f); seek(f);
}
function laneUp() {
  const d = drag; drag = null;
  if (d && d.key) { if (d.moved) changed(); else seek(d.key.f); }
}

function renderKeys() {
  const lanes = $('#sceneLanes');
  if (!lanes) return;
  const n = Math.max(1, frames() - 1), ts = tracks();
  const ticks = [];
  for (let s = 0; s * FPS <= n; s++) ticks.push(h('span', { class: 'tick', style: `left:${lanePos(s * FPS)}` }, s));
  $('#sceneNames').replaceChildren(h('div', { class: 'sheet-head' }),
    ...ts.map(([it, id, label]) => h('button', { type: 'button', class: 'sheet-name' + (id === R.sel ? ' sel' : '') + (it.hidden ? ' off' : ''),
      title: label, onclick: () => select(id) }, label)));
  lanes.replaceChildren(h('div', { class: 'sheet-ruler' }, ...ticks),
    ...ts.map(([it, id], i) => h('div', { class: 'sheet-lane' + (id === R.sel ? ' sel' : ''), 'data-track': i },
      it.keys.length > 1 ? h('span', { class: 'span', style: `left:${lanePos(it.keys[0].f)};`
        + `width:calc((100% - ${2 * PAD}px) * ${(it.keys[it.keys.length - 1].f - it.keys[0].f) / n})` }) : null,
      ...it.keys.map((k, j) => h('span', { class: 'key' + (k.f === R.f ? ' on' : ''), 'data-key': j, style: `left:${lanePos(k.f)}`,
        title: `Key at ${(k.f / FPS).toFixed(2)} s · drag to move` })))),
    h('div', { id: 'scenePlayhead', class: 'playhead', style: `left:${lanePos(R.f)}` }));
  const [item] = keyTarget();
  const add = $('#sceneAddKey'), del = $('#sceneDelKey');
  if (add) add.disabled = !item;
  if (del) del.disabled = !item || !item.keys.some((k) => k.f === R.f);
  if (add) add.classList.toggle('pending', !!item && TEMP.has(item));  // a held change to keep
  const lbl = $('#sceneKeyFor');
  if (lbl) lbl.textContent = selItem() ? selItem().name : R.sel === ROOM ? 'Room (not animated)' : 'Camera';
}

function renderTransport() {
  const lanes = h('div', { id: 'sceneLanes', class: 'sheet-lanes' });
  lanes.addEventListener('pointerdown', laneDown);
  lanes.addEventListener('pointermove', laneMove);
  lanes.addEventListener('pointerup', laneUp);
  lanes.addEventListener('pointercancel', laneUp);
  $('#sceneTransport').replaceChildren(
    h('div', { class: 'row scene-keybar' },
      button(R.playing ? '❚❚ Pause' : '▶ Play', play, { cls: 'small primary', title: 'Play / pause (Space)' }),
      h('span', { id: 'sceneTime', class: 'timecode' }),
      h('span', { class: 'grow' }),
      button('● Auto key', () => setAutoKey(!R.autoKey), { id: 'sceneAutoKey', cls: 'small autokey' + (R.autoKey ? ' on' : ''), 'aria-pressed': R.autoKey,
        title: 'Auto key (K): on, a change to something animated sets a key at the playhead. Off, it shifts the whole animation (or edits the key under the playhead).' }),
      h('span', { class: 'hint' }, 'Key: ', h('b', { id: 'sceneKeyFor' })),
      button('◆ Key', () => {
        const [item, names] = keyTarget(); if (!item) return;
        addKey(item, names); changed();
      }, { id: 'sceneAddKey', title: 'Keyframe at the playhead' }),
      button('✕ Key', () => {
        const [item] = keyTarget(); if (!item) return;
        item.keys = item.keys.filter((k) => k.f !== R.f); changed();
      }, { id: 'sceneDelKey', title: 'Remove the key at the playhead' })),
    h('div', { class: 'scene-sheet' }, h('div', { id: 'sceneNames', class: 'sheet-names' }), lanes));
  renderTime(); renderKeys();
}

// a slider: the view follows while dragging, the change is saved on letting go
const slider = (label, get, set, opts) => rangeField(label, get, set,
  { ...opts, onInput: () => { pose(R.f); draw(); }, onChange: () => { save(); renderKeys(); } });
// a number box (drag it sideways like a slider: the view follows, the change is saved on letting go)
const num = (label, get, set, opts = {}) => propNum(label, +Number(get()).toFixed(opts.digits ?? 2), set,
  () => { if (opts.after) opts.after(); changed(); },
  { step: 'any', live: () => { if (opts.after) opts.after(); syncMeshes(); pose(R.f); draw(); }, ...opts });
const easeSeg = (item) => field('Between keys', seg([['smooth', 'Ease'], ['linear', 'Linear']], item.ease, (v) => { item.ease = v; changed(); }));
const clearKeys = (item, names) => (item.keys.length ? button('Clear keys', () => { Object.assign(item.base, current(item, names)); item.keys = []; changed(); }) : null);

function objectProps(o) {
  const names = namesFor(o);
  const cur = () => current(o, names);
  if (o.type !== 'figure') return section(TYPES[o.type].label, () => select(null), placeProps(o, cur));
  // a figure: its pose tools in tabs, big enough for fingers
  const tab = FIG_TABS.some(([k]) => k === R.figTab) ? R.figTab : 'pose';
  return section(o.name, () => select(null),
    seg(FIG_TABS, tab, (v) => { R.figTab = v; store.set('deck.scene.figtab', v); renderPanel(); }, { wrap: true }),
    { pose: posesTab, adjust: adjustTab, move: movesTab, joint: jointsTab, place: placeProps }[tab](o, cur));
}

// where it is, how big, its pivot; duplicate and delete
function placeProps(o, cur) {
  const names = namesFor(o);
  const set = (k) => (v) => write(o, names, { [k]: v });
  const even = (v) => write(o, names, { sx: v, sy: v, sz: v });
  const name = h('input', { type: 'text', value: o.name });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(); });
  const xyz = (label, ks, opts) => field(label,
    h('div', { class: 'row' }, ...ks.map(([k, l, o2]) => num(l, () => cur()[k], set(k), { ...opts, ...o2 }))));
  return [
    field('Name', name),
    xyz('Position (m)', [['x', 'X'], ['y', 'Up', { min: -5, max: 10 }], ['z', 'Z']], { min: -20, max: 20 }),
    xyz('Rotation (°)', [['rx', 'X'], ['ry', 'Y'], ['rz', 'Z']], { digits: 0, min: -180, max: 180, step: 1 }),
    o.type === 'figure' ? num('Height (m)', () => cur().sy * FIGURE.HEIGHT, (v) => even(Math.max(0.3, v) / FIGURE.HEIGHT), { min: 0.3, max: 2.5 })
      : o.type === 'photo' ? num('Scale', () => cur().sy, (v) => even(Math.max(0.05, v)), { min: 0.05, max: 20 })
      : xyz('Size (m)', [['sx', 'Width'], ['sy', 'Height'], ['sz', 'Depth']], { min: 0.05, max: 20 }),
    field('Pivot (where the gizmo turns it)', seg(pivotsFor(o), pivotsFor(o).some(([k]) => k === pivotOf(o)) ? pivotOf(o) : null,
      (v) => { o.pivot = v; changed(); }, { wrap: true })),
    o.type === 'figure' ? [
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!o.ground,
        onchange: (e) => { o.ground = e.target.checked; changed(); } }), 'Planted on the floor (Up lifts it off)'),
      button('🎥 Face the camera', () => {
        const v = cur(), c = current(SC.camera, CAM);
        write(o, names, { ry: Math.round(THREE.MathUtils.radToDeg(Math.atan2(c.px - v.x, c.pz - v.z))) }); changed();
      })] : null,
    o.type === 'photo' ? [
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      hint('The picture as a 3D mesh (MoGe). Keep camera moves small: nothing is behind what the picture shows. Render depth video, then use it with this picture as a reference.')] : null,
    easeSeg(o),
    h('div', { class: 'row wrap' },
      button('Duplicate', () => {
        const c = { ...clone(o), id: uid(), name: `${o.name} copy` };
        c.base.x += 0.6; c.keys.forEach((k) => { if (k.x != null) k.x += 0.6; });
        SC.objects.push(c); save(); select(c.id);
      }),
      clearKeys(o, names),
      button('Delete', removeSelected, { cls: 'small danger' })),
    hint('Drag the gizmo to move it; tap the object again (or W / E / R) for Rotate and Scale. With keys, a change sets a key at the playhead; with Auto key off it is held until ◆ Key (or until the playhead moves).')];
}

// a figure that isn't planted on the floor keeps its feet (or seat) where they were for a new pose
function liftTo(o, v, j, m) {
  if (o.ground) return {};
  return { y: v.y + (FIGURE.liftFor(j, m) - FIGURE.liftFor(v.j, v.m)) * v.sy };
}

// ---- a figure's pose tabs ----------------------------------------------------------------
const FIG_TABS = [['pose', '🧍 Poses'], ['adjust', '🎚 Adjust'], ['move', '🎬 Moves'], ['joint', '🦴 Joints'], ['place', '📐 Place']];
const SPEEDS = [[1.5, 'Slow'], [1, 'Normal'], [0.7, 'Fast']];
const UPPER = new Set(['spine', 'chest', 'neck', 'head', 'lsho', 'lelb', 'lhand', 'rsho', 'relb', 'rhand']);
const MINE = 'deck.figure.poses';  // poses saved by hand, in every project
let clip = null;  // a copied pose

// a stick-figure picture of a pose (or two people), kept once drawn
const THUMBS = new Map();
function thumb(key, people) {
  if (!THUMBS.has(key)) {
    const c = document.createElement('canvas'); c.width = c.height = 160;
    THUMBS.set(key, FIGURE.drawThumb(c, people).toDataURL());
  }
  return h('img', { src: THUMBS.get(key), alt: '', draggable: false });
}
const tile = (label, img, onclick, extra = null) => h('button', { type: 'button', class: 'pose-tile', title: label, onclick }, img, h('span', {}, label), extra);

// a new pose for the figure, only the upper or lower body when asked; name is what it's called in a prompt
function takePose(o, j, { m = undefined, name = null, mask = R.mask } = {}) {
  const v = current(o, FIG);
  let nj = j;
  if (mask !== 'all') {
    nj = { ...v.j };
    for (const n of Object.keys(FIGURE.JOINTS)) if (UPPER.has(n) === (mask === 'upper')) { if (j[n]) nj[n] = j[n]; else delete nj[n]; }
  }
  const nm = m === undefined ? v.m : m;
  write(o, FIG, { j: nj, m: nm, pn: name, ...liftTo(o, v, nj, nm) });
  changed();
}

// two people: this figure and the nearest other one (a new one when there's none), placed together
function takePair(o, key) {
  const p = FIGURE.pair(key), v = current(o, FIG), s = v.sy, r = THREE.MathUtils.degToRad(v.ry);
  const others = SC.objects.filter((x) => x.type === 'figure' && x !== o && !x.hidden);
  const dist = (x) => { const w = current(x, OBJ); return Math.hypot(w.x - v.x, w.z - v.z); };
  let b = others.sort((x, y) => dist(x) - dist(y))[0];
  if (!b) { b = newObject('figure'); SC.objects.push(b); }
  write(o, FIG, { j: p.a, m: {}, pn: `pair:${key}`, ...liftTo(o, v, p.a, {}) });
  const floor = o.ground ? current(o, FIG).y : current(o, FIG).y - FIGURE.liftFor(p.a) * s;  // where a's floor is
  const bs = current(b, FIG).sy;
  const dx = p.at.x * s, dz = p.at.z * s;
  write(b, FIG, { j: p.b, m: {}, pn: `pair:${key}:b`, rx: 0, rz: 0, ry: v.ry + p.at.ry,
    x: v.x + dx * Math.cos(r) + dz * Math.sin(r), z: v.z - dx * Math.sin(r) + dz * Math.cos(r),
    y: floor + p.at.y * s + (b.ground ? 0 : FIGURE.liftFor(p.b) * bs) });
  changed();
  toast(`${o.name} and ${b.name} together`);
}

function posesTab(o, cur) {
  const cat = R.poseCat;
  const cats = [...FIGURE.categories(), ['pairs', '👥 Pairs'], ['mine', '★ Mine']];
  let tiles;
  if (cat === 'pairs') {
    tiles = FIGURE.pairList().map(([k, l]) => {
      const p = FIGURE.pair(k);
      return tile(l, thumb(`pair:${k}`, [{ j: p.a }, { j: p.b, at: p.at }]), () => takePair(o, k));
    });
  } else if (cat === 'mine') {
    // saved poses: this project's (kept with its scene) and everyone's (in every project)
    const lists = [['project', 'This project', () => SC.poses || [], (l) => { SC.poses = l; save(); }],
      ['all', 'All projects', () => store.get(MINE, []), (l) => store.set(MINE, l)]];
    const mineTile = ([, , get, put], p) => tile(p.name, thumb(`mine:${p.id}`, [{ j: p.j, m: p.m }]), () => takePose(o, p.j, { m: p.m, name: `mine:${p.name}` }),
      iconBtn(`Delete ${p.name}`, '✕', () => {
        put(get().filter((x) => x.id !== p.id)); renderPanel();
        undoToast(`${p.name} deleted`, () => { put([...get(), p]); renderPanel(); });
      }, { class: 'icon-btn del' }));
    let where = 'project';
    tiles = [
      tile('Save this pose', h('span', { class: 'pose-add' }, '+'), () => nameSheet({ title: 'Save this pose', placeholder: 'Name',
        extra: field('Keep it in', seg([['project', 'This project'], ['all', 'All projects']], where, (v) => { where = v; })),
        save: (name) => {
          if (!name) throw new Error('Give it a name');
          const v = cur(), [, , get, put] = lists.find(([k]) => k === where);
          put([...get(), { id: uid(), name, j: v.j, m: v.m || {} }]); renderPanel();
        } })),
      ...lists.flatMap((l) => (l[2]().length ? [h('div', { class: 'grid-label' }, l[1]), ...l[2]().map((p) => mineTile(l, p))] : []))];
  } else {
    tiles = FIGURE.presetList(cat).map(([k, l]) => tile(l, thumb(k, [{ j: FIGURE.preset(k).j }]), () => takePose(o, FIGURE.preset(k).j, { name: k })));
  }
  return [
    h('div', { class: 'cat-row' }, cats.map(([k, l]) => h('button', { type: 'button', class: 'chip' + (k === cat ? ' on' : ''),
      onclick: () => { R.poseCat = k; store.set('deck.scene.posecat', k); renderPanel(); } }, l))),
    cat === 'pairs' ? hint('Poses this figure and the nearest other posable person together (adds one if there is none).')
      : field('Apply to', seg([['all', 'Whole body'], ['upper', 'Upper'], ['lower', 'Lower']], R.mask, (v) => { R.mask = v; })),
    h('div', { class: 'pose-grid' }, tiles),
    h('div', { class: 'row wrap' },
      button('⇋ Mirror', () => takePose(o, FIGURE.mirrorPose(cur().j), { m: FIGURE.mirrorParams(cur().m), name: cur().pn, mask: 'all' }), { title: 'Swap left and right' }),
      button('Copy pose', () => { const v = cur(); clip = { j: v.j, m: v.m, pn: v.pn }; toast('Pose copied: paste it on any figure'); renderPanel(); }),
      clip ? button('Paste pose', () => takePose(o, clip.j, { m: clip.m, name: clip.pn })) : null,
      button('Reset', () => takePose(o, FIGURE.preset('stand').j, { m: {}, name: 'stand', mask: 'all' }))),
  ];
}

// parameters: tap one on, slide it; tap it again for off
function adjustTab(o, cur) {
  const groups = [...new Set(Object.values(FIGURE.PARAMS).map((p) => p.group))].filter(Boolean);
  const setM = (m) => write(o, FIG, { m });
  return [
    ...groups.map((g) => {
      const keys = Object.entries(FIGURE.PARAMS).filter(([, p]) => p.group === g);  // (the step phase has no chip)
      const on = keys.filter(([k]) => cur().m?.[k]);
      return field(g,
        g === 'Cycle' ? hint('A walk or run in place: move the figure with keys and its steps follow, or set the step by hand.') : null,
        h('div', { class: 'chips' }, keys.map(([k, p]) => h('button', { type: 'button', class: 'chip' + (cur().m?.[k] ? ' on' : ''), 'aria-pressed': !!cur().m?.[k],
          onclick: () => {
            const m = { ...cur().m };
            if (m[k]) delete m[k]; else m[k] = p.on;
            setM(m); changed();
          } }, p.label))),
        on.map(([k, p]) => slider(p.label, () => cur().m?.[k] || 0, (v) => setM({ ...cur().m, [k]: v || 0.001 }),
          { min: p.min, max: p.max, step: 1, fmt: (v) => `${Math.round(v)}${p.unit || '°'}` })),
        g === 'Cycle' && on.length ? [
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: o.stepsFollow !== false,
            onchange: (e) => { o.stepsFollow = e.target.checked; changed(); } }), 'Steps follow movement (feet don\'t slide)'),
          o.stepsFollow === false ? slider('Step', () => cur().m?.phase || 0, (v) => setM({ ...cur().m, phase: v }),
            { min: 0, max: 8, step: 0.01, fmt: (v) => `${v.toFixed(2)} strides` }) : null,
          o.stepsFollow === false ? hint('Key Step 0 here and 6 later for six strides on the spot.') : null] : null);
    }),
    h('div', { class: 'row wrap' }, Object.keys(cur().m || {}).length ? button('All off', () => { setM({}); changed(); }) : null),
    hint('These sit on top of the pose, so a new pose keeps them. With keys they are keyed with the pose and blend between keys.'),
  ];
}

// a move: keys from the playhead on, starting from the pose it's in now (one undo)
function runMove(o, key) {
  const v = current(o, FIG), f0 = R.f, n = frames(), k = R.speed;
  const avail = (n - 1 - f0) / FPS / k;
  if (avail < 0.3) return toast('Move the playhead back: there\'s no time left for a move', true);
  const steps = FIGURE.moveSteps(key, avail, R.inPlace);
  if (!steps.length) return toast('Not enough time left for that move: move the playhead back', true);
  const before = clone(o);
  const at = (st) => Math.min(n - 1, f0 + Math.max(1, Math.round(st.t * k * FPS)));
  const last = at(steps[steps.length - 1]), r = THREE.MathUtils.degToRad(v.ry);
  if (FIGURE.moveKind(key) === 'spot' || (R.inPlace && FIGURE.moveKind(key) === 'travel')) o.stepsFollow = false;
  else if (FIGURE.moveKind(key) === 'travel') o.stepsFollow = true;
  addKey(o, FIG, { ...v, m: { ...v.m } });
  o.keys = o.keys.filter((x) => x.f <= f0 || x.f > last);
  for (const st of steps) {
    const f = at(st), j = st.j || v.j, m = { ...v.m, ...st.m }, d = (st.d || 0) * v.sy;
    if (st.phase != null) m.phase = (v.m?.phase || 0) + st.phase;
    const y = v.y + (o.ground ? 0 : (FIGURE.liftFor(j, m) - FIGURE.liftFor(v.j, v.m)) * v.sy) + (st.y || 0) * v.sy;
    const key = { ...v, f, j, m, pn: st.pn || v.pn, y, ry: v.ry + (st.ry || 0), x: v.x + d * Math.sin(r), z: v.z + d * Math.cos(r) };
    if (st.ease) key.ease = st.ease;
    o.keys = o.keys.filter((x) => x.f !== f);
    o.keys.push(key);
  }
  o.keys.sort((a, b) => a.f - b.f);
  changed();
  undoToast(`${FIGURE.moveList().find(([x]) => x === key)[1]}: keys to ${(last / FPS).toFixed(1)} s`, () => {
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, before); changed();
  });
}

// keys a step later: a key here and the same pose further on, to change into the next pose
function nextKey(o, secs) {
  const f = Math.min(frames() - 1, R.f + Math.round(secs * FPS));
  if (f === R.f) return toast('At the end of the clip', true);
  addKey(o, FIG); seek(f); addKey(o, FIG); changed();
}

function movesTab(o, cur) {
  if (THUMBS.size > 400) THUMBS.clear();
  const strip = o.keys.map((k) => h('button', { type: 'button', class: 'key-card' + (k.f === R.f ? ' on' : ''), onclick: () => seek(k.f) },
    thumb(`k:${JSON.stringify([k.j, k.m])}`, [{ j: k.j, m: k.m }]), h('span', {}, `${(k.f / FPS).toFixed(1)} s`)));
  return [
    field('Keys', strip.length ? h('div', { class: 'key-strip' }, strip) : hint('No keys yet: a move adds them, or ◆ Key.')),
    field('Next key in', h('div', { class: 'row' }, [0.5, 1, 2].map((t) => button(`+${t} s`, () => nextKey(o, t), { title: `A key here and one ${t} s on, ready for the next pose` })))),
    h('div', { class: 'row' },
      field('Speed', seg(SPEEDS, R.speed, (v) => { R.speed = v; })),
      field('Walk and run', seg([[false, 'Go forward'], [true, 'On the spot']], R.inPlace, (v) => { R.inPlace = v; }))),
    h('div', { class: 'pose-grid moves' }, FIGURE.moveList().map(([k, l, icon]) => tile(l, h('span', { class: 'move-icon' }, icon), () => runMove(o, k)))),
    hint('A move starts at the playhead from the pose the figure is in, and replaces the keys it covers. Undo takes it back.'),
  ];
}

// the joints as a body map (seen from the front), and the picked joint's turns as sliders
const BODY = [['head', 1, 3, 'Head'], ['neck', 2, 3, 'Neck'], ['chest', 3, 3, 'Chest'], ['spine', 4, 3, 'Waist'], ['hips', 5, 3, 'Hips'],
  ['rsho', 2, 1, 'Shoulder'], ['relb', 3, 1, 'Elbow'], ['rhand', 4, 1, 'Hand'], ['lsho', 2, 5, 'Shoulder'], ['lelb', 3, 5, 'Elbow'], ['lhand', 4, 5, 'Hand'],
  ['rhip', 5, 2, 'Hip'], ['rknee', 6, 2, 'Knee'], ['rfoot', 7, 2, 'Foot'], ['lhip', 5, 4, 'Hip'], ['lknee', 6, 4, 'Knee'], ['lfoot', 7, 4, 'Foot']];
function jointsTab(o, cur) {
  const n = R.joint, label = n && FIGURE.JOINTS[n][2];
  const order = Object.keys(FIGURE.JOINTS);
  const map = h('div', { class: 'body-map' },
    h('span', { class: 'side', style: 'grid-area:1/1' }, 'Right'), h('span', { class: 'side', style: 'grid-area:1/5' }, 'Left'),
    BODY.map(([k, r, c, l]) => h('button', { type: 'button', class: k === n ? 'on' : '', style: `grid-area:${r}/${c}`, title: FIGURE.JOINTS[k][2],
      onclick: () => selectJoint(k === n ? null : k) }, l)));
  if (!n) return [map, hint('Pick a joint here or tap a blue dot on the figure. Drag a hand or foot and the arm or leg follows.')];
  const e = () => new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(cur().j[n] || [0, 0, 0, 1]));
  const opp = FIGURE.opposite(n);
  const setTurn = (i) => (deg) => {
    const a = e().toArray().slice(0, 3);
    a[i] = THREE.MathUtils.degToRad(deg);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...a)).toArray(), j = { ...cur().j, [n]: q };
    if (R.sym && opp) j[opp] = FIGURE.mirrorQ(q);
    write(o, FIG, { j });
  };
  const turn = (l, i) => slider(l, () => THREE.MathUtils.radToDeg(e().toArray()[i]), setTurn(i), { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` });
  const step = (d) => selectJoint(order[(order.indexOf(n) + d + order.length) % order.length]);
  return [
    map,
    h('div', { class: 'row joint-head' }, iconBtn('Previous joint', '◀', () => step(-1)), h('b', { class: 'grow' }, label), iconBtn('Next joint', '▶', () => step(1))),
    turn('Bend', 0), turn('Twist', 1), turn('Side', 2),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: R.sym, onchange: (ev) => { R.sym = ev.target.checked; } }), 'Mirror edits to the other side'),
    h('div', { class: 'row wrap' },
      button('Reset joint', () => { const j = { ...cur().j }; delete j[n]; if (R.sym && opp) delete j[opp]; write(o, FIG, { j }); changed(); }),
      opp ? button('Copy to other side', () => { const j = { ...cur().j }; if (j[n]) j[opp] = FIGURE.mirrorQ(j[n]); else delete j[opp]; write(o, FIG, { j }); changed(); }) : null,
      button('Pivot here', () => { o.pivot = n; changed(); }, { title: 'The gizmo turns the whole figure around this joint' }),
      button('Done', () => selectJoint(null))),
    hint(`${FIGURE.IK[n] ? 'Move drags the limb (the elbow or knee follows), Rotate turns it.' : 'Rotate turns it.'} Tap the body (or Esc) for the whole figure.`),
  ];
}

function roomProps() {
  const rm = SC.room;
  const re = () => rebuildRoom();
  return section('Room', () => select(null),
    h('div', { class: 'row' },
      num('Width (m)', () => rm.w, (v) => { rm.w = Math.max(1, v); }, { min: 1, max: 40, after: re }),
      num('Depth (m)', () => rm.d, (v) => { rm.d = Math.max(1, v); }, { min: 1, max: 40, after: re }),
      num('Height (m)', () => rm.h, (v) => { rm.h = Math.max(1, v); }, { min: 1, max: 10, after: re })),
    field('Shape', seg([['room', 'Walls + ceiling'], ['walls', 'Walls'], ['floor', 'Floor only']], rm.walls ? (rm.ceiling ? 'room' : 'walls') : 'floor',
      (v) => { rm.walls = v !== 'floor'; rm.ceiling = v === 'room'; rebuildRoom(); changed(); })),
    hint('Keep the walls about where the real ones should be: H3 sizes the room from them. Hide it (◉) for an open space.'),
    button('Delete room', removeSelected, { cls: 'small danger' }));
}

function cameraProps() {
  const cam = SC.camera;
  const mm = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);  // full-frame equivalent, from the vertical angle
  const sizeSel = h('select', {}, ...SIZES.map(([w, hh]) => h('option', { value: `${w}x${hh}` }, `${w}×${hh}`)));
  sizeSel.value = `${SC.width}x${SC.height}`;
  if (sizeSel.value !== `${SC.width}x${SC.height}`) sizeSel.append(h('option', { value: `${SC.width}x${SC.height}`, selected: true }, `${SC.width}×${SC.height}`));
  sizeSel.addEventListener('change', () => { [SC.width, SC.height] = sizeSel.value.split('x').map(Number); save(); fit(); renderPanel(); });
  const secs = num(`Length (s) · ${frames()} frames`, () => SC.seconds, (v) => {
    SC.seconds = Math.max(2, Math.min(15, Math.round(v || 6)));
    const n = frames();
    for (const it of [SC.camera, ...SC.objects]) it.keys = it.keys.filter((k) => k.f < n);
    R.f = Math.min(R.f, n - 1);
  }, { min: 2, max: 15, step: 1, digits: 0, after: () => renderTransport(), live: null });
  return section('Camera', null,
    h('div', { class: 'row' }, field('Size', sizeSel), secs),
    slider('Lens', () => current(cam, CAM).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm` }),
    slider('Camera height', () => current(cam, CAM).py, (v) => write(cam, CAM, { py: v }),
      { min: 0.1, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    easeSeg(cam),
    h('div', { class: 'row wrap' },
      clearKeys(cam, CAM),
      button('Reset view', () => { write(cam, CAM, { ...defaultScene().camera.base }); changed(); })),
    hint('The view is the camera: drag empty space to orbit, two fingers to pan and zoom. With keys and Auto key on, each move sets a key at the playhead; with Auto key off it is only a look around until ◆ Key.'));
}

function renderProps() {
  return section('Render', null,
    slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
    hint('Blurs the depth so H3 copies the shapes less literally. Use with deck-h3-ctrl2v (strength 1, end 0.4).'),
    h('div', { class: 'row wrap' },
      button('Render depth video', renderDepthVideo, { cls: 'small primary', disabled: busy }),
      SC.objects.some((o) => o.type === 'figure' && !o.hidden)
        ? button('Render pose video', renderPoseVideo, { disabled: busy, title: 'The posable people as OpenPose stick figures' }) : null,
      button('📷 Save frame', saveFrame)),
    R.lastRender ? button(`Use #${R.lastRender.id} in H3 control`, () => C.useControlVideo(R.lastRender, SC)) : null,
    h('p', { id: 'sceneStatus', class: 'hint' }, statusText));
}

function openAdd() {
  const chip = (label, fn, title) => h('button', { type: 'button', class: 'chip', title, onclick: fn }, label);
  openSheet(h('h3', {}, 'Add to the scene'),
    h('div', { class: 'chips' }, ...Object.entries(TYPES).filter(([t]) => t !== 'photo').map(([t, d]) => chip(`${d.icon} ${d.label}`, () => addObject(t))),
      SC.room ? null : chip('⌂ Room', () => addObject(ROOM)),
      chip('🖼 Photo in 3D…', () => {
        closeSheet(); C.openImagePicker({ title: 'Picture to turn into 3D', onPick: (name) => makePhoto(name) });
      }, 'Turn a picture into a 3D mesh (MoGe in ComfyUI) for camera moves')));
}

function renderPanel() {
  const panel = $('#scenePanel');
  if (!panel || !SC) return;
  panel.replaceChildren(h('div', { class: 'panel-body' },
    panelTop(button('+ Add', openAdd, { cls: 'primary' }), SC.objects.length || SC.room ? () => {
      const before = clone(SC);
      SC.objects = []; SC.room = null; R.sel = null; rebuildRoom(); changed(); renderToolbar();
      undoToast('Scene cleared (the camera stays)', () => { SC = before; rebuildRoom(); changed(); });
    } : null),
    layerList(),
    selItem() ? objectProps(selItem()) : R.sel === ROOM && SC.room ? roomProps() : cameraProps(),
    renderProps()));
}

// ---- entry points (called from app.js) ------------------------------------------------
let ready = false;
export function init(helpers) {
  C = helpers; R.autoKey = store.get('deck.scene.autokey', true) !== false;
  R.figTab = store.get('deck.scene.figtab', 'pose'); R.poseCat = store.get('deck.scene.posecat', 'stand');
}

function showAll() { rebuildRoom(); refresh(); renderToolbar(); renderTransport(); renderPanel(); fit(); }

export function show() {
  if (!ready) { load(); setup(); ready = true; }
  showAll();
}

export function hide() { if (ready) stopPlay(); }

// a new project has its own scene
export function projectChanged() {
  if (!ready) return;
  stopPlay(); load(); R.lastRender = null; showAll();
}

// open the scene saved with a "3d scene" generation
export function open(scene) {
  if (!scene || scene.v !== 1) return toast('That scene is from another version', true);
  SC = upgrade(clone(scene));
  R.sel = null; R.f = 0; resetHistory(); save(true);
  if (ready) showAll();
}
