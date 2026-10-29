// Motion from outside (text-to-motion, video mocap) onto a 3D-tab figure. The input is joint positions
// per frame in the SMPL / HumanML3D 22-joint order, in metres, y up, the body facing +Z with its left on
// +X (the same frame as figure.js). Each figure joint's turn is rebuilt from where its bone points
// (and, for arms and legs, which way the elbow or knee bends), so the source's T-pose rest and bone
// lengths don't matter. With a capture's hands and face (MHR70), the head, the wrists and the fingers
// get their own turn; without them the head copies the neck and the hands copy the elbows, as before.
import * as THREE from './vendor/three.module.min.js';
import { FINGERS, JOINTS, mirrorQ, restOffsets, shapeFor } from './figure.js';
import { basis as camBasis } from './track-math.js';

export const SMPL22 = ['pelvis', 'lhip', 'rhip', 'spine1', 'lknee', 'rknee', 'spine2', 'lankle', 'rankle', 'spine3', 'ltoe', 'rtoe',
  'neck', 'lcollar', 'rcollar', 'head', 'lsho', 'rsho', 'lelb', 'relb', 'lwrist', 'rwrist'];
const I = Object.fromEntries(SMPL22.map((n, i) => [n, i]));
export const FPS_OUT = 24;
const LEG = Math.abs(JOINTS.lknee[1][1]) + Math.abs(JOINTS.lfoot[1][1]);   // our hip to ankle, metres
const HIP_Y = JOINTS.hips[1][1];

const v3 = (a) => (a?.isVector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));
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

// half of the twist about `axis` (the bone) moves onto the parent, so a turned hand rolls the forearm too
function shareTwist(parent, child, axis) {
  const ax = axis.clone().normalize();
  if (!Number.isFinite(ax.x)) return;
  const rel = parent.clone().invert().multiply(child);
  const dot = rel.x * ax.x + rel.y * ax.y + rel.z * ax.z;
  const tw = new THREE.Quaternion(ax.x * dot, ax.y * dot, ax.z * dot, rel.w);
  if (tw.lengthSq() < 1e-8) return;
  tw.normalize();
  parent.multiply(tw.slerp(new THREE.Quaternion(), 0.5));
}

// world turns of every figure joint for one frame of 22 points.
// face: [nose, leye, reye, lear, rear]. hands: {l, r} of 21 points, wrist then knuckle→tip per finger.
export function worldTurns(P, { face = null, hands = null } = {}) {
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
  if (face && face.length >= 5) {
    const earL = sub(face[3], face[4]), nose = sub(face[0], v3(face[3]).add(v3(face[4])).multiplyScalar(0.5));
    if (earL.length() > 1e-4 && nose.length() > 1e-4) W.head = aim(LEFT, FWD, earL, nose);
  }
  for (const s of ['l', 'r']) {
    const sho = P[I[`${s}sho`]], elb = P[I[`${s}elb`]], wr = P[I[`${s}wrist`]];
    const armBend = bend(sho, elb, wr, BACK.clone().applyQuaternion(W.chest));   // elbows bend back (IK in figure.js)
    W[`${s}sho`] = aim(DOWN, BACK, sub(elb, sho), armBend);
    W[`${s}elb`] = aim(DOWN, BACK, sub(wr, elb), armBend);
    W[`${s}hand`] = W[`${s}elb`].clone();
    const H = hands?.[s];
    if (H && H.length >= 21) {
      const along = sub(H[9], H[0]), across = sub(H[5], H[17]);
      if (along.length() > 1e-4 && across.length() > 1e-4) {
        W[`${s}hand`] = aim(DOWN, BACK, along, across);
        shareTwist(W[`${s}elb`], W[`${s}hand`], sub(wr, elb));
      }
    }
    const hip = P[I[`${s}hip`]], knee = P[I[`${s}knee`]], ank = P[I[`${s}ankle`]], toe = P[I[`${s}toe`]];
    const legBend = bend(hip, knee, ank, FWD.clone().applyQuaternion(W.hips));     // knees bend forward
    W[`${s}hip`] = aim(DOWN, FWD, sub(knee, hip), legBend);
    W[`${s}knee`] = aim(DOWN, FWD, sub(ank, knee), legBend);
    const shinUp = sub(knee, ank);
    W[`${s}foot`] = aim(FWD, UP, sub(toe, ank), shinUp);
  }
  return W;
}

