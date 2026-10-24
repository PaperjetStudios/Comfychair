// 3D tab: block out a shot (soft mannequins, boxes, a room, a camera move) and render it as a depth
// video for H3's Fun ControlNet (deck-h3-ctrl2v). Near is white and far is black, like Depth
// Anything, and the range is fixed over the whole clip so the depth doesn't flicker.
// It works like the Editor: a layer list (Camera, Room, objects), the selected layer's settings under
// it, and a gizmo on the selected object (Move / Rotate / Scale; tap it again to switch). The view is
// the shot camera. Anything with keyframes is animated, and changing it writes a key at the playhead.
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';

let C;  // helpers handed over by app.js (see sceneModule there)
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
};
const MODES = [['translate', '✥ Move', 'w'], ['rotate', '⟳ Rotate', 'e'], ['scale', '⤢ Scale', 'r']];
const ROOM = 'room';  // R.sel for the room; null is the camera

// ---- scene data ------------------------------------------------------------
let SC;   // the scene (persisted per project)
const R = { f: 0, sel: null, mode: 'translate', playing: false, depth: false, meshes: new Map(), room: [], applying: false, lastRender: null };

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
  return { id: Math.random().toString(36).slice(2, 9), type, name: `${t.label} ${n}`, ease: 'smooth', keys: [], hidden: false,
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
}

// scenes saved before rotation on all axes, hiding and a deletable room
function upgrade(sc) {
  for (const o of sc.objects) { o.base = { rx: 0, rz: 0, ...o.base }; o.hidden = !!o.hidden; }
  if (sc.room) sc.room = { ceiling: false, hidden: false, ...sc.room };
  return sc;
}

const sceneKey = () => `deck.scene.${C.S.project ?? 'none'}`;
function load() {
  const sc = C.store.get(sceneKey(), null);
  SC = sc && sc.v === 1 ? upgrade(sc) : defaultScene();
  R.sel = null; R.f = Math.min(R.f, frames() - 1);
}
let saveTimer;
function save(now = false) {  // the key and scene are taken now, so a project switch can't misfile it
  clearTimeout(saveTimer);
  const key = sceneKey(), sc = SC;
  if (now) C.store.set(key, sc); else saveTimer = setTimeout(() => C.store.set(key, sc), 300);
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
  const t = (f - a.f) / (b.f - a.f), e = item.ease === 'linear' ? t : ease(t);
  return Object.fromEntries(names.map((n) => [n, a[n] + (b[n] - a[n]) * e]));
}

// write values: into the key at the playhead when the item is animated, else into its base
function write(item, names, vals) {
  if (!item.keys.length) { Object.assign(item.base, vals); return; }
  let k = item.keys.find((x) => x.f === R.f);
  if (!k) { k = { f: R.f, ...sample(item, names, R.f) }; item.keys.push(k); item.keys.sort((a, b) => a.f - b.f); }
  Object.assign(k, vals);
}

function addKey(item, names) {
  const vals = sample(item, names, R.f);
  if (!item.keys.length) Object.assign(item.base, vals);
  const k = item.keys.find((x) => x.f === R.f);
  if (k) Object.assign(k, vals); else { item.keys.push({ f: R.f, ...vals }); item.keys.sort((a, b) => a.f - b.f); }
}

