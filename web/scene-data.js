import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import { toast, uid } from './ui.js';
import { isPoseCh, putKey, recordInto, sampleKeys } from './keys.js';
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
  // a skinned model driven by the posable figure's own joints (scene-rig.js)
  rigged: { label: 'Rigged model', icon: '🦴', size: [1, 1, 1] },
  // a generic skinned model: its own bones are keyed (b.<bone> channels) and posed bone by bone
  skinned: { label: 'Skinned model', icon: '🦴', size: [1, 1, 1] },
  splat: { label: 'Splat', icon: '☁', size: [1, 1, 1] },
};
export const EVEN = new Set(['figure', 'photo', 'model', 'splat', 'rigged', 'skinned']);
// how a layer type that lives in its own module builds its three.js object: makers[type](layer) (scene-model.js: object)
export const makers = {};
// what's valued: a figure's values also hold its pose (j: joint rotations, m: parameters on top)
export const FIG = [...OBJ, 'j', 'm', 'pn'];  // pn: the pose's name, for a prompt
// a posable layer (a figure, or a model rigged to one: scene-rig.js) holds FIG
export const isPosable = (o) => o?.type === 'figure' || o?.type === 'rigged';
// a generic skinned model (scene-skin.js) keys its own bones: b.<bone>, the same quaternions j.<joint> are
export const BONE = [...OBJ, 'b'];
export const isBoneKeyed = (o) => o?.type === 'skinned';
export const namesFor = (o) => (isPosable(o) ? FIG : isBoneKeyed(o) ? BONE : OBJ);
// a joint's turn (j.) and a bone's (b.) are quaternions: both slerp and both live in a bag by name
export const isQuatCh = (ch) => ch.startsWith('j.') || ch.startsWith('b.');
// the gizmo's modes: [mode, icon, shortcut, name]
export const MODES = [['translate', '✥', 'w', 'Move'], ['rotate', '⟳', 'e', 'Rotate'], ['scale', '⤢', 'r', 'Scale']];
export const ROOM = 'room';  // R.sel for the room; null is the camera
// where the gizmo sits on an object (what it turns and scales around), in the object's own space
const PIVOTS = {
  figure: [['feet', 'Feet'], ['hips', 'Hips'], ['com', 'Centre of mass'], ['head', 'Head']],
  rigged: [['feet', 'Feet'], ['hips', 'Hips'], ['com', 'Centre of mass'], ['head', 'Head']],
  photo: [['origin', 'Lens'], ['center', 'Centre']],
  model: [['base', 'Base'], ['center', 'Centre']],
  splat: [['base', 'Base'], ['center', 'Centre']],
  other: [['base', 'Base'], ['center', 'Centre'], ['top', 'Top']],
};
export const pivotsFor = (o) => PIVOTS[o.type] || PIVOTS.other;
export const pivotOf = (o) => (pivotsFor(o).some(([k]) => k === o.pivot) || (isPosable(o) && FIGURE.JOINTS[o.pivot]) ? o.pivot
  : isPosable(o) ? 'hips' : o.type === 'photo' ? 'center' : 'base');

// ---- scene data ------------------------------------------------------------
export let SC;   // the scene (persisted per project)
export const R = { offEdit: null, modeKey: null, free: false, f: 0, sel: null, joint: null, figTab: 'pose', poseCat: 'stand', mask: 'all', sym: false, speed: 1, inPlace: false, renders: {}, promptOff: new Set(), promptNames: false, shotOff: new Set(), shotFmt: 'h3', viewCut: true, mode: 'translate', playing: false, real: false, depth: false, autoKey: true, record: false, meshes: new Map(), room: [], applying: false, lastRender: null };

export const newRoom = () => ({ w: 8, d: 8, h: 2.8, walls: true, ceiling: true, hidden: false });
export function defaultScene() {
  return {
    v: 1, width: 768, height: 448, seconds: 6, lenMode: 'match', blur: 2, room: newRoom(),
    camera: { id: 'cam0', name: 'Camera', base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, roll: 0 }, chans: {}, ease: 'smooth' }, cams: [],
    cuts: [], shotText: {}, tcStart: '01:00:00:00', renderShots: 'take',
    objects: [newObject('person', { x: 0, z: 0 }, [])],
  };
}

