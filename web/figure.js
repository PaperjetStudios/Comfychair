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
    for (const geo of PARTS[name]) { const m = new THREE.Mesh(geo, material); b.add(m); meshes.push(m); }
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

// a pose is { joint: [x, y, z, w] } (local rotations; missing = rest)
const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
export function applyPose(rig, j = {}) {
  for (const [name, b] of Object.entries(rig.bones)) {
    if (j[name]) b.quaternion.fromArray(j[name]).normalize(); else b.quaternion.identity();
  }
}
export function slerpPose(a = {}, b = {}, t) {
  const out = {};
  for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
    Q.fromArray(a[n] || [0, 0, 0, 1]); Q2.fromArray(b[n] || [0, 0, 0, 1]);
    out[n] = Q.slerp(Q2, t).toArray();
  }
  return out;
}
export const readJoint = (rig, name) => rig.bones[name].quaternion.toArray();

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

// presets: joint rotations in degrees (XYZ); y is where the figure's base goes (sitting lowers it)
const PRESETS = {
  stand: { label: 'Stand', j: { lsho: [0, 0, 8], rsho: [0, 0, -8], lelb: [-8, 0, 0], relb: [-8, 0, 0] } },
  walk: { label: 'Walk', j: { lhip: [-22, 0, 0], lknee: [12, 0, 0], rhip: [18, 0, 0], rknee: [28, 0, 0], rfoot: [-10, 0, 0],
    lsho: [18, 0, 6], rsho: [-18, 0, -6], lelb: [-12, 0, 0], relb: [-28, 0, 0] } },
  run: { label: 'Run', j: { spine: [10, 0, 0], lhip: [-55, 0, 0], lknee: [70, 0, 0], rhip: [25, 0, 0], rknee: [95, 0, 0],
    lsho: [40, 0, 8], rsho: [-50, 0, -8], lelb: [-80, 0, 0], relb: [-90, 0, 0] } },
  sit: { label: 'Sit', y: -0.43, j: { lhip: [-90, 0, 0], rhip: [-90, 0, 0], lknee: [90, 0, 0], rknee: [90, 0, 0],
    lsho: [-15, 0, 6], rsho: [-15, 0, -6], lelb: [-45, 0, 0], relb: [-45, 0, 0] } },
  point: { label: 'Point', j: { rsho: [-85, 0, 0], lsho: [0, 0, 8], lelb: [-8, 0, 0], head: [0, -10, 0] } },
  wave: { label: 'Wave', j: { rsho: [0, 0, -150], relb: [0, 0, -30], lsho: [0, 0, 8], lelb: [-8, 0, 0] } },
  reach: { label: 'Arms up', j: { lsho: [0, 0, 170], rsho: [0, 0, -170] } },
  tpose: { label: 'T-pose', j: { lsho: [0, 0, 90], rsho: [0, 0, -90] } },
};
export const presetList = () => Object.entries(PRESETS).map(([k, p]) => [k, p.label]);
export function preset(key) {
  const p = PRESETS[key], e = new THREE.Euler(), r = THREE.MathUtils.degToRad, j = {};
  for (const [n, [x, y, z]] of Object.entries(p.j)) j[n] = Q.setFromEuler(e.set(r(x), r(y), r(z))).toArray();
  return { j, y: p.y ?? 0 };
}

// left and right swapped, mirrored across the figure's middle
export function mirrorPose(j = {}) {
  const swap = (n) => (/^l(sho|elb|hand|hip|knee|foot)$/.test(n) ? `r${n.slice(1)}` : /^r(sho|elb|hand|hip|knee|foot)$/.test(n) ? `l${n.slice(1)}` : n);
  const out = {};
  for (const [n, [x, y, z, w]] of Object.entries(j)) out[swap(n)] = [x, -y, -z, w];  // a mirror in X flips the Y and Z turns
  return out;
}

// ---- OpenPose (COCO 18) ---------------------------------------------------------------------
const KP = ['nose', 'neck', 'rsho', 'relb', 'rhand', 'lsho', 'lelb', 'lhand', 'rhip', 'rknee', 'rfoot', 'lhip', 'lknee', 'lfoot', 'reye', 'leye', 'rear', 'lear'];
// the limbs and colours of controlnet_aux's draw_bodypose (1-based keypoints, first 17 limbs)
const LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]];
const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 85], [255, 0, 0]];

// the 18 keypoints in world space (the neck is between the shoulders, like OpenPose's)
export function keypoints(rig) {
  rig.root.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const p = {};
  for (const n of KP) p[n] = n === 'neck' ? null : at(rig.marks[n] || rig.bones[n]);
  p.neck = p.lsho.clone().add(p.rsho).multiplyScalar(0.5);
  return KP.map((n) => p[n]);
}

// draw figures' keypoints (already projected to pixels; null = behind the camera) like OpenPose
export function drawPose(ctx, people, W, H) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const s = Math.max(1, Math.min(W, H) / 512), stick = 4 * s;
  for (const pts of people) {
    LIMBS.forEach(([a, b], i) => {
      const p = pts[a - 1], q = pts[b - 1];
      if (!p || !q) return;
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
