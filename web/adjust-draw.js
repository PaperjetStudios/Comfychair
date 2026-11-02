// ---------------------------------------------------------------------------
// adjust-draw: adjust.js on canvases. A layer's graded picture is kept until its adjust or pixels change; while a slider
// or a brush is moving, a big picture is graded small so it keeps up.
// ---------------------------------------------------------------------------
import { applyGrade, gradeOf, histOf } from './adjust.js';

const QUICK_MAX = 2e6;   // pixels graded per frame while something's moving
const sizeOf = (src) => [src.naturalWidth || src.videoWidth || src.width, src.naturalHeight || src.videoHeight || src.height];
const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const ctxOf = (cv) => cv.getContext('2d', { willReadFrequently: true });

function gradeInto(cv, src, a) {
  const c = ctxOf(cv);
  c.globalCompositeOperation = 'copy';
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, cv.width, cv.height);
  const d = c.getImageData(0, 0, cv.width, cv.height);
  applyGrade(d.data, gradeOf(a));
  c.putImageData(d, 0, 0);
  return cv;
}
function shrunk(w, h, most) {
  const k = Math.min(1, Math.sqrt(most / Math.max(1, w * h)));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

const KEPT = new WeakMap();   // the layer's own picture -> its graded copies
// the picture graded. owner: what it's kept under; rev: the pixels' version; quick: for a frame in a drag (it can be smaller than src); live: src changes every frame
export function gradedPicture(src, a, { owner = src, rev = 0, quick = false, live = false } = {}) {
  const [w, h] = sizeOf(src), small = (quick || live) && w * h > QUICK_MAX;
  let kept = KEPT.get(owner);
  if (!kept) KEPT.set(owner, kept = {});
  const slot = live ? 'live' : small ? 'quick' : 'full', sig = `${JSON.stringify(a)}|${rev}`;
  if (!live && kept.full?.sig === sig) return kept.full.cv;
  if (!live && kept[slot]?.sig === sig) return kept[slot].cv;
  const [cw, ch] = small ? shrunk(w, h, QUICK_MAX) : [w, h];
  let cv = kept[slot]?.cv;
  if (!cv || cv.width !== cw || cv.height !== ch) cv = makeCanvas(cw, ch);
  gradeInto(cv, src, a);
  kept[slot] = { sig, cv };
  if (slot === 'full') delete kept.quick;
  return cv;
}

let frameCv = null;
// a frame of a clip graded, for the preview (no wider than cap: it's done again for every frame)
export function gradedFrame(el, a, cap = 1600) {
  const [w, h] = sizeOf(el), k = Math.min(1, cap / Math.max(1, w)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  if (!frameCv || frameCv.width !== cw || frameCv.height !== ch) frameCv = makeCanvas(cw, ch);
  return gradeInto(frameCv, el, a);
}

// the histogram of a picture's kept part (crop: fractions of it), from a small copy
export function histOfPicture(src, crop = { x: 0, y: 0, w: 1, h: 1 }) {
  const [w, h] = sizeOf(src), sx = crop.x * w, sy = crop.y * h, sw = Math.max(1, crop.w * w), sh = Math.max(1, crop.h * h);
  const [cw, ch] = shrunk(sw, sh, 3e5), cv = makeCanvas(cw, ch), c = ctxOf(cv);
  c.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
  return histOf(c.getImageData(0, 0, cw, ch).data);
}
