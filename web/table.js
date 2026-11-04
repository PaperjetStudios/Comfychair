// The table: one surface where the project's images, videos, sounds, 3D scenes and notes sit as frames, to move, size
// and open in place. Each frame owns a saved document of its kind (table-frames.js); the table itself is a document
// of kind `tables` (app/store.py), listed on the document bar like any other.
//
// The view: the wheel (or a trackpad pinch) zooms about the pointer, two fingers pan and pinch, Space + drag or the
// middle button pans. A drag on empty space draws a box: over frames it selects them, over nothing it asks what kind
// of frame to make there. A frame goes live (Enter, a double-click, Open): the table puts it at 1:1 and a frame-kind
// module mounts its engine in it (the `table:live` event); Esc or a tap beside it brings the table back.
//
// Events for the frame-kind modules (on window, detail.handled = true when taken):
//   table:live       { frame, root, table }   mount the frame's engine in root (live.js has the gate)
//   table:unlive     { frame, root }          save and let go; root is removed after
//   table:drop-frame { from: [frame], onto: frame, table }   a frame held over another and let go there
import { $, h, api, store, toast, undoToast, openSheet, closeSheet, button, field, section, sheetOpen, actions, icon, hint, toggle, help } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { TabSet } from './tabs.js';
import { currentTab } from './navigation.js';
import { ownsKey } from './key-focus.js';
import { openPressMenu, pressMenu, closePressMenu } from './press-menu.js';
import { gzChip, snap as snapPrefs, snapBar } from './gizmo.js';
import { fullScreen } from './layout.js';
import { droppedFiles, draggingPicture } from './drop-files.js';
import { isLive, liveFrame, liveRoot, setLive } from './live.js';
import * as M from './table-model.js';
import { KIND_ICON, copyDoc, createDoc, frameEl, frameFor, kindOfDoc, loadStills, restoreDoc, syncFrame, trashDoc } from './table-frames.js';

const ZMIN = 0.02, ZMAX = 8, DRAG_PX = 4, SNAP_PX = 8, DWELL_MS = 600, NUDGE = 1;
const SOURCE_TYPE = 'application/x-deck-source';   // an in-app drag's payload: JSON { generation, index } | { input } | { media }
const NEW_KINDS = ['image', 'video', 'scene', 'sound', 'note'];

let T = M.blankTable();   // the open table
const U = { sel: new Set(), els: new Map(), wired: false, lastTap: null, tabs: null, mode: null, retryAt: 0, op: null, pts: new Map(), space: false, panelSig: '' };
const D = {};             // its elements

