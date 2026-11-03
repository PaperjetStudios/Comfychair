// node --test tests/adjust.test.mjs: colour adjustments and matching between pictures (web/adjust.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../web/adjust.js';

// a picture of random-ish pixels, RGBA, with a seeded generator
function picture(n = 20000, seed = 7, shape = (v) => v) {
  const px = new Uint8ClampedArray(n * 4);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) {
    const v = rnd() ** 1.3, cr = rnd() * 0.15, cb = rnd() * 0.15;
    const [r, g, b] = shape([v + cr, v, v + cb]);
    px[i * 4] = r * 255; px[i * 4 + 1] = g * 255; px[i * 4 + 2] = b * 255; px[i * 4 + 3] = 255;
  }
  return px;
}
const graded = (px, a) => A.applyGrade(new Uint8ClampedArray(px), A.gradeOf(a));
const mean = (px, c) => { let t = 0; for (let i = c; i < px.length; i += 4) t += px[i]; return t / (px.length / 4); };

test('nothing set is nothing: clean gives null and a straight curve does not count', () => {
  assert.equal(A.clean({ exposure: 0, curves: { m: [[0, 0], [1, 1]] } }), null);
  assert.equal(A.isOn(null), false);
  assert.deepEqual(A.clean({ sat: 0.5, hue: 0, curves: { r: [[0, 0], [1, 1]] } }), { sat: 0.5 });
});

test('a curve goes through its points, stays flat past its ends and never overshoots', () => {
  const f = A.curveFn([[0.2, 0.1], [0.5, 0.5], [0.8, 0.9]]);
  assert.ok(Math.abs(f(0.5) - 0.5) < 1e-6);
  assert.equal(f(0), 0.1);
  assert.equal(f(1), 0.9);
  let last = -1;
  for (let x = 0; x <= 1; x += 0.01) { assert.ok(f(x) >= last - 1e-9); last = f(x); }
  const steep = A.curveFn([[0, 0], [0.1, 0.9], [1, 1]]);
  for (let x = 0; x <= 1; x += 0.01) assert.ok(steep(x) <= 1 + 1e-9);
});

test('the sliders move light and colour the way they say, and alpha stays', () => {
  const px = picture();
  assert.ok(mean(graded(px, { exposure: 1 }), 0) > mean(px, 0) * 1.2);
  assert.ok(mean(graded(px, { exposure: -1 }), 0) < mean(px, 0) * 0.85);
  const warm = graded(px, { temp: 0.8 });
  assert.ok(mean(warm, 0) > mean(px, 0) && mean(warm, 2) < mean(px, 2));
  const grey = graded(px, { sat: -1 });
  for (let i = 0; i < 400; i += 4) { assert.ok(Math.abs(grey[i] - grey[i + 1]) <= 1 && Math.abs(grey[i + 1] - grey[i + 2]) <= 1); assert.equal(grey[i + 3], 255); }
});

test('a turn of hue all the way round comes back', () => {
  const px = picture(2000), back = graded(px, { hue: 180 - 180 + 360 });
  for (let i = 0; i < 4000; i += 1) if (i % 4 !== 3) assert.ok(Math.abs(back[i] - px[i]) <= 1);
});

test('auto curves stretch a dull picture to black and white', () => {
  const dull = picture(20000, 3, ([r, g, b]) => [0.2 + r * 0.4, 0.2 + g * 0.4, 0.2 + b * 0.4]);
  const curves = A.autoCurves(A.histOf(dull)), out = graded(dull, { curves });
  const q = (px, c) => { const v = []; for (let i = c; i < px.length; i += 4) v.push(px[i]); v.sort((a, b) => a - b); return [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]]; };
  assert.ok(q(out, 0)[0] < 20 && q(out, 0)[1] > 220);
  assert.equal(A.autoCurves(A.histOf(new Uint8ClampedArray(400).fill(128))), null);
});

