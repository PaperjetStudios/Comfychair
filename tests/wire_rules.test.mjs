// node --test tests/wire_rules.test.mjs: wires between a table's frames (web/wire-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldKind, wireLabel, outKind, outKinds, renumber, migrateWires, cycle, addWire, setWire, removeWires, dropFrames, inputsFor, mapToFields, remap,
  framePick, isFrameWire, replaceWire,
} from '../web/wire-rules.js';

const F = (id, kind, more = {}) => ({ id, kind, doc: `doc-${id}`, x: 0, y: 0, w: 512, h: 512, ...more });
const frames = [F('i1', 'image'), F('i2', 'image'), F('v1', 'video'), F('s1', 'sound'), F('n1', 'note', { doc: null, text: 'hi' }),
  F('e1', 'image', { doc: null }), F('t', 'image'), F('c1', 'scene')];
const W = (id, from, to, kind, more = {}) => ({ id, from, to, kind, n: 0, on: true, ...more });

test('field kinds: audio takes sound; labels', () => {
  assert.equal(fieldKind({ kind: 'audio' }), 'sound');
  assert.equal(fieldKind({ kind: 'image' }), 'image');
  assert.equal(fieldKind({ kind: 'video' }), 'video');
  assert.equal(fieldKind({ kind: 'int' }), null);
  assert.equal(wireLabel({ kind: 'image', n: 2 }), 'Image 2');
});

test('what a frame puts out: none from a note or an empty frame', () => {
  assert.deepEqual(['i1', 'v1', 's1', 'n1', 'e1', 'c1'].map((id) => outKind(frames.find((f) => f.id === id))), ['image', 'video', 'sound', null, null, 'image']);
  assert.equal(outKind(F('p', 'image', { doc: null, preview: 'x.png' })), 'image');
  assert.equal(outKind(null), null);
});

test('renumber: per target and kind, in plug order', () => {
  const ws = renumber([W('a', 'i1', 't', 'image'), W('b', 'v1', 't', 'video'), W('c', 'i2', 't', 'image'), W('d', 'i1', 'i2', 'image')]);
  assert.deepEqual(ws.map((w) => w.n), [1, 1, 2, 1]);
});

test('migrate: bad shapes, self wires, repeats and missing frames go; on defaults true', () => {
  const ws = migrateWires([W('a', 'i1', 't', 'image', { on: undefined }), W('b', 'i1', 't', 'image'), W('c', 'i1', 'i1', 'image'),
    W('d', 'gone', 't', 'image'), { from: 'v1', to: 't', kind: 'smell' }, null, W(null, 'v1', 't', 'video', { on: false })], frames);
  assert.deepEqual(ws.map((w) => [w.from, w.kind, w.n, w.on]), [['i1', 'image', 1, true], ['v1', 'video', 1, false]]);
  assert.ok(ws[1].id);
  assert.deepEqual(migrateWires(undefined), []);
  assert.equal(migrateWires([W('d', 'gone', 't', 'image')]).length, 1);   // no frames given: kept
});

test('cycle: a frame to itself, or to one that already feeds it', () => {
  const ws = [W('a', 'i1', 'i2', 'image'), W('b', 'i2', 't', 'image')];
  assert.equal(cycle(ws, 't', 'i1'), true);
  assert.equal(cycle(ws, 'i2', 'i2'), true);
  assert.equal(cycle(ws, 'i1', 't'), false);
  assert.equal(cycle(ws, 'v1', 'i1'), false);
});

test('add: kind from the source, numbered; refused for a loop, a repeat, a note, a missing frame', () => {
  let r = addWire([], { from: 'i1', to: 't' }, frames);
  assert.deepEqual([r.wire.kind, r.wire.n, r.wire.on, r.why], ['image', 1, true, null]);
  r = addWire(r.wires, { from: 'i2', to: 't', id: 'w2' }, frames);
  assert.deepEqual([r.wire.id, r.wire.n], ['w2', 2]);
  const ws = r.wires;
  assert.equal(addWire(ws, { from: 't', to: 'i1' }, frames).why, 'cycle');
  assert.equal(addWire(ws, { from: 'i1', to: 't' }, frames).why, 'exists');
  assert.equal(addWire(ws, { from: 'n1', to: 't' }, frames).why, 'no-output');
  assert.equal(addWire(ws, { from: 'e1', to: 't' }, frames).why, 'no-output');
  assert.equal(addWire(ws, { from: 'zz', to: 't' }, frames).why, 'missing');
  const refused = addWire(ws, { from: 't', to: 't' }, frames);
  assert.equal(refused.wire, null);
  assert.equal(refused.wires, ws);
  assert.equal(addWire(ws, { from: 'v1', to: 't', kind: 'image' }, frames).wire.kind, 'image');   // a frame of a video, asked for
});

