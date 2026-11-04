// node --test tests/table_model.test.mjs: a table's frames, view, snapping and layouts (web/table-model.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankTable, migrateTable, newFrame, hitFrame, framesIn, moveFrames, resizeFrame, snapRect, snapValue, boundsOf, fitView,
  zoomAt, toTable, toStage, liveView, rowLayout, nextBeside, mpOf, sizeForMp, toFront, toBack, rectFrom,
  rowsOf, layoutRows, liveBackdrop,
} from '../web/table-model.js';

const F = (id, x, y, w, h, more = {}) => ({ id, kind: 'image', doc: null, label: id, x, y, w, h, ...more });

test('a blank table and a partial payload made whole', () => {
  assert.deepEqual(blankTable(), { v: 1, view: { x: 0, y: 0, z: 1 }, grid: { on: true, size: 64 }, frames: [] });
  const t = migrateTable({ view: { z: 0 }, frames: [{ id: 'a', kind: 'video', x: '5' }, { kind: 'bogus' }, null] });
  assert.equal(t.view.z, 1);
  assert.equal(t.frames.length, 1);
  assert.deepEqual([t.frames[0].x, t.frames[0].w, t.frames[0].label, t.frames[0].doc], [5, 512, 'Video', null]);
});

test('a new frame: whole pixels, a floor on its sides, extras kept', () => {
  const f = newFrame('note', { x: 1.4, y: 2.6, w: 3, h: 100.4 }, { text: 'hi' });
  assert.deepEqual([f.x, f.y, f.w, f.h, f.kind, f.text, f.label], [1, 3, 16, 100, 'note', 'hi', 'Note']);
  assert.ok(f.id.length >= 8);
  assert.notEqual(newFrame('image', f).id, f.id);
});

test('hit test takes the topmost; the marquee takes what it touches', () => {
  const fs = [F('a', 0, 0, 100, 100), F('b', 50, 50, 100, 100)];
  assert.equal(hitFrame(fs, { x: 60, y: 60 }).id, 'b');
  assert.equal(hitFrame(fs, { x: 10, y: 10 }).id, 'a');
  assert.equal(hitFrame(fs, { x: 500, y: 10 }), null);
  assert.deepEqual(framesIn(fs, rectFrom({ x: 140, y: 140 }, { x: 120, y: 120 })).map((f) => f.id), ['b']);
  assert.deepEqual(framesIn(fs, { x: 200, y: 0, w: 10, h: 10 }), []);
});

test('moving skips locked frames and leaves the rest untouched', () => {
  const fs = [F('a', 0, 0, 10, 10), F('b', 0, 0, 10, 10, { locked: true }), F('c', 0, 0, 10, 10)];
  const out = moveFrames(fs, ['a', 'b'], 5.4, -3);
  assert.deepEqual([out[0].x, out[0].y], [5, -3]);
  assert.equal(out[1], fs[1]);
  assert.equal(out[2], fs[2]);
});

test('z-order to front and back keeps the order among the moved', () => {
  const fs = [F('a', 0, 0, 1, 1), F('b', 0, 0, 1, 1), F('c', 0, 0, 1, 1)];
  assert.deepEqual(toFront(fs, ['a', 'b']).map((f) => f.id), ['c', 'a', 'b']);
  assert.deepEqual(toBack(fs, ['c']).map((f) => f.id), ['c', 'a', 'b']);
});

test('resizing: sides, the opposite edge stays, a minimum, and corners that keep the shape', () => {
  const f = F('a', 100, 100, 200, 100);
  assert.deepEqual(pick(resizeFrame(f, 'e', 50, 999)), [100, 100, 250, 100]);
  assert.deepEqual(pick(resizeFrame(f, 'w', 50, 0)), [150, 100, 150, 100]);
  assert.deepEqual(pick(resizeFrame(f, 'n', 0, 500)), [100, 184, 200, 16]);
  assert.deepEqual(pick(resizeFrame(f, 'se', 100, 0, { keepAspect: true })), [100, 100, 300, 150]);
  assert.deepEqual(pick(resizeFrame(f, 'nw', -200, 0, { keepAspect: true })), [-100, 0, 400, 200]);
  assert.deepEqual(pick(resizeFrame(f, 'se', 7, 0, { snap: (a, v) => Math.round(v / 10) * 10 })), [100, 100, 210, 100]);
});
const pick = (r) => [r.x, r.y, r.w, r.h];

test('snapping: edges and centres first, then the grid, and nothing when off', () => {
  const others = [F('o', 300, 0, 100, 100)];
  const s = snapRect({ x: 195, y: 5, w: 100, h: 50 }, others, { on: true, size: 64 }, 8);
  assert.equal(s.x, 200);   // its right edge on the other's left
  assert.equal(s.y, 0);     // top onto the other's top
  assert.deepEqual(s.guides, [{ x: 300 }, { y: 0 }]);
  const g = snapRect({ x: 70, y: 500, w: 10, h: 10 }, others, { on: true, size: 64 }, 4);
  assert.deepEqual([g.x, g.y, g.guides.length], [64, 512, 0]);
  const off = snapRect({ x: 70, y: 500, w: 10, h: 10 }, others, { on: false, size: 64 }, 4, { edges: false });
  assert.deepEqual([off.x, off.y], [70, 500]);
  assert.equal(snapValue(297, 'x', others, null, 5), 300);
  assert.equal(snapValue(250, 'x', others, { on: true, size: 100 }, 5), 300);
});

