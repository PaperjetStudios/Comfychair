// node --test tests/tool_batch.test.mjs: a batch of layers goes on past a failing one (web/tool-batch.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { eachOne, failureText } from '../web/tool-batch.js';

test('every layer runs in order, one at a time', async () => {
  const log = [];
  const r = await eachOne(['a', 'b', 'c'], async (x) => { log.push(`start ${x}`); await new Promise((s) => setTimeout(s, 5)); log.push(`end ${x}`); });
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(r.done, ['a', 'b', 'c']);
  assert.equal(r.failed.length, 0);
});

test('a failing layer is reported and the others still run', async () => {
  const ran = [];
  const r = await eachOne(['a', 'b', 'c'], async (x) => { if (x === 'b') throw new Error('upload failed'); ran.push(x); });
  assert.deepEqual(ran, ['a', 'c']);
  assert.deepEqual(r.done, ['a', 'c']);
  assert.deepEqual(r.failed, [{ item: 'b', error: 'upload failed' }]);
  assert.equal(failureText('Skin detail', r.failed), 'Skin detail failed on b (upload failed)');
});

test('one layer works, and nothing failed says nothing', async () => {
  const r = await eachOne(['only'], async () => {});
  assert.deepEqual(r.done, ['only']);
  assert.equal(failureText('x', r.failed), '');
});

test('a thrown non-error is still reported', async () => {
  const r = await eachOne([1], async () => { throw 'boom'; });
  assert.equal(r.failed[0].error, 'boom');
});
