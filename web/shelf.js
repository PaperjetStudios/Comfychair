import { $, h, api, store, icon, seg, placeholder, toast, button, openSheet, closeSheet, section, hint, actions } from './ui.js';
import { S, onServer, onProject, thumbUrl } from './core.js';
import { B, FILTER_KINDS, genTime, dayKey, dayName, usedBadge, loadAttached, loadAllProjectGenerations, openGallery, togglePin, finishClips } from './board.js';
import { dropOnTable, selectedFrames, tableFrames } from './table.js';
import { stillOf } from './table-frames.js';
import { openPressMenu, pressMenu } from './press-menu.js';
import { openUseAs } from './useas.js';
import { openCompare } from './compare.js';
import { kindOf, cardPicture, kindDef } from './kinds.js';
import { DOC_KIND } from './table-model.js';
import { genLabel, outputCard } from './media.js';
import { fetchHistory } from './generation-data.js';

// ---------------------------------------------------------------------------
// the Shelf: a drawer left of the table with the project's outputs (the Board), its History and its pictures.
// Drag a tile onto the table: a mouse uses the browser's own drag (the table takes SOURCE_TYPE); a finger or pen holds a
// moment, then drags a ghost, and the drop calls dropOnTable at that point. Double-click drops at the table's centre.
// ---------------------------------------------------------------------------
const SOURCE_TYPE = 'application/x-deck-source';   // (the same string as table.js's, which doesn't export it)
const SH = { el: null, body: null, tab: store.get('deck.shelf.tab', 'outputs'), filter: store.get('deck.shelf.filter', 'all'),
  open: store.get('deck.shelf.open', false), w: store.get('deck.shelf.w', 240), timer: 0, btn: null, inputs: null,
  sel: new Set() };   // sel: "<run id>:<output index>", Shift-click picks tiles for Compare and Delete

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
  const mark = kindOf(o) === 'image' ? null : icon(kindDef(o).icon), key = `${g.id}:${i}`;
  const tile = h('div', { class: `tile shelf-tile${SH.sel.has(key) ? ' sel' : ''}`, 'data-gen': g.id, 'data-key': key,
    title: `${genLabel(g)}: drag onto the table · Shift-click to select · right-click or hold for more` },
    cardPicture(o, g, 160), usedBadge(g), h('div', { class: 'tile-meta' }, genLabel(g), mark));
  tile.addEventListener('click', (e) => {
    if (e.shiftKey) { if (SH.sel.has(key)) SH.sel.delete(key); else SH.sel.add(key); }
    else if (SH.sel.size) SH.sel.clear();
    else return;
    syncSel();
  });
  pressMenu(tile, (e) => tileMenu(e, { g, o, i, key }, outputList));
  return draggable(tile, { generation: g.id, index: i });
}
function syncSel() {
  SH.body?.querySelectorAll('.shelf-tile[data-key]').forEach((t) => t.classList.toggle('sel', SH.sel.has(t.dataset.key)));
}

// ---- a tile's menu (right click, long hold): open, use, compare, finish, pin, delete. With more than one tile selected
// (Shift-click), Compare and Delete take the selection.
const outputList = () => outputItems().map((x) => ({ ...x, key: `${x.g.id}:${x.i}` }));
function selectedItems() {
  return [...SH.sel].map((k) => { const [id, i] = k.split(':').map(Number), g = S.history.get(id); return g?.outputs?.[i] ? { g, o: g.outputs[i], i, key: k } : null; }).filter(Boolean);
}
const looks = (o) => ['image', 'video'].includes(kindOf(o));
function frameSide() {   // the selected frame's still, for Compare
  const f = (selectedFrames() || []).find((x) => x.kind !== 'note' && stillOf(x));
  return f ? { o: { url: stillOf(f), kind: 'image' }, label: f.label || 'Frame' } : null;
}
function tileMenu(e, it, list) {
  const many = SH.sel.has(it.key) && SH.sel.size > 1 ? selectedItems() : null;
  const { g, o, i } = it, frame = frameSide();
  const two = many?.length === 2 && many.every((x) => looks(x.o)) ? many : null;
  const gens = [...new Map((many || [it]).map((x) => [x.g.id, x.g])).values()];
  openPressMenu(e.clientX, e.clientY, [
    [{ label: 'Open', run: () => openGallery(it.key, () => { const l = list(); return l.some((x) => x.key === it.key) ? l : [it, ...l]; }) },
      { label: 'Use as…', run: () => openUseAs(g, i) }],
    [two ? { label: 'Compare the two', run: () => openCompare(two.slice().reverse().map((x) => ({ o: x.o, label: genLabel(x.g) }))) } : null,
      { label: frame ? `Compare with ${frame.label}` : 'Compare with the selected frame', disabled: !frame || !looks(o),
        run: () => openCompare([frame, { o, label: genLabel(g) }]) }].filter(Boolean),
    o.kind === 'video' ? [{ label: 'Finish (H3 1080p)', run: () => finishClips([{ g, o, i }]) }] : [],
    [{ label: g.pinned ? 'Unpin' : 'Pin', on: !!g.pinned, run: async () => { await togglePin(g); later(); } }],
    [{ label: gens.length > 1 ? `Delete ${gens.length}` : 'Delete', danger: true, run: () => deleteRuns(gens) }],
  ].filter((grp) => grp.length), 'Output');
}

