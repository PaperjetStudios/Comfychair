// Scene sources for the 3D tab: imported models (glb/gltf, obj with its mtl, fbx), Gaussian splats
// (ply, splat, ksplat, spz) and starter scenes. Plugs into the Edit scene panel and the layer loaders
// (scene-view.js LOADERS / passHooks); needs nothing in the core but those hooks and the layer types.
//   model layer: { type: 'model', name, url, file, ext, mtl?, fit, clay? }
//   splat layer: { type: 'splat', name, url, file, ext, fit, flip, box: [x0,y0,z0,x1,y1,z1] (the splat's own units) }
// Both scale evenly (base.sx = sy = sz = fit, then whatever the user did). The file is in the project
// folder (POST /api/scene/asset); the layer only holds its URL.
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { actions, api, button, clone, closeSheet, fileButton, h, hint, nameSheet, openSheet, section, toast, uid, undoToast , help, toggle, chip } from './ui.js';
import { C, R, SC, newObject, namesFor, save, selItem, write } from './scene-data.js';
import { addModeSection } from './scene-modes.js';
import { LOADERS, controls, changed, draw, fit, passHooks, renderer, scene, select } from './scene-view.js';
import { LIBRARY } from './scene-library.js';

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
async function sparkOf() {
  sparkLib ||= import('./vendor/spark.module.js');
  const lib = await sparkLib;
  if (!spark) { spark = new lib.SparkRenderer({ renderer }); scene.add(spark); }
  return lib;
}
async function loadSplat(o, x = {}) {
  const lib = x.lib ? await x.lib() : await sparkOf();
  const mesh = new lib.SplatMesh({ url: o.url, fileName: o.file || undefined });
  await mesh.initialized;
  mesh.raycast = () => {};  // picking uses the box (the splats are far too many to ray-test)
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
  const ready = x.mine ? null : loaded.get(o.id);
  if (!x.mine) loaded.delete(o.id);
  (ready ? Promise.resolve(ready) : loadSplat(o, x)).then((mesh) => {
    if (!alive(o, group)) return;
    const holder = new THREE.Group();   // turned over if the file is y-down
    holder.add(mesh);
    // the depth render can't use splats: a box of the same size stands in (see passHooks below)
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), clayMat);
    proxy.visible = false;
    const box = o.box || splatBox(mesh);
    const fit = () => {  // the holder and box for the current flip: standing on the floor, centred
      const f = o.flip ? -1 : 1, [x0, y0, z0, x1, y1, z1] = box;
      const lo = [x0, f > 0 ? y0 : -y1, f > 0 ? z0 : -z1], hi = [x1, f > 0 ? y1 : -y0, f > 0 ? z1 : -z0];
      holder.rotation.x = o.flip ? Math.PI : 0;
      // a photo's splat (o.cam) keeps the photo's camera at the object's origin, looking down -Z: placing the
      // object places that camera, as with a photo mesh
      if (o.cam) holder.position.set(0, 0, 0);
      else holder.position.set(-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2);
      proxy.scale.set(Math.max(0.01, hi[0] - lo[0]), Math.max(0.01, hi[1] - lo[1]), Math.max(0.01, hi[2] - lo[2]));
      proxy.position.set(0, proxy.scale.y / 2, 0);
    };
    fit();
    group.add(holder, proxy);
    group.userData.splat = { fit, proxy };
    group.userData.dispose = () => { holder.remove(mesh); mesh.dispose(); };  // (the layer is gone: free its buffers)
    tagPicks(o, group); redraw();
  }).catch((e) => toast(`${o.name}: ${e.message}`, true));
};

// A SparkRenderer only draws when drawn again after its sort lands, which our draw-on-demand view
// doesn't do by itself: a few more draws follow each one (not while they're the follow-ups).
let kicking = false, kickTimer = 0;
const hasSplat = () => [...R.meshes.values()].some((m) => m.userData.splat && m.visible);
let hadSplat = false;  // (the draw after the last one went also needs following, to wipe it)
function kick() {
  clearTimeout(kickTimer);
  let n = 0;
  const go = () => {
    kicking = true; try { draw(); } finally { kicking = false; }
    if (++n < 4) kickTimer = setTimeout(go, 120 * n);
  };
  kickTimer = setTimeout(go, 80);
}
passHooks.push((pass) => {
  for (const m of R.meshes.values()) if (m.userData.splat) m.userData.splat.proxy.visible = pass === 'depth';
  if (spark) spark.visible = pass !== 'depth';
  if (pass !== 'color' || kicking || !spark) return;
  const has = hasSplat();
  if (has || hadSplat) kick();
  if (has !== hadSplat) setTimeout(fit);   // (splats in or out of view: the view's resolution follows, see fit)
  hadSplat = has;
});

