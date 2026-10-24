// 3D tab: block out a shot (soft mannequins, boxes, a room, a camera move) and render it as a depth
// video for H3's Fun ControlNet (deck-h3-ctrl2v). Near is white and far is black, like Depth
// Anything, and the range is fixed over the whole clip so the depth doesn't flicker.
// The view is the shot camera: what you see is what gets rendered. Anything with keyframes is
// animated, and moving it (or orbiting the camera) writes a key at the playhead.
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

let C;  // helpers handed over by app.js: h, $, api, toast, store, S, uploadImage, useControlVideo
const FPS = 24;
// the same length as the H3 templates' "Seconds to frames (24 fps, 17k+5 grid)" node
const framesFor = (sec) => { const n = Math.max(5, Math.round(sec * FPS)); return n + (((5 - n % 17) % 17) + 17) % 17; };
const OBJ = ['x', 'y', 'z', 'ry', 'sx', 'sy', 'sz'];
const CAM = ['px', 'py', 'pz', 'tx', 'ty', 'tz', 'fov'];
const SIZES = [[768, 448], [448, 768], [1024, 576], [576, 1024], [832, 480], [480, 832], [1280, 720], [720, 1280], [768, 768]];
const TYPES = {
  person: { label: 'Person', size: [0.45, 1.75, 0.28] },
  child: { label: 'Child', size: [0.32, 1.2, 0.2], geo: 'person' },
  box: { label: 'Box', size: [1.2, 0.75, 0.7] },
  ball: { label: 'Ball', size: [0.6, 0.6, 0.6] },
  cylinder: { label: 'Cylinder', size: [0.5, 1, 0.5] },
  wall: { label: 'Wall', size: [3, 2.6, 0.12], geo: 'box' },
};

// ---- scene data ------------------------------------------------------------
let SC;   // the scene (persisted per project)
const R = { f: 0, sel: null, playing: false, depth: false, meshes: new Map(), room: [], applying: false, lastRender: null };

function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, blur: 2,
    room: { w: 8, d: 8, h: 2.8, walls: true, ceiling: true },
    camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, keys: [], ease: 'smooth' },
    objects: [newObject('person', { x: 0, z: 0 })],
  };
}

function newObject(type, at = {}) {
  const t = TYPES[type];
  const n = SC ? SC.objects.filter((o) => o.type === type).length + 1 : 1;
  return { id: Math.random().toString(36).slice(2, 9), type, name: `${t.label} ${n}`, ease: 'smooth', keys: [],
    base: { x: 0, y: 0, z: 0, ry: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
}

const sceneKey = () => `deck.scene.${C.S.project ?? 'none'}`;
function load() {
  SC = C.store.get(sceneKey(), null);
  if (!SC || SC.v !== 1) SC = defaultScene();
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
const keyTarget = () => { const o = selItem(); return o ? [o, OBJ] : [SC.camera, CAM]; };

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
let renderer, scene, camera, controls, grid, canvas, viewer;
const clay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9 });
const claySel = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x5c5c5c, roughness: 1, side: THREE.DoubleSide });
const wallMat = new THREE.MeshStandardMaterial({ color: 0x7c7c7c, roughness: 1, side: THREE.DoubleSide });
const depthMat = new THREE.ShaderMaterial({
  uniforms: { near: { value: 0.5 }, far: { value: 20 } }, side: THREE.DoubleSide,
  vertexShader: 'varying float vz; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform float near; uniform float far; varying float vz;'
    + 'void main() { float d = (1.0 / max(vz, 1e-3) - 1.0 / far) / (1.0 / near - 1.0 / far);'
    + ' gl_FragColor = vec4(vec3(pow(clamp(d, 0.0, 1.0), 0.8)), 1.0); }',
});
// first export pass: linear depth packed into RGB (alpha 1 marks a hit), to find the clip's
// nearest and farthest points
const RANGE = 400;
const rangeMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: 'varying float vz; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: `varying float vz; void main() { float d = clamp(vz / ${RANGE}.0, 0.0, 0.9999);`
    + ' vec3 e = fract(d * vec3(1.0, 255.0, 65025.0)); e -= e.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);'
    + ' gl_FragColor = vec4(e, 1.0); }',
});

