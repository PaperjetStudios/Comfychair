// Who a key belongs to when a control has the focus: the control, or the player's shortcuts (playback.js, vfield.js).
// A tap or click leaves the focus on what was touched, and that must not cost the shortcuts: a control reached with
// Tab keeps its keys, one that was only clicked doesn't. (Not :focus-visible: a browser turns that on at the first key
// pressed, before any handler sees it.) Tested by tests/key_focus.test.mjs.

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

let tabbed = false;   // the focus was last moved with Tab, not with a pointer
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { tabbed = false; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbed = true; }, true);
}
export const keyboardFocus = () => tabbed;

// e: the keydown. True when the focused control uses this key itself, so the shortcut must leave it alone.
// dialog: false for a player that itself sits in a dialog (a dialog's keys are otherwise its own).
export function ownsKey(e, { dialog = true, keyboard = tabbed } = {}) {
  const t = e.target;
  if (!t?.closest || t.closest('textarea, select, [contenteditable]') || (dialog && t.closest('[role=dialog]'))) return true;
  const input = t.closest('input');
  if (input) {
    if (input.type === 'range') return SLIDER_KEYS.has(e.key) && !input.matches('.scrub');   // (a player's own scrub bar: the keys go to the player)
    if (input.type === 'checkbox' || input.type === 'radio') return keyboard;
    return true;   // something is being typed
  }
  return keyboard && !!t.closest('button, a, [role=tab]');
}