test('bounds, fit and zoom about a point', () => {
  const fs = [F('a', 0, 0, 100, 100), F('b', 300, 100, 100, 100)];
  assert.deepEqual(boundsOf(fs), { x: 0, y: 0, w: 400, h: 200 });
  assert.equal(boundsOf([]), null);
  const v = fitView(boundsOf(fs), 1000, 600, 100);
  assert.equal(v.z, 2);
  assert.deepEqual(toStage(v, 200, 100), { x: 500, y: 300 });   // the middle of the bounds in the middle of the stage
  const z = zoomAt({ x: 10, y: 20, z: 1 }, 110, 220, 2);
  assert.deepEqual(toTable(z, 110, 220), toTable({ x: 10, y: 20, z: 1 }, 110, 220));
  assert.equal(zoomAt({ x: 0, y: 0, z: 1 }, 0, 0, 100, 0.1, 4).z, 4);
  assert.deepEqual(liveView(F('a', 100, 100, 200, 100), 1000, 600), { x: 300, y: 150, z: 1 });
});

test('row layout: shots left to right, scenes one under another', () => {
  const rows = rowLayout([[F('a', 0, 0, 100, 50), F('b', 0, 0, 200, 80)], [F('c', 0, 0, 10, 10)]], { gap: 10, rowGap: 20 });
  assert.deepEqual(rows.map((r) => r.map((f) => [f.x, f.y])), [[[0, 0], [110, 0]], [[0, 100]]]);
});

test('next beside: right of the last of its kind, past anything in the way', () => {
  assert.deepEqual(nextBeside([], 'image'), { x: 0, y: 0 });
  const fs = [F('a', 0, 0, 100, 100), F('b', 140, 0, 100, 100, { kind: 'video' })];
  assert.deepEqual(nextBeside(fs, 'image', { w: 100, h: 100, gap: 40 }), { x: 280, y: 0 });
  assert.deepEqual(nextBeside(fs, 'sound', { w: 100, h: 100, gap: 40 }), { x: 280, y: 0 });
});

test('megapixels: the same shape, sides on 16', () => {
  assert.equal(mpOf(1000, 1000), 1);
  assert.deepEqual(sizeForMp(1, 1, 1), { w: 1008, h: 1008 });
  const s = sizeForMp(1920, 1080, 1);
  assert.equal(s.w % 16, 0); assert.equal(s.h % 16, 0);
  assert.ok(Math.abs(s.w / s.h - 16 / 9) < 0.02);
  assert.ok(Math.abs(mpOf(s.w, s.h) - 1) < 0.03);
});

test('rows: frames grouped by overlapping tops and bottoms, each row left to right', () => {
  const fs = [F('c', 300, 10, 100, 100), F('a', 0, 0, 100, 100), F('b', 150, 40, 100, 100), F('d', 0, 400, 50, 50), F('e', -90, 420, 50, 50)];
  assert.deepEqual(rowsOf(fs).map((r) => r.map((f) => f.id)), [['a', 'b', 'c'], ['e', 'd']]);
  // apart by 20: two rows, unless the gap lets them join
  const two = [F('a', 0, 0, 100, 100), F('b', 200, 120, 100, 100)];
  assert.equal(rowsOf(two).length, 2);
  assert.deepEqual(rowsOf(two, { gap: 30 }).map((r) => r.map((f) => f.id)), [['a', 'b']]);
  assert.deepEqual(rowsOf([]), []);
  // a row grows as frames join it: c overlaps b, which overlaps a
  assert.equal(rowsOf([F('a', 0, 0, 10, 100), F('b', 20, 90, 10, 100), F('c', 40, 180, 10, 100)]).length, 1);
});

test('layoutRows lays rows out from a corner, the same as rowLayout', () => {
  const rows = [[F('a', 9, 9, 100, 50), F('b', 9, 9, 200, 80)], [F('c', 9, 9, 10, 10)]];
  const out = layoutRows(rows, { x: 5, y: 7, gap: 10, rowGap: 20 });
  assert.deepEqual(out.map((r) => r.map((f) => [f.id, f.x, f.y])), [[['a', 5, 7], ['b', 115, 7]], [['c', 5, 107]]]);
  assert.deepEqual(out, rowLayout(rows, { gap: 10, rowGap: 20, x0: 5, y0: 7 }));
  assert.equal(rows[0][0].x, 9);   // (new objects)
});

test('a live frame\'s backdrop: the frame fitted to the stage, any zoom', () => {
  const v = liveBackdrop(F('a', 100, 100, 1008, 1008), 740, 600, 20);
  assert.ok(Math.abs(v.z - 560 / 1008) < 1e-9);
  assert.ok(Math.abs((100 + 504) * v.z + v.x - 370) < 1e-9 && Math.abs((100 + 504) * v.z + v.y - 300) < 1e-9);
  assert.equal(liveBackdrop(F('b', 0, 0, 320, 180), 1000, 600, 20).z, 3);
});

test('engine TabSets sit empty on a version-2 project only', async () => {
  const { sitsEmpty } = await import('../web/table-model.js');
  for (const k of ['edit-tabs', 'video-tabs', 'sound-tabs', 'scene-tabs', 'vfx-tabs', 'gen-tabs']) {
    assert.equal(sitsEmpty(k, { version: 2 }), true);
    assert.equal(sitsEmpty(k, { version: 1 }), false);
    assert.equal(sitsEmpty(k, {}), false);
    assert.equal(sitsEmpty(k, undefined), false);
  }
  assert.equal(sitsEmpty('tables', { version: 2 }), false);
  assert.equal(sitsEmpty('story-tabs', { version: 2 }), false);
});
