// node --test tests/undo_steps.test.mjs: what an image editor undo step holds, when steps merge, when history is kept on load (web/layer-stack.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../web/layer-stack.js';

const L = (key, o = {}) => ({ key, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1, ...o });
const canvasE = (layers, o = {}) => ({ layers, groups: [], size: { w: 512, h: 512 }, sizeShape: null, bg: '#000000', clear: false, out: 1, mp: 0, anim: null, items: [], ...o });
const snap = (E, pixels = (l) => l.cv && { img: l.cv, id: l.cv.from || l.cv, name: l.name }) => S.stackState(E.layers, E.groups, { canvas: E, pixels });

test('a canvas crop is one step: undo brings back the size and the layers\' places together, redo the crop', () => {
  const a = L('a', { x: 10, y: 20 }), E = canvasE([a]);
  const was = snap(E);
  a.x -= 100; a.y -= 50; E.size = { w: 300, h: 300 }; E.sizeShape = null;
  const now = snap(E);
  assert.equal(S.sameState(was, now), false);
  S.applyState(E, was);
  assert.deepEqual([E.size, a.x, a.y], [{ w: 512, h: 512 }, 10, 20]);
  S.applyState(E, now);
  assert.deepEqual([E.size, a.x, a.y], [{ w: 300, h: 300 }, -90, -30]);
});

test('the export size, items and fit come back with their step (an Upscale result leaves no raised export size)', () => {
  const E = canvasE([L('a')], { items: [{ x: 1, y: 1, w: 9, h: 9, desc: 'cat', ref: '' }] });
  const was = snap(E);
  E.out = 2; E.items[0].x = 50; E.size = null;
  S.applyState(E, was);
  assert.equal(E.out, 1); assert.equal(E.items[0].x, 1); assert.deepEqual(E.size, { w: 512, h: 512 });
  E.items[0].x = 7;
  assert.equal(was.canvas.items[0].x, 1, 'the step keeps its own copy');
});

test('a mask replaced whole goes back with its step, its file name too; an image turned into a canvas for its first stroke is no change', () => {
  const old = { id: 'old' }, neu = { id: 'new' }, m = L('m', { mask: true, cv: old, name: 'old.png' }), E = canvasE([m]);
  const was = snap(E);
  m.cv = neu; m.name = 'new.png';
  const now = snap(E);
  assert.equal(S.sameState(was, now), false);
  m.img = neu;
  assert.deepEqual(S.applyState(E, was), [m]);
  assert.equal(m.img, old); assert.equal(m.name, 'old.png');
  const pic = { id: 'image' }, p = L('p', { cv: pic }), E3 = canvasE([p]), before = snap(E3);
  p.cv = { id: 'converted', from: pic };
  assert.ok(S.sameState(before, snap(E3)));
  const bare = L('b'), E4 = canvasE([bare]), none = snap(E4);   // (no picture yet: one loading in is no change either)
  bare.cv = { id: 'loaded' };
  assert.ok(S.sameState(none, snap(E4)));
  assert.deepEqual(S.applyState(E4, none), [], 'nothing is taken from a layer that had no picture');
});

test('an animated layer\'s keys and the animation come back with the move that wrote them', () => {
  const a = L('a', { chans: { x: [{ f: 0, v: 0 }] } }), E = canvasE([a], { anim: { len: 3, fps: 24 } });
  const was = snap(E);
  a.x = 40; a.chans.x.push({ f: 1, v: 40 }); E.anim.len = 5;
  assert.equal(S.sameState(was, snap(E)), false);
  S.applyState(E, was);
  assert.deepEqual(a.chans, { x: [{ f: 0, v: 0 }] }); assert.equal(a.x, 0); assert.equal(E.anim.len, 3);
});

test('steps merge only within a slider\'s run that keeps the same layers and canvas', () => {
  const a = L('a'), E = canvasE([a]);
  const s0 = snap(E); a.opacity = 0.9; const s1 = snap(E); a.opacity = 0.8; const s2 = snap(E);
  const last = { beforeStack: s0, afterStack: s1 };
  assert.ok(S.mergesWith(last, s2, 100));
  assert.ok(!S.mergesWith(last, s2, 600), 'too late');
  E.layers = [a, L('result')]; const landed = snap(E);
  assert.ok(!S.mergesWith(last, landed, 100), 'a result landing is a step of its own');
  const del = { beforeStack: landed, afterStack: s2 };
  a.opacity = 0.7;
  assert.ok(!S.mergesWith(del, snap(E), 100), 'nothing joins a delete');
  E.layers = [a]; const t0 = snap(E); E.size = { w: 300, h: 300 };
  assert.ok(!S.mergesWith({ beforeStack: s1, afterStack: t0 }, snap(E), 100), 'a canvas size is a step of its own');
  a.cv = { id: 'c1' }; const p0 = snap(E); a.cv = { id: 'c2' };
  assert.ok(!S.mergesWith({ beforeStack: p0, afterStack: p0 }, snap(E), 100), 'a swapped picture is a step of its own');
});

test('history is kept on load only for the same document reopened as it is on show, never after a save from elsewhere', () => {
  assert.ok(S.keepsHistory({ was: 'd1', id: 'd1', same: true }));
  assert.ok(!S.keepsHistory({ was: 'd1', id: 'd2', same: true }), 'another document');
  assert.ok(!S.keepsHistory({ was: 'd1', id: 'd1', same: false }), 'changed meanwhile');
  assert.ok(!S.keepsHistory({ was: 'd1', id: 'd1', same: true, remote: true }), 'saved on another device');
  assert.ok(!S.keepsHistory({ was: null, id: null, same: true }), 'no document');
});
