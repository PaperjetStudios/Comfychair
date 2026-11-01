// A 3D layer's origin, as plain maths: no three.js, no DOM, so node can test it (tests/origin_math.test.mjs).
//
// A layer's x, y, z are where its origin is, and it turns and scales around that point, in the view, in renders and
// between keys. item.origin is the point in the layer's own unscaled space; without one it is the layer's own (0, 0, 0)
// (a model's base, a figure's feet), so a scene saved before origins looks the same.
import { qRot } from './gizmo-orient.js';

const RAD = Math.PI / 180;
// degrees to a quaternion, in three.js's Euler order (XYZ)
export function eulerQ(rx = 0, ry = 0, rz = 0) {
  const c1 = Math.cos(rx * RAD / 2), c2 = Math.cos(ry * RAD / 2), c3 = Math.cos(rz * RAD / 2);
  const s1 = Math.sin(rx * RAD / 2), s2 = Math.sin(ry * RAD / 2), s3 = Math.sin(rz * RAD / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
// the scale a layer is drawn at (the same floors as pose()): even, one number; else one per axis
export const drawnScale = (v, even) => (even ? Array(3).fill(Math.max(1e-4, v.sy)) : [v.sx, v.sy, v.sz].map((s) => Math.max(0.01, s)));
// a point in the layer's own space, from the layer's (0, 0, 0): scaled and turned by its values v
export function originShift(v, at, even) {
  const s = drawnScale(v, even);
  return qRot(eulerQ(v.rx, v.ry, v.rz), [at[0] * s[0], at[1] * s[1], at[2] * s[2]]);
}

const PLACE = ['x', 'y', 'z'], TURN = ['rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
// The origin moves to `at` and the layer stays where it is: x, y, z change by the shift, in the base and on keys. With a
// turn or a size animated the shift differs per frame, so place gets keys on every frame that has a place, turn or size
// key (between those keys it can part slightly from the old path). sample(f): the values before the change.
export function moveOrigin(item, at, { even, sample, setKey }) {
  const from = item.origin || [0, 0, 0], d = at.map((a, i) => a - from[i]);
  const keyed = (ch) => !!item.chans?.[ch]?.length;
  const base = originShift(item.base, d, even);
  if (TURN.some(keyed)) {
    const fs = [...new Set([...PLACE, ...TURN].flatMap((ch) => (item.chans[ch] || []).map((k) => k.f)))].sort((a, b) => a - b);
    const vals = fs.map((f) => {
      const v = sample(f), s = originShift(v, d, even);
      return { f, p: [v.x + s[0], v.y + s[1], v.z + s[2]] };
    });
    PLACE.forEach((ch, i) => {
      // (a place that was not animated and needs no keys now stays that way: no extra rows in the sheet)
      if (!keyed(ch) && vals.every((x) => Math.abs(x.p[i] - vals[0].p[i]) < 1e-9)) item.base[ch] = vals[0].p[i];
      else { for (const x of vals) setKey(item, ch, x.f, x.p[i]); item.base[ch] += base[i]; }
    });
  } else {
    PLACE.forEach((ch, i) => {
      item.base[ch] += base[i];
      for (const k of item.chans?.[ch] || []) k.v += base[i];
    });
  }
  if (at.every((a) => Math.abs(a) < 1e-9)) delete item.origin; else item.origin = [...at];
}
