// node --test tests/table_stack.test.mjs: a table's frames as a layer stack (groups, rows, z-order steps, hide, undo
// snapshots), the frame menu, and Arrange (align, distribute, same size, tidy) in web/table-model.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../web/table-model.js';
import * as ST from '../web/layer-stack.js';
import { frameMenu, frameArrangeMenu, layerMenu } from '../web/layer-menu.js';

const F = (id, x, y, w, h, more = {}) => ({ id, key: id, kind: 'image', doc: null, label: id, x, y, w, h, ...more });
const ids = (list) => list.map((f) => f.id);

test('a saved table: groups made whole, members together, a lost group dropped, keys are ids', () => {
  const t = M.migrateTable({ groups: [{ id: 'g', name: 'Pair', opacity: 0.5 }, { id: 'empty' }, { name: 'no id' }],
    frames: [{ id: 'a', kind: 'image', group: 'g' }, { id: 'b', kind: 'note' }, { id: 'c', kind: 'video', group: 'g' }, { id: 'd', kind: 'image', group: 'gone' }] });
  assert.deepEqual(t.groups, [{ id: 'g', name: 'Pair', collapsed: false }]);
  assert.deepEqual(ids(t.frames), ['a', 'c', 'b', 'd']);
  assert.deepEqual(t.frames.map((f) => f.key), ['a', 'c', 'b', 'd']);
  assert.equal(t.frames[3].group, undefined);
  assert.deepEqual(M.migrateTable({}).groups, []);
});

test('a new frame\'s key is its id', () => {
  const f = M.newFrame('image', { x: 0, y: 0, w: 10, h: 10 });
  assert.equal(f.key, f.id);
});

test('the layer stack rules work on frames: group, rows, move a row, ungroup', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => F(id, 0, 0, 10, 10));
  const groups = [];
  let fs = ST.makeGroup([a, b, c, d], groups, [a, c], 'g', 'Group 1', {});
  assert.deepEqual(groups, [{ id: 'g', name: 'Group 1', collapsed: false }]);   // (no opacity or blend for frames)
  assert.deepEqual(ids(fs), ['b', 'a', 'c', 'd']);
  const rows = ST.rowsOf(fs, groups);   // top first
  assert.deepEqual(rows.map((r) => r.group?.id || r.layer.id), ['d', 'g', 'c', 'a', 'b']);
  fs = ST.moveRow(fs, groups, 0, 4);   // d to the bottom
  assert.deepEqual(ids(fs), ['d', 'b', 'a', 'c']);
  fs = ST.moveRow(fs, groups, 4, 2);   // d dropped on a member: joins the group
  assert.equal(d.group, 'g');
  fs = ST.ungroup(fs, groups, 'g');
  assert.deepEqual(groups, []);
  assert.ok(fs.every((f) => !f.group));
});

test('the editor\'s groups still get opacity and blend', () => {
  const groups = [];
  ST.makeGroup([F('a', 0, 0, 1, 1), F('b', 0, 0, 1, 1)], groups, [], 'x');
  const [a, b] = [F('a', 0, 0, 1, 1), F('b', 0, 0, 1, 1)];
  ST.makeGroup([a, b], groups, [a, b], 'g');
  assert.deepEqual(groups, [{ id: 'g', name: 'Group 1', opacity: 1, blend: 'normal', collapsed: false }]);
});

test('withoutPicked keeps locked frames', () => {
  const [a, b] = [F('a', 0, 0, 1, 1), F('b', 0, 0, 1, 1, { locked: true })];
  const r = ST.withoutPicked([a, b], [a, b]);
  assert.deepEqual([ids(r.keep), r.count], [['b'], 1]);
});

