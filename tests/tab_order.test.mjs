import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, slideOf } from '../web/tab-order.js';

// two rows of three, 100 wide and 40 tall, gap 10
const rects = [0, 1, 2, 3, 4, 5].map((i) => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 50, w: 100, h: 40 }));

test('along a row: past a chip\'s middle takes its place', () => {
  assert.equal(dropIndex(rects, 0, 40, 20), 0);
  assert.equal(dropIndex(rects, 0, 170, 20), 1);
  assert.equal(dropIndex(rects, 0, 280, 20), 2);
});
test('to the row below, and back up', () => {
  assert.equal(dropIndex(rects, 0, 40, 70), 2);   // (before the first chip of row 2: the rest of row 1 is before it)
  assert.equal(dropIndex(rects, 0, 170, 70), 4);   // (past the middle of the first two of row 2)
  assert.equal(dropIndex(rects, 5, 170, 20), 2);
});
test('below every row is the end, above them the start', () => {
  assert.equal(dropIndex(rects, 0, 10, 500), 5);
  assert.equal(dropIndex(rects, 3, 300, -20), 0);
});
test('chips between make room, across a row\'s end too', () => {
  assert.deepEqual(slideOf(rects, 0, 3, 1), [-110, 0]);
  assert.deepEqual(slideOf(rects, 0, 3, 3), [220, -50]);   // (first of row 2 to the end of row 1)
  assert.equal(slideOf(rects, 0, 3, 4), null);
  assert.deepEqual(slideOf(rects, 5, 2, 2), [-220, 50]);
  assert.equal(slideOf(rects, 2, 2, 1), null);
});
