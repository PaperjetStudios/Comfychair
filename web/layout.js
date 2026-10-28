// App-wide layout, the way Blender does it: every panel's areas resize by dragging a splitter,
// the sidebar has a strip of icon tabs, and every viewer maximizes the same way. Sizes and picks
// are remembered per device (localStorage), per panel.

import { $, h, store, clamp, overlayOpened, overlayClosed } from './ui.js';

const svg = (paths) => {
  const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
};

// ---------------------------------------------------------------------------
// splitters: .tab > .splitter between the preview and the sidebar (sideways in landscape, up and
// down in portrait), plus .hsplit grips above bottom areas (the video timeline). Each panel keeps its
// own sizes; double-tap a splitter to put them back.
// ---------------------------------------------------------------------------
const portrait = () => matchMedia('(max-width: 900px), (orientation: portrait)').matches;
const splitKey = (tab) => `deck.split.${tab.id.replace('tab-', '')}`;

function applySplit(tab) {
  const st = store.get(splitKey(tab), null) || {};
  const vars = { '--panel-w': st.w, '--stage-h': st.h, '--tl-h': st.tl };
  for (const [k, v] of Object.entries(vars)) { if (v) tab.style.setProperty(k, `${v}px`); else tab.style.removeProperty(k); }
}

// Drag handle: onMove(event, rect-of-tab) while down; a second tap within 300 ms calls reset
function dragHandle(el, tab, onMove, reset) {
  let lastTap = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (Date.now() - lastTap < 300) { lastTap = 0; reset(); return; }
    lastTap = Date.now();
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    el.classList.add('dragging');
    const rect = tab.getBoundingClientRect();
    const move = (ev) => onMove(ev, rect);
    const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}

export function wireSplitters() {
  const tabs = [...document.querySelectorAll('.tab')].filter((t) => t.querySelector(':scope > .splitter'));
  const save = (tab, patch) => {
    const k = splitKey(tab), st = { ...(store.get(k, null) || {}), ...patch };
    for (const n of Object.keys(st)) if (st[n] == null) delete st[n];
    store.set(k, Object.keys(st).length ? st : null);
    applySplit(tab);
  };
  const oldW = store.get('deck.split.panelW', null), oldH = store.get('deck.split.stageH', null);   // Generate's old global pair
  if ((oldW || oldH) && !store.get('deck.split.generate', null)) store.set('deck.split.generate', { w: oldW || undefined, h: oldH || undefined });
  store.set('deck.split.panelW', null); store.set('deck.split.stageH', null);
  for (const tab of tabs) {
    applySplit(tab);
    const sp = tab.querySelector(':scope > .splitter');
    dragHandle(sp, tab, (ev, r) => {
      if (portrait()) save(tab, { h: Math.round(clamp(ev.clientY - r.top - 8, 140, r.height - 160)) });
      else save(tab, { w: Math.round(clamp(r.right - ev.clientX - 8, 300, r.width - 240)) });
    }, () => save(tab, { w: null, h: null }));
    // arrow keys too (a keyboard or a pen-less desktop): the same steps as dragging
    sp.tabIndex = 0;
    sp.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const r = tab.getBoundingClientRect(), a = $(`#${tab.id} .stage`).getBoundingClientRect(), p = $(`#${tab.id} > .panel`).getBoundingClientRect();
      if (portrait()) save(tab, { h: Math.round(clamp(a.height + d * 24, 140, r.height - 160)) });
      else save(tab, { w: Math.round(clamp(p.width - d * 24, 300, r.width - 240)) });
    });
  }
  // the bottom areas: a grip above the video timeline sets its height
  for (const g of document.querySelectorAll('.hsplit')) {
    const tab = g.closest('.tab'), tl = g.parentElement.querySelector('.timeline');
    dragHandle(g, tab, (ev, r) => save(tab, { tl: Math.round(clamp(r.bottom - ev.clientY - (g.parentElement.offsetHeight - tl.offsetHeight), 60, r.height - 220)) }),
      () => save(tab, { tl: null }));
  }
}

