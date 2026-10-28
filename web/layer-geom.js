// ---------------------------------------------------------------------------
// layer-geom: where an Editor layer's pixels land on the canvas (no DOM, so the node tests load it).
// A layer shows the crop of its image ({x,y,w,h} fractions) at l.x, l.y (the kept part's top-left before turning),
// l.scale; then it is turned by l.rotation degrees (clockwise on screen) about the kept part's centre and mirrored
// across that centre by l.flipX / l.flipY. Without rotation or flips everything is as it always was.
// Matrices are [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (canvas 2D order).
// ---------------------------------------------------------------------------
const size = (l) => [l.img?.naturalWidth || l.w || 1, l.img?.naturalHeight || l.h || 1];
export const turned = (l) => !!((l.rotation || 0) % 360) || !!l.flipX || !!l.flipY;

export const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const apply = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
const T = (x, y) => [1, 0, 0, 1, x, y];

// the kept part before turning, in canvas px
export function layerRect(l) {
  const [W, H] = size(l), c = l.crop;
  return { x: l.x, y: l.y, w: c.w * W * l.scale, h: c.h * H * l.scale };
}
export const centre = (l) => { const r = layerRect(l); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
// the turn and mirror alone (a 2x2 as a matrix without moving)
export function linear(l) {
  const a = ((l.rotation || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a), fx = l.flipX ? -1 : 1, fy = l.flipY ? -1 : 1;
  return [cos * fx, sin * fx, -sin * fy, cos * fy, 0, 0];
}
// about the kept part's centre: canvas px (unturned) -> canvas px (turned)
export function turn(l) {
  const c = centre(l);
  return mul(T(c.x, c.y), mul(linear(l), T(-c.x, -c.y)));
}
// image px -> canvas px
export function layerMatrix(l) {
  const [W, H] = size(l), s = l.scale;
  return mul(turn(l), [s, 0, 0, s, l.x - l.crop.x * W * s, l.y - l.crop.y * H * s]);
}
export const imageToCanvas = (l, p) => apply(layerMatrix(l), p);
export const canvasToImage = (l, p) => apply(invert(layerMatrix(l)), p);
// a canvas point in the layer's unturned frame (to test it against layerRect, or resize along the layer's sides)
export const toLocal = (l, p) => apply(invert(turn(l)), p);
// the kept part's corners on the canvas: top-left, top-right, bottom-right, bottom-left (before mirroring)
export function corners(l) {
  const r = layerRect(l), c = centre(l), a = ((l.rotation || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) =>
    ({ x: c.x + (x - c.x) * cos - (y - c.y) * sin, y: c.y + (x - c.x) * sin + (y - c.y) * cos }));
}
// the box round what the layer covers on the canvas (layerRect itself when it isn't turned)
export function bounds(l) {
  if (!((l.rotation || 0) % 360)) return layerRect(l);
  const ps = corners(l), xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export const insideLayer = (l, p) => { const q = toLocal(l, p), r = layerRect(l); return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h; };

// A new crop that leaves the image where it is on the canvas: with a turn, the kept part's centre (the pivot) moves
// with the crop, so its position makes up for that
export function cropKeepingPlace(l, c) {
  const [W, H] = size(l), s = l.scale, old = l.crop;
  const o = { x: l.x - old.x * W * s, y: l.y - old.y * H * s };
  const d = { x: s * ((c.x + c.w / 2) - (old.x + old.w / 2)) * W, y: s * ((c.y + c.h / 2) - (old.y + old.h / 2)) * H };
  const ad = apply(linear(l), d);
  return { crop: c, x: o.x + ad.x - d.x + c.x * W * s, y: o.y + ad.y - d.y + c.y * H * s };
}

// degrees in (-180, 180]; near a multiple of 15 (within `pull`) it lands on it; step: always on multiples of step
export function snapAngle(deg, { pull = 0, step = 0 } = {}) {
  let a = deg;
  if (step) a = Math.round(a / step) * step;
  else if (pull) { const n = Math.round(a / 15) * 15; if (Math.abs(n - a) <= pull) a = n; }
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}
