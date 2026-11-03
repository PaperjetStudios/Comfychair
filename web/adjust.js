// ---------------------------------------------------------------------------
// adjust: colour adjustments as data, with no DOM (the node tests load it). The Image tab's layers (layer.adjust) and the
// Video tab's clips (clip.adjust) share it. An adjust is never changed in place: a change makes a new object, so a split
// clip or an undo state can hold the old one.
//   { exposure (stops), mids, contrast, shadows, highlights, temp, tint, sat (each -1..1), hue (degrees),
//     curves: { m, r, g, b } (points [[x, y], ...], 0..1; m is all three channels, before r, g and b) }
// A grade is what it comes to: a table per channel, then a colour matrix. The preview draws with it; the export sends
// the same tables to ffmpeg (exportGrade, videoedit.grade_filters), so there is one set of colour math.
// ---------------------------------------------------------------------------
export const NUMBERS = [
  ['exposure', 'Exposure', -3, 3], ['mids', 'Midtones', -1, 1], ['contrast', 'Contrast', -1, 1], ['shadows', 'Shadows', -1, 1], ['highlights', 'Highlights', -1, 1],
  ['temp', 'Warmth', -1, 1], ['tint', 'Tint', -1, 1], ['sat', 'Saturation', -1, 1], ['hue', 'Hue', -180, 180],
];
export const CHANNELS = ['m', 'r', 'g', 'b'];
const near = (a, b) => Math.abs(a - b) < 1e-3;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const identityCurve = (pts) => !pts?.length || pts.every(([x, y]) => near(x, y));

// the same adjust without what does nothing; null when nothing is left
export function clean(a) {
  if (!a) return null;
  const out = {};
  for (const [k] of NUMBERS) if (Math.abs(a[k] || 0) > 1e-4) out[k] = a[k];
  const curves = {};
  for (const ch of CHANNELS) if (!identityCurve(a.curves?.[ch])) curves[ch] = a.curves[ch].map(([x, y]) => [x, y]);
  if (Object.keys(curves).length) out.curves = curves;
  return Object.keys(out).length ? out : null;
}
export const isOn = (a) => !!clean(a);

// A curve through its points as a function of 0..1: smooth, with no overshoot between points (monotone cubic); flat past its ends
export function curveFn(points) {
  const p = [...(points?.length ? points : [[0, 0], [1, 1]])].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n === 1) return () => p[0][1];
  const d = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]);
  t[0] = d[0]; t[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { t[i] = 0; continue; }
    const a = p[i][0] - p[i - 1][0], b = p[i + 1][0] - p[i][0];
    t[i] = (3 * (a + b)) / ((2 * b + a) / d[i - 1] + (b + 2 * a) / d[i]);
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (x > p[i + 1][0]) i++;
    const w = Math.max(1e-6, p[i + 1][0] - p[i][0]), s = (x - p[i][0]) / w, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p[i][1] + (s3 - 2 * s2 + s) * w * t[i] + (-2 * s3 + 3 * s2) * p[i + 1][1] + (s3 - s2) * w * t[i + 1];
  };
}

