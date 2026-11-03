// node --test tests/download_words.test.mjs: what a download's row says (web/download-words.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyWords, progressWords } from '../web/download-words.js';

test('one on its way: how much of how much, how fast, how long', () => {
  assert.match(progressWords({ got: 1.2e9, total: 6.2e9, speed: 12e6 }), /^1\.2 GB of 6\.2 GB · 12 MB\/s · .+ left$/);
  assert.equal(progressWords({ got: 5e6, total: 0, speed: 0 }), '5 MB');
  assert.equal(progressWords({ got: 0 }), 'Starting…');
  assert.equal(progressWords({ got: 5e6, stopping: true }), 'Stopping…');
});

test('one in the history says how it ended', () => {
  assert.match(historyWords({ state: 'done', size: 2.3e9, finished: 1e9 }), /^Done · 2\.3 GB · /);
  assert.match(historyWords({ state: 'done', skipped: true, size: 5e6 }), /^Already there/);
  assert.match(historyWords({ state: 'done', gone: true }), /^Done, file since deleted/);
  assert.match(historyWords({ state: 'stopped' }), /^Stopped/);
  assert.match(historyWords({ state: 'interrupted' }), /^Interrupted/);
  assert.doesNotMatch(historyWords({ state: 'failed', size: 9 }), /\d/);
});
