// node --test tests/key_lanes.test.mjs: the keyframe lanes' rules (web/key-lane-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shownKeys, keyTime, keyX, fAtX, selKey, isSel, pickKey, remapSel, moveRange, clampShift, movedF, boxKeys,
  compatible, pastePlan, mergeKeys, fmtValue, keyTitle,
} from '../web/key-lane-rules.js';

const K = (...fs) => fs.map((f) => ({ f, v: f }));
const it = { id: 'c1', at: 10, in: 2 };

test('shown keys: only those inside the trim window', () => {
  const keys = K(0, 2, 3, 5, 6);
  assert.deepEqual(shownKeys(keys, 2, 3).map((k) => k.f), [2, 3, 5]);
  assert.deepEqual(shownKeys(undefined, 2, 3), []);
});

test('key time and x: it.at + f - it.in, and back', () => {
  assert.equal(keyTime(it, 3), 11);
  assert.equal(keyX(it, 3, 50), 550);
  assert.equal(fAtX(it, 550, 50), 3);
});

test('selection: alone, toggle, and it follows keys through a move', () => {
  let s = pickKey(new Set(), 'c1', 'opacity', 1, false);
  s = pickKey(s, 'c1', 'opacity', 2, true);
  assert.ok(isSel(s, 'c1', 'opacity', 1) && isSel(s, 'c1', 'opacity', 2));
  assert.ok(!isSel(s, 'c2', 'opacity', 1));
  assert.deepEqual([...pickKey(s, 'c1', 'opacity', 1, true)], [selKey('c1', 'opacity', 2)]);
  assert.deepEqual([...pickKey(s, 'c1', 'opacity', 9, false)], [selKey('c1', 'opacity', 9)]);
  const m = remapSel(new Set([...s, selKey('c1', 'scale', 1)]), 'c1', 'opacity', [[1, 1.5], [2, 2.5]]);
  assert.ok(isSel(m, 'c1', 'opacity', 1.5) && isSel(m, 'c1', 'opacity', 2.5) && isSel(m, 'c1', 'scale', 1));
  assert.ok(!isSel(m, 'c1', 'opacity', 1));
});

test('move range: inside the shown ends and one frame short of an unselected neighbour', () => {
  const keys = K(1, 2, 4, 6), o = { lo: 0, hi: 7, fps: 10 };
  const sel = (...fs) => (k) => fs.includes(k.f);
  const [mn, mx] = moveRange(keys, sel(2, 4), o);
  assert.ok(Math.abs(mn - -0.9) < 1e-9);   // key 2 stops a frame after key 1
  assert.ok(Math.abs(mx - 1.9) < 1e-9);    // key 4 stops a frame before key 6
  const [a, b] = moveRange(keys, sel(1, 2, 4, 6), o);
  assert.equal(a, -1);                     // all selected: only the ends hold
  assert.equal(b, 1);
});

test('clamp shift: on the fps grid, inside the range, a key never passes its neighbour', () => {
  const g = { fps: 10, grid: true };
  assert.equal(clampShift(0.34, [-1, 1], g), 0.3);
  assert.equal(clampShift(5, [-1, 0.95], g), 0.9);
  assert.equal(clampShift(-5, [-0.95, 1], g), -0.9);
  assert.equal(clampShift(0.34, [-1, 1], { fps: 10, grid: false }), 0.34);
  assert.equal(clampShift(0.34, [0, 0], g), 0);
});

test('moved f: rounds to a frame, stays inside the clip', () => {
  const o = { lo: 2, hi: 5, fps: 10, grid: true };
  assert.equal(movedF(3.03, 0.3, o), 3.3);
  assert.equal(movedF(3, 9, o), 5);
  assert.equal(movedF(3, -9, o), 2);
  assert.equal(movedF(3, 0.034, { ...o, grid: false }), 3.034);
});

test('box select: keys whose diamond touches the box, in one row', () => {
  const keys = K(2, 3, 4, 5);   // x = (10 + f - 2) * 100
  assert.deepEqual(boxKeys(keys, it, 100, 1090, 1210, 0).map((k) => k.f), [3, 4]);
  assert.deepEqual(boxKeys(keys, it, 100, 1210, 1090, 0).map((k) => k.f), [3, 4]);
  assert.deepEqual(boxKeys(keys, it, 100, 1000, 1000, 5).map((k) => k.f), [2]);
});

test('paste: first key at t on the grid, spacing kept, outside keys dropped, same frame replaced', () => {
  const src = [{ f: 1, v: 0.1, ease: 'in' }, { f: 1.5, v: 0.2 }, { f: 3, v: 0.3 }];
  const { keys, dropped } = pastePlan(src, 2.04, { lo: 2, hi: 4, fps: 10 });
  assert.deepEqual(keys.map((k) => k.f), [2, 2.5, 4]);
  assert.equal(keys[0].ease, 'in');
  assert.equal(dropped, 0);
  const cut = pastePlan(src, 3, { lo: 2, hi: 4, fps: 10 });
  assert.deepEqual(cut.keys.map((k) => k.f), [3, 3.5]);
  assert.equal(cut.dropped, 1);
  keys[0].v = 9;
  assert.equal(src[0].v, 0.1);   // (a deep copy)
  assert.deepEqual(mergeKeys(K(2, 3), [{ f: 2, v: 'n' }, { f: 2.5, v: 'm' }]).map((k) => [k.f, k.v]), [[2, 'n'], [2.5, 'm'], [3, 3]]);
});

test('paste only onto a channel of the same kind of value', () => {
  assert.ok(compatible([{ f: 0, v: 1 }], [{ f: 0, v: 2 }]));
  assert.ok(!compatible([{ f: 0, v: [1, 2] }], [{ f: 0, v: 2 }]));
  assert.ok(compatible([{ f: 0, v: [1, 2] }], [{ f: 0, v: [3, 4] }]));
  assert.ok(!compatible([{ f: 0, v: [1, 2] }], [{ f: 0, v: [3, 4, 5] }]));
  assert.ok(!compatible([], [{ f: 0, v: 1 }]));
});

test('titles', () => {
  assert.equal(fmtValue(0.5), '0.50');
  assert.equal(fmtValue([1, 0.256]), '1.00, 0.26');
  assert.equal(keyTitle('Opacity', { v: 0.5 }, 72, (t) => `0:01:${t - 60}`), 'Opacity 0.50 at 0:01:12');
});
