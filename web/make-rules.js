// The table's Make panel (make-panel.js), its rules: which templates fit the selection, what of a frame goes into a run,
// and where a result lands. Pure, so node --test tests/make_panel.test.mjs can check it.

// What the panel makes for: nothing (or a note) selected, or the first frame of the selection that isn't a note
export function makeTarget(frames = []) {
  const f = (frames || []).find((x) => x && x.kind !== 'note') || null;
  return { kind: f ? f.kind : 'none', frame: f };
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

export function fitsKind(t, kind) {
  const id = t.id;
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
export const LANDS = { none: 'frame', image: 'layer', video: 'clip', scene: 'shelf', sound: 'shelf' };

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

// Where an image frame's results go on its canvas: the canvas when it has a size, else the frame's own rectangle
export const canvasRect = (payload, frame) => (payload?.size ? { x: 0, y: 0, w: payload.size.w, h: payload.size.h } : { x: 0, y: 0, w: frame.w, h: frame.h });