// ---------------------------------------------------------------------------
// maximize: the same ⛶ button, top right of the viewer, in every panel. Real Fullscreen API where
// there is one (Esc leaves it), else the stage is pinned over the page (Esc / back leaves it).
// maximizable(stage, viewer, { onChange, native }) -> { toggle, exit, on }
// native: the element that goes real full screen (default the stage). The page itself keeps sheets,
// pickers and toasts on show over the pinned stage, which a full-screen stage would hide.
// ---------------------------------------------------------------------------
const MAXED = [];   // open ones, innermost last
export function maximizable(stage, viewer, { onChange = null, cls = 'maxed', title = 'Full screen', native: fsEl = stage } = {}) {
  let native = false, active = false;
  const btn = h('button', { type: 'button', class: 'max-btn', 'aria-label': title, 'aria-pressed': 'false', title: `${title} (Esc leaves)` }, '⛶');
  const back = () => { set(false); };
  const set = (on) => {
    if (on === active) return;
    active = on;
    stage.classList.toggle(cls, on);
    btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on);
    btn.textContent = on ? '✕' : '⛶';
    btn.setAttribute('aria-label', on ? 'Leave full screen' : title);
    if (on) {
      MAXED.push(api); overlayOpened(back);
      const req = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
      const already = fsEl === document.documentElement && (document.fullscreenElement || document.webkitFullscreenElement);   // the app's own ⛶ (leave it on)
      try { if (req && !already) { native = true; Promise.resolve(req.call(fsEl)).catch(() => { native = false; }); } } catch { native = false; }
    } else {
      MAXED.splice(MAXED.indexOf(api), 1); overlayClosed(back);
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (native && fs === fsEl) { native = false; try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* already out */ } }
    }
    onChange?.(on);
    requestAnimationFrame(() => dispatchEvent(new Event('resize')));   // canvases refit to the new size
  };
  const sync = () => { if (active && native && !(document.fullscreenElement || document.webkitFullscreenElement)) { native = false; set(false); } };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  const api = { toggle: () => set(!active), exit: () => set(false), on: () => active, btn };
  btn.addEventListener('click', (e) => { e.stopPropagation(); api.toggle(); });
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());   // the viewer underneath pans / draws
  viewer.append(btn);
  return api;
}
// (capture: before the panels' own Esc handling, which would also deselect things)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !MAXED.length) return;
  e.stopImmediatePropagation();
  MAXED[MAXED.length - 1].exit();
}, true);

