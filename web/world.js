import { h, toast } from './ui.js';
import { switchTab } from './core.js';

// ---------------------------------------------------------------------------
// world: the app as a small world of three spaces you move around in.
//   Make  (Story, Generate, VFX, 3D) where things get made: written down and sorted, then a process, its inputs, a big GO
//   Edit  (Editor, Video, Sound)    where made things are put together in space and time
//   View  (Board, History)          where everything made is seen and sent on
// The spaces' buttons and their tools' tabs move you (the tab slides on to the next, and a map shows where you
// are); so do a sideways swipe along the top bar and Alt + arrows. (Three-finger travel was taken out: it got in
// the way of the 3D view's own finger gestures.) The page never overscrolls sideways (Chrome's swipe back /
// forward), and if Back fires with nothing open, it goes to the tool you were on before instead of leaving the app.
//
// The tabs themselves stay their own modules: this only moves between them.
// ---------------------------------------------------------------------------
const SPACES = [
  { id: 'make', name: 'Make', tabs: ['story', 'generate', 'vfx', 'scene'], icon: ['M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z', 'M5 21l4-4'] },
  { id: 'edit', name: 'Edit', tabs: ['editor', 'video', 'sound'], icon: ['M4 6h10M4 12h16M4 18h7', 'M17 4v4M14 16v4'] },
  { id: 'view', name: 'View', tabs: ['board', 'history'], icon: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'] },
];

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

// ---- moving a tab: only translate and opacity, so the compositor does it smoothly even while a tab is busy ----
const SLIDE = 56;   // px a tool slides as it goes and as the next one comes (with a fade: the move reads, nothing flies)
const shift = (axis, d) => (d ? `translate${axis === 'x' ? 'X' : 'Y'}(${d}px)` : 'none');
// held under the fingers: d along the axis, fading a little the further it goes
function hold(el, axis, d) {
  if (!el) return;
  el.style.transform = d ? shift(axis, d) : '';
  el.style.opacity = d ? String(1 - 0.45 * Math.min(1, Math.abs(d) / (roomOf(axis, el) * 0.5))) : '';
}
// let go short of travelling: back it springs, with a little overshoot
function settle(el, axis, d) {
  hold(el, axis, 0);
  if (!el || !d) return Promise.resolve();
  return el.animate([{ transform: shift(axis, d) }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.34, 1.56, .64, 1)' })
    .finished.catch(() => {});
}

// ---- the map: a column per space with its tools; where you are, and where you'd land, light up ----
const map = h('div', { class: 'world-map', 'aria-hidden': 'true' });
let mapTimer = 0;
let drawn = '';   // (the map as last built: rebuilt only when it changes, not on every finger move)
function showMap(target = tabNow()) {
  const here = tabNow();
  if (drawn !== (drawn = `${here}>${target}`) || !map.classList.contains('on')) map.replaceChildren(...SPACES.map((s, i) => h('div', { class: `wm-col${spaceOf(here) === i ? ' here' : ''}${spaceOf(target) === i ? ' to' : ''}` },
    h('span', { class: 'wm-space' }, svgIcon(s.icon), s.name),
    ...tabsIn(i).map((t) => h('span', { class: `wm-tool${t === here ? ' here' : ''}${t === target ? ' to' : ''}` },
      btnOf(t).querySelector('svg')?.cloneNode(true) || '', btnOf(t).title)))));
  map.classList.add('on');
  clearTimeout(mapTimer);
}
const hideMap = (after = 900) => { clearTimeout(mapTimer); mapTimer = setTimeout(() => map.classList.remove('on'), after); };

// ---- travel: the old tab slides a little along the move and fades, the new one slides in after it ----
let moving = false;
// where a move lands: sideways ±1 a space (at its last tool), up / down ±1 a tool in this space (null: the edge)
function landing(axis, dir) {
  const tab = tabNow(), si = spaceOf(tab);
  if (si < 0) return null;
  if (axis === 'x') { const sj = si + dir; return sj >= 0 && sj < SPACES.length ? last[SPACES[sj].id] || tabsIn(sj)[0] : null; }
  const ts = tabsIn(si), j = ts.indexOf(tab) + dir;
  return j >= 0 && j < ts.length ? ts[j] : null;
}
async function travel(axis, dir, { d = 0 } = {}) {
  const el = tabEl(), to = landing(axis, dir);
  if (moving || !el) return;
  if (!to) { showMap(); await settle(el, axis, d); hideMap(); return; }   // the edge of the world: it gives, then settles
  return travelTo(to, { axis, dir, d });
}
async function travelTo(to, { axis = 'x', dir = 1, d = 0 } = {}) {
  const el = tabEl();
  if (moving || !el) return;
  moving = true;
  showMap(to);
  const out = el.animate([{ transform: shift(axis, d), opacity: el.style.opacity || 1 }, { transform: shift(axis, d - dir * SLIDE), opacity: 0 }],
    { duration: 120, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  await out.finished.catch(() => {});
  hold(el, axis, 0);
  switchTab(to);
  out.cancel();   // (the old tab is hidden now: no flash back)
  showMap(to);
  // the new tab draws itself hidden first (its first frame is the heavy one), then slides in on the compositor
  const nu = tabEl();
  if (nu) nu.style.opacity = '0';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (nu) nu.style.opacity = '';
  if (nu) await nu.animate([{ transform: shift(axis, dir * SLIDE), opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 240, easing: 'cubic-bezier(0, 0, .2, 1)' }).finished.catch(() => {});
  moving = false;
  hideMap();
}

const roomOf = (axis, el) => (axis === 'x' ? el.clientWidth || innerWidth : el.clientHeight || innerHeight);

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
  } else toast('ComfyChair stays open: use the spaces and tabs at the top to move around');
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
new MutationObserver(paint).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
paint();
