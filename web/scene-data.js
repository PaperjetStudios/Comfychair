import * as FIGURE from './figure.js';
import { toast, uid } from './ui.js';
import { easeAt, isPoseCh } from './scene-keyops.js';
export { isPoseCh };

export let C;  // app state and actions handed over by app.js (see sceneModule there)
export const FPS = 24;
// the same length as the H3 templates' "Seconds to frames (24 fps, 17k+5 grid)" node
export const framesFor = (sec) => { const n = Math.max(5, Math.round(sec * FPS)); return n + (((5 - n % 17) % 17) + 17) % 17; };
export const OBJ = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
// roll: degrees around the view axis, positive = the camera banks clockwise (the picture turns anticlockwise); a camera or key without it reads 0
export const CAM = ['px', 'py', 'pz', 'tx', 'ty', 'tz', 'fov', 'roll'];
// a three.js camera that has been aimed (lookAt), rolled
export const applyRoll = (cam, roll) => { if (roll) cam.rotateZ(-roll * Math.PI / 180); };
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
  // imported files (scene-import.js): scaled evenly, the layer also holds url, name, ext
  model: { label: 'Model', icon: '🗿', size: [1, 1, 1] },
  splat: { label: 'Splat', icon: '☁', size: [1, 1, 1] },
};
export const EVEN = new Set(['figure', 'photo', 'model', 'splat']);
// how a layer type that lives in its own module builds its three.js object: makers[type](layer) (scene-model.js: object)
export const makers = {};
// what's valued: a figure's values also hold its pose (j: joint rotations, m: parameters on top)
export const FIG = [...OBJ, 'j', 'm', 'pn'];  // pn: the pose's name, for a prompt
export const namesFor = (o) => (o.type === 'figure' ? FIG : OBJ);
// the gizmo's modes: [mode, icon, shortcut, name]
export const MODES = [['translate', '✥', 'w', 'Move'], ['rotate', '⟳', 'e', 'Rotate'], ['scale', '⤢', 'r', 'Scale']];
export const ROOM = 'room';  // R.sel for the room; null is the camera
// where the gizmo sits on an object (what it turns and scales around), in the object's own space
const PIVOTS = {
  figure: [['feet', 'Feet'], ['hips', 'Hips'], ['com', 'Centre of mass'], ['head', 'Head']],
  photo: [['origin', 'Lens'], ['center', 'Centre']],
  model: [['base', 'Base'], ['center', 'Centre']],
  splat: [['base', 'Base'], ['center', 'Centre']],
  other: [['base', 'Base'], ['center', 'Centre'], ['top', 'Top']],
};
export const pivotsFor = (o) => PIVOTS[o.type] || PIVOTS.other;
export const pivotOf = (o) => (pivotsFor(o).some(([k]) => k === o.pivot) || (o.type === 'figure' && FIGURE.JOINTS[o.pivot]) ? o.pivot
  : o.type === 'figure' ? 'hips' : o.type === 'photo' ? 'center' : 'base');

// ---- scene data ------------------------------------------------------------
export let SC;   // the scene (persisted per project)
export const R = { modeKey: null, free: false, f: 0, sel: null, joint: null, figTab: 'pose', poseCat: 'stand', mask: 'all', sym: false, speed: 1, inPlace: false, renders: {}, promptOff: new Set(), promptNames: false, mode: 'translate', playing: false, real: false, depth: false, autoKey: true, meshes: new Map(), room: [], applying: false, lastRender: null };

export const newRoom = () => ({ w: 8, d: 8, h: 2.8, walls: true, ceiling: true, hidden: false });
export function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, blur: 2, room: newRoom(),
    camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, roll: 0 }, chans: {}, ease: 'smooth' },
    objects: [newObject('person', { x: 0, z: 0 }, [])],
  };
}

