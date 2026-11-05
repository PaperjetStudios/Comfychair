// node --test tests/combine_rules.test.mjs: several frames made into one (web/combine-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasLayout, clipsEnd, combinable, combineClips, combineImages, combineKind, combineScenes, readingOrder } from '../web/combine-rules.js';

const f = (kind, extra = {}) => ({ id: Math.random().toString(36), kind, x: 0, y: 0, w: 100, h: 100, ...extra });
let n = 0;
const newId = () => `n${++n}`;

test('what frames make: by their kinds; notes, hidden and locked ones take no part', () => {
  assert.equal(combineKind([f('image'), f('image')]), 'image');
  assert.equal(combineKind([f('video'), f('video')]), 'video');
  assert.equal(combineKind([f('sound'), f('sound')]), 'sound');
  assert.equal(combineKind([f('scene'), f('scene')]), 'scene');
  assert.equal(combineKind([f('scene'), f('image')]), 'scene');
  assert.equal(combineKind([f('video'), f('image')]), 'video');
  assert.equal(combineKind([f('scene'), f('sound')]), 'video');
  assert.equal(combineKind([f('image'), f('note')]), null);
  assert.equal(combineKind([f('image'), f('image', { hidden: true })]), null);
  assert.equal(combineKind([f('image'), f('image', { locked: true })]), null);
  assert.equal(combinable([f('note'), f('image')]).length, 1);
});

test('reading order: along each row, then the next row down', () => {
  const a = f('video', { x: 300, y: 10 }), b = f('video', { x: 0, y: 30 }), c = f('video', { x: 50, y: 400 });
  assert.deepEqual(readingOrder([a, c, b]), [b, a, c]);
});

test('images keep their places on the table, at their own output size, with no overlap they did not have', () => {
  const left = { frame: f('image', { x: 100, y: 50, w: 100, h: 100 }), rect: { x: 0, y: 0, w: 1000, h: 1000 } };
  const right = { frame: f('image', { x: 220, y: 50, w: 100, h: 100 }), rect: { x: 0, y: 0, w: 500, h: 500 } };
  const r = canvasLayout([left, right]);
  assert.deepEqual(r.at, [{ x: 0, y: 0 }, { x: 1200, y: 0 }]);
  assert.deepEqual(r.size, { w: 1700, h: 1000 });
  assert.deepEqual(r.tile, { x: 100, y: 50, w: 170, h: 100 });
});

test('a stack: every canvas centred on the largest', () => {
  const big = { frame: f('image', { x: 0 }), rect: { x: 0, y: 0, w: 1000, h: 800 } };
  const small = { frame: f('image', { x: 900 }), rect: { x: 0, y: 0, w: 500, h: 400 } };
  const r = canvasLayout([big, small], { stack: true });
  assert.deepEqual(r.size, { w: 1000, h: 800 });
  assert.deepEqual(r.at, [{ x: 0, y: 0 }, { x: 250, y: 200 }]);
});

test('layers: new keys, masks follow their owner, groups stay, several plain layers group under the frame name', () => {
  const dup = { v: 2, layers: [{ key: 'a', name: 'a.png', x: 10, y: 0, label: 'A' }, { key: 'm', name: 'm.png', x: 10, y: 0, maskOf: 'a' }, { key: 'b', name: 'b.png', x: 0, y: 0 }], groups: [] };
  const grouped = { v: 2, layers: [{ key: 'a', name: 'c.png', x: 0, y: 0, group: 'g1' }], groups: [{ id: 'g1', name: 'Mine' }] };
  const r = combineImages([
    { frame: f('image', { x: 0, label: 'One' }), payload: dup, rect: { x: 0, y: 0, w: 100, h: 100 } },
    { frame: f('image', { x: 200, label: 'Two' }), payload: grouped, rect: { x: 0, y: 0, w: 100, h: 100 } },
  ], { newId });
  const { layers, groups, size } = r.payload;
  assert.deepEqual(size, { w: 300, h: 100 });
  assert.equal(new Set(layers.map((l) => l.key)).size, 3 + 0 + 1);
  const mask = layers.find((l) => l.name === 'm.png'), owner = layers.find((l) => l.name === 'a.png');
  assert.equal(mask.maskOf, owner.key);
  assert.notEqual(owner.key, 'a');
  assert.equal(groups.find((g) => g.id === owner.group).name, 'One');
  assert.equal(mask.group, undefined);
  const moved = layers.find((l) => l.name === 'c.png');
  assert.equal(moved.x, 200);
  assert.equal(groups.find((g) => g.id === moved.group).name, 'Mine');
  assert.notEqual(moved.group, 'g1');
  assert.deepEqual(r.out, size);
});