test('matching a shot from another camera undoes the difference', () => {
  const ref = picture(30000, 11);
  // the same scene through another camera: a colder, darker, flatter look, with other noise
  const other = picture(30000, 23, ([r, g, b]) => [0.08 + 0.62 * r ** 1.2, 0.05 + 0.7 * g, 0.1 + 0.85 * b ** 0.85]);
  const before = [0, 1, 2].map((c) => Math.abs(mean(other, c) - mean(ref, c)));
  const curves = A.matchCurves(A.histOf(other), A.histOf(ref));
  const out = graded(other, { curves });
  for (const c of [0, 1, 2]) {
    assert.ok(Math.abs(mean(out, c) - mean(ref, c)) < Math.max(3, before[c] / 4), `channel ${c}: ${mean(out, c)} vs ${mean(ref, c)}`);
  }
  // the curves are ones a person can work with: few points, in order
  for (const ch of ['r', 'g', 'b']) {
    assert.ok(curves[ch].length <= 9 && curves[ch].length >= 2);
    for (let i = 1; i < curves[ch].length; i++) assert.ok(curves[ch][i][0] > curves[ch][i - 1][0] && curves[ch][i][1] >= curves[ch][i - 1][1]);
  }
});

test('match strength 0 leaves it alone, and a picture matches itself with a straight curve', () => {
  const px = picture(), hist = A.histOf(px), other = A.histOf(picture(20000, 5, ([r, g, b]) => [r * 0.5, g * 0.7, b]));
  for (const pts of Object.values(A.matchCurves(other, hist, { strength: 0 }))) for (const [x, y] of pts) assert.ok(Math.abs(x - y) < 1e-3);
  for (const pts of Object.values(A.matchCurves(hist, hist))) for (const [x, y] of pts) assert.ok(Math.abs(x - y) < 0.02);
});

test('the average of several looks counts each the same, whatever its size, and skips one showing nothing', () => {
  const dark = A.histOf(picture(4000, 3, ([r, g, b]) => [r * 0.3, g * 0.3, b * 0.3])), light = A.histOf(picture(40000, 9, ([r, g, b]) => [0.6 + r * 0.3, 0.6 + g * 0.3, 0.6 + b * 0.3]));
  const clear = A.histOf(new Uint8ClampedArray(400));
  const avg = A.averageLook([dark, clear, light]);
  const share = (h, from, to) => h.g.slice(from, to).reduce((a, b) => a + b, 0) / h.g.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(share(avg, 0, 128) - 0.5) < 0.01, 'half dark, though the light one has ten times the pixels');
  assert.deepEqual(A.averageLook([dark]).g.map((v) => +v.toFixed(9)), dark.g.map((n) => +(n / 4000).toFixed(9)));
  assert.equal(A.averageLook([clear]), null);
});

test('two layers matched to their average come closer to each other', () => {
  const a = picture(30000, 11), b = picture(30000, 23, ([r, g, bl]) => [0.1 + 0.6 * r, 0.7 * g, 0.2 + 0.8 * bl]);
  const want = A.averageLook([A.histOf(a), A.histOf(b)]);
  const outA = graded(a, { curves: A.matchCurves(A.histOf(a), want) }), outB = graded(b, { curves: A.matchCurves(A.histOf(b), want) });
  for (const c of [0, 1, 2]) {
    const before = Math.abs(mean(a, c) - mean(b, c)), after = Math.abs(mean(outA, c) - mean(outB, c));
    assert.ok(after < Math.max(4, before / 3), `channel ${c}: ${before} to ${after}`);
  }
});

test('what does not show is not matched; a picture with nothing showing gives no curves', () => {
  const clear = new Uint8ClampedArray(400);
  assert.equal(A.matchCurves(A.histOf(clear), A.histOf(picture())), null);
});

test('a histogram through an adjust is how the graded picture counts', () => {
  const px = picture(), a = { exposure: 0.6, curves: { b: [[0, 0.1], [1, 0.9]] } };
  assert.deepEqual(A.histThrough(A.histOf(px), a), A.histOf(graded(px, a)));
});

test('export: 33 steps per channel that agree with the preview tables', () => {
  assert.equal(A.exportGrade(null), null);
  const a = { contrast: 0.3, curves: { r: [[0, 0], [0.5, 0.7], [1, 1]] }, sat: 0.2 }, g = A.exportGrade(a), t = A.gradeOf(a);
  for (const ch of ['r', 'g', 'b']) {
    assert.equal(g[ch].length, 33);
    g[ch].forEach((v, i) => assert.ok(Math.abs(v * 255 - t[ch][Math.round((i * 255) / 32)]) <= 1.5));
  }
  assert.equal(g.m.length, 9);
});
