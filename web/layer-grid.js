// ---------------------------------------------------------------------------
// layer-grid: the selected Editor layers in equal cells (no DOM, so the node tests load it). A plan is a set of whole-pixel cells,
// one per layer, in the reading order the layers have on the canvas. Auto columns: on a fixed canvas, what loses least to the cells'
// shape (the same sum whether the loss is cut off or left empty), with empty cells counted; with no fixed canvas, the
// squarest sheet. A short last row is centred. densePlan drops the equal cells: each cell has its picture's own shape, so the
// only space between pictures is the gap.
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

// { cols, rows, cells: [{x, y, w, h}], one for each item by its index, order: the items as they were laid out }. `order` replaces the
// reading order from the canvas (dense columns don't read back the way they were filled, so another grid would shuffle them).
export function gridPlan(items, { frame = null, origin = { x: 0, y: 0 }, cols = 0, gap = 0, order = readingOrder(items) } = {}) {
  const n = items.length, c = Math.min(n, cols > 0 ? cols : bestCols(items, { frame, gap }));
  const shape = cellShape(items, c, { frame, gap }), rows = shape.rows;
  const cw = Math.max(1, shape.w), ch = Math.max(1, shape.h), from = frame || origin;
  const cells = new Array(n);
  order.forEach((item, k) => {
    const row = Math.floor(k / c), col = k % c, inRow = row === rows - 1 ? n - row * c : c;
    const left = from.x + ((c - inRow) * (cw + gap)) / 2 + col * (cw + gap), top = from.y + row * (ch + gap);
    const x = Math.round(left), y = Math.round(top);
    cells[item] = { x, y, w: Math.max(1, Math.round(left + cw) - x), h: Math.max(1, Math.round(top + ch) - y) };
  });
  return { cols: c, rows, cells, order };
}

// ---- dense: rows (or columns) of pictures that touch, each row as tall as it takes to span the sheet ----
// `aspects` split into k runs in order, each as near the same total as it can be
function splitRuns(aspects, k) {
  const n = aspects.length, sum = [0];
  for (const a of aspects) sum.push(sum[sum.length - 1] + a);
  const want = sum[n] / k;
  let cost = Array.from({ length: n + 1 }, (_, j) => (j ? Infinity : 0));
  const from = [];
  for (let r = 1; r <= k; r++) {
    const next = new Array(n + 1).fill(Infinity), back = new Array(n + 1).fill(0);
    for (let j = r; j <= n; j++) for (let i = r - 1; i < j; i++) {
      const c = cost[i] + (sum[j] - sum[i] - want) ** 2;
      if (c < next[j]) { next[j] = c; back[j] = i; }
    }
    cost = next; from.push(back);
  }
  const runs = [];
  for (let r = k - 1, j = n; r >= 0; j = from[r][j], r--) runs.unshift([from[r][j], j]);
  return runs;
}

// The biggest these runs can be inside W×H: { w, h, rows: [{ h, widths }], area }, or null if the gap leaves no room
function sizeRuns(aspects, runs, W, H, gap) {
  const rows = runs.map(([a, b]) => { const part = aspects.slice(a, b); return { part, total: part.reduce((t, v) => t + v, 0), gaps: gap * (part.length - 1) }; });
  const between = gap * (rows.length - 1);
  const tallAt = (w) => rows.reduce((t, r) => t + (w - r.gaps) / r.total, between);
  const w = tallAt(W) <= H ? W : (H - between + rows.reduce((t, r) => t + r.gaps / r.total, 0)) / rows.reduce((t, r) => t + 1 / r.total, 0);
  if (rows.some((r) => w <= r.gaps)) return null;
  const sized = rows.map((r) => { const h = (w - r.gaps) / r.total; return { h, widths: r.part.map((a) => a * h) }; });
  return { w, h: tallAt(w), rows: sized, area: sized.reduce((t, r) => t + r.widths.reduce((u, v) => u + v * r.h, 0), 0) };
}

// The way of cutting these into rows that shows the most picture in W×H. The number of rows tried is around the even one.
function bestRuns(aspects, W, H, gap) {
  const n = aspects.length, even = Math.sqrt((aspects.reduce((t, v) => t + v, 0) * H) / W);
  let best = null;
  for (let k = Math.max(1, Math.floor(even / 2)); k <= Math.min(n, Math.ceil(even * 2)); k++) {
    const runs = splitRuns(aspects, k), got = sizeRuns(aspects, runs, W, H, gap);
    if (got && (!best || got.area > best.got.area * (1 + 1e-6))) best = { runs, got };
  }
  return best;
}

