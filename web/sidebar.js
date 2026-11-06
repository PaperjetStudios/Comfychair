// The table's sidebar: tabbed panes, Photoshop style, in #tablePanel. A strip of icon tabs at the top, one pane on show
// below it. Modules make their pane on demand and render into it; which one shows follows the selection on the table:
// nothing selected → Make, a frame selected → Frame, a live image frame → Properties (its layers are there). The pane picked by hand for a kind
// of selection is remembered on this device (deck.sidebar.<kind>: none, image, video…, live-image, live-video…).
//
//   const el = sidebar.pane('make', { title: 'Make', icon: 'sparkle', when?: (ctx) => bool })   the pane's element
//     (calling it again updates the title and icon. A shared pane's `when` is the sidebar's own, not the caller's:
//     `layers` shows while any frame with an engine is live, whichever module mounted last; see WHEN)
//   sidebar.show('frame')     put a pane on show (as a tap on its tab does, without remembering it)
//   sidebar.current()         the name on show
//   sidebar.refresh()         re-check which tabs show (each pane's `when`), after something they depend on changed
//   sidebar.onShow(fn)        fn(name, el) whenever a pane comes on show; returns an unsubscribe
//   sidebar.context()         { frames, live } the panes are following
//   (the Properties pane, `props`, is web/props-panel.js's: the picked thing's place, size, opacity and times)
//   sidebar.addTo('frame', fn)  fn(el) each time the pane's owner draws it again (its children replaced), and now: a module
//     adds a part of its own to a pane it doesn't draw (frame-image.js: Fit layers / Fixed size in the Frame pane)
//
// A pane's sections get the panel's jump strip (layout.js sideNav) as other panels do; a pane that holds a whole panel
// of its own (the editor's) is marked `host` and gets none.
import { $, h, store, icon } from './ui.js';
import { sectionTargets, sideNav } from './layout.js';
import { liveFrame } from './live.js';

const P = { panes: new Map(), order: [], cur: null, strip: null, body: null, root: null, ctx: { frames: [], live: null }, fns: new Set(), built: false };
const DEFAULTS = { make: { title: 'Make', icon: 'sparkle' }, output: { title: 'Output', icon: 'enlarge' }, edit: { title: 'Edit', icon: 'brush' }, props: { title: 'Properties', icon: 'settings' }, layers: { title: 'Layers', icon: 'rows' }, frame: { title: 'Frame', icon: 'fit' },
  story: { title: 'Story', icon: 'story' }, shelf: { title: 'Shelf', icon: 'board' } };
const ORDER = ['make', 'edit', 'output', 'props', 'layers', 'frame', 'story', 'shelf'];
// when the sidebar's own panes show, from its context (a `when` passed for these is ignored: several modules share them)
const ENGINE_KINDS = ['image', 'video', 'sound', 'scene'];
// (an image frame has no Layers pane: its layer list and their settings are the Properties pane's, props-panel.js head / extra)
const WHEN = { layers: (c) => ENGINE_KINDS.includes(c.live?.kind) && c.live.kind !== 'image',
  output: (c) => (c.live ? [c.live] : c.frames || []).some((f) => ['image', 'video', 'scene'].includes(f.kind)) };

