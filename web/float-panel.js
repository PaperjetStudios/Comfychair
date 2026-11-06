// A floating panel over the screen: a head to drag it by, and a body. It can be resized; its place and size are kept on this device.
// Every one can also dock, in a column or a row the work area makes room for, at one of five places (dock-rules.js): left of the work area,
// left of the sidebar (between the canvas and the sidebar), right of the sidebar, or in a row above or below the work area (side by side there). Drag its head to one of those (or onto a column) to
// dock it there, drag a docked one's head away to float it again, or pick a place from its Dock button (or a right-click / long hold
// on its head). Docked panels share their column's height; the column's inner edge drags its width. Over a full-screen view the
// docked ones float at their floating place until it closes (the full-screen view covers the columns), as the ones left of the sidebar
// do in portrait or on a screen without a sidebar. Kept on this device too.
//   floatPanel({ key, title, cls, buttons, inside }) → { el, body, title(words), show(), hide(), shown(), dragBy(el), docked(), dock(side | null) }
//     key: where the place is kept. buttons: more in the head. inside: the whole panel stays on the screen and clear of the Generate bar
//     (otherwise a corner of it is enough). dragBy(el): something else in it to drag it by.
import { h, store } from './ui.js';
import { icon } from './icons.js';
import { openPressMenu, pressMenu } from './press-menu.js';
import { DOCK_SIDES, DOCK_NAMES, dockZones, dockSide, dockIndex, dockWidth, dockHeight, isRow } from './dock-rules.js';

