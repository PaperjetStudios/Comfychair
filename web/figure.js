// A low-poly posable person for the 3D tab: faceted parts on a joint hierarchy (no skinning, each part
// just rides on its joint), a man or a woman, fingers and a face, two-bone IK for the arms and legs, pose
// and hand presets, and the OpenPose keypoints of a pose (body, hands, face) for a pose control video.
// Built facing +Z, its left on +X, 1.75 m tall at scale 1 (the man; the woman is a little smaller).
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

// ---- the hands: three joints per finger (knuckle, middle, end) under each hand. Built like the body,
// facing +Z with the arm hanging: the palm faces back (-Z), so a finger curls by turning +X; the thumb
// sits on the body side and its first joint has a turned rest frame (the 4th entry, degrees), so it too
// curls by +X. The right hand is the left one mirrored. Not in JOINTS (the motion import and the joint
// dots are the body's), but posed, keyed (j.lindex1...) and mirrored like any joint.
export const FINGERS = [['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['pinky', 'Pinky']];
// knuckle (left hand, metres from the wrist), the three bone lengths, radius
const FINGER_AT = {
  thumb: [[-0.024, -0.026, -0.012], [0.042, 0.032, 0.026], 0.0105, [-10, -50, -30]],
  index: [[-0.026, -0.094, 0], [0.042, 0.025, 0.021], 0.0085],
  middle: [[-0.008, -0.099, 0], [0.046, 0.028, 0.022], 0.0088],
  ring: [[0.01, -0.096, 0], [0.043, 0.026, 0.021], 0.0083],
  pinky: [[0.027, -0.088, 0], [0.034, 0.021, 0.019], 0.0074],
};
export const HAND = {};
for (const side of ['l', 'r']) {
  const sx = side === 'l' ? 1 : -1, S = side === 'l' ? 'Left' : 'Right';
  for (const [f, label] of FINGERS) {
    const [at, len, , rest] = FINGER_AT[f];
    HAND[`${side}${f}1`] = [`${side}hand`, [at[0] * sx, at[1], at[2]], `${S} ${label.toLowerCase()} 1`, rest && [rest[0], rest[1] * sx, rest[2] * sx]];
    HAND[`${side}${f}2`] = [`${side}${f}1`, [0, -len[0], 0], `${S} ${label.toLowerCase()} 2`];
    HAND[`${side}${f}3`] = [`${side}${f}2`, [0, -len[1], 0], `${S} ${label.toLowerCase()} 3`];
  }
}
// every joint the rig has: the body's, then the fingers'
export const RIG_JOINTS = { ...JOINTS, ...HAND };
export const handJoints = (side) => Object.keys(HAND).filter((n) => n[0] === side);

// ---- bodies: a man (the original proportions: old scenes get him) and a woman, a little smaller with
// narrower shoulders and wider hips. k scales the whole of her; at moves joints (before k).
const BODY = {
  man: { k: 1, at: {} },
  woman: { k: 0.935, at: { lsho: [0.156, 0.145, 0], rsho: [-0.156, 0.145, 0], lhip: [0.097, -0.045, 0], rhip: [-0.097, -0.045, 0] } },
};
export const BODIES = [['man', 'Man'], ['woman', 'Woman']];
export const bodyOf = (b) => (BODY[b] ? b : 'man');
export const heightOf = (b) => HEIGHT * BODY[bodyOf(b)].k;
// a body's joint offsets
function offsets(body) {
  const B = BODY[bodyOf(body)], out = {};
  for (const [n, [, at]] of Object.entries(RIG_JOINTS)) out[n] = (B.at[n] || at).map((x) => x * B.k);
  return out;
}

// ---- the parts: smooth, low-poly volumes, each riding on its joint (no skinning: the balls at the
// shoulders, elbows, hips, knees and ankles hide the seams). The silhouette reads in a depth render:
// chest and pelvis shaped front and back, a face with a nose, brows, eyes, ears and a jaw that opens.
// a tube through rings along y, closed at both ends: rings [y, half width, depth in front (+z), depth
// behind, x offset, z offset]; p: 2 is an ellipse, more is boxier
function loft(rings, n = 10, p = 2) {
  const pos = [], idx = [];
  const e = (t) => Math.sign(t) * Math.abs(t) ** (2 / p);
  for (const [y, rx, zf, zb, cx = 0, cz = 0] of rings) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(cx + rx * e(c), y, cz + (s > 0 ? zf : zb) * e(s));
    }
  }
  const m = rings.length;
  for (let k = 0; k < m - 1; k++) {
    for (let i = 0; i < n; i++) {
      const a = k * n + i, b = (k + 1) * n + i, c = k * n + (i + 1) % n, d = (k + 1) * n + (i + 1) % n;
      idx.push(a, b, c, c, b, d);
    }
  }
  const cap = (k, up) => {
    const [y, , , , cx = 0, cz = 0] = rings[k], o = pos.length / 3;
    pos.push(cx, y, cz);
    for (let i = 0; i < n; i++) { const a = k * n + i, b = k * n + (i + 1) % n; idx.push(...(up ? [o, b, a] : [o, a, b])); }
  };
  cap(0, false); cap(m - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
const blob = (rx, ry, rz, [x, y, z] = [0, 0, 0], w = 10, hh = 7) => new THREE.SphereGeometry(1, w, hh).scale(rx, ry, rz).translate(x, y, z);
const ball = (r, at) => blob(r, r, r, at, 10, 8);
// one geometry from several (position and normal only)
function merge(list) {
  const pos = [], nor = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.computeVertexNormals();
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  return g;
}
// x mirrored (a right-hand part from a left one); the faces turn back the right way out
function mirrorX(g0) {
  const g = (g0.index ? g0.toNonIndexed() : g0.clone()).scale(-1, 1, 1), a = g.attributes.position.array;
  for (let i = 0; i < a.length; i += 9) for (let c = 0; c < 3; c++) { const t = a[i + 3 + c]; a[i + 3 + c] = a[i + 6 + c]; a[i + 6 + c] = t; }
  g.computeVertexNormals();
  return g;
}

// the head (its joint is the top of the neck), lofted through rings: [y, half width, front z, back z],
// chin to crown, the man's (head space, metres). The face is pressed into it (eye sockets, cheekbones,
// lips); the nose, ears, eyes, lids and brows are pieces of their own. The part under the mouth is cut
// off as the jaw, which turns on its own joint.
const HEAD_RINGS = [[0, 0.022, 0.07, 0.04], [0.012, 0.034, 0.082, 0.0], [0.03, 0.047, 0.085, -0.035], [0.045, 0.058, 0.083, -0.05],
  [0.06, 0.066, 0.089, -0.065], [0.075, 0.07, 0.089, -0.085], [0.09, 0.072, 0.086, -0.098], [0.105, 0.074, 0.086, -0.104],
  [0.125, 0.076, 0.085, -0.108], [0.145, 0.076, 0.092, -0.11], [0.165, 0.075, 0.09, -0.11], [0.185, 0.071, 0.082, -0.105],
  [0.205, 0.06, 0.066, -0.09], [0.218, 0.042, 0.042, -0.065], [0.226, 0.015, 0.012, -0.025]];
const HEAD_P = 2.2, MOUTH_Y = 0.061;
// a body's rings (the woman's head is narrower, her jaw more so)
const headRings = (W) => HEAD_RINGS.map(([y, rx, f, b]) => (W ? [y, rx * (y < 0.07 ? 0.88 : 0.95), f * 0.98, b * 0.97] : [y, rx, f, b]));
// the face pressed in: + out, - in (metres), at a point of the front
function facePress(x, y) {
  const g = (cx, cy, sx, sy) => Math.exp(-(((Math.abs(x) - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);
  return -0.009 * g(0.032, 0.125, 0.016, 0.012)      // eye sockets
    + 0.005 * g(0.048, 0.098, 0.016, 0.014)          // cheekbones
    + 0.004 * g(0, 0.067, 0.02, 0.004) + 0.004 * g(0, 0.053, 0.018, 0.004)   // the lips
    - 0.004 * g(0, 0.036, 0.03, 0.008);              // under the lower lip
}
// the front of the head at (x, y): its z, pressed in or not
function frontZ(R, x, y, press = true) {
  let i = 0;
  while (i < R.length - 2 && R[i + 1][0] < y) i++;
  const [y0, r0, f0, b0] = R[i], [y1, r1, f1, b1] = R[i + 1], t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
  const rx = r0 + (r1 - r0) * t, f = f0 + (f1 - f0) * t, b = b0 + (b1 - b0) * t, cz = (f + b) / 2, d = (f - b) / 2;
  const z = cz + d * Math.max(0, 1 - Math.min(1, Math.abs(x) / rx) ** HEAD_P) ** (1 / HEAD_P);
  return press ? z + facePress(x, y) : z;
}
const headWidth = (R, y) => { let i = 0; while (i < R.length - 2 && R[i + 1][0] < y) i++; const t = (y - R[i][0]) / (R[i + 1][0] - R[i][0]); return R[i][1] + (R[i + 1][1] - R[i][1]) * t; };
// the skull and the jaw (head space)
function headShape(W) {
  const R = headRings(W), g = loft(R.map(([y, rx, f, b]) => [y, rx, (f - b) / 2, (f - b) / 2, 0, (f + b) / 2]), 20, HEAD_P).toNonIndexed();
  const a = g.attributes.position.array;
  for (let i = 0; i < a.length; i += 3) {
    const [x, y, z] = [a[i], a[i + 1], a[i + 2]], z0 = frontZ(R, x, y, false);
    if (z > 0 && z > z0 - 0.03) a[i + 2] += facePress(x, y) * Math.min(1, Math.max(0, 1 - (z0 - z) / 0.03));
  }
  // a triangle under the mouth and in front of the ears is the jaw's
  const skull = [], jaw = [];
  for (let i = 0; i < a.length; i += 9) {
    const cy = (a[i + 1] + a[i + 4] + a[i + 7]) / 3, cz = (a[i + 2] + a[i + 5] + a[i + 8]) / 3;
    (cy < MOUTH_Y && cz > -0.025 ? jaw : skull).push(...a.slice(i, i + 9));
  }
  const geo = (p) => { const x = new THREE.BufferGeometry(); x.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); return x; };
  return { skull: geo(skull), jaw: geo(jaw), R };
}
function headParts(W, { skull, R }) {
  const s = W ? 0.92 : 1;
  const nose = new THREE.BufferGeometry();   // a wedge: bridge, tip, the nostrils either side
  const P = [[0, 0.134, frontZ(R, 0, 0.134) - 0.003], [0, 0.09, W ? 0.108 : 0.113], [-0.016 * s, 0.083, 0.09], [0.016 * s, 0.083, 0.09], [0, 0.08, 0.095],
    [-0.011 * s, 0.118, 0.08], [0.011 * s, 0.118, 0.08]];
  const T = [[0, 5, 1], [0, 1, 6], [5, 2, 1], [6, 1, 3], [1, 2, 4], [1, 4, 3]];
  nose.setAttribute('position', new THREE.Float32BufferAttribute(T.flatMap((t) => t.flatMap((i) => P[i])), 3));
  const ear = (sx) => blob(0.011, 0.03, 0.019, [sx * headWidth(R, 0.112) * 0.98, 0.112, -0.012], 7, 6);
  return [skull, nose, ear(1), ear(-1), blob(0.036, 0.03, 0.036, [0, 0.056, 0.045], 8, 6)];   // (and the inside of the mouth)
}

// a finger's three bones, each a tapered tube with a ball at its root (the last one rounded off)
function fingerParts(f) {
  const [, len, r, rest] = FINGER_AT[f];
  const seg = (l, r1, r2, tip) => merge([new THREE.CylinderGeometry(r2, r1, l, 6).translate(0, -l / 2, 0), ball(r1 * 1.02, [0, 0, 0]),
    ...(tip ? [blob(r2, r2 * 1.2, r2, [0, -l, 0], 6, 4)] : [])]);
  const k = rest ? 1.15 : 1;
  return [seg(len[0], r * 1.08 * k, r * 0.95 * k), seg(len[1], r * 0.95 * k, r * 0.88 * k), seg(len[2], r * 0.86 * k, r * 0.74 * k, true)];
}

function parts(body) {
  const W = body === 'woman', k = BODY[body].k;
  const w = (m, f) => (W ? f : m), hd = headShape(W);
  const g = {
    hips: merge([loft(W
      ? [[-0.14, 0.05, 0.05, 0.055], [-0.115, 0.14, 0.085, 0.11], [-0.07, 0.172, 0.095, 0.13], [-0.02, 0.172, 0.095, 0.12], [0.03, 0.155, 0.09, 0.1], [0.08, 0.13, 0.085, 0.085]]
      : [[-0.135, 0.05, 0.05, 0.05], [-0.11, 0.13, 0.08, 0.1], [-0.06, 0.155, 0.09, 0.112], [-0.01, 0.158, 0.09, 0.105], [0.04, 0.15, 0.09, 0.092], [0.09, 0.142, 0.09, 0.087]], 14),
    ...(W ? [blob(0.072, 0.07, 0.055, [0.06, -0.065, -0.07]), blob(0.072, 0.07, 0.055, [-0.06, -0.065, -0.07])]
      : [blob(0.065, 0.065, 0.045, [0.058, -0.06, -0.065]), blob(0.065, 0.065, 0.045, [-0.058, -0.06, -0.065])])]),   // the seat
    spine: loft(W
      ? [[-0.03, 0.13, 0.085, 0.085], [0.05, 0.112, 0.08, 0.078], [0.13, 0.112, 0.083, 0.078], [0.21, 0.122, 0.088, 0.082]]
      : [[-0.03, 0.142, 0.09, 0.087], [0.06, 0.132, 0.092, 0.082], [0.14, 0.135, 0.097, 0.086], [0.21, 0.14, 0.1, 0.088]], 14),
    chest: merge([loft(W
      ? [[-0.03, 0.122, 0.088, 0.082], [0.03, 0.13, 0.092, 0.085], [0.09, 0.142, 0.095, 0.09], [0.14, 0.152, 0.09, 0.09], [0.18, 0.152, 0.08, 0.085],
        [0.21, 0.122, 0.066, 0.07], [0.235, 0.07, 0.048, 0.05]]
      : [[-0.03, 0.142, 0.1, 0.088], [0.03, 0.152, 0.11, 0.092], [0.09, 0.164, 0.12, 0.097], [0.14, 0.172, 0.115, 0.1], [0.18, 0.172, 0.1, 0.095],
        [0.21, 0.142, 0.08, 0.08], [0.237, 0.08, 0.058, 0.058]], 14),
    ...(W ? [blob(0.062, 0.056, 0.042, [0.054, 0.068, 0.066], 10, 8), blob(0.062, 0.056, 0.042, [-0.054, 0.068, 0.066], 10, 8)] : [])]),   // the bust
    neck: loft(W ? [[-0.04, 0.043, 0.04, 0.045, 0, -0.005], [0.05, 0.038, 0.036, 0.038, 0, 0], [0.11, 0.04, 0.038, 0.04, 0, 0.005]]
      : [[-0.04, 0.056, 0.05, 0.055, 0, -0.005], [0.05, 0.05, 0.045, 0.048, 0, 0], [0.11, 0.05, 0.045, 0.048, 0, 0.005]], 8),
    head: merge(headParts(W, hd)),
    jaw: merge([hd.jaw]),
    eye: blob(0.0115, 0.0115, 0.0115, [0, 0, 0], 8, 6),
    lid: new THREE.SphereGeometry(0.013, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.42),   // the upper lid: a cap over the eye, turned down to blink
    brow: loft([[-0.018, 0.0035, 0.004, 0.004], [0, 0.005, 0.005, 0.005], [0.018, 0.003, 0.003, 0.003]], 6).rotateZ(-Math.PI / 2),
    sho: merge([blob(w(0.06, 0.05), w(0.064, 0.055), w(0.06, 0.05), [0.008, -0.022, 0]), loft(W
      ? [[-0.28, 0.031, 0.031, 0.031], [-0.22, 0.034, 0.035, 0.034], [-0.12, 0.039, 0.041, 0.039], [-0.04, 0.043, 0.043, 0.043]]
      : [[-0.28, 0.036, 0.037, 0.037], [-0.22, 0.04, 0.042, 0.04], [-0.12, 0.046, 0.05, 0.046], [-0.04, 0.05, 0.05, 0.05]], 8)]),
    elb: merge([ball(w(0.038, 0.032), [0, 0, 0]), loft(W
      ? [[-0.26, 0.023, 0.016, 0.016], [-0.2, 0.026, 0.02, 0.02], [-0.08, 0.035, 0.032, 0.03], [-0.02, 0.033, 0.031, 0.031]]
      : [[-0.26, 0.026, 0.018, 0.018], [-0.2, 0.03, 0.024, 0.024], [-0.08, 0.042, 0.038, 0.036], [-0.02, 0.039, 0.037, 0.037]], 8)]),
    // the palm (the back of the hand is +z), thicker at the thumb's root
    hand: merge([loft([[-0.1, 0.042, 0.011, 0.012], [-0.062, 0.044, 0.015, 0.014], [-0.02, 0.035, 0.014, 0.013], [0.004, 0.025, 0.012, 0.012]], 10, 3),
      blob(0.02, 0.03, 0.014, [-0.02, -0.035, -0.008], 7, 5)]),
    hip: merge([ball(w(0.066, 0.07), [0, 0, 0]), loft(W
      ? [[-0.43, 0.047, 0.047, 0.047], [-0.36, 0.053, 0.055, 0.053], [-0.2, 0.068, 0.072, 0.07], [-0.07, 0.08, 0.082, 0.085], [-0.02, 0.07, 0.068, 0.07]]
      : [[-0.43, 0.05, 0.05, 0.05], [-0.36, 0.056, 0.058, 0.056], [-0.2, 0.07, 0.075, 0.07], [-0.07, 0.078, 0.08, 0.08], [-0.02, 0.068, 0.066, 0.068]], 9)]),
    knee: merge([ball(w(0.05, 0.047), [0, 0, 0]), loft(W
      ? [[-0.43, 0.03, 0.032, 0.032], [-0.38, 0.033, 0.035, 0.037], [-0.25, 0.042, 0.042, 0.054], [-0.12, 0.048, 0.046, 0.058], [-0.02, 0.046, 0.046, 0.046]]
      : [[-0.43, 0.032, 0.035, 0.035], [-0.38, 0.036, 0.038, 0.04], [-0.25, 0.045, 0.045, 0.058], [-0.12, 0.052, 0.05, 0.062], [-0.02, 0.05, 0.05, 0.05]], 9)]),
    // the foot, built along y and laid forward (rings: [along, half width, below, above, 0, -height]); its sole is 5 cm under the ankle
    foot: merge([ball(0.036, [0, 0, 0]), loft([[-0.07, 0.025, 0.025, 0.025, 0, 0.025], [-0.04, 0.033, 0.035, 0.045, 0, 0.015], [0.02, 0.038, 0.04, 0.045, 0, 0.01],
      [0.09, 0.045, 0.025, 0.03, 0, 0.025], [0.15, 0.045, 0.015, 0.02, 0, 0.035], [0.19, 0.03, 0.012, 0.012, 0, 0.038]], 10, 2.4).rotateX(Math.PI / 2)]),
  };
  const out = {
    hips: [g.hips], spine: [g.spine], chest: [g.chest], neck: [g.neck], head: [g.head],
    lsho: [g.sho], lelb: [g.elb], lhand: [g.hand], rsho: [mirrorX(g.sho)], relb: [mirrorX(g.elb)], rhand: [mirrorX(g.hand)],
    lhip: [g.hip], lknee: [g.knee], lfoot: [g.foot], rhip: [mirrorX(g.hip)], rknee: [mirrorX(g.knee)], rfoot: [mirrorX(g.foot)],
    face: { jaw: g.jaw, eye: g.eye, lid: g.lid, brow: g.brow, bits: faceBits(hd.R), pts: facePoints(hd.R) },
  };
  for (const [f] of FINGERS) {
    const fp = fingerParts(f).map((x) => x.scale(W ? 0.95 : 1, 1, W ? 0.95 : 1));
    fp.forEach((x, i) => { out[`l${f}${i + 1}`] = [x]; out[`r${f}${i + 1}`] = [mirrorX(x)]; });
  }
  if (k !== 1) for (const v of Object.values(out)) for (const x of Array.isArray(v) ? v : Object.values(v)) if (x.isBufferGeometry) x.scale(k, k, k);
  return out;
}
const PARTS = {};

// ---- the face: its moving bits and the 68 points OpenPose (DWPose) puts on a face, in head space on the
// head's front (frontZ). Each point rides on a bit: h head, j jaw, lb/rb a brow, ll/rl a lid, lc/rc a
// mouth corner. Built for the figure's left (+x) and mirrored; in iBUG order (0 is the right ear's end
// of the jaw line, 8 the chin).
function faceBits(R) {
  const eyeZ = frontZ(R, 0.032, 0.125) - 0.004;
  return { jaw: [0, 0.09, 0.004], leye: [0.032, 0.125, eyeZ], reye: [-0.032, 0.125, eyeZ], lbrow: [0.035, 0.146, frontZ(R, 0.035, 0.146) + 0.001],
    rbrow: [-0.035, 0.146, frontZ(R, 0.035, 0.146) + 0.001], lmouth: [0.023, MOUTH_Y, frontZ(R, 0.023, MOUTH_Y)], rmouth: [-0.023, MOUTH_Y, frontZ(R, 0.023, MOUTH_Y)] };
}
function facePoints(R) {
  const P = [], on = (b, x, y, dz = 0) => [b, x, y, frontZ(R, x, y) + dz];
  const side = (i, j, b, x, y, dz) => { P[i] = on(b === 'l' || b === 'c' || b === 'b' ? `r${b}` : b, -x, y, dz); P[j] = on(b === 'l' || b === 'c' || b === 'b' ? `l${b}` : b, x, y, dz); };
  // the jaw line, from the ear down to the chin: [y, how far out (of the head's half width)]
  [[0.125, 0.985], [0.105, 0.98], [0.085, 0.97], [0.068, 0.94], [0.052, 0.86], [0.038, 0.72], [0.026, 0.54], [0.016, 0.3]]
    .forEach(([y, f], i) => side(i, 16 - i, y < MOUTH_Y ? 'j' : 'h', headWidth(R, y) * f, y, 0));
  P[8] = on('j', 0, 0.008);
  [[0.062, 0.143], [0.05, 0.149], [0.037, 0.151], [0.024, 0.15], [0.011, 0.146]].forEach(([x, y], i) => side(17 + i, 26 - i, 'b', x, y, 0.004));   // brows, outer to inner
  [[0.128, 0.004], [0.115, 0.011], [0.103, 0.018], [0.09, 0.026]].forEach(([y, dz], i) => { P[27 + i] = on('h', 0, y, dz); });   // down the nose
  [[-0.015, 0.084], [-0.008, 0.081], [0, 0.08], [0.008, 0.081], [0.015, 0.084]].forEach(([x, y], i) => { P[31 + i] = on('h', x, y, 0.006); });   // under it
  // the eyes: outer corner, two on the upper lid, inner corner, two on the lower lid (the right eye from its outer corner, the left from its inner)
  const eye = [[0.047, 0.125, 'h'], [0.038, 0.131, 'l'], [0.026, 0.131, 'l'], [0.017, 0.124, 'h'], [0.026, 0.12, 'h'], [0.038, 0.12, 'h']];
  eye.forEach(([x, y, b], i) => { P[36 + i] = on(b === 'l' ? 'rl' : 'h', -x, y, 0.004); });
  [3, 2, 1, 0, 5, 4].forEach((e, i) => { const [x, y, b] = eye[e]; P[42 + i] = on(b === 'l' ? 'll' : 'h', x, y, 0.004); });
  // the mouth: the corners and the lips' outer edge, then their inner edge (the corners and the lips' ends move with the corners)
  P[48] = on('rc', -0.023, MOUTH_Y); P[54] = on('lc', 0.023, MOUTH_Y);
  [[-0.015, 0.066, 'rc'], [-0.007, 0.068, 'h'], [0, 0.067, 'h'], [0.007, 0.068, 'h'], [0.015, 0.066, 'lc']].forEach(([x, y, b], i) => { P[49 + i] = on(b, x, y, 0.002); });
  [[0.015, 0.055, 'lc'], [0.007, 0.051, 'j'], [0, 0.05, 'j'], [-0.007, 0.051, 'j'], [-0.015, 0.055, 'rc']].forEach(([x, y, b], i) => { P[55 + i] = on(b, x, y, 0.002); });
  P[60] = on('rc', -0.019, MOUTH_Y); P[64] = on('lc', 0.019, MOUTH_Y);
  [[-0.007, 0.063], [0, 0.063], [0.007, 0.063]].forEach(([x, y], i) => { P[61 + i] = on('h', x, y); });
  [[0.007, 0.059], [0, 0.059], [-0.007, 0.059]].forEach(([x, y], i) => { P[65 + i] = on('j', x, y); });
  return P;
}
const FACE_ON = { h: 'head', j: 'jaw', lb: 'lbrow', rb: 'rbrow', ll: 'llid', rl: 'rlid', lc: 'lmouth', rc: 'rmouth' };

// root (a Group to place and scale), its joints by name, the part meshes, and a dot per body joint
// (layer 1, drawn on top, for picking a joint). body: 'man' (also anything unknown) or 'woman'.
export function buildFigure(material, dotMaterial, body = 'man') {
  body = bodyOf(body);
  const P = (PARTS[body] ||= parts(body)), at = offsets(body), k = BODY[body].k;
  const root = new THREE.Group(), bones = {}, meshes = [], dots = [];
  const dotGeo = new THREE.SphereGeometry(0.035, 10, 8);
  const mesh = (geo, part, on) => { const m = new THREE.Mesh(geo, material); m.userData.part = part; on.add(m); meshes.push(m); return m; };
  for (const [name, [parent, , , rest]] of Object.entries(RIG_JOINTS)) {
    const b = new THREE.Object3D();
    b.name = name;
    let on = parent ? bones[parent] : root;
    if (rest) {  // a fixed turn the joint sits in (the thumb's)
      const r = new THREE.Object3D();
      r.position.fromArray(at[name]); r.quaternion.setFromEuler(new THREE.Euler(...rest.map((d) => d * Math.PI / 180)));
      on.add(r); on = r;
    } else b.position.fromArray(at[name]);
    on.add(b);
    bones[name] = b;
    const part = HAND[name] ? `${name[0]}hand` : name;   // (fingers hide with their hand)
    for (const geo of P[name]) mesh(geo, part, b);
    if (HAND[name]) continue;
    const d = new THREE.Mesh(dotGeo, dotMaterial);
    d.userData.joint = name; d.renderOrder = 10; d.layers.set(1);
    b.add(d); dots.push(d);
  }
  {
    // the face's moving bits, on the head (applyFace sets them from the parameters)
    const face = {}, F = P.face;
    for (const [n, p] of Object.entries(F.bits)) {
      const o = new THREE.Object3D(); o.position.set(p[0] * k, p[1] * k, p[2] * k); o.userData.rest = o.position.clone();
      bones.head.add(o); face[n] = o;
    }
    mesh(F.jaw, 'head', face.jaw).position.set(...F.bits.jaw.map((x) => -x * k));   // (its geometry is in head space)
    for (const s of ['l', 'r']) {
      mesh(F.eye, 'head', face[`${s}eye`]);
      const lid = new THREE.Object3D(); face[`${s}eye`].parent.add(lid); lid.position.copy(face[`${s}eye`].position); face[`${s}lid`] = lid;
      mesh(F.lid, 'head', lid);
      mesh(F.brow, 'head', face[`${s}brow`]).rotation.y = s === 'l' ? 0.35 : -0.35;   // (following the brow round)
    }
    // where OpenPose puts the face points: COCO's five, and the 68 of a full face
    const marks = {};
    for (const [n, p] of Object.entries({ nose: [0, 0.088, 0.115], reye: [-0.032, 0.124, 0.084], leye: [0.032, 0.124, 0.084],
      rear: [-0.08, 0.112, -0.005], lear: [0.08, 0.112, -0.005] })) {
      marks[n] = new THREE.Object3D(); marks[n].position.set(p[0] * k, p[1] * k, p[2] * k); bones.head.add(marks[n]);
    }
    const on = (key) => (key === 'h' ? bones.head : face[FACE_ON[key]]);
    marks.face = F.pts.map(([b, x, y, z]) => {
      const o = new THREE.Object3D(), host = on(b);
      o.position.set(x * k, y * k, z * k);
      if (host !== bones.head) o.position.sub(host.position);   // (the bits hang off the head at their rest place)
      host.add(o);
      return o;
    });
    // a fingertip per finger, for the hands' 21 points and Hand mode
    for (const side of ['l', 'r']) {
      for (const [f] of FINGERS) {
        const t = new THREE.Object3D(); t.position.set(0, -FINGER_AT[f][1][2] * k, 0);
        bones[`${side}${f}3`].add(t); marks[`${side}${f}tip`] = t;
      }
    }
    return { root, bones, meshes, dots, marks, face, body, at };
  }
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
  curlHands(rig, m);
  applyFace(rig, m);
  rig.bones.hips.position.y = rig.at.hips[1];
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
const SPARE = {};
const spare = (body = 'man') => (SPARE[bodyOf(body)] ||= buildFigure(new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), body));
// how far a pose has to move up to stand on the floor (sitting is negative), at scale 1
export function liftFor(j, m, body = 'man') { const r = spare(body); applyPose(r, j, m); return -lowest(r); }

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
  // the hands (their own tab): curl closes the hand's pose toward a fist (curlHands)
  curlL: { label: 'Left hand curl', group: 'Hands', tab: 'hands', min: 0, max: 100, unit: '%', rot: () => ({}) },
  curlR: { label: 'Right hand curl', group: 'Hands', tab: 'hands', min: 0, max: 100, unit: '%', rot: () => ({}) },
  // the face (its own tab; applyFace): the eyes look to the figure's left (+) and up (+); a smile below 0
  // frowns, brows below 0 knit
  jaw: { label: 'Mouth open', group: 'Face', tab: 'face', min: 0, max: 100, unit: '%', rot: () => ({}) },
  smile: { label: 'Smile', group: 'Face', tab: 'face', min: -100, max: 100, unit: '%', rot: () => ({}) },
  brows: { label: 'Brows', group: 'Face', tab: 'face', min: -100, max: 100, unit: '%', rot: () => ({}) },
  lookX: { label: 'Eyes right / left', group: 'Face', tab: 'face', min: -100, max: 100, unit: '%', rot: () => ({}) },
  lookY: { label: 'Eyes down / up', group: 'Face', tab: 'face', min: -100, max: 100, unit: '%', rot: () => ({}) },
  blink: { label: 'Eyes closed', group: 'Face', tab: 'face', min: 0, max: 100, unit: '%', rot: () => ({}) },
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
// mirrored parameters: the ones with a side change sign, a hand's go to the other hand
const SIDED = new Set(['side', 'twist', 'sway', 'turn', 'tilt', 'step', 'lookX']), SWAP = { curlL: 'curlR', curlR: 'curlL' };
export const mirrorParams = (m = {}) => Object.fromEntries(Object.entries(m).map(([k, v]) => [SWAP[k] || k, SIDED.has(k) ? -v : k === 'phase' ? v + 0.5 : v]));

// ---- hand poses: turns in degrees (XYZ) per finger, knuckle to tip, for the left hand (the right is it
// mirrored). +X curls toward the palm, Z spreads (- toward the thumb). A finger a pose leaves out is straight.
const HANDS = {
  relaxed: { label: 'Relaxed', icon: '🫳', f: { thumb: [[8, 0, 0], [12, 0, 0], [10, 0, 0]], index: [[14, 0, -2], [20, 0, 0], [10, 0, 0]],
    middle: [[20, 0, 0], [26, 0, 0], [12, 0, 0]], ring: [[26, 0, 2], [30, 0, 0], [14, 0, 0]], pinky: [[32, 0, 5], [32, 0, 0], [16, 0, 0]] } },
  open: { label: 'Open', icon: '🖐', f: { thumb: [[-4, 0, 6], [0, 0, 0], [0, 0, 0]], index: [[0, 0, -9], [0, 0, 0], [0, 0, 0]], middle: [[0, 0, -2], [0, 0, 0], [0, 0, 0]],
    ring: [[0, 0, 6], [0, 0, 0], [0, 0, 0]], pinky: [[0, 0, 15], [0, 0, 0], [0, 0, 0]] } },
  fist: { label: 'Fist', icon: '✊', f: { thumb: [[45, 0, 15], [35, 0, 0], [40, 0, 0]], index: [[88, 0, 0], [100, 0, 0], [60, 0, 0]],
    middle: [[90, 0, 0], [100, 0, 0], [60, 0, 0]], ring: [[90, 0, 2], [100, 0, 0], [60, 0, 0]], pinky: [[90, 0, 4], [95, 0, 0], [60, 0, 0]] } },
  grip: { label: 'Grip', icon: '🥤', f: { thumb: [[30, 0, 10], [20, 0, 0], [20, 0, 0]], index: [[50, 0, 0], [55, 0, 0], [30, 0, 0]],
    middle: [[55, 0, 0], [58, 0, 0], [30, 0, 0]], ring: [[58, 0, 2], [58, 0, 0], [30, 0, 0]], pinky: [[60, 0, 4], [55, 0, 0], [30, 0, 0]] } },
  point: { label: 'Point', icon: '👉', f: { thumb: [[40, 0, 12], [30, 0, 0], [25, 0, 0]], index: [[0, 0, 0], [3, 0, 0], [2, 0, 0]],
    middle: [[88, 0, 0], [100, 0, 0], [60, 0, 0]], ring: [[90, 0, 2], [100, 0, 0], [60, 0, 0]], pinky: [[90, 0, 4], [95, 0, 0], [60, 0, 0]] } },
  pinch: { label: 'Pinch', icon: '🤏', f: { thumb: [[24, 0, -6], [2, 0, 0], [4, 0, 0]], index: [[42, 0, -2], [48, 0, 0], [28, 0, 0]],
    middle: [[30, 0, 0], [34, 0, 0], [16, 0, 0]], ring: [[34, 0, 3], [36, 0, 0], [18, 0, 0]], pinky: [[38, 0, 6], [36, 0, 0], [18, 0, 0]] } },
};
export const handList = () => Object.entries(HANDS).map(([k, p]) => [k, p.label, p.icon]);
// a hand pose as the turns of that side's 15 finger joints ({ lindex1: [x, y, z, w], ... }); side 'l' or 'r'
export function handPose(key, side) {
  const out = {};
  for (const [f] of FINGERS) {
    (HANDS[key].f[f] || [[0, 0, 0], [0, 0, 0], [0, 0, 0]]).forEach(([x, y, z], i) => {
      const q = Q.setFromEuler(E.set(rad(x), rad(y), rad(z))).toArray();
      out[`${side}${f}${i + 1}`] = side === 'l' ? q : mirrorQ(q);
    });
  }
  return out;
}
// a pose's fingers only (a body preset keeps the hands as they are)
export const fingersOf = (j = {}) => Object.fromEntries(Object.entries(j).filter(([n]) => HAND[n]));
// curl: each hand's fingers turned from their pose toward a fist, 0 to 100%
let FIST;
function curlHands(rig, m = {}) {
  for (const [side, k] of [['l', 'curlL'], ['r', 'curlR']]) {
    const c = Math.min(1, Math.max(0, (m[k] || 0) / 100));
    if (!c) continue;
    FIST ||= { ...handPose('fist', 'l'), ...handPose('fist', 'r') };
    for (const n of handJoints(side)) rig.bones[n]?.quaternion.slerp(Q2.fromArray(FIST[n]), c);
  }
}
// one finger bent by c (0 straight to 1 a fist's), as a Hand mode drag sets it: its three joints' turns
export function fingerCurl(side, finger, c) {
  const out = {};
  HANDS.fist.f[finger].forEach(([x, y, z], i) => {
    const q = Q.setFromEuler(E.set(rad(x * c), rad(y * c), rad(z * c))).toArray();
    out[`${side}${finger}${i + 1}`] = side === 'l' ? q : mirrorQ(q);
  });
  return out;
}
// how bent a finger is in a pose (0 to 1, against the fist's turns): where a Hand mode drag starts
export function curlOf(j, side, finger) {
  let a = 0, b = 0;
  HANDS.fist.f[finger].forEach(([x], i) => {
    const q = j[`${side}${finger}${i + 1}`];
    b += Math.abs(x);
    if (q) a += THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q[3]))));
  });
  return Math.min(1, b ? a / b : 0);
}

