import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import * as THREE from './vendor/three.module.min.js';
import { TransformControls } from './vendor/TransformControls.js';
import * as FIGURE from './figure.js';
import { $, api, busy as busyBar, clone, closeSheet, toast, undoToast } from './ui.js';
import {
  C, CAM, EVEN, FIG, MODES, OBJ, R, ROOM, SC, TYPES, current, frames, hooks, namesFor, newObject, newRoom, pivotOf, sample,
  sameTab, save, selItem, setSC, write
} from './scene-data.js';
import { modeOf } from './scene-modes.js';
import { renderKeys, renderPanel, renderToolbar, setSceneMode } from './scene-ui.js';

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
export let renderer, scene, camera, controls, gizmo, grid, canvas, viewer;
// the free view (setFree), the shot camera drawn in it, and the empty stage of Create object
let viewCam, viewControls, shotCam, frustum, stage;
const clay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9 });
const claySel = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8 });
export const floorMat = new THREE.MeshStandardMaterial({ color: 0x5c5c5c, roughness: 1, side: THREE.DoubleSide });
export const wallMat = new THREE.MeshStandardMaterial({ color: 0x7c7c7c, roughness: 1, side: THREE.DoubleSide });
const roomSel = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 1, side: THREE.DoubleSide });
const figClay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9, flatShading: true });
const figSel = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8, flatShading: true });
const dotMat = new THREE.MeshBasicMaterial({ color: 0x4cc3ff, depthTest: false, transparent: true, opacity: 0.85 });
const dotSel = new THREE.MeshBasicMaterial({ color: 0xff4c8a, depthTest: false, transparent: true, opacity: 0.95 });
const ikTarget = new THREE.Object3D();  // what the gizmo drags when a hand or foot is moved (IK)
// what the gizmo holds for a whole object: at its pivot, turned and scaled with it. pivotAt is the
// pivot in the object's own space, kept still while dragging.
const pivot = new THREE.Object3D(), pivotAt = new THREE.Vector3();
// (the skinning chunks pose an imported character's bones; plain meshes pass through them)
const VERT = `#include <skinning_pars_vertex>
varying float vz;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv;
}`;
const depthMat = new THREE.ShaderMaterial({
  uniforms: { near: { value: 0.5 }, far: { value: 20 } }, side: THREE.DoubleSide, vertexShader: VERT,
  fragmentShader: 'uniform float near; uniform float far; varying float vz;'
    + 'void main() { float d = (1.0 / max(vz, 1e-3) - 1.0 / far) / (1.0 / near - 1.0 / far);'
    + ' gl_FragColor = vec4(vec3(pow(clamp(d, 0.0, 1.0), 0.8)), 1.0); }',
});
// first export pass: linear depth packed into RGB (alpha 1 marks a hit), to find the clip's
// nearest and farthest points
export const RANGE = 400;
export const rangeMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide, vertexShader: VERT,
  fragmentShader: `varying float vz; void main() { float d = clamp(vz / ${RANGE}.0, 0.0, 0.9999);`
    + ' vec3 e = fract(d * vec3(1.0, 255.0, 65025.0)); e -= e.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);'
    + ' gl_FragColor = vec4(e, 1.0); }',
});

