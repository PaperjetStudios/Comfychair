// Motion from outside (text-to-motion, video mocap) onto a 3D-tab figure. The input is joint positions
// per frame in the SMPL / HumanML3D 22-joint order, in metres, y up, the body facing +Z with its left on
// +X (the same frame as figure.js). Each figure joint's turn is rebuilt from where its bone points
// (and, for arms and legs, which way the elbow or knee bends), so the source's T-pose rest and bone
// lengths don't matter. Hands and the head keep no twist of their own (22 joints don't say).
import * as THREE from './vendor/three.module.min.js';
import { JOINTS } from './figure.js';

export const SMPL22 = ['pelvis', 'lhip', 'rhip', 'spine1', 'lknee', 'rknee', 'spine2', 'lankle', 'rankle', 'spine3', 'ltoe', 'rtoe',
  'neck', 'lcollar', 'rcollar', 'head', 'lsho', 'rsho', 'lelb', 'relb', 'lwrist', 'rwrist'];
const I = Object.fromEntries(SMPL22.map((n, i) => [n, i]));
export const FPS_OUT = 24;
const LEG = Math.abs(JOINTS.lknee[1][1]) + Math.abs(JOINTS.lfoot[1][1]);   // our hip to ankle, metres
const HIP_Y = JOINTS.hips[1][1];

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const sub = (a, b) => v3(a).sub(v3(b));

// the turn taking rest axes (d0 along the bone, p0 a second direction) onto d, p
function basis(d, p) {
  const x = d.clone().normalize();
  let y = p.clone().sub(x.clone().multiplyScalar(p.dot(x)));
  if (y.lengthSq() < 1e-6) y = new THREE.Vector3(Math.abs(x.y) < 0.9 ? 0 : 1, Math.abs(x.y) < 0.9 ? 1 : 0, 0).cross(x);   // p along the bone: any square-on direction
  y.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}
