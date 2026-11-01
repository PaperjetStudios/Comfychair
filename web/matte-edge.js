// A matte's edge, redrawn against the picture (no DOM: tests/matte_edge.test.mjs). SAM3 and BiRefNet see about 1000 px whatever the
// picture's size, so on a big picture their edge is a staircase, and SAM3's is hard. Two things help: running them again on a crop
// close to the thing, so those pixels cover less (boxesFor, foundIn), and deciding the edge's pixels by their colour, which
// moves the edge onto the picture's own (refineEdge). Everything is row by row: masks 0..255 (Uint8), colours 0..1 (Float32).

export const SEES = 1008;   // the longest side the models really see
export const WORTH_CROP = 1.25;   // a picture this much bigger than SEES gains from a second look
const STAIR = 4;   // the mask's own pixel, in SEES pixels: one step of the staircase

// how big a step of the staircase is, for an area of a picture the model saw w×h of, in that picture's pixels
export const stairOf = (w, h) => Math.max(1, (STAIR * Math.max(w, h)) / SEES);

// the box round what's on in a mask, or null
export function boundsOf(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (mask[i] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const touch = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function join(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// The areas to look at again: each thing's box with room round it (so the model still sees what's beside it), inside the picture;
// boxes that touch become one, or two things side by side would be looked at twice.
export function boxesFor(bounds, W, H, room = 0.12) {
  const out = [];
  for (const b of bounds) {
    const pad = Math.max(32, Math.round(Math.max(b.w, b.h) * room));
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    let box = { x, y, w: Math.min(W, b.x + b.w + pad) - x, h: Math.min(H, b.y + b.h + pad) - y };
    for (let i = out.length - 1; i >= 0; i--) if (touch(out[i], box)) { box = join(box, out[i]); out.splice(i, 1); }
    out.push(box);
  }
  // (a join can reach a box it passed over)
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < out.length && !again; i++) for (let j = i + 1; j < out.length; j++) if (touch(out[i], out[j])) { out[i] = join(out[i], out[j]); out.splice(j, 1); again = true; break; }
  }
  return out;
}

// The bounds of each separate marked area of a mask. Worked out on a grid of `cell` px, so a line of text's letters count as one area,
// and scattered marks can't make thousands.
export function separateAreas(mask, w, h, cell = 32) {
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), on = new Uint8Array(gw * gh);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (mask[i] > 127) on[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
  const out = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s]) continue;
    on[s] = 0;
    const stack = [s];
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (stack.length) {
      const k = stack.pop(), gx = k % gw, gy = (k / gw) | 0;
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx; if (gy < y0) y0 = gy; if (gy > y1) y1 = gy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && on[ny * gw + nx]) { on[ny * gw + nx] = 0; stack.push(ny * gw + nx); }
      }
    }
    out.push({ x: x0 * cell, y: y0 * cell, w: Math.min(w, (x1 + 1) * cell) - x0 * cell, h: Math.min(h, (y1 + 1) * cell) - y0 * cell });
  }
  return out;
}

// is a second look at this box any finer? Not when the box is about as big as the picture, or fits what the model sees anyway
export const worthLooking = (box, W, H) => Math.max(W, H) > SEES * WORTH_CROP && Math.max(box.w, box.h) < Math.max(W, H) * 0.8;

// What a second look found that is the thing the first look found: a crop can hold other things of that name, so a mask only counts
// if most of it lies on the first look's. Null when they don't agree (the first look stands): nothing kept, or far from it.
export function foundIn(first, founds, n = first.length) {
  const out = new Uint8Array(n);
  let any = false;
  for (const m of founds) {
    let area = 0, both = 0;
    for (let i = 0; i < n; i++) if (m[i] > 127) { area++; if (first[i] > 127) both++; }
    if (area && both / area >= 0.5) {
      any = true;
      for (let i = 0; i < n; i++) if (m[i] > out[i]) out[i] = m[i];
    }
  }
  if (!any) return null;
  let u = 0, x = 0;
  for (let i = 0; i < n; i++) { const a = first[i] > 127, b = out[i] > 127; if (a || b) u++; if (a && b) x++; }
  return x / Math.max(1, u) >= 0.5 ? out : null;
}

// the mean over a square of radius r at every pixel, in time that doesn't depend on r (edges: over what is inside the picture)
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0, n = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) { sum += src[row + x]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      if (x + r + 1 < w) { sum += src[row + x + r + 1]; n++; }
      if (x - r >= 0) { sum -= src[row + x - r]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) { sum += tmp[y * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      if (y + r + 1 < h) { sum += tmp[(y + r + 1) * w + x]; n++; }
      if (y - r >= 0) { sum -= tmp[(y - r) * w + x]; n--; }
    }
  }
  return out;
}

