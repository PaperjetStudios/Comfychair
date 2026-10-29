import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import * as THREE from './vendor/three.module.min.js';
import { TransformControls } from './vendor/TransformControls.js';
import * as FIGURE from './figure.js';
import { $, api, busy as busyBar, canvasFont, clone, closeSheet, h, store, toast, undoToast } from './ui.js';
import { gzChip, smoothGizmo, snap3, snapMenu3 } from './gizmo.js';
import { ORIENTS, centrePoint, follow, frameQuat, orientOf, relQuat, spaceOf } from './gizmo-orient.js';
import {
  C, CAM, EVEN, applyRoll, FIG, MODES, OBJ, R, ROOM, SC, TYPES, WP, current, frames, holdStart, hooks, liveCam, pathSig, makers, namesFor, newObject, newRoom, pivotOf, sample,
  sameTab, save, selItem, setActiveCam, setSC, write
} from './scene-data.js';
import { letGo } from './scene-export.js';
import { modeOf } from './scene-modes.js';
import { renderKeys, renderPanel, renderToolbar, setSceneMode } from './scene-ui.js';
import { placeAtCamera, sharpOn } from './splat-levels.js';
import { standShift } from './splat-shape.js';
import { renderDepth, setSplatRange, splatDepths, splatMeshes } from './splat-depth.js';
// the SparkRenderer once scene-import.js has made one (a depth picture draws the splats in a pass of their own)
export const SPLAT_PASS = { spark: null };

// ---- geometry ----------------------------------------------------------------
// A soft, featureless figure turned on a lathe: feet, legs as one column, hips, waist, chest,
// neck and head in one smooth outline. Unit size (1 wide, 1 tall, base at y=0), scaled per object.
export const PERSON_PROFILE = [[0, 0], [0.27, 0], [0.29, 0.02], [0.25, 0.08], [0.28, 0.27], [0.36, 0.45], [0.4, 0.52],
  [0.33, 0.63], [0.44, 0.73], [0.5, 0.8], [0.4, 0.83], [0.11, 0.855], [0.12, 0.875], [0.18, 0.91], [0.185, 0.95],
  [0.13, 0.99], [0, 1]];