export function newObject(type, at = {}, others = SC.objects) {
  const t = TYPES[type];
  const n = others.filter((o) => o.type === type).length + 1;
  const o = { id: uid(), type, name: `${t.label} ${n}`, ease: 'smooth', chans: {}, hidden: false,
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: t.size[0], sy: t.size[1], sz: t.size[2], ...at } };
  if (isPosable(o)) { o.base.j = { ...FIGURE.preset('stand').j, ...FIGURE.handPose('relaxed', 'l'), ...FIGURE.handPose('relaxed', 'r') }; o.ground = true; }
  return o;
}

// scenes saved before rotation on all axes, hiding and a deletable room, and before keys were per channel
export function upgrade(sc) {
  if (sc.camera) migrateKeys(sc.camera, CAM);
  // more cameras (2026-10-28): SC.camera is the active one (what the view, renders and compositions look
  // through), SC.cams the others; an older scene's one camera is the active one
  sc.cams = Array.isArray(sc.cams) ? sc.cams : [];
  if (sc.camera) { sc.camera.id ||= 'cam0'; sc.camera.name ||= 'Camera'; }
  for (const c of sc.cams) { migrateKeys(c, CAM); c.id ||= uid(); c.name ||= 'Camera'; c.mute = !!c.mute; c.ease ||= 'smooth'; }
  for (const o of sc.objects) {
    migrateKeys(o, namesFor(o));
    o.base = { rx: 0, rz: 0, ...o.base }; o.hidden = !!o.hidden; o.mute = !!o.mute;
    if (isPosable(o) && o.ground == null) o.ground = false;  // planted on the floor: older figures kept their own height
  }
  if (sc.camera) sc.camera.mute = !!sc.camera.mute;  // muted layers ignore their keys on screen (not in renders)
  if (sc.room) sc.room = { ceiling: false, hidden: false, ...sc.room };
  // cuts (2026-10-29): which camera is live from which frame. Missing on an older scene: the active camera throughout.
  sc.cuts = Array.isArray(sc.cuts) ? sc.cuts.filter((c) => c && Number.isFinite(+c.f) && c.cam).map((c) => ({ id: c.id || uid(), f: Math.round(+c.f), cam: String(c.cam), ease: 'const' })) : [];
  sc.cuts.sort((a, b) => a.f - b.f);
  if (!sc.shotText || typeof sc.shotText !== 'object' || Array.isArray(sc.shotText)) sc.shotText = {};
  if (typeof sc.tcStart !== 'string' || !/^\d+:\d+:\d+:\d+$/.test(sc.tcStart)) sc.tcStart = '01:00:00:00';
  if (sc.renderShots !== 'each') sc.renderShots = 'take';
  return sc;
}

// every camera, the active one first
export const camsOf = (sc = SC) => [sc.camera, ...(sc.cams || [])].filter(Boolean);
// a new camera where the active one is now (unkeyed); it is not added anywhere yet
export function newCamera(name = `Camera ${camsOf().length + 1}`, from = SC.camera) {
  return { id: uid(), name, base: { ...current(from, CAM) }, chans: {}, ease: 'smooth', mute: false };
}
export const camById = (id, sc = SC) => camsOf(sc).find((c) => c.id === id) || null;

// the camera the picture uses at frame f. No cuts, or a cut whose camera was deleted: the active camera.
// Before the first cut, that cut's camera (it holds, the way a key holds before its first frame).
export function liveCam(f, sc = SC) {
  const cuts = [...(sc?.cuts || [])].filter((c) => c && camById(c.cam, sc)).sort((a, b) => a.f - b.f);
  if (!cuts.length || !sc?.camera) return sc?.camera || null;
  let pick = cuts[0];
  for (const c of cuts) if (c.f <= f) pick = c;
  return camById(pick.cam, sc) || sc.camera;
}

