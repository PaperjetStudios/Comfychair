// node --test tests/tool_models.test.mjs: several models ticked for one image tool (web/tool-models.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticked, chosen, toggled } from '../web/tool-models.js';

test('settings saved before there were lists keep their one model', () => {
  assert.deepEqual(ticked(undefined, 'krea2'), ['krea2']);
  assert.deepEqual(ticked(['a', 'b'], 'krea2'), ['a', 'b']);
  assert.deepEqual(ticked([], 'krea2'), []);   // (all unticked stays unticked)
  assert.deepEqual(ticked(undefined, undefined), []);
});

test('only what can run here is chosen', () => {
  assert.deepEqual(chosen(['a', 'b', 'c'], null, (k) => k !== 'b'), ['a', 'c']);
  assert.deepEqual(chosen(undefined, 'a', () => false), []);
});

test('a tap ticks or unticks', () => {
  assert.deepEqual(toggled(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggled(['a', 'b'], 'a'), ['b']);
});
