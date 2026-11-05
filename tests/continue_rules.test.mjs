// node --test tests/continue_rules.test.mjs: continuing a clip (web/continue-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONT_TEMPLATES, LAPS, LAP_DEFAULT, familyOf, continueTemplate, lapFrames, sourceKey, tailTrim, contOf,
  childrenOf, chainFrom, staleOf, placeAfter, settle, seamWindows, prevOnTrack } from '../web/continue-rules.js';
import { endOf } from '../web/timeline-rules.js';

const V = (id, at, dur, more = {}) => ({ id, track: 'v1', kind: 'video', at, in: 0, out: dur, dur, src: { generation: 7, index: 0 }, ...more });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('constants', () => {
  assert.deepEqual(CONT_TEMPLATES, { ltx: 'deck-ltx-continue', h3: 'deck-h3-continue' });
  assert.deepEqual(LAPS, { ltx: [9, 17, 25], h3: [5, 22, 39] });
  assert.deepEqual(LAP_DEFAULT, { ltx: 17, h3: 22 });
});

test('familyOf, continueTemplate, lapFrames', () => {
  assert.equal(familyOf('deck-ltx-t2v'), 'ltx');
  assert.equal(familyOf('deck-h3-ref2v'), 'h3');
  assert.equal(familyOf('deck-wan-x'), null);
  assert.equal(familyOf(undefined), null);
  assert.equal(continueTemplate('deck-ltx-i2v'), 'deck-ltx-continue');
  assert.equal(continueTemplate('deck-h3-ctrl2v'), 'deck-h3-continue');
  assert.equal(continueTemplate('other'), null);
  assert.equal(lapFrames('ltx', 20), 17);
  assert.equal(lapFrames('ltx', 25), 25);
  assert.equal(lapFrames('ltx', 100), 25);
  assert.equal(lapFrames('ltx', 3), 9);
  assert.equal(lapFrames('h3', 21), 5);
});

test('sourceKey', () => {
  assert.equal(sourceKey({ src: { generation: 12, index: 2 } }), '12:2');
  assert.equal(sourceKey({ src: { generation: 12 } }), '12:0');
  assert.equal(sourceKey({ src: { generation: 0 } }), '0:0');
  assert.equal(sourceKey({ src: { input: 'a.png' } }), null);
  assert.equal(sourceKey({}), null);
});

test('tailTrim: whole clip, trimmed clip, short clip, rounding', () => {
  assert.deepEqual(tailTrim(V('a', 0, 5), 24), { start: 4, len: 1, frames: 24 });
  const t = tailTrim(V('a', 0, 5, { in: 1, out: 3 }), 24);
  assert.deepEqual(t, { start: 2, len: 1, frames: 24 }, 'ends at out, not dur');
  const s = tailTrim(V('a', 0, 5, { in: 4.5, out: 5 }), 24);
  assert.deepEqual(s, { start: 4.5, len: 0.5, frames: 12 }, 'shorter than the guide: whole used range');
  const r = tailTrim(V('a', 0, 5.92, { out: undefined }), 22);
  assert.equal(r.frames, 22);
  near(r.start, (Math.round(5.92 * 24) - 22) / 24);
  assert.equal(r.len, 22 / 24);
  assert.equal(tailTrim(V('a', 0, 5, { out: 9 }), 24).frames, 24, 'out past dur is clamped to dur');
  assert.equal(tailTrim(V('a', 0, 2), 12, 12).start, 1, 'other fps');
});

test('contOf, childrenOf', () => {
  const A = V('a', 0, 5, { out: 4 });
  assert.deepEqual(contOf(A, 0.9), { of: 'a', from: '7:0', end: 4, lap: 0.9 });
  const items = [A, V('b', 3, 2, { cont: { of: 'a' } }), V('c', 9, 2)];
  assert.deepEqual(childrenOf(items, 'a').map((c) => c.id), ['b']);
});

test('chainFrom: branch order, cycle safe', () => {
  const items = [V('d', 0, 1, { cont: { of: 'b' } }), V('a', 0, 1), V('c', 0, 1, { cont: { of: 'a' } }), V('b', 0, 1, { cont: { of: 'a' } })];
  const ids = chainFrom(items, 'a');
  assert.equal(ids.length, 3);
  assert.ok(ids.indexOf('b') < ids.indexOf('d'));
  assert.ok(!ids.includes('a'));
  assert.deepEqual(chainFrom(items, 'd'), []);
  const cyc = [V('x', 0, 1, { cont: { of: 'y' } }), V('y', 0, 1, { cont: { of: 'x' } })];
  assert.deepEqual(chainFrom(cyc, 'x'), ['y']);
});

