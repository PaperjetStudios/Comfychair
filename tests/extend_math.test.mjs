import assert from 'node:assert/strict';
import test from 'node:test';
import { NONE, any, bothSides, grownSize, newParts, overlapOf, toShape } from '../web/extend-math.js';

test('the grown size adds each side', () => {
  assert.deepEqual(grownSize(1024, 768, { l: 8, r: 16, t: 0, b: 32 }), { w: 1048, h: 800 });
  assert.deepEqual(grownSize(100, 50, NONE), { w: 100, h: 50 });
  assert.equal(any(NONE), false);
  assert.equal(any({ l: 0, r: 0, t: 8, b: 0 }), true);
});

test('both sides grow by a share of the longer side, a multiple of 8', () => {
  assert.deepEqual(bothSides(1024, 768, 0.25), { l: 256, r: 256, t: 256, b: 256 });
  const d = bothSides(1000, 600, 0.125);
  assert.equal(d.l % 8, 0);
  assert.equal(d.l, 128);
});

test('to a shape: the shorter way grows, split evenly', () => {
  const wide = toShape(1024, 1024, 16 / 9);
  assert.equal(wide.t, 0); assert.equal(wide.b, 0);
  assert.equal(wide.l, wide.r);
  const g = grownSize(1024, 1024, wide);
  assert.ok(Math.abs(g.w / g.h - 16 / 9) < 0.02, `${g.w}×${g.h} is about 16:9`);
  const tall = toShape(1920, 1080, 1);
  assert.equal(tall.l, 0);
  assert.equal(tall.t, tall.b);
  assert.ok(Math.abs(grownSize(1920, 1080, tall).h - 1920) <= 16, 'about square');
  assert.deepEqual(toShape(1024, 1024, 0), NONE);
});

test('the new parts reach into the old picture by the overlap', () => {
  const o = overlapOf(1000, 500, 0.04);
  assert.equal(o, 40);
  const rects = newParts(1000, 500, { l: 100, r: 0, t: 0, b: 50 }, o);
  assert.deepEqual(rects, [{ x: 0, y: 0, w: 140, h: 550 }, { x: 0, y: 460, w: 1100, h: 90 }]);
  assert.deepEqual(newParts(10, 10, NONE, 2), []);
});
