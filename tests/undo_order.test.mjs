// node --test tests/undo_order.test.mjs: one Undo order for a live frame's engine and the table (web/undo-order.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { undoOrder } from '../web/undo-order.js';

// a stand-in engine: its state is a string, its history snapshots of it
function engine() {
  const e = { s: 'A', undos: [], redos: [] };
  e.step = (s) => { e.undos.push(e.s); e.redos = []; e.s = s; };
  e.undo = () => { e.redos.push(e.s); e.s = e.undos.pop(); };
  e.redo = () => { e.undos.push(e.s); e.s = e.redos.pop(); };
  e.can = () => [e.undos.length > 0, e.redos.length > 0];
  return e;
}
// one Ctrl+Z / Ctrl+Shift+Z: returns who went
function press(o, e, table, dir) {
  const [cu, cr] = e.can();
  const who = dir === 'undo' ? o.undoBy(e.s, cu) : o.redoBy(e.s, cr);
  if (who === 'table') {
    const m = dir === 'undo' ? o.undone() : o.redone();
    table[dir](m.entry); m.sig = e.s;
  } else if (dir === 'undo') e.undo(); else e.redo();
  return who;
}
const tbl = () => { const t = { log: [] }; t.undo = (x) => t.log.push(`undo ${x}`); t.redo = (x) => t.log.push(`redo ${x}`); return t; };

test('a table step made after an engine step undoes first, then the engine step', () => {
  const o = undoOrder(), e = engine(), t = tbl();
  e.step('B'); o.made('size', e.s);
  assert.equal(press(o, e, t, 'undo'), 'table');
  assert.equal(press(o, e, t, 'undo'), 'engine');
  assert.equal(e.s, 'A');
  assert.equal(press(o, e, t, 'redo'), 'engine');
  assert.equal(press(o, e, t, 'redo'), 'table');
  assert.deepEqual(t.log, ['undo size', 'redo size']);
});
test('an engine step made after a table step undoes first', () => {
  const o = undoOrder(), e = engine(), t = tbl();
  o.made('pin', e.s); e.step('B');
  assert.equal(press(o, e, t, 'undo'), 'engine');
  assert.equal(press(o, e, t, 'undo'), 'table');
  assert.equal(press(o, e, t, 'redo'), 'table');
  assert.equal(press(o, e, t, 'redo'), 'engine');
  assert.equal(e.s, 'B');
});
test('interleaved steps undo in the order they were made', () => {
  const o = undoOrder(), e = engine(), t = tbl(), went = [];
  e.step('B'); o.made('t1', e.s); e.step('C'); o.made('t2', e.s);
  for (let i = 0; i < 4; i++) went.push(press(o, e, t, 'undo'));
  assert.deepEqual(went, ['table', 'engine', 'table', 'engine']);
  assert.deepEqual(t.log, ['undo t2', 'undo t1']);
});
test('an engine with nothing to undo lets the table step go', () => {
  const o = undoOrder();
  o.made('x', 'A');
  assert.equal(o.undoBy('changed elsewhere', false), 'table');
  assert.equal(o.undoBy('changed elsewhere', true), 'engine');
});
test('no table steps: the engine always; a new step clears the redo side; drop forgets', () => {
  const o = undoOrder();
  assert.equal(o.undoBy('A'), 'engine');
  o.made('a', 'A'); o.undone();
  assert.deepEqual(o.can(), [false, true]);
  o.made('b', 'A');
  assert.deepEqual(o.can(), [true, false]);
  o.drop('b');
  assert.deepEqual(o.can(), [false, false]);
  assert.equal(o.top(), null);
});
