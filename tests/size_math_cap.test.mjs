import test from 'node:test';
import assert from 'node:assert/strict';
import { capSize } from '../web/size-math.js';

test('capSize: under the limit, the shape kept, sides snapped down; never bigger; 0 keeps its size', () => {
  const big = capSize(5184, 2512, 1);
  assert.ok(big.w * big.h <= 1e6);
  assert.equal(big.w % 16, 0);
  assert.ok(Math.abs(big.w / big.h - 5184 / 2512) < 0.05);
  assert.deepEqual(capSize(800, 600, 4), { w: 800, h: 592 });
  assert.deepEqual(capSize(5184, 2512, 0), { w: 5184, h: 2512 });
});
