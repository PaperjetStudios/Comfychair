// node --test tests/layer_stack.test.mjs: groups, masks and undo states of the layer stack (web/layer-stack.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../web/layer-stack.js';

const L = (key, o = {}) => ({ key, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, ...o });
const keys = (ls) => ls.map((l) => l.key);

test('a group gathers its members at the place of the topmost', () => {
  const a = L('a'), b = L('b'), c = L('c'), d = L('d'), groups = [];
  const out = S.makeGroup([a, b, c, d], groups, [a, c], 'g');
  assert.deepEqual(keys(out), ['b', 'a', 'c', 'd']);
  assert.equal(a.group, 'g'); assert.equal(b.group, undefined);
  assert.deepEqual(S.rowsOf(out, groups).map((r) => (r.group ? 'G' : r.layer.key)), ['d', 'G', 'c', 'a', 'b']);
});
test('collapsed shows the heading; ungrouping and an empty group go', () => {
  const a = L('a'), b = L('b'), groups = [];
  let out = S.makeGroup([a, b], groups, [a, b], 'g');
  groups[0].collapsed = true;
  assert.deepEqual(S.rowsOf(out, groups).map((r) => (r.group ? 'G' : r.layer.key)), ['G']);
  out = S.ungroup(out, groups, 'g');
  assert.equal(groups.length, 0); assert.equal(a.group, undefined);
});
test('one layer alone is no group', () => {
  const a = L('a'), groups = [];
  assert.deepEqual(keys(S.makeGroup([a], groups, [a], 'g')), ['a']);
  assert.equal(groups.length, 0);
});
test('a dragged layer joins the group it lands in, leaves when dropped outside', () => {
  const a = L('a'), b = L('b'), c = L('c'), groups = [];
  let out = S.makeGroup([a, b, c], groups, [a, b], 'g');   // list: c, G, b, a
  out = S.moveRow(out, groups, 0, 2);                      // c onto b's place
  assert.equal(c.group, 'g');
  assert.deepEqual(S.rowsOf(out, groups).map((r) => (r.group ? 'G' : r.layer.key)), ['G', 'b', 'c', 'a']);
  out = S.moveRow(out, groups, 2, 2);
  const pl = L('p'); out = [...out, pl];                   // list: p, G, b, c, a
  out = S.moveRow(out, groups, 3, 0);                      // c onto p's place: out of the group, top of the list
  assert.equal(c.group, undefined);
});
test('a group moves whole, and stays together', () => {
  const a = L('a'), b = L('b'), c = L('c'), groups = [];
  let out = S.makeGroup([a, b, c], groups, [a, b], 'g');   // list: c, G, b, a
  out = S.moveRow(out, groups, 1, 0);                      // the group above c
  assert.deepEqual(keys(out), ['c', 'a', 'b']);
  assert.equal(c.group, undefined);
});
test('a mask stays right above its owner and goes with it', () => {
  const o = L('o'), m = L('m', { maskOf: 'o' }), t = L('t'), groups = [];
  assert.deepEqual(keys(S.normalize([m, t, o], groups)), ['t', 'o', 'm']);
  assert.deepEqual(keys(S.normalize([m, t], groups)), ['t'], 'an orphan mask goes');
  assert.deepEqual(S.rowsOf(S.normalize([o, m], groups), groups).map((r) => r.layer.key), ['o'], 'not a row');
  o.x = 5; o.rotation = 30; S.syncMask(m, o);
  assert.equal(m.x, 5); assert.equal(m.rotation, 30);
});
test('a mask attached to a new layer sits right above it, with its geometry', () => {
  const t = L('t'), o = L(undefined, { x: 7, y: 8, scale: 0.5, rotation: 30, flipX: true, crop: { x: 0, y: 0, w: 1, h: 1 } }), m = { name: 'mask.png' };
  const out = S.attachMask([o, t], [], o, m, 'new-key');
  assert.equal(o.key, 'new-key');
  assert.equal(m.maskOf, 'new-key');
  assert.deepEqual(out, [o, m, t]);
  assert.deepEqual([m.x, m.y, m.scale, m.rotation, m.flipX, m.crop], [7, 8, 0.5, 30, true, o.crop]);
  const keyed = L('k'), m2 = { name: 'm2.png' };
  S.attachMask([keyed], [], keyed, m2, 'unused');
  assert.equal(keyed.key, 'k', 'a key it has stays');
});
test('undo puts the stack back on the same layer objects, with their pixels', () => {
  const a = L('a'), b = L('b'), E = { layers: [a, b], groups: [] };
  const was = S.stackState(E.layers, E.groups);
  assert.ok(S.sameState(was, S.stackState(E.layers, E.groups)));
  a.x = 9; a.hidden = true; E.layers = [b, a]; E.groups.push({ id: 'g' });
  assert.ok(!S.sameState(was, S.stackState(E.layers, E.groups)));
  S.applyState(E, was);
  assert.equal(a.x, 0); assert.equal(E.layers[0], a); assert.equal(E.groups.length, 0);
  assert.ok(!('hidden' in a) || a.hidden === undefined);
});
test('the grid counts from the frame', () => {
  assert.equal(S.gridStep(1000, 5), 50);
  assert.equal(S.onGrid(127, 100, 50), 150);
  assert.equal(S.onGrid(-30, 0, 50), -50);
  assert.ok(S.plainGroup({ opacity: 1, blend: 'normal' }));
  assert.ok(!S.plainGroup({ opacity: 0.5 }));
});