const selItem = () => SC.objects.find((o) => o.id === R.sel) || null;
// what ◆ Key acts on: the selected object, else the camera (the room isn't animated)
const keyTarget = () => { const o = selItem(); return o ? [o, OBJ] : R.sel === ROOM ? [null, null] : [SC.camera, CAM]; };

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
  viewer = C.$('#sceneViewer');
  canvas = C.$('#sceneCanvas');
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

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.addEventListener('change', () => { if (!R.applying) draw(); });
  controls.addEventListener('end', () => {
    if (R.playing) return;
    write(SC.camera, CAM, readCamera());
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
    const d = THREE.MathUtils.radToDeg;
    write(o, OBJ, { x: m.position.x, y: m.position.y, z: m.position.z,
      rx: d(m.rotation.x), ry: d(m.rotation.y), rz: d(m.rotation.z),
      sx: Math.max(0.01, m.scale.x), sy: Math.max(0.01, m.scale.y), sz: Math.max(0.01, m.scale.z) });
  });

  // a tap (not a drag, not on a gizmo handle) selects what's under it; tapping the selected
  // object again switches the gizmo between Move, Rotate and Scale
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, onGizmo: gizmo.dragging || gizmo.axis != null }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || down.onGizmo || R.playing || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
    down = null;
    const id = hitAt(e);
    if (id && id === R.sel && id !== ROOM) setMode(MODES[(MODES.findIndex(([m]) => m === R.mode) + 1) % MODES.length][0]);
    else select(id);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  viewer.append(C.h('div', { id: 'sceneToolbar', class: 'layer-toolbar scene-toolbar', role: 'toolbar', 'aria-label': 'Gizmo' },
    ...MODES.map(([m, label, key]) => C.h('button', { type: 'button', 'data-mode': m, title: `${label.slice(2)} (${key.toUpperCase()})`,
      onclick: () => setMode(m) }, label)),
    C.h('span', { class: 'sep' }),
    C.h('button', { type: 'button', 'data-depth': '', title: 'Show the depth the render will use',
      onclick: () => { R.depth = !R.depth; draw(); renderToolbar(); } }, '◐ Depth')));

  document.addEventListener('keydown', (e) => {
    if (!C.$('#tab-scene').classList.contains('active') || !C.$('#sheet').classList.contains('hidden')
      || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const m = MODES.find(([, , k]) => k === e.key.toLowerCase());
    if (m) { e.preventDefault(); setMode(m[0]); }
    else if (e.key === 'Escape') select(null);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
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

function syncMeshes() {
  const g = geometries();
  const ids = new Set(SC.objects.map((o) => o.id));
  for (const [id, m] of R.meshes) if (!ids.has(id)) { scene.remove(m); R.meshes.delete(id); }
  for (const o of SC.objects) {
    let m = R.meshes.get(o.id);
    if (!m) { m = new THREE.Mesh(g[TYPES[o.type].geo || o.type], clay); m.userData.id = o.id; scene.add(m); R.meshes.set(o.id, m); }
    m.material = o.id === R.sel ? claySel : clay;
    m.visible = !o.hidden;
  }
  for (const m of R.room) {
    m.visible = !SC.room.hidden;
    m.material = R.sel === ROOM ? roomSel : m === R.room[0] ? floorMat : wallMat;
  }
  const o = selItem();
  const m = o && !o.hidden ? R.meshes.get(o.id) : null;
  if (m) { if (gizmo.object !== m) gizmo.attach(m); gizmo.setMode(R.mode); } else gizmo.detach();
}

// put every object and the camera where they are at frame f
function pose(f) {
  const r = THREE.MathUtils.degToRad;
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id);
    if (!m) continue;
    const v = sample(o, OBJ, f);
    m.position.set(v.x, v.y, v.z);
    m.rotation.set(r(v.rx), r(v.ry), r(v.rz));
    m.scale.set(Math.max(0.01, v.sx), Math.max(0.01, v.sy), Math.max(0.01, v.sz));
  }
  const c = sample(SC.camera, CAM, f);
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
  // the room only blocks: tapping a wall or the floor deselects (pick the room in the layer list)
  const hit = ray.intersectObjects(visibleMeshes(), false)[0];
  return hit && hit.object.userData.id !== ROOM ? hit.object.userData.id : null;
}

// ---- selection, layers ------------------------------------------------------------
function select(id) { R.sel = id; refresh(); renderToolbar(); renderKeys(); renderPanel(); }
function setMode(m) { R.mode = m; if (gizmo.object) gizmo.setMode(m); draw(); renderToolbar(); }

function changed() { save(); refresh(); renderKeys(); renderPanel(); }

function removeSelected() {
  const before = JSON.parse(JSON.stringify(SC)), sel = R.sel;
  let name;
  if (sel === ROOM) { name = 'Room'; SC.room = null; rebuildRoom(); }
  else { const o = selItem(); if (!o) return; name = o.name; SC.objects = SC.objects.filter((x) => x !== o); }
  R.sel = null; changed(); renderToolbar();
  C.undoToast(`${name} deleted`, () => { SC = before; R.sel = sel; rebuildRoom(); changed(); renderToolbar(); });
}

function addObject(type) {
  C.closeSheet && C.closeSheet();
  if (type === ROOM) { SC.room = newRoom(); rebuildRoom(); select(ROOM); save(); return; }
  const c = controls.target;
  const o = newObject(type, { x: +c.x.toFixed(2), z: +(type === 'wall' ? c.z - 2 : c.z).toFixed(2) });
  SC.objects.push(o); save(); select(o.id);
}

function layerList() {
  const { h, iconBtn } = C;
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
  return C.layerRowsEl(rows);
}

// ---- playback ----------------------------------------------------------------------
let raf = 0;
function play() {
  if (R.playing) return stopPlay();
  R.playing = true;
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
function seek(f) { R.f = Math.max(0, Math.min(frames() - 1, Math.round(f))); pose(R.f); draw(); renderTime(); renderKeys(); renderPanel(); }

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
  busy = true; stopPlay(); renderPanel();
  const keep = R.f, W = SC.width, H = SC.height;
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
    }
    rt.dispose();
    form.append('fps', FPS); form.append('blur', SC.blur); form.append('scene', JSON.stringify(SC));
    if (C.S.project != null) form.append('project_id', C.S.project);
    setStatus('Encoding…');
    R.lastRender = await C.api('/api/scene/render', { method: 'POST', form });
    setStatus(`Depth video #${R.lastRender.id} is in History`);
    C.toast('Depth video saved', false, { label: 'Use in H3 control', fn: () => C.useControlVideo(R.lastRender, SC) });
  } catch (e) {
    setStatus(''); C.toast(e.message, true);
  } finally {
    busy = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

// a lit clay frame at the output size, as an input image (a start frame to restyle, for example)
async function saveFrame() {
  const W = SC.width, H = SC.height;
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
  const wasDepth = R.depth; R.depth = false;
  draw('clay');
  for (const m of R.meshes.values()) m.material = clay;
  for (const m of R.room) m.material = m === R.room[0] ? floorMat : wallMat;
  camera.aspect = W / H; camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const blob = await targetToBlob(rt, W, H, false);
  rt.dispose();
  R.depth = wasDepth; fit(); refresh();
  try {
    const r = await C.uploadImage(blob, { source: 'scene', filename: 'scene.png' });
    C.toast(`Saved frame as ${r.name.split('/').pop()}`);
  } catch (e) { C.toast(e.message, true); }
}

// ---- UI ----------------------------------------------------------------------
let statusText = '';
function setStatus(t) { statusText = t; const s = C.$('#sceneStatus'); if (s) s.textContent = t; }

function renderToolbar() {
  const tb = C.$('#sceneToolbar');
  if (!tb) return;
  const can = !!selItem();
  tb.querySelectorAll('[data-mode]').forEach((b) => { b.classList.toggle('on', can && b.dataset.mode === R.mode); b.disabled = !can; });
  tb.querySelector('[data-depth]').classList.toggle('on', R.depth);
}

function renderTime() {
  const t = C.$('#sceneTime');
  if (t) t.textContent = `${(R.f / FPS).toFixed(2)} s · ${R.f + 1}/${frames()}`;
  const r = C.$('#sceneScrub');
  if (r && document.activeElement !== r) r.value = R.f;
}

function renderKeys() {
  const box = C.$('#sceneKeys');
  if (!box) return;
  const [item] = keyTarget();
  const n = frames() - 1;
  box.replaceChildren(...(item ? item.keys : []).map((k) => C.h('button', {
    type: 'button', class: 'key' + (k.f === R.f ? ' on' : ''), style: `left:${(k.f / n) * 100}%`,
    title: `Key at ${(k.f / FPS).toFixed(2)} s`, onclick: () => seek(k.f) })));
  const add = C.$('#sceneAddKey'), del = C.$('#sceneDelKey');
  if (add) add.disabled = !item;
  if (del) del.disabled = !item || !item.keys.some((k) => k.f === R.f);
  const lbl = C.$('#sceneKeyFor');
  if (lbl) lbl.textContent = selItem() ? selItem().name : R.sel === ROOM ? 'Room (not animated)' : 'Camera';
}

function renderTransport() {
  const { h } = C;
  const scrub = h('input', { id: 'sceneScrub', type: 'range', min: 0, max: frames() - 1, step: 1, value: R.f });
  scrub.addEventListener('input', () => seek(+scrub.value));
  C.$('#sceneTransport').replaceChildren(
    h('button', { type: 'button', class: 'btn small primary', title: 'Play / pause (Space)', onclick: play }, R.playing ? '❚❚ Pause' : '▶ Play'),
    h('div', { class: 'scene-scrub' }, h('div', { id: 'sceneKeys', class: 'scene-keys' }), scrub),
    h('span', { id: 'sceneTime', class: 'timecode' }),
    h('div', { class: 'row scene-keybar' },
      h('span', { class: 'hint' }, 'Key: ', h('b', { id: 'sceneKeyFor' })),
      h('button', { id: 'sceneAddKey', type: 'button', class: 'btn small', title: 'Keyframe at the playhead', onclick: () => {
        const [item, names] = keyTarget(); if (!item) return; addKey(item, names); changed();
      } }, '◆ Key'),
      h('button', { id: 'sceneDelKey', type: 'button', class: 'btn small', onclick: () => {
        const [item] = keyTarget(); if (!item) return;
        item.keys = item.keys.filter((k) => k.f !== R.f); changed();
      } }, '✕ Key')));
  renderTime(); renderKeys();
}

function slider(label, get, set, { min, max, step, fmt = (v) => v.toFixed(2) }) {
  const { h } = C;
  const val = h('span', {}, fmt(get()));
  const r = h('input', { type: 'range', min, max, step, value: get() });
  r.addEventListener('input', () => { set(parseFloat(r.value)); val.textContent = fmt(get()); pose(R.f); draw(); });
  r.addEventListener('change', () => { save(); renderKeys(); });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, h('span', {}, label), val), r);
}
const num = (label, get, set, opts = {}) => C.propNum(label, +Number(get()).toFixed(opts.digits ?? 2), set,
  () => { if (opts.after) opts.after(); changed(); }, { step: 'any', ...opts });
