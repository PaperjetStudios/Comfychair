// Apply scale, rotation, transform (web/bake-math.js), checked against three.js: the layer doesn't move, at any frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBake, IDENT, linear, point } from '../web/bake-math.js';
import { drawnScale, eulerQ, moveOrigin, originShift } from '../web/origin-math.js';
import { follow } from '../web/gizmo-orient.js';
import * as THREE from '../web/vendor/three.module.min.js';

// what is drawn at values v: as scene-view.js pose() and bakeOn do it
function drawn(item, v, even) {
  const b = item.bake || IDENT, at = item.origin || item.bake ? originShift(v, point(b, item.origin || [0, 0, 0]), even) : [0, 0, 0];
  const r = Math.PI / 180, q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.rx * r, v.ry * r, v.rz * r));
  return new THREE.Matrix4().compose(new THREE.Vector3(v.x - at[0], v.y - at[1], v.z - at[2]), q, new THREE.Vector3(...drawnScale(v, even))).multiply(new THREE.Matrix4().fromArray(b));
}
const close = (a, b, msg) => a.elements.forEach((v, i) => assert.ok(Math.abs(v - b.elements[i]) < 1e-6, `${msg} [${i}]: ${v} != ${b.elements[i]}`));
const layer = (o = {}) => ({ chans: {}, base: { x: 1.5, y: 0.4, z: -2, rx: 20, ry: 75, rz: -40, sx: 1.2, sy: 0.75, sz: 0.7, ...o } });

for (const kind of ['scale', 'rotation', 'all']) {
  for (const [name, item, even] of [
    ['a stretched box', layer(), false],
    ['an even model', layer({ sx: 2, sy: 2, sz: 2 }), true],
    ['with an origin', { ...layer(), origin: [0.3, 0.5, -0.1] }, false],
    ['applied before', { ...layer({ sx: 2, sy: 2, sz: 2 }), origin: [0.1, 0.2, 0.3], bake: new THREE.Matrix4().makeRotationY(1).setPosition(1, 2, 3).toArray() }, true],
  ]) {
    test(`Apply ${kind}, ${name}: it stays where it is`, () => {
      const before = drawn(item, item.base, even);
      assert.ok(applyBake(item, kind, { even }).ok);
      close(drawn(item, item.base, even), before, kind);
    });
  }
}

test('what was applied reads as nothing', () => {
  const a = layer({ sx: 2, sy: 2, sz: 2 }); applyBake(a, 'scale', { even: true });
  assert.deepEqual([a.base.sx, a.base.sy, a.base.sz, a.base.rx], [1, 1, 1, 20]);
  const b = layer({ sx: 2, sy: 2, sz: 2 }); assert.equal(applyBake(b, 'rotation', { even: true }).note, null);
  assert.deepEqual([b.base.rx, b.base.ry, b.base.rz, b.base.sy, b.base.x], [0, 0, 0, 2, 1.5]);
  const c = layer(); applyBake(c, 'all');
  assert.deepEqual(['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'].map((k) => c.base[k]), [0, 0, 0, 0, 0, 0, 1, 1, 1]);
});

test('a stretched layer loses its scale with its turn, and says so', () => {
  const a = layer(); const r = applyBake(a, 'rotation');
  assert.ok(r.note); assert.deepEqual([a.base.sx, a.base.ry], [1, 0]);
});

test('keys on what would go refuse it, and change nothing; other keys play on the same', () => {
  const a = layer(); a.chans.sy = [{ f: 0, v: 1 }]; const was = JSON.stringify(a);
  assert.match(applyBake(a, 'scale').why, /scale/);
  assert.match(applyBake(a, 'all').why, /scale/);
  assert.equal(JSON.stringify(a), was);
  const b = layer({ sx: 2, sy: 2, sz: 2 }); b.origin = [0.2, 0, 0.1]; b.chans.ry = [{ f: 0, v: 10 }, { f: 9, v: 90 }];
  const at = (x) => ({ ...x.base, ry: 55 }), before = drawn(b, at(b), true);
  assert.ok(applyBake(b, 'scale', { even: true }).ok);
  close(drawn(b, at(b), true), before, 'a keyed turn');
  assert.equal(applyBake({ ...layer(), off: {} }, 'scale').ok, false);
  assert.equal(applyBake({ ...layer(), mute: true }, 'scale').ok, false);
});

test('after applying, the gizmo holds the same point: its handle stays on it as the layer turns', () => {
  const o = { ...layer({ sx: 2, sy: 2, sz: 2 }), origin: [0.3, 0.1, 0] }; applyBake(o, 'all', { even: true });
  const B = new THREE.Matrix4().fromArray(o.bake), local = [0.4, 1, -0.2], q = eulerQ(10, 30, 50), hp = [4, 5, 6];
  const t = follow(hp, q, [0, 0, 0, 1], point(o.bake, local), [1.5, 1.5, 1.5]);
  const M = new THREE.Matrix4().compose(new THREE.Vector3(...t.p), new THREE.Quaternion(...t.q), new THREE.Vector3(1.5, 1.5, 1.5)).multiply(B);
  new THREE.Vector3(...local).applyMatrix4(M).toArray().forEach((v, i) => assert.ok(Math.abs(v - hp[i]) < 1e-6));
});

test('moving an origin after applying leaves the layer where it is', () => {
  const o = layer({ sx: 2, sy: 2, sz: 2 }); applyBake(o, 'rotation', { even: true });
  o.base.ry = 25;   // (turned again since)
  const before = drawn(o, o.base, true);
  moveOrigin(o, [0.5, 0.2, 0.1], { even: true, sample: () => o.base, setKey() {}, map: (d) => linear(o.bake, d) });
  close(drawn(o, o.base, true), before, 'origin');
});