let GEO;
export function geometries() {
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
let snapGrid, smooth;   // the floor grid shown while grid snapping is on; the gizmo's smoothing (gizmo.js)
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
// what the gizmo drags in the director view: the shot camera itself (keeps its distance to what it looks at)
const camProxy = new THREE.Object3D();
const ikTarget = new THREE.Object3D();  // what the gizmo drags when a hand or foot is moved (IK)
// what the gizmo holds for a whole object: at its pivot, scaled with it and turned like the gizmo's axes (the
// object's own turn in World and Local, the view's in View: gizmo-orient.js). pivotAt is the pivot in the object's own
// space, kept still while dragging; pivotRel the object's turn relative to the stand-in's.
const pivot = new THREE.Object3D(), pivotAt = new THREE.Vector3();
let pivotRel = [0, 0, 0, 1];
// the shot camera's pivot in the director view (in its own space: the camera itself unless moved) and its turn
// relative to camProxy's
let camAt = [0, 0, 0], camRel = [0, 0, 0, 1];
// "Pivot at the view centre": a stand-in pivot for one thing (an object, or the active camera) until reset or the
// selection changes; at is in the thing's own space. Not saved: the thing's data keeps its own origin and pivot.
let tmpPivot = null;
// (the skinning chunks pose an imported character's bones; plain meshes pass through them)
const VERT = `#include <skinning_pars_vertex>
varying float vz;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv;
}`;
export const depthMat = new THREE.ShaderMaterial({
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

let built = false;   // setup has made everything draw() uses
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
  scene.add(ikTarget, pivot, camProxy);
  R.orient = orientOf(store.get('deck.scene.orient', 'world'));   // the gizmo's axes (this device's choice)
  R.viewCut = store.get('deck.scene.viewcut', true) !== false;   // the picture follows the cuts, unless you are editing a camera
  R.shotFmt = store.get('deck.scene.shotfmt', 'h3') === 'ltx' ? 'ltx' : 'h3';

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  // (orbiting aims the camera level: the roll goes back on). While it plays, the orbit is held over the camera's keys.
  controls.addEventListener('start', () => holdStart('orbit'));
  controls.addEventListener('change', () => {
    if (R.applying || shownCam(R.f) !== SC.camera) return;   // a cut's camera is only looked through: dragging it does not move the one you edit
    applyRoll(camera, current(SC.camera, CAM).roll);
    if (R.playing) write(SC.camera, CAM, readCamera());
    followView(); draw();
  });
  controls.addEventListener('end', () => {
    if (shownCam(R.f) !== SC.camera) { letGo('orbit'); return; }
    const c = readCamera(), was = current(SC.camera, CAM);
    if (CAM.some((n) => Math.abs(c[n] - was[n]) >= 1e-6)) {  // (a tap, not a move: no key)
      write(SC.camera, CAM, c);  // with auto key off on an animated camera, only held (see TEMP)
      save(); renderKeys(); if (!R.sel && !R.playing) renderPanel();
    }
    letGo('orbit');
  });

  // the free view (see setFree): its own camera and orbit, in place of the shot camera's
  viewCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 500);
  viewCam.position.set(5, 4, 7);
  viewControls = new OrbitControls(viewCam, canvas);
  viewControls.enableDamping = false; viewControls.enabled = false;
  viewControls.target.set(0, 1, 0); viewControls.update();
  viewControls.addEventListener('change', () => { followView(); draw(); });
  shotCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.3, 3);  // (only drawn: short, so the frustum stays small)
  frustum = new THREE.CameraHelper(shotCam); frustum.visible = false; scene.add(frustum);
  stage = new THREE.Mesh(new THREE.CircleGeometry(2, 64).rotateX(-Math.PI / 2), floorMat);  // Create object's floor
  stage.visible = false; scene.add(stage);

  gizmo = new TransformControls(camera, canvas);
  gizmo.setSize(1.15);
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('change', () => { if (!R.applying) draw(); });
  // controls off while a handle is held (the free view has its own); the drag is smoothed and snapped
  // (gizmo.js), then saved once after it settles
  gizmo.addEventListener('dragging-changed', (e) => { (R.free ? viewControls : controls).enabled = !e.value; });
  smooth = smoothGizmo(gizmo, {
    canvas, fix: fixTarget, redraw: () => draw(),
    apply: (o) => { if (gizmo.object === o) { applyChange(); draw(); } },
    settle: () => { save(); renderKeys(); renderPanel(); },
    end: () => { letGo('gizmo'); placeHandle(); },
    start: () => holdStart('gizmo'),
  });
  // hovering a handle with a pen (or mouse) lights it before contact: the stage draws on demand, so it needs a nudge
  let hoverAxis = null;
  canvas.addEventListener('pointermove', () => { if (gizmo.axis !== hoverAxis) { hoverAxis = gizmo.axis; draw(); } });
  snapGrid = new THREE.Object3D(); scene.add(snapGrid);
  const bar = snapMenu3(() => { floorGrid(); draw(); });
  bar.classList.add('gz-3d', 'ctx'); viewer.append(bar);
  floorGrid();

  // a tap (not a drag, not on a gizmo handle) selects what's under it; tapping the selected
  // object again switches the gizmo between Move, Rotate and Scale. On a selected figure, a tap on
  // a joint dot picks the joint; a tap on its body goes back to the whole figure.
  let down = null;
  // a bone dot under the pointer starts a reach: a camera-facing plane through the bone, the orbit held
  const BDRAG = { on: false, id: null, bone: null, pid: null, plane: new THREE.Plane(), p: new THREE.Vector3() };
  function planeHit(e) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
    return ray.ray.intersectPlane(BDRAG.plane, BDRAG.p);
  }
  function boneDragEnd() {
    if (!BDRAG.on) return;
    BDRAG.on = false;
    controls.enabled = true;
    boneDrag?.end(BDRAG.id, BDRAG.bone);
    holdEnd('bonedrag');
  }
  canvas.addEventListener('pointerdown', (e) => {
    const bone = !HAND.on && (e.button === 0 || e.pointerType !== 'mouse') && !gizmo.dragging && gizmo.axis == null ? boneDotAt(e) : null;
    const dot = bone && (R.meshes.get(R.sel)?.userData.dots || []).find((x) => x.userData.joint === bone);
    if (dot) {
      const w = dot.getWorldPosition(new THREE.Vector3());
      BDRAG.plane.setFromNormalAndCoplanarPoint(activeCamera().getWorldDirection(new THREE.Vector3()).negate(), w);
      Object.assign(BDRAG, { on: true, id: R.sel, bone, pid: e.pointerId });
      controls.enabled = false;
      holdStart('bonedrag');
      bonePick?.(R.sel, bone);
      down = null;
      return;
    }
    down = { x: e.clientX, y: e.clientY, onGizmo: gizmo.dragging || gizmo.axis != null };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!BDRAG.on) return;
    const p = planeHit(e);
    if (p) boneDrag?.move(BDRAG.id, BDRAG.bone, p);
  });
  canvas.addEventListener('pointercancel', boneDragEnd);
  // letting go outside the canvas (or the window losing the pointer) ends the reach too, or the orbit stays off
  window.addEventListener('pointerup', (e) => { if (BDRAG.on && e.pointerId === BDRAG.pid) boneDragEnd(); });
  window.addEventListener('pointercancel', (e) => { if (BDRAG.on && e.pointerId === BDRAG.pid) boneDragEnd(); });
  canvas.addEventListener('pointerup', (e) => {
    if (BDRAG.on) { boneDragEnd(); down = null; return; }
    if (HAND.on) { down = null; return; }   // (Hand mode keeps the figure: a tap doesn't change what's selected)
    if (!down || down.onGizmo || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
    down = null;
    const joint = jointAt(e);
    if (joint) return selectJoint(joint);
    const bone = boneDotAt(e);
    if (bone) { bonePick?.(R.sel, bone); return; }
    const other = otherCamAt(e);
    if (other) { setActiveCam(other); R.sel = null; changed(); toast(`${other.name} is active`); return; }
    const id = hitAt(e);
    if (id && id === R.sel && R.joint) selectJoint(null);
    else if (id && id === R.sel && id !== ROOM) setMode(MODES[(MODES.findIndex(([m]) => m === R.mode) + 1) % MODES.length][0]);
    else select(id);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Hand mode's fingertip drags, ahead of the orbit and the gizmo (capture on the viewer)
  viewer.addEventListener('pointerdown', tipDown, true);
  viewer.addEventListener('pointermove', tipMove, true);
  viewer.addEventListener('pointerup', tipUp, true);
  viewer.addEventListener('pointercancel', tipUp, true);


  new ResizeObserver(() => fit()).observe(viewer);
  built = true;
}

// the grid snapping moves to, drawn on the floor (rebuilt when the step changes)
function floorGrid() {
  if (snapGrid.userData.m === snap3.gridM) return;
  snapGrid.userData.m = snap3.gridM;
  snapGrid.clear();
  const n = Math.round(20 / snap3.gridM);
  const g = new THREE.GridHelper(n * snap3.gridM, n, 0x93b4e6, 0x6a84ad);
  g.position.y = 0.003; snapGrid.add(g);
}

// the gizmo's target holds a whole turn of an even-scaled thing as one number: follow whichever axis moved
function fixTarget(o, start) {
  if (o !== pivot) return;
  const it = selItem();
  if (!it || !EVEN.has(it.type)) return;
  const s = [o.scale.x, o.scale.y, o.scale.z].find((v) => Math.abs(v - start.sy) > 1e-6) ?? start.sy;
  o.scale.setScalar(Math.max(1e-4, s));
}

// each frame of a drag (and its settling): the object the gizmo holds is where the spring has it, so
// the scene follows it and the change is written (a key, or the base)
function applyChange() {
  if (gizmo.object === camProxy) return camChanged();
  const o = selItem(), m = o && R.meshes.get(o.id);
  if (!o || !m) return;
  if (R.joint) return jointChanged(o);
  const p = pivot;
  // the object follows the pivot: turned (relative to it) and scaled around it
  const t = follow(p.position.toArray(), p.quaternion.toArray(), pivotRel, pivotAt.toArray(), p.scale.toArray());
  m.quaternion.fromArray(t.q); m.scale.copy(p.scale); m.position.fromArray(t.p);
  const d = THREE.MathUtils.radToDeg;
  write(o, namesFor(o), { x: m.position.x, y: m.position.y, z: m.position.z,
    rx: d(m.rotation.x), ry: d(m.rotation.y), rz: d(m.rotation.z),
    sx: Math.max(1e-4, m.scale.x), sy: Math.max(1e-4, m.scale.y), sz: Math.max(1e-4, m.scale.z) });
}

// the shot camera put where the proxy is, looking along it at what it looked at (same distance)
// (at the camera, or at its stand-in pivot; turned like the gizmo's axes, camRel being the camera's turn relative to it)
function placeCamProxy() {
  camera.updateMatrixWorld();
  camAt = tmpPivot?.item === SC.camera ? tmpPivot.at : [0, 0, 0];
  camProxy.position.copy(camera.localToWorld(new THREE.Vector3(...camAt)));
  camProxy.quaternion.fromArray(frameQuat(R.orient, 'translate', camera.quaternion.toArray(), activeCamera().quaternion.toArray()));
  camProxy.scale.set(1, 1, 1);
  camRel = relQuat(camProxy.quaternion.toArray(), camera.quaternion.toArray());
  camProxy.userData.d = Math.max(0.5, camera.position.distanceTo(controls.target));
  camProxy.updateMatrixWorld();
}
function camChanged() {
  const at = follow(camProxy.position.toArray(), camProxy.quaternion.toArray(), camRel, camAt);
  const p = new THREE.Vector3(...at.p), q = new THREE.Quaternion(...at.q);
  const t = new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(camProxy.userData.d).add(p);
  // the roll is what is left of the camera's turn once it is aimed level (applyRoll's sign)
  const lvl = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(p, t, camera.up)), dq = lvl.invert().multiply(q);
  const c = { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z, fov: camera.fov, roll: -THREE.MathUtils.radToDeg(2 * Math.atan2(dq.z, dq.w)) };
  if (c.roll < -180) c.roll += 360; else if (c.roll > 180) c.roll -= 360;
  write(SC.camera, CAM, { px: c.px, py: c.py, pz: c.pz, tx: c.tx, ty: c.ty, tz: c.tz, roll: c.roll });
  putCamera(c);
}
export const camGizmo = () => !!gizmo && gizmo.object === camProxy;

function readCamera() {
  return { px: camera.position.x, py: camera.position.y, pz: camera.position.z,
    tx: controls.target.x, ty: controls.target.y, tz: controls.target.z, fov: camera.fov, roll: current(SC.camera, CAM).roll };
}

// the canvas keeps the output's aspect, as large as fits in the viewer
export function fit() {
  if (!viewer) return;
  const vw = viewer.clientWidth, vh = viewer.clientHeight;
  if (!vw || !vh) return;
  const a = SC.width / SC.height;
  const w = Math.min(vw, vh * a), hh = w / a;
  // a splat in view on a touch screen: drawn at 1x (a tablet's 2-3x is 4-9x the work, and splats are soft anyway),
  // unless the splat panel's Sharp is on
  const splats = matchMedia('(pointer: coarse)').matches && !sharpOn() && [...R.meshes.values()].some((m) => m.userData.splat && m.visible);
  const dpr = splats ? 1 : Math.min(window.devicePixelRatio || 1, 2);
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
// splats load on their own time), passHooks run before each draw with the pass ('depth' or 'color') and what the
// draw is for (false: the view; else a render's kind)
export const LOADERS = {};
export const passHooks = [];
// a skinned model's bone dots are picked here; scene.js hands the layer and bone to scene-skin.js
let bonePick = null;
export const setBonePick = (fn) => { bonePick = fn; };
// ...and dragging one reaches for the pointer (scene-skin.js solves the chain with web/ik.js)
let boneDrag = null;
export const setBoneDrag = (h) => { boneDrag = h; };

// a layer's three.js object: a mesh, a figure's rig (userData.rig, its root group), or a group the
// photo's mesh loads into
function makeObject(o) {
  let m;
  if (o.type === 'figure') {
    const rig = FIGURE.buildFigure(figClay, dotMat, o.body);
    m = rig.root; m.userData.rig = rig; m.userData.body = FIGURE.bodyOf(o.body);
    for (const p of rig.meshes) p.userData.id = o.id;
  } else if (o.type === 'photo') {
    m = new THREE.Group(); loadPhoto(o, m);
  } else if (makers[o.type]) m = makers[o.type](o);
  else if (LOADERS[o.type]) {
    m = new THREE.Group(); LOADERS[o.type](o, m);
  } else m = new THREE.Mesh(geometries()[TYPES[o.type].geo || o.type], clay);
  m.userData.id = o.id; scene.add(m); R.meshes.set(o.id, m);
  return m;
}
export function paint(m, on) {  // a photo keeps its picture
  if (m.userData.paint) return m.userData.paint(on);   // (an object layer keeps its own colour)
  if (m.userData.rig && !m.userData.skin) for (const p of m.userData.rig.meshes) p.material = on ? figSel : figClay;
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
    if (o.view) s.position.set(...o.view.pos);   // (centred: the photo's camera is at o.view.pos)
    group.add(s); draw();
  }).catch((e) => toast(`${o.name}: ${e.message}`, true));
}
// where a photo's mesh goes to stand centred on the floor at its object's origin (the middle 99% of its points, as a
// splat's box): the shift, which is also where the photo's camera (the mesh's origin) ends up
export function photoShift(src) {
  const p = new THREE.Vector3(), a = [[], [], []];
  src.updateMatrixWorld(true);
  src.traverse((c) => {
    const pos = c.isMesh && c.geometry.attributes.position;
    if (pos) for (let i = 0; i < pos.count; i += 7) { p.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld); a[0].push(p.x); a[1].push(p.y); a[2].push(p.z); }
  });
  if (!a[0].length) return [0, 0, 0];
  const box = [];
  for (const q of [0.005, 0.995]) for (const v of a) { v.sort((x, y) => x - y); box.push(v[Math.min(v.length - 1, Math.floor(v.length * q))]); }
  return standShift(box, false);
}
// A photo's mesh or splat placed the old way (at the camera) moves to the world's origin, standing centred on the
// floor and upright, and keeps where its photo was taken (o.view), so Camera to the photo's view still works
export async function recentre(o) {
  const pos = o.type === 'photo' ? photoShift(await photoScene(o.url)) : standShift(o.box || [0, 0, 0, 0, 0, 0], o.flip);
  o.view = { pos };
  write(o, OBJ.filter((k) => ['x', 'y', 'z', 'rx', 'ry', 'rz'].includes(k)), { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
  R.meshes.get(o.id)?.userData.splat?.fit();
  const g = R.meshes.get(o.id);
  if (o.type === 'photo' && g) for (const c of g.children) c.position.set(...pos);
  lookThrough(o);
  changed();
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
// the shot camera where the photo was taken (and with its lens): the object's origin, or o.view.pos in its space
export function lookThrough(o) {
  const v = current(o, OBJ), r = THREE.MathUtils.degToRad, rot = new THREE.Euler(r(v.rx), r(v.ry), r(v.rz));
  const at = new THREE.Vector3(...(o.view?.pos || [0, 0, 0])).multiplyScalar(v.sy).applyEuler(rot).add(new THREE.Vector3(v.x, v.y, v.z));
  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(rot);
  const t = fwd.multiplyScalar((o.dist || 3) * v.sy).add(at);
  write(SC.camera, CAM, { px: at.x, py: at.y, pz: at.z, tx: t.x, ty: t.y, tz: t.z, fov: o.fov || 50, roll: 0 });
}


// put a "3d photo" generation into the scene where the shot camera is, seen through its lens
export async function addPhoto(g) {
  await hooks.ready();
  const out = g.outputs.find((x) => /\.glb$/i.test(x.filename));
  if (!out) return toast('That run has no 3D mesh', true);
  let lens, src;
  try { src = await photoScene(out.url); lens = photoLens(src); } catch (e) { return toast(e.message, true); }
  if (modeOf().stage === 'empty') setSceneMode('edit');   // (a photo belongs to the scene)
  // centred at the world's origin, standing on the floor (the camera moves to the photo's view), or at the camera
  const d = THREE.MathUtils.radToDeg, c = camera, here = placeAtCamera();
  const o = newObject('photo', here ? { x: c.position.x, y: c.position.y, z: c.position.z,
    rx: d(c.rotation.x), ry: d(c.rotation.y), rz: d(c.rotation.z) } : { x: 0, y: 0, z: 0 });
  Object.assign(o, { url: out.url, gen: g.id, image: g.params.image, fov: +lens.fov.toFixed(2), dist: +lens.dist.toFixed(3) });
  if (!here) o.view = { pos: photoShift(src) };
  o.name = `Photo #${g.id}`;
  SC.objects.push(o);
  lookThrough(o);
  save(); select(o.id);
  toast('Photo added: small camera moves look best (nothing is behind what the picture shows)');
}

// picture in, SHARP on the server, splat into the scene at the shot camera (scene-import.js makeSplat)
export async function makeSplatHere(name) {
  await hooks.ready();
  if (modeOf().stage === 'empty') setSceneMode('edit');
  return (await import('./scene-import.js')).makeSplat(name, { lookThrough, camera, busyBar });
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
  // (a hand or foot has no turn of its own to drag along: World and Local are the world's axes, View the view's)
  if (R.orient === 'view') ikTarget.quaternion.copy(activeCamera().quaternion); else ikTarget.quaternion.identity();
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
  return new THREE.Vector3(0, { base: 0, center: 0.5, top: 1 }[k] * (m.userData.height ?? 1), 0);  // the shapes are 1 tall, base at 0 (an object layer says its own height)
}
function placePivot() {
  const o = selItem(), m = o && R.meshes.get(o.id);
  if (!m) return;
  if (tmpPivot?.item === o) { m.updateMatrixWorld(true); pivotAt.fromArray(tmpPivot.at); } else pivotAt.copy(pivotPoint(o, m));
  pivot.position.copy(m.localToWorld(pivotAt.clone()));
  pivot.quaternion.fromArray(frameQuat(R.orient, R.mode, m.quaternion.toArray(), activeCamera().quaternion.toArray()));
  pivotRel = relQuat(pivot.quaternion.toArray(), m.quaternion.toArray());
  pivot.scale.copy(m.scale);
  pivot.updateMatrixWorld();
}
// View axes follow the view: put the gizmo's stand-in back each time the view moves (not while a handle is held)
function followView() { if (R.orient === 'view') placeHandle(); }
// the stand-in put back on what it holds: after the view moves, and after a drag (a View turn leaves it turned off the view's axes)
function placeHandle() {
  if (!gizmo?.object || gizmo.dragging || smooth?.settling()) return;
  if (gizmo.object === pivot) placePivot();
  else if (gizmo.object === ikTarget) placeIkTarget();
  else if (gizmo.object === camProxy) placeCamProxy();
}

// ---- the gizmo's axes (World / Local / View, remembered on this device) and its stand-in pivot
export function setOrient(k) {
  R.orient = orientOf(k); store.set('deck.scene.orient', R.orient);
  refresh(); renderToolbar();
}
export const orientLabel = () => (ORIENTS.find(([k]) => k === R.orient) || ORIENTS[0])[1];
// what "Pivot at the view centre" can move: the selected object (not a joint) or, in the director view, the camera
const pivotItem = () => (camGizmo() ? SC.camera : !R.joint && !HAND.on && gizmo?.object === pivot ? selItem() : null);
export const canPivot = () => !!pivotItem();
export const pivotMoved = () => !!tmpPivot && tmpPivot.item === pivotItem();
// the gizmo's pivot to where the middle of the view meets the thing (or as far along that line as its pivot was), so
// it turns and scales around what is being looked at
export function pivotToView() {
  const it = pivotItem();
  if (!it) return;
  const cam = activeCamera();
  cam.updateMatrixWorld();
  ray.setFromCamera(new THREE.Vector2(0, 0), cam);
  const r = ray.ray, cut = (xs) => xs.find((x) => x.object.visible || x.object.userData.pickProxy);
  if (it === SC.camera) {   // (the shot camera: around what the free view looks at)
    const hit = cut(ray.intersectObjects(visibleMeshes(), true));
    const pt = centrePoint(r.origin.toArray(), r.direction.toArray(), hit?.point.toArray() ?? null, controls.target.toArray());
    camera.updateMatrixWorld();
    tmpPivot = { item: it, at: camera.worldToLocal(new THREE.Vector3(...pt)).toArray() };
  } else {
    const m = R.meshes.get(it.id);
    if (!m) return;
    m.updateMatrixWorld(true);
    const hit = cut(ray.intersectObject(m, true));
    const pt = centrePoint(r.origin.toArray(), r.direction.toArray(), hit?.point.toArray() ?? null, pivot.position.toArray());
    tmpPivot = { item: it, at: m.worldToLocal(new THREE.Vector3(...pt)).toArray() };
  }
  refresh(); renderToolbar();
}
export function resetPivot() {
  if (!tmpPivot) return;
  tmpPivot = null; refresh(); renderToolbar();
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
  for (const o of SC.objects) {  // a figure that changed body is built again
    const m = R.meshes.get(o.id);
    if (m?.userData.rig && m.userData.body !== FIGURE.bodyOf(o.body)) { scene.remove(m); R.meshes.delete(o.id); }
  }
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id) || makeObject(o);
    paint(m, o.id === R.sel);
    m.visible = !o.hidden && onStage();
  }
  for (const m of R.room) {
    m.visible = !!SC.room && !SC.room.hidden && onStage();   // (no room: it was deleted, its meshes go at the next rebuild)
    m.material = R.sel === ROOM ? roomSel : m === R.room[0] ? floorMat : wallMat;
  }
  const o = selItem();
  const m = o && !o.hidden && onStage() ? R.meshes.get(o.id) : null;
  if (R.joint && !m?.userData.rig) R.joint = null;
  const target = HAND.on ? null : !m ? (R.free && wantFrustum() ? camProxy : null) : !R.joint ? pivot : jointMode() === 'translate' ? ikTarget : m.userData.rig.bones[R.joint];
  if (target) {
    const was = gizmo.object;
    gizmo.setMode(R.joint ? jointMode() : target === camProxy && R.mode === 'scale' ? 'translate' : R.mode);
    // (a joint turns on its own axes; everything else as picked: World, Local or View)
    gizmo.setSpace(R.joint && jointMode() === 'rotate' ? 'local' : spaceOf(R.orient));
    if (was !== target) { gizmo.attach(target); if (target === camProxy) placeCamProxy(); }
  } else gizmo.detach();
}

// a figure's walk or run steps along with how far it has moved (unless set by hand), so its feet
// don't slide: the step phase is the distance covered over the stride length
const PATHS = new Map();  // figure: { sig, d: metres covered by each frame }
function travelled(o, f) {
  const sig = pathSig(o);
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
  if (!m || !(m.walk || m.run) || o.stepsFollow === false || (o.mute && !R.real)) return m;
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
    if (EVEN.has(o.type)) m.scale.setScalar(Math.max(1e-4, v.sy));
    else m.scale.set(Math.max(0.01, v.sx), Math.max(0.01, v.sy), Math.max(0.01, v.sz));
    if (m.userData.rig) { FIGURE.setShape(m.userData.rig, o.shape, o.anatomy); FIGURE.applyPose(m.userData.rig, v.j, stepped(o, v.m, f), o.ground); FIGURE.setHidden(m.userData.rig, o.hide); }
    m.userData.atFrame?.(f);   // (a footage layer shows its frame, scene-track.js)
  }
  // the director view's frustum stays the camera you edit; a render, and the shot view, follow the cuts
  const camItem = R.free && !R.real ? SC.camera : shownCam(f);
  putCamera(current(camItem, CAM, f));
  if (!R.real) syncShotOrbit();
  if (gizmo.dragging || smooth?.settling()) return;   // (a held handle keeps its own place)
  if (gizmo.object === ikTarget) placeIkTarget();
  if (gizmo.object === pivot) placePivot();
  if (gizmo.object === camProxy) placeCamProxy();
}
// editing a camera: Camera mode, or the camera layer selected (not while it plays, and not the Shots row)
function editingCamera() {
  if (R.playing || R.real || R.sel === 'cuts') return false;
  return modeOf().key === 'camera' || R.sel == null;
}
// the camera the picture is drawn through. Renders always follow the cuts. The Cut / Cam toggle
// (R.viewCut) does too, unless you are editing a camera: then you see the one you edit.
export function shownCam(f = R.f) {
  if (R.real || (R.viewCut && !editingCamera())) return liveCam(f);
  return SC.camera;
}
// orbit writes the camera you edit only while that camera is the one on show
function syncShotOrbit() {
  if (!controls || R.free) return;
  if (!gizmo?.dragging) controls.enabled = shownCam(R.f) === SC.camera;
}
function putCamera(c) {
  R.applying = true;
  camera.position.set(c.px, c.py, c.pz);
  controls.target.set(c.tx, c.ty, c.tz);
  camera.fov = c.fov; camera.updateProjectionMatrix();
  controls.update();
  applyRoll(camera, c.roll);
  R.applying = false;
  syncFrustum();
}

