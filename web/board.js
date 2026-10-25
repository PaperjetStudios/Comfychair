import {
  $, h, store, api, toast, undoToast, overlayOpened, overlayClosed, sheetOpen, button, iconBtn, linkBtn, seg, placeholder,
} from './ui.js';
import { S, switchTab } from './core.js';
import { openGeneration, sendToInput } from './run.js';
import { E, FULL, persistEditor, renderEditor } from './editor.js';
import { addToTimeline } from './video.js';

// ---------------------------------------------------------------------------
// board: every output in the project as a pin board. Pin favourites, filter, resize the tiles.
// Videos play (muted) while on screen.
// ---------------------------------------------------------------------------
export const B = { filter: store.get('deck.board.filter', 'all'), size: store.get('deck.board.size', 240), loadedFor: undefined,
  selecting: false, sel: new Set(), longPressed: false,   // sel: "<generation id>:<output index>"
  marked: new Set(store.get('deck.board.marked', [])) };  // generation ids marked for deletion
const boardVideos = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && !GAL.el) e.target.play().catch(() => {}); else e.target.pause();
  }
}, { threshold: 0.25 });

async function loadAllProjectGenerations() {
  let before = null;
  for (let page = 0; page < 20; page++) {
    const rows = await api(`/api/generations?limit=200${S.project != null ? `&project_id=${S.project}` : ''}${before ? `&before=${before}` : ''}`);
    for (const g of rows) S.history.set(g.id, g);
    if (rows.length < 200) break;
    before = Math.min(...rows.map((g) => g.id));
  }
  B.loadedFor = S.project;
}

export async function renderBoard() {
  const bar = $('#boardBar');
  if (B.filter === 'marked' && !B.marked.size) B.filter = 'all';
  const filters = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['pinned', '★ Pinned'], ...(B.marked.size ? [['marked', '🗑 Marked']] : [])];
  const filterSeg = seg(filters, B.filter, (k) => { B.filter = k; store.set('deck.board.filter', k); renderBoard(); });
  const size = h('input', { type: 'range', min: 120, max: 520, step: 10, value: B.size, 'aria-label': 'Tile size' });
  size.addEventListener('input', () => { B.size = Number(size.value); store.set('deck.board.size', B.size); $('#board').style.setProperty('--tile', `${B.size}px`); });
  const count = h('span', { class: 'hint' });
  const selBtn = button(B.selecting ? 'Done' : '☑ Select', () => setBoardSelecting(!B.selecting), { cls: 'small' + (B.selecting ? ' on' : '') });
  const delMarked = h('span', { class: 'hidden' });   // filled in once the project's generations are loaded
  bar.replaceChildren(filterSeg, h('label', { class: 'board-size' }, 'Size', size), selBtn, delMarked, count, boardSelBar());
  $('#board').style.setProperty('--tile', `${B.size}px`);

  if (B.loadedFor !== S.project) {
    $('#board').replaceChildren(placeholder('Loading…'));
    try { await loadAllProjectGenerations(); } catch (e) { toast(e.message, true); }
  }
  const tiles = boardItems().map(({ g, o, i }) => boardTile(g, o, i));
  pauseBoard();
  $('#board').replaceChildren(...(tiles.length ? tiles : [placeholder(
    B.filter === 'pinned' ? 'Nothing pinned yet. Tap ☆ on any tile.'
      : B.filter === 'marked' ? 'Nothing marked. Mark things for deletion in the gallery (tap a tile).'
        : 'Nothing generated in this project yet.')]));
  $('#board').querySelectorAll('video').forEach((v) => boardVideos.observe(v));
  count.textContent = `${tiles.length} item${tiles.length === 1 ? '' : 's'}`;
  const nMarked = markedGens().length;
  if (nMarked) delMarked.replaceWith(button(`Delete ${nMarked} marked`, deleteMarked, { cls: 'small danger' }));
}