// ---- importing --------------------------------------------------------------------------
// big or tiny files (FBX is often in cm) come in at a usable size; the factor is kept in the layer
const fitFor = (size, target) => {
  const m = Math.max(size.x, size.y, size.z);
  return m > 12 || m < 0.3 ? +(target / m).toPrecision(3) || 1 : 1;
};

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
  let size;
  if (kind === 'model') {
    const s = stand(await loadModel(o));
    size = s.size; loaded.set(o.id, s.wrap);
  } else {
    const mesh = await loadSplat(o);
    o.box = splatBox(mesh).map((v) => +v.toFixed(3)); o.flip = flipFor(ext);
    size = new THREE.Vector3(o.box[3] - o.box[0], o.box[4] - o.box[1], o.box[5] - o.box[2]);
    loaded.set(o.id, mesh);
  }
  o.fit = fitFor(size, kind === 'splat' ? 4 : 2);
  o.base.sx = o.base.sy = o.base.sz = o.fit;
  SC.objects.push(o); save(); select(o.id);
  toast(o.fit === 1 ? `${o.name} added` : `${o.name} added, scaled ×${o.fit} to a usable size`);
}

async function importFiles(files) {
  const mains = files.filter((f) => MODELS.has(extOf(f.name)) || SPLATS.has(extOf(f.name)));
  if (!mains.length) return toast('Pick a .glb, .gltf, .obj or .fbx model, or a .ply, .splat, .ksplat or .spz splat', true);
  const extras = mains.length === 1 ? files.filter((f) => EXTRAS.has(extOf(f.name))) : [];  // (a .mtl and textures go with their one model)
  for (const m of mains) {
    try { await importOne(m, extras); } catch (e) { toast(`${m.name}: ${e.message}`, true); }
  }
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
      fileButton('📦 Import model or splat…', importFiles, { accept: ACCEPT, multiple: true, cls: 'small primary' }),
      button('🏠 New scene from template…', openTemplates)),
    help('Models: glb, gltf, fbx, obj (pick its .mtl and textures too). Splats: ply, splat, ksplat, spz. Files are kept in this project\'s folder.'));
}

function itemSection(o) {
  const set = (k, v) => { o[k] = v; changed(); };
  return section(o.type === 'splat' ? 'Imported splat' : 'Imported model', null,
    hint(`${o.file || o.name}${o.fit && o.fit !== 1 ? ` · fitted ×${o.fit}` : ''}`),
    o.type === 'model' ? toggle('Plain clay look (ignore its colours and textures)', o.clay, (on) => { o.clay = on; applyClay(R.meshes.get(o.id), o.clay); save(); draw(); }) : null,
    o.type === 'splat' ? toggle('Upside down (turn it over: many splat files are y-down)', o.flip, (on) => { set('flip', on); R.meshes.get(o.id)?.userData.splat?.fit(); draw(); }) : null,
    button('Back to fitted size', () => { const f = o.fit || 1; write(o, namesFor(o), { sx: f, sy: f, sz: f }); changed(); }),
    o.type === 'splat' ? help('Splats can\'t be drawn as depth: renders (and the ◐ Depth view) use a box the size of the splat in its place.') : null);
}

// ---- a picture as a splat (SHARP, POST /api/scene/splat): where the shot camera is, seen through the photo's lens ----
export async function makeSplat(name, { lookThrough, camera, busyBar }) {
  const bar = busyBar('Making a splat from the picture…');
  try {
    const { waitJob } = await import('./clipimport.js');
    const r = await waitJob(await api('/api/scene/splat', { method: 'POST', body: { image: name, project_id: C.S.project }, busy: false }));
    const d = THREE.MathUtils.radToDeg, c = camera;
    const o = newObject('splat', { x: c.position.x, y: c.position.y, z: c.position.z, rx: d(c.rotation.x), ry: d(c.rotation.y), rz: d(c.rotation.z) });
    Object.assign(o, { name: `Splat of ${name.split('/').pop().replace(/\.\w+$/, '')}`.slice(0, 60), url: r.url, file: r.name, ext: 'ply',
      flip: true, cam: true, image: name, fov: r.lens?.fov || 50 });
    const mesh = await loadSplat(o);
    o.box = splatBox(mesh).map((v) => +v.toFixed(3));
    o.dist = +Math.max(0.3, (o.box[2] + o.box[5]) / 2).toFixed(3);   // (its middle, straight ahead of the photo's camera)
    loaded.set(o.id, mesh);
    SC.objects.push(o); save(); select(o.id);
    lookThrough(o);
    toast('Splat added: small camera moves look best (nothing is behind what the picture shows)');
  } catch (e) { toast(e.message, true); } finally { bar.done(); }
}

export function registerImport({ newTab }) {
  hostNewTab = newTab;
  addModeSection('edit', () => {
    const o = selItem();
    return [o && (o.type === 'model' || o.type === 'splat') ? itemSection(o) : null, sourcesSection()];
  });
}