function setup() {
  viewer = C.$('#sceneViewer');
  canvas = C.$('#sceneCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
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
  controls.zoomToCursor = false;
  controls.addEventListener('change', () => { if (!R.applying) draw(); });
  controls.addEventListener('end', () => {
    if (R.playing) return;
    write(SC.camera, CAM, readCamera());
    save(); renderKeys(); renderPanel();
  });
  new ResizeObserver(() => fit()).observe(viewer);
  viewer.addEventListener('pointerdown', onDown, true);  // capture: decide before OrbitControls sees it
  viewer.addEventListener('dblclick', (e) => e.preventDefault());
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
  const { w, d, h, walls } = SC.room;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), floorMat);
  R.room.push(floor);
  if (walls) {
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h).translate(0, h / 2, -d / 2), wallMat);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(d, h).rotateY(Math.PI / 2).translate(-w / 2, h / 2, 0), wallMat);
    const right = new THREE.Mesh(new THREE.PlaneGeometry(d, h).rotateY(-Math.PI / 2).translate(w / 2, h / 2, 0), wallMat);
    R.room.push(back, left, right);
    if (SC.room.ceiling) R.room.push(new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2).translate(0, h, 0), wallMat));
  }
  for (const m of R.room) scene.add(m);
}

function syncMeshes() {
  const g = geometries();
  const ids = new Set(SC.objects.map((o) => o.id));
  for (const [id, m] of R.meshes) if (!ids.has(id)) { scene.remove(m); R.meshes.delete(id); }
  for (const o of SC.objects) {
    let m = R.meshes.get(o.id);
    const geo = g[TYPES[o.type].geo || o.type];
    if (!m) { m = new THREE.Mesh(geo, clay); m.userData.id = o.id; scene.add(m); R.meshes.set(o.id, m); }
    m.material = o.id === R.sel ? claySel : clay;
  }
}

// put every object and the camera where they are at frame f
function pose(f) {
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id);
    if (!m) continue;
    const v = sample(o, OBJ, f);
    m.position.set(v.x, v.y, v.z);
    m.rotation.set(0, THREE.MathUtils.degToRad(v.ry), 0);
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

function draw() {
  if (!renderer) return;
  scene.overrideMaterial = R.depth ? depthMat : null;
  scene.background.set(R.depth ? 0x000000 : 0x24272e);
  grid.visible = !R.depth;
  if (R.depth) setRange(cameraRange(R.f));
  renderer.render(scene, camera);
}

function refresh() { syncMeshes(); pose(R.f); draw(); }

// a rough near/far for the live depth view (the export measures the real one)
function cameraRange() {
  const box = new THREE.Box3();
  for (const m of [...R.meshes.values(), ...R.room]) box.expandByObject(m);
  const p = camera.position;
  const far = Math.max(...[0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => p.distanceTo(new THREE.Vector3(
    i ? box.max.x : box.min.x, j ? box.max.y : box.min.y, k ? box.max.z : box.min.z))))));
  return [Math.max(0.3, box.distanceToPoint(p) * 0.8 || 0.3), Math.max(far, 1)];
}
function setRange([near, far]) { depthMat.uniforms.near.value = near; depthMat.uniforms.far.value = far; }

// ---- pointer: drag objects on the floor, orbit everywhere else ----------------------------------
const ray = new THREE.Raycaster();
function ndc(e) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
function hitObject(e) {
  ray.setFromCamera(ndc(e), camera);
  return ray.intersectObjects([...R.meshes.values()], false)[0] || null;
}

let drag = null, pointers = 0;
function onDown(e) {
  pointers++;
  const up = () => { pointers = Math.max(0, pointers - 1); };
  window.addEventListener('pointerup', up, { once: true });
  window.addEventListener('pointercancel', up, { once: true });
  if (R.playing || pointers > 1) { if (drag) endDrag(); return; }
  const hit = hitObject(e), id = hit && hit.object.userData.id;
  const start = { x: e.clientX, y: e.clientY };
  if (!id) {  // orbit, or a tap on empty space: deselect
    const tap = (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6 && R.sel) { R.sel = null; refresh(); renderKeys(); renderPanel(); }
    };
    window.addEventListener('pointerup', tap, { once: true });
    return;
  }
  controls.enabled = false;
  const o = SC.objects.find((x) => x.id === id);
  const v = sample(o, OBJ, R.f);
  // a level plane through the point grabbed, so that point stays under the finger
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
  const p0 = hit.point.clone();
  if (R.sel !== id) { R.sel = id; refresh(); renderKeys(); renderPanel(); }
  drag = { o, plane, off: { x: v.x - p0.x, z: v.z - p0.z }, moved: false, start };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', endDrag, { once: true });
  canvas.addEventListener('pointercancel', endDrag, { once: true });
}
function onMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < 4) return;
  drag.moved = true;
  ray.setFromCamera(ndc(e), camera);
  const p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(drag.plane, p)) return;
  write(drag.o, OBJ, { x: +(p.x + drag.off.x).toFixed(3), z: +(p.z + drag.off.z).toFixed(3) });
  pose(R.f); draw();
}
function endDrag() {
  canvas.removeEventListener('pointermove', onMove);
  controls.enabled = true;
  if (drag && drag.moved) { save(); renderKeys(); renderPanel(); }
  drag = null;
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
function stopPlay() { R.playing = false; cancelAnimationFrame(raf); renderTransport(); renderPanel(); }
function seek(f) { R.f = Math.max(0, Math.min(frames() - 1, Math.round(f))); pose(R.f); draw(); renderTime(); renderKeys(); renderPanel(); }

// ---- export ----------------------------------------------------------------------
const decodeDepth = (r, g, b) => r / 255 + g / 65025 + b / 16581375;  // rangeMat's packing, undone

function measureRange() {
  const W = 128, H = Math.max(8, Math.round(128 * SC.height / SC.width));
  const rt = new THREE.WebGLRenderTarget(W, H);
  const buf = new Uint8Array(W * H * 4);
  const bg = scene.background; scene.background = null;
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = rangeMat; grid.visible = false;
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
  busy = true; stopPlay();
  const keep = R.f, W = SC.width, H = SC.height;
  try {
    setRange(measureRange());
    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.NoColorSpace });
    scene.overrideMaterial = depthMat; scene.background.set(0x000000); grid.visible = false;
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
    busy = false; R.f = keep; fit(); pose(R.f); draw(); renderPanel();
  }
}