// He's guided filter: p (0..1) follows the edges of I (0..1) within radius r. eps: how small a change in I counts as an edge
export function guidedFilter(p, I, w, h, r, eps) {
  const n = w * h, mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r);
  const II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  const cII = boxMean(II, w, h, r), cIp = boxMean(Ip, w, h, r), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = (cIp[i] - mI[i] * mp[i]) / (cII[i] - mI[i] * mI[i] + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

// The mask (0..255) with its edge moved onto the picture's. rgb: three arrays, 0..1. Only a band as wide as the staircase changes:
// deeper in, the mask is sure of itself, on either side, and those sure pixels say what colours the thing and its background have
// near here (a count of each colour, so a wall with windows is two colours, not their mean). A pixel in the band is as much "thing" as its
// colour is more common on the thing's side. So a thin frond or pole comes out, flat sky stays clean, and a window stays background.
// A colour seen on neither side, or as often on both, says nothing: there the guided filter (the picture's brightness) decides.
const BINS = 12;
// (two grids of bins half a bin apart, averaged: one colour's sky, lying across a bin's edge, doesn't split into blotches)
const binOf = (rgb, i, shift) => {
  const at = (v) => Math.min(BINS - 1, (v * (BINS - 1) + shift) | 0);
  return at(rgb[0][i]) + BINS * (at(rgb[1][i]) + BINS * at(rgb[2][i]));
};
export function refineEdge(mask, rgb, w, h, stair, { eps = 2e-4 } = {}) {
  const n = w * h, r = Math.max(2, Math.round(stair)), T = Math.max(48, r * 6);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = mask[i] / 255;
  const near = boxMean(p, w, h, r);
  const sure = (i) => near[i] >= 0.999 || near[i] <= 0.001;
  // the colours of each side round a tile (made only when a pixel in the band asks): the tile and half a tile round it
  const tiles = new Map();
  const tileAt = (tx, ty) => {
    const key = tx + ty * 65536;
    let t = tiles.get(key);
    if (t) return t;
    const on = [new Float32Array(BINS ** 3), new Float32Array(BINS ** 3)], off = [new Float32Array(BINS ** 3), new Float32Array(BINS ** 3)];
    let nOn = 0, nOff = 0;
    const x1 = Math.min(w, (tx + 1.5) * T), y1 = Math.min(h, (ty + 1.5) * T);
    for (let y = Math.max(0, (ty - 0.5) * T) | 0; y < y1; y++) {
      for (let x = Math.max(0, (tx - 0.5) * T) | 0, i = y * w + x; x < x1; x++, i++) {
        if (near[i] >= 0.999) { on[0][binOf(rgb, i, 0)]++; on[1][binOf(rgb, i, 0.5)]++; nOn++; } else if (near[i] <= 0.001) { off[0][binOf(rgb, i, 0)]++; off[1][binOf(rgb, i, 0.5)]++; nOff++; }
      }
    }
    t = { on, off, nOn: Math.max(1, nOn), nOff: Math.max(1, nOff) };
    tiles.set(key, t);
    return t;
  };
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = 0.299 * rgb[0][i] + 0.587 * rgb[1][i] + 0.114 * rgb[2][i];
  const q = guidedFilter(p, I, w, h, r, eps), alpha = new Float32Array(n);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (sure(i)) { alpha[i] = p[i]; continue; }
      const t = tileAt((x / T) | 0, (y / T) | 0), b0 = binOf(rgb, i, 0), b1 = binOf(rgb, i, 0.5);
      const on = (t.on[0][b0] + t.on[1][b1]) / (2 * t.nOn), off = (t.off[0][b0] + t.off[1][b1]) / (2 * t.nOff), seen = on + off;
      const k = Math.max(0, Math.min(1, (q[i] - 0.3) / 0.4)), filter = k * k * (3 - 2 * k);
      const trust = seen / (seen + 0.002);   // (a colour in fewer than about 1 pixel in 500 of a side is hardly evidence)
      alpha[i] = seen ? trust * (on / seen) + (1 - trust) * filter : filter;
    }
  }
  // a pixel's colour alone is grainy: a last small pass, along the picture's edges, smooths that without moving them
  const soft = guidedFilter(alpha, I, w, h, 2, 1e-3), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (sure(i)) { out[i] = mask[i]; continue; }
    const k = Math.max(0, Math.min(1, (soft[i] - 0.25) / 0.5));   // (a colour seen a bit on both sides is no see-through patch)
    out[i] = Math.round(k * k * (3 - 2 * k) * 255);
  }
  return out;
}

// RGBA pixels (in place): the see-through channel as an opaque grey picture, solid = white, so a layer's shape can be used as a matte
export function alphaAsGrey(px) {
  for (let i = 0; i < px.length; i += 4) { px[i] = px[i + 1] = px[i + 2] = px[i + 3]; px[i + 3] = 255; }
  return px;
}

// the words of a "Find" box, each its own search: SAM3 takes one thing per run
export const termsOf = (text, most = 4) => [...new Set(String(text || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, most);
