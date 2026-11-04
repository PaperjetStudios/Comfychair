// The table's Make panel (make-panel.js), its rules: which templates fit the selection, what of a frame goes into a run,
// and where a result lands, and the panel's own settings (one per frame, frame.make). Pure, so node --test
// tests/make_panel.test.mjs can check it.
import { OPS } from './edit-rules.js';

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
// A frame's size for a template: its sides at 1:1, to a multiple of 16, inside the template's limits
export function frameSize(pair, frame) {
  if (!pair || !frame?.w || !frame?.h) return null;
  const side = (n, f) => Math.min(f.max ?? 4096, Math.max(f.min ?? 64, Math.round(n / 16) * 16));
  return { w: side(frame.w, pair[0]), h: side(frame.h, pair[1]) };
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
  return { tpl: t, values, seedMode: clone(same && p.seedMode) || {}, imageMp: clone(same && p.imageMp) || {}, imageCrop: clone(same && p.imageCrop) || {},
    sizeMode: clone(same && p.sizeMode) || {}, loraFolder: clone(same && p.loraFolder) || {},
    pb: b ? { on: false, parts: {}, ...b, subjects: b.subjects?.length ? b.subjects : [{ text: '', pic: null }] } : null };
}
export function settingsPayload(st, extra = {}) {
  const t = st.tpl, overrides = {};
  for (const f of t.fields || []) if (f.key in st.values && !eq(st.values[f.key], f.value)) overrides[f.key] = clone(st.values[f.key]);
  return { ...extra, v: 1, template: t.id, presetId: null, overrides, seedMode: clone(st.seedMode), imageMp: clone(st.imageMp), imageCrop: clone(st.imageCrop),
    sizeMode: clone(st.sizeMode), loraFolder: clone(st.loraFolder), builder: st.pb ? clone(st.pb) : null };
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
export const canvasRect = (payload, frame) => (payload?.size ? { x: 0, y: 0, w: payload.size.w, h: payload.size.h } : { x: 0, y: 0, w: frame.w, h: frame.h });
