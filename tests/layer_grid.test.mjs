// The Image tab's Grid (web/layer-grid.js): which cells, what a crop keeps and that a layer ends up exactly in its cell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestCols, densePlan, fitToCell, gridItem, gridPlan, readingOrder } from '../web/layer-grid.js';
import * as G from '../web/layer-geom.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const layer = (w, h, o = {}) => ({ w, h, crop: { ...FULL }, x: 0, y: 0, scale: 1, ...o });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const plan = (ls, opts, cropOn = false) => gridPlan(ls.map((l) => gridItem(l, l.crop, cropOn)), opts);

test('auto columns follow the pictures and the canvas', () => {
  const square = Array.from({ length: 4 }, () => layer(100, 100));
  assert.equal(plan(square, { frame: { x: 0, y: 0, w: 1000, h: 1000 } }).cols, 2);
  const wide = Array.from({ length: 3 }, () => layer(300, 100));
  assert.equal(plan(wide, { frame: { x: 0, y: 0, w: 1000, h: 1000 } }).cols, 1, 'wide pictures stack');
  const tall = Array.from({ length: 3 }, () => layer(100, 300));
  assert.equal(plan(tall, { frame: { x: 0, y: 0, w: 1000, h: 1000 } }).cols, 3, 'tall pictures sit side by side');
  assert.equal(plan(square, {}).cols, 2, 'with no fixed canvas, the squarest sheet');
  assert.equal(bestCols(square.map((l) => gridItem(l, FULL)), { frame: { x: 0, y: 0, w: 100, h: 1000 }, gap: 120 }), 1, 'a gap too big for the columns');
});

test('cells are whole pixels that fill the canvas, with the gap', () => {
  const ls = Array.from({ length: 3 }, (_, i) => layer(100, 100, { x: i * 200 }));
  const { cells } = plan(ls, { frame: { x: 0, y: 0, w: 100, h: 50 }, cols: 3 });
  assert.deepEqual(cells.map((c) => [c.x, c.w]), [[0, 33], [33, 34], [67, 33]]);
  const gapped = plan(ls, { frame: { x: 0, y: 0, w: 320, h: 100 }, cols: 3, gap: 10 }).cells;
  assert.deepEqual(gapped.map((c) => [c.x, c.w]), [[0, 100], [110, 100], [220, 100]]);
});

test('a short last row is centred', () => {
  const ls = Array.from({ length: 3 }, (_, i) => layer(100, 100, { x: i * 200 }));
  const { cells, rows } = plan(ls, { frame: { x: 0, y: 0, w: 200, h: 200 }, cols: 2 });
  assert.equal(rows, 2);
  assert.deepEqual(cells[2], { x: 50, y: 100, w: 100, h: 100 });
});

test('reading order comes from the canvas; a pile keeps the order given', () => {
  const at = (x, y) => ({ box: { x, y, w: 100, h: 100 } });
  assert.deepEqual(readingOrder([at(300, 10), at(0, 300), at(0, 0), at(310, 290)]), [2, 0, 1, 3]);
  assert.deepEqual(readingOrder([at(5, 5), at(5, 5), at(5, 5)]), [0, 1, 2]);
});

