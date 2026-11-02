// node --test tests/mp_cap.test.mjs: the largest size of a picked picture (web/mp-cap.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capLabel, cappedSize } from '../web/mp-cap.js';

test('a bigger picture comes down to the cap, in its own shape', () => {
  const [w, h] = cappedSize(4032, 3024, 4);
  assert.ok(w * h <= 4e6 && w * h > 3.99e6);
  assert.ok(Math.abs(w / h - 4 / 3) < 0.002);
});
test('a smaller one, or Full, stays as it is', () => {
  assert.deepEqual(cappedSize(800, 600, 4), [800, 600]);
  assert.deepEqual(cappedSize(4032, 3024, 0), [4032, 3024]);
});
test('the label says what it will become, only when it changes', () => {
  assert.equal(capLabel(800, 600, 4), '800×600 · 0.5 MP');
  assert.equal(capLabel(4000, 3000, 4), '4000×3000 · 12 MP → 2309×1732 · 4 MP');
});