// helpers (grid, gizmo) only in the editing view, never in a render
export function draw(forRender = false) {
  if (!renderer || !built) return;   // (a pen hovering the gizmo can ask for a frame while setup is still building)
  const depth = R.depth || forRender === 'depth';
  scene.overrideMaterial = depth ? depthMat : null;
  scene.background.set(depth ? 0x000000 : 0x24272e);
  const live = !R.playing;   // (while it plays, the While-playing settings say what shows: WP)
  grid.visible = !forRender && !depth && !snap3.grid && (live || WP.grid);
  snapGrid.visible = !forRender && !depth && snap3.grid && (live || WP.grid);
  for (const f of passHooks) f(depth || forRender === 'range' ? 'depth' : 'color', forRender);
  frustum.visible = wantFrustum() && !forRender && !depth && (live || WP.frustum);
  for (const x of OTHERS.values()) x.group.visible = frustum.visible;
  stage.visible = !onStage() && !forRender;
  gizmo.getHelper().visible = !forRender && (live || WP.gizmo) && !!gizmo.object;
  if (!forRender && !gizmo.dragging) gizmo.enabled = live || WP.gizmo;   // hidden while playing: can't be grabbed either (the drag orbits)
  const dots = !forRender && !depth && (live || WP.dots);
  for (const [id, m] of R.meshes) {
    for (const d of m.userData.rig?.dots || []) { d.visible = dots && id === R.sel && !HAND.on; d.material = d.userData.joint === R.joint ? dotSel : dotMat; }
    for (const d of m.userData.tips || []) { d.visible = dots && HAND.on && id === R.sel && d.userData.side === HAND.side; d.material = d.userData.finger === HAND.drag?.finger ? dotSel : dotMat; }
    for (const d of m.userData.dots || []) { d.visible = dots && id === R.sel; d.material = d.userData.joint === m.userData.pickedBone ? dotSel : dotMat; }
  }
  if (!forRender) {
    if (depth) { setRange(roughRange()); renderDepth(renderer, scene, R.free ? viewCam : camera, SPLAT_PASS.spark); }
    else renderer.render(scene, R.free ? viewCam : camera);
  }
}