// ---- the dock columns, made when first wanted: left and right beside main, mid inside the open screen before its splitter ----
const COLS = {};
const colKey = (side) => `deck.dock.${side}.${isRow(side) ? 'h' : 'w'}`;   // (a row keeps its height)
const portrait = () => matchMedia('(max-width: 900px), (orientation: portrait)').matches;
const maxed = () => !!document.querySelector('.stage.maxed');
const shownIn = (col) => !!col && !col.classList.contains('flat') && [...col.children].some((c) => c.matches('.float-panel.docked:not(.hidden)') && c.offsetParent !== null);
// the splitter of the screen on show, when it is side by side (the place left of the sidebar is before it)
const splitNow = () => (portrait() ? null : document.querySelector('main > .tab.active > .splitter, main > .tab.live-host > .splitter'));
function placeMid() {
  const col = COLS.mid;
  if (!col) return;
  const sp = splitNow();
  if (sp) { if (col.nextElementSibling !== sp) sp.before(col); } else if (col.parentElement !== document.body) document.body.append(col);
  if (col.classList.contains('flat') === !sp) return;
  col.classList.toggle('flat', !sp);   // (no sidebar side by side: its panels float, kept on the screen)
  dispatchEvent(new Event('resize'));
}
function dockCol(side) {
  if (COLS[side]?.isConnected) return COLS[side];
  const row = isRow(side);   // (a row: its panels side by side, its grip along its inner edge, dragged for its height)
  const col = h('div', { class: `float-dock ${side}${row ? ' row' : ''}`, 'data-side': side, role: 'complementary', 'aria-label': `Docked panels, ${DOCK_NAMES[side].toLowerCase()}` });
  const grip = h('div', { class: 'float-dock-grip', role: 'separator', 'aria-orientation': row ? 'horizontal' : 'vertical', tabIndex: 0, title: `Drag to resize the docked panels (double-tap: back to the usual ${row ? 'height' : 'width'})` });
  const setW = (w) => {
    const px = w == null ? null : row ? dockHeight(w, innerHeight) : dockWidth(w, innerWidth);
    store.set(colKey(side), px);
    if (row) col.style.height = `${px ?? 220}px`; else col.style.width = `${px ?? 300}px`;
    if (row) dispatchEvent(new Event('resize'));   // (the work area changed height)
  };
  setW(store.get(colKey(side), null));
  const fromLeft = side === 'left' || side === 'top';   // (its grip is on its right, or under it; the others' on their left, or over them)
  let lastTap = 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (Date.now() - lastTap < 300) { lastTap = 0; setW(null); return; }
    lastTap = Date.now();
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    grip.classList.add('dragging');
    const r = col.getBoundingClientRect();
    const move = (ev) => setW(row ? (fromLeft ? ev.clientY - r.top : r.bottom - ev.clientY) : fromLeft ? ev.clientX - r.left : r.right - ev.clientX);
    const up = () => { grip.classList.remove('dragging'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('keydown', (e) => {
    const d = (row ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 })[e.key];
    if (!d) return;
    e.preventDefault();
    setW((row ? col.offsetHeight : col.offsetWidth) + (fromLeft ? d : -d) * 24);
  });
  col.append(grip);
  document.body.append(col);
  COLS[side] = col;
  if (side === 'mid') {   // (it follows the screen on show, and portrait)
    const mo = new MutationObserver(placeMid);
    for (const t of document.querySelectorAll('main > .tab')) mo.observe(t, { attributes: true, attributeFilter: ['class'] });
    matchMedia('(max-width: 900px), (orientation: portrait)').addEventListener('change', placeMid);
    placeMid();
  }
  return col;
}
// where a drop lands while dragging: the column it joins, or a strip where a new one would be
let HINT = null;
function showHint(side) {
  if (!side) { HINT?.classList.add('hidden'); return; }
  HINT ||= document.body.appendChild(h('div', { class: 'dock-hint hidden', 'aria-hidden': 'true' }));
  const col = COLS[side], m = document.querySelector('main')?.getBoundingClientRect(), sp = splitNow()?.getBoundingClientRect();
  if (!m) return;
  const r = shownIn(col) ? col.getBoundingClientRect() : null;
  if (isRow(side)) {
    const hgt = r ? r.height : dockHeight(store.get(colKey(side), null), innerHeight);
    const top = r ? r.top : side === 'top' ? m.top : m.bottom - hgt;
    Object.assign(HINT.style, { top: `${top}px`, height: `${hgt}px`, width: `${m.width}px`, left: `${m.left}px` });
  } else {
    const w = r ? r.width : dockWidth(store.get(colKey(side), null), innerWidth);
    const left = r ? r.left : side === 'left' ? m.left : side === 'mid' ? (sp?.left ?? m.right) - w : m.right - w;
    Object.assign(HINT.style, { top: `${m.top}px`, height: `${m.height}px`, width: `${w}px`, left: `${left}px` });
  }
  HINT.classList.remove('hidden');
}
function sideAt(x, y) {
  const m = document.querySelector('main')?.getBoundingClientRect();
  if (!m || maxed()) return null;   // (a full-screen view covers the columns)
  const cols = {};
  for (const s of DOCK_SIDES) if (shownIn(COLS[s])) { const r = COLS[s].getBoundingClientRect(); cols[s] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
  const sp = splitNow()?.getBoundingClientRect();
  return dockSide(x, dockZones({ left: m.left, right: m.right, top: m.top, bottom: m.bottom }, sp?.width ? { left: sp.left, right: sp.right } : null, cols), y);
}

export function floatPanel({ key, title = '', cls = '', buttons = [], inside = false }) {
  const words = h('span', { class: 'float-title' }, title);
  // the places to dock it, and Float: from the Dock button, or a right-click / long hold on the head
  const placeMenu = (x, y) => openPressMenu(x, y, [
    DOCK_SIDES.map((s) => ({ label: DOCK_NAMES[s], on: side === s, run: () => dock(s) })),
    [{ label: 'Float', on: !side, run: () => dock(null) }]], 'Dock');
  const dockBtn = h('button', { type: 'button', class: 'icon-btn float-dock-btn', 'aria-haspopup': 'menu', onmousedown: (e) => e.preventDefault(),   // (keeps the cursor where it was: the hints type into it)
    onclick: () => { const r = dockBtn.getBoundingClientRect(); placeMenu(r.left, r.bottom + 4); } });
  const head = h('div', { class: 'float-head' }, words, h('span', { class: 'float-btns' }, dockBtn, ...buttons));
  const body = h('div', { class: 'float-body' });
  const el = h('div', { class: `float-panel hidden ${cls}`.trim(), role: 'dialog', 'aria-label': title }, head, body);
  document.body.append(el);
  let side = null;
  const floating = () => !side || maxed() || !!COLS[side]?.classList.contains('flat');
  const keep = () => {   // (always reachable: the window may have shrunk)
    if (!floating()) return;
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
  const saveAt = () => {
    if (!floating()) return;
    const r = el.getBoundingClientRect();
    store.set(`${key}.at`, { x: r.left, y: r.top, w: r.width, h: el.classList.contains('folded') ? (store.get(`${key}.at`, null)?.h ?? null) : r.height });
  };
  const label = () => {
    const t = side ? `Docked ${DOCK_NAMES[side].toLowerCase()}: move it or float it` : 'Dock it (or drag its title to a side of the work area, its top or bottom, or beside the sidebar)';
    dockBtn.replaceChildren(icon('dock'));
    dockBtn.title = t; dockBtn.setAttribute('aria-label', t);
    el.classList.toggle('docked', !!side);
  };
  // dock(side): into that side's column (at its index among the panels there, default last); null: floating again
  function dock(to, { at = null } = {}) {
    if (to && !DOCK_SIDES.includes(to)) to = null;
    side = to;
    store.set(`${key}.dock`, side);
    if (side) {
      const col = dockCol(side), there = [...col.querySelectorAll(':scope > .float-panel')].filter((p) => p !== el);
      col.insertBefore(el, at == null ? null : there[at] || null);
    } else if (el.parentElement !== document.body) {
      document.body.append(el);
      keep();
    }
    label();
    if (side && floating()) keep();   // (left of the sidebar, with no sidebar beside it: it floats)
    dispatchEvent(new Event('resize'));   // (the work area changed width: canvases and the table fit it again)
  }
  const dragBy = (grip) => grip.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.button > 0) return;
    const r = el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    let dx = e.clientX - r.left, dy = e.clientY - r.top, lifted = floating(), drop = null;
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!lifted) {   // a docked one floats once it's dragged a little way
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
        dock(null);
        try { grip.setPointerCapture(ev.pointerId); } catch { /* moving it in the page let go of the pointer */ }
        const w = el.getBoundingClientRect().width;
        dx = Math.min(dx, w - 40); dy = Math.min(dy, 20);
        lifted = true;
      }
      el.style.left = `${ev.clientX - dx}px`; el.style.top = `${ev.clientY - dy}px`; keep();
      drop = sideAt(ev.clientX, ev.clientY);
      showHint(drop);
      drop &&= { side: drop, x: ev.clientX, y: ev.clientY };
    };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      showHint(null);
      if (!lifted) return;
      saveAt();
      if (drop) {
        const col = COLS[drop.side];
        const across = isRow(drop.side);   // (a row's panels are side by side: its place among them goes by x)
        const mids = col ? [...col.querySelectorAll(':scope > .float-panel:not(.hidden)')].filter((p) => p !== el).map((p) => { const b = p.getBoundingClientRect(); return across ? b.left + b.width / 2 : b.top + b.height / 2; }) : [];
        dock(drop.side, { at: dockIndex(across ? drop.x : drop.y, mids) });
      }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  dragBy(head);
  pressMenu(head, (e) => placeMenu(e.clientX, e.clientY), { ok: (e) => !e.target.closest('button') });
  new ResizeObserver(() => { if (el.classList.contains('hidden')) return; if (inside) keep(); saveAt(); }).observe(el);
  addEventListener('resize', () => { if (!el.classList.contains('hidden')) keep(); });
  const at = store.get(`${key}.at`, null);
  if (at) Object.assign(el.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, ...(at.h ? { height: `${at.h}px` } : {}) });
  const was = store.get(`${key}.dock`, null);
  if (DOCK_SIDES.includes(was)) dock(was); else label();
  return { el, body, head, dragBy, title: (t) => { words.textContent = t; }, shown: () => !el.classList.contains('hidden'),
    docked: () => side, dock: (s) => dock(s),
    show() { const was = el.classList.contains('hidden'); el.classList.remove('hidden'); keep(); if (was && side) dispatchEvent(new Event('resize')); },
    hide() { const was = !el.classList.contains('hidden'); el.classList.add('hidden'); if (was && side) dispatchEvent(new Event('resize')); } };
}
