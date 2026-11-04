// ---------------------------------------------------------------------------
// layer-geom: where an Editor layer's pixels land on the canvas (no DOM, so the node tests load it).
// A layer shows the crop of its image ({x,y,w,h} fractions) at l.x, l.y (the kept part's top-left before turning),
// l.scale; then it is turned by l.rotation degrees (clockwise on screen) about the kept part's centre and mirrored
// across that centre by l.flipX / l.flipY. Without rotation or flips everything is as it always was.
// Matrices are [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (canvas 2D order).
// ---------------------------------------------------------------------------
export const size = (l) => [l.img?.naturalWidth || l.w || 1, l.img?.naturalHeight || l.h || 1];
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
// whether a crop keeps the whole image
// RGBA pixels with any part see-through (a rounding's worth of it doesn't count)
export function seeThrough(px, solid = 250) {
  for (let i = 3; i < px.length; i += 4) if (px[i] < solid) return true;
  return false;
}
export const plainCrop = (c) => !c || (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999);
// the pixels an Image tool is sent for this layer: its kept part at the file's own size, whatever its scale on the canvas
export function sentPixels(l) {
  const [W, H] = size(l), c = l.crop;
  return plainCrop(c) ? [W, H] : [Math.max(1, Math.round(c.w * W)), Math.max(1, Math.round(c.h * H))];
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
// A layer's sent pixels (w×h, its kept part unturned) -> a frame's pixels (a picture of the whole canvas, as a painted mask is)
export function sentToFrame(l, f, [w, h]) {
  const r = layerRect(l);
  return mul(T(-f.x, -f.y), mul(turn(l), [r.w / w, 0, 0, r.h / h, r.x, r.y]));
}
// A crop that goes past the picture's edges (Ctrl while cropping), and the picture it makes: w×h, with the old W×H picture drawn at ix, iy
export const pastEdge = (c) => c.x < -1e-4 || c.y < -1e-4 || c.x + c.w > 1 + 1e-4 || c.y + c.h > 1 + 1e-4;
// E.grow = { l, was }: a crop past the edges waiting for its Extend button, was being the layer's crop and place without it.
// What becomes of it: null it waits on, 'clear' it's over and the crop stays (back inside the picture, or the layer's gone),
// 'undo' the crop goes back to was (the crop was left, or another layer picked, without extending).
export function growFate(g, { cropping, sel, layers }) {
  if (!g) return null;
  if (!layers.includes(g.l) || !pastEdge(g.l.crop)) return 'clear';
  return cropping && sel === g.l ? null : 'undo';
}
export function grownPicture(c, W, H) {
  return { w: Math.max(1, Math.round(c.w * W)), h: Math.max(1, Math.round(c.h * H)), ix: -Math.round(c.x * W), iy: -Math.round(c.y * H) };
}
// does a box on the canvas ({ x, y, w, h }) touch what the layer covers, turned or not: no line along either's sides separates them
export function touchesBox(l, box) {
  const a = corners(l).map(({ x, y }) => [x, y]);
  const b = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
  const axes = [[1, 0], [0, 1], [a[1][0] - a[0][0], a[1][1] - a[0][1]], [a[3][0] - a[0][0], a[3][1] - a[0][1]]];
  return axes.every(([ax, ay]) => {
    const on = (ps) => ps.map(([x, y]) => x * ax + y * ay);
    const pa = on(a), pb = on(b);
    return Math.max(...pa) >= Math.min(...pb) && Math.max(...pb) >= Math.min(...pa);
  });
}
// the box round what the layer covers on the canvas (layerRect itself when it isn't turned)
export function bounds(l) {
  if (!((l.rotation || 0) % 360)) return layerRect(l);
  const ps = corners(l), xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export const insideLayer = (l, p) => { const q = toLocal(l, p), r = layerRect(l); return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h; };

// A layer's place when it covers rect in l's unturned frame and turns with l (an Image tool's result over l): x, y, and l's turn if it has one
export function placeOn(l, rect) {
  if (!turned(l)) return { x: rect.x, y: rect.y };
  const c = apply(turn(l), { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  return { x: c.x - rect.w / 2, y: c.y - rect.h / 2, rotation: l.rotation || 0, flipX: !!l.flipX, flipY: !!l.flipY };
}

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
