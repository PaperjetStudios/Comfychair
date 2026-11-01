// Apply scale, rotation or transform on a 3D layer, as plain maths: no three.js, no DOM (tests/bake_math.test.mjs).
//
// A layer is drawn at T R S B: its x, y, z, turn and size, then item.bake, what was applied to it (16 numbers, column by column, as
// three.js's Matrix4). Applying moves part of T R S into B: the layer looks exactly the same, and those values read 0 or 1. Its files
// are not touched. item.origin stays in the file's own space, so what x, y, z and the turn work round is B × origin.
import { qRot } from './gizmo-orient.js';
import { drawnScale, eulerQ } from './origin-math.js';

export const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
export const point = (m, p) => [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
// (a direction or a distance between points: no move)
export const linear = (m, d) => [0, 1, 2].map((i) => m[i] * d[0] + m[4 + i] * d[1] + m[8 + i] * d[2]);
// how much a bake scales along each of its axes
export const scaleOf = (m) => [0, 4, 8].map((c) => Math.hypot(m[c], m[c + 1], m[c + 2]));
function matrix(q, s, t) {
  const x = qRot(q, [s[0], 0, 0]), y = qRot(q, [0, s[1], 0]), z = qRot(q, [0, 0, s[2]]);
  return [...x, 0, ...y, 0, ...z, 0, ...t, 1];
}
const turnOf = (v) => eulerQ(v.rx, v.ry, v.rz);
const NOW = [0, 0, 0, 1];
// a matrix with a move, a turn and no shear, undone
function invert(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  const inv = [A / det, (c * h - b * i) / det, (b * f - c * e) / det, 0, B / det, (a * i - c * g) / det, (c * d - a * f) / det, 0, C / det, (b * g - a * h) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
  const t = linear(inv, [m[12], m[13], m[14]]);
  inv[12] = -t[0]; inv[13] = -t[1]; inv[14] = -t[2];
  return inv;
}

const PLACE = ['x', 'y', 'z'], TURN = ['rx', 'ry', 'rz'], SIZE = ['sx', 'sy', 'sz'];
const same = (s) => Math.abs(s[0] - s[1]) < 1e-6 && Math.abs(s[1] - s[2]) < 1e-6;

// kind: 'scale', 'rotation' or 'all'. Changes item in place. { ok, note? } or { ok: false, why }: with keys on what would go, each
// frame would need its own bake, so that's refused and the layer is left as it was.
export function applyBake(item, kind, { even = false } = {}) {
  if (item.off) return { ok: false, why: 'It has an offset layer: bake or remove that first' };
  if (item.mute) return { ok: false, why: 'It has muted keys: turn them back on first' };
  const b = item.base, s = drawnScale(b, even);
  const keyed = (chs) => chs.some((ch) => item.chans?.[ch]?.length);
  // a stretched layer can't lose its turn alone: the stretch is along the turned axes, so its size goes too
  const stretched = kind === 'rotation' && !same(s);
  const scale = kind === 'scale' || kind === 'all' || stretched, turn = kind === 'rotation' || kind === 'all', move = kind === 'all';
  if ((scale && keyed(SIZE)) || (turn && keyed(TURN)) || (move && keyed(PLACE))) {
    return { ok: false, why: `It has keys on its ${[scale && keyed(SIZE) && 'scale', turn && keyed(TURN) && 'rotation', move && keyed(PLACE) && 'position'].filter(Boolean).join(' and ')}: those differ per frame, so they can't be applied` };
  }
  const B = item.bake || IDENT, at = point(B, item.origin || [0, 0, 0]);
  // what moves into the bake. A uniform scale that stays comes through a turn unchanged: the turn alone goes
  let by = IDENT;
  if (move) {   // x, y, z are where the origin is: where the file's own (0, 0, 0) really stands is that, less the origin's shift
    const q = turnOf(b), off = qRot(q, [at[0] * s[0], at[1] * s[1], at[2] * s[2]]);
    by = matrix(q, s, [b.x - off[0], b.y - off[1], b.z - off[2]]);
  } else if (turn) by = matrix(turnOf(b), stretched ? s : [1, 1, 1], [0, 0, 0]);
  else by = matrix(NOW, s, [0, 0, 0]);
  const next = mul(by, B);
  if (scale) for (const ch of SIZE) b[ch] = 1;
  if (turn) for (const ch of TURN) b[ch] = 0;
  if (move) {   // (at the world's zero, with the point there as its origin, so it turns round that)
    for (const ch of PLACE) b[ch] = 0;
    const o = point(invert(next), [0, 0, 0]);
    item.origin = o;
    item.pivot = 'set';
  }
  item.bake = next;
  return { ok: true, note: stretched ? 'It was stretched, so its scale was applied too' : null };
}