// the camera that's on show (the shot camera, or the free view's)
export const activeCamera = () => (R.free ? viewCam : camera);

export function refresh() { syncMeshes(); pose(R.f); draw(); }

const visibleMeshes = () => [...[...R.meshes.values()].filter((m) => m.visible), ...R.room.filter((m) => m.visible)];

// a rough near/far for the live depth view (the export measures the real one)
function roughRange() {
  const box = new THREE.Box3();
  for (const m of visibleMeshes()) box.expandByObject(m);
  // splats: their sampled centres in view (the box around a splat layer doesn't hold its points)
  const zs = splatDepths(splatMeshes(R.meshes.values()), camera).sort((a, b) => a - b);
  const sn = zs.length ? zs[Math.floor(zs.length * 0.01)] : Infinity, sf = zs.length ? zs[Math.floor(zs.length * 0.99)] : 0;
  if (box.isEmpty() && !zs.length) return [0.3, 10];
  const p = camera.position, corners = [];
  if (!box.isEmpty()) for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(p.distanceTo(new THREE.Vector3(x, y, z)));
  const near = Math.min(box.isEmpty() ? Infinity : box.distanceToPoint(p) * 0.8 || 0.3, sn * 0.9);
  return [Math.max(0.3, near), Math.max(...corners, sf * 1.05, 1)];
}
export function setRange([near, far]) { depthMat.uniforms.near.value = near; depthMat.uniforms.far.value = far; setSplatRange([near, far]); }

