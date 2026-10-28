import { h } from './ui.js';
import { switchTab } from './core.js';

// ---------------------------------------------------------------------------
// world (ComfyChair Lab): the app as a place you move around in. One finger touches things, two move the
// surface (zoom, pan), three move you: sideways to the next tab (a layout), up and down to the next group of
// its settings (a menu set). The tab follows the fingers and springs into place, and a map of where you are
// shows while you travel. Alt + arrow keys travel too. Only the Lab branch loads this (app.js); the rest of
// the app is the same code as the main copy, so the two never drift apart.
// ---------------------------------------------------------------------------
const FINGERS = 3;
const tabBtns = () => [...document.querySelectorAll('nav.tabs button[data-tab]')].filter((b) => !b.hidden && b.offsetParent !== null);
const here = () => tabBtns().findIndex((b) => b.classList.contains('active'));
const tabEl = () => document.querySelector('.tab.active');
// the open tab's menu sets: its side panel's groups (layout.js sideNav), else nothing (Board, History)
const groups = () => [...(tabEl()?.querySelectorAll('.side-nav .side-tab') || [])];
const groupHere = () => Math.max(0, groups().findIndex((b) => b.classList.contains('on')));

// ---- a spring: x eases to `to` with a little overshoot; v is the speed it starts with (px/s) ----
function spring(from, to, frame, { k = 240, c = 21, v = 0 } = {}) {
  return new Promise((done) => {
    let x = from, last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      v += (-k * (x - to) - c * v) * dt;
      x += v * dt;
      if (Math.abs(x - to) < 0.4 && Math.abs(v) < 8) { frame(to); done(); return; }
      frame(x);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// how far the tab gives up or down: a little, and less the further you pull (it doesn't leave its place)
const give = (dy) => 48 * Math.tanh(dy / 160);
// the tab leans into the move: a slide with a slight turn, as if the layouts sat round you
function lean(el, dx, dy = 0) {
  const w = el.clientWidth || innerWidth, f = dx / w;
  el.style.transform = dx || dy
    ? `perspective(1400px) translate(${dx}px, ${dy}px) rotateY(${-f * 10}deg) scale(${1 - Math.min(0.08, Math.abs(f) * 0.08 + Math.abs(dy) / 4000)})`
    : '';
}

// ---- the map: a column per tab, the open one showing its menu sets; the place you'd land on lights up ----
const map = h('div', { class: 'world-map', 'aria-hidden': 'true' });
let mapTimer = 0;
function showMap(col = here(), row = groupHere()) {
  const btns = tabBtns(), sets = groups(), at = here();
  map.replaceChildren(...btns.map((b, i) => h('div', { class: `wm-col${i === at ? ' here' : ''}${i === col ? ' to' : ''}` },
    h('span', { class: 'wm-icon' }, b.querySelector('svg')?.cloneNode(true) || b.textContent.trim()[0]),
    i === at && sets.length ? h('div', { class: 'wm-sets' }, ...sets.map((s, j) =>
      h('span', { class: `wm-set${j === row && i === col ? ' to' : ''}`, title: s.title }))) : null,
    h('span', { class: 'wm-name' }, b.title))));
  map.classList.add('on');
  clearTimeout(mapTimer);
}
const hideMap = (after = 900) => { clearTimeout(mapTimer); mapTimer = setTimeout(() => map.classList.remove('on'), after); };

// ---- travel: to the tab next door (dir ±1), or the menu set above / below ----
let moving = false;
async function travelX(dir, { dx = 0, v = 0 } = {}) {
  const btns = tabBtns(), i = here(), j = i + dir, el = tabEl();
  if (moving || !el) return;
  if (j < 0 || j >= btns.length) { showMap(i); await spring(dx, 0, (x) => lean(el, x), { v }); hideMap(); return; }   // the edge of the world
  moving = true;
  showMap(j);
  const w = el.clientWidth || innerWidth;
  await spring(dx, -dir * w * 0.45, (x) => lean(el, x), { k: 520, c: 40, v });   // the old layout swings away…
  lean(el, 0);
  switchTab(btns[j].dataset.tab);
  const next = tabEl();
  showMap(j);
  await spring(dir * w * 0.35, 0, (x) => lean(next, x));                          // …and the next one springs in
  moving = false;
  hideMap();
}
async function travelY(dir, { dy = 0, v = 0 } = {}) {
  const el = tabEl();
  if (!el || moving) return;
  const sets = groups(), i = groupHere(), j = Math.min(sets.length - 1, Math.max(0, i + dir));
  showMap(here(), j);
  if (sets.length && j !== i) sets[j].click();   // (sideNav scrolls the panel to that group)
  else if (!sets.length) (el.querySelector('.panel, .board, .history') || el).scrollBy({ top: dir * innerHeight * 0.6, behavior: 'smooth' });
  await spring(dy, 0, (y) => lean(el, 0, y), { v });
  hideMap();
}

// ---- three fingers: follow them, then travel (or spring back) when they lift ----
const P = new Map();   // touch pointers down: id -> { x, y, target }
let G = null;          // the gesture: { x0, y0, axis, dx, dy, t, v }
const mid = () => {
  let x = 0, y = 0;
  for (const p of P.values()) { x += p.x; y += p.y; }
  return { x: x / P.size, y: y / P.size };
};
function begin() {
  const m = mid();
  G = { x0: m.x, y0: m.y, axis: null, dx: 0, dy: 0, trail: [] };
  // the fingers that landed first were a drag or a pinch: call it off (as the browser does on a system gesture)
  for (const [id, p] of P) p.target?.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true }));
  showMap();
}
function follow() {
  const m = mid(), el = tabEl(), now = performance.now();
  const dx = m.x - G.x0, dy = m.y - G.y0;
  if (!G.axis && Math.hypot(dx, dy) > 18) G.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  G.dx = dx; G.dy = dy;
  G.trail.push({ t: now, dx, dy });
  while (G.trail.length > 2 && now - G.trail[0].t > 120) G.trail.shift();   // (the last ~0.1 s: how fast the flick is)
  if (!el || moving) return;
  if (G.axis === 'x') {
    const i = here() - Math.sign(dx), edge = i < 0 || i >= tabBtns().length;
    lean(el, edge ? dx * 0.3 : dx);   // rubber band at the ends
    showMap(Math.abs(dx) > 60 && !edge ? i : here());
  } else if (G.axis === 'y') {
    lean(el, 0, give(dy));
    const sets = groups(), j = Math.min(sets.length - 1, Math.max(0, groupHere() - Math.sign(dy)));
    showMap(here(), Math.abs(dy) > 50 ? j : groupHere());
  }
}
// px/s along the axis over the last ~0.1 s
function speed(g) {
  const a = g.trail[0], b = g.trail[g.trail.length - 1], dt = b && b.t - a.t;
  if (!dt || dt < 30) return 0;
  return ((g.axis === 'x' ? b.dx - a.dx : b.dy - a.dy) / dt) * 1000;
}
function finish() {
  const g = G, el = tabEl();
  G = null;
  if (!el) return;
  g.v = speed(g);
  const w = el.clientWidth || innerWidth;
  if (g.axis === 'x' && (Math.abs(g.dx) > w * 0.18 || Math.abs(g.v) > 900)) travelX(g.dx < 0 ? 1 : -1, { dx: g.dx, v: g.v });
  else if (g.axis === 'y' && (Math.abs(g.dy) > 50 || Math.abs(g.v) > 700)) travelY(g.dy < 0 ? 1 : -1, { dy: give(g.dy), v: g.v * 0.2 });
  else if (g.axis === 'y') spring(give(g.dy), 0, (y) => lean(el, 0, y)).then(() => hideMap());   // not far enough: back it goes
  else spring(g.dx, 0, (x) => lean(el, x)).then(() => hideMap());
}

