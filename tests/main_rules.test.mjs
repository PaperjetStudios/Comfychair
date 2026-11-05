// node --test tests/main_rules.test.mjs: a frame's main source (web/main-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mainOf, mainName, plainLayer, keepMain, withoutMade, pinStamp } from '../web/main-rules.js';
import { migrateTable } from '../web/table-model.js';

const L = (key, name, more = {}) => ({ key, name, crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, scale: 1, opacity: 1, ...more });
const img = { layers: [L('k1', 'in/a.png', { label: 'Base' }), L('k2', 'in/b.png'), { key: 'm1', name: 'in/m.png', maskOf: 'k2' }] };
const vid = { items: [{ id: 'c1', kind: 'video', src: { generation: 4 }, label: 'Shot' }, { id: 'c2', kind: 'video', src: { media: 'x/y.mp4' } }] };

test('mainOf: the pinned layer or item, null when unpinned or gone', () => {
  assert.equal(mainOf({ kind: 'image', main: 'k2' }, img).name, 'in/b.png');
  assert.equal(mainOf({ kind: 'image', main: 'k2' }, { payload: img }).name, 'in/b.png', 'a document or its payload');
  assert.equal(mainOf({ kind: 'image' }, img), null);
  assert.equal(mainOf({ kind: 'image', main: 'gone' }, img), null);
  assert.equal(mainOf({ kind: 'image', main: 'm1' }, img), null, 'a mask is never the main source');
  assert.equal(mainOf({ kind: 'video', main: 'c2' }, vid).id, 'c2');
  assert.equal(mainOf({ kind: 'sound', main: 'c9' }, vid), null);
  assert.equal(mainOf({ kind: 'video', main: 'c1' }, null), null);
});

test('mainName: the label, else the file, else the run', () => {
  assert.equal(mainName({ kind: 'image', main: 'k1' }, img), 'Base');
  assert.equal(mainName({ kind: 'image', main: 'k2' }, img), 'b.png');
  assert.equal(mainName({ kind: 'video', main: 'c1' }, vid), 'Shot');
  assert.equal(mainName({ kind: 'video', main: 'c2' }, vid), 'y.mp4');
  assert.equal(mainName({ kind: 'video', main: 'zz' }, vid), null);
});

test('plainLayer: whole, unturned, opaque, no mask passes straight through; moved or scaled still does', () => {
  assert.equal(plainLayer(L('a', 'in/a.png', { x: 40, y: 9, scale: 0.5 })), 'in/a.png');
  assert.equal(plainLayer(L('a', 'in/a.png', { crop: { x: 0.1, y: 0, w: 0.9, h: 1 } })), null);
  assert.equal(plainLayer(L('a', 'in/a.png', { rotation: 15 })), null);
  assert.equal(plainLayer(L('a', 'in/a.png', { opacity: 0.5 })), null);
  assert.equal(plainLayer(L('a', 'in/a.png', { flipX: true })), null);
  assert.equal(plainLayer(L('a', 'in/a.png', { adjust: { on: true } })), null);
  assert.equal(plainLayer(L('a', 'in/a.png', { canvas: true })), null, 'a painted layer');
  assert.equal(plainLayer(img.layers[1], img.layers), null, 'it has a mask');
  assert.equal(plainLayer(img.layers[1], [img.layers[1], { ...img.layers[2], maskOff: true }]), 'in/b.png', 'its mask is off');
  assert.equal(plainLayer(null), null);
});

test('keepMain: a chain run never takes out the pinned layer or item', () => {
  assert.deepEqual(keepMain(['k2', 'kz'], { kind: 'image', main: 'k2' }, img), ['kz']);
  assert.deepEqual(keepMain(['k2'], { kind: 'image' }, img), ['k2'], 'no pin: as it was');
  assert.deepEqual(keepMain(['c1', 'c2'], { kind: 'video', main: 'c1' }, vid), ['c2']);
  assert.deepEqual(keepMain(undefined, { kind: 'video', main: 'c1' }, vid), []);
});

test('withoutMade: the last chain run\'s results left out of what the frame shows (and their masks)', () => {
  const p = withoutMade(img, ['k2']);
  assert.deepEqual(p.layers.map((l) => l.key), ['k1'], 'the layer and its mask');
  assert.equal(img.layers.length, 3, 'the document itself is untouched');
  assert.deepEqual(withoutMade({ payload: vid }, ['c1']).items.map((i) => i.id), ['c2']);
  assert.equal(withoutMade(img, []), img);
  assert.equal(withoutMade(img, null), img);
});

test('pinStamp, and the table keeps frame.main', () => {
  assert.equal(pinStamp({ main: 'k1' }), '+m:k1');
  assert.equal(pinStamp({}), '');
  const t = migrateTable({ frames: [{ id: 'a', kind: 'image', main: 'k1' }, { id: 'b', kind: 'video', main: '' }, { id: 'c', kind: 'sound', main: 7 }] });
  assert.equal(t.frames[0].main, 'k1');
  assert.ok(!('main' in t.frames[1]), 'an empty pin goes');
  assert.equal(t.frames[2].main, '7', 'kept as text');
});
