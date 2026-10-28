// Create object mode: basic modelling for simple shapes. A lathe (draw the outline, spin it) or a
// box-style mesh (pick faces, Extrude, Inset), saved as a document of kind `objects` (this project's
// folder, or the library shared by every project), listed with a thumbnail, and placed in a scene as an
// `object` layer that points at it ({ scope, id, rev }). The geometry itself is in model-geom.js (no DOM);
// this file is the stage, the panel, the library and the layer.
import * as THREE from './vendor/three.module.min.js';
import * as MG from './model-geom.js';
import {
  $, actions, api, button, closeSheet, field, h, hint, iconBtn, openSheet, section, seg, toast, uid, undoToast, help, numSlider, colorField, chip,
} from './ui.js';
import { R, SC, TYPES, makers, newObject, save } from './scene-data.js';
import { modeOf, registerMode } from './scene-modes.js';
import { activeCamera, aimFree, controls, draw, renderer, scene, select } from './scene-view.js';
import { setSceneMode } from './scene-ui.js';
import { S, onProject, onServer } from './core.js';
import { snap, snapBar, snapOn, snapStep } from './gizmo.js';

const rnd = (x) => Math.round(x * 1000) / 1000;
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- the layer type: an object from the library, placed in a scene ----
TYPES.object = { label: 'Object', icon: '🧊', size: [1, 1, 1], hide: true };   // (hide: not in the Add list; it comes from the library)

// ---- storage: documents of kind `objects`, in the project's folder or the shared library ----
const qs = (scope) => (scope === 'global' ? '?scope=global' : S.project != null ? `?project_id=${S.project}` : '');
const url = (scope, id = '', tail = '') => `/api/store/objects${id ? `/${id}` : ''}${tail}${qs(scope)}`;
const LIB = { project: [], global: [], loaded: false };
async function loadLib() {
  try {
    const [p, g] = await Promise.all([api(url('project'), { busy: false }), api(url('global'), { busy: false })]);
    LIB.project = p; LIB.global = g; LIB.loaded = true;
  } catch (e) { toast(`Object library: ${e.message}`, true); }
  if (!ED) renderCreate();
}

// What a layer or the library needs of a document, shared: the data, and the geometry built once per id+rev
const DOCS = new Map();   // "scope/project/id": { rev, data, built: { geo, size } | null }
const keyOf = (scope, id) => `${scope === 'global' ? 'g' : S.project ?? 'none'}/${id}`;
const PEND = new Map();
export function fetchObject(scope, id) {
  const key = keyOf(scope, id);
  if (!PEND.has(key)) {
    PEND.set(key, api(url(scope, id), { busy: false }).then((d) => {
      const old = DOCS.get(key);
      if (!old || old.rev !== d.rev) DOCS.set(key, { rev: d.rev, data: d.payload, name: d.name, built: MG.buildObject(d.payload) });
      return DOCS.get(key);
    }).finally(() => PEND.delete(key)));
  }
  return PEND.get(key);
}