// ---------------------------------------------------------------------------
// saving: a `tables` document through TabSet, or this device's storage until the server knows the kind
// ---------------------------------------------------------------------------
const localKey = () => `deck.tables.${S.project ?? 'none'}`;
const adapter = {
  empty: M.blankTable,
  migrate: M.migrateTable,
  dump: () => T,
  load(p) { unlive(); T = M.migrateTable(p); U.sel.clear(); D.syncBar?.(); renderAll(); refreshStills(); },
};
// Can the server keep tables yet? (app/store.py answers 400 for a kind it doesn't know.) Once it can, the table moves
// there: TabSet seeds its first document with the one kept here.
async function serverTakesTables() {
  try { await api(`/api/store/tables${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false }); return true; } catch { return false; }
}
async function startStore() {
  if (U.mode === 'server') return U.tabs.start();
  if (await serverTakesTables()) {
    U.mode = 'server';
    let seeded = false;
    U.tabs ||= new TabSet({ kind: 'tables', host: D.tab, newName: (n) => `Table ${n}`, adapter,
      seed: () => { seeded = true; return store.get(localKey(), null) || T; } });
    await U.tabs.start();
    if (seeded) store.set(localKey(), null);
    return;
  }
  U.mode = 'local';
  adapter.load(store.get(localKey(), null) || M.blankTable());
}
function changed() {
  if (U.mode === 'server') return U.tabs.changed();
  store.set(localKey(), T);
  if (Date.now() > U.retryAt) { U.retryAt = Date.now() + 15000; serverTakesTables().then((ok) => { if (ok && U.mode === 'local') startStore(); }); }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
function stageSize() { return { w: D.stage.clientWidth, h: D.stage.clientHeight }; }
function applyView() {
  const { x, y, z } = T.view;
  D.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  D.stage.style.setProperty('--z', z);
  // the grid is the stage's background, so it never runs out; a step too fine to see is drawn coarser
  let s = T.grid.size * z;
  while (s < 10) s *= 4;
  D.stage.classList.toggle('grid-on', !!T.grid.on);
  D.stage.style.backgroundSize = `${s}px ${s}px`;
  D.stage.style.backgroundPosition = `${x}px ${y}px`;
  D.zoom.textContent = `${Math.round(z * 100)}%`;
}
function setView(v, { animate = false, save = true } = {}) {
  T.view = { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: v.z };
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    D.world.classList.add('table-anim');
    clearTimeout(U.animT); U.animT = setTimeout(() => D.world.classList.remove('table-anim'), 300);
  }
  applyView();
  if (save) changed();
}
const byId = (id) => T.frames.find((f) => f.id === id) || null;
const selected = () => T.frames.filter((f) => U.sel.has(f.id));

// The frames' elements follow the list (its order is the stacking order); each is made once and kept
function renderFrames() {
  const seen = new Set(), live = liveFrame();
  T.frames.forEach((f, i) => {
    let el = U.els.get(f.id);
    if (!el) { el = frameEl(f, { onText: (t) => { f.text = t; changed(); } }); U.els.set(f.id, el); }
    if (D.frames.children[i] !== el) D.frames.insertBefore(el, D.frames.children[i] || null);
    syncFrame(el, f, { selected: U.sel.has(f.id), live: live?.id === f.id });
    seen.add(f.id);
  });
  for (const [id, el] of U.els) if (!seen.has(id)) { el.remove(); U.els.delete(id); }
  renderHandles();
  renderPanel();
}
function renderAll() { applyView(); renderFrames(); }

// eight handles on the one selected frame (none while live or locked); their size holds against the zoom (app.css)
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function renderHandles() {
  D.handles.replaceChildren();
  const s = selected();
  if (s.length !== 1 || s[0].locked || isLive()) return;
  const f = s[0];
  for (const hd of HANDLES) {
    const x = f.x + (hd.includes('w') ? 0 : hd.includes('e') ? f.w : f.w / 2), y = f.y + (hd.includes('n') ? 0 : hd.includes('s') ? f.h : f.h / 2);
    D.handles.append(h('div', { class: `frame-handle h-${hd}`, 'data-handle': hd, style: `left:${x}px;top:${y}px` }));
  }
}
function showGuides(guides = []) {
  D.guides.replaceChildren(...guides.map((g) => h('div', { class: `table-guide ${g.x != null ? 'gx' : 'gy'}`,
    style: g.x != null ? `left:${g.x}px` : `top:${g.y}px` })));
}

// the stills come from each document kind's list; a frame's document saving elsewhere sends a `store` message
let stillT = 0;
async function refreshStills(kinds = [...new Set(T.frames.map((f) => f.kind))]) {
  await loadStills(kinds);
  renderFrames();
}

// ---------------------------------------------------------------------------
// frames: making, opening, deleting
// ---------------------------------------------------------------------------
const nextLabel = (kind) => `${M.KIND_LABEL[kind]} ${T.frames.filter((f) => f.kind === kind).length + 1}`;
// A frame of a kind over rect, with its document made first (from payload, else the kind's empty one)
async function makeFrame(kind, rect, { payload, frame } = {}) {
  const f = frame || M.newFrame(kind, rect, { label: nextLabel(kind) });
  if (kind !== 'note') {
    try { f.doc = await createDoc(f, payload); } catch (e) { toast(`Couldn't make the frame: ${e.message}`, true); return null; }
  }
  T.frames.push(f);
  U.sel = new Set([f.id]);
  renderFrames(); changed();
  return f;
}
// a frame of 1 MP, square, in the middle of the view (a sound frame is a strip)
function newAtCentre(kind) {
  const { w, h } = stageSize(), c = M.toTable(T.view, w / 2, h / 2);
  const s = kind === 'sound' ? { w: 1024, h: 256 } : kind === 'note' ? { w: 480, h: 320 } : M.sizeForMp(1, 1, 1);
  return makeFrame(kind, { x: c.x - s.w / 2, y: c.y - s.h / 2, ...s });
}
function kindMenu(x, y, make, label = 'New frame') {
  openPressMenu(x, y, [NEW_KINDS.map((k) => ({ label: M.KIND_LABEL[k], run: () => make(k) }))], label);
}

// Live: the table moves so the frame is at 1:1 in the middle, the others dim, and the frame's module mounts in it
export function goLive(f) {
  if (!f) return;
  if (f.kind === 'note') { U.els.get(f.id)?.querySelector('textarea')?.focus(); return; }
  if (liveFrame()?.id === f.id) return;
  unlive();
  U.sel = new Set([f.id]);
  const { w, h: hh } = stageSize();
  setView(M.liveView(f, w, hh), { animate: true });
  const root = h('div', { class: 'frame-mount' });
  U.els.get(f.id)?.querySelector('.frame-body').append(root);
  D.stage.classList.add('table-live');
  setLive(f, root);
  renderFrames();
  dispatchEvent(new CustomEvent('table:live', { detail: { frame: f, root, table: T, handled: false } }));
}
export function unlive() {
  const f = liveFrame();
  if (!f) return;
  const root = liveRoot();
  dispatchEvent(new CustomEvent('table:unlive', { detail: { frame: f, root } }));
  setLive(null);
  root?.remove();
  D.stage?.classList.remove('table-live');
  renderFrames();
  refreshStills([f.kind]);   // (its still may have changed while it was open)
}

// Delete: the frames go, their documents to the server's trash; Undo brings both back. A locked frame stays.
async function deleteFrames(ids) {
  const gone = T.frames.filter((f) => ids.has(f.id) && !f.locked);
  if (!gone.length) return;
  if (gone.some((f) => f.id === liveFrame()?.id)) unlive();
  const at = new Map(gone.map((f) => [f.id, T.frames.indexOf(f)]));
  T.frames = T.frames.filter((f) => !gone.includes(f));
  U.sel.clear(); renderFrames(); changed();
  try { await Promise.all(gone.map(trashDoc)); } catch (e) { toast(`Couldn't delete a frame's document: ${e.message}`, true); }
  undoToast(gone.length === 1 ? `Deleted "${gone[0].label}"` : `Deleted ${gone.length} frames`, async () => {
    try { await Promise.all(gone.map(restoreDoc)); } catch (e) { toast(e.message, true); }
    for (const f of gone) T.frames.splice(Math.min(at.get(f.id), T.frames.length), 0, f);
    U.sel = new Set(gone.map((f) => f.id)); renderFrames(); changed();
  });
}
// Duplicate: each copy beside its original, with a copy of its document
async function duplicateFrames(ids) {
  const made = [];
  for (const f of T.frames.filter((x) => ids.has(x.id))) {
    const g = { ...structuredClone(f), id: M.newFrame(f.kind, f).id, label: `${f.label} copy`, locked: false };
    Object.assign(g, M.nextBeside([...T.frames, ...made], f.kind, { w: f.w, h: f.h }));
    try { g.doc = f.doc ? await copyDoc(f, g.label) : null; } catch (e) { toast(`Couldn't copy "${f.label}": ${e.message}`, true); continue; }
    made.push(g);
  }
  if (!made.length) return;
  T.frames.push(...made);
  U.sel = new Set(made.map((f) => f.id)); renderFrames(); changed();
}
function setLocked(list, on) { for (const f of list) f.locked = on; renderFrames(); changed(); }
function restack(fn) { T.frames = fn(T.frames, [...U.sel]); renderFrames(); changed(); }
function fit(list = T.frames) {
  const { w, h: hh } = stageSize();
  setView(M.fitView(M.boundsOf(list), w, hh, 48, { min: ZMIN, max: 1 }), { animate: true });
}
// a frame brought into view at the zoom there is now (from the panel's list)
function reveal(f) {
  const { w, h: hh } = stageSize(), z = T.view.z;
  setView({ x: w / 2 - (f.x + f.w / 2) * z, y: hh / 2 - (f.y + f.h / 2) * z, z }, { animate: true });
}

// ---------------------------------------------------------------------------
// Size and MP: a frame's canvas size, typed, or from megapixels at the same shape
// ---------------------------------------------------------------------------
function sizeSheet(f) {
  let w = f.w, hh = f.h, keep = true;
  const ar = () => f.w / f.h;
  const num = (v, step, label) => h('input', { type: 'number', inputMode: 'decimal', min: step === 16 ? 16 : 0.01, step, value: v, 'aria-label': label });
  const wIn = num(w, 16, 'Width'), hIn = num(hh, 16, 'Height'), mpIn = num(M.mpOf(w, hh).toFixed(2), 0.05, 'Megapixels');
  const show = () => { wIn.value = w; hIn.value = hh; mpIn.value = M.mpOf(w, hh).toFixed(2); };
  wIn.addEventListener('change', () => { w = Math.max(16, Math.round(+wIn.value || w)); if (keep) hh = Math.max(16, Math.round(w / ar())); show(); });
  hIn.addEventListener('change', () => { hh = Math.max(16, Math.round(+hIn.value || hh)); if (keep) w = Math.max(16, Math.round(hh * ar())); show(); });
  mpIn.addEventListener('change', () => { ({ w, h: hh } = M.sizeForMp(w, hh, Math.max(0.01, +mpIn.value || 1))); show(); });
  openSheet(h('h3', {}, `Size · ${f.label}`),
    help('The frame\'s size is its canvas size. The image, video or 3D document takes it the next time the frame is opened. Megapixels keep the shape and round each side to 16.'),
    h('div', { class: 'grid-2' }, field('Width', wIn), field('Height', hIn)), field('Megapixels', mpIn),
    toggle('Keep the shape', keep, (on) => { keep = on; }),
    actions(button('Apply', () => { closeSheet(); Object.assign(f, { w, h: hh }); renderFrames(); changed(); }, { cls: 'small primary' }),
      button('Cancel', closeSheet, { cls: 'small ghost' })));
}

// ---------------------------------------------------------------------------
// the frame menu (right click, long hold)
// ---------------------------------------------------------------------------
function frameMenu(x, y, f) {
  if (!U.sel.has(f.id)) U.sel = new Set([f.id]);
  renderFrames();
  const list = selected(), one = list.length === 1, locked = list.every((s) => s.locked);
  openPressMenu(x, y, [
    [{ label: 'Open', keys: 'Enter', disabled: !one, run: () => goLive(f) }],
    [{ label: 'Duplicate', keys: 'Ctrl+D', run: () => duplicateFrames(new Set(U.sel)) },
      { label: 'Size and MP…', disabled: !one, run: () => sizeSheet(f) },
      { label: locked ? 'Unlock' : 'Lock', run: () => setLocked(list, !locked) }],
    [{ label: 'Bring to front', run: () => restack(M.toFront) }, { label: 'Send to back', run: () => restack(M.toBack) }],
    [{ label: one ? 'Delete' : `Delete ${list.length}`, keys: 'Del', danger: true, disabled: locked, run: () => deleteFrames(new Set(U.sel)) }],
  ], 'Frame');
}
function stageMenu(e) {
  cancelOp();
  if (isLive()) return;
  const f = frameAt(e);
  if (f) return frameMenu(e.clientX, e.clientY, f);
  const r = D.stage.getBoundingClientRect(), p = M.toTable(T.view, e.clientX - r.left, e.clientY - r.top);
  const at = (k) => (k === 'sound' ? { w: 1024, h: 256 } : k === 'note' ? { w: 480, h: 320 } : M.sizeForMp(1, 1, 1));
  kindMenu(e.clientX, e.clientY, (k) => makeFrame(k, { ...p, ...at(k) }), 'New frame here');
}

// ---------------------------------------------------------------------------
// pointer: pan, pinch, marquee, move, resize
// ---------------------------------------------------------------------------
const local = (e) => { const r = D.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const tablePt = (e) => { const p = local(e); return M.toTable(T.view, p.x, p.y); };
function frameAt(e) {
  const el = e.target.closest?.('.frame');
  return el ? byId(el.dataset.id) : null;
}
const inLive = (e) => !!e.target.closest?.('.frame.live .frame-body');
const othersOf = (ids) => T.frames.filter((f) => !ids.has(f.id));
const snapThr = () => SNAP_PX / T.view.z;

function onDown(e) {
  if (inLive(e) || e.target.closest('.max-btn, .pull-tab, textarea')) return;
  if (e.pointerType === 'touch') {
    U.pts.set(e.pointerId, local(e));
    if (U.pts.size === 2) { cancelOp(); U.op = { type: 'pinch', last: [...U.pts.values()] }; return; }
    if (U.pts.size > 2) return;
  }
  if (e.button === 2) return;   // (the menu comes with contextmenu)
  e.preventDefault();
  try { D.stage.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  const base = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
  const handle = e.target.closest('.frame-handle'), f = frameAt(e);
  if (e.button === 1 || (e.button === 0 && U.space) || isLive()) U.op = { ...base, type: 'pan', v0: { ...T.view } };
  else if (handle) {
    const r = byId([...U.sel][0]);
    U.op = { ...base, type: 'resize', f: r, start: { ...r }, handle: handle.dataset.handle };
  } else if (f) startMove(e, f, base);
  else U.op = { ...base, type: 'marquee', p0: tablePt(e), base: e.shiftKey ? new Set(U.sel) : new Set(), shift: e.shiftKey };
}
function startMove(e, f, base) {
  // a second tap on the same frame opens it (a dblclick would land on the stage, which holds the pointer)
  if (!e.shiftKey && U.lastTap?.id === f.id && Date.now() - U.lastTap.t < 400) { U.lastTap = null; U.op = null; goLive(f); return; }
  if (e.shiftKey) {
    if (U.sel.has(f.id)) { U.sel.delete(f.id); renderFrames(); return; }
    U.sel.add(f.id);
  } else if (!U.sel.has(f.id)) U.sel = new Set([f.id]);
  renderFrames();
  const ids = new Set(selected().filter((s) => !s.locked).map((s) => s.id));
  U.op = { ...base, type: 'move', ids, tap: f, start: new Map(T.frames.filter((s) => ids.has(s.id)).map((s) => [s.id, { x: s.x, y: s.y }])), p0: tablePt(e) };
}

function onMove(e) {
  if (U.pts.has(e.pointerId)) U.pts.set(e.pointerId, local(e));
  const op = U.op;
  if (op?.type === 'pinch') return pinch();
  if (!op || e.pointerId !== op.id) return;
  if (!op.moved && Math.hypot(e.clientX - op.x0, e.clientY - op.y0) < DRAG_PX) return;
  op.moved = true;
  if (op.type === 'pan') setView({ ...op.v0, x: op.v0.x + e.clientX - op.x0, y: op.v0.y + e.clientY - op.y0 }, { save: false });
  else if (op.type === 'move') dragMove(e, op);
  else if (op.type === 'resize') dragResize(e, op);
  else if (op.type === 'marquee') dragMarquee(e, op);
}
function dragMove(e, op) {
  const p = tablePt(e), dx = p.x - op.p0.x, dy = p.y - op.p0.y;
  const moving = [...op.start].map(([id, s]) => ({ ...byId(id), x: s.x + dx, y: s.y + dy }));
  let sx = 0, sy = 0, guides = [];
  if (moving.length && !e.altKey) {
    const b = M.boundsOf(moving), s = M.snapRect(b, othersOf(op.ids), T.grid, snapThr(), { edges: snapPrefs.edges });
    sx = s.x - b.x; sy = s.y - b.y; guides = s.guides;
  }
  for (const [id, s] of op.start) Object.assign(byId(id), { x: Math.round(s.x + dx + sx), y: Math.round(s.y + dy + sy) });
  showGuides(guides);
  dwell(op, p);
  renderFrames();
}
// held over another frame for a moment: let go there and the frames go onto it (table:drop-frame)
function dwell(op, p) {
  const under = M.hitFrame(othersOf(op.ids), p);
  if (under?.id !== op.over?.id) {
    clearTimeout(op.dwellT); U.els.get(op.over?.id)?.classList.remove('drop-onto');
    op.over = under; op.onto = null;
    if (under) op.dwellT = setTimeout(() => { op.onto = under; U.els.get(under.id)?.classList.add('drop-onto'); }, DWELL_MS);
  }
}
function dragResize(e, op) {
  const others = othersOf(new Set([op.f.id]));
  const snapFn = e.altKey ? null : (axis, v) => M.snapValue(v, axis, others, T.grid, snapThr(), { edges: snapPrefs.edges });
  const dx = (e.clientX - op.x0) / T.view.z, dy = (e.clientY - op.y0) / T.view.z;
  Object.assign(op.f, M.resizeFrame(op.start, op.handle, dx, dy, { keepAspect: e.shiftKey, snap: snapFn }));
  renderFrames();
}
function dragMarquee(e, op) {
  const r = M.rectFrom(op.p0, tablePt(e));
  op.rect = r;
  Object.assign(D.marquee.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const hit = M.framesIn(T.frames, r);
  U.sel = new Set([...op.base, ...hit.map((f) => f.id)]);
  renderFrames();
}
function pinch() {
  const cur = [...U.pts.values()], last = U.op.last;
  if (cur.length !== 2 || last.length !== 2) return;
  const mid = (a) => ({ x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }), d = (a) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  const m = mid(cur), lm = mid(last);
  let v = { ...T.view, x: T.view.x + m.x - lm.x, y: T.view.y + m.y - lm.y };
  if (!isLive()) v = M.zoomAt(v, m.x, m.y, d(cur) / Math.max(1, d(last)), ZMIN, ZMAX);
  setView(v, { save: false });
  U.op.last = cur;
}

function onUp(e) {
  const wasPinch = U.op?.type === 'pinch';
  U.pts.delete(e.pointerId);
  if (wasPinch) { if (U.pts.size < 2) { U.op = null; changed(); } return; }
  const op = U.op;
  if (!op || e.pointerId !== op.id) return;
  U.op = null;
  showGuides(); D.marquee.style.display = 'none';
  if (e.type === 'pointercancel') return cancelOp(op);
  if (op.type === 'pan') { if (op.moved) changed(); else if (isLive()) unlive(); return; }
  if (op.type === 'move') return endMove(e, op);
  if (op.type === 'resize') { if (op.moved) changed(); return; }
  if (op.type === 'marquee') endMarquee(e, op);
}
function endMove(e, op) {
  clearTimeout(op.dwellT);
  if (op.onto) {
    U.els.get(op.onto.id)?.classList.remove('drop-onto');
    const from = [...op.ids].map(byId);
    for (const [id, s] of op.start) Object.assign(byId(id), s);   // they go back: what happens to them is the module's
    renderFrames();
    const detail = { from, onto: op.onto, table: T, handled: false };
    dispatchEvent(new CustomEvent('table:drop-frame', { detail }));
    if (!detail.handled) toast('Not yet: frames can\'t go into other frames yet');
    return;
  }
  if (op.moved) return changed();
  U.lastTap = { id: op.tap.id, t: Date.now() };
  if (!e.shiftKey && U.sel.size > 1) { U.sel = new Set([op.tap.id]); renderFrames(); }   // a tap in a selection picks that one
}
function endMarquee(e, op) {
  if (!op.moved) { U.sel = op.shift ? U.sel : new Set(); renderFrames(); return; }
  if (op.shift || M.framesIn(T.frames, op.rect).length) return;
  // a box over nothing: a frame that size, of the kind picked (its corners on the grid when that's on)
  const g = (v, a) => M.snapValue(v, a, [], T.grid, 0, { edges: false });
  const r = op.rect, x = g(r.x, 'x'), y = g(r.y, 'y');
  const rect = { x, y, w: Math.max(M.MIN_SIDE, g(r.x + r.w, 'x') - x), h: Math.max(M.MIN_SIDE, g(r.y + r.h, 'y') - y) };
  kindMenu(e.clientX, e.clientY, (k) => makeFrame(k, rect));
}
// a gesture given up (a second finger, the menu, a cancelled pointer): whatever it moved goes back
function cancelOp(op = U.op) {
  U.op = null;
  showGuides(); if (D.marquee) D.marquee.style.display = 'none';
  if (!op) return;
  clearTimeout(op.dwellT);
  if (op.type === 'move') for (const [id, s] of op.start) Object.assign(byId(id) || {}, s);
  if (op.type === 'resize') Object.assign(op.f, op.start);
  renderFrames();
}

function onWheel(e) {
  if (inLive(e)) return;
  e.preventDefault();
  const p = local(e);
  if (isLive()) return setView({ ...T.view, x: T.view.x - e.deltaX, y: T.view.y - e.deltaY });   // live stays at 1:1
  const k = e.ctrlKey ? 0.01 : 0.0025;   // (a trackpad pinch comes as the wheel with Ctrl, in small steps)
  let v = M.zoomAt(T.view, p.x, p.y, Math.exp(-e.deltaY * k), ZMIN, ZMAX);
  if (e.deltaX && !e.ctrlKey) v = { ...v, x: v.x - e.deltaX };
  setView(v);
}

// ---------------------------------------------------------------------------
// keys (only on the table, with nothing typed in and no sheet open; a live frame's engine has its own)
// ---------------------------------------------------------------------------
const onTable = () => currentTab() === 'table' && !sheetOpen();
function onKey(e) {
  if (!onTable() || e.defaultPrevented || ownsKey(e)) return;
  if (e.code === 'Space' && !isLive()) { U.space = true; D.stage.classList.add('panning'); e.preventDefault(); return; }
  if (isLive() || e.altKey) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key;
  const step = e.shiftKey ? NUDGE * 10 : NUDGE;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  let fn = null;
  if (k === 'Delete' || k === 'Backspace') fn = () => deleteFrames(new Set(U.sel));
  else if (arrows[k] && U.sel.size) fn = () => { T.frames = M.moveFrames(T.frames, [...U.sel], ...arrows[k]); renderFrames(); changed(); };
  else if (ctrl && k.toLowerCase() === 'd') fn = () => duplicateFrames(new Set(U.sel));
  else if (ctrl && k.toLowerCase() === 'a') fn = () => { U.sel = new Set(T.frames.map((f) => f.id)); renderFrames(); };
  else if (!ctrl && k.toLowerCase() === 'f') fn = () => fit(U.sel.size ? selected() : T.frames);
  else if (!ctrl && k === '0') fn = () => zoomTo(1);
  else if (!ctrl && k === 'Enter' && U.sel.size === 1) fn = () => goLive(selected()[0]);
  if (!fn) return;
  e.preventDefault(); fn();
}
// Esc (on window: after the engines' own Esc, which marks it handled when it used it)
function onEsc(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !onTable() || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (isLive()) { e.preventDefault(); unlive(); }
  else if (U.sel.size) { U.sel.clear(); renderFrames(); }
}
function zoomTo(z) {
  const { w, h: hh } = stageSize();
  setView(M.zoomAt(T.view, w / 2, hh / 2, z / T.view.z, ZMIN, ZMAX), { animate: true });
}

// ---------------------------------------------------------------------------
// drops: files from the computer, and things dragged from elsewhere in the app (SOURCE_TYPE)
// ---------------------------------------------------------------------------
const wantDrop = (e) => !isLive() && ([...(e.dataTransfer?.types || [])].includes(SOURCE_TYPE) || draggingPicture(e.dataTransfer));
async function onDrop(e) {
  if (!wantDrop(e)) return;
  e.preventDefault();   // (picture-drop.js leaves a drop already taken)
  const raw = e.dataTransfer.getData(SOURCE_TYPE);
  const got = raw ? null : droppedFiles(e.dataTransfer);   // (read during the event: the browser empties it after)
  let list;
  try { list = raw ? [JSON.parse(raw)].flat() : await got; } catch (err) { return toast(err.message, true); }
  await dropOnTable(list, e.clientX, e.clientY);
}
// Things dropped at a screen point become frames there, side by side. src: see table-frames.js frameFor.
export async function dropOnTable(list, clientX, clientY) {
  const r = D.stage.getBoundingClientRect();
  let at = M.toTable(T.view, clientX - r.left, clientY - r.top), made = 0;
  for (const src of [list].flat()) {
    let got;
    try { got = await frameFor(src, at); } catch (err) { toast(err.message, true); continue; }
    if (!got) { toast('That can\'t go on the table', true); continue; }
    got.frame.label = got.frame.label || nextLabel(got.frame.kind);
    if (await makeFrame(got.frame.kind, got.frame, got)) { made++; at = { x: got.frame.x + got.frame.w + 40, y: got.frame.y }; }
  }
  if (made > 1) toast(`Added ${made} frames`);
}

// ---------------------------------------------------------------------------
// the panel (for now: the frames, and the selected one's label, size and lock; a tabbed sidebar replaces it)
// ---------------------------------------------------------------------------
function renderPanel() {
  const s = selected(), one = s.length === 1 ? s[0] : null;
  const sig = JSON.stringify([[...U.sel], T.frames.map((f) => [f.id, f.label, f.w, f.h, f.locked])]);
  if (sig === U.panelSig || D.panel.contains(document.activeElement) && document.activeElement.matches('input')) return;
  U.panelSig = sig;
  const row = (f) => h('button', { type: 'button', class: `table-row${U.sel.has(f.id) ? ' on' : ''}`, 'aria-pressed': String(U.sel.has(f.id)),
    onclick: () => { U.sel = new Set([f.id]); renderFrames(); reveal(f); }, ondblclick: () => goLive(f) },
  icon(KIND_ICON[f.kind]), h('span', { class: 'table-row-name' }, f.label), h('span', { class: 'table-row-size' }, `${f.w}×${f.h}`), f.locked ? icon('lock') : null);
  D.panel.replaceChildren(
    section('Frames', null, help('Drag on empty table to make a frame there. Double-click a frame, or press Enter, to open it at full size; Esc comes back. Wheel zooms, Space + drag pans, F fits.'),
      T.frames.length ? h('div', { class: 'table-rows' }, [...T.frames].reverse().map(row)) : hint('No frames yet.')),
    section('Frame', null, one ? frameFields(one) : hint(s.length ? `${s.length} frames selected` : 'Select a frame.')));
}
function frameFields(f) {
  const name = h('input', { type: 'text', value: f.label, maxLength: 120, 'aria-label': 'Label' });
  name.addEventListener('input', () => { f.label = name.value; syncFrame(U.els.get(f.id), f, { selected: true, live: liveFrame()?.id === f.id }); });
  name.addEventListener('change', () => { f.label = name.value.trim() || M.KIND_LABEL[f.kind]; U.panelSig = ''; renderFrames(); changed(); });
  return [field('Label', name),
    field('Size', h('div', { class: 'row wrap' }, h('span', { class: 'table-size' }, `${f.w}×${f.h} · ${M.mpOf(f.w, f.h).toFixed(2)} MP`),
      button('Size and MP…', () => sizeSheet(f)))),
    toggle('Locked', !!f.locked, (on) => setLocked([f], on)),
    h('div', { class: 'row wrap' }, f.kind !== 'note' ? button('Open', () => goLive(f), { cls: 'small primary' }) : null,
      button('Duplicate', () => duplicateFrames(new Set([f.id]))),
      button('Delete', () => deleteFrames(new Set([f.id])), { cls: 'small ghost danger', disabled: !!f.locked }))];
}

// ---------------------------------------------------------------------------
// the bar over the table: fit, 100%, the grid and snapping, a new frame, the zoom
// ---------------------------------------------------------------------------
function buildBar() {
  const gridChip = gzChip('▦ Grid', () => { T.grid.on = !T.grid.on; gridChip.classList.toggle('on', T.grid.on); applyView(); changed(); },
    { on: T.grid.on, title: 'Snap frames to the grid' });
  const gridSize = h('select', { 'aria-label': 'Grid size', onchange: () => { T.grid.size = +gridSize.value; applyView(); changed(); } },
    [16, 32, 64, 128, 256].map((v) => h('option', { value: v }, `${v} px`)));
  D.syncBar = () => { gridChip.classList.toggle('on', !!T.grid.on); gridSize.value = String(T.grid.size); };
  const newBtn = button('＋ New frame ▾', (e) => { const r = newBtn.getBoundingClientRect(); kindMenu(r.left, r.bottom + 4, newAtCentre); });
  D.zoom = h('button', { type: 'button', class: 'btn small ghost table-zoom', title: 'Zoom: tap for 100%', onclick: () => zoomTo(1) }, '100%');
  D.bar = h('div', { class: 'table-bar' },
    button('Fit', () => fit(U.sel.size ? selected() : T.frames), { title: 'Fit all, or the selected frames (F)' }),
    button('100%', () => zoomTo(1), { title: 'Zoom to 100% (0)' }),
    gridChip, gridSize, snapBar(['edges'], () => {}), newBtn, h('span', { class: 'table-bar-gap' }), D.zoom);
}

// ---------------------------------------------------------------------------
// wiring (once) and showing
// ---------------------------------------------------------------------------
function wire() {
  U.wired = true;
  D.tab = $('#tab-table'); D.panel = $('#tablePanel');
  D.stage = D.tab.querySelector('.table-stage');
  D.frames = h('div', { class: 'table-frames' });
  D.handles = h('div', { class: 'table-handles' });
  D.guides = h('div', { class: 'table-guides' });
  D.marquee = h('div', { class: 'table-marquee' });
  D.world = h('div', { class: 'table-world' }, D.frames, D.guides, D.marquee, D.handles);
  D.stage.append(D.world);
  buildBar();
  D.tab.querySelector('.stage').prepend(D.bar);
  fullScreen(D.tab, { viewer: D.stage, title: 'Full screen table' });
  D.stage.addEventListener('pointerdown', onDown);
  D.stage.addEventListener('pointermove', onMove);
  D.stage.addEventListener('pointerup', onUp);
  D.stage.addEventListener('pointercancel', onUp);
  D.stage.addEventListener('wheel', onWheel, { passive: false });
  D.stage.addEventListener('dragover', (e) => { if (wantDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  D.stage.addEventListener('drop', onDrop);
  pressMenu(D.stage, stageMenu, { ok: (e) => !isLive() && !e.target.closest?.('.max-btn, .pull-tab') });
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') { U.space = false; D.stage.classList.remove('panning'); } });
  addEventListener('keydown', onEsc);
  new ResizeObserver(() => { const f = liveFrame(); if (f) { const { w, h: hh } = stageSize(); setView(M.liveView(f, w, hh), { save: false }); } }).observe(D.stage);
  onServer('store', (m) => {
    const kind = kindOfDoc(m.kind);
    if (!kind || !T.frames.some((f) => f.kind === kind && f.doc === m.id)) return;
    clearTimeout(stillT); stillT = setTimeout(() => refreshStills([kind]), 300);
  });
  onProject(() => { unlive(); if (U.mode === 'local' || !U.mode) startStore(); });
}

// The Table screen comes on: wire it the first time, load the table, and show it. Coming back to it while a frame is
// live brings the table back (the screen's own button is "the whole table").
export async function renderTable() {
  if (!U.wired) {
    wire();
    await startStore().catch((e) => toast(`Couldn't load the table: ${e.message}`, true));
    return;
  }
  unlive();
  applyView(); D.syncBar?.(); renderFrames();
}
// another screen came on: let go of the live frame and any gesture
export function pauseTable() {
  if (!U.wired) return;
  cancelOp(); closePressMenu(); unlive();
  U.space = false;
}
