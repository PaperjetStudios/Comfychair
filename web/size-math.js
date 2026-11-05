// A picture size from proportions and megapixels, without the page (web/size-picker.js draws the picker; Make's Size field
// and a frame's Resolution use it). node --test tests/size_math.test.mjs
//   presetSize(aspect, mp, step, lim?)  { w, h } of about mp megapixels at aspect (w / h), each side on the step;
//     lim(n, 'w' | 'h') keeps a side in its range (default: at least one step)
//   nearestAspect(w, h, presets)  the preset id within 3% of w / h, else 'custom'
//   modeOf(w, h, presets)         { aspect, mp } that describes w × h
//   snapSide(n, step, min, max)   a typed side on the step, kept in range
export const MP_STEPS = [0.25, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function presetSize(aspect, mp, step = 16, lim = (n) => Math.max(step, n)) {
  const px = mp * 1e6;
  return { w: lim(Math.round(Math.sqrt(px * aspect) / step) * step, 'w'), h: lim(Math.round(Math.sqrt(px / aspect) / step) * step, 'h') };
}
export function nearestAspect(w, h, presets) {
  const near = presets.find(([, a]) => Math.abs(w / h / a - 1) < 0.03);
  return near ? near[0] : 'custom';
}
export const modeOf = (w, h, presets) => ({ aspect: nearestAspect(w, h, presets), mp: Math.round((w * h) / 1e4) / 100 });
export function snapSide(n, step = 16, min = step, max = Infinity) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
}

// What a picture of w × h comes in at under mp megapixels (0: its own size), sides snapped down to a multiple: as app/imageprep.py prep cuts it
export function capSize(w, h, mp = 0, multiple = 16) {
  if (mp && w * h > mp * 1e6) { const k = Math.sqrt((mp * 1e6) / (w * h)); w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }
  return { w: Math.max(multiple, Math.floor(w / multiple) * multiple), h: Math.max(multiple, Math.floor(h / multiple) * multiple) };
}