// one entry per run of the same camera, clipped to the clip: { i, f0, f1, cam, id } (f0 and f1 inclusive)
export function shots(sc = SC) {
  const n = Math.max(1, framesFor(sc?.seconds || 0));
  const last = n - 1;
  if (!sc?.camera) return [];
  const cuts = [...(sc.cuts || [])].filter((c) => c && camById(c.cam, sc)).sort((a, b) => a.f - b.f);
  const bounds = [0];
  for (const c of cuts) {
    if (c.f <= 0 || c.f > last) continue;
    if (liveCam(c.f - 1, sc).id !== liveCam(c.f, sc).id) bounds.push(c.f);
  }
  const out = [];
  for (let i = 0; i < bounds.length; i++) {
    const f0 = bounds[i], f1 = i + 1 < bounds.length ? bounds[i + 1] - 1 : last;
    const cam = liveCam(f0, sc);
    const cut = [...cuts].reverse().find((c) => c.f <= f0) || null;
    out.push({ i: out.length + 1, f0, f1, cam, id: cut?.id || null });
  }
  return out;
}

// cut to cam at frame f (the playhead when f is left out). A cut already on that frame is replaced.
export function cutTo(cam, f = R.f) {
  const cuts = (SC.cuts ||= []);
  const at = Math.max(0, Math.min(frames() - 1, Math.round(f)));
  const i = cuts.findIndex((c) => c.f === at);
  const row = { id: i >= 0 ? cuts[i].id : uid(), f: at, cam: cam.id, ease: 'const' };
  if (i >= 0) cuts[i] = row; else cuts.push(row);
  cuts.sort((a, b) => a.f - b.f);
  return row;
}
// drop cuts that point at a camera, or that sit at or past frame n (a shorter clip)
export function dropCuts(test) {
  if (!SC.cuts) return;
  SC.cuts = SC.cuts.filter((c) => !test(c));
}
export function trimCuts(n) { dropCuts((c) => c.f >= n); }
// the same stretch as keys.js stretchAll, for the shot row
export function stretchCuts(from, to) {
  if (!SC.cuts?.length) return;
  const k = to / Math.max(1, from);
  for (const c of SC.cuts) c.f = Math.max(0, Math.min(Math.max(0, to - 1), Math.round(c.f * k)));
  const by = new Map();
  for (const c of SC.cuts) by.set(c.f, c);
  SC.cuts = [...by.values()].sort((a, b) => a.f - b.f);
}

// the shot row as a keys.js track (kind 'cut'): the keys are the cuts, ease stays constant, never blended
export function cutTrack(sc = SC) {
  if (!Array.isArray(sc.cuts)) sc.cuts = [];
  return {
    item: sc, ch: 'cut', id: 'cuts', kind: 'cut',
    get keys() { return sc.cuts; },
    set keys(v) {
      const seen = new Set();
      for (const k of v) {
        k.ease = 'const';
        if (!k.id || seen.has(k.id)) k.id = uid();
        seen.add(k.id);
      }
      sc.cuts = v;
    },
  };
}

// make one of SC.cams the active camera (the one it replaces joins the others, in its place)
export function setActiveCam(cam) {
  const i = (SC.cams ||= []).indexOf(cam);
  if (i < 0) return false;
  SC.cams.splice(i, 1, SC.camera); SC.camera = cam;
  TEMP.delete(cam);
  return true;
}

export function setC(helpers) { C = helpers; }
export function setSC(sc) { SC = sc; }

