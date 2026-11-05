// The table's Make panel (make-panel.js), its rules: which templates fit the selection, what of a frame goes into a run,
// and where a result lands, and the panel's own settings (one per frame, frame.make). Pure, so node --test
// tests/make_panel.test.mjs can check it.
import { OPS } from './edit-rules.js';
import { outputOf } from './table-model.js';
import { fieldKind, mapToFields } from './wire-rules.js';

// What the panel makes for: nothing (or a note) selected, or the first frame of the selection that isn't a note
export function makeTarget(frames = []) {
  const f = (frames || []).find((x) => x && x.kind !== 'note') || null;
  return { kind: f ? f.kind : 'none', frame: f };
}
// Every selected frame a run goes to (one run each, as the Edit pane's planRuns): the frames of the target's kind, in
// the order selected; none when nothing (or only notes) is selected
export function makeFrames(frames = []) {
  const { kind } = makeTarget(frames);
  return kind === 'none' ? [] : (frames || []).filter((x) => x && x.kind === kind);
}
// The words of the first selected note that has any: they are the run's prompt (null: no note with words)
export function noteText(frames = []) {
  const n = (frames || []).find((x) => x && x.kind === 'note' && String(x.text || '').trim());
  return n ? { note: n, text: String(n.text).trim() } : null;
}

// Templates by what they are for. Most of ComfyChair's own are named deck-<model>-<job>; a template of the user's own
// (not deck-) goes by what it saves (templates.py media_kind).
const T2X = /-(t2i|t2v)$/;
const IMAGE_JOB = /-(t2i|i2i|edit|control|detail|face-skin|skin-whole|identity)$|face-restore|upscale-image|clean-image|cutout-image|remove-lama/;
// (inpaint needs a painted area: the frame's own Inpaint does that. The VFX tab's jobs stay there for now.)
const VIDEO_JOB = /^deck-(ltx|h3)-|^deck-upscale-video/;
const VIDEO_VFX = /alpha|cleanplate|ltx-inpaint|ripple|tracks|sam3|charsheet|objectsheet/;
const SCENE_JOB = /3d-object|splat|trellis|autorig|mocap/;
const SOUND_JOB = /ace-music|ltx-t2a|mmaudio/;
const own = (t) => !/^deck-/.test(t.id);
// What the Edit pane's ops already run on a frame of a kind (edit-rules.js OPS tpl): not offered again by Make there.
// (Text to image or video stays Make's: it makes new content, which an empty frame from Quick start runs.)
export const OP_TEMPLATES = Object.freeze(Object.fromEntries(Object.entries(OPS).map(([k, list]) => [k, new Set(list.map((o) => o.tpl).filter(Boolean))])));

export function fitsKind(t, kind) {
  const id = t.id;
  if (OP_TEMPLATES[kind]?.has(id) && !T2X.test(id)) return false;
  switch (kind) {
    case 'none': return T2X.test(id) || (own(t) && t.media === 'image' && !t.fields?.some((f) => f.kind === 'image'));
    case 'image': return t.media === 'image' && (IMAGE_JOB.test(id) || own(t)) && !/inpaint/.test(id);
    case 'video': return t.media === 'video' && (own(t) || (VIDEO_JOB.test(id) && !VIDEO_VFX.test(id)));
    case 'scene': return SCENE_JOB.test(id);
    case 'sound': return SOUND_JOB.test(id) || (own(t) && t.media === 'audio');
    default: return false;
  }
}
export const templatesFor = (templates, kind) => (templates || []).filter((t) => fitsKind(t, kind));
// The templates a frame can be on: the kind's, and the one already on it (a node's tool template, hidden from the picker otherwise)
const MEDIA = { image: 'image', video: 'video', sound: 'audio' };
export function templatesForFrame(templates, kind, frame) {
  const list = templatesFor(templates, kind), id = frame?.make?.template;
  const own = id && !list.some((t) => t.id === id) ? (templates || []).find((t) => t.id === id && (!MEDIA[kind] || t.media === MEDIA[kind])) : null;
  return own ? [...list, own] : list;
}
export const familiesOf = (list) => [...new Set(list.map((t) => t.family || 'Other'))].sort();

