// node --test tests/owed_runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { besideX, layerOf, owedFor, owedRecord, sameRun, withOwed, withoutOwed } from '../web/owed-runs.js';

const src = () => ({ name: 'a.png', px: [100, 50], rect: { x: 10, y: 20, w: 100, h: 50 }, layer: {},
  was: { name: 'a.png', key: 'k', crop: { x: 0, y: 0, w: 1, h: 1 }, x: 10, y: 20, scale: 1, rotation: 90, flipX: true, img: { naturalWidth: 100, naturalHeight: 50 }, live: {} } });

test('variations go side by side, the first in the original\'s place', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual([0, 1, 2].map((n) => besideX(r, n)), [10, 112, 214]);
  assert.equal(besideX(r), 10);
});
test('on a canvas of a fixed size they stay in one place, or they would be cut off', () => {
  assert.equal(besideX({ x: 10, w: 100 }, 2, true), 10);
});
test('a record survives JSON, and keeps what a turned layer needs to be placed on', () => {
  const rec = JSON.parse(JSON.stringify(owedRecord('tab', 'edit', src(), { id: 5, prompt_id: 'p' }, 2, 1000)));
  assert.equal(rec.id, 5); assert.equal(rec.nth, 2); assert.deepEqual(rec.rect, src().rect);
  assert.deepEqual([rec.was.w, rec.was.h, rec.was.rotation, rec.was.flipX, rec.was.flipY], [100, 50, 90, true, false]);
  assert.equal(rec.was.img, undefined); assert.equal(rec.was.live, undefined);
});
test('a whole-picture run has no layer to keep', () => {
  assert.equal(owedRecord('tab', 'edit', { name: 'a', px: [1, 1], rect: {}, layer: null }, { id: 1 }).was, null);
});
test('the list: no doubles, each edit its own, and old ones go', () => {
  const DAY = 24 * 3600 * 1000, now = 100 * DAY, a = { id: 1, tab: 'x', at: now - 8 * DAY }, b = { id: 2, tab: 'x', at: now - DAY };
  const list = withOwed([a, b], { id: 3, tab: 'y', at: now }, now);
  assert.deepEqual(list.map((r) => r.id), [2, 3]);
  assert.deepEqual(withOwed(list, { id: 2, tab: 'x', at: now }, now).map((r) => r.id), [3, 2]);
  assert.deepEqual(owedFor(list, 'y').map((r) => r.id), [3]);
  assert.deepEqual(withoutOwed(list, 2).map((r) => r.id), [3]);
});
test('a reused run id is not the run that was owed', () => {
  const rec = { id: 5, prompt: 'p' };
  assert.equal(sameRun(rec, { id: 5, prompt_id: 'p' }), true);
  assert.equal(sameRun(rec, { id: 5, prompt_id: 'other' }), false);
  assert.equal(sameRun(rec, null), false);
});
test('the original is found by key, then by picture and crop; a mask or a changed crop is not it', () => {
  const crop = { x: 0, y: 0, w: 1, h: 1 }, was = { name: 'a', key: 'k', crop };
  const byKey = { name: 'other', key: 'k', crop }, byName = { name: 'a', crop }, mask = { name: 'a', crop, maskOf: 'z' }, cut = { name: 'a', crop: { x: 0.5, y: 0, w: 0.5, h: 1 } };
  assert.equal(layerOf([byName, byKey], was), byKey);
  assert.equal(layerOf([mask, cut, byName], was), byName);
  assert.equal(layerOf([mask, cut], was), null);
  assert.equal(layerOf([byName], null), null);
});
test('a run for a video or sound frame keeps where it lands and as what, and counts per document', async () => {
  const { landingRecord, owedCounts } = await import('../web/owed-runs.js');
  const rec = JSON.parse(JSON.stringify(landingRecord({ id: 9, prompt_id: 'q' }, { tab: 'v1', frame: 'f1', kind: 'video', op: 'restyle', label: 'LoRA restyle · Clip' }, 5)));
  assert.deepEqual(rec, { id: 9, prompt: 'q', tab: 'v1', frame: 'f1', kind: 'video', op: 'restyle', as: 'clip', at: 5, label: 'LoRA restyle · Clip' });
  assert.equal(sameRun(rec, { id: 9, prompt_id: 'q' }), true);
  const list = withOwed(withOwed([], rec, 5), { ...rec, id: 10 }, 5);
  assert.deepEqual(owedCounts(list), { v1: 2 });
  assert.deepEqual(owedCounts(withoutOwed(list, 9)), { v1: 1 });
  assert.deepEqual(owedCounts([]), {});
});
