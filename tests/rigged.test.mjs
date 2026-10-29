// node tests/shots.test.mjs
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
const { TYPES, EVEN, namesFor, newObject, FIG, defaultScene, setSC } = D;

setSC(defaultScene());
assert.ok(TYPES.rigged, 'a rigged layer type exists');
assert.ok(EVEN.has('rigged'), 'it scales evenly, like a figure');
const o = newObject('rigged');
assert.equal(o.type, 'rigged');
assert.deepEqual(namesFor(o), FIG, 'a rigged layer holds the figure\'s values (j, m)');
assert.ok(o.base.j && o.base.j.lsho, 'its pose starts as the stand pose');
assert.equal(o.ground, true);

// a figure still does, and a plain model still does not take a pose
const fig = newObject('figure');
assert.deepEqual(namesFor(fig), FIG);
const model = newObject('model');
assert.ok(!namesFor(model).includes('j'));

console.log('rigged ok');
