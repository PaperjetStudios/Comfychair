// Run by tests/test_layer_geom.py (node tests/layer_geom.test.mjs): where a turned Editor layer lands (web/layer-geom.js).
import assert from 'node:assert/strict';
import * as G from '../web/layer-geom.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const nearP = (p, q, msg) => { near(p.x, q.x, `${msg} x`); near(p.y, q.y, `${msg} y`); };
const layer = (o = {}) => ({ img: { naturalWidth: 200, naturalHeight: 100 }, crop: { x: 0, y: 0, w: 1, h: 1 }, x: 10, y: 20, scale: 2, ...o });

// what an Image tool is sent: the file's pixels, whatever the layer's scale; a crop keeps its part of them
assert.deepEqual(G.sentPixels(layer({ scale: 0.5 })), [200, 100]);
assert.deepEqual(G.sentPixels(layer({ scale: 0.5, crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 } })), [100, 50]);
assert.deepEqual(G.sentPixels(layer({ crop: { x: 0, y: 0, w: 0.9995, h: 1 } })), [200, 100]);

// a painted mask is cut to a layer: its sent pixels -> the frame's, at the layer's scale, crop and turn
const toFrame = (l, f, px, p) => G.apply(G.sentToFrame(l, f, px), p);
const inFrame = { x: 10, y: 20, w: 400, h: 200 };
nearP(toFrame(layer(), inFrame, [200, 100], { x: 0, y: 0 }), { x: 0, y: 0 }, 'mask: corner');
nearP(toFrame(layer(), inFrame, [200, 100], { x: 200, y: 100 }), { x: 400, y: 200 }, 'mask: scaled');
nearP(toFrame(layer({ x: 110 }), { x: 10, y: 20, w: 800, h: 200 }, [200, 100], { x: 0, y: 0 }), { x: 100, y: 0 }, 'mask: a second layer along the canvas');
nearP(toFrame(layer({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }), inFrame, [100, 100], { x: 100, y: 100 }), { x: 200, y: 200 }, 'mask: a crop');
nearP(toFrame(layer({ flipX: true }), inFrame, [200, 100], { x: 0, y: 0 }), { x: 400, y: 0 }, 'mask: mirrored');
nearP(toFrame(layer({ rotation: 90 }), { x: 0, y: 0, w: 1, h: 1 }, [200, 100], { x: 0, y: 0 }), G.imageToCanvas(layer({ rotation: 90 }), { x: 0, y: 0 }), 'mask: turned, as the layer shows');
const m = G.sentToFrame(layer(), inFrame, [200, 100]);
nearP(G.apply(G.invert(m), G.apply(m, { x: 37, y: 11 })), { x: 37, y: 11 }, 'mask: back again');

// no turn: exactly as before
const l0 = layer();
assert.deepEqual(G.layerRect(l0), { x: 10, y: 20, w: 400, h: 200 });
assert.deepEqual(G.bounds(l0), G.layerRect(l0));
nearP(G.imageToCanvas(l0, { x: 50, y: 50 }), { x: 110, y: 120 }, 'plain');
assert.equal(G.turned(l0), false);

// a quarter turn about the centre (210, 120): the bounds swap sides, the image's top-left goes to the top-right
const l90 = layer({ rotation: 90 });
const b = G.bounds(l90);
near(b.w, 200, 'w'); near(b.h, 400, 'h'); near(b.x, 110, 'bx'); near(b.y, -80, 'by');
nearP(G.imageToCanvas(l90, { x: 0, y: 0 }), { x: 310, y: -80 }, 'top-left');
nearP(G.canvasToImage(l90, G.imageToCanvas(l90, { x: 33, y: 77 })), { x: 33, y: 77 }, 'round trip');
assert.ok(G.insideLayer(l90, { x: 300, y: 300 }));
assert.ok(!G.insideLayer(l90, { x: 20, y: 30 }));   // inside the unturned rect, outside the turned one

// mirrored: the left edge goes right
const lf = layer({ flipX: true });
nearP(G.imageToCanvas(lf, { x: 0, y: 0 }), { x: 410, y: 20 }, 'flip');
assert.deepEqual(G.bounds(lf), G.layerRect(lf));

