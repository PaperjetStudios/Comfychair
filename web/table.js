// The table: one surface where the project's images, videos, sounds, 3D scenes and notes sit as frames, to move, size
// and open in place. Each frame owns a saved document of its kind (table-frames.js); the table itself is a document
// of kind `tables` (app/store.py). The project's tables are the top tabs (table-nav.js), not a strip on the document bar.
//
// The view: the wheel (or a trackpad pinch) zooms about the pointer, two fingers pan and pinch, Space + drag or the
// middle button pans. A drag on empty space draws a box: over frames it selects them, over nothing it asks what kind
// of frame to make there. A frame goes live (Enter, a double-click, Open): its mount root sits in .live-layer over the
// stage (not in the zoomed .table-world, so it is at 1:1 and a fixed full screen inside it works), filling the stage
// less a margin, with the table behind it dimmed and fitted to the frame; a frame-kind module mounts its engine in the
// root (the `table:live` event) and fits its picture inside. Esc or a tap beside it brings the table back.
// Moves, resizes and deletes undo (Ctrl+Z, the top bar's ↶) while nothing is live.
//
// Events for the frame-kind modules (on window, detail.handled = true when taken):
//   table:live       { frame, root, table }   mount the frame's engine in root (live.js has the gate)
//   table:unlive     { frame, root, wait: [] } save and let go; root is removed after. A module that saves after this
//                    pushes that promise into wait: the table waits for them before trashing a document (deleting the
//                    frame or its table), so a late save never meets a trashed document
//   table:drop-frame { from: [frame], sources: [src], onto: frame, table }   frames held over another and let go there,
//                    or things dropped on it from the Shelf, a picker or the computer (sources: { generation, index } |
//                    { input } | { media, kind?, url?, label? } | File, as frameFor takes; table-frames.js sourcePicture /
//                    sourceClip turn one into a picture or a clip). Either list may be empty. Not handled: the sources
//                    become frames of their own beside it.
//   table:select     { frames: [frame], table }  the selection changed (sidebar.js follows it)
//   table:resize     { frame, table }            a frame's size was set while it is live (its module applies it)
//   table:move       { frames: [frame], table }  frames were moved by a drag, the arrows (once they stop) or Undo
//   table:open       { table, doc }              a table document was loaded or made (its frames are drawn); doc is the
//                    TabSet's doc ({ id, name, … }). Not fired for the open table saved elsewhere (it is the same table).
//   table:deleted    { frames: [frame] }         frames were deleted (their documents are in the server's trash); a frame
//                    module drops what only the frame itself owned. Undo brings the frames back, not that.
import { $, h, toast, undoToast, openSheet, closeSheet, button, field, section, sheetOpen, actions, icon, hint, toggle, help, mpInput } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { TabSet } from './tabs.js';
import { currentTab } from './navigation.js';
import { ownsKey } from './key-focus.js';
import { openPressMenu, pressMenu, closePressMenu } from './press-menu.js';
import { gzChip, snap as snapPrefs, snapBar } from './gizmo.js';
import { exitMaxedIn, fullScreen } from './layout.js';
import { registerUndo, syncUndo } from './undo-dock.js';
import { onNavigate, switchTab as navigate } from './navigation.js';
import { wireTableNav } from './table-nav.js';
import { droppedFiles, draggingPicture } from './drop-files.js';
import { isLive, liveFrame, liveRoot, setLive } from './live.js';
import * as M from './table-model.js';
import { KIND_ICON, copyDoc, createDoc, editDoc, frameEl, frameFor, kindOfDoc, loadStills, owedCounts, renameDoc, restoreDoc, syncFrame, trashDoc } from './table-frames.js';
import { sidebar } from './sidebar.js';

const ZMIN = 0.02, ZMAX = 8, DRAG_PX = 4, SNAP_PX = 8, DWELL_MS = 600, NUDGE = 1;
const SOURCE_TYPE = 'application/x-deck-source';   // an in-app drag's payload: JSON { generation, index } | { input } | { media }
const NEW_KINDS = ['image', 'video', 'scene', 'sound', 'note'];

let T = M.blankTable();   // the open table
const U = { sel: new Set(), els: new Map(), wired: false, lastTap: null, tabs: null, op: null, pts: new Map(), space: false, panelSig: '',
  before: null /* the view before a frame went live */, nudge: null /* arrows held: { ids, before, t } */,
  loaded: null /* { id, pid } of the table loaded last */, leaving: Promise.resolve() /* the last live frame's saves (table:unlive wait) */ };
const H = { past: [], future: [] };   // undo: [{ undo(), redo() }] for this table's moves, resizes and deletes
const D = {};             // its elements