// The template to show: the one kept for this frame (or kind) if it still fits, else the first that does
export function pickTemplate(list, ...wants) {
  for (const w of wants) if (w && list.some((t) => t.id === w)) return w;
  return list[0]?.id || null;
}

// The image field the frame's own picture goes into: the template's first picture (make.js ROLES.first)
export const frameImageField = (t) => (t?.fields || []).find((f) => f.kind === 'image') || null;

// The template's output size (a width + height pair on one node), or null
export function sizePair(t) {
  const fs = t?.fields || [];
  const w = fs.find((f) => f.kind === 'int' && f.input === 'width' && fs.some((x) => x.node === f.node && x.kind === 'int' && x.input === 'height'));
  return w ? [w, fs.find((x) => x.node === w.node && x.kind === 'int' && x.input === 'height')] : null;
}
export const frameOutput = outputOf;
// A template's length setting, in seconds (each is a "Length (seconds)"; null: it has none)
export const lengthField = (t) => (t?.fields || []).find((f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(f.label || '')) || null;
// How long a frame's run comes out (its Output tab's frame.len; before one is set, what its settings say). null: its template has no length.
export function frameLength(frame, t) {
  const f = lengthField(t);
  return f ? frame?.len ?? frame?.make?.overrides?.[f.key] ?? f.value ?? null : null;
}
// That length as the field takes it
export const lengthValue = (f, secs) => (f.kind === 'int' ? Math.max(1, Math.round(secs)) : secs);
// The settings a frame's Output tab owns, not its workflow: the size of an image or video frame, the length of a video or sound frame
export function outputOwns(t, kind, f) {
  const pair = kind === 'image' || kind === 'video' ? sizePair(t) : null;
  return !!pair?.some((x) => x.key === f.key) || ((kind === 'video' || kind === 'sound') && lengthField(t)?.key === f.key);
}
// A frame's size for a template: its output's sides at 1:1, to a multiple of 16, inside the template's limits
export function frameSize(pair, frame) {
  const o = frameOutput(frame);
  if (!pair || !o) return null;
  const side = (n, f) => Math.min(f.max ?? 4096, Math.max(f.min ?? 64, Math.round(n / 16) * 16));
  return { w: side(o.w, pair[0]), h: side(o.h, pair[1]) };
}

// Where a result lands, by what was selected
export const LANDS = { none: 'frame', image: 'layer', video: 'clip', scene: 'scene', sound: 'mix' };

// A video document with a run's clip at the end of its first video track (the clip's shape is video.js newItem's)
export function withClip(payload, { src, url = null, label, dur = 0, kind = 'video' }, id) {
  const p = { ...(payload || {}) };
  const tracks = p.tracks?.length ? p.tracks : [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }];
  const want = kind === 'audio' ? 'audio' : 'video';
  const track = (tracks.find((t) => t.kind === want) || tracks[0]).id;
  const items = [...(p.items || [])];
  const len = (it) => Math.max(0.1, (it.out ?? (it.dur || 3)) - (it.in || 0));
  const at = items.filter((i) => i.track === track).reduce((m, i) => Math.max(m, (i.at || 0) + len(i)), 0);
  items.push({ id, track, kind, src, url, label, thumb: null, dur, at, in: 0, out: kind === 'image' ? 3 : dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 });
  return { ...p, tracks, items };
}