// How an edit reaches the tab that saves it and the toolbar that shows undo (scene.js sets these), so
// this file needs nothing from the rest.
export const hooks = { ready: async () => {}, persist() {}, history() {}, tab: () => null, held() {} };
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
export const pathSig = (o) => o.ease + ['x', 'z'].map((ch) => (o.chans?.[ch] || []).map((k) => `${k.f},${k.v},${k.ease || ''},${k.ti || ''},${k.to || ''}`).join('|')).join('#');
export const keyAt = (item, f) => Object.values(item.chans || {}).some((l) => l.some((k) => k.f === f));
export const chanNames = (item, prefix) => Object.keys(item.chans || {}).filter((c) => c.startsWith(prefix));
// the next key frame after (dir 1) or before (-1) f, on any channel
export const nextKeyFrame = (item, f, dir = 1) => (dir > 0 ? keyFrames(item).find((x) => x > f) : keyFrames(item).findLast((x) => x < f));

// what a channel holds without keys
export function baseOf(item, ch) {
  if (isQuatCh(ch)) return (item.base[ch[0]] || {})[ch.slice(2)] ?? IDENT;
  if (ch.startsWith('m.')) return item.base.m?.[ch.slice(2)] || 0;
  return item.base[ch] ?? (ch === 'roll' ? 0 : undefined);   // (the camera's roll, missing in older scenes, is 0)
}
// a channel's value in a set of values { x, j: {...}, m: {...}, pn } (an unset joint is at rest, a parameter off)
export function valOf(vals, ch) {
  if (isQuatCh(ch)) return (vals[ch[0]] || {})[ch.slice(2)] ?? IDENT;
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
    if (n === 'j' || n === 'b') for (const jn of new Set([...Object.keys(vals[n] || {}), ...Object.keys(from?.[n] || {}), ...chanNames(item, `${n}.`).map((c) => c.slice(2))])) out.push(`${n}.${jn}`);
    else if (n === 'm') for (const p of new Set([...Object.keys(vals.m || {}), ...Object.keys(from?.m || {}), ...chanNames(item, 'm.').map((c) => c.slice(2))])) out.push(`m.${p}`);
    else if (vals[n] !== undefined) out.push(n);
  }
  return out;
}

// one channel at frame f
// (keys.js sampleKeys: a joint's turn slerps, the pose's name steps half way, the rest blend as numbers)
const stepAt = (a, b, e) => (e < 0.5 ? a : b);
export function sampleChan(item, ch, f) {
  const list = item.chans?.[ch];
  if (!list || !list.length) return baseOf(item, ch);
  return sampleKeys(list, f, { ease: item.ease, lerp: isQuatCh(ch) ? FIGURE.slerpQ : ch === 'pn' ? stepAt : undefined });
}