// ---------------------------------------------------------------------------
// saving: a `tables` document through TabSet
// ---------------------------------------------------------------------------
const adapter = {
  empty: M.blankTable,
  migrate: M.migrateTable,
  dump: () => T,
  load(p, doc) {
    const next = M.migrateTable(p), key = { id: doc?.id ?? null, pid: S.project };
    const same = U.loaded && U.loaded.id === key.id && U.loaded.pid === key.pid;
    U.loaded = key;
    if (same) return reloaded(next);
    unlive(); cancelOp();
    T = next; U.sel.clear(); H.past = []; H.future = []; U.nudge = null;
    U.fitDue = T.view.x === 0 && T.view.y === 0 && T.view.z === 1; U.laid = false;   // (a table never viewed: fit its frames once)
    syncUndo(); D.syncBar?.(); renderAll(); refreshStills();
    fitAll();
    dispatchEvent(new CustomEvent('table:open', { detail: { table: T, doc } }));
  },
};
// The open table saved elsewhere (another device, a story module): its new contents, keeping what is going on here. The
// frames that are still there keep their objects (a live frame's module and a drag hold them), their selection and the
// live one; undo steps stay (they find frames by id).
function reloaded(next) {
  const old = new Map(T.frames.map((f) => [f.id, f]));
  next.frames = next.frames.map((nf) => {
    const f = old.get(nf.id);
    if (!f) return nf;
    for (const k of Object.keys(f)) if (!(k in nf)) delete f[k];
    return Object.assign(f, nf);
  });
  T = next;
  const ids = new Set(T.frames.map((f) => f.id));
  for (const id of [...U.sel]) if (!ids.has(id)) U.sel.delete(id);
  if (liveFrame() && !ids.has(liveFrame().id)) unlive();
  else if (liveFrame()) placeLive();
  if (U.op && [...(U.op.ids || []), U.op.f?.id].some((id) => id && !ids.has(id))) cancelOp();
  U.panelSig = '';
  D.syncBar?.(); renderAll(); refreshStills();
}
function startStore() {
  if (!U.tabs) {
    U.tabs = new TabSet({ kind: 'tables', host: D.tab, newName: (n) => `Table ${n}`, adapter });
    const strip = U.tabs.render.bind(U.tabs);   // (its own strip stays off the bar: the top tabs are drawn from its list)
    U.tabs.render = () => { strip(); D.nav?.render(); };
  }
  return U.tabs.start();
}
const changed = () => U.tabs?.changed();
// The table open now and its project, to check after an await: true while they are still the ones open (a result that
// comes back after the table or project changed is dropped, or goes to its own table)
function here() {
  const id = U.tabs?.active?.id, pid = S.project;
  return () => U.tabs?.active?.id === id && S.project === pid;
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
// for the frame modules and the sidebar: the open table's frames (the objects themselves: change one, then frameChanged)
export const tableFrames = () => T.frames;
export const selectedFrames = () => selected();
export const frameById = (id) => byId(id);
export const activeTableId = () => U.tabs?.active?.id ?? null;
export function frameChanged() { U.panelSig = ''; renderFrames(); changed(); }

// The frames' elements follow the list (its order is the stacking order); each is made once and kept
function renderFrames() {
  const seen = new Set(), live = liveFrame(), owed = owedCounts();
  T.frames.forEach((f, i) => {
    let el = U.els.get(f.id);
    if (!el) { el = frameEl(f, { onText: (t) => { f.text = t; changed(); } }); U.els.set(f.id, el); }
    if (D.frames.children[i] !== el) D.frames.insertBefore(el, D.frames.children[i] || null);
    syncFrame(el, f, { selected: U.sel.has(f.id), live: live?.id === f.id, owed: f.kind === 'image' ? owed.get(f.doc) || 0 : 0 });
    seen.add(f.id);
  });
  for (const [id, el] of U.els) if (!seen.has(id)) { el.remove(); U.els.delete(id); }
  renderHandles();
  renderPanel();
  tellSelection();
}
// table:select, each time the selected frames are other ones than last time
function tellSelection() {
  const sig = [...U.sel].sort().join(',');
  if (sig === U.selSig) return;
  U.selSig = sig;
  dispatchEvent(new CustomEvent('table:select', { detail: { frames: selected(), table: T } }));
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
export async function refreshStills(kinds = [...new Set(T.frames.map((f) => f.kind))]) {
  await loadStills(kinds);
  renderFrames();
}

// ---------------------------------------------------------------------------
// frames: making, opening, deleting
// ---------------------------------------------------------------------------
const nextLabel = (kind) => `${M.KIND_LABEL[kind]} ${T.frames.filter((f) => f.kind === kind).length + 1}`;
// A frame of a kind over rect, with its document made first (from payload, else the kind's empty one)
// ok: here() taken before whatever the caller awaited (default: now)
async function makeFrame(kind, rect, { payload, frame, ok = here() } = {}) {
  const f = frame || M.newFrame(kind, rect, { label: nextLabel(kind) });
  if (kind !== 'note') {
    try { f.doc = await createDoc(f, payload); } catch (e) { toast(`Couldn't make the frame: ${e.message}`, true); return null; }
    if (!ok()) { trashDoc(f).catch(() => {}); return null; }   // (another table opened meanwhile: the document goes too)
  }
  if (!ok()) return null;
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

// Live: the frame's mount root fills the stage less a margin, in .live-layer (unscaled: engines work at 1:1); the
// table behind is fitted to the frame and dimmed; the frame's module mounts its engine in the root and fits it there.
const livePad = () => { const { w, h: hh } = stageSize(); return Math.round(Math.max(8, Math.min(32, Math.min(w, hh) * 0.03))); };
function placeLive({ animate = false } = {}) {
  const f = liveFrame(), root = liveRoot();
  if (!f || !root) return;
  const { w, h: hh } = stageSize(), pad = livePad();
  root.style.inset = `${pad}px`;
  if (w && hh) setView(M.liveBackdrop(f, w, hh, pad, { min: ZMIN, max: ZMAX }), { animate, save: false });
}
export function goLive(f) {
  if (!f) return;
  if (f.kind === 'note') { U.els.get(f.id)?.querySelector('textarea')?.focus(); return; }
  if (liveFrame()?.id === f.id) return;
  unlive();
  cancelOp();
  U.sel = new Set([f.id]);
  U.before = { ...T.view };
  const root = h('div', { class: 'frame-mount', 'data-frame': f.id });
  D.live.append(root);
  if (!setLive(f, root)) { root.remove(); U.before = null; return; }
  D.stage.classList.add('table-live');
  placeLive({ animate: true });
  renderFrames();
  dispatchEvent(new CustomEvent('table:live', { detail: { frame: f, root, table: T, handled: false } }));
}
// Resolves once the frame's module has saved (table:unlive wait); with nothing live, once the last one has
export function unlive() {
  const f = liveFrame();
  if (!f) return U.leaving;
  const root = liveRoot();
  exitMaxedIn(root);   // (a full screen inside it goes first: its stage is about to move)
  const detail = { frame: f, root, wait: [] };
  dispatchEvent(new CustomEvent('table:unlive', { detail }));
  U.leaving = Promise.allSettled([U.leaving, ...detail.wait]).then(() => {});
  setLive(null);
  root?.remove();
  D.stage?.classList.remove('table-live');
  if (U.before) { setView(U.before, { animate: true, save: false }); U.before = null; }
  renderFrames();
  refreshStills([f.kind]);   // (its still may have changed while it was open)
  return U.leaving;
}

// Delete: the frames go, their documents to the server's trash; Undo brings both back. A locked frame stays. A frame
// whose document couldn't be trashed comes back; Undo brings back the ones whose document could be restored, into their
// own table (the one open, or saved to it on the server when another is open by then).
async function deleteFrames(ids) {
  const ok = here(), tid = U.tabs?.active?.id;
  const gone = T.frames.filter((f) => ids.has(f.id) && !f.locked);
  if (!gone.length) return;
  if (gone.some((f) => f.id === liveFrame()?.id)) unlive();
  await U.leaving;   // (a live frame's last save lands before its document is trashed)
  if (!ok()) return;
  const at = new Map(gone.map((f) => [f.id, T.frames.indexOf(f)]));
  const putBack = (list) => {
    for (const f of [...list].sort((a, b) => at.get(a.id) - at.get(b.id))) if (!byId(f.id)) T.frames.splice(Math.min(at.get(f.id), T.frames.length), 0, f);
  };
  let trashed = [];
  const take = async () => {
    const still = here(), drop = new Set(gone.map((f) => f.id));
    T.frames = T.frames.filter((f) => !drop.has(f.id));
    U.sel.clear(); renderFrames(); changed();
    const res = await Promise.allSettled(gone.map(trashDoc));
    trashed = gone.filter((f, i) => res[i].status === 'fulfilled');
    const kept = gone.filter((f, i) => res[i].status === 'rejected');
    if (trashed.length) dispatchEvent(new CustomEvent('table:deleted', { detail: { frames: trashed } }));
    if (kept.length) {
      toast(`Couldn't delete ${kept.length === 1 ? `"${kept[0].label}"` : `${kept.length} frames`}: ${res.find((r) => r.status === 'rejected').reason?.message}`, true);
      if (still()) { putBack(kept); renderFrames(); changed(); }
    }
  };
  const back = async () => {
    const still = here(), list = trashed;
    const res = await Promise.allSettled(list.map(restoreDoc));
    const fine = list.filter((f, i) => res[i].status === 'fulfilled');
    if (fine.length < list.length) toast(`Couldn't bring back ${list.length - fine.length === 1 ? 'a frame' : `${list.length - fine.length} frames`}: ${res.find((r) => r.status === 'rejected').reason?.message}`, true);
    if (!fine.length) return;
    if (still() && U.tabs?.active?.id === tid) {
      putBack(fine);
      U.sel = new Set(fine.map((f) => f.id)); renderFrames(); changed();
      return;
    }
    // another table (or project) is open now: the frames go back into their own table's saved document
    try {
      await editDoc('tables', tid, (p) => {
        p.frames ||= [];
        const have = new Set(p.frames.map((f) => f.id));
        for (const f of fine) if (!have.has(f.id)) p.frames.splice(Math.min(at.get(f.id), p.frames.length), 0, f);
      });
      toast(fine.length === 1 ? `"${fine[0].label}" is back on its table` : `${fine.length} frames are back on their table`);
    } catch (e) { toast(`Couldn't put the frames back on their table: ${e.message}`, true); }
  };
  await take();
  if (!trashed.length) return;
  const entry = { undo: back, redo: take };
  record(entry);
  undoToast(trashed.length === 1 ? `Deleted "${trashed[0].label}"` : `Deleted ${trashed.length} frames`, () => {
    if (H.past.at(-1) === entry && U.tabs?.active?.id === tid) return undo();   // (the same step as Ctrl+Z: it can be redone)
    if (!byId(trashed[0].id)) back();
  });
}

// ---------------------------------------------------------------------------
// undo: steps of this table's own (where frames sit, their sizes, deletes); a document's own edits undo in its engine
// ---------------------------------------------------------------------------
function record(entry) {
  H.past.push(entry);
  if (H.past.length > 200) H.past.shift();
  H.future = [];
  syncUndo();
}
// where frames sit and how big they are, to go back to (only the frames still on the table)
const geomOf = (ids = null) => T.frames.filter((f) => !ids || ids.has(f.id)).map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h }));
const sameGeom = (a, b) => a.length === b.length && a.every((g, i) => ['id', 'x', 'y', 'w', 'h'].every((k) => g[k] === b[i][k]));
function applyGeom(list) {
  const moved = [];
  for (const g of list) {
    const f = byId(g.id);
    if (!f) continue;
    const resized = f.w !== g.w || f.h !== g.h;
    Object.assign(f, g); moved.push(f);
    if (resized && liveFrame()?.id === f.id) { placeLive(); dispatchEvent(new CustomEvent('table:resize', { detail: { frame: f, table: T } })); }
  }
  U.sel = new Set(moved.map((f) => f.id));
  renderFrames(); changed();
  tellMoved(moved);
}
function recordGeom(before, after) {
  if (sameGeom(before, after)) return;
  record({ undo: () => applyGeom(before), redo: () => applyGeom(after) });
}
async function undo() { const e = H.past.pop(); if (!e) return; H.future.push(e); syncUndo(); await e.undo(); syncUndo(); }
async function redo() { const e = H.future.pop(); if (!e) return; H.past.push(e); syncUndo(); await e.redo(); syncUndo(); }
// table:move, for the story table (its shot order follows where the frames are)
function tellMoved(frames) {
  if (frames.length) dispatchEvent(new CustomEvent('table:move', { detail: { frames, table: T } }));
}
// Duplicate: each copy beside its original, with a copy of its document
async function duplicateFrames(ids) {
  const made = [], ok = here();
  for (const f of T.frames.filter((x) => ids.has(x.id))) {
    const g = { ...structuredClone(f), id: M.newFrame(f.kind, f).id, label: `${f.label} copy`, locked: false };
    Object.assign(g, M.nextBeside([...T.frames, ...made], f.kind, { w: f.w, h: f.h }));
    try { g.doc = f.doc ? await copyDoc(f, g.label) : null; } catch (e) { toast(`Couldn't copy "${f.label}": ${e.message}`, true); continue; }
    made.push(g);
    if (!ok()) break;
  }
  if (!made.length) return;
  if (!ok()) { for (const g of made) trashDoc(g).catch(() => {}); return; }   // (another table opened meanwhile: the copies go)
  T.frames.push(...made);
  U.sel = new Set(made.map((f) => f.id)); renderFrames(); changed();
}
function setLocked(list, on) { for (const f of list) f.locked = on; renderFrames(); changed(); }
function restack(fn) { T.frames = fn(T.frames, [...U.sel]); renderFrames(); changed(); }
function fit(list = T.frames, { animate = true } = {}) {
  const { w, h: hh } = stageSize();
  setView(M.fitView(M.boundsOf(list), w, hh, 48, { min: ZMIN, max: 1 }), { animate });
}
// The first look at a table whose view was never set: all its frames in view, once. It waits for a stage with a size (the
// Table screen on show) and for frames; a story table (frame-story.js lays its rows first) waits for fitAll({ laid: true }).
// Returns true when it fitted.
export function fitAll({ laid = false } = {}) {
  if (laid) U.laid = true;
  if (!U.fitDue || !D.stage || !T.frames.length || (T.story && !U.laid) || isLive()) return false;
  const { w, h: hh } = stageSize();
  if (!w || !hh) return false;
  U.fitDue = false;
  fit(T.frames, { animate: false });
  return true;
}
// Select these frames (by id) as a tap on one would, and with scroll: true bring them into view (the zoom stays, unless
// they are bigger than the stage). A live frame keeps the table as it is. Fires table:select when the selection changed.
export function selectFrames(ids, { scroll = false } = {}) {
  if (isLive() || !D.stage) return false;
  const list = T.frames.filter((f) => ids.includes(f.id));
  U.sel = new Set(list.map((f) => f.id));
  renderFrames();
  if (scroll && list.length) {
    const { w, h: hh } = stageSize(), { x, y, z } = T.view, b = M.boundsOf(list);
    const inside = b.x * z + x >= 0 && b.y * z + y >= 0 && (b.x + b.w) * z + x <= w && (b.y + b.h) * z + y <= hh;
    if (!inside && w && hh) {
      if (b.w * z > w || b.h * z > hh) fit(list);
      else setView({ x: w / 2 - (b.x + b.w / 2) * z, y: hh / 2 - (b.y + b.h / 2) * z, z }, { animate: true });
    }
  }
  return true;
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
    actions(button('Apply', () => { closeSheet(); setSize(f, { w, h: hh }); }, { cls: 'small primary' }),
      button('Cancel', closeSheet, { cls: 'small ghost' })));
}

