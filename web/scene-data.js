import * as FIGURE from './figure.js';
import { toast, uid } from './ui.js';

export let C;  // app state and actions handed over by app.js (see sceneModule there)
export const FPS = 24;
// the same length as the H3 templates' "Seconds to frames (24 fps, 17k+5 grid)" node
const framesFor = (sec) => { const n = Math.max(5, Math.round(sec * FPS)); return n + (((5 - n % 17) % 17) + 17) % 17; };
export const OBJ = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
export const CAM = ['px', 'py', 'pz', 'tx', 'ty', 'tz', 'fov'];
export const SIZES = [[768, 448], [448, 768], [1024, 576], [576, 1024], [832, 480], [480, 832], [1280, 720], [720, 1280], [768, 768]];
export const TYPES = {
  person: { label: 'Person', icon: '🧍', size: [0.45, 1.75, 0.28] },
  child: { label: 'Child', icon: '🧒', size: [0.32, 1.2, 0.2], geo: 'person' },
  box: { label: 'Box', icon: '▭', size: [1.2, 0.75, 0.7] },
  ball: { label: 'Ball', icon: '●', size: [0.6, 0.6, 0.6] },
  cylinder: { label: 'Cylinder', icon: '⬮', size: [0.5, 1, 0.5] },
  wall: { label: 'Wall', icon: '▯', size: [3, 2.6, 0.12], geo: 'box' },
  // these two scale evenly (sx = sy = sz): a posable figure (figure.js) and a picture as a mesh (MoGe)
  figure: { label: 'Posable person', icon: '🤸', size: [1, 1, 1] },
  photo: { label: 'Photo', icon: '🖼', size: [1, 1, 1] },
};
export const EVEN = new Set(['figure', 'photo']);
// what's keyed: a figure's keys also hold its pose (j: joint rotations, m: parameters on top)
export const FIG = [...OBJ, 'j', 'm', 'pn'];  // pn: the pose's name, for a prompt
export const namesFor = (o) => (o.type === 'figure' ? FIG : OBJ);
export const MODES = [['translate', '✥ Move', 'w'], ['rotate', '⟳ Rotate', 'e'], ['scale', '⤢ Scale', 'r']];
export const ROOM = 'room';  // R.sel for the room; null is the camera
// where the gizmo sits on an object (what it turns and scales around), in the object's own space
const PIVOTS = {
  figure: [['feet', 'Feet'], ['hips', 'Hips'], ['com', 'Centre of mass'], ['head', 'Head']],
  photo: [['origin', 'Lens'], ['center', 'Centre']],
  other: [['base', 'Base'], ['center', 'Centre'], ['top', 'Top']],
};
export const pivotsFor = (o) => PIVOTS[o.type] || PIVOTS.other;
export const pivotOf = (o) => (pivotsFor(o).some(([k]) => k === o.pivot) || (o.type === 'figure' && FIGURE.JOINTS[o.pivot]) ? o.pivot
  : o.type === 'figure' ? 'hips' : o.type === 'photo' ? 'center' : 'base');

// ---- scene data ------------------------------------------------------------
export let SC;   // the scene (persisted per project)
export const R = { modeKey: null, free: false, f: 0, sel: null, joint: null, figTab: 'pose', poseCat: 'stand', mask: 'all', sym: false, speed: 1, inPlace: false, renders: {}, promptOff: new Set(), promptNames: false, mode: 'translate', playing: false, depth: false, autoKey: true, meshes: new Map(), room: [], applying: false, lastRender: null };

export const newRoom = () => ({ w: 8, d: 8, h: 2.8, walls: true, ceiling: true, hidden: false });
export function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, blur: 2, room: newRoom(),
    camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, keys: [], ease: 'smooth' },
    objects: [newObject('person', { x: 0, z: 0 }, [])],
  };
}

