// the mini camera view's box (web/scene-pip.js): whole, inside the canvas, the shot's shape
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipBox } from '../web/scene-pip-box.js';

test('it has the shot\'s shape, as wide as asked', () => {
  const b = pipBox({ x: 0.5, y: 0.1, w: 0.25 }, 1600, 900, 16 / 9);
  assert.deepEqual([b.x, b.y, b.w, b.h], [800, 90, 400, 225]);
});
test('it can\'t leave the canvas, at any corner', () => {
  for (const [x, y] of [[-3, -3], [5, 5], [5, -3]]) {
    const b = pipBox({ x, y, w: 0.25 }, 1000, 600, 1.5);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 1000 && b.y + b.h <= 600, JSON.stringify(b));
  }
});
test('not too small to see or grab, nor so big it covers the view', () => {
  assert.equal(pipBox({ x: 0, y: 0, w: 0.001 }, 1000, 600, 1.5).w, 120);
  assert.equal(pipBox({ x: 0, y: 0, w: 5 }, 1000, 600, 1).h, 420);   // (tall shot: its height sets the limit)
  assert.equal(pipBox({ x: 0, y: 0, w: 5 }, 1000, 900, 2).w, 700);
});
test('on a canvas narrower than the smallest box it still fits', () => {
  const b = pipBox({ x: 0.5, y: 0.5, w: 0.2 }, 80, 200, 1);
  assert.ok(b.x + b.w <= 80);
});
