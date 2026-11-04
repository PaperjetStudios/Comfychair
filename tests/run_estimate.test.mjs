import test from 'node:test';
import assert from 'node:assert/strict';
import { stepClock, runEstimate, fmtPerStep } from '../web/run-state.js';

const run = (steps) => steps.reduce((c, [value, max, now]) => stepClock(c, value, max, now), null);

test('no estimate until two steps have been seen', () => {
  const c = run([[1, 20, 30000]]);
  assert.equal(c.per, null);
  assert.equal(runEstimate(c, 0, 30000), null);
  assert.equal(runEstimate(null, 0, 30000), null);
});

test('the average leaves out the time before the first step', () => {
  // 30s of loading, then 2s a step
  const c = run([[1, 20, 30000], [2, 20, 32000], [3, 20, 34000]]);
  assert.equal(c.per, 2000);
  assert.equal(runEstimate(c, 0, 34000), 68);  // 34s gone + 17 steps at 2s
});

test('the estimate holds still between steps and never falls behind the clock', () => {
  const c = run([[1, 4, 0], [2, 4, 2000]]);
  assert.equal(runEstimate(c, 0, 2000), 6);
  assert.equal(runEstimate(c, 0, 3000), 6);
  assert.equal(runEstimate(c, 0, 9000), 9);
});

test('a repeated step changes nothing', () => {
  const c = run([[1, 20, 0], [2, 20, 2000]]);
  assert.equal(stepClock(c, 2, 20, 5000), c);
});

test('a second pass starts afresh, whether the count falls or the total changes', () => {
  const fell = run([[1, 20, 0], [20, 20, 19000], [1, 20, 25000]]);
  assert.equal(fell.per, null);
  assert.equal(fell.firstAt, 25000);
  const total = run([[1, 20, 0], [5, 20, 4000], [6, 8, 9000]]);
  assert.equal(total.per, null);
  assert.equal(total.max, 8);
});

test('the pace reads in seconds, then minutes', () => {
  assert.equal(fmtPerStep(3240), '3.2s/step');
  assert.equal(fmtPerStep(400), '0.4s/step');
  assert.equal(fmtPerStep(90000), '1m 30s/step');
});