// ---- the object layer in a scene ----
const selMat = new THREE.MeshStandardMaterial({ color: 0xe9b44c, roughness: 0.8, side: THREE.DoubleSide });
const MISSING = new THREE.BoxGeometry(0.4, 0.4, 0.4).translate(0, 0.2, 0);
function fill(o, m, x = {}) {   // (x: { mine(o, m), draw() } for a scene built elsewhere, as in scene-import.js)
  const ref = o.ref, alive = x.mine || ((a, b) => R.meshes.get(a.id) === b), redraw = x.draw || draw;
  if (!ref) return;
  fetchObject(ref.scope, ref.id).then((d) => {
    if (!alive(o, m)) return;   // gone, or built again meanwhile
    if (!d.built) throw new Error('nothing to show');
    ref.rev = d.rev;
    m.geometry = d.built.geo; m.userData.height = d.built.size[1];
    m.userData.own.color.set(d.data.color || MG.DEFAULT_COLOR);
    redraw();
  }).catch((e) => {
    if (!alive(o, m)) return;
    m.geometry = MISSING; m.userData.own.color.set(0x8a4a4a); redraw();
    toast(`${o.name}: ${e.status === 404 || /not found/i.test(e.message) ? 'that object is gone from the library' : e.message}`, true);
  });
}
makers.object = (o, x) => {
  const own = new THREE.MeshStandardMaterial({ color: MG.DEFAULT_COLOR, roughness: 0.85, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.BufferGeometry(), own);
  m.userData.own = own;
  m.userData.paint = (on) => { m.material = on ? selMat : own; };   // (scene-view's paint calls this)
  queueMicrotask(() => fill(o, m, x));   // (makeObject registers the mesh right after this returns)
  return m;
};
// the library changed (here or on another device): objects in the open scene look again
function refreshLayers(id) {
  for (const o of SC.objects) {
    const m = R.meshes.get(o.id);
    if (o.type === 'object' && o.ref && (!id || o.ref.id === id) && m) fill(o, m);
  }
}
async function addToScene(e) {
  try {
    const d = await fetchObject(e.scope, e.id);
    const o = newObject('object', { x: +controls.target.x.toFixed(2), z: +controls.target.z.toFixed(2) });
    o.ref = { scope: e.scope, id: e.id, rev: d.rev }; o.name = e.name;
    SC.objects.push(o); save();
    setSceneMode('edit'); select(o.id);
    toast(`${e.name} is in the scene`);
  } catch (err) { toast(err.message, true); }
}

// ---- the editor's state ----
// ED: null (the library shows) or { data (what is saved), name, doc ({ scope, id, rev } once saved), undo, redo,
//   dirty, sel (faces), pt (the profile point picked), tool, multi, ext, ins }
let ED = null, pv = null, live = null;
const snapOf = () => JSON.stringify({ data: ED.data, sel: ED.sel, pt: ED.pt });
function pushUndo(before) {
  ED.undo.push(before); if (ED.undo.length > 100) ED.undo.shift();
  ED.redo = []; ED.dirty = true;
}
function edit(fn) { const before = snapOf(); fn(); pushUndo(before); }
function liveEdit(fn) { if (!live) live = snapOf(); fn(); ED.dirty = true; rebuildView(); }   // a slider: one undo step on letting go
function endLive() { if (live) { pushUndo(live); live = null; renderCreate(); } }
function step(back) {
  const [from, to] = back ? [ED.undo, ED.redo] : [ED.redo, ED.undo];
  if (!from.length) return;
  to.push(snapOf());
  Object.assign(ED, (({ data, sel, pt }) => ({ data, sel, pt }))(JSON.parse(from.pop())));
  ED.dirty = true; renderCreate(); rebuildView();
}

// a shape's starting size: standing on y = 0
const lift = (m) => { const lo = Math.min(...m.v.map((p) => p[1])); return { v: m.v.map(([x, y, z]) => [x, y - lo, z]), f: m.f }; };
const PRIMS = {
  box: { label: 'Box', icon: '▭', params: [['w', 'Width', 1, 0.05, 5], ['h', 'Height', 1, 0.05, 5], ['d', 'Depth', 1, 0.05, 5], ['sx', 'Segments across', 1, 1, 12], ['sy', 'Segments up', 1, 1, 12], ['sz', 'Segments deep', 1, 1, 12]],
    make: (p) => MG.box(p.w, p.h, p.d, p.sx, p.sy, p.sz) },
  cylinder: { label: 'Cylinder', icon: '⬮', params: [['r', 'Radius', 0.5, 0.05, 3], ['h', 'Height', 1, 0.05, 5], ['seg', 'Sides', 12, 3, 48], ['rings', 'Segments up', 1, 1, 12]],
    make: (p) => MG.cylinder(p.r, p.h, p.seg, p.rings) },
  sphere: { label: 'Sphere', icon: '●', params: [['r', 'Radius', 0.5, 0.05, 3], ['seg', 'Segments round', 12, 3, 48], ['rings', 'Segments up', 8, 2, 24]],
    make: (p) => MG.sphere(p.r, p.seg, p.rings) },
  plane: { label: 'Plane', icon: '▱', params: [['w', 'Width', 1, 0.05, 5], ['d', 'Depth', 1, 0.05, 5], ['sx', 'Segments across', 1, 1, 12], ['sz', 'Segments deep', 1, 1, 12]],
    make: (p) => MG.plane(p.w, p.d, p.sx, p.sz) },
};

function begin(data, name, doc = null) {
  ED = { data, name, doc, undo: [], redo: [], dirty: !doc, sel: [], pt: -1, tool: 'select', multi: false, ext: 0.25, ins: 0.05 };
  pv = null; live = null;
  renderCreate(); rebuildView();
  const geo = body?.geometry; geo?.computeBoundingBox();
  const b = geo?.boundingBox, hgt = b ? Math.max(0.5, b.max.y) : 1, r = b ? Math.max(0.5, b.max.x - b.min.x, b.max.z - b.min.z) : 1;
  aimFree([r * 1.5, hgt * 0.9 + 0.6, r * 2.2 + hgt * 0.5], [0, hgt / 2, 0]);
}
function startPrim(kind, p) {
  const prim = PRIMS[kind];
  begin(MG.fromMesh(lift(prim.make(p)), MG.DEFAULT_COLOR, kind === 'sphere'), prim.label);
}
function close() {
  const go = () => { closeSheet(); ED = null; pv = null; live = null; renderCreate(); rebuildView(); loadLib(); aimFree([2.6, 1.9, 3.4], [0, 0.5, 0]); };
  if (!ED.dirty) return go();
  openSheet(h('h3', {}, 'Leave this object?'), h('p', { class: 'hint sheet-hint' }, 'It has changes that are not saved.'),
    actions(button('Save…', () => saveSheet(go), { cls: 'primary' }), button('Leave without saving', go, { cls: 'danger' }), button('Keep editing', closeSheet)));
}

// ---- save ----
async function put(scope, id, body) {
  const send = () => api(url(scope, id), { method: 'PUT', body, busy: 'Saving object…' });
  try { return await send(); } catch (e) {
    if (!/stale rev/i.test(e.message)) throw e;
    body.rev = (await api(url(scope, id), { busy: false })).rev;   // changed elsewhere: this one wins
    return send();
  }
}
function saveSheet(after) {
  const name = h('input', { type: 'text', value: ED.name, placeholder: 'Name' });
  let scope = ED.doc?.scope || 'project';
  const go = async (copy) => {
    try {
      await saveObject(name.value.trim() || ED.name, scope, copy);
      closeSheet(); after?.();
    } catch (e) { toast(e.message, true); }
  };
  openSheet(h('h3', {}, 'Save object'), field('Name', name),
    field('Keep it in', seg([['project', 'This project'], ['global', 'All projects']], scope, (v) => { scope = v; })),
    help('This project: saved in the project folder. All projects: in the library every project can use.'),
    actions(button('Save', () => go(false), { cls: 'primary' }),
      ED.doc ? button('Save as a copy', () => go(true)) : null));
  setTimeout(() => name.focus(), 50);
}
async function saveObject(name, scope, copy) {
  const same = !copy && ED.doc && ED.doc.scope === scope;   // moving to the other place makes a new document
  const id = same ? ED.doc.id : uid();
  const d = await put(scope, id, { name, payload: MG.pack(ED.data), rev: same ? ED.doc.rev : 0 });
  ED.doc = { scope, id, rev: d.rev }; ED.name = name; ED.dirty = false;
  try {   // the thumbnail follows (a failure here doesn't lose the object)
    const blob = await thumb(ED.data);
    if (blob) await fetch(url(scope, id, '/still'), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
  } catch (e) { console.warn('thumbnail not saved:', e); }
  toast(`${name} saved ${scope === 'global' ? 'for all projects' : 'in this project'}`);
  loadLib(); renderCreate();
}

// a picture of the object, lit like the stage: rendered offscreen with the app's renderer
async function thumb(data) {
  const built = MG.buildObject(data);
  if (!built || !renderer) return null;
  const W = 256, sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
  sc.background = new THREE.Color(0x2a2e36);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 6, 4); sc.add(sun);
  sc.add(new THREE.Mesh(built.geo, new THREE.MeshStandardMaterial({ color: data.color || MG.DEFAULT_COLOR, roughness: 0.85, side: THREE.DoubleSide })));
  const [w, hh, d] = built.size, r = Math.max(0.2, Math.hypot(w, hh, d) / 2);
  cam.position.set(r * 1.5, hh / 2 + r * 0.8, r * 2.3).normalize().multiplyScalar(r * 3.4).add(new THREE.Vector3(0, hh / 2, 0));
  cam.lookAt(0, hh / 2, 0);
  const rt = new THREE.WebGLRenderTarget(W, W, { colorSpace: THREE.SRGBColorSpace });
  renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(null);
  const buf = new Uint8Array(W * W * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, W, buf); rt.dispose();
  const cv = document.createElement('canvas'); cv.width = cv.height = W;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, W);
  for (let y = 0; y < W; y++) img.data.set(buf.subarray((W - 1 - y) * W * 4, (W - y) * W * 4), y * W * 4);   // GL rows run bottom-up
  ctx.putImageData(img, 0, 0);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

// ---- the stage: the object being made (and, for a mesh, its faces, selection and Extrude handle) ----
let G, body, selMesh, lines, handle, handleLine, bodyMat, faceOf = null, hnd = null;
function stage() {
  if (G) return;
  G = new THREE.Group(); G.visible = false; scene.add(G);
  bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  body = new THREE.Mesh(new THREE.BufferGeometry(), bodyMat);
  selMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xe9b44c, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
  lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x14171c, transparent: true, opacity: 0.55 }));
  const top = new THREE.MeshBasicMaterial({ color: 0xff4c8a, depthTest: false, transparent: true, opacity: 0.95 });
  handle = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), top); handle.renderOrder = 20;
  handleLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff4c8a, depthTest: false })); handleLine.renderOrder = 19;
  G.add(body, selMesh, lines, handle, handleLine);
  body.frustumCulled = selMesh.frustumCulled = lines.frustumCulled = handleLine.frustumCulled = false;
}
// what the stage shows now: the saved mesh, or with Extrude / Inset on, the result of it so far
function viewState() {
  const m = ED.data.mesh;
  pv = null;
  if (ED.sel.length && ED.tool === 'extrude' && Math.abs(ED.ext) > 1e-6) pv = MG.extrude(m, ED.sel, ED.ext);
  else if (ED.sel.length && ED.tool === 'inset' && ED.ins > 1e-6) pv = MG.inset(m, ED.sel, ED.ins);
  return pv || { mesh: m, sel: ED.sel };
}
function selectionAxis() {   // where the selected faces are and which way they face (before the preview)
  const m = ED.data.mesh, c = [0, 0, 0], n = [0, 0, 0];
  for (const i of ED.sel) {
    const fc = MG.faceCentre(m, i), fn = MG.faceNormal(m, i), a = MG.faceArea(m, i);
    for (let k = 0; k < 3; k++) { c[k] += fc[k] / ED.sel.length; n[k] += fn[k] * a; }
  }
  const l = Math.hypot(...n) || 1;
  return { c: new THREE.Vector3(...c), n: new THREE.Vector3(n[0] / l, n[1] / l, n[2] / l) };
}
function rebuildView() {
  if (!scene) return;
  stage();
  G.visible = !!ED && modeOf().key === 'create';
  if (!ED) return draw();
  const d = ED.data;
  bodyMat.color.set(d.color || MG.DEFAULT_COLOR);
  for (const o of [body, selMesh, lines]) o.geometry.dispose();
  hnd = null;
  if (d.kind === 'lathe') {
    body.geometry = MG.latheGeometry(d) || new THREE.BufferGeometry();
    selMesh.geometry = new THREE.BufferGeometry(); lines.geometry = new THREE.BufferGeometry(); faceOf = null;
  } else {
    const v = viewState(), t = MG.toGeometry(v.mesh, { smooth: d.smooth });
    body.geometry = t.geo; faceOf = t.faceOf;
    lines.geometry = MG.edgeLines(v.mesh);
    const want = new Set(v.sel), pos = t.geo.attributes.position.array, out = [];
    faceOf.forEach((f, k) => { if (want.has(f)) for (let j = 0; j < 9; j++) out.push(pos[k * 9 + j]); });
    selMesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    if (ED.tool === 'extrude' && ED.sel.length) hnd = selectionAxis();
  }
  placeHandle();
  draw();
}
function placeHandle() {
  handle.visible = handleLine.visible = !!hnd;
  if (!hnd) return;
  const p = hnd.c.clone().addScaledVector(hnd.n, ED.ext);
  handle.position.copy(p);
  handle.scale.setScalar(activeCamera().position.distanceTo(p) * 0.03);
  handleLine.geometry.dispose();
  handleLine.geometry = new THREE.BufferGeometry().setFromPoints([hnd.c, p]);
}

