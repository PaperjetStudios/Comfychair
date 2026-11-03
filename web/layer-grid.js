// ---------------------------------------------------------------------------
// layer-grid: the selected Editor layers in equal cells (no DOM, so the node tests load it). A plan is a set of whole-pixel cells,
// one per layer, in the reading order the layers have on the canvas. Auto columns: on a fixed canvas, what loses least to the cells'
// shape (the same sum whether the loss is cut off or left empty), with empty cells counted; with no fixed canvas, the
// squarest sheet. A short last row is centred.
// ---------------------------------------------------------------------------
import { bounds, size, snapAngle } from './layer-geom.js';

const quarter = (r) => snapAngle(Math.round((r || 0) / 90) * 90);
const odd = (r) => Math.abs(quarter(r)) === 90;

// What a plan needs of a layer: the box it covers at scale 1 from this crop (with crop on, turned to the nearest quarter), its scale and place
export function gridItem(l, crop, cropOn) {
  const [W, H] = size(l), w = crop.w * W, h = crop.h * H;
  let bw = w, bh = h;
  if (cropOn) { if (odd(l.rotation)) [bw, bh] = [h, w]; } else {
    const a = ((l.rotation || 0) * Math.PI) / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    bw = w * cos + h * sin; bh = w * sin + h * cos;
  }
  return { w: bw, h: bh, scale: l.scale, box: bounds(l) };
}

// Rows from where the items are: top to bottom, left to right. Items in a pile stay in the order given.
export function readingOrder(items) {
  const at = items.map((it, i) => ({ i, x: it.box.x + it.box.w / 2, y: it.box.y + it.box.h / 2 }));
  const hs = items.map((it) => it.box.h).sort((a, b) => a - b), tall = hs[hs.length >> 1] / 2;
  const rows = [];
  for (const p of [...at].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    if (row && p.y - row[0].y <= tall) row.push(p); else rows.push([p]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x).map((p) => p.i));
}

const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
const cellShape = (items, cols, { frame, gap }) => {
  const rows = Math.ceil(items.length / cols);
  if (frame) return { w: (frame.w - gap * (cols - 1)) / cols, h: (frame.h - gap * (rows - 1)) / rows, rows };
  return { w: median(items.map((it) => it.w * it.scale)), h: median(items.map((it) => it.h * it.scale)), rows };
};

export function bestCols(items, { frame = null, gap = 0 } = {}) {
  let best = 1, top = -1;
  for (let cols = 1; cols <= items.length; cols++) {
    const { w, h, rows } = cellShape(items, cols, { frame, gap });
    if (w <= 0 || h <= 0) continue;
    const fill = items.length / (cols * rows);
    let score;
    if (frame) {
      const a = w / h;
      score = (items.reduce((sum, it) => { const b = it.w / it.h; return sum + Math.min(a / b, b / a); }, 0) / items.length) * fill;
    } else score = fill / (1 + Math.abs(Math.log(((w + gap) * cols) / ((h + gap) * rows))));
    if (score > top + 1e-9) { top = score; best = cols; }
  }
  return best;
}

// { cols, rows, cells: [{x, y, w, h}], one for each item by its index }
export function gridPlan(items, { frame = null, origin = { x: 0, y: 0 }, cols = 0, gap = 0 } = {}) {
  const n = items.length, c = Math.min(n, cols > 0 ? cols : bestCols(items, { frame, gap }));
  const shape = cellShape(items, c, { frame, gap }), rows = shape.rows;
  const cw = Math.max(1, shape.w), ch = Math.max(1, shape.h), from = frame || origin;
  const cells = new Array(n);
  readingOrder(items).forEach((item, k) => {
    const row = Math.floor(k / c), col = k % c, inRow = row === rows - 1 ? n - row * c : c;
    const left = from.x + ((c - inRow) * (cw + gap)) / 2 + col * (cw + gap), top = from.y + row * (ch + gap);
    const x = Math.round(left), y = Math.round(top);
    cells[item] = { x, y, w: Math.max(1, Math.round(left + cw) - x), h: Math.max(1, Math.round(top + ch) - y) };
  });
  return { cols: c, rows, cells };
}

// What a layer changes to stand in a cell, its centre on the cell's: whole inside it, or filling it with a crop around the middle of `base`
export function fitToCell(l, base, cell, cropOn) {
  const [W, H] = size(l), cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2, w = base.w * W, h = base.h * H;
  if (!cropOn) {
    const a = ((l.rotation || 0) * Math.PI) / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const s = Math.min(cell.w / (w * cos + h * sin), cell.h / (w * sin + h * cos));
    return { crop: { ...base }, scale: s, x: Math.round(cx - (w * s) / 2), y: Math.round(cy - (h * s) / 2) };
  }
  const q = quarter(l.rotation), side = odd(l.rotation), sw = side ? h : w, sh = side ? w : h;
  const s = Math.max(cell.w / sw, cell.h / sh);
  const vw = Math.min(w, (side ? cell.h : cell.w) / s), vh = Math.min(h, (side ? cell.w : cell.h) / s);
  const crop = { x: base.x + (w - vw) / 2 / W, y: base.y + (h - vh) / 2 / H, w: vw / W, h: vh / H };
  return { crop, scale: s, x: cx - (vw * s) / 2, y: cy - (vh * s) / 2, ...((l.rotation || 0) % 90 ? { rotation: q } : {}) };
}
