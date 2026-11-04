// node --test tests/layer_menu.test.mjs: what the layers' menu offers, in what order, and where it goes (web/layer-menu.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { cropShapeMenu, layerMenu, menuSpot, pickedFor } from '../web/layer-menu.js';

const ids = (m) => m.map((g) => g.map((i) => i.id));
const base = { layers: 3, selected: 0, pictures: 0, hidden: 0, clip: false, pickMode: false, newEdit: true, mergeDown: true, mergeSet: true };

test('one layer: selecting, the clipboard, merging, sending elsewhere and removing, in that order', () => {
  assert.deepEqual(ids(layerMenu({ ...base, selected: 1, pictures: 1, clip: true, hidden: 2 })), [
    ['all', 'none', 'several'], ['copy', 'paste', 'duplicate'], ['mergeDown'], ['saveEach', 'openNew', 'moveNew'], ['delete', 'deleteHidden', 'clear']]);
});
test('several layers get the words and the actions for several', () => {
  const m = layerMenu({ ...base, selected: 3, pictures: 3 }), all = m.flat();
  assert.deepEqual(ids(m)[2], ['group', 'mergeSelected']);
  assert.deepEqual(ids(m)[3], ['saveEach', 'saveTogether', 'openNew', 'moveNew']);
  assert.equal(all.find((i) => i.id === 'saveEach').label, 'Save each as input');
  assert.equal(all.find((i) => i.id === 'delete').label, 'Delete 3 selected');
});
test('with nothing selected, only what needs no selection is there, and no group is left empty', () => {
  assert.deepEqual(ids(layerMenu({ ...base, clip: true })), [['all', 'several'], ['paste'], ['clear']]);
});
test('with no layers, only Paste, and only with something copied', () => {
  assert.deepEqual(ids(layerMenu({ ...base, layers: 0, clip: true })), [['paste']]);
  assert.deepEqual(layerMenu({ ...base, layers: 0 }), []);
});
test('a host with no new edits offers neither', () => {
  const all = layerMenu({ ...base, selected: 1, pictures: 1, newEdit: false }).flat().map((i) => i.id);
  assert.ok(!all.includes('openNew')); assert.ok(!all.includes('moveNew'));
});
test('a mask alone can be moved or deleted, but has no picture to save', () => {
  const all = layerMenu({ ...base, selected: 1, pictures: 0 }).flat().map((i) => i.id);
  assert.ok(!all.includes('saveEach')); assert.ok(!all.includes('openNew')); assert.ok(all.includes('moveNew'));
});
test('a merge that can\'t happen is greyed, not hidden', () => {
  const merge = (s) => layerMenu({ ...base, ...s }).flat().find((i) => /^merge/.test(i.id));
  assert.equal(merge({ selected: 1, mergeDown: false }).disabled, true);
  assert.equal(merge({ selected: 1 }).disabled, false);
  assert.equal(merge({ selected: 2, mergeSet: false }).disabled, true);
});
test('removing is marked as dangerous, and Select several shows when it is on', () => {
  const all = layerMenu({ ...base, selected: 1, hidden: 1, pickMode: true }).flat();
  assert.deepEqual(all.filter((i) => i.danger).map((i) => i.id), ['delete', 'deleteHidden', 'clear']);
  assert.equal(all.find((i) => i.id === 'several').on, true);
});
test('a press on a selected layer keeps the selection; on another layer it picks that one; off any layer nothing changes', () => {
  const a = {}, b = {}, c = {};
  assert.deepEqual(pickedFor([a, b], a), [a, b]);
  assert.deepEqual(pickedFor([a, b], c), [c]);
  assert.deepEqual(pickedFor([a, b], null), [a, b]);
});
test('the menu stays on screen, flipping away from the edge it would pass', () => {
  assert.deepEqual(menuSpot(100, 100, 200, 300, 1000, 800), { left: 100, top: 100 });
  assert.deepEqual(menuSpot(900, 700, 200, 300, 1000, 800), { left: 700, top: 400 });
  assert.deepEqual(menuSpot(10, 100, 200, 900, 300, 800), { left: 10, top: 4 });
});

test('a crop box offers its shapes in order, with the one in use ticked', () => {
  const shapes = [['Free', null], ['16:9', 16 / 9], ['9:16', 9 / 16]];
  const on = (cur) => cropShapeMenu(shapes, cur)[0].filter((i) => i.on).map((i) => i.label);
  assert.deepEqual(cropShapeMenu(shapes, null)[0].map((i) => [i.label, i.aspect]), [['Free', null], ['16:9', 16 / 9], ['9:16', 9 / 16]]);
  assert.deepEqual(on(null), ['Free']);
  assert.deepEqual(on(undefined), ['Free']);
  assert.deepEqual(on(9 / 16), ['9:16']);
});
