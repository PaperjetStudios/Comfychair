// node --test tests/wire_rules.test.mjs: wires between a table's frames (web/wire-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldKind, wireLabel, outKind, renumber, migrateWires, cycle, addWire, removeWires, dropFrames, inputsFor, mapToFields, remap,
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
