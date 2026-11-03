// node --test tests/edit_image.test.mjs: what the Edit image tool tells the model (web/edit-image.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { asRefs, editChoices, editPrompt, layerWord, refSlots, seedStep, sigmasFor, usableLoras } from '../web/edit-image.js';

test('the prompt, the context and the sentence that holds the rest still, in that order', () => {
  const t = editPrompt({ prompt: ' Make the jacket red. ', context: 'It is a film still.', keep: true });
  assert.match(t, /^Make the jacket red\. It is a film still\. Change only what is asked\./);
});

test('without keep or context only the prompt goes', () => {
  assert.equal(editPrompt({ prompt: 'Make it night', keep: false }), 'Make it night');
});

test('{layer} becomes the layer name everywhere, and "the picture" for the whole picture', () => {
  assert.equal(editPrompt({ prompt: 'Restyle {layer}', context: 'This is {layer}', keep: false, layer: 'hero' }), 'Restyle hero This is hero');
  assert.equal(editPrompt({ prompt: 'Restyle {layer}', keep: false }), 'Restyle the picture');
});

test('a wildcard is left for the server', () => {
  assert.equal(editPrompt({ prompt: 'Make it {red|blue}', keep: false, layer: 'x' }), 'Make it {red|blue}');
});

test('a layer is called by its label, then its file name', () => {
  assert.equal(layerWord({ label: 'Hero', name: 'a/b.png' }), 'Hero');
  assert.equal(layerWord({ name: 'comfydeck/shot.01.png' }), 'shot.01');
  assert.equal(layerWord(null), '');
});

test('random seeds stay random and leave the kept seed alone', () => {
  assert.deepEqual(seedStep('random', 7, 3), { use: -1, next: 7 });
});

test('a fixed seed is the same on every picture', () => {
  assert.deepEqual(seedStep('fixed', 7, 3), { use: 7, next: 7 });
});

test('+1 each run counts past the variations, so no two runs share a seed', () => {
  assert.deepEqual(seedStep('increment', 7, 3), { use: 7, next: 10 });
});

test('8 steps is the model\'s own list', () => {
  assert.equal(sigmasFor(8), '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0');
});

test('any step count starts at 1, ends at 0 and only goes down', () => {
  for (const n of [1, 4, 6, 12, 16]) {
    const s = sigmasFor(n).split(', ').map(Number);
    assert.equal(s.length, n + 1);
    assert.equal(s[0], 1);
    assert.equal(s[n], 0);
    for (let i = 1; i <= n; i++) assert.ok(s[i] < s[i - 1]);
  }
});

test('only LoRAs that are named, on and installed are used', () => {
  const rows = [{ name: 'a', strength: 1 }, { name: '', strength: 1 }, { name: 'b', enabled: false }, { name: 'gone' }];
  assert.deepEqual(usableLoras(rows, ['a', 'b']).map((l) => l.name), ['a']);
});

test('references saved as bare names come back as { name }; holes go', () => {
  assert.deepEqual(asRefs(['a.png', { name: 'b.png', crop: { x: 0, y: 0, w: 1, h: 1 } }, null, '']), [{ name: 'a.png' }, { name: 'b.png', crop: { x: 0, y: 0, w: 1, h: 1 } }]);
  assert.deepEqual(asRefs(undefined), []);
});

test('picking several fills the slot, then the empty ones, up to the most', () => {
  assert.deepEqual(refSlots(0, 0, 3), [0, 1, 2]);   // the first empty slot
  assert.deepEqual(refSlots(0, 2, 3), [0, 2]);      // a used slot, with one empty
  assert.deepEqual(refSlots(2, 2, 3), [2]);         // the last empty slot
  assert.deepEqual(refSlots(1, 3, 3), [1]);         // all used: only itself
});

test('a chosen model or sampler goes only if the template still offers it', () => {
  const fields = [{ kind: 'choice', key: 'm', options: ['a', 'b'] }, { kind: 'choice', key: 's', options: ['euler'] }, { kind: 'text', key: 'p' }];
  assert.deepEqual(editChoices(fields, { m: 'b', s: 'gone', p: 'x' }), { m: 'b' });
  assert.deepEqual(editChoices(fields, {}), {});
});
