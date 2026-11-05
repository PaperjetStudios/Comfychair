// An open frame's layer list alone, in a floating panel over the table, whichever sidebar pane is on show beside it: an image or 3D frame's layers, a
// video or sound frame's clips (clip-list.js). The panel holds the list and nothing else; the engine draws everything else in its own pane as before. Kept on this device, as are its
// place and size.
//   FLOAT_KINDS                what has a list; floatsFor(kind) the panel is taking this kind's list now; floatLayers(on), layersFloating()  the switch: tells layers:float { on }, and the engine draws its panel again
//   layerListPart(kind, list)  called by the engine with its list part as it draws: in the panel while it floats, and what's left of it for the pane (or null)
import { h, store } from './ui.js';
import { icon } from './icons.js';
import { liveFrame } from './live.js';

export const FLOAT_KINDS = ['image', 'scene', 'video', 'sound'];
const TITLES = { image: 'Layers', scene: 'Layers', video: 'Clips', sound: 'Sounds' };
const KEY = 'deck.layers.float';
const F = { on: store.get(KEY, false) === true, el: null, body: null };

const floatsNow = () => F.on && FLOAT_KINDS.includes(liveFrame()?.kind);
export const floatsFor = (kind) => floatsNow() && liveFrame()?.kind === kind;
function keepOnScreen() {
  const r = F.el.getBoundingClientRect();
  F.el.style.left = `${Math.max(0, Math.min(r.left, innerWidth - 80))}px`;
  F.el.style.top = `${Math.max(0, Math.min(r.top, innerHeight - 40))}px`;
}
function build() {
  if (F.el) return;
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back in the sidebar', title: 'Back in the sidebar', onclick: () => floatLayers(false) }, icon('close'));
  const head = h('div', { class: 'float-head' }, (F.title = h('span', { class: 'float-title' }, 'Layers')), close);
  F.body = h('div', { class: 'float-body' });
  F.el = h('div', { class: 'float-panel hidden', role: 'dialog', 'aria-label': 'Layers' }, head, F.body);
  document.body.append(F.el);
  const saveAt = () => { const r = F.el.getBoundingClientRect(); store.set(`${KEY}.at`, { x: r.left, y: r.top, w: r.width, h: r.height }); };
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = F.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { F.el.style.left = `${ev.clientX - dx}px`; F.el.style.top = `${ev.clientY - dy}px`; keepOnScreen(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); saveAt(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  new ResizeObserver(() => { if (!F.el.classList.contains('hidden')) saveAt(); }).observe(F.el);
  addEventListener('resize', () => { if (!F.el.classList.contains('hidden')) keepOnScreen(); });
  const at = store.get(`${KEY}.at`, null);
  if (at) Object.assign(F.el.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px` });
}
function sync() {
  if (!F.on && !F.el) return;
  build();
  const open = floatsNow();
  F.el.classList.toggle('hidden', !open);
  if (open) { keepOnScreen(); F.title.textContent = TITLES[liveFrame().kind]; }
  else F.body.replaceChildren();
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
  F.body.replaceChildren(rows || h('span', { class: 'hint' }, 'Nothing here yet'));
  sync();
  return rows === list ? null : list;
}
if (typeof addEventListener === 'function') {
  addEventListener('table:live', () => queueMicrotask(sync));
  addEventListener('table:unlive', () => queueMicrotask(sync));
}
