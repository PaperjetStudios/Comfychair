// Who a key belongs to when a control has the focus: the control, or the player's shortcuts (playback.js, vfield.js).
// A tap or click leaves the focus on what was touched, and that must not cost the shortcuts: a control reached with
// Tab keeps its keys, one that was only clicked doesn't. (Not :focus-visible: a browser turns that on at the first key
// pressed, before any handler sees it.) Tested by tests/key_focus.test.mjs.

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

let tabbed = false;   // the focus was last moved with Tab, not with a pointer
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    tabbed = false;
    const a = document.activeElement;
    if (takesKeyboard(e.target, a)) a.blur();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbed = true; }, true);
}
export const keyboardFocus = () => tabbed;

// A press on something that can be picked takes the keyboard away from a prompt box being typed in, so Delete, the arrows and
// the shortcuts reach what was picked. t: the pressed element (anything with closest()); active: the focused element.
// A press inside a text field, a dialog, a label, or a control that acts on the text leaves the focus alone.
const PICK_SURFACE = '.stage, .table-outer, .editor-stage, .editor-canvas, .canvas-stage, .layer-row, .layer-grip, .tl-clip, .tl-lane, .frame, .table-stage, .scene-view, .viewport3d, canvas';
const KEEPS_TYPING = '.prompt-body, .prompt-part, .prompt-chip, textarea, input, select, label, [contenteditable], [role=dialog], dialog, .sheet, .prompt-helper, .info-pop';
export function takesKeyboard(t, active) {
  if (!t?.closest || !active?.matches?.('textarea, input:not([type=range], [type=checkbox], [type=radio]), [contenteditable]')) return false;
  if (t.closest(KEEPS_TYPING)) return false;
  if (t.closest('button, a, [role=tab], [role=button]') && !t.closest('.layer-row, .tl-clip, .tl-lane, canvas')) return false;   // (a button in a frame acts on its own)
  return !!t.closest(PICK_SURFACE);
}

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

// What Ctrl+Enter or Shift+Enter runs on the Editor tab, from where the focus is: 'tool' (the Image tool that's open),
// 'fill' (Inpaint's Fill, or Extend: inpaint.js runFill) or null. A box being typed in that belongs to another panel runs
// neither, and Shift+Enter in Inpaint's own boxes stays a new line. The Edit pane's Inpaint and Extend rows carry
// data-run-key; with them on show (shown(): the rows on show, if any), a key from no box runs Fill too. Not for any other
// combination of keys: see editorRunKeys.
const runKeyShown = () => {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector('[data-run-key]');
  return !!el?.offsetParent;
};
export function editorRunKey(e, shown = runKeyShown) {
  const t = e.target, title = t.closest?.('section')?.querySelector('.section-title span')?.textContent;
  const typing = !!t.closest?.('textarea, [contenteditable]') || !['range', 'checkbox', 'radio', undefined].includes(t.closest?.('input')?.type);
  if (title === 'Image tools') return 'tool';
  if ((title === 'Inpaint and extend' || t.closest?.('[data-run-key]')) && (e.ctrlKey || e.metaKey)) return 'fill';
  if (typing) return null;
  return shown() ? 'fill' : 'tool';
}
// Ctrl+Enter or Shift+Enter, and not both: Ctrl+Shift+Enter is still Generate's, as it always was.
export const editorRunKeys = (e) => e.key === 'Enter' && !e.altKey && (e.ctrlKey || e.metaKey) !== e.shiftKey;

// A panel about to be built again: call what this returns afterwards, and a box being typed in has the focus back, with
// the cursor where it was (a run landing, or Ctrl+Enter's own run, must not end the typing). It's found by its panel section and its place there.
export function keepTyping(panel, root = document) {
  const box = root.activeElement;
  if (!box || !panel.contains(box) || !box.matches('textarea, input:not([type=range], [type=checkbox], [type=radio])')) return () => {};
  const titled = (s) => s.querySelector('.section-title span')?.textContent, boxes = (s) => [...s.querySelectorAll('textarea, input')];
  const home = box.closest('section'), title = home && titled(home);
  if (!title) return () => {};
  const at = boxes(home).indexOf(box), { selectionStart: a, selectionEnd: b } = box;
  return () => {
    const again = [...panel.querySelectorAll('section')].find((s) => titled(s) === title), next = again && boxes(again)[at];
    if (next?.tagName !== box.tagName || next.type !== box.type) return;
    next.focus({ preventScroll: true });
    try { next.setSelectionRange(a, b); } catch { /* (a number box has no cursor to set) */ }
  };
}
