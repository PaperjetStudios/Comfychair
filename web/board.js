import {
  $, h, store, api, toast, undoToast, overlayOpened, overlayClosed, sheetOpen, button, iconBtn, linkBtn, seg, placeholder,
  numSlider, field, section, hint, openSheet, closeSheet, icon, iconize, setIcon,
} from './ui.js';
import { fmtTime } from './playback.js';
import { bareSource, extractSound, genLabel, soundInput, soundToSoundTab } from './media.js';
import { S, switchTab } from './core.js';
import { openGeneration } from './run.js';
import { openUseAs } from './useas.js';
import { E, FULL, editorTabsReady, persistEditor, renderEditor } from './editor.js';
import { addToTimeline } from './video.js';
import { maximizable, zoomPan } from './layout.js';
import { cardPicture, kindDef, kindOf, kindTile, waveArt } from './kinds.js';
import { openCompare } from './compare.js';

// ---------------------------------------------------------------------------
// board: every picture, clip and sound in the project as a pin board. Pin favourites, filter, resize the tiles.
// Videos play (muted) while on screen; sounds show their waveform.
// ---------------------------------------------------------------------------
export const B = { filter: store.get('deck.board.filter', 'all'), size: store.get('deck.board.size', 240), loadedFor: undefined,
  selecting: false, sel: new Set(), longPressed: false, boxDrag: store.get('deck.board.boxDrag', false),   // sel: "<generation id>:<output index>"
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
  if (!B.boxWired) { B.boxWired = true; wireBoxSelect(); }
  const bar = $('#boardBar');
  if (B.filter === 'marked' && !B.marked.size) B.filter = 'all';
  const filters = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Sounds'], ['motion', 'Motion'], ['3d', '3D'],
    ['pinned', '★ Pinned'], ...(B.marked.size ? [['marked', '🗑 Marked']] : [])];
  const filterSeg = seg(filters, B.filter, (k) => { B.filter = k; store.set('deck.board.filter', k); renderBoard(); });
  const size = numSlider({ min: 120, max: 520, step: 10, value: B.size, label: 'Tile size' });
  const setSize = () => { B.size = Number(size.value); store.set('deck.board.size', B.size); $('#board').style.setProperty('--tile', `${B.size}px`); };
  size.addEventListener('input', setSize); size.addEventListener('change', setSize);
  const count = h('span', { class: 'hint' });
  const selBtn = button(B.selecting ? 'Done' : '☑ Select', () => setBoardSelecting(!B.selecting), { cls: 'small' + (B.selecting ? ' on' : '') });
  const delMarked = h('span', { class: 'hidden' });   // filled in once the project's generations are loaded
  const importBtn = button('⤓ Import clip', () => import('./clipimport.js').then((m) => m.openClipImport({ onSaved: clipImported })),
    { title: 'Cut a piece out of a YouTube/Reddit link, or a big video file, into the media library' });
  bar.replaceChildren(filterSeg, h('label', { class: 'board-size' }, 'Size', size), selBtn, importBtn, delMarked, count, boardSelBar());
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
// a filter's kinds: 3D is models and splats; every kind the app makes is on the board (not plain files)
const FILTER_KINDS = { image: ['image'], video: ['video'], audio: ['audio'], motion: ['motion'], '3d': ['mesh', 'splat'] };
function boardItems() {
  const items = [];
  const gens = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done').sort((a, b) => b.id - a.id);
  for (const g of gens) {
    if (B.filter === 'pinned' && !g.pinned) continue;
    if (B.filter === 'marked' && !B.marked.has(g.id)) continue;
    g.outputs.forEach((o, i) => {
      const k = kindOf(o);
      if (k === 'file') return;
      if (FILTER_KINDS[B.filter] && !FILTER_KINDS[B.filter].includes(k)) return;
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

// a clip's length on its tile: 4.9s, 1:05
const clipLen = (s) => (s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const kindMark = (o) => (kindOf(o) === 'image' ? null : icon(kindDef(o).icon));   // (kinds.js)
function boardTile(g, o, i) {
  // light previews (app/previews.py): a still straight away; videos loop a small 8 fps copy while on screen
  const media = cardPicture(o, g, B.size, { live: true });   // (kinds.js: the same pictures as everywhere)
  const pin = h('button', { type: 'button', class: 'pin' + (g.pinned ? ' on' : ''), 'aria-label': g.pinned ? 'Unpin' : 'Pin',
    onclick: (e) => { e.stopPropagation(); togglePin(S.history.get(g.id) || g); } }, iconize(g.pinned ? '★' : '☆'));
  const key = `${g.id}:${i}`;
  const tile = h('div', { class: 'tile' + (B.sel.has(key) ? ' sel' : '') + (B.marked.has(g.id) ? ' marked' : ''), 'data-gen': g.id, 'data-key': key,
    onclick: () => {
      if (B.longPressed) { B.longPressed = false; return; }   // the long press already selected it
      if (B.selecting) toggleBoardSel(key, tile); else openGallery(key);
    } }, media, pin, h('span', { class: 'tick', 'aria-hidden': 'true' }, icon('check')),
    h('span', { class: 'mark', 'aria-hidden': 'true' }, icon('trash')),
    o.duration ? h('span', { class: 'tile-len' }, clipLen(o.duration)) : null,
    h('div', { class: 'tile-meta' }, genLabel(g), kindMark(o)));
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

// ---- a clip's sound: take it out into the media library, or put another sound on it (a new clip in History)
function openSoundSheet(g, i) {
  const video = { generation: g.id, index: i };
  let sound = null, mode = 'replace';
  const vol = numSlider({ min: 0, max: 2, step: 0.05, value: 1, digits: 2, label: 'Sound level' });
  const keep = numSlider({ min: 0, max: 2, step: 0.05, value: 1, digits: 2, label: 'Clip sound level' });
  const at = h('input', { type: 'number', inputMode: 'decimal', min: 0, step: 0.1, value: 0, 'aria-label': 'Starts at (s)' });
  const keepRow = field('The clip\'s own sound level', keep);
  const lay = async () => {
    if (!sound) return toast('Choose a sound first', true);
    try {
      const out = await api('/api/audio/lay', { method: 'POST', timeout: 600000, busy: 'Putting the sound on…', body: {
        video, sound: bareSource(sound),
        sound_trim: sound.trim || null, mode, at: parseFloat(at.value) || 0, volume: parseFloat(vol.value), keep: parseFloat(keep.value), project_id: S.project } });
      closeSheet();
      toast(`Made #${out.id} with the new sound`);
      S.history.set(out.id, out);
      if (GAL.el) galleryRefresh(); else renderBoard();
    } catch (e) { toast(e.message, true); }
  };
  keepRow.classList.toggle('hidden', mode !== 'mix');
  openSheet(h('h3', {}, `Sound · ${genLabel(g)}`),
    section('Take the sound out', null,
      hint('Saves the clip\'s sound as its own file in the media library, to edit in the Sound tab or use as a reference.'),
      h('div', { class: 'row wrap' }, button('Take the sound out', async () => {
        try { await extractSound(video, { name: `${g.id}-${g.template}-sound` }); closeSheet(); } catch (e) { toast(e.message, true); }
      }, { cls: 'primary' }), button('Into the Sound tab', async () => {
        closeSheet(); await soundToSoundTab(video, { name: `${g.id}-${g.template}-sound` });
      }, { title: 'Take the sound out and put it on the Sound tab\'s timeline' }))),
    section('Put a sound on it', null,
      soundInput(null, (v) => { sound = v; }, { title: 'The sound to put on the clip' }),
      field('Clip\'s own sound', seg([['replace', 'Replace it'], ['mix', 'Keep it under']], mode, (v) => { mode = v; keepRow.classList.toggle('hidden', v !== 'mix'); })),
      keepRow, field('Sound level', vol), field('Starts at (s)', at),
      h('div', { class: 'row wrap' }, button('Make the clip', lay, { cls: 'primary' }))));
}

// ---- board selection: pick tiles, then make a new edit from them, put them on the timeline, or delete
// Box select: drag across the board to select the tiles under the box. In select mode a mouse or pen drag starts it
// (a pen doesn't scroll the board then), and so does a finger with Drag to select on; otherwise a finger starts it
// with a long press and keeps going without lifting (then the page doesn't scroll).
// The box's start is pinned to the board's content (y0 in scrolled pixels), so it stretches as the board scrolls under
// it: by the edge auto-scroll, a finger (while a pen draws the box), a second finger, or the wheel.
const BOX = { on: false, x0: 0, y0: 0, base: null, el: null, id: null, type: null, sc: null, raf: 0, last: null };
function boxStart(e) {
  const sc = document.getElementById('tab-board');
  Object.assign(BOX, { on: true, x0: e.clientX, y0: e.clientY + sc.scrollTop, base: new Set(B.sel), id: e.pointerId, type: e.pointerType, sc, last: e });
  BOX.el ||= h('div', { class: 'board-box' });
  document.body.append(BOX.el);
  B.longPressed = true;   // the click that ends the drag isn't a tap on a tile
  boxMove(e);
}
function boxMove(e) {
  if (!BOX.on) return;
  BOX.last = e;
  const top = Math.min(BOX.y0 - BOX.sc.scrollTop, e.clientY), bottom = Math.max(BOX.y0 - BOX.sc.scrollTop, e.clientY);
  const left = Math.min(BOX.x0, e.clientX), right = Math.max(BOX.x0, e.clientX);
  Object.assign(BOX.el.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  const sel = new Set(BOX.base);
  for (const t of document.querySelectorAll('#board .tile[data-key]')) {
    const r = t.getBoundingClientRect();
    if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) sel.add(t.dataset.key);
  }
  B.sel = sel;
  for (const t of document.querySelectorAll('#board .tile[data-key]')) t.classList.toggle('sel', sel.has(t.dataset.key));
  const bar = $('#boardBar .board-sel');
  if (bar) bar.replaceWith(boardSelBar());
  // near (or past) the top or bottom: scroll, faster the deeper in, and keep selecting while the pen rests there
  const sr = BOX.sc.getBoundingClientRect(), edge = Math.min(110, sr.height / 4);
  const dy = e.clientY < sr.top + edge ? -(sr.top + edge - e.clientY) : e.clientY > sr.bottom - edge ? e.clientY - (sr.bottom - edge) : 0;
  cancelAnimationFrame(BOX.raf);
  if (dy) {
    BOX.raf = requestAnimationFrame(() => {
      const before = BOX.sc.scrollTop;
      BOX.sc.scrollTop += Math.sign(dy) * Math.min(40, 2 + (Math.abs(dy) / edge) ** 1.5 * 24);
      if (BOX.sc.scrollTop !== before) boxMove(BOX.last);   // (at the very top or bottom it stops)
    });
  }
}
// the board scrolled under the box (any cause): stretch it to where the pen is now
const boxFollow = () => { if (BOX.on && BOX.last) boxMove(BOX.last); };
function boxEnd() {
  if (!BOX.on) return;
  BOX.on = false; cancelAnimationFrame(BOX.raf); BOX.el?.remove();
  setTimeout(() => { B.longPressed = false; }, 0);
}
function wireBoxSelect() {
  const board = document.getElementById('board');
  let down = null;
  let touches = 0;   // (fingers on the board: two scroll, even with Drag to select on)
  board.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && ++touches > 1) { down = null; return; }
    down = e.button === 0 || e.pointerType !== 'mouse' ? { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, t: Date.now() } : null;
  });
  window.addEventListener('pointermove', (e) => {
    if (BOX.on) { if (e.pointerId === BOX.id) boxMove(e); return; }
    if (!down || e.pointerId !== down.id || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12) return;
    // a mouse or pen drag in select mode (a finger too with Drag to select on), or any drag right after a long press
    if ((B.selecting && (down.type !== 'touch' || B.boxDrag)) || B.longPressed) boxStart({ clientX: down.x, clientY: down.y, pointerId: e.pointerId, pointerType: down.type }), boxMove(e);
    else down = null;   // a finger that moves before the long press is scrolling
  });
  // only the pointer drawing the box ends it (another finger lifting, from scrolling, doesn't)
  const up = (e) => { if (e.pointerType === 'touch') touches = Math.max(0, touches - 1); down = null; if (!BOX.on || e.pointerId === BOX.id) boxEnd(); };
  window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  document.getElementById('tab-board').addEventListener('scroll', boxFollow, { passive: true });
  // The board mustn't scroll under the pen or finger drawing a box, but other fingers may scroll it meanwhile (a
  // finger while a pen draws, a second finger while a finger draws). In select mode a pen (or a finger with Drag to
  // select on) never scrolls it, so its drag is a box from the start (the first move is stopped, not the tap).
  document.addEventListener('touchmove', (e) => {
    const ts = [...e.touches], pens = ts.filter((t) => t.touchType === 'stylus').length, fingers = ts.length - pens;
    const drawing = BOX.on && (BOX.type === 'pen' ? fingers === 0 : BOX.type === 'touch' ? ts.length === 1 : true);
    if (drawing || (!BOX.on && B.selecting && e.target.closest?.('#board') && ((B.boxDrag && ts.length === 1) || pens))) e.preventDefault();
  }, { passive: false });
}

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
// The selected clips drawn again at 1080P by Open-H3-Regenerate (its refiner LoRA); each lands on the Board as a new
// take, a child of its draft. The 1080P second pass is 2 steps from 0.70 and keeps the clip's sound.
async function boardFinish() {
  const clips = boardSelected().filter(({ o }) => o.kind === 'video');
  if (!clips.length) return toast('Select a clip first', true);
  let info;
  try { info = await api('/api/h3/regen', { busy: false }); } catch (e) { return toast(e.message, true); }
  if (!info.available) return toast(info.reason || 'Regenerate needs its refiner LoRA in models/loras', true);
  const lora = info.loras[0].name;
  let n = 0;
  for (const { g, i } of clips) {
    try {
      const run = await api('/api/h3/upscale', { method: 'POST', busy: false,
        body: { generation: g.id, index: i, scale: 1.5, strength: 'strong',
                regen: { quality: 'standard', lora, target: '1080p' } } });
      S.history.set(run.id, run);
      boardChanged(run);
      n++;
    } catch (e) { toast(`#${g.id}: ${e.message}`, true); }
  }
  if (n) toast(`${n} finish${n === 1 ? '' : 'es'} queued`);
}

function boardSelBar() {
  if (!B.selecting) return h('span', { class: 'board-sel hidden' });
  const n = B.sel.size, items = boardSelected(), images = items.filter((x) => x.o.kind === 'image').length;
  const comparable = n === 2 && items.every((x) => x.o.kind !== 'audio');
  const videos = items.filter((x) => x.o.kind === 'video').length;
  const visibleKeys = () => [...$('#board').querySelectorAll('.tile[data-key]')].map((t) => t.dataset.key);
  return h('div', { class: 'board-sel' },
    h('b', {}, n ? `${n} selected` : 'Tap tiles to select'),
    button('Drag to select', () => { B.boxDrag = !B.boxDrag; store.set('deck.board.boxDrag', B.boxDrag); renderBoard(); },
      { cls: 'small' + (B.boxDrag ? ' on' : ''), title: 'On: a finger dragged across the board selects the tiles under it (scroll with two fingers or the scroll bar). A pen always does.' }),
    button('All', () => { visibleKeys().forEach((k) => B.sel.add(k)); renderBoard(); }),
    n ? button('None', () => { B.sel.clear(); renderBoard(); }) : null,
    button(`New edit${images ? ` (${images})` : ''}`, boardToEditor, { cls: 'small primary', disabled: !images }),
    button('Compare', boardCompare, { disabled: !comparable, title: 'Select two pictures or clips to see them side by side or wipe between them' }),
    button('To video', boardToVideo, { disabled: !n }),
    button('Finish', boardFinish, { disabled: !videos,
      title: 'Draw the selected clips again at 1080P with Open-H3-Regenerate (its refiner LoRA in models/loras)' }),
    button('Delete', boardDelete, { cls: 'small danger', disabled: !n }));
}

// A clip from the importer is in the media library (not a generation, so not on the board): offer where to use it
function clipImported(e) {
  toast(`${e.label} is in the media library`, false, { label: 'Open in VFX', fn: () => import('./vfx.js').then((m) => m.sendToVfx({ media: e.name }, { label: e.label })) });
}

// The selected images as a fresh Editor layout (side by side, or a grid for more than 3).
// Whatever was in the Editor can be brought back with Undo.
function boardCompare() {
  const items = boardSelected().reverse();   // older on the left
  if (items.length === 2 && items.every((x) => x.o.kind !== 'audio')) openCompare(items.map(({ g, o }) => ({ o, label: genLabel(g) })));
}
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
  await editorTabsReady();   // a first visit loads the tab's saved state; write after it, not before
  const before = { layers: E.layers, arrange: E.arrange, size: E.size };
  E.layers = names.reverse().map((name) => ({ name, crop: { ...FULL }, scale: 1, hidden: false }));  // first selected on top of the list
  E.sel = null; E.cropping = false; E.size = null;
  E.arrange = names.length > 3 ? 'grid' : 'row';
  E.cols = names.length > 3 ? Math.ceil(Math.sqrt(names.length)) : E.cols;
  persistEditor();
  setBoardSelecting(false);
  switchTab('editor');
  const tid = E.tab?.id;
  if (before.layers.length) undoToast(`New edit with ${names.length} image${names.length > 1 ? 's' : ''}`, () => {
    if (E.tab?.id !== tid) return toast('That edit is in another tab', true);
    Object.assign(E, before); persistEditor(); renderEditor();
  });
}

// The selection onto the Video timeline, oldest first, after what's already there
async function boardToVideo() {
  const items = boardSelected().reverse();
  if (!items.length) return;
  for (const { g, o, i } of items) {
    await addToTimeline({ kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: genLabel(g), dur: o.duration || 0 });
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
    const p = t.querySelector('.pin'); p.classList.toggle('on', !!g.pinned); setIcon(p, g.pinned ? '★' : '☆');
    t.classList.toggle('marked', B.marked.has(g.id));
  });
}

// ---- board gallery: full screen, one big preview with a sliding row of thumbnails under it.
// Swipe (or ← →) to move through what the board is showing; pin, mark for deletion, edit.
export const GAL = { el: null, items: [], idx: 0, key: null };
const galThumbs = new IntersectionObserver((entries) => {   // video thumbnails load their first frame once scrolled to
  for (const e of entries) if (e.isIntersecting) { e.target.preload = 'metadata'; galThumbs.unobserve(e.target); }
}, { rootMargin: '0px 400px' });

// The gallery's video plays with its sound (opened by a tap, so the browser allows it), unless it was muted
// last time; if the browser still refuses, it plays muted.
function galleryVideo(o) {
  const v = h('video', { src: o.url, muted: !!store.get('deck.board.muted', false), loop: true, playsInline: true, controls: true });
  v.addEventListener('volumechange', () => store.set('deck.board.muted', v.muted));
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  return v;
}

// A sound in the gallery: a big play button, its waveform as the scrub bar (tap or drag it), a slider and the time.
// It plays on opening, like a clip.
const clock = (s) => fmtTime(s);
function galleryAudio(o) {
  const a = h('audio', { src: o.url, preload: 'auto' });
  const fill = h('div', { class: 'gal-wave-fill' });
  const wave = waveArt(o, 640, 'gal-wave');
  wave.append(fill);
  const play = h('button', { type: 'button', class: 'gal-play', 'aria-label': 'Play' }, icon('play'));
  const time = h('span', { class: 'gal-time' });
  const scrub = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: 0, 'aria-label': 'Position' });
  const dur = () => (isFinite(a.duration) && a.duration > 0 ? a.duration : o.duration || 0);
  let raf = 0;
  const draw = () => {
    const d = dur(), p = d ? Math.min(1, a.currentTime / d) : 0;
    fill.style.width = `${p * 100}%`;
    if (document.activeElement !== scrub || a.paused) scrub.value = p;
    time.textContent = `${clock(a.currentTime)} / ${clock(d)}`;
    setIcon(play, a.paused ? '▶' : '❚❚');
    play.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
    cancelAnimationFrame(raf);
    if (!a.paused && a.isConnected) raf = requestAnimationFrame(draw);
  };
  const seek = (p) => { if (dur()) { a.currentTime = Math.max(0, Math.min(1, p)) * dur(); draw(); } };
  for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'seeked']) a.addEventListener(ev, draw);
  play.addEventListener('click', () => (a.paused ? a.play().catch(() => {}) : a.pause()));
  scrub.addEventListener('input', () => seek(Number(scrub.value)));
  wave.addEventListener('pointerdown', (e) => {
    const at = (ev) => { const r = wave.getBoundingClientRect(); seek((ev.clientX - r.left) / r.width); };
    try { wave.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    at(e);
    const move = (ev) => at(ev), up = () => { wave.removeEventListener('pointermove', move); wave.removeEventListener('pointerup', up); wave.removeEventListener('pointercancel', up); };
    wave.addEventListener('pointermove', move); wave.addEventListener('pointerup', up); wave.addEventListener('pointercancel', up);
  });
  draw();
  a.play().catch(() => draw());
  return h('div', { class: 'gal-audio' }, a, h('div', { class: 'gal-audio-ui' }, wave,
    h('div', { class: 'gal-audio-bar' }, play, scrub, time)));
}

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
  GAL.max = maximizable(el, el.querySelector('.gal-stage'), { title: 'Full screen the picture' });   // hides the bars: just the picture
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
  GAL.max?.exit(); GAL.max = null;
  GAL.el.querySelectorAll('video, audio').forEach((v) => v.pause());
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
  el.querySelector('.gal-title').textContent = genLabel(g);
  el.querySelector('.gal-count').textContent = `${GAL.idx + 1} / ${GAL.items.length}`;
  el.querySelector('.gal-nav.prev').disabled = GAL.idx === 0;
  el.querySelector('.gal-nav.next').disabled = GAL.idx === GAL.items.length - 1;
  const main = el.querySelector('.gal-main');
  main.classList.toggle('marked', marked);
  if (newMedia || GAL.key !== cur.key) {
    main.querySelectorAll('video, audio').forEach((v) => v.pause());
    galleryZoom();
    main.replaceChildren(o.kind === 'video' ? galleryVideo(o) : o.kind === 'audio' ? galleryAudio(o) : o.kind === 'image' ? h('img', { src: o.url, alt: o.filename, draggable: false }) : kindTile(o, cur.g));
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
    button('Use as…', () => openUseAs(g, i, { before: () => closeGallery() }), { cls: 'small primary', title: 'U: send it to Generate, VFX, Video, Sound, the Editor or 3D' }),
    o.kind === 'video' ? button('♪ Sound', () => openSoundSheet(g, i), { title: 'Take the sound out, or put a sound on this clip' }) : null,
    button('Details', () => openGeneration(g.id)),
    linkBtn('Download', o.url, { download: o.filename }),
    markedGens().length ? button(`Delete ${markedGens().length} marked`, deleteMarked, { cls: 'small danger' }) : null,
  ].filter(Boolean));

  const strip = el.querySelector('.gal-strip');
  if (strip.childElementCount !== GAL.items.length || newMedia) {
    galThumbs.disconnect();
    strip.replaceChildren(...GAL.items.map((x, n) => h('button', { type: 'button', class: 'gal-thumb', 'data-n': n, onclick: () => { GAL.idx = n; galleryRender(true); } },
      x.o.kind === 'audio' ? waveArt(x.o, 192, 'gal-thumb-wave') : cardPicture(x.o, x.g, 192),
      h('span', { class: 'gal-badges' }))));
    strip.querySelectorAll('video').forEach((v) => galThumbs.observe(v));
  }
  strip.querySelectorAll('.gal-thumb').forEach((t, n) => {
    const x = GAL.items[n], xg = S.history.get(x.g.id) || x.g;
    t.classList.toggle('sel', n === GAL.idx);
    t.classList.toggle('marked', B.marked.has(xg.id));
    t.querySelector('.gal-badges').replaceChildren(...[xg.pinned && iconize('★'), B.marked.has(xg.id) && icon('trash'), kindMark(x.o)].filter(Boolean));
  });
  strip.querySelector('.gal-thumb.sel')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: newMedia ? 'smooth' : 'auto' });
}

