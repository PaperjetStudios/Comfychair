// Scene sources for the 3D tab: imported models (glb/gltf, obj with its mtl, fbx), Gaussian splats
// (ply, splat, ksplat, spz) and starter scenes. Plugs into the Edit scene panel and the layer loaders
// (scene-view.js LOADERS / passHooks); needs nothing in the core but those hooks and the layer types.
//   model layer: { type: 'model', name, url, file, ext, mtl?, fit, clay? }
//   splat layer: { type: 'splat', name, url, file, ext, fit, flip, box: [x0,y0,z0,x1,y1,z1] (the splat's own units),
//     frames?, frameRate?, frameLoop? (an animated splat: splat-frames.js) }
// Both scale evenly (base.sx = sy = sz = fit, then whatever the user did). The file is in the project
// folder (POST /api/scene/asset); the layer only holds its URL.
import * as THREE from './vendor/three.module.min.js';
import { maxMpRow, resizeInput } from './media.js';
import { blenderButton, blenderSplatButton } from './blender.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { store, actions, api, button, clone, closeSheet, fileButton, h, hint, nameSheet, openSheet, section, toast, uid, undoToast , help, toggle, chip, field, seg, info, rangeField, mediaCard, placeholder, iconBtn } from './ui.js';
import { S as APP, inputUrl, thumbUrl } from './core.js';
import { icon } from './icons.js';
import { floatPanel } from './float-panel.js';
import { pictureSlot } from './picture-drop.js';
import { liveFrame } from './live.js';
import { OBJECT_MODELS, VIEWS as VIEW_ROLES, addPictures, planRun, usedViews } from './object-rules.js';
import { C, OBJ as OBJ_CH, R, SC, current, frames, matchSceneTo, newObject, namesFor, sampleChan, save, selItem, setKey, write } from './scene-data.js';
import { heightOf as figureHeight } from './figure.js';
import { addModeSection } from './scene-modes.js';
import { setupsRow } from './setups.js';
import { sceneKey } from './setups-rules.js';
import { SCN, LOADERS, SPLAT_PASS, activeCamera, boxEditing, boxHost, levelBox, refresh, setBoxEdit, setFloor, controls, changed, draw, fit, lookThrough, passHooks, pose, recentre, renderer, scene, select } from './scene-view.js';
import { LIBRARY } from './scene-library.js';
import { askHeight } from './scene-scale.js';
import { baseOf, fitForHeight, fmtLen, importFit, unitToMetres } from './scale-math.js';
import {
  LEVELS, countLabel, fileOf, levelFor, levelName, makeChoices, placeAtCamera, previewLevel, previewUrl, renderUrl, setMakeChoices, setPlaceAtCamera,
  setPreviewLevel, setSharp, sharpOn
} from './splat-levels.js';
import {
  GROWS, boxAround, boxBottomTo, boxOn, fillFactor, keptShare, medianOf, pickAlong, reachOf, samplePoints, sameTrim, shapeMesh, standShift, trimBody, trimOn, trimSphere
} from './splat-shape.js';
import { LOOPS, RATES, DEFAULT_RATE, addFrame, frameCount, frameIndex, frameList, frameTrimOf, framesOnWhole, hasFrameKeys, removeFrame, sceneFrameShowing, shapeFor, swapFrames } from './splat-frames.js';

const MODELS = new Set(['glb', 'gltf', 'obj', 'fbx']);
const SPLATS = new Set(['ply', 'splat', 'ksplat', 'spz']);
const EXTRAS = new Set(['mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga']);  // what a model refers to
const ACCEPT = [...MODELS, ...SPLATS, ...EXTRAS].map((e) => `.${e}`).join(',');
const extOf = (name) => (String(name).split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
export const clayMat = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9, side: THREE.DoubleSide });

// ---- loading ----------------------------------------------------------------------------
// A layer's file as three.js objects, in the file's own units. (Libraries load when first needed.)
async function loadModel(o) {
  const e = o.ext || extOf(o.url);
  if (e === 'glb' || e === 'gltf') return (await new GLTFLoader().loadAsync(o.url)).scene;
  if (e === 'fbx') return new (await import('./vendor/FBXLoader.js')).FBXLoader().loadAsync(o.url);
  if (e === 'obj') {
    const loader = new (await import('./vendor/OBJLoader.js')).OBJLoader();
    if (o.mtl) {
      const mats = await new (await import('./vendor/MTLLoader.js')).MTLLoader().loadAsync(o.mtl);
      mats.preload(); loader.setMaterials(mats);
    }
    const g = await loader.loadAsync(o.url);
    if (!o.mtl) g.traverse((c) => { if (c.isMesh) c.material = clayMat; });  // (no mtl: plain default white is blinding)
    return g;
  }
  throw new Error(`Can't show .${e} models`);
}

// the model standing on the floor at the layer's origin, centred, in a wrapper (its size comes back)
function stand(obj) {
  const box = new THREE.Box3().setFromObject(obj), wrap = new THREE.Group();
  wrap.add(obj);
  obj.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  obj.traverse((c) => { if (c.isMesh) { c.userData.orig = c.material; if (c.isSkinnedMesh) c.frustumCulled = false; } });
  return { wrap, size: box.getSize(new THREE.Vector3()) };
}
export function applyClay(group, on) {
  group.traverse((c) => { if (c.isMesh && c.userData.orig) c.material = on ? clayMat : c.userData.orig; });
}

const loaded = new Map();  // layer id: what the import already loaded (so it isn't read twice)
const mine = (o, group) => R.meshes.get(o.id) === group;
function tagPicks(o, group) { group.traverse((c) => { if (c.isMesh) c.userData.id = o.id; }); }

// (x: an optional context { mine(o, group), draw(), lib() } for a scene built elsewhere: the video tab's compositions)
LOADERS.model = (o, group, x = {}) => {
  const alive = x.mine || mine, redraw = x.draw || draw;
  const ready = x.mine ? null : loaded.get(o.id);
  if (!x.mine) loaded.delete(o.id);
  (ready ? Promise.resolve(ready) : loadModel(o).then((obj) => stand(obj).wrap)).then((wrap) => {
    if (!alive(o, group)) return;
    group.add(wrap); tagPicks(o, group); applyClay(group, !!o.clay);
    group.userData.model = true; redraw();
  }).catch((e) => toast(`${o.name}: ${e.message}`, true));
};

// ---- splats: Spark (vendor/spark.module.js) draws them through one SparkRenderer in the scene ----
let sparkLib = null, spark = null;
export const sparkNow = () => spark;   // (the depth pass draws it on its own: splat-depth.js renderDepth)
async function sparkOf() {
  sparkLib ||= import('./vendor/spark.module.js');
  const lib = await sparkLib;
  if (!spark) { spark = SPLAT_PASS.spark = new lib.SparkRenderer({ renderer }); scene.add(spark); }
  return lib;
}
// Which file: the view loads the preview level picked on this device (splat-levels.js), a render (x.full) the
// full set or the densest level kept. A layer without levels (older, or .spz/.splat) has only its url.
const coarse = () => matchMedia('(pointer: coarse)').matches;
const splatUrl = (o, x = {}) => (x.full ? renderUrl(o) : previewUrl(o, previewLevel(coarse())));
async function loadSplat(o, x = {}, url = splatUrl(o, x)) {
  const lib = x.lib ? await x.lib() : await sparkOf();
  const mesh = new lib.SplatMesh({ url, fileName: (url === o.url ? o.file : fileOf(url)) || undefined });
  await mesh.initialized;
  mesh.raycast = () => {};  // picking uses the box (the splats are far too many to ray-test)
  mesh.userData.url = url;
  shapeMesh(lib, mesh, o, !!x.full);   // (size and trim, splat-shape.js; a render's follow the layer's "renders too")
  return mesh;
}
// where the splat is: the middle 99% of its centres per axis, so a few stray floaters don't count
function splatBox(mesh) {
  const n = mesh.packedSplats.numSplats, a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  mesh.forEachSplat((i, c) => { a[0][i] = c.x; a[1][i] = c.y; a[2][i] = c.z; });
  const lo = [], hi = [];
  for (const v of a) { v.sort(); lo.push(v[Math.floor(n * 0.005)]); hi.push(v[Math.min(n - 1, Math.ceil(n * 0.995))]); }
  return [...lo, ...hi];
}
// splat files from capture tools are usually y-down: flipped by default, except spz (made y-up)
const flipFor = (ext) => ext !== 'spz';

LOADERS.splat = (o, group, x = {}) => {
  const alive = x.mine || mine, redraw = x.draw || draw;
  let index = 0;   // (the frame showing; pose can ask before anything has loaded)
  group.userData.atFrame = (f, v) => { index = frameIndex(o, f, v?.sf); group.userData.splat?.show(index); };
  const ready = x.mine ? null : loaded.get(o.id);
  if (!x.mine) loaded.delete(o.id);
  (ready ? Promise.resolve(ready) : loadSplat(o, x)).then((mesh) => {
    if (!alive(o, group)) return;
    const holder = new THREE.Group();   // turned over if the file is y-down
    holder.add(mesh);
    // a box of the same size stands in for the clay look and for picking
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), clayMat);
    proxy.visible = false; proxy.userData.pickProxy = true;   // (the view-centre pivot aims at it: scene-view.js pivotToView)
    const box = o.box || splatBox(mesh);
    const fit = () => {  // the holder and box for the current flip: standing on the floor, centred
      const f = o.flip ? -1 : 1, [x0, y0, z0, x1, y1, z1] = box;
      const lo = [x0, f > 0 ? y0 : -y1, f > 0 ? z0 : -z1], hi = [x1, f > 0 ? y1 : -y0, f > 0 ? z1 : -z0];
      holder.rotation.x = o.flip ? Math.PI : 0;
      // a photo's splat (o.cam) placed the old way keeps the photo's camera at the object's origin, looking down -Z
      // (placing the object places that camera); one with o.view stands centred on the floor like any splat, and
      // o.view.pos says where the photo's camera is (the holder's shift: the file's origin)
      if (o.cam && !o.view) holder.position.set(0, 0, 0);
      else holder.position.set(...standShift(box, o.flip));
      proxy.scale.set(Math.max(0.01, hi[0] - lo[0]), Math.max(0.01, hi[1] - lo[1]), Math.max(0.01, hi[2] - lo[2]));
      proxy.position.set(0, proxy.scale.y / 2, 0);
    };
    fit();
    group.add(holder, proxy);
    // meshes: one per frame, in order (null until it has loaded); only the frame showing is visible, and it is sp.mesh
    const sp = group.userData.splat = { fit, proxy, holder, mesh, meshes: [mesh], all: new Set([mesh]), show(i) {
      const list = sp.meshes;
      let at = Math.min(i, list.length - 1);
      while (at > 0 && !list[at]) at--;   // (a frame still on its way: the one before it holds)
      const m = list[at] || list.find(Boolean);
      if (!m) return;
      for (const c of sp.all) c.visible = c === m;
      sp.mesh = m;
    }, index: () => index };
    if (!x.mine) { sp.sphere = trimSphere(); holder.add(sp.sphere); }   // (the trim's sphere, while it is adjusted)
    group.userData.dispose = () => {   // (the layer is gone: free its buffers)
      sp.job = null;
      for (const m of sp.all) { holder.remove(m); m.dispose(); }
      sp.all.clear(); sp.meshes = []; sp.mesh = null;
    };
    tagPicks(o, group);
    applyShapes(o, sp);
    sp.show(index);
    if (!x.mine) redraw();
    return frameCount(o) > 1 ? syncFrames(o, group, x, alive) : null;
  }).then(() => { if (alive(o, group)) redraw(); })
    .catch((e) => { toast(`${o.name}: ${e.message}`, true); if (x.mine) redraw(); });
};