const ray = new THREE.Raycaster();
function hitAt(e) {
  if (!modeOf().select) return null;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
  // the room and photos only block: tapping them deselects (pick them in the layer list)
  const hit = ray.intersectObjects(visibleMeshes(), true).find((x) => x.object.visible);  // raycasts ignore .visible: hidden figure parts can't be picked
  return hit && hit.object.userData.id !== ROOM && !hit.object.userData.photo ? hit.object.userData.id : null;
}
// the selected figure's joint dot under the pointer (within a finger's reach). Where dots overlap,
// the one nearest the camera wins; anything else in front of it takes the tap instead. Turn the view
// to get at one that's covered.
// joint dots and fingertips hidden while playing (While playing) can't be picked
const dotsOff = () => R.playing && !WP.dots;
function jointAt(e) {
  if (dotsOff()) return null;
  const rig = selRig();
  if (!rig || !rig.root.visible) return null;
  const r = canvas.getBoundingClientRect(), reach = e.pointerType === 'touch' ? 28 : 18;
  rig.root.updateMatrixWorld(true);
  let best = null;
  for (const d of rig.dots) {
    const w = d.getWorldPosition(new THREE.Vector3()), v = w.clone().project(activeCamera());
    if (v.z > 1) continue;
    const dist = Math.hypot(r.left + (v.x + 1) / 2 * r.width - e.clientX, r.top + (1 - v.y) / 2 * r.height - e.clientY);
    const depth = activeCamera().position.distanceTo(w);
    if (dist < reach && (!best || depth < best.depth)) best = { joint: d.userData.joint, depth };
  }
  if (!best) return null;
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
  const front = ray.intersectObjects(visibleMeshes().filter((m) => m !== rig.root), true).find((x) => x.object.visible);
  return front && front.distance < best.depth ? null : best.joint;
}
// a skinned model's bone dot under the pointer (the same reach and depth test as a figure's joint dots)
function boneDotAt(e) {
  if (dotsOff()) return null;
  const m = R.sel && R.meshes.get(R.sel);
  const dots = m?.userData.dots;
  if (!dots?.length) return null;
  const r = canvas.getBoundingClientRect(), reach = e.pointerType === 'touch' ? 28 : 18;
  let best = null;
  for (const d of dots) {
    const w = d.getWorldPosition(new THREE.Vector3()), v = w.clone().project(activeCamera());
    if (v.z > 1) continue;
    const dist = Math.hypot(r.left + (v.x + 1) / 2 * r.width - e.clientX, r.top + (1 - v.y) / 2 * r.height - e.clientY);
    const depth = activeCamera().position.distanceTo(w);
    if (dist < reach && (!best || depth < best.depth)) best = { joint: d.userData.joint, depth };
  }
  if (!best) return null;
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
  const front = ray.intersectObjects(visibleMeshes().filter((m2) => m2 !== m), true).find((x) => x.object.visible);
  return front && front.distance < best.depth ? null : best.joint;
}