// ---------------------------------------------------------------------------
// sidebar icon tabs (Blender's Properties editor): a column of icon buttons at the left of a
// panel that shows one parameter group at a time, or all of them. Navigation only: the groups
// themselves stay where they are. sideNav watches the panel, so it follows every redraw.
// find() -> [{ el, label }] for the groups there are now.
// ---------------------------------------------------------------------------
const ICONS = [
  [/prompt|text|caption|subject|negative/i, ['M4 6h16M4 12h16M4 18h10']],
  [/image|picture|photo|input|reference|source/i, ['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M9 9.5h.01']],
  [/video|clip|movie|frames?/i, ['M3 5h18v14H3z', 'M8 5v14M16 5v14M3 10h5M3 14h5M16 10h5M16 14h5']],
  [/audio|sound|music|voice|volume/i, ['M4 10v4h4l5 4V6L8 10z', 'M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11']],
  [/sampl|steps|seed|cfg|noise|scheduler|denois|guidance/i, ['M4 7h10M18 7h2M4 17h2M10 17h10', 'M16 5v4M8 15v4']],
  [/model|checkpoint|unet|vae|clip\b|loader|base/i, ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5M12 12v9']],
  [/lora|style/i, ['M12 4l9 4.5-9 4.5-9-4.5z', 'M3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5']],
  [/size|resolution|dimension|canvas|aspect|crop|frame size/i, ['M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4', 'M9 9h6v6H9z']],
  [/camera|lens|view|shot/i, ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6']],
  [/light|sun|bright/i, ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5']],
  [/import|upload|template|library/i, ['M12 15V4M7 8l5-5 5 5', 'M5 20h14']],
  [/render|export|output|save|sequence/i, ['M12 4v11M7 11l5 5 5-5', 'M5 20h14']],
  [/layer|transform|object|clip|place|position|move/i, ['M12 3v18M3 12h18', 'M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3']],
  [/room|scene|world/i, ['M3 20V9l9-6 9 6v11z', 'M9 20v-7h6v7']],
  [/pose|figure|person|body|joint/i, ['M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4', 'M12 7v7M7 10l5-2 5 2M9 21l3-7 3 7']],
  [/advanced|more|other|extra|setting|option|misc/i, ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6', 'M19 12l2-1-1-3-2.2.5-1.3-1.3.5-2.2-3-1-1 2h-1.8l-1-2-3 1 .5 2.2-1.3 1.3L4 8l-1 3 2 1v1.8l-2 1 1 3 2.2-.5 1.3 1.3-.5 2.2 3 1 1-2h1.8l1 2 3-1-.5-2.2 1.3-1.3 2.2.5 1-3-2-1z']],
  [/brush|eraser|shapes|fill|selection/i, ['M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-3-3z', 'M9 13c-2.8 0-4.5 1.8-4.5 4.3 0 1.5-.9 2.4-2.5 2.7 2.2 1.4 5 1.3 6.9-.3 1.4-1.2 2.1-2.6 2.1-3.7']],
  [/animat/i, ['M12 4l8 8-8 8-8-8z']],
];
const navIcon = (label) => {
  const m = ICONS.find(([re]) => re.test(label));
  if (m) return svg(m[1]);
  return h('span', { class: 'nav-letter' }, (label.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase());   // no icon for it: its first letter
};

export function sideNav(panel, name, find) {
  const strip = h('nav', { class: 'side-nav', 'aria-label': 'Jump to a group of settings' });
  let sig = '', busy = false, queued = false, targets = [];
  // the group in view: the last one whose top has scrolled up past the panel's top third
  const spy = () => {
    const r = panel.getBoundingClientRect(), atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
    const line = atEnd ? r.bottom - 40 : r.top + panel.clientHeight / 3;   // at the end the last groups can't reach the top
    let cur = targets[0]?.label ?? '';
    if (panel.scrollTop > 4) for (const t of targets) if (t.el.getBoundingClientRect().top <= line) cur = t.label;
    for (const b of strip.children) b.classList.toggle('on', b.dataset.g === cur);
  };
  // tap a group: scroll to it (a closed one opens); every group stays on show
  const pick = (t) => {
    if (t.el.tagName === 'DETAILS') t.el.open = true;
    t.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const refresh = () => {
    queued = false; busy = true;
    targets = find();
    const on = targets.length > 1;
    panel.classList.toggle('has-nav', on);
    if (on) {
      if (strip.parentNode !== panel) panel.prepend(strip);
      const s = targets.map((t) => t.label).join('\n');
      if (s !== sig) {
        sig = s;
        strip.replaceChildren(...targets.map((t) => h('button', { type: 'button', class: 'side-tab', 'data-g': t.label, title: t.label, 'aria-label': t.label,
          onclick: () => pick(targets.find((x) => x.label === t.label) || t) }, navIcon(t.label))));
      }
      spy();
    } else { strip.remove(); sig = ''; }
    obs.takeRecords(); busy = false;
  };
  panel.addEventListener('scroll', () => requestAnimationFrame(spy), { passive: true });
  const obs = new MutationObserver(() => { if (!busy && !queued) { queued = true; queueMicrotask(refresh); } });
  obs.observe(panel, { childList: true, subtree: true });
  refresh();
  return { refresh };
}

// ---------------------------------------------------------------------------
// zoomPan: pinch, the wheel or a double-tap zooms a viewer's picture, the same in Generate's viewer and the
// Board's gallery; one finger pans while zoomed. layer() is the element that moves (it can change, e.g. per
// gallery item); its transform origin is set to its top-left. A drag or pinch doesn't also count as a tap.
//   const zp = zoomPan(viewer, () => layer, { min, max, snapOne, canZoom(), skip(e), swipe(dir), onChange(s) });
//   zp.reset(); zp.zoomBy(f) (about the middle); zp.s()
// swipe: while not zoomed, one finger sideways drags the viewer and swipe(±1) moves on (the gallery).
// skip(e): leave this press alone (a player's own controls). snapOne: a zoom passing 100% lands on it.
// ---------------------------------------------------------------------------
export function zoomPan(viewer, layer, { min = 1, max = 8, snapOne = false, canZoom = () => true, skip = () => false, swipe = null, onChange = null } = {}) {
  const Z = { s: 1, x: 0, y: 0 };
  const apply = () => {
    const el = layer();
    if (el) { el.style.transformOrigin = '0 0'; el.style.transform = Z.s === 1 && !Z.x && !Z.y ? '' : `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`; }
    viewer.classList.toggle('zoomed', Z.s !== 1);
    onChange?.(Z.s);
  };
  const reset = () => { Z.s = 1; Z.x = 0; Z.y = 0; apply(); };
  // keep the point under (cx, cy) where it is (the layer's untransformed top-left is its box less the pan)
  const zoomAt = (f, cx, cy) => {
    const el = layer();
    if (!el || !canZoom()) return reset();
    const r = el.getBoundingClientRect(), px = cx - (r.left - Z.x), py = cy - (r.top - Z.y);
    let s = clamp(Z.s * f, min, max);
    if (snapOne && Math.abs(s - 1) < 0.04) s = 1;
    if (s <= 1.001 && min >= 1) s = 1;
    Z.x = px - (px - Z.x) * (s / Z.s); Z.y = py - (py - Z.y) * (s / Z.s); Z.s = s;
    if (s === 1) { Z.x = 0; Z.y = 0; }
    apply();
  };
  const zoomBy = (f) => { const r = viewer.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); };
  // rotating the tablet changes the viewer's size, so old pan offsets could leave the picture off-screen
  let lastSize = '';
  new ResizeObserver(() => {
    const r = viewer.getBoundingClientRect(), size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (lastSize && size !== lastSize && Z.s !== 1) reset();
    lastSize = size;
  }).observe(viewer);
  viewer.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY); }, { passive: false });

  const pts = new Map();
  let last = null, one = null, moved = false, lastTap = 0;
  const capture = (id) => { try { viewer.setPointerCapture(id); } catch { /* synthetic */ } };
  viewer.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || skip(e)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = false;
    if (pts.size === 2) { one = null; viewer.style.transform = ''; for (const id of pts.keys()) capture(id); }   // a pinch: forget any swipe
    else if (pts.size === 1) {
      one = { x: e.clientX, y: e.clientY, id: e.pointerId, horiz: null };
      if (Z.s !== 1) capture(e.pointerId);
    }
    last = [...pts.values()];
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = [...pts.values()];
    if (cur.length === 2 && last?.length === 2) {
      const d = (a) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      const mid = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 }, lmid = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
      if (canZoom()) { Z.x += mid.x - lmid.x; Z.y += mid.y - lmid.y; zoomAt(d(cur) / Math.max(1, d(last)), mid.x, mid.y); }
      moved = true;
    } else if (cur.length === 1 && one && e.pointerId === one.id) {
      const dx = e.clientX - one.x, dy = e.clientY - one.y;
      if (Math.hypot(dx, dy) > 6) moved = true;
      if (Z.s !== 1) { Z.x += cur[0].x - last[0].x; Z.y += cur[0].y - last[0].y; apply(); }
      else if (swipe) {
        if (one.horiz == null && moved) { one.horiz = Math.abs(dx) > Math.abs(dy); if (one.horiz) capture(e.pointerId); }
        if (one.horiz) viewer.style.transform = `translateX(${dx}px)`;
      }
    }
    last = cur;
  });
  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    last = [...pts.values()];
    if (!one || e.pointerId !== one.id) return;
    const dx = e.clientX - one.x, { horiz } = one;
    one = null;
    if (horiz && swipe) {
      viewer.style.transition = 'transform .15s'; viewer.style.transform = '';
      setTimeout(() => { viewer.style.transition = ''; }, 160);
      if (Math.abs(dx) > Math.min(80, viewer.clientWidth / 6)) swipe(dx < 0 ? 1 : -1);
    }
    if (!moved && e.type === 'pointerup') {   // double-tap: zoom in there, or back out
      if (Date.now() - lastTap < 300) { lastTap = 0; moved = true; if (Z.s !== 1) reset(); else zoomAt(2.5, e.clientX, e.clientY); }
      else lastTap = Date.now();
    }
  };
  viewer.addEventListener('pointerup', end); viewer.addEventListener('pointercancel', end);
  viewer.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  return { reset, zoomBy, zoomAt, s: () => Z.s };
}