// what the board shows with the current filter, newest first: [{g, o, i, key}]
function boardItems() {
  const items = [];
  const gens = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done').sort((a, b) => b.id - a.id);
  for (const g of gens) {
    if (B.filter === 'pinned' && !g.pinned) continue;
    if (B.filter === 'marked' && !B.marked.has(g.id)) continue;
    g.outputs.forEach((o, i) => {
      if (o.kind !== 'image' && o.kind !== 'video') return;
      if ((B.filter === 'image' || B.filter === 'video') && o.kind !== B.filter) return;
      items.push({ g, o, i, key: `${g.id}:${i}` });
    });
  }
  return items;
}

async function togglePin(g) {
  try { const r = await api(`/api/generations/${g.id}/pin`, { method: 'POST', body: { pinned: !g.pinned } }); S.history.set(r.id, r); boardChanged(r); }
  catch (err) { toast(err.message, true); }
}

// Marks are per generation (deleting takes the whole generation) and live in this browser only
function toggleMarked(id) {
  if (B.marked.has(id)) B.marked.delete(id); else B.marked.add(id);
  saveMarked();
}
function saveMarked() { store.set('deck.board.marked', [...B.marked]); }
function markedGens() { return [...B.marked].map((id) => S.history.get(id)).filter((g) => g && g.project_id === S.project); }

function boardTile(g, o, i) {
  const media = o.kind === 'video'
    ? h('video', { src: o.url, muted: true, loop: true, playsInline: true, preload: 'metadata' })
    : h('img', { src: o.url, loading: 'lazy', alt: '', draggable: false });
  const pin = h('button', { type: 'button', class: 'pin' + (g.pinned ? ' on' : ''), 'aria-label': g.pinned ? 'Unpin' : 'Pin',
    onclick: (e) => { e.stopPropagation(); togglePin(S.history.get(g.id) || g); } }, g.pinned ? '★' : '☆');
  const key = `${g.id}:${i}`;
  const tile = h('div', { class: 'tile' + (B.sel.has(key) ? ' sel' : '') + (B.marked.has(g.id) ? ' marked' : ''), 'data-gen': g.id, 'data-key': key,
    onclick: () => {
      if (B.longPressed) { B.longPressed = false; return; }   // the long press already selected it
      if (B.selecting) toggleBoardSel(key, tile); else openGallery(key);
    } }, media, pin, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
    h('span', { class: 'mark', 'aria-hidden': 'true' }, '🗑'),
    h('div', { class: 'tile-meta' }, `#${g.id} ${g.template}${o.kind === 'video' ? ' ▶' : ''}`));
  // long press: start selecting with this tile
  let timer = 0, start = null;
  tile.addEventListener('pointerdown', (e) => {
    B.longPressed = false;
    if (e.target.closest('.pin')) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      B.longPressed = true;
      if (!B.selecting) setBoardSelecting(true);
      if (!B.sel.has(key)) toggleBoardSel(key, $(`#board .tile[data-key="${key}"]`));
      try { navigator.vibrate?.(20); } catch { /* not supported */ }
    }, 500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tile.addEventListener(ev, () => clearTimeout(timer));
  tile.addEventListener('pointermove', (e) => {   // a finger that moves is scrolling, not pressing
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer);
  });
  tile.addEventListener('contextmenu', (e) => e.preventDefault());   // no image menu on long press
  tile.addEventListener('dragstart', (e) => e.preventDefault());     // nor the browser's own image drag, which cancels the press
  return tile;
}

