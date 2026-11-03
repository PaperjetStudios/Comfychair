// node --test tests/photo_restore.test.mjs: the pixel work of Colourise and Restore (web/photo-restore.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceBox, keepBrightness, scratchMask, tilesOf } from '../web/photo-restore.js';

const W = 400, H = 300;
function picture(fn) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) { const v = fn(x, y); px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
  return px;
}
const smooth = (x, y) => 60 + (x / W) * 80 + (y / H) * 40;
const marked = (m, x, y) => m[y * W + x] === 255;
const total = (m) => m.reduce((a, v) => a + (v ? 1 : 0), 0);

test('new colour keeps the brightness and see-through of the original', () => {
  const orig = new Uint8ClampedArray([100, 100, 100, 200, 30, 30, 30, 255]), colour = new Uint8ClampedArray([200, 120, 40, 255, 90, 20, 10, 255]);
  keepBrightness(orig, colour);
  const y = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  assert.ok(Math.abs(y(colour, 0) - 100) < 1.5);
  assert.ok(Math.abs(y(colour, 4) - 30) < 1.5);
  assert.ok(colour[0] > colour[2], 'the colour stays');
  assert.equal(colour[3], 200);
});

test('a long scratch is marked, bright or dark, straight or slanted; a smooth picture is not', () => {
  assert.equal(total(scratchMask(picture(smooth), W, H)), 0);
  const m = scratchMask(picture((x, y) => (x === 200 || x === 201 ? 240 : Math.abs(y - x) < 1.5 && x > 40 && x < 250 ? 10 : smooth(x, y))), W, H);
  assert.ok(marked(m, 200, 150), 'bright, straight');
  assert.ok(marked(m, 100, 100), 'dark, slanted');
  assert.equal(marked(m, 300, 40), false);
});

test('specks are marked when alone, but many together are texture', () => {
  const alone = scratchMask(picture((x, y) => (Math.abs(x - 100) < 2 && Math.abs(y - 100) < 2 ? 250 : smooth(x, y))), W, H);
  assert.ok(marked(alone, 100, 100));
  const cloth = scratchMask(picture((x, y) => (x % 6 < 2 && y % 6 < 2 ? 240 : smooth(x, y))), W, H);
  assert.ok(total(cloth) < 40, `${total(cloth)} marked`);
});

test('the edge of a big shape is not a scratch', () => {
  const m = scratchMask(picture((x, y) => (x > 120 && x < 280 && y > 80 && y < 220 ? 220 : 40)), W, H);
  assert.equal(total(m.filter((_, i) => { const x = i % W, y = (i - x) / W; return (Math.abs(x - 120) < 3 || Math.abs(x - 280) < 3) && y > 100 && y < 200; })), 0);
});

test('a mark inside what is to be left alone stays; a scratch that only crosses it is still a scratch', () => {
  const skip = new Uint8Array(W * H);
  for (let y = 100; y < 200; y++) for (let x = 150; x < 250; x++) skip[y * W + x] = 255;
  const crossing = scratchMask(picture((x, y) => (x === 200 || x === 201 ? 240 : smooth(x, y))), W, H, { skip });
  assert.ok(marked(crossing, 200, 150) && marked(crossing, 200, 50));
  const inside = scratchMask(picture((x, y) => ((x === 200 || x === 201) && y > 110 && y < 190 ? 240 : smooth(x, y))), W, H, { skip });
  assert.equal(total(inside), 0);
});

test('a scratch is still found through film grain, and the grain itself is not marked', () => {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const grainy = (x, y) => smooth(x, y) + (rnd() - 0.5) * 24;
  assert.ok(total(scratchMask(picture(grainy), W, H)) < 60);
  const m = scratchMask(picture((x, y) => (Math.abs(y - x * 0.5 - 20) < 0.8 ? 235 : grainy(x, y))), W, H);
  let hit = 0;
  for (let x = 20; x < 380; x++) if (marked(m, x, Math.round(x * 0.5 + 20))) hit++;
  assert.ok(hit > 300, `${hit} of 360 along the scratch`);
});

test('a face gets a square with room, inside the picture; too small a one gets none', () => {
  assert.deepEqual(faceBox({ x: 100, y: 100, w: 100, h: 80 }, 1000, 1000), { x: 70, y: 60, w: 160, h: 160 });
  const edge = faceBox({ x: 0, y: 0, w: 100, h: 100 }, 1000, 1000);
  assert.deepEqual([edge.x, edge.y], [0, 0]);
  assert.ok(faceBox({ x: 0, y: 0, w: 900, h: 700 }, 800, 700).w <= 700);
  assert.equal(faceBox({ x: 5, y: 5, w: 20, h: 20 }, 1000, 1000), null);
});

test('tiles cover the whole picture and none is over the limit', () => {
  const ts = tilesOf(5000, 3000, 2e6);
  for (const t of ts) assert.ok(t.w * t.h <= 2e6 && t.w > 0 && t.h > 0);
  assert.equal(Math.max(...ts.map((t) => t.x + t.w)), 5000);
  assert.equal(Math.max(...ts.map((t) => t.y + t.h)), 3000);
  assert.equal(tilesOf(800, 600, 2e6).length, 1);
});
