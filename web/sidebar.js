// The table's sidebar: tabbed panes, Photoshop style, in #tablePanel. A strip of icon tabs at the top, one pane on show
// below it. Modules make their pane on demand and render into it; which one shows follows the selection on the table:
// nothing selected → Make, a frame selected → Frame, a live image frame → Layers. The pane picked by hand for a kind
// of selection is remembered on this device (deck.sidebar.<kind>: none, image, video…, live-image, live-video…).
//
//   const el = sidebar.pane('make', { title: 'Make', icon: 'sparkle', when?: (ctx) => bool })   the pane's element
//   sidebar.show('frame')     put a pane on show (as a tap on its tab does, without remembering it)
//   sidebar.current()         the name on show
//   sidebar.refresh()         re-check which tabs show (each pane's `when`), after something they depend on changed
//   sidebar.onShow(fn)        fn(name, el) whenever a pane comes on show; returns an unsubscribe
//   sidebar.context()         { frames, live } the panes are following
//
// A pane's sections get the panel's jump strip (layout.js sideNav) as other panels do; a pane that holds a whole panel
// of its own (the editor's) is marked `host` and gets none.
import { $, h, store, icon } from './ui.js';
import { sectionTargets, sideNav } from './layout.js';
import { liveFrame } from './live.js';

const P = { panes: new Map(), order: [], cur: null, strip: null, body: null, root: null, ctx: { frames: [], live: null }, fns: new Set(), built: false };
const DEFAULTS = { make: { title: 'Make', icon: 'sparkle' }, layers: { title: 'Layers', icon: 'rows' }, frame: { title: 'Frame', icon: 'fit' },
  story: { title: 'Story', icon: 'story' }, shelf: { title: 'Shelf', icon: 'board' } };
const ORDER = ['make', 'layers', 'frame', 'story', 'shelf'];

function build() {
  if (P.built) return true;
  const root = $('#tablePanel');
  if (!root) return false;
  P.built = true; P.root = root;
  P.strip = h('div', { class: 'sb-tabs', role: 'tablist', 'aria-label': 'Sidebar' });
  P.body = h('div', { class: 'sb-panes' });
  root.classList.add('sidebar');
  root.replaceChildren(P.strip, P.body);
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
const defaultFor = (kind) => (kind === 'none' ? 'make' : kind === 'live-image' ? 'layers' : kind.startsWith('live-') ? 'make' : 'frame');
const usable = (name) => { const p = P.panes.get(name); return !!p && !p.tab.classList.contains('hidden'); };

function pane(name, { title, icon: ic, when, host } = {}) {
  build();
  let p = P.panes.get(name);
  const d = DEFAULTS[name] || { title: name[0].toUpperCase() + name.slice(1), icon: 'list' };
  if (!p) {
    const el = h('div', { class: 'sb-pane hidden', id: `pane-${name}`, role: 'tabpanel', 'data-pane': name, 'aria-label': title || d.title });
    const tab = h('button', { type: 'button', class: 'sb-tab', role: 'tab', 'aria-selected': 'false', 'aria-controls': el.id, tabIndex: -1,
      onclick: () => { show(name); store.set(`deck.sidebar.${ctxKind()}`, name); } });
    p = { name, el, tab, when: null, host: false, nav: null };
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
  if (when !== undefined) p.when = when;
  if (host !== undefined) { p.host = !!host; p.el.classList.toggle('sb-host', p.host); }
  if (!p.host && !p.nav) p.nav = sideNav(p.el, `sidebar ${name}`, sectionTargets(p.el));
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

function refresh() {
  syncTabs();
  if (!P.cur || !usable(P.cur)) follow();
  for (const p of P.panes.values()) p.nav?.refresh();
}

export const sidebar = {
  pane, show, refresh,
  current: () => P.cur,
  context: () => P.ctx,
  onShow(fn) { P.fns.add(fn); return () => P.fns.delete(fn); },
};

// (registered when this module first loads, so before the frame modules that import it: their own show() comes after)
addEventListener('table:select', (e) => { P.ctx = { frames: e.detail?.frames || [], live: liveFrame() }; follow(); });
addEventListener('table:live', (e) => { P.ctx = { frames: [e.detail.frame], live: e.detail.frame }; follow(); });
addEventListener('table:unlive', (e) => { P.ctx = { frames: e.detail?.frame ? [e.detail.frame] : [], live: null }; queueMicrotask(follow); });

// the panes everyone uses are there from the start, in their order
for (const n of ['make', 'frame']) pane(n);
pane('layers', { host: true, when: (c) => c.live?.kind === 'image' });
