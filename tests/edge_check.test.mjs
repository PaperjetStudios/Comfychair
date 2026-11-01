// node --test tests/edge_check.test.mjs: telling a subject that fits from one the picture's edge cuts off
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutEdges, edgeWords } from '../web/edge-check.js';

// a w×h picture; paint(x, y) gives [r, g, b, a]
function pic(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(paint(x, y), (y * w + x) * 4);
  return d;
}
const inBox = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
const cutout = (x0, y0, x1, y1) => pic(100, 200, (x, y) => (inBox(x, y, x0, y0, x1, y1) ? [200, 150, 100, 255] : [0, 0, 0, 0]));
const studio = (x0, y0, x1, y1, grey = (y) => 200 - y / 4) => pic(100, 200, (x, y) => (inBox(x, y, x0, y0, x1, y1) ? [40, 30, 90, 255] : [grey(y), grey(y), grey(y), 255]));

test('a cut-out', () => {
  assert.deepEqual(cutEdges(cutout(30, 20, 70, 180), 100, 200), []);
  assert.deepEqual(cutEdges(cutout(30, 0, 70, 180), 100, 200), ['top']);
  assert.deepEqual(cutEdges(cutout(30, 0, 70, 200), 100, 200), ['top', 'bottom']);
  assert.deepEqual(cutEdges(cutout(0, 20, 70, 180), 100, 200), ['left']);
});
test('a stray hair at the edge is no cut', () => {
  const d = pic(100, 200, (x, y) => (inBox(x, y, 30, 20, 70, 180) || inBox(x, y, 50, 0, 51, 20) ? [9, 9, 9, 255] : [0, 0, 0, 0]));
  assert.deepEqual(cutEdges(d, 100, 200), []);
});
test('an opaque picture gets no verdict: a vignette looks like a subject', () => {
  assert.deepEqual(cutEdges(studio(30, 0, 70, 200), 100, 200), []);
  assert.deepEqual(cutEdges(pic(100, 200, (x, y) => (x < 50 ? [250, 20, 20, 255] : [20, 20, 250, 255])), 100, 200), []);
});
test('the words', () => {
  assert.equal(edgeWords(['top']), 'the top');
  assert.equal(edgeWords(['top', 'bottom']), 'the top and the bottom');
});
