import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnOutput, migrateTable, newFrame, outputOf, resizeFrame, tileShape } from '../web/table-model.js';

test('a new frame comes out at its size; sound and notes have no output', () => {
  assert.deepEqual(newFrame('video', { x: 0, y: 0, w: 1920, h: 1080 }).out, { w: 1920, h: 1080 });
  assert.equal(newFrame('sound', { x: 0, y: 0, w: 100, h: 50 }).out, undefined);
  assert.deepEqual(newFrame('image', { x: 0, y: 0, w: 512, h: 512 }, { out: { w: 64, h: 64 } }).out, { w: 64, h: 64 });
});
test('resizing the preview leaves the output alone', () => {
  const f = newFrame('image', { x: 0, y: 0, w: 1024, h: 1024 });
  const g = { ...f, ...resizeFrame(f, 'se', -500, -300) };
  assert.notEqual(g.w, 1024);
  assert.deepEqual(outputOf(g), { w: 1024, h: 1024 });
});
test('an old table: a frame\'s size becomes its output, once', () => {
  const t = migrateTable({ frames: [{ id: 'a', kind: 'image', w: 800, h: 600 }, { id: 'b', kind: 'video', w: 100, h: 100, out: { w: 1280, h: 720 } }, { id: 'c', kind: 'note', w: 10, h: 10 }] });
  assert.deepEqual(t.frames.find((f) => f.id === 'a').out, { w: 800, h: 600 });
  assert.deepEqual(t.frames.find((f) => f.id === 'b').out, { w: 1280, h: 720 });
  assert.equal(t.frames.find((f) => f.id === 'c').out, undefined);
});
test('tileShape: keeps the longest side at the output\'s shape; the same shape changes nothing', () => {
  assert.deepEqual(tileShape({ w: 640, h: 360 }, { w: 1920, h: 1080 }), { w: 640, h: 360 });
  assert.deepEqual(tileShape({ w: 640, h: 360 }, { w: 1080, h: 1920 }), { w: 360, h: 640 });
});
test('drawnOutput: a small drawn frame comes out near 1 MP in its shape, on multiples of 16', () => {
  const o = drawnOutput({ w: 320, h: 180 });
  assert.ok(Math.abs(o.w * o.h - 1e6) < 1e5);
  assert.equal(o.w % 16, 0);
  assert.deepEqual(drawnOutput({ w: 1920, h: 1088 }), { w: 1920, h: 1088 });
});
