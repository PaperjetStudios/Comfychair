// Run by tests/test_workarea.py (node tests/workarea.test.mjs): the work area's maths (web/workarea-math.js).
import assert from 'node:assert/strict';
import * as W from '../web/workarea-math.js';

// norm: ordered, inside 0..len, long enough; on defaults to true
assert.deepEqual(W.norm({ a: 4, b: 2 }, 10), { a: 2, b: 4, on: true });
assert.deepEqual(W.norm({ a: -1, b: 20, on: false }, 10), { a: 0, b: 10, on: false });
assert.equal(W.norm(null), null);
assert.equal(W.norm({ a: 3, b: 3 }), null);
assert.equal(W.norm({ a: 12, b: 20 }, 10), null);          // wholly past the end
assert.equal(W.norm({ a: 1, b: 1.05 }, 10, 0.1), null);    // shorter than minLen
assert.equal(W.norm({ a: NaN, b: 2 }), null);
// bound: only while on
assert.equal(W.bound({ a: 1, b: 2, on: false }, 10), null);
assert.deepEqual(W.bound({ a: 1, b: 2 }, 10), { a: 1, b: 2, on: true });

// clamp: stepping and scrubbing stay inside
const r = { a: 2, b: 5, on: true };
assert.equal(W.clampT(1, r), 2);
assert.equal(W.clampT(7, r), 5);
assert.equal(W.clampT(3.3, r), 3.3);
assert.equal(W.clampT(7, null), 7);

// play starts inside the range: from where it is, else (outside or at the out point) from the in point
assert.equal(W.playFrom(3, r, 10, 0.01), 3);
assert.equal(W.playFrom(1, r, 10, 0.01), 2);
assert.equal(W.playFrom(4.995, r, 10, 0.01), 2);
assert.equal(W.playFrom(9.995, null, 10, 0.01), 0);
assert.equal(W.playFrom(4, null, 10, 0.01), 4);

// a tick: loops back to the in point, or stops at the out point with loop off
assert.deepEqual(W.tickT(3, r, 10, true), { t: 3, wrap: false, stop: false });
assert.deepEqual(W.tickT(5.2, r, 10, true), { t: 2, wrap: true, stop: false });
assert.deepEqual(W.tickT(5.2, r, 10, false), { t: 5, wrap: false, stop: true });
assert.deepEqual(W.tickT(10.1, null, 10, true), { t: 0, wrap: true, stop: false });
assert.deepEqual(W.tickT(10.1, null, 10, false), { t: 10, wrap: false, stop: true });
assert.deepEqual(W.tickT(0.5, r, 10, true), { t: 2, wrap: false, stop: false });   // jumped in before the in point
// frames (3D): the out point is the last frame shown
const fr = { a: 10, b: 20, on: true };
assert.equal(W.tickT(20, fr, 47, true, true).t, 20);
assert.deepEqual(W.tickT(21, fr, 47, true, true), { t: 10, wrap: true, stop: false });
// a loop over many ticks never leaves the range
let t = 2;
for (let i = 0; i < 500; i++) { t = W.tickT(t + 0.037, r, 10, true).t; assert.ok(t >= 2 && t <= 5); }

// snap: onto a near point first, else onto the frame grid
assert.equal(W.snapT(2.49, { step: 1 / 24, points: [2.5], tol: 0.02 }), 2.5);
assert.equal(W.snapT(2.49, { step: 1 / 24, points: [3], tol: 0.02 }), Math.round(2.49 * 24) / 24);
assert.equal(W.snapT(7.4, { step: 1 }), 7);
assert.equal(W.snapT(7.4), 7.4);
assert.equal(W.snapT(5, { points: [4.9, 5.05], tol: 0.2 }), 5.05);   // the nearest

