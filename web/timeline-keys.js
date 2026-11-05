// The timeline's keys (Video and Sound) and the list the ⓘ shows, with no DOM. Tested by tests/timeline_keys.test.mjs:
// no key means two things, and none takes a key playKeys (playback.js) or the work area (I / O) already owns.

// [what it runs, key (e.key, lower-cased), needs Ctrl / Meta, needs Shift, needs Alt, what the list says]
export const COMMANDS = [
  ['undo', 'z', true, false, false, 'undo'],
  ['redo', 'z', true, true, false, 'redo'],
  ['redo', 'y', true, false, false, 'redo'],
  ['copy', 'c', true, false, false, 'copy the picked clips'],
  ['cut', 'x', true, false, false, 'cut the picked clips'],
  ['paste', 'v', true, false, false, 'paste at the playhead'],
  ['duplicate', 'j', true, false, false, 'duplicate the picked clips'],
  ['selectAll', 'a', true, false, false, 'pick every clip'],
  ['selectNone', 'd', true, false, false, 'pick no clips'],
  ['delete', 'delete', false, false, false, 'delete the picked clips'],
  ['delete', 'backspace', false, false, false, 'delete the picked clips'],
  ['rippleDelete', 'delete', false, true, false, 'delete and close the gap'],
  ['nudgeLeft', 'arrowleft', false, null, true, 'move the picked clips back a frame (Shift: 10)'],
  ['nudgeRight', 'arrowright', false, null, true, 'move the picked clips on a frame (Shift: 10)'],
  ['split', 's', false, false, false, 'split at the playhead'],
  ['marker', 'm', false, false, false, 'marker at the playhead'],
  ['deselect', 'escape', false, false, false, 'drop the picks, then deselect'],
  ['toolSelect', 'v', false, false, false, 'Select tool'],
  ['toolRazor', 'c', false, false, false, 'Razor tool'],
  ['toolRipple', 'b', false, false, false, 'Ripple tool'],
  ['toolSlip', 'y', false, false, false, 'Slip tool'],
  ['toolHand', 'h', false, false, false, 'Hand tool'],
  ['zoomIn', '=', false, null, false, 'zoom in'],
  ['zoomIn', '+', false, null, false, 'zoom in'],
  ['zoomOut', '-', false, null, false, 'zoom out'],
];

// the command a keydown means, or null. Shift is ignored for the zoom keys (+ is Shift+= on most keyboards).
export function commandFor(e) {
  if (e.repeat && !/^(nudge|zoom)/.test(COMMANDS.find(([, k]) => k === e.key.toLowerCase())?.[0] || '')) return null;
  const k = e.key.toLowerCase(), ctrl = !!(e.ctrlKey || e.metaKey);
  return COMMANDS.find(([, key, c, shift, alt]) => key === k && c === ctrl && alt === !!e.altKey && (shift === null || shift === !!e.shiftKey))?.[0] || null;
}

// the keys that need Ctrl / Meta (playKeys' combos), and the rest, each as the lower-cased e.key
export const comboKeys = () => COMMANDS.filter((c) => c[2]).map((c) => c[1]);
export const plainKeys = () => COMMANDS.filter((c) => !c[2]).map((c) => c[1]);

const keyName = (key, ctrl, shift, alt) => `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${
  key.length === 1 ? key.toUpperCase() : key === 'arrowleft' ? '←' : key === 'arrowright' ? '→' : key[0].toUpperCase() + key.slice(1)}`;
// [{ keys, label }] for the ⓘ: a command's keys joined with " / "
export function keysHelp() {
  const out = [];
  for (const [id, key, ctrl, shift, alt, label] of COMMANDS) {
    const name = keyName(key, ctrl, shift === true, alt);
    const same = out.find((o) => o.id === id);
    if (same) same.keys += ` / ${name}`; else out.push({ id, keys: name, label });
  }
  return out.map(({ keys, label }) => ({ keys, label }));
}