// ---- the panel's own settings: a template's values, seed modes, picture sizes and crops, the prompt builder ----
// Saved on the frame as frame.make ({ v: 1, template, overrides: what differs from the template, seedMode, imageMp,
// imageCrop, sizeMode, loraFolder, builder }: a Generate tab's payload, so frames made before keep theirs).
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validFor = (f, v) => v !== undefined && !(f.kind === 'choice' && f.options?.length && !f.options.includes(v));   // (models get renamed or removed)
export function settingsFor(t, p = null) {
  const same = p?.template === t.id, ov = same ? p.overrides || {} : {};
  const values = {};
  for (const f of t.fields || []) values[f.key] = clone(validFor(f, ov[f.key]) ? ov[f.key] : f.value);
  const b = same && p.builder ? clone(p.builder) : null;
  const wired = same && p.wired && typeof p.wired === 'object' ? clone(p.wired) : {};
  return { tpl: t, values, wired, from: clone(same && p.from) || {}, layerSrc: clone(same && p.layerSrc) || {}, seedMode: clone(same && p.seedMode) || {}, imageMp: clone(same && p.imageMp) || {}, imageCrop: clone(same && p.imageCrop) || {},
    sizeMode: clone(same && p.sizeMode) || {}, loraFolder: clone(same && p.loraFolder) || {},
    pb: b ? { on: false, parts: {}, ...b, subjects: b.subjects?.length ? b.subjects : [{ text: '', pic: null }] } : null };
}
export function settingsPayload(st, extra = {}) {
  const t = st.tpl, overrides = {};
  for (const f of t.fields || []) if (f.key in st.values && !eq(st.values[f.key], f.value)) overrides[f.key] = clone(st.values[f.key]);
  return { ...extra, v: 1, template: t.id, presetId: null, overrides, wired: clone(st.wired || {}), from: clone(st.from || {}), layerSrc: clone(st.layerSrc || {}), seedMode: clone(st.seedMode), imageMp: clone(st.imageMp), imageCrop: clone(st.imageCrop),
    sizeMode: clone(st.sizeMode), loraFolder: clone(st.loraFolder), builder: st.pb ? clone(st.pb) : null };
}
// The values a run of these settings sends, as the Generate tab's runValues sends the shown ones: a random seed as -1, a
// fixed or increasing one as its number. (For a frame run without its fields on show: a chain run, chain-run.js.)
export function runValuesOf(st) {
  const values = {};
  for (const f of st?.tpl?.fields || []) {
    let v = clone(st.values?.[f.key]);
    if (f.kind === 'seed') v = (st.seedMode?.[f.key] || 'random') === 'random' ? -1 : Number(v);
    values[f.key] = v;
  }
  return values;
}
// After such a run is queued: an increasing seed moves on by the batch (generate.js afterQueued for settings not on show).
// Returns { [seed key]: the seed the last run used } for S.lastSeed.
export function seedsAfter(st, gens, batch = 1) {
  const last = gens?.[gens.length - 1], used = {};
  for (const f of st?.tpl?.fields || []) {
    if (f.kind !== 'seed') continue;
    if (last?.params && f.key in last.params) used[f.key] = last.params[f.key];
    if (st.seedMode?.[f.key] === 'increment') st.values[f.key] = Number(st.values[f.key]) + batch;
  }
  return used;
}
// A template change keeps the words: the prompt and negative prompt carry over to the new template's
export function carryWords(from, to) {
  const text = (st, neg) => (st.tpl.fields || []).find((x) => x.kind === 'text' && x.multiline && neg === /negative/i.test(`${x.input} ${x.group}`));
  for (const neg of [false, true]) {
    const a = text(from, neg), b = text(to, neg);
    if (a && b && String(from.values[a.key] || '').trim()) to.values[b.key] = from.values[a.key];
  }
  return to;
}

// Where an image frame's results go on its canvas: the canvas when it has a size, else the frame's own rectangle
export const canvasRect = (payload, frame) => (payload?.size ? { x: 0, y: 0, w: payload.size.w, h: payload.size.h } : { x: 0, y: 0, ...outputOf(frame) });