test('remove and drop frames renumber the rest', () => {
  const ws = renumber([W('a', 'i1', 't', 'image'), W('b', 'i2', 't', 'image'), W('c', 'c1', 't', 'image'), W('d', 's1', 't', 'sound')]);
  assert.deepEqual(removeWires(ws, ['a']).map((w) => [w.id, w.n]), [['b', 1], ['c', 2], ['d', 1]]);
  assert.deepEqual(dropFrames(ws, ['i2']).map((w) => [w.id, w.n]), [['a', 1], ['c', 2], ['d', 1]]);
  assert.deepEqual(dropFrames(ws, ['t']), []);
  assert.equal(ws[1].n, 2);   // (the given list is left as it was)
});

test('inputs of a frame: image, video, sound, each by number', () => {
  const ws = renumber([W('s', 's1', 't', 'sound'), W('b', 'i2', 't', 'image'), W('v', 'v1', 't', 'video'), W('a', 'i1', 't', 'image'), W('x', 'i1', 'i2', 'image')]);
  assert.deepEqual(inputsFor(ws, 't').map((w) => w.id), ['b', 'a', 'v', 's']);
  assert.deepEqual(inputsFor(ws, 'v1'), []);
});

test('map to fields: Nth input to Nth field of its kind, the frame\'s own image field skipped, overrides and off wires honoured', () => {
  const fields = [{ key: 'own', kind: 'image' }, { key: 'ref1', kind: 'image' }, { key: 'ref2', kind: 'image' },
    { key: 'clip', kind: 'video' }, { key: 'voice', kind: 'audio' }, { key: 'steps', kind: 'int' }];
  const ins = inputsFor(renumber([W('a', 'i1', 't', 'image'), W('b', 'i2', 't', 'image'), W('c', 'c1', 't', 'image'),
    W('v', 'v1', 't', 'video', { on: false }), W('s', 's1', 't', 'sound')]), 't');
  let m = mapToFields(fields, ins, { skip: 'own' });
  assert.deepEqual(Object.fromEntries(Object.entries(m.map).map(([k, w]) => [k, w.id])), { ref1: 'a', ref2: 'b', clip: 'v', voice: 's' });
  assert.deepEqual(Object.keys(m.use).sort(), ['ref1', 'ref2', 'voice']);   // the off video keeps the field on its own value
  assert.deepEqual(m.spare.map((w) => w.id), ['c']);
  m = mapToFields(fields, ins, { skip: [fields[0]], overrides: { ref1: 'c', ref2: false, voice: 'v' } });
  assert.deepEqual(Object.fromEntries(Object.entries(m.map).map(([k, w]) => [k, w.id])), { ref1: 'c', clip: 'v', voice: 's' });   // a video wire can't go in a sound field
  assert.deepEqual(m.spare.map((w) => w.id), ['a', 'b']);
  m = mapToFields(fields, ins, { skip: 'own', overrides: { ref2: 'gone' } });   // a wire that is gone frees its field
  assert.equal(m.map.ref2.id, 'b');
  m = mapToFields(fields, ins);   // no skip: the first image field takes Image 1
  assert.equal(m.map.own.id, 'a');
});

