// node --test tests/setups_rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { differs, editKey, forKey, fromPreset, omit, pick, sceneKey, sortSetups, soundMakerKey, stable, toSetup, toolKey, tplKey, tplOfKey, vfxKey, SOUND_VOICE } from '../web/setups-rules.js';

test('keys name the block', () => {
  assert.equal(tplKey('deck-qwen21-edit'), 'tpl:deck-qwen21-edit');
  assert.equal(editKey('video', 'restyle'), 'edit:video.restyle');
  assert.equal(editKey('image', 'edit'), 'tool:edit');   // the Edit pane's image ops are the Image tools
  assert.equal(toolKey('edit'), 'tool:edit');
  assert.equal(vfxKey('ripple'), 'vfx:ripple');
  assert.equal(soundMakerKey('music'), 'sound:maker.music');
  assert.equal(SOUND_VOICE, 'sound:voice');
  assert.equal(sceneKey('out'), 'scene:out');
  assert.equal(editKey('video', null), null);
  assert.equal(tplOfKey('tpl:abc'), 'abc');
  assert.equal(tplOfKey('vfx:abc'), null);
});

test('differs compares values by JSON, key order and missing keys aside', () => {
  assert.equal(differs({ a: 1, b: { x: 1, y: [1, 2] } }, { b: { y: [1, 2], x: 1 }, a: 1 }), false);
  assert.equal(differs({ a: 1 }, { a: 2 }), true);
  assert.equal(differs({ a: 1, b: null }, { a: 1 }), false);
  assert.equal(differs({ a: 1, b: 'x' }, { a: 1 }), true);
  assert.equal(differs({ loras: [{ name: 'a', s: 1 }] }, { loras: [{ name: 'a', s: 0.8 }] }), true);
  assert.equal(differs(null, {}), false);
  assert.equal(stable({ b: 1, a: [undefined, { d: 2, c: 1 }] }), '{"a":[null,{"c":1,"d":2}],"b":1}');
});

test('sortSetups: newest first, then by name; forKey keeps one block', () => {
  const list = [{ id: 1, name: 'b', updated: 5, key: 'k' }, { id: 2, name: 'a', updated: 9, key: 'k' }, { id: 3, name: 'a', updated: 5, key: 'j' }];
  assert.deepEqual(sortSetups(list).map((s) => s.id), [2, 3, 1]);
  assert.deepEqual(forKey(list, 'k').map((s) => s.id), [1, 2]);
  assert.deepEqual(sortSetups(null), []);
});

test('documents become setups; old presets become read-only template entries', () => {
  const s = toSetup({ id: 'x', name: 'Night', rev: 2, updated: 7, payload: { v: 1, key: 'tool:edit', values: { eprompt: 'night' } } });
  assert.deepEqual(s, { id: 'x', name: 'Night', rev: 2, updated: 7, key: 'tool:edit', values: { eprompt: 'night' }, note: null });
  const p = fromPreset({ id: 'p1', name: 'Fast', rev: 1, payload: { v: 1, template: 'deck-krea2-t2i', values: { '3.steps': 4 } } });
  assert.equal(p.key, 'tpl:deck-krea2-t2i');
  assert.equal(p.readOnly, true);
  assert.equal(p.name, 'Fast (project)');
});

test('pick and omit copy', () => {
  const o = { a: { n: 1 }, b: 2, c: undefined };
  const p = pick(o, ['a', 'c', 'z']);
  assert.deepEqual(p, { a: { n: 1 } });
  p.a.n = 5;
  assert.equal(o.a.n, 1);
  assert.deepEqual(omit(o, ['a']), { b: 2 });
});
