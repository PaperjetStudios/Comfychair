import test from 'node:test';
import assert from 'node:assert/strict';
import { SWAP_MODELS, SWAP_PARTS, biggestArea, changedAround, joined, onlyWithin, scaleFor, softEdge, swapBox, swapLora, swapPrompt, swapRefPixels, without } from '../web/swap-part.js';

test('each model is told in its own words, for every part', () => {
  for (const part of Object.keys(SWAP_PARTS)) for (const [k, m] of Object.entries(SWAP_MODELS)) {
    if (m.bfs) continue;
    const p = swapPrompt(part, k);
    assert.ok(p.includes(m.a) && p.includes(m.b), `${part} ${k}`);
  }
  assert.ok(swapPrompt('face', 'krea2', ' with freckles ').endsWith('with freckles'));
});

test('the biggest area wins', () => {
  assert.deepEqual(biggestArea([{ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 3, h: 3 }]), { x: 5, y: 5, w: 3, h: 3 });
  assert.equal(biggestArea([]), null);
});

test('the box has room round the area and stays inside the picture', () => {
  assert.deepEqual(swapBox({ x: 100, y: 100, w: 100, h: 50 }, 1000, 1000, 0.5), { x: 50, y: 50, w: 200, h: 150 });
  assert.deepEqual(swapBox({ x: 0, y: 0, w: 100, h: 100 }, 120, 110, 0.5), { x: 0, y: 0, w: 120, h: 110 });
});

test('a small box is enlarged and a big one brought down', () => {
  assert.ok(scaleFor({ w: 100, h: 100 }) > 1);
  assert.ok(scaleFor({ w: 4000, h: 3000 }) < 1);
});

test('only within a box, and taking an area out', () => {
  const m = new Uint8Array(16).fill(255);
  const kept = onlyWithin(m, 4, { x: 1, y: 1, w: 2, h: 2 });
  assert.equal(kept.reduce((a, b) => a + (b ? 1 : 0), 0), 4);
  assert.equal(kept[0], 0);
  assert.equal(kept[5], 255);
  const left = without(m, kept);
  assert.equal(left[5], 0);
  assert.equal(left[0], 255);
});

test('the edge grows and softens; far from the area nothing changes', () => {
  const W = 41, m = new Uint8Array(W * W);
  m[20 * W + 20] = 255;
  const grown = softEdge(m, W, W, 5, 0);
  assert.equal(grown[20 * W + 25], 255);
  assert.equal(grown[20 * W + 26], 0);
  const soft = softEdge(m, W, W, 8, 6);
  assert.equal(soft[20 * W + 20], 255);
  const v = soft[20 * W + 28];
  assert.ok(v > 0 && v < 255, String(v));
  assert.equal(soft[0], 0);
});

test('a BFS model shows only with its LoRA for that part, in its own words', () => {
  const have = ['h3/x.safetensors', 'bfs/bfs_head_swap_v1.1_krea2.safetensors', 'bfs/bfs_head_v1_flux-klein_9b_step3500_rank128.safetensors'];
  assert.equal(swapLora('krea2', 'face', have), null);
  assert.deepEqual(swapLora('krea2-bfs', 'head', have), { name: 'bfs/bfs_head_swap_v1.1_krea2.safetensors', strength: 0.5 });
  assert.equal(swapLora('krea2-bfs', 'face', have), false);
  assert.equal(swapLora('krea2-bfs', 'body', have), false);
  assert.equal(swapLora('klein9b-bfs', 'person', have), false);
  assert.ok(swapPrompt('head', 'krea2-bfs').startsWith('head_swap:'));
  assert.ok(swapPrompt('person', 'qwen21-bfs', 'more').startsWith('body_swap:'));
  assert.ok(swapPrompt('person', 'qwen21-bfs', 'more').endsWith('more'));
  assert.equal(swapRefPixels('qwen21-bfs', 'body'), 0.59e6);
  assert.equal(swapRefPixels('qwen21-bfs', 'head'), 0);
});

test('what changed next to the area joins it; a change elsewhere does not, and a moved picture says nothing', () => {
  const W = 200, H = 200, before = new Uint8ClampedArray(W * H * 4), mask = new Uint8Array(W * H);
  for (let y = 50; y < 80; y++) for (let x = 50; x < 80; x++) mask[y * W + x] = 255;
  const paint = (a, x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[(y * W + x) * 4] = 255; };
  const after = Uint8ClampedArray.from(before);
  paint(after, 50, 80, 80, 120);   // a beard below the area
  paint(after, 160, 190, 160, 190);   // something far away
  const ch = changedAround(before, after, mask, W, H);
  assert.equal(ch[100 * W + 60], 255);
  assert.equal(ch[175 * W + 175], 0);
  assert.equal(ch[10 * W + 10], 0);
  const all = Uint8ClampedArray.from(before);
  paint(all, 0, W, 0, H);
  assert.equal(changedAround(before, all, mask, W, H), null);
  assert.equal(joined(new Uint8Array([0, 9]), new Uint8Array([5, 2]))[0], 5);
});

test('Klein 3 is told shortly, naming the picture it edits first', () => {
  assert.ok(swapPrompt('face', 'klein3').startsWith("In <ref_image_0>, replace the person's face"));
});