// the angle between two bone directions, signed by which side of `palm` the bend falls on (degrees)
function bendDeg(a, b, palm) {
  const A = a.clone().normalize(), B = b.clone().normalize();
  if (!Number.isFinite(A.x) || !Number.isFinite(B.x)) return 0;
  const ang = Math.acos(THREE.MathUtils.clamp(A.dot(B), -1, 1)) * 180 / Math.PI;
  const sign = Math.sign(new THREE.Vector3().crossVectors(A, B).dot(palm)) || 1;
  return ang * sign;
}

// finger joints from a capture's hands ({l, r} of 21 points). Curl is +X, the same turns the Hands tab writes.
// A straight finger is the identity. Old motion without hands leaves the fingers as they were.
export function fingerPose(hands) {
  const out = {};
  for (const s of ['l', 'r']) {
    const H = hands?.[s];
    if (!H || H.length < 21) continue;
    const wrist = v3(H[0]);
    const along = sub(H[9], H[0]), across = sub(H[5], H[17]);
    let palm = new THREE.Vector3().crossVectors(along, across);
    if (palm.lengthSq() < 1e-8) palm.set(0, 0, s === 'l' ? -1 : 1);
    palm.normalize();
    FINGERS.forEach(([name], fi) => {
      const o = 1 + fi * 4;
      const chain = [wrist, v3(H[o]), v3(H[o + 1]), v3(H[o + 2]), v3(H[o + 3])];
      for (let j = 0; j < 3; j++) {
        const deg = bendDeg(chain[j + 1].clone().sub(chain[j]), chain[j + 2].clone().sub(chain[j + 1]), palm);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg * Math.PI / 180, 0, 0));
        const arr = q.toArray().map((x) => Math.round(x * 1e5) / 1e5);
        out[`${s}${name}${j + 1}`] = s === 'l' ? arr : mirrorQ(arr);
      }
    });
  }
  return out;
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

// A video capture is in its camera's space (Deck Save Body Motion: x right, y up, looking down -Z); app/motion.py
// normalised it and says how (space: normalised = m · given + t). Put back through a camera per frame
// (camAt(i): the scene camera's values px..tz, roll at 24 fps frame i), the body lands where that camera saw
// it in the world: a shot that pans keeps a body that stands still standing still. Returns { fps: 24, frames }.
function throughCam(p, M, t, eye, b) {
  const q = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  const r = [0, 1, 2].map((j) => q[0] * M[0][j] + q[1] * M[1][j] + q[2] * M[2][j]);   // (M is a turn: its inverse is its transpose)
  return [0, 1, 2].map((k) => eye[k] + r[0] * b.x[k] + r[1] * b.y[k] + r[2] * b.z[k]);
}
export function toWorld(motion, camAt) {
  const fps = motion.fps || 20;
  const frames = resample(motion.frames, fps), { m: M, t } = motion.space;
  const side = (pts) => pts ? resample(pts, fps) : null;
  const hl = side(motion.hands?.l), hr = side(motion.hands?.r), face = side(motion.face);
  const camPts = (P, i) => {
    const c = camAt(i), eye = [c.px, c.py, c.pz], b = camBasis(eye, [c.tx, c.ty, c.tz], c.roll || 0);
    return P.map((p) => throughCam(p, M, t, eye, b));
  };
  const out = { fps: FPS_OUT, frames: frames.map((P, i) => camPts(P, i)) };
  if (hl && hr) out.hands = { l: hl.map(camPts), r: hr.map(camPts) };
  if (face) out.face = face.map(camPts);
  return out;
}

