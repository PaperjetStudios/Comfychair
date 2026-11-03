// node --test tests/edit_size.test.mjs: an edit model keeps the whole picture
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editSizeFor, editSizeTo } from '../web/edit-size.js';

test('a tall picture stays tall', () => {
  const [w, h] = editSizeFor(1344, 2304);
  assert.ok(Math.abs(w / h - 1344 / 2304) < 0.01, `${w}×${h}`);
  assert.ok(w * h <= 2.2e6, `${w}×${h}`);
  assert.equal(w % 16, 0); assert.equal(h % 16, 0);
});
test('a small picture is not made bigger', () => assert.deepEqual(editSizeFor(672, 1152), [672, 1152]));
test('a set size scales a small picture up and a big one down, keeping its shape', () => {
  for (const [pw, ph] of [[672, 1152], [4000, 3000]]) {
    const [w, h] = editSizeTo(pw, ph, 32, 2e6);
    assert.ok(Math.abs((w * h) / 2e6 - 1) < 0.05, `${w}×${h}`);
    assert.ok(Math.abs(w / h - pw / ph) < 0.02, `${w}×${h}`);
    assert.equal(w % 32, 0); assert.equal(h % 32, 0);
  }
});
test('the model\'s multiple', () => {
  const [w, h] = editSizeFor(700, 1000, 32);
  assert.equal(w % 32, 0); assert.equal(h % 32, 0);
});
test('within the size field\'s limits', () => {
  assert.deepEqual(editSizeFor(100, 100), [256, 256]);
  assert.ok(Math.max(...editSizeFor(8000, 400)) <= 4096);
});