// What a channel's value becomes, before the colour matrix: light first (exposure in a gamma picture is a gain), then tone, then the curves
function channelFn(a, ch) {
  const gain = 2 ** ((a.exposure || 0) / 2.2)
    * (ch === 'r' ? 1 + 0.25 * (a.temp || 0) : ch === 'b' ? 1 - 0.25 * (a.temp || 0) : 1 - 0.2 * (a.tint || 0));
  const mids = 2 ** -(a.mids || 0), c = a.contrast || 0, slope = c >= 0 ? 1 + 2 * c : 1 + c;
  const sh = (a.shadows || 0) * 0.35, hi = (a.highlights || 0) * 0.35;
  const master = curveFn(a.curves?.m), own = curveFn(a.curves?.[ch]);
  return (v0) => {
    let v = clamp01(v0 * gain) ** mids;
    v = clamp01((v - 0.5) * slope + 0.5);
    const bump = 4 * v * (1 - v);
    v = clamp01(v + sh * bump * (1 - v) + hi * bump * v);
    return clamp01(own(clamp01(master(v))));
  };
}
// saturation about Rec. 709 light, then a turn of hue that keeps it (the matrices of CSS saturate() and hue-rotate()); null when it does nothing
function matrixOf(a) {
  const s = 1 + (a.sat || 0), deg = a.hue || 0;
  if (near(s, 1) && near(deg, 0)) return null;
  const L = [0.2126, 0.7152, 0.0722];
  const S = [0, 1, 2].map((r) => [0, 1, 2].map((c) => L[c] * (1 - s) + (r === c ? s : 0)));
  const co = Math.cos((deg * Math.PI) / 180), si = Math.sin((deg * Math.PI) / 180);
  const H = [
    [L[0] + co * (1 - L[0]) - si * L[0], L[1] - co * L[1] - si * L[1], L[2] - co * L[2] + si * (1 - L[2])],
    [L[0] - co * L[0] + si * 0.143, L[1] + co * (1 - L[1]) + si * 0.14, L[2] - co * L[2] - si * 0.283],
    [L[0] - co * L[0] - si * (1 - L[0]), L[1] - co * L[1] + si * L[1], L[2] + co * (1 - L[2]) + si * L[2]],
  ];
  return [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => H[r][0] * S[0][c] + H[r][1] * S[1][c] + H[r][2] * S[2][c]));
}

const GRADES = new WeakMap();
// the 8-bit tables and matrix of an adjust, kept with it (it never changes)
export function gradeOf(a) {
  let g = GRADES.get(a);
  if (g) return g;
  g = { m: matrixOf(a) };
  for (const ch of ['r', 'g', 'b']) {
    const f = channelFn(a, ch), t = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) t[i] = Math.round(f(i / 255) * 255);
    g[ch] = t;
  }
  GRADES.set(a, g);
  return g;
}
// RGBA pixels graded in place; alpha stays
export function applyGrade(px, g) {
  const { r, g: gr, b, m } = g;
  if (!m) {
    for (let i = 0; i < px.length; i += 4) { px[i] = r[px[i]]; px[i + 1] = gr[px[i + 1]]; px[i + 2] = b[px[i + 2]]; }
    return px;
  }
  const [a0, a1, a2, b0, b1, b2, c0, c1, c2] = m;
  const put = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : v + 0.5 | 0);
  for (let i = 0; i < px.length; i += 4) {
    const R = r[px[i]], G = gr[px[i + 1]], B = b[px[i + 2]];
    px[i] = put(a0 * R + a1 * G + a2 * B); px[i + 1] = put(b0 * R + b1 * G + b2 * B); px[i + 2] = put(c0 * R + c1 * G + c2 * B);
  }
  return px;
}
// what /api/video/render takes for a clip: each channel at 33 even steps (0..1), the matrix if any
export function exportGrade(a) {
  if (!isOn(a)) return null;
  const at = (ch) => { const f = channelFn(a, ch); return Array.from({ length: 33 }, (_, i) => +f(i / 32).toFixed(5)); };
  return { r: at('r'), g: at('g'), b: at('b'), m: matrixOf(a) };
}

