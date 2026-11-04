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

test('a submenu opens beside its item, flips left at the right edge and moves up to stay on screen', async () => {
  const { subSpot } = await import('../web/layer-menu.js');
  assert.deepEqual(subSpot({ left: 100, right: 300, top: 50 }, 200, 100, 1000, 800), { left: 300, top: 50, flipped: false });
  assert.deepEqual(subSpot({ left: 800, right: 990, top: 750 }, 200, 100, 1000, 800), { left: 600, top: 696, flipped: true });
  assert.deepEqual(subSpot({ left: 2, right: 150, top: 10 }, 300, 100, 320, 800), { left: 4, top: 10, flipped: true });
});

// ---- the timeline's menus ----
import { clipMenu, keyMenu, rulerMenu, trackMenu } from '../web/layer-menu.js';

test('clip menu: clipboard, split, delete, selecting; Paste only with something copied', () => {
  const m = clipMenu({ n: 1, canPaste: true, canSplit: true, locked: false, hasKeys: false, kind: 'video' });
  assert.deepEqual(ids(m), [['cut', 'copy', 'paste', 'duplicate'], ['split', 'crossfade'], ['rippleDelete', 'delete'], ['selectTrack', 'selectAfter']]);
  assert.ok(!clipMenu({ n: 1, kind: 'video' }).flat().some((i) => i.id === 'paste'));
  assert.equal(clipMenu({ n: 1, canSplit: false, kind: 'video' }).flat().find((i) => i.id === 'split').disabled, true);
});
test('clip menu: several clips, sound clips, nothing picked, locked', () => {
  const several = clipMenu({ n: 3, canSplit: true, kind: 'video' }).flat();
  assert.equal(several.find((i) => i.id === 'delete').label, 'Delete 3');
  assert.ok(!several.some((i) => i.id === 'crossfade'));
  assert.ok(!clipMenu({ n: 1, kind: 'audio' }).flat().some((i) => i.id === 'crossfade'));
  assert.deepEqual(ids(clipMenu({ n: 0, canPaste: true })), [['paste'], ['selectTrack', 'selectAfter']]);
  assert.ok(clipMenu({ n: 1, locked: true, kind: 'video' }).flat().find((i) => i.id === 'delete').disabled);
});
test('track menu: Hide is for video; Remove only when empty and not the last of its kind', () => {
  const v = trackMenu({ kind: 'video', locked: true, empty: true, only: false }).flat();
  assert.equal(v.find((i) => i.id === 'lock').label, 'Unlock');
  assert.ok(v.some((i) => i.id === 'hide'));
  assert.ok(!v.find((i) => i.id === 'remove').disabled);
  assert.ok(!trackMenu({ kind: 'audio' }).flat().some((i) => i.id === 'hide'));
  assert.ok(trackMenu({ kind: 'audio', empty: false }).flat().find((i) => i.id === 'remove').disabled);
  assert.ok(trackMenu({ kind: 'audio', empty: true, only: true }).flat().find((i) => i.id === 'remove').disabled);
  assert.equal(trackMenu({ kind: 'video', solo: true }).flat().find((i) => i.id === 'solo').on, true);
});
test('ruler menu: marker and work area items appear only when they apply', () => {
  assert.deepEqual(ids(rulerMenu({})), [['addMarker'], ['areaStart', 'areaEnd']]);
  assert.deepEqual(ids(rulerMenu({ marker: true, hasRange: true })), [['addMarker', 'renameMarker', 'removeMarker'], ['areaStart', 'areaEnd', 'areaClear']]);
});
test('key menu: Ease opens the names it is given', () => {
  const m = keyMenu({ n: 2, canPaste: true, eases: ['linear', 'ease-in'] });
  assert.deepEqual(ids(m), [['copy', 'paste', 'delete'], ['ease']]);
  assert.deepEqual(m[1][0].subItems.map((i) => i.label), ['linear', 'ease-in']);
  assert.deepEqual(ids(keyMenu({ n: 0, canPaste: true, eases: ['linear'] })), [['paste']]);
});