// ---- wires into the panel (wire-rules.js): which template field each plugged input fills ----
// frame.make.wired is { fieldKey: wireId | false } (re-pointed fields; false: the field keeps its own picked value).
// An image frame's own "this frame" field (the template's first picture) holds the frame's own picture, so a wire skips it,
// unless the frame has no picture of its own (ownPicture false: the plugged Image 1 takes the slot) or the slot was
// re-pointed to a wire on purpose. Returns wire-rules mapToFields' { map, use, spare }.
const ownSlot = (t, kind, wired, ownPicture) => {
  const own = kind === 'image' ? frameImageField(t) : null;
  return own && ownPicture !== false && !wired?.[own.key] ? own : null;   // (the slot kept for the frame's picture)
};
export function wireFields(t, kind, inputs, wired = {}, { ownPicture = true } = {}) {
  const own = ownSlot(t, kind, wired, ownPicture);
  return mapToFields(t?.fields || [], inputs || [], { skip: own ? [own.key] : [], overrides: wired || {} });
}
// Where a picture or clip slot gets its value: 'layers' (an image frame's own layers, all or one), 'wire' (a plugged input) or 'manual' (picked in
// the slot). st.from[key] holds a choice made ('layers' | 'manual'; a wire chosen is st.wired[key]). Unchosen: a plugged input if one maps to it,
// else an image frame's first picture slot is its layers, else manual. A video slot can't come from layers.
export function slotMode(t, kind, f, st, inputs, { ownPicture = true } = {}) {
  const canLayer = kind === 'image' && fieldKind(f) === 'image', pick = st?.from?.[f.key];
  if (pick === 'manual') return 'manual';
  if (pick === 'layers' && canLayer) return 'layers';
  if (wireFields(t, kind, inputs, st?.wired, { ownPicture }).use[f.key]) return 'wire';
  return canLayer && frameImageField(t)?.key === f.key ? 'layers' : 'manual';
}
// the fields a wire left to their own value on purpose (wired false), where a plugged input of their kind is waiting;
// and the frame's own picture slot, when the frame has one and an input is waiting that could take it instead
export function selfPicked(t, kind, inputs, wired = {}, { ownPicture = true } = {}) {
  const own = ownSlot(t, kind, wired, ownPicture);
  return (t?.fields || []).filter((f) => (f.key === own?.key || wired?.[f.key] === false) && (inputs || []).some((w) => w.kind === fieldKind(f)));
}
// whether a field from selfPicked is the frame's own picture slot (its row says "Use Image 1 here")
export const isOwnSlot = (t, kind, f, wired = {}, opts = {}) => !!f && ownSlot(t, kind, wired, opts.ownPicture)?.key === f.key;
// the inputs a field could be re-pointed to: its kind, not already filling another field
export function repointable(f, inputs, map) {
  const k = fieldKind(f), taken = new Set(Object.entries(map || {}).filter(([key]) => key !== f.key).map(([, w]) => w.id));
  return (inputs || []).filter((w) => w.kind === k && !taken.has(w.id));
}

// ---- what a wire carries: when a document is one plain source that can pass straight through ----
const near = (v, to, eps = 1e-6) => v == null || Math.abs(v - to) < eps;
const noMove = (it) => near(it.x, 0) && near(it.y, 0) && near(it.scale, 1) && near(it.rotation, 0) && near(it.opacity, 1)
  && !it.flipX && !it.flipY && !(it.anchor && (it.anchor.x || it.anchor.y)) && (it.fit == null || it.fit === 'fit');
