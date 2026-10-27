// A low-poly posable person for the 3D tab: faceted parts on a joint hierarchy (no skinning, each part
// just rides on its joint), two-bone IK for the arms and legs, pose presets, and the OpenPose
// keypoints of a pose for a pose control video. Built facing +Z, its left on +X, 1.75 m tall at scale 1.
import * as THREE from './vendor/three.module.min.js';

export const HEIGHT = 1.75;  // metres at scale 1

// joint: [parent, offset from the parent in metres, label]
export const JOINTS = {
  hips: [null, [0, 0.95, 0], 'Hips'],
  spine: ['hips', [0, 0.1, 0], 'Waist'],
  chest: ['spine', [0, 0.2, 0], 'Chest'],
  neck: ['chest', [0, 0.2, 0], 'Neck'],
  head: ['neck', [0, 0.08, 0], 'Head'],
  lsho: ['chest', [0.17, 0.15, 0], 'Left shoulder'],
  lelb: ['lsho', [0, -0.28, 0], 'Left elbow'],
  lhand: ['lelb', [0, -0.26, 0], 'Left hand'],
  rsho: ['chest', [-0.17, 0.15, 0], 'Right shoulder'],
  relb: ['rsho', [0, -0.28, 0], 'Right elbow'],
  rhand: ['relb', [0, -0.26, 0], 'Right hand'],
  lhip: ['hips', [0.09, -0.04, 0], 'Left hip'],
  lknee: ['lhip', [0, -0.43, 0], 'Left knee'],
  lfoot: ['lknee', [0, -0.43, 0], 'Left foot'],
  rhip: ['hips', [-0.09, -0.04, 0], 'Right hip'],
  rknee: ['rhip', [0, -0.43, 0], 'Right knee'],
  rfoot: ['rknee', [0, -0.43, 0], 'Right foot'],
};
// the hands and feet are dragged with IK: [end, middle, root] and which way the middle bends
export const IK = {
  lhand: ['lelb', 'lsho', [0, 0, -1]], rhand: ['relb', 'rsho', [0, 0, -1]],
  lfoot: ['lknee', 'lhip', [0, 0, 1]], rfoot: ['rknee', 'rhip', [0, 0, 1]],
};

const limb = (r1, r2, len) => new THREE.CylinderGeometry(r1, r2, len, 6).translate(0, -len / 2, 0);
function parts() {
  const g = {
    hips: new THREE.CylinderGeometry(0.14, 0.15, 0.2, 6).scale(1, 1, 0.75),
    spine: new THREE.CylinderGeometry(0.125, 0.135, 0.22, 6).scale(1, 1, 0.7).translate(0, 0.1, 0),
    chest: new THREE.CylinderGeometry(0.19, 0.13, 0.27, 6).scale(1, 1, 0.65).translate(0, 0.1, 0),
    neck: new THREE.CylinderGeometry(0.045, 0.055, 0.12, 6).translate(0, 0.03, 0),
    head: new THREE.IcosahedronGeometry(0.11, 1).scale(0.85, 1.08, 0.95).translate(0, 0.12, 0),
    nose: new THREE.ConeGeometry(0.025, 0.06, 4).rotateX(Math.PI / 2).translate(0, 0.11, 0.115),
    sho: new THREE.IcosahedronGeometry(0.06, 0),
    upperArm: limb(0.055, 0.042, 0.28),
    foreArm: limb(0.042, 0.033, 0.26),
    hand: new THREE.BoxGeometry(0.07, 0.17, 0.035).translate(0, -0.085, 0),
    thigh: limb(0.085, 0.06, 0.43),
    shin: limb(0.06, 0.045, 0.43),
    foot: new THREE.BoxGeometry(0.09, 0.06, 0.25).translate(0, -0.02, 0.06),
  };
  return {
    hips: [g.hips], spine: [g.spine], chest: [g.chest], neck: [g.neck], head: [g.head, g.nose],
    lsho: [g.sho, g.upperArm], lelb: [g.foreArm], lhand: [g.hand],
    rsho: [g.sho, g.upperArm], relb: [g.foreArm], rhand: [g.hand],
    lhip: [g.thigh], lknee: [g.shin], lfoot: [g.foot],
    rhip: [g.thigh], rknee: [g.shin], rfoot: [g.foot],
  };
}
let PARTS;

// root (a Group to place and scale), its joints by name, the part meshes, and a dot per joint (layer 1,
// drawn on top, for picking a joint)
export function buildFigure(material, dotMaterial) {
  PARTS ||= parts();
  const root = new THREE.Group(), bones = {}, meshes = [], dots = [];
  const dotGeo = new THREE.SphereGeometry(0.035, 10, 8);
  for (const [name, [parent, at]] of Object.entries(JOINTS)) {
    const b = new THREE.Object3D();
    b.name = name;
    b.position.fromArray(at);
    (parent ? bones[parent] : root).add(b);
    bones[name] = b;
    for (const geo of PARTS[name]) { const m = new THREE.Mesh(geo, material); m.userData.part = name; b.add(m); meshes.push(m); }
    const d = new THREE.Mesh(dotGeo, dotMaterial);
    d.userData.joint = name; d.renderOrder = 10; d.layers.set(1);
    b.add(d); dots.push(d);
  }
  // where OpenPose puts the face points, on the head
  const marks = {};
  for (const [k, p] of Object.entries({ nose: [0, 0.11, 0.12], reye: [-0.035, 0.145, 0.095], leye: [0.035, 0.145, 0.095],
    rear: [-0.09, 0.12, 0], lear: [0.09, 0.12, 0] })) {
    marks[k] = new THREE.Object3D(); marks[k].position.fromArray(p); bones.head.add(marks[k]);
  }
  return { root, bones, meshes, dots, marks };
}

// ---- hiding parts (display only): a part is a joint's own meshes, so its id is the joint name -------
// groups for the quick toggles: [id, label, its parts]
export const PART_GROUPS = [['head', 'Head', ['head']], ['torso', 'Torso', ['neck', 'chest', 'spine']], ['hips', 'Pelvis', ['hips']],
  ['armL', 'L arm', ['lsho', 'lelb']], ['armR', 'R arm', ['rsho', 'relb']], ['handL', 'L hand', ['lhand']], ['handR', 'R hand', ['rhand']],
  ['legL', 'L leg', ['lhip', 'lknee']], ['legR', 'R leg', ['rhip', 'rknee']], ['footL', 'L foot', ['lfoot']], ['footR', 'R foot', ['rfoot']]];
// hide is a list of part ids (absent = all shown). The meshes go invisible but stay in rig.meshes, so
// lowest() (the floor plant) still sees the whole body and hiding legs doesn't drop the figure.
export function setHidden(rig, hide) {
  const off = new Set(hide || []);
  for (const m of rig.meshes) m.visible = !off.has(m.userData.part);
}

// a pose is { joint: [x, y, z, w] } (local rotations; missing = rest), with parameters m on top
const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), M = new THREE.Matrix4();
const rad = THREE.MathUtils.degToRad;
export function applyPose(rig, j = {}, m = {}, ground = false) {
  const rot = paramRot(m);
  rig.mq = {};
  for (const [name, b] of Object.entries(rig.bones)) {
    if (j[name]) b.quaternion.fromArray(j[name]).normalize(); else b.quaternion.identity();
    const r = rot[name];
    if (r) { rig.mq[name] = new THREE.Quaternion().setFromEuler(E.set(rad(r[0]), rad(r[1]), rad(r[2]))); b.quaternion.multiply(rig.mq[name]); }
  }
  rig.bones.hips.position.y = JOINTS.hips[1][1];
  if (ground) { rig.bones.hips.position.y -= lowest(rig); rig.root.updateMatrixWorld(true); }
}
export function slerpPose(a = {}, b = {}, t) {
  const out = {};
  for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
    Q.fromArray(a[n] || [0, 0, 0, 1]); Q2.fromArray(b[n] || [0, 0, 0, 1]);
    out[n] = Q.slerp(Q2, t).toArray();
  }
  return out;
}
// one joint's turn between two (arrays [x, y, z, w]; missing = rest)
export function slerpQ(a, b, t) {
  Q.fromArray(a || [0, 0, 0, 1]); Q2.fromArray(b || [0, 0, 0, 1]);
  return Q.slerp(Q2, t).toArray();
}
// a joint's own turn, without the parameters on top
export function readJoint(rig, name) {
  const q = rig.bones[name].quaternion.clone(), mq = rig.mq?.[name];
  return (mq ? q.multiply(mq.clone().invert()) : q).toArray();
}

