// A menu at the pointer: a right click with a mouse, a long hold with a finger.
import { h, icon } from './ui.js';
import { menuSpot } from './layer-menu.js';

const HOLD_MS = 500, SLIP_PX = 10;
let menuEl = null;

export function closePressMenu() {
  menuEl?.remove(); menuEl = null;
  removeEventListener('pointerdown', away, true);
  removeEventListener('keydown', onKey, true);
  removeEventListener('blur', closePressMenu);
}
function away(e) { if (menuEl && !menuEl.contains(e.target)) closePressMenu(); }
function onKey(e) {
  if (!menuEl) return;
  if (e.key === 'Escape') { e.stopPropagation(); closePressMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...menuEl.querySelectorAll('button:not(:disabled)')], at = items.indexOf(document.activeElement), by = e.key === 'ArrowDown' ? 1 : -1;
  items[(at + by + items.length) % items.length]?.focus();
}

// groups: [[{ label, keys, on, danger, disabled, run }]], with a line between groups
export function openPressMenu(x, y, groups, label = 'Actions') {
  closePressMenu();
  if (!groups.length) return;
  const item = (it) => h('button', { type: 'button', role: 'menuitem', class: `press-item${it.danger ? ' danger' : ''}`, disabled: !!it.disabled,
    onclick: () => { closePressMenu(); it.run(); } },
  h('span', { class: 'press-tick' }, it.on ? icon('check') : null), h('span', { class: 'press-label' }, it.label), it.keys ? h('span', { class: 'press-keys' }, it.keys) : null);
  menuEl = h('div', { class: 'press-menu', role: 'menu', 'aria-label': label, oncontextmenu: (e) => e.preventDefault() },
    groups.map((g) => h('div', { class: 'press-group' }, g.map(item))));
  (document.fullscreenElement || document.body).append(menuEl);   // (full screen shows only what's inside it)
  const { left, top } = menuSpot(x, y, menuEl.offsetWidth, menuEl.offsetHeight, innerWidth, innerHeight);
  Object.assign(menuEl.style, { left: `${left}px`, top: `${top}px` });
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', onKey, true);
  addEventListener('blur', closePressMenu);
}

// el's own menu: open(e) is given the press, with its clientX and clientY. ok(e): whether this press is one for the menu at all.
// A text box keeps the browser's menu, for pasting and spelling. A finger that moves is scrolling or dragging, so the hold ends there.
// The click that ends a hold is dropped, or it would also tap what's under the finger.
export function pressMenu(el, open, { ok = () => true } = {}) {
  const fieldHere = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');
  let timer = 0, start = null, fingers = 0, held = false;
  const stop = () => { clearTimeout(timer); timer = 0; start = null; };
  const fire = (e) => { stop(); held = true; try { navigator.vibrate?.(20); } catch { /* not supported */ } open(e); };
  el.addEventListener('pointerdown', (e) => {
    held = false;
    if (e.pointerType !== 'touch') return;
    fingers = e.isPrimary ? 1 : fingers + 1;
    if (fingers > 1 || fieldHere(e) || !ok(e)) return stop();
    start = { x: e.clientX, y: e.clientY };
    const at = { clientX: e.clientX, clientY: e.clientY, target: e.target };
    timer = setTimeout(() => fire(at), HOLD_MS);
  }, true);
  el.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLIP_PX) stop(); }, true);
  for (const type of ['pointerup', 'pointercancel']) el.addEventListener(type, (e) => { if (e.pointerType === 'touch') fingers = Math.max(0, fingers - 1); stop(); }, true);
  el.addEventListener('click', (e) => { if (held) { held = false; e.stopPropagation(); e.preventDefault(); } }, true);
  el.addEventListener('contextmenu', (e) => {
    if (fieldHere(e)) return;
    e.preventDefault();
    if (held || !ok(e)) return;   // (Android sends this for a long hold too)
    fire(e);
    if (!e.pointerType || e.pointerType === 'mouse') held = false;   // (no click follows a right click, so don't wait for one)
  });
}
