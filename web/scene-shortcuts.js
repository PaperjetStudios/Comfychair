// The 3D tab's one-key commands (scene-ui.js wireKeys runs them) and the list the ⓘ and the ? key show.
// Tested by tests/scene_shortcuts.test.mjs: no key means two things, and none takes a key the tab already uses.

// [what it runs, key, needs Shift, what the list says]
export const COMMANDS = [
  ['camToView', 'c', false, 'camera to this view (director view)'],
  ['newCamera', 'c', true, 'new camera'],
  ['viewCut', 'v', true, 'view: the camera you edit / the cuts'],
  ['cutHere', 'b', false, 'cut to the active camera at the playhead'],
  ['addKey', 'j', false, '◆ key at the playhead'],
  ['delKey', 'j', true, 'remove the key at the playhead'],
  ['add', 'a', true, 'add to the scene'],
  ['duplicate', 'd', true, 'duplicate the selected object'],
  ['gridSnap', 'g', false, 'grid snapping on / off'],
  ['fullScreen', 'f', false, 'full screen'],
  ['saveFrame', 's', true, 'save this frame'],
  ['mode1', '1', false, 'Edit scene mode'],
  ['mode2', '2', false, 'Camera mode'],
  ['mode3', '3', false, 'Create object mode'],
  ['keysHelp', '?', true, 'this list'],
];

// the command a keydown means, or null. (? is Shift on most keyboards, not all: its Shift isn't checked.)
export function commandFor(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  const k = e.key.toLowerCase();
  return COMMANDS.find(([, key, shift]) => key === k && (key === '?' || shift === e.shiftKey))?.[0] || null;
}

const keyName = (key, shift) => (key === '?' ? '?' : `${shift ? 'Shift+' : ''}${key.toUpperCase()}`);
// the keys the tab had before this list, by what they're for
const OTHERS = [
  ['View', ['V director view / through the camera', 'H hide the tools', 'N the panel, in full screen', 'Right mouse + W A S D Q E walk the camera']],
  ['Objects', ['W / E / R move, rotate, scale', 'Q gizmo axes', 'Delete remove the selected object', 'Esc deselect', 'Ctrl+Z undo', 'Ctrl+Y redo']],
  ['Time', ['Space play / pause', 'P play from the start of the range', '← → or , . a frame', 'Shift+← → the start / end', '↑ ↓ next / previous key', 'Home / End the start / end', 'I / O set the range\'s in / out', 'Shift+I / Shift+O go to them', 'Alt+X clear the range', 'K auto key']],
  ['Key sheet, after a click on it', ['A select all', 'Alt+A select none', 'S stretch in time', 'X or Delete delete keys', 'Ctrl+C / Ctrl+V / Ctrl+D copy, paste, duplicate']],
];
export const keysList = () => [
  ['Commands', COMMANDS.map(([, key, shift, what]) => `${keyName(key, shift)} ${what}`)],
  ...OTHERS,
];
export const keysText = () => keysList().map(([group, keys]) => `${group}: ${keys.join(' · ')}`).join('\n\n');