export function newObject(type, at = {}, others = SC.objects) {
  const t = TYPES[type];
  const n = others.filter((o) => o.type === type).length + 1;
  const o = { id: uid(), type, name: `${t.label} ${n}`, ease: 'smooth', chans: {}, hidden: false,
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
  if (type === 'figure') { o.base.j = { ...FIGURE.preset('stand').j, ...FIGURE.handPose('relaxed', 'l'), ...FIGURE.handPose('relaxed', 'r') }; o.ground = true; }
  return o;
}

// scenes saved before rotation on all axes, hiding and a deletable room, and before keys were per channel
export function upgrade(sc) {
  if (sc.camera) migrateKeys(sc.camera, CAM);
  for (const o of sc.objects) {
    migrateKeys(o, namesFor(o));
    o.base = { rx: 0, rz: 0, ...o.base }; o.hidden = !!o.hidden; o.mute = !!o.mute;
    if (o.type === 'figure' && o.ground == null) o.ground = false;  // planted on the floor: older figures kept their own height
  }
  if (sc.camera) sc.camera.mute = !!sc.camera.mute;  // muted layers ignore their keys on screen (not in renders)
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
const pick = (o, names) => Object.fromEntries(names.map((n) => [n, o[n]]));

// ---- keys: one list per channel, like Blender's F-curves --------------------------------------------
// item.chans = { channel: [{ f, v, ease? }, ...] } (sorted by f, never empty). A channel is a number
// ('x', 'fov'...), a figure parameter ('m.lean'), one joint's turn ('j.lknee': [x, y, z, w]) or the pose's
// name ('pn'). A channel with no keys holds item.base's value; with keys it is held before the first and
// after the last, and eased in between (the key's own `ease`, else the item's).
export const IDENT = [0, 0, 0, 1];
export const chansOf = (item) => (item.chans ||= {});
export const hasKeys = (item) => !!item.chans && Object.values(item.chans).some((l) => l.length);
export const keyFrames = (item, only = () => true) => [...new Set(Object.entries(item.chans || {}).filter(([ch]) => only(ch)).flatMap(([, l]) => l.map((k) => k.f)))].sort((a, b) => a - b);
// how many frames hold a key, for a layer's hint
export const keyCount = (item) => keyFrames(item).length;
// a string that changes when the item's position keys do (what a figure's step phase is cached on)
export const pathSig = (o) => o.ease + ['x', 'z'].map((ch) => (o.chans?.[ch] || []).map((k) => `${k.f},${k.v},${k.ease || ''}`).join('|')).join('#');
export const keyAt = (item, f) => Object.values(item.chans || {}).some((l) => l.some((k) => k.f === f));
export const chanNames = (item, prefix) => Object.keys(item.chans || {}).filter((c) => c.startsWith(prefix));
// the next key frame after (dir 1) or before (-1) f, on any channel
export const nextKeyFrame = (item, f, dir = 1) => (dir > 0 ? keyFrames(item).find((x) => x > f) : keyFrames(item).findLast((x) => x < f));

// what a channel holds without keys
export function baseOf(item, ch) {
  if (ch.startsWith('j.')) return item.base.j?.[ch.slice(2)] ?? IDENT;
  if (ch.startsWith('m.')) return item.base.m?.[ch.slice(2)] || 0;
  return item.base[ch] ?? (ch === 'roll' ? 0 : undefined);   // (the camera's roll, missing in older scenes, is 0)
}
// a channel's value in a set of values { x, j: {...}, m: {...}, pn } (an unset joint is at rest, a parameter off)
export function valOf(vals, ch) {
  if (ch.startsWith('j.')) return vals.j?.[ch.slice(2)] ?? IDENT;
  if (ch.startsWith('m.')) return vals.m?.[ch.slice(2)] || 0;
  return vals[ch];
}
export function sameVal(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-5);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-4;
  return a === b;
}
const cloneV = (v) => (Array.isArray(v) ? [...v] : v);

// the channels a set of values touches (names: the item's value names; from: the values before, for what vanished)
export function keyChans(item, names, vals, from = null) {
  const out = [];
  for (const n of names) {
    if (n === 'j') for (const jn of new Set([...Object.keys(vals.j || {}), ...Object.keys(from?.j || {}), ...chanNames(item, 'j.').map((c) => c.slice(2))])) out.push(`j.${jn}`);
    else if (n === 'm') for (const p of new Set([...Object.keys(vals.m || {}), ...Object.keys(from?.m || {}), ...chanNames(item, 'm.').map((c) => c.slice(2))])) out.push(`m.${p}`);
    else if (vals[n] !== undefined) out.push(n);
  }
  return out;
}

// one channel at frame f
export function sampleChan(item, ch, f) {
  const list = item.chans?.[ch];
  if (!list || !list.length) return baseOf(item, ch);
  if (f <= list[0].f) return list[0].v;
  const last = list[list.length - 1];
  if (f >= last.f) return last.v;
  let lo = 0, hi = list.length - 1;   // list[lo].f <= f < list[hi].f
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].f <= f) lo = mid; else hi = mid; }
  const a = list[lo], b = list[hi], e = easeAt(a.ease || item.ease, (f - a.f) / (b.f - a.f));   // a key can set its own ease (smooth, linear, in, out, const)
  if (ch.startsWith('j.')) return FIGURE.slerpQ(a.v, b.v, e);
  if (ch === 'pn') return e < 0.5 ? a.v : b.v;
  return a.v + (b.v - a.v) * e;
}