test('remap copies wires onto copied frames with new ids', () => {
  const ws = renumber([W('a', 'i1', 'i2', 'image'), W('b', 'v1', 'i2', 'video'), W('c', 'i2', 't', 'image')]);
  const out = remap(ws, { i1: 'I1', i2: 'I2' });
  assert.deepEqual(out.map((w) => [w.from, w.to, w.kind, w.n]), [['I1', 'I2', 'image', 1]]);
  assert.notEqual(out[0].id, 'a');
  const withIn = remap(ws, new Map([['i1', 'I1'], ['i2', 'I2']]), { inputs: true });
  assert.deepEqual(withIn.map((w) => [w.from, w.to]), [['I1', 'I2'], ['v1', 'I2']]);
  const all = remap(ws, { i1: 'X1', i2: 'X2', v1: 'XV', t: 'XT' });
  assert.deepEqual(all.map((w) => [w.from, w.to]), [['X1', 'X2'], ['XV', 'X2'], ['X2', 'XT']]);
});

test('a video frame puts out its clip and a frame of it; the rest one kind or none', () => {
  assert.deepEqual(outKinds(frames.find((f) => f.id === 'v1')), ['video', 'image']);
  assert.deepEqual(outKinds(frames.find((f) => f.id === 'i1')), ['image']);
  assert.deepEqual(outKinds(frames.find((f) => f.id === 'c1')), ['image']);
  assert.deepEqual(outKinds(frames.find((f) => f.id === 'n1')), []);
  assert.deepEqual(outKinds(frames.find((f) => f.id === 'e1')), []);
  assert.equal(outKind(frames.find((f) => f.id === 'v1')), 'video');
  assert.deepEqual(['first', 'last', 'playhead', 2.5, -1, 'x', NaN, null].map(framePick), ['first', 'last', 'playhead', 2.5, 'first', 'first', 'first', 'first']);
});

test('add: a frame of a video carries which frame; first, then last; a kind the source lacks is refused', () => {
  let r = addWire([], { from: 'v1', to: 't', kind: 'image' }, frames);
  assert.deepEqual([r.wire.kind, r.wire.frame, r.wire.n], ['image', 'first', 1]);
  assert.ok(isFrameWire(r.wire));
  r = addWire(r.wires, { from: 'v1', to: 't', kind: 'image' }, frames);
  assert.deepEqual([r.wire.frame, r.wire.n], ['last', 2]);
  assert.equal(addWire(r.wires, { from: 'v1', to: 't', kind: 'image', frame: 'last' }, frames).why, 'exists');
  assert.equal(addWire(r.wires, { from: 'v1', to: 't', kind: 'image', frame: 3 }, frames).wire.frame, 3);
  r = addWire(r.wires, { from: 'v1', to: 't' }, frames);
  assert.deepEqual([r.wire.kind, r.wire.frame, r.wire.n], ['video', undefined, 1]);
  assert.equal(addWire([], { from: 'i1', to: 't', kind: 'video' }, frames).why, 'wrong-kind');
  assert.equal(addWire([], { from: 's1', to: 't', kind: 'image' }, frames).why, 'wrong-kind');
  assert.equal(addWire([], { from: 'i1', to: 't', frame: 'last' }, frames).wire.frame, undefined);   // (a picture frame has no frames)
});

test('migrate: a frame of a video says which; a frame field elsewhere goes; first and last both kept', () => {
  const ws = migrateWires([W('a', 'v1', 't', 'image'), W('b', 'v1', 't', 'image', { frame: 'last' }), W('c', 'v1', 't', 'image', { frame: 'bogus' }),
    W('d', 'i1', 't', 'image', { frame: 'last' }), W('e', 'v1', 'i2', 'video', { frame: 2 })], frames);
  assert.deepEqual(ws.map((w) => [w.id, w.frame, w.n]), [['a', 'first', 1], ['b', 'last', 2], ['d', undefined, 3], ['e', undefined, 1]]);
});

test('setWire: an image wire keeps a crop until it is taken off; other kinds never do', () => {
  const ws = migrateWires([{ id: 'a', from: 'x', to: 'y', kind: 'image' }, { id: 'b', from: 'x', to: 'y', kind: 'sound' }]);
  const c = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
  assert.deepEqual(setWire(ws, 'a', { crop: c }).find((w) => w.id === 'a').crop, c);
  assert.equal('crop' in setWire(setWire(ws, 'a', { crop: c }), 'a', { crop: null }).find((w) => w.id === 'a'), false);
  assert.equal('crop' in setWire(ws, 'b', { crop: c }).find((w) => w.id === 'b'), false);
});

