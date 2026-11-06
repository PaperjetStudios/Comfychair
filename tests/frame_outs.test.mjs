// A 3D frame's renders as takes of its out pins (web/frame-outs.js), and wires from those pins (web/wire-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../web/frame-outs.js';
import * as W from '../web/wire-rules.js';

const scene = (outs) => ({ id: 's', kind: 'scene', doc: 'd', outs });

test('takes: a new render is carried by its pin, older ones stay as takes', () => {
  let outs = O.keepOuts([], 'depth', 'video', [{ gen: 5 }], 1);
  outs = O.keepOuts(outs, 'depth', 'video', [{ gen: 9 }], 2);
  outs = O.keepOuts(outs, 'frame', 'image', [{ input: 'a/f.png' }], 3);
  outs = O.keepOuts(outs, 'pose', 'video', [{ gen: 11, shot: 1 }, { gen: 12, shot: 2 }], 4);
  const pins = O.outsOf(scene(outs));
  assert.deepEqual(pins.map((p) => p.id), ['depth-video', 'pose-video-1', 'pose-video-2', 'frame-image']);
  assert.equal(pins[0].gen, 9); assert.equal(pins[0].count, 2);
  assert.equal(O.outLabel(pins[1]), 'Pose video · shot 1');
  assert.equal(O.outLabel(pins[3]), 'Frame');
  const takes = O.takesFor(scene(outs), 'depth-video');
  assert.deepEqual(takes.map((t) => [t.gen, t.on]), [[9, true], [5, false]]);
  // choose the older one, then take the carried one off: the newest left is carried
  const old = takes[1].id;
  outs = O.useTake(outs, old);
  assert.equal(O.outOf(scene(outs), 'depth-video').gen, 5);
  outs = O.keepOuts(outs, 'depth', 'video', [{ gen: 20 }], 5);
  assert.equal(O.outOf(scene(outs), 'depth-video').gen, 20);   // (a new render takes over)
  outs = O.dropTakes(outs, [O.outOf(scene(outs), 'depth-video').take]);
  assert.equal(O.outOf(scene(outs), 'depth-video').gen, 9);
  outs = O.dropPin(outs, 'depth-video');
  assert.equal(O.outOf(scene(outs), 'depth-video'), null);
  assert.equal(O.outsOf(scene(outs)).length, 3);
});

test('takes: bad entries and other frame kinds put nothing out', () => {
  assert.deepEqual(O.outsOf({ kind: 'image', outs: [{ kind: 'depth', type: 'video', gen: 1 }] }), []);
  assert.deepEqual(O.outsOf(scene([{ kind: 'depth', type: 'video' }, { kind: 'x', type: 'video', gen: 1 }, { kind: 'pose', type: 'image', input: '' }])), []);
  assert.equal(O.keepOuts([], 'depth', 'video', []).length, 0);
  assert.equal(O.keepOuts([], 'depth', 'video', [{ input: 'p.png' }]).length, 0);   // (a video take needs a run)
});

test('wires from a render pin: its kind, its own identity, replaced and kept through migrate', () => {
  const outs = O.keepOuts(O.keepOuts([], 'depth', 'video', [{ gen: 3 }]), 'pose', 'image', [{ input: 'p.png' }]);
  const s = scene(outs), v = { id: 'v', kind: 'video', doc: 'x' }, frames = [s, v];
  assert.deepEqual(W.outPins(s).map((p) => [p.id, p.kind]), [['depth-video', 'video'], ['pose-image', 'image']]);
  let r = W.addWire([], { from: 's', to: 'v', out: 'depth-video' }, frames);
  assert.equal(r.why, null); assert.equal(r.wire.kind, 'video'); assert.equal(r.wire.out, 'depth-video');
  assert.equal(W.addWire(r.wires, { from: 's', to: 'v', out: 'depth-video' }, frames).why, 'exists');
  assert.equal(W.addWire(r.wires, { from: 's', to: 'v', out: 'nope' }, frames).why, 'no-output');
  assert.equal(W.addWire(r.wires, { from: 's', to: 'v', out: 'depth-video', kind: 'image' }, frames).why, 'wrong-kind');
  const r2 = W.addWire(r.wires, { from: 's', to: 'v', out: 'pose-image' }, frames);
  assert.equal(r2.why, null);
  const r3 = W.addWire(r2.wires, { from: 's', to: 'v' }, frames);   // (the frame's own still: a wire of its own)
  assert.equal(r3.why, null); assert.equal(r3.wire.out, undefined);
  assert.equal(W.pinLabelOf(r2.wire, s), 'Pose picture');
  assert.equal(W.isFrameWire(r2.wire), false);
  // the still wire taken over by the pose pin: refused, it is there already; the depth pin can't go in a picture slot
  assert.equal(W.replaceWire(r3.wires, r3.wire.id, { from: 's', out: 'pose-image' }, frames).why, 'exists');
  assert.equal(W.replaceWire(r3.wires, r3.wire.id, { from: 's', out: 'depth-video' }, frames).why, 'wrong-kind');
  const m = W.migrateWires(r3.wires, frames);
  assert.deepEqual(m.map((w) => w.out ?? null), ['depth-video', 'pose-image', null]);
});