// ---- tapping faces, dragging the Extrude handle (the canvas is shared with the orbit controls) ----
const ray = new THREE.Raycaster();
const rayAt = (e, cv) => {
  const r = cv.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
  return r;
};
const stageOn = () => !!ED && G?.visible && ED.data.kind === 'mesh';
const stepM = () => snap.gridPct / 100;   // the snap step in metres: the gizmo's grid setting, taken as centimetres
let tap = null, dragH = null;
function wire() {
  const cv = $('#sceneCanvas');
  cv.addEventListener('pointerdown', (e) => {
    if (!stageOn()) return;
    if (hnd && ED.tool === 'extrude') {   // the handle is a finger-sized target on the screen, not the little ball
      const r = cv.getBoundingClientRect(), v = handle.position.clone().project(activeCamera());
      const dist = Math.hypot(r.left + (v.x + 1) / 2 * r.width - e.clientX, r.top + (1 - v.y) / 2 * r.height - e.clientY);
      if (dist < (e.pointerType === 'touch' ? 40 : 24)) {
        e.stopImmediatePropagation(); e.preventDefault();
        cv.setPointerCapture(e.pointerId); dragH = { id: e.pointerId, from: ED.ext }; return;
      }
    }
    tap = { x: e.clientX, y: e.clientY };
  }, true);
  cv.addEventListener('pointermove', (e) => {
    if (!dragH || e.pointerId !== dragH.id) return;
    rayAt(e, cv);
    const n = hnd.n, w0 = hnd.c.clone().sub(ray.ray.origin), dd = ray.ray.direction;
    const b = n.dot(dd), den = b * b - 1;
    if (Math.abs(den) < 1e-4) return;   // looking along the axis: no telling
    let s = (n.dot(w0) - b * dd.dot(w0)) / den;
    if (snapOn('grid', e)) s = snapStep(s, stepM());
    ED.ext = rnd(clampN(s, -3, 5)); rebuildView(); syncAmounts();
  });
  const up = (e) => {
    if (dragH && e.pointerId === dragH.id) { dragH = null; return; }
    if (!tap || !stageOn()) { tap = null; return; }
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6;
    tap = null;
    if (moved || e.target !== cv) return;
    rayAt(e, cv);
    const hit = ray.intersectObject(body, false)[0], f = hit && faceOf ? faceOf[hit.faceIndex] : null;
    const cur = new Set(ED.sel), multi = ED.multi || e.shiftKey || e.ctrlKey;
    if (f == null) { if (!multi) ED.sel = []; } else if (multi) { cur.has(f) ? cur.delete(f) : cur.add(f); ED.sel = [...cur]; }
    else ED.sel = cur.size === 1 && cur.has(f) ? [] : [f];
    renderCreate(); rebuildView();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', () => { dragH = null; tap = null; });
}

// ---- panel pieces ----
const ROOT = h('div', { class: 'mdl' });
const amounts = [];   // the number + slider pairs on show (updated while dragging the handle)
function syncAmounts() { for (const f of amounts) f(); }

// a slider (numSlider) for one value; set(v) runs while it's pulled, done() on letting go or typing
function amount(label, get, set, { min, max, step = 0.01, digits = 3, done = null }) {
  const num = numSlider({ min, max, step, value: get(), digits: Math.min(digits, 3), label });
  const show = () => num.set(get());
  num.addEventListener('input', () => { if (num.dataset.scrubbing) set(parseFloat(num.value)); });
  num.addEventListener('change', () => { set(parseFloat(num.value)); show(); done?.(); });
  amounts.push(show);
  return field(label, h('div', { class: 'mdl-amount' }, num));
}
const modelColor = () => {
  const el = colorField('Colour', () => ED.data.color || MG.DEFAULT_COLOR, (v) => liveEdit(() => { ED.data.color = v; }));
  el.input.addEventListener('change', endLive);
  return el;
};
const undoRow = () => h('div', { class: 'row mdl-top' },
  iconBtn('Back to the library', '←', close),
  h('b', { class: 'grow mdl-name' }, ED.name + (ED.dirty ? ' •' : '')),
  iconBtn('Undo', '↶', () => step(true), { disabled: !ED.undo.length }), iconBtn('Redo', '↷', () => step(false), { disabled: !ED.redo.length }),
  button('Save…', () => saveSheet(), { cls: 'small primary' }));

// ---- the lathe: a profile drawn in a side view, spun round the axis ----
const PV = { w: 640, h: 576, k: 256, x0: 1.25, y0: 0.15 };   // the side view: pixels per metre, and where 0,0 sits
const toPx = (x, y) => [(x + PV.x0) * PV.k, PV.h - (y + PV.y0) * PV.k];
const fromPx = (px, py) => [px / PV.k - PV.x0, (PV.h - py) / PV.k - PV.y0];
let pcv = null;
function drawProfile() {
  if (!pcv || !ED || ED.data.kind !== 'lathe') return;
  const c = pcv.getContext('2d'), P = ED.data.profile, css = getComputedStyle(pcv);
  const ink = css.getPropertyValue('--text').trim() || '#ddd', acc = css.getPropertyValue('--accent').trim() || '#4c9aff';
  c.clearRect(0, 0, PV.w, PV.h);
  c.fillStyle = css.getPropertyValue('--surface-2').trim() || '#262a31'; c.fillRect(0, 0, PV.w, PV.h);
  c.lineWidth = 1;
  for (let g = -1; g <= 1.001; g += 0.25) { c.strokeStyle = Math.abs(g % 0.5) < 1e-6 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.06)'; const [x] = toPx(g, 0); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PV.h); c.stroke(); }
  for (let g = 0; g <= 2.001; g += 0.25) { c.strokeStyle = Math.abs(g % 0.5) < 1e-6 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.06)'; const [, y] = toPx(0, g); c.beginPath(); c.moveTo(0, y); c.lineTo(PV.w, y); c.stroke(); }
  const [ax] = toPx(0, 0);
  c.setLineDash([10, 8]); c.strokeStyle = acc; c.lineWidth = 2; c.beginPath(); c.moveTo(ax, 0); c.lineTo(ax, PV.h); c.stroke(); c.setLineDash([]);   // the axis it spins round
  const curve = MG.profileCurve(P);
  for (const sign of [-1, 1]) {   // the other side is the mirror image
    c.strokeStyle = sign < 0 ? 'rgba(255,255,255,.3)' : ink; c.lineWidth = sign < 0 ? 2 : 3;
    c.beginPath();
    curve.forEach((p, i) => { const [x, y] = toPx(sign * p.x, p.y); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
  }
  P.forEach(([x, y, s], i) => {
    const [px, py] = toPx(x, y);
    c.fillStyle = i === ED.pt ? '#ff4c8a' : acc; c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath();
    if (s) c.arc(px, py, 11, 0, Math.PI * 2); else c.rect(px - 10, py - 10, 20, 20);   // round: smooth, square: a corner
    c.fill(); c.stroke();
  });
  c.fillStyle = 'rgba(255,255,255,.5)'; c.font = '20px sans-serif';
  c.fillText('axis', ax + 8, 22); c.fillText('1 m', toPx(1, 0)[0] - 36, PV.h - 8);
}
function profileEditor() {
  pcv = h('canvas', { class: 'mdl-prof', width: PV.w, height: PV.h, 'aria-label': 'Profile: tap to add a point, drag to move it' });
  let drag = null;
  const pos = (e) => { const r = pcv.getBoundingClientRect(), k = PV.w / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k]; };
  const snapW = (w, e) => (snapOn('grid', e) ? w.map((v) => snapStep(v, stepM())) : w);
  pcv.addEventListener('pointerdown', (e) => {
    const [px, py, k] = pos(e), P = ED.data.profile, reach = (e.pointerType === 'touch' ? 34 : 20) * k;
    let best = -1, bd = reach;
    P.forEach(([x, y], i) => { const d = Math.hypot(toPx(x, y)[0] - px, toPx(x, y)[1] - py); if (d < bd) { bd = d; best = i; } });
    pcv.setPointerCapture(e.pointerId);
    drag = { i: best, at: [px, py], moved: false, before: snapOf(), id: e.pointerId };
    if (best >= 0) { ED.pt = best; drawProfile(); }
  });
  pcv.addEventListener('pointermove', (e) => {
    if (!drag || drag.i < 0 || e.pointerId !== drag.id) return;
    const [px, py, k] = pos(e);
    if (!drag.moved && Math.hypot(px - drag.at[0], py - drag.at[1]) < 6 * k) return;
    drag.moved = true;
    const [x, y] = snapW(fromPx(px, py), e), p = ED.data.profile[drag.i];
    p[0] = rnd(Math.max(0, x)); p[1] = rnd(y);
    ED.dirty = true; drawProfile(); rebuildView();
  });
  pcv.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d || e.pointerId !== d.id) return;
    if (d.moved) { pushUndo(d.before); renderCreate(); return; }
    if (d.i >= 0) { renderCreate(); return; }   // a tap on a point: picked
    const [px, py] = pos(e), [wx, wy] = snapW(fromPx(px, py), e), P = ED.data.profile;
    const at = [rnd(Math.abs(wx)), rnd(wy), 1];
    let idx = P.length, bd = Infinity;   // where it goes: in the nearest piece of the outline, or on either end
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, ay] = P[i], [bx, by] = P[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = clampN(((at[0] - ax) * dx + (at[1] - ay) * dy) / l2, 0, 1), dist = Math.hypot(at[0] - (ax + t * dx), at[1] - (ay + t * dy));
      if (dist < bd) { bd = dist; idx = i === 0 && t === 0 ? 0 : i + 1 === P.length - 1 && t === 1 ? P.length : i + 1; }
    }
    pushUndo(d.before);
    P.splice(idx, 0, at); ED.pt = idx;
    renderCreate(); rebuildView();
  });
  pcv.addEventListener('pointercancel', () => { drag = null; });
  drawProfile();
  return pcv;
}
function lathePanel() {
  const d = ED.data, P = d.profile, p = P[ED.pt];
  return [
    section('Profile', null,
      profileEditor(),
      help('Tap to add a point, drag a point to move it. Round points curve smoothly; square ones are corners. The dashed line is the axis: the other side is its mirror.'),
      h('div', { class: 'row wrap' },
        button(p && p[2] ? '◼ Make it a corner' : '● Make it smooth', () => { edit(() => { p[2] = p[2] ? 0 : 1; }); renderCreate(); rebuildView(); }, { disabled: !p }),
        button('Delete point', () => { edit(() => { P.splice(ED.pt, 1); ED.pt = -1; }); renderCreate(); rebuildView(); }, { cls: 'small danger', disabled: !p || P.length <= 2 }),
        button('All smooth', () => { edit(() => P.forEach((q) => { q[2] = 1; })); renderCreate(); rebuildView(); }),
        button('All corners', () => { edit(() => P.forEach((q) => { q[2] = 0; })); renderCreate(); rebuildView(); })),
      snapBar(['grid'], renderCreate),
      snap.grid ? hint(`Points snap to ${snap.gridPct} cm.`) : null),
    section('Spin', null,
      amount('Segments around', () => d.segments, (v) => liveEdit(() => { d.segments = Math.round(v); }), { min: 3, max: 64, step: 1, digits: 0, done: endLive }),
      amount('Sweep (°)', () => d.sweep, (v) => liveEdit(() => { d.sweep = Math.round(v); }), { min: 30, max: 360, step: 5, digits: 0, done: endLive }),
      h('div', { class: 'chips' }, [90, 180, 270, 360].map((a) => chip(`${a}°`, () => { edit(() => { d.sweep = a; }); renderCreate(); rebuildView(); }, { on: d.sweep === a }))),
      modelColor())];
}

