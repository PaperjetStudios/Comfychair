// node --test tests/pick_slots.test.mjs: ticking several pictures in the image picker and the slots they fill
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slotsFrom, tick, tickRange } from '../web/pick-slots.js';

const refs = ['a', 'b', 'c', 'd'].map((key) => ({ key, kind: 'image', group: 'References' }));
const fields = [{ key: 'first', kind: 'image', group: 'First frame' }, { key: 'p', kind: 'text', group: 'References' }, ...refs];

test('a pick fills its own slot, then the empty ones of its group, going on from it', () => {
  assert.deepEqual(slotsFrom(fields, 'a', {}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(slotsFrom(fields, 'c', {}), ['c', 'd', 'a', 'b']);
  assert.deepEqual(slotsFrom(fields, 'b', { a: 'x.png', c: 'y.png' }), ['b', 'd']);
});
test('a slot that is filled already is replaced, and only by the one it was picked from', () => {
  assert.deepEqual(slotsFrom(fields, 'a', { a: 'x.png', b: 'y.png', c: 'z.png', d: 'w.png' }), ['a']);
});
test('an image input alone in its group, or an unknown one, gets one picture', () => {
  assert.deepEqual(slotsFrom(fields, 'first', {}), ['first']);
  assert.deepEqual(slotsFrom(fields, 'gone', {}), ['gone']);
  assert.deepEqual(slotsFrom(null, 'gone', {}), ['gone']);
});
test('ticks keep their order and stop at the limit; unticking makes room', () => {
  const sel = new Map();
  assert.equal(tick(sel, { key: 'b' }, true, 2), true);
  assert.equal(tick(sel, { key: 'a' }, true, 2), true);
  assert.equal(tick(sel, { key: 'c' }, true, 2), false);
  assert.equal(tick(sel, { key: 'a' }, true, 2), true);   // (already ticked, so no room is needed)
  assert.deepEqual([...sel.keys()], ['b', 'a']);
  tick(sel, { key: 'b' }, false, 2);
  assert.equal(tick(sel, { key: 'c' }, true, 2), true);
  assert.deepEqual([...sel.keys()], ['a', 'c']);
});
test('a range ticks in the direction clicked and passes over what needs a choice', () => {
  const get = () => {};
  const items = [{ key: 'a', get }, { key: 'clip' }, { key: 'c', get }, { key: 'd', get }];
  let sel = new Map();
  assert.equal(tickRange(sel, items, 0, 3), true);
  assert.deepEqual([...sel.keys()], ['a', 'c', 'd']);
  sel = new Map();
  assert.equal(tickRange(sel, items, 3, 0), true);
  assert.deepEqual([...sel.keys()], ['d', 'c', 'a']);
  sel = new Map();
  assert.equal(tickRange(sel, items, 0, 3, 2), false);
  assert.deepEqual([...sel.keys()], ['a', 'c']);
});
