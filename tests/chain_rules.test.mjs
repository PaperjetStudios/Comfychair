// node --test tests/chain_rules.test.mjs: rerunning a chain of wired frames (web/chain-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { staleInfo, staleFrames, staleText, sourceStamps, freshLayers, layerMarks, withoutLayers, replaceItem, withSoundItem, placeResults } from '../web/chain-rules.js';

const W = (id, from, to, kind = 'image', more = {}) => ({ id, from, to, kind, n: 1, on: true, ...more });
const F = (id, more = {}) => ({ id, kind: 'image', doc: `d-${id}`, ...more });
const flow = (ran) => ({ make: { template: 'tpl', ...(ran && { ran }) } });

test('stale: a source changed, a wire plugged in or unplugged since the last run, and what is downstream', () => {
  const stamps = { a: 'r2', b: 'r5', c: 'r1', d: 'r1', e: 'r1', x: null };
  const stampOf = (f) => stamps[f.id];
  const wires = [W('ab', 'a', 'b'), W('bc', 'b', 'c'), W('cd', 'c', 'd'), W('de', 'd', 'e'), W('xe', 'x', 'e')];
  const frames = [F('a'), F('b', flow({ sources: { ab: 'r1' } })), F('c', flow({ sources: { bc: 'r5' } })), F('d'),
    F('e', flow({ sources: { de: 'r1', xe: 'whatever' } }))];
  const info = staleInfo(wires, frames, stampOf);
  assert.deepEqual(info.get('b'), { why: 'changed', wire: 'ab', from: 'a' });
  assert.deepEqual(info.get('c'), { why: 'upstream', from: 'b' });
  assert.ok(!info.has('d'), 'no workflow: takes nothing in');
  assert.deepEqual(info.get('e'), { why: 'upstream', from: 'b' }, 'through a frame with no workflow; an unknown stamp is not held against it');
  assert.ok(!info.has('a'));
  assert.deepEqual(staleFrames(wires, frames, stampOf).sort(), ['b', 'c', 'e']);
});

test('stale: new and unplugged wires; off wires; a frame never run is not stale', () => {
  const stampOf = () => 'r1';
  const f1 = [F('a'), F('b', flow({ sources: {} }))];
  assert.equal(staleInfo([W('ab', 'a', 'b')], f1, stampOf).get('b').why, 'new');
  assert.equal(staleInfo([W('ab', 'a', 'b', 'image', { on: false })], f1, stampOf).size, 0, 'an off wire is not read');
  const f2 = [F('a'), F('b', flow({ sources: { ab: 'r1' } }))];
  assert.equal(staleInfo([], f2, stampOf).get('b').why, 'unplugged');
  assert.equal(staleInfo([W('ab', 'a', 'b', 'image', { on: false })], f2, stampOf).get('b').why, 'unplugged');
  assert.equal(staleInfo([W('ab', 'a', 'b')], f2, stampOf).size, 0, 'same stamp: fine');
  assert.equal(staleInfo([W('ab', 'a', 'b')], [F('a'), F('b', flow(null))], stampOf).size, 0, 'never run');
  assert.equal(staleInfo([W('ab', 'a', 'b')], [F('a'), F('b', { make: { ran: { sources: {} } } })], stampOf).size, 0, 'no workflow');
});

test('staleText and sourceStamps', () => {
  const name = (id) => ({ a: 'Pic' })[id] || 'x', wireName = () => 'Image 1';
  assert.match(staleText({ why: 'changed', wire: 'w', from: 'a' }, { name, wireName }), /Image 1 from "Pic" changed/);
  assert.match(staleText({ why: 'upstream', from: 'a' }, { name, wireName }), /"Pic" feeds this frame/);
  assert.equal(staleText(null), '');
  const frames = [F('a'), F('b'), F('c')];
  const st = sourceStamps([W('1', 'a', 'c'), W('2', 'b', 'c', 'image', { on: false }), W('3', 'a', 'b')], 'c', frames, (f) => `s-${f.id}`);
  assert.deepEqual(st, { 1: 's-a' });
  assert.deepEqual(sourceStamps([W('1', 'a', 'c')], 'c', frames, () => null), {});
});