export function setup() {
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

  // the free view (see setFree): its own camera and orbit, in place of the shot camera's
  viewCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 500);
  viewCam.position.set(5, 4, 7);
  viewControls = new OrbitControls(viewCam, canvas);
  viewControls.enableDamping = false; viewControls.enabled = false;
  viewControls.target.set(0, 1, 0); viewControls.update();
  viewControls.addEventListener('change', () => draw());
  shotCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.3, 3);  // (only drawn: short, so the frustum stays small)
  frustum = new THREE.CameraHelper(shotCam); frustum.visible = false; scene.add(frustum);
  stage = new THREE.Mesh(new THREE.CircleGeometry(2, 64).rotateX(-Math.PI / 2), floorMat);  // Create object's floor
  stage.visible = false; scene.add(stage);

  gizmo = new TransformControls(camera, canvas);
  gizmo.setSize(1.15);
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('change', () => { if (!R.applying) draw(); });
  gizmo.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (!e.value) { save(); renderKeys(); renderPanel(); }
  });
  gizmo.addEventListener('objectChange', () => {
    const o = selItem(), m = o && R.meshes.get(o.id);
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


  new ResizeObserver(() => fit()).observe(viewer);
}

function readCamera() {
  return { px: camera.position.x, py: camera.position.y, pz: camera.position.z,
    tx: controls.target.x, ty: controls.target.y, tz: controls.target.z, fov: camera.fov };
}

// the canvas keeps the output's aspect, as large as fits in the viewer
export function fit() {
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
  viewCam.aspect = a; viewCam.updateProjectionMatrix();
  draw();
}

export function rebuildRoom() {
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

// What scene-import.js plugs in: LOADERS[type](o, group) fills a layer's group (imported models and
// splats load on their own time), passHooks run before each draw with the pass ('depth' or 'color')
export const LOADERS = {};
export const passHooks = [];

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
  } else if (LOADERS[o.type]) {
    m = new THREE.Group(); LOADERS[o.type](o, m);
  } else m = new THREE.Mesh(geometries()[TYPES[o.type].geo || o.type], clay);
  m.userData.id = o.id; scene.add(m); R.meshes.set(o.id, m);
  return m;
}
export function paint(m, on) {  // a photo keeps its picture
  if (m.userData.rig) for (const p of m.userData.rig.meshes) p.material = on ? figSel : figClay;
  else if (m.isMesh) m.material = on ? claySel : clay;
}

// ---- photos: a picture as a mesh (MoGe, made by /api/scene/photo), in glTF axes: the photo's camera
// at the object's origin looking down its -Z, so placing the object places that camera
const gltf = new GLTFLoader();
const photoScenes = new Map();  // url: Promise of the loaded mesh, shared by every copy
export function photoScene(url) {
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
export function photoLens(src) {
  let t = 0;
  const p = new THREE.Vector3(), box = new THREE.Box3().setFromObject(src);
  src.traverse((c) => {
    const a = c.isMesh && c.geometry.attributes.position;
    if (a) for (let i = 0; i < a.count; i += 7) { p.fromBufferAttribute(a, i); if (p.z < -1e-4) t = Math.max(t, Math.abs(p.y / p.z)); }
  });
  return { fov: t ? THREE.MathUtils.radToDeg(2 * Math.atan(t)) : 50, dist: Math.max(0.3, -box.getCenter(p).z) };
}
// the shot camera where the photo was taken (and with its lens)
export function lookThrough(o) {
  const v = current(o, OBJ), r = THREE.MathUtils.degToRad;
  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(r(v.rx), r(v.ry), r(v.rz)));
  const t = fwd.multiplyScalar((o.dist || 3) * v.sy).add(new THREE.Vector3(v.x, v.y, v.z));
  write(SC.camera, CAM, { px: v.x, py: v.y, pz: v.z, tx: t.x, ty: t.y, tz: t.z, fov: o.fov || 50 });
}


