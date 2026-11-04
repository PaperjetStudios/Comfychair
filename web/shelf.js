import { $, h, api, store, icon, seg, placeholder, toast, button } from './ui.js';
import { S, onServer, onProject, thumbUrl } from './core.js';
import { B, FILTER_KINDS, genTime, dayKey, dayName, usedBadge, loadAttached, loadAllProjectGenerations } from './board.js';
import { dropOnTable } from './table.js';
import { kindOf, cardPicture, kindDef } from './kinds.js';
import { genLabel, outputCard } from './media.js';
import { fetchHistory } from './generation-data.js';

// ---------------------------------------------------------------------------
// the Shelf: a drawer left of the table with the project's outputs (the Board), its History and its pictures.
// Drag a tile onto the table: a mouse uses the browser's own drag (the table takes SOURCE_TYPE); a finger or pen holds a
// moment, then drags a ghost, and the drop calls dropOnTable at that point. Double-click drops at the table's centre.
// ---------------------------------------------------------------------------
const SOURCE_TYPE = 'application/x-deck-source';
const SH = { el: null, body: null, tab: store.get('deck.shelf.tab', 'outputs'), filter: store.get('deck.shelf.filter', 'all'),
  open: store.get('deck.shelf.open', false), w: store.get('deck.shelf.w', 240), timer: 0, btn: null, inputs: null };

const tableOn = () => !!document.querySelector('#tab-table.active, #tab-table.live-host');
const stageEl = () => document.querySelector('#tab-table .table-stage');

function dropAtCentre(src) {
  const r = stageEl()?.getBoundingClientRect();
  if (r) dropOnTable([src], r.left + r.width / 2, r.top + r.height / 2);
}

// make a tile draggable: src is the JSON the table's drop reads
function draggable(tile, src) {
  tile.draggable = true;
  tile.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(SOURCE_TYPE, JSON.stringify(src));
    e.dataTransfer.effectAllowed = 'copy';
  });
  tile.addEventListener('dblclick', () => dropAtCentre(src));
  tile.addEventListener('contextmenu', (e) => { if (e.pointerType === 'touch') e.preventDefault(); });
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.button > 0) return;   // (mouse: the native drag)
    const x0 = e.clientX, y0 = e.clientY;
    const wait = e.pointerType === 'touch' ? 350 : 0;   // a finger holds first, so the drawer still scrolls
    let ghost = null, ended = false;
    const start = () => {
      if (ended) return;
      ghost = tile.cloneNode(true);
      ghost.classList.add('shelf-ghost');
      document.body.append(ghost);
      move({ clientX: x0, clientY: y0 });
    };
    const move = (ev) => { if (ghost) { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; } };
    const onMove = (ev) => {
      if (!ghost && wait === 0 && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) start();
      if (ghost) { ev.preventDefault(); move(ev); }
      else if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) end(false);   // scrolling
    };
    const stopTouch = (ev) => { if (ghost) ev.preventDefault(); };
    const end = (drop, ev) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('pointercancel', onCancel);
      removeEventListener('touchmove', stopTouch);
      ghost?.remove();
      if (drop && ghost && ev) {
        tile.dataset.dropped = '1'; setTimeout(() => delete tile.dataset.dropped, 0);
        if (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#tab-table .table-stage')) dropOnTable([src], ev.clientX, ev.clientY);
      }
    };
    const onUp = (ev) => end(true, ev), onCancel = () => end(false);
    const timer = setTimeout(start, wait || 1e9);
    addEventListener('pointermove', onMove, { passive: false });
    addEventListener('pointerup', onUp); addEventListener('pointercancel', onCancel);
    addEventListener('touchmove', stopTouch, { passive: false });
    if (wait === 0) clearTimeout(timer);
  });
  return tile;
}

// ---- outputs: the Board's pictures, clips and sounds, newest first, in day groups
const FILTERS = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Sounds'], ['3d', '3D'], ['pinned', '★'], ['free', 'Free']];
function outputItems() {
  const items = [];
  const gens = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done').sort((a, b) => b.id - a.id);
  for (const g of gens) {
    if (SH.filter === 'pinned' && !g.pinned) continue;
    if (SH.filter === 'free' && B.attached.has(g.id)) continue;
    g.outputs.forEach((o, i) => {
      const k = kindOf(o);
      if (k === 'file') return;
      if (FILTER_KINDS[SH.filter] && !FILTER_KINDS[SH.filter].includes(k)) return;
      items.push({ g, o, i });
    });
  }
  return items;
}
function outputTile({ g, o, i }) {
  const mark = kindOf(o) === 'image' ? null : icon(kindDef(o).icon);
  const tile = h('div', { class: 'tile shelf-tile', 'data-gen': g.id, 'data-key': `${g.id}:${i}`, title: `${genLabel(g)}: drag onto the table` },
    cardPicture(o, g, 160), usedBadge(g), h('div', { class: 'tile-meta' }, genLabel(g), mark));
  return draggable(tile, { generation: g.id, index: i });
}
async function drawOutputs(body) {
  if (B.loadedFor !== S.project) {
    body.replaceChildren(placeholder('Loading…'));
    try { await loadAllProjectGenerations(); } catch (e) { toast(e.message, true); }
  }
  await loadAttached();
  const chips = seg(FILTERS, SH.filter, (k) => { SH.filter = k; store.set('deck.shelf.filter', k); draw(); }, { wrap: true });
  const items = outputItems();
  const days = new Map();
  for (const it of items) { const k = dayKey(genTime(it.g)); if (!days.has(k)) days.set(k, []); days.get(k).push(it); }
  body.replaceChildren(chips, ...(items.length ? [...days].map(([k, rows]) => h('section', { class: 'shelf-day' },
    h('div', { class: 'shelf-day-head' }, h('b', {}, dayName(k)), h('span', { class: 'hint' }, String(rows.length))),
    h('div', { class: 'shelf-grid' }, rows.map(outputTile)))) : [placeholder('Nothing here yet.')]));
}