// A layer's meshes follow its frames and this device's preview level: what is missing loads, one at a time, and what
// is no longer wanted goes once the rest are in (a frame getting a new level keeps showing the old one until then).
// A render (x.full) loads each frame's full set. A later call takes over from an earlier one.
const applyShapes = (o, sp) => sp.meshes.forEach((m, i) => m?.userData.shape?.set(shapeFor(o, i)));   // (each frame's own trim, else the layer's)
async function syncFrames(o, group, x = {}, alive = mine) {
  const sp = group.userData.splat, want = frameList(o).map((fr) => splatUrl(fr, x)), job = sp.job = { urls: want.join() };
  const have = new Map([...sp.all].map((m) => [m.userData.url, m]));
  sp.meshes = want.map((url, i) => have.get(url) || sp.meshes[i] || null);
  for (let i = 0; i < want.length; i++) {
    if (have.has(want[i])) continue;
    let m;
    try { m = await loadSplat(o, x, want[i]); } catch (e) { toast(`${o.name}, frame ${i + 1}: ${e.message}`, true); continue; }
    if (sp.job !== job || !alive(o, group)) { m.dispose(); return; }
    m.visible = false;
    sp.holder.add(m); sp.all.add(m); have.set(want[i], m);
    want.forEach((url, j) => { if (url === want[i]) sp.meshes[j] = m; });   // (the same file twice: one mesh)
    applyShapes(o, sp);
    sp.show(sp.index());
    if (!x.mine) draw();
  }
  if (sp.job !== job) return;
  sp.meshes = want.map((url) => have.get(url) || null);
  applyShapes(o, sp);
  sp.show(sp.index());
  for (const m of [...sp.all]) if (!sp.meshes.includes(m)) { sp.all.delete(m); sp.holder.remove(m); m.dispose(); }
}

// The preview level changed (or the layer got levels): each splat layer whose file differs loads the new one, and
// the old mesh is let go once the new one is in. The box stays the layer's own (o.box), so nothing moves.
export function applySplatLevels() {
  for (const o of SC.objects) {
    if (o.type !== 'splat') continue;
    const group = R.meshes.get(o.id), sp = group?.userData.splat;
    if (!sp) continue;
    const urls = frameList(o).map((fr) => splatUrl(fr));
    if (sp.job?.urls === urls.join() || (urls.length === sp.meshes.length && urls.every((u, i) => sp.meshes[i]?.userData.url === u))) continue;
    syncFrames(o, group).then(draw).catch((e) => toast(`${o.name}: ${e.message}`, true));
  }
}

// A SparkRenderer only draws when drawn again after its sort lands, which our draw-on-demand view
// doesn't do by itself: a few more draws follow each one (not while they're the follow-ups).
let kicking = false, kickTimer = 0;
const hasSplat = () => [...R.meshes.values()].some((m) => m.userData.splat && m.visible);
let hadSplat = false;  // (the draw after the last one went also needs following, to wipe it)
// While Spark is still working (a big set's rebuild after a new look or depth range, its sort), it goes on drawing
// every 100 ms, up to 5 s, and once more when it is done.
const sparkBusy = () => !!spark && (!!(spark.pendingUpdate && spark.pendingUpdate.timeoutId !== -1) || !!spark.defaultView?.sorting || !!spark.defaultView?.pending);
function kick() {
  clearTimeout(kickTimer);
  let n = 0, idle = 0;
  const go = () => {
    kicking = true; try { draw(); } finally { kicking = false; }
    n++;
    if (sparkBusy()) idle = 0; else idle++;
    if (n < 4 || (idle < 2 && n < 50)) kickTimer = setTimeout(go, n < 4 ? 120 * n : 100);
  };
  kickTimer = setTimeout(go, 80);
}
passHooks.push((pass, forRender) => {
  // depth: the splats are drawn as dots by renderDepth (splat-depth.js) over the meshes, not by Spark
  for (const m of R.meshes.values()) {
    const sp = m.userData.splat;
    if (!sp) continue;
    sp.proxy.visible = false;   // (near and far count the splat's own points: splat-depth.js splatDepths)
    if (sp.sphere && pass === 'depth') sp.sphere.visible = false;
  }
  if (spark) spark.visible = pass !== 'depth';
  if (pass !== 'color' || kicking || !spark) return;
  const has = hasSplat();
  if (has || hadSplat) kick();
  if (has !== hadSplat) setTimeout(fit);   // (splats in or out of view: the view's resolution follows, see fit)
  hadSplat = has;
});

// ---- importing --------------------------------------------------------------------------
// A file in a known unit (glTF: metres; FBX: its UnitScaleFactor) comes in at its true size. An unknown unit (OBJ, a
// splat) or an absurd size (over 50 m, under 5 cm) asks how tall it is; dismissed, it comes in at a usable size (as
// imports always did). The factor is kept in the layer (o.fit); saved scenes keep theirs.
async function fitOf(o, kind, size, unit) {
  const r = importFit(o.ext, [size.x, size.y, size.z], unit, kind === 'splat' ? 4 : 2);
  if (!r.ask) return r.fit;
  const known = unitToMetres(o.ext, unit), fileH = size.y * (known ?? 1);
  const want = await askHeight(o.name, fileH, known == null);
  return want ? fitForHeight(size.y, want) : r.fit;
}

async function upload(file, group) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (C.S.project != null) form.append('project_id', C.S.project);
  if (group) form.append('group', group);
  return api('/api/scene/asset', { method: 'POST', form, busy: `Uploading ${file.name}…` });
}

async function importOne(main, extras) {
  const ext = extOf(main.name), kind = SPLATS.has(ext) ? 'splat' : 'model';
  const up = await upload(main);
  let mtl = null;
  for (const f of extras) {
    const r = await upload(f, up.group);
    if (extOf(f.name) === 'mtl' && !mtl) mtl = r.url;
  }
  const c = controls.target;
  const o = newObject(kind, { x: +c.x.toFixed(2), z: +c.z.toFixed(2) });
  Object.assign(o, { name: main.name.replace(/\.\w+$/, '').replace(/[_]+/g, ' ').slice(0, 60) || 'Imported', url: up.url, file: up.name, ext });
  if (mtl && ext === 'obj') o.mtl = mtl;
  let size, unit = null;
  if (kind === 'model') {
    const raw = await loadModel(o);
    unit = raw.userData?.unitScaleFactor ?? null;   // (FBX: centimetres per unit)
    const s = stand(raw);
    size = s.size; loaded.set(o.id, s.wrap);
  } else {
    const mesh = await loadSplat(o);
    o.box = splatBox(mesh).map((v) => +v.toFixed(3)); o.flip = flipFor(ext);
    size = new THREE.Vector3(o.box[3] - o.box[0], o.box[4] - o.box[1], o.box[5] - o.box[2]);
    loaded.set(o.id, mesh);
  }
  o.fit = await fitOf(o, kind, size, unit);
  o.base.sx = o.base.sy = o.base.sz = o.fit;
  SC.objects.push(o); save(); select(o.id);
  toast(`${o.name} added: ${fmtLen(size.y * o.fit)} tall${o.fit === 1 ? '' : ` (×${o.fit})`}`);
}

// Model and splat files from this device into the open scene (a .mtl and textures go with their one model): how many came in
export async function importFiles(files) {
  const mains = files.filter((f) => MODELS.has(extOf(f.name)) || SPLATS.has(extOf(f.name)));
  if (!mains.length) { toast('Pick a .glb, .gltf, .obj or .fbx model, or a .ply, .splat, .ksplat or .spz splat', true); return 0; }
  const extras = mains.length === 1 ? files.filter((f) => EXTRAS.has(extOf(f.name))) : [];  // (a .mtl and textures go with their one model)
  let n = 0;
  for (const m of mains) {
    try { await importOne(m, extras); n++; } catch (e) { toast(`${m.name}: ${e.message}`, true); }
  }
  return n;
}
// A file a model or splat layer can be made from (by its name)
export const isSceneFile = (name) => MODELS.has(extOf(name)) || SPLATS.has(extOf(name));