// set one joint's own turn (q), keeping its parameters on top
export function setJoint(rig, name, q) {
  rig.bones[name].quaternion.fromArray(q);
  if (rig.mq?.[name]) rig.bones[name].quaternion.multiply(rig.mq[name]);
}

// the figure's lowest point, in its own space (scale 1): 0 when standing on the floor
export function lowest(rig) {
  rig.root.updateMatrixWorld(true);
  const inv = rig.root.matrixWorld.clone().invert();
  let min = Infinity;
  for (const mesh of rig.meshes) {
    M.multiplyMatrices(inv, mesh.matrixWorld);
    const a = mesh.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) min = Math.min(min, V.fromBufferAttribute(a, i).applyMatrix4(M).y);
  }
  return min;
}
// a spare rig for working out poses away from the scene
let SPARE;
const spare = () => (SPARE ||= buildFigure(new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()));
// how far a pose has to move up to stand on the floor (sitting is negative), at scale 1
export function liftFor(j, m) { const r = spare(); applyPose(r, j, m); return -lowest(r); }

// the centre of mass (world), from rough shares of body weight per part
const MASS = { hips: 0.14, spine: 0.1, chest: 0.2, neck: 0.02, head: 0.08, lsho: 0.028, rsho: 0.028, lelb: 0.016, relb: 0.016,
  lhand: 0.006, rhand: 0.006, lhip: 0.1, rhip: 0.1, lknee: 0.045, rknee: 0.045, lfoot: 0.015, rfoot: 0.015 };
export function centerOfMass(rig) {
  rig.root.updateMatrixWorld(true);
  const sum = new THREE.Vector3();
  let w = 0;
  for (const [name, b] of Object.entries(rig.bones)) {
    const geo = b.children.find((c) => c.isMesh && !c.userData.joint)?.geometry;
    if (!geo || !MASS[name]) continue;
    geo.boundingSphere || geo.computeBoundingSphere();
    sum.addScaledVector(geo.boundingSphere.center.clone().applyMatrix4(b.matrixWorld), MASS[name]);
    w += MASS[name];
  }
  return sum.divideScalar(w);
}

// ---- parameters: named turns layered on a pose, keyed with it as m: { name: value } (missing = 0,
// off). Each turns joints by degrees (XYZ), after the pose's own turn.
export const PARAMS = {
  lean: { label: 'Lean', group: 'Body', min: -45, max: 60, on: 20, rot: (v) => ({ spine: [v / 2, 0, 0], chest: [v / 2, 0, 0] }) },
  side: { label: 'Side bend', group: 'Body', min: -40, max: 40, on: 15, rot: (v) => ({ spine: [0, 0, -v / 2], chest: [0, 0, -v / 2] }) },
  twist: { label: 'Twist', group: 'Body', min: -60, max: 60, on: 25, rot: (v) => ({ spine: [0, v / 2, 0], chest: [0, v / 2, 0] }) },
  fold: { label: 'Bend at hips', group: 'Body', min: -20, max: 110, on: 30, rot: (v) => ({ hips: [v, 0, 0], lhip: [-v, 0, 0], rhip: [-v, 0, 0] }) },
  sway: { label: 'Hip sway', group: 'Body', min: -15, max: 15, on: 6,
    rot: (v) => ({ hips: [0, 0, v], spine: [0, 0, -v], lhip: [0, 0, -v], rhip: [0, 0, -v] }) },
  turn: { label: 'Head turn', group: 'Head', min: -80, max: 80, on: 30, rot: (v) => ({ head: [0, v * 0.7, 0], neck: [0, v * 0.3, 0] }) },
  tilt: { label: 'Head tilt', group: 'Head', min: -40, max: 40, on: 15, rot: (v) => ({ head: [0, 0, -v] }) },
  nod: { label: 'Look down', group: 'Head', min: -50, max: 50, on: 20, rot: (v) => ({ head: [v * 0.6, 0, 0], neck: [v * 0.4, 0, 0] }) },
  armsOut: { label: 'Arms out', group: 'Arms', min: -20, max: 170, on: 35, rot: (v) => ({ lsho: [0, 0, v], rsho: [0, 0, -v] }) },
  armsFwd: { label: 'Arms forward', group: 'Arms', min: -60, max: 180, on: 45, rot: (v) => ({ lsho: [-v, 0, 0], rsho: [-v, 0, 0] }) },
  elbows: { label: 'Bend elbows', group: 'Arms', min: 0, max: 150, on: 60, rot: (v) => ({ lelb: [-v, 0, 0], relb: [-v, 0, 0] }) },
  legsApart: { label: 'Legs apart', group: 'Legs', min: -10, max: 90, on: 25, rot: (v) => ({ lhip: [0, 0, v / 2], rhip: [0, 0, -v / 2] }) },
  knees: { label: 'Bend knees', group: 'Legs', min: 0, max: 120, on: 30,
    rot: (v) => ({ lhip: [-v / 2, 0, 0], lknee: [v, 0, 0], lfoot: [-v / 2, 0, 0], rhip: [-v / 2, 0, 0], rknee: [v, 0, 0], rfoot: [-v / 2, 0, 0] }) },
  step: { label: 'Left foot forward', group: 'Legs', min: -45, max: 45, on: 20, rot: (v) => ({ lhip: [-v, 0, 0], rhip: [v, 0, 0] }) },
  tiptoe: { label: 'Tiptoe', group: 'Legs', min: 0, max: 70, on: 30, rot: (v) => ({ lfoot: [v, 0, 0], rfoot: [v, 0, 0] }) },
  // cycles: how much of a walk or run (they mix), at the step phase (0 to 1 is one stride, left and right)
  walk: { label: 'Walk', group: 'Cycle', min: 0, max: 100, on: 100, unit: '%', rot: (v, m) => gait(WALK, v / 100, m.phase || 0) },
  run: { label: 'Run', group: 'Cycle', min: 0, max: 100, on: 100, unit: '%', rot: (v, m) => gait(RUN, v / 100, m.phase || 0) },
  phase: { label: 'Step', group: null, min: 0, max: 8, rot: () => ({}) },
  // blends: part of the way into a pose
  squatB: { label: 'Squat', group: 'Blend', min: 0, max: 100, on: 50, unit: '%', rot: (v) => part('squat', v) },
  sitB: { label: 'Sit', group: 'Blend', min: 0, max: 100, on: 50, unit: '%', rot: (v) => part('sit', v) },
  kneelB: { label: 'Kneel', group: 'Blend', min: 0, max: 100, on: 50, unit: '%', rot: (v) => part('kneel', v) },
  crouchB: { label: 'Crouch', group: 'Blend', min: 0, max: 100, on: 50, unit: '%', rot: (v) => part('crouch', v) },
  bowB: { label: 'Bow', group: 'Blend', min: 0, max: 100, on: 50, unit: '%', rot: (v) => part('bow', v) },
};
// a preset's turns, v% of the way
function part(key, v) {
  return Object.fromEntries(Object.entries(PRESETS[key].j).map(([n, r]) => [n, r.map((x) => x * v / 100)]));
}
// a stride as curves of the phase (t: 0 to 1, the left foot lands at 0 and the right at 0.5): degrees,
// scaled by how much of it there is (a). Arms swing against the legs; the body bobs on its own when planted.
const WALK = { hip: 20, back: 2, knee: 50, stance: 8, toe: 14, arm: 16, elbow: 15, twist: 6, lean: 2, len: 1.5 };
const RUN = { hip: 42, back: 12, knee: 95, stance: 25, toe: 25, arm: 38, elbow: 80, twist: 12, lean: 10, len: 2.6 };
export const strideLength = (m = {}) => {  // metres per stride (two steps) at scale 1, for the mix of walk and run
  const w = (m.walk || 0) / 100, r = (m.run || 0) / 100;
  return w + r ? (WALK.len * w + RUN.len * r) / (w + r) : WALK.len;
};
function gait(g, a, phase) {
  const out = {};
  for (const [side, off, sgn] of [['l', 0, 1], ['r', 0.5, -1]]) {
    const th = 2 * Math.PI * (phase + off), c = Math.cos(th), sn = Math.sin(th);
    const swing = Math.max(0, -sn);  // the foot is off the ground for the second half of its cycle
    out[`${side}hip`] = [a * (-g.hip * c + g.back), 0, 0];
    out[`${side}knee`] = [a * (g.stance * Math.max(0, sn) + g.knee * swing ** 1.5), 0, 0];
    out[`${side}foot`] = [a * (g.toe * Math.max(0, -Math.sin(th + 0.6)) - g.toe * 0.5 * Math.max(0, c)), 0, 0];
    out[`${side}sho`] = [a * g.arm * c, 0, 0];
    out[`${side}elb`] = [-a * (g.elbow + g.elbow * 0.3 * (1 - c)), 0, 0];
    if (side === 'l') {
      out.chest = [a * g.lean / 2, a * g.twist * c * sgn, 0];
      out.spine = [a * g.lean / 2, 0, 0];
      out.hips = [0, -a * g.twist * 0.6 * c, 0];
    }
  }
  return out;
}
// the turns all the parameters in m add up to, per joint (degrees)
function paramRot(m = {}) {
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (!v || !PARAMS[k]) continue;
    for (const [n, r] of Object.entries(PARAMS[k].rot(v, m))) { const o = (out[n] ||= [0, 0, 0]); o[0] += r[0]; o[1] += r[1]; o[2] += r[2]; }
  }
  return out;
}
export function lerpParams(a = {}, b = {}, t) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const v = (a?.[k] || 0) + ((b?.[k] || 0) - (a?.[k] || 0)) * t;
    if (v) out[k] = v;
  }
  return out;
}
// mirrored parameters: the ones with a side change sign
const SIDED = new Set(['side', 'twist', 'sway', 'turn', 'tilt', 'step']);
export const mirrorParams = (m = {}) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, SIDED.has(k) ? -v : k === 'phase' ? v + 0.5 : v]));