test('crop off: the whole picture, inside its cell and centred', () => {
  const l = layer(200, 100, { crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
  Object.assign(l, fitToCell(l, l.crop, { x: 100, y: 100, w: 400, h: 200 }, false));
  assert.deepEqual(l.crop, { x: 0.25, y: 0, w: 0.5, h: 1 }, 'its own crop stays');
  assert.deepEqual(G.bounds(l), { x: 200, y: 100, w: 200, h: 200 });
});

test('crop off: a turned picture\'s box fits the cell', () => {
  const l = layer(200, 100, { rotation: 90 });
  Object.assign(l, fitToCell(l, l.crop, { x: 0, y: 0, w: 100, h: 100 }, false));
  const b = G.bounds(l);
  near(b.h, 100, 'height'); near(b.w, 50, 'width'); near(b.x, 25, 'x'); near(b.y, 0, 'y');
});

test('crop on: fills the cell exactly, around the middle of its own crop', () => {
  const l = layer(400, 200, { x: 7, y: 9 });
  Object.assign(l, fitToCell(l, l.crop, { x: 10, y: 20, w: 100, h: 100 }, true));
  assert.deepEqual(G.layerRect(l), { x: 10, y: 20, w: 100, h: 100 });
  near(l.crop.x, 0.25, 'crop x'); near(l.crop.w, 0.5, 'crop w'); near(l.crop.h, 1, 'crop h');
  const base = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.deepEqual(fitToCell(layer(400, 200), base, { x: 0, y: 0, w: 100, h: 100 }, true).crop, { x: 0.5, y: 0, w: 0.5, h: 1 }, 'stays inside the crop');
});

test('crop on: a quarter turn fills the cell; an angle is straightened', () => {
  const side = layer(400, 200, { rotation: 90 });
  Object.assign(side, fitToCell(side, side.crop, { x: 0, y: 0, w: 100, h: 300 }, true));
  const b = G.bounds(side);
  near(b.x, 0, 'x'); near(b.y, 0, 'y'); near(b.w, 100, 'w'); near(b.h, 300, 'h');
  assert.equal(fitToCell(layer(400, 200, { rotation: 80 }), FULL, { x: 0, y: 0, w: 100, h: 100 }, true).rotation, 90);
  assert.equal(fitToCell(layer(400, 200, { rotation: -20 }), FULL, { x: 0, y: 0, w: 100, h: 100 }, true).rotation, 0);
});

const dense = (ls, opts, cropOn = false) => densePlan(ls.map((l) => gridItem(l, l.crop, cropOn)), opts);
const inRow = (n, w, h) => Array.from({ length: n }, (_, i) => layer(w, h, { x: i * 2000 }));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noOverlaps = (cells) => cells.forEach((a, i) => cells.slice(i + 1).forEach((b) => assert.ok(!overlaps(a, b), `${JSON.stringify(a)} ${JSON.stringify(b)}`)));

test('dense: wide pictures on a square canvas touch, where equal cells would leave space', () => {
  const ls = inRow(4, 300, 100), frame = { x: 0, y: 0, w: 1000, h: 1000 };
  const { cells } = dense(ls, { frame });
  noOverlaps(cells);
  for (const c of cells) assert.ok(Math.abs(c.w / c.h - 3) < 0.02, `own shape: ${c.w}×${c.h}`);
  const shown = cells.reduce((t, c) => t + c.w * c.h, 0);
  const equal = plan(ls, { frame, cols: 2 }).cells.reduce((t, c) => { const s = Math.min(c.w / 300, c.h / 100); return t + 300 * s * 100 * s; }, 0);
  assert.ok(shown > equal * 1.3, `${shown} against ${equal}`);
});

test('dense: mixed shapes share a row with no space, spanning the canvas', () => {
  const ls = [layer(200, 100, { x: 0 }), layer(100, 100, { x: 2000 }), layer(100, 200, { x: 4000 })];
  const { cells, rows } = dense(ls, { frame: { x: 0, y: 0, w: 350, h: 100 } });
  assert.equal(rows, 1);
  assert.deepEqual(cells.map((c) => [c.x, c.y, c.w, c.h]), [[0, 0, 200, 100], [200, 0, 100, 100], [300, 0, 50, 100]]);
});

test('dense: the gap is exactly the space between pictures', () => {
  const { cells } = dense(inRow(3, 100, 100), { frame: { x: 10, y: 20, w: 320, h: 100 }, gap: 10, cols: 3 });
  assert.deepEqual(cells.map((c) => [c.x, c.y, c.w, c.h]), [[10, 20, 100, 100], [120, 20, 100, 100], [230, 20, 100, 100]]);
});

test('dense: what is left of the canvas is split evenly around the sheet', () => {
  const { cells } = dense(inRow(2, 100, 100), { frame: { x: 0, y: 0, w: 1000, h: 300 }, cols: 2 });
  assert.deepEqual(cells.map((c) => [c.x, c.y, c.w, c.h]), [[200, 0, 300, 300], [500, 0, 300, 300]]);
});

test('dense: a number asks for about that many in a row, in reading order', () => {
  const { cells, rows, cols } = dense(inRow(6, 100, 100), { frame: { x: 0, y: 0, w: 900, h: 900 }, cols: 3 });
  assert.equal(rows, 2); assert.equal(cols, 3);
  assert.deepEqual(cells.map((c) => c.x), [0, 300, 600, 0, 300, 600]);
  assert.deepEqual(cells.map((c) => c.y), [150, 150, 150, 450, 450, 450]);
});

test('dense: one tall beside two wide fills the canvas, as columns', () => {
  const ls = [layer(100, 200, { x: 0, y: 0 }), layer(200, 100, { x: 300, y: 0 }), layer(200, 100, { x: 300, y: 120 })];
  const { cells } = dense(ls, { frame: { x: 0, y: 0, w: 300, h: 200 } });
  assert.deepEqual(cells.map((c) => [c.x, c.y, c.w, c.h]), [[0, 0, 100, 200], [100, 0, 200, 100], [100, 100, 200, 100]]);
});

test('dense with no fixed canvas: starts at the origin, about the same picture area, a squarish sheet', () => {
  const ls = inRow(4, 100, 100);
  const { cells } = dense(ls, { origin: { x: 50, y: 60 } });
  assert.deepEqual(cells.map((c) => [c.x, c.y, c.w, c.h]), [[50, 60, 100, 100], [150, 60, 100, 100], [50, 160, 100, 100], [150, 160, 100, 100]]);
});

test('dense: a gap too big for the canvas falls back to touching', () => {
  const { cells } = dense(inRow(3, 100, 100), { frame: { x: 0, y: 0, w: 100, h: 100 }, gap: 500, cols: 3 });
  assert.equal(cells.length, 3);
  noOverlaps(cells);
  for (const c of cells) assert.ok(c.w >= 1 && c.h >= 1);
});

test('dense crop on: the cells reach every edge of the canvas', () => {
  const ls = [layer(300, 100, { x: 0 }), layer(100, 100, { x: 2000 }), layer(100, 300, { x: 4000 })], frame = { x: 0, y: 0, w: 800, h: 600 };
  const { cells } = dense(ls, { frame, fill: true }, true);
  noOverlaps(cells);
  assert.equal(Math.min(...cells.map((c) => c.x)), 0); assert.equal(Math.min(...cells.map((c) => c.y)), 0);
  assert.equal(Math.max(...cells.map((c) => c.x + c.w)), 800); assert.equal(Math.max(...cells.map((c) => c.y + c.h)), 600);
  assert.equal(cells.reduce((t, c) => t + c.w * c.h, 0), 800 * 600);
});

test('dense: every layer ends up covering its cell whole, with no hairline', () => {
  const ls = [layer(317, 211, { x: 0 }), layer(211, 317, { x: 2000 }), layer(500, 123, { x: 4000 }), layer(123, 123, { x: 6000 })];
  const { cells } = dense(ls, { frame: { x: 0, y: 0, w: 1001, h: 777 } });
  ls.forEach((l, i) => {
    const before = { ...l.crop };
    Object.assign(l, fitToCell(l, l.crop, cells[i], false, true));
    const b = G.bounds(l), c = cells[i];
    assert.deepEqual(l.crop, before, 'nothing cut');
    assert.ok(b.x <= c.x + 1e-6 && b.y <= c.y + 1e-6 && b.x + b.w >= c.x + c.w - 1e-6 && b.y + b.h >= c.y + c.h - 1e-6, `${JSON.stringify(b)} covers ${JSON.stringify(c)}`);
    assert.ok(b.w - c.w < 2 && b.h - c.h < 2, `${JSON.stringify(b)} no more than rounding past ${JSON.stringify(c)}`);
  });
});

test('a given order replaces the reading order, so another grid does not shuffle', () => {
  const ls = inRow(3, 100, 100), frame = { x: 0, y: 0, w: 300, h: 100 };
  for (const make of [dense, plan]) {
    const { cells, order } = make(ls, { frame, cols: 3, order: [2, 0, 1] });
    assert.deepEqual(order, [2, 0, 1]);
    assert.deepEqual(cells.map((c) => c.x), [100, 200, 0]);
  }
  const ms = [layer(100, 200), layer(200, 100, { x: 300 }), layer(200, 100, { x: 300, y: 120 })];
  const f = { x: 0, y: 0, w: 300, h: 200 }, first = dense(ms, { frame: f });
  ms.forEach((l, i) => Object.assign(l, fitToCell(l, l.crop, first.cells[i], false, true)));
  assert.deepEqual(dense(ms, { frame: f, order: first.order }).cells, first.cells);
});
