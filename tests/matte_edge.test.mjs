import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEES, alphaAsGrey, boundsOf, solidBounds, boxesFor, foundIn, guidedFilter, refineEdge, separateAreas, stairOf, termsOf, worthLooking } from '../web/matte-edge.js';

// a picture of w×h with an edge at x = at, and the same edge in a mask as a staircase `step` wide (a diagonal in the picture)
function scene(w, h, step) {
  const guide = new Float32Array(w * h), mask = new Uint8Array(w * h), truth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = x < w / 4 + y / 2;
      guide[y * w + x] = on ? 0.8 : 0.2;
      truth[y * w + x] = on ? 255 : 0;
      const sy = Math.floor(y / step) * step, sx = Math.floor(x / step) * step;
      mask[y * w + x] = sx < w / 4 + sy / 2 ? 255 : 0;
    }
  }
  return { guide, mask, truth };
}
const grey = (g) => [g, g, g];
const wrong = (a, b) => a.reduce((n, v, i) => n + ((v > 127) !== (b[i] > 127) ? 1 : 0), 0);

test('the edge moves onto the picture: the staircase is mostly gone', () => {
  const w = 240, h = 160, { guide, mask, truth } = scene(w, h, 16);
  const before = wrong(mask, truth), after = wrong(refineEdge(mask, grey(guide), w, h, 16), truth);
  assert.ok(before > 500, `the test's staircase is off by ${before}`);
  assert.ok(after < before / 5, `${before} wrong before, ${after} after`);
});

test('a thin pole in flat sky, with the mask far too wide: the edge lands on it and leaves no haze', () => {
  const w = 300, h = 120, sky = new Float32Array(w * h).fill(0.8), mask = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= 140 && x < 160) sky[y * w + x] = 0.15;   // the pole: 20 wide
    if (x >= 130 && x < 170) mask[y * w + x] = 0;   // the mask (on = sky) leaves out 40
  }
  const out = refineEdge(mask, grey(sky), w, h, 12);
  for (const y of [20, 60, 100]) {
    for (let x = 100; x < 200; x++) {
      const v = out[y * w + x], pole = x >= 140 && x < 160;
      assert.ok(pole ? v <= 5 : v >= 250, `x ${x}: ${v}`);
    }
  }
});

test('where the thing and its background are one colour, the edge stays about where the mask had it', () => {
  const w = 120, h = 80, g = new Float32Array(w * h).fill(0.5), mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (i % w < 60) mask[i] = 255;
  const out = refineEdge(mask, grey(g), w, h, 6);
  for (const y of [10, 40, 70]) { assert.equal(out[y * w + 20], 255); assert.equal(out[y * w + 100], 0); assert.ok(out[y * w + 50] > out[y * w + 70]); }
});

test('a busy background: its windows do not join the thing', () => {
  // the thing (on) is a dark strip; behind it a light wall with dark and blue windows, some right beside the mask's edge
  const w = 240, h = 160, n = w * h, rgb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], mask = new Uint8Array(n), win = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, thing = x >= 100 && x < 130, window = !thing && x % 24 < 12 && y % 24 < 12;
    const c = thing ? [0.3, 0.45, 0.2] : window ? [0.1, 0.2, 0.45] : [0.75, 0.72, 0.7];
    rgb.forEach((v, k) => { v[i] = c[k]; });
    win[i] = window ? 1 : 0;
    if (x >= 90 && x < 140) mask[i] = 255;   // (the mask is a blob over the thing and the wall beside it)
  }
  const out = refineEdge(mask, rgb, w, h, 10);
  let fresh = 0;
  for (let i = 0; i < n; i++) if (win[i] && !mask[i] && out[i] > 127) fresh++;
  assert.equal(fresh, 0, `${fresh} window pixels outside the mask came on`);
});

test('only the band round the edge changes', () => {
  const w = 240, h = 160, { guide, mask } = scene(w, h, 8);
  // a hard edge in the picture far inside the thing, and far outside it, is left alone
  for (let i = 0; i < guide.length; i++) if ((i % w) < 10 || (i % w) > 230) guide[i] = (i % 7) / 7;
  const out = refineEdge(mask, grey(guide), w, h, 8);
  for (let y = 0; y < h; y++) { assert.equal(out[y * w], 255); assert.equal(out[y * w + w - 1], 0); }
});

test('a mask with nothing on, or all on, stays so', () => {
  const w = 40, h = 30, g = new Float32Array(w * h).map((_, i) => (i % 9) / 9);
  assert.ok(refineEdge(new Uint8Array(w * h), grey(g), w, h, 4).every((v) => v === 0));
  assert.ok(refineEdge(new Uint8Array(w * h).fill(255), grey(g), w, h, 4).every((v) => v === 255));
});