// turn a bone by a world-space rotation q
function rotateWorld(bone, q) {
  const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const bq = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pq.invert().multiply(q.multiply(bq)));
  bone.updateMatrixWorld(true);
}

// move a hand or foot to target (world): the shoulder or hip and the elbow or knee turn, bending the
// way they already bend (or the natural way when the limb is straight). The hand or foot keeps its
// world orientation. Returns the joints it changed.
export function solveIK(rig, endName, target) {
  const [midName, rootName, bend] = IK[endName];
  const end = rig.bones[endName], mid = rig.bones[midName], top = rig.bones[rootName];
  rig.root.updateMatrixWorld(true);
  const V = () => new THREE.Vector3();
  const A = top.getWorldPosition(V()), B = mid.getWorldPosition(V()), C = end.getWorldPosition(V());
  const endQ = end.getWorldQuaternion(new THREE.Quaternion());
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
  const dir = target.clone().sub(A);
  const d = THREE.MathUtils.clamp(dir.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  if (dir.lengthSq() < 1e-8) return [];
  dir.normalize();
  const flat = (v) => v.sub(dir.clone().multiplyScalar(v.dot(dir)));
  let pole = flat(B.clone().sub(A));
  if (pole.lengthSq() < 1e-6) pole = flat(new THREE.Vector3(...bend).applyQuaternion(rig.bones[rootName].parent.getWorldQuaternion(new THREE.Quaternion())));
  if (pole.lengthSq() < 1e-8) pole = flat(new THREE.Vector3(0, 0, 1));
  pole.normalize();
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const Bn = A.clone().addScaledVector(dir, l1 * cosA).addScaledVector(pole, l1 * sinA);
  const Cn = A.clone().addScaledVector(dir, d);
  rotateWorld(top, new THREE.Quaternion().setFromUnitVectors(B.clone().sub(A).normalize(), Bn.clone().sub(A).normalize()));
  const B2 = mid.getWorldPosition(V()), C2 = end.getWorldPosition(V());
  rotateWorld(mid, new THREE.Quaternion().setFromUnitVectors(C2.sub(B2).normalize(), Cn.sub(B2).normalize()));
  end.quaternion.copy(end.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(endQ));
  end.updateMatrixWorld(true);
  return [rootName, midName, endName];
}

// presets: joint rotations in degrees (XYZ), in a category. ik: a hand or foot is then pulled to a
// point (a joint's place plus an offset in metres, figure axes: x its left, y up, z its front).
const CATS = [['stand', 'Stand'], ['bend', 'Bend & lean'], ['move', 'Move'], ['low', 'Sit & kneel'], ['floor', 'Floor'], ['fit', 'Fitness']];
const PRESETS = {
  // standing
  stand: { label: 'Stand', cat: 'stand', j: { lsho: [0, 0, 8], rsho: [0, 0, -8], lelb: [-8, 0, 0], relb: [-8, 0, 0] } },
  relaxed: { label: 'Relaxed', cat: 'stand', j: { hips: [0, 0, 2], spine: [0, 0, -3], head: [0, 0, 4], lsho: [3, 0, 6], rsho: [-3, 0, -9],
    lelb: [-15, 0, 0], relb: [-6, 0, 0], rhip: [-6, 0, -4], rknee: [12, 0, 0] } },
  akimbo: { label: 'Hands on hips', cat: 'stand', j: { lsho: [0, 0, 45], rsho: [0, 0, -45] },
    ik: { lhand: ['lhip', [0.1, 0.1, 0]], rhand: ['rhip', [-0.1, 0.1, 0]] } },
  crossed: { label: 'Arms crossed', cat: 'stand', j: { lsho: [-30, 0, 20], rsho: [-30, 0, -20] },
    ik: { lhand: ['chest', [-0.13, 0.1, 0.17]], rhand: ['chest', [0.13, 0.06, 0.2]] } },
  think: { label: 'Thinking', cat: 'stand', j: { head: [8, 0, 0], lsho: [-30, 0, 15], rsho: [-40, 0, -15] },
    ik: { rhand: ['head', [0, 0.02, 0.14]], lhand: ['chest', [-0.08, -0.04, 0.18]] } },
  phone: { label: 'On the phone', cat: 'stand', j: { lsho: [0, 0, 8], lelb: [-8, 0, 0], rsho: [0, 0, -40] }, ik: { rhand: ['head', [-0.11, 0.1, 0.03]] } },
  point: { label: 'Point', cat: 'stand', j: { rsho: [-85, 0, 0], lsho: [0, 0, 8], lelb: [-8, 0, 0], head: [0, -10, 0] } },
  wave: { label: 'Wave', cat: 'stand', j: { rsho: [0, 0, -150], relb: [0, 0, -30], lsho: [0, 0, 8], lelb: [-8, 0, 0] } },
  reach: { label: 'Arms up', cat: 'stand', j: { lsho: [0, 0, 170], rsho: [0, 0, -170] } },
  tpose: { label: 'T-pose', cat: 'stand', j: { lsho: [0, 0, 90], rsho: [0, 0, -90] } },
  shrug: { label: 'Shrug', cat: 'stand', j: { head: [0, 0, 10], lsho: [0, 0, 20], rsho: [0, 0, -20] },
    ik: { lhand: ['lsho', [0.28, -0.36, 0.22]], rhand: ['rsho', [-0.28, -0.36, 0.22]] } },
  salute: { label: 'Salute', cat: 'stand', j: { rsho: [0, 0, -75], lsho: [0, 0, 8], lelb: [-8, 0, 0] }, ik: { rhand: ['head', [-0.08, 0.15, 0.1]] } },
  handsUp: { label: 'Hands up', cat: 'stand', j: { lsho: [0, 0, 90], rsho: [0, 0, -90], lelb: [0, 0, 90], relb: [0, 0, -90] } },
  behind: { label: 'Hands behind', cat: 'stand', j: { lsho: [20, 0, 12], rsho: [20, 0, -12] },
    ik: { lhand: ['hips', [0.04, 0.02, -0.17]], rhand: ['hips', [-0.04, 0.02, -0.17]] } },
  together: { label: 'Hands together', cat: 'stand', j: { lsho: [-25, 0, 15], rsho: [-25, 0, -15] },
    ik: { lhand: ['chest', [0.02, 0.02, 0.3]], rhand: ['chest', [-0.02, 0.02, 0.3]] } },
  bow: { label: 'Bow', cat: 'stand', j: { spine: [25, 0, 0], chest: [25, 0, 0], neck: [10, 0, 0], lsho: [-50, 0, 5], rsho: [-50, 0, -5] } },
  thumb: { label: 'Thumbs up', cat: 'stand', j: { lsho: [0, 0, 8], lelb: [-8, 0, 0], rsho: [-30, 0, -5], relb: [-70, 0, 0] } },
  // bending and leaning
  bendOver: { label: 'Bend over', cat: 'bend', j: { hips: [70, 0, 0], lhip: [-70, 0, 0], rhip: [-70, 0, 0], spine: [10, 0, 0], head: [-30, 0, 0],
    lsho: [-80, 0, 5], rsho: [-80, 0, -5] } },
  leanOver: { label: 'Lean on table', cat: 'bend', j: { hips: [45, 0, 0], lhip: [-45, 0, 0], rhip: [-45, 0, 0], spine: [10, 0, 0], head: [-25, 0, 0],
    lsho: [-60, 0, 15], rsho: [-60, 0, -15] }, ik: { lhand: ['hips', [0.25, -0.17, 0.55]], rhand: ['hips', [-0.25, -0.17, 0.55]] } },
  toes: { label: 'Touch toes', cat: 'bend', j: { hips: [100, 0, 0], lhip: [-100, 0, 0], rhip: [-100, 0, 0], spine: [20, 0, 0], lsho: [-120, 0, 0], rsho: [-120, 0, 0] } },
  pickUp: { label: 'Pick up', cat: 'bend', j: { hips: [35, 0, 0], spine: [20, 0, 0], lhip: [-90, 0, 0], lknee: [90, 0, 0], lfoot: [-10, 0, 0], rhip: [-55, 0, 0],
    rknee: [60, 0, 0], rfoot: [-20, 0, 0], rsho: [-60, 0, 0], lsho: [-40, 0, 20] }, ik: { rhand: ['rfoot', [-0.12, 0.02, 0.4]] } },
  leanBack: { label: 'Lean back', cat: 'bend', j: { spine: [-15, 0, 0], chest: [-15, 0, 0], head: [-15, 0, 0], lsho: [20, 0, 15], rsho: [20, 0, -15] },
    ik: { lhand: ['hips', [0.12, 0.12, -0.16]], rhand: ['hips', [-0.12, 0.12, -0.16]] } },
  wallLean: { label: 'Lean on wall', cat: 'bend', j: { hips: [0, 0, -10], lhip: [0, 0, 6], rhip: [-10, 0, 14], rknee: [10, 0, 0], head: [0, 0, -6],
    lsho: [-30, 0, 20], rsho: [-30, 0, -20] }, ik: { lhand: ['chest', [-0.13, 0.1, 0.17]], rhand: ['chest', [0.13, 0.06, 0.2]] } },
  shoulder: { label: 'Look back', cat: 'bend', j: { spine: [0, 20, 0], chest: [0, 40, 0], head: [0, 60, 0], lsho: [0, 0, 8], rsho: [0, 0, -8] } },
  tieShoe: { label: 'Tie shoe', cat: 'bend', j: { lhip: [-90, 0, 0], lknee: [90, 0, 0], rhip: [5, 0, 0], rknee: [95, 0, 0], spine: [40, 0, 0], chest: [20, 0, 0],
    lsho: [-60, 0, 10], rsho: [-60, 0, -10] }, ik: { lhand: ['lfoot', [0.06, 0.1, 0.12]], rhand: ['lfoot', [-0.06, 0.1, 0.12]] } },
  reachHigh: { label: 'Reach high', cat: 'bend', j: { lfoot: [30, 0, 0], rfoot: [30, 0, 0], rsho: [-170, 0, 0], lsho: [0, 0, 8] } },
  // moving
  walk: { label: 'Walk', cat: 'move', j: { lhip: [-22, 0, 0], lknee: [12, 0, 0], rhip: [18, 0, 0], rknee: [28, 0, 0], rfoot: [-10, 0, 0],
    lsho: [18, 0, 6], rsho: [-18, 0, -6], lelb: [-12, 0, 0], relb: [-28, 0, 0] } },
  run: { label: 'Run', cat: 'move', j: { spine: [10, 0, 0], lhip: [-55, 0, 0], lknee: [70, 0, 0], rhip: [25, 0, 0], rknee: [95, 0, 0],
    lsho: [40, 0, 8], rsho: [-50, 0, -8], lelb: [-80, 0, 0], relb: [-90, 0, 0] } },
  jump: { label: 'Jump', cat: 'move', j: { lsho: [0, 0, 150], rsho: [0, 0, -150], lhip: [-40, 0, 0], lknee: [70, 0, 0], rhip: [-25, 0, 0],
    rknee: [50, 0, 0], lfoot: [30, 0, 0], rfoot: [30, 0, 0] } },
  kick: { label: 'Kick', cat: 'move', j: { spine: [-12, 0, 0], rhip: [-85, 0, 0], rknee: [10, 0, 0], rfoot: [-10, 0, 0], lknee: [10, 0, 0],
    lsho: [0, 0, 50], lelb: [-30, 0, 0], rsho: [0, 0, -40] } },
  punch: { label: 'Punch', cat: 'move', j: { lhip: [-20, 0, 0], lknee: [15, 0, 0], rhip: [15, 0, 0], rknee: [15, 0, 0], chest: [0, 25, 0],
    rsho: [-90, 0, 0], lsho: [-50, 0, 15], lelb: [-120, 0, 0] } },
  guard: { label: 'Guard', cat: 'move', j: { head: [8, 0, 0], lhip: [-15, 0, 4], rhip: [10, 0, -4], lknee: [20, 0, 0], rknee: [20, 0, 0],
    lsho: [-40, 0, 20], rsho: [-35, 0, -20], lelb: [-120, 0, 0], relb: [-125, 0, 0] } },
  throw: { label: 'Throw', cat: 'move', j: { chest: [0, -25, 0], lhip: [-25, 0, 0], rhip: [15, 0, 0], rknee: [15, 0, 0],
    rsho: [-45, 0, -110], relb: [-70, 0, 0], lsho: [-70, 0, 20] } },
  climb: { label: 'Climb', cat: 'move', j: { lsho: [-165, 0, 0], rsho: [-140, 0, 0], relb: [-40, 0, 0], lhip: [-70, 0, 0], lknee: [100, 0, 0],
    rhip: [-10, 0, 0], rknee: [20, 0, 0] } },
  carry: { label: 'Carry', cat: 'move', j: { spine: [-5, 0, 0], lsho: [-45, 0, 5], rsho: [-45, 0, -5], lelb: [-50, 0, 0], relb: [-50, 0, 0] },
    ik: { lhand: ['chest', [0.17, -0.12, 0.36]], rhand: ['chest', [-0.17, -0.12, 0.36]] } },
  push: { label: 'Push', cat: 'move', j: { spine: [15, 0, 0], chest: [10, 0, 0], lsho: [-75, 0, 0], rsho: [-75, 0, 0], lelb: [-25, 0, 0],
    relb: [-25, 0, 0], lhip: [-35, 0, 0], lknee: [35, 0, 0], rhip: [25, 0, 0], rfoot: [20, 0, 0] } },
  pull: { label: 'Pull', cat: 'move', j: { spine: [-15, 0, 0], lsho: [-70, 0, 0], rsho: [-70, 0, 0], lhip: [-25, 0, 0], lknee: [30, 0, 0],
    rhip: [5, 0, 0], rknee: [20, 0, 0] } },
  // sitting and kneeling
  sit: { label: 'Sit (chair)', cat: 'low', j: { lhip: [-90, 0, 0], rhip: [-90, 0, 0], lknee: [90, 0, 0], rknee: [90, 0, 0],
    lsho: [-15, 0, 6], rsho: [-15, 0, -6], lelb: [-45, 0, 0], relb: [-45, 0, 0] } },
  crossLegs: { label: 'Cross-legged', cat: 'low', j: { lhip: [-90, 0, 45], rhip: [-90, 0, -45], lsho: [-20, 0, 10], lelb: [-40, 0, 0],
    rsho: [-20, 0, -10], relb: [-40, 0, 0] }, ik: { lfoot: ['hips', [-0.17, -0.12, 0.32]], rfoot: ['hips', [0.17, -0.14, 0.28]] } },
  longSit: { label: 'Sit, legs out', cat: 'low', j: { spine: [-15, 0, 0], lhip: [-90, 0, 0], rhip: [-90, 0, 0], lsho: [55, 0, 15], rsho: [55, 0, -15] } },
  hugKnees: { label: 'Hug knees', cat: 'low', j: { spine: [20, 0, 0], chest: [15, 0, 0], lhip: [-125, 0, 0], rhip: [-125, 0, 0], lknee: [135, 0, 0],
    rknee: [135, 0, 0], lsho: [-60, 0, 10], rsho: [-60, 0, -10], lelb: [-60, 0, 0], relb: [-60, 0, 0] } },
  kneelOne: { label: 'Kneel (one knee)', cat: 'low', j: { lhip: [-90, 0, 0], lknee: [90, 0, 0], rhip: [5, 0, 0], rknee: [95, 0, 0],
    lsho: [-50, 0, 10], lelb: [-40, 0, 0], rsho: [0, 0, -8], relb: [-8, 0, 0] } },
  kneel: { label: 'Kneel', cat: 'low', j: { lknee: [90, 0, 0], rknee: [90, 0, 0], lfoot: [90, 0, 0], rfoot: [90, 0, 0], lsho: [0, 0, 8], rsho: [0, 0, -8] } },
  seiza: { label: 'Sit on heels', cat: 'low', j: { lhip: [-75, 0, 0], rhip: [-75, 0, 0], lknee: [160, 0, 0], rknee: [160, 0, 0], lfoot: [95, 0, 0],
    rfoot: [95, 0, 0], lsho: [-30, 0, 5], rsho: [-30, 0, -5], lelb: [-50, 0, 0], relb: [-50, 0, 0] } },
  squat: { label: 'Squat', cat: 'low', j: { spine: [35, 0, 0], lhip: [-115, 0, 20], rhip: [-115, 0, -20], lknee: [140, 0, 0], rknee: [140, 0, 0],
    lfoot: [-25, 0, 0], rfoot: [-25, 0, 0], lsho: [-80, 0, 10], rsho: [-80, 0, -10] } },
  crouch: { label: 'Crouch', cat: 'low', j: { spine: [40, 0, 0], chest: [10, 0, 0], head: [-30, 0, 0], lhip: [-70, 0, 0], lknee: [110, 0, 0],
    lfoot: [-40, 0, 0], rhip: [-50, 0, 0], rknee: [100, 0, 0], rfoot: [-50, 0, 0], lsho: [-40, 0, 10], rsho: [-40, 0, -10] } },
  // on the floor
  allFours: { label: 'On all fours', cat: 'floor', j: { hips: [84, 0, 0], lhip: [-84, 0, 0], rhip: [-84, 0, 0], lknee: [90, 0, 0], rknee: [90, 0, 0],
    lfoot: [90, 0, 0], rfoot: [90, 0, 0], lsho: [-84, 0, 0], rsho: [-84, 0, 0], lhand: [-90, 0, 0], rhand: [-90, 0, 0], neck: [-15, 0, 0], head: [-55, 0, 0] } },
  plank: { label: 'Plank', cat: 'floor', j: { hips: [74, 0, 0], lsho: [-74, 0, 0], rsho: [-74, 0, 0], lhand: [-90, 0, 0], rhand: [-90, 0, 0],
    lfoot: [16, 0, 0], rfoot: [16, 0, 0], head: [-30, 0, 0] } },
  forearm: { label: 'Forearm plank', cat: 'floor', j: { hips: [80, 0, 0], lsho: [-80, 0, 0], rsho: [-80, 0, 0], lelb: [-90, 0, 0], relb: [-90, 0, 0],
    lfoot: [10, 0, 0], rfoot: [10, 0, 0], head: [-25, 0, 0] } },
  pushDown: { label: 'Push-up (down)', cat: 'floor', j: { hips: [86, 0, 0], lsho: [-86, 0, 30], rsho: [-86, 0, -30], lhand: [-90, 0, 0], rhand: [-90, 0, 0],
    lfoot: [4, 0, 0], rfoot: [4, 0, 0], head: [-30, 0, 0] }, ik: { lhand: ['lsho', [0.12, -0.3, -0.05]], rhand: ['rsho', [-0.12, -0.3, -0.05]] } },
  lieBack: { label: 'Lie on back', cat: 'floor', j: { hips: [-90, 0, 0], lfoot: [20, 0, 0], rfoot: [20, 0, 0], lsho: [0, 0, 10], rsho: [0, 0, -10] } },
  lieFront: { label: 'Lie face down', cat: 'floor', j: { hips: [90, 0, 0], head: [0, 70, 0], lfoot: [70, 0, 0], rfoot: [70, 0, 0], lsho: [0, 0, 10], rsho: [0, 0, -10] } },
  lieSide: { label: 'Lie on side', cat: 'floor', j: { hips: [0, 0, 90], lhip: [-30, 0, 0], lknee: [40, 0, 0], rhip: [-15, 0, 0], rknee: [25, 0, 0],
    rsho: [-150, 0, 0], lsho: [-30, 0, 0] } },
  // fitness
  lunge: { label: 'Lunge', cat: 'fit', j: { lhip: [-85, 0, 0], lknee: [90, 0, 0], lfoot: [-5, 0, 0], rhip: [25, 0, 0], rknee: [90, 0, 0], lsho: [0, 0, 8], rsho: [0, 0, -8] } },
  star: { label: 'Star', cat: 'fit', j: { lsho: [0, 0, 135], rsho: [0, 0, -135], lhip: [0, 0, 22], rhip: [0, 0, -22] } },
  stretch: { label: 'Side stretch', cat: 'fit', j: { spine: [0, 0, -15], chest: [0, 0, -15], lsho: [0, 0, 165], rsho: [0, 0, -15], relb: [-10, 0, 0] } },
  tree: { label: 'Tree', cat: 'fit', j: { lhip: [0, 0, 60], lsho: [0, 0, 165], rsho: [0, 0, -165] },
    ik: { lfoot: ['rknee', [0.07, 0.1, 0]], lhand: ['head', [0.03, 0.45, 0]], rhand: ['head', [-0.03, 0.45, 0]] } },
  warrior: { label: 'Warrior', cat: 'fit', j: { spine: [0, -20, 0], chest: [0, -50, 0], head: [0, 70, 0], lhip: [-55, 0, 0], lknee: [65, 0, 0],
    lfoot: [-10, 0, 0], rhip: [35, 0, 0], rfoot: [-35, 0, 0], lsho: [0, 0, 90], rsho: [0, 0, -90] } },
  downDog: { label: 'Downward dog', cat: 'fit', j: { spine: [65, 0, 0], chest: [55, 0, 0], lsho: [-175, 0, 8], rsho: [-175, 0, -8],
    lhip: [25, 0, 0], rhip: [25, 0, 0], lfoot: [-20, 0, 0], rfoot: [-20, 0, 0] } },
};
export const categories = () => CATS;
export const presetList = (cat = null) => Object.entries(PRESETS).filter(([, p]) => !cat || p.cat === cat).map(([k, p]) => [k, p.label]);
// a pose spec: a preset's name, or { from: a preset to start from, j: turns in degrees, ik: points to pull to }
function buildPose(p) {
  if (typeof p === 'string') return preset(p).j;
  const j = p.from ? preset(p.from).j : {};
  for (const [n, [x, y, z]] of Object.entries(p.j || {})) j[n] = Q.setFromEuler(E.set(rad(x), rad(y), rad(z))).toArray();
  if (p.ik) {  // pull hands and feet to their points on a spare rig, and read the turns back
    const r = spare();
    applyPose(r, j);
    r.root.updateMatrixWorld(true);
    for (const [end, [at, off]] of Object.entries(p.ik)) {
      solveIK(r, end, r.bones[at].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...off)));
      for (const n of [end, ...IK[end].slice(0, 2)]) j[n] = readJoint(r, n);
    }
  }
  return j;
}
const BUILT = {};
export function preset(key) {
  BUILT[key] ||= buildPose({ ...PRESETS[key], from: null });
  return { j: { ...BUILT[key] } };
}

