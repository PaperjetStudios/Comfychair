// The top tabs: one per table of the project (table.js keeps them as `tables` documents through a TabSet), then ＋ for
// a new one. A tap opens a table (and the Table screen), a double-click renames it, a right click or a long hold opens
// its menu (Rename, Duplicate, Delete with Undo), and a drag along the row puts it elsewhere (a finger holds first, so
// the row still scrolls). The old screens sit under the Classic ▾ button beside them (app.js).
//
//   const nav = wireTableNav({ list(), active(), shown(), open(id), create(), rename(id), duplicate(id), remove(id), reorder(from, to) });
//   nav.render()   after the list, the open table or the screen changed
import { $, h, icon } from './ui.js';
import { openPressMenu, pressMenu } from './press-menu.js';
import { dropIndex, slideOf } from './tab-order.js';

const DRAG_PX = 6, HOLD_MS = 350;

export function wireTableNav(cb) {
  const row = $('#tableTabs'), plus = $('#tableNew');
  if (!row) return { render() {} };
  plus?.addEventListener('click', () => cb.create());
  let drag = null, justDragged = false;

  const menu = (x, y, id) => openPressMenu(x, y, [
    [{ label: 'Rename…', run: () => cb.rename(id) }, { label: 'Duplicate', run: () => cb.duplicate(id) }],
    [{ label: 'Delete', danger: true, disabled: cb.list().length < 2, run: () => cb.remove(id) }],
  ], 'Table');

  function render() {
    if (drag?.started) { drag.stale = true; return; }
    const on = cb.shown(), act = cb.active(), focused = row.contains(document.activeElement);
    row.replaceChildren(...cb.list().map((d) => {
      const me = on && d.id === act;
      const b = h('button', { type: 'button', role: 'tab', class: `table-tab${me ? ' active' : ''}${d.id === act ? ' current' : ''}`, 'data-table': d.id,
        'aria-selected': String(me), tabIndex: d.id === act ? 0 : -1, title: `${d.name}: double-click to rename, right-click for more`,
        onclick: () => { if (!justDragged) cb.open(d.id); },
        ondblclick: (e) => { e.preventDefault(); cb.rename(d.id); },
        onpointerdown: (e) => dragStart(e, b, d.id) },
      icon('board'), h('span', { class: 'tab-label' }, d.name));
      pressMenu(b, (e) => menu(e.clientX, e.clientY, d.id));
      return b;
    }));
    if (focused) row.querySelector('.table-tab.current')?.focus({ preventScroll: true });
    row.querySelector('.table-tab.current')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // drag along the row to reorder (the TabSet saves the new order); the tabs slide with transforms until let go
  function dragStart(e, chip, id) {
    if (e.button > 0 || drag) return;
    const touch = e.pointerType !== 'mouse';
    const d = drag = { id, chip, x0: e.clientX, pid: e.pointerId, started: false, lastX: e.clientX, from: -1, to: -1 };
    const lift = () => {
      clearTimeout(d.hold);
      d.chips = [...row.children];
      d.from = d.to = d.chips.indexOf(chip);
      d.rects = d.chips.map((c) => ({ left: c.offsetLeft, top: 0, w: c.offsetWidth, h: 1 }));
      d.started = true;
      try { chip.setPointerCapture(d.pid); } catch { /* the pointer is gone */ }
      chip.classList.add('lift');
    };
    const move = (ev) => {
      if (ev.pointerId !== d.pid) return;
      d.lastX = ev.clientX;
      if (!d.started) {
        const dist = Math.abs(ev.clientX - d.x0);
        if (touch) { if (dist > 10) cleanup(); } else if (dist > DRAG_PX) lift();
        return;
      }
      ev.preventDefault();
      const dx = d.lastX - d.x0, me = d.rects[d.from];
      d.to = dropIndex(d.rects, d.from, me.left + me.w / 2 + dx, 0);
      d.chips.forEach((c, i) => {
        if (i === d.from) { c.style.transform = `translateX(${dx}px)`; return; }
        const by = slideOf(d.rects, d.from, d.to, i);
        c.style.transform = by ? `translateX(${by[0]}px)` : '';
      });
    };
    const cleanup = () => {
      clearTimeout(d.hold);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (d.started) d.chips.forEach((c) => { c.style.transform = ''; c.classList.remove('lift'); });
      drag = null;
    };
    const up = (ev) => {
      if (ev.pointerId !== d.pid) return;
      const was = d.started, { from, to, stale } = d;
      cleanup();
      if (!was) return;
      justDragged = true; setTimeout(() => { justDragged = false; }, 0);   // (the click a drag ends in isn't a tap)
      if (ev.type !== 'pointercancel' && from !== to) cb.reorder(from, to); else if (stale) render();
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up); addEventListener('pointercancel', up);
    if (touch) d.hold = setTimeout(lift, HOLD_MS);
  }

  return { render };
}
