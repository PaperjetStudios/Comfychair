// node --test tests/snap_math.test.mjs: the snapping maths the viewers and the table share (web/snap-math.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapNearest, snapStep } from '../web/snap-math.js';
import * as TM from '../web/table-model.js';

test('snapStep rounds to the nearest multiple', () => {
  assert.equal(snapStep(13, 10), 10);
  assert.equal(snapStep(15, 10), 20);
  assert.equal(snapStep(-14, 10), -10);
  assert.equal(snapStep(0.26, 0.25), 0.25);
});
test('snapNearest picks the smallest shift within the threshold', () => {
  assert.deepEqual(snapNearest([10], [12, 8, 100], 3), { d: 2, at: 12 });
  assert.deepEqual(snapNearest([10, 50], [53, 11], 4), { d: 1, at: 11 });
  assert.equal(snapNearest([10], [20], 3), null);
  assert.equal(snapNearest([], [1], 3), null);
  assert.equal(snapNearest([5], [], 3), null);
});
test('the table model re-exports the same functions', () => {
  assert.equal(TM.snapNearest, snapNearest);
  assert.equal(TM.snapStep, snapStep);
});