// ---- two people together: the selected figure (a) and a partner (b) placed in a's space: at is
// [x, how high b's hips are above a's (null: b stands on the floor), z, b's turn in degrees]
const PAIRS = {
  hug: { label: 'Hug', a: { j: { head: [0, 30, 0], lsho: [-60, 0, 30], rsho: [-60, 0, -30] },
    ik: { lhand: ['chest', [0.06, 0.02, 0.44]], rhand: ['chest', [-0.06, 0.08, 0.44]] } }, b: 'hugB', at: [0, null, 0.32, 180] },
  kiss: { label: 'Kiss', a: { j: { spine: [5, 0, 0], head: [8, 0, 14], lsho: [-30, 0, 20], rsho: [-30, 0, -20] },
    ik: { lhand: ['hips', [0.16, 0.12, 0.28]], rhand: ['hips', [-0.16, 0.12, 0.28]] } },
  b: { j: { spine: [5, 0, 0], head: [12, 0, 14], lsho: [-100, 0, 30], rsho: [-100, 0, -30] },
    ik: { lhand: ['neck', [0.1, 0.02, 0.3]], rhand: ['neck', [-0.1, 0.02, 0.3]] } }, at: [0, null, 0.3, 180] },
  hands: { label: 'Holding hands', a: { from: 'stand', j: { rsho: [0, 0, -20] }, ik: { rhand: ['hips', [-0.28, -0.12, 0.06]] } },
    b: { from: 'stand', j: { lsho: [0, 0, 20] }, ik: { lhand: ['hips', [0.28, -0.12, 0.06]] } }, at: [-0.56, null, 0, 0] },
  shake: { label: 'Handshake', a: { from: 'stand', j: { rsho: [-30, 0, 0] }, ik: { rhand: ['hips', [-0.02, 0.05, 0.42]] } }, b: 'shakeB', at: [0, null, 0.86, 180] },
  dance: { label: 'Slow dance', a: { j: { lsho: [-30, 0, 20], rsho: [-30, 0, -20] }, ik: { lhand: ['hips', [0.15, 0.14, 0.3]], rhand: ['hips', [-0.15, 0.14, 0.3]] } },
    b: { j: { lsho: [-90, 0, 30], rsho: [-90, 0, -30] }, ik: { lhand: ['neck', [0.16, -0.06, 0.3]], rhand: ['neck', [-0.16, -0.06, 0.3]] } }, at: [0, null, 0.36, 180] },
  carry: { label: 'Carry in arms', a: { j: { spine: [-6, 0, 0], lsho: [-60, 0, 20], rsho: [-60, 0, -20] },
    ik: { lhand: ['chest', [0.3, -0.22, 0.34]], rhand: ['chest', [-0.25, -0.12, 0.34]] } },
  b: { j: { hips: [-80, 0, 0], lhip: [-70, 0, 0], rhip: [-70, 0, 0], lknee: [80, 0, 0], rknee: [80, 0, 0], head: [-20, 0, 0], lsho: [-150, 0, 0] } },
  at: [0.02, 0.08, 0.36, 90] },
  piggy: { label: 'Piggyback', a: { j: { spine: [12, 0, 0], lsho: [25, 0, 25], rsho: [25, 0, -25], lelb: [-70, 0, 0], relb: [-70, 0, 0] } },
    b: { j: { spine: [10, 0, 0], lhip: [-75, 0, 30], rhip: [-75, 0, -30], lknee: [80, 0, 0], rknee: [80, 0, 0], lsho: [-90, 0, 15], rsho: [-90, 0, -15] },
      ik: { lhand: ['chest', [-0.06, 0.12, 0.34]], rhand: ['chest', [0.06, 0.12, 0.34]] } }, at: [0, 0.12, -0.24, 0] },
  lap: { label: 'Sit on lap', a: 'sit', b: { from: 'sit', j: { lsho: [-120, 0, 10], head: [0, -30, 0] } }, at: [0, 0.16, 0.26, 90] },
  straddle: { label: 'Straddle (seated)', a: 'sit', b: { j: { lhip: [-80, 0, 35], rhip: [-80, 0, -35], lknee: [100, 0, 0], rknee: [100, 0, 0],
    lsho: [-90, 0, 30], rsho: [-90, 0, -30] }, ik: { lhand: ['neck', [0.16, -0.05, 0.26]], rhand: ['neck', [-0.16, -0.05, 0.26]] } }, at: [0, 0.18, 0.3, 180] },
  kneelFacing: { label: 'Kneel facing', a: 'kneel', b: 'kneel', at: [0, null, 0.55, 180] },
  lieBacks: { label: 'Lie on backs', a: 'lieBack', b: 'lieBack', at: [-0.55, null, 0, 0] },
  lieFronts: { label: 'Lie on fronts', a: 'lieFront', b: { from: 'lieFront', j: { head: [0, -70, 0] } }, at: [-0.55, null, 0, 0] },
  spoon: { label: 'Lie on sides', a: 'lieSide', b: 'lieSide', at: [0, null, -0.28, 0] },
  onTop: { label: 'Lie on top', a: { from: 'lieBack', j: { lsho: [-80, 0, 25], rsho: [-80, 0, -25], lelb: [-40, 0, 0], relb: [-40, 0, 0] } },
    b: { from: 'lieFront', j: { head: [-10, 30, 0], lsho: [0, 0, 40], rsho: [0, 0, -40] } }, at: [0, 0.22, 0.05, 180] },
  grapple: { label: 'Grapple', a: { j: { spine: [20, 0, 0], lhip: [-20, 0, 8], rhip: [15, 0, -8], lknee: [25, 0, 0], rknee: [20, 0, 0], lsho: [-70, 0, 20], rsho: [-70, 0, -20] },
    ik: { lhand: ['chest', [0.17, 0.12, 0.42]], rhand: ['chest', [-0.12, -0.05, 0.4]] } }, b: 'grappleB', at: [0, null, 0.5, 180] },
  fight: { label: 'Punch & guard', a: 'punch', b: 'guard', at: [0, null, 0.85, 180] },
  helpUp: { label: 'Help up', a: { j: { spine: [30, 0, 0], lhip: [-15, 0, 0], lknee: [20, 0, 0], rsho: [-70, 0, 0] }, ik: { rhand: ['hips', [-0.02, -0.25, 0.55]] } },
    b: { from: 'longSit', j: { rsho: [-120, 0, -5] } }, at: [0, null, 0.95, 180] },
};
// the partner's halves that are the same as the first's
for (const [b, a] of [['hugB', 'hug'], ['shakeB', 'shake'], ['grappleB', 'grapple']]) PRESETS[b] = { ...PAIRS[a].a, cat: null, label: '' };
export const pairList = () => Object.entries(PAIRS).map(([k, p]) => [k, p.label]);
export function pair(key) {
  const p = PAIRS[key], a = buildPose(p.a), b = buildPose(p.b), [x, dy, z, ry] = p.at;
  return { a, b, at: { x, z, ry, y: dy == null ? 0 : liftFor(a) - liftFor(b) + dy } };  // y: b's Up (both planted)
}

