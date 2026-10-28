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

// toWorld: a body standing still in the world, filmed by a camera that pans (and rolls) — in camera space it
// moves; put back through the camera per frame it stands still again
{
  const TM = await import('../web/track-math.js');
  const W = still.map(([x, y, z]) => [x + 0.4, y, z - 1]);   // in the world, somewhere in front of the camera
  const cams = Array.from({ length: 24 }, (_, i) => {
    const yaw = (i - 12) * 0.02, eye = [0, 1.5, 6];
    return { px: eye[0], py: eye[1], pz: eye[2], tx: eye[0] + Math.sin(yaw) * 10, ty: eye[1] - 0.5, tz: eye[2] - Math.cos(yaw) * 10, roll: i * 0.5 };
  });
  const toCam = (p, c) => {   // world -> camera space (x right, y up, looking down -Z)
    const b = TM.basis([c.px, c.py, c.pz], [c.tx, c.ty, c.tz], c.roll), d = [p[0] - c.px, p[1] - c.py, p[2] - c.pz];
    return [b.x, b.y, b.z].map((ax) => ax[0] * d[0] + ax[1] * d[1] + ax[2] * d[2]);
  };
  // the server's normalising: a turn about y and a shift (normalised = m · given + t)
  const a2 = 0.7, m = [[Math.cos(a2), 0, Math.sin(a2)], [0, 1, 0], [-Math.sin(a2), 0, Math.cos(a2)]], t = [0.3, 1.1, -2];
  const norm = (p) => [0, 1, 2].map((r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + t[r]);
  const frames = cams.map((c) => W.map((p) => norm(toCam(p, c))));
  const out = M.toWorld({ fps: 24, frames, space: { m, t } }, (i) => cams[i]);
  let err = 0;
  out.frames.forEach((P) => P.forEach((p, j) => { err = Math.max(err, Math.hypot(p[0] - W[j][0], p[1] - W[j][1], p[2] - W[j][2])); }));
  assert.ok(err < 1e-6, `toWorld off by ${err}`);
}
console.log('motion ok');
