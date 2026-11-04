// node --test tests/undo_history.test.mjs: undo / redo by snapshots (web/undo-history.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../web/undo-history.js';

function make(opts = {}) {
  const doc = { v: 0 }; let t = 0;
  const hist = history({ snap: () => ({ ...doc }), apply: (s) => Object.assign(doc, s), now: () => t, ...opts });
  return { doc, hist, at: (ms) => { t = ms; } };
}

test('a change is a step; undo and redo walk it', () => {
  const { doc, hist } = make();
  doc.v = 1; hist.mark(); doc.v = 2; hist.mark();
  assert.deepEqual(hist.can(), [true, false]);
  hist.undo(); assert.equal(doc.v, 1);
  hist.undo(); assert.equal(doc.v, 0);
  assert.equal(hist.undo(), false);
  hist.redo(); hist.redo(); assert.equal(doc.v, 2);
  assert.deepEqual(hist.can(), [true, false]);
});
test('an identical snapshot makes no step', () => {
  const { doc, hist } = make();
  assert.equal(hist.mark(), false);
  doc.v = 1; hist.mark(); hist.mark();
  hist.undo(); assert.equal(doc.v, 0); assert.deepEqual(hist.can(), [false, true]);
});
test('a new change drops the redo steps', () => {
  const { doc, hist } = make();
  doc.v = 1; hist.mark(); hist.undo(); doc.v = 5; hist.mark();
  assert.deepEqual(hist.can(), [true, false]);
});
test('the same tag within mergeMs is one step; later or another tag is a new one', () => {
  const { doc, hist, at } = make();
  at(0); doc.v = 1; hist.mark('drag');
  at(200); doc.v = 2; hist.mark('drag');
  at(400); doc.v = 3; hist.mark('drag');
  hist.undo(); assert.equal(doc.v, 0);
  hist.redo();
  at(2000); doc.v = 4; hist.mark('drag');
  doc.v = 5; hist.mark('other');
  hist.undo(); assert.equal(doc.v, 4);
  hist.undo(); assert.equal(doc.v, 3);
});
test('hold: marks inside re-base and make no step', () => {
  const { doc, hist } = make();
  doc.v = 1; hist.mark();
  hist.hold(() => { doc.v = 9; hist.mark(); });
  hist.undo(); assert.equal(doc.v, 0);
  hist.redo(); assert.equal(doc.v, 9);
  assert.deepEqual(hist.can(), [true, false]);
});
test('hold releases when fn throws', () => {
  const { doc, hist } = make();
  assert.throws(() => hist.hold(() => { throw new Error('x'); }));
  doc.v = 1; assert.equal(hist.mark(), true);
});
test('limit drops the oldest; clear forgets everything and keeps the state', () => {
  const { doc, hist } = make({ limit: 2 });
  for (let i = 1; i <= 4; i++) { doc.v = i; hist.mark(); }
  hist.undo(); hist.undo(); assert.equal(doc.v, 2); assert.equal(hist.undo(), false);
  hist.clear(); assert.deepEqual(hist.can(), [false, false]); assert.equal(doc.v, 2);
});
test('apply gets a copy: later edits do not change what undo restores', () => {
  const { doc, hist } = make();
  doc.v = 1; hist.mark(); doc.v = 2; hist.mark(); hist.undo(); doc.v = 7;
  hist.mark(); hist.undo(); assert.equal(doc.v, 1);
});