const seg = (opts, cur, on) => C.h('div', { class: 'seg' }, ...opts.map(([v, label]) =>
  C.h('button', { type: 'button', class: cur === v ? 'on' : '', onclick: () => on(v) }, label)));
const easeSeg = (item) => C.h('div', { class: 'field' }, C.h('span', { class: 'lbl' }, 'Between keys'),
  seg([['smooth', 'Ease'], ['linear', 'Linear']], item.ease, (v) => { item.ease = v; changed(); }));

function objectProps(o) {
  const { h } = C;
  const cur = () => sample(o, OBJ, R.f);
  const set = (k) => (v) => write(o, OBJ, { [k]: v });
  const name = h('input', { type: 'text', value: o.name });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(); });
  const xyz = (label, ks, opts) => h('div', { class: 'field' }, h('span', { class: 'lbl' }, label),
    h('div', { class: 'row' }, ...ks.map(([k, l]) => num(l, () => cur()[k], set(k), opts))));
  return h('div', { class: 'props' }, C.propsTitle(TYPES[o.type].label, () => select(null)),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), name),
    xyz('Position (m)', [['x', 'X'], ['y', 'Up'], ['z', 'Z']]),
    xyz('Rotation (°)', [['rx', 'X'], ['ry', 'Y'], ['rz', 'Z']], { digits: 0 }),
    xyz('Size (m)', [['sx', 'Width'], ['sy', 'Height'], ['sz', 'Depth']], { min: 0.01 }),
    easeSeg(o),
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        const c = { ...JSON.parse(JSON.stringify(o)), id: Math.random().toString(36).slice(2, 9), name: `${o.name} copy` };
        c.base.x += 0.6; c.keys.forEach((k) => { if (k.x != null) k.x += 0.6; });
        SC.objects.push(c); save(); select(c.id);
      } }, 'Duplicate'),
      o.keys.length ? h('button', { type: 'button', class: 'btn small', onclick: () => { Object.assign(o.base, cur()); o.keys = []; changed(); } }, 'Clear keys') : null),
    h('button', { type: 'button', class: 'btn small danger', onclick: removeSelected }, 'Delete'),
    h('div', { class: 'hint' }, 'Drag the gizmo to move it; tap the object again (or W / E / R) for Rotate and Scale. With keys, a change sets a key at the playhead.'));
}

