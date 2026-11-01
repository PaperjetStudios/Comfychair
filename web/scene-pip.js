// The director view's mini camera view: what the camera you edit sees, in a box over the view, like a picture in picture.
// The box only frames it and takes the pointer; scene-view.js draws the picture into that part of the canvas (drawPip).
// Where it is and how big are kept per device, as shares of the canvas, so it stays put as the view changes size.
import { h, iconBtn, store } from './ui.js';
import { pipBox } from './scene-pip-box.js';

const KEY = 'deck.scene.pip';
export const PIP = { on: false, x: 0.72, y: 0.04, w: 0.25, ...store.get(KEY, {}) };

let frame = null, cv = null, redraw = () => {}, aspectOf = () => 16 / 9, shown = false;
const save = () => store.set(KEY, { on: PIP.on, x: PIP.x, y: PIP.y, w: PIP.w });
const size = () => [cv.clientWidth || 1, cv.clientHeight || 1];

// the box as the renderer wants it: logical units of its size, y up. Null when it isn't on show.
export function pipRect(sizeX, sizeY) {
  if (!shown) return null;
  const [cw, ch] = size(), b = pipBox(PIP, cw, ch, aspectOf()), k = sizeX / cw, j = sizeY / ch;
  return { x: b.x * k, y: (ch - b.y - b.h) * j, w: b.w * k, h: b.h * j };
}
function place() {
  const [cw, ch] = size(), b = pipBox(PIP, cw, ch, aspectOf());
  Object.assign(frame.style, { left: `${cv.offsetLeft + b.x}px`, top: `${cv.offsetTop + b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}
// each draw of the view: shown or not (the director view, not while Depth is showing), and where
export function syncPip(can) {
  if (!frame) return;
  shown = PIP.on && can;
  frame.classList.toggle('hidden', !shown);
  if (shown) place();
}
export function togglePip(on = !PIP.on) { PIP.on = !!on; save(); redraw(); }

// a pointer held on the box or its corner, as a share of the canvas
function drag(e, onMove) {
  e.preventDefault(); e.stopPropagation();
  const el = e.currentTarget, x0 = e.clientX, y0 = e.clientY, start = { ...PIP };
  el.setPointerCapture?.(e.pointerId);
  const move = (ev) => { const [cw, ch] = size(); onMove(start, (ev.clientX - x0) / cw, (ev.clientY - y0) / ch); redraw(); };
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); save(); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
export function wirePip({ viewer, canvas, draw, aspect }) {
  cv = canvas; redraw = draw; aspectOf = aspect;
  // (stays inside the canvas once let go, wherever it was dragged towards)
  const settle = () => { const [cw, ch] = size(), b = pipBox(PIP, cw, ch, aspectOf()); PIP.x = b.x / cw; PIP.y = b.y / ch; PIP.w = b.w / cw; };
  const grip = h('span', { class: 'pip-grip', title: 'Drag to resize',
    onpointerdown: (e) => drag(e, (s, dx) => { PIP.w = s.w + dx; settle(); }) });
  frame = h('div', { class: 'scene-pip hidden', title: 'The camera\'s view: drag to move',
    onpointerdown: (e) => drag(e, (s, dx, dy) => { PIP.x = s.x + dx; PIP.y = s.y + dy; settle(); }) },
  iconBtn('Hide the mini camera view', '✕', () => togglePip(false), { class: 'icon-btn pip-close', onpointerdown: (e) => e.stopPropagation() }), grip);
  // (the view behind mustn't orbit, zoom or pick through it)
  frame.addEventListener('wheel', (e) => e.stopPropagation());
  viewer.append(frame);
}