// put a "3d photo" generation into the scene where the shot camera is, seen through its lens
export async function addPhoto(g) {
  await hooks.ready();
  const out = g.outputs.find((x) => /\.glb$/i.test(x.filename));
  if (!out) return toast('That run has no 3D mesh', true);
  let lens;
  try { lens = photoLens(await photoScene(out.url)); } catch (e) { return toast(e.message, true); }
  if (modeOf().stage === 'empty') setSceneMode('edit');   // (a photo belongs to the scene)
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
export async function makePhoto(name) {
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
export const jointMode = () => (FIGURE.IK[R.joint] && R.mode === 'translate' ? 'translate' : 'rotate');
const selRig = () => R.meshes.get(R.sel)?.userData.rig || null;
export function selectJoint(name) {
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
  if (o.type === 'photo' || LOADERS[o.type]) {  // (the mesh itself sits on the floor at its origin)
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

export function syncMeshes() {
  const ids = new Set(SC.objects.map((o) => o.id));
  for (const [id, m] of R.meshes) if (!ids.has(id)) { scene.remove(m); R.meshes.delete(id); m.userData.dispose?.(); }
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id) || makeObject(o);
    paint(m, o.id === R.sel);
    m.visible = !o.hidden && onStage();
  }
  for (const m of R.room) {
    m.visible = !SC.room.hidden && onStage();
    m.material = R.sel === ROOM ? roomSel : m === R.room[0] ? floorMat : wallMat;
  }
  const o = selItem();
  const m = o && !o.hidden && onStage() ? R.meshes.get(o.id) : null;
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
export function pose(f) {
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
  syncFrustum();
}

// helpers (grid, gizmo) only in the editing view, never in a render
export function draw(forRender = false) {
  if (!renderer) return;
  const depth = R.depth || forRender === 'depth';
  scene.overrideMaterial = depth ? depthMat : null;
  scene.background.set(depth ? 0x000000 : 0x24272e);
  grid.visible = !forRender && !depth;
  for (const f of passHooks) f(depth || forRender === 'range' ? 'depth' : 'color');
  frustum.visible = wantFrustum() && !forRender && !depth;
  stage.visible = !onStage() && !forRender;
  gizmo.getHelper().visible = !forRender && !R.playing && !!gizmo.object;
  const dots = !forRender && !depth && !R.playing;
  for (const [id, m] of R.meshes) {
    for (const d of m.userData.rig?.dots || []) { d.visible = dots && id === R.sel; d.material = d.userData.joint === R.joint ? dotSel : dotMat; }
  }
  if (!forRender) {
    if (depth) setRange(roughRange());
    renderer.render(scene, R.free ? viewCam : camera);
  }
}

export function refresh() { syncMeshes(); pose(R.f); draw(); }

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
export function setRange([near, far]) { depthMat.uniforms.near.value = near; depthMat.uniforms.far.value = far; }

const ray = new THREE.Raycaster();
function hitAt(e) {
  if (!modeOf().select) return null;
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
export function select(id) { R.sel = modeOf().select ? id : null; R.joint = null; refresh(); renderToolbar(); renderKeys(); renderPanel(); }
export function setMode(m) { R.mode = m; refresh(); renderToolbar(); }

export function changed() { save(); refresh(); renderKeys(); renderPanel(); }

export function removeSelected() {
  const before = clone(SC), sel = R.sel, ok = sameTab();
  let name;
  if (sel === ROOM) { name = 'Room'; SC.room = null; rebuildRoom(); }
  else { const o = selItem(); if (!o) return; name = o.name; SC.objects = SC.objects.filter((x) => x !== o); }
  R.sel = null; R.joint = null; changed(); renderToolbar();
  undoToast(`${name} deleted`, () => { if (ok()) { setSC(before); R.sel = sel; rebuildRoom(); changed(); renderToolbar(); } });
}

export function addObject(type) {
  closeSheet();
  if (type === ROOM) { SC.room = newRoom(); rebuildRoom(); select(ROOM); save(); return; }
  const c = controls.target;
  const o = newObject(type, { x: +c.x.toFixed(2), z: +(type === 'wall' ? c.z - 2 : c.z).toFixed(2) });
  SC.objects.push(o); save(); select(o.id);
}

// ---- modes' views: a free view for looking at the room (and, with the shot camera drawn in it, for
// directing it), and the empty stage of Create object
const onStage = () => modeOf().stage !== 'empty';   // the scene is on show (Create object has an empty stage of its own)
const wantFrustum = () => R.free && !!modeOf().frustum;
export function setFree(on) {
  R.free = !!on;
  controls.enabled = !on; viewControls.enabled = !!on;
  if (R.free) pose(R.f);   // (puts the frustum where the camera is now)
  draw();
}
// aim the free view at a point from where
export function aimFree(at, target) { viewCam.position.set(...at); viewControls.target.set(...target); viewControls.update(); draw(); }
// the shot camera set to what the free view sees (its lens stays)
export function cameraFromView() {
  const p = viewCam.position, t = viewControls.target;
  write(SC.camera, CAM, { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z });
}
function syncFrustum() {
  if (!wantFrustum()) return;
  shotCam.position.copy(camera.position); shotCam.quaternion.copy(camera.quaternion);
  shotCam.fov = camera.fov; shotCam.aspect = camera.aspect; shotCam.updateProjectionMatrix();
  shotCam.updateMatrixWorld(true); frustum.update();
}