// ---- a small picture of a pose: a stick figure seen from the front and a little to the side,
// standing on a line (its left limbs blue, its right ones amber)
const STICKS = [['hips', 'spine', 'chest', 'neck', 'head'], ['neck', 'lsho', 'lelb', 'lhand', 'ltip'], ['neck', 'rsho', 'relb', 'rhand', 'rtip'],
  ['lhip', 'lknee', 'lfoot', 'ltoe'], ['rhip', 'rknee', 'rfoot', 'rtoe'], ['lhip', 'hips', 'rhip']];
const THUMB_RIGS = [];
// people: [{ j, m, at: { x, y, z, ry } (where it stands; a's own space) }]
export function drawThumb(canvas, people, { yaw = 35, pitch = 12 } = {}) {
  const rot = new THREE.Euler(rad(pitch), rad(yaw), 0, 'XYZ');
  const all = people.map((p, i) => {
    const r = (THUMB_RIGS[i] ||= buildFigure(new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()));
    const at = p.at || {};
    r.root.position.set(at.x || 0, at.y || 0, at.z || 0); r.root.rotation.set(0, rad(at.ry || 0), 0);
    applyPose(r, p.j, p.m, true);
    r.root.updateMatrixWorld(true);
    const pt = (b, q = [0, 0, 0]) => r.bones[b].localToWorld(new THREE.Vector3(...q)).applyEuler(rot);
    const P = {};
    for (const n of Object.keys(JOINTS)) P[n] = pt(n);
    Object.assign(P, { ltip: pt('lhand', [0, -0.17, 0]), rtip: pt('rhand', [0, -0.17, 0]), ltoe: pt('lfoot', [0, -0.03, 0.18]),
      rtoe: pt('rfoot', [0, -0.03, 0.18]), skull: pt('head', [0, 0.12, 0]) });
    return P;
  });
  const floor = new THREE.Vector3(0, 0, 0).applyEuler(rot).y;
  const pts = all.flatMap((P) => Object.values(P));
  const xs = pts.map((v) => v.x), ys = [...pts.map((v) => v.y), floor];
  const W = canvas.width, H = canvas.height, pad = W * 0.1;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys) + 0.15, 0.6);
  const sc = (W - 2 * pad) / span, cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const X = (v) => W / 2 + (v.x - cx) * sc, Y = (v) => H / 2 - (v.y - cy) * sc;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff30'; ctx.lineWidth = W / 60;
  ctx.beginPath(); ctx.moveTo(pad / 2, Y({ y: floor })); ctx.lineTo(W - pad / 2, Y({ y: floor })); ctx.stroke();
  // every stick of every person, the far ones first; a partner is drawn paler
  const sticks = all.flatMap((P, i) => STICKS.map((s) => ({ P, s, i, z: s.reduce((a, n) => a + P[n].z, 0) / s.length })));
  const heads = all.map((P, i) => ({ P, s: null, i, z: P.skull.z }));
  for (const t of [...sticks, ...heads].sort((a, b) => a.z - b.z)) {
    ctx.globalAlpha = t.i ? 0.55 : 1;
    if (!t.s) { ctx.fillStyle = '#e8eaef'; ctx.beginPath(); ctx.arc(X(t.P.skull), Y(t.P.skull), 0.1 * sc, 0, Math.PI * 2); ctx.fill(); continue; }
    const n1 = t.s[1];
    ctx.strokeStyle = n1[0] === 'l' && n1 !== 'lhip' ? '#4cc3ff' : n1[0] === 'r' ? '#e9b44c' : '#e8eaef';
    ctx.lineWidth = W / (people.length > 1 ? 30 : 22);
    ctx.beginPath(); t.s.forEach((n, k) => (k ? ctx.lineTo(X(t.P[n]), Y(t.P[n])) : ctx.moveTo(X(t.P[n]), Y(t.P[n])))); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

// left and right swapped, mirrored across the figure's middle
export const opposite = (n) => (/^[lr](sho|elb|hand|hip|knee|foot)$/.test(n) ? (n[0] === 'l' ? 'r' : 'l') + n.slice(1) : null);
export const mirrorQ = ([x, y, z, w]) => [x, -y, -z, w];  // a mirror in X flips the Y and Z turns
export function mirrorPose(j = {}) {
  const out = {};
  for (const [n, q] of Object.entries(j)) out[opposite(n) || n] = mirrorQ(q);
  return out;
}

// words for a prompt: what a preset, pair or parameter looks like
const SAY = {
  stand: 'standing', relaxed: 'standing relaxed, weight on one leg', akimbo: 'standing with hands on hips', crossed: 'standing with arms crossed',
  think: 'standing with a hand on the chin, thinking', phone: 'talking on the phone', point: 'pointing ahead', wave: 'waving',
  reach: 'with both arms raised', tpose: 'with arms stretched out to the sides', shrug: 'shrugging', salute: 'saluting', handsUp: 'with hands up',
  behind: 'with hands behind the back', together: 'with hands pressed together', bow: 'bowing', thumb: 'giving a thumbs up',
  bendOver: 'bending over', leanOver: 'leaning over a table on both hands', toes: 'bending down to touch the toes', pickUp: 'bending down to pick something up',
  leanBack: 'leaning back, hands on the lower back', wallLean: 'leaning against a wall', shoulder: 'looking back over the shoulder',
  tieShoe: 'kneeling to tie a shoe', reachHigh: 'reaching up high on tiptoe',
  walk: 'walking', run: 'running', jump: 'jumping', kick: 'kicking', punch: 'throwing a punch', guard: 'in a fighting stance', throw: 'throwing',
  climb: 'climbing', carry: 'carrying something in both arms', push: 'pushing', pull: 'pulling',
  sit: 'sitting on a chair', crossLegs: 'sitting cross-legged on the floor', longSit: 'sitting on the floor with legs stretched out',
  hugKnees: 'sitting hugging the knees', kneelOne: 'kneeling on one knee', kneel: 'kneeling', seiza: 'kneeling sitting back on the heels',
  squat: 'squatting', crouch: 'crouching', allFours: 'on all fours', plank: 'holding a plank', forearm: 'in a forearm plank', pushDown: 'doing a push-up',
  lieBack: 'lying on the back', lieFront: 'lying face down', lieSide: 'lying on the side',
  lunge: 'in a lunge', star: 'in a star jump', stretch: 'stretching to the side', tree: 'in tree pose', warrior: 'in warrior pose', downDog: 'in downward dog',
};
// two people: {a} is the figure posed, {b} its partner
const SAY_PAIR = {
  hug: '{a} and {b} are hugging', kiss: '{a} and {b} are kissing', hands: '{a} and {b} are holding hands', shake: '{a} and {b} are shaking hands',
  dance: '{a} and {b} are slow dancing', carry: '{a} is carrying {b} in their arms', piggy: '{a} is giving {b} a piggyback ride',
  lap: '{b} is sitting on {a}\'s lap', straddle: '{b} is straddling {a}, who sits on a chair', kneelFacing: '{a} and {b} are kneeling face to face',
  lieBacks: '{a} and {b} are lying side by side on their backs', lieFronts: '{a} and {b} are lying side by side on their stomachs',
  spoon: '{a} and {b} are lying on their sides, {b} behind {a}', onTop: '{b} is lying on top of {a}', grapple: '{a} and {b} are grappling',
  fight: '{a} throws a punch and {b} guards', helpUp: '{a} is helping {b} up from the floor',
};
const SAY_PARAM = { lean: ['leaning forward', 'leaning back'], side: ['leaning to the left', 'leaning to the right'], twist: ['twisting', 'twisting'],
  fold: ['bent at the hips', 'arching back'], sway: ['hips swayed', 'hips swayed'], turn: ['head turned left', 'head turned right'],
  tilt: ['head tilted', 'head tilted'], nod: ['looking down', 'looking up'], armsOut: ['arms out', 'arms in'], armsFwd: ['arms forward', 'arms back'],
  elbows: ['elbows bent', ''], legsApart: ['legs apart', 'legs together'], knees: ['knees bent', ''], step: ['one foot forward', 'one foot forward'],
  tiptoe: ['on tiptoe', ''], walk: ['walking', ''], run: ['running', ''], squatB: ['squatting', ''], sitB: ['sitting down', ''],
  kneelB: ['kneeling down', ''], crouchB: ['crouching', ''], bowB: ['bowing', ''] };
export const say = (key) => SAY[key] || '';
export const pairSay = (key, a, b) => (SAY_PAIR[key] || '').replaceAll('{a}', a).replaceAll('{b}', b);
// the parameters worth a word: big enough to see
export const sayParams = (m = {}) => Object.entries(m).filter(([k, v]) => SAY_PARAM[k] && Math.abs(v) >= 10)
  .map(([k, v]) => SAY_PARAM[k][v > 0 ? 0 : 1]).filter(Boolean);

// ---- moves: a few seconds of keys from the current pose. A step is [seconds, pose (null: the
// pose it started in), parameters to set on top, { y: lift (m), ry: turn (°), d: forward (m), ease }].
// loop: [seconds per round, ...steps] repeated to the end of the clip. travel: walk or run forward;
// spot: walk on the spot (the step phase keyed).
Object.assign(PRESETS, {
  wave2: { cat: null, label: '', j: { rsho: [0, 0, -150], relb: [0, 0, -65], lsho: [0, 0, 8], lelb: [-8, 0, 0] } },
  clapOut: { cat: null, label: '', j: { lsho: [-40, 0, 25], rsho: [-40, 0, -25] }, ik: { lhand: ['chest', [0.22, 0, 0.3]], rhand: ['chest', [-0.22, 0, 0.3]] } },
});
PRESETS.punchL = { cat: null, label: '', j: Object.fromEntries(Object.entries(PRESETS.punch.j).map(([n, [x, y, z]]) => [opposite(n) || n, [x, -y, -z]])) };
const MOVES = {
  walk: { label: 'Walk', icon: '🚶', travel: { m: { walk: 100 }, speed: 1.3, pn: 'walk' } },
  run: { label: 'Run', icon: '🏃', travel: { m: { run: 100 }, speed: 3.6, pn: 'run' } },
  spot: { label: 'Walk on the spot', icon: '👣', spot: { m: { walk: 100 }, rate: 0.9, pn: 'walk' } },
  jump: { label: 'Jump', icon: '⤒', steps: [[0.35, null, { squatB: 45 }], [0.6, 'jump', null, { y: 0.45 }], [0.75, 'jump', null, { y: 0.5 }],
    [1.0, null, { squatB: 40 }], [1.4, null]] },
  sitDown: { label: 'Sit down', icon: '🪑', steps: [[1.0, 'sit']] },
  standUp: { label: 'Stand up', icon: '⬆', steps: [[0.6, 'crouch'], [1.3, 'stand', {}]] },
  kneelDown: { label: 'Kneel down', icon: '🧎', steps: [[1.2, 'kneelOne']] },
  lieDown: { label: 'Lie down', icon: '🛌', steps: [[0.7, 'crouch'], [1.5, 'longSit'], [2.5, 'lieBack']] },
  getUp: { label: 'Get up', icon: '🌅', steps: [[1.0, 'longSit'], [2.0, 'crouch'], [2.8, 'stand', {}]] },
  bow: { label: 'Bow', icon: '🙇', steps: [[0.8, 'bow'], [1.5, 'bow'], [2.3, null]] },
  turn: { label: 'Turn around', icon: '↻', steps: [[1.2, null, null, { ry: 180 }]] },
  wave: { label: 'Wave', icon: '👋', steps: [[0.4, 'wave'], [0.7, 'wave2'], [1.0, 'wave'], [1.3, 'wave2'], [1.6, 'wave'], [2.2, null]] },
  nod: { label: 'Nod', icon: '↕', steps: [[0.25, null, { nod: 20 }], [0.5, null, { nod: -5 }], [0.75, null, { nod: 20 }], [1.1, null]] },
  shake: { label: 'Shake head', icon: '↔', steps: [[0.25, null, { turn: 30 }], [0.55, null, { turn: -30 }], [0.85, null, { turn: 30 }], [1.2, null]] },
  look: { label: 'Look around', icon: '👀', steps: [[0.8, null, { turn: 60 }], [1.4, null, { turn: 60 }], [2.4, null, { turn: -60 }], [3.0, null, { turn: -60 }], [3.6, null]] },
  squats: { label: 'Squats', icon: '🏋', loop: [1.6, [0.8, null, { squatB: 100 }], [1.6, null, { squatB: 0 }]] },
  pushups: { label: 'Push-ups', icon: '💪', steps: [[0.8, 'kneel'], [1.6, 'plank']], loop: [1.2, [0.6, 'pushDown'], [1.2, 'plank']] },
  jacks: { label: 'Jumping jacks', icon: '✳', loop: [0.7, [0.35, 'star', null, { y: 0.08 }], [0.7, 'stand']] },
  punches: { label: 'Punches', icon: '🥊', steps: [[0.3, 'guard']], loop: [1.0, [0.25, 'punch'], [0.5, 'guard'], [0.75, 'punchL'], [1.0, 'guard']] },
  clap: { label: 'Clap', icon: '👏', steps: [[0.3, 'clapOut']], loop: [0.5, [0.25, 'together'], [0.5, 'clapOut']] },
  breathe: { label: 'Breathe', icon: '🫁', loop: [3, [1.5, null, { lean: 3, armsOut: 3 }], [3, null, { lean: 0, armsOut: 0 }]] },
};
export const moveList = () => Object.entries(MOVES).map(([k, mv]) => [k, mv.label, mv.icon]);
export const moveKind = (key) => (MOVES[key].travel ? 'travel' : MOVES[key].spot ? 'spot' : 'steps');
// the steps of a move that fit in avail seconds: [{ t, j (null: as it started), m (set on top), pn, y, ry, d, ease }]
export function moveSteps(key, avail, inPlace = false) {
  const mv = MOVES[key], out = [];
  const step = (t, [, pose, m, x = {}]) => out.push({ t, j: pose ? preset(pose).j : null, pn: pose, m: m || null, ...x });
  if (mv.travel || mv.spot) {
    const c = mv.travel || mv.spot, ramp = Math.min(0.4, avail / 2);
    if (mv.travel && !inPlace) {  // speed up for the first moment, then a steady pace (linear) to the end
      out.push({ t: ramp, j: null, m: c.m, pn: c.pn, d: c.speed * ramp / 2, ease: 'linear' });
      out.push({ t: avail, j: null, m: c.m, pn: c.pn, d: c.speed * (avail - ramp / 2) });
    } else {
      const rate = mv.spot ? c.rate : c.speed / strideLength(c.m);
      out.push({ t: ramp, j: null, m: c.m, pn: c.pn, phase: rate * ramp / 2, ease: 'linear' });
      out.push({ t: avail, j: null, m: c.m, pn: c.pn, phase: rate * (avail - ramp / 2) });
    }
    return out;
  }
  let t0 = 0;
  for (const s of mv.steps || []) { if (s[0] > avail) return out; step(s[0], s); t0 = s[0]; }
  if (mv.loop) {
    const [len, ...ls] = mv.loop;
    for (let r = 0; t0 + len * (r + 1) <= avail + 1e-6; r++) for (const s of ls) step(t0 + len * r + s[0], s);
  }
  return out;
}

// ---- OpenPose (COCO 18) ---------------------------------------------------------------------
const KP = ['nose', 'neck', 'rsho', 'relb', 'rhand', 'lsho', 'lelb', 'lhand', 'rhip', 'rknee', 'rfoot', 'lhip', 'lknee', 'lfoot', 'reye', 'leye', 'rear', 'lear'];
// the limbs and colours of controlnet_aux's draw_bodypose (1-based keypoints, first 17 limbs)
const LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]];
const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 85], [255, 0, 0]];

