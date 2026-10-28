// Real-world size in the 3D tab (scene units are metres): an object's size readout, a 1.8 m reference person and metre
// labels on the floor (drawn in the view only, never rendered), the measure tool (tap two points, say what that
// distance really is, the object rescales about its base) and "Calibrate from a person" for a photo's mesh or splat
// (the person in the source photo found on the server, their height measured through the layer's own depth).
// The maths is scale-math.js.
import * as THREE from './vendor/three.module.min.js';
import { actions, api, button, canvasFont, closeSheet, field, h, hint, icon, openSheet, seg, sheetStillOpen, store, toast } from './ui.js';
import { OBJ, R, SC, WP, current, namesFor, write } from './scene-data.js';
import { PERSON_PROFILE, activeCamera, canvas, changed, controls, draw, passHooks, photoScene, renderer, scene } from './scene-view.js';
import { samplePoints, pickAlong } from './splat-shape.js';
import { modeOf } from './scene-modes.js';
import {
  HEIGHTS, LENGTHS, baseOf, boxSize, dist, factorFor, fitForHeight, fmtHWD, fmtLen, glToCam, headFeet, personDepth, personFactor, scaledVals, tanXY
} from './scale-math.js';

// ---- an object's box in the world, at the frame on show ----
const shown = (c, root) => { for (let x = c; x && x !== root.parent; x = x.parent) if (!x.visible) return false; return true; };
const tmp = new THREE.Box3();
export function worldBox(o) {
  const m = R.meshes.get(o.id), box = new THREE.Box3();
  if (!m) return box;
  m.updateMatrixWorld(true);
  const sp = m.userData.splat;
  if (sp) return box.setFromObject(sp.proxy);   // (a splat: the box of its middle 99%, as the depth render's stand-in)
  const parts = m.userData.rig ? m.userData.rig.meshes : [];
  if (!parts.length) m.traverse((c) => { if (c.isMesh && c.layers.mask & 1 && !c.userData.joint && !c.userData.finger) parts.push(c); });
  for (const c of parts) {
    if (!shown(c, m) || !c.geometry) continue;
    if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
    box.union(tmp.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld));
  }
  return box;
}
const sizeOfBox = (b) => [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];

// "Real size" in an object's panel: height × width × depth of its world box (its scale, fit and turn included). A
// model or splat still loading fills in once it is there.
export function sizeField(o) {
  const out = h('span', { class: 'hint' }, '…');
  let tries = 0;
  const show = () => {
    if (!out.isConnected && tries) return;
    const b = worldBox(o);
    if (b.isEmpty()) { out.textContent = 'loading…'; if (tries++ < 20) setTimeout(show, 500); return; }
    out.textContent = fmtHWD(sizeOfBox(b));
    tries = 1;
  };
  setTimeout(show);
  return field(['Real size (H × W × D)', out]);
}

// ---- rescaling about the base (one undo step; keyed at the playhead when the object is animated) ----
export function rescale(o, k, what = '') {
  if (!(k > 0) || Math.abs(k - 1) < 1e-6) return;
  const b = worldBox(o), names = namesFor(o), v = current(o, names);
  const base = b.isEmpty() ? [v.x, v.y, v.z] : baseOf(b.min.toArray(), b.max.toArray());
  const n = scaledVals(v, base, k);
  for (const c of ['sx', 'sy', 'sz']) n[c] = Math.max(0.0001, n[c]);
  write(o, names, n);
  changed();
  const after = worldBox(o);
  toast(`${o.name}${what ? ` (${what})` : ''}: ×${+k.toPrecision(3)}${after.isEmpty() ? '' : `, now ${fmtHWD(sizeOfBox(after))}`}`);
}

// ---- view-only helpers: the reference person and the floor's metre labels, plus the measure tool's marks ----
const helpers = new THREE.Group();   // never in a render or the depth view (see the pass hook)
let refFig = null, labels = null, marks = null;
const REF_H = 1.8;
export const refOn = () => !!store.get('deck.scene.refPerson', false);

