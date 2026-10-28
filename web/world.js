import { h, toast } from './ui.js';
import { switchTab } from './core.js';

// ---------------------------------------------------------------------------
// world (ComfyChair Lab): the app as a small world of three spaces you move around in.
//   Make  (Generate, VFX, 3D)       where things get made: a process, its inputs, a big GO
//   Edit  (Editor, Video, Sound)    where made things are put together in space and time
//   View  (Board, History)          where everything made is seen and sent on
// One finger touches things, two move the surface (zoom, pan), three move you: sideways to the space next
// door, up and down through the tools in this one. The tab follows the fingers and springs into place, and a
// map shows where you are while you travel. A sideways swipe along the top bar travels too, and Alt + arrows.
//
// Swipes stay clear of the tablet's own: a three-finger swipe that starts at a screen edge (where Android's
// back gesture lives) is left alone, the page never overscrolls sideways (Chrome's swipe back / forward), and
// if Back does fire with nothing open, it goes to the tool you were on before instead of leaving the app.
//
// Only the Lab branch loads this (app.js); the tabs themselves are the main copy's, so the two never drift.
// ---------------------------------------------------------------------------
const SPACES = [
  { id: 'make', name: 'Make', tabs: ['generate', 'vfx', 'scene'], icon: ['M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z', 'M5 21l4-4'] },
  { id: 'edit', name: 'Edit', tabs: ['editor', 'video', 'sound'], icon: ['M4 6h10M4 12h16M4 18h7', 'M17 4v4M14 16v4'] },
  { id: 'view', name: 'View', tabs: ['board', 'history'], icon: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'] },
];
const FINGERS = 3;
const EDGE = 32;   // px from the left / right edge: Android's back gesture starts there

const btnOf = (tab) => document.querySelector(`nav.tabs button[data-tab="${tab}"]`);
const tabNow = () => document.querySelector('nav.tabs button.active')?.dataset.tab;
const spaceOf = (tab) => SPACES.findIndex((s) => s.tabs.includes(tab));
const tabsIn = (si) => SPACES[si].tabs.filter((t) => btnOf(t));
const tabEl = () => document.querySelector('.tab.active');
const last = {};          // space id -> the tool last open there (where travelling back to it lands)
const been = [];          // the tools visited, for Back
const svgIcon = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
};

// ---- the top bar: the three spaces, then the tools of the one you're in (the main copy's tab buttons) ----
const bar = h('div', { class: 'spaces', role: 'tablist', 'aria-label': 'Spaces' }, ...SPACES.map((s, i) =>
  h('button', { type: 'button', class: 'space-btn', role: 'tab', 'data-space': s.id, title: `${s.name}: ${s.tabs.map((t) => btnOf(t)?.title).join(', ')}`,
    onclick: () => go(i) }, svgIcon(s.icon), h('span', {}, s.name))));
function paint() {
  const tab = tabNow(), si = spaceOf(tab), nav = document.querySelector('nav.tabs');
  if (si < 0) return;
  last[SPACES[si].id] = tab;
  if (been[been.length - 1] !== tab) { been.push(tab); if (been.length > 40) been.shift(); }
  [...bar.children].forEach((b, i) => { b.classList.toggle('on', i === si); b.setAttribute('aria-selected', String(i === si)); });
  for (const b of nav.querySelectorAll('button[data-tab]')) b.classList.toggle('off-space', spaceOf(b.dataset.tab) !== si);
  // a run going on in Generate shows on Make while you're elsewhere
  const run = btnOf('generate')?.style.getPropertyValue('--run') || '';
  bar.children[0].style.setProperty('--run', si === 0 ? '0%' : run || '0%');
}

// a space's button: to the tool last open there, travelling the way it lies
function go(si) {
  const to = last[SPACES[si].id] || tabsIn(si)[0], from = spaceOf(tabNow());
  if (!to || to === tabNow()) return;
  travelTo(to, { axis: 'x', dir: si > from ? 1 : -1 });
}

