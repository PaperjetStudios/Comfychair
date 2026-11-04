import test from 'node:test';
import assert from 'node:assert/strict';
import { laneAbove, MAP_MAX_SECS, mapRoles, mapSpan } from '../web/maps.js';

const clip = { id: 'c', track: 'v1', at: 10, in: 2, out: 12 };   // 10 s long, on the timeline from 10 to 20
const lengthOf = (x) => x.len ?? 10;

test('a map covers the clip from its own in point', () => {
  assert.deepEqual(mapSpan(clip, 10), { at: 10, start: 2, len: 10, capped: false });
});
test('a range takes only the part of the clip inside it, in the clip\'s time', () => {
  assert.deepEqual(mapSpan(clip, 10, { a: 12, b: 15 }), { at: 12, start: 4, len: 3, capped: false });
  assert.deepEqual(mapSpan(clip, 10, { a: 5, b: 11 }), { at: 10, start: 2, len: 1, capped: false });
  assert.equal(mapSpan(clip, 10, { a: 25, b: 30 }), null);
});
test('a long clip is capped and says so', () => {
  const s = mapSpan({ ...clip, in: 0 }, 60);
  assert.equal(s.len, MAP_MAX_SECS);
  assert.equal(s.capped, true);
});
test('a map lands on the lowest track above its clip with room', () => {
  const tracks = [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'v3', kind: 'video' }, { id: 'a1', kind: 'audio' }];
  assert.equal(laneAbove(tracks, [clip], clip, 10, 10, lengthOf), 'v2');
  const inTheWay = { track: 'v2', at: 15, len: 2 };
  assert.equal(laneAbove(tracks, [clip, inTheWay], clip, 10, 10, lengthOf), 'v3');
  assert.equal(laneAbove(tracks, [clip, inTheWay], clip, 10, 5, lengthOf), 'v2');   // (touching isn't overlapping)
  assert.equal(laneAbove(tracks.slice(0, 2), [clip, inTheWay], clip, 10, 10, lengthOf), null);
  assert.equal(laneAbove(tracks, [clip], { ...clip, track: 'v3' }, 10, 10, lengthOf), null);   // never the sound track
});
test('map settings are the same for every door', () => {
  assert.deepEqual(mapRoles('depth', { depthModel: 'small' }), { depthModel: 'video_depth_anything_vits.pth', depthSize: 518 });
  assert.deepEqual(mapRoles('depth'), { depthModel: 'video_depth_anything_vitl.pth', depthSize: 448 });
  assert.deepEqual(mapRoles('canny', { edgeAmount: 'more' }), { edgeAmount: 0.2 });
  assert.deepEqual(mapRoles('scribble', { edgeAmount: 'less' }), { edgeAmount: 40 });
  assert.deepEqual(mapRoles('pose'), {});
});