export function newObject(type, at = {}, others = SC.objects) {
  const t = TYPES[type];
  const n = others.filter((o) => o.type === type).length + 1;
  const o = { id: uid(), type, name: `${t.label} ${n}`, ease: 'smooth', keys: [], hidden: false,
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
  if (type === 'figure') { o.base.j = FIGURE.preset('stand').j; o.ground = true; }
  return o;
}

// scenes saved before rotation on all axes, hiding and a deletable room
export function upgrade(sc) {
  for (const o of sc.objects) {
    o.base = { rx: 0, rz: 0, ...o.base }; o.hidden = !!o.hidden;
    if (o.type === 'figure' && o.ground == null) o.ground = false;  // planted on the floor: older figures kept their own height
  }
  if (sc.room) sc.room = { ceiling: false, hidden: false, ...sc.room };
  return sc;
}

export function setC(helpers) { C = helpers; }
export function setSC(sc) { SC = sc; }

// How an edit reaches the tab that saves it and the toolbar that shows undo (scene.js sets these), so
// this file needs nothing from the rest.
export const hooks = { ready: async () => {}, persist() {}, history() {}, tab: () => null };
// an Undo button that outlives a tab switch must not write into the other tab's scene
export function sameTab() {
  const t = hooks.tab();
  return () => hooks.tab() === t || (toast('Switch back to that tab to undo', true), false);
}

// undo / redo: the scene as JSON after each saved change (one list per tab: a switch resets it)
export const HIST = { undo: [], redo: [], cur: null };
// (the mode is the tab's own, not an edit: it stays out of the list)
const snap = () => JSON.stringify({ ...SC, mode: undefined });
export function resetHistory() { TEMP.clear(); HIST.undo = []; HIST.redo = []; HIST.cur = snap(); hooks.history(); }
function remember() {
  const s = snap();
  if (s === HIST.cur) return;
  HIST.undo.push(HIST.cur);
  if (HIST.undo.length > 100) HIST.undo.shift();
  HIST.redo = []; HIST.cur = s;
  hooks.history();
}

// the tab saves the scene a moment later (and flushes on leaving)
export function save() { remember(); hooks.persist(); }


export const frames = () => framesFor(SC.seconds);
const ease = (t) => t * t * (3 - 2 * t);
// a key's ease (or the item's): 'smooth' is the default; in / out are the camera moves' slow start and slow stop
export const EASES = { linear: (t) => t, in: (t) => t * t * t, out: (t) => 1 - (1 - t) ** 3, smooth: ease };
const pick = (o, names) => Object.fromEntries(names.map((n) => [n, o[n]]));

// an item's values at frame f: its keys eased in between, held before the first and after the last
export function sample(item, names, f) {
  const k = item.keys;
  if (!k.length) return pick(item.base, names);
  if (f <= k[0].f) return pick({ ...item.base, ...k[0] }, names);
  const last = k[k.length - 1];
  if (f >= last.f) return pick({ ...item.base, ...last }, names);
  let i = 0;
  while (k[i + 1].f <= f) i++;
  const a = { ...item.base, ...k[i] }, b = { ...item.base, ...k[i + 1] };
  const t = (f - a.f) / (b.f - a.f), e = (EASES[k[i].ease || item.ease] || ease)(t);  // a key can set its own ease
  return Object.fromEntries(names.map((n) => [n, n === 'j' ? FIGURE.slerpPose(a.j, b.j, e) : n === 'm' ? FIGURE.lerpParams(a.m, b.m, e)
    : n === 'pn' ? (e < 0.5 ? a.pn : b.pn) : a[n] + (b[n] - a[n]) * e]));
}

// With auto key off, a change to an animated item isn't saved: it's held here (by item, for the
// frame it was made on) until the playhead moves, and ◆ Key keeps it.
export const TEMP = new Map();
// an item's values at frame f, with a held change on top
export function current(item, names, f = R.f) {
  const t = item.keys.length ? TEMP.get(item) : null;
  return t && t.f === f ? pick(t.v, names) : sample(item, names, f);
}

// write values: into the key at the playhead when the item is animated, else into its base
export function write(item, names, vals) {
  if (!item.keys.length) { Object.assign(item.base, vals); return; }
  if (!R.autoKey) { TEMP.set(item, { f: R.f, v: { ...current(item, names), ...vals } }); return; }
  let k = item.keys.find((x) => x.f === R.f);
  if (!k) { k = { f: R.f, ...sample(item, names, R.f) }; item.keys.push(k); item.keys.sort((a, b) => a.f - b.f); }
  Object.assign(k, vals);
}

export function addKey(item, names, vals = current(item, names)) {
  TEMP.delete(item);
  if (!item.keys.length) Object.assign(item.base, vals);
  const k = item.keys.find((x) => x.f === R.f);
  if (k) Object.assign(k, vals); else { item.keys.push({ f: R.f, ...vals }); item.keys.sort((a, b) => a.f - b.f); }
}

export const selItem = () => SC.objects.find((o) => o.id === R.sel) || null;
// what ◆ Key acts on: the selected object, else the camera (the room isn't animated)
export const keyTarget = () => { const o = selItem(); return o ? [o, namesFor(o)] : R.sel === ROOM ? [null, null] : [SC.camera, CAM]; };