test('layers: what a run landed, by key, and taking out only the last run\'s (and their masks)', () => {
  const layers = [{ name: 'old', key: 'k1', label: 'Made' }, { name: 'mine', key: 'k2', label: 'Made' }, { name: 'm1', key: 'k3', maskOf: 'k1' },
    { name: 'new', key: 'k4', label: 'Krea' }, { name: 'other', key: 'k5', label: 'Other' }];
  const before = layerMarks(layers.slice(0, 3));
  assert.deepEqual(freshLayers(before, layers, 'Krea'), ['k4']);
  assert.deepEqual(freshLayers(before, layers), ['k4', 'k5']);
  assert.deepEqual(freshLayers(new Set(['old']), [{ name: 'old', key: 'k9', label: 'Made' }]), [], 'a key given since the count: there by its name');
  assert.deepEqual(freshLayers(new Set(), [{ name: 'n', label: 'Krea' }], 'Krea'), [], 'no key yet: not counted');
  const r = withoutLayers(layers, ['k1']);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.layers.map((l) => l.name), ['mine', 'new', 'other']);
  assert.equal(withoutLayers(layers, ['gone']).removed, 0);
  assert.equal(withoutLayers(layers, []).layers.length, 5);
  // a duplicated or pasted copy shares the picture's name but has its own key: a rerun never takes it
  const dup = [{ name: 'res.png', key: 'r1', label: 'Krea' }, { name: 'res.png', key: 'r2', label: 'Krea copy' }];
  assert.deepEqual(withoutLayers(dup, ['r1']).layers.map((l) => l.key), ['r2']);
  assert.equal(withoutLayers(dup, ['res.png']).removed, 0, 'an old made entry (a name) matches nothing');
});

test('replaceItem keeps the place, trim start and transform; takes the new source and length', () => {
  const p = { tracks: [{ id: 'v1' }], items: [{ id: 'c1', track: 'v1', kind: 'video', src: { generation: 1, index: 0 }, url: 'a', label: '#1', dur: 5, at: 3, in: 1, out: 4, x: 10, scale: 2, opacity: 0.5 },
    { id: 'c2', track: 'v1', at: 9, dur: 2 }] };
  const q = replaceItem(p, 'c1', { kind: 'video', src: { generation: 2, index: 0 }, url: 'b', label: '#2', dur: 6 });
  const it = q.items[0];
  assert.deepEqual([it.id, it.track, it.at, it.in, it.out, it.x, it.scale, it.opacity], ['c1', 'v1', 3, 1, 4, 10, 2, 0.5]);
  assert.deepEqual([it.src.generation, it.url, it.label, it.dur], [2, 'b', '#2', 6]);
  assert.equal(q.items[1], p.items[1]);
  assert.equal(p.items[0].url, 'a', 'not changed in place');
  const short = replaceItem(p, 'c1', { kind: 'video', src: {}, url: 'c', label: '#3', dur: 2 }).items[0];
  assert.deepEqual([short.in, short.out], [1, 2]);
  const tiny = replaceItem(p, 'c1', { kind: 'video', src: {}, url: 'c', label: '#3', dur: 0.5 }).items[0];
  assert.deepEqual([tiny.in, tiny.out], [0, 0.5]);
  assert.equal(replaceItem(p, 'nope', { src: {} }), null);
});

test('placeResults: the first output in place of the last run\'s item, its other items go, the rest are added', () => {
  const p = withSoundItem(withSoundItem({ tracks: [{ id: 'a1' }], items: [{ id: 'u', track: 'a1', at: 0, dur: 1, out: 1 }] },
    { src: { generation: 1 }, url: 'x', label: '#1', dur: 2 }, 's1'), { src: { generation: 1, index: 1 }, url: 'y', label: '#1', dur: 2 }, 's2');
  assert.deepEqual(p.items.map((i) => [i.id, i.at]), [['u', 0], ['s1', 1], ['s2', 3]]);
  let n = 0;
  const newId = () => `n${++n}`;
  const m = (g) => ({ kind: 'audio', src: { generation: g }, url: `g${g}`, label: `#${g}`, dur: 2 });
  const r = placeResults(p, ['s1', 's2', 'gone'], [m(5)], { append: withSoundItem, newId });
  assert.deepEqual(r.made, ['s1']);
  assert.deepEqual(r.payload.items.map((i) => i.id), ['u', 's1']);
  assert.equal(r.payload.items[1].url, 'g5');
  assert.equal(r.payload.items[1].at, 1);
  const r2 = placeResults(p, [], [m(6), m(7)], { append: withSoundItem, newId });
  assert.deepEqual(r2.made, ['n1', 'n2']);
  assert.equal(r2.payload.items.length, 5);
  const r3 = placeResults(p, ['s1'], [], { append: withSoundItem, newId });
  assert.equal(r3.payload, p, 'nothing came out: nothing goes');
  assert.deepEqual(r3.made, ['s1']);
  const r4 = placeResults(p, ['gone'], [m(8)], { append: withSoundItem, newId });
  assert.deepEqual(r4.made, ['n3'], 'the last run\'s item was deleted by hand: added instead');
  assert.equal(r4.payload.items.length, 4);
});

test('freshLayers: a run\'s layers are found under their full name too', async () => {
  const { freshLayers: f } = await import('../web/chain-rules.js');
  const layers = [{ key: 'a', label: 'control · Klein 3 · lora' }, { key: 'b', label: 'control' }, { key: 'c', label: 'controlled' }];
  assert.deepEqual(f(new Set(), layers, 'control'), ['a', 'b']);
});