// ---- the mesh: faces to pick, Extrude and Inset ----
function applyPreview() {
  if (!pv) return;
  const r = pv;
  edit(() => { ED.data.mesh = r.mesh; ED.sel = r.sel; });
  ED.tool = 'select'; renderCreate(); rebuildView();
}
function meshPanel() {
  const d = ED.data, m = d.mesh, n = ED.sel.length;
  amounts.length = 0;
  const maxIns = n ? MG.maxInset(m, ED.sel) : 0.5;
  const tools = [['select', '☝ Select'], ['extrude', '⬆ Extrude'], ['inset', '▣ Inset']];
  return [
    section('Faces', null,
      seg(tools, ED.tool, (v) => { ED.tool = v; renderCreate(); rebuildView(); }),
      h('div', { class: 'row wrap' },
        chip(ED.multi ? '☑ Adding to the selection' : '☐ Add to selection', () => { ED.multi = !ED.multi; renderCreate(); }, { on: ED.multi, title: 'Each tap adds or removes a face' }),
        button('All', () => { ED.sel = m.f.map((_, i) => i); renderCreate(); rebuildView(); }),
        button('None', () => { ED.sel = []; renderCreate(); rebuildView(); }),
        button('Invert', () => { const s = new Set(ED.sel); ED.sel = m.f.map((_, i) => i).filter((i) => !s.has(i)); renderCreate(); rebuildView(); })),
      hint(n ? `${n} face${n > 1 ? 's' : ''} selected (orange). ${ED.tool === 'select' ? 'Pick Extrude or Inset to work on them.' : ''}`
        : 'Tap a face of the shape to select it. Drag empty space to look around.'),
      ED.tool === 'extrude' ? [
        amount('Distance (m)', () => ED.ext, (v) => { ED.ext = rnd(v); rebuildView(); }, { min: -2, max: 3, step: snap.grid ? stepM() : 0.01 }),
        help('Drag the pink ball along the line, or type a number. Negative pushes in.'),
        snapBar(['grid'], renderCreate), snap.grid ? hint(`Snaps to ${snap.gridPct} cm.`) : null,
        button('Extrude', applyPreview, { cls: 'primary', disabled: !n || Math.abs(ED.ext) < 1e-6 })] : null,
      ED.tool === 'inset' ? [
        amount('Amount (m)', () => Math.min(ED.ins, maxIns), (v) => { ED.ins = rnd(v); rebuildView(); }, { min: 0, max: rnd(Math.max(0.01, maxIns)), step: snap.grid ? stepM() : 0.005 }),
        help('Shrinks the selected faces into a smaller face with a border around it. Extrude it next for a step or a panel.'),
        snapBar(['grid'], renderCreate),
        button('Inset', applyPreview, { cls: 'primary', disabled: !n || ED.ins < 1e-6 })] : null,
      ED.tool === 'select' ? button('Delete selected faces', () => { edit(() => { const r = MG.deleteFaces(m, ED.sel); d.mesh = r.mesh; ED.sel = []; }); renderCreate(); rebuildView(); }, { cls: 'small danger', disabled: !n }) : null),
    section('Look', null,
      seg([['flat', 'Flat'], ['smooth', 'Smooth']], d.smooth ? 'smooth' : 'flat', (v) => { edit(() => { d.smooth = v === 'smooth'; }); rebuildView(); }),
      modelColor(),
      hint(`${m.f.length} faces, ${m.v.length} points${MG.edgeStats(m).open ? ' · open (has holes)' : ''}`))];
}

