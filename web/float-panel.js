// A floating panel over the screen: a head to drag it by, and a body. It can be resized; its place and size are kept on this device.
//   floatPanel({ key, title, cls, buttons }) → { el, body, title(words), show(), hide(), shown() }   key: where the place is kept. buttons: more in the head.
import { h, store } from './ui.js';

export function floatPanel({ key, title = '', cls = '', buttons = [] }) {
  const words = h('span', { class: 'float-title' }, title);
  const head = h('div', { class: 'float-head' }, words, ...buttons);
  const body = h('div', { class: 'float-body' });
  const el = h('div', { class: `float-panel hidden ${cls}`.trim(), role: 'dialog', 'aria-label': title }, head, body);
  document.body.append(el);
  const keep = () => {   // (always reachable: the window may have shrunk)
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(r.left, innerWidth - 80))}px`;
    el.style.top = `${Math.max(0, Math.min(r.top, innerHeight - 40))}px`;
  };
  const saveAt = () => { const r = el.getBoundingClientRect(); store.set(`${key}.at`, { x: r.left, y: r.top, w: r.width, h: el.classList.contains('folded') ? (store.get(`${key}.at`, null)?.h ?? null) : r.height }); };
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { el.style.left = `${ev.clientX - dx}px`; el.style.top = `${ev.clientY - dy}px`; keep(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); saveAt(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  new ResizeObserver(() => { if (!el.classList.contains('hidden')) saveAt(); }).observe(el);
  addEventListener('resize', () => { if (!el.classList.contains('hidden')) keep(); });
  const at = store.get(`${key}.at`, null);
  if (at) Object.assign(el.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, ...(at.h ? { height: `${at.h}px` } : {}) });
  return { el, body, head, title: (t) => { words.textContent = t; }, shown: () => !el.classList.contains('hidden'),
    show() { el.classList.remove('hidden'); keep(); }, hide() { el.classList.add('hidden'); } };
}
