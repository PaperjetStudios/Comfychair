// node --test tests/char_outs.test.mjs: a character frame's pins (web/char-outs.js) and wires from them (web/wire-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../web/char-outs.js';
import * as M from '../web/char-model.js';
import * as W from '../web/wire-rules.js';

const doc = () => ({ id: 'c', rev: 1, name: 'Mara', payload: {
  looks: [{ id: 'main', name: 'Main', text: 'red coat', main: 'b.png', views: { front: 'f.png', side: 's.png' }, sheet: 'sheet.png', expressions: { happy: 'h.png' } },
    { id: 'w', name: 'Winter', text: 'blue coat', main: null, views: { back: 'wb.png' }, sheet: null, expressions: {} }],
  active: 'main',
  media: [{ id: 'm0', kind: 'image', src: { input: 'a.png' }, role: 'ref' }, { id: 'm1', kind: 'image', src: { input: 'b.png' }, role: 'face' },
    { id: 'm2', kind: 'image', src: { input: 'scar.png' }, role: 'detail', label: 'scar' },
    { id: 'm3', kind: 'image', src: { input: 'bust.png' }, role: 'sheet', label: 'Bust' },
    { id: 'm4', kind: 'image', src: { input: 'wc.png' }, role: 'ref', look: 'w' }] } });
const frame = (pins) => ({ id: 'ch', kind: 'character', doc: 'c', label: 'Mara', x: 0, y: 0, w: 200, h: 200, pins });

test('pins: main, views, sheets, expressions, details, in a steady order', () => {
  const c = M.fromDoc(doc());
  const pins = C.pinsOf(c);
  assert.deepEqual(pins.map((p) => p.id), ['main', 'view:front', 'view:side', 'sheet', 'sheet:m3', 'expr:happy', 'detail:m2']);
  assert.equal(pins[0].input, 'b.png');
  assert.equal(pins[1].label, 'Front');
  assert.equal(pins[4].label, 'Sheet · Bust');
  assert.equal(pins[6].label, 'Detail · scar');
  assert.ok(pins.every((p) => p.kind === 'image'));
});

test('pins follow the look asked for; a look with no main picture falls back to its first picture', () => {
  const c = M.fromDoc(doc());
  const pins = C.pinsOf(c, 'w');
  // (media with no look belongs to every look, as char-model's pics says: the bust sheet and the detail show here too)
  assert.deepEqual(pins.map((p) => p.id), ['main', 'view:back', 'sheet:m3', 'detail:m2']);
  assert.equal(pins[0].input, 'a.png');   // (no main: the first of its pictures)
  assert.deepEqual(C.pinsOf(M.fromDoc({ id: 'e', rev: 1, name: 'Empty', payload: {} })), []);
  assert.deepEqual(C.pinsOf(null), []);
});

test('mirrorPins copies the pins onto the frame once, and only when they changed', () => {
  const c = M.fromDoc(doc());
  const f0 = frame(undefined);
  const f1 = C.mirrorPins(f0, c);
  assert.notEqual(f1, f0);
  assert.equal(C.charPins(f1).length, 7);
  assert.equal(C.mirrorPins(f1, c), f1);   // (nothing changed: the same frame back)
  c.views.front = 'f2.png';                // (a view made again)
  const f2 = C.mirrorPins(f1, c);
  assert.notEqual(f2, f1);
  assert.equal(C.charPin(f2, 'view:front').input, 'f2.png');
  assert.equal(C.mirrorPins({ id: 'i', kind: 'image' }, c).kind, 'image');   // (not a character frame: left alone)
});

test('charPins reads a saved copy made whole: no repeats, no half pins, no other kinds', () => {
  const f = frame([{ id: 'main', input: 'b.png' }, { id: 'main', input: 'x.png' }, { id: 'view:front' }, null, { id: 'sheet', input: 's.png', label: 'Sheet' }]);
  assert.deepEqual(C.charPins(f).map((p) => [p.id, p.input, p.label]), [['main', 'b.png', 'main'], ['sheet', 's.png', 'Sheet']]);
  assert.deepEqual(C.charPins({ kind: 'scene', pins: [{ id: 'main', input: 'b.png' }] }), []);
  assert.equal(C.charPinLabel(f, 'sheet'), 'Sheet');
  assert.equal(C.charPinLabel(f, 'view:back'), 'a picture that is gone');
});

test('wires: a character frame has an image port only once it has pictures, and its pins plug by id', () => {
  const c = M.fromDoc(doc());
  const bare = frame([]);
  assert.deepEqual(W.outKinds(bare), []);
  const f = C.mirrorPins(bare, c);
  assert.deepEqual(W.outKinds(f), ['image']);
  assert.deepEqual(W.outPins(f).map((p) => p.id), C.pinsOf(c).map((p) => p.id));
  assert.equal(W.outPin(f, 'view:side').label, 'Side');
  assert.equal(W.pinLabelOf({ out: 'view:side' }, f), 'Side');
  assert.equal(W.pinLabelOf({ out: 'view:nope' }, f), 'a picture that is gone');
  // a wire from a pin into a frame's picture field survives migration while the pin's frame is there
  const target = { id: 't', kind: 'image', doc: 'd' };
  const wires = W.migrateWires([{ id: 'w1', from: 'ch', to: 't', kind: 'image', out: 'view:side' }], [f, target]);
  assert.equal(wires.length, 1); assert.equal(wires[0].out, 'view:side');
  assert.deepEqual(W.migrateWires(wires, [target]), []);   // (the character frame gone: the wire goes)
});