// Once every model and splat layer of the open scene has its file drawn (or ms has passed): a still drawn then shows them
export async function whenLoaded(ms = 20000) {
  const t0 = Date.now();
  const waiting = () => SC.objects.some((o) => !o.hidden && (o.type === 'model' || o.type === 'splat') && o.url
    && !(R.meshes.get(o.id)?.userData?.model || R.meshes.get(o.id)?.userData?.splat));
  while (waiting() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
}

// ---- a 3D object from photos (Pixal3D; TRELLIS.2 for comparing) -----------------------------
// The templates save a GLB (dev/make_3d_object_templates.py builds them from ComfyUI's own workflow);
// the sheet runs one and adds the mesh as a model layer.
const OBJECT_TPL = 'deck-3d-object';
const OBJECT_TRELLIS = 'deck-3d-object-trellis';   // TRELLIS.2 from one photo: the same fields as Pixal3D's
const OBJECT_MULTI = 'deck-3d-object-multi';
const SHEET_TPL = 'deck-h3-objectsheet';
const SPLAT_TPL = 'deck-3d-object-splat';   // Idol: a gaussian splat of one object from one picture, unseen sides included
// what the sheet sets on the template's own fields (by their group name); a blank seed is a fresh one each run
const OBJ = { steps: 20, seed: '', tex: true, res: 4096, cut: true, photo: false, model: 'pixal' };
const OBJ_FIELDS = { steps: 'Detail (steps)', seed: 'Seed', tex: 'Texture', res: 'Texture resolution', cut: 'Cut out' };
const SHEET_FRAMES = [4, 54, 96, 120];   // the sheet's orbit: front, side, back, other side
const hasTrellis = () => C.S.templates.some((t) => t.id === OBJECT_TRELLIS && !t.error);
// the one-photo model: TRELLIS.2 when picked (and installed), else Pixal3D
const photoTpl = () => (OBJ.model === 'trellis' && hasTrellis() ? OBJECT_TRELLIS : OBJECT_TPL);

// a model file already on the server (a run's GLB) as a model layer, fitted and standing on the floor
// at the middle of the scene, the way an import lands
export async function addModel(url, name = 'Model', { gen = null, index = 0 } = {}) {
  const o = newObject('model', { x: 0, y: 0, z: 0 });
  Object.assign(o, { name: String(name || 'Model').slice(0, 60), url, ext: extOf(url), gen, genIndex: index });
  const raw = await loadModel(o);
  const s = stand(raw);
  o.fit = await fitOf(o, 'model', s.size, null);
  o.base.sx = o.base.sy = o.base.sz = o.fit;
  SC.objects.push(o);
  save(); select(o.id);
  toast(`${o.name} added: ${fmtLen(s.size.y * o.fit)} tall`);
  return o;
}

// a splat file already on the server (a run's), fitted and centred the way an import lands
export async function addSplat(url, name = 'Splat', { gen = null, index = 0 } = {}) {
  const c = controls.target;
  const o = newObject('splat', { x: +c.x.toFixed(2), z: +c.z.toFixed(2) });
  const ext = extOf(url);
  Object.assign(o, { name: String(name || 'Splat').slice(0, 60), url, ext, gen, genIndex: index });
  const mesh = await loadSplat(o);
  o.box = splatBox(mesh).map((v) => +v.toFixed(3)); o.flip = flipFor(ext);
  const size = new THREE.Vector3(o.box[3] - o.box[0], o.box[4] - o.box[1], o.box[5] - o.box[2]);
  loaded.set(o.id, mesh);
  o.fit = await fitOf(o, 'splat', size, null);
  o.base.sx = o.base.sy = o.base.sz = o.fit;
  SC.objects.push(o); save(); select(o.id);
  toast(`${o.name} added: ${fmtLen(size.y * o.fit)} tall${o.fit === 1 ? '' : ` (×${o.fit})`}`);
  return o;
}

// the picture field a group holds (Front, Back…), for the template's field keys
async function objectValues(templateId, groups) {
  const { template } = await import('./make.js');
  const t = template(templateId);
  if (!t) throw new Error(`Template ${templateId} isn't installed`);
  if (t.error) throw new Error(t.error);
  const values = {};
  for (const [group, name] of Object.entries(groups)) {
    if (!name) continue;
    const f = t.fields.find((x) => x.kind === 'image' && x.group === group);
    if (f) values[f.key] = name;
  }
  if (templateId === OBJECT_TPL || templateId === OBJECT_TRELLIS || templateId === OBJECT_MULTI) {
    const seed = OBJ.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(OBJ.seed);
    for (const [k, group] of Object.entries(OBJ_FIELDS)) {
      const f = t.fields.find((x) => x.group === group && x.kind !== 'image');
      if (f) values[f.key] = k === 'seed' ? seed : OBJ[k];
    }
  }
  return { t, values };
}

// who: where this run's result goes, settled when Make is pressed (objectTarget), so opening the panel for something else meanwhile can't move it
async function objectRun(templateId, values, what, who = null) {
  const { queueRun, waitGen } = await import('./make.js');
  const [g] = await queueRun({ template: templateId, values });
  toast(`${what}: queued as #${g.id}. It takes a while on the GPU.`);
  if (who?.queued && what === 'The 3D object') who.queued(g, 'model', templateId, { ...OBJ });   // (recorded now: the run is found again after a reload)
  if (who?.queued && what === 'The splat') who.queued(g, 'splat', templateId, { ...OBJ });
  const row = { id: g.id, what, state: 'running' };
  PANEL.runs = [row, ...PANEL.runs].slice(0, 5);
  drawObjectPanel();
  try {
    const done = await waitGen(g.id);
    row.state = 'done';
    return done?.outputs ? done : await api(`/api/generations/${g.id}`, { busy: false });
  } catch (e) { row.state = 'failed'; throw e; } finally { drawObjectPanel(); }
}

const glbOf = (g) => (g?.outputs || []).find((o) => /\.glb$/i.test(o.filename));

// a run's result into its place: who.queued took it already (a character's To review, a new 3D frame); who.scene is the 3D frame that
// was open when it was asked for, even if another is open now; else the open scene
async function intoScene(who, add) {
  if (who?.queued) return;
  if (who?.scene) return (await import('./frame-scene.js')).withSceneDoc(who.scene, add);
  return add();
}
async function land(g, label, who) {
  const out = glbOf(g);
  if (!out) throw new Error('That run made no 3D model (a GLB)');
  await intoScene(who, () => addModel(out.url, label, { gen: g.id, index: g.outputs.indexOf(out) }));
}

// one picture of an object as a splat (Idol): the splat file lands as a splat layer
async function makeIdolSplat(name, label, who) {
  try {
    const { t, values } = await objectValues(SPLAT_TPL, { 'Object picture': name });
    const set = (group, v) => { const f = t.fields.find((x) => x.group === group && x.kind !== 'image'); if (f) values[f.key] = v; };
    set('It is a photograph', OBJ.photo);
    set('Seed', OBJ.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(OBJ.seed));
    const g = await objectRun(SPLAT_TPL, values, 'The splat', who);
    const i = (g.outputs || []).findIndex((o) => o.kind === 'splat' || /\.(ply|spz|ksplat|splat)$/i.test(o.filename));
    if (i < 0) throw new Error('That run made no splat file');
    await intoScene(who, () => addSplat(g.outputs[i].url, label, { gen: g.id, index: i }));
  } catch (e) { toast(e.message, true); }
}

// one photo: the front view
async function makeFromPhoto(name, label, who) {
  try {
    const tpl = photoTpl();
    const { values } = await objectValues(tpl, { Front: name });
    await land(await objectRun(tpl, values, 'The 3D object', who), label, who);
  } catch (e) { toast(e.message, true); }
}

// the object sheet first (an orbit: front, side, back, other side), then the four views
async function makeFromViews(name, label, who) {
  try {
    const { t, values } = await objectValues(SHEET_TPL, {});
    const ref = t.fields.find((f) => f.kind === 'image' && f.group === 'References');
    if (!ref) throw new Error('The object sheet has no picture field');
    values[ref.key] = name;
    const g = await objectRun(SHEET_TPL, values, 'Its views');
    const out = (g.outputs || []).find((o) => o.kind === 'video');
    if (!out) throw new Error('The sheet made no clip to take its views from');
    const idx = g.outputs.indexOf(out), views = [];
    for (const f of SHEET_FRAMES) {
      views.push((await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index: idx, frame: f } })).name);
    }
    // (the sheet turns to the character's left first: side = left, other side = right)
    const { values: mv } = await objectValues(OBJECT_MULTI, { Front: views[0], Left: views[1], Back: views[2], Right: views[3] });
    await land(await objectRun(OBJECT_MULTI, mv, 'The 3D object', who), label, who);
  } catch (e) { toast(e.message, true); }
}

// the other views picked from the inputs
async function makeFromPicked(picks, label, who) {
  try {
    const { values } = await objectValues(OBJECT_MULTI, picks);
    await land(await objectRun(OBJECT_MULTI, values, 'The 3D object', who), label, who);
  } catch (e) { toast(e.message, true); }
}

// an imported model with its own skeleton, keyed bone by bone (no figure)
async function useOwnSkin(o) {
  const { addSkinned } = await import('./scene-skin.js');
  try {
    const made = await addSkinned(o.url, o.name, { gen: o.gen, index: o.genIndex || 0 });
    toast(`${made.name}: key its bones in the panel`);
  } catch (e) { toast(e.message, true); }
}

// an imported model that already has a skeleton (Mixamo, an FBX from UniRig): drive its bones directly
async function useOwnRig(o) {
  const { addRigged } = await import('./scene-rig.js');
  try {
    const made = await addRigged(o.url, o.name, { gen: o.gen, index: o.genIndex || 0 });
    toast(`${made.name}: its own skeleton drives it now`);
  } catch (e) { toast(e.message, true); }
}

// Rig a run's mesh: the mesh goes into ComfyUI's input folder, an auto-rig template (Make It Animatable
// for people, UniRig for anything else) returns a skinned model, and that becomes a rigged layer that
// takes the figure's poses.
// The rig comes back in the rigger's own size (a rigged layer is fitted to a person's height, a skinned one is the file's):
// put it where the model it was made from stands, as tall, and turned the same. A rigged or skinned layer stands centred
// with its feet at its (0, 0, 0). like: likeOf() of that model. A skinned layer takes its scale when its file has loaded
// and its height is known (asTall, scene-skin.js).
export function placeLike(o, like, figure) {
  if (!like || !o) return o;
  o.base.x = like.x; o.base.y = like.y; o.base.z = like.z; o.base.ry = like.ry;
  if (figure) o.base.sx = o.base.sy = o.base.sz = fitForHeight(figureHeight('man'), like.height);
  else o.asTall = like.height;
  save();
  pose(R.f); draw();
  return o;
}
// where a model layer stands and how tall it is, from what is drawn: { height (m), x, y, z (its base), ry }
export function likeOf(o) {
  const m = R.meshes.get(o.id);
  if (!m) return null;
  const box = new THREE.Box3().setFromObject(m), height = box.max.y - box.min.y;
  if (!Number.isFinite(height) || height <= 0) return null;
  const [x, y, z] = baseOf(box.min.toArray(), box.max.toArray());   // (where it stands, whatever its origin)
  return { height, x, y, z, ry: current(o, OBJ_CH).ry };
}

export async function rigRun(generation, index, name, template = 'deck-autorig-human', { skinned = false, url = null, like = null } = {}) {
  const { template: tpl2, queueRun, waitGen } = await import('./make.js');
  const t = tpl2(template);
  if (!t) return toast(`Rigging needs the UniRig nodes (ComfyUI-UniRig) and the ${template} template`, true);
  const up = await api('/api/scene/mesh', { method: 'POST', busy: 'Sending the model to ComfyUI…',
    body: generation == null ? { url } : { generation, index } });
  const f = t.fields.find((x) => x.group === 'Model');   // the mesh's path (a text field: no list to be on)
  const [g] = await queueRun({ template, values: f ? { [f.key]: up.file_path } : {} });
  toast(`${name || 'The model'}: rigging queued as #${g.id}. It takes a while.`);
  const done = await waitGen(g.id);
  const file = (done.outputs || []).find((x) => /\.(fbx|glb)$/i.test(x.filename));
  if (!file) throw new Error('The rig made no model file');
  if (skinned) {
    const { addSkinned } = await import('./scene-skin.js');
    return placeLike(await addSkinned(file.url, name || 'Skinned', { gen: done.id }), like, false);
  }
  const { addRigged } = await import('./scene-rig.js');
  return placeLike(await addRigged(file.url, name || 'Rigged', { gen: done.id }), like, true);
}