function label(text, px = 40, color = '#c9d3e3') {
  const cv = document.createElement('canvas'), c = cv.getContext('2d');
  c.font = canvasFont(px);
  cv.width = Math.ceil(c.measureText(text).width) + 12; cv.height = px + 10;
  c.font = canvasFont(px); c.fillStyle = color; c.textBaseline = 'middle'; c.fillText(text, 6, cv.height / 2 + 1);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return { t, aspect: cv.width / cv.height };
}
// the outline of a person 1.8 m tall (the Person shape's profile, both sides), with its height over its head
function buildRef() {
  const curve = new THREE.SplineCurve(PERSON_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
  const right = curve.getPoints(70).map((p) => new THREE.Vector3(p.x * 0.46, p.y * REF_H, 0));
  const pts = [...right, ...right.slice(1, -1).reverse().map((p) => new THREE.Vector3(-p.x, p.y, 0))];
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.8 });
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat));
  const { t, aspect } = label(`${REF_H} m`, 32, '#dbe7ff');
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  sp.scale.set(0.12 * aspect, 0.12, 1); sp.position.set(0, REF_H + 0.12, 0); sp.renderOrder = 12;
  g.add(sp);
  g.traverse((c) => { c.raycast = () => {}; });
  return g;
}
// "1 m" … "10 m" at the floor along both of the grid's middle lines (the grid is in 1 m squares): small, faint
// labels that always face the view (flat on the floor they can't be read from a camera at standing height)
function buildLabels() {
  const g = new THREE.Group(), tex = new Map();
  const add = (n, x, z) => {
    if (!tex.has(n)) tex.set(n, label(`${n} m`, 40, '#b4bfd0'));
    const { t, aspect } = tex.get(n), hgt = 0.1;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, opacity: 0.6, depthWrite: false }));
    sp.center.set(0.5, 0); sp.scale.set(hgt * aspect, hgt, 1); sp.position.set(x, 0.01, z); sp.raycast = () => {};
    g.add(sp);
  };
  for (let i = 1; i <= 10; i++) for (const s of [-1, 1]) { add(i, s * i, 0); add(i, 0, s * i); }
  return g;
}
// what the reference stands beside: the selected object (to its right, seen from the camera), else the view's middle
function placeRef() {
  const cam = activeCamera(), o = SC.objects.find((x) => x.id === R.sel);
  const b = o && !o.hidden ? worldBox(o) : null;
  const at = new THREE.Vector3();
  if (b && !b.isEmpty()) {
    const c = b.getCenter(new THREE.Vector3()), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    const reach = Math.abs((b.max.x - b.min.x) * right.x) / 2 + Math.abs((b.max.z - b.min.z) * right.z) / 2;
    at.copy(c).addScaledVector(right, reach + 0.45).setY(b.min.y);
  } else {   // (a step to the right of what the view looks at: not on top of whatever stands there)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    at.set(controls.target.x, 0, controls.target.z).addScaledVector(right, 0.8);
  }
  refFig.position.copy(at);
  refFig.rotation.y = Math.atan2(cam.position.x - at.x, cam.position.z - at.z);
}

export function setRef(on) {
  store.set('deck.scene.refPerson', !!on);
  draw();
}

// the measure tool's marks: a dot at each tapped point and the line between
function setMarks(pts) {
  marks.clear();
  if (!pts?.length) return;
  const dot = new THREE.SphereGeometry(1, 12, 8), mat = new THREE.MeshBasicMaterial({ color: 0xffd34c, depthTest: false, transparent: true });
  const size = Math.max(0.01, activeCamera().position.distanceTo(pts[0]) * 0.008);
  for (const p of pts) { const d = new THREE.Mesh(dot, mat); d.position.copy(p); d.scale.setScalar(size); d.renderOrder = 13; marks.add(d); }
  if (pts.length > 1) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd34c, depthTest: false, transparent: true }));
    l.renderOrder = 13; marks.add(l);
  }
  marks.traverse((c) => { c.raycast = () => {}; });
}
export const clearMarks = () => { setMarks(null); draw(); };

export function initScale() {
  refFig = buildRef(); labels = buildLabels(); marks = new THREE.Group();
  helpers.add(refFig, labels, marks);
  scene.add(helpers);
  passHooks.push((pass, forRender) => {
    const live = !forRender && pass === 'color' && modeOf().stage !== 'empty';   // (not on Create object's empty stage)
    helpers.visible = live;
    if (!live) return;
    labels.visible = !R.playing || WP.grid;
    refFig.visible = refOn();
    if (refFig.visible) placeRef();
  });
  // (its toggle is in the view bar's Overlays menu: scene-ui.js)
}