function roomProps() {
  const { h } = C;
  const rm = SC.room;
  const re = () => rebuildRoom();
  return h('div', { class: 'props' }, C.propsTitle('Room', () => select(null)),
    h('div', { class: 'row' },
      num('Width (m)', () => rm.w, (v) => { rm.w = Math.max(1, v); }, { min: 1, after: re }),
      num('Depth (m)', () => rm.d, (v) => { rm.d = Math.max(1, v); }, { min: 1, after: re }),
      num('Height (m)', () => rm.h, (v) => { rm.h = Math.max(1, v); }, { min: 1, after: re })),
    seg([['room', 'Walls + ceiling'], ['walls', 'Walls'], ['floor', 'Floor only']], rm.walls ? (rm.ceiling ? 'room' : 'walls') : 'floor',
      (v) => { rm.walls = v !== 'floor'; rm.ceiling = v === 'room'; rebuildRoom(); changed(); }),
    h('div', { class: 'hint' }, 'Keep the walls about where the real ones should be: H3 sizes the room from them. Hide it (◉) for an open space.'),
    h('button', { type: 'button', class: 'btn small danger', onclick: removeSelected }, 'Delete room'));
}

function cameraProps() {
  const { h } = C;
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
  }, { min: 2, max: 15, step: 1, digits: 0, after: () => renderTransport() });
  return h('div', { class: 'props' }, C.propsTitle('Camera'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Size'), sizeSel), secs),
    slider('Lens', () => sample(cam, CAM, R.f).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm` }),
    slider('Camera height', () => sample(cam, CAM, R.f).py, (v) => write(cam, CAM, { py: v }),
      { min: 0.1, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    easeSeg(cam),
    h('div', { class: 'row wrap' },
      cam.keys.length ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        Object.assign(cam.base, sample(cam, CAM, R.f)); cam.keys = []; changed();
      } }, 'Clear keys') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => { write(cam, CAM, { ...defaultScene().camera.base }); changed(); } }, 'Reset view')),
    h('div', { class: 'hint' }, 'The view is the camera: drag empty space to orbit, two fingers to pan and zoom. With keys, each move sets a key at the playhead.'));
}

function renderProps() {
  const { h } = C;
  return h('div', { class: 'props' }, C.propsTitle('Render'),
    slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
    h('div', { class: 'hint' }, 'Blurs the depth so H3 copies the shapes less literally. Use with deck-h3-ctrl2v (strength 1, end 0.4).'),
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: renderDepthVideo }, 'Render depth video'),
      h('button', { type: 'button', class: 'btn small', onclick: saveFrame }, '📷 Save frame')),
    R.lastRender ? h('button', { type: 'button', class: 'btn small', onclick: () => C.useControlVideo(R.lastRender, SC) },
      `Use #${R.lastRender.id} in H3 control`) : null,
    h('div', { id: 'sceneStatus', class: 'hint' }, statusText));
}

function openAdd() {
  const { h } = C;
  C.openSheet(h('h3', {}, 'Add to the scene'),
    h('div', { class: 'chips' }, ...Object.entries(TYPES).map(([t, d]) =>
      h('button', { type: 'button', class: 'chip', onclick: () => addObject(t) }, `${d.icon} ${d.label}`)),
    SC.room ? null : h('button', { type: 'button', class: 'chip', onclick: () => addObject(ROOM) }, '⌂ Room')));
}

function renderPanel() {
  const { h } = C;
  const panel = C.$('#scenePanel');
  if (!panel || !SC) return;
  panel.replaceChildren(h('div', { class: 'group-body flat' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: openAdd }, '+ Add'),
      SC.objects.length || SC.room ? h('button', { type: 'button', class: 'btn ghost', style: 'flex:none', onclick: () => {
        const before = JSON.parse(JSON.stringify(SC));
        SC.objects = []; SC.room = null; R.sel = null; rebuildRoom(); changed(); renderToolbar();
        C.undoToast('Scene cleared (the camera stays)', () => { SC = before; rebuildRoom(); changed(); });
      } }, 'Clear all') : null),
    layerList(),
    selItem() ? objectProps(selItem()) : R.sel === ROOM && SC.room ? roomProps() : cameraProps(),
    renderProps()));
}

// ---- entry points (called from app.js) ------------------------------------------------
let ready = false;
export function init(helpers) { C = helpers; }

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
  if (!scene || scene.v !== 1) return C.toast('That scene is from another version', true);
  SC = upgrade(JSON.parse(JSON.stringify(scene)));
  R.sel = null; R.f = 0; save(true);
  if (ready) showAll();
}