test('the guided filter leaves a flat picture\'s mean alone', () => {
  const w = 20, h = 20, p = new Float32Array(w * h).fill(0.25), I = new Float32Array(w * h).fill(0.5);
  for (const v of guidedFilter(p, I, w, h, 3, 1e-4)) assert.ok(Math.abs(v - 0.25) < 1e-4);
});

test('the staircase is as wide as what the model saw, scaled up', () => {
  assert.equal(stairOf(SEES, 10), 4);
  assert.ok(Math.abs(stairOf(4416, 3520) - 17.52) < 0.01);
  assert.equal(stairOf(10, 10), 1);
});

test('bounds of a mask', () => {
  const m = new Uint8Array(100);
  assert.equal(boundsOf(m, 10, 10), null);
  m[23] = 255; m[45] = 255; m[47] = 100;   // (100 isn't on)
  assert.deepEqual(boundsOf(m, 10, 10), { x: 3, y: 2, w: 3, h: 3 });
});

test('boxes get room, stay inside, and those that touch become one', () => {
  assert.deepEqual(boxesFor([{ x: 0, y: 0, w: 100, h: 100 }], 1000, 1000), [{ x: 0, y: 0, w: 132, h: 132 }]);
  assert.equal(boxesFor([{ x: 0, y: 0, w: 100, h: 100 }, { x: 110, y: 0, w: 100, h: 100 }], 1000, 1000).length, 1);
  assert.equal(boxesFor([{ x: 0, y: 0, w: 100, h: 100 }, { x: 800, y: 800, w: 100, h: 100 }], 1000, 1000).length, 2);
  // (the 3rd joins the first two, which didn't touch each other)
  assert.equal(boxesFor([{ x: 0, y: 0, w: 50, h: 50 }, { x: 300, y: 0, w: 50, h: 50 }, { x: 70, y: 0, w: 200, h: 50 }], 1000, 1000).length, 1);
});

test('a second look is only worth it on a big picture, on a box smaller than it', () => {
  assert.equal(worthLooking({ w: 300, h: 300 }, 1000, 1000), false);
  assert.equal(worthLooking({ w: 1000, h: 1000 }, 4000, 3000), true);
  assert.equal(worthLooking({ w: 3500, h: 2000 }, 4000, 3000), false);
});

test('a second look keeps what lies on the first, and drops another thing of that name', () => {
  const first = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0]);
  const same = Uint8Array.from([255, 255, 255, 0, 0, 0, 0, 0]), other = Uint8Array.from([0, 0, 0, 0, 0, 0, 255, 255]);
  assert.deepEqual([...foundIn(first, [same, other])], [255, 255, 255, 0, 0, 0, 0, 0]);
  assert.equal(foundIn(first, [other]), null);
  assert.equal(foundIn(first, []), null);
  // (a tiny piece on it doesn't stand for the thing)
  assert.equal(foundIn(first, [Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0])]), null);
});

test('find words: one search each, no repeats, at most four', () => {
  assert.deepEqual(termsOf('watermark, text; logo\nwatermark'), ['watermark', 'text', 'logo']);
  assert.deepEqual(termsOf('a,b,c,d,e'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(termsOf('  '), []);
});

test('separate marked areas: a line of letters is one, two far apart are two, none is none', () => {
  const w = 400, h = 200, m = new Uint8Array(w * h), mark = (x, y) => { m[y * w + x] = 255; };
  assert.deepEqual(separateAreas(m, w, h), []);
  for (let x = 10; x < 100; x += 12) mark(x, 10);   // (letters with gaps)
  mark(380, 190);
  const a = separateAreas(m, w, h);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { x: 0, y: 0, w: 96, h: 32 });
  assert.deepEqual(a[1], { x: 352, y: 160, w: 32, h: 32 });
});

test('a layer\'s see-through as a matte: solid is white, see-through black, whatever its colour', () => {
  const px = Uint8ClampedArray.from([9, 80, 200, 255, 200, 0, 0, 0, 1, 2, 3, 128]);
  assert.deepEqual([...alphaAsGrey(px)], [255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
});

test('what is solid in a picture: a blob in the middle, a faint haze ignored, nothing is null', () => {
  const w = 10, h = 8, px = new Uint8ClampedArray(w * h * 4);
  assert.equal(solidBounds(px, w, h), null);
  for (let y = 3; y < 6; y++) for (let x = 4; x < 7; x++) px[(y * w + x) * 4 + 3] = 255;
  px[3] = 5;   // (haze in the corner)
  assert.deepEqual(solidBounds(px, w, h), { x: 4, y: 3, w: 3, h: 3 });
});