// an Image tool's result: over its layer with the layer's turn, and a part of the layer stays on the same pixels
assert.deepEqual(G.placeOn(l0, { x: 10, y: 20, w: 400, h: 200 }), { x: 10, y: 20 });
const lt = layer({ rotation: 30, flipX: true });
const pl = G.placeOn(lt, G.layerRect(lt));
assert.deepEqual([pl.rotation, pl.flipX, pl.flipY], [30, true, false]);
near(pl.x, 10, 'same box x'); near(pl.y, 20, 'same box y');
const cell = { x: 210, y: 20, w: 200, h: 100 }, cl = G.placeOn(lt, cell);   // the top-right quarter
const res = { img: { naturalWidth: 400, naturalHeight: 200 }, crop: { x: 0, y: 0, w: 1, h: 1 }, scale: 0.5, ...cl };
nearP(G.imageToCanvas(res, { x: 0, y: 0 }), G.imageToCanvas(lt, { x: 100, y: 0 }), 'cell top-left');
nearP(G.imageToCanvas(res, { x: 400, y: 200 }), G.imageToCanvas(lt, { x: 200, y: 50 }), 'cell bottom-right');

// a new crop leaves the image where it was, turned or not
for (const o of [{}, { rotation: 37 }, { rotation: -120, flipY: true }]) {
  const l = layer(o), p = { x: 150, y: 60 }, at = G.imageToCanvas(l, p);
  Object.assign(l, G.cropKeepingPlace(l, { x: 0.25, y: 0.1, w: 0.5, h: 0.6 }));
  nearP(G.imageToCanvas(l, p), at, `crop ${JSON.stringify(o)}`);
}

// angles
assert.equal(G.snapAngle(44, { pull: 3 }), 45);
assert.equal(G.snapAngle(40, { pull: 3 }), 40);
assert.equal(G.snapAngle(52, { step: 15 }), 45);
assert.equal(G.snapAngle(270), -90);
assert.equal(G.snapAngle(-180), 180);
console.log('layer geom ok');

// a picture that is see-through anywhere
assert.equal(G.seeThrough(new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255])), false);
assert.equal(G.seeThrough(new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 0])), true);
assert.equal(G.seeThrough(new Uint8ClampedArray([9, 9, 9, 252])), false);

// a box over the layers (Select layers): it touches what a layer covers, turned or not
{
  const flat = layer({ x: 0, y: 0, scale: 1 });   // 200x100 at the origin
  assert.ok(G.touchesBox(flat, { x: 190, y: 90, w: 50, h: 50 }));
  assert.ok(!G.touchesBox(flat, { x: 201, y: 0, w: 50, h: 50 }));
  const turned = layer({ x: 0, y: 0, scale: 1, rotation: 45 });   // a box inside the square round it but off its turned sides doesn't touch it; the middle does
  assert.ok(!G.touchesBox(turned, { x: 190, y: 0, w: 5, h: 5 }));
  assert.ok(G.touchesBox(turned, { x: 98, y: 48, w: 4, h: 4 }));
  assert.ok(G.touchesBox(turned, { x: -100, y: -100, w: 400, h: 300 }));
}

// a crop past the picture's edges (Ctrl while cropping): the picture it makes, the old one at its place inside
{
  assert.ok(!G.pastEdge({ x: 0, y: 0, w: 1, h: 1 }));
  assert.ok(!G.pastEdge({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }));
  assert.ok(G.pastEdge({ x: -0.1, y: 0, w: 1.1, h: 1 }));
  assert.ok(G.pastEdge({ x: 0, y: 0, w: 1, h: 1.25 }));
  const past = { crop: { x: -0.1, y: 0, w: 1.1, h: 1 } }, inside = { crop: { x: 0.1, y: 0, w: 0.5, h: 1 } }, other = {};
  const at = (l, o = {}) => G.growFate({ l }, { cropping: true, sel: l, layers: [l, other], ...o });
  assert.equal(G.growFate(null, { cropping: true, sel: past, layers: [past] }), null);
  assert.equal(at(past), null);   // it waits for its button
  assert.equal(at(past, { cropping: false }), 'undo');
  assert.equal(at(past, { sel: other }), 'undo');
  assert.equal(at(inside), 'clear');   // dragged back inside: a plain crop
  assert.equal(at(past, { layers: [other] }), 'clear');
  assert.deepEqual(G.grownPicture({ x: -0.25, y: 0, w: 1.25, h: 1.5 }, 200, 100), { w: 250, h: 150, ix: 50, iy: -0 });
  assert.deepEqual(G.grownPicture({ x: 0.5, y: -0.5, w: 1, h: 1 }, 200, 100), { w: 200, h: 100, ix: -100, iy: 50 });
}