// ---- a spring: x eases to `to` with a little overshoot; v is the speed it starts with (px/s) ----
function spring(from, to, frame, { k = 240, c = 21, v = 0 } = {}) {
  return new Promise((done) => {
    let x = from, t0 = performance.now();
    const step = (now) => {
      const dt = Math.min(0.032, (now - t0) / 1000);
      t0 = now;
      v += (-k * (x - to) - c * v) * dt;
      x += v * dt;
      if (Math.abs(x - to) < 0.4 && Math.abs(v) < 8) { frame(to); done(); return; }
      frame(x);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// the tab leans into the move, as if the spaces sat round you and the tools stood one above the other
function lean(el, dx, dy = 0) {
  if (!el) return;
  const fx = dx / (el.clientWidth || innerWidth), fy = dy / (el.clientHeight || innerHeight);
  el.style.transform = dx || dy
    ? `perspective(1400px) translate(${dx}px, ${dy}px) rotateY(${-fx * 10}deg) rotateX(${fy * 8}deg) scale(${1 - Math.min(0.08, (Math.abs(fx) + Math.abs(fy)) * 0.08)})`
    : '';
}

// ---- the map: a column per space with its tools; where you are, and where you'd land, light up ----
const map = h('div', { class: 'world-map', 'aria-hidden': 'true' });
let mapTimer = 0;
function showMap(target = tabNow()) {
  const here = tabNow();
  map.replaceChildren(...SPACES.map((s, i) => h('div', { class: `wm-col${spaceOf(here) === i ? ' here' : ''}${spaceOf(target) === i ? ' to' : ''}` },
    h('span', { class: 'wm-space' }, svgIcon(s.icon), s.name),
    ...tabsIn(i).map((t) => h('span', { class: `wm-tool${t === here ? ' here' : ''}${t === target ? ' to' : ''}` },
      btnOf(t).querySelector('svg')?.cloneNode(true) || '', btnOf(t).title)))));
  map.classList.add('on');
  clearTimeout(mapTimer);
}
const hideMap = (after = 900) => { clearTimeout(mapTimer); mapTimer = setTimeout(() => map.classList.remove('on'), after); };

// ---- travel: the old tab swings away along the move, the new one springs in from the other side ----
let moving = false;
// where a move lands: sideways ±1 a space (at its last tool), up / down ±1 a tool in this space (null: the edge)
function landing(axis, dir) {
  const tab = tabNow(), si = spaceOf(tab);
  if (si < 0) return null;
  if (axis === 'x') { const sj = si + dir; return sj >= 0 && sj < SPACES.length ? last[SPACES[sj].id] || tabsIn(sj)[0] : null; }
  const ts = tabsIn(si), j = ts.indexOf(tab) + dir;
  return j >= 0 && j < ts.length ? ts[j] : null;
}
const along = (axis, el) => (x) => (axis === 'x' ? lean(el, x, 0) : lean(el, 0, x));
async function travel(axis, dir, { d = 0, v = 0 } = {}) {
  const el = tabEl(), to = landing(axis, dir);
  if (moving || !el) return;
  if (!to) { showMap(); await spring(d, 0, along(axis, el), { v }); hideMap(); return; }   // the edge of the world: it gives, then settles
  return travelTo(to, { axis, dir, d, v });
}
async function travelTo(to, { axis = 'x', dir = 1, d = 0, v = 0 } = {}) {
  const el = tabEl();
  if (moving || !el) return;
  moving = true;
  showMap(to);
  const size = axis === 'x' ? el.clientWidth || innerWidth : el.clientHeight || innerHeight;
  await spring(d, -dir * size * 0.4, along(axis, el), { k: 520, c: 40, v });   // the old one swings away…
  lean(el, 0);
  switchTab(to);
  showMap(to);
  await spring(dir * size * 0.3, 0, along(axis, tabEl()));                   // …and the next springs in
  moving = false;
  hideMap();
}

// ---- three fingers: follow them, then travel (or spring back) when they lift ----
const P = new Map();   // touch pointers down: id -> { x, y, x0, target }
let G = null;          // the gesture: { x0, y0, axis, dx, dy, shown, trail }
const mid = () => {
  let x = 0, y = 0;
  for (const p of P.values()) { x += p.x; y += p.y; }
  return { x: x / P.size, y: y / P.size };
};
const nearEdge = () => [...P.values()].some((p) => p.x0 < EDGE || p.x0 > innerWidth - EDGE);
function begin() {
  const m = mid();
  G = { x0: m.x, y0: m.y, axis: null, dx: 0, dy: 0, shown: 0, trail: [] };
  // the fingers that landed first were a drag or a pinch: call it off (as the browser does for its own gestures)
  for (const [id, p] of P) p.target?.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true }));
  showMap();
}
// how far the tab gives up or down before it travels: less the further you pull (it stays in reach)
const give = (d, room) => room * 0.3 * Math.tanh(d / (room * 0.3));
const roomOf = (axis, el) => (axis === 'x' ? el.clientWidth || innerWidth : el.clientHeight || innerHeight);
function follow() {
  const m = mid(), el = tabEl(), now = performance.now();
  const dx = m.x - G.x0, dy = m.y - G.y0;
  if (!G.axis && Math.hypot(dx, dy) > 18) G.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  G.dx = dx; G.dy = dy;
  G.trail.push({ t: now, dx, dy });
  while (G.trail.length > 2 && now - G.trail[0].t > 120) G.trail.shift();   // (the last ~0.1 s: how fast the flick is)
  if (!el || moving || !G.axis) return;
  const d = G.axis === 'x' ? dx : dy, to = landing(G.axis, d < 0 ? 1 : -1);
  G.shown = !to ? d * 0.25 : G.axis === 'x' ? d : give(d, roomOf('y', el));   // rubber band at the edges of the world
  along(G.axis, el)(G.shown);
  showMap(Math.abs(d) > 50 && to ? to : tabNow());
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
  if (!el || !g.axis) { hideMap(300); return; }
  const d = g.axis === 'x' ? g.dx : g.dy, v = speed(g);
  if (Math.abs(d) > roomOf(g.axis, el) * 0.15 || Math.abs(v) > 800) travel(g.axis, d < 0 ? 1 : -1, { d: g.shown, v: v * 0.4 });
  else spring(g.shown, 0, along(g.axis, el)).then(() => hideMap());   // not far enough: back it goes
}

const own = (e) => { if (G) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); } };
addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  P.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, target: e.target });
  if (P.size === FINGERS && !G && !nearEdge() && !document.querySelector('.sheet:not(.hidden), .overlay:not(.hidden)')) begin();
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
// while travelling, the page underneath doesn't scroll or zoom
addEventListener('touchmove', (e) => { if (G && e.cancelable) e.preventDefault(); }, { capture: true, passive: false });