// a lit clay frame at the output size, as an input image (a start frame to restyle, for example)
async function saveFrame() {
  const W = SC.width, H = SC.height;
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
  const wasDepth = R.depth; R.depth = false;
  scene.overrideMaterial = null; grid.visible = false;
  for (const m of R.meshes.values()) m.material = clay;
  camera.aspect = W / H; camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const blob = await targetToBlob(rt, W, H, false);
  rt.dispose();
  R.depth = wasDepth; refresh();
  try {
    const r = await C.uploadImage(blob, { source: 'scene', filename: 'scene.png' });
    C.toast(`Saved frame as ${r.name.split('/').pop()}`);
  } catch (e) { C.toast(e.message, true); }
}

// ---- UI ----------------------------------------------------------------------
let statusText = '';
function setStatus(t) { statusText = t; const s = C.$('#sceneStatus'); if (s) s.textContent = t; }

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
  box.replaceChildren(...item.keys.map((k) => C.h('button', {
    type: 'button', class: 'key' + (k.f === R.f ? ' on' : ''), style: `left:${(k.f / n) * 100}%`,
    title: `Key at ${(k.f / FPS).toFixed(2)} s`, onclick: () => seek(k.f) })));
  const del = C.$('#sceneDelKey');
  if (del) del.disabled = !item.keys.some((k) => k.f === R.f);
  const lbl = C.$('#sceneKeyFor');
  if (lbl) lbl.textContent = selItem() ? selItem().name : 'Camera';
}