// ---- board selection: pick tiles, then make a new edit from them, put them on the timeline, or delete
function setBoardSelecting(on) {
  B.selecting = on;
  if (!on) B.sel.clear();
  $('#board').classList.toggle('selecting', on);
  renderBoard();
}
function toggleBoardSel(key, tile) {
  if (B.sel.has(key)) B.sel.delete(key); else B.sel.add(key);
  tile?.classList.toggle('sel', B.sel.has(key));
  const bar = $('#boardBar .board-sel');
  if (bar) bar.replaceWith(boardSelBar());
}
function boardSelected() {   // [{g, o, i}] in board order
  return [...B.sel].map((k) => { const [id, i] = k.split(':').map(Number); const g = S.history.get(id); return g && g.outputs[i] ? { g, o: g.outputs[i], i } : null; })
    .filter(Boolean).sort((a, b) => b.g.id - a.g.id || a.i - b.i);
}
function boardSelBar() {
  if (!B.selecting) return h('span', { class: 'board-sel hidden' });
  const n = B.sel.size, items = boardSelected(), images = items.filter((x) => x.o.kind === 'image').length;
  const visibleKeys = () => [...$('#board').querySelectorAll('.tile[data-key]')].map((t) => t.dataset.key);
  return h('div', { class: 'board-sel' },
    h('b', {}, n ? `${n} selected` : 'Tap tiles to select'),
    button('All', () => { visibleKeys().forEach((k) => B.sel.add(k)); renderBoard(); }),
    n ? button('None', () => { B.sel.clear(); renderBoard(); }) : null,
    button(`New edit${images ? ` (${images})` : ''}`, boardToEditor, { cls: 'small primary', disabled: !images }),
    button('To video', boardToVideo, { disabled: !n }),
    button('Delete', boardDelete, { cls: 'small danger', disabled: !n }));
}

// The selected images as a fresh Editor layout (side by side, or a grid for more than 3).
// Whatever was in the Editor can be brought back with Undo.
async function boardToEditor() { return itemsToEditor(boardSelected()); }
async function itemsToEditor(all) {
  const items = all.filter((x) => x.o.kind === 'image');
  if (!items.length) return toast('Select some images first', true);
  toast(`Preparing ${items.length} image${items.length > 1 ? 's' : ''}…`);
  const names = [];
  for (const { g, i } of items) {
    try {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index: i, frame: 'first', mp: 0, multiple: 1 } });
      names.push(r.name);
    } catch (e) { toast(`#${g.id}: ${e.message}`, true); }
  }
  if (!names.length) return;
  const before = { layers: E.layers, arrange: E.arrange, size: E.size };
  E.layers = names.reverse().map((name) => ({ name, crop: { ...FULL }, scale: 1, hidden: false }));  // first selected on top of the list
  E.sel = null; E.cropping = false; E.size = null;
  E.arrange = names.length > 3 ? 'grid' : 'row';
  E.cols = names.length > 3 ? Math.ceil(Math.sqrt(names.length)) : E.cols;
  persistEditor();
  setBoardSelecting(false);
  switchTab('editor');
  if (before.layers.length) undoToast(`New edit with ${names.length} image${names.length > 1 ? 's' : ''}`, () => {
    Object.assign(E, before); persistEditor(); renderEditor();
  });
}

// The selection onto the Video timeline, oldest first, after what's already there
async function boardToVideo() {
  const items = boardSelected().reverse();
  if (!items.length) return;
  for (const { g, o, i } of items) {
    await addToTimeline({ kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: `#${g.id} ${g.template}`, dur: o.duration || 0 });
  }
  setBoardSelecting(false);
  switchTab('video');
  toast(`Added ${items.length} to the timeline`);
}

// Deletes whole generations (with all their files), so say when that takes outputs that weren't picked
async function boardDelete() {
  const items = boardSelected();
  const gens = [...new Map(items.map((x) => [x.g.id, x.g])).values()];
  const extra = gens.reduce((a, g) => a + g.outputs.filter((o, i) => !B.sel.has(`${g.id}:${i}`)).length, 0);
  if (!await deleteGenerations(gens, extra ? `\n\nThat also deletes ${extra} other output${extra > 1 ? 's' : ''} of those generations.` : '')) return;
  setBoardSelecting(false);
}

async function deleteMarked() {
  if (await deleteGenerations(markedGens())) renderBoard();
}

// Asks first; returns false if nothing was deleted
async function deleteGenerations(gens, note = '') {
  if (!gens.length) return false;
  const pinned = gens.filter((g) => g.pinned).length;
  if (!confirm(`Delete ${gens.length} generation${gens.length > 1 ? 's' : ''} and their files? This can't be undone.` + note
    + (pinned ? `\n\n${pinned} of them ${pinned > 1 ? 'are' : 'is'} pinned.` : ''))) return false;
  let done = 0;
  for (const g of gens) {
    try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); S.history.delete(g.id); B.marked.delete(g.id); done++; }
    catch (e) { toast(`#${g.id}: ${e.message}`, true); }
  }
  saveMarked();
  if (GAL.el) galleryRefresh();
  toast(`Deleted ${done} generation${done === 1 ? '' : 's'}`);
  return done > 0;
}

