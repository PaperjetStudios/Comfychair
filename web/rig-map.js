// A model's skeleton onto the posable figure's joints. Pure: no DOM (figure.js gives the joint table and
// rest offsets). scene-rig.js does the three.js side with these names.
//
// Auto-riggers name bones their own way: Mixamo (mixamorig:Hips, LeftArm…), UniRig (guessed names), a
// DCC's default. Known names map directly; the rest are guessed by where the bone sits in the figure's
// rest pose, so any model that is roughly a standing figure can be driven.
import { FINGERS, JOINTS, mirrorQ, restOffsets } from './figure.js';

// A bone's name, lowercased and stripped: "mixamorig:LeftArm" and "Left_Arm" are both "leftarm".
export function norm(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/^.*[:|]/, '');            // a rig's prefix, e.g. "mixamorig:"
  s = s.replace(/^mixamorig/, '');          // ...or without the colon (FBXLoader drops it)
  s = s.replace(/^(def|org|mch)[-_]/, '');  // Rigify's (DEF-spine)
  s = s.replace(/[\s_\-.]+/g, '');
  return s;
}

// the names the common rigs use, cleaned by norm(); null = a bone the figure has no joint for
export const NAMES = {
  root: null, hips: 'hips', pelvis: 'hips', spine: 'spine', spine1: 'chest', spine2: 'chest',
  spine01: 'spine', spine02: 'chest', spine03: 'chest', chest: 'chest', upperchest: 'chest',
  neck: 'neck', head: 'head', headtopend: null,
  leftshoulder: null, leftarm: 'lsho', leftforearm: 'lelb', leftlowerarm: 'lelb', lefthand: 'lhand',
  rightshoulder: null, rightarm: 'rsho', rightforearm: 'relb', rightlowerarm: 'relb', righthand: 'rhand',
  leftupleg: 'lhip', leftthigh: 'lhip', leftleg: 'lknee', leftshin: 'lknee', leftcalf: 'lknee',
  leftfoot: 'lfoot', lefttoebase: null, lefttoe: null,
  rightupleg: 'rhip', rightthigh: 'rhip', rightleg: 'rknee', rightshin: 'rknee', rightcalf: 'rknee',
  rightfoot: 'rfoot', righttoebase: null, righttoe: null,
};
for (const [side, hand] of [['l', 'left'], ['r', 'right']]) {
  FINGERS.forEach(([fig], i) => {
    const word = ['thumb', 'index', 'middle', 'ring', 'pinky'][i];
    for (let j = 1; j <= 3; j++) NAMES[`${hand}hand${word}${j}`] = `${side}${fig}${j}`;
  });
}

// The bone on the other side of the middle, or null for a centre bone: Mixamo's Left/Right, an .L/.R
// (or _L/-L) suffix, or a leading l/r (l_hand, rFoot).
export function oppositeBone(name) {
  const s = String(name || '');
  if (!s) return null;
  const swapped = s.replace(/Left/g, '\u0000').replace(/Right/g, 'Left').replace(/\u0000/g, 'Right');
  if (swapped !== s) return swapped;
  const m = /^(.*?)([._-])(L|R)$/i.exec(s);
  if (m) return m[1] + m[2] + (m[3].toUpperCase() === 'L' ? 'R' : 'L');
  if (/^[lr](?=[A-Z0-9_]|$)/.test(s)) return (s[0] === 'l' ? 'r' : 'l') + s.slice(1);
  // a lowercase limb name (lhand, rfoot): never 'root'
  if (/^[lr](hand|arm|sho|shoulder|elb|elbow|leg|foot|knee|hip|thumb|index|middle|ring|pinky|toe)/i.test(s)) {
    return (s[0] === 'l' ? 'r' : 'l') + s.slice(1);
  }
  return null;
}

// A pose's bone channels mirrored about the model's own middle: paired bones swap sides, centre bones
// mirror in place (a turn's y and z flip, the same mirror figure.js uses). Frames, eases and every
// non-bone channel stay as they were.
export function mirrorChans(chans = {}, base = {}) {
  const outC = Object.fromEntries(Object.entries(chans || {}).filter(([c]) => !c.startsWith('b.')));
  const outB = {};
  const names = new Set([...Object.keys(chans || {}).filter((c) => c.startsWith('b.')).map((c) => c.slice(2)),
    ...Object.keys(base || {})]);
  for (const n of names) {
    const t = oppositeBone(n) || n;
    const list = chans?.[`b.${n}`];
    if (Array.isArray(list) && list.length) outC[`b.${t}`] = list.map((k) => ({ ...k, v: mirrorQ(k.v) }));
    if (base?.[n]) outB[t] = mirrorQ(base[n]);
  }
  return { chans: outC, base: outB };
}

// the body joints the figure poses, in its order
export const BODY_JOINTS = Object.keys(JOINTS);
// body and fingers: everything a rigged model can drive
export const RIG_JOINTS = [...BODY_JOINTS,
  ...['l', 'r'].flatMap((s) => FINGERS.flatMap(([f]) => [1, 2, 3].map((j) => `${s}${f}${j}`)))];

// where each body joint stands in the figure's rest pose (offsets summed down the chain), in metres
export function restPositions(body = 'man') {
  const off = restOffsets(body), pos = {};
  const at = (name) => {
    if (pos[name]) return pos[name];
    const parent = JOINTS[name]?.[0];
    const p = parent ? at(parent) : [0, 0, 0];
    const o = off[name] || JOINTS[name][1];
    pos[name] = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
    return pos[name];
  };
  for (const name of BODY_JOINTS) at(name);
  return pos;
}

// bones: [{ name, pos?: [x,y,z] }]. Returns { boneName: jointName }.
// Known names first (one bone per joint); then each joint still without one takes the nearest free
// bone within the tolerance (a body's worth: 0.12 m).
export function mapBones(bones, { positions = null, tolerance = 0.12 } = {}) {
  const out = {}, used = new Set(), taken = new Set();
  for (const b of bones) {
    const j = NAMES[norm(b.name)];
    if (j && !taken.has(j)) { out[b.name] = j; used.add(b.name); taken.add(j); }
  }
  if (positions) {
    for (const joint of BODY_JOINTS) {
      if (taken.has(joint)) continue;
      const want = positions[joint];
      if (!want) continue;
      let best = null, bestD = tolerance;
      for (const b of bones) {
        if (used.has(b.name) || !b.pos) continue;
        const d = Math.hypot(b.pos[0] - want[0], b.pos[1] - want[1], b.pos[2] - want[2]);
        if (d < bestD) { best = b; bestD = d; }
      }
      if (best) { out[best.name] = joint; used.add(best.name); taken.add(joint); }
    }
  }
  return out;
}

// the joints the map leaves out, for the panel ("no left hand: the model's skeleton has no such bone")
export function missing(map) {
  const have = new Set(Object.values(map));
  return RIG_JOINTS.filter((j) => !have.has(j));
}