// ---- one finger along the top bar travels sideways too (a tap there is still a tap) ----
function wireBarSwipe(topbar) {
  let s = null, swiped = false;
  topbar.addEventListener('pointerdown', (e) => {
    swiped = false;
    if (e.pointerType !== 'touch' || e.target.closest('select, input')) return;
    s = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  topbar.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id || swiped) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(e.clientY - s.y)) { swiped = true; travel('x', dx < 0 ? 1 : -1); }
  });
  const end = () => { s = null; if (swiped) setTimeout(() => { swiped = false; }, 400); };   // (the click a swipe ends in, if any, comes first)
  topbar.addEventListener('pointerup', end); topbar.addEventListener('pointercancel', end);
  topbar.addEventListener('click', (e) => { if (swiped) { swiped = false; e.stopPropagation(); e.preventDefault(); } }, true);
}

// ---- Back with nothing open (Android's edge swipe, the back button): the tool before, never out of the app ----
// ui.js gives each open sheet its own history entry, so Back closes those first; under them sits this one floor.
const FLOOR = { world: 1 };
if (history.state?.world !== 1) history.pushState(FLOOR, '');
addEventListener('popstate', (e) => {
  if (e.state) return;   // (a sheet closing: ui.js)
  history.pushState(FLOOR, '');
  const here = tabNow();
  while (been.length && been[been.length - 1] === here) been.pop();
  const prev = been.pop();
  if (prev) {
    const a = spaceOf(prev), b = spaceOf(here);
    travelTo(prev, a === b ? { axis: 'y', dir: tabsIn(a).indexOf(prev) > tabsIn(a).indexOf(here) ? 1 : -1 } : { axis: 'x', dir: a > b ? 1 : -1 });
  } else toast('ComfyChair stays open: swipe with three fingers (away from the edges) to move around');
});

// ---- keys: Alt + ← → between spaces, Alt + ↑ ↓ between the tools in one ----
addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select')) return;
  const fn = { ArrowLeft: () => travel('x', -1), ArrowRight: () => travel('x', 1), ArrowUp: () => travel('y', -1), ArrowDown: () => travel('y', 1) }[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

document.documentElement.classList.add('lab');
document.body.append(map);
const nav = document.querySelector('nav.tabs');
nav.before(bar);
wireBarSwipe(document.querySelector('.topbar'));
document.querySelector('.brand')?.append(h('sup', { class: 'lab-badge', title: 'ComfyChair Lab: the experimental copy' }, 'Lab'));
new MutationObserver(paint).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
paint();
