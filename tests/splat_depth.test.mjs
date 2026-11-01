// node --test tests/splat_depth.test.mjs: a depth picture's dots and blur (web/splat-depth.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blurTaps, cloudArrays, splatBlurOf, SPLAT_BLUR } from '../web/splat-depth.js';

const fake = (list) => ({
  numSplats: list.length,
  forEachSplat(fn) { list.forEach((s, i) => fn(i, { x: s.at[0], y: s.at[1], z: s.at[2] }, { x: s.s[0], y: s.s[1], z: s.s[2] }, null, s.o)); },
});

test('a dot per visible splat, at its centre; haze is left out', () => {
  const { pos, size } = cloudArrays(fake([{ at: [1, 2, 3], s: [1, 1, 1], o: 1 }, { at: [9, 9, 9], s: [1, 1, 1], o: 0.05 }, { at: [4, 5, 6], s: [2, 2, 2], o: 0.5 }]));
  assert.deepEqual([...pos], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...size], [1, 2]);
});

test('a dot is the size of the splat\'s middle axis: a flat disc keeps its width, a needle stays small', () => {
  const size = (s) => cloudArrays(fake([{ at: [0, 0, 0], s, o: 1 }])).size[0];
  assert.equal(size([4, 4, 0.5]), 4);
  assert.equal(size([0.5, 0.5, 4]), 0.5);
  assert.equal(size([0.5, 4, 0.5]), 0.5);
});

test('an empty set is fine', () => {
  const { pos, size } = cloudArrays({ numSplats: 0, forEachSplat() {} });
  assert.equal(pos.length, 0); assert.equal(size.length, 0);
});

test('the blur keeps its brightness and is even both ways', () => {
  const t = blurTaps();
  assert.ok(Math.abs(t.reduce((a, [, w]) => a + w, 0) - 1) < 1e-9);
  t.forEach(([o, w], i) => { const [o2, w2] = t[t.length - 1 - i]; assert.ok(Math.abs(o + o2) < 1e-9); assert.ok(Math.abs(w - w2) < 1e-9); });
  assert.equal(t.length, 17);
});

test('Splat blur is a share of the height, so the view and a render at another size match', () => {
  assert.equal(splatBlurOf({ height: 448, splatBlur: 4 }), 4 / 448);
  assert.equal(splatBlurOf({ height: 448 }), SPLAT_BLUR / 448);
  assert.equal(splatBlurOf({ height: 448, splatBlur: 0 }), 0);
});