// ---------------------------------------------------------------------------
// fullScreen: a tab's full screen, the same in every tab (the 3D tab's): the page goes full screen with the
// stage pinned over it, and the tab's own settings panel pulls out over the view from a handle on the right
// edge. It is the same live panel, pinned by CSS (.tab.view-max), so nothing moves or rebuilds. Tap the handle
// to show or hide it, drag it to size it, or back past the edge to put it away. Kept per device, per tab.
//   const max = fullScreen(tab, { viewer, title, onChange });   // max: maximizable's { toggle, exit, on, btn }
// ---------------------------------------------------------------------------
export function fullScreen(tab, { viewer = tab.querySelector('.viewer'), title = 'Full screen', onChange = null } = {}) {
  const key = `deck.pull.${tab.id}`;
  const P = { open: store.get(`${key}.open`, false) === true, w: +store.get(`${key}.w`, 380) || 380 };
  const most = () => Math.max(260, innerWidth - 60);
  const hd = h('button', { type: 'button', class: 'pull-tab', 'aria-label': 'Settings panel', 'aria-expanded': P.open,
    title: 'Settings: tap to show or hide, drag to size' }, h('span', {}, '‹'));
  const apply = (w = P.w, open = P.open) => {
    const px = `${Math.round(clamp(w, 0, most()))}px`;
    tab.style.setProperty('--ov-w', px);
    document.documentElement.style.setProperty('--ov-w', px);   // (Generate's action bar, outside the tab, keeps clear of it)
    tab.classList.toggle('panel-out', open && tab.classList.contains('view-max'));
    hd.setAttribute('aria-expanded', open); hd.firstChild.textContent = open ? '›' : '‹';
  };
  const keep = () => { store.set(`${key}.open`, P.open); store.set(`${key}.w`, P.w); apply(); };
  hd.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    try { hd.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const x0 = e.clientX, w0 = P.open ? Math.min(P.w, most()) : 0;
    let w = w0, moved = false;
    const move = (ev) => {
      w = w0 + x0 - ev.clientX;   // to the left pulls it out
      if (!moved && Math.abs(w - w0) < 6) return;
      moved = true; tab.classList.add('pulling'); apply(w, true);
    };
    const up = () => {
      hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up);
      tab.classList.remove('pulling');
      if (!moved) P.open = !P.open;
      else if (w < 160) P.open = false;   // pushed back to the edge: put away (it keeps its width)
      else { P.open = true; P.w = Math.round(clamp(w, 260, most())); }
      keep();
    };
    hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
  });
  hd.addEventListener('click', (e) => { e.stopPropagation(); if (e.detail === 0) { P.open = !P.open; keep(); } });   // (a key; a tap is done on letting go)
  const stage = tab.querySelector('.stage');
  stage.append(hd);
  return maximizable(stage, viewer, { title, native: document.documentElement,
    onChange: (on) => { tab.classList.toggle('view-max', on); apply(); onChange?.(on); } });
}
