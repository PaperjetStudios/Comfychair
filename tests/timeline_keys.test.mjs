// node --test tests/timeline_keys.test.mjs: the timeline's keys (web/timeline-keys.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandFor, comboKeys, keysHelp, plainKeys } from '../web/timeline-keys.js';

const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...o });
// the keys web/playback.js playKeys owns (its table and the work area's I / O / Alt+X), lower-cased
const OWNED = [' ', 'k', 'p', 'arrowleft', 'arrowright', ',', '.', 'arrowup', 'arrowdown', 'home', 'end', 'i', 'o', 'x'];

test('no key combination is bound to two commands', () => {
  const seen = new Map();
  for (const [id, key, ctrl, shift, alt] of COMMANDS) {
    const sig = [key, ctrl, shift, alt].join('|');
    assert.ok(!seen.has(sig), `${sig} is both ${seen.get(sig)} and ${id}`);
    seen.set(sig, id);
  }
});
test('no plain key collides with playKeys or the work area', () => {
  for (const [id, key, ctrl, , alt] of COMMANDS) {
    if (ctrl) continue;
    // Alt+arrows differ from the bare arrows playKeys owns; Alt+X clears the work area, so x stays out
    if (alt && key.startsWith('arrow')) continue;
    assert.ok(!OWNED.includes(key), `${id} takes ${key}`);
  }
});
test('commandFor reads the keys the brief names', () => {
  assert.equal(commandFor(ev('z', { ctrlKey: true })), 'undo');
  assert.equal(commandFor(ev('Z', { ctrlKey: true, shiftKey: true })), 'redo');
  assert.equal(commandFor(ev('y', { metaKey: true })), 'redo');
  assert.equal(commandFor(ev('j', { ctrlKey: true })), 'duplicate');
  assert.equal(commandFor(ev('Delete')), 'delete');
  assert.equal(commandFor(ev('Backspace')), 'delete');
  assert.equal(commandFor(ev('Delete', { shiftKey: true })), 'rippleDelete');
  assert.equal(commandFor(ev('ArrowLeft', { altKey: true })), 'nudgeLeft');
  assert.equal(commandFor(ev('ArrowRight', { altKey: true, shiftKey: true })), 'nudgeRight');
  assert.equal(commandFor(ev('ArrowRight')), null);
  assert.equal(commandFor(ev('s')), 'split');
  assert.equal(commandFor(ev('s', { ctrlKey: true })), null);
  assert.equal(commandFor(ev('+', { shiftKey: true })), 'zoomIn');
  assert.equal(commandFor(ev('=')), 'zoomIn');
  assert.equal(commandFor(ev('-')), 'zoomOut');
  assert.equal(commandFor(ev('Escape')), 'deselect');
  assert.equal(commandFor(ev('s', { repeat: true })), null);
});
test('comboKeys and plainKeys split the table; every plain tool key is there', () => {
  assert.deepEqual(comboKeys().sort(), ['a', 'c', 'j', 'v', 'x', 'y', 'z', 'z'].sort());
  for (const k of ['v', 'c', 'b', 'y', 'h', 's', 'm', 'escape', 'delete', '=', '+', '-']) assert.ok(plainKeys().includes(k), k);
  assert.equal(comboKeys().length + plainKeys().length, COMMANDS.length);
});
test('keysHelp lists each command once with its keys', () => {
  const l = keysHelp();
  assert.ok(l.every((x) => x.keys && x.label));
  assert.ok(l.some((x) => x.keys.includes('Ctrl+Shift+Z') && x.keys.includes('Ctrl+Y')));
});
