// Mark the views on one picture (a character sheet): a box per view, drawn, moved or resized on the picture.
// The boxes are fractions of the picture, { Front: {x, y, w, h}, … }; onDone gets them.
import { button, clamp01, h, hint, openOverlay, seg } from './ui.js';
import { inputUrl } from './core.js';

export const VIEWS = ['Front', 'Left', 'Back', 'Right'];

export function openViewBoxes({ image, boxes = {}, onDone }) {
  const bs = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, { ...b }]));
  let cur = VIEWS.find((v) => !bs[v]) || 'Front';
  let aspect = 1;
  const canvas = h('div', { class: 'box-canvas' });
  const stage = h('div', { class: 'sketch-stage' }, canvas);
  const list = h('div', { class: 'box-list' });
  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 20) / aspect, r.height - 20);
    canvas.style.width = `${Math.floor(k * aspect)}px`; canvas.style.height = `${Math.floor(k)}px`;
  };
  canvas.style.backgroundImage = `url("${inputUrl(image)}")`;
  const probe = new Image();
  probe.onload = () => { aspect = probe.naturalWidth / probe.naturalHeight; fit(); };
  probe.src = inputUrl(image);

  const draw = () => {
    canvas.replaceChildren(...VIEWS.filter((v) => bs[v]).map((v) => h('div', { class: 'bx' + (v === cur ? ' sel' : ''), 'data-v': v,
      style: `left:${bs[v].x * 100}%;top:${bs[v].y * 100}%;width:${bs[v].w * 100}%;height:${bs[v].h * 100}%` },
      h('span', { class: 'bx-num' }, v), h('span', { class: 'bx-handle', 'data-v': v }))));
    list.replaceChildren(
      h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('span', {}, 'Drag on the picture to mark')),
        seg(VIEWS.map((v) => [v, bs[v] ? `${v} ✓` : v]), cur, (v) => { cur = v; draw(); }, { wrap: true })),
      hint(`Marking: ${cur}. Drag on empty space to draw its box (a new drag replaces it); drag a box to move it, its corner to resize. Left is the character's left.`),
      ...VIEWS.filter((v) => bs[v]).map((v) => h('div', { class: 'row' }, h('b', { class: 'grow' }, v),
        button('Clear', () => { delete bs[v]; draw(); }, { cls: 'small ghost' }))),
      h('div', { class: 'row wrap' }, hint('Or start from equal columns:'),
        ...[[2, ['Front', 'Back']], [3, ['Front', 'Left', 'Back']], [4, ['Front', 'Left', 'Back', 'Right']]].map(([n, names]) =>
          button(`${n} columns`, () => {
            for (const v of VIEWS) delete bs[v];
            names.forEach((v, i) => { bs[v] = { x: i / n, y: 0, w: 1 / n, h: 1 }; });
            draw();
          }, { cls: 'small' }))));
  };

  let drag = null;
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const p = pt(e), t = e.target, v = t.dataset?.v || t.closest?.('.bx')?.dataset.v;
    if (t.classList.contains('bx-handle')) { cur = v; drag = { mode: 'resize', b: bs[v] }; }
    else if (v) { cur = v; drag = { mode: 'move', b: bs[v], p0: p, b0: { ...bs[v] } }; }
    else { bs[cur] = { x: p.x, y: p.y, w: 0, h: 0 }; drag = { mode: 'new', b: bs[cur], p0: p, v: cur }; }
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e), b = drag.b;
    if (drag.mode === 'move') {
      b.x = Math.min(1 - b.w, Math.max(0, drag.b0.x + p.x - drag.p0.x));
      b.y = Math.min(1 - b.h, Math.max(0, drag.b0.y + p.y - drag.p0.y));
    } else if (drag.mode === 'resize') {
      b.w = Math.max(0.02, p.x - b.x); b.h = Math.max(0.02, p.y - b.y);
    } else {
      b.x = Math.min(p.x, drag.p0.x); b.y = Math.min(p.y, drag.p0.y);
      b.w = Math.abs(p.x - drag.p0.x); b.h = Math.abs(p.y - drag.p0.y);
    }
    const el = canvas.querySelector(`.bx[data-v="${cur}"]`);
    if (el) Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  });
  const end = () => {
    if (drag?.mode === 'new' && (drag.b.w < 0.02 || drag.b.h < 0.02)) delete bs[drag.v];   // (a tap, not a box)
    else if (drag?.mode === 'new') cur = VIEWS.find((v) => !bs[v]) || cur;   // on to the next view
    drag = null; draw();
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  const start = JSON.stringify(boxes);
  const overlay = h('div', { class: 'sketch boxes-editor' },
    h('div', { class: 'sketch-bar' }, h('b', {}, 'Mark the views'), h('div', { class: 'spacer' }),
      button('Cancel', () => close(), { cls: 'small ghost' }),
      button('Done', () => { onDone(Object.fromEntries(Object.entries(bs).map(([k, b]) => [k, { x: b.x, y: b.y, w: b.w, h: b.h }]))); close(false, true); }, { cls: 'small primary' })),
    h('div', { class: 'box-body' }, stage, list));
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  const close = openOverlay(overlay, { dirty: () => JSON.stringify(bs) !== start, ask: 'Throw away your changes to the views?', onClose: () => ro.disconnect() });
  draw();
}
