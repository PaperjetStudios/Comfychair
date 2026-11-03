// ---------------------------------------------------------------------------
// photo-restore: the pixel work of Colourise and Restore, with no DOM (the node tests load it): keeping a picture's own
// brightness under new colour, finding scratches and dust, and where a face goes to the face model.
// ---------------------------------------------------------------------------
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// The colour of `colour` on the brightness and see-through of `orig` (RGBA, same size), written into colour. An edit model
// only ever sees about 2 MP and redraws what it sees: this way every line and grain of the original stays, at its full size.
export function keepBrightness(orig, colour) {
  for (let i = 0; i < orig.length; i += 4) {
    const d = luma(orig[i], orig[i + 1], orig[i + 2]) - luma(colour[i], colour[i + 1], colour[i + 2]);
    colour[i] += d; colour[i + 1] += d; colour[i + 2] += d;   // (a clamped array)
    colour[i + 3] = orig[i + 3];
  }
  return colour;
}

// the darkest or lightest value within r of each one, along a row or column (a running window)
function slide(src, w, h, r, big, across) {
  const out = new Uint8Array(src.length), lines = across ? h : w, n = across ? w : h, step = across ? 1 : w, line = across ? w : 1;
  const q = new Int32Array(n);
  for (let l = 0; l < lines; l++) {
    const at = l * line;
    let head = 0, tail = 0;
    for (let i = 0; i < n + r; i++) {
      if (i < n) {
        const v = src[at + i * step];
        while (tail > head && (big ? src[at + q[tail - 1] * step] <= v : src[at + q[tail - 1] * step] >= v)) tail--;
        q[tail++] = i;
      }
      if (q[head] < i - 2 * r) head++;
      if (i >= r) out[at + (i - r) * step] = src[at + q[head] * step];
    }
  }
  return out;
}
const square = (src, w, h, r, big) => slide(slide(src, w, h, r, big, true), w, h, r, big, false);

export const SCRATCH_AMOUNTS = { light: 42, normal: 30, strong: 20 };

// the picture with each value the mean of the 3×3 round it: grain goes down by about three, and a line stays
function softened(L, w, h) {
  const out = new Uint8Array(L.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      let t = 0, n = 0;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { t += L[j * w + i]; n++; }
      out[y * w + x] = t / n;
    }
  }
  return out;
}
// how much a grainy picture's values stray from what's round them, in values (the median stray, as a spread)
function grainOf(L, soft) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < L.length; i++) counts[Math.abs(L[i] - soft[i])]++;
  let seen = 0, v = 0;
  for (; v < 255 && seen + counts[v] < L.length / 2; v++) seen += counts[v];
  return v * 1.48;
}

// Scratches and dust in a picture (RGBA), as a mask (255 = marked): what is thinner than the window and stands out from what's round it, by more than
// the picture's own grain does. A long thin mark counts anywhere; a speck only where few others are near, since many together are texture (hair, leaves, cloth), not dust.
// skip: a mask of what to leave alone (faces: their fine lines look like scratches, and the face model sees to them): a mark wholly inside it stays,
// and one that only crosses it is still a scratch. Returns the mask.
export function scratchMask(px, w, h, { amount = 'normal', skip = null } = {}) {
  const r = Math.max(2, Math.round(Math.min(w, h) / 400));
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = luma(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  const L = softened(raw, w, h), bar = Math.max(SCRATCH_AMOUNTS[amount] ?? SCRATCH_AMOUNTS.normal, 2.2 * grainOf(raw, L));
  const open = square(square(L, w, h, r, false), w, h, r, true), shut = square(square(L, w, h, r, true), w, h, r, false);
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) if (Math.max(L[i] - open[i], shut[i] - L[i]) >= bar) on[i] = 1;
  // how crowded each part of the picture is
  const cell = Math.max(16, 12 * r), gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), count = new Uint32Array(gw * gh);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (on[i]) count[((y / cell) | 0) * gw + ((x / cell) | 0)]++;
  const crowded = (x, y) => count[((y / cell) | 0) * gw + ((x / cell) | 0)] > cell * cell * 0.08;
  const out = new Uint8Array(w * h), seen = new Uint8Array(w * h), stack = [], longest = Math.max(24, 12 * r), widest = 2 * r + 3, speck = 4 * r * r + 4 * r + 4;
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    const part = [];
    let x0 = w, x1 = 0, y0 = h, y1 = 0, inside = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      part.push(i);
      if (skip && skip[i] > 127) inside++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (inside === part.length) continue;
    const length = Math.max(x1 - x0, y1 - y0) + 1, cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1;
    const thin = length >= longest && part.length / length <= widest;
    if (thin || (part.length <= speck && !crowded(cx, cy))) for (const i of part) out[i] = 255;
  }
  return out;
}

// The square a face goes to the face model in (it wants a face with some room round it), inside a W×H picture; null when it's too small to help
export function faceBox(area, W, H, room = 1.6) {
  const side = Math.min(W, H, Math.round(Math.max(area.w, area.h) * room));
  if (Math.max(area.w, area.h) < 24) return null;
  const x = Math.max(0, Math.min(W - side, Math.round(area.x + area.w / 2 - side / 2)));
  const y = Math.max(0, Math.min(H - side, Math.round(area.y + area.h / 2 - side / 2)));
  return { x, y, w: side, h: side };
}

// Parts of a W×H picture small enough for a model that takes at most `most` pixels, overlapping a little
export function tilesOf(W, H, most, overlap = 64) {
  const side = Math.floor(Math.sqrt(most)), out = [], step = side - overlap;
  for (let y = 0; ; y += step) {
    for (let x = 0; ; x += step) {
      out.push({ x, y, w: Math.min(side, W - x), h: Math.min(side, H - y) });
      if (x + side >= W) break;
    }
    if (y + side >= H) break;
  }
  return out;
}
