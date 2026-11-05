// ---------------------------------------------------------------------------
// group-box: the sums behind one transform box round several Editor layers (no DOM, so the node tests load it).
// The box is the bounds of every layer's corners; scaling and turning move each layer's centre with the box, so
// every layer keeps its place inside it; a crop keeps only what lies inside a canvas rect.
// Each function takes the layer as it was when the gesture began (l0) and returns the fields to set on it.
// ---------------------------------------------------------------------------
import * as G from './layer-geom.js';

const size = (l) => [l.img?.naturalWidth || l.w || 1, l.img?.naturalHeight || l.h || 1];

// the box round several layers (canvas px), or null for none
export function groupBounds(ls) {
  if (!ls.length) return null;
  const rs = ls.map(G.bounds);
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

// x and y that put the kept part's centre at c at this scale (a turn is about that centre, so it carries over)
function atCentre(l0, scale, c) {
  const r = G.layerRect({ ...l0, scale });
  return { x: c.x - r.w / 2, y: c.y - r.h / 2 };
}

// grown or shrunk by k about the point a: its scale times k, its centre k times as far from a
export function scaleAbout(l0, k, a) {
  const c = G.centre(l0), scale = Math.max(0.01, l0.scale * k);
  const kk = scale / l0.scale;   // (the floor on the scale holds the centre to it too)
  return { scale, ...atCentre(l0, scale, { x: a.x + (c.x - a.x) * kk, y: a.y + (c.y - a.y) * kk }) };
}

// turned by deg (clockwise on screen) about the point a: its own turn plus deg, its centre swung round a
export function turnAbout(l0, deg, a) {
  const c = G.centre(l0), t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const dx = c.x - a.x, dy = c.y - a.y;
  return { rotation: G.snapAngle((l0.rotation || 0) + deg), ...atCentre(l0, l0.scale, { x: a.x + dx * cos - dy * sin, y: a.y + dx * sin + dy * cos }) };
}

// whether a rect on the canvas crops this layer exactly (its sides line up with the canvas: no turn, or quarter turns)
export const cropsExactly = (l) => !((l.rotation || 0) % 90);

// the corner box dragged from the fixed corner f to p, with aspect (width / height) when one is set; never under 1 px
export function spanRect(f, p, aspect = null) {
  let w = Math.abs(p.x - f.x), hh = Math.abs(p.y - f.y);
  if (aspect) { if (w / hh > aspect) w = hh * aspect; else hh = w / aspect; }
  w = Math.max(1, w || 0); hh = Math.max(1, hh || 0);
  return { x: p.x < f.x ? f.x - w : f.x, y: p.y < f.y ? f.y - hh : f.y, w, h: hh };
}

// The crop (and place, so the image stays put under it) that keeps only what of l0's whole image lies inside rect.
// null when nothing of the image is inside it, or when l0 is turned by other than quarter turns (no exact answer)
export function cropToRect(l0, rect) {
  if (!cropsExactly(l0)) return null;
  const [W, H] = size(l0);
  const ps = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]
    .map(([x, y]) => G.canvasToImage(l0, { x, y }));
  const x0 = Math.max(0, Math.min(...ps.map((q) => q.x))), x1 = Math.min(W, Math.max(...ps.map((q) => q.x)));
  const y0 = Math.max(0, Math.min(...ps.map((q) => q.y))), y1 = Math.min(H, Math.max(...ps.map((q) => q.y)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return G.cropKeepingPlace(l0, { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
}