// ---- library ----
function paramSheet(kind) {
  const prim = PRIMS[kind], vals = Object.fromEntries(prim.params.map(([k, , def]) => [k, def]));
  const inputs = prim.params.map(([k, label, def, min, max]) => {
    const whole = Number.isInteger(def) && Number.isInteger(min) && min >= 1;   // segments, sides
    const i = numSlider({ min, max, step: whole ? 1 : 0.05, value: vals[k], label });
    i.addEventListener('change', () => { vals[k] = clampN(parseFloat(i.value) || min, min, max); });
    return field(label, i);
  });
  openSheet(h('h3', {}, `New ${prim.label.toLowerCase()}`), h('div', { class: 'mdl-params' }, inputs),
    help('More segments give you more faces to pick, extrude and inset.'),
    actions(button('Start', () => { closeSheet(); startPrim(kind, vals); }, { cls: 'primary' })));
}
async function openEntry(e) {
  try {
    const d = await api(url(e.scope, e.id), { busy: 'Opening…' });
    const p = d.payload;
    if (p.kind === 'lathe' && Array.isArray(p.profile)) begin({ ...MG.vase(), ...p }, d.name, { scope: e.scope, id: e.id, rev: d.rev });
    else if (p.kind === 'mesh' && p.mesh) begin({ ...p, smooth: !!p.smooth }, d.name, { scope: e.scope, id: e.id, rev: d.rev });
    else throw new Error('That object is from another version');
  } catch (err) { toast(err.message, true); }
}
async function removeEntry(e) {
  try {
    await api(url(e.scope, e.id), { method: 'DELETE', busy: false });
    undoToast(`${e.name} deleted`, () => api(url(e.scope, e.id, '/restore'), { method: 'POST', busy: false }).then(loadLib).catch((err) => toast(err.message, true)));
    loadLib();
  } catch (err) { toast(err.message, true); }
}
const card = (e) => h('div', { class: 'mdl-card' },
  h('button', { type: 'button', class: 'mdl-thumb', title: `Edit ${e.name}`, onclick: () => openEntry(e) },
    e.still ? h('img', { src: e.still.url, alt: e.name, loading: 'lazy' }) : h('span', {}, '🧊')),
  h('div', { class: 'mdl-cap' }, h('span', { class: 'mdl-title' }, e.name),
    h('div', { class: 'mdl-btns' }, button('＋ Scene', () => addToScene(e), { cls: 'small primary', title: 'Put it in the scene' }),
      iconBtn('Edit', '✎', () => openEntry(e)), iconBtn('Delete', '🗑', () => removeEntry(e)))));