// ---- the frame menu on the table (table.js table:menu): Compare with another frame or a Shelf tile; Finish a video
// frame's clips (the runs on its timeline) as the Board's Finish does
addEventListener('table:menu', (e) => {
  const { frame: f, frames = [], groups } = e.detail || {};
  if (!f || f.kind === 'note' || frames.length !== 1) return;
  const still = stillOf(f);
  groups.push([{ label: 'Compare with…', disabled: !still, run: () => compareSheet(f) }]);
  if (f.kind === 'video' && f.doc) groups.push([{ label: 'Finish (H3 1080p)', run: () => finishFrame(f) }]);
});
// a sheet of what the frame's still can be compared with: the table's other frames' stills, then the Shelf's pictures
// and clips (the ones selected there first)
function compareSheet(f) {
  const me = { o: { url: stillOf(f), kind: 'image' }, label: f.label || 'Frame' };
  if (!me.o.url) return toast(`"${f.label}" has no picture yet: open it once`, true);
  const go = (other) => { closeSheet(); openCompare([me, other]); };
  const card = (img, label, other) => h('button', { type: 'button', class: 'make-frame-card', onclick: () => go(other) },
    img ? h('img', { src: img, alt: '', loading: 'lazy' }) : h('span', { class: 'hint' }, label), h('span', {}, label));
  const others = tableFrames().filter((x) => x.id !== f.id && x.kind !== 'note' && stillOf(x));
  const picked = new Set(SH.sel);
  const outs = outputList().filter((x) => looks(x.o)).sort((a, b) => picked.has(b.key) - picked.has(a.key)).slice(0, 48);
  openSheet(h('h3', {}, `Compare "${f.label}" with…`),
    section('Frames', null, others.length ? h('div', { class: 'make-frame-list' }, others.map((x) => card(stillOf(x), x.label || 'Frame', { o: { url: stillOf(x), kind: 'image' }, label: x.label || 'Frame' })))
      : hint('No other frame on this table has a picture yet.')),
    section('Shelf', null, outs.length ? h('div', { class: 'make-frame-list' }, outs.map((x) => {
      const c = card(null, genLabel(x.g), { o: x.o, label: genLabel(x.g) });
      c.firstChild.replaceWith(cardPicture(x.o, x.g, 160));
      return c;
    })) : hint('Nothing made in this project yet.')),
    actions(button('Cancel', closeSheet, { cls: 'small ghost' })));
}
// a video frame's clips that are runs (its timeline's items), finished with H3 (board.js finishClips)
async function finishFrame(f) {
  let d;
  try { d = await api(`/api/store/${DOC_KIND.video}/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false }); }
  catch (err) { return toast(err.message, true); }
  const seen = new Set(), clips = [];
  for (const it of d.payload?.items || []) {
    const src = it.src || {}, key = `${src.generation}:${src.index || 0}`;
    if (src.generation == null || it.kind !== 'video' || seen.has(key)) continue;
    seen.add(key);
    let g = S.history.get(src.generation);
    if (!g) { try { g = await api(`/api/generations/${src.generation}`, { busy: false }); } catch { continue; } }
    const o = g?.outputs?.[src.index || 0];
    if (o?.kind === 'video') clips.push({ g, o, i: src.index || 0 });
  }
  if (!clips.length) return toast(`"${f.label}" has no made clips on its timeline (dropped files can't be finished)`, true);
  return finishClips(clips);
}

// Delete whole runs. One something uses is refused by the server (409) and the toast names what uses it.
async function deleteRuns(gens) {
  if (!gens.length) return;
  const extra = gens.reduce((n, g) => n + (g.outputs?.length || 1), 0) - gens.length;
  if (!confirm(`Delete ${gens.length === 1 ? `#${gens[0].id}` : `${gens.length} generations`} and their files? This can't be undone.`
    + (extra ? `\n\nThat also deletes ${extra} other output${extra > 1 ? 's' : ''} of ${gens.length === 1 ? 'that run' : 'those runs'}.` : ''))) return;
  if (gens.length === 1) {
    try { await api(`/api/generations/${gens[0].id}`, { method: 'DELETE', busy: 'Deleting…' }); }
    catch (e) { toast(e.status === 409 ? `#${gens[0].id} can't go: ${e.message}` : e.message, true); return; }
    S.history.delete(gens[0].id);
    toast(`Deleted #${gens[0].id}`);
  } else {
    let r;
    try { r = await api('/api/generations/delete', { method: 'POST', body: { ids: gens.map((g) => g.id) }, busy: 'Deleting…' }); }
    catch (e) { toast(e.message, true); return; }
    for (const id of r.deleted) S.history.delete(id);
    const used = (r.kept || []).map((k) => `#${k.id} (${(k.used_by || []).map((o) => `${o.label} ${o.name}`.trim()).join(', ')})`);
    toast(`Deleted ${r.deleted.length}${used.length ? `; kept, in use: ${used.join('; ')}` : ''}${r.failed?.length ? `; ${r.failed.length} failed` : ''}`, !!used.length || !!r.failed?.length);
  }
  SH.sel.clear();
  later();
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
    if (g.status !== 'done' || !o || kindOf(o) === 'file') return c;
    const it = { g, o, i: 0, key: `${g.id}:0` };
    pressMenu(c, (e) => tileMenu(e, it, () => [it]));
    return draggable(c, { generation: g.id, index: 0 });
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
    const up = () => {   // (also when the system takes the pointer: pointercancel, lostpointercapture)
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.removeEventListener(t, up);
      grip.removeEventListener('pointermove', mv);
      store.set('deck.shelf.w', SH.w);
    };
    grip.addEventListener('pointermove', mv);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(t, up);
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