// the face from its parameters: the jaw drops, the eyes turn and close, the brows lift or knit, the
// mouth's corners rise or fall (and come down with the jaw)
function applyFace(rig, m = {}) {
  const F = rig.face;
  if (!F) return;
  const k = BODY[rig.body].k, v = (n) => Math.max(-1, Math.min(1, (m[n] || 0) / 100));
  const jaw = Math.max(0, v('jaw')) * 24;
  F.jaw.rotation.set(rad(jaw), 0, 0);
  const lx = v('lookX'), ly = v('lookY'), bl = Math.max(0, v('blink')), br = v('brows'), sm = v('smile');
  for (const [s, sx] of [['l', 1], ['r', -1]]) {
    F[`${s}eye`].rotation.set(-rad(ly * 22), rad(lx * 30), 0);
    F[`${s}lid`].rotation.set(rad(56 * bl + 14 * Math.max(0, -ly) * (1 - bl) - 8 * Math.max(0, br) * (1 - bl)), 0, 0);
    const b = F[`${s}brow`];
    b.position.copy(b.userData.rest).add(V.set(0, (br > 0 ? 0.008 : 0.004) * br * k, br < 0 ? -0.002 * br * k : 0));
    b.rotation.set(0, 0, sx * rad(br < 0 ? -br * 16 : -br * 4));
    const c = F[`${s}mouth`];
    c.position.copy(c.userData.rest).add(V.set(sx * 0.004 * Math.max(0, sm) * k, (sm > 0 ? 0.006 : 0.005) * sm * k - Math.sin(rad(jaw)) * 0.045 * k,
      -0.004 * Math.abs(sm) * k));
  }
}

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
  point: { label: 'Point', cat: 'stand', hands: { r: 'point', l: 'relaxed' }, j: { rsho: [-85, 0, 0], lsho: [0, 0, 8], lelb: [-8, 0, 0], head: [0, -10, 0] } },
  wave: { label: 'Wave', cat: 'stand', hands: { r: 'open' }, j: { rsho: [0, 0, -150], relb: [0, 0, -30], lsho: [0, 0, 8], lelb: [-8, 0, 0] } },
  reach: { label: 'Arms up', cat: 'stand', hands: { l: 'open', r: 'open' }, j: { lsho: [0, 0, 170], rsho: [0, 0, -170] } },
  tpose: { label: 'T-pose', cat: 'stand', hands: { l: 'open', r: 'open' }, j: { lsho: [0, 0, 90], rsho: [0, 0, -90] } },
  shrug: { label: 'Shrug', cat: 'stand', j: { head: [0, 0, 10], lsho: [0, 0, 20], rsho: [0, 0, -20] },
    ik: { lhand: ['lsho', [0.28, -0.36, 0.22]], rhand: ['rsho', [-0.28, -0.36, 0.22]] } },
  salute: { label: 'Salute', cat: 'stand', hands: { r: 'open' }, j: { rsho: [0, 0, -75], lsho: [0, 0, 8], lelb: [-8, 0, 0] }, ik: { rhand: ['head', [-0.08, 0.15, 0.1]] } },
  handsUp: { label: 'Hands up', cat: 'stand', hands: { l: 'open', r: 'open' }, j: { lsho: [0, 0, 90], rsho: [0, 0, -90], lelb: [0, 0, 90], relb: [0, 0, -90] } },
  behind: { label: 'Hands behind', cat: 'stand', j: { lsho: [20, 0, 12], rsho: [20, 0, -12] },
    ik: { lhand: ['hips', [0.04, 0.02, -0.17]], rhand: ['hips', [-0.04, 0.02, -0.17]] } },
  together: { label: 'Hands together', cat: 'stand', hands: { l: 'open', r: 'open' }, j: { lsho: [-25, 0, 15], rsho: [-25, 0, -15] },
    ik: { lhand: ['chest', [0.02, 0.02, 0.3]], rhand: ['chest', [-0.02, 0.02, 0.3]] } },
  bow: { label: 'Bow', cat: 'stand', j: { spine: [25, 0, 0], chest: [25, 0, 0], neck: [10, 0, 0], lsho: [-50, 0, 5], rsho: [-50, 0, -5] } },
  thumb: { label: 'Thumbs up', cat: 'stand', hands: { r: 'fist' }, j: { lsho: [0, 0, 8], lelb: [-8, 0, 0], rsho: [-30, 0, -5], relb: [-70, 0, 0] } },
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
  punch: { label: 'Punch', cat: 'move', hands: { l: 'fist', r: 'fist' }, j: { lhip: [-20, 0, 0], lknee: [15, 0, 0], rhip: [15, 0, 0], rknee: [15, 0, 0], chest: [0, 25, 0],
    rsho: [-90, 0, 0], lsho: [-50, 0, 15], lelb: [-120, 0, 0] } },
  guard: { label: 'Guard', cat: 'move', hands: { l: 'fist', r: 'fist' }, j: { head: [8, 0, 0], lhip: [-15, 0, 4], rhip: [10, 0, -4], lknee: [20, 0, 0], rknee: [20, 0, 0],
    lsho: [-40, 0, 20], rsho: [-35, 0, -20], lelb: [-120, 0, 0], relb: [-125, 0, 0] } },
  throw: { label: 'Throw', cat: 'move', j: { chest: [0, -25, 0], lhip: [-25, 0, 0], rhip: [15, 0, 0], rknee: [15, 0, 0],
    rsho: [-45, 0, -110], relb: [-70, 0, 0], lsho: [-70, 0, 20] } },
  climb: { label: 'Climb', cat: 'move', hands: { l: 'grip', r: 'grip' }, j: { lsho: [-165, 0, 0], rsho: [-140, 0, 0], relb: [-40, 0, 0], lhip: [-70, 0, 0], lknee: [100, 0, 0],
    rhip: [-10, 0, 0], rknee: [20, 0, 0] } },
  carry: { label: 'Carry', cat: 'move', hands: { l: 'grip', r: 'grip' }, j: { spine: [-5, 0, 0], lsho: [-45, 0, 5], rsho: [-45, 0, -5], lelb: [-50, 0, 0], relb: [-50, 0, 0] },
    ik: { lhand: ['chest', [0.17, -0.12, 0.36]], rhand: ['chest', [-0.17, -0.12, 0.36]] } },
  push: { label: 'Push', cat: 'move', hands: { l: 'open', r: 'open' }, j: { spine: [15, 0, 0], chest: [10, 0, 0], lsho: [-75, 0, 0], rsho: [-75, 0, 0], lelb: [-25, 0, 0],
    relb: [-25, 0, 0], lhip: [-35, 0, 0], lknee: [35, 0, 0], rhip: [25, 0, 0], rfoot: [20, 0, 0] } },
  pull: { label: 'Pull', cat: 'move', hands: { l: 'grip', r: 'grip' }, j: { spine: [-15, 0, 0], lsho: [-70, 0, 0], rsho: [-70, 0, 0], lhip: [-25, 0, 0], lknee: [30, 0, 0],
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
  star: { label: 'Star', cat: 'fit', hands: { l: 'open', r: 'open' }, j: { lsho: [0, 0, 135], rsho: [0, 0, -135], lhip: [0, 0, 22], rhip: [0, 0, -22] } },
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
// a pose spec: a preset's name, or { from: a preset to start from, j: turns in degrees, ik: points to pull to,
// hands: { l, r: a hand pose } }
function buildPose(p) {
  if (typeof p === 'string') return preset(p).j;
  const j = p.from ? preset(p.from).j : {};
  for (const [n, [x, y, z]] of Object.entries(p.j || {})) j[n] = Q.setFromEuler(E.set(rad(x), rad(y), rad(z))).toArray();
  for (const [s, k] of Object.entries(p.hands || {})) Object.assign(j, handPose(k, s));
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
export const opposite = (n) => (/^[lr](sho|elb|hand|hip|knee|foot|(thumb|index|middle|ring|pinky)[123])$/.test(n) ? (n[0] === 'l' ? 'r' : 'l') + n.slice(1) : null);
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
  wave2: { cat: null, label: '', hands: { r: 'open' }, j: { rsho: [0, 0, -150], relb: [0, 0, -65], lsho: [0, 0, 8], lelb: [-8, 0, 0] } },
  clapOut: { cat: null, label: '', hands: { l: 'open', r: 'open' }, j: { lsho: [-40, 0, 25], rsho: [-40, 0, -25] }, ik: { lhand: ['chest', [0.22, 0, 0.3]], rhand: ['chest', [-0.22, 0, 0.3]] } },
});
PRESETS.punchL = { cat: null, label: '', hands: { l: 'fist', r: 'fist' }, j: Object.fromEntries(Object.entries(PRESETS.punch.j).map(([n, [x, y, z]]) => [opposite(n) || n, [x, -y, -z]])) };
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
// .hands: each hand's 21 points (the wrist, then each finger from its root to its tip, thumb first;
// null when the hand is hidden), .face: the 68 face points (null when the head is)
export function keypoints(rig, hide = []) {
  rig.root.updateMatrixWorld(true);
  const at = (o) => o.getWorldPosition(new THREE.Vector3());
  const p = {};
  for (const n of KP) p[n] = n === 'neck' ? null : at(rig.marks[n] || rig.bones[n]);
  p.neck = p.lsho.clone().add(p.rsho).multiplyScalar(0.5);
  const pts = KP.map((n) => (KP_PARTS[n].every((x) => hide.includes(x)) ? null : p[n]));
  pts.cut = new Set(LIMB_PARTS.flatMap((l, i) => (l.every((x) => hide.includes(x)) ? [i] : [])));
  pts.hands = ['l', 'r'].map((s) => (hide.includes(`${s}hand`) ? null
    : [at(rig.bones[`${s}hand`]), ...FINGERS.flatMap(([f]) => [1, 2, 3].map((i) => at(rig.bones[`${s}${f}${i}`])).concat(at(rig.marks[`${s}${f}tip`])))]));
  pts.face = hide.includes('head') ? null : rig.marks.face.map(at);
  return pts;
}
// the keypoints seen by a camera, in pixels of a W x H picture (a point behind the camera is null), as
// drawPose takes them. hands / face: false leaves them out.
export function projectPose(rig, hide, camera, W, H, { hands = true, face = true } = {}) {
  const k = keypoints(rig, hide);
  const px = (p) => {
    if (!p) return null;
    const v = p.clone().project(camera);
    return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
  };
  const pts = k.map(px);
  pts.cut = k.cut;
  pts.hands = hands ? k.hands.map((h) => h && h.map(px)) : [];
  pts.face = face && k.face ? k.face.map(px) : null;
  return pts;
}
// the 20 bones of a hand, between its 21 points (OpenPose's order)
const HAND_EDGES = [0, 1, 2, 3, 4].flatMap((f) => [[0, f * 4 + 1], [f * 4 + 1, f * 4 + 2], [f * 4 + 2, f * 4 + 3], [f * 4 + 3, f * 4 + 4]]);
// HSV with full saturation and value, as RGB 0-255 (the hands' bone colours)
const hsv = (h) => [5, 3, 1].map((n) => { const k = (n + h * 6) % 6; return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))); });

// draw figures' keypoints (already projected to pixels; null = behind the camera) like OpenPose: the body
// as controlnet_aux's draw_bodypose, the hands as its draw_handpose (bones in rainbow colours, blue
// points) and the face as white dots
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
    for (const hand of pts.hands || []) {
      if (!hand) continue;
      ctx.lineWidth = 2 * s; ctx.lineCap = 'round';
      HAND_EDGES.forEach(([a, b], i) => {
        const p = hand[a], q = hand[b];
        if (!p || !q) return;
        ctx.strokeStyle = `rgb(${hsv(i / HAND_EDGES.length).join(',')})`;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      });
      ctx.fillStyle = 'rgb(0,0,255)';
      for (const p of hand) if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2 * s, 0, Math.PI * 2); ctx.fill(); }
    }
    if (pts.face) {
      ctx.fillStyle = '#fff';
      for (const p of pts.face) if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5 * s, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}