function libraryPanel() {
  const group = (title, scope, empty) => section(title, null,
    LIB[scope].length ? h('div', { class: 'mdl-grid' }, LIB[scope].map((e) => card({ ...e, scope }))) : hint(LIB.loaded ? empty : 'Loading…'));
  return [
    section('Create object', null,
      help('Simple shapes: spin an outline into a vase or a bottle, or start from a box and pull faces out. Saved objects can go in any scene.'),
      h('div', { class: 'chips mdl-new' },
        chip('🏺 Lathe', () => begin(MG.vase(), 'Vase'), { title: 'Draw an outline and spin it' }),
        ...Object.entries(PRIMS).map(([k, p]) => chip(`${p.icon} ${p.label}`, () => paramSheet(k), { title: `Start from a ${p.label.toLowerCase()}` })))),
    group('This project', 'project', 'Nothing saved in this project yet.'),
    group('All projects', 'global', 'Nothing shared yet: save with "All projects" to use an object everywhere.')];
}

export function renderCreate() {
  amounts.length = 0;
  ROOT.replaceChildren(...(ED ? [undoRow(), ...(ED.data.kind === 'lathe' ? lathePanel() : meshPanel())] : libraryPanel()));
  if (ED && ED.data.kind !== 'lathe') pcv = null;
}

// ---- the mode ----
export function initModel() {
  registerMode({ key: 'create', label: 'Create object', icon: '⬢', hint: 'Create object mode: basic modelling for simple shapes only',
    panel: () => { if (!ROOT.childNodes.length) renderCreate(); return ROOT; },
    select: false, stage: 'empty', view: 'free', lanes: 'none',
    enter: () => { aimFree([2.6, 1.9, 3.4], [0, 0.5, 0]); if (!G) { stage(); wire(); } rebuildView(); loadLib(); },
    exit: () => { if (G) { G.visible = false; draw(); } } });
  onServer('store', (m) => {
    if (m.kind !== 'objects') return;
    if (m.scope === 'global' || m.project_id == null || m.project_id === S.project) {
      for (const k of [...DOCS.keys()]) if (k.endsWith(`/${m.id}`)) DOCS.delete(k);
      loadLib(); if (m.id) refreshLayers(m.id); else refreshLayers();
    }
  });
  onProject(() => { LIB.project = []; LIB.loaded = false; DOCS.clear(); if (ED?.doc?.scope === 'project') ED.doc = null; if (!ED) renderCreate(); if (G) loadLib(); });
}
