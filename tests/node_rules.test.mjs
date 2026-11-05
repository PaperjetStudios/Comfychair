// node --test tests/node_rules.test.mjs: what a wire let go on empty table can start (web/node-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { templatesForFrame } from '../web/make-rules.js';
import { nodeGroups, otherTemplates, slotFor, nodeMake, nodeSize, emptyFeeders, landsIn } from '../web/node-rules.js';

const T = (id, media, fields, more = {}) => ({ id, name: id, media, fields, ...more });
const img = { key: 'img.image', kind: 'image' }, vid = { key: 'src.video', kind: 'video' };
const secs = { key: 'secs.value', kind: 'float', label: 'Length (seconds)', value: 10 };
const tpls = [
  T('deck-depth-image', 'image', [img]), T('deck-canny-image', 'image', [img]), T('deck-upscale-image', 'image', [img]),
  T('deck-depth-video', 'video', [vid, secs]), T('deck-upscale-video', 'video', [vid]),
  T('deck-pose-image', 'image', [img], { error: 'a node is missing' }),
  T('mine-i2v', 'video', [img], { name: 'My animate' }), T('mine-song', 'audio', [{ key: 'a', kind: 'audio' }]),
  T('deck-3d-object', 'image', [img]),
];
const ids = (gs) => gs.flatMap((g) => g.items.map((i) => i.id));

test('a picture offers its maps and tools, only where the template is there and has no error', () => {
  const gs = nodeGroups(tpls, 'image');
  assert.deepEqual(gs.map((g) => g.title), ['Maps', 'Tools']);
  assert.deepEqual(ids(gs), ['depth', 'canny', 'up']);
  assert.equal(gs[0].items[0].kind, 'image');
  assert.equal(gs[0].items[0].keepSize, true);
});

test('a clip offers video templates only; a sound offers no maps', () => {
  const gs = nodeGroups(tpls, 'video');
  assert.deepEqual(gs.flatMap((g) => g.items.map((i) => i.tpl)), ['deck-depth-video', 'deck-upscale-video']);
  assert.equal(gs[0].items[0].keepSize, false);
  assert.deepEqual(nodeGroups(tpls, 'sound'), []);
});

test('search finds the other templates that take the wire, not those already shown', () => {
  assert.deepEqual(otherTemplates(tpls, 'image', 'animate').map((t) => t.id), ['mine-i2v']);
  assert.ok(!otherTemplates(tpls, 'image').some((t) => t.id === 'deck-depth-image'));
  assert.ok(!otherTemplates(tpls, 'image').some((t) => t.error));
  assert.deepEqual(otherTemplates(tpls, 'sound').map((t) => t.id), ['mine-song']);
});

test('a template lands in the frame kind of what it makes', () => {
  assert.equal(landsIn(T('x', 'video', [])), 'video');
  assert.equal(landsIn(T('x', 'audio', [])), 'sound');
  assert.equal(landsIn(T('deck-3d-object', 'image', [])), 'scene');
});

test('a new node points its slot at the wire, so a result in the frame never takes the slot back', () => {
  const m = nodeMake(tpls[0], 'w1', 'image');
  assert.deepEqual(m.wired, { 'img.image': 'w1' });
  assert.equal(m.template, 'deck-depth-image');
  assert.equal(slotFor(tpls[0], 'video'), null);
});

test('a clip node runs for the source clip, up to the longest the maps are tested at', () => {
  const t = tpls[3];
  assert.equal(nodeMake(t, 'w', 'video', 7.5).overrides['secs.value'], 7.5);
  assert.equal(nodeMake(t, 'w', 'video', 90).overrides['secs.value'], 20);
  assert.deepEqual(nodeMake(t, 'w', 'video', 0).overrides, {});
  assert.deepEqual(nodeMake(t, 'w', 'image', 7).overrides, {});
});

test('a node comes out at its source size; a sound source has no picture size', () => {
  assert.deepEqual(nodeSize({ kind: 'image', w: 300, h: 200, out: { w: 1536, h: 864 } }), { w: 1536, h: 864 });
  assert.deepEqual(nodeSize({ kind: 'sound', w: 1024, h: 256 }, 'video'), { w: 1024, h: 576 });
});

test('the run button runs nodes that feed it and never ran, first; never a plain clip that only holds a template', () => {
  const tpl = { template: 't' };
  const frames = [{ id: 'clip', make: tpl }, { id: 'a', make: tpl }, { id: 'b', make: tpl }, { id: 'c' }, { id: 'd', make: tpl }, { id: 'off', make: tpl }, { id: 'ran', make: { ...tpl, ran: {} } }];
  const wires = [{ from: 'clip', to: 'a', on: true }, { from: 'a', to: 'b', on: true }, { from: 'b', to: 'd', on: true }, { from: 'c', to: 'd', on: true }, { from: 'off', to: 'd', on: false }, { from: 'clip', to: 'ran', on: true }, { from: 'ran', to: 'd', on: true }];
  assert.deepEqual(emptyFeeders(wires, frames, 'd', () => true), ['a', 'b']);
  assert.deepEqual(emptyFeeders(wires, frames, 'd', (f) => f.id === 'b'), ['b']);
  assert.deepEqual(emptyFeeders(wires, frames, 'clip', () => true), []);
});

test('a node keeps its tool template, of its own media only, though the picker hides tool templates', () => {
  const depth = tpls[0];
  assert.ok(templatesForFrame([depth], 'image', { make: { template: depth.id } }).includes(depth));
  assert.ok(!templatesForFrame([depth], 'video', { make: { template: depth.id } }).includes(depth));
  assert.ok(!templatesForFrame([depth], 'image', { make: { template: 'other' } }).includes(depth));
});
