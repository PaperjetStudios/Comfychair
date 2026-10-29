// Scene sources for the 3D tab: imported models (glb/gltf, obj with its mtl, fbx), Gaussian splats
// (ply, splat, ksplat, spz) and starter scenes. Plugs into the Edit scene panel and the layer loaders
// (scene-view.js LOADERS / passHooks); needs nothing in the core but those hooks and the layer types.
//   model layer: { type: 'model', name, url, file, ext, mtl?, fit, clay? }
//   splat layer: { type: 'splat', name, url, file, ext, fit, flip, box: [x0,y0,z0,x1,y1,z1] (the splat's own units) }
// Both scale evenly (base.sx = sy = sz = fit, then whatever the user did). The file is in the project
// folder (POST /api/scene/asset); the layer only holds its URL.
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { actions, api, button, clone, closeSheet, fileButton, h, hint, nameSheet, openSheet, section, toast, uid, undoToast , help, toggle, chip, field, seg, info, rangeField } from './ui.js';
import { C, R, SC, newObject, namesFor, save, selItem, write } from './scene-data.js';
import { addModeSection } from './scene-modes.js';
import { LOADERS, SPLAT_PASS, activeCamera, controls, changed, draw, fit, lookThrough, passHooks, recentre, renderer, scene, select } from './scene-view.js';
import { LIBRARY } from './scene-library.js';
import { askHeight } from './scene-scale.js';
import { fitForHeight, fmtLen, importFit, unitToMetres } from './scale-math.js';
import {
  LEVELS, countLabel, fileOf, levelFor, levelName, makeChoices, placeAtCamera, previewLevel, previewUrl, renderUrl, setMakeChoices, setPlaceAtCamera,
  setPreviewLevel, setSharp, sharpOn
} from './splat-levels.js';
import { depthLook } from './splat-depth.js';
import {
  GROWS, fillFactor, keptShare, medianOf, pickAlong, reachOf, samplePoints, sameTrim, shapeMesh, standShift, trimBody, trimSphere
} from './splat-shape.js';

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
let sparkLib = null, spark = null, sparkMod = null;
export const sparkNow = () => spark;   // (the depth pass draws it on its own: splat-depth.js renderDepth)
async function sparkOf() {
  sparkLib ||= import('./vendor/spark.module.js');
  const lib = sparkMod = await sparkLib;
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
  const ready = x.mine ? null : loaded.get(o.id);
  if (!x.mine) loaded.delete(o.id);
  (ready ? Promise.resolve(ready) : loadSplat(o, x)).then((mesh) => {
    if (!alive(o, group)) return;
    const holder = new THREE.Group();   // turned over if the file is y-down
    holder.add(mesh);
    // the depth render can't use splats: a box of the same size stands in (see passHooks below)
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
    const sp = group.userData.splat = { fit, proxy, holder, mesh, url: mesh.userData.url };
    if (!x.mine) { sp.sphere = trimSphere(); holder.add(sp.sphere); }   // (the trim's sphere, while it is adjusted)
    group.userData.dispose = () => { holder.remove(sp.mesh); sp.mesh.dispose(); sp.mesh = null; };  // (the layer is gone: free its buffers)
    tagPicks(o, group); redraw();
  }).catch((e) => toast(`${o.name}: ${e.message}`, true));
};

