// node --test tests/props_rules.test.mjs: the Properties pane's rows and mixed values (web/props-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIXED, rowsFor, shared, applyAll, snapNum, lockedSize, mixLength } from '../web/props-rules.js';

test('rowsFor: frames on the table', () => {
  assert.deepEqual(rowsFor({ kind: 'frames', picked: [] }), []);
  assert.deepEqual(rowsFor({ kind: 'frames', picked: [{ kind: 'image' }] }),
    ['x', 'y', 'opacity', 'name', 'lock', 'hide']);
  // several: no name (it would name them alike); a resolution only when they are all image frames
  assert.deepEqual(rowsFor({ kind: 'frames', picked: [{ kind: 'image' }, { kind: 'video' }] }),
    ['x', 'y', 'opacity', 'lock', 'hide']);
  assert.ok(!rowsFor({ kind: 'frames', picked: [{ kind: 'image' }, { kind: 'image' }] }).includes('resolution'));
  assert.ok(rowsFor({ kind: 'frames', picked: [{ kind: 'sound' }] }).includes('resolution'));
  // a note has nothing to measure
  assert.ok(!rowsFor({ kind: 'frames', picked: [{ kind: 'note' }] }).includes('resolution'));
  // frame rotation is not a row
  assert.ok(!rowsFor({ kind: 'frames', picked: [{ kind: 'image' }] }).includes('rot'));
});

test('rowsFor: layers in a live image frame', () => {
  assert.deepEqual(rowsFor({ kind: 'image', live: true, picked: [{ flat: false }] }), ['x', 'y', 'scale', 'rotation', 'opacity']);
  assert.deepEqual(rowsFor({ kind: 'image', live: true, picked: [{ flat: true }] }), ['x', 'y', 'scale', 'opacity']);
  assert.deepEqual(rowsFor({ kind: 'image', live: true, picked: [] }), []);
});

test('rowsFor: clips in a live video frame follow the primary', () => {
  const v = rowsFor({ kind: 'video', live: true, picked: [{ kind: 'video' }] });
  assert.deepEqual(v, ['at', 'in', 'out', 'framing', 'x', 'y', 'scale', 'rotation', 'anchor', 'opacity', 'level', 'fadeIn', 'fadeOut']);
  const still = rowsFor({ kind: 'video', live: true, picked: [{ kind: 'image' }, { kind: 'video' }] });
  assert.ok(still.includes('duration') && !still.includes('in') && !still.includes('level') && still.includes('opacity'));
  const snd = rowsFor({ kind: 'video', live: true, picked: [{ kind: 'audio' }] });
  assert.ok(snd.includes('level') && !snd.includes('x') && !snd.includes('opacity'));
});

test('rowsFor: sound items, and kinds with none', () => {
  assert.deepEqual(rowsFor({ kind: 'sound', live: true, picked: [{}] }), ['at', 'in', 'out', 'level', 'pan', 'fadeIn', 'fadeOut']);
  assert.deepEqual(rowsFor({ kind: 'scene', live: true, picked: [{}] }), []);
  assert.deepEqual(rowsFor(), []);
});

test('shared: one value or MIXED', () => {
  assert.equal(shared([1, 1, 1]), 1);
  assert.equal(shared([0.1 + 0.2, 0.3]), 0.1 + 0.2);
  assert.equal(shared([1, 2]), MIXED);
  assert.equal(shared(['a', 'a']), 'a');
  assert.equal(shared([true, false]), MIXED);
  assert.equal(shared([]), MIXED);
});

test('applyAll: the edit goes to every item', () => {
  const items = [{ o: 1 }, { o: 0.5 }, null];
  assert.equal(applyAll(items, (it, v) => { it.o = v; }, 0.25), 2);
  assert.deepEqual(items.slice(0, 2), [{ o: 0.25 }, { o: 0.25 }]);
});

test('snapNum and lockedSize', () => {
  assert.equal(snapNum(37.4, { on: true, size: 32 }), 32);
  assert.equal(snapNum(37.4, { on: false, size: 32 }), 37);
  assert.deepEqual(lockedSize({ w: 1600, h: 900 }, 'w', 800, true), { w: 800, h: 450 });
  assert.deepEqual(lockedSize({ w: 1600, h: 900 }, 'h', 450, true), { w: 800, h: 450 });
  assert.deepEqual(lockedSize({ w: 1600, h: 900 }, 'w', 800, false), { w: 800, h: 900 });
  assert.deepEqual(lockedSize({ w: 100, h: 100 }, 'w', 2, false), { w: 16, h: 100 });
});

test('mixLength: where the last item ends', () => {
  assert.equal(mixLength([]), 0);
  assert.equal(mixLength([{ at: 1, in: 0.5, dur: 3 }, { at: 0, in: 0, out: 2 }]), 3.5);
});
