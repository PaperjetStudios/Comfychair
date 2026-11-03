// node --test tests/skin_parts.test.mjs: the parts the Skin detail tool does, and each one's prompt (web/skin-parts.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { partPrompt, partSize, partsOf } from '../web/skin-parts.js';

test('parts are split on commas and new lines, without repeats or blanks', () => {
  assert.deepEqual(partsOf('chest, left arm\nright arm,, chest'), ['chest', 'left arm', 'right arm']);
  assert.deepEqual(partsOf('  '), []);
});

test('each part goes into the prompt once, without doubling its article', () => {
  const p = 'A close-up of the {part}, natural skin';
  assert.equal(partPrompt(p, 'chest'), 'A close-up of the chest, natural skin');
  assert.equal(partPrompt(p, 'the left arm'), 'A close-up of the left arm, natural skin');
});

test('a large picture draws its parts bigger', () => {
  assert.equal(partSize([1216, 1664]), 1024);
  assert.equal(partSize([2048, 2048]), 1024);
  assert.equal(partSize([3648, 4992]), 1536);
});

test('a prompt without {part} is sent as written', () => {
  assert.equal(partPrompt('Natural skin', 'chest'), 'Natural skin');
});
