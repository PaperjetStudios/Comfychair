// node tests/skin_channels.test.mjs — a generic skinned model's bone channels (b.<bone>)
import assert from 'node:assert/strict';
import { register } from 'node:module';

const el = () => {
  const node = {
    style: {}, dataset: {}, classList: { add() {}, toggle() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, append() {}, appendChild() { return node; }, prepend() {},
    addEventListener() {}, removeEventListener() {}, remove() {}, closest() { return null; },
    querySelector() { return el(); }, querySelectorAll() { return []; },
    getContext() { return { canvas: node, measureText: () => ({ width: 0 }), fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {}, scale() {}, translate() {}, setTransform() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    width: 100, height: 100, childNodes: [], children: [],
    parentElement: { append() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  };
  return node;
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, querySelector() { return el(); }, querySelectorAll() { return []; },
  documentElement: { style: {} }, createElement: el, createElementNS: el,
  body: { append() {}, removeChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  activeElement: null,
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.HTMLElement = class {};
globalThis.Node = class {};
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

await register(new URL('./shot-hooks.mjs', import.meta.url).href, { parentURL: import.meta.url });
const D = await import('../web/scene-data.js');

D.setSC(D.defaultScene());
const o = { id: 's1', type: 'skinned', name: 'Skin', ease: 'linear', chans: {},
  base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, b: { Hips: [0, 0, 0, 1] } } };
D.SC.objects.push(o);

assert.deepEqual(D.namesFor(o), D.BONE, 'a skinned model holds bone values too');
assert.ok(!D.namesFor({ type: 'model' }).includes('b'));
assert.ok(D.isQuatCh('b.Hips') && D.isQuatCh('j.spine') && !D.isQuatCh('x'));

const qx = [Math.SQRT1_2, 0, 0, Math.SQRT1_2], qy = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
D.setKey(o, 'b.Hips', 0, qx);
D.setKey(o, 'b.Hips', 10, qy);
assert.equal(o.chans['b.Hips'].length, 2);

const mid = D.sampleChan(o, 'b.Hips', 5);
assert.ok(Math.abs(Math.hypot(...mid) - 1) < 1e-6, 'the midpoint is a unit quaternion');
assert.ok(!D.sameVal(mid, qx) && !D.sameVal(mid, qy), 'it slerps between the two keys');
const vals = D.sample(o, D.namesFor(o), 5);
assert.deepEqual(vals.b.Hips, mid, 'sample() gives the bone bag');

// keying a bone that has no key yet takes the base
assert.deepEqual(D.baseOf(o, 'b.Neck'), [0, 0, 0, 1]);
D.bakeBase(o, 'b.Neck', qy);
assert.deepEqual(o.base.b.Neck, qy, 'bakeBase puts it in the bone bag');
assert.ok(D.keyChans(o, D.BONE, { b: { Hips: qx, Head: qy } }).includes('b.Head'));

// a whole-item key (an old move) does not disturb the bone channels
assert.ok(D.keyChans(o, D.BONE, { x: 2 }).every((c) => !c.startsWith('j.')));
console.log('skin_channels ok');