test('z-order steps: one place, within a group, over a group, a whole group as one', () => {
  const g = (id, group) => F(id, 0, 0, 1, 1, group ? { group } : {});
  const fs = [g('a'), g('b'), g('m1', 'G'), g('m2', 'G'), g('c')];
  assert.deepEqual(ids(M.stepZ(fs, ['a'], 1)), ['b', 'a', 'm1', 'm2', 'c']);
  assert.deepEqual(ids(M.stepZ(fs, ['b'], 1)), ['a', 'm1', 'm2', 'b', 'c']);   // over the whole group
  assert.deepEqual(ids(M.stepZ(fs, ['m1'], 1)), ['a', 'b', 'm2', 'm1', 'c']);
  assert.deepEqual(ids(M.stepZ(fs, ['m2'], 1)), ids(fs));   // the top of its group: stays in it
  assert.deepEqual(ids(M.stepZ(fs, ['m1'], -1)), ids(fs));
  assert.deepEqual(ids(M.stepZ(fs, ['m1', 'm2'], 1)), ['a', 'b', 'c', 'm1', 'm2']);   // the whole group
  assert.deepEqual(ids(M.stepZ(fs, ['c'], -1)), ['a', 'b', 'c', 'm1', 'm2']);
  assert.deepEqual(ids(M.stepZ(fs, ['a', 'b'], 1)), ['m1', 'm2', 'a', 'b', 'c']);
  assert.deepEqual(ids(M.stepZ([g('a'), g('b'), g('c')], ['a', 'b'], 1)), ['c', 'a', 'b']);
  assert.deepEqual(ids(M.stepZ([g('a'), g('b'), g('c')], ['b', 'c'], 1)), ['a', 'b', 'c']);   // the top one holds the other back
  assert.deepEqual(ids(M.stepZ([g('a'), g('b'), g('c')], ['a'], -1)), ['a', 'b', 'c']);
});

test('front and back keep a group together', () => {
  const g = (id, group) => F(id, 0, 0, 1, 1, group ? { group } : {});
  const groups = [{ id: 'G', name: 'G', collapsed: false }];
  const fs = [g('m1', 'G'), g('m2', 'G'), g('a')];
  assert.deepEqual(ids(ST.normalize(M.toFront(fs, ['m1']), groups)), ['m2', 'm1', 'a']);
  assert.deepEqual(ids(ST.normalize(M.toFront(fs, ['m1', 'm2']), groups)), ['a', 'm1', 'm2']);
});

test('undo snapshots: order, groups, hidden and locked come back by id; a frame gone stays gone', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => F(id, 0, 0, 1, 1));
  let groups = [];
  const before = M.stackSnap([a, b, c], groups);
  let fs = ST.makeGroup([a, b, c], groups, [a, c], 'g', 'G', {});
  b.hidden = true; c.locked = true;
  const after = M.stackSnap(fs, groups);
  assert.ok(!M.sameSnap(before, after));
  let r = M.applySnap(fs, before);
  assert.deepEqual(ids(r.frames), ['a', 'b', 'c']);
  assert.deepEqual(r.groups, []);
  assert.ok(!a.group && !b.hidden && !c.locked);
  r = M.applySnap(r.frames.filter((f) => f !== b), after);   // b was deleted since
  assert.deepEqual(ids(r.frames), ['a', 'c']);
  assert.deepEqual([a.group, c.group, c.locked], ['g', 'g', true]);
  const d = F('d', 0, 0, 1, 1);   // made since: kept, on top
  r = M.applySnap([d, a, c], before);
  assert.deepEqual(ids(r.frames), ['a', 'c', 'd']);
});

test('hidden frames: shown() leaves them out, in their place', () => {
  const fs = [F('a', 0, 0, 1, 1), F('b', 0, 0, 1, 1, { hidden: true })];
  assert.deepEqual(ids(M.shown(fs)), ['a']);
});

test('align to the selection\'s bounds; a locked frame stays; the line on the grid', () => {
  const fs = [F('a', 10, 0, 100, 50), F('b', 200, 100, 50, 80), F('c', 60, 300, 20, 20, { locked: true })];
  const xy = (out) => out.map((f) => [f.x, f.y]);
  assert.deepEqual(xy(M.alignFrames(fs, 'left')), [[10, 0], [10, 100], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'right')), [[150, 0], [200, 100], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'hcenter')), [[80, 0], [105, 100], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'top')), [[10, 0], [200, 0], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'bottom')), [[10, 270], [200, 240], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'vcenter')), [[10, 135], [200, 120], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames(fs, 'left', { step: 64 })), [[0, 0], [0, 100], [60, 300]]);
  assert.deepEqual(xy(M.alignFrames([fs[0]], 'left')), [[10, 0]]);
  assert.throws(() => M.alignFrames(fs, 'middle'));
  assert.notEqual(M.alignFrames(fs, 'left')[0], fs[0]);   // new objects
});