// an item's values at frame f: each channel eased between its own keys
export function sample(item, names, f) {
  const out = {};
  for (const n of names) {
    if (n === 'j') {
      const jk = chanNames(item, 'j.');
      if (!jk.length) { out.j = item.base.j; continue; }
      const j = {};
      for (const jn of new Set([...Object.keys(item.base.j || {}), ...jk.map((c) => c.slice(2))])) j[jn] = sampleChan(item, `j.${jn}`, f);
      out.j = j;
    } else if (n === 'm') {
      const mk = chanNames(item, 'm.');
      if (!mk.length) { out.m = item.base.m; continue; }
      const m = {};
      for (const p of new Set([...Object.keys(item.base.m || {}), ...mk.map((c) => c.slice(2))])) { const v = sampleChan(item, `m.${p}`, f); if (v) m[p] = v; }
      out.m = m;
    } else out[n] = sampleChan(item, n, f);
  }
  return out;
}

// put (or change) one channel's key at frame f; the key's ease stays unless one is given ('' clears it)
export function setKey(item, ch, f, v, ease) {
  const list = (chansOf(item)[ch] ||= []);
  const k = list.find((x) => x.f === f);
  if (k) { k.v = cloneV(v); if (ease !== undefined) { if (ease) k.ease = ease; else delete k.ease; } return k; }
  const n = { f, v: cloneV(v), ...(ease ? { ease } : {}) };
  list.push(n); list.sort((a, b) => a.f - b.f);
  return n;
}
// make a channel's base value v (what it falls back to once it has no keys)
export function bakeBase(item, ch, v) {
  if (ch.startsWith('j.')) item.base.j = { ...item.base.j, [ch.slice(2)]: cloneV(v) };
  else if (ch.startsWith('m.')) item.base.m = { ...item.base.m, [ch.slice(2)]: v };
  else item.base[ch] = v;
}
// remove every key the test (frame, channel) says yes to, on every channel
export function dropKeys(item, test) {
  for (const [ch, list] of Object.entries(item.chans || {})) {
    const keep = list.filter((k) => !test(k.f, ch));
    if (keep.length) item.chans[ch] = keep; else delete item.chans[ch];
  }
}

// Whole-item keys [{ f, x, j, m, pn, ease? }...] (the old form, and what the move and motion makers
// build) as channel lists. A key without a value for a channel that others have takes the base's, as it did.
function wholeToChans(item, keys, names) {
  const out = {}, base = item.base;
  const add = (ch, get) => { out[ch] = keys.map((k) => ({ f: k.f, v: cloneV(get(k)), ...(k.ease ? { ease: k.ease } : {}) })).sort((a, b) => a.f - b.f); };
  for (const n of names) {
    if (n === 'j') {
      const of = (k) => (k.j !== undefined ? k.j : base.j) || {};
      for (const jn of new Set(keys.flatMap((k) => Object.keys(of(k))))) add(`j.${jn}`, (k) => of(k)[jn] ?? IDENT);
    } else if (n === 'm') {
      const of = (k) => (k.m !== undefined ? k.m : base.m) || {};
      for (const p of new Set(keys.flatMap((k) => Object.keys(of(k))))) add(`m.${p}`, (k) => of(k)[p] || 0);
    } else if (keys.some((k) => k[n] !== undefined)) add(n, (k) => k[n] ?? baseOf(item, n));
  }
  return out;
}
const constant = (list) => list.every((k) => sameVal(k.v, list[0].v));
// Scenes saved with whole-item keys (item.keys): each becomes a key on every channel it carried. A
// channel that never leaves the base's value is left out (it looked the same), so a figure's still
// joints don't fill the sheet; if that would leave nothing the item keeps them all, so it stays animated.
export function migrateKeys(item, names) {
  item.chans ||= {};
  if (!Array.isArray(item.keys)) { delete item.keys; return; }
  const keys = item.keys; delete item.keys;
  if (!keys.length) return;
  const all = wholeToChans(item, keys, names), keep = Object.entries(all).filter(([ch, l]) => !(constant(l) && sameVal(l[0].v, baseOf(item, ch))));
  Object.assign(item.chans, Object.fromEntries(keep.length ? keep : Object.entries(all)));
}
// keys from the move and motion makers, on top of what is there. A channel they leave where it was is
// not keyed (it would only add rows).
export function putKeys(item, keys, names) {
  for (const [ch, list] of Object.entries(wholeToChans(item, keys, names))) {
    const cur = item.chans?.[ch];
    if (!cur?.length && constant(list) && sameVal(list[0].v, baseOf(item, ch))) continue;
    for (const k of list) setKey(item, ch, k.f, k.v, k.ease || '');
  }
}

