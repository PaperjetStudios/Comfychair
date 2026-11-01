// A 3D model or splat on its own: a viewer to turn it round (Details, the Board's gallery), and the screenshot a model's card shows.
// Loaded when first needed, because three.js is big. The screenshot is drawn here, in the browser, and kept by the server (app/previews.py).
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { disposeTree, smoothFaceted } from './reskin.js';
import { h } from './ui.js';
import { maximizable } from './layout.js';

const BACK = 0x1b1b1f, FOV = 28, SHOT = 640;
const extOf = (url) => (String(url).split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';

async function loadFile(url) {
  const e = extOf(url);
  let obj;
  if (e === 'glb' || e === 'gltf') obj = (await new GLTFLoader().loadAsync(url)).scene;
  else if (e === 'fbx') obj = await new (await import('./vendor/FBXLoader.js')).FBXLoader().loadAsync(url);
  else if (e === 'obj') {
    obj = await new (await import('./vendor/OBJLoader.js')).OBJLoader().loadAsync(url);
    const clay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.85 });
    obj.traverse((c) => { if (c.isMesh) c.material = clay; });
  } else throw new Error(`Can't show .${e} models`);
  smoothFaceted(obj);
  obj.traverse((c) => { if (c.isMesh) c.frustumCulled = false; });
  return obj;
}

// soft light from all round: a generated model's metal map goes black without something to reflect
function lightUp(scene, renderer) {
  const sky = new THREE.Scene();
  sky.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), new THREE.ShaderMaterial({ side: THREE.BackSide,
    vertexShader: 'varying float y; void main() { y = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float y; void main() { gl_FragColor = vec4(vec3(mix(0.35, 1.3, y * 0.5 + 0.5)), 1.0); }' })));
  const pm = new THREE.PMREMGenerator(renderer), env = pm.fromScene(sky, 0.04);
  pm.dispose();
  scene.environment = env.texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555560, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(2, 4, 3);
  scene.add(key);
  return () => { env.dispose(); sky.children[0].geometry.dispose(); sky.children[0].material.dispose(); };
}

function newRenderer(canvas, opts = {}) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, ...opts });
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.setClearColor(BACK);
  return r;
}

// the camera a little to the front left and above, all of the sphere in frame; what to turn about comes back
function aimAt(camera, center, radius) {
  const r = Math.max(radius, 1e-3), half = THREE.MathUtils.degToRad(camera.fov / 2);
  const dist = (r / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect)))) * 1.02;
  camera.position.copy(center).add(new THREE.Vector3(0.45, 0.2, 1).normalize().multiplyScalar(dist));
  camera.near = dist / 100; camera.far = dist * 10;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}
export function aim(camera, obj) {
  obj.updateMatrixWorld(true);
  const s = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
  return aimAt(camera, s.center, s.radius);
}

// The viewer's frame: drag to turn, wheel or pinch to zoom, right drag to pan. It frees everything once it has left the page or its
// sheet has closed. start({ scene, renderer, camera, el, reaim }) loads what it shows: { aim(camera), free(), live } (live: draw
// every frame, as a splat wants while it sorts).
function viewer(o, { maxBtn = true, kind = 'model', start }) {
  const canvas = h('canvas', { 'aria-label': `${o.filename || kind}: drag to turn it` });
  const note = h('span', { class: 'hint model-note' }, `Loading the ${kind}…`);
  const el = h('div', { class: 'model-view' }, canvas, note);
  if (maxBtn) maximizable(el, el, { title: `Full screen the ${kind}` });
  let renderer;
  try { renderer = newRenderer(canvas); } catch { note.textContent = 'This browser can\'t show 3D here'; return el; }
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  let shown = null, dirty = true, framed = false, raf = 0, wasOn = false, gone = false;
  controls.addEventListener('change', () => { dirty = true; });
  const reaim = () => { if (shown) { controls.target.copy(shown.aim(camera)); framed = true; dirty = true; } };
  const size = () => {
    const w = el.clientWidth, hh = el.clientHeight;
    if (!w || !hh) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh; camera.updateProjectionMatrix();
    if (!framed) reaim();
    dirty = true;
  };
  const seen = new ResizeObserver(size);
  seen.observe(el);
  const free = () => {
    gone = true;
    cancelAnimationFrame(raf); seen.disconnect(); controls.dispose();
    shown?.free(); renderer.dispose(); renderer.forceContextLoss?.();
  };
  const tick = () => {
    // (a closed sheet is only hidden until the next one opens: hidden counts as gone, so it doesn't sit in memory)
    if (el.getClientRects().length) wasOn = true;
    else if (wasOn) return free();
    controls.update();
    if (shown && (dirty || shown.live)) { dirty = false; renderer.render(scene, camera); }
    raf = requestAnimationFrame(tick);
  };
  tick();
  start({ scene, renderer, camera, el, reaim }).then((run) => {
    if (gone) return run.free();
    shown = run; note.remove();
    size();
  }).catch((e) => { note.textContent = `Couldn't load the ${kind}: ${e.message}`; });
  return el;
}