// ---- measure: two taps on the selected object, then what that distance really is ----
const rayAt = (e) => {
  const r = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCamera());
  return ray;
};
// where a ray meets the object (world): a mesh's surface; a splat's nearest Gaussian along it, else its box
export function hitOn(o, ray) {
  const m = R.meshes.get(o.id);
  if (!m) return null;
  m.updateMatrixWorld(true);
  const sp = m.userData.splat;
  if (sp) {
    if (sp.mesh) {
      const inv = sp.mesh.matrixWorld.clone().invert();
      const org = ray.ray.origin.clone().applyMatrix4(inv), dir = ray.ray.direction.clone().transformDirection(inv);
      const b = o.box || [-1, -1, -1, 1, 1, 1], diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      const p = pickAlong(samplePoints(sp.mesh), org.toArray(), dir.toArray(), diag * 0.006);
      if (p) return sp.mesh.localToWorld(new THREE.Vector3(...p));
    }
    return ray.intersectObject(sp.proxy, false)[0]?.point || null;
  }
  const hit = ray.intersectObject(m, true).find((x) => shown(x.object, m) && x.object.layers.mask & 1 && !x.object.userData.joint);
  return hit?.point || null;
}

let measuring = null;   // { o, pts, grab }
export function stopMeasure() {
  if (!measuring) return;
  removeEventListener('pointerdown', measuring.grab, true);
  removeEventListener('keydown', measuring.esc, true);
  measuring = null;
  canvas.classList.remove('measuring');
}
export function startMeasure(o) {
  stopMeasure(); clearMarks();
  const m = { o, pts: [] };
  m.grab = (e) => {
    if (e.target !== canvas || !e.isPrimary) return;
    e.stopImmediatePropagation(); e.preventDefault();
    addEventListener('pointerup', (u) => { u.stopImmediatePropagation(); }, { capture: true, once: true });
    const p = hitOn(o, rayAt(e));
    if (!p) return toast(`That isn't on ${o.name}: tap on it`, true);
    m.pts.push(p); setMarks(m.pts); draw();
    if (m.pts.length < 2) return toast('Now the second point');
    stopMeasure();
    realSheet(o, m.pts);
  };
  m.esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); stopMeasure(); clearMarks(); toast('Measuring stopped'); } };
  measuring = m;
  addEventListener('pointerdown', m.grab, true);
  addEventListener('keydown', m.esc, true);
  canvas.classList.add('measuring');
  toast(`Tap the first point on ${o.name}`);
}

// the number box and Set of a sheet's Custom choice
function custom(placeholder, set) {
  const n = h('input', { type: 'number', min: 0.01, step: 0.01, placeholder, 'aria-label': 'Custom length in metres', style: 'max-width:7em' });
  const go = () => { const v = parseFloat(n.value); if (v > 0) set(v); else toast('Type a length in metres', true); };
  n.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return h('div', { class: 'row', style: 'align-items:center' }, n, h('span', { class: 'hint' }, 'm'), button('Set', go, { style: 'flex:0 0 auto' }));
}
function realSheet(o, pts) {
  const d = dist(pts[0].toArray(), pts[1].toArray());
  const apply = (real, what) => { closeSheet(); clearMarks(); rescale(o, factorFor(d, real), `${what || fmtLen(real)} between the points`); };
  const seq = openSheet(h('h3', {}, `Measured ${fmtLen(d)}: really?`),
    h('div', { class: 'chips' }, ...LENGTHS.map(([n, v]) => button(`${n} ${fmtLen(v)}`, () => apply(v, n)))),
    field('Custom', custom(fmtLen(d).replace(/ .*/, ''), (v) => apply(v))),
    actions(button('Measure again', () => { closeSheet(); startMeasure(o); }), button('Done', () => { closeSheet(); clearMarks(); })));
  const keep = setInterval(() => { if (!sheetStillOpen(seq)) { clearInterval(keep); if (!measuring) clearMarks(); } }, 400);
}

// ---- calibrate from a person: found in the source photo, measured through the layer's own depth ----
// The layer's points in the photo camera's space (x right, y down, z ahead), and a way back to the world.
async function camPoints(o) {
  const m = R.meshes.get(o.id);
  if (!m) throw new Error('It has not loaded yet');
  m.updateMatrixWorld(true);
  if (o.type === 'splat') {
    const sp = m.userData.splat;
    if (!sp?.mesh) throw new Error('The splat has not loaded yet');
    const pts = new Float32Array(samplePoints(sp.mesh));
    if (!o.flip) glToCam(pts);   // (a photo's splat is y-down, z ahead: the camera's own axes)
    const toWorld = (p) => sp.mesh.localToWorld(new THREE.Vector3(p[0], o.flip ? p[1] : -p[1], o.flip ? p[2] : -p[2]));
    return { pts, toWorld };
  }
  const src = await photoScene(o.url), shown = m.children[0], a = [], p = new THREE.Vector3();
  src.updateMatrixWorld(true);
  src.traverse((c) => {
    const pos = c.isMesh && c.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 60000));
    for (let i = 0; i < pos.count; i += step) { p.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld); a.push(p.x, p.y, p.z); }
  });
  if (!shown) throw new Error('The photo has not loaded yet');
  return { pts: glToCam(new Float32Array(a)), toWorld: (q) => shown.localToWorld(new THREE.Vector3(q[0], -q[1], -q[2])) };
}

