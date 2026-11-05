// node --test tests/size_math.test.mjs: picture sizes from proportions and megapixels (web/size-math.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { presetSize, nearestAspect, modeOf, snapSide } from '../web/size-math.js';

const P = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3]];

test('presetSize: about mp megapixels, sides on the step', () => {
  assert.deepEqual(presetSize(1, 1, 16), { w: 1008, h: 1008 });
  const s = presetSize(16 / 9, 1, 16);
  assert.equal(s.w % 16, 0); assert.equal(s.h % 16, 0);
  assert.ok(Math.abs(s.w * s.h / 1e6 - 1) < 0.05);
  // a limit keeps each side in range
  assert.deepEqual(presetSize(1, 16, 16, (n) => Math.min(2048, n)), { w: 2048, h: 2048 });
});

test('nearestAspect and modeOf', () => {
  assert.equal(nearestAspect(1920, 1080, P), '16:9');
  assert.equal(nearestAspect(1000, 1010, P), '1:1');
  assert.equal(nearestAspect(1000, 300, P), 'custom');
  assert.deepEqual(modeOf(1024, 1024, P), { aspect: '1:1', mp: 1.05 });
});

test('snapSide: on the step, in range', () => {
  assert.equal(snapSide(1000, 16), 1008);
  assert.equal(snapSide(3, 16), 16);
  assert.equal(snapSide(9000, 16, 16, 8192), 8192);
  assert.equal(snapSide(NaN, 16), 16);
});