test('setWire: an image wire keeps its megapixels, 0 included', () => {
  const ws = migrateWires([{ id: 'a', from: 'x', to: 'y', kind: 'image' }, { id: 'b', from: 'x', to: 'y', kind: 'sound' }]);
  assert.equal(setWire(ws, 'a', { mp: 0 }).find((w) => w.id === 'a').mp, 0);
  assert.equal('mp' in setWire(setWire(ws, 'a', { mp: 2 }), 'a', { mp: null }).find((w) => w.id === 'a'), false);
  assert.equal('mp' in setWire(ws, 'b', { mp: 1 }).find((w) => w.id === 'b'), false);
});

test('setWire: on, frame, and n moves it among its kind', () => {
  let ws = renumber([W('a', 'i1', 't', 'image'), W('v', 'v1', 't', 'video'), W('b', 'i2', 't', 'image'), W('c', 'c1', 't', 'image'),
    W('f', 'v1', 't', 'image', { frame: 'first' })]);
  assert.equal(setWire(ws, 'zz', { on: false }), ws);
  let out = setWire(ws, 'a', { on: false });
  assert.equal(out.find((w) => w.id === 'a').on, false);
  assert.equal(ws[0].on, true);   // (the given list is left as it was)
  out = setWire(ws, 'f', { frame: 'playhead' });
  assert.equal(out.find((w) => w.id === 'f').frame, 'playhead');
  assert.equal(setWire(ws, 'a', { frame: 'last' }).find((w) => w.id === 'a').frame, undefined);   // (not a frame of a video)
  out = setWire(ws, 'c', { n: 1 });
  assert.deepEqual(inputsFor(out, 't').map((w) => [w.id, w.n]), [['c', 1], ['a', 2], ['b', 3], ['f', 4], ['v', 1]]);
  out = setWire(ws, 'a', { n: 99 });
  assert.deepEqual(inputsFor(out, 't').filter((w) => w.kind === 'image').map((w) => w.id), ['b', 'c', 'f', 'a']);
  out = setWire(ws, 'v', { n: 3 });
  assert.equal(out.find((w) => w.id === 'v').n, 1);
});

// ---- the wires as a one-way graph: what a chain reruns (chain-run.js) ----
import { downstream, upstream, chainOf, runOrder, remapIds, remapWired } from '../web/wire-rules.js';

test('downstream: frames fed through ON wires, each after all its sources', () => {
  // a -> b -> d, a -> c -> d, d -> e; x -> b; an off wire c -> f
  const ws = [W('1', 'a', 'b', 'image'), W('2', 'a', 'c', 'image'), W('3', 'c', 'd', 'image'), W('4', 'b', 'd', 'image'),
    W('5', 'd', 'e', 'video'), W('6', 'x', 'b', 'image'), W('7', 'c', 'f', 'image', { on: false })];
  const down = downstream(ws, 'a');
  assert.deepEqual(new Set(down), new Set(['b', 'c', 'd', 'e']));
  assert.ok(down.indexOf('d') > down.indexOf('b') && down.indexOf('d') > down.indexOf('c'));
  assert.equal(down.at(-1), 'e');
  assert.ok(!down.includes('f'), 'an off wire chains nothing');
  assert.ok(!down.includes('x') && !down.includes('a'));
  assert.deepEqual(chainOf(ws, 'a'), ['a', ...down]);
  assert.deepEqual(downstream(ws, 'e'), []);
  assert.deepEqual(chainOf(ws, 'e'), ['e']);
  assert.deepEqual(downstream(ws, 'c'), ['d', 'e']);
});

test('upstream: what feeds a frame, near and far, in run order', () => {
  const ws = [W('1', 'a', 'b', 'image'), W('2', 'b', 'c', 'image'), W('3', 'x', 'c', 'image'), W('4', 'y', 'x', 'image', { on: false })];
  const up = upstream(ws, 'c');
  assert.deepEqual(new Set(up), new Set(['a', 'b', 'x']));
  assert.ok(up.indexOf('a') < up.indexOf('b'));
  assert.deepEqual(upstream(ws, 'a'), []);
});