// ---- selection, layers ------------------------------------------------------------
export function select(id) {
  if (HAND.on && id !== R.sel) handMode(null);
  if (id !== R.sel) tmpPivot = null;
  const allow = modeOf().select || id === 'cuts' || id == null;   // the Shots row can be picked in Camera mode too
  R.sel = allow ? id : null; R.joint = null; refresh(); renderToolbar(); renderKeys(); renderPanel();
}

// ---- Hand mode: the view closes in on one hand of the selected figure (the free view, so the shot
// camera stays put) and dragging a fingertip curls that finger: toward the knuckles closes it, away
// opens it. One undo step per drag; with keys, it keys the finger at the playhead like any other change.
export const HAND = { on: false, side: 'l', was: null, drag: null, bar: null };
const tipGeo = new THREE.SphereGeometry(0.007, 8, 6);
function tipDots(m) {
  if (m.userData.tips) return m.userData.tips;
  const rig = m.userData.rig;
  m.userData.tips = [];
  for (const side of ['l', 'r']) {
    for (const [f] of FIGURE.FINGERS) {
      const d = new THREE.Mesh(tipGeo, dotMat);
      d.renderOrder = 11; d.visible = false; d.userData.side = side; d.userData.finger = f; d.raycast = () => {};
      rig.marks[`${side}${f}tip`].add(d); m.userData.tips.push(d);
    }
  }
  return m.userData.tips;
}
// side: 'l' or 'r' to frame that hand (entering Hand mode or switching hands), null to leave it
export function handMode(side) {
  const m = R.meshes.get(R.sel), rig = m?.userData.rig;
  if (!side || !rig) {
    if (!HAND.on) return;
    HAND.on = false; HAND.drag = null; HAND.bar?.remove(); HAND.bar = null;
    const w = HAND.was;
    viewCam.position.copy(w.pos); viewControls.target.copy(w.target); viewControls.update();
    setFree(w.free); renderPanel();
    return;
  }
  if (!HAND.on) HAND.was = { free: R.free, pos: viewCam.position.clone(), target: viewControls.target.clone() };
  HAND.on = true; HAND.side = side; R.joint = null;
  tipDots(m);
  setFree(true);
  // look at the palm from a little to the thumb's side and above, close enough to fill the view
  rig.root.updateMatrixWorld(true);
  const hand = rig.bones[`${side}hand`], at = hand.localToWorld(new THREE.Vector3(0, -0.08, 0));
  const toPalm = new THREE.Vector3(side === 'l' ? -0.5 : 0.5, 0.35, -1).transformDirection(hand.matrixWorld);
  const d = 0.3 * m.scale.y;
  aimFree(at.clone().addScaledVector(toPalm, d).toArray(), at.toArray());
  HAND.bar?.remove();
  HAND.bar = h('div', { class: 'gz-bar hand-bar' }, gzChip('Left hand', () => handMode('l'), { on: side === 'l' }), gzChip('Right hand', () => handMode('r'), { on: side === 'r' }),
    h('span', { class: 'gz-chip hand-tip' }, 'Drag a fingertip to curl it'), gzChip('Done', () => handMode(null)));
  viewer.append(HAND.bar);
  syncMeshes(); renderPanel(); draw();
}
// the fingertip under a pointer (projected through the free view), within a finger's reach
function tipAt(e) {
  const m = R.meshes.get(R.sel), r = canvas.getBoundingClientRect(), reach = e.pointerType === 'touch' ? 30 : 18;
  let best = null;
  for (const d of m?.userData.tips || []) {
    if (d.userData.side !== HAND.side) continue;
    const v = d.getWorldPosition(new THREE.Vector3()).project(viewCam);
    const dist = Math.hypot(r.left + (v.x + 1) / 2 * r.width - e.clientX, r.top + (1 - v.y) / 2 * r.height - e.clientY);
    if (dist < reach && (!best || dist < best.dist)) best = { finger: d.userData.finger, dist };
  }
  return best?.finger || null;
}
const screenOf = (obj) => {
  const r = canvas.getBoundingClientRect(), v = obj.getWorldPosition(new THREE.Vector3()).project(viewCam);
  return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
};
function tipDown(e) {
  if (!HAND.on || HAND.drag || e.target !== canvas || dotsOff()) return;
  const finger = tipAt(e), o = selItem(), rig = R.meshes.get(R.sel)?.userData.rig;
  if (!finger || !o || !rig) return;
  e.stopPropagation(); e.preventDefault();
  canvas.setPointerCapture(e.pointerId); holdStart('tip');
  // the drag runs along the finger as it is on screen: from its tip to its knuckle is closing it
  const base = screenOf(rig.bones[`${HAND.side}${finger}1`]), tip = screenOf(rig.marks[`${HAND.side}${finger}tip`]);
  const len = Math.max(20, Math.hypot(base[0] - tip[0], base[1] - tip[1]));
  HAND.drag = { finger, id: e.pointerId, x: e.clientX, y: e.clientY, dir: [(base[0] - tip[0]) / len, (base[1] - tip[1]) / len], len,
    c0: FIGURE.curlOf(current(o, FIG).j || {}, HAND.side, finger), moved: false };
  draw();
}
function tipMove(e) {
  const g = HAND.drag;
  if (!g || e.pointerId !== g.id) return;
  e.stopPropagation(); e.preventDefault();
  const along = (e.clientX - g.x) * g.dir[0] + (e.clientY - g.y) * g.dir[1];
  const c = Math.max(0, Math.min(1, g.c0 + along / (g.len * 1.2)));
  const o = selItem();
  if (!o) return;
  write(o, FIG, { j: { ...current(o, FIG).j, ...FIGURE.fingerCurl(HAND.side, g.finger, c) } });
  g.moved = true;
  pose(R.f); draw();
}
function tipUp(e) {
  const g = HAND.drag;
  if (!g || e.pointerId !== g.id) return;
  e.stopPropagation();
  HAND.drag = null;
  if (g.moved) { save(); renderKeys(); if (!R.playing) renderPanel(); }
  letGo('tip'); draw();
}
export function setMode(m) { R.mode = m; refresh(); renderToolbar(); }

