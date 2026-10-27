// Run by tests/test_motion.py (node tests/motion.test.mjs): SMPL-22 joint positions back onto the figure.
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
import * as F from '../web/figure.js';
import * as M from '../web/motion.js';

const mat = new THREE.MeshBasicMaterial();
const rig = () => F.buildFigure(mat, mat);
const wpos = (r, name, local = [0, 0, 0]) => { r.root.updateMatrixWorld(true); return r.bones[name].localToWorld(new THREE.Vector3(...local)).toArray(); };
const mid = (a, b) => a.map((x, i) => (x + b[i]) / 2);

// our figure's joints, posed, as the 22 points a mocap / text-to-motion model would give
function smpl(r) {
  const p = (n, l) => wpos(r, n, l);
  return [p('hips'), p('lhip'), p('rhip'), p('spine'), p('lknee'), p('rknee'), mid(p('spine'), p('chest')), p('lfoot'), p('rfoot'),
    p('chest'), p('lfoot', [0, -0.05, 0.17]), p('rfoot', [0, -0.05, 0.17]), p('neck'), p('lsho'), p('rsho'), p('head'),
    p('lsho'), p('rsho'), p('lelb'), p('relb'), p('lhand'), p('rhand')];
}

let worst = 0;
for (const [key] of F.presetList()) {
  const pose = F.preset(key);
  if (!pose?.j) continue;
  const a = rig(); F.applyPose(a, pose.j, pose.m || {});
  const pts = smpl(a);
  const b = rig(); F.applyPose(b, M.localPose(M.worldTurns(pts)), {});
  for (const n of Object.keys(F.JOINTS)) {
    const pa = new THREE.Vector3(...wpos(a, n)), pb = new THREE.Vector3(...wpos(b, n));
    worst = Math.max(worst, pa.distanceTo(pb));
    assert.ok(pa.distanceTo(pb) < 0.03, `${key}: ${n} off by ${pa.distanceTo(pb).toFixed(3)} m`);
  }
}
console.log(`round trip worst joint error ${(worst * 100).toFixed(2)} cm`);

// keys: resampled to 24 fps, path moved and turned with the figure, feet on the floor
const a = rig(); F.applyPose(a, {}, {});
const still = smpl(a);
const walk = Array.from({ length: 21 }, (_, i) => still.map(([x, y, z]) => [x, y, z + i * 0.05]));   // 1 s at 20 fps, 1 m forward
const keys = M.toKeys({ fps: 20, frames: walk }, { x: 2, y: 0, z: 0, ry: 90, sy: 1, j: {}, m: {} }, { f0: 10, every: 1 });
assert.equal(keys.length, 25);
assert.equal(keys[0].f, 10);
const last = keys[keys.length - 1];
assert.ok(Math.abs(last.x - 3) < 0.02 && Math.abs(last.z) < 0.02, `turned path ends at ${last.x}, ${last.z}`);   // ry 90: +Z becomes +X
assert.ok(Math.abs(keys[0].y) < 0.01, `standing figure stays on the floor (y ${keys[0].y})`);
// placement: on the spot keeps x/z, no rise keeps the hips at base.y
const spot = M.toKeys({ fps: 20, frames: walk }, { x: 2, y: 0.3, z: 1, ry: 90, sy: 1, j: {}, m: {} }, { every: 1, travel: false, rise: false });
assert.ok(spot.every((k) => k.x === 2 && k.z === 1 && k.y === 0.3), 'on the spot, hips held');
console.log('motion ok');
