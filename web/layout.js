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
];
const ALL_ICON = ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'];
const navIcon = (label) => {
  const m = ICONS.find(([re]) => re.test(label));
  if (m) return svg(m[1]);
  return h('span', { class: 'nav-letter' }, (label.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase());   // no icon for it: its first letter
};

export function sideNav(panel, name, find) {
  const key = `deck.sidetab.${name}`;
  const strip = h('nav', { class: 'side-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings groups' });
  let sig = '', busy = false, queued = false;
  const apply = (targets) => {
    let cur = store.get(key, '');
    if (cur && !targets.some((t) => t.label === cur)) cur = '';   // that group isn't here now (another template): show all
    for (const t of targets) t.el.classList.toggle('nav-off', !!cur && t.label !== cur);
    for (const b of strip.children) { const on = b.dataset.g === cur; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  };
  const pick = (g) => {
    store.set(key, g);
    apply(find());
    panel.scrollTo?.({ top: 0 });
  };
  const refresh = () => {
    queued = false; busy = true;
    const targets = find();
    const on = targets.length > 1;
    panel.classList.toggle('has-nav', on);
    if (on) {
      if (strip.parentNode !== panel) panel.prepend(strip);
      const s = targets.map((t) => t.label).join('\n');
      if (s !== sig) {
        sig = s;
        strip.replaceChildren(
          navBtn('', 'All', svg(ALL_ICON)),
          ...targets.map((t) => navBtn(t.label, t.label, navIcon(t.label))));
      }
      apply(targets);
    } else {
      strip.remove(); sig = '';
      for (const t of targets) t.el.classList.remove('nav-off');
    }
    obs.takeRecords(); busy = false;
  };
  const navBtn = (g, label, icon) => h('button', { type: 'button', role: 'tab', class: 'side-tab', 'data-g': g, title: label, 'aria-label': label,
    onclick: () => pick(g) }, icon);
  const obs = new MutationObserver(() => { if (!busy && !queued) { queued = true; queueMicrotask(refresh); } });
  obs.observe(panel, { childList: true, subtree: true });
  refresh();
  return { refresh };
}
