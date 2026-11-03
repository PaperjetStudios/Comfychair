// The size to run an edit model at for a whole picture (no DOM: tests/edit_size.test.mjs). Edit templates default to 1024×1024 and
// centre-crop to it (app/editsize.py), which cuts the top and bottom off a tall picture: this keeps the picture's shape, at about
// 2 MP at most, on the multiple the model wants.
export function editSizeFor(w, h, step = 16, maxPixels = 2.1e6) {
  return scaled(w, h, step, Math.min(1, Math.sqrt(maxPixels / (w * h))));
}

// The same at about this many pixels whatever the picture's size, so a small one is scaled up, as Generate's Megapixels does
export function editSizeTo(w, h, step = 16, pixels = 1e6) {
  return scaled(w, h, step, Math.sqrt(pixels / (w * h)));
}

function scaled(w, h, step, k) {
  const side = (v) => Math.max(256, Math.min(4096, Math.round((v * k) / step) * step));
  return [side(w), side(h)];
}
