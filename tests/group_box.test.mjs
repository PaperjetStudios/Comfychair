// node --test tests/group_box.test.mjs: one transform box round several Editor layers (web/group-box.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../web/layer-geom.js';
import * as B from '../web/group-box.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const nearR = (r, q, msg) => { for (const k of ['x', 'y', 'w', 'h']) near(r[k], q[k], `${msg} ${k}`); };
const layer = (o = {}) => ({ img: { naturalWidth: 200, naturalHeight: 100 }, crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, scale: 1, ...o });

test('the box is the bounds of every layer', () => {
  const a = layer({ x: 10, y: 20 }), b = layer({ x: 300, y: 50, scale: 0.5 });
  nearR(B.groupBounds([a, b]), { x: 10, y: 20, w: 390, h: 100 }, 'two');
  const t = layer({ x: 0, y: 0, rotation: 90 });   // a quarter turn: 100 wide, 200 tall about (100, 50)
  nearR(B.groupBounds([t]), { x: 50, y: -50, w: 100, h: 200 }, 'turned');
  assert.equal(B.groupBounds([]), null);
});

test('scaling about a corner keeps each layer\'s place in the box', () => {
  const a = layer({ x: 10, y: 20 }), b = layer({ x: 300, y: 50, scale: 0.5 });
  const box = B.groupBounds([a, b]), anchor = { x: box.x, y: box.y };
  const na = { ...a, ...B.scaleAbout(a, 2, anchor) }, nb = { ...b, ...B.scaleAbout(b, 2, anchor) };
  near(na.scale, 2, 'a scale'); near(nb.scale, 1, 'b scale');
  nearR(B.groupBounds([na, nb]), { x: 10, y: 20, w: 780, h: 200 }, 'box doubled from its top-left');
  near(G.layerRect(nb).x, 10 + (300 - 10) * 2, 'b keeps its place');
  // a turned layer: its turn stays, its centre moves with the box
  const t = layer({ x: 100, y: 100, rotation: 30 }), nt = { ...t, ...B.scaleAbout(t, 0.5, { x: 0, y: 0 }) };
  near(nt.scale, 0.5, 'turned scale'); near(G.centre(nt).x, 100, 'centre x'); near(G.centre(nt).y, 75, 'centre y');
  assert.equal(nt.rotation, 30);
});

test('turning about the box centre swings each layer round it', () => {
  const a = layer({ x: 0, y: 0 }), b = layer({ x: 400, y: 0 });
  const box = B.groupBounds([a, b]), c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const na = { ...a, ...B.turnAbout(a, 90, c) };
  assert.equal(na.rotation, 90);
  near(G.centre(na).x, 300, 'a centre x'); near(G.centre(na).y, -150, 'a centre y');   // (100,50) swung 90° clockwise round (300,50)
  const nb = { ...b, ...B.turnAbout(b, 90, c) };
  near(G.centre(nb).x, 300, 'b centre x'); near(G.centre(nb).y, 250, 'b centre y');
});

test('a crop rect keeps only what lies inside it, the image staying put', () => {
  const a = layer({ x: 10, y: 20, scale: 2 });   // covers 10..410 x 20..220
  const r = B.cropToRect(a, { x: 110, y: 0, w: 1000, h: 120 });
  nearR(r.crop, { x: 0.25, y: 0, w: 0.75, h: 0.5 }, 'crop');
  const na = { ...a, ...r };
  nearR(G.layerRect(na), { x: 110, y: 20, w: 300, h: 100 }, 'kept part');
  near(G.imageToCanvas(na, { x: 100, y: 50 }).x, G.imageToCanvas(a, { x: 100, y: 50 }).x, 'image stays put');
  // growing the rect brings back what an earlier crop took away
  nearR(B.cropToRect(na, { x: -1000, y: -1000, w: 5000, h: 5000 }).crop, { x: 0, y: 0, w: 1, h: 1 }, 'whole again');
  // nothing inside: no answer
  assert.equal(B.cropToRect(a, { x: 1000, y: 1000, w: 10, h: 10 }), null);
});

test('quarter turns and mirrors crop exactly; other turns are left out', () => {
  const t = layer({ x: 0, y: 0, rotation: 90 });   // on the canvas 50..150 x -50..150; the image's top runs down the right side
  const r = B.cropToRect(t, { x: 100, y: -50, w: 50, h: 200 });   // the right half on the canvas = the image's top half
  nearR(r.crop, { x: 0, y: 0, w: 1, h: 0.5 }, 'quarter turn');
  nearR(G.bounds({ ...t, ...r }), { x: 100, y: -50, w: 50, h: 200 }, 'kept part on the canvas');
  const f = layer({ flipX: true });   // mirrored: the canvas's left half is the image's right half
  nearR(B.cropToRect(f, { x: 0, y: 0, w: 100, h: 100 }).crop, { x: 0.5, y: 0, w: 0.5, h: 1 }, 'mirror');
  assert.equal(B.cropsExactly(layer({ rotation: 30 })), false);
  assert.equal(B.cropToRect(layer({ rotation: 30 }), { x: 0, y: 0, w: 50, h: 50 }), null);
});

test('a dragged corner box, with and without a shape', () => {
  nearR(B.spanRect({ x: 100, y: 100 }, { x: 20, y: 160 }), { x: 20, y: 100, w: 80, h: 60 }, 'free');
  nearR(B.spanRect({ x: 0, y: 0 }, { x: 100, y: 30 }, 2), { x: 0, y: 0, w: 60, h: 30 }, '2:1');
  nearR(B.spanRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 1, h: 1 }, 'never under a pixel');
});
