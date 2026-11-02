// node --test tests/mask_spread.test.mjs: dilate and erode a mask (web/mask-spread.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPREAD_MAX, distanceField, spreadInto, spreadLabel } from '../web/mask-spread.js';

const W = 300, H = 200;
const square = (x0, y0, x1, y1) => { const a = new Uint8Array(W * H); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * W + x] = 255; return a; };
const count = (a) => a.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
const at = (a, x, y) => a[y * W + x];

test('dilate grows it by r all round, with round corners; erode shrinks it', () => {
  const f = distanceField(square(100, 80, 200, 120), W, H), a = new Uint8Array(W * H);
  spreadInto(f, 10, a, W);
  assert.ok(at(a, 91, 100) > 127 && at(a, 88, 100) < 128, 'left');
  assert.ok(at(a, 208, 100) > 127 && at(a, 211, 100) < 128, 'right');
  assert.ok(at(a, 150, 71) > 127 && at(a, 150, 68) < 128, 'top');
  assert.equal(at(a, 91, 71), 0, 'a round corner');
  spreadInto(f, -10, a, W);
  assert.ok(at(a, 112, 100) > 127 && at(a, 108, 100) < 128, 'eroded left');
  assert.ok(at(a, 150, 92) > 127 && at(a, 150, 88) < 128, 'eroded top');
  assert.ok(Math.abs(count(a) - 80 * 20) < 80, 'its area');
});
test('nothing marked gives nothing; none is the mask as it was', () => {
  assert.equal(distanceField(new Uint8Array(W * H), W, H), null);
  const s = square(50, 50, 90, 90), a = new Uint8Array(W * H);
  spreadInto(distanceField(s, W, H), 0, a, W);
  assert.deepEqual(a, s);
});
test('eroding enough takes it away', () => {
  const a = new Uint8Array(W * H);
  spreadInto(distanceField(square(50, 50, 90, 90), W, H), -25, a, W);
  assert.equal(count(a), 0);
});
test('the picture\'s edge is no edge of the mask: one reaching it stays there, and a full one stays full', () => {
  const a = new Uint8Array(W * H);
  spreadInto(distanceField(square(0, 0, 40, H), W, H), -10, a, W);
  assert.ok(at(a, 0, 100) > 127 && at(a, 28, 100) > 127 && at(a, 32, 100) < 128);
  spreadInto(distanceField(square(0, 0, W, H), W, H), -50, a, W);
  assert.equal(count(a), W * H);
});
test('as far as the slider goes, into RGBA, and a soft stroke counts as mask', () => {
  const s = new Uint8Array(W * H);
  s[100 * W + 150] = 10;
  const rgba = new Uint8ClampedArray(W * H * 4);
  spreadInto(distanceField(s, W, H), SPREAD_MAX, rgba, W, { stride: 4, offset: 3 });
  assert.ok(rgba[(100 * W + 150 + 90) * 4 + 3] > 127);
  assert.equal(rgba[(100 * W + 150) * 4], 0, 'only the alpha is written');
});
test('the slider\'s words', () => {
  assert.equal(spreadLabel(0), 'None');
  assert.equal(spreadLabel(8), 'Dilate 8 px');
  assert.equal(spreadLabel(-4), 'Erode 4 px');
});