// Swipe sideways on the big preview to move; the picture follows the finger. Pinch, the wheel or a double-tap zooms
// (images and videos; layout.js zoomPan, as in Generate's viewer); while zoomed one finger pans instead of swiping.
let GZ = null;
function galleryZoom() { GZ?.reset(); }
function wireGallerySwipe(main) {
  const media = () => main.firstElementChild;
  GZ = zoomPan(main, media, {
    canZoom: () => !media()?.classList.contains('gal-audio'),
    // a sound's play button and scrub bar keep their touches, and so does the bottom of an unzoomed video (its controls)
    skip: (e) => !!e.target.closest('.gal-audio-ui') || (GZ.s() === 1 && media()?.tagName === 'VIDEO' && e.clientY > media().getBoundingClientRect().bottom - 50),
    swipe: (dir) => galleryGo(dir),
    onChange: (s) => GAL.el?.classList.toggle('zoomed', s !== 1) });
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
    u: () => openUseAs(S.history.get(cur.g.id) || cur.g, cur.i, { before: () => closeGallery() }),
    ' ': () => { const m = GAL.el.querySelector('.gal-main video, .gal-main audio'); if (m) { if (m.paused) m.play().catch(() => {}); else m.pause(); } },
  };
  if (e.key === ' ' && e.target.closest('button, a')) return;   // (Space on a focused button presses it)
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

export function pauseBoard() { document.querySelectorAll('#board video').forEach((v) => { boardVideos.unobserve(v); v.pause(); }); }