// motion { fps, frames: [[22 x [x,y,z]]...] } as figure keys from frame f0, every `every` frames.
// base: the figure's values where the motion starts (x, y, z, ry, sy...): the motion is turned by its ry,
// starts at its x/z, and is scaled to its size; the source person's leg length is matched to ours.
// travel: false keeps it on the spot (no path); rise: false keeps the hips at base.y (no up and down);
// fit: false takes the clip's metres as they are (only the figure's own size), not matched by leg length.
// scale: the clip's metres times this (instead of fit and the figure's size); hipY: where the figure's hips joint
// stands above its root (a shaped figure's own; else the plain body's at its size).
export function toKeys(motion, base, { f0 = 0, every = 2, maxF = Infinity, travel = true, rise = true, fit = true, scale = null, hipY = null } = {}) {
  const fpsIn = motion.fps || 20;
  const frames = resample(motion.frames, fpsIn);
  if (!frames.length) return [];
  const faces = motion.face ? resample(motion.face, fpsIn) : null;
  const hl = motion.hands?.l ? resample(motion.hands.l, fpsIn) : null;
  const hr = motion.hands?.r ? resample(motion.hands.r, fpsIn) : null;
  const s = scale ?? (fit ? LEG / (legLength(frames[0]) || LEG) : 1) * (base.sy || 1), hy = hipY ?? HIP_Y * (base.sy || 1);
  const yaw = THREE.MathUtils.degToRad(base.ry || 0), turn = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const p0 = v3(frames[0][I.pelvis]);
  const keys = [];
  for (let i = 0; i < frames.length; i++) {
    const f = f0 + i;
    if (f > maxF) break;
    if (i % every && i !== frames.length - 1) continue;
    const P = frames[i];
    const hands = hl ? { l: hl[i], r: hr[i] } : null;
    const W = worldTurns(P, { face: faces?.[i] || null, hands });   // (the figure's own ry turns these with it; only the path needs turning)
    const at = travel ? v3(P[I.pelvis]).sub(p0).setY(0).multiplyScalar(s).applyQuaternion(turn) : new THREE.Vector3();
    keys.push({ ...base, f, j: { ...localPose(W), ...(hands ? fingerPose(hands) : {}) }, x: base.x + at.x, z: base.z + at.z,
      y: rise ? P[I.pelvis][1] * s - hy : base.y || 0, ease: 'linear', m: {} });
  }
  return keys;
}

// ---- the capture's proportions onto the figure: its bones measured (the median over the frames, metres), then the
// figure's size (sy) and shape (o.shape %) that come closest, so the retarget stretches less (feet plant, hands reach)
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function measure(frames) {
  const m = (fn) => median(frames.map(fn));
  const two = (a, b) => (P) => (dist(P[I[`l${a}`]], P[I[`l${b}`]]) + dist(P[I[`r${a}`]], P[I[`r${b}`]])) / 2;
  return {
    leg: m(two('hip', 'knee')) + m(two('knee', 'ankle')), arm: m(two('sho', 'elb')) + m(two('elb', 'wrist')),
    torso: m((P) => dist(P[I.pelvis], P[I.neck])), neck: m((P) => dist(P[I.neck], P[I.head])),
    sho: m((P) => dist(P[I.lsho], P[I.rsho])), hips: m((P) => dist(P[I.lhip], P[I.rhip])),
  };
}
// { sy, shape }: sy from the pelvis-to-neck height plus the legs (the steadiest lengths a capture gives), then each
// part's length over the figure's at that size as its shape. The head's place is rough in a capture (between the
// ears), so the neck goes only half way.
export function matchProportions(frames, body) {
  const c = measure(frames), r = restOffsets(body), len = (n) => Math.hypot(...r[n]);
  const fig = { leg: len('lknee') + len('lfoot'), arm: len('lelb') + len('lhand'),
    torso: len('spine') + len('chest') + len('neck') + Math.abs(r.lhip[1]),   // (the capture's pelvis is between the hip joints)
    sho: Math.abs(r.lsho[0] - r.rsho[0]), hips: Math.abs(r.lhip[0] - r.rhip[0]), neck: len('head') };
  const sy = (c.leg + c.torso) / (fig.leg + fig.torso), k = (n) => c[n] / (fig[n] * sy);
  const shape = shapeFor({ legs: k('leg'), arms: k('arm'), torso: k('torso'), sho: k('sho'), hips: k('hips'), neck: 1 + (k('neck') - 1) * 0.5 });
  return { sy, shape, measured: c };
}
