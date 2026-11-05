// node --test tests/prompt_results.test.mjs: what the prompt helper wrote, kept (web/prompt-results.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SETS, rootOf, setFor, setsFor, withSet } from '../web/prompt-results.js';

const a = { kind: 'improve', root: 'a cat', src: 'a cat', mode: 'expand', fam: 'h3', variants: [{ text: 'a long cat' }, { text: 'a cat on a mat' }] };

test('a version that was used still belongs to the prompt it came from', () => {
  assert.equal(rootOf([a], 'improve', ' a cat '), 'a cat');
  assert.equal(rootOf([a], 'improve', 'a cat on a mat'), 'a cat');
  assert.equal(rootOf([a], 'improve', 'a dog'), 'a dog');
  assert.equal(rootOf([a], 'describe', 'a cat'), 'a cat');
});

test('a writing is found by what it was asked for', () => {
  assert.equal(setFor([a], 'improve', 'a cat', 'expand', 'h3'), a);
  assert.equal(setFor([a], 'improve', 'a cat', 'improve', 'h3'), null);
  assert.equal(setFor([a], 'improve', 'a cat', 'expand', 'ltx'), null);
  assert.deepEqual(setsFor([a], 'improve', 'a dog'), []);
});

test('newest first, and the oldest fall off', () => {
  let list = [];
  for (let i = 0; i < MAX_SETS + 5; i++) list = withSet(list, { at: i });
  assert.equal(list.length, MAX_SETS);
  assert.equal(list[0].at, MAX_SETS + 4);
});