export async function calibrate(o) {
  let found;
  try {
    found = await api('/api/scene/person', { method: 'POST', body: { image: o.image }, busy: 'Looking for a person in the photo…' });
  } catch (e) { return noPerson(o, e.message); }
  if (!found.people?.length) return noPerson(o, 'No person found in the photo');
  let geo;
  try { geo = await camPoints(o); } catch (e) { return toast(e.message, true); }
  const [tx, ty] = tanXY(o.fov || 50, found.w / found.h);
  const s = current(o, OBJ).sy;
  const people = found.people.map((box) => {
    const d = personDepth(geo.pts, box, tx, ty);
    if (d == null) return null;
    const { head, feet } = headFeet(box, d, tx, ty);
    return { box, head, feet, now: dist(head, feet) * s };
  }).filter(Boolean);
  if (!people.length) return noPerson(o, 'A person was found, but the layer has no depth where they are');
  personSheet(o, people, geo);
}
function noPerson(o, why) {
  openSheet(h('h3', {}, 'Calibrate from a person'), hint(why),
    actions(button('Cancel', closeSheet), button('Measure instead', () => { closeSheet(); startMeasure(o); }, { cls: 'small primary' })));
}
function personSheet(o, people, geo) {
  let i = 0, want = store.get('deck.scene.personH', 1.7);
  const facts = hint('');
  const show = () => {
    const p = people[i];
    facts.textContent = `This person is ${fmtLen(p.now)} tall in the scene now`;
    setMarks([geo.toWorld(p.head), geo.toWorld(p.feet)]); draw();
  };
  const apply = (v) => {
    want = v; store.set('deck.scene.personH', v);
    const p = people[i];
    closeSheet(); clearMarks();
    rescale(o, personFactor(p.head, p.feet, current(o, OBJ).sy, v), `a person ${fmtLen(v)}`);
  };
  const seq = openSheet(h('h3', {}, 'Calibrate from a person'),
    people.length > 1 ? field('Which person', seg(people.map((p, k) => [k, `${k + 1}`, `Person ${k + 1}: ${fmtLen(p.now)} now`]), i, (k) => { i = +k; show(); })) : null,
    facts,
    field('Their real height', h('div', { class: 'chips' }, ...[1.5, 1.6, 1.7, 1.8, 1.9].map((v) => button(fmtLen(v), () => apply(v), { cls: `small${v === want ? ' primary' : ''}` })))),
    field('Custom', custom(String(want), apply)),
    actions(button('Cancel', () => { closeSheet(); clearMarks(); }), button('Measure instead', () => { closeSheet(); startMeasure(o); })));
  show();
  const keep = setInterval(() => { if (!sheetStillOpen(seq)) { clearInterval(keep); if (!measuring) clearMarks(); } }, 400);
}

// ---- the panel's part: the readout and the tools (scene-ui.js placeProps puts it under Size) ----
export function scaleProps(o) {
  const photo = (o.type === 'photo' || (o.type === 'splat' && o.cam)) && o.image;
  return [
    sizeField(o),
    h('div', { class: 'row wrap' },
      button('Measure…', () => startMeasure(o), { title: 'Tap two points on it, then say how far apart they really are: it rescales about its base' }),
      photo ? button('Calibrate from a person', () => calibrate(o), { title: 'Find a person in the source photo and scale the whole layer so they are a real height' }) : null),
  ];
}

// ---- import: "About how tall is it?" (null: dismissed) ----
export function askHeight(name, fileHeight, unknown) {
  return new Promise((done) => {
    let settled = false;
    const pick = (v) => { if (settled) return; settled = true; closeSheet(); done(v); };
    const seq = openSheet(h('h3', {}, 'About how tall is it?'),
      hint(`${name}: ${fmtLen(fileHeight)} tall in its file${unknown ? ' (its unit is unknown)' : ' (that size looks wrong)'}`),
      h('div', { class: 'chips' }, ...HEIGHTS.map(([n, v]) => button(`${n} ${fmtLen(v)}`, () => pick(v)))),
      field('Custom', custom('1.0', pick)),
      actions(button(`As in the file (${fmtLen(fileHeight)})`, () => pick(fileHeight)), button('Usable size', () => pick(null))));
    const keep = setInterval(() => { if (!sheetStillOpen(seq)) { clearInterval(keep); if (!settled) { settled = true; done(null); } } }, 300);
  });
}
export { fitForHeight };