// an item's values at frame f: each channel eased between its own keys
export function sample(item, names, f) {
  const out = {};
  for (const n of names) {
    if (n === 'j' || n === 'b') {
      const jk = chanNames(item, `${n}.`);
      if (!jk.length) { out[n] = item.base[n]; continue; }
      const bag = {};
      for (const jn of new Set([...Object.keys(item.base[n] || {}), ...jk.map((c) => c.slice(2))])) bag[jn] = sampleChan(item, `${n}.${jn}`, f);
      out[n] = bag;
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
export const setKey = (item, ch, f, v, ease) => putKey(chansOf(item), ch, f, v, ease);
// make a channel's base value v (what it falls back to once it has no keys)
export function bakeBase(item, ch, v) {
  if (isQuatCh(ch)) item.base[ch[0]] = { ...item.base[ch[0]], [ch.slice(2)]: cloneV(v) };
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
// an item's values at frame f, with a held change and its offset layer on top (what shows)
export function current(item, names, f = R.f) {
  if (item.mute && !R.real) return pick(heldOf(item), names);
  return applyOffset(item, rawCurrent(item, names, f), f);
}
// the same without the offset layer: what the keys hold
export function rawCurrent(item, names, f = R.f) {
  if (item.mute && !R.real) return pick(heldOf(item), names);
  const t = hasKeys(item) ? TEMP.get(item) : null;
  // (a change held while it plays keeps only its own channels on top: the rest plays on)
  const out = t?.play ? overlay(sample(item, names, f), t.hv, names) : t && t.f === f ? pick(t.v, names) : sample(item, names, f);
  const hd = !R.real && HOLD.items.get(item);
  return hd ? overlay(out, hd.ch, names) : out;
}

// ---- edits while it plays ----------------------------------------------------------------------------
// What shows while playing, and what a hold does when it ends (per device; scene.js loads them).
// back: the playhead goes back to where the hold began, so the change shows at once.
export const WP = { gizmo: true, dots: true, frustum: true, grid: true, follow: false, back: true };
// Each frame of playback would put every item back on its keys, so while the user holds a gizmo, a slider
// or the orbit (a "source": holdStart/holdEnd), what they write to an animated item is held here per
// channel and shown over its keys (the item's other channels keep playing). When the last source lets go,
// the held channels are keyed (at the playhead, or where the hold began with WP.back), or, with Record,
// every few frames over the span that was held; with Auto key off they are only held (TEMP) until ◆ Key.
// f0: the frame the hold began on. rec: [{ f, v: Map }] one per frame shown, with Record on.
export const HOLD = { src: new Set(), items: new Map(), f0: null };
export const REC_EVERY = 3;   // a recorded key every 3 frames (8 a second)
function overlay(out, ch, names) {
  const o = { ...out };
  for (const [c, v] of ch) {
    if (isQuatCh(c)) { const bag = c[0]; if (names.includes(bag)) { if (o[bag] === out[bag]) o[bag] = { ...out[bag] }; o[bag][c.slice(2)] = v; } }
    else if (c.startsWith('m.')) { if (names.includes('m')) { if (o.m === out.m) o.m = { ...out.m }; if (v) o.m[c.slice(2)] = v; else delete o.m[c.slice(2)]; } }
    else if (names.includes(c)) o[c] = v;
  }
  return o;
}
const holding = (item) => R.playing && HOLD.src.size > 0 && (hasKeys(item) || R.record);
function holdWrite(item, names, vals) {
  let hd = HOLD.items.get(item);
  if (!hd) HOLD.items.set(item, hd = { ch: new Map(), rec: [] });
  const from = sample(item, names, R.f);
  for (const [ch, v] of changedChans(item, names, { ...from, ...vals }, from)) hd.ch.set(ch, cloneV(v));
}
// a gesture that edits begins (gizmo, orbit, hand, panel); while it plays, its writes are held
export function holdStart(src) {
  if (!HOLD.src.size) HOLD.f0 = R.playing ? R.f : null;
  HOLD.src.add(src);
}
// it ends: once nothing is held any more, what was held lands (returns the frame to go back to, or null)
export function holdEnd(src) {
  if (!HOLD.src.delete(src) || HOLD.src.size) return null;
  return commitHolds();
}
// one frame of playback shown: with Record on, what is held now is a sample at that frame
export function recordFrame(f) {
  if (!R.record) return;
  for (const hd of HOLD.items.values()) if (hd.ch.size) hd.rec.push({ f, v: new Map([...hd.ch].map(([c, v]) => [c, cloneV(v)])) });
}
export function commitHolds() {
  const f0 = HOLD.f0, back = WP.back && f0 != null;
  HOLD.src.clear(); HOLD.f0 = null;
  if (!HOLD.items.size) return null;
  const at = back ? Math.min(f0, frames() - 1) : R.f;
  for (const [item, hd] of HOLD.items) {
    if (!hd.ch.size) continue;
    if (R.record) {
      for (const [ch, v] of hd.ch) {
        const samples = [...hd.rec.filter((s) => s.v.has(ch)).map((s) => ({ f: s.f, v: s.v.get(ch) })), { f: R.f, v }];
        if (!item.chans?.[ch]?.length) bakeBase(item, ch, v);
        chansOf(item)[ch] = recordInto(item.chans[ch], samples, REC_EVERY);
      }
    } else if (R.autoKey || !hasKeys(item)) {
      for (const [ch, v] of hd.ch) setKey(item, ch, at, v);
    } else {
      holdTemp(item, at, new Map(hd.ch));
    }
  }
  HOLD.items.clear();
  save(); hooks.held();
  return back ? at : null;
}
// with Auto key off, a change to an animated item is held until ◆ Key: while it plays, on every frame (hv:
// just the channels it changed); once stopped, at the frame it stops on (settleTemp)
function holdTemp(item, f, hv) {
  const t = TEMP.get(item);
  if (t?.play) for (const [c, v] of t.hv) if (!hv.has(c)) hv.set(c, v);
  TEMP.set(item, { f, play: R.playing, hv, ch: new Set(hv.keys()), v: overlay(sample(item, allNames(item), f), hv, allNames(item)) });
}
export function settleTemp() {
  for (const [item, t] of TEMP) if (t.play) { t.play = false; t.f = R.f; t.v = overlay(sample(item, allNames(item), R.f), t.hv, allNames(item)); }
}
// a new scene (undo, a tab): nothing held carries over
export function dropHolds() { HOLD.items.clear(); HOLD.src.clear(); HOLD.f0 = null; }

// the channels whose value in vals differs from what the item has (from): [[channel, value]...]
function changedChans(item, names, vals, from) {
  return keyChans(item, names, vals, from).map((ch) => [ch, valOf(vals, ch)]).filter(([ch, v]) => v !== undefined && !sameVal(v, valOf(from, ch)));
}

// write values: when the item is animated, into the playhead's keys of the channels that changed (a
// channel that stays put gets no key); else into its base
export function write(item, names, vals) {
  if (item.mute && !R.real) { Object.assign(heldOf(item), vals); return; }
  if (offOn(item)) {   // shown with its offset: the gizmo moves the offset, or the keys under it
    if (R.offEdit === item.id) { writeOffset(item, names, vals); return; }
    vals = removeOffset(item, vals);
  }
  if (holding(item)) { holdWrite(item, names, vals); return; }
  if (!hasKeys(item)) { Object.assign(item.base, vals); return; }
  const from = sample(item, names, R.f);
  if (!R.autoKey) {
    const v = { ...rawCurrent(item, names), ...vals };
    if (R.playing) return holdTemp(item, R.f, new Map(changedChans(item, names, v, from).map(([ch, x]) => [ch, cloneV(x)])));
    TEMP.set(item, { f: R.f, v, ch: new Set(changedChans(item, names, v, from).map(([ch]) => ch)) });
    return;
  }
  for (const [ch, v] of changedChans(item, names, { ...from, ...vals }, from)) setKey(item, ch, R.f, v);
}

// ◆ Key: the playhead's keys. Held changes (auto key off) key only the channels they changed; otherwise
// (or when vals are given) every channel of names. only: a set of channels to limit it to.
export function addKey(item, names, vals = null, only = null) {
  const held = TEMP.get(item);
  if (!vals) { vals = rawCurrent(item, names); if (!only && held && (held.f === R.f || held.play) && held.ch.size) only = held.ch; }
  TEMP.delete(item);
  if (!hasKeys(item)) Object.assign(item.base, vals);
  for (const ch of keyChans(item, names, vals)) if ((!only || only.has(ch)) && valOf(vals, ch) !== undefined) setKey(item, ch, R.f, valOf(vals, ch));
}

export const selItem = () => SC.objects.find((o) => o.id === R.sel) || null;
// what ◆ Key acts on: the selected object, else the camera (the room isn't animated)
export const keyTarget = () => { const o = selItem(); return o ? [o, namesFor(o)] : R.sel === ROOM ? [null, null] : [SC.camera, CAM]; };

// ---- the offset layer (item.off): a move, slid, turned and scaled as a whole without touching its keys ----
// { on, pv: [x, y, z] (what it turns and scales around: where the figure stood when it was made), ease,
//   base: { x, y, z, rx, ry, rz, s, j: { joint: [x, y, z, w] } }, chans: like an item's, sparse }.
// Shown = pv + turn × (keys' place − pv) × s + (x, y, z); the turn goes on before the keys' own, the size
// multiplies; a joint's offset turns it in its parent's frame (off × key). Saved with the item, undoable.
export const OFF = ['x', 'y', 'z', 'rx', 'ry', 'rz', 's'];
export const OFFN = [...OFF, 'j'];
export function newOffset(item, f = R.f) {
  const v = sample(item, OBJ, f);
  return { on: true, pv: [v.x, v.y, v.z], ease: 'smooth', base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, j: {} }, chans: {} };
}
export const offOn = (item) => !!item.off && item.off.on !== false;
export const offAt = (item, f = R.f) => sample(item.off, OFFN, f);
const d2r = THREE.MathUtils.degToRad, r2d = THREE.MathUtils.radToDeg;
const qOf = (v) => new THREE.Quaternion().setFromEuler(new THREE.Euler(d2r(v.rx || 0), d2r(v.ry || 0), d2r(v.rz || 0)));
const Q4 = (a) => new THREE.Quaternion(...(a || IDENT));
const flat = (v) => Math.abs(v.rx || 0) < 1e-6 && Math.abs(v.rz || 0) < 1e-6;
// a turn as degrees near ref (the keys' own numbers), so a key at 170° doesn't come back as 180 / 10 / 180
function nearEuler(q, ref) {
  const e = new THREE.Euler().setFromQuaternion(q);
  const unwrap = (a, r) => a + 360 * Math.round((r - a) / 360);
  const opts = [[r2d(e.x), r2d(e.y), r2d(e.z)], [r2d(e.x) + 180, 180 - r2d(e.y), r2d(e.z) + 180]]
    .map(([x, y, z]) => [unwrap(x, ref.rx || 0), unwrap(y, ref.ry || 0), unwrap(z, ref.rz || 0)]);
  const dist = (a) => Math.abs(a[0] - (ref.rx || 0)) + Math.abs(a[1] - (ref.ry || 0)) + Math.abs(a[2] - (ref.rz || 0));
  const [rx, ry, rz] = dist(opts[0]) <= dist(opts[1]) ? opts[0] : opts[1];
  return { rx, ry, rz };
}
// the place and turn: keys' values v through offset o (back = the other way, shown to keys)
function moveRoot(item, v, o, back) {
  const pv = new THREE.Vector3(...item.off.pv), t = new THREE.Vector3(o.x, o.y, o.z), s = Math.max(1e-4, o.s ?? 1);
  const P = new THREE.Vector3(v.x, v.y, v.z), out = {};
  const yaw = flat(o) && flat(v);   // (the usual case: a plain turn on Y adds, exactly)
  if (!back) {
    P.sub(pv).multiplyScalar(s).applyQuaternion(qOf(o)).add(pv).add(t);
    Object.assign(out, yaw ? { rx: v.rx, ry: v.ry + o.ry, rz: v.rz } : nearEuler(qOf(o).multiply(qOf(v)), v));
  } else {
    P.sub(t).sub(pv).applyQuaternion(qOf(o).invert()).divideScalar(s).add(pv);
    Object.assign(out, yaw ? { rx: v.rx, ry: v.ry - o.ry, rz: v.rz } : nearEuler(qOf(o).invert().multiply(qOf(v)), v));
  }
  out.x = P.x; out.y = P.y; out.z = P.z;
  for (const k of ['sx', 'sy', 'sz']) if (v[k] !== undefined) out[k] = back ? v[k] / s : v[k] * s;
  return out;
}
const hasRoot = (v) => OBJ.some((k) => v[k] !== undefined);
export function applyOffset(item, vals, f = R.f) {
  if (!offOn(item)) return vals;
  const o = offAt(item, f), out = { ...vals };
  if (vals.x !== undefined && vals.ry !== undefined) Object.assign(out, moveRoot(item, vals, o, false));
  if (vals.j && Object.keys(o.j || {}).length) {
    out.j = { ...vals.j };
    for (const [n, q] of Object.entries(o.j)) out.j[n] = Q4(q).multiply(Q4(vals.j[n])).toArray();
  }
  return out;
}
// shown values (some of them) back to what the keys would hold
function removeOffset(item, vals) {
  const o = offAt(item), out = { ...vals };
  if (hasRoot(vals)) Object.assign(out, moveRoot(item, { ...current(item, OBJ), ...vals }, o, true));
  if (vals.j) {
    out.j = { ...vals.j };
    for (const [n, q] of Object.entries(o.j || {})) if (vals.j[n]) out.j[n] = Q4(q).invert().multiply(Q4(vals.j[n])).toArray();
  }
  return out;
}
// the gizmo (or a number) on the offset: the offset that puts the item where it is asked to be at the playhead.
// An animated offset gets a key there; a still one changes.
export function writeOffset(item, names, vals) {
  const O = item.off, o = offAt(item), next = {};
  if (hasRoot(vals)) {
    const raw = rawCurrent(item, OBJ), want = { ...current(item, OBJ), ...vals };
    const s = Math.max(1e-4, want.sy / Math.max(1e-4, raw.sy));
    const qo = flat(raw) && flat(want) ? qOf({ ry: want.ry - raw.ry }) : qOf(want).multiply(qOf(raw).invert());
    const e = flat(raw) && flat(want) ? { rx: 0, ry: want.ry - raw.ry, rz: 0 } : nearEuler(qo, o);
    const pv = new THREE.Vector3(...O.pv);
    const t = new THREE.Vector3(want.x, want.y, want.z).sub(pv).sub(new THREE.Vector3(raw.x, raw.y, raw.z).sub(pv).multiplyScalar(s).applyQuaternion(qo));
    Object.assign(next, { x: t.x, y: t.y, z: t.z, ...e, s });
  }
  if (vals.j) {
    const raw = rawCurrent(item, ['j']).j || {}, shown = current(item, ['j']).j || {}, j = { ...(o.j || {}) };
    for (const [n, q] of Object.entries(vals.j)) if (!sameVal(q, shown[n] ?? IDENT)) j[n] = Q4(q).multiply(Q4(raw[n]).invert()).toArray();
    next.j = j;
  }
  setOffset(item, next);
}
// offset values (some of them) at the playhead: keyed when the offset is animated, else its base
export function setOffset(item, vals) {
  const O = item.off;
  if (!hasKeys(O)) { const j = vals.j; Object.assign(O.base, vals); if (j) O.base.j = { ...j }; return; }
  const from = offAt(item);
  for (const [ch, v] of changedChans(O, OFFN, { ...from, ...vals }, from)) setKey(O, ch, R.f, v);
}
// ◆ on the offset: every one of its values at the playhead
export function keyOffset(item) {
  const O = item.off, v = offAt(item);
  for (const ch of keyChans(O, OFFN, v)) setKey(O, ch, R.f, valOf(v, ch));
}
// Bake: the offset goes into the keys (each frame that has a key, on the item or the offset), then away.
// A part with no keys on either side changes the base instead.
export function bakeOffset(item) {
  const O = item.off;
  if (!O) return;
  const names = namesFor(item), joints = [...new Set([...Object.keys(O.base.j || {}), ...chanNames(O, 'j.').map((c) => c.slice(2))])];
  const rootKeyed = OBJ.some((ch) => item.chans?.[ch]?.length) || OFF.some((ch) => O.chans?.[ch]?.length);
  const fs = [...new Set([...keyFrames(item), ...keyFrames(O)])].sort((a, b) => a - b);
  const at = (f) => applyOffset(item, sample(item, names, f), f);
  const shown = fs.map((f) => [f, at(f)]), still = at(fs[0] ?? 0);
  if (rootKeyed) { for (const [f, v] of shown) for (const ch of OBJ) setKey(item, ch, f, v[ch]); }
  else for (const ch of OBJ) item.base[ch] = still[ch];
  for (const n of joints) {
    if (item.chans?.[`j.${n}`]?.length || O.chans?.[`j.${n}`]?.length) for (const [f, v] of shown) setKey(item, `j.${n}`, f, v.j[n]);
    else bakeBase(item, `j.${n}`, still.j?.[n] ?? IDENT);
  }
  delete item.off;
  if (R.offEdit === item.id) R.offEdit = null;
}