test('distribute: even gaps, even centres, a fixed gap', () => {
  const fs = [F('c', 500, 0, 300, 10), F('a', 0, 0, 100, 10), F('b', 120, 0, 200, 10)];
  const x = (out) => out.map((f) => f.x);
  assert.deepEqual(x(M.distributeFrames(fs, 'x')), [500, 0, 200]);   // gaps of 100 either side of b
  assert.deepEqual(x(M.distributeFrames(fs, 'x', { centres: true })), [500, 0, 250]);   // centres 50, 350, 650
  assert.deepEqual(x(M.distributeFrames(fs, 'x', { gap: 10 })), [320, 0, 110]);
  assert.deepEqual(x(M.distributeFrames(fs, 'x', { gap: 10, step: 64 })), [320, 0, 128]);
  const ys = [F('a', 0, 0, 10, 10), F('b', 0, 15, 10, 10), F('c', 0, 100, 10, 10)];
  assert.deepEqual(M.distributeFrames(ys, 'y').map((f) => f.y), [0, 50, 100]);
});

test('same size: to the first picked or the largest; locked stays', () => {
  const fs = [F('a', 0, 0, 100, 50), F('b', 0, 0, 300, 200), F('c', 0, 0, 10, 10, { locked: true })];
  const wh = (out) => out.map((f) => [f.w, f.h]);
  assert.deepEqual(wh(M.sameSize(fs, 'w')), [[100, 50], [100, 200], [10, 10]]);
  assert.deepEqual(wh(M.sameSize(fs, 'h')), [[100, 50], [300, 50], [10, 10]]);
  assert.deepEqual(wh(M.sameSize(fs, 'both', { to: 'largest' })), [[300, 200], [300, 200], [10, 10]]);
});

test('tidy: side by side, stacked, a grid, from the selection\'s corner', () => {
  const fs = [F('b', 300, 10, 100, 100), F('a', 10, 20, 200, 50), F('c', 50, 400, 100, 30)];
  const xy = (out) => Object.fromEntries(out.map((f) => [f.id, [f.x, f.y]]));
  assert.deepEqual(xy(M.tidyRows(fs, { mode: 'row', gap: 10 })), { a: [10, 35], c: [220, 45], b: [330, 10] });
  assert.deepEqual(xy(M.tidyRows(fs, { mode: 'column', gap: 10 })), { b: [60, 10], a: [10, 120], c: [60, 180] });
  assert.deepEqual(xy(M.tidyRows(fs, { mode: 'grid', gap: 10 })), { b: [10, 10], a: [120, 35], c: [10, 120] });
  assert.deepEqual(xy(M.tidyRows(fs, { mode: 'row', gap: 0, step: 64 })), { a: [0, 25], c: [200, 35], b: [300, 0] });
});

test('the frame menu: the same groups for the table and the list; what doesn\'t apply is greyed or left out', () => {
  const one = frameMenu({ selected: 1, openable: true });
  const flat = (g) => g.flat().map((i) => i.id);
  assert.deepEqual(flat(one), ['open', 'rename', 'duplicate', 'hide', 'lock', 'front', 'forward', 'backward', 'back', 'align', 'distribute', 'sameSize', 'size', 'delete']);
  assert.ok(one.flat().find((i) => i.id === 'align').disabled);
  const two = frameMenu({ selected: 2, grouped: true, hidden: true, locked: true, extra: [[{ id: 'x', label: 'X' }]] });
  assert.deepEqual(flat(two).slice(0, 6), ['open', 'rename', 'duplicate', 'group', 'ungroup', 'hide']);
  assert.equal(two.flat().find((i) => i.id === 'hide').label, 'Show');
  assert.equal(two.flat().find((i) => i.id === 'lock').label, 'Unlock');
  assert.ok(two.flat().find((i) => i.id === 'delete').disabled);
  assert.deepEqual(two.at(-2).map((i) => i.id), ['x']);   // other modules' items, before Delete
  assert.deepEqual(frameMenu({ selected: 0 }), []);
  const a = frameArrangeMenu();
  assert.deepEqual(Object.keys(a), ['align', 'distribute', 'tidy', 'size']);
  assert.equal(a.align.length, 6);
  assert.ok(layerMenu({ layers: 1, selected: 1 }).length);   // (the editor's own is still there)
});
