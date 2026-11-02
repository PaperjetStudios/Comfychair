// Modifiers on a keyed value (the 3D graph's): waves and noise added on top of what a channel's keys, or its base, hold.
// Pure (node tests import it). item.mods = { channel: [mod, ...] }, each mod
//   { type, amp (in the channel's own unit), freq (cycles a second), phase (degrees), seed, detail (noise layers, 1-4), on }
// A modifier never changes the keys: it only depends on the time, so a preview and a render get the same movement.
export const MOD_TYPES = [['sine', 'Sine'], ['cosine', 'Cosine'], ['triangle', 'Triangle'], ['square', 'Square'], ['saw', 'Saw'], ['noise', 'Noise'], ['steps', 'Random steps']];
export const isRandom = (type) => type === 'noise' || type === 'steps';
// a splat's frame, a pose's name, a joint's turn, a bone's and a figure's parameters aren't numbers a wave can add to here
export const canModify = (ch) => !ch.includes('.') && ch !== 'sf' && ch !== 'pn' && ch !== 'cut';

// a repeatable number in -1..1 for a whole number and a seed
function hash(i, seed) {
  let x = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 2147483647.5 - 1;
}
// smooth noise in -1..1: random heights at whole numbers, eased between them
export function noise(x, seed = 0, detail = 1) {
  let sum = 0, weight = 0, a = 1, fx = x;
  for (let o = 0; o < Math.max(1, detail); o++) {
    const i = Math.floor(fx), t = fx - i, e = t * t * (3 - 2 * t), s = seed + o * 101;
    const p = hash(i, s), q = hash(i + 1, s);
    sum += a * (p + (q - p) * e); weight += a;
    a *= 0.5; fx = fx * 2 + 17.3;
  }
  return sum / weight;
}
const wrap = (x) => x - Math.floor(x);
// one modifier's value at t seconds
export function modAt(m, t) {
  if (m.on === false) return 0;
  const amp = +m.amp || 0, freq = +m.freq || 0, x = t * freq + (+m.phase || 0) / 360;
  switch (m.type) {
    case 'cosine': return amp * Math.cos(2 * Math.PI * x);
    case 'triangle': return amp * (1 - 4 * Math.abs(wrap(x + 0.25) - 0.5));
    case 'square': return amp * (wrap(x) < 0.5 ? 1 : -1);
    case 'saw': return amp * (2 * wrap(x + 0.5) - 1);
    case 'noise': return amp * noise(x, m.seed, m.detail);
    case 'steps': return amp * hash(Math.floor(x), +m.seed || 0);
    default: return amp * Math.sin(2 * Math.PI * x);
  }
}
// what a channel's modifiers add up to at t seconds
export const modsAt = (list, t) => (list || []).reduce((sum, m) => sum + modAt(m, t), 0);
// a new modifier for a channel; amp: a size that shows without taking over
export const newMod = (type, amp = 0.1, seed = 1) => ({ type, amp, freq: isRandom(type) ? 1 : 0.5, phase: 0, on: true, ...(isRandom(type) ? { seed, detail: type === 'noise' ? 2 : undefined } : {}) });

// values with an item's modifiers on (over: +1) or off (-1), in a new object when any apply. names: which values count.
export function shiftByMods(item, vals, t, over = 1) {
  if (!item?.mods) return vals;
  let out = vals;
  for (const [ch, list] of Object.entries(item.mods)) {
    if (typeof vals[ch] !== 'number' || !list?.length) continue;
    if (out === vals) out = { ...vals };
    out[ch] = vals[ch] + over * modsAt(list, t);
  }
  return out;
}