function renderTransport() {
  const { h } = C;
  const scrub = h('input', { id: 'sceneScrub', type: 'range', min: 0, max: frames() - 1, step: 1, value: R.f });
  scrub.addEventListener('input', () => seek(+scrub.value));
  C.$('#sceneTransport').replaceChildren(
    h('button', { type: 'button', class: 'btn small primary', onclick: play }, R.playing ? '❚❚ Pause' : '▶ Play'),
    h('div', { class: 'scene-scrub' }, h('div', { id: 'sceneKeys', class: 'scene-keys' }), scrub),
    h('span', { id: 'sceneTime', class: 'timecode' }),
    h('div', { class: 'row scene-keybar' },
      h('span', { class: 'hint' }, 'Key: ', h('b', { id: 'sceneKeyFor' })),
      h('button', { type: 'button', class: 'btn small', title: 'Keyframe at the playhead', onclick: () => {
        const [item, names] = keyTarget(); addKey(item, names); save(); renderKeys(); renderPanel();
      } }, '◆ Key'),
      h('button', { id: 'sceneDelKey', type: 'button', class: 'btn small', onclick: () => {
        const [item] = keyTarget();
        item.keys = item.keys.filter((k) => k.f !== R.f);
        save(); pose(R.f); draw(); renderKeys(); renderPanel();
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
function num(label, get, set, { step = 0.1, min, max } = {}) {
  const { h } = C;
  const inp = h('input', { type: 'number', inputMode: 'decimal', step, min, max, value: +Number(get()).toFixed(3) });
  inp.addEventListener('change', () => { set(parseFloat(inp.value) || 0); save(); refresh(); renderPanel(); });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), inp);
}
const seg = (opts, cur, on) => C.h('div', { class: 'seg' }, ...opts.map(([v, label]) =>
  C.h('button', { type: 'button', class: cur === v ? 'on' : '', onclick: () => on(v) }, label)));
const section = (title, ...kids) => C.h('div', { class: 'vid-section' }, C.h('div', { class: 'lbl' }, C.h('b', {}, title)), ...kids);

function objectProps(o) {
  const { h } = C;
  const cur = () => sample(o, OBJ, R.f);
  const set = (k) => (v) => write(o, OBJ, { [k]: v });
  const name = h('input', { type: 'text', value: o.name });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; save(); renderPanel(); renderKeys(); });
  return section(`${o.name}${o.keys.length ? ` · ${o.keys.length} key${o.keys.length > 1 ? 's' : ''}` : ''}`,
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), name),
    h('div', { class: 'row' }, num('X (m)', () => cur().x, set('x')), num('Z (m)', () => cur().z, set('z'))),
    slider('Off the floor', () => cur().y, set('y'), { min: 0, max: 3, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    slider('Turn', () => cur().ry, set('ry'), { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` }),
    slider('Width', () => cur().sx, set('sx'), { min: 0.05, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    slider('Height', () => cur().sy, set('sy'), { min: 0.05, max: 4, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    slider('Depth', () => cur().sz, set('sz'), { min: 0.05, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    h('div', { class: 'lbl' }, 'Between keys'),
    seg([['smooth', 'Ease'], ['linear', 'Linear']], o.ease, (v) => { o.ease = v; save(); refresh(); renderPanel(); }),
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        const c = { ...JSON.parse(JSON.stringify(o)), id: Math.random().toString(36).slice(2, 9), name: `${o.name} copy` };
        c.base.x += 0.6; c.keys.forEach((k) => { if (k.x != null) k.x += 0.6; });
        SC.objects.push(c); R.sel = c.id; save(); refresh(); renderPanel(); renderKeys();
      } }, 'Duplicate'),
      o.keys.length ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        Object.assign(o.base, cur()); o.keys = []; save(); refresh(); renderPanel(); renderKeys();
      } }, 'Clear keys') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        SC.objects = SC.objects.filter((x) => x.id !== o.id); R.sel = null; save(); refresh(); renderPanel(); renderKeys();
      } }, 'Delete')));
}

function cameraProps() {
  const { h } = C;
  const cam = SC.camera;
  const mm = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);  // full-frame equivalent, from the vertical angle
  return section(`Camera${cam.keys.length ? ` · ${cam.keys.length} key${cam.keys.length > 1 ? 's' : ''}` : ''}`,
    h('div', { class: 'hint' }, 'Drag to orbit, two fingers to pan and zoom. With keys, each move you make sets a key at the playhead.'),
    slider('Lens', () => sample(cam, CAM, R.f).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm` }),
    slider('Camera height', () => sample(cam, CAM, R.f).py, (v) => write(cam, CAM, { py: v }),
      { min: 0.1, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    h('div', { class: 'lbl' }, 'Between keys'),
    seg([['smooth', 'Ease'], ['linear', 'Linear']], cam.ease, (v) => { cam.ease = v; save(); refresh(); renderPanel(); }),
    h('div', { class: 'row wrap' },
      cam.keys.length ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        Object.assign(cam.base, sample(cam, CAM, R.f)); cam.keys = []; save(); refresh(); renderPanel(); renderKeys();
      } }, 'Clear keys') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        write(cam, CAM, { ...defaultScene().camera.base }); save(); refresh(); renderPanel(); renderKeys();
      } }, 'Reset view')));
}

