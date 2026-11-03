import { ASPECT_PRESETS } from './core.js';
export const FULL = { x: 0, y: 0, w: 1, h: 1 };

export const ASPECTS = [['Free', null], ...ASPECT_PRESETS];

// Crop rectangle (fractions of a W×H image) from a fixed corner (fx,fy) to the pointer, respecting
// the aspect lock (width/height in pixels, null = free) and the image bounds (past: it may go past them)
export function cropSpan(W, H, aspect, fx, fy, px, py, past = false) {
  let w = Math.abs(px - fx), hh = Math.abs(py - fy);
  if (aspect) {
    const maxW = past ? Infinity : px < fx ? fx : 1 - fx, maxH = past ? Infinity : py < fy ? fy : 1 - fy;
    hh = (w * W) / (aspect * H);
    if (hh > maxH) { hh = maxH; w = (hh * aspect * H) / W; }
    if (w > maxW) { w = maxW; hh = (w * W) / (aspect * H); }
  }
  w = Math.max(w, 0.02); hh = Math.max(hh, 0.02);
  return { x: px < fx ? fx - w : fx, y: py < fy ? fy - hh : fy, w, h: hh };
}

// the largest centred crop with that aspect
export function aspectCrop(W, H, a) {
  let w = 1, hh = W / (a * H);
  if (hh > 1) { hh = 1; w = (a * H) / W; }
  return { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
}