export function changed() { save(); refresh(); renderKeys(); renderPanel(); }

// delete a layer (an object's id, or ROOM), with Undo in the toast; the selection only goes if it was that layer
export function removeLayer(id) {
  const before = clone(SC), sel = R.sel, ok = sameTab();
  let name;
  if (id === ROOM) { if (!SC.room) return; name = 'Room'; SC.room = null; rebuildRoom(); }
  else { const o = id && SC.objects.find((x) => x.id === id); if (!o) return; name = o.name; SC.objects = SC.objects.filter((x) => x !== o); }
  if (sel === id) { if (HAND.on) handMode(null); R.sel = null; R.joint = null; }
  changed(); renderToolbar();
  undoToast(`${name} deleted`, () => { if (ok()) { setSC(before); R.sel = sel; rebuildRoom(); changed(); renderToolbar(); } });
}
export const removeSelected = () => removeLayer(R.sel);

export function addObject(type, extra = {}) {
  closeSheet();
  if (type === ROOM) { SC.room = newRoom(); rebuildRoom(); select(ROOM); save(); return; }
  const c = controls.target;
  const o = Object.assign(newObject(type, { x: +c.x.toFixed(2), z: +(type === 'wall' ? c.z - 2 : c.z).toFixed(2) }), extra);
  SC.objects.push(o); save(); select(o.id);
}