// ---- history: every run with its state; a finished one drags by its first output
function drawHistory(body) {
  const runs = [...S.history.values()].filter((g) => g.project_id === S.project).sort((a, b) => b.id - a.id);
  const card = (g) => {
    const c = outputCard(g, { onPick: () => {} });
    c.classList.add('shelf-run');
    const o = g.outputs?.[0];
    return g.status === 'done' && o && kindOf(o) !== 'file' ? draggable(c, { generation: g.id, index: 0 }) : c;
  };
  body.replaceChildren(...(runs.length ? [h('div', { class: 'shelf-grid' }, runs.map(card)),
    S.historyDone ? null : button('More', async () => { await fetchHistory(true); draw(); }, { cls: 'small' })]
    : [placeholder('Nothing generated in this project yet.')]));
}

// ---- pictures: the project's input pictures
async function drawPictures(body) {
  try { SH.inputs = await api(`/api/inputs${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false }); }
  catch (e) { return body.replaceChildren(placeholder(e.message)); }
  const rows = SH.inputs.project || [];
  body.replaceChildren(...(rows.length ? [h('div', { class: 'shelf-grid' }, rows.map((r) => draggable(
    h('div', { class: 'tile shelf-tile', title: `${r.name.split('/').pop()}: drag onto the table` },
      h('img', { src: thumbUrl(r.name), alt: '', loading: 'lazy', draggable: false }),
      h('div', { class: 'tile-meta' }, r.name.split('/').pop())), { input: r.name })))]
    : [placeholder('No pictures in this project yet.')]));
}

let seq = 0;
export async function draw() {
  if (!SH.el || !SH.open || !tableOn()) return;
  const mine = ++seq;
  const body = h('div', { class: 'shelf-body-inner' });
  const fn = { outputs: drawOutputs, history: drawHistory, pictures: drawPictures }[SH.tab] || drawOutputs;
  await fn(body);
  if (mine !== seq) return;
  const keep = SH.body.scrollTop;
  SH.body.replaceChildren(body);
  SH.body.scrollTop = keep;
}
const later = () => { clearTimeout(SH.timer); SH.timer = setTimeout(draw, 250); };

function setOpen(on) {
  SH.open = on; store.set('deck.shelf.open', on);
  SH.el.classList.toggle('open', on);
  SH.el.parentElement.classList.toggle('shelf-open', on);
  SH.btn?.classList.toggle('on', on);
  SH.btn?.setAttribute('aria-pressed', String(on));
  if (on) draw();
}
function setWidth(w) {
  SH.w = Math.max(160, Math.min(520, Math.round(w)));
  SH.el.parentElement.style.setProperty('--shelf-w', `${SH.w}px`);
}

function build(stage) {
  const tabs = seg([['outputs', 'Outputs'], ['history', 'History'], ['pictures', 'Pictures']], SH.tab,
    (t) => { SH.tab = t; store.set('deck.shelf.tab', t); SH.body.scrollTop = 0; draw(); });
  SH.body = h('div', { class: 'shelf-body' });
  const grip = h('div', { class: 'shelf-grip', role: 'separator', 'aria-label': 'Drag to resize the shelf', title: 'Drag to resize' });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = SH.w;
    const mv = (ev) => setWidth(w0 + ev.clientX - x0);
    const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); store.set('deck.shelf.w', SH.w); };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
  });
  SH.el = h('aside', { class: 'shelf', 'aria-label': 'Shelf: outputs, history and pictures' }, tabs, SH.body, grip);
  stage.prepend(SH.el);
  setWidth(SH.w);
  setOpen(SH.open);
}
function addButton(bar) {
  if (SH.btn?.isConnected) return;
  SH.btn = h('button', { type: 'button', class: 'btn small shelf-toggle', 'aria-pressed': String(SH.open), title: 'Shelf: outputs, history and pictures to drag onto the table',
    onclick: () => setOpen(!SH.open) }, icon('folder'), ' Shelf');
  SH.btn.classList.toggle('on', SH.open);
  bar.prepend(SH.btn);
}

let wired = false;
export function wireShelf() {
  if (wired) return;
  const stage = document.querySelector('#tab-table .stage');
  if (!stage) return;
  wired = true;
  build(stage);
  // the table builds its bar when it first shows; put the button in it whenever it appears
  const find = () => { const bar = stage.querySelector('.table-bar'); if (bar) addButton(bar); };
  find();
  new MutationObserver(find).observe(stage, { childList: true });
  // the table coming on shows the shelf's contents
  new MutationObserver(() => { if (tableOn() && SH.open) later(); }).observe(document.querySelector('#tab-table'), { attributes: true, attributeFilter: ['class'] });
  for (const t of ['deck_generation', 'generation_updated', 'deck_generation_deleted', 'history_loaded']) onServer(t, later);
  onServer('deck_input_deleted', () => { if (SH.tab === 'pictures') later(); });
  onProject(() => { SH.inputs = null; later(); });
}

// (board.js imports this module while it is still loading: wire once the page has been built)
if (document.querySelector('#tab-table')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireShelf, { once: true });
  else queueMicrotask(wireShelf);
}
