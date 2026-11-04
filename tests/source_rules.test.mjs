// node --test tests/source_rules.test.mjs: what a picked source is and what it can become (web/source-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { accepts, convertPlan, itemOf, recentKey } from '../web/source-rules.js';

test('itemOf reads every shape in use', () => {
  assert.deepEqual(itemOf('cat.png'), { kind: 'image', key: 'icat.png', src: { input: 'cat.png' } });
  assert.equal(itemOf({ input: 'cat.png' }).key, 'icat.png');
  assert.deepEqual(itemOf({ generation: 12, index: 0, kind: 'video' }), { kind: 'video', key: 'g12.0', src: { generation: 12, index: 0 } });
  assert.equal(itemOf({ generation: 12 }).kind, 'image');
  assert.equal(itemOf({ generation: 12, index: 2, kind: 'audio' }).key, 'g12.2');
  assert.deepEqual(itemOf({ media: 'a.mp4', kind: 'video' }), { kind: 'video', key: 'ma.mp4', src: { media: 'a.mp4' } });
  assert.equal(itemOf({ media: 'a.wav' }).kind, 'audio');
  assert.deepEqual(itemOf({ frame: 'f3', kind: 'image' }), { kind: 'image', key: 'ff3', src: { frame: 'f3' } });
  assert.equal(itemOf(null), null); assert.equal(itemOf({}), null); assert.equal(itemOf(5), null);
});
test('accepts filters by kind; no list takes all', () => {
  const v = itemOf({ media: 'a.mp4', kind: 'video' });
  assert.ok(accepts(v, ['video', 'audio'])); assert.ok(!accepts(v, ['image'])); assert.ok(accepts(v)); assert.ok(!accepts(null, ['image']));
});
test('convertPlan', () => {
  const img = itemOf('a.png'), out = itemOf({ generation: 1, kind: 'image' }), vid = itemOf({ media: 'a.mp4', kind: 'video' }), snd = itemOf({ media: 'a.wav' });
  assert.equal(convertPlan(img, 'picture'), 'use');
  assert.equal(convertPlan(out, 'picture'), 'toInput');
  assert.equal(convertPlan(vid, 'picture'), 'frames');
  assert.equal(convertPlan(snd, 'picture'), null);
  assert.equal(convertPlan(vid, 'clip'), 'use'); assert.equal(convertPlan(img, 'clip'), null);
  assert.equal(convertPlan(snd, 'sound'), 'use'); assert.equal(convertPlan(vid, 'sound'), 'sound-of-clip'); assert.equal(convertPlan(img, 'sound'), null);
  assert.equal(convertPlan(snd, 'any'), 'use'); assert.equal(convertPlan(null, 'any'), null);
});
test('recentKey is stable and matches the picker\'s existing keys', () => {
  assert.equal(recentKey(itemOf({ generation: 12, index: 0 })), 'g12.0');
  assert.equal(recentKey(itemOf({ media: 'x.mp4', kind: 'video' })), 'mx.mp4');
  assert.equal(recentKey(itemOf('p.png')), 'ip.png');
  assert.equal(recentKey(itemOf({ generation: 12 })), recentKey(itemOf({ generation: 12, index: 0 })));
});