export async function rigModel(o, template, opts = {}) {
  if (!o || o.type !== 'model') return toast('Pick a model layer first', true);
  // a model from a run is sent by its run; any other (imported, cleaned up) by its file in the project
  if (o.gen == null && !/^\/files\/projects\//.test(o.url || '')) return toast('Rig a model that is a file in this project (one made, imported or cleaned up)', true);
  // as tall, and standing where this model does
  try { await rigRun(o.gen, o.genIndex || 0, o.name, template, { ...opts, url: o.url, like: likeOf(o) }); }
  catch (e) { toast(e.message, true); }
}

// A view the picture's edge cuts off makes a model with that part missing, and it costs a GPU run to find out: look before
// making, say which, and let it through if it's meant. A picture that can't be read is no reason to stop.
async function cutViews(picks) {
  const { cutEdges } = await import('./edge-check.js');
  const out = [];
  for (const [view, name] of Object.entries(picks)) {
    if (!name) continue;
    try {
      const img = new Image();
      img.src = inputUrl(name);
      await img.decode();
      const k = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(4, Math.round(img.naturalWidth * k)), hh = Math.max(4, Math.round(img.naturalHeight * k));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = hh;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0, w, hh);
      const edges = cutEdges(c.getImageData(0, 0, w, hh).data, w, hh);
      if (edges.length) out.push({ view, name, edges });
    } catch { /* (the run will say if it's really unreadable) */ }
  }
  return out;
}
async function checkViews(picks, go, back) {
  const cuts = await cutViews(picks), { edgeWords } = await import('./edge-check.js');
  if (!cuts.length) return go();
  openSheet(h('h3', {}, cuts.length > 1 ? 'These views look cut off' : 'This view looks cut off'),
    help('The subject reaches the edge of the picture, so what is past the edge won\'t be in the model. Go back and use a picture with space all round it. If it is meant (a bust, or a false alarm), make it anyway.'),
    h('div', { class: 'obj-views' }, cuts.map((c) => h('div', { class: 'obj-slot filled' },
      h('div', { class: 'obj-slot-pic' }, h('img', { src: thumbUrl(c.name, 320), alt: '' })),
      h('div', { class: 'obj-slot-bar' }, h('span', {}, `${c.view}: ${edgeWords(c.edges)}`))))),
    actions(button('Make it anyway', () => { closeSheet(); go(); }, { cls: 'primary' }), button('Back', back)));
}

// The object panel: floating, so nothing is lost by working elsewhere, picking a picture or closing it. Its first section is the attached
// pictures, one slot for each view (Front, Left, Back, Right). A slot takes any picture (the picker crops too), several can be added at once,
// one picture can be split across the slots, and a layer or a file can be dropped on a slot. The model says which of them it reads: Pixal3D all
// of them together, the others the first; the rest stay attached, greyed. The pictures are kept on this device per project until cleared, and
// only their names: it writes no file of its own. A run goes on the Queue and the panel stays usable.
const PANEL = { panel: null, picks: {}, label: '', who: null, runs: [] };
const draftKey = () => `deck.scene.object.${APP.project ?? 'none'}`;
const keepDraft = () => store.set(draftKey(), PANEL.picks);
const readDraft = () => { const d = store.get(draftKey(), {}); return d && typeof d === 'object' ? d : {}; };
export const attachedPictures = () => Object.keys(PANEL.panel?.shown() ? PANEL.picks : readDraft()).length;
const setPicks = (picks) => { PANEL.picks = picks; keepDraft(); drawObjectPanel(); };

// where a run started now lands: the panel's own target, the open 3D frame, a new 3D frame on the table, else the open scene
async function objectTarget() {
  if (PANEL.who) return PANEL.who;
  const live = liveFrame();
  if (live?.kind === 'scene') return { scene: live };
  if (!document.querySelector('#tab-table.active, #tab-table.live-host')) return null;
  const T = await import('./table.js'), near = T.selectedFrames?.()?.[0];
  return { queued: async (g) => { (await import('./edit-ops.js')).runBeside(near || { x: 0, y: 0, w: 0, h: 0, label: `#${g.id}` }, g, 'scene', '3D object').catch((e) => toast(e.message, true)); } };
}

