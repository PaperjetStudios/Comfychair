// A floating panel over the screen: a head to drag it by, and a body. It can be resized; its place and size are kept on this device.
//   floatPanel({ key, title, cls, buttons, inside }) → { el, body, title(words), show(), hide(), shown(), dragBy(el) }
//     key: where the place is kept. buttons: more in the head. inside: the whole panel stays on the screen and clear of the Generate bar
//     (otherwise a corner of it is enough). dragBy(el): something else in it to drag it by.
import { h, store } from './ui.js';

export function floatPanel({ key, title = '', cls = '', buttons = [], inside = false }) {
  const words = h('span', { class: 'float-title' }, title);
  const head = h('div', { class: 'float-head' }, words, ...buttons);
  const body = h('div', { class: 'float-body' });
  const el = h('div', { class: `float-panel hidden ${cls}`.trim(), role: 'dialog', 'aria-label': title }, head, body);
  document.body.append(el);
  const keep = () => {   // (always reachable: the window may have shrunk)
    const r = el.getBoundingClientRect();
    if (inside) {
      const bar = document.querySelector('.stage.maxed') ? null : document.querySelector('.actionbar')?.getBoundingClientRect();   // (a full-screen stage covers the bar)
      const floor = bar?.height && bar.top > innerHeight / 2 ? bar.top : innerHeight;
      el.style.left = `${Math.max(0, Math.min(r.left, innerWidth - r.width))}px`;
      el.style.top = `${Math.max(0, Math.min(r.top, floor - r.height))}px`;
      return;
    }
    el.style.left = `${Math.max(0, Math.min(r.left, innerWidth - 80))}px`;
    el.style.top = `${Math.max(0, Math.min(r.top, innerHeight - 40))}px`;
  };
  const saveAt = () => { const r = el.getBoundingClientRect(); store.set(`${key}.at`, { x: r.left, y: r.top, w: r.width, h: el.classList.contains('folded') ? (store.get(`${key}.at`, null)?.h ?? null) : r.height }); };
  const dragBy = (grip) => grip.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => { el.style.left = `${ev.clientX - dx}px`; el.style.top = `${ev.clientY - dy}px`; keep(); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); saveAt(); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  dragBy(head);
  new ResizeObserver(() => { if (el.classList.contains('hidden')) return; if (inside) keep(); saveAt(); }).observe(el);
  addEventListener('resize', () => { if (!el.classList.contains('hidden')) keep(); });
  const at = store.get(`${key}.at`, null);
  if (at) Object.assign(el.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, ...(at.h ? { height: `${at.h}px` } : {}) });
  return { el, body, head, dragBy, title: (t) => { words.textContent = t; }, shown: () => !el.classList.contains('hidden'),
    show() { el.classList.remove('hidden'); keep(); }, hide() { el.classList.add('hidden'); } };
}