function build() {
  if (P.built) return true;
  const root = $('#tablePanel');
  if (!root) return false;
  P.built = true; P.root = root;
  P.strip = h('div', { class: 'sb-tabs', role: 'tablist', 'aria-label': 'Sidebar' });
  // words on the tabs, or icons only (each tab still names itself when pointed at); kept on this device
  const iconsOnly = (on) => {
    P.strip.classList.toggle('icons-only', on);
    P.labels.setAttribute('aria-pressed', String(on));
    P.labels.title = on ? 'Show the words on these tabs' : 'Show only icons on these tabs';
    P.labels.setAttribute('aria-label', P.labels.title);
  };
  P.labels = h('button', { type: 'button', class: 'sb-labels', onclick: () => { const on = !P.strip.classList.contains('icons-only'); store.set('deck.sidebar.iconsOnly', on); iconsOnly(on); P.fades(); } }, icon('text'));
  iconsOnly(store.get('deck.sidebar.iconsOnly', matchMedia('(pointer: coarse)').matches));   // (a tablet starts with icons: the open tab keeps its word)
  P.body = h('div', { class: 'sb-panes' });
  root.classList.add('sidebar');
  // One row of tabs: the wheel or a drag of the finger scrolls it, and an edge with more beyond it fades
  P.fades = () => {
    const el = P.strip, more = el.scrollWidth - el.clientWidth;
    el.classList.toggle('more-before', el.scrollLeft > 1);
    el.classList.toggle('more-after', el.scrollLeft < more - 1);
  };
  P.strip.addEventListener('scroll', P.fades, { passive: true });
  P.strip.addEventListener('wheel', (e) => {
    if (P.strip.scrollWidth <= P.strip.clientWidth || e.deltaX) return;
    e.preventDefault();
    P.strip.scrollLeft += e.deltaY;
  }, { passive: false });
  new ResizeObserver(P.fades).observe(P.strip);
  // (beside the tabs: it takes no room of its own in their row)
  root.replaceChildren(h('div', { class: 'sb-head' }, P.strip, P.labels), P.body);
  P.strip.addEventListener('keydown', (e) => {
    const tabs = [...P.strip.querySelectorAll('.sb-tab:not(.hidden)')], at = tabs.indexOf(e.target);
    const to = at < 0 ? null : { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    const b = tabs[(to + tabs.length) % tabs.length];
    b.focus(); b.click();
  });
  return true;
}

// which kind of selection this is, for the remembered pane
function ctxKind() {
  const { frames, live } = P.ctx;
  if (live) return `live-${live.kind}`;
  if (frames.length === 1) return frames[0].kind;
  return frames.length ? 'many' : 'none';
}
const defaultFor = (kind) => (kind === 'none' ? 'make' : kind === 'live-image' ? 'props' : kind.startsWith('live-') ? 'make' : 'frame');
const usable = (name) => { const p = P.panes.get(name); return !!p && !p.tab.classList.contains('hidden'); };

function pane(name, { title, icon: ic, when, host } = {}) {
  build();
  let p = P.panes.get(name);
  const d = DEFAULTS[name] || { title: name[0].toUpperCase() + name.slice(1), icon: 'list' };
  if (!p) {
    const el = h('div', { class: 'sb-pane hidden', id: `pane-${name}`, role: 'tabpanel', 'data-pane': name, 'aria-label': title || d.title });
    const tab = h('button', { type: 'button', class: 'sb-tab', role: 'tab', 'aria-selected': 'false', 'aria-controls': el.id, tabIndex: -1,
      onclick: () => { show(name); store.set(`deck.sidebar.${ctxKind()}`, name); } });
    p = { name, el, tab, when: WHEN[name] || null, host: false, nav: null };
    P.panes.set(name, p);
    const rank = (n) => { const i = ORDER.indexOf(n); return i < 0 ? 99 : i; };
    P.order.push(name); P.order.sort((a, b) => rank(a) - rank(b));
    const i = P.order.indexOf(name), next = P.panes.get(P.order[i + 1]);
    P.strip?.insertBefore(tab, next?.tab || null);
    P.body?.append(el);
  }
  if (title || !p.title) { p.title = title || d.title; p.tab.title = p.title; p.tab.setAttribute('aria-label', p.title); p.el.setAttribute('aria-label', p.title); }
  if (ic || !p.icon) { p.icon = ic || d.icon; p.tab.replaceChildren(icon(p.icon), h('span', { class: 'sb-tab-label' }, p.title)); }
  else p.tab.querySelector('.sb-tab-label').textContent = p.title;
  if (when !== undefined && !WHEN[name]) p.when = when;
  if (host !== undefined) { p.host = !!host; p.el.classList.toggle('sb-host', p.host); }
  // (a pane that is a whole panel's host some of the time, the shared `layers`, has no strip while it is one)
  if (!p.host && !p.nav) { const find = sectionTargets(p.el); p.nav = sideNav(p.el, `sidebar ${name}`, () => (p.host ? [] : find())); }
  else p.nav?.refresh();
  syncTabs();
  if (!P.cur) follow();
  return p.el;
}

function syncTabs() {
  for (const p of P.panes.values()) {
    let on = true;
    try { on = p.when ? !!p.when(P.ctx) : true; } catch (e) { console.error(e); }
    p.tab.classList.toggle('hidden', !on);
  }
  P.fades?.();
}

function show(name) {
  const p = P.panes.get(name);
  if (!p) return false;
  const was = P.cur;
  P.cur = name;
  for (const q of P.panes.values()) {
    const on = q === p;
    q.el.classList.toggle('hidden', !on);
    q.tab.classList.toggle('on', on);
    q.tab.setAttribute('aria-selected', String(on));
    q.tab.tabIndex = on ? 0 : -1;
  }
  // (the tab on show is in view in its row)
  if (P.strip && !p.tab.classList.contains('hidden')) {
    const t = p.tab.getBoundingClientRect(), r = P.strip.getBoundingClientRect(), edge = 28;
    if (t.left < r.left + edge) P.strip.scrollLeft -= r.left + edge - t.left;
    else if (t.right > r.right - edge) P.strip.scrollLeft += t.right - (r.right - edge);
  }
  P.fades?.();
  if (was !== name) for (const fn of [...P.fns]) { try { fn(name, p.el); } catch (e) { console.error(e); } }
  return true;
}

// the selection changed: the pane remembered for it, else its default, else the first tab there is
function follow() {
  syncTabs();
  const kind = ctxKind(), want = store.get(`deck.sidebar.${kind}`, null);
  const pick = [want, defaultFor(kind), P.cur, ...P.order].find((n) => n && usable(n));
  if (pick) show(pick);
}

function addTo(name, fn) {
  const el = pane(name);
  const run = () => { try { fn(el); } catch (e) { console.error(e); } };
  new MutationObserver(run).observe(el, { childList: true });
  run();
}

function refresh() {
  syncTabs();
  if (!P.cur || !usable(P.cur)) follow();
  for (const p of P.panes.values()) p.nav?.refresh();
}

export const sidebar = {
  pane, show, refresh, addTo,
  current: () => P.cur,
  context: () => P.ctx,
  onShow(fn) { P.fns.add(fn); return () => P.fns.delete(fn); },
};

// (registered when this module first loads, so before the frame modules that import it: their own show() comes after)
addEventListener('table:select', (e) => { P.ctx = { frames: e.detail?.frames || [], live: liveFrame() }; follow(); });
addEventListener('table:live', (e) => { P.ctx = { frames: [e.detail.frame], live: e.detail.frame }; follow(); });
addEventListener('table:unlive', (e) => { P.ctx = { frames: e.detail?.frame ? [e.detail.frame] : [], live: null }; queueMicrotask(follow); });

// the panes everyone uses are there from the start, in their order
for (const n of ['make', 'frame', 'output']) pane(n);
pane('layers', { host: true });
