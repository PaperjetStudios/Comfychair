// node --test tests/key_focus.test.mjs: who gets a key while a control has the focus (web/key-focus.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorRunKey, editorRunKeys, ownsKey } from '../web/key-focus.js';

// a fake element: tag + attributes, inside the parents given (selectors are matched on the simple forms key-focus uses)
function el(tag, { type, cls, role, parent = null } = {}) {
  const me = {
    tag, type, parent,
    matches(sel) {
      if (sel === '.scrub') return cls === 'scrub';
      return sel.split(',').map((s) => s.trim()).some((s) => s === tag || (role && s === `[role=${role}]`));
    },
    closest(sel) { for (let n = me; n; n = n.parent) if (n.matches(sel)) return n; return null; },
  };
  return me;
}
const owns = (target, key = ' ', opts = {}) => ownsKey({ target, key }, { keyboard: false, ...opts });
const tabbed = (target, key = ' ') => owns(target, key, { keyboard: true });

test('nothing focused: the shortcut runs', () => {
  assert.equal(owns(el('body')), false);
  assert.equal(owns(el('div', { parent: el('body') }), 'i'), false);
  assert.equal(tabbed(el('body')), false);
});

test('a clicked button or tab gives its keys up; one reached with Tab keeps them', () => {
  assert.equal(owns(el('button')), false);
  assert.equal(owns(el('button'), 'ArrowLeft'), false);
  assert.equal(tabbed(el('button')), true);
  assert.equal(owns(el('div', { role: 'tab' })), false);
  assert.equal(tabbed(el('div', { role: 'tab' })), true);
  assert.equal(owns(el('span', { parent: el('button') })), false);   // (the icon inside a button)
  assert.equal(tabbed(el('span', { parent: el('button') })), true);
});

test('typing is never interrupted', () => {
  for (const key of [' ', 'i', 'ArrowLeft']) {
    assert.equal(owns(el('input', { type: 'text' }), key), true);
    assert.equal(owns(el('input', { type: 'number' }), key), true);
    assert.equal(owns(el('textarea'), key), true);
    assert.equal(owns(el('select'), key), true);
  }
});

test('a slider keeps the keys that move it, and the rest go to the player', () => {
  const slider = el('input', { type: 'range' });
  assert.equal(owns(slider, 'ArrowLeft'), true);
  assert.equal(owns(slider, 'Home'), true);
  assert.equal(owns(slider, ' '), false);
  assert.equal(owns(slider, 'i'), false);
});

test("the player's own scrub bar gives every key to the player", () => {
  const scrub = el('input', { type: 'range', cls: 'scrub' });
  assert.equal(owns(scrub, 'ArrowLeft'), false);
  assert.equal(owns(scrub, 'End'), false);
});

test('a checkbox: clicked gives up its keys, reached with Tab keeps them', () => {
  assert.equal(owns(el('input', { type: 'checkbox' })), false);
  assert.equal(tabbed(el('input', { type: 'checkbox' })), true);
});

test('a dialog keeps every key', () => {
  assert.equal(owns(el('div', { parent: el('div', { role: 'dialog' }) })), true);
  assert.equal(owns(el('button', { parent: el('div', { role: 'dialog' }) })), true);
});

test('a player inside a dialog still gets its keys, and typing there still wins', () => {
  const dialog = el('div', { role: 'dialog' });
  const inDialog = (target, key = ' ') => owns(target, key, { dialog: false });
  assert.equal(inDialog(el('div', { parent: dialog })), false);
  assert.equal(inDialog(el('button', { parent: dialog })), false);
  assert.equal(inDialog(el('input', { type: 'text', parent: dialog })), true);
});

// A fake control inside a panel section with the title given.
function inSection(title, tag = 'textarea', type) {
  const section = { closest: () => null, querySelector: () => ({ textContent: title }) };
  const me = {
    type,
    closest(sel) {
      if (sel === 'section') return title ? section : null;
      return sel.split(',').map((s) => s.trim()).includes(tag) ? me : null;
    },
  };
  return me;
}
const run = (target, mods) => editorRunKey({ target, key: 'Enter', ...mods });
const ctrl = { ctrlKey: true }, shift = { shiftKey: true };

test('Ctrl+Enter on the Editor tab: the tool, from its own boxes or with nothing focused', () => {
  assert.equal(run(inSection('Image tools'), ctrl), 'tool');
  assert.equal(run(inSection('Image tools', 'input', 'number'), ctrl), 'tool');
  assert.equal(run(inSection('Image tools', 'select'), ctrl), 'tool');
  assert.equal(run(inSection(null, 'body'), ctrl), 'tool');
  assert.equal(run(inSection(null, 'body'), { metaKey: true }), 'tool');
});

test('Inpaint: Ctrl+Enter is Fill, Shift+Enter stays a new line', () => {
  assert.equal(run(inSection('Inpaint and extend'), ctrl), 'fill');
  assert.equal(run(inSection('Inpaint and extend'), shift), null);
});

test('a box being typed in on another panel runs nothing; a slider there does not count as typing', () => {
  assert.equal(run(inSection('Layer', 'input', 'text'), ctrl), null);
  assert.equal(run(inSection('Layer', 'input', 'number'), shift), null);
  assert.equal(run(inSection('Layer'), ctrl), null);
  assert.equal(run(inSection('Layer', 'input', 'range'), ctrl), 'tool');
  assert.equal(run(inSection('Layer', 'input', 'checkbox'), ctrl), 'tool');
});

test('only Ctrl+Enter or Shift+Enter are run keys', () => {
  const keys = (k) => editorRunKeys({ key: 'Enter', ...k });
  assert.equal(keys(ctrl), true);
  assert.equal(keys(shift), true);
  assert.equal(keys({ metaKey: true }), true);
  assert.equal(keys({}), false);
  assert.equal(keys({ ctrlKey: true, shiftKey: true }), false);
  assert.equal(keys({ ctrlKey: true, altKey: true }), false);
  assert.equal(editorRunKeys({ key: 'a', ctrlKey: true }), false);
});
