// The red mask in a floating panel over the open image frame, whichever sidebar pane is on show: what marks it, Dilate /
// erode and its visibility (inpaint.js maskRows), and while the mask is being painted, the brush to paint it with (brush or
// eraser, size, hardness). So painting a mask never needs the Layers pane. The engine feeds it as it draws (maskFloatPart,
// from editor.js panelParts), as float-layers.js is fed. Kept on this device, as are its place and size.
//   maskFloatPart(eng)        called by the engine's host as it draws: fills the panel while it is on show
//   openMask(eng, { start })  on show; start: paint the mask now if nothing is marked yet. Also the mask:open event { eng, start }
//   closeMask()               hidden; the mask brush, if it is the tool, goes back to Move
//   maskFloating()            on show (mask:float { on } says when that changes)
import { h, store, button, field, seg, rangeField, section, hint } from './ui.js';
import { icon } from './icons.js';
import { CURRENT_EDIT } from './core.js';
import { liveFrame } from './live.js';
import { floatPanel } from './float-panel.js';
import { maskHelp, maskRows } from './inpaint.js';

const KEY = 'deck.mask.float';
const F = { on: store.get(KEY, false) === true, panel: null, eng: null };

const floatsNow = () => F.on && liveFrame()?.kind === 'image';
export const maskFloating = () => F.on;
function build() {
  if (F.panel) return;
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the Mask panel', title: 'Close', onclick: () => closeMask() }, icon('close'));
  F.panel = floatPanel({ key: KEY, title: 'Mask', cls: 'float-mask', buttons: [close] });
}
function tell() { dispatchEvent(new CustomEvent('mask:float', { detail: { on: F.on } })); }
function setOn(on) {
  if (F.on === !!on) return;
  F.on = !!on;
  store.set(KEY, F.on);
  tell();
}

// the mask's brush is the tool now: the mask layer picked, a brush or the eraser
const maskBrush = (eng) => !!eng && eng.paint.painting() && !!eng.E.sel?.mask && ['brush', 'eraser'].includes(eng.paint.P.tool);

function brushRows(eng) {
  if (!maskBrush(eng)) return [];
  const p = eng.paint, t = p.P.tool, k = t === 'eraser' ? 'eraser' : p.P.brush;
  const b = () => p.brushOf(k);
  return [section(t === 'eraser' ? 'Eraser' : 'Brush', null,
    field('Paint', seg([['brush', 'Brush'], ['eraser', 'Eraser']], t, (v) => { p.setTool(v); })),
    rangeField('Size', () => b().size, (v) => p.setBrush(k, { size: Math.round(v) }), { min: 1, max: 400, step: 1, fmt: (v) => `${Math.round(v)} px` }),
    rangeField('Hardness', () => b().hard ?? 1, (v) => p.setBrush(k, { hard: Math.max(0, Math.min(1, v)) }), { min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`,
      help: 'How sharp the brush\'s edge is: 100% is a clean edge, lower fades out towards it. The red only shows where the mask is; a soft edge marks part way.' }),
    button('Done painting', () => { p.setTool('move'); }, { cls: 'small', title: 'Back to the Move tool (Esc)' }))];
}

function fill(eng) {
  F.eng = eng;
  F.panel.body.replaceChildren(...(eng?.E.layers.length ? [...brushRows(eng), ...maskRows(eng), maskHelp()] : [hint('Add a picture first')]));
}
function sync() {
  if (!F.on && !F.panel) return;
  build();
  if (floatsNow()) {
    const was = F.panel.shown();
    F.panel.show();
    if (!was) fill(F.eng || CURRENT_EDIT.eng);
  } else { F.panel.hide(); F.panel.body.replaceChildren(); }
}

export function maskFloatPart(eng) {
  if (!floatsNow()) return null;
  build();
  fill(eng);
  if (!F.panel.shown()) F.panel.show();
  return null;
}

export function openMask(eng = CURRENT_EDIT.eng, { start = false } = {}) {
  setOn(true);
  build();
  sync();
  if (!eng) return;
  F.eng = eng;
  if (start && eng.E.layers.length && !eng.paint.maskLayer(false)) eng.paint.paintMask();   // (paints: the engine draws, and fills the panel)
  else eng.render();
}
export function closeMask() {
  setOn(false);
  const eng = F.eng || CURRENT_EDIT.eng;
  if (maskBrush(eng)) eng.paint.setTool('move');   // (renders)
  sync();
}

if (typeof addEventListener === 'function') {
  let soon = 0;
  addEventListener('mask:painted', () => { clearTimeout(soon); soon = setTimeout(() => { if (F.panel?.shown() && F.eng) fill(F.eng); }, 200); });
  addEventListener('mask:open', (e) => openMask(e.detail?.eng || CURRENT_EDIT.eng, { start: !!e.detail?.start }));
  addEventListener('table:live', () => queueMicrotask(sync));
  addEventListener('table:unlive', () => queueMicrotask(sync));
}
