// An open frame's layer list alone, in a floating panel over the table, whichever sidebar pane is on show beside it: an image or 3D frame's layers, a
// video or sound frame's clips (clip-list.js). The panel holds the list and nothing else; the engine draws everything else in its own pane as before. Kept on this device, as are its
// place and size.
//   FLOAT_KINDS                what has a list; floatsFor(kind) the panel is taking this kind's list now; floatLayers(on), layersFloating()  the switch: tells layers:float { on }, and the engine draws its panel again
//   layerListPart(kind, list)  called by the engine with its list part as it draws: in the panel while it floats, and what's left of it for the pane (or null)
import { h, store } from './ui.js';
import { icon } from './icons.js';
import { liveFrame } from './live.js';
import { floatPanel } from './float-panel.js';

export const FLOAT_KINDS = ['image', 'scene', 'video', 'sound'];
const TITLES = { image: 'Layers', scene: 'Layers', video: 'Clips', sound: 'Sounds' };
const KEY = 'deck.layers.float';
const F = { on: store.get(KEY, false) === true, panel: null };

const floatsNow = () => F.on && FLOAT_KINDS.includes(liveFrame()?.kind);
export const floatsFor = (kind) => floatsNow() && liveFrame()?.kind === kind;
function build() {
  if (F.panel) return;
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back in the sidebar', title: 'Back in the sidebar', onclick: () => floatLayers(false) }, icon('close'));
  F.panel = floatPanel({ key: KEY, title: 'Layers', cls: 'float-layers', buttons: [close] });
}
function sync() {
  if (!F.on && !F.panel) return;
  build();
  if (floatsNow()) { F.panel.show(); F.panel.title(TITLES[liveFrame().kind]); }
  else { F.panel.hide(); F.panel.body.replaceChildren(); }
}
export const layersFloating = () => F.on;
export function floatLayers(on) {
  if (F.on === !!on) return;
  F.on = !!on;
  store.set(KEY, F.on);
  sync();
  dispatchEvent(new CustomEvent('layers:float', { detail: { on: F.on } }));
}
export function layerListPart(kind, list) {
  if (!floatsFor(kind)) return list;
  build();
  const rows = list?.matches?.('.layers') ? list : list?.querySelector?.('.layers') || null;
  F.panel.body.replaceChildren(rows || h('span', { class: 'hint' }, 'Nothing here yet'));
  sync();
  return rows === list ? null : list;
}
if (typeof addEventListener === 'function') {
  addEventListener('table:live', () => queueMicrotask(sync));
  addEventListener('table:unlive', () => queueMicrotask(sync));
}