export function modelViewer(o, { maxBtn = true } = {}) {
  return viewer(o, { maxBtn, start: async ({ scene, renderer }) => {
    const unlight = lightUp(scene, renderer), obj = await loadFile(o.url).catch((e) => { unlight(); throw e; });
    scene.add(obj);
    return { aim: (camera) => aim(camera, obj), free: () => { disposeTree(obj); unlight(); } };
  } });
}

// A splat (Spark, as in the 3D tab). Most files are y-down, so it starts turned over except an spz, with a button for the rest.
export function splatViewer(o, { maxBtn = true } = {}) {
  return viewer(o, { maxBtn, kind: 'splat', start: async ({ scene, renderer, el, reaim }) => {
    renderer.toneMapping = THREE.NoToneMapping;   // (a splat's colours are the picture's own)
    const lib = await import('./vendor/spark.module.js');
    const spark = new lib.SparkRenderer({ renderer });
    scene.add(spark);
    const mesh = new lib.SplatMesh({ url: o.url, fileName: o.filename || undefined });
    let flip = extOf(o.filename || o.url) !== 'spz', box;
    try {
      await mesh.initialized;
      box = middleBox(mesh);
    } catch (e) { mesh.dispose?.(); spark.dispose?.(); throw e; }
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.rotation.x = flip ? Math.PI : 0;
    scene.add(holder);
    el.append(h('button', { type: 'button', class: 'small model-flip', title: 'For a splat that shows upside down', onclick: () => {
      flip = !flip; holder.rotation.x = flip ? Math.PI : 0; reaim();
    } }, 'Turn over'));
    const [x0, y0, z0, x1, y1, z1] = box, f = () => (flip ? -1 : 1);
    return { live: true,
      aim: (camera) => aimAt(camera, new THREE.Vector3((x0 + x1) / 2, f() * (y0 + y1) / 2, f() * (z0 + z1) / 2),
        Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2),
      free: () => { holder.remove(mesh); mesh.dispose(); scene.remove(spark); spark.dispose?.(); } };
  } });
}
// the middle 99% of a splat's centres per axis, so a few stray floaters don't count
function middleBox(mesh) {
  const n = mesh.packedSplats.numSplats, a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  mesh.forEachSplat((i, c) => { a[0][i] = c.x; a[1][i] = c.y; a[2][i] = c.z; });
  const lo = [], hi = [];
  for (const v of a) { v.sort(); lo.push(v[Math.floor(n * 0.005)]); hi.push(v[Math.min(n - 1, Math.ceil(n * 0.995))]); }
  return [...lo, ...hi];
}

// ---- screenshots: one at a time, on one hidden renderer -----------------------------------------------------
let shooter = null, line = Promise.resolve();
const asked = new Map();
function shoot(url) {
  return (line = line.catch(() => {}).then(async () => {
    if (!shooter) {
      const renderer = newRenderer(document.createElement('canvas'), { preserveDrawingBuffer: true });
      renderer.setSize(SHOT, SHOT, false);
      const scene = new THREE.Scene();
      lightUp(scene, renderer);
      shooter = { renderer, scene, camera: new THREE.PerspectiveCamera(FOV, 1, 0.01, 100) };
    }
    const { renderer, scene, camera } = shooter, obj = await loadFile(url);
    try {
      scene.add(obj);
      aim(camera, obj);
      renderer.render(scene, camera);
      const blob = await new Promise((res) => renderer.domElement.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) throw new Error('No screenshot');
      const r = await fetch(`/api/preview/shot?u=${encodeURIComponent(url)}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!r.ok) throw new Error(`Saving it failed: ${r.status}`);
      return true;
    } finally { scene.remove(obj); disposeTree(obj); }
  }));
}
// true once the model's screenshot is saved; false if it can't be drawn (asked once a session per model)
export function ensureShot(url) {
  if (!asked.has(url)) asked.set(url, shoot(url).catch((e) => { console.warn('Model screenshot:', url, e.message); return false; }));
  return asked.get(url);
}