test('runOrder: ties go in wire order; a loop in a hand-edited list does not hang', () => {
  const ws = [W('1', 'p', 'q', 'image'), W('2', 'r', 's', 'image')];
  assert.deepEqual(runOrder(ws, ['s', 'q', 'r', 'p']), ['p', 'q', 'r', 's']);
  const loop = [W('1', 'a', 'b', 'image'), W('2', 'b', 'a', 'image')];
  assert.deepEqual(new Set(runOrder(loop, ['a', 'b'])), new Set(['a', 'b']));
  assert.deepEqual(new Set(downstream(loop, 'a')), new Set(['b']));
});

test('remapIds: the copied wires and old -> new ids; remapWired follows them', () => {
  const ws = [W('w1', 'i1', 'i2', 'image'), W('w2', 'v1', 'i2', 'image', { frame: 'last' }), W('w3', 'i2', 's1', 'image')];
  const { wires, ids } = remapIds(ws, { i1: 'c1', i2: 'c2' });
  assert.equal(wires.length, 1);
  assert.equal(ids.get('w1'), wires[0].id);
  assert.ok(!ids.has('w2') && !ids.has('w3'));
  assert.deepEqual(remapWired({ a: 'w1', b: 'w2', c: false }, ids), { a: wires[0].id, c: false });
  const all = remapIds(ws, { i2: 'c2' }, { inputs: true });
  assert.equal(all.wires.length, 2);
  assert.deepEqual(remapWired({ b: 'w2' }, all.ids), { b: all.ids.get('w2') });
  assert.equal(remap(ws, { i1: 'c1', i2: 'c2' }).length, 1);
});

test('replace: a wire takes a new source and keeps its place, id and size; the old crop goes', () => {
  const ws = [W('a', 'i1', 't', 'image', { n: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, mp: 0, on: false }), W('b', 'i2', 't', 'image', { n: 2 })];
  const r = replaceWire(ws, 'a', { from: 'c1' }, frames);
  assert.equal(r.why, null);
  assert.deepEqual(r.wires.map((w) => [w.id, w.from, w.n]), [['a', 'c1', 1], ['b', 'i2', 2]]);
  assert.equal(r.wire.crop, undefined);
  assert.equal(r.wire.mp, 0);
  assert.equal(r.wire.on, true);
  assert.equal(ws[0].from, 'i1');   // (what it was given is unchanged)
});

test('replace: a picture out of a video says which frame; a picture wire off a video drops it', () => {
  const ws = [W('a', 'i1', 't', 'image', { n: 1 })];
  assert.equal(replaceWire(ws, 'a', { from: 'v1', frame: 2.5 }, frames).wire.frame, 2.5);
  assert.equal(replaceWire(ws, 'a', { from: 'v1' }, frames).wire.frame, 'first');
  const fw = [W('a', 'v1', 't', 'image', { n: 1, frame: 1 })];
  assert.equal(replaceWire(fw, 'a', { from: 'i1' }, frames).wire.frame, undefined);
});

test('replace: refused for the wrong kind, a loop, a repeat, no change, nothing to give', () => {
  const ws = [W('a', 'i1', 't', 'image', { n: 1 }), W('b', 'i2', 't', 'image', { n: 2 }), W('c', 't', 'i2', 'image', { n: 1 })];
  assert.equal(replaceWire(ws, 'a', { from: 's1' }, frames).why, 'wrong-kind');
  assert.equal(replaceWire(ws, 'b', { from: 'i1' }, frames).why, 'exists');
  assert.equal(replaceWire(ws, 'a', { from: 'i1' }, frames).why, 'same');
  assert.equal(replaceWire(ws, 'a', { from: 'e1' }, frames).why, 'no-output');
  assert.equal(replaceWire(ws, 'nope', { from: 'i1' }, frames).why, 'missing');
  const loop = [W('a', 'i1', 't', 'image', { n: 1 }), W('c', 't', 'i2', 'image', { n: 1 })];
  assert.equal(replaceWire(loop, 'a', { from: 'i2' }, frames).why, 'cycle');
});
