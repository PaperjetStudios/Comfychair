// node --test tests/quick_start.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// (the usual stand-ins: the rules load no DOM, but keep a document about in case an import reaches for one)
globalThis.document ??= { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }), querySelector: () => null };

const R = await import('../web/quick-start-rules.js');
const ASPECTS = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3]];
const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), m }; };

test('size from an aspect and megapixels: about that many pixels, sides on 16', () => {
  assert.deepEqual(R.sizeFor(1, 1), { w: 1008, h: 1008 });   // (1000 rounds to 1008, the nearest 16)
  const wide = R.sizeFor(16 / 9, 1);
  assert.equal(wide.w % 16, 0); assert.equal(wide.h % 16, 0);
  assert.ok(Math.abs(wide.w / wide.h - 16 / 9) < 0.03);
  assert.ok(Math.abs(wide.w * wide.h - 1e6) < 0.05e6);
  const big = R.sizeFor(1, 4);
  assert.ok(big.w > 1900 && big.w < 2100);
  assert.deepEqual(R.sizeFor(0, 0), R.sizeFor(1, 1), 'nonsense falls back to 1 MP square');
  assert.ok(R.sizeFor(1, 100).w <= 4096, 'capped at 16 MP');
});

test('placement: the top-left at the tapped point, on the grid when it is on', () => {
  const s = { w: 512, h: 256 };
  assert.deepEqual(R.placeAt({ x: 100.4, y: 37 }, s, { on: false, size: 64 }), { x: 100, y: 37, w: 512, h: 256 });
  assert.deepEqual(R.placeAt({ x: 100, y: 37 }, s, { on: true, size: 64 }), { x: 128, y: 64, w: 512, h: 256 });
  assert.deepEqual(R.placeAt({ x: -90, y: 10 }, s, { on: true, size: 64 }), { x: -64, y: 0, w: 512, h: 256 });
  // centre: the point is the frame's middle (the New frame button's)
  assert.deepEqual(R.placeAt({ x: 1000, y: 500 }, s, { on: false }, { centre: true }), { x: 744, y: 372, w: 512, h: 256 });
  assert.deepEqual(R.placeAt({ x: 1000, y: 500 }, s, { on: true, size: 32 }, { centre: true }), { x: 736, y: 384, w: 512, h: 256 });
});

test('the last choice: remembered, merged, and checked against what is offered', () => {
  const st = memStore();
  assert.deepEqual(R.lastChoice(st, ASPECTS), R.DEFAULTS);
  assert.equal(R.DEFAULTS.aspect, '1:1'); assert.equal(R.DEFAULTS.mp, 1);
  R.rememberChoice(st, { aspect: '16:9' });
  R.rememberChoice(st, { mp: 2, kind: 'video' });
  R.rememberChoice(st, { video: [1080, 1920], fps: 30 });
  const c = R.lastChoice(st, ASPECTS);
  assert.equal(c.aspect, '16:9'); assert.equal(c.mp, 2); assert.equal(c.kind, 'video');
  assert.deepEqual(c.video, [1080, 1920]); assert.equal(c.fps, 30);
  assert.deepEqual(c.scene, R.DEFAULTS.scene);
  // stale or broken values fall back one by one
  const bad = memStore({ 'deck.quick': { aspect: '7:5', mp: -3, kind: 'hologram', video: [1, 2], fps: 12, scene: 'x' } });
  assert.deepEqual(R.lastChoice(bad, ASPECTS), R.DEFAULTS);
  assert.deepEqual(R.lastChoice(memStore({ 'deck.quick': null }), ASPECTS), R.DEFAULTS);
});

const P = { key: '3.text', kind: 'text', group: 'Prompt', input: 'text' }, N = { key: '4.text', kind: 'text', group: 'Negative prompt', input: 'text' };
const I = { key: '1.image', kind: 'image', input: 'image' };
const T = (id, media, fields = []) => ({ id, media, fields });
const ALL = [T('deck-krea2-t2i', 'image', [N, P]), T('deck-krea2-edit', 'image', [I, P]), T('example_txt2img', 'image', [P]),
  T('deck-ltx-t2v', 'video', [{ ...I, key: 'img.image' }, P]), T('deck-ltx-i2v', 'video', [I, P]), T('deck-h3-ref2v', 'video', [I, P]),
  T('deck-3d-object', 'other', [I]), T('deck-ace-music', 'audio', [{ key: 'enc.tags', kind: 'text', group: 'Music', input: 'tags' }, { key: 'enc.lyrics', kind: 'text', group: 'Music', input: 'lyrics' }]), T('deck-ltx-t2a', 'audio', [P]), { ...T('deck-broken-t2i', 'image', [P]), error: 'x' }];

test('the template a start uses: the last that fits, else its own, else the first that fits', () => {
  assert.equal(R.startTemplate(ALL, 'image-text').id, 'deck-krea2-t2i');
  assert.equal(R.startTemplate(ALL, 'image-text', 'example_txt2img').id, 'example_txt2img');
  assert.equal(R.startTemplate(ALL, 'image-text', 'deck-krea2-edit').id, 'deck-krea2-t2i', 'an edit takes a picture: not a start from text');
  assert.equal(R.startTemplate(ALL, 'image-text', 'deck-broken-t2i').id, 'deck-krea2-t2i', 'a broken template is skipped');
  assert.equal(R.startTemplate(ALL, 'video-text').id, 'deck-ltx-t2v');
  assert.equal(R.startTemplate(ALL, 'video-picture').id, 'deck-ltx-i2v');
  assert.equal(R.startTemplate(ALL, 'video-picture', 'deck-ltx-t2v').id, 'deck-ltx-i2v');
  assert.equal(R.startTemplate(ALL, 'scene-object').id, 'deck-3d-object');
  assert.equal(R.startTemplate(ALL, 'sound-music').id, 'deck-ace-music');
  assert.equal(R.startTemplate([], 'image-text'), null);
  assert.equal(R.startTemplate(ALL, 'nope'), null);
});

test('a frame\'s Make settings: the prompt and the picture in their fields, a kept preset only for the same template', () => {
  const t2i = ALL[0], i2v = ALL[4];
  assert.deepEqual(R.makePayload(t2i, { prompt: 'a cat' }), { v: 1, template: 'deck-krea2-t2i', presetId: null, overrides: { '3.text': 'a cat' } });
  assert.deepEqual(R.makePayload(i2v, { picture: 'p/x.png' }).overrides, { '1.image': 'p/x.png' });
  const base = { v: 1, template: 'deck-krea2-t2i', presetId: 'pre', overrides: { '9.steps': 8, '3.text': 'old' }, seedMode: { s: 'random' }, inputs: ['keep/out.png'] };
  const p = R.makePayload(t2i, { prompt: 'new' }, base);
  assert.equal(p.presetId, 'pre'); assert.deepEqual(p.overrides, { '9.steps': 8, '3.text': 'new' }); assert.deepEqual(p.seedMode, { s: 'random' });
  assert.equal(p.inputs, undefined, 'another frame\'s copied pictures are not taken over');
  assert.deepEqual(R.makePayload(R.startTemplate(ALL, 'sound-music'), { prompt: 'calm piano' }).overrides, { 'enc.tags': 'calm piano' }, 'music: the words go in its tags');
  assert.deepEqual(R.makePayload(ALL[2], { prompt: 'x' }, base), { v: 1, template: 'example_txt2img', presetId: null, overrides: { '3.text': 'x' } });
});