// a frame's size set from the sheet or the panel; a live frame's module takes it at once (table:resize), others on opening
function setSize(f, s) {
  const before = geomOf(new Set([f.id]));
  Object.assign(f, s);
  recordGeom(before, geomOf(new Set([f.id])));
  if (liveFrame()?.id === f.id) {
    placeLive();
    dispatchEvent(new CustomEvent('table:resize', { detail: { frame: f, table: T } }));
  }
  renderFrames(); changed();
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
const inLive = (e) => !!e.target.closest?.('.live-layer .frame-mount');
const othersOf = (ids) => T.frames.filter((f) => !ids.has(f.id));
const snapThr = () => SNAP_PX / T.view.z;

function onDown(e) {
  if (inLive(e) || e.target.closest('.max-btn, .pull-tab, textarea')) return;
  if (e.pointerType === 'touch') {
    U.pts.set(e.pointerId, local(e));
    if (U.pts.size === 2) { cancelOp(); U.op = isLive() ? null : { type: 'pinch', last: [...U.pts.values()] }; return; }
    if (U.pts.size > 2) return;
  }
  if (e.button === 2) return;   // (the menu comes with contextmenu)
  e.preventDefault();
  try { D.stage.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  const base = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
  const handle = e.target.closest('.frame-handle'), f = frameAt(e);
  if (isLive()) U.op = { ...base, type: 'backdrop' };   // (the table behind a live frame: a tap beside it lets go of it)
  else if (e.button === 1 || (e.button === 0 && U.space)) U.op = { ...base, type: 'pan', v0: { ...T.view } };
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
  if (op.type === 'backdrop') { if (!op.moved && isLive()) unlive(); return; }
  if (op.type === 'pan') { if (op.moved) changed(); return; }
  if (op.type === 'move') return endMove(e, op);
  if (op.type === 'resize') {
    if (op.moved) { recordGeom([{ id: op.f.id, x: op.start.x, y: op.start.y, w: op.start.w, h: op.start.h }], geomOf(new Set([op.f.id]))); changed(); tellMoved([op.f]); }
    return;
  }
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
  if (op.moved) {
    const moved = [...op.start.keys()].map(byId).filter(Boolean);
    recordGeom([...op.start].map(([id, s]) => { const f = byId(id); return { id, x: s.x, y: s.y, w: f?.w, h: f?.h }; }), geomOf(new Set(op.start.keys())));
    changed(); tellMoved(moved);
    return;
  }
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
  if (isLive()) return;   // (the table behind a live frame stays put: the bar's Fit and 100% move it)
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
  if (ctrl && (k.toLowerCase() === 'z' || k.toLowerCase() === 'y')) {
    e.preventDefault();
    if (k.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
    return;
  }
  const step = e.shiftKey ? NUDGE * 10 : NUDGE;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  let fn = null;
  if (k === 'Delete' || k === 'Backspace') fn = () => deleteFrames(new Set(U.sel));
  else if (arrows[k] && U.sel.size) fn = () => nudge(arrows[k]);
  else if (ctrl && k.toLowerCase() === 'd') fn = () => duplicateFrames(new Set(U.sel));
  else if (ctrl && k.toLowerCase() === 'a') fn = () => { U.sel = new Set(T.frames.map((f) => f.id)); renderFrames(); };
  else if (!ctrl && k.toLowerCase() === 'f') fn = () => fit(U.sel.size ? selected() : T.frames);
  else if (!ctrl && k === '0') fn = () => zoomTo(1);
  else if (!ctrl && k === 'Enter' && U.sel.size === 1) fn = () => goLive(selected()[0]);
  if (!fn) return;
  e.preventDefault(); fn();
}
// The arrows move the selection a pixel (ten with Shift); a run of presses is one step to undo, and table:move goes once
// they stop
function nudge([dx, dy]) {
  const ids = new Set([...U.sel]), key = [...ids].sort().join(',');
  if (U.nudge?.key !== key) { flushNudge(); U.nudge = { key, ids, before: geomOf(ids) }; }
  T.frames = M.moveFrames(T.frames, [...ids], dx, dy);
  renderFrames(); changed();
  clearTimeout(U.nudge.t); U.nudge.t = setTimeout(flushNudge, 500);
}
function flushNudge() {
  const n = U.nudge;
  if (!n) return;
  U.nudge = null; clearTimeout(n.t);
  recordGeom(n.before, geomOf(n.ids));
  tellMoved(T.frames.filter((f) => n.ids.has(f.id)));
}
// Esc (on window: after the engines' own Esc, which marks it handled when it used it)
function onEsc(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !onTable() || ownsKey(e) || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
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
// (while a frame is live: only an in-app drag over it; files dropped on it are its module's own)
const wantDrop = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  if (isLive()) return types.includes(SOURCE_TYPE) && inLive(e);
  return types.includes(SOURCE_TYPE) || draggingPicture(e.dataTransfer);
};
function onDragOver(e) {
  if (!wantDrop(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  hoverDrop(isLive() ? null : frameAtPoint(e.clientX, e.clientY));
}
// the frame a drop would go into, outlined while something is held over it
function hoverDrop(f) {
  const id = f && f.kind !== 'note' && f.doc ? f.id : null;
  if (U.dropOver === id) return;
  U.els.get(U.dropOver)?.classList.remove('drop-onto');
  U.dropOver = id;
  U.els.get(id)?.classList.add('drop-onto');
}
async function onDrop(e) {
  hoverDrop(null);
  if (!wantDrop(e)) return;
  e.preventDefault();   // (picture-drop.js leaves a drop already taken)
  const raw = e.dataTransfer.getData(SOURCE_TYPE);
  const got = raw ? null : droppedFiles(e.dataTransfer);   // (read during the event: the browser empties it after)
  let list;
  try { list = raw ? [JSON.parse(raw)].flat() : await got; } catch (err) { return toast(err.message, true); }
  await dropOnTable(list, e.clientX, e.clientY);
}
// the frame under a screen point: the live one when the point is on its mount (and no other while one is live)
function frameAtPoint(clientX, clientY) {
  if (isLive()) {
    const r = liveRoot()?.getBoundingClientRect();
    return r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom ? liveFrame() : null;
  }
  const r = D.stage.getBoundingClientRect();
  return M.hitFrame(T.frames, M.toTable(T.view, clientX - r.left, clientY - r.top));
}
// Things dropped into a frame (table:drop-frame with sources): true when its module took them
export function dropOntoFrame(frame, list) {
  if (!frame || frame.kind === 'note' || !frame.doc) return false;
  const detail = { from: [], sources: [list].flat(), onto: frame, table: T, handled: false };
  dispatchEvent(new CustomEvent('table:drop-frame', { detail }));
  return detail.handled;
}
// Things dropped at a screen point: over a frame, into it (an image frame takes pictures as layers, a video frame clips,
// a 3D frame pictures); else frames of their own there, side by side. src: see table-frames.js frameFor.
export async function dropOnTable(list, clientX, clientY) {
  if (!U.wired) await startTables();
  if (dropOntoFrame(frameAtPoint(clientX, clientY), list)) return;
  const r = D.stage.getBoundingClientRect(), ok = here();
  let at = M.toTable(T.view, clientX - r.left, clientY - r.top), made = 0;
  for (const src of [list].flat()) {
    let got;
    try { got = await frameFor(src, at); } catch (err) { toast(err.message, true); continue; }
    if (!ok()) return;   // (another table opened meanwhile)
    if (!got) { toast('That can\'t go on the table', true); continue; }
    got.frame.label = got.frame.label || nextLabel(got.frame.kind);
    if (await makeFrame(got.frame.kind, got.frame, { ...got, ok })) { made++; at = { x: got.frame.x + got.frame.w + 40, y: got.frame.y }; }
  }
  if (made > 1) toast(`Added ${made} frames`);
}

// ---------------------------------------------------------------------------
// the sidebar's Frame pane: the frames, and the selected one's label, size, place and lock
// ---------------------------------------------------------------------------
function renderPanel() {
  const s = selected(), one = s.length === 1 ? s[0] : null;
  const sig = JSON.stringify([[...U.sel], T.frames.map((f) => [f.id, f.label, f.w, f.h, f.locked, ...(U.sel.has(f.id) ? [f.x, f.y] : [])])]);
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
  name.addEventListener('change', () => {
    f.label = name.value.trim() || M.KIND_LABEL[f.kind]; U.panelSig = ''; renderFrames(); changed();
    renameDoc(f, f.label).catch((e) => toast(`Couldn't rename its document: ${e.message}`, true));   // (the document bar and pickers show the frame's name)
  });
  // where it sits: typed table pixels (a locked frame stays put)
  const num = (k) => {
    const el = h('input', { type: 'number', inputMode: 'numeric', step: 1, value: Math.round(f[k]), 'aria-label': k.toUpperCase(), disabled: !!f.locked });
    el.addEventListener('change', () => {
      if (f.locked || !Number.isFinite(+el.value)) return;
      const before = geomOf(new Set([f.id]));
      f[k] = Math.round(+el.value);
      recordGeom(before, geomOf(new Set([f.id])));
      if (liveFrame()?.id === f.id) placeLive();
      renderFrames(); changed(); tellMoved([f]);
    });
    return el;
  };
  const mp = mpInput(() => M.mpOf(f.w, f.h).toFixed(2), (n) => { if (n > 0) setSize(f, M.sizeForMp(f.w, f.h, n)); });
  mp.querySelector('span').textContent = 'MP';
  return [field('Label', name),
    field('Size', h('div', { class: 'row wrap' }, h('span', { class: 'table-size' }, `${f.w}×${f.h} · ${M.mpOf(f.w, f.h).toFixed(2)} MP`),
      button('Size and MP…', () => sizeSheet(f)))),
    f.kind !== 'note' ? mp : null,
    h('div', { class: 'grid-2' }, field('X', num('x')), field('Y', num('y'))),
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
  D.tab = $('#tab-table'); D.panel = sidebar.pane('frame');
  D.stage = D.tab.querySelector('.table-stage');
  D.frames = h('div', { class: 'table-frames' });
  D.handles = h('div', { class: 'table-handles' });
  D.guides = h('div', { class: 'table-guides' });
  D.marquee = h('div', { class: 'table-marquee' });
  D.world = h('div', { class: 'table-world' }, D.frames, D.guides, D.marquee, D.handles);
  D.live = h('div', { class: 'live-layer' });   // (a live frame's mount: over the stage, outside the zoomed world)
  D.stage.append(D.world, D.live);
  buildBar();
  D.tab.querySelector('.stage').prepend(D.bar);
  fullScreen(D.tab, { viewer: D.stage, title: 'Full screen table' });
  D.stage.addEventListener('pointerdown', onDown);
  D.stage.addEventListener('pointermove', onMove);
  D.stage.addEventListener('pointerup', onUp);
  D.stage.addEventListener('pointercancel', onUp);
  D.stage.addEventListener('wheel', onWheel, { passive: false });
  D.stage.addEventListener('dragover', onDragOver);
  D.stage.addEventListener('dragleave', (e) => { if (!D.stage.contains(e.relatedTarget)) hoverDrop(null); });
  D.stage.addEventListener('drop', onDrop);
  pressMenu(D.stage, stageMenu, { ok: (e) => !isLive() && !e.target.closest?.('.max-btn, .pull-tab') });
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') { U.space = false; D.stage.classList.remove('panning'); } });
  addEventListener('keydown', onEsc);
  new ResizeObserver(() => placeLive()).observe(D.stage);
  registerUndo('table', { undo, redo, can: () => [H.past.length > 0, H.future.length > 0] });
  D.nav = wireTableNav({
    list: () => U.tabs?.docs || [],
    active: () => U.tabs?.active?.id,
    shown: () => currentTab() === 'table',
    open: openTable,
    create: () => tableOp(() => U.tabs.create()),
    rename: (id) => tableOp(async () => { if (await switchTable(id)) U.tabs.rename(); }),
    duplicate: (id) => tableOp(() => duplicateTable(id)),
    remove: (id) => tableOp(async () => {
      if (!(await switchTable(id))) return;
      await unlive();   // (its live frame's last save lands before the table's documents are trashed)
      if (U.tabs.active?.id === id) await U.tabs.remove();
    }),
    reorder: (from, to) => tableOp(() => U.tabs.reorder(from, to)),
  });
  onNavigate(() => D.nav.render());
  onServer('store', (m) => {
    const kind = kindOfDoc(m.kind);
    if (!kind || !T.frames.some((f) => f.kind === kind && f.doc === m.id)) return;
    clearTimeout(stillT); stillT = setTimeout(() => refreshStills([kind]), 300);
  });
  onProject(() => unlive());   // (the TabSet loads the project's tables itself)
  // a result waiting for an image frame's document (imagetools.js keeps them in deck.imagetools.owed): its badge follows
  let owedT = 0;
  const owedSoon = () => { clearTimeout(owedT); owedT = setTimeout(renderFrames, 200); };
  onServer('deck_generation', owedSoon);
  addEventListener('storage', (e) => { if (e.key === 'deck.imagetools.owed') owedSoon(); });
}

// Wire the table and load the project's tables (app.js calls it at start, so the top tabs are there on any screen)
let starting = null;
export function startTables() {
  if (U.wired) return starting || Promise.resolve();
  wire();
  starting = startStore().catch((e) => toast(`Couldn't load the table: ${e.message}`, true));
  return starting;
}
// The Table screen comes on: load the table if that hasn't happened, and show it. Coming back to it while a frame is
// live brings the table back (the screen's own button is "the whole table").
export async function renderTable() {
  if (!U.wired) return startTables();
  unlive();
  applyView(); D.syncBar?.(); renderFrames();
  fitAll();   // (a table opened while another screen was on show had no stage size)
}

// ---------------------------------------------------------------------------
// the project's tables: the top tabs (table-nav.js draws them from the `tables` TabSet's list)
// ---------------------------------------------------------------------------
// a tab's action: on the Table screen
async function tableOp(fn) {
  if (!U.tabs) return;
  if (currentTab() !== 'table') navigate('table');
  try { await fn(); } catch (e) { toast(e.message, true); }
}
// that table open (the Table screen on show too); true once it is the one open
async function switchTable(id) {
  if (U.tabs.active?.id !== id) { flushNudge(); await U.tabs.switchTo(id); }
  return U.tabs.active?.id === id;
}
export async function openTable(id) {
  if (currentTab() !== 'table') navigate('table');
  if (await switchTable(id)) D.nav.render();
}
// Alt + ← →: the table before or after this one
export function stepTable(dir) {
  const list = U.tabs?.docs || [];
  if (currentTab() !== 'table') return navigate('table');
  const i = list.findIndex((d) => d.id === U.tabs?.active?.id), j = i + dir;
  if (i >= 0 && j >= 0 && j < list.length) openTable(list[j].id);
}
// A copy of a table beside it, its frames each with a copy of their document (two frames never share one: deleting
// one would take the other's)
async function duplicateTable(id) {
  if (!(await switchTable(id))) return;
  await unlive();   // (its live frame's last save is in the copy)
  if (!(await U.tabs.leave())) return;
  const a = U.tabs.active, copy = structuredClone(T), pid = S.project;
  for (const f of copy.frames) {
    f.id = M.newFrame(f.kind, f).id;
    if (f.doc) {
      try { f.doc = await copyDoc(f, f.label); } catch (e) { toast(`Couldn't copy "${f.label}": ${e.message}`, true); f.doc = null; }
    }
  }
  copy.frames = copy.frames.filter((f) => f.doc || f.kind === 'note');
  delete copy.story;   // (a story stays with its own table)
  if (S.project !== pid) { for (const f of copy.frames) trashDoc(f).catch(() => {}); return; }   // (another project opened meanwhile)
  const doc = await U.tabs.create1({ name: `${a.name} copy`.slice(0, 120), payload: copy, order: a.order + 0.5 });
  U.tabs.open(doc);
}
// another screen came on: let go of the live frame and any gesture
export function pauseTable() {
  if (!U.wired) return;
  cancelOp(); closePressMenu(); unlive();
  U.space = false;
}
