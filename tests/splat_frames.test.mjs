// An animated splat's frames: which one shows when, and what taking one out or moving one does to the layer and its keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addFrame, frameCount, frameIndex, frameList, frameTrimOf, framesOnWhole, removeFrame, sceneFrameShowing, shapeFor, swapFrames } from '../web/splat-frames.js';

const layer = (n = 3, x = {}) => {
  const o = { url: '/f0.ply', file: 'f0.ply', image: 'p0.png', levels: [{ k: 'light', url: '/f0.ply', n: 1 }], box: [0, 0, 0, 1, 1, 1], ...x };
  for (let i = 1; i < n; i++) addFrame(o, { url: `/f${i}.ply`, image: `p${i}.png` });
  return o;
};

test('a layer with one file stays on it', () => {
  assert.equal(frameCount({ url: '/a.ply' }), 1);
  assert.equal(frameIndex({ url: '/a.ply', frameRate: 12 }, 100), 0);
});

test('the frame rate counts in scene frames, whatever the rate', () => {
  const o = layer(3, { frameRate: 6 });   // 6 a second at 24: a new frame every 4
  assert.deepEqual([0, 3, 4, 8, 11, 12].map((f) => frameIndex(o, f)), [0, 0, 1, 2, 2, 0]);
  o.frameRate = 24;
  assert.deepEqual([0, 1, 2, 3].map((f) => frameIndex(o, f)), [0, 1, 2, 0]);
});

test('once holds the last frame; there and back does not repeat its ends', () => {
  const o = layer(3, { frameRate: 24, frameLoop: 'once' });
  assert.deepEqual([0, 1, 2, 3, 50].map((f) => frameIndex(o, f)), [0, 1, 2, 2, 2]);
  o.frameLoop = 'bounce';
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => frameIndex(o, f)), [0, 1, 2, 1, 0, 1]);
});

test('a key beats the rate, and is held inside the frames there are', () => {
  const o = layer(3, { frameRate: 24 });
  assert.equal(frameIndex(o, 1, 2), 2);
  assert.equal(frameIndex(o, 1, 0), 0);
  assert.equal(frameIndex(o, 1, 9), 2);
  assert.equal(frameIndex(o, 1, undefined), 1);
});

test('taking out the first frame makes the next one the layer, and keeps where it stands', () => {
  const o = layer(3);
  removeFrame(o, 0);
  assert.equal(o.url, '/f1.ply');
  assert.equal(o.image, 'p1.png');
  assert.equal(o.levels, undefined);
  assert.equal(o.file, undefined);
  assert.deepEqual(o.box, [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(frameList(o).map((f) => f.url), ['/f1.ply', '/f2.ply']);
});

test('keys stay on the frames they showed when one goes', () => {
  const o = layer(4, { chans: { sf: [{ f: 0, v: 0 }, { f: 5, v: 1 }, { f: 9, v: 2 }, { f: 12, v: 3 }] } });
  removeFrame(o, 1);
  assert.deepEqual(frameList(o).map((f) => f.url), ['/f0.ply', '/f2.ply', '/f3.ply']);
  assert.deepEqual(o.chans.sf.map((k) => k.v), [0, 1, 1, 2]);
});

test('down to one file, it is a plain splat again', () => {
  const o = layer(2, { chans: { sf: [{ f: 0, v: 1 }], x: [{ f: 0, v: 3 }] } });
  removeFrame(o, 1);
  assert.equal(o.frames, undefined);
  assert.equal(o.chans.sf, undefined);
  assert.deepEqual(o.chans.x, [{ f: 0, v: 3 }]);
  assert.equal(removeFrame(o, 0), false);
  assert.equal(o.url, '/f0.ply');
});

test('moving a frame moves its keys with it, the first frame included', () => {
  const o = layer(3, { chans: { sf: [{ f: 0, v: 0 }, { f: 5, v: 1 }, { f: 9, v: 2 }] } });
  assert.equal(swapFrames(o, 0, 1), true);
  assert.deepEqual(frameList(o).map((f) => f.url), ['/f1.ply', '/f0.ply', '/f2.ply']);
  assert.equal(o.levels, undefined);
  assert.equal(o.frames[0].levels.length, 1);
  assert.deepEqual(o.chans.sf.map((k) => k.v), [1, 0, 2]);
  assert.equal(swapFrames(o, 0, -1), false);
  assert.equal(swapFrames(o, 2, 3), false);
});

test('a frame with a trim of its own uses it; the others follow the layer', () => {
  const whole = { on: true, c: [0, 0, 0], r: 1 }, mine = { on: true, c: [1, 1, 1], r: 2 };
  const o = layer(3, { trim: whole, grow: 1.2 });
  o.frames[0].frameTrim = mine;
  assert.equal(frameTrimOf(o, 0), whole);
  assert.equal(frameTrimOf(o, 1), mine);
  assert.equal(frameTrimOf(o, 2), whole);
  assert.equal(shapeFor(o, 0), o);
  assert.equal(shapeFor(o, 1).trim, mine);
  assert.equal(shapeFor(o, 1).grow, 1.2);
  assert.deepEqual(framesOnWhole(o), [0, 2]);
});

test('a frame\'s own trim stays with it when frames move or go, the first frame too', () => {
  const mine = { on: true, c: [1, 1, 1], r: 2 };
  const o = layer(3, { frameTrim: mine });
  swapFrames(o, 0, 1);
  assert.equal(o.frameTrim, undefined);
  assert.equal(o.frames[0].frameTrim, mine);
  swapFrames(o, 0, 1);
  assert.equal(o.frameTrim, mine);
  removeFrame(o, 0);
  assert.equal(o.frameTrim, undefined);
  assert.equal(frameTrimOf(o, 0), undefined);
});

test('the scene frame that shows a splat frame: the nearest, or none', () => {
  const o = layer(3, { frameRate: 6 });   // a new frame every 4
  assert.equal(sceneFrameShowing(o, 1, 24, 0), 4);
  assert.equal(sceneFrameShowing(o, 1, 24, 14), 16);
  assert.equal(sceneFrameShowing(o, 1, 24, 17), 17);
  assert.equal(sceneFrameShowing(layer(3, { frameRate: 2 }), 2, 12, 0), null);   // (half a second never leaves the first)
  assert.equal(sceneFrameShowing(o, 2, 24, 0, () => 2), 0);
  assert.equal(sceneFrameShowing(o, 0, 24, 0, () => 2), null);
});
