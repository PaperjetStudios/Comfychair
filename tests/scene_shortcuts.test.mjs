// node --test tests/scene_shortcuts.test.mjs: the 3D tab's one-key commands (web/scene-shortcuts.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, commandFor, keysText } from '../web/scene-shortcuts.js';

const press = (key, mods = {}) => commandFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods });

test('no key means two things', () => {
  const seen = COMMANDS.map(([, key, shift]) => `${key}${shift}`);
  assert.equal(new Set(seen).size, seen.length);
});

test('none takes a key the tab already uses', () => {
  // W E R Q gizmo, K auto key, V director view, H tools, N panel, P play, I O range, S (no Shift) stretch on the sheet,
  // A (no Shift) and X the sheet's selection
  const taken = new Set(['w', 'e', 'r', 'q', 'k', 'v', 'h', 'n', 'p', 'i', 'o', 's', 'a', 'x']);
  for (const [id, key, shift] of COMMANDS) assert.ok(shift || !taken.has(key), `${id} takes ${key}`);
});

test('the camera keys', () => {
  assert.equal(press('c'), 'camToView');
  assert.equal(press('C', { shiftKey: true }), 'newCamera');
  assert.equal(press('V', { shiftKey: true }), 'viewCut');
  assert.equal(press('v'), null);   // (still the director view, the tab's own)
});

test('Shift matters, with a capital in e.key', () => {
  assert.equal(press('j'), 'addKey');
  assert.equal(press('J', { shiftKey: true }), 'delKey');
  assert.equal(press('a'), null);
  assert.equal(press('A', { shiftKey: true }), 'add');
});

test('? works with or without Shift (keyboard layouts differ)', () => {
  assert.equal(press('?', { shiftKey: true }), 'keysHelp');
  assert.equal(press('?'), 'keysHelp');
});

test('Ctrl, Cmd, Alt and a held key run nothing (Ctrl+C copies keys; a held Shift+C mustn\'t make many cameras)', () => {
  assert.equal(press('c', { ctrlKey: true }), null);
  assert.equal(press('c', { metaKey: true }), null);
  assert.equal(press('c', { altKey: true }), null);
  assert.equal(press('C', { shiftKey: true, repeat: true }), null);
});

test('the list names every command', () => {
  const text = keysText();
  for (const [, , , what] of COMMANDS) assert.ok(text.includes(what), what);
  assert.ok(text.includes('Shift+C new camera'));
});