// the 18 keypoints in world space (the neck is between the shoulders, like OpenPose's)
// a hidden part's points are null (drawPose skips them and their limbs): a point stays while any part
// that meets it is shown (the elbow, for one, ends the upper arm and starts the forearm)
const KP_PARTS = { nose: ['head'], reye: ['head'], leye: ['head'], rear: ['head'], lear: ['head'], neck: ['neck', 'chest'],
  lsho: ['lsho'], lelb: ['lsho', 'lelb'], lhand: ['lelb', 'lhand'], rsho: ['rsho'], relb: ['rsho', 'relb'], rhand: ['relb', 'rhand'],
  lhip: ['lhip', 'hips'], lknee: ['lhip', 'lknee'], lfoot: ['lknee', 'lfoot'], rhip: ['rhip', 'hips'], rknee: ['rhip', 'rknee'], rfoot: ['rknee', 'rfoot'] };
// and a limb goes when none of its parts is shown (the shin, with the thigh and foot still there): the
// result's .cut holds those limb indexes, for drawPose
const LIMB_PARTS = [['rsho'], ['lsho'], ['rsho'], ['relb'], ['lsho'], ['lelb'], ['chest', 'spine', 'hips'], ['rhip'], ['rknee'], ['chest', 'spine', 'hips'],
  ['lhip'], ['lknee'], ['neck', 'head'], ['head'], ['head'], ['head'], ['head']];
