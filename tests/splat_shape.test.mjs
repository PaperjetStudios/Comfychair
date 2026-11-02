// Run by tests/test_splat_levels_js.py (node tests/splat_shape.test.mjs): a splat's size and trim maths.
import assert from 'node:assert/strict';
import * as S from '../web/splat-shape.js';

assert.equal(S.fillFactor(0.5), 0.25);
assert.equal(S.fillFactor(1.5), 2.25);
assert.equal(S.growOf({ grow: 0.7 }, false), 0.7);
assert.equal(S.growOf({ grow: 0.7 }, true), 1);   // erosion stays out of renders unless asked
assert.equal(S.growOf({ grow: 0.7, growRenders: true }, true), 0.7);
assert.equal(S.growOf({}, false), 1);

const t = { on: true, c: [0, 0, 0], r: 1, near: 0 };
assert.ok(S.trimOn({ trim: t }, true));   // a trim goes into renders by default
assert.ok(!S.trimOn({ trim: { ...t, renders: false } }, true));
assert.ok(S.trimOn({ trim: { ...t, renders: false } }, false));
assert.ok(!S.trimOn({ trim: { ...t, on: false } }, false));
assert.ok(!S.trimOn({}, false));
assert.deepEqual(S.trimBody({ on: true, c: [1.234567, 0, 0], r: 2, near: undefined }), { c: [1.2346, 0, 0], r: 2, near: 0 });
assert.equal(S.trimBody({ on: false, c: [0, 0, 0], r: 1 }), null);
assert.ok(S.sameTrim(S.trimBody(t), { c: [0, 0, 0], r: 1, near: 0 }));
assert.ok(!S.sameTrim(S.trimBody(t), null));
assert.ok(S.sameTrim(null, undefined));

// points: 0..9 along x
const pts = new Float32Array(30);
for (let i = 0; i < 10; i++) pts[i * 3] = i;
assert.equal(S.keptShare(pts, { c: [0, 0, 0], r: 4.5 }), 0.5);
assert.equal(S.keptShare(pts, { c: [0, 0, 0], r: 4.5, near: 1.5 }), 0.3);   // 2, 3, 4
assert.equal(S.keptShare(new Float32Array(0), t), 1);
assert.deepEqual(S.medianOf(pts), [5, 0, 0]);
assert.equal(S.reachOf(pts, [0, 0, 0]), 9);
// a ray along -x from x=20 at y=0.05 hits the point at x=9 first
assert.deepEqual(S.pickAlong(pts, [20, 0.05, 0], [-1, 0, 0], 0.1), [9, 0, 0]);
assert.equal(S.pickAlong(pts, [20, 5, 0], [-1, 0, 0], 0.1), null);
assert.equal(S.pickAlong(pts, [20, 0, 0], [1, 0, 0], 0.1), null);   // behind the ray

// standing on the floor, centred: a box 2 wide, 1 tall (y -0.5..0.5), 2.2..3 deep
assert.deepEqual(S.standShift([-1, -0.5, 2.2, 1, 0.5, 3], false), [0, 0.5, -2.6]);
// turned over (y down, z away, as SHARP's): y and z flip, the lowest is what was the highest y
assert.deepEqual(S.standShift([-1, -0.8, 2.2, 1, 0.2, 3], true), [0, 0.2, 2.6]);
assert.deepEqual(S.standShift([1, 0, 0, 3, 2, 0], false), [-2, 0, 0]);

console.log('splat shape ok');

// the box trim
{
  const line = new Float32Array(30);
  for (let i = 0; i < 10; i++) line[i * 3] = i;
  const on = (o) => ({ on: false, box: { on: true, c: [0, 0, 0], h: [4.5, 1, 1], q: [0, 0, 0, 1], ...o } });
  assert.equal(S.keptShare(line, on({})), 0.5);   // 0..4, the radial part being off
  assert.equal(S.keptShare(line, on({ q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], h: [1, 4.5, 1] })), 0.5, 'turned, its long side along the same line');
  assert.equal(S.keptShare(line, on({ q: [0, 0, Math.SQRT1_2, Math.SQRT1_2] })), 0.2, 'turned, its short side along it: 0 and 1');
  assert.equal(S.keptShare(line, { ...on({}), on: true, c: [0, 0, 0], r: 2.5 }), 0.3, 'both: radial and box');
  assert.ok(S.boxOn({ trim: on({}) }, true));
  assert.ok(!S.boxOn({ trim: { ...on({}), renders: false } }, true));
  assert.deepEqual(S.trimBody(on({})), { box: { c: [0, 0, 0], h: [4.5, 1, 1], q: [0, 0, 0, 1] } });
  assert.deepEqual(Object.keys(S.trimBody({ ...on({}), on: true, c: [0, 0, 0], r: 1 })), ['c', 'r', 'near', 'box']);
  assert.equal(S.trimBody({ on: false, box: { on: false, c: [0, 0, 0], h: [1, 1, 1], q: [0, 0, 0, 1] } }), null);
  const a = S.boxAxes([0, 0, Math.SQRT1_2, Math.SQRT1_2]);   // 90 about Z: X goes to Y
  [0, 1, 0].forEach((v, i) => assert.ok(Math.abs(a[0][i] - v) < 1e-9));
  const round = S.boxAround(line);
  assert.equal(round.on, true);
  assert.ok(round.c[0] > 4 && round.c[0] < 5 && round.h[0] > 4.5);
  assert.deepEqual(round.q, [0, 0, 0, 1]);
  assert.deepEqual(S.boxAround(line, true).q, [1, 0, 0, 0], 'a splat kept upside down: its Y is the layer\'s up');
  const up = S.boxBottomTo({ on: true, c: [0, 0, 0], h: [1, 2, 1], q: [0, 0, 0, 1] }, [5, -1, 5]);
  assert.deepEqual([up.c[1], up.h[1]], [0.5, 1.5], 'the bottom to y -1, the top still at 2');
  const down = S.boxBottomTo({ on: true, c: [0, 0, 0], h: [1, 2, 1], q: [1, 0, 0, 0] }, [0, 1, 0]);
  assert.deepEqual([down.c[1], down.h[1]], [-0.5, 1.5], 'turned over: its bottom is toward +Y of the file');
}
