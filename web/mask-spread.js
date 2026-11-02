// Dilate and erode a mask, as plain maths: no DOM (tests/mask_spread.test.mjs). The mask's alpha gives a signed distance to its edge once,
// which is the slow part; any amount is then one pass over it, quick enough to follow a slider. Past the picture's edge isn't an edge: a
// mask reaching the side of the picture stays there when it erodes.
export const SPREAD_MAX = 128;   // px, either way
const ON = 3;   // the alpha that counts as mask: any ink does (editor-engine composeMask)
const FAR = 1e12;

// one line of the squared distance transform (Felzenszwalb and Huttenlocher), in place: f, n values `step` apart from `at`
function line(f, at, step, n, v, z, g) {
  let k = 0, count = 0;
  for (let q = 0; q < n; q++) {
    g[q] = f[at + q * step];
    if (g[q] < FAR) count++;
  }
  if (!count) return;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      s = (g[q] + q * q - g[v[k]] - v[k] * v[k]) / (2 * (q - v[k]));
      if (s > z[k]) break;
      k--;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    f[at + q * step] = d * d + g[v[k]];
  }
}
function squared(seed, w, h) {
  const n = Math.max(w, h), v = new Int32Array(n), z = new Float64Array(n + 1), g = new Float64Array(n);
  for (let x = 0; x < w; x++) line(seed, x, w, h, v, z, g);
  for (let y = 0; y < h; y++) line(seed, y * w, 1, w, v, z, g);
  return seed;
}

// alpha: one value a pixel, 0-255, W×H. { x, y, w, h, sd }: the box round the mask with SPREAD_MAX of room, inside the picture, and the
// distance from each of its pixels to the mask's edge (more than 0 inside it). null with nothing marked.
export function distanceField(alpha, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    if (alpha[i] >= ON) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const bx = Math.max(0, x0 - SPREAD_MAX), by = Math.max(0, y0 - SPREAD_MAX), w = Math.min(W, x1 + SPREAD_MAX + 1) - bx, h = Math.min(H, y1 + SPREAD_MAX + 1) - by, n = w * h;
  const out = new Float64Array(n), inside = new Float64Array(n);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const on = alpha[(y + by) * W + x + bx] >= ON;
    out[i] = on ? 0 : FAR; inside[i] = on ? FAR : 0;
  }
  squared(out, w, h); squared(inside, w, h);
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) sd[i] = out[i] === 0 ? (inside[i] >= FAR ? SPREAD_MAX * 2 : Math.sqrt(inside[i]) - 0.5) : 0.5 - Math.sqrt(out[i]);
  return { x: bx, y: by, w, h, sd };
}

// The alpha of the mask dilated by r px (r < 0: eroded) into dst (W×H, one value a pixel, or every `stride` bytes from `offset`), its edge one pixel soft
export function spreadInto(field, r, dst, W, { stride = 1, offset = 0 } = {}) {
  for (let i = offset; i < dst.length; i += stride) dst[i] = 0;
  const { x, y, w, h, sd } = field;
  for (let row = 0, i = 0; row < h; row++) {
    let at = ((y + row) * W + x) * stride + offset;
    for (let col = 0; col < w; col++, i++, at += stride) {
      const a = sd[i] + r + 0.5;
      dst[at] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return dst;
}

export const spreadLabel = (r) => (!r ? 'None' : `${r > 0 ? 'Dilate' : 'Erode'} ${Math.abs(r)} px`);
