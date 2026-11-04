// A menu at the pointer: a right click with a mouse, a long hold with a finger.
// An item with `sub` (groups, or a function giving them) opens a submenu beside it: on hover with a mouse, on a tap with
// a finger, or → from the keyboard (← and Esc close it again).
import { h, icon } from './ui.js';
import { menuSpot, subSpot } from './layer-menu.js';

const HOLD_MS = 500, SLIP_PX = 10, HOVER_MS = 120;
let menuEl = null, subEl = null, subOf = null, hoverT = 0;

export function closePressMenu() {
  closeSub();
  menuEl?.remove(); menuEl = null;
  removeEventListener('pointerdown', away, true);
  removeEventListener('keydown', onKey, true);
  removeEventListener('blur', closePressMenu);
}
function closeSub() {
  clearTimeout(hoverT);
  subOf?.classList.remove('open'); subOf?.setAttribute('aria-expanded', 'false');
  subEl?.remove(); subEl = null; subOf = null;
}
// (the submenu counts as inside the menu)
function away(e) { if (menuEl && !menuEl.contains(e.target) && !subEl?.contains(e.target)) closePressMenu(); }
const buttonsIn = (el) => [...el.querySelectorAll('button:not(:disabled)')];
function onKey(e) {
  if (!menuEl) return;
  const inSub = !!subEl?.contains(document.activeElement);
  if (e.key === 'Escape') {
    e.stopPropagation(); e.preventDefault();
    if (subEl) { const at = subOf; closeSub(); at?.focus(); } else closePressMenu();
    return;
  }
  if (e.key === 'ArrowRight' && document.activeElement?.classList.contains('has-sub')) {
    e.preventDefault(); openSub(document.activeElement, { focus: true }); return;
  }
  if (e.key === 'ArrowLeft' && inSub) { e.preventDefault(); const at = subOf; closeSub(); at?.focus(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = buttonsIn(inSub ? subEl : menuEl), at = items.indexOf(document.activeElement), by = e.key === 'ArrowDown' ? 1 : -1;
  items[(at + by + items.length) % items.length]?.focus();
}

const groupsOf = (sub) => (typeof sub === 'function' ? sub() : sub) || [];
function itemEl(it, { inSub = false } = {}) {
  const sub = !!it.sub;
  const label = sub ? String(it.label).replace(/\s*▸$/, '') : it.label;
  const el = h('button', { type: 'button', role: 'menuitem', class: `press-item${it.danger ? ' danger' : ''}${sub ? ' has-sub' : ''}`, disabled: !!it.disabled,
    title: it.title || null, ...(sub ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}) },
  h('span', { class: 'press-tick' }, it.on ? icon('check') : null), h('span', { class: 'press-label' }, label),
  it.keys ? h('span', { class: 'press-keys' }, it.keys) : null, sub ? h('span', { class: 'press-arrow', 'aria-hidden': 'true' }, '▸') : null);
  if (sub) {
    el._sub = it.sub;
    el.addEventListener('click', () => (subOf === el ? closeSub() : openSub(el, { focus: false })));
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || el.disabled) return;
      clearTimeout(hoverT); hoverT = setTimeout(() => { if (subOf !== el) openSub(el); }, HOVER_MS);
    });
  } else {
    el.addEventListener('click', () => { closePressMenu(); it.run?.(); });
    // a mouse on another item of the main menu: the open submenu goes after the same pause
    if (!inSub) el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && subEl) { clearTimeout(hoverT); hoverT = setTimeout(closeSub, HOVER_MS); } });
  }
  el.addEventListener('pointerleave', () => clearTimeout(hoverT));
  return el;
}
function openSub(owner, { focus = false } = {}) {
  closeSub();
  let got = groupsOf(owner._sub);
  if (typeof got?.then === 'function') {   // (a sub that has to read something first: "Reading…" until it comes)
    const was = got;
    owner._sub = [[{ label: 'Reading…', disabled: true }]];
    was.then((g) => g, (e) => [[{ label: `Couldn't read it: ${e.message}`, disabled: true }]]).then((g) => {
      owner._sub = g?.length ? g : [[{ label: 'Nothing here', disabled: true }]];
      if (subOf === owner) openSub(owner, { focus });
    });
    got = owner._sub;
  }
  const groups = got.map((g) => g.filter(Boolean)).filter((g) => g.length);
  if (!groups.length) return;
  subOf = owner; owner.classList.add('open'); owner.setAttribute('aria-expanded', 'true');
  subEl = h('div', { class: 'press-menu press-sub', role: 'menu', 'aria-label': owner.querySelector('.press-label')?.textContent || 'More', oncontextmenu: (e) => e.preventDefault() },
    groups.map((g) => h('div', { class: 'press-group' }, g.map((it) => itemEl2(it)))));
  subEl.addEventListener('pointerenter', () => clearTimeout(hoverT));
  menuEl.parentElement.append(subEl);
  const r = owner.getBoundingClientRect();
  const { left, top } = subSpot(r, subEl.offsetWidth, subEl.offsetHeight, innerWidth, innerHeight);
  Object.assign(subEl.style, { left: `${left}px`, top: `${top}px` });
  if (focus) buttonsIn(subEl)[0]?.focus();
}
const itemEl2 = (it) => itemEl(it.sub ? { ...it, sub: null, disabled: true } : it, { inSub: true });   // (one level deep)

// groups: [[{ label, keys, on, danger, disabled, title, run, sub }]], with a line between groups
export function openPressMenu(x, y, groups, label = 'Actions') {
  closePressMenu();
  if (!groups.length) return;
  menuEl = h('div', { class: 'press-menu', role: 'menu', 'aria-label': label, oncontextmenu: (e) => e.preventDefault() },
    groups.map((g) => h('div', { class: 'press-group' }, g.map((it) => itemEl(it)))));
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
