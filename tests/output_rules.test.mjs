// node --test tests/output_rules.test.mjs: what a frame's Output tab owns, not its workflow (web/make-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameLength, lengthField, lengthValue, outputOwns } from '../web/make-rules.js';

const w = { key: '7.width', node: '7', kind: 'int', input: 'width' }, h = { key: '7.height', node: '7', kind: 'int', input: 'height' };
const len = { key: '16.value', kind: 'int', label: 'Length (seconds)', value: 5 }, steps = { key: '10.steps', kind: 'int', label: 'Steps', value: 8 };
const t = { fields: [w, h, len, steps] };

test('a video frame leaves its size and length to the Output tab, and only those', () => {
  for (const f of [w, h, len]) assert.equal(outputOwns(t, 'video', f), true);
  assert.equal(outputOwns(t, 'video', steps), false);
});

test('an image frame owns its size; a sound frame its length; nothing selected, or 3D, keeps them in the workflow', () => {
  assert.equal(outputOwns(t, 'image', w), true);
  assert.equal(outputOwns(t, 'image', len), false);
  assert.equal(outputOwns(t, 'sound', len), true);
  assert.equal(outputOwns(t, 'sound', w), false);
  for (const k of ['none', 'scene']) { assert.equal(outputOwns(t, k, w), false); assert.equal(outputOwns(t, k, len), false); }
});

test('a frame\'s length: the Output tab\'s, else what its settings said, else the template\'s', () => {
  assert.equal(frameLength({ len: 9, make: { overrides: { '16.value': 7 } } }, t), 9);
  assert.equal(frameLength({ make: { overrides: { '16.value': 7 } } }, t), 7);
  assert.equal(frameLength({}, t), 5);
  assert.equal(frameLength({ len: 9 }, { fields: [steps] }), null);
  assert.equal(frameLength({ len: 9 }, null), null);
  assert.equal(lengthField({ fields: [steps] }), null);
});

test('a length goes in as its field takes it', () => {
  assert.equal(lengthValue(len, 4.6), 5);
  assert.equal(lengthValue({ kind: 'float' }, 4.5), 4.5);
});
