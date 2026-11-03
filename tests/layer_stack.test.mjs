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

test('merge down goes to the nearest showing layer below, in the same group', () => {
  const a = L('a'), off = L('off', { hidden: true }), m = L('m', { maskOf: 'b' }), b = L('b');
  assert.equal(S.mergeBelow([a, off, b, m], b), a);
  assert.equal(S.mergeBelow([a, b], a), null);
  const g1 = L('g1', { group: 'g' }), g2 = L('g2', { group: 'g' }), out = L('out');
  assert.equal(S.mergeBelow([out, g1, g2], g2), g1);
  assert.equal(S.mergeBelow([out, g1, g2], g1), null, 'the bottom of a group stays in it');
  assert.equal(S.mergeBelow([g1, g2, out], out), null, 'nor does a layer merge into a group');
  assert.equal(S.mergeBelow([a, L('ink', { mask: true }), b], b), a, 'the inpaint mask is no picture');
  assert.equal(S.mergeBelow([a, b], L('x', { hidden: true })), null);
});
test('merging takes what shows, bottom first', () => {
  const a = L('a'), b = L('b', { hidden: true }), c = L('c'), m = L('m', { maskOf: 'c' }), ink = L('ink', { mask: true });
  assert.deepEqual(keys(S.mergeSet([a, b, c, m, ink], [c, ink, b, a, m])), ['a', 'c']);
});
test('the merged layer sits at the topmost, its masks gone, others in their places', () => {
  const a = L('a'), b = L('b'), bm = L('bm', { maskOf: 'b' }), c = L('c'), d = L('d'), x = L('x');
  assert.deepEqual(keys(S.mergedStack([a, b, bm, c, d], [], [a, b, ], x)), ['x', 'c', 'd']);
  assert.deepEqual(keys(S.mergedStack([a, b, bm, c, d], [], [a, c], x)), ['b', 'bm', 'x', 'd'], 'one between them stays under');
});
test('a merge stays in a group they all share, and an emptied group goes', () => {
  const a = L('a', { group: 'g' }), b = L('b', { group: 'g' }), c = L('c'), groups = [{ id: 'g', name: 'G' }];
  assert.equal(S.mergeGroup([a, b]), 'g');
  assert.equal(S.mergeGroup([a, c]), null);
  const x = L('x', { group: 'g' });
  assert.deepEqual(keys(S.mergedStack([a, b, c], groups, [a, b], x)), ['x', 'c']);
  assert.equal(groups.length, 1);
  const y = L('y');
  S.mergedStack([a, b, c], groups, [a, b], y);
  assert.equal(groups.length, 0);
});
test('a merge is as sharp as its sharpest layer, within what a canvas holds', () => {
  assert.equal(S.mergeScale([L('a', { scale: 0.5 }), L('b', { scale: 1 })], 100, 100), 2);
  assert.equal(S.mergeScale([L('a', { scale: 0.01 })], 4000, 2000), 8192 / 4000);
  assert.ok(Math.abs(S.mergeScale([L('a', { scale: 0.1 })], 3000, 3000) - Math.sqrt(64e6 / 9e6)) < 1e-9);
});
test('undo of a merge puts the same layers back', () => {
  const a = L('a', { opacity: 0.5 }), b = L('b'), E = { layers: [a, b], groups: [] }, was = S.stackState(E.layers, E.groups);
  E.layers = S.mergedStack(E.layers, E.groups, [a, b], L('x'));
  S.applyState(E, was);
  assert.deepEqual(keys(E.layers), ['a', 'b']);
  assert.equal(E.layers[0], a);
});

test('undo brings back a layer\'s adjust and what its mask works on', () => {
  const l = L('a', { adjust: { exposure: 1 } }), m = L('m', { maskOf: 'a' });
  const was = S.stackState([l, m]);
  l.adjust = { exposure: 2 }; l.maskFor = 'adjust';
  assert.equal(S.sameState(was, S.stackState([l, m])), false);
  const E = { layers: [], groups: [] };
  S.applyState(E, was);
  assert.deepEqual(l.adjust, { exposure: 1 });
  assert.equal(l.maskFor, undefined);
});

