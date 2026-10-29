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

// proportions: a shaped, scaled figure's own points measured; the size and shape matched to them give a figure
// with the same bone lengths (size and shape trade off, so it's the lengths that must agree, not the numbers)
const capture = (body, shape, sy) => {
  const r = F.buildFigure(mat, mat, body);
  F.setShape(r, shape); r.root.scale.setScalar(sy); F.applyPose(r, {}, {});
  const P = smpl(r); P[0] = mid(P[1], P[2]);   // (a capture's pelvis is between its hip joints, as Deck Save Body Motion puts it)
  return P;
};
for (const [body, shape, sy] of [['man', { legs: 30, arms: -20, torso: 10, shoulders: 25, hips: -15 }, 1.1], ['woman', {}, 0.95], ['man', { legs: -40, neck: 40 }, 1],
  ['woman', { arms: 40, shoulders: -20 }, 1.05]]) {
  const want = M.measure([capture(body, shape, sy)]);
  const got = M.matchProportions([capture(body, shape, sy)], body), back = M.measure([capture(body, got.shape, got.sy)]);
  for (const k of ['leg', 'arm', 'torso', 'sho', 'hips']) assert.ok(Math.abs(back[k] - want[k]) < 0.02, `${body} ${k}: ${back[k].toFixed(3)} not ${want[k].toFixed(3)}`);
  assert.ok(Object.entries(got.shape).every(([k, v]) => v >= F.shapeRange(k)[0] && v <= F.shapeRange(k)[1]));
}
// out of range: clamped to the slider's ends
assert.equal(F.shapeFor({ legs: 9 }).legs, F.shapeRange('legs')[1]);
assert.deepEqual(F.shapeFor({ legs: 1, arms: NaN }), {});
const hy = F.hipsHeight('man', { legs: 30 });
assert.ok(Math.abs(hy - (0.95 + 0.86 * 0.09)) < 1e-9);
// without hands or a face the keys are the 22-joint pose, and the head still copies the neck
{
  const bare = M.toKeys({ fps: 24, frames: [still, still] }, { x: 0, y: 0, z: 0, ry: 0, sy: 1, j: {}, m: {} }, { every: 1 });
  const posed = M.localPose(M.worldTurns(still));
  for (const n of Object.keys(posed)) assert.deepEqual(bare[0].j[n], posed[n], n);
  assert.equal(bare[0].j.lindex1, undefined);
  const W = M.worldTurns(still);
  assert.ok(W.head.angleTo(W.neck) < 1e-8);
}

// the face aims the head: ears across, nose forward. A nose to the side yaws it.
{
  const face = [[0, 1.65, 0.12], [0.03, 1.68, 0.08], [-0.03, 1.68, 0.08], [0.08, 1.65, 0], [-0.08, 1.65, 0]];
  const look = new THREE.Vector3(0, 0, 1).applyQuaternion(M.worldTurns(still, { face }).head);
  assert.ok(look.z > 0.8 && Math.abs(look.x) < 0.3, `head looks along ${look.toArray()}`);
  const yawed = [[0.12, 1.65, 0], [0.04, 1.68, 0.03], [0.04, 1.68, -0.03], [0, 1.65, -0.08], [0, 1.65, 0.08]];
  const turned = M.worldTurns(still, { face: yawed }).head;
  assert.ok(M.worldTurns(still).head.angleTo(turned) > 0.4, 'a turned face turns the head');
}

// a straight finger stays straight; bending the index curls that joint and turns the hand off the elbow
{
  const hand = (side, bend) => {
    const sx = side === 'l' ? 1 : -1, H = [[0, 0, 0]];
    for (let fi = 0; fi < 5; fi++) {
      const x = sx * (fi - 2) * 0.02;
      for (let k = 1; k <= 4; k++) H.push([x, -0.02 * k, 0]);
    }
    if (bend) { const o = 5, x = H[o][0]; H[o + 1] = [x, -0.04, 0]; H[o + 2] = [x, -0.04, 0.02]; H[o + 3] = [x, -0.04, 0.04]; }
    return H;
  };
  const straight = M.fingerPose({ l: hand('l', false), r: hand('r', false) });
  assert.ok(Math.abs(straight.lindex2[3]) > 0.99, `straight w ${straight.lindex2[3]}`);
  const curled = M.fingerPose({ l: hand('l', true), r: hand('r', false) });
  const deg = 2 * Math.acos(Math.min(1, Math.abs(curled.lindex2[3]))) * 180 / Math.PI;
  assert.ok(deg > 20, `index curl ${deg.toFixed(1)}°`);
  assert.ok(Math.abs(curled.lmiddle2[3]) > 0.99, 'the other fingers stay straight');
  const W0 = M.worldTurns(still), W1 = M.worldTurns(still, { hands: { l: hand('l', true), r: hand('r', false) } });
  assert.ok(W0.lhand.angleTo(W0.lelb) < 1e-8);
  assert.ok(W1.lhand.angleTo(W1.lelb) > 0.05, 'the hand no longer copies the elbow');
  const keyed = M.toKeys({ fps: 24, frames: [still, still], hands: { l: [hand('l', true), hand('l', true)], r: [hand('r', false), hand('r', false)] } },
    { x: 0, y: 0, z: 0, ry: 0, sy: 1, j: {}, m: {} }, { every: 1 });
  assert.ok(keyed[0].j.lindex2, 'finger keys are written');
}

console.log('motion ok');
