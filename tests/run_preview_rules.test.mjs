import test from 'node:test';
import assert from 'node:assert/strict';
import { lineOver, previewHome, rememberRun, windowUp } from '../web/run-preview-rules.js';

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

test('the preview window comes up with a run\'s first picture and stays until its line goes', () => {
  const on = { window: true, previews: true };
  assert.equal(windowUp(false, { ...on, words: 'Queued', live: false }), false);   // nothing to show yet
  assert.equal(windowUp(false, { ...on, words: 'step 1/8', live: true }), true);
  assert.equal(windowUp(true, { ...on, words: 'Starting…', live: false }), true);   // between a batch's runs
  assert.equal(windowUp(true, { ...on, words: 'Finished in 4s', live: false }), true);   // (its end line; lineOver times it out)
  assert.equal(windowUp(true, { ...on, words: '', live: false }), false);
});
test('no window for a line with no picture: switched off, previews off, another device\'s run', () => {
  assert.equal(windowUp(true, { window: false, previews: true, words: 'step 1/8', live: true }), false);
  assert.equal(windowUp(true, { window: true, previews: false, words: 'step 1/8', live: false }), false);
  assert.equal(windowUp(false, { window: true, previews: true, words: 'ComfyUI is busy with a run from another device', live: false }), false);
  assert.equal(windowUp(true, { window: true, previews: true, words: "ComfyUI is busy with another device's run · 3/20", live: true }), false);
});
test('a step line that says its run is over goes by itself', () => {
  assert.equal(lineOver('Finished in 4s'), true);
  assert.equal(lineOver('Stopped after 2s'), true);
  assert.equal(lineOver("ComfyUI is busy with another device's run · 20/20"), true);   // (no end line ever follows it here)
  assert.equal(lineOver("ComfyUI is busy with another device's run · 3/20"), false);
  assert.equal(lineOver('step 8/8'), false);   // this page's own run: its end line comes
  assert.equal(lineOver(''), false);
});
