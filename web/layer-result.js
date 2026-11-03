// ---------------------------------------------------------------------------
// layer-result: what a layer's result takes from the layer it was made from: its place and turn, and its shape (its own mask and see-through).
// Shared by the Image tools and Inpaint.
// ---------------------------------------------------------------------------
import { pngBlob, uploadImage } from './media.js';
import * as G from './layer-geom.js';

const { seeThrough } = G;

// The models give back a solid picture: a cut-out's see-through would be lost. A canvas that shows what a picture's see-through leaves, or null when it is solid
export function shapeOf(pic, sx, sy, sw, sh, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(pic, sx, sy, sw, sh, 0, 0, w, h);
  // (Qwen 2.1's VAE writes a noisy alpha, down to 248 on a solid picture: its pictures aren't cut-outs)
  return seeThrough(c.getImageData(0, 0, w, h).data, 240) ? cv : null;
}
// A layer's shape as it is now, its kept part at its own pixels (painting on it during the run doesn't change it): what its mask and its own
// see-through leave showing, for a mask on the result. null if it has neither.
export function maskAsSent(eng, l) {
  const m = l.maskFor === 'adjust' ? null : eng.E.layers.find((x) => x.maskOf === l.key && eng.ready(x));   // (a mask for its colour is in the picture sent)
  const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, k = l.crop;
  const w = Math.max(1, Math.round(k.w * W)), h = Math.max(1, Math.round(k.h * H));
  const own = shapeOf(l.img, k.x * W, k.y * H, k.w * W, k.h * H, w, h);
  // (a mask switched off stays off, on the result too; the see-through can't be, so it goes on alone)
  const useMask = m && !(l.maskOff && own);
  if (!useMask && !own) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'destination-in';
  if (own) c.drawImage(own, 0, 0);
  if (useMask) {
    const mw = m.img.naturalWidth || m.img.width, mh = m.img.naturalHeight || m.img.height;
    c.drawImage(m.img, k.x * mw, k.y * mh, k.w * mw, k.h * mh, 0, 0, w, h);
  }
  cv.dataset.off = useMask && l.maskOff ? '1' : '';
  return cv;
}
// that mask at a result's pixels, as a new input: what a mask shares with its layer is scale and crop, so it must be the result's size
export async function maskForResult(src, r) {
  if (!src.mask) return {};
  const cv = document.createElement('canvas');
  cv.width = r.width; cv.height = r.height;
  const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(src.mask, 0, 0, cv.width, cv.height);
  const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'mask.png', multiple: 1 });
  return { mask: up.name, ...(src.mask.dataset.off && { maskOff: true }) };
}

// a result pic's place at x, y and w wide: over its layer, with that layer's turn
export function placed(src, x, y, w, pic) {
  const scale = w / pic.width;
  return { ...(src.was ? G.placeOn(src.was, { x, y, w, h: pic.height * scale }) : { x, y }), scale };
}
