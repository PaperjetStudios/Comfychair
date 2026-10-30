// node tests/rig_retarget.test.mjs
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
const THREE = await import('../web/vendor/three.module.min.js');
const FIGURE = await import('../web/figure.js');
const { restOffsets } = await import('../web/scene-rig.js');
const mat = new THREE.MeshBasicMaterial();

// A rigged model bound in a T- or A-pose: after retargeting, each limb points where the figure's does, in every
// pose (before, the bind pose sat on top of the figure's: arms 90° or 45° too high). The model here is a figure
// itself, posed for its bind, in a layer group turned 90° (the offsets are measured in the group's frame).
const LIMBS = [['lsho', 'lelb'], ['lelb', 'lhand'], ['rsho', 'relb'], ['relb', 'rhand'], ['lhip', 'lknee'], ['rknee', 'rfoot'], ['spine', 'chest']];
const at = (o) => o.getWorldPosition(new THREE.Vector3());
const q = (z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(z))).toArray();
for (const bindPose of ['tpose', { lsho: q(45), rsho: q(-45) }]) {
  const group = new THREE.Group();
  group.rotation.y = Math.PI / 2;
  const model = FIGURE.buildFigure(mat, mat, 'man'), fig = FIGURE.buildFigure(mat, mat, 'man');
  group.add(model.root, fig.root);
  FIGURE.applyPose(model, typeof bindPose === 'string' ? FIGURE.preset(bindPose).j : bindPose);
  group.updateMatrixWorld(true);
  const map = Object.fromEntries(Object.keys(FIGURE.JOINTS).map((n) => [n, n]));
  const byName = new Map(Object.entries(model.bones));
  const rest = restOffsets(map, byName, group);
  // each limb's bind direction in its bone's own frame: it turns with the bone
  const local = Object.fromEntries(LIMBS.map(([a, b]) => [a, at(model.bones[b]).sub(at(model.bones[a]))
    .applyQuaternion(model.bones[a].getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()]));
  for (const pose of ['stand', 'wave', 'tpose', 'walk', 'sit', 'crossed']) {
    FIGURE.applyPose(fig, FIGURE.preset(pose).j);
    group.updateMatrixWorld(true);
    for (const [a, b] of LIMBS) {
      const turn = fig.bones[a].getWorldQuaternion(new THREE.Quaternion()).multiply(rest.get(a));
      const got = local[a].clone().applyQuaternion(turn);
      const want = at(fig.bones[b]).sub(at(fig.bones[a])).normalize();
      const deg = THREE.MathUtils.radToDeg(got.angleTo(want));
      assert.ok(deg < 1, `${JSON.stringify(bindPose)} bind, ${pose}: ${a} is ${deg.toFixed(1)}° off the figure`);
    }
  }
}
console.log('rig retarget ok');