// With auto key off, a change to an animated item isn't saved: it's held here (by item, for the
// frame it was made on) until the playhead moves, and ◆ Key keeps it. ch: the channels it changed.
export const TEMP = new Map();
// Mute (item.mute, saved): a muted layer ignores its keys on screen. It stays where the user last put
// it (held here, not saved; first the look at the playhead when muted) and moving it writes no keys.
// Renders set R.real and use the real keys.
export const MUTED = new Map();
const allNames = (item) => (item === SC.camera ? CAM : namesFor(item));
const heldOf = (item) => { let v = MUTED.get(item); if (!v) MUTED.set(item, v = sample(item, allNames(item), R.f)); return v; };
export function setMute(item, on) {
  if (on) MUTED.set(item, { ...current(item, allNames(item), R.f) }); else MUTED.delete(item);
  item.mute = !!on;
}
// an item's values at frame f, with a held change on top
export function current(item, names, f = R.f) {
  if (item.mute && !R.real) return pick(heldOf(item), names);
  const t = hasKeys(item) ? TEMP.get(item) : null;
  return t && t.f === f ? pick(t.v, names) : sample(item, names, f);
}

// the channels whose value in vals differs from what the item has (from): [[channel, value]...]
function changedChans(item, names, vals, from) {
  return keyChans(item, names, vals, from).map((ch) => [ch, valOf(vals, ch)]).filter(([ch, v]) => v !== undefined && !sameVal(v, valOf(from, ch)));
}

// write values: when the item is animated, into the playhead's keys of the channels that changed (a
// channel that stays put gets no key); else into its base
export function write(item, names, vals) {
  if (item.mute && !R.real) { Object.assign(heldOf(item), vals); return; }
  if (!hasKeys(item)) { Object.assign(item.base, vals); return; }
  const from = sample(item, names, R.f);
  if (!R.autoKey) {
    const v = { ...current(item, names), ...vals };
    TEMP.set(item, { f: R.f, v, ch: new Set(changedChans(item, names, v, from).map(([ch]) => ch)) });
    return;
  }
  for (const [ch, v] of changedChans(item, names, { ...from, ...vals }, from)) setKey(item, ch, R.f, v);
}

// ◆ Key: the playhead's keys. Held changes (auto key off) key only the channels they changed; otherwise
// (or when vals are given) every channel of names. only: a set of channels to limit it to.
export function addKey(item, names, vals = null, only = null) {
  const held = TEMP.get(item);
  if (!vals) { vals = current(item, names); if (!only && held && held.f === R.f && held.ch.size) only = held.ch; }
  TEMP.delete(item);
  if (!hasKeys(item)) Object.assign(item.base, vals);
  for (const ch of keyChans(item, names, vals)) if ((!only || only.has(ch)) && valOf(vals, ch) !== undefined) setKey(item, ch, R.f, valOf(vals, ch));
}

export const selItem = () => SC.objects.find((o) => o.id === R.sel) || null;
// what ◆ Key acts on: the selected object, else the camera (the room isn't animated)
export const keyTarget = () => { const o = selItem(); return o ? [o, namesFor(o)] : R.sel === ROOM ? [null, null] : [SC.camera, CAM]; };