// ---- modes' views: a free view for looking at the room (and, with the shot camera drawn in it, for
// directing it), and the empty stage of Create object
const onStage = () => modeOf().stage !== 'empty';   // the scene is on show (Create object has an empty stage of its own)
const wantFrustum = () => R.free && !!modeOf().frustum;
export function setFree(on) {
  R.free = !!on;
  controls.enabled = !on; viewControls.enabled = !!on;
  gizmo.camera = on ? viewCam : camera;   // the handles are picked and sized from what is on show
  syncMeshes();   // (the camera gets its own gizmo in the director view)
  pose(R.f);   // the frustum is the camera you edit; the shot view follows the cuts
  draw(); renderToolbar();
}
// aim the free view at a point from where
export function aimFree(at, target) { viewCam.position.set(...at); viewControls.target.set(...target); viewControls.update(); draw(); }
// the shot camera set to what the free view sees (its lens stays)
// where a new camera starts: the view you're looking through in the director view; else a step back and up from
// the active camera (on top of it, it was easy to lose, and it inherited wherever that camera had been sent)
export function newCameraPose() {
  if (R.free) {
    const p = viewCam.position, t = viewControls.target;
    return { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z, fov: viewCam.fov, roll: 0 };
  }
  const c = current(SC.camera, CAM), back = new THREE.Vector3(c.px - c.tx, c.py - c.ty, c.pz - c.tz);
  const d = back.length() || 1;
  back.setLength(Math.max(0.5, d * 0.25));
  return { ...c, px: c.px + back.x, py: c.py + back.y + 0.3, pz: c.pz + back.z, roll: 0 };
}

export function cameraFromView() {
  const p = viewCam.position, t = viewControls.target;
  write(SC.camera, CAM, { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z, roll: 0 });
}
function syncFrustum() {
  if (!wantFrustum()) return;
  syncOthers();
  shotCam.position.copy(camera.position); shotCam.quaternion.copy(camera.quaternion);
  shotCam.fov = camera.fov; shotCam.aspect = camera.aspect; shotCam.updateProjectionMatrix();
  shotCam.updateMatrixWorld(true); frustum.update();
}


// ---- the other cameras (SC.cams) in the director view: a grey outline each, its name over it. A tap on an
// outline makes that camera active (then the view's camera gizmo moves it). Drawn only, never rendered or picked
// by the meshes' raycast.
const OTHERS = new Map();   // camera item -> { group, cam, helper, label, name }
function nameSprite(text) {
  const cv = document.createElement('canvas'), c = cv.getContext('2d'), px = 26;
  c.font = canvasFont(px); const w = Math.ceil(c.measureText(text).width) + 16;
  cv.width = w; cv.height = px + 12;
  c.font = canvasFont(px); c.fillStyle = '#000a'; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#e8e8e8'; c.textBaseline = 'middle'; c.fillText(text, 8, cv.height / 2 + 1);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.scale.set(0.035 * cv.width / cv.height, 0.035, 1); sp.center.set(0, 0); sp.renderOrder = 12;
  return sp;
}
function syncOthers() {
  const cams = SC.cams || [];
  for (const [c, x] of OTHERS) if (!cams.includes(c)) { scene.remove(x.group); x.helper.dispose(); x.label.material.map.dispose(); x.label.material.dispose(); OTHERS.delete(c); }
  for (const c of cams) {
    let x = OTHERS.get(c);
    if (!x) {
      const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.3, 3), helper = new THREE.CameraHelper(cam), group = new THREE.Group();
      const grey = new THREE.Color(0x8a8f99); helper.setColors(grey, grey, grey, grey, grey);
      group.add(cam, helper); scene.add(group);
      OTHERS.set(c, x = { group, cam, helper, label: null, name: null });
    }
    if (x.name !== c.name) { if (x.label) { x.group.remove(x.label); x.label.material.map.dispose(); x.label.material.dispose(); } x.label = nameSprite(c.name); x.name = c.name; x.group.add(x.label); }
    const v = current(c, CAM, R.f);
    x.cam.position.set(v.px, v.py, v.pz); x.cam.lookAt(v.tx, v.ty, v.tz); applyRoll(x.cam, v.roll);
    x.cam.fov = v.fov; x.cam.aspect = camera.aspect; x.cam.updateProjectionMatrix(); x.cam.updateMatrixWorld(true); x.helper.update();
    x.label.position.set(v.px, v.py + 0.12, v.pz);
  }
}
// the other camera whose outline (or name) is under the pointer, within a finger's reach; the nearest wins
function otherCamAt(e) {
  if (!wantFrustum() || !OTHERS.size) return null;
  const r = canvas.getBoundingClientRect(), reach = e.pointerType === 'touch' ? 28 : 18, px = e.clientX - r.left, py = e.clientY - r.top;
  const scr = (w) => { const p = w.clone().project(viewCam); return p.z > 1 ? null : [(p.x + 1) / 2 * r.width, (1 - p.y) / 2 * r.height]; };
  const seg = (a, b) => {
    if (!a || !b) return Infinity;
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a[0] + dx * t - px, a[1] + dy * t - py);
  };
  let best = null;
  for (const [c, x] of OTHERS) {
    const apex = scr(x.cam.position), far = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => scr(new THREE.Vector3(u, v, 1).unproject(x.cam)));
    let d = Math.min(...far.map((p) => seg(apex, p)), ...far.map((p, i) => seg(p, far[(i + 1) % 4])));
    const lb = scr(x.label.position);   // (the name's box, up and to the right of its corner)
    if (lb && px >= lb[0] - 4 && py <= lb[1] + 4 && py >= lb[1] - 30 && px <= lb[0] + 160) d = Math.min(d, 0);
    if (d < reach && (!best || d < best.d)) best = { c, d };
  }
  return best?.c || null;
}