export function boardChanged(g) {
  if (GAL.el) return galleryRefresh();   // the board catches up when the gallery closes
  const tiles = $('#board').querySelectorAll(`.tile[data-gen="${g.id}"]`);
  if (!tiles.length || (B.filter === 'pinned' && !g.pinned) || (B.filter === 'marked' && !B.marked.has(g.id))) return renderBoard();
  tiles.forEach((t) => {
    const p = t.querySelector('.pin'); p.classList.toggle('on', !!g.pinned); p.textContent = g.pinned ? '★' : '☆';
    t.classList.toggle('marked', B.marked.has(g.id));
  });
}

// ---- board gallery: full screen, one big preview with a sliding row of thumbnails under it.
// Swipe (or ← →) to move through what the board is showing; pin, mark for deletion, edit.
export const GAL = { el: null, items: [], idx: 0, key: null };
const galThumbs = new IntersectionObserver((entries) => {   // video thumbnails load their first frame once scrolled to
  for (const e of entries) if (e.isIntersecting) { e.target.preload = 'metadata'; galThumbs.unobserve(e.target); }
}, { rootMargin: '0px 400px' });

function openGallery(key) {
  GAL.items = boardItems();
  GAL.idx = Math.max(0, GAL.items.findIndex((x) => x.key === key));
  if (!GAL.items.length) return;
  pauseBoard();
  const main = h('div', { class: 'gal-main' });
  const el = h('div', { class: 'gal-view', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'gal-top' }, h('span', { class: 'gal-title' }), h('span', { class: 'gal-count hint' }),
      button('Thumbnails', () => galleryStrip(), { cls: 'small gal-strip-btn', title: 'Show or hide the thumbnails (T)' }),
      iconBtn('Close', '✕', () => closeGallery())),
    h('div', { class: 'gal-stage' }, main,
      h('button', { type: 'button', class: 'gal-nav prev', 'aria-label': 'Previous', onclick: () => galleryGo(-1) }, '‹'),
      h('button', { type: 'button', class: 'gal-nav next', 'aria-label': 'Next', onclick: () => galleryGo(1) }, '›')),
    h('div', { class: 'gal-actions' }),
    h('div', { class: 'gal-strip' }));
  GAL.el = el;
  document.body.append(el);
  galleryStrip(store.get('deck.gallery.strip', true));
  wireGallerySwipe(main);
  galleryRender(true);
  overlayOpened(galleryBack);
}
const galleryBack = () => closeGallery(true);
// The thumbnail row can be hidden to give the preview the whole height (tall videos); remembered
function galleryStrip(on = GAL.el.classList.contains('no-strip')) {
  GAL.el.classList.toggle('no-strip', !on);
  GAL.el.querySelector('.gal-strip-btn').classList.toggle('on', on);
  store.set('deck.gallery.strip', on);
  if (on) GAL.el.querySelector('.gal-thumb.sel')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}
export function closeGallery(viaBack = false) {
  if (!GAL.el) return;
  const key = GAL.items[GAL.idx]?.key;
  GAL.el.querySelectorAll('video').forEach((v) => v.pause());
  GAL.el.remove(); GAL.el = null; galThumbs.disconnect();
  if (viaBack !== true) overlayClosed(galleryBack);
  if ($('#tab-board').classList.contains('active')) {
    renderBoard().then(() => $(`#board .tile[data-key="${key}"]`)?.scrollIntoView({ block: 'center' }));
  }
}

// After pins / marks / deletes: rebuild the list, staying on the same item (or its neighbour if it went)
export function galleryRefresh() {
  const key = GAL.items[GAL.idx]?.key;
  GAL.items = boardItems();
  if (!GAL.items.length) return closeGallery();
  const at = GAL.items.findIndex((x) => x.key === key);
  const same = at >= 0;
  GAL.idx = same ? at : Math.min(GAL.idx, GAL.items.length - 1);
  galleryRender(!same);
}

