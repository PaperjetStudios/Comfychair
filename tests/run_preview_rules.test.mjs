import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHome, rememberRun } from '../web/run-preview-rules.js';

test('a run shows in the frame that made it', () => {
  assert.equal(previewHome({ pid: 'p', runs: { p: 'a' }, selected: ['b'] }), 'a');
});
test('the open frame takes its own run and any run no frame made', () => {
  assert.equal(previewHome({ pid: 'p', runs: { p: 'a' }, live: 'a' }), 'a');
  assert.equal(previewHome({ pid: 'p', runs: {}, live: 'a' }), 'a');
});
test('another frame\'s run never covers the open frame', () => {
  assert.equal(previewHome({ pid: 'p', runs: { p: 'b' }, live: 'a' }), null);
});
test('a run no frame made goes in the one selected frame, else nowhere', () => {
  assert.equal(previewHome({ pid: 'p', selected: ['a'] }), 'a');
  assert.equal(previewHome({ pid: 'p', selected: ['a', 'b'] }), null);
  assert.equal(previewHome({ pid: 'p' }), null);
});
test('rememberRun maps each run of a batch, and keeps only the newest', () => {
  assert.deepEqual(rememberRun({}, [{ prompt_id: 'x' }, { prompt_id: 'y' }, {}], 'a'), { x: 'a', y: 'a' });
  assert.deepEqual(rememberRun({ x: 'a' }, [{ prompt_id: 'y' }], null), { x: 'a' });
  assert.deepEqual(rememberRun({ x: 'a', y: 'a' }, [{ prompt_id: 'z' }], 'b', 2), { y: 'a', z: 'b' });
});