// drawing, in and out
assert.deepEqual(W.span(6, 2, 10), { a: 2, b: 6, on: true });
assert.equal(W.span(2, 2, 10), null);
assert.deepEqual(W.setIn(null, 3, 10), { a: 3, b: 10, on: true });
assert.deepEqual(W.setIn(r, 3, 10), { a: 3, b: 5, on: true });
assert.deepEqual(W.setIn(r, 6, 10), { a: 6, b: 10, on: true });        // past the out point: out goes to the end
assert.deepEqual(W.setOut(null, 4, 10), { a: 0, b: 4, on: true });
assert.deepEqual(W.setOut(r, 4, 10), { a: 2, b: 4, on: true });
assert.deepEqual(W.setOut(r, 1, 10), { a: 0, b: 1, on: true });        // before the in point: in goes to the start
assert.deepEqual(W.setOut({ ...r, on: false }, 4, 10), { a: 2, b: 4, on: false });   // keeps the switch
// handles keep a minimum length and stay inside
assert.deepEqual(W.dragEnd(r, 'a', 4.95, 10, 0.1), { a: 4.9, b: 5, on: true });
assert.deepEqual(W.dragEnd(r, 'a', -3, 10), { a: 0, b: 5, on: true });
assert.deepEqual(W.dragEnd(r, 'b', 2.01, 10, 0.5), { a: 2, b: 2.5, on: true });
assert.deepEqual(W.dragEnd(r, 'b', 12, 10), { a: 2, b: 10, on: true });
// sliding keeps the length, inside 0..len
assert.deepEqual(W.slide(r, 8, 10), { a: 7, b: 10, on: true });
assert.deepEqual(W.slide(r, -2, 10), { a: 0, b: 3, on: true });
assert.deepEqual(W.slide(r, 4, Infinity), { a: 4, b: 7, on: true });

// frames a render covers
assert.deepEqual(W.frameSpan(null, 48), { first: 0, count: 48 });
assert.deepEqual(W.frameSpan(fr, 48, 1, true), { first: 10, count: 11 });
assert.deepEqual(W.frameSpan({ a: 1, b: 2 }, 72, 24), { first: 24, count: 24 });
assert.deepEqual(W.frameSpan({ a: 40, b: 99 }, 48, 1, true), { first: 40, count: 8 });

// cutting clips to the range (exports of only the range)
const len = (it) => (it.out ?? 3) - it.in;
const items = [
  { id: 'a', at: 0, in: 1, out: 4, fadeIn: 0.5, fadeOut: 0.5 },        // 0..3: its head is cut at 2
  { id: 'b', at: 3, in: 0, out: 1, fadeIn: 0.2 },                      // 3..4: whole
  { id: 'c', at: 4.5, in: 2, out: 6, fadeOut: 1 },                     // 4.5..8.5: its tail is cut at 5
  { id: 'd', at: 6, in: 0, out: 2 },                                   // outside
  { id: 'e', kind: 'image', at: 1, in: 0, out: 3, chans: { x: [{ f: 0, v: 0 }, { f: 2, v: 1 }] } },   // a still across the in point
];
const cut = W.cutItems(items, r, { len, still: (it) => it.kind === 'image' });
assert.deepEqual(cut.map((c) => c.id), ['a', 'b', 'c', 'e']);
const [ca, cb, cc, ce] = cut;
assert.deepEqual([ca.at, ca.in, ca.out, ca.fadeIn, ca.fadeOut], [0, 3, 4, 0, 0.5]);
assert.deepEqual([cb.at, cb.in, cb.out, cb.fadeIn], [1, 0, 1, 0.2]);
assert.deepEqual([cc.at, cc.in, cc.out, cc.fadeOut], [2.5, 2, 2.5, 0]);
assert.deepEqual([ce.at, ce.in, ce.out], [0, 0, 2]);
assert.deepEqual(ce.chans.x.map((k) => k.f), [-1, 1]);   // its keys moved with its new start
assert.equal(items[4].chans.x[1].f, 2);                   // (the originals are untouched)
assert.equal(items[0].in, 1);
assert.equal(W.cutItems(items, null, { len }), items);

console.log('workarea math ok');