test('Duplicate: copies over the topmost, masks with them, nothing shared', () => {
  let n = 0;
  const o = { newKey: () => `k${++n}`, name: (l) => l.label };
  const a = L('a', { key: 'a', label: 'A', crop: { x: 0 }, adjust: { on: 1 } }), m = L('am', { maskOf: 'a', key: 'am', label: 'A mask', crop: { x: 0 } }), b = L('b', { key: 'b', label: 'B', crop: { x: 0 } }), red = L('red', { mask: true, crop: { x: 0 } });
  const r = S.duplicate([a, m, b, red], [], [a], o);
  assert.equal(r.copies.length, 1);
  const c = r.copies[0];
  assert.equal(c.label, 'A copy');
  assert.notEqual(c.key, 'a');
  assert.deepEqual(r.layers.map((l) => l.label), ['A', 'A mask', 'A copy', 'A copy mask', 'B', undefined].map((x, i) => (i === 5 ? r.layers[5].label : x)));
  assert.equal(r.layers[3].maskOf, c.key, 'its own mask');
  assert.notEqual(c.crop, a.crop); assert.notEqual(c.adjust, a.adjust);
  assert.equal(S.duplicate([a, m, b, red], [], [m], o).copies[0].label, 'A copy', 'its mask picked means the layer');
  assert.equal(S.duplicate([a, red], [], [red], o).copies.length, 0, 'the red mask is no picture');
  const two = S.duplicate([a, m, b], [], [b, a], o);
  assert.deepEqual(two.copies.map((l) => l.label), ['A copy', 'B copy'], 'the stack\'s order');
  assert.equal(two.layers.indexOf(two.copies[0]), 3, 'over the topmost');
  const g = L('g', { key: 'g', label: 'G', group: 'x', crop: { x: 0 } }), h = L('h', { key: 'h', label: 'H', group: 'x', crop: { x: 0 } });
  const inG = S.duplicate([g, h], [{ id: 'x' }], [g], o);
  assert.equal(inG.copies[0].group, 'x', 'it stays in its group');
});

test('copy takes a layer with its mask, in stack order; a picked mask means its layer; masks for the brush and drafts stay out', () => {
  const a = { key: 'a', name: 'a' }, m = { key: 'm', name: 'm', maskOf: 'a' }, b = { key: 'b', name: 'b' }, red = { name: 'r', mask: true }, d = { name: 'd', draft: true };
  assert.deepEqual(S.clipOf([a, m, b, red, d], [b, a]), [a, m, b]);
  assert.deepEqual(S.clipOf([a, m, b], [m]), [a, m]);
  assert.deepEqual(S.clipOf([a, m, b, red, d], [red, d]), []);
});

test('pasted layers get new keys, a mask follows its layer, and a group comes along under a new id', () => {
  let n = 0;
  const saved = [{ key: 'a', name: 'a', group: 'g1', adjust: { sat: 1 } }, { key: 'm', name: 'm', maskOf: 'a', group: 'g1' }, { name: 'plain', group: 'gone' }];
  const r = S.pastedLayers(saved, [{ id: 'g1', name: 'Faces' }, { id: 'g2', name: 'Other' }], { newKey: () => `k${++n}`, newGroup: () => 'new' });
  assert.deepEqual(r.layers.map((l) => l.key), ['k1', 'k2', undefined]);
  assert.equal(r.layers[1].maskOf, 'k1');
  assert.deepEqual(r.layers.map((l) => l.group), ['new', 'new', undefined]);
  assert.deepEqual(r.groups, [{ id: 'new', name: 'Faces' }]);
  assert.notEqual(r.layers[0].adjust, saved[0].adjust, 'its own copy');
  assert.equal(saved[0].key, 'a', 'the copied list stays, to paste again');
});

test('a mask whose layer did not come along is not pasted', () => {
  const r = S.pastedLayers([{ key: 'm', name: 'm', maskOf: 'lost' }], [], { newKey: () => 'k', newGroup: () => 'g' });
  assert.deepEqual(r.layers, []);
});

test('delete hidden takes hidden layers and their masks, not locked ones, drafts, or a mask hidden by itself on a showing layer', () => {
  const a = { key: 'a', name: 'a', hidden: true }, am = { key: 'am', name: 'am', maskOf: 'a', hidden: true }, b = { key: 'b', name: 'b' }, bm = { key: 'bm', name: 'bm', maskOf: 'b', hidden: true };
  const held = { key: 'c', name: 'c', hidden: true, locked: true }, red = { name: 'r', mask: true, hidden: true }, d = { name: 'd', draft: true, hidden: true };
  const r = S.hiddenOnes([a, am, b, bm, held, red, d]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.keep, [b, bm, held, red, d]);
  assert.equal(S.hiddenOnes([b]).count, 0);
});