function galleryGo(d) {
  const n = Math.max(0, Math.min(GAL.items.length - 1, GAL.idx + d));
  if (n === GAL.idx) return;
  GAL.idx = n; galleryRender(true);
}

function galleryRender(newMedia = false) {
  const el = GAL.el, cur = GAL.items[GAL.idx];
  if (!el || !cur) return;
  const g = S.history.get(cur.g.id) || cur.g, { o, i } = cur;
  const marked = B.marked.has(g.id);
  el.querySelector('.gal-title').textContent = `#${g.id} ${g.template}`;
  el.querySelector('.gal-count').textContent = `${GAL.idx + 1} / ${GAL.items.length}`;
  el.querySelector('.gal-nav.prev').disabled = GAL.idx === 0;
  el.querySelector('.gal-nav.next').disabled = GAL.idx === GAL.items.length - 1;
  const main = el.querySelector('.gal-main');
  main.classList.toggle('marked', marked);
  if (newMedia || GAL.key !== cur.key) {
    main.querySelectorAll('video').forEach((v) => v.pause());
    galleryZoom(1);
    main.replaceChildren(o.kind === 'video'
      ? h('video', { src: o.url, muted: true, loop: true, playsInline: true, autoplay: true, controls: true })
      : h('img', { src: o.url, alt: o.filename, draggable: false }));
    for (const d of [-1, 1]) {   // warm the cache for the neighbours
      const nb = GAL.items[GAL.idx + d];
      if (nb && nb.o.kind === 'image') new Image().src = nb.o.url;
    }
  }
  GAL.key = cur.key;

  el.querySelector('.gal-actions').replaceChildren(...[
    button(g.pinned ? '★ Pinned' : '☆ Pin', () => togglePin(g), { cls: 'small' + (g.pinned ? ' on' : ''), title: 'P' }),
    button(marked ? '🗑 Marked' : '🗑 Mark', () => { toggleMarked(g.id); boardChanged(g); }, { cls: 'small' + (marked ? ' danger on' : ''), title: 'D' }),
    o.kind === 'image' ? button('✎ Edit', () => { closeGallery(); itemsToEditor([cur]); }, { title: 'E' }) : null,
    button('Use as input', () => { closeGallery(); sendToInput(g, i, 'first'); }),
    button('Details', () => openGeneration(g.id)),
    linkBtn('Download', o.url, { download: o.filename }),
    markedGens().length ? button(`Delete ${markedGens().length} marked`, deleteMarked, { cls: 'small danger' }) : null,
  ].filter(Boolean));

  const strip = el.querySelector('.gal-strip');
  if (strip.childElementCount !== GAL.items.length || newMedia) {
    galThumbs.disconnect();
    strip.replaceChildren(...GAL.items.map((x, n) => h('button', { type: 'button', class: 'gal-thumb', 'data-n': n, onclick: () => { GAL.idx = n; galleryRender(true); } },
      x.o.kind === 'video' ? h('video', { src: `${x.o.url}#t=0.1`, muted: true, playsInline: true, preload: 'none' })
        : h('img', { src: x.o.url, loading: 'lazy', alt: '', draggable: false }),
      h('span', { class: 'gal-badges' }))));
    strip.querySelectorAll('video').forEach((v) => galThumbs.observe(v));
  }
  strip.querySelectorAll('.gal-thumb').forEach((t, n) => {
    const x = GAL.items[n], xg = S.history.get(x.g.id) || x.g;
    t.classList.toggle('sel', n === GAL.idx);
    t.classList.toggle('marked', B.marked.has(xg.id));
    t.querySelector('.gal-badges').textContent = `${xg.pinned ? '★' : ''}${B.marked.has(xg.id) ? '🗑' : ''}${x.o.kind === 'video' ? '▶' : ''}`;
  });
  strip.querySelector('.gal-thumb.sel')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: newMedia ? 'smooth' : 'auto' });
}

