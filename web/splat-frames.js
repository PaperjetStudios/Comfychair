// An animated splat: a splat layer with more than one file, shown one at a time. Pure (node tests import it).
// The layer itself is the first frame (o.url, o.file, o.levels, o.image, o.gen, o.genIndex, as any splat); o.frames
// holds the rest, each with those same fields. Every frame sits where the first does (the layer's o.box), so frames
// made from one camera's photos stay lined up.
//   o.frameRate  frames a second, while the layer has no keys on its 'sf' channel
//   o.frameLoop  'loop' | 'once' (holds the last) | 'bounce' (there and back)
//   chans.sf     keys on the timeline: which frame from each key on (0 is the first). They win over the rate.
//   o.trim       the whole layer's radial trim (splat-shape.js); a frame's frameTrim takes its place on that frame
export const RATES = [2, 4, 6, 8, 12, 24];
export const LOOPS = [['loop', 'Loop'], ['once', 'Once'], ['bounce', 'There and back']];
export const DEFAULT_RATE = 6;
const FRAME_FIELDS = ['url', 'file', 'ext', 'levels', 'image', 'gen', 'genIndex', 'label', 'frameTrim'];

export const frameCount = (o) => 1 + (o?.frames?.length || 0);
export const frameList = (o) => [o, ...(o?.frames || [])];
export const hasFrameKeys = (o) => !!o?.chans?.sf?.length;

// which frame shows at scene frame f (fps: the scene's). keyed: the 'sf' channel's value there, when it has keys.
export function frameIndex(o, f, keyed, fps = 24) {
  const n = frameCount(o);
  if (n < 2) return 0;
  if (Number.isFinite(keyed)) return Math.min(n - 1, Math.max(0, Math.round(keyed)));
  const step = Math.floor((Math.max(0, f) * (+o.frameRate || DEFAULT_RATE)) / fps + 1e-6);
  if (o.frameLoop === 'once') return Math.min(step, n - 1);
  if (o.frameLoop === 'bounce') { const p = step % (2 * n - 2); return p < n ? p : 2 * n - 2 - p; }
  return step % n;
}

// the trim frame i uses, and the layer as frame i's mesh should read it (its size stays the layer's)
export const frameTrimOf = (o, i) => frameList(o)[i]?.frameTrim || o.trim;
export const shapeFor = (o, i) => (frameList(o)[i]?.frameTrim ? { ...o, trim: frameList(o)[i].frameTrim } : o);
// the frames that follow the layer's own trim
export const framesOnWhole = (o) => frameList(o).map((fr, i) => (fr.frameTrim ? -1 : i)).filter((i) => i >= 0);
// a scene frame that shows frame i, the nearest to `from` (null: the timeline never shows it)
export function sceneFrameShowing(o, i, total, from = 0, keyedAt = () => undefined, fps = 24) {
  let best = null;
  for (let f = 0; f < total; f++) if (frameIndex(o, f, keyedAt(f), fps) === i && (best === null || Math.abs(f - from) < Math.abs(best - from))) best = f;
  return best;
}

const fieldsOf = (x) => Object.fromEntries(FRAME_FIELDS.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]));
// write frame i's fields: the first frame's are the layer's own
function put(o, i, fr) {
  if (i > 0) { o.frames[i - 1] = fr; return; }
  for (const k of FRAME_FIELDS) delete o[k];
  Object.assign(o, fr);
}
const relabelKeys = (o, map) => { for (const k of o.chans?.sf || []) k.v = map(Math.round(k.v)); };
const dropIfOne = (o) => {
  if (o.frames?.length) return;
  delete o.frames;
  if (o.chans?.sf) { delete o.chans.sf; }
};

// a frame from a made or imported splat ({ url, file?, ext?, levels?, image?, gen?, genIndex?, label? }) at the end
export function addFrame(o, fr) { (o.frames ||= []).push(fieldsOf(fr)); o.frameRate ||= DEFAULT_RATE; o.frameLoop ||= 'loop'; }

// take frame i out; keys stay on the frames they showed (a key on the frame that went shows the one after it)
export function removeFrame(o, i) {
  const n = frameCount(o);
  if (n < 2 || i < 0 || i >= n) return false;
  if (i === 0) { const next = o.frames.shift(); put(o, 0, fieldsOf(next)); } else o.frames.splice(i - 1, 1);
  relabelKeys(o, (v) => (v > i ? v - 1 : Math.min(v, n - 2)));
  dropIfOne(o);
  return true;
}

// frames i and j change places, and their keys go with them
export function swapFrames(o, i, j) {
  const n = frameCount(o);
  if (i === j || i < 0 || j < 0 || i >= n || j >= n) return false;
  const a = fieldsOf(frameList(o)[i]), b = fieldsOf(frameList(o)[j]);
  put(o, i, b); put(o, j, a);
  relabelKeys(o, (v) => (v === i ? j : v === j ? i : v));
  return true;
}