const noFx = (it) => !it.adjust && !it.chans && !it.fill && !it.mask && !it.scene;
// An image document that is one plain picture: one layer, whole (no crop), unmoved, no mask, adjust or fill, nothing else
// on the canvas. Returns that layer's input name, else null.
export function plainPicture(payload) {
  const ls = payload?.layers;
  if (!Array.isArray(ls) || ls.length !== 1) return null;
  const l = ls[0];
  const c = l.crop || { x: 0, y: 0, w: 1, h: 1 };
  if (!l.name || l.hidden || l.mask || l.draft || l.maskOf || l.clip || l.canvas || l.fill || l.adjust || l.chans || l.group) return null;
  if (!(near(c.x, 0) && near(c.y, 0) && near(c.w, 1) && near(c.h, 1))) return null;
  if (!near(l.scale, 1) || !near(l.rotation, 0) || !near(l.opacity, 1) || l.flipX || l.flipY || (l.blend && l.blend !== 'normal')) return null;
  if (payload.items?.length || payload.anim) return null;
  return l.name;
}
// Whether plainPicture's one layer fills the canvas exactly (wh: its picture's natural [w, h]): at the canvas corner, its size
// the canvas size (to a pixel). Else the frame shows a cut of the file or the file sits in a margin, and the file alone
// isn't what the frame shows. No canvas size or no picture size: false (the frame's picture goes as a copy of what it shows).
export function plainFills(payload, wh) {
  const s = payload?.size, l = payload?.layers?.[0];
  if (!s?.w || !s?.h || !l || !Array.isArray(wh) || !(wh[0] > 0) || !(wh[1] > 0)) return false;
  const k = l.scale ?? 1;
  return Math.abs(l.x || 0) <= 0.5 && Math.abs(l.y || 0) <= 0.5 && Math.abs(wh[0] * k - s.w) <= 1 && Math.abs(wh[1] * k - s.h) <= 1;
}
const cleanTracks = (p, ids) => !(p.tracks || []).some((t) => ids.has(t.id) && (t.hidden || t.muted || t.solo));
const unity = (v) => v == null || near(v, 1);
const noFade = (it) => !(it.fadeIn > 0) && !(it.fadeOut > 0);
// A video document that is one plain clip: a single video item, at 0, default transform, no effects, fades or work area.
// Returns the item, else null.
export function plainVideo(payload) {
  const its = (payload?.items || []).filter((it) => it && (it.src || it.kind === 'scene'));
  if (its.length !== 1 || payload.range) return null;
  const it = its[0];
  if (it.kind !== 'video' || !it.src || !near(it.at, 0) || !noMove(it) || !noFx(it) || !noFade(it) || !unity(it.volume)) return null;
  return cleanTracks(payload, new Set([it.track])) ? it : null;
}
// A sound document that is one plain sound: a single audio item, at 0, level 1, centred, no fades or effects. Returns the item, else null.
export function plainSound(payload) {
  const its = (payload?.items || []).filter((it) => it && it.src);
  if (its.length !== 1 || payload.range) return null;
  const it = its[0];
  if (it.kind !== 'audio' || !near(it.at, 0) || !unity(it.volume) || !near(it.pan, 0) || it.chans || !noFade(it)) return null;
  const out = payload.out || {};
  if (out.normalize || !unity(out.gain)) return null;
  return cleanTracks(payload, new Set([it.track])) ? it : null;
}
// The source and cut of a plain item, as a run takes it: { generation, index } | { media }, and trim { start, len? }
export function itemSource(it) {
  const s = it.src || {};
  const src = s.generation != null ? { generation: s.generation, index: s.index || 0 } : s.media ? { media: s.media } : { ...s };
  const end = it.out ?? it.dur, start = it.in || 0;
  return { ...src, ...((start > 0 || end) && { trim: { start, ...(end ? { len: +(end - start).toFixed(4) } : {}) } }) };
}

// ---- the cached render of a whole edit: a key from the render body, so an unchanged edit is not rendered twice ----
// Stable text for a value: object keys in order, undefined left out (so the same body always gives the same text)
export function stableJson(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
// A 53-bit hash (cyrb53) of a body as 14 hex digits; project_id and the tab's name don't change what is drawn
export function renderKey(body) {
  const { project_id, tab, name, ...rest } = body || {};
  const s = stableJson(rest);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ---- the wire pictures a frame's queued runs have yet to read (frame.make.held: [{ name, gen }], saved with the table) ----
// A wire's picture made for a run (a copy of a frame's picture, a grab of a video) is the frame's until every run that reads
// it has finished; it is settled by the runs' status, never by what the slots show, so a page reload mid-run neither drops
// it early nor forgets it. Pure: the caller asks the runs' status and deletes the pictures.
const STILL_GOING = new Set(['queued', 'running', 'pending']);
// held plus each name for each of these runs (no repeats)
export function addHeld(held, names, gens) {
  const out = Array.isArray(held) ? held.filter((x) => x && typeof x.name === 'string') : [];
  for (const name of names || []) for (const g of gens || []) {
    const gen = g?.id ?? g;
    if (gen != null && !out.some((x) => x.name === name && x.gen === gen)) out.push({ name, gen });
  }
  return out;
}
// statusOf(gen): the run's status ('queued' | 'running' | 'done' | 'error' | 'interrupted' | 'gone' when it no longer exists),
// or null when it isn't known yet. Returns { held: the entries still waiting, drop: the names no waiting run reads any more }.
export function settleHeld(held, statusOf) {
  const list = Array.isArray(held) ? held.filter((x) => x && typeof x.name === 'string') : [];
  const waiting = list.filter((x) => { const s = statusOf(x.gen); return s == null || STILL_GOING.has(s); });
  const still = new Set(waiting.map((x) => x.name));
  return { held: waiting, drop: [...new Set(list.map((x) => x.name))].filter((n) => !still.has(n)) };
}