test('staleOf: four reasons and a fresh chain', () => {
  const A = V('a', 0, 5);
  const mk = (id, par, more = {}) => V(id, 4, 3, { cont: { ...contOf(par, 1), ...more } });
  const fresh = [A, mk('b', A)];
  fresh.push(mk('c', fresh[1]));
  assert.deepEqual(staleOf(fresh), {});
  assert.deepEqual(staleOf([mk('b', A)]), { b: 'gone' });
  const changed = [{ ...A, src: { generation: 8, index: 0 } }, mk('b', A)];
  assert.deepEqual(staleOf(changed), { b: 'changed' });
  const trimmed = [{ ...A, out: 4 }, mk('b', A)];
  assert.deepEqual(staleOf(trimmed), { b: 'trimmed' });
  const tiny = [{ ...A, out: 4.99 }, mk('b', A)];
  assert.deepEqual(staleOf(tiny), {}, 'within a frame');
  const up = [{ ...A, out: 4 }, mk('b', A), mk('c', mk('b', A))];
  assert.deepEqual(staleOf(up), { b: 'trimmed', c: 'upstream' });
  const cyc = [V('x', 0, 1, { cont: { of: 'y', from: '7:0', end: 1, lap: 0 } }), V('y', 0, 1, { cont: { of: 'x', from: '7:0', end: 1, lap: 0 } })];
  assert.deepEqual(staleOf(cyc), {});
});

test('placeAfter: overlap, pushes later clips, other tracks alone', () => {
  const A = V('a', 2, 4);                       // 2..6
  const later1 = V('l1', 6, 2), later2 = V('l2', 10, 1);
  const other = V('o', 6, 2, { track: 'v2' });
  const B = V('b', 0, 5, { track: 'v9' });
  const items = [A, later1, later2, other, B];
  placeAfter(items, A, B, 1);
  assert.equal(B.track, 'v1');
  assert.equal(B.at, 5);                        // 5..10
  assert.equal(later1.at, 10);                  // pushed by 10 - 6 = 4
  assert.equal(later2.at, 14);
  assert.equal(other.at, 6);
  assert.equal(A.at, 2);
  const free = [A, V('far', 20, 1)];
  const B2 = V('b2', 0, 3);
  placeAfter(free, A, B2, 1);
  assert.equal(free[1].at, 20, 'room already there');
  const A0 = V('a0', 0, 0.5);
  const B3 = V('b3', 0, 2);
  placeAfter([A0, B3], A0, B3, 2);
  assert.equal(B3.at, 0, 'never before 0');
});

test('placeAfter: continuations of B follow it', () => {
  const A = V('a', 0, 4), B = V('b', 0, 3), C = V('c', 20, 2, { cont: { of: 'b', lap: 1 } });
  placeAfter([A, B, C], A, B, 1);
  assert.equal(B.at, 3);
  assert.equal(C.at, 5);
});

test('settle: chain of three after the first gets longer then shorter', () => {
  const A = V('a', 0, 4);
  const B = V('b', 3, 4, { cont: { of: 'a', lap: 1 } });     // 3..7
  const C = V('c', 6, 4, { cont: { of: 'b', lap: 1 } });     // 6..10
  const tail = V('t', 10, 2);
  const items = [A, B, C, tail];
  A.out = 6; settle(items, 'a');                             // A ends 6: B at 5, C at 8, tail at 12
  assert.deepEqual([B.at, C.at, tail.at], [5, 8, 12]);
  A.out = 3; settle(items, 'a');                             // A ends 3: B at 2, C at 5, tail at 9
  assert.deepEqual([B.at, C.at, tail.at], [2, 5, 9]);
  const before = items.map((c) => c.at);
  settle(items, 'a');
  assert.deepEqual(items.map((c) => c.at), before, 'stable');
  const x = V('x', 0, 1, { cont: { of: 'y', lap: 0 } }), y = V('y', 2, 1, { cont: { of: 'x', lap: 0 } });
  settle([x, y], 'x');                                       // no hang
});

test('seamWindows: with and without overlap', () => {
  const A = V('a', 0, 4, { in: 1, out: 4 });                 // 0..3 on the timeline
  const B = V('b', 2.5, 3, { in: 0.5, out: 3 });             // overlap 0.5, 2.5 s long
  const w = seamWindows(A, B);
  near(w.lap, 0.5);
  assert.deepEqual(w.ref, { start: 3.5, len: 0.5 });
  near(w.src.start, 1); near(w.src.len, 0.5);
  const gap = seamWindows(A, { ...B, at: 5 });
  assert.equal(gap.lap, 0);
  near(gap.src.start, 0.5);
  const short = seamWindows(V('a', 0, 0.3), V('b', 0, 1, { in: 0.2, out: 1 }), 0.5);
  assert.deepEqual(short.ref, { start: 0, len: 0.3 });
  const all = seamWindows(A, V('b', 2.5, 0.55, { in: 0 }));      // 0.55 s, overlap 0.5: 0.05 left
  assert.deepEqual(all.src, { start: 0, len: 0.5 }, 'falls back to the clip start');
});

test('prevOnTrack', () => {
  const a = V('a', 0, 2), b = V('b', 3, 2), au = V('au', 4, 2, { kind: 'audio' }), o = V('o', 1, 1, { track: 'v2' });
  const B = V('c', 6, 1);
  assert.equal(prevOnTrack([a, b, au, o, B], B).id, 'b', 'audio skipped');
  assert.equal(prevOnTrack([a, B], a), null);
  const Au = V('A2', 6, 1, { kind: 'audio' });
  assert.equal(prevOnTrack([a, b, au, Au], Au).id, 'au');
  assert.equal(endOf(a), 2);
});