const own = (e) => { if (G) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } };
addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  P.set(e.pointerId, { x: e.clientX, y: e.clientY, target: e.target });
  if (P.size === FINGERS && !G && !document.querySelector('.sheet:not(.hidden), .overlay:not(.hidden)')) begin();
  own(e);
}, true);
addEventListener('pointermove', (e) => {
  const p = P.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (G) { follow(); own(e); }
}, true);
const lift = (e) => {
  if (!P.has(e.pointerId)) return;
  const was = !!G;
  P.delete(e.pointerId);
  if (was) { own(e); finish(); }
};
addEventListener('pointerup', lift, true);
addEventListener('pointercancel', (e) => { if (e.isTrusted) lift(e); }, true);   // (not the cancels begin() sends)
// three fingers also mean nothing to the page underneath (no scroll, no zoom)
addEventListener('touchmove', (e) => { if (G && e.cancelable) e.preventDefault(); }, { capture: true, passive: false });

// ---- keys: Alt + ← → between tabs, Alt + ↑ ↓ between menu sets ----
addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select')) return;
  const go = { ArrowLeft: () => travelX(-1), ArrowRight: () => travelX(1), ArrowUp: () => travelY(-1), ArrowDown: () => travelY(1) }[e.key];
  if (go) { e.preventDefault(); go(); }
});

document.documentElement.classList.add('lab');
document.body.append(map);
document.querySelector('.brand')?.append(h('sup', { class: 'lab-badge', title: 'ComfyChair Lab: the experimental copy' }, 'Lab'));