function renderPanel() {
  const { h } = C;
  const panel = C.$('#scenePanel');
  if (!panel || !SC) return;
  const sizeSel = h('select', {}, ...SIZES.map(([w, hh]) => h('option', { value: `${w}x${hh}` }, `${w}×${hh}`)));
  sizeSel.value = `${SC.width}x${SC.height}`;
  if (sizeSel.value !== `${SC.width}x${SC.height}`) sizeSel.append(h('option', { value: `${SC.width}x${SC.height}`, selected: true }, `${SC.width}×${SC.height}`));
  sizeSel.addEventListener('change', () => { [SC.width, SC.height] = sizeSel.value.split('x').map(Number); save(); fit(); });
  const secs = h('input', { type: 'number', min: 2, max: 15, step: 1, value: SC.seconds });
  secs.addEventListener('change', () => {
    SC.seconds = Math.max(2, Math.min(15, Math.round(+secs.value || 6)));
    const n = frames();
    for (const it of [SC.camera, ...SC.objects]) it.keys = it.keys.filter((k) => k.f < n);
    R.f = Math.min(R.f, n - 1); save(); renderTransport(); renderPanel(); refresh();
  });

  const add = h('div', { class: 'chips' }, ...Object.entries(TYPES).map(([t, d]) => h('button', { type: 'button', class: 'chip', onclick: () => {
    const c = controls.target;
    const o = newObject(t, { x: +c.x.toFixed(2), z: +c.z.toFixed(2) });
    if (t === 'wall') o.base.z = +(c.z - 2).toFixed(2);
    SC.objects.push(o); R.sel = o.id; save(); refresh(); renderPanel(); renderKeys();
  } }, `+ ${d.label}`)));
  const list = h('div', { class: 'chips' },
    h('button', { type: 'button', class: 'chip' + (R.sel ? '' : ' on'), onclick: () => { R.sel = null; refresh(); renderPanel(); renderKeys(); } }, '🎥 Camera'),
    ...SC.objects.map((o) => h('button', { type: 'button', class: 'chip' + (o.id === R.sel ? ' on' : ''),
      onclick: () => { R.sel = o.id; refresh(); renderPanel(); renderKeys(); } }, o.name + (o.keys.length ? ' ◆' : ''))));
  const o = selItem();

  panel.replaceChildren(
    section('Shot',
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Size'), sizeSel),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, `Length (s) · ${frames()} frames`), secs)),
      seg([[false, 'Clay'], [true, 'Depth']], R.depth, (v) => { R.depth = v; draw(); renderPanel(); })),
    section('Add', add),
    section('Objects', list, h('div', { class: 'hint' }, 'Tap to select, drag to move it along the floor.')),
    o ? objectProps(o) : cameraProps(),
    section('Room',
      h('div', { class: 'row' },
        num('Width', () => SC.room.w, (v) => { SC.room.w = Math.max(1, v); rebuildRoom(); }, { step: 0.5, min: 1 }),
        num('Depth', () => SC.room.d, (v) => { SC.room.d = Math.max(1, v); rebuildRoom(); }, { step: 0.5, min: 1 }),
        num('Height', () => SC.room.h, (v) => { SC.room.h = Math.max(1, v); rebuildRoom(); }, { step: 0.1, min: 1 })),
      seg([['room', 'Walls + ceiling'], ['walls', 'Walls'], ['floor', 'Floor only']],
        SC.room.walls ? (SC.room.ceiling ? 'room' : 'walls') : 'floor', (v) => {
          SC.room.walls = v !== 'floor'; SC.room.ceiling = v === 'room'; rebuildRoom(); save(); draw(); renderPanel();
        }),
      h('div', { class: 'hint' }, 'Keep the walls about where the real ones should be: H3 sizes the room from them.')),
    section('Render',
      slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
      h('div', { class: 'hint' }, 'Blurs the depth video so H3 copies the shapes less literally. Use it with deck-h3-ctrl2v (strength 1, end 0.4).'),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: renderDepthVideo }, 'Render depth video'),
        h('button', { type: 'button', class: 'btn small', onclick: saveFrame }, '📷 Save frame')),
      R.lastRender ? h('button', { type: 'button', class: 'btn small', onclick: () => C.useControlVideo(R.lastRender, SC) },
        `Use #${R.lastRender.id} in H3 control`) : null,
      h('div', { id: 'sceneStatus', class: 'hint' }, statusText),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn small', onclick: () => {
          if (!confirm('Start a new scene? This one is cleared.')) return;
          SC = defaultScene(); R.sel = null; R.f = 0; save(); rebuildRoom(); refresh(); renderTransport(); renderPanel(); fit();
        } }, 'New scene'))));
}

// ---- entry points (called from app.js) ------------------------------------------------
let ready = false;
export function init(helpers) { C = helpers; }

export function show() {
  if (!ready) { load(); setup(); ready = true; rebuildRoom(); }
  refresh(); renderTransport(); renderPanel(); fit();
}

export function hide() { if (ready) stopPlay(); }

// a new project has its own scene
export function projectChanged() {
  if (!ready) return;
  stopPlay(); load(); R.lastRender = null; rebuildRoom(); refresh(); renderTransport(); renderPanel(); fit();
}

// open the scene saved with a "3d scene" generation
export function open(scene) {
  if (!scene || scene.v !== 1) return C.toast('That scene is from another version', true);
  SC = JSON.parse(JSON.stringify(scene));
  R.sel = null; R.f = 0; save(true);
  if (ready) { rebuildRoom(); refresh(); renderTransport(); renderPanel(); fit(); }
}