function drawObjectPanel() {
  const { panel, picks, label } = PANEL;
  if (!panel) return;
  const model = OBJECT_MODELS[OBJ.model] && (OBJ.model !== 'trellis' || hasTrellis()) ? OBJ.model : 'pixal';
  const plan = planRun(picks, model), used = new Set(plan.views), first = picks[plan.views[0]], name = label || (plan.kind === 'splat' ? 'Splat' : '3D object');
  const num = (key, min, max) => h('input', { type: 'number', min, max, value: OBJ[key], placeholder: key === 'seed' ? 'random' : null,
    onchange: (e) => { OBJ[key] = e.target.value === '' && key === 'seed' ? '' : Math.max(min, Math.min(max, Math.round(+e.target.value || min))); } });
  const picker = async (o) => (await import('./source-picker.js')).openSourcePicker({ kinds: ['image'], want: 'picture', mpKey: '3d', ...o });
  const pick = (role) => picker({ title: `The ${role.toLowerCase()} view`, onPick: (n) => setPicks({ ...PANEL.picks, [role]: n }) });
  const free = VIEW_ROLES.filter((v) => !picks[v]).length;
  const addMany = () => picker({ title: 'Pictures of the object', multi: free > 1, limit: free,
    onPick: (n) => setPicks(addPictures(PANEL.picks, [n]).picks) });
  // one picture holding several views (a character sheet): a box round each, cut out into its slot
  const split = () => picker({ title: 'A picture with several views', onPick: (src) => import('./view-boxes.js').then((m) => m.openViewBoxes({ image: src, boxes: {},
    onDone: async (boxes) => {
      const out = { ...PANEL.picks };
      try {
        for (const [view, box] of Object.entries(boxes)) out[view] = (await api('/api/inputs/crop', { method: 'POST', body: { name: src, multiple: 1, crop: box } })).name;
      } catch (e) { toast(e.message, true); }
      setPicks(out);
    },
    onCancel: () => {} })) });
  const clear = (role) => { const out = { ...PANEL.picks }; delete out[role]; setPicks(out); };
  const slot = (role) => pictureSlot(h('div', { class: `obj-slot${picks[role] ? ' filled' : ''}${picks[role] && !used.has(role) ? ' unused' : ''}` },
    h('button', { type: 'button', class: 'obj-slot-pic', 'aria-label': `${role}: ${picks[role] ? 'change' : 'pick'} the picture`, title: picks[role] && !used.has(role) ? `${OBJECT_MODELS[model].label} doesn't read this one` : null, onclick: () => pick(role) },
      picks[role] ? h('img', { src: thumbUrl(picks[role], 320), alt: '', onerror: () => clear(role) })   // (the picture was deleted)
        : h('span', { class: 'obj-slot-plus' }, '+')),
    h('div', { class: 'obj-slot-bar' }, h('span', {}, role),
      picks[role] ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Clear ${role}`, title: `Clear ${role}`, onclick: () => clear(role) }, icon('close')) : null)),
  { give: (n) => setPicks({ ...PANEL.picks, [role]: n }) });
  const go = async (fn) => {
    const views = Object.fromEntries(plan.views.map((v) => [v, picks[v]]));
    const who = await objectTarget();
    checkViews(views, () => fn(views, who), () => closeSheet());
  };
  const make = plan.kind === 'splat' ? button('Make the splat', () => go((v, who) => makeIdolSplat(first, name, who)), { cls: 'primary' })
    : plan.kind === 'multi' ? button(`Make it from ${plan.views.length} views`, () => go((v, who) => makeFromPicked(v, name, who)), { cls: 'primary' })
    : button(plan.kind ? 'Make it from this picture' : 'Attach a picture first', () => go((v, who) => makeFromPhoto(first, name, who)), { cls: 'primary', disabled: !plan.kind });
  const splat = plan.kind === 'splat';
  const stateWord = { running: 'on the way', done: 'done', failed: 'failed' };
  panel.body.replaceChildren(
    label ? hint(`For ${label}`) : '',
    section('Attached images', null,
      h('div', { class: 'obj-views' }, VIEW_ROLES.map(slot)),
      h('div', { class: 'row wrap' },
        button('Add images…', addMany, { cls: 'small', disabled: !free }),
        button('Split one picture…', split, { cls: 'small', title: 'Draw a box round each view in one picture' }),
        Object.keys(picks).length ? button('Clear all', () => setPicks({}), { cls: 'small' }) : null),
      help('Pictures stay here until you clear them, whatever you do elsewhere. Each slot is a side of the object. Pixal3D uses all you attach: four views 90° apart, the object the same size in each, on a plain background, make the roundest model. TRELLIS.2 and Idol use one picture, the first; the others stay, greyed, for when you change model.')),
    section('Model', null,
      seg(Object.entries(OBJECT_MODELS).filter(([id]) => id !== 'trellis' || hasTrellis()).map(([id, m]) => [id, m.label]), model, (v) => { OBJ.model = v; drawObjectPanel(); }),
      splat ? null : field('Detail (steps)', num('steps', 4, 60)),
      field('Seed', num('seed', 0, 2 ** 31 - 1)),
      splat ? null : field('Texture resolution', seg([[1024, '1K'], [2048, '2K'], [4096, '4K']], OBJ.res, (v) => { OBJ.res = v; })),
      splat ? null : toggle('Texture', OBJ.tex, (v) => { OBJ.tex = v; }, { help: 'Off makes the shape alone, much quicker' }),
      splat ? toggle('The picture is a photograph', OBJ.photo, (v) => { OBJ.photo = v; }, { help: 'On for a camera photo, off for a render or a generated picture. The object should be one thing, whole in the frame.' }) : null,
      plan.kind === 'single' ? toggle('Cut out the object', OBJ.cut, (v) => { OBJ.cut = v; }, { help: 'Removes the background before making the model from one picture. Turn off when it is already cut out.' }) : null),
    h('div', { class: 'row wrap' }, make,
      plan.kind === 'single' && model === 'pixal' ? button('Make its other views first', () => go((v, who) => makeFromViews(first, name, who)),
        { cls: 'small', title: 'An orbit sheet of the object (front, side, back, other side), then a model from those four views' }) : null),
    ...PANEL.runs.map((r) => hint(`#${r.id} ${r.what}: ${stateWord[r.state]}`)));
}

// Opens the panel. name alone: that picture joins the ones attached. picks: these views instead (a character's, marked views). Neither: what was
// attached last. opts: { character: { queued(run, slot, template, settings) } gets the run and the model goes there; settings: start from these }
export function openObjectSheet(name = null, label = '', picks = null, opts = {}) {
  if (!PANEL.panel) {
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close (the pictures stay attached)', title: 'Close: the pictures stay attached', onclick: () => PANEL.panel.hide() }, icon('close'));
    PANEL.panel = floatPanel({ key: 'deck.scene.objectPanel', title: 'Make a 3D object', cls: 'float-object', buttons: [close], inside: true });
  }
  if (opts.settings) Object.assign(OBJ, opts.settings);
  if (!PANEL.panel.shown()) PANEL.picks = readDraft();
  PANEL.who = opts.character || null;
  PANEL.label = label || '';
  if (picks) PANEL.picks = { ...picks };
  else if (name) PANEL.picks = addPictures(PANEL.picks, [name]).picks;
  keepDraft();
  drawObjectPanel();
  PANEL.panel.show();
}

// ---- scene templates ----------------------------------------------------------------------
// Built-in ones (scene-library.js) and the user's own: saved in the library for every project (the
// one place a scene is kept outside the project folder, since a template is meant to be reused).
let hostNewTab = async () => {};
const tplUrl = (id = '', tail = '') => `/api/store/scenes${id ? `/${id}` : ''}${tail}?scope=global`;

async function openTemplates() {
  const mine = h('div', { class: 'chips' }, hint('Loading…'));
  openSheet(h('h3', {}, 'New scene from a template'),
    help('Opens a new 3D tab. Your current scene is not changed.'),
    h('div', { class: 'chips' }, ...LIBRARY.map((t) => chip(t.name, () => start(t.name, t.build()), { title: t.hint }))),
    h('h3', {}, 'Your templates'), mine,
    actions(button('Save this scene as a template…', saveAsTemplate)));
  try {
    const rows = await api(tplUrl(), { busy: false });
    mine.replaceChildren(...(rows.length ? rows.map((r) => h('span', { class: 'chip-pair' },
      chip(r.name, async () => {
        try { start(r.name, (await api(tplUrl(r.id), { busy: false })).payload); } catch (e) { toast(e.message, true); }
      }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete ${r.name}`, title: 'Delete',
        onclick: async () => {
          try {
            await api(tplUrl(r.id), { method: 'DELETE', busy: false });
            undoToast(`${r.name} deleted`, () => api(tplUrl(r.id, '/restore'), { method: 'POST', busy: false }).catch((e) => toast(e.message, true)));
            openTemplates();
          } catch (e) { toast(e.message, true); }
        } }, '✕'))) : [hint('None yet: save a scene as a template and it shows up here, in every project.')]));
  } catch (e) { mine.replaceChildren(hint(e.message)); }
}
async function start(name, payload) { closeSheet(); await hostNewTab(clone(payload), name); }

function saveAsTemplate() {
  nameSheet({ title: 'Save scene as a template', placeholder: 'Template name', save: async (name) => {
    if (!name) throw new Error('Give the template a name');
    const payload = { ...clone(SC), mode: undefined };
    await api(tplUrl(uid() + uid()), { method: 'PUT', body: { name, payload, rev: 0 } });
    toast(`Saved "${name}": it's in the templates for every project`);
  } });
}

// ---- the panel ---------------------------------------------------------------------------
function sourcesSection() {
  return section('Import and templates', null,
    h('div', { class: 'row wrap' },
      importButton(),
      button('🏠 New scene from template…', openTemplates)),
    help('Models: glb, gltf, fbx, obj (pick its .mtl and textures too). Splats: ply, splat, ksplat, spz. Files are kept in this project\'s folder.'));
}

// ---- clean up a model in Blender (POST /api/scene/cleanup): fewer or better-arranged faces, or smoother, as a new layer ----
const CLEAN_MODES = {
  quads: { label: 'Clean quads', min: 500, max: 200000, step: 500, value: 20000, unit: 'faces', send: (v) => v,
    help: 'Blender rebuilds the surface as tidy quads (about this many faces), then bakes the old colours onto it. Best before rigging or posing.' },
  voxel: { label: 'Even skin', min: 0.2, max: 5, step: 0.1, value: 1, unit: '% of its height', send: (v) => v / 100,
    help: 'Blender remeshes in an even grid of this size (smaller = finer), then bakes the old colours. Closes holes and loose bits.' },
  decimate: { label: 'Fewer faces', min: 2, max: 95, step: 1, value: 30, unit: '% kept', send: (v) => v / 100,
    help: 'Blender removes faces and keeps the shape and its UVs, so the texture stays as it is. Quick.' },
  subdivide: { label: 'Smoother', min: 1, max: 3, step: 1, value: 1, unit: 'levels', send: (v) => v,
    help: 'Blender splits every face into four, per level, and rounds the shape. Four times the faces each level.' },
};
const CLEAN = { mode: 'quads', amount: {}, tex: 2048 };

function openCleanup(o) {
  const again = () => { closeSheet(); openCleanup(o); };
  const m = CLEAN_MODES[CLEAN.mode], amount = CLEAN.amount[CLEAN.mode] ?? m.value;
  const rebuild = CLEAN.mode === 'quads' || CLEAN.mode === 'voxel';
  openSheet(h('h3', {}, 'Clean up in Blender'),
    hint(o.name),
    setupsRow({ key: sceneKey('cleanup'), get: () => clone(CLEAN), set: (v) => { Object.assign(CLEAN, { mode: 'quads', amount: {}, tex: 2048 }, clone(v)); again(); } }),
    field('What to do', seg(Object.entries(CLEAN_MODES).map(([k, v]) => [k, v.label]), CLEAN.mode, (v) => { CLEAN.mode = v; again(); })),
    help(m.help),
    field(`Amount (${m.unit})`, h('input', { type: 'number', min: m.min, max: m.max, step: m.step, value: amount,
      onchange: (e) => { CLEAN.amount[CLEAN.mode] = Math.max(m.min, Math.min(m.max, +e.target.value || m.value)); e.target.value = CLEAN.amount[CLEAN.mode]; } })),
    rebuild ? field('Texture size', seg([[1024, '1K'], [2048, '2K'], [4096, '4K']], CLEAN.tex, (v) => { CLEAN.tex = v; })) : null,
    hint('The original stays as it is: the clean one is added as a new layer.'),
    actions(button('Cancel', closeSheet), button('Clean it up', () => { closeSheet(); runCleanup(o); }, { cls: 'primary' })));
}

// pick: { mode, amount (in the mode's own unit), tex }; the sheet's choices when not given (the Edit pane passes its own)
export async function runCleanup(o, pick = null) {
  const mode = CLEAN_MODES[pick?.mode] ? pick.mode : CLEAN.mode, m = CLEAN_MODES[mode];
  const amount = pick?.amount ?? CLEAN.amount[mode] ?? m.value, tex = pick?.tex || CLEAN.tex;
  const bar = (await import('./ui.js')).busy('Blender is working on the model…');
  try {
    const { waitJob } = await import('./clipimport.js');
    const r = await waitJob(await api('/api/scene/cleanup', { method: 'POST', busy: false,
      body: { url: o.url, mode, amount: m.send(amount), tex } }));
    const made = await addModel(r.url, `${o.name} (${m.label.toLowerCase()})`.slice(0, 60));
    toast(`${made.name}: ${r.faces ? `${r.faces.toLocaleString()} faces` : 'done'}`);
    return made;
  } catch (e) { if (pick) throw e; toast(e.message, true); } finally { bar.done(); }
}
// the clean-up choices, for a form of its own (the Edit pane): { id: { label, min, max, step, value, unit, help } }
export const cleanModes = () => Object.fromEntries(Object.entries(CLEAN_MODES).map(([k, v]) => [k, { ...v, send: undefined }]));
export { openCleanup };
// What a scene op works on: the selected layer of that type, else the first ('model' | 'splat'); null when there is none.
// A model must be a file in the project (cleaned up, rigged and opened in Blender from there).
export function sceneObject(type = 'model') {
  const sel = selItem();
  if (sel?.type === type) return sel;
  return SC.objects.find((o) => o.type === type) || null;
}

function itemSection(o) {
  const set = (k, v) => { o[k] = v; changed(); };
  return section(o.type === 'splat' ? 'Imported splat' : 'Imported model', null,
    hint(`${o.file || o.name}${o.fit && o.fit !== 1 ? ` · fitted ×${o.fit}` : ''}`),
    o.type === 'model' ? toggle('Plain clay look (ignore its colours and textures)', o.clay, (on) => { o.clay = on; applyClay(R.meshes.get(o.id), o.clay); save(); draw(); }) : null,
    o.type === 'model' && /^(glb|gltf)$/.test(o.ext || extOf(o.url || '')) && /^\/files\/projects\//.test(o.url || '')
      ? button('Clean up in Blender…', () => openCleanup(o), { cls: 'small',
        title: 'Blender remeshes it into tidy quads, takes faces off, or smooths it, and adds the result as a new layer' }) : null,
    o.type === 'model' ? blenderButton(o.url, o.name) : null,
    o.type === 'splat' ? blenderSplatButton(o, trimOn(o) || boxOn(o)) : null,
    o.type === 'model' ? h('div', { class: 'row wrap' },
      button('Rig it as a person', () => rigModel(o), { cls: 'small',
        title: 'Make It Animatable gives it the figure\'s skeleton, so poses, moves and mocap drive it' }),
      button('Use its own skeleton', () => useOwnRig(o), { cls: 'small',
        title: 'An import that already has bones (Mixamo, UniRig) needs no rigging run: the figure drives those bones' }),
      button('Rig anything', () => rigModel(o, 'deck-autorig-any', { skinned: true }), { cls: 'small',
        title: 'UniRig: a skeleton for an animal or a prop; its bones are then keyed in the Bones panel' }),
      button('Key its own bones', () => useOwnSkin(o), { cls: 'small',
        title: 'An import that already has a skeleton: no rigging run, key its bones directly' })) : null,
    o.type === 'splat' ? toggle('Upside down (turn it over: many splat files are y-down)', o.flip, (on) => { set('flip', on); R.meshes.get(o.id)?.userData.splat?.fit(); draw(); }) : null,
    o.type === 'splat' && o.image ? h('div', { class: 'row wrap' },
      button('Make it again…', async () => {
        const { camera } = await import('./scene-view.js');
        makeSplat(o.image, { lookThrough, camera, busyBar: (await import('./ui.js')).busy }, o);
      }, { cls: 'small', title: 'Run SHARP on the photo again with other choices (preview density, scene shape); the layer keeps its place' })) : null,
    o.type === 'splat' && o.cam ? h('div', { class: 'row wrap' },
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      o.view ? null : button('Re-centre', () => recentre(o), { title: 'Stand it centred at the middle of the scene, on the floor and upright; the camera moves to the photo\'s view' })) : null,
    o.type === 'splat' ? framesFields(o) : null,
    o.type === 'splat' ? previewFields(o) : null,
    o.type === 'splat' ? shapeFields(o) : null,
    button('Back to fitted size', () => { const f = o.fit || 1; write(o, namesFor(o), { sx: f, sy: f, sz: f }); changed(); }),
    o.type === 'splat' ? help('Splats can\'t be drawn as depth: renders (and the ◐ Depth view) use a box the size of the splat in its place.') : null);
}

// ---- an animated splat (splat-frames.js): more files on one layer, played by a frame rate or by keys on the timeline ----
const frameName = (fr, i) => fr.label || (fr.image ? fr.image.split('/').pop() : '') || fr.file || `Frame ${i + 1}`;
const framesChanged = (o) => {   // (the 'sf' channel comes and goes with the frames: the layer's rows follow)
  const group = R.meshes.get(o.id);
  if (group?.userData.splat) syncFrames(o, group).then(() => { pose(R.f); draw(); }).catch((e) => toast(e.message, true));
  changed();
};
// which maker a new frame should use: the one that made this layer
const madeByIdol = (o) => !o.image && o.gen != null;
// Pictures queue up here, one layer's at a time: each becomes a frame as its run finishes.
const FRAME_QUEUE = new Map();   // layer: { names, how, bar, seed }
async function runFrameQueue(o, how) {
  const q = FRAME_QUEUE.get(o);
  const { busy } = await import('./ui.js');
  const bar = busy('Making frames…');
  const keepFull = levelFor(o, 'full')?.k === 'full' || !o.levels?.length;
  try {
    while (q.names.length) {
      const name = q.names.shift();
      bar.set(`Frame ${frameCount(o) + 1}: ${name.split('/').pop()}${q.names.length ? ` (${q.names.length} more after it)` : ''}`);
      let fr;
      if (how === 'idol') fr = await idolFrame(name, q);
      else {
        const { waitJob } = await import('./clipimport.js');
        const r = await waitJob(await api('/api/scene/splat', { method: 'POST', body: { image: name, project_id: C.S.project, preview: previewLevel(coarse()), keep_full: keepFull }, busy: false }));
        fr = { url: r.url, file: r.name, ext: 'ply', levels: r.levels || undefined, image: name };
      }
      if (!SC.objects.includes(o)) throw new Error('That splat is no longer in the open scene: the other pictures were not made');
      addFrame(o, fr);
      framesChanged(o);
    }
    toast(`${o.name}: ${frameCount(o)} frames`);
  } catch (e) { toast(e.message, true); } finally { FRAME_QUEUE.delete(o); bar.done(); }
}
function queueFrame(o, how, name) {
  const q = FRAME_QUEUE.get(o);
  if (q) { q.names.push(name); return; }
  FRAME_QUEUE.set(o, { names: [name], seed: OBJ.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(OBJ.seed) });
  runFrameQueue(o, how);
}
// one Idol run: every frame of a batch has the same seed, so they differ as little as they can
async function idolFrame(name, q) {
  const { t, values } = await objectValues(SPLAT_TPL, { 'Object picture': name });
  const set = (group, v) => { const f = t.fields.find((x) => x.group === group && x.kind !== 'image'); if (f) values[f.key] = v; };
  set('It is a photograph', OBJ.photo);
  set('Seed', q.seed);
  const g = await objectRun(SPLAT_TPL, values, 'The frame');
  const i = (g.outputs || []).findIndex((x) => x.kind === 'splat' || /\.(ply|spz|ksplat|splat)$/i.test(x.filename));
  if (i < 0) throw new Error('That run made no splat file');
  return { url: g.outputs[i].url, ext: extOf(g.outputs[i].url), gen: g.id, genIndex: i, image: name };
}
// a splat this project already made, as the next frame
async function pickMadeFrame(o) {
  const { projectOutputs, genLabel } = await import('./media.js');
  const { cardPicture } = await import('./kinds.js');
  const grid = h('div', { class: 'grid gallery' }, placeholder('Loading…'));
  openSheet(h('h3', {}, 'A splat as the next frame'), grid, actions(button('Done', closeSheet)));
  const items = (await projectOutputs(['splat'])).filter(({ o: x }) => SPLATS.has(extOf(x.filename)));
  grid.replaceChildren(...(items.length ? items.slice(0, 300).map(({ g, o: x, i }) => mediaCard(cardPicture(x, g), genLabel(g), () => {
    addFrame(o, { url: x.url, ext: extOf(x.url), gen: g.id, genIndex: i, label: genLabel(g) });
    framesChanged(o);
    toast(`Frame ${frameCount(o)} added`);
  })) : [placeholder('No splats made in this project yet.')]));
}
function framesFields(o) {
  const n = frameCount(o), now = R.meshes.get(o.id)?.userData.splat?.meshes;
  const addPics = (how, title) => C.openImagePicker({ title, multi: true, mpKey: '3d', onPick: (name) => queueFrame(o, how, name) });
  const sheet = (i) => { const k = o.chans?.sf?.find((x) => x.f === R.f && Math.round(x.v) === i); return !!k; };
  const makers = madeByIdol(o) ? [['idol', 'Add pictures (Idol)…']] : o.image ? [['sharp', 'Add pictures (SHARP)…']]
    : [['sharp', 'Add pictures (SHARP)…'], ['idol', 'Add pictures (Idol)…']];
  const out = [
    field(['Frames', info('Each frame is its own splat on this layer, shown one at a time. Every picture runs through the model, so a frame takes as long as a new splat, and takes that much disk. Frames from the same camera line up; the model works on each picture alone, so expect some flicker. To take pictures from a clip, use Pick a frame in the picker.')],
      h('div', { class: 'row wrap' },
        ...makers.map(([how, label]) => button(label, () => addPics(how, `Pictures for the frames of ${o.name}`), { cls: 'small' })),
        button('Add a splat this project made…', () => pickMadeFrame(o), { cls: 'small' }))),
  ];
  if (n < 2) return out;
  out.push(h('div', { class: 'stack' }, ...frameList(o).map((fr, i) => h('div', { class: 'splat-frame' },
    h('span', { title: fr.url }, `${i + 1}. ${frameName(fr, i)}${now && !now[i] ? ' (loading)' : ''}`),
    iconBtn(`Key: frame ${i + 1} from the playhead on`, '◆', () => { setKey(o, 'sf', R.f, i); framesChanged(o); }, { class: `icon-btn${sheet(i) ? ' on' : ''}` }),
    iconBtn('Earlier', '▲', () => { TRIM_EDIT.delete(o); if (swapFrames(o, i, i - 1)) framesChanged(o); }, { disabled: i === 0 }),
    iconBtn('Later', '▼', () => { TRIM_EDIT.delete(o); if (swapFrames(o, i, i + 1)) framesChanged(o); }, { disabled: i === n - 1 }),
    iconBtn('Take this frame out of the layer', '✕', () => { TRIM_EDIT.delete(o); removeFrame(o, i); framesChanged(o); })))));
  if (hasFrameKeys(o)) {
    out.push(hint(`Frame set by ${o.chans.sf.length} key${o.chans.sf.length === 1 ? '' : 's'} on the timeline`),
      button('Clear the keys: use the frame rate', () => { delete o.chans.sf; framesChanged(o); }, { cls: 'small' }));
  } else {
    out.push(
      field(['Frame rate', info('Frames a second, however fast the scene plays. For a frame on an exact moment, use the ◆ beside it: it keys that frame at the playhead, and keys take over from the rate.')],
        seg(RATES.map((r) => [r, String(r), `${r} frames a second`]), +o.frameRate || DEFAULT_RATE, (r) => { o.frameRate = r; pose(R.f); draw(); save(); })),
      field('Then', seg(LOOPS, o.frameLoop || 'loop', (k) => { o.frameLoop = k; pose(R.f); draw(); save(); })));
  }
  return out;
}

// ---- splat preview: which level the view shows (this device's choice, for every splat), and lighter levels on demand ----
function previewFields(o) {
  const facts = hint('');
  const showFacts = () => {
    const lv = levelFor(o, previewLevel(coarse())), full = levelFor(o, 'full');
    facts.textContent = !lv ? 'One file: no lighter previews yet'
      : `Showing ${levelName(lv.k)} · ${countLabel(lv.n)} of ${countLabel(full?.n)} · renders use ${full.k === 'full' ? 'the full set' : levelName(full.k)}`;
  };
  showFacts();
  const has = new Set((o.levels || []).map((v) => v.k));
  const opts = LEVELS.map(([k, label, n]) => [k, label, has.size && !has.has(k) ? `${label}: this splat has no such level (the next lighter one shows)` : `${label}${Number.isFinite(n) ? ` (${countLabel(n)})` : ''}`]);
  const out = [
    field(['Splat preview', info('How many of its Gaussians the 3D view draws, on this device, for every splat. Light is quick on a tablet; Full is every one. Renders (colour video, the Video tab\'s export) always use the full set.')],
      seg(opts, previewLevel(coarse()), (k) => { setPreviewLevel(k); applySplatLevels(); showFacts(); })),
    facts,
  ];
  if (coarse()) out.push(toggle('Sharp (full screen resolution with splats)', sharpOn(), (on) => { setSharp(on); fit(); },
    { help: 'Off: while a splat is in view, the 3D view draws at 1 pixel per screen point, which is far quicker on a tablet. On: every pixel, sharper but slower.' }));
  if (!o.levels?.length && /\.ply$/i.test(fileOf(o.url))) {
    out.push(button('Make lighter previews', async () => {
      try {
        const r = await api('/api/scene/splat/levels', { method: 'POST', body: { url: o.url }, busy: 'Making lighter previews…' });
        if (!r.levels.some((v) => v.k !== 'full')) return toast(`It has only ${countLabel(r.n)} Gaussians: already light`);
        o.levels = r.levels; o.box ||= r.box;
        for (const fr of o.frames || []) {
          if (/\.ply$/i.test(fileOf(fr.url))) fr.levels = (await api('/api/scene/splat/levels', { method: 'POST', body: { url: fr.url }, busy: 'Making lighter previews…' })).levels;
        }
        changed(); applySplatLevels();
        toast(`Previews made: ${r.levels.map((v) => `${levelName(v.k)} ${countLabel(v.n)}`).join(', ')}`);
      } catch (e) { toast(e.message, true); }
    }, { title: 'Lighter copies of this splat for the 3D view (the full set stays for renders)' }));
  }
  return out;
}

// ---- splat size (erode / dilate) and radial trim: live through the mesh's modifier (splat-shape.js); a trim can
// also cut the preview levels on the server, so the view really draws fewer ----
const meshOf = (o) => R.meshes.get(o.id)?.userData.splat?.mesh || null;
const worldScale = (o) => Math.abs(R.meshes.get(o.id)?.scale.x || 1);
function reshape(o) {
  const sp = R.meshes.get(o.id)?.userData.splat;
  if (sp) applyShapes(o, sp);
  draw();
}
// which trim the panel edits: null the whole layer's, a number that frame's own
const TRIM_EDIT = new WeakMap();
const trimFrame = (o) => { const i = TRIM_EDIT.get(o) ?? null; return i !== null && i < frameCount(o) ? i : null; };
const meshAt = (o, i) => (i === null ? meshOf(o) : R.meshes.get(o.id)?.userData.splat?.meshes?.[i] || meshOf(o));
// the box trim the gizmo edits (scene-view.js): what the panel is on; a frame takes a copy of the layer's the first time it changes
const trimShown = (o) => { const at = trimFrame(o); return at === null ? o.trim : frameList(o)[at].frameTrim || o.trim; };
boxHost.get = (o) => (o?.type === 'splat' ? trimShown(o)?.box || null : null);
boxHost.edit = (o) => {
  const at = trimFrame(o), fr = at === null ? null : frameList(o)[at];
  if (fr && !fr.frameTrim) { fr.frameTrim = structuredClone(o.trim); delete fr.frameTrim.made; delete fr.frameTrim.kept; }
  return (fr ? fr.frameTrim : o.trim)?.box || null;
};
boxHost.changed = (o) => reshape(o);
// show the frame being trimmed: the playhead goes to the nearest moment it shows
async function goToFrame(o, i) {
  const f = sceneFrameShowing(o, i, frames(), R.f, (x) => (o.chans?.sf?.length ? sampleChan(o, 'sf', x) : undefined));
  if (f === null) return toast(`Frame ${i + 1} never shows on the timeline: the view can't show it while you trim it`, true);
  (await import('./scene-export.js')).seek(f);
}
let sphereTimer = 0;
function showSphere(o, t = o.trim) {
  const sp = R.meshes.get(o.id)?.userData.splat, s = sp?.sphere;
  if (!s) return;
  s.visible = !!(t?.on && t.c);
  if (s.visible) { s.position.set(...t.c); s.scale.setScalar(t.r); }
  clearTimeout(sphereTimer);
  sphereTimer = setTimeout(() => { s.visible = false; draw(); }, 2500);
  draw();
}
// pick the trim's centre: the next tap on the view lands on the nearest splat under it (else on its box)
function pickCentre(o, done, at = null, ask = 'Tap the splat where the middle of what to keep is', reach = 0.01) {
  toast(ask);
  const grab = (e) => {
    const cv = renderer.domElement;
    if (e.target !== cv) return;
    e.stopImmediatePropagation(); e.preventDefault();
    removeEventListener('pointerdown', grab, true);
    addEventListener('pointerup', (u) => { u.stopImmediatePropagation(); }, { capture: true, once: true });
    const mesh = meshAt(o, at);
    if (!mesh) return;
    const r = cv.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
    const inv = mesh.matrixWorld.clone().invert();
    const org = ray.ray.origin.clone().applyMatrix4(inv), dir = ray.ray.direction.clone().transformDirection(inv);
    const b = o.box || [-1, -1, -1, 1, 1, 1], diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    let hit = pickAlong(samplePoints(mesh), org.toArray(), dir.toArray(), diag * reach);
    if (!hit) {
      const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
      hit = new THREE.Ray(org, dir).intersectBox(box, new THREE.Vector3())?.toArray() || null;
    }
    if (!hit) return toast('Nothing of the splat there: tap on it', true);
    done(hit.map((v) => +v.toFixed(4)));
  };
  addEventListener('pointerdown', grab, true);
}
// the box trim: keep what is inside a box the gizmo moves, turns and sizes; its bottom face can be made the floor
const FLOOR_CAM = 'deck.scene.floorcam';
function boxFields(o, at, mine, tNow, mesh0, s, big, showFacts) {
  const box = tNow()?.box;
  const out = [toggle('Box trim', !!box?.on, (on) => {
    const m = mesh0();
    if (at === null) o.trim ||= { on: false, near: 0, renders: true };
    const t = mine();
    if (on && !t.box && m) t.box = boxAround(samplePoints(m), !!o.flip);
    else if (t.box) t.box.on = on;
    reshape(o);
    if (on) setBoxEdit(true); else { if (R.boxEdit === o.id) setBoxEdit(false); changed(); }
  }, { help: 'Keep only what is inside a box. Edit the box puts the gizmo on it: Move, Rotate and Scale, with snapping, and the splat stays where it is. To level a tilted splat, turn the box until its filled bottom face lies on the ground in the splat, then Set floor. If you turned the splat by hand instead, Level the box first.' })];
  if (!box?.on) return out;
  const live = () => { reshape(o); showFacts(); };
  const side = (label, i) => rangeField(label, () => box.h[i] * 2 * s, (v) => { const b = boxHost.edit(o); b.h[i] = Math.max(0.005, v / (2 * s)); },
    { min: 0.02, max: +(big * 2).toFixed(2), step: 0.01, fmt: (v) => v.toFixed(2), onInput: () => { live(); refresh(); }, onChange: () => { live(); refresh(); save(); } });
  out.push(
    toggle('Edit the box', boxEditing(), (on) => setBoxEdit(on), { help: 'The gizmo moves, turns and sizes the box (W, E, R). Esc leaves it.' }),
    side('Width (m)', 0), side('Height (m)', 1), side('Depth (m)', 2),
    h('div', { class: 'row wrap' },
      button('Fit to the splat', () => { const m = mesh0(), b = boxHost.edit(o); if (!m || !b) return; Object.assign(b, boxAround(samplePoints(m), !!o.flip)); reshape(o); changed(); }, { cls: 'small', title: 'The box back round the splat, on the splat\'s axes' }),
      button('Level the box', () => levelBox(o), { cls: 'small', title: 'Turn the box so its bottom is level in the scene. The splat stays' }),
      button('Pick the floor…', () => pickCentre(o, (p) => { const b = boxHost.edit(o); Object.assign(b, boxBottomTo(b, p)); reshape(o); changed(); }, at, 'Tap the ground in the splat: the box\'s bottom goes there', 0.02), { cls: 'small', title: 'The next tap puts the box\'s bottom on the ground under it, along the box\'s own up' }),
      button('Set floor', () => { const r = setFloor(o, store.get(FLOOR_CAM, true) !== false); if (r) toast(r.camera ? 'Floor set: the splat and the camera turned with it' : store.get(FLOOR_CAM, true) !== false ? 'Floor set. The camera has keys, so it stayed' : 'Floor set'); }, { cls: 'small primary', title: 'Turn and move the splat so the box\'s bottom is level, on the scene\'s floor' })),
    toggle('Set floor moves the camera too', store.get(FLOOR_CAM, true) !== false, (on) => store.set(FLOOR_CAM, on), { help: 'On: the camera turns and moves with the splat, so what it sees stays the same. A camera with keys stays where it is.' }));
  return out;
}
function shapeFields(o) {
  const at = trimFrame(o), holder = at === null ? o : frameList(o)[at], key = at === null ? 'trim' : 'frameTrim';
  const own = at !== null && !!holder.frameTrim;   // (a frame with no trim of its own shows the layer's, read-only until changed)
  const tNow = () => (at === null ? o.trim : holder.frameTrim || o.trim);
  const mesh0 = () => meshAt(o, at);
  const n = levelFor(holder, 'full')?.n || mesh0()?.packedSplats?.numSplats || 0;
  const facts = hint('');
  const showFacts = () => {
    const g = +o.grow || 1, t = tNow(), mesh = mesh0();
    const body = trimBody(t), cut = body && sameTrim(body, t.made) && t.kept;   // (cut: the server counted it; else the shown level's points say)
    const share = cut && n ? t.kept / n : body && mesh ? keptShare(samplePoints(mesh), t) : 1;
    const parts = [];
    if (g !== 1) parts.push(`each Gaussian ×${g} wide · fill ≈ ×${fillFactor(g)}`);
    if (body) parts.push(`trim keeps ≈ ${Math.round(share * 100)}%${n ? ` (${countLabel(Math.round(share * n))} of ${countLabel(n)})` : ''}`
      + (sameTrim(trimBody(t), t.made) ? ' · previews cut' : ' · previews not cut yet'));
    facts.textContent = parts.join(' · ') || 'As made';
  };
  showFacts();
  const after = () => { save(); reshape(o); showFacts(); };
  const out = [
    field(['Splat size', info('Erode (below 1) shrinks every Gaussian on all three axes: less overdraw, quicker on a tablet, but gaps can show. Dilate (above 1) grows them: fills the gaps of a light preview. Renders keep the size as made unless "Size in renders too" is on.')],
      seg(GROWS.map((g) => [g, `×${g}`, g < 1 ? `Erode: fill ≈ ×${fillFactor(g)}` : g > 1 ? `Dilate: fill ≈ ×${fillFactor(g)}` : 'As made']), +o.grow || 1,
        (g) => { o.grow = g === 1 ? undefined : g; after(); })),
    toggle('Size in renders too', !!o.growRenders, (on) => { o.growRenders = on || undefined; save(); }),
  ];
  if (frameCount(o) > 1) {
    out.push(field(['Trim', info('Whole layer: one trim for every frame. A frame: a trim of its own, in place of the whole layer\'s, and only on that frame. The view goes to where that frame shows.')],
      h('select', { 'aria-label': 'What the trim applies to', onchange: (e) => {
        const v = e.target.value === '' ? null : +e.target.value;
        if (v === null) TRIM_EDIT.delete(o); else { TRIM_EDIT.set(o, v); goToFrame(o, v); }
        changed();
      } }, h('option', { value: '', selected: at === null }, 'Whole layer'),
      ...frameList(o).map((fr, i) => h('option', { value: i, selected: at === i }, `Frame ${i + 1}${fr.frameTrim ? ' (own trim)' : ''}`)))));
  }
  // the trim to change: a frame takes a copy of the layer's the first time it is changed
  const mine = () => {
    if (at !== null && !holder.frameTrim) { holder.frameTrim = o.trim ? structuredClone(o.trim) : { near: 0, renders: true }; delete holder.frameTrim.made; delete holder.frameTrim.kept; }
    return holder[key];
  };
  out.push(toggle('Radial trim', !!tNow()?.on, (on) => {
    const mesh = mesh0(), t = at === null ? o.trim : mine();
    if (on && !t?.c && mesh) {
      const pts = samplePoints(mesh), c = medianOf(pts);
      holder[key] = { near: 0, renders: true, ...t, on: true, c, r: reachOf(pts, c) };
    } else holder[key] = { ...(t || { near: 0, renders: true }), on };
    reshape(o); showSphere(o, holder[key]); changed();
  }, { help: 'Keep only the Gaussians within a distance of a centre (the splat\'s middle, or a point you tap). Shown live; "Cut the previews" makes the preview files hold only what is kept, so the view draws fewer. Renders trim the full set the same way.' }));
  if (own) out.push(button('Use the whole layer\'s trim', () => { delete holder.frameTrim; reshape(o); changed(); }, { cls: 'small', title: 'This frame gives up its own trim. Its preview files stay as they were until the previews are cut again' }));
  const t = tNow(), body = trimBody(t);
  const s = worldScale(o), bb = o.box || [0, 0, 0, 1, 1, 1];
  const big = Math.max(0.5, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) * s);
  // (a frame's first change gives it a trim of its own: the panel then offers what goes with one)
  const settledOf = (live) => () => { live(); if (at !== null && !own) changed(); else save(); };
  if (t?.on && t.c) {
    const live = () => { reshape(o); showSphere(o, tNow()); showFacts(); };
    const settled = settledOf(live);
    out.push(
      rangeField('Keep within (m)', () => tNow().r * s, (v) => { mine(); tNow().r = Math.max(0.01, v / s); }, { min: 0.05, max: +big.toFixed(2), step: 0.01, fmt: (v) => v.toFixed(2), onInput: live, onChange: settled }),
      o.cam ? rangeField('Drop near the camera (m)', () => (tNow().near || 0) * s, (v) => { mine(); tNow().near = Math.max(0, v / s); }, { min: 0, max: +Math.min(big, 5).toFixed(2), step: 0.01, fmt: (v) => (v ? v.toFixed(2) : 'off'), onInput: live, onChange: settled }) : null,
      h('div', { class: 'row wrap' },
        button('Centre: its middle', () => { const m = mesh0(); if (!m) return; mine(); tNow().c = medianOf(samplePoints(m)); settled(); }),
        button('Pick the centre…', () => pickCentre(o, (c) => { mine(); tNow().c = c; live(); changed(); }, at)),
        button('Show', () => showSphere(o, tNow()), { title: 'Show the trim\'s sphere for a moment' })));
  }
  out.push(...boxFields(o, at, mine, tNow, mesh0, s, big, showFacts));
  if (body) {
    out.push(toggle('Trim renders too', t.renders !== false, (on) => { mine(); tNow().renders = on; settledOf(() => { reshape(o); showFacts(); })(); }));
    if (/\.ply$/i.test(fileOf(holder.url)) && !sameTrim(body, t.made) && (at === null || own)) {
      out.push(button('Cut the previews', () => remakeLevels(o, body, at), { cls: 'small primary', title: 'Make the preview levels hold only what the trim keeps (the full set stays whole for renders)' }));
    }
  } else if (t?.made && /\.ply$/i.test(fileOf(holder.url)) && (at === null || own)) {
    out.push(button('Whole previews again', () => remakeLevels(o, null, at), { title: 'The trim is off: make the preview levels from the whole splat again' }));
  }
  out.push(facts);
  return out;
}
// at: one frame, with its own trim; null: the whole layer's trim, on the frames that follow it
async function remakeLevels(o, trim, at = null) {
  const busy = trim ? 'Cutting the previews…' : 'Making whole previews…', list = frameList(o);
  try {
    let r = null, kept = 0, total = 0;
    for (const i of at === null ? framesOnWhole(o) : [at]) {
      if (!/\.ply$/i.test(fileOf(list[i].url))) continue;
      r = await api('/api/scene/splat/levels', { method: 'POST', body: { url: list[i].url, trim }, busy });
      list[i].levels = r.levels; kept += r.kept; total += r.n;
      if (i === 0) o.box ||= r.box;
    }
    if (!r) return toast('None of those frames can be cut: only .ply splats have previews', true);
    const t = at === null ? o.trim : list[at].frameTrim;
    if (t) { t.made = r.trim || undefined; t.kept = r.trim ? r.kept : undefined; }
    changed(); applySplatLevels();
    toast(trim ? `Previews cut: ${countLabel(kept)} of ${countLabel(total)} kept` : 'Previews made from the whole splat');
  } catch (e) { toast(e.message, true); }
}

// ---- a picture as a splat (SHARP, POST /api/scene/splat): where the shot camera is, seen through the photo's lens ----
// First a small sheet: the preview density (this device's, as the layer panel's Splat preview) and whether the
// full set is kept for renders. These are remembered per device.
export function makeSplat(name, ctx, redo = null) {
  const ch = { ...makeChoices(coarse()), preview: previewLevel(coarse()), match: !redo };
  const keep = toggle('Keep the full set for renders', ch.keepFull, (on) => { ch.keepFull = on; },
    { help: 'On: renders (colour video, the Video tab\'s export) use every Gaussian SHARP made, about 1.2M. Off: only the previews are kept, and renders use the densest of them (smaller files).' });
  openSheet(h('h3', {}, redo ? 'Make this splat again' : 'Photo as a splat (SHARP)'),
    help('SHARP turns the picture into about 1.2 million Gaussians. The 3D view shows a lighter preview of them; you can change it later in the splat\'s panel. Any picture size or shape works (SHARP looks at it at 1536 px square whatever it is); sharp, well-lit photos about 1000 px or more on the short side do best, and a very small one gives a soft splat.'),
    redo ? field('Largest size', maxMpRow(name, (v) => { ch.mp = v; }, '3d', (v) => { ch.mp = v; })) : null,
    field('Preview density', seg(LEVELS.map(([k, label, n]) => [k, label, Number.isFinite(n) ? `${label}: about ${countLabel(n)} Gaussians` : `${label}: every Gaussian`]),
      ch.preview, (k) => { ch.preview = k; })),
    keep,
    toggle('Make the scene the photo\'s shape', ch.match, (on) => { ch.match = on; },
      { help: 'The splat has the photo\'s own lens and shape. In a scene of another shape (a tall photo in a wide scene) it shows as a strip, or cut off. On: the scene\'s picture size changes to the photo\'s shape, keeping its longer side.' }),
    redo ? null : toggle('Place at the camera instead', placeAtCamera(), (on) => setPlaceAtCamera(on),
      { help: 'Off: the splat stands centred at the middle of the scene, on the floor, and the shot camera moves to where the photo was taken. On: the splat goes where the shot camera is now (the camera stays).' }),
    actions(button('Cancel', closeSheet), button('Make the splat', () => {
      closeSheet(); setMakeChoices(ch); setPreviewLevel(ch.preview); runSplat(name, ch, ctx, redo);
    }, { cls: 'primary' })));
}

async function runSplat(name, ch, { lookThrough, camera, busyBar }, redo = null) {
  const bar = busyBar(redo ? 'Making the splat again…' : 'Making a splat from the picture…');
  try {
    const { waitJob } = await import('./clipimport.js');
    if (ch.mp) name = (await resizeInput(name, ch.mp)).name;
    const r = await waitJob(await api('/api/scene/splat', { method: 'POST', body: { image: name, project_id: C.S.project, preview: ch.preview, keep_full: ch.keepFull }, busy: false }));
    if (ch.match) matchSceneTo(r.lens?.width, r.lens?.height);
    if (redo) {   // the same layer (where it stands, its keys and trim), with the new splat in it
      const old = R.meshes.get(redo.id);
      if (old) { scene.remove(old); R.meshes.delete(redo.id); old.userData.dispose?.(); }
      loaded.delete(redo.id);
      Object.assign(redo, { url: r.url, file: r.name, fov: r.lens?.fov || redo.fov, levels: r.levels || undefined, box: r.box });
      const mesh = await loadSplat(redo);
      redo.box = r.box || splatBox(mesh).map((v) => +v.toFixed(3));
      redo.dist = +Math.max(0.3, (redo.box[2] + redo.box[5]) / 2).toFixed(3);
      if (redo.view) redo.view = { pos: standShift(redo.box, redo.flip) };
      loaded.set(redo.id, mesh);
      changed(); fit();
      toast('Splat made again');
      return;
    }
    const d = THREE.MathUtils.radToDeg, c = camera, here = placeAtCamera();
    const o = newObject('splat', here ? { x: c.position.x, y: c.position.y, z: c.position.z, rx: d(c.rotation.x), ry: d(c.rotation.y), rz: d(c.rotation.z) } : {});
    Object.assign(o, { name: `Splat of ${name.split('/').pop().replace(/\.\w+$/, '')}`.slice(0, 60), url: r.url, file: r.name, ext: 'ply',
      flip: true, cam: true, image: name, fov: r.lens?.fov || 50, levels: r.levels || undefined });
    const mesh = await loadSplat(o);
    o.box = r.box || splatBox(mesh).map((v) => +v.toFixed(3));   // (the full set's, so every level sits the same)
    o.dist = +Math.max(0.3, (o.box[2] + o.box[5]) / 2).toFixed(3);   // (its middle, straight ahead of the photo's camera)
    if (!here) o.view = { pos: standShift(o.box, o.flip) };   // (centred on the floor: the photo's camera is there)
    loaded.set(o.id, mesh);
    SC.objects.push(o); save(); select(o.id);
    lookThrough(o); fit();
    toast('Splat added: small camera moves look best (nothing is behind what the picture shows)');
  } catch (e) { toast(e.message, true); } finally { bar.done(); }
}

// A splat layer made again from its photo with the choices it was last made with (no sheet: the Edit pane's), waited for
export async function remakeSplat(o, { preview = null, keepFull = null } = {}) {
  if (!o?.image) throw new Error('This splat was not made from a photo here');
  const { camera } = await import('./scene-view.js'), { busy } = await import('./ui.js');
  const base = makeChoices(coarse());
  const ch = { ...base, preview: preview || previewLevel(coarse()), keepFull: keepFull ?? base.keepFull, match: false };
  await runSplat(o.image, ch, { lookThrough, camera, busyBar: busy }, o);
}

// Import: a file from this device (the tablet's own file chooser), or a model or splat this project already made
export async function openImportSheet() {
  const { projectOutputs, genLabel } = await import('./media.js');
  const { cardPicture } = await import('./kinds.js');
  const grid = h('div', { class: 'grid gallery' }, placeholder('Loading…'));
  openSheet(h('h3', {}, 'Import a model or splat'),
    h('div', { class: 'row wrap' },
      fileButton('From this device…', (fs) => { closeSheet(); importFiles(fs); }, { accept: ACCEPT, multiple: true, cls: 'small primary', paste: false }),
      hint('glb, gltf, fbx, obj (pick its .mtl and textures too), or ply, splat, ksplat, spz')),
    h('h3', {}, 'Made in this project'), grid);
  const items = (await projectOutputs(['mesh', 'splat'])).filter(({ g, o }) => g.template !== '3d photo' && (MODELS.has(extOf(o.filename)) || SPLATS.has(extOf(o.filename))));
  const take = async ({ g, o, i }) => {
    try {
      closeSheet();
      if (o.kind === 'splat' || SPLATS.has(extOf(o.filename))) await addSplat(o.url, genLabel(g), { gen: g.id, index: i });
      else await addModel(o.url, genLabel(g), { gen: g.id, index: i });
    } catch (e) { toast(e.message, true); }
  };
  grid.replaceChildren(...(items.length ? items.slice(0, 300).map((it) => mediaCard(cardPicture(it.o, it.g), genLabel(it.g), () => take(it), { badge: it.o.kind === 'splat' ? 'splat' : null }))
    : [placeholder('No models or splats made in this project yet.')]));
}
export const importButton = (cls = 'small primary') => button('📦 Import model or splat…', openImportSheet, { cls });

export function registerImport({ newTab }) {
  hostNewTab = newTab;
  // files dropped on the 3D view come in as layers, like the chooser's
  const view = SCN.viewer;
  if (view) {
    const files = (e) => e.dataTransfer?.types?.includes('Files');
    view.addEventListener('dragover', (e) => { if (files(e)) e.preventDefault(); });
    view.addEventListener('drop', (e) => { if (!files(e)) return; e.preventDefault(); importFiles([...e.dataTransfer.files]); });
  }
  addModeSection('edit', () => {
    const o = selItem();
    return [o && (o.type === 'model' || o.type === 'splat') ? itemSection(o) : null, sourcesSection()];
  });
}