export function keypoints(rig, hide = []) {
  rig.root.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const p = {};
  for (const n of KP) p[n] = n === 'neck' ? null : at(rig.marks[n] || rig.bones[n]);
  p.neck = p.lsho.clone().add(p.rsho).multiplyScalar(0.5);
  const pts = KP.map((n) => (KP_PARTS[n].every((x) => hide.includes(x)) ? null : p[n]));
  pts.cut = new Set(LIMB_PARTS.flatMap((l, i) => (l.every((x) => hide.includes(x)) ? [i] : [])));
  return pts;
}

// draw figures' keypoints (already projected to pixels; null = behind the camera) like OpenPose
export function drawPose(ctx, people, W, H) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const s = Math.max(1, Math.min(W, H) / 512), stick = 4 * s;
  for (const pts of people) {
    LIMBS.forEach(([a, b], i) => {
      const p = pts[a - 1], q = pts[b - 1];
      if (!p || !q || pts.cut?.has(i)) return;
      const [r, g, bl] = COLORS[i];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      ctx.save();
      ctx.translate((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      ctx.rotate(Math.atan2(q[1] - p[1], q[0] - p[0]));
      ctx.fillStyle = `rgba(${r},${g},${bl},0.6)`;
      ctx.beginPath(); ctx.ellipse(0, 0, len / 2, stick, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    pts.forEach((p, i) => {
      if (!p) return;
      ctx.fillStyle = `rgb(${COLORS[i].join(',')})`;
      ctx.beginPath(); ctx.arc(p[0], p[1], 4 * s, 0, Math.PI * 2); ctx.fill();
    });
  }
}