// { cols, rows, cells, order }, as gridPlan. `cols` asks for about that many in a row; Auto also tries
// columns, which fit a mix like one tall picture beside two wide ones. With `fill`, the cells stretch to reach all of the canvas
// (for a crop to make up the difference). With no fixed canvas, the pictures keep about the area they have and make the squarest sheet.
export function densePlan(items, { frame = null, origin = { x: 0, y: 0 }, cols = 0, gap = 0, fill = false, order = readingOrder(items) } = {}) {
  const n = items.length, aspects = order.map((k) => items[k].w / items[k].h);
  const wanted = Math.sqrt(items.reduce((t, it) => t + it.w * it.h * it.scale * it.scale, 0));
  const W = frame ? frame.w : wanted, H = frame ? frame.h : wanted;
  const asked = cols > 0 ? splitRuns(aspects, Math.ceil(n / Math.min(n, cols))) : null;
  const flipped = aspects.map((a) => 1 / a);
  const across = asked ? { runs: asked, got: sizeRuns(aspects, asked, W, H, gap) } : bestRuns(aspects, W, H, gap);
  const down = asked ? null : bestRuns(flipped, H, W, gap);
  const turned = !!down && (!across?.got || down.got.area > across.got.area * 1.02);
  const pick = turned ? down : across, parts = turned ? flipped : aspects;
  const [fw, fh] = turned ? [H, W] : [W, H];
  let plan = pick?.got || sizeRuns(parts, [[0, n]], fw, fh, 0);
  // (a gap too big for the canvas: touching is the closest there is)
  const g = pick?.got ? gap : 0;
  if (!frame) { const k = wanted / Math.sqrt(plan.area); plan = sizeRuns(parts, pick?.got ? pick.runs : [[0, n]], fw * k, fh * k, g) || plan; }
  if (frame && fill) {
    const rowsH = plan.rows.reduce((t, r) => t + r.h, 0), roomH = fh - g * (plan.rows.length - 1);
    plan = { ...plan, w: fw, h: fh, rows: plan.rows.map((r) => {
      const wide = r.widths.reduce((t, v) => t + v, 0), roomW = fw - g * (r.widths.length - 1);
      return { h: (r.h * roomH) / rowsH, widths: r.widths.map((v) => (v * roomW) / wide) };
    }) };
  }
  const left0 = frame ? (fw - plan.w) / 2 : 0, top0 = frame ? (fh - plan.h) / 2 : 0, from = frame || origin;
  const cells = new Array(n);
  let top = top0, k = 0;
  for (const row of plan.rows) {
    let left = left0;
    for (const v of row.widths) {
      const a = Math.round(left), b = Math.round(top), c = Math.max(1, Math.round(left + v) - a), d = Math.max(1, Math.round(top + row.h) - b);
      cells[order[k++]] = turned ? { x: from.x + b, y: from.y + a, w: d, h: c } : { x: from.x + a, y: from.y + b, w: c, h: d };
      left += v + g;
    }
    top += row.h + g;
  }
  const most = Math.max(...plan.rows.map((r) => r.widths.length));
  return turned ? { cols: plan.rows.length, rows: most, cells, order } : { cols: most, rows: plan.rows.length, cells, order };
}

// What a layer changes to stand in a cell, its centre on the cell's: whole inside it, or filling it with a crop around the middle of `base`.
// `snug`: a dense cell, already the picture's shape but for rounding: covers it, so no hairline shows between pictures that touch.
export function fitToCell(l, base, cell, cropOn, snug = false) {
  const [W, H] = size(l), cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2, w = base.w * W, h = base.h * H;
  if (!cropOn) {
    const a = ((l.rotation || 0) * Math.PI) / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const bw = cell.w / (w * cos + h * sin), bh = cell.h / (w * sin + h * cos), s = snug ? Math.max(bw, bh) : Math.min(bw, bh);
    if (snug) return { crop: { ...base }, scale: s, x: cx - (w * s) / 2, y: cy - (h * s) / 2 };
    return { crop: { ...base }, scale: s, x: Math.round(cx - (w * s) / 2), y: Math.round(cy - (h * s) / 2) };
  }
  const q = quarter(l.rotation), side = odd(l.rotation), sw = side ? h : w, sh = side ? w : h;
  const s = Math.max(cell.w / sw, cell.h / sh);
  const vw = Math.min(w, (side ? cell.h : cell.w) / s), vh = Math.min(h, (side ? cell.w : cell.h) / s);
  const crop = { x: base.x + (w - vw) / 2 / W, y: base.y + (h - vh) / 2 / H, w: vw / W, h: vh / H };
  return { crop, scale: s, x: cx - (vw * s) / 2, y: cy - (vh * s) / 2, ...((l.rotation || 0) % 90 ? { rotation: q } : {}) };
}