// The preview level changed (or the layer got levels): each splat layer whose file differs loads the new one, and
// the old mesh is let go once the new one is in. The box stays the layer's own (o.box), so nothing moves.
const swapping = new Map();   // layer id: the url on its way in
export function applySplatLevels() {
  for (const o of SC.objects) {
    if (o.type !== 'splat') continue;
    const group = R.meshes.get(o.id), sp = group?.userData.splat;
    const url = splatUrl(o);
    if (!sp || (swapping.get(o.id) ?? sp.url) === url) continue;
    swapping.set(o.id, url);
    loadSplat(o, {}, url).then((mesh) => {
      if (swapping.get(o.id) !== url || !mine(o, group) || !sp.mesh) { mesh.dispose(); return; }
      const old = sp.mesh;
      sp.holder.remove(old); old.dispose();
      sp.holder.add(mesh); sp.mesh = mesh; sp.url = url;
      draw();
    }).catch((e) => toast(`${o.name}: ${e.message}`, true))
      .finally(() => { if (swapping.get(o.id) === url) swapping.delete(o.id); });
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
  // depth: each splat coloured by its depth, drawn by renderDepth (splat-depth.js) over the meshes; measuring
  // the range (rangeMat) its box stands in
  const range = forRender === 'range';
  let turned = false;
  for (const m of R.meshes.values()) {
    const sp = m.userData.splat;
    if (!sp) continue;
    sp.proxy.visible = false;   // (near and far count the splat's own points: splat-depth.js splatDepths)
    if (sp.sphere && pass === 'depth') sp.sphere.visible = false;
    if (sparkMod && sp.mesh && depthLook(sparkMod, sp.mesh, pass === 'depth' && !range)) turned = true;
  }
  if (spark) spark.visible = pass !== 'depth';
  if (turned && !forRender && !kicking) kick();   // (the splats come back in their new colours a moment later)
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
    o.type === 'splat' && o.cam ? h('div', { class: 'row wrap' },
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      o.view ? null : button('Re-centre', () => recentre(o), { title: 'Stand it centred at the middle of the scene, on the floor and upright; the camera moves to the photo\'s view' })) : null,
    o.type === 'splat' ? previewFields(o) : null,
    o.type === 'splat' ? shapeFields(o) : null,
    button('Back to fitted size', () => { const f = o.fit || 1; write(o, namesFor(o), { sx: f, sy: f, sz: f }); changed(); }),
    o.type === 'splat' ? help('Splats can\'t be drawn as depth: renders (and the ◐ Depth view) use a box the size of the splat in its place.') : null);
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
function reshape(o) { meshOf(o)?.userData.shape?.set(o); draw(); }
let sphereTimer = 0;
function showSphere(o) {
  const sp = R.meshes.get(o.id)?.userData.splat, s = sp?.sphere;
  if (!s) return;
  const t = o.trim;
  s.visible = !!(t?.on && t.c);
  if (s.visible) { s.position.set(...t.c); s.scale.setScalar(t.r); }
  clearTimeout(sphereTimer);
  sphereTimer = setTimeout(() => { s.visible = false; draw(); }, 2500);
  draw();
}
// pick the trim's centre: the next tap on the view lands on the nearest splat under it (else on its box)
function pickCentre(o, done) {
  toast('Tap the splat where the middle of what to keep is');
  const grab = (e) => {
    const cv = renderer.domElement;
    if (e.target !== cv) return;
    e.stopImmediatePropagation(); e.preventDefault();
    removeEventListener('pointerdown', grab, true);
    addEventListener('pointerup', (u) => { u.stopImmediatePropagation(); }, { capture: true, once: true });
    const mesh = meshOf(o);
    if (!mesh) return;
    const r = cv.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
    const inv = mesh.matrixWorld.clone().invert();
    const org = ray.ray.origin.clone().applyMatrix4(inv), dir = ray.ray.direction.clone().transformDirection(inv);
    const b = o.box || [-1, -1, -1, 1, 1, 1], diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    let hit = pickAlong(samplePoints(mesh), org.toArray(), dir.toArray(), diag * 0.01);
    if (!hit) {
      const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
      hit = new THREE.Ray(org, dir).intersectBox(box, new THREE.Vector3())?.toArray() || null;
    }
    if (!hit) return toast('Nothing of the splat there: tap on it', true);
    done(hit.map((v) => +v.toFixed(4)));
  };
  addEventListener('pointerdown', grab, true);
}
function shapeFields(o) {
  const n = levelFor(o, 'full')?.n || meshOf(o)?.packedSplats?.numSplats || 0;
  const facts = hint('');
  const showFacts = () => {
    const g = +o.grow || 1, t = o.trim, mesh = meshOf(o);
    const cut = t?.on && t.c && sameTrim(trimBody(t), t.made) && t.kept;   // (cut: the server counted it; else the shown level's points say)
    const share = cut && n ? t.kept / n : t?.on && t.c && mesh ? keptShare(samplePoints(mesh), t) : 1;
    const parts = [];
    if (g !== 1) parts.push(`each Gaussian ×${g} wide · fill ≈ ×${fillFactor(g)}`);
    if (t?.on && t.c) parts.push(`trim keeps ≈ ${Math.round(share * 100)}%${n ? ` (${countLabel(Math.round(share * n))} of ${countLabel(n)})` : ''}`
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
    toggle('Radial trim', !!o.trim?.on, (on) => {
      const mesh = meshOf(o);
      if (on && !o.trim?.c && mesh) {
        const pts = samplePoints(mesh), c = medianOf(pts);
        o.trim = { on: true, c, r: reachOf(pts, c), near: 0, renders: true };
      } else o.trim = { ...(o.trim || { near: 0, renders: true }), on };
      reshape(o); showSphere(o); changed();
    }, { help: 'Keep only the Gaussians within a distance of a centre (the splat\'s middle, or a point you tap). Shown live; "Cut the previews" makes the preview files hold only what is kept, so the view draws fewer. Renders trim the full set the same way.' }),
  ];
  const t = o.trim;
  if (t?.on && t.c) {
    const s = worldScale(o), b = o.box || [0, 0, 0, 1, 1, 1];
    const big = Math.max(0.5, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * s);
    const live = () => { reshape(o); showSphere(o); showFacts(); };
    out.push(
      rangeField('Keep within (m)', () => t.r * s, (v) => { t.r = Math.max(0.01, v / s); }, { min: 0.05, max: +big.toFixed(2), step: 0.01, fmt: (v) => v.toFixed(2), onInput: live, onChange: () => { save(); live(); } }),
      o.cam ? rangeField('Drop near the camera (m)', () => (t.near || 0) * s, (v) => { t.near = Math.max(0, v / s); }, { min: 0, max: +Math.min(big, 5).toFixed(2), step: 0.01, fmt: (v) => (v ? v.toFixed(2) : 'off'), onInput: live, onChange: () => { save(); live(); } }) : null,
      h('div', { class: 'row wrap' },
        button('Centre: its middle', () => { const m = meshOf(o); if (!m) return; t.c = medianOf(samplePoints(m)); save(); live(); }),
        button('Pick the centre…', () => pickCentre(o, (c) => { t.c = c; live(); changed(); })),
        button('Show', () => showSphere(o), { title: 'Show the trim\'s sphere for a moment' })),
      toggle('Trim renders too', t.renders !== false, (on) => { t.renders = on; save(); }));
    if (/\.ply$/i.test(fileOf(o.url)) && !sameTrim(trimBody(t), t.made)) {
      out.push(button('Cut the previews', () => remakeLevels(o, trimBody(t)), { cls: 'small primary', title: 'Make the preview levels hold only what the trim keeps (the full set stays whole for renders)' }));
    }
  } else if (o.trim?.made && /\.ply$/i.test(fileOf(o.url))) {
    out.push(button('Whole previews again', () => remakeLevels(o, null), { title: 'The trim is off: make the preview levels from the whole splat again' }));
  }
  out.push(facts);
  return out;
}
async function remakeLevels(o, trim) {
  try {
    const r = await api('/api/scene/splat/levels', { method: 'POST', body: { url: o.url, trim }, busy: trim ? 'Cutting the previews…' : 'Making whole previews…' });
    o.levels = r.levels; o.box ||= r.box;
    if (o.trim) { o.trim.made = r.trim || undefined; o.trim.kept = r.trim ? r.kept : undefined; }
    changed(); applySplatLevels();
    toast(trim ? `Previews cut: ${countLabel(r.kept)} of ${countLabel(r.n)} kept` : 'Previews made from the whole splat');
  } catch (e) { toast(e.message, true); }
}

// ---- a picture as a splat (SHARP, POST /api/scene/splat): where the shot camera is, seen through the photo's lens ----
// First a small sheet: the preview density (this device's, as the layer panel's Splat preview) and whether the
// full set is kept for renders. These are remembered per device.
export function makeSplat(name, ctx) {
  const ch = { ...makeChoices(coarse()), preview: previewLevel(coarse()) };
  const keep = toggle('Keep the full set for renders', ch.keepFull, (on) => { ch.keepFull = on; },
    { help: 'On: renders (colour video, the Video tab\'s export) use every Gaussian SHARP made, about 1.2M. Off: only the previews are kept, and renders use the densest of them (smaller files).' });
  openSheet(h('h3', {}, 'Photo as a splat'),
    help('SHARP turns the picture into about 1.2 million Gaussians. The 3D view shows a lighter preview of them; you can change it later in the splat\'s panel.'),
    field('Preview density', seg(LEVELS.map(([k, label, n]) => [k, label, Number.isFinite(n) ? `${label}: about ${countLabel(n)} Gaussians` : `${label}: every Gaussian`]),
      ch.preview, (k) => { ch.preview = k; })),
    keep,
    toggle('Place at the camera instead', placeAtCamera(), (on) => setPlaceAtCamera(on),
      { help: 'Off: the splat stands centred at the middle of the scene, on the floor, and the shot camera moves to where the photo was taken. On: the splat goes where the shot camera is now (the camera stays).' }),
    actions(button('Cancel', closeSheet), button('Make the splat', () => {
      closeSheet(); setMakeChoices(ch); setPreviewLevel(ch.preview); runSplat(name, ch, ctx);
    }, { cls: 'primary' })));
}

async function runSplat(name, ch, { lookThrough, camera, busyBar }) {
  const bar = busyBar('Making a splat from the picture…');
  try {
    const { waitJob } = await import('./clipimport.js');
    const r = await waitJob(await api('/api/scene/splat', { method: 'POST', body: { image: name, project_id: C.S.project, preview: ch.preview, keep_full: ch.keepFull }, busy: false }));
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