function aim(d0, p0, d, p) {
  const m = basis(d, p).multiply(basis(d0, p0).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
// a perpendicular hint for a bone that may be straight: where `mid` sits off the root→end line, else fall back
function bend(root, mid, end, fallback) {
  const line = sub(end, root).normalize();
  const off = sub(mid, root);
  off.sub(line.multiplyScalar(off.dot(line)));
  return off.length() > 0.01 ? off.normalize() : fallback;
}

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0), FWD = new THREE.Vector3(0, 0, 1), BACK = new THREE.Vector3(0, 0, -1);
const LEFT = new THREE.Vector3(1, 0, 0);

// world turns of every figure joint for one frame of 22 points
export function worldTurns(P) {
  const W = {};
  // pelvis: left from the hip joints, up from the pelvis to the lower spine
  W.hips = aim(LEFT, UP, sub(P[I.lhip], P[I.rhip]), sub(P[I.spine1], P[I.pelvis]));
  // chest: left across the shoulders, up from the top of the spine to the neck
  W.chest = aim(LEFT, UP, sub(P[I.lsho], P[I.rsho]), sub(P[I.neck], P[I.spine3]));
  // waist: aimed from the lower spine at the top of the spine, its left halfway between pelvis and chest
  const left = LEFT.clone().applyQuaternion(W.hips).add(LEFT.clone().applyQuaternion(W.chest));
  W.spine = aim(UP, LEFT, sub(P[I.spine3], P[I.spine1]), left);
  const chestFwd = FWD.clone().applyQuaternion(W.chest);
  W.neck = aim(UP, FWD, sub(P[I.head], P[I.neck]), chestFwd);
  W.head = W.neck.clone();
  for (const s of ['l', 'r']) {
    const sho = P[I[`${s}sho`]], elb = P[I[`${s}elb`]], wr = P[I[`${s}wrist`]];
    const armBend = bend(sho, elb, wr, BACK.clone().applyQuaternion(W.chest));   // elbows bend back (IK in figure.js)
    W[`${s}sho`] = aim(DOWN, BACK, sub(elb, sho), armBend);
    W[`${s}elb`] = aim(DOWN, BACK, sub(wr, elb), armBend);
    W[`${s}hand`] = W[`${s}elb`].clone();
    const hip = P[I[`${s}hip`]], knee = P[I[`${s}knee`]], ank = P[I[`${s}ankle`]], toe = P[I[`${s}toe`]];
    const legBend = bend(hip, knee, ank, FWD.clone().applyQuaternion(W.hips));     // knees bend forward
    W[`${s}hip`] = aim(DOWN, FWD, sub(knee, hip), legBend);
    W[`${s}knee`] = aim(DOWN, FWD, sub(ank, knee), legBend);
    const shinUp = sub(knee, ank);
    W[`${s}foot`] = aim(FWD, UP, sub(toe, ank), shinUp);
  }
  return W;
}

// world turns to each joint's own (local) turn, as [x, y, z, w]
export function localPose(W) {
  const j = {};
  for (const [name, [parent]] of Object.entries(JOINTS)) {
    const q = parent ? W[parent].clone().invert().multiply(W[name]) : W[name].clone();
    j[name] = q.toArray().map((x) => Math.round(x * 1e5) / 1e5);
  }
  return j;
}

const legLength = (P) => (sub(P[I.lhip], P[I.lknee]).length() + sub(P[I.lknee], P[I.lankle]).length()
  + sub(P[I.rhip], P[I.rknee]).length() + sub(P[I.rknee], P[I.rankle]).length()) / 2;

// resample frames (arrays of 22 points) at fps to FPS_OUT, linearly
export function resample(frames, fps) {
  if (!fps || Math.abs(fps - FPS_OUT) < 1e-6) return frames;
  const dur = (frames.length - 1) / fps, n = Math.max(1, Math.round(dur * FPS_OUT) + 1), out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(frames.length - 1, (i / FPS_OUT) * fps), a = Math.floor(t), b = Math.min(frames.length - 1, a + 1), u = t - a;
    out.push(frames[a].map((p, k) => p.map((x, c) => x + (frames[b][k][c] - x) * u)));
  }
  return out;
}

// motion { fps, frames: [[22 x [x,y,z]]...] } as figure keys from frame f0, every `every` frames.
// base: the figure's values where the motion starts (x, y, z, ry, sy...): the motion is turned by its ry,
// starts at its x/z, and is scaled to its size; the source person's leg length is matched to ours.
// travel: false keeps it on the spot (no path); rise: false keeps the hips at base.y (no up and down);
// fit: false takes the clip's metres as they are (only the figure's own size), not matched by leg length.
export function toKeys(motion, base, { f0 = 0, every = 2, maxF = Infinity, travel = true, rise = true, fit = true } = {}) {
  const frames = resample(motion.frames, motion.fps || 20);
  if (!frames.length) return [];
  const s = (fit ? LEG / (legLength(frames[0]) || LEG) : 1) * (base.sy || 1);
  const yaw = THREE.MathUtils.degToRad(base.ry || 0), turn = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const p0 = v3(frames[0][I.pelvis]);
  const keys = [];
  for (let i = 0; i < frames.length; i++) {
    const f = f0 + i;
    if (f > maxF) break;
    if (i % every && i !== frames.length - 1) continue;
    const P = frames[i];
    const W = worldTurns(P);   // (the figure's own ry turns these with it; only the path needs turning)
    const at = travel ? v3(P[I.pelvis]).sub(p0).setY(0).multiplyScalar(s).applyQuaternion(turn) : new THREE.Vector3();
    keys.push({ ...base, f, j: localPose(W), x: base.x + at.x, z: base.z + at.z,
      y: rise ? P[I.pelvis][1] * s - HIP_Y * (base.sy || 1) : base.y || 0, ease: 'linear', m: {} });
  }
  return keys;
}