// Swipe sideways on the big preview to move; the picture follows the finger. Pinch, the wheel or
// a double-tap zooms (images and videos); while zoomed one finger pans instead of swiping.
const GZ = { s: 1, x: 0, y: 0 };
function galleryZoom(s, x, y) {
  if (s <= 1.01) { s = 1; x = 0; y = 0; }
  Object.assign(GZ, { s, x, y });
  const m = GAL.el?.querySelector('.gal-main > *');
  if (m) m.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
  GAL.el?.classList.toggle('zoomed', s !== 1);
}
function wireGallerySwipe(main) {
  const zoomAt = (f, cx, cy) => {   // keep the point under (cx, cy) where it is
    const r = main.getBoundingClientRect(), qx = cx - (r.left + r.width / 2), qy = cy - (r.top + r.height / 2);
    const s = Math.max(1, Math.min(8, GZ.s * f)); f = s / GZ.s;
    galleryZoom(s, qx - f * (qx - GZ.x), qy - f * (qy - GZ.y));
  };
  const pts = new Map();
  let start = null, pinch = null, lastTap = 0;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {   // second finger: pinch, and forget any swipe the first one started
      start = null; main.style.transform = '';
      pinch = mid();
      for (const id of pts.keys()) { try { main.setPointerCapture(id); } catch { /* synthetic */ } }
      return;
    }
    if (pts.size > 2) return;
    const m = main.firstElementChild;
    // leave the bottom of an unzoomed video to its own controls (scrubbing)
    if (GZ.s === 1 && m?.tagName === 'VIDEO' && e.clientY > m.getBoundingClientRect().bottom - 50) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, horiz: null, pan: GZ.s > 1, zx: GZ.x, zy: GZ.y, moved: false };
    if (start.pan) { try { main.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
  });
  main.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const now = mid();
      if (pinch.d > 0) zoomAt(now.d / pinch.d, now.x, now.y);
      galleryZoom(GZ.s, GZ.x + now.x - pinch.x, GZ.y + now.y - pinch.y);
      pinch = now;
      return;
    }
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 10) start.moved = true;
    if (start.pan) return galleryZoom(GZ.s, start.zx + dx, start.zy + dy);
    if (start.horiz == null && start.moved) {
      start.horiz = Math.abs(dx) > Math.abs(dy);
      if (start.horiz) { try { main.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
    }
    if (start.horiz) main.style.transform = `translateX(${dx}px)`;
  });
  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pinch) { if (!pts.size) pinch = null; return; }   // the rest of a pinch isn't a swipe or a tap
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, { horiz, pan, moved } = start;
    start = null;
    if (!pan && horiz) {
      main.style.transition = 'transform .15s'; main.style.transform = '';
      setTimeout(() => { main.style.transition = ''; }, 160);
      if (Math.abs(dx) > Math.min(80, main.clientWidth / 6)) galleryGo(dx < 0 ? 1 : -1);
    }
    if (!moved && e.type === 'pointerup') {   // double-tap: zoom in there, or back out
      if (Date.now() - lastTap < 300) { lastTap = 0; if (GZ.s > 1) galleryZoom(1); else zoomAt(2.5, e.clientX, e.clientY); }
      else lastTap = Date.now();
    }
  };
  main.addEventListener('pointerup', end); main.addEventListener('pointercancel', end);
  main.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY); }, { passive: false });
}

document.addEventListener('keydown', (e) => {
  if (!GAL.el || sheetOpen() || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
  const cur = GAL.items[GAL.idx];
  const keys = {
    ArrowLeft: () => galleryGo(-1), ArrowRight: () => galleryGo(1),
    Home: () => galleryGo(-GAL.items.length), End: () => galleryGo(GAL.items.length),
    Escape: () => closeGallery(),
    t: () => galleryStrip(),
    p: () => togglePin(S.history.get(cur.g.id) || cur.g),
    d: () => { toggleMarked(cur.g.id); boardChanged(cur.g); },
    e: () => { if (cur.o.kind === 'image') { closeGallery(); itemsToEditor([cur]); } },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

export function pauseBoard() { document.querySelectorAll('#board video').forEach((v) => { boardVideos.unobserve(v); v.pause(); }); }
