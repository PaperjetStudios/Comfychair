// The Image tab's Grid (web/layer-grid.js): which cells, what a crop keeps and that a layer ends up exactly in its cell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestCols, fitToCell, gridItem, gridPlan, readingOrder } from '../web/layer-grid.js';
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