test('a source offset by its fitted box lands at its place; a keyed position moves too; a lone layer takes the frame name', () => {
  const p = { v: 2, layers: [{ key: 'k', name: 'x.png', x: 60, y: 40, chans: { x: [{ f: 0, v: 60 }], scale: [{ f: 0, v: 2 }] } }] };
  const r = combineImages([
    { frame: f('image', { x: 0, label: 'Far' }), payload: { v: 2, layers: [{ key: 'z', name: 'z.png', x: 0, y: 0 }] }, rect: { x: 0, y: 0, w: 100, h: 100 } },
    { frame: f('image', { x: 300, label: 'Near' }), payload: p, rect: { x: 50, y: 40, w: 100, h: 100 } },
  ], { newId });
  const l = r.payload.layers.find((x) => x.name === 'x.png');
  assert.equal(l.x, 310);
  assert.equal(l.y, 0);
  assert.equal(l.chans.x[0].v, 310);
  assert.equal(l.chans.scale[0].v, 2);
  assert.equal(l.label, 'Near');
  assert.equal(p.layers[0].x, 60);   // (the source is not touched)
});

test('clips: one source after another, tracks by kind, cont links stay inside a source', () => {
  const one = { tracks: [{ id: 't', kind: 'video' }, { id: 'u', kind: 'audio' }],
    items: [{ id: 'a', track: 't', kind: 'video', at: 0, in: 0, out: 2, dur: 2 }, { id: 'b', track: 't', kind: 'video', at: 2, in: 1, out: 4, dur: 4, cont: { of: 'a' } },
      { id: 'c', track: 'u', kind: 'audio', at: 0, in: 0, out: 5, dur: 5 }] };
  const two = { tracks: [{ id: 't', kind: 'video' }], items: [{ id: 'a', track: 't', kind: 'video', at: 1, in: 0, out: 2, dur: 2, cont: { of: 'gone' } }] };
  const r = combineClips([one, two], { tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }], newId });
  assert.equal(r.tracks.length, 3);
  const [a, b, c, d] = r.items;
  assert.equal(a.track, 'v1');
  assert.equal(c.track, 'a1');
  assert.equal(b.cont.of, a.id);
  assert.equal(d.track, 'v1');
  assert.equal(d.at, 6);   // (the first source ends at 5 + its own start of 1 for the second)
  assert.equal(d.cont, undefined);
  assert.equal(new Set(r.items.map((i) => i.id)).size, 4);
  assert.equal(clipsEnd(r.items), 8);
});

test('clips: a hidden track stays apart; a sound frame on a video timeline is audio; more tracks are added when needed', () => {
  const hid = { tracks: [{ id: 'h', kind: 'video', hidden: true }], items: [{ id: 'a', track: 'h', kind: 'video', at: 0, in: 0, out: 1 }] };
  const snd = { tracks: [{ id: 's' }], items: [{ id: 'b', track: 's', kind: 'audio', at: 0, in: 0, out: 1 }] };
  const three = { tracks: ['p', 'q', 'r'].map((id) => ({ id, kind: 'video' })), items: ['p', 'q', 'r'].map((track, i) => ({ id: `i${i}`, track, kind: 'video', at: 0, in: 0, out: 1 })) };
  const r = combineClips([hid, snd, three], { tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }], newId });
  assert.ok(r.tracks.find((t) => t.id === r.items[0].track).hidden);
  assert.equal(r.items[1].track, 'a1');
  assert.deepEqual(r.items.slice(2).map((i) => r.tracks.find((t) => t.id === i.track).kind), ['video', 'video', 'video']);
  assert.equal(new Set(r.items.slice(2).map((i) => i.track)).size, 3);
});

test('sound edits: tracks with no kind, in sequence', () => {
  const a = { tracks: [{ id: 's' }], items: [{ id: 'x', track: 's', kind: 'audio', at: 0, in: 0, out: 2 }] };
  const r = combineClips([a, a], { tracks: [{ id: 'a1' }, { id: 'a2' }], sound: true, newId });
  assert.equal(r.tracks.length, 2);
  assert.deepEqual(r.items.map((i) => [i.track, i.at]), [['a1', 0], ['a1', 2]]);
});

test('scenes: first camera and shape, every object with a new id, longest length, first room there is', () => {
  const r = combineScenes([
    { width: 768, height: 448, seconds: 6, room: null, camera: { id: 'cam0' }, objects: [{ id: 'same', type: 'model', base: { x: 1 } }] },
    { width: 100, height: 100, seconds: 9, room: { w: 8 }, camera: { id: 'other' }, objects: [{ id: 'same', type: 'splat', base: { x: 2 } }] },
  ], { newId });
  assert.equal(r.width, 768);
  assert.equal(r.camera.id, 'cam0');
  assert.equal(r.seconds, 9);
  assert.deepEqual(r.room, { w: 8 });
  assert.deepEqual(r.objects.map((o) => o.base.x), [1, 2]);
  assert.equal(new Set(r.objects.map((o) => o.id)).size, 2);
});
