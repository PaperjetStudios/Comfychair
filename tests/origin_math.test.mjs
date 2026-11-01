// A layer's origin (web/origin-math.js), checked against three.js: moving it leaves the layer where it is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawnScale, eulerQ, moveOrigin, originShift } from '../web/origin-math.js';
import * as THREE from '../web/vendor/three.module.min.js';

const near = (a, b, msg, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${msg}[${i}]: ${v} != ${b[i]}`));
const CH = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
const lerpKeys = (l, f) => {
  const a = l.findLast((k) => k.f <= f) ?? l[0], b = l.find((k) => k.f >= f) ?? l.at(-1);
  return a.f === b.f ? a.v : a.v + (b.v - a.v) * (f - a.f) / (b.f - a.f);
};
const sample = (it, f) => Object.fromEntries(CH.map((c) => [c, it.chans?.[c]?.length ? lerpKeys(it.chans[c], f) : it.base[c]]));
const setKey = (it, ch, f, v) => {
  const l = (it.chans[ch] ||= []), k = l.find((x) => x.f === f);
  if (k) k.v = v; else { l.push({ f, v }); l.sort((a, b) => a.f - b.f); }
};
// where the layer's own (0, 0, 0) is drawn, as pose() does it
const root = (it, f, even) => {
  const v = sample(it, f), s = it.origin ? originShift(v, it.origin, even) : [0, 0, 0];
  return [v.x - s[0], v.y - s[1], v.z - s[2]];
};
const move = (it, at, even) => moveOrigin(it, at, { even, setKey, sample: (f) => sample(it, f) });
const base = (o = {}) => ({ x: 1, y: 2, z: 3, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, ...o });

test('eulerQ and originShift agree with three.js', () => {
  const v = base({ rx: 20, ry: -75, rz: 130, sx: 2, sy: 3, sz: 0.5 });
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(20 * Math.PI / 180, -75 * Math.PI / 180, 130 * Math.PI / 180));
  near(eulerQ(20, -75, 130), [q.x, q.y, q.z, q.w], 'quaternion');
  near(originShift(v, [0.2, 0.5, -1], false), new THREE.Vector3(0.4, 1.5, -0.5).applyQuaternion(q).toArray(), 'uneven');
  near(originShift(v, [0.2, 0.5, -1], true), new THREE.Vector3(0.6, 1.5, -3).applyQuaternion(q).toArray(), 'even uses sy');
  assert.deepEqual(drawnScale({ sx: 0, sy: 0, sz: 0 }, true), [1e-4, 1e-4, 1e-4]);
  assert.deepEqual(drawnScale({ sx: 0, sy: 0, sz: 0 }, false), [0.01, 0.01, 0.01]);
});

test('still layer: the layer stays, the origin is what x, y, z now hold', () => {
  const it = { base: base({ ry: 90, sy: 2 }), chans: {} }, was = root(it, 0, true);
  move(it, [0, 1, 0], true);
  near(root(it, 0, true), was, 'layer');
  near([it.base.x, it.base.y, it.base.z], [1, 4, 3], 'origin in the world');
  assert.deepEqual(it.origin, [0, 1, 0]);
});

test('moving it twice, then back to the start, leaves no origin and the same place', () => {
  const it = { base: base({ rx: 30, ry: 40, rz: 50, sx: 2, sy: 1, sz: 3 }), chans: {} };
  move(it, [0.3, 0.2, 0.1], false); move(it, [-1, 0, 2], false);
  near(root(it, 0, false), [1, 2, 3], 'layer');
  move(it, [0, 0, 0], false);
  assert.equal(it.origin, undefined);
  near([it.base.x, it.base.y, it.base.z], [1, 2, 3], 'base');
});

test('place keys only: every key shifts, no keys are added', () => {
  const it = { base: base({ ry: 90 }), chans: { x: [{ f: 0, v: 0 }, { f: 10, v: 5 }] } };
  const was = [0, 5, 10].map((f) => root(it, f, true));
  move(it, [1, 0, 0], true);
  [0, 5, 10].forEach((f, i) => near(root(it, f, true), was[i], `frame ${f}`));
  assert.equal(it.chans.x.length, 2);
  assert.equal(it.chans.z, undefined, 'a place that was not animated stays unkeyed');
});

test('a turn animated: the layer stays on every key, and a place that does not change gets no keys', () => {
  const it = { base: base(), chans: { ry: [{ f: 0, v: 0 }, { f: 24, v: 90 }], x: [{ f: 12, v: 2 }] } };
  const was = [0, 12, 24].map((f) => root(it, f, true));
  move(it, [0, 1, 1], true);
  [0, 12, 24].forEach((f, i) => near(root(it, f, true), was[i], `frame ${f}`));
  assert.equal(it.chans.x.length, 3);
  assert.equal(it.chans.y, undefined, 'turning on Y does not move a point up');
  assert.ok(it.chans.z?.length === 3);
});

test('a size animated: the shift follows the size', () => {
  const it = { base: base(), chans: { sy: [{ f: 0, v: 1 }, { f: 10, v: 3 }] } };
  const was = [0, 10].map((f) => root(it, f, true));
  move(it, [0, 1, 0], true);
  [0, 10].forEach((f, i) => near(root(it, f, true), was[i], `frame ${f}`));
  near([sample(it, 10).y], [5], 'origin at frame 10');
});