// ---- histograms and curves made from them: { r, g, b } of 256 counts each ----
export function histOf(px) {
  const out = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) };
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;   // (what doesn't show has no colour to match)
    out.r[px[i]]++; out.g[px[i + 1]]++; out.b[px[i + 2]]++;
  }
  return out;
}
// a histogram as it is after an adjust's tables (how a clip that already has an adjust really looks)
export function histThrough(hist, a) {
  if (!isOn(a)) return hist;
  const g = gradeOf(a), out = {};
  for (const ch of ['r', 'g', 'b']) {
    out[ch] = new Array(256).fill(0);
    hist[ch].forEach((n, i) => { out[ch][g[ch][i]] += n; });
  }
  return out;
}
// the value (0..1) a share q of the counts lies below, between the steps
function quantiles(counts, qs) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let i = 0, below = 0;
  return qs.map((q) => {
    const want = q * total;
    while (i < 255 && below + counts[i] < want) { below += counts[i]; i++; }
    return clamp01((i + (counts[i] ? (want - below) / counts[i] : 0.5) - 0.5) / 255);
  });
}
// Black and white of each channel stretched to the ends (a colour cast goes with it); a nearly flat channel is left as it is
export function autoCurves(hist, clip = 0.005) {
  const curves = {};
  for (const ch of ['r', 'g', 'b']) {
    const q = quantiles(hist[ch], [clip, 1 - clip]);
    if (q && q[1] - q[0] >= 0.1) curves[ch] = [[q[0], 0], [q[1], 1]];
  }
  return Object.keys(curves).length ? curves : null;
}
// the fewest of these points that stay within tol of them all (straight lines between)
function simplify(pts, tol = 0.004, most = 9) {
  const keep = [0, pts.length - 1];
  while (keep.length < most) {
    let worst = -1, err = tol;
    const k = [...keep].sort((a, b) => a - b);
    for (let s = 0; s < k.length - 1; s++) {
      const [ax, ay] = pts[k[s]], [bx, by] = pts[k[s + 1]];
      for (let i = k[s] + 1; i < k[s + 1]; i++) {
        const e = Math.abs(ay + ((by - ay) * (pts[i][0] - ax)) / Math.max(1e-6, bx - ax) - pts[i][1]);
        if (e > err) { err = e; worst = i; }
      }
    }
    if (worst < 0) break;
    keep.push(worst);
  }
  return keep.sort((a, b) => a - b).map((i) => pts[i]);
}
// One look from several, each counting the same whatever its size (shares, not counts). Those showing nothing don't count; null when none shows anything.
export function averageLook(looks) {
  const out = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) };
  let used = 0;
  for (const look of looks) {
    const totals = ['r', 'g', 'b'].map((ch) => look[ch].reduce((a, b) => a + b, 0));
    if (totals.some((t) => !t)) continue;
    ['r', 'g', 'b'].forEach((ch, k) => look[ch].forEach((n, i) => { out[ch][i] += n / totals[k]; }));
    used++;
  }
  return used ? out : null;
}
const MATCH_AT = [0.002, 0.01, 0.03, 0.07, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.93, 0.97, 0.99, 0.998];
const MAX_SLOPE = 4;   // (steeper than this, a difference in what's in the shots would show as banding, not a match)
// The curves that give a picture with histogram src the look of one with histogram ref: the value at each share of one
// goes to the other's at that share, per channel. strength 1 is the whole way, 0 leaves it alone. Null when either shows nothing.
export function matchCurves(src, ref, { strength = 1 } = {}) {
  const curves = {};
  for (const ch of ['r', 'g', 'b']) {
    const xs = quantiles(src[ch], MATCH_AT), ys = quantiles(ref[ch], MATCH_AT);
    if (!xs || !ys) return null;
    const pts = [];
    xs.forEach((x, i) => {
      const last = pts[pts.length - 1];
      if (last && x - last[0] < 0.012) { last[1] = (last[1] + ys[i]) / 2; return; }   // (a spike in its histogram: one value, one place)
      pts.push([x, ys[i]]);
    });
    for (let i = 1; i < pts.length; i++) {
      const w = pts[i][0] - pts[i - 1][0];
      pts[i][1] = Math.min(pts[i - 1][1] + w * MAX_SLOPE, Math.max(pts[i][1], pts[i - 1][1] + w * 0.2));
    }
    const first = pts[0], last = pts[pts.length - 1];
    const full = [
      ...(first[0] > 0.001 ? [[0, Math.max(0, first[1] - first[0])]] : []), ...pts,
      ...(last[0] < 0.999 ? [[1, Math.min(1, last[1] + (1 - last[0]))]] : []),
    ].map(([x, y]) => [x, clamp01(x + (y - x) * strength)]);
    curves[ch] = simplify(full).map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
  }
  return curves;
}
