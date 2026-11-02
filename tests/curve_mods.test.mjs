// Graph modifiers: the waves' shapes, noise that repeats, and values taken off again when an edit comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canModify, modAt, modsAt, newMod, noise, shiftByMods } from '../web/curve-mods.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} is not ${b}`);

test('waves have the amount and the speed asked for', () => {
  const s = { type: 'sine', amp: 2, freq: 0.5 };
  near(modAt(s, 0), 0); near(modAt(s, 0.5), 2); near(modAt(s, 1.5), -2); near(modAt(s, 2), 0);
  near(modAt({ type: 'cosine', amp: 2, freq: 1 }, 0), 2);
  near(modAt({ type: 'sine', amp: 1, freq: 1, phase: 90 }, 0), 1);
  near(modAt({ type: 'triangle', amp: 1, freq: 1 }, 0), 0); near(modAt({ type: 'triangle', amp: 1, freq: 1 }, 0.25), 1); near(modAt({ type: 'triangle', amp: 1, freq: 1 }, 0.75), -1);
  assert.equal(modAt({ type: 'square', amp: 1, freq: 1 }, 0.2), 1); assert.equal(modAt({ type: 'square', amp: 1, freq: 1 }, 0.7), -1);
  near(modAt({ type: 'saw', amp: 1, freq: 1 }, 0), 0); near(modAt({ type: 'saw', amp: 1, freq: 1 }, 0.25), 0.5);
});

test('noise repeats for a seed, differs between seeds, stays in range and has no jumps', () => {
  const a = { type: 'noise', amp: 3, freq: 2, seed: 7, detail: 3 };
  assert.equal(modAt(a, 1.37), modAt({ ...a }, 1.37));
  assert.notEqual(modAt(a, 1.37), modAt({ ...a, seed: 8 }, 1.37));
  let prev = noise(0, 5, 1), lo = 9, hi = -9, big = 0;
  for (let x = 0.01; x < 300; x += 0.01) { const v = noise(x, 5, 1); big = Math.max(big, Math.abs(v - prev)); prev = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= -1 && hi <= 1 && hi - lo > 1, `${lo}..${hi}`);
  assert.ok(big < 0.05, `jump ${big}`);
  for (let i = 0; i < 2000; i++) { const v = modAt({ type: 'steps', amp: 1, freq: 1, seed: 3 }, i); assert.ok(v >= -1 && v <= 1); }
});

test('off adds nothing; several add up; the old scene without any is left as it was', () => {
  assert.equal(modAt({ type: 'sine', amp: 1, freq: 1, on: false }, 0.25), 0);
  near(modsAt([{ type: 'cosine', amp: 1, freq: 1 }, { type: 'cosine', amp: 2, freq: 1 }], 0), 3);
  const v = { y: 1 };
  assert.equal(shiftByMods({}, v, 1), v);
  assert.equal(shiftByMods({ mods: { x: [{ type: 'cosine', amp: 1, freq: 1 }] } }, v, 0), v);   // (no x in these values)
});

test('on and off again gives back what the keys hold, and leaves the rest', () => {
  const item = { mods: { py: [{ type: 'noise', amp: 0.4, freq: 1.3, seed: 2, detail: 2 }] } };
  const vals = { py: 1.6, px: 2, fov: 30 };
  const shown = shiftByMods(item, vals, 2.2);
  assert.notEqual(shown.py, 1.6); assert.equal(shown.px, 2); assert.equal(vals.py, 1.6);
  near(shiftByMods(item, shown, 2.2, -1).py, 1.6);
});

test('new modifiers are complete, and only plain numbers can have one', () => {
  assert.equal(newMod('noise', 0.1, 4).seed, 4);
  assert.equal(newMod('sine').seed, undefined);
  for (const ch of ['py', 'x', 'fov', 'roll']) assert.ok(canModify(ch));
  for (const ch of ['sf', 'pn', 'cut', 'j.hips', 'm.smile', 'b.arm']) assert.ok(!canModify(ch));
});
