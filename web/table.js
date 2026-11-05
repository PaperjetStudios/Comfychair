// The table: one surface where the project's images, videos, sounds, 3D scenes and notes sit as frames, to move, size
// and open in place. Each frame owns a saved document of its kind (table-frames.js); the table itself is a document
// of kind `tables` (app/store.py). The project's tables are the top tabs (table-nav.js), not a strip on the document bar.
//
// The view: the wheel (or a trackpad pinch) zooms about the pointer, two fingers pan and pinch, Space + drag or the
// middle button pans. A drag on empty space draws a box: over frames it selects them, over nothing it asks what kind
// of frame to make there. A frame goes live (Enter, a double-click, Open): its mount root sits in .live-layer over the
// stage (not in the zoomed .table-world, so it is at 1:1 and a fixed full screen inside it works), filling the stage
// and covering the table; a thin bar on top has its name, the one ⛶ and ✕. A frame-kind module mounts its engine in the
// root (the `table:live` event) and fits its picture inside. Esc or ✕ brings the table back.
// Moves, resizes and deletes undo (Ctrl+Z, the top bar's ↶) while nothing is live.
//
// The frames are a layer stack, with the editor's rules (web/layer-stack.js): the list's order is the stacking order
// (bottom first), frames group (T.groups; a member says frame.group), hide (not drawn, picked, boxed or fitted, but kept
// where it is) and lock (not moved, sized or deleted). The Frame pane lists them as the editor lists layers (ui.js
// layerRowsEl), and the list and the table share one menu (layer-menu.js frameMenu). Arrange ▾ on the bar aligns,
// spreads, sizes and tidies the selection (table-model.js). Changes to the stack undo as the moves do.
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
//   table:frame-field { frame, keys, table }     a frame's own fields changed; keys has 'out' when its output size did (its module applies it)
//   table:move       { frames: [frame], table }  frames were moved by a drag, the arrows (once they stop) or Undo
//   table:open       { table, doc }              a table document was loaded or made (its frames are drawn); doc is the
//                    TabSet's doc ({ id, name, … }). Not fired for the open table saved elsewhere (it is the same table).
//   table:deleted    { frames: [frame] }         frames were deleted (their documents are in the server's trash); a frame
//                    module drops what only the frame itself owned. Undo brings the frames back, not that.
//   table:menu       { frame, frames, groups }   the frame menu is about to open: a module adds its own groups of items
//                    (press-menu.js's shape) to groups; they go before Delete
//   table:wires      { frames: [id], table }     wires were plugged, unplugged or changed (by hand, Undo, a delete or a
//                    duplicate); frames: the ids of the frames at either end of the wires that changed
//   table:stale      { frames: [id] }            which frames need a rerun changed (a source's content changed since their
//                    last run: chain-rules.js staleInfo); the tiles show it, the Make pane says why
//
// Wires (web/wire-rules.js, T.wires): a frame's output plugged into another frame's Make inputs. A frame with something to
// put out has an out port beside its right edge, always there; a drag from it to another frame plugs it in (a video frame
// asks: the clip, or frames of it, chosen on a scrubber), as its next input; let go on an input port, it takes that port's place;
// let go on empty table, it opens the quick panel (wire-panel.js).
// A frame with a workflow and something plugged in has a little run button at its top right (chain-run.js runNode). The target shows one input port per wire down its left edge
// ("Image 1", "Video 1", "Sound 1"). Tap a wire or an input port to select it, Delete unplugs it, right click or a long hold
// has the rest. Every wire change is a table undo step. For the Make pane: tableWires, wiresInto, setTableWire.
import { $, h, api, store, toast, undoToast, openSheet, closeSheet, button, field, section, sheetOpen, actions, icon, hint, info, toggle, help, layerRowsEl, iconBtn, uid } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { TabSet } from './tabs.js';
import { currentTab } from './navigation.js';
import { ownsKey } from './key-focus.js';
import { openPressMenu, pressMenu, closePressMenu } from './press-menu.js';
import { gzChip, snap as snapPrefs, snapBar } from './gizmo.js';
import { onPreviewWindow, onSamplerPreview, previewWindow, samplerPreview, setPreviewWindow, setSamplerPreview } from './run-strip.js';
import { exitMaxedIn, fullScreen, fullScreenOf } from './layout.js';
import { liveUndoEntry, registerUndo, setLiveSteps, syncUndo } from './undo-dock.js';
import { undoOrder } from './undo-order.js';
import { onNavigate, switchTab as navigate } from './navigation.js';
import { wireTableNav } from './table-nav.js';
import { droppedFiles, draggingPicture } from './drop-files.js';
import { isLive, liveFrame, liveRoot, setLive } from './live.js';
import * as M from './table-model.js';
import * as ST from './layer-stack.js';
import * as W from './wire-rules.js';
import { frameMenu as frameMenuGroups, frameArrangeMenu, pickedFor } from './layer-menu.js';
import { filtering, foldedGroups, listRows } from './frame-list.js';
import { KIND_ICON, copyDoc, createDoc, dropInput, editDoc, frameEl, frameFor, frameStamp, kindOfDoc, loadStills, noteRev, owedCounts, renameDoc, restoreDoc, stillOf, syncFrame, trashDoc, pausePreviews, previewMode, setPreviewMode } from './table-frames.js';
import { staleInfo, staleText } from './chain-rules.js';
import { docEmpty } from './quick-start-rules.js';
import { sidebar } from './sidebar.js';
import { FLOAT_KINDS, floatLayers, layersFloating } from './float-layers.js';
import { registerProps, propsChanged } from './props-panel.js';
import { shared, snapNum, mixLength } from './props-rules.js';

const ZMIN = 0.02, ZMAX = 8, DRAG_PX = 4, SNAP_PX = 8, DWELL_MS = 600, NUDGE = 1;
const DOUBLE_MS = 380, DOUBLE_PX = 24;   // a double tap: the second within this long and this near (screen pixels)
const SOURCE_TYPE = 'application/x-deck-source';   // an in-app drag's payload: JSON { generation, index } | { input } | { media }
const NEW_KINDS = ['image', 'video', 'scene', 'sound', 'note'];

let T = M.blankTable();   // the open table
const U = { sel: new Set(), els: new Map(), wired: false, lastTap: null, tabs: null, op: null, pts: new Map(), space: false, panelSig: '',
  before: null /* the view before a frame went live */, nudge: null /* arrows held: { ids, before, t } */,
  loaded: null /* { id, pid } of the table loaded last */, find: { q: '', kinds: new Set(), selOnly: false } /* the Frame pane's list filters */,
  fold: new Map() /* a story scene's row folded or opened by hand, by scene id */, leaving: Promise.resolve() /* the last live frame's saves (table:unlive wait) */,
  wire: null /* the selected wire's id */, hover: null /* the frame the mouse is over (its out port shows) */,
  wireEls: new Map() /* wire id -> its <g> */, outEls: new Map() /* frame id -> its out port */, inEls: new Map() /* wire id -> its input port */, runEls: new Map() /* frame id -> its run button */, chain: null /* chain:state */ };
const PENDING = new Map();   // doc id -> results on their way to it (edit:pending { doc, n }, from any kind's edits)
const H = { past: [], future: [] };   // undo: [{ undo(), redo() }] for this table's moves, resizes and deletes
const ORDER = undoOrder();   // the table steps made while a frame is live, in their place among its engine's (liveStep)
const D = {};             // its elements

// ---------------------------------------------------------------------------
// saving: a `tables` document through TabSet
// ---------------------------------------------------------------------------
const adapter = {
  empty: M.blankTable,
  migrate: M.migrateTable,
  dump: () => T,
  // (a live frame lets go first: its last changes, such as a canvas size its module writes back, are saved on this table)
  beforeLeave: () => unlive(),
  refused: (r, tab) => dropForeign(r, tab),
  load(p, doc) {
    const next = M.migrateTable(p), key = { id: doc?.id ?? null, pid: S.project };
    const same = U.loaded && U.loaded.id === key.id && U.loaded.pid === key.pid;
    U.loaded = key;
    if (same) return reloaded(next);
    unlive(); cancelOp();
    T = next; U.sel.clear(); H.past = []; H.future = []; ORDER.clear(); U.nudge = null; U.wire = null; U.hover = null; U.mends = 0;
    U.fitDue = T.view.x === 0 && T.view.y === 0 && T.view.z === 1; U.laid = false;   // (a table never viewed: fit its frames once)
    syncUndo(); D.syncBar?.(); renderAll(); refreshStills();
    fitAll();
    dispatchEvent(new CustomEvent('table:open', { detail: { table: T, doc } }));
    moveVfxDocs().catch((e) => console.warn('old frame VFX', e));
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
  if (U.wire && !T.wires.some((w) => w.id === U.wire)) U.wire = null;
  if (liveFrame() && !ids.has(liveFrame().id)) unlive();
  else if (liveFrame()) placeLive();
  if (U.op && [...(U.op.ids || []), U.op.f?.id, U.op.src?.id].some((id) => id && !ids.has(id))) cancelOp();
  U.panelSig = '';
  D.syncBar?.(); renderAll(); refreshStills();
}
// A save refused because frames here carry documents another table owns (app/store.py names them: { docs }): exactly those
// frames come off this table's copy, their documents left alone (they are the other table's), one toast says so, and the
// table saves again (tabs.js). Nothing named here, or the third time on one table: false, and the refusal stands. A server
// that doesn't name them yet: the other tables are read (?full=true) and their frames' documents are the ones.
async function dropForeign(r, tab) {
  if (tab?.id !== activeTableId() || (U.mends || 0) >= 3 || !/another table/i.test(r?.data?.detail || '')) return false;
  let docs = r?.data?.docs;
  if (!Array.isArray(docs)) {   // (a server from before it named them: the other tables' frames, read here)
    const ok = here();
    try { docs = M.docsOwnedElsewhere(await api(`/api/store/tables?full=true${S.project != null ? `&project_id=${S.project}` : ''}`, { busy: false }), tab.id); } catch { return false; }
    if (!ok()) return false;
  }
  const ids = M.foreignFrames(T.frames, docs);
  if (!ids.length) return false;
  U.mends = (U.mends || 0) + 1;
  const drop = new Set(ids), gone = T.frames.filter((f) => drop.has(f.id));
  if (gone.some((f) => f.id === liveFrame()?.id)) unlive();
  T.frames = ST.normalize(T.frames.filter((f) => !drop.has(f.id)), T.groups);
  for (const id of ids) U.sel.delete(id);
  const hadWires = T.wires;
  T.wires = W.dropFrames(T.wires, ids);
  if (U.wire && !wireById(U.wire)) U.wire = null;
  H.past = []; H.future = []; ORDER.clear(); syncUndo();   // (an undo step could put them back)
  renderFrames();
  tellWires(wiresTouched(hadWires, T.wires));
  const names = gone.map((f) => `"${f.label || M.KIND_LABEL[f.kind]}"`).join(', ');
  toast(`Took ${gone.length === 1 ? `the frame ${names}` : `${gone.length} frames (${names})`} off this table: ${gone.length === 1 ? 'its document belongs' : 'their documents belong'} to another table, so this table couldn't be saved. Nothing was deleted.`, true);
  return true;
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
  // the grid is the stage's background, so it never runs out: fine lines, and a main line every fourth
  const { fine, main } = M.gridSteps(T.grid.size, z);
  D.stage.classList.toggle('grid-on', !!T.grid.on);
  D.stage.style.backgroundSize = `${main}px ${main}px, ${main}px ${main}px, ${fine}px ${fine}px, ${fine}px ${fine}px`;
  D.stage.style.backgroundPosition = `${x}px ${y}px`;
  D.zoom.textContent = `${Math.round(z * 100)}%`;
  if (U.wz !== z) { U.wz = z; renderPorts(); renderWires(); }   // (the ports and the input stack hold their size on screen)
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
// a table's name, by id (the project's tables the TabSet lists), else null
export const tableName = (id) => U.tabs?.docs?.find((d) => d.id === id)?.name ?? null;
export function frameChanged() { U.panelSig = ''; renderFrames(); changed(); }
// The open table's story is gone (deleted on the Classic screen): the table stops being a story's (its frames stay)
export function dropStory(storyId) {
  if (!T.story || T.story !== storyId) return false;
  delete T.story; changed();
  return true;
}

// The frames' elements follow the list (its order is the stacking order); each is made once and kept
function renderFrames() {
  const seen = new Set(), live = liveFrame(), owed = owedCounts();
  // waiting results: the image frames' owed runs (table-frames.js), and what edit:pending says for any kind
  const waiting = (f) => Math.max(f.kind === 'image' ? owed.get(f.doc) || 0 : 0, PENDING.get(f.doc) || 0);
  const stale = staleNow();
  if (U.liveBar && live && U.liveBar.name.isConnected) U.liveBar.name.textContent = live.label || M.KIND_LABEL[live.kind];
  T.frames.forEach((f, i) => {
    f.key = f.id;   // (what the stack rules know a frame by)
    let el = U.els.get(f.id);
    if (!el) { el = frameEl(f, { onText: (t) => { f.text = t; changed(); }, onTextDone: (was, now) => textStep(f.id, was, now) }); U.els.set(f.id, el); }
    if (D.frames.children[i] !== el) D.frames.insertBefore(el, D.frames.children[i] || null);
    syncFrame(el, f, { selected: U.sel.has(f.id), live: live?.id === f.id, owed: waiting(f), stale: stale.get(f.id) || null });
    el.classList.toggle('frame-hidden', !!f.hidden);
    el.style.opacity = f.opacity != null && f.opacity < 1 ? String(f.opacity) : '';   // (the Properties pane's Opacity: the tile on the table only)
    seen.add(f.id);
  });
  for (const [id, el] of U.els) if (!seen.has(id)) { el.remove(); U.els.delete(id); }
  tellNewFrames();
  renderHandles();
  renderWires(dragTouch());
  renderPanel();
  D.syncArrange?.();
  tellSelection();
}
// A frame that appears on the table while another one is open (a tool's result, a send to the table, a copy, another device): a toast that goes to it.
// Several at once are one toast, going to the newest. A table being opened tells nothing: what's on it isn't new.
function tellNewFrames() {
  const table = activeTableId(), ids = T.frames.map((f) => f.id);
  if (U.knownIn !== table || !U.known) { U.knownIn = table; U.known = new Set(ids); U.freshIds = []; return; }
  const fresh = ids.filter((id) => !U.known.has(id));
  U.known = new Set(ids);
  if (!fresh.length || !liveFrame()) return;
  U.freshIds = [...(U.freshIds || []), ...fresh];
  clearTimeout(U.freshT);
  U.freshT = setTimeout(() => {
    const list = (U.freshIds || []).map(byId).filter(Boolean), last = list[list.length - 1];
    U.freshIds = [];
    if (!last || !liveFrame()) return;
    toast(list.length > 1 ? `${list.length} new frames on the table` : `New on the table: ${last.label || M.KIND_LABEL[last.kind]}`, false, { label: 'Go to it', fn: () => goToFrame(last.id) });
  }, 400);
}
function goToFrame(id) {
  const f = byId(id);
  if (!f) return toast('That frame has gone', true);
  if (f.kind !== 'note') return goLive(f);
  Promise.resolve(unlive()).then(() => { selectFrames([id], { scroll: true }); goLive(byId(id)); });
}
// table:select, each time the selected frames are other ones than last time
function tellSelection() {
  const sig = [...U.sel].sort().join(',');
  if (sig === U.selSig) return;
  U.selSig = sig;
  dispatchEvent(new CustomEvent('table:select', { detail: { frames: selected(), table: T } }));
}
function renderAll() { applyView(); renderFrames(); }
// Frames whose sources changed since their last run (chain-rules.js staleInfo on the frames' stamps): frameId -> the words
// why. Drawn with each render, so it follows the wires (table:wires renders), the documents (a store message reads the
// stamps again and renders) and a run landing (it records frame.make.ran through frameChanged).
export const staleReasons = () => staleInfo(T.wires, T.frames, frameStamp);
export const staleWords = (r) => staleText(r, { name: (id) => byId(id)?.label || 'a frame', wireName: (id) => { const w = wireById(id); return w ? W.wireLabel(w) : 'An input'; } });
let staleSig = '';
function staleNow() {
  const out = new Map();
  try { for (const [id, r] of staleReasons()) out.set(id, staleWords(r)); } catch (e) { console.warn('stale frames', e); }
  const sig = JSON.stringify([...out]);
  if (sig !== staleSig) { staleSig = sig; queueMicrotask(() => dispatchEvent(new CustomEvent('table:stale', { detail: { frames: [...out.keys()] } }))); }
  return out;
}

// eight handles on the one selected frame (none while live or locked); their size holds against the zoom (app.css)
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function renderHandles() {
  renderPorts(dragTouch());
  D.handles.replaceChildren();
  const s = selected();
  if (s.length !== 1 || s[0].locked || s[0].hidden || isLive()) return;
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

// ---------------------------------------------------------------------------
// wires: drawn in an SVG under the frames (it rides the pan and zoom), the ports over them (with the handles)
// ---------------------------------------------------------------------------
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
// where the ports sit, in screen pixels (a finger gets more room, clear of the resize handles): the out port's gap beside
// the right edge, the first input port's drop from the top and the step between them
const portGeom = () => (matchMedia('(pointer: coarse)').matches ? { gap: 48, top: 60, step: 48 } : { gap: 20, top: 34, step: 26 });
const outPt = (f, pg, z) => ({ x: f.x + f.w + pg.gap / z, y: f.y + f.h / 2 });
const inPt = (f, i, pg, z) => ({ x: f.x, y: f.y + (pg.top + i * pg.step) / z });
function curve(a, b, z) {
  const dx = Math.max(Math.abs(b.x - a.x) / 2, 60 / z);
  return `M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
}
// the frames being dragged (only their wires and ports are redrawn meanwhile), or null for all of them
function dragTouch() {
  const op = U.op;
  if (!op?.moved) return null;
  if (op.type === 'move') return op.ids;
  if (op.type === 'resize') return new Set([op.f.id]);
  return null;
}
const wireById = (id) => T.wires.find((w) => w.id === id) || null;
const drawn = (w) => { const a = byId(w.from), b = byId(w.to); return a && b && !a.hidden && !b.hidden ? [a, b] : null; };
// each wire's place in its target's input stack (image, video, sound, each by n)
function inputSlots() {
  const to = new Map(), at = new Map();
  for (const w of T.wires) { if (!to.has(w.to)) to.set(w.to, []); to.get(w.to).push(w); }
  for (const [id, list] of to) W.inputsFor(list, id).forEach((w, i) => at.set(w.id, i));
  return at;
}
function renderWires(touch = null) {
  if (!D.wires) return;
  const z = T.view.z, pg = portGeom(), slot = inputSlots(), seen = new Set();
  for (const w of T.wires) {
    if (touch && !touch.has(w.from) && !touch.has(w.to)) { seen.add(w.id); continue; }
    const ends = drawn(w);
    if (!ends) continue;
    let g = U.wireEls.get(w.id);
    if (!g) {
      g = svgEl('g', { class: 'wire', 'data-wire': w.id });
      g.append(svgEl('path', { class: 'wire-hit' }), svgEl('path', { class: 'wire-line' }));
      D.wires.append(g); U.wireEls.set(w.id, g);
    }
    const d = curve(outPt(ends[0], pg, z), inPt(ends[1], slot.get(w.id), pg, z), z);
    g.firstChild.setAttribute('d', d);
    g.lastChild.setAttribute('d', d);
    g.lastChild.setAttribute('class', `wire-line k-${w.kind}${w.on === false ? ' off' : ''}`);
    g.lastChild.style.strokeDasharray = w.on === false ? `${6 / z} ${5 / z}` : '';
    g.classList.toggle('sel', U.wire === w.id);
    seen.add(w.id);
  }
  if (!touch) for (const [id, g] of U.wireEls) if (!seen.has(id)) { g.remove(); U.wireEls.delete(id); }
}
// An out port beside every frame with something to put out (shown on hover, while selected or wiring from it), and an
// input port per wire on its target. None while a frame is live.
function renderPorts(touch = null) {
  if (!D.ports) return;
  if (isLive()) { D.ports.replaceChildren(); U.outEls.clear(); U.inEls.clear(); U.runEls.clear(); return; }
  const z = T.view.z, pg = portGeom(), seenOut = new Set(), seenIn = new Set(), seenRun = new Set(), fed = new Set(T.wires.filter((w) => w.on !== false).map((w) => w.to));
  for (const f of T.frames) {
    if (touch && !touch.has(f.id)) { seenOut.add(f.id); seenRun.add(f.id); continue; }
    if (!f.hidden && f.make?.template && fed.has(f.id)) { renderRun(f); seenRun.add(f.id); }   // (a frame keeps a template just from being selected: only something fed by a wire is a node)
    const kinds = f.hidden ? [] : W.outKinds(f);
    if (!kinds.length) continue;
    let el = U.outEls.get(f.id);
    if (!el) {
      el = h('div', { class: 'wire-out', 'data-frame': f.id, title: 'Drag onto another frame to plug it in' });
      D.ports.append(el); U.outEls.set(f.id, el);
    }
    const p = outPt(f, pg, z);
    el.className = `wire-out k-${kinds[0]}${showOut(f.id) ? ' show' : ''}`;
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
    seenOut.add(f.id);
  }
  const slot = inputSlots();
  for (const w of T.wires) {
    if (touch && !touch.has(w.to)) { seenIn.add(w.id); continue; }
    const ends = drawn(w);
    if (!ends) continue;
    let el = U.inEls.get(w.id);
    if (!el) {
      el = h('div', { class: 'frame-in', 'data-wire': w.id }, h('span', { class: 'frame-in-dot' }), h('span', { class: 'frame-in-label' }));
      D.ports.append(el); U.inEls.set(w.id, el);
    }
    const p = inPt(ends[1], slot.get(w.id), pg, z), pick = W.isFrameWire(w) ? FRAME_PICK_LABEL[w.frame] || `${(+w.frame).toFixed(2)} s` : '';
    el.className = `frame-in k-${w.kind}${w.on === false ? ' off' : ''}${U.wire === w.id ? ' sel' : ''}`;
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
    el.lastChild.textContent = pick ? `${W.wireLabel(w)} · ${pick}` : W.wireLabel(w);
    el.title = `From "${ends[0].label}"${pick ? ` · ${pick}` : ''}${w.on === false ? ' · off' : ''}`;
    seenIn.add(w.id);
  }
  if (touch) return;
  for (const [id, el] of U.outEls) if (!seenOut.has(id)) { el.remove(); U.outEls.delete(id); }
  for (const [id, el] of U.inEls) if (!seenIn.has(id)) { el.remove(); U.inEls.delete(id); }
  for (const [id, el] of U.runEls) if (!seenRun.has(id)) { el.remove(); U.runEls.delete(id); }
}
// A frame's little run button: at the right end of its label bar. Running: it stops. Waiting in the chain: dimmed.
function renderRun(f) {
  let el = U.runEls.get(f.id);
  if (!el) {
    el = h('button', { type: 'button', class: 'frame-run', 'data-frame': f.id, 'aria-label': 'Run this frame' }, icon('play'));
    D.ports.append(el); U.runEls.set(f.id, el);
  }
  const now = U.chain?.running && U.chain.frame === f.id, wait = !now && U.chain?.running && U.chain.list?.includes(f.id);
  el.classList.toggle('now', !!now); el.classList.toggle('wait', !!wait);
  if (el.dataset.now !== String(!!now)) { el.dataset.now = String(!!now); el.replaceChildren(icon(now ? 'close' : 'play')); }
  el.title = now ? 'Stop this run' : wait ? 'Waiting to run' : 'Run this frame';
  el.style.left = `${f.x + f.w}px`; el.style.top = `${f.y}px`;
}
addEventListener('chain:state', (e) => { U.chain = e.detail; renderPorts(); });
const FRAME_PICK_LABEL = { first: 'First frame', last: 'Last frame', playhead: 'Playhead' };
const showOut = (id) => U.sel.has(id) || U.hover === id || U.op?.src?.id === id;
// the mouse over a frame or its out port: that port shows
function setHover(id) {
  if (U.hover === id) return;
  const was = U.hover;
  U.hover = id;
  for (const x of [was, id]) if (x) U.outEls.get(x)?.classList.toggle('show', showOut(x));
}
// the wire picked (null: none); picking one lets go of the frames
function pickWire(id) {
  if (U.wire === id) return;
  U.wire = id;
  if (id) U.sel.clear();
  renderFrames();
}
// T.wires set (an undo step's list: wires naming a frame that's gone since are left out)
function putWires(list, touched) {
  T.wires = W.renumber(list.filter((w) => byId(w.from) && byId(w.to)));
  if (U.wire && !wireById(U.wire)) U.wire = null;
  renderFrames(); changed();
  tellWires(touched);
}
function tellWires(ids) {
  const frames = [...new Set(ids)];
  if (frames.length) dispatchEvent(new CustomEvent('table:wires', { detail: { frames, table: T } }));
}
// the frames at either end of the wires that differ between two lists
function wiresTouched(a, b) {
  const key = (w) => JSON.stringify(w), ka = new Set(a.map(key)), kb = new Set(b.map(key)), out = new Set();
  for (const w of a) if (!kb.has(key(w))) { out.add(w.from); out.add(w.to); }
  for (const w of b) if (!ka.has(key(w))) { out.add(w.from); out.add(w.to); }
  return [...out];
}
// A change to the wires as one undo step; false when nothing changed
function wireStep(next) {
  const before = T.wires, touched = wiresTouched(before, next);
  if (!touched.length) return false;
  record({ undo: () => putWires(before, touched), redo: () => putWires(next, touched) });
  putWires(next, touched);
  return true;
}
const WHY = {
  missing: () => 'That frame is gone',
  'no-output': (s) => `"${s.label}" has nothing to plug in yet`,
  'wrong-kind': (s) => `"${s.label}" can't go in as that`,
  cycle: (s, d) => `That would go round in a loop: "${d.label}" already feeds "${s.label}"`,
  exists: (s, d) => `"${s.label}" is plugged into "${d.label}" already`,
  same: () => null,
};
// src's output into dst, as kind (a video frame: its clip, 'video', or a frame of it, 'image')
function plug(src, dst, kind) {
  if (byId(src.id) !== src || byId(dst.id) !== dst) return toast('That frame is gone');
  const r = W.addWire(T.wires, { from: src.id, to: dst.id, kind }, T.frames);
  if (r.why) return toast((WHY[r.why] || (() => 'That can\'t be plugged in there'))(src, dst));
  wireStep(r.wires);
}
// let go over dst: a source with more than one thing to put out asks which
function plugAt(src, dst, x, y) {
  if (dst.kind === 'note') return toast('A note takes nothing in');
  const kinds = W.outKinds(src);
  if (kinds.length < 2) return plug(src, dst, kinds[0]);
  const framesOf = () => import('./frame-pick.js').then((m) => m.openFramePick(src, { title: `Frames of "${src.label}" for "${dst.label}"`,
    onPick: (times) => times.forEach((t) => plugWire(src, dst, { kind: 'image', frame: t })) }));
  openPressMenu(x, y, [kinds.map((k) => (k === 'image' && src.kind === 'video' ? { label: 'Frames of it…', run: framesOf } : { label: W.WIRE_LABEL[k], run: () => plug(src, dst, k) }))], 'Plug in as');
}
// src in the place of an input (a wire let go on its port), as one undo step: the same number, and the field it fills. A video going in as a
// picture asks which frame.
function replaceAt(src, id) {
  const w = wireById(id), dst = w && byId(w.to);
  if (!w || !dst) return toast('That input is gone');
  const put = (frame) => {
    const r = W.replaceWire(T.wires, id, { from: src.id, frame }, T.frames);
    if (r.why === 'wrong-kind') return toast(`${W.wireLabel(w)} takes ${w.kind === 'image' ? 'a picture' : w.kind === 'video' ? 'a clip' : 'a sound'}: "${src.label}" can't go there`, true);
    if (r.why) { const say = (WHY[r.why] || (() => 'That can\'t be plugged in there'))(src, dst); if (say) toast(say); return null; }
    return wireStep(r.wires);
  };
  if (w.kind === 'image' && src.kind === 'video') {
    return import('./frame-pick.js').then((m) => m.openFramePick(src, { title: `Frame of "${src.label}" for ${W.wireLabel(w)}`, multi: false, onPick: ([t]) => put(t) }));
  }
  return put(null);
}
// src plugged into dst as one undo step, and the wire. id: the wire's id, given where dst's make names it already. frame: a time or
// pick, for a picture out of a video. mp: the size its picture goes in at (0: its own size). Refused: a toast, and null.
export function plugWire(src, dst, { id = null, kind = null, frame = null, mp = null } = {}) {
  const r = W.addWire(T.wires, { from: src.id, to: dst.id, kind, id, frame }, T.frames);
  if (r.why) { toast((WHY[r.why] || (() => 'That can\'t be plugged in there'))(src, dst)); return null; }
  wireStep(mp == null ? r.wires : W.setWire(r.wires, r.wire.id, { mp }));
  return wireById(r.wire.id);
}
// the scrubber for a picture wire out of a video: which frame goes in
export function chooseWireFrame(id) {
  const w = wireById(id), src = w && byId(w.from);
  if (!src || !W.isFrameWire(w)) return;
  import('./frame-pick.js').then((m) => m.openFramePick(src, { title: `Frame of "${src.label}" for ${W.wireLabel(w)}`, multi: false, at: typeof w.frame === 'number' ? w.frame : 0,
    onPick: ([t]) => setTableWire(id, { frame: t }) }));
}
function removeWire(id) {
  if (wireStep(W.removeWires(T.wires, [id])) && U.wire === id) { U.wire = null; renderFrames(); }
}
// a wire's menu (right click or a long hold on it or its input port)
function wireMenu(x, y, id) {
  const w = wireById(id);
  if (!w) return;
  pickWire(id);
  const groups = [[{ label: w.on === false ? 'Turn on' : 'Turn off', run: () => setTableWire(id, { on: w.on === false }) }]];
  if (W.isFrameWire(w)) groups.push([...W.FRAME_PICKS.map((v) => ({ label: FRAME_PICK_LABEL[v], on: w.frame === v, run: () => setTableWire(id, { frame: v }) })),
    { label: 'Choose a frame…', on: typeof w.frame === 'number', run: () => chooseWireFrame(id) }]);
  groups.push([{ label: 'Remove', keys: 'Del', danger: true, run: () => removeWire(id) }]);
  openPressMenu(x, y, groups, W.wireLabel(w));
}
// for the Make pane (wave 2): the open table's wires; a frame's inputs, each with its source frame (wire-rules inputsFor
// order: image, video, sound, each by n); one wire changed ({ on, frame, n }: wire-rules setWire) as an undo step,
// returning the wire as it is now (null: not there)
export const tableWires = () => T.wires;
export const wiresInto = (frameId) => W.inputsFor(T.wires, frameId).map((w) => ({ ...w, source: byId(w.from) }));
export function setTableWire(id, patch) {
  if (!wireById(id)) return null;
  wireStep(W.setWire(T.wires, id, patch));
  return wireById(id);
}

// A few of a frame's own fields set (null / undefined takes the field off), saved with the table and, unless record is false,
// one undo step. Tells table:frame-field { frame, keys } (the frame's screen and the Make pane redraw). Returns the frame
// (null: not on this table). Used for the frame's main source (frame.main, main-rules.js).
export function setFrameField(frameId, patch, { record: rec = true } = {}) {
  const f = byId(frameId);
  if (!f || !patch || typeof patch !== 'object') return null;
  const keys = Object.keys(patch);
  const norm = (v) => (v === undefined || v === null ? undefined : v);
  if (keys.every((k) => norm(f[k]) === norm(patch[k]))) return f;
  const before = Object.fromEntries(keys.map((k) => [k, f[k]]));
  const put = (vals) => {
    const g = byId(frameId);
    if (!g) return;
    for (const k of keys) { const v = norm(vals[k]); if (v === undefined) delete g[k]; else g[k] = v; }
    frameChanged();
    dispatchEvent(new CustomEvent('table:frame-field', { detail: { frame: g, keys, table: T } }));
  };
  put(patch);
  if (rec) record({ undo: () => put(before), redo: () => put(patch) });
  return byId(frameId);
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
// ok: here() taken before whatever the caller awaited (default: now). fresh: a picture uploaded for the frame's document
// (frameFor), deleted when the frame isn't made: nothing else owns it
async function makeFrame(kind, rect, { payload, frame, fresh = null, ok = here(), select = true } = {}) {
  const f = frame || M.newFrame(kind, rect, { label: nextLabel(kind), ...(M.HAS_OUTPUT.has(kind) && { out: M.drawnOutput(rect) }) });
  if (kind !== 'note') {
    try { f.doc = await createDoc(f, payload); } catch (e) { toast(`Couldn't make the frame: ${e.message}`, true); dropInput(fresh); return null; }
    if (!ok()) { trashDoc(f).catch(() => {}); return null; }   // (another table opened meanwhile: the document goes too, and its picture with it)
  }
  if (!ok()) { dropInput(fresh); return null; }
  T.frames.push(f);
  if (select) U.sel = new Set([f.id]);
  renderFrames(); changed();
  recordAdd([f]);
  return f;
}
// a frame of 1 MP, square, in the middle of the view (a sound frame is a strip)
function newAtCentre(kind) {
  const { w, h } = stageSize(), c = M.toTable(T.view, w / 2, h / 2);
  const s = kind === 'sound' ? { w: 1024, h: 256 } : kind === 'note' ? { w: 480, h: 320 } : M.sizeForMp(1, 1, 1);
  return makeFrame(kind, { x: c.x - s.w / 2, y: c.y - s.h / 2, ...s });
}
// more(): the quick-start sheet for the same place (quick-start.js)
function kindMenu(x, y, make, label = 'New frame', more = null) {
  openPressMenu(x, y, [NEW_KINDS.map((k) => ({ label: M.KIND_LABEL[k], run: () => make(k) })),
    more ? [{ label: 'Quick start…', run: more }] : []].filter((g) => g.length), label);
}
// The quick-start sheet (quick-start.js) for a table point: { x, y, rect?, kind?, centre? }
export function quickStart(at) {
  return import('./quick-start.js').then((m) => m.openQuickStart(at)).catch((e) => toast(`Couldn't open the quick start: ${e.message}`, true));
}
// for quick-start.js: a new frame of a kind over rect (its document made from payload; extra: the frame's own fields,
// such as make, set before the table says it is selected; select: false leaves the selection as it is), and the grid
export function newFrameAt(kind, rect, { payload, extra = {}, select = true } = {}) {
  const f = M.newFrame(kind, rect, { label: nextLabel(kind), ...extra });
  return makeFrame(kind, f, { payload, frame: f, select });
}
export const tableGrid = () => ({ ...T.grid });

// Live: the frame's mount root fills the stage, in .live-layer (unscaled: engines work at 1:1), the table behind simply
// covered. Its first child is the live bar: the kind's icon, the name (tap to rename), the one full-screen button and ✕.
// The frame's module mounts its engine in the root under the bar; the engine's own full screen is what the bar's ⛶ and
// F work (layout.js fullScreenOf), its own button showing only while it is full screen (to leave it).
function placeLive() {
  const root = liveRoot();
  if (root) root.style.inset = '0px';
}
function liveBar(f, root) {
  const name = h('button', { type: 'button', class: 'live-bar-name', title: 'Rename' }, f.label || M.KIND_LABEL[f.kind]);
  name.addEventListener('click', () => renameLive(f, name));
  const full = h('button', { type: 'button', class: 'icon-btn live-bar-btn live-full', 'aria-label': 'Full screen (F)', title: 'Full screen (F)' }, '⛶');
  full.addEventListener('click', () => {
    const max = fullScreenOf(root);
    if (max) max.toggle(); else toast('Full screen comes once the frame has opened');
  });
  // (its layer list in a floating panel)
  const layersBtn = !FLOAT_KINDS.includes(f.kind) ? null : h('button', { type: 'button', class: `icon-btn live-bar-btn live-layers${layersFloating() ? ' on' : ''}`, 'aria-label': 'Layers in a floating panel', title: 'Layers in a floating panel' }, icon('rows'));
  layersBtn?.addEventListener('click', () => floatLayers(!layersFloating()));
  const unfloat = (e) => { if (!layersBtn?.isConnected) { removeEventListener('layers:float', unfloat); return; } layersBtn.classList.toggle('on', e.detail.on); };
  addEventListener('layers:float', unfloat);
  // (an image frame's red mask in its floating panel, float-mask.js)
  const maskBtn = f.kind !== 'image' ? null : h('button', { type: 'button', class: `icon-btn live-bar-btn live-mask${store.get('deck.mask.float', false) === true ? ' on' : ''}`, 'aria-label': 'Mask panel', title: 'Mask panel: paint the red mask' }, icon('brush'));
  maskBtn?.addEventListener('click', () => import('./float-mask.js').then((m) => (m.maskFloating() ? m.closeMask() : m.openMask())).catch((e) => toast(e.message, true)));
  const unmask = (e) => { if (!maskBtn?.isConnected) { removeEventListener('mask:float', unmask); return; } maskBtn.classList.toggle('on', e.detail.on); };
  if (maskBtn) addEventListener('mask:float', unmask);
  const close = h('button', { type: 'button', class: 'icon-btn live-bar-btn live-close', 'aria-label': 'Close (Esc)', title: 'Back to the table (Esc)' }, icon('close'));
  close.addEventListener('click', () => unlive());
  const bar = h('div', { class: 'live-bar', 'data-kind': f.kind },
    h('span', { class: 'live-bar-kind', 'aria-hidden': 'true' }, icon(KIND_ICON[f.kind])), name, h('span', { class: 'live-bar-gap' }), maskBtn, layersBtn, full, close);
  for (const ev of ['pointerdown', 'dblclick', 'wheel']) bar.addEventListener(ev, (e) => e.stopPropagation());
  // a module that empties the root (frame-image, frame-scene: replaceChildren) gets the bar back on top
  const keep = new MutationObserver(() => { if (root.firstChild !== bar) root.prepend(bar); });
  keep.observe(root, { childList: true });
  root.append(bar);
  return { bar, name, stop: () => keep.disconnect() };
}
function renameLive(f, btn) {
  const was = f.label || '', ok = here();
  const input = h('input', { type: 'text', class: 'live-bar-rename', value: was, maxLength: 120, 'aria-label': 'Name' });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (keep && v && v !== was && ok() && byId(f.id) === f) setName(f, v);
    btn.textContent = f.label || M.KIND_LABEL[f.kind];
    input.replaceWith(btn);
    U.panelSig = ''; renderFrames();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  btn.replaceWith(input);
  input.focus(); input.select();
}
// A double-click on a frame: it opens, or if nothing is in it and nothing is plugged into it, what to start it with (quick-start.js)
async function openOrStart(f) {
  if (f.kind === 'note' || T.wires.some((w) => w.to === f.id)) return goLive(f);
  const doc = f.doc ? await api(`/api/store/${M.DOC_KIND[f.kind]}/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false }).catch(() => null) : null;
  if (byId(f.id) !== f) return null;
  if (!docEmpty(f.kind, doc?.payload)) return goLive(f);
  return quickStart({ into: f });
}
export function goLive(f) {
  if (!f) return;
  if (f.kind === 'note') { U.els.get(f.id)?.querySelector('textarea')?.focus(); return; }
  if (liveFrame()?.id === f.id) return;
  unlive();
  cancelOp();
  pausePreviews();   // (the tiles' clips stop: the live frame has the screen)
  U.sel = new Set([f.id]);
  U.before = { ...T.view };
  const root = h('div', { class: 'frame-mount', 'data-frame': f.id, 'data-kind': f.kind });
  D.live.append(root);
  if (!setLive(f, root)) { root.remove(); U.before = null; return; }
  U.liveBar = liveBar(f, root);
  D.stage.classList.add('table-live');
  placeLive();
  renderFrames();
  dispatchEvent(new CustomEvent('table:live', { detail: { frame: f, root, table: T, handled: false } }));
}
// Resolves once the frame's module has saved (table:unlive wait); with nothing live, once the last one has
export function unlive() {
  const f = liveFrame();
  if (!f) return U.leaving;
  const root = liveRoot();
  exitMaxedIn(root);   // (a full screen inside it goes first: its stage is about to move)
  U.liveBar?.stop(); U.liveBar = null;
  const detail = { frame: f, root, wait: [] };
  dispatchEvent(new CustomEvent('table:unlive', { detail }));
  U.leaving = Promise.allSettled([U.leaving, ...detail.wait]).then(() => {});
  setLive(null); ORDER.clear();   // (the table's steps made meanwhile stay on its list, in their order)
  root?.remove();
  D.stage?.classList.remove('table-live');
  if (U.before) { setView(U.before, { save: false }); U.before = null; }
  renderFrames();
  refreshStills([f.kind]);   // (its still may have changed while it was open)
  return U.leaving;
}

// a video frame's old VFX document (frame.vfx: the Edit pane's full VFX panel kept one), as table-frames.js trashDoc /
// restoreDoc take it. A frame's VFX state is its own now (frame.ops): moveVfxDocs reads an old one in once and trashes it.
const vfxOf = (f) => ({ kind: 'vfx-tabs', doc: f.vfx, label: `${f.label || 'Video'} · VFX` });
async function moveVfxDocs() {
  const old = T.frames.filter((f) => f.kind === 'video' && f.vfx);
  if (!old.length) return;
  const ok = here(), qs = S.project != null ? `?project_id=${S.project}` : '';
  const { mergeOps, migrateVfxDoc } = await import('./vfx-rules.js');
  let moved = 0;
  for (const f of old) {
    let d = null;
    try { d = await api(`/api/store/vfx-tabs/${f.vfx}${qs}`, { busy: false }); } catch (e) { if (e.status !== 404) continue; }   // (not now: next time)
    if (!ok()) return;
    const id = f.vfx;
    if (d) f.ops = mergeOps(migrateVfxDoc(d.payload), f.ops);
    delete f.vfx; moved++;
    if (d && !T.frames.some((g) => g.vfx === id)) trashDoc(vfxOf({ ...f, vfx: id })).catch((e) => console.warn('old frame VFX', e));
  }
  if (moved && ok()) changed();
}

// Delete: the frames go, their documents to the server's trash; Undo brings both back. A locked frame stays. A frame
// whose document couldn't be trashed comes back; Undo brings back the ones whose document could be restored, into their
// own table (the one open, or saved to it on the server when another is open by then).
async function deleteFrames(ids) {
  const d = await takeOff(T.frames.filter((f) => ids.has(f.id) && !f.locked));
  if (!d) return;
  const { trashed, back, take, tid } = d;
  if (!trashed().length) return;
  const entry = { undo: back, redo: take };
  record(entry);
  undoToast(trashed().length === 1 ? `Deleted "${trashed()[0].label}"` : `Deleted ${trashed().length} frames`, () => {
    if (H.past.at(-1) === entry && U.tabs?.active?.id === tid) return undo();   // (the same step as Ctrl+Z: it can be redone)
    if (!byId(trashed()[0].id)) back();
  });
}
// The frames off the table as Delete takes them (their documents to the trash, their wires gone, a group they emptied
// kept for coming back): { take, back, trashed(), tid } once taken, null when nothing was. back() brings back the ones
// whose document could be restored, into their own table (the one open, or saved to it on the server when another is open by then).
async function takeOff(gone) {
  const ok = here(), tid = U.tabs?.active?.id;
  if (!gone.length) return null;
  if (gone.some((f) => f.id === liveFrame()?.id)) unlive();
  await U.leaving;   // (a live frame's last save lands before its document is trashed)
  if (!ok()) return null;
  const at = new Map(gone.map((f) => [f.id, T.frames.indexOf(f)])), hadGroups = T.groups.map((g) => ({ ...g }));
  let hadWires = T.wires;   // (the wires as they were before the frames went, to put theirs back in their places)
  const wiresBack = (list) => {
    const back = new Set(list.map((f) => f.id)), have = new Set(T.wires.map((w) => w.id));
    return hadWires.filter((w) => !have.has(w.id) && (back.has(w.from) || back.has(w.to)));
  };
  // (a group they emptied comes back with them, and their wires to frames still there)
  const putBack = (list) => {
    for (const f of [...list].sort((a, b) => at.get(a.id) - at.get(b.id))) if (!byId(f.id)) T.frames.splice(Math.min(at.get(f.id), T.frames.length), 0, f);
    for (const g of hadGroups) if (!T.groups.some((o) => o.id === g.id) && list.some((f) => f.group === g.id)) T.groups.push({ ...g });
    T.frames = ST.normalize(T.frames, T.groups);
    const add = wiresBack(list).filter((w) => byId(w.from) && byId(w.to));
    if (!add.length) return;
    const order = new Map(hadWires.map((w, i) => [w.id, i]));
    T.wires = W.renumber([...T.wires, ...add].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)));
    tellWires(add.flatMap((w) => [w.from, w.to]));
  };
  let trashed = [];
  const take = async () => {
    const still = here(), drop = new Set(gone.map((f) => f.id));
    const groupOf = new Map(gone.map((f) => [f.id, f.group]));
    T.frames = ST.normalize(T.frames.filter((f) => !drop.has(f.id)), T.groups);
    for (const f of gone) if (groupOf.get(f.id)) f.group = groupOf.get(f.id);   // (normalize left them be: they keep it for Undo)
    hadWires = T.wires;
    T.wires = W.dropFrames(T.wires, [...drop]);
    if (U.wire && !wireById(U.wire)) U.wire = null;
    U.sel.clear(); renderFrames(); changed();
    tellWires(wiresTouched(hadWires, T.wires));
    const res = await Promise.allSettled(gone.map(trashDoc));
    trashed = gone.filter((f, i) => res[i].status === 'fulfilled');
    for (const f of trashed) if (f.vfx) trashDoc(vfxOf(f)).catch((e) => console.warn('frame VFX', e));   // (a video frame's VFX document goes with it)
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
    await Promise.allSettled(fine.filter((f) => f.vfx).map((f) => restoreDoc(vfxOf(f))));
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
        // (their wires too: the table's migrate drops one whose other end has gone meanwhile)
        const haveW = new Set((p.wires || []).map((w) => w.id)), ids = new Set(fine.map((f) => f.id));
        p.wires = [...(p.wires || []), ...hadWires.filter((w) => !haveW.has(w.id) && (ids.has(w.from) || ids.has(w.to)))];
      });
      toast(fine.length === 1 ? `"${fine[0].label}" is back on its table` : `${fine.length} frames are back on their table`);
    } catch (e) { toast(`Couldn't put the frames back on their table: ${e.message}`, true); }
  };
  await take();
  return { take, back, trashed: () => trashed, tid };
}
// A frame just made (New frame, Quick start, a drop, Send to table, a result frame, Duplicate) as one undo step: Undo takes
// it off as Delete does (its document to the trash, where it still holds the runs it uses: storage.py), Redo brings it back.
// A frame still waiting for a result stays, with a toast: the run on its way lands in its document.
function recordAdd(made) {
  if (!made.length) return;
  const ids = made.map((f) => f.id);
  let d = null;
  record({
    adds: new Set(ids),
    async undo() {
      const list = ids.map(byId).filter(Boolean);
      if (!list.length) return;
      const owed = owedCounts(), busy = list.find((f) => (f.kind === 'image' && owed.get(f.doc)) || PENDING.get(f.doc));
      if (busy) { toast(`"${busy.label}" is still waiting for a result: undo once it has landed`, true); return false; }
      d = await takeOff(list);
    },
    async redo() { if (d) await d.back(); d = null; },
  });
}
// frames gone without a step (removeFrames): the steps that made them go too
function forgetAdds(ids) {
  const keep = (e) => !e.adds || ![...e.adds].some((id) => ids.has(id));
  for (const e of [...H.past, ...H.future]) if (!keep(e)) ORDER.drop(e);
  H.past = H.past.filter(keep); H.future = H.future.filter(keep);
  syncUndo();
}
// Frames made for a result that never came (an Edit run that failed before anything was queued): off the table, their
// documents to the trash, no undo step and no toast
export async function removeFrames(ids) {
  const drop = new Set(ids);
  const gone = T.frames.filter((f) => drop.has(f.id));
  if (!gone.length) return;
  forgetAdds(drop);   // (the step that made them has nothing to undo now)
  if (gone.some((f) => f.id === liveFrame()?.id)) { unlive(); await U.leaving; }
  T.frames = ST.normalize(T.frames.filter((f) => !drop.has(f.id)), T.groups);
  for (const f of gone) U.sel.delete(f.id);
  const hadWires = T.wires;
  T.wires = W.dropFrames(T.wires, [...drop]);
  if (U.wire && !wireById(U.wire)) U.wire = null;
  renderFrames(); changed();
  tellWires(wiresTouched(hadWires, T.wires));
  await Promise.allSettled(gone.map((f) => trashDoc(f)));
  for (const f of gone) if (f.vfx) trashDoc(vfxOf(f)).catch(() => {});
  dispatchEvent(new CustomEvent('table:deleted', { detail: { frames: gone } }));
}

// ---------------------------------------------------------------------------
// undo: steps of this table's own (where frames sit, their sizes, deletes); a document's own edits undo in its engine
// ---------------------------------------------------------------------------
function record(entry) {
  H.past.push(entry);
  if (H.past.length > 200) ORDER.drop(H.past.shift());
  H.future = [];
  if (isLive()) queueMicrotask(() => { if (H.past.includes(entry)) ORDER.made(entry, liveSig()); syncUndo(); });   // (after the step's own effects: wireStep records first)
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
    if (resized && liveFrame()?.id === f.id) placeLive();
  }
  U.sel = new Set(moved.map((f) => f.id));
  renderFrames(); changed();
  tellMoved(moved);
}
function recordGeom(before, after) {
  if (sameGeom(before, after)) return;
  record({ undo: () => applyGeom(before), redo: () => applyGeom(after) });
}
// (a step whose undo says false refused: it stays where it was)
async function undo() {
  const e = H.past.pop(); if (!e) return null; H.future.push(e); syncUndo();
  const ok = (await e.undo()) !== false;
  if (!ok && H.future.at(-1) === e) { H.future.pop(); H.past.push(e); }
  syncUndo(); return ok;
}
async function redo() {
  const e = H.future.pop(); if (!e) return null; H.past.push(e); syncUndo();
  const ok = (await e.redo()) !== false;
  if (!ok && H.past.at(-1) === e) { H.past.pop(); H.future.push(e); }
  syncUndo(); return ok;
}
// While a frame is live, Ctrl+Z and the undo pair reach its engine's history; a table step made meanwhile (the Output tab, the
// Make pane's pin, wires and fields, a result frame) goes in its place among the engine's steps (undo-order.js): it goes
// first when the engine is where it was just after it. True when a table step went.
const liveSig = () => { try { return liveUndoEntry()?.sig?.() ?? null; } catch { return null; } };
function liveStep(dir) {
  if (!isLive()) return false;
  const undoing = dir === 'undo', mine = undoing ? ORDER.top() : ORDER.next();
  if (!mine) return false;
  if (mine !== (undoing ? H.past : H.future).at(-1)) { ORDER.drop(mine); return liveStep(dir); }   // (no longer the table's next: forgotten)
  const eng = liveUndoEntry(), [cu, cr] = eng?.can?.() ?? [true, true], sig = liveSig();
  if ((undoing ? ORDER.undoBy(sig, cu) : ORDER.redoBy(sig, cr)) !== 'table') return false;
  const m = undoing ? ORDER.undone() : ORDER.redone();
  (undoing ? undo() : redo()).then((ok) => {
    if (ok === false) { if (undoing) ORDER.redone(); else ORDER.undone(); } else m.sig = liveSig();
    syncUndo();
  });
  return true;
}
// (on window, before the engines' own keys: paint.js and the 3D view take Ctrl+Z on document)
function onLiveUndoKey(e) {
  if (!isLive() || !onTable() || e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey) || ownsKey(e)) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  if (!liveStep(k === 'y' || e.shiftKey ? 'redo' : 'undo')) return;
  e.preventDefault(); e.stopImmediatePropagation();
}
// table:move, for the story table (its shot order follows where the frames are)
function tellMoved(frames) {
  if (frames.length) dispatchEvent(new CustomEvent('table:move', { detail: { frames, table: T } }));
}
// Duplicate: each copy beside its original, with a copy of its document (and its own op state, frame.ops). The Make panel's
// pictures (make.inputs) stay the original's: the copy's settings still name them, but deleting the copy, or its slot
// taking another picture, never deletes them.
// A wire between two of the frames copied is copied onto their copies (wire-rules remap). A main source (frame.main) stays:
// copyDoc copies the document as it is, so the copy's layer keys and item ids are the original's.
async function duplicateFrames(ids) {
  const made = [], ok = here(), idMap = new Map();
  const gone = (g) => { trashDoc(g).catch(() => {}); };
  for (const f of T.frames.filter((x) => ids.has(x.id))) {
    const g = { ...structuredClone(f), id: M.newFrame(f.kind, f).id, label: `${f.label} copy`, locked: false };
    g.key = g.id;
    if (g.make) { g.make = { ...g.make, inputs: [] }; delete g.make.ran; delete g.make.held; }   // (a copy has made nothing yet: a chain run never takes the original's results; the original's runs hold their own pictures)
    Object.assign(g, M.nextBeside([...T.frames, ...made], f.kind, { w: f.w, h: f.h }));
    try { g.doc = f.doc ? await copyDoc(f, g.label) : null; } catch (e) { toast(`Couldn't copy "${f.label}": ${e.message}`, true); continue; }
    delete g.vfx;   // (an old VFX document stays the original's: moveVfxDocs reads it into that frame)
    made.push(g); idMap.set(f.id, g.id);
    if (!ok()) break;
  }
  if (!made.length) return;
  if (!ok()) { for (const g of made) gone(g); return; }   // (another table opened meanwhile: the copies go)
  T.frames = ST.normalize([...T.frames, ...made], T.groups);   // (a copy of a member joins its group, at its top)
  const { wires: copied, ids: wireIds } = W.remapIds(T.wires, idMap);
  if (copied.length) T.wires = W.renumber([...T.wires, ...copied]);
  for (const g of made) if (g.make?.wired) g.make.wired = W.remapWired(g.make.wired, wireIds);   // (its re-pointed fields follow the copied wires)
  U.sel = new Set(made.map((f) => f.id)); U.wire = null; renderFrames(); changed();
  tellWires(copied.flatMap((w) => [w.from, w.to]));
  recordAdd(made);
}

// ---------------------------------------------------------------------------
// the stack: groups, hide, lock, z-order; each change one undo step (table-model.js stackSnap)
// ---------------------------------------------------------------------------
function stackStep(fn) {
  const before = M.stackSnap(T.frames, T.groups);
  fn();
  T.frames = ST.normalize(T.frames, T.groups);
  const after = M.stackSnap(T.frames, T.groups);
  if (!M.sameSnap(before, after)) record({ undo: () => putSnap(before), redo: () => putSnap(after) });
  U.panelSig = ''; renderFrames(); changed();
}
function putSnap(snap) {
  const r = M.applySnap(T.frames, snap);
  T.frames = r.frames; T.groups = r.groups;
  if (liveFrame()?.hidden) unlive();
  U.panelSig = ''; renderFrames(); changed();
}
// the selected frames in the order they were picked (Same size goes by the first)
const pickedList = () => [...U.sel].map(byId).filter(Boolean);
function setLocked(list, on) { stackStep(() => { for (const f of list) { if (on) f.locked = true; else delete f.locked; } }); }
function setHidden(list, on) {
  if (on && list.some((f) => f.id === liveFrame()?.id)) unlive();
  stackStep(() => { for (const f of list) { if (on) f.hidden = true; else delete f.hidden; } });
}
// H and L, and the menu: all of them on when any is off, else all off
const toggleHidden = (list = selected()) => list.length && setHidden(list, !list.every((f) => f.hidden));
const toggleLocked = (list = selected()) => list.length && setLocked(list, !list.every((f) => f.locked));
function restack(fn) { stackStep(() => { T.frames = fn(T.frames, [...U.sel]); }); }
const stepBy = (dir) => restack((fs, ids) => M.stepZ(fs, ids, dir));
function groupSelected() {
  const list = selected();
  if (list.length < 2) return;
  stackStep(() => { T.frames = ST.makeGroup(T.frames, T.groups, list, uid(), `Group ${T.groups.length + 1}`, {}); });
}
function ungroupSelected(ids = [...new Set(selected().map((f) => f.group).filter(Boolean))]) {
  if (!ids.length) return;
  stackStep(() => { for (const id of ids) T.frames = ST.ungroup(T.frames, T.groups, id); });
}
// Fit: the selected frames on show, else all of them
const fitSel = () => fit(M.shown(selected()).length ? M.shown(selected()) : M.shown(T.frames));
function fit(list = M.shown(T.frames), { animate = true } = {}) {
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
  fit(M.shown(T.frames).length ? M.shown(T.frames) : T.frames, { animate: false });
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
// the output size (the Output tab, Make's Size field): frames with a picture take this size, not a locked one, one undo step. The preview on
// the table takes the new shape. Resizing the frame on the table never comes here.
// ---------------------------------------------------------------------------
export function setOutputs(ids, { w, h: hh }) {
  const list = [...ids].map(byId).filter((f) => f && !f.locked && M.HAS_OUTPUT.has(f.kind));
  const steps = list.filter((f) => { const o = M.outputOf(f); return o.w !== w || o.h !== hh; })
    .map((f) => ({ id: f.id, was: { out: M.outputOf(f), w: f.w, h: f.h }, now: { out: { w, h: hh }, ...M.tileShape(f, { w, h: hh }) } }));
  if (!steps.length) return;
  const open = isLive() && steps.length === 1 && steps[0].id === liveFrame()?.id ? liveSig() : undefined;
  for (const s of steps) setFrameField(s.id, s.now, { record: false });
  // the open frame's own engine took the size as a step of its history (an image frame's canvas): that step is the undo. A second one here
  // would make Ctrl+Z bounce between the two.
  if (open !== undefined && liveSig() !== open) { syncUndo(); return; }
  record({ undo: () => { for (const s of steps) setFrameField(s.id, s.was, { record: false }); },
    redo: () => { for (const s of steps) setFrameField(s.id, s.now, { record: false }); } });
}

// How long these frames' runs come out (the Output tab), one undo step
export function setLengths(ids, secs) {
  const steps = [...ids].map(byId).filter((f) => f && !f.locked && f.len !== secs).map((f) => ({ id: f.id, was: f.len ?? null }));
  if (!steps.length) return;
  for (const s of steps) setFrameField(s.id, { len: secs }, { record: false });
  record({ undo: () => { for (const s of steps) setFrameField(s.id, { len: s.was }, { record: false }); },
    redo: () => { for (const s of steps) setFrameField(s.id, { len: secs }, { record: false }); } });
}

// ---------------------------------------------------------------------------
// the frame menu (right click, long hold)
// ---------------------------------------------------------------------------
// One menu for a frame on the table and its row in the Frame pane's list (layer-menu.js frameMenu says what's offered).
// f: the frame pressed (it, or the selection it is in, is what the menu acts on); none: the selection as it is.
function frameMenu(x, y, f = null) {
  if (f) U.sel = new Set(pickedFor(selected(), f).map((s) => s.id));
  renderFrames();
  const list = selected(), one = list.length === 1 ? list[0] : null;
  if (!list.length) return;
  const extra = [];   // (other modules' items: table:menu)
  dispatchEvent(new CustomEvent('table:menu', { detail: { frame: f || one || list[0], frames: list, groups: extra, table: T } }));
  const run = {
    open: () => goLive(one), rename: () => nameFrame(one), duplicate: () => duplicateFrames(new Set(U.sel)),
    group: groupSelected, ungroup: () => ungroupSelected(), hide: () => toggleHidden(list), lock: () => toggleLocked(list),
    front: () => restack(M.toFront), forward: () => stepBy(1), backward: () => stepBy(-1), back: () => restack(M.toBack),
    size: () => sidebar.show('output'), delete: () => deleteFrames(new Set(U.sel)),
  };
  const groups = frameMenuGroups({ selected: list.length, openable: !!one && one.kind !== 'note' && !one.hidden, grouped: list.some((s) => s.group),
    hidden: list.every((s) => s.hidden), locked: list.every((s) => s.locked), extra: extra.filter((g) => g?.length) });
  // Align ▸, Distribute ▸, Same size ▸: their part of Arrange as a submenu (press-menu.js `sub`)
  const parts = { align: ['align'], distribute: ['distribute', 'tidy'], size: ['size'] };
  openPressMenu(x, y, groups.map((g) => g.map((it) => (it.run || typeof it.sub === 'function' || Array.isArray(it.sub) ? it
    : typeof it.sub === 'string' ? { ...it, sub: arrangeGroups(parts[it.sub]) } : { ...it, run: run[it.id] }))), 'Frame');
}
function arrangeGroups(parts) {
  const all = frameArrangeMenu(), n = selected().filter((f) => !f.hidden).length;
  return parts.map((p) => all[p].map((it) => ({ ...it, disabled: n < 2, run: () => arrange(it.id) })));
}
// Arrange: what frameArrangeMenu offers, those parts of it (all of them from the bar's Arrange ▾)
function arrangeMenu(x, y, parts = ['align', 'distribute', 'tidy', 'size']) {
  openPressMenu(x, y, arrangeGroups(parts), 'Arrange');
}
// The selection (shown ones, in the order picked) aligned, spread, sized or tidied: one undo step, on the grid when it is on
function arrange(id) {
  const list = pickedList().filter((f) => !f.hidden);
  if (list.length < 2) return;
  const step = T.grid.on ? T.grid.size : 0, gap = T.grid.on ? T.grid.size : 40;
  const [what, how] = id.split(':');
  const out = what === 'align' ? M.alignFrames(list, how, { step })
    : what === 'spread' ? M.distributeFrames(list, how, { step })
      : what === 'centres' ? M.distributeFrames(list, how, { centres: true, step })
        : what === 'tidy' ? M.tidyRows(list, { mode: how, gap, step })
          : what === 'size' ? (how === 'largest' ? M.sameSize(list, 'both', { to: 'largest' }) : M.sameSize(list, how)) : null;
  if (!out) return;
  const ids = new Set(list.map((f) => f.id)), before = geomOf(ids);
  for (const g of out) {
    const f = byId(g.id), resized = f.w !== g.w || f.h !== g.h;
    Object.assign(f, { x: g.x, y: g.y, w: g.w, h: g.h });
    if (resized && liveFrame()?.id === f.id) placeLive();
  }
  recordGeom(before, geomOf(ids));
  renderFrames(); changed(); tellMoved(list);
}
function stageMenu(e) {
  cancelOp();
  if (isLive()) return;
  const onWire = e.target.closest?.('[data-wire]');
  if (onWire) return wireMenu(e.clientX, e.clientY, onWire.dataset.wire);
  const f = frameAt(e);
  if (f) return frameMenu(e.clientX, e.clientY, f);
  const r = D.stage.getBoundingClientRect(), p = M.toTable(T.view, e.clientX - r.left, e.clientY - r.top);
  const at = (k) => (k === 'sound' ? { w: 1024, h: 256 } : k === 'note' ? { w: 480, h: 320 } : M.sizeForMp(1, 1, 1));
  kindMenu(e.clientX, e.clientY, (k) => makeFrame(k, { ...p, ...at(k) }), 'New frame here', () => quickStart({ ...p }));
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
const othersOf = (ids) => M.shown(T.frames).filter((f) => !ids.has(f.id));
const snapThr = () => SNAP_PX / T.view.z;

function onDown(e) {
  if (e.target.closest?.('.frame-rename')) return;
  if (document.activeElement?.matches?.('.frame-rename')) document.activeElement.blur();
  if (inLive(e) || e.target.closest('.max-btn, .pull-tab, textarea')) return;
  if (e.pointerType === 'touch') {
    U.pts.set(e.pointerId, local(e));
    if (U.pts.size === 2) { U.lastEmpty = null; cancelOp(); U.op = isLive() ? null : { type: 'pinch', last: [...U.pts.values()] }; return; }
    if (U.pts.size > 2) return;
  }
  if (e.button === 2) return;   // (the menu comes with contextmenu)
  e.preventDefault();
  try { D.stage.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  const base = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
  const handle = e.target.closest('.frame-handle'), f = frameAt(e);
  const port = e.target.closest('.wire-out'), onWire = e.target.closest('[data-wire]'), runBtn = e.target.closest('.frame-run');
  if (isLive() || handle || f || port || onWire || runBtn || e.button !== 0 || U.space) U.lastEmpty = null;   // (only tap, tap on empty table counts)
  if (!isLive() && !onWire && U.wire && e.button === 0) pickWire(null);   // (anything else pressed lets go of the wire)
  if (isLive()) U.op = { ...base, type: 'backdrop' };   // (the table behind a live frame: a tap beside it lets go of it)
  else if (e.button === 1 || (e.button === 0 && U.space)) U.op = { ...base, type: 'pan', v0: { ...T.view } };
  else if (runBtn) U.op = { ...base, type: 'runtap', frame: runBtn.dataset.frame };
  else if (port) startWire(byId(port.dataset.frame), base);
  else if (onWire) { pickWire(onWire.dataset.wire); U.op = { ...base, type: 'wiretap' }; }
  else if (handle) {
    const r = byId([...U.sel][0]);
    U.op = { ...base, type: 'resize', f: r, start: { ...r }, handle: handle.dataset.handle };
  } else if (f) startMove(e, f, base);
  else U.op = { ...base, type: 'marquee', p0: tablePt(e), base: adds(e) ? new Set(U.sel) : new Set(), shift: adds(e) };
}
// a drag from an out port: a wire follows the pointer; let go over another frame to plug it in there
function startWire(src, base) {
  if (!src) return;
  U.op = { ...base, type: 'wire', src, over: null, pin: null };
  setHover(src.id);
}
function dragWire(e, op) {
  const p = tablePt(e), z = T.view.z;
  // (an input port under the pointer: it would take that port's place. The stage holds the pointer, so its target can't say)
  const pinEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.frame-in');
  const pin = pinEl && wireById(pinEl.dataset.wire)?.to !== op.src.id ? pinEl : null;
  const under = pin ? null : M.hitFrame(M.shown(T.frames).filter((f) => f.id !== op.src.id), p);
  if (pin !== op.pin) {
    op.pin?.classList.remove('wire-swap');
    pin?.classList.add('wire-swap');
    op.pin = pin;
  }
  if (under?.id !== op.over?.id) {
    U.els.get(op.over?.id)?.classList.remove('wire-over');
    op.over = under;
    if (under && under.kind !== 'note') U.els.get(under.id)?.classList.add('wire-over');
    showNextInput(op.src, under);
  }
  D.wireDraft.setAttribute('d', curve(outPt(op.src, portGeom(), z), p, z));
  D.wireDraft.setAttribute('class', `wire-draft k-${W.outKind(op.src) || 'image'}`);
  D.wireDraft.style.display = '';
}
// While a wire is held over a frame: where it would go in, under the inputs it has
function showNextInput(src, dst) {
  U.nextIn?.remove(); U.nextIn = null;
  if (!dst || dst.kind === 'note') return;
  const kinds = W.outKinds(src), have = T.wires.filter((w) => w.to === dst.id), pg = portGeom(), z = T.view.z, p = inPt(dst, have.length, pg, z);
  const word = kinds.length > 1 ? 'Add' : `${W.WIRE_LABEL[kinds[0]]} ${have.filter((w) => w.kind === kinds[0]).length + 1}`;
  U.nextIn = h('div', { class: `frame-in next k-${kinds[0]}` }, h('span', { class: 'frame-in-dot' }), h('span', { class: 'frame-in-label' }, word));
  U.nextIn.style.left = `${p.x}px`; U.nextIn.style.top = `${p.y}px`;
  D.ports.append(U.nextIn);
}
function endWireDraft(op) {
  if (D.wireDraft) D.wireDraft.style.display = 'none';
  U.els.get(op?.over?.id)?.classList.remove('wire-over');
  op?.pin?.classList.remove('wire-swap');
  U.nextIn?.remove(); U.nextIn = null;
}
function endWire(e, op) {
  endWireDraft(op);
  setHover(null);
  if (!op.moved) { U.sel = new Set([op.src.id]); renderFrames(); return; }   // (a tap on the port picks its frame)
  if (op.pin) return replaceAt(op.src, op.pin.dataset.wire);
  if (op.over) return plugAt(op.src, op.over, e.clientX, e.clientY);
  renderPorts();
  // (let go on empty table: what to start from it. Let go back on its own frame: nothing)
  const p = tablePt(e);
  if (!M.hitFrame(M.shown(T.frames), p)) import('./wire-panel.js').then((m) => m.openWirePanel(op.src, p)).catch((err) => toast(`Couldn't open the panel: ${err.message}`, true));
}
// (Shift or Ctrl adds to what is selected)
const adds = (e) => !!(e.shiftKey || e.ctrlKey || e.metaKey);
function startMove(e, f, base) {
  // a second tap on the same frame opens it, or on its label names it (a dblclick would land on the stage, which holds the pointer)
  if (!adds(e) && U.lastTap?.id === f.id && Date.now() - U.lastTap.t < DOUBLE_MS) {
    U.lastTap = null; U.op = null;
    if (e.target.closest('.frame-label')) nameFrame(f); else openOrStart(f);
    return;
  }
  if (adds(e)) {
    if (U.sel.has(f.id)) { U.sel.delete(f.id); renderFrames(); return; }
    U.sel.add(f.id);
  } else if (!U.sel.has(f.id)) U.sel = new Set([f.id]);
  renderFrames();
  const ids = new Set(selected().filter((s) => !s.locked && !s.hidden).map((s) => s.id));
  U.op = { ...base, type: 'move', ids, tap: f, start: new Map(T.frames.filter((s) => ids.has(s.id)).map((s) => [s.id, { x: s.x, y: s.y }])), p0: tablePt(e) };
}

function onMove(e) {
  if (U.pts.has(e.pointerId)) U.pts.set(e.pointerId, local(e));
  if (!U.op && e.pointerType !== 'touch' && !isLive()) setHover(e.target.closest?.('.wire-out')?.dataset.frame || frameAt(e)?.id || null);
  const op = U.op;
  if (op?.type === 'pinch') return pinch();
  if (!op || e.pointerId !== op.id) return;
  if (!op.moved && Math.hypot(e.clientX - op.x0, e.clientY - op.y0) < DRAG_PX) return;
  op.moved = true;
  if (op.type === 'pan') setView({ ...op.v0, x: op.v0.x + e.clientX - op.x0, y: op.v0.y + e.clientY - op.y0 }, { save: false });
  else if (op.type === 'move') dragMove(e, op);
  else if (op.type === 'resize') dragResize(e, op);
  else if (op.type === 'marquee') dragMarquee(e, op);
  else if (op.type === 'wire') dragWire(e, op);
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
  const hit = M.framesIn(M.shown(T.frames), r);
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
  if (op.type === 'wire') return endWire(e, op);
  if (op.type === 'wiretap') return;
  if (op.type === 'runtap') {
    if (!op.moved) import('./chain-run.js').then((m) => m.runNode(byId(op.frame))).catch((err) => toast(err.message, true));
    return;
  }
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
  if (!adds(e) && U.sel.size > 1) { U.sel = new Set([op.tap.id]); renderFrames(); }   // a tap in a selection picks that one
}
function endMarquee(e, op) {
  if (!op.moved) {
    U.sel = op.shift ? U.sel : new Set(); renderFrames();
    // a second tap on empty table, soon and near the first: the quick-start sheet there (a box or a pan in between
    // forgets the first tap)
    const t = Date.now(), last = U.lastEmpty;
    U.lastEmpty = null;
    if (!op.shift && last && t - last.t < DOUBLE_MS && Math.hypot(e.clientX - last.cx, e.clientY - last.cy) < DOUBLE_PX) quickStart({ x: last.p.x, y: last.p.y });
    else if (!op.shift) U.lastEmpty = { t, cx: e.clientX, cy: e.clientY, p: op.p0 };
    return;
  }
  U.lastEmpty = null;
  if (op.shift || M.framesIn(M.shown(T.frames), op.rect).length) return;
  // a box over nothing: a frame that size, of the kind picked (its corners on the grid when that's on)
  const g = (v, a) => M.snapValue(v, a, [], T.grid, 0, { edges: false });
  const r = op.rect, x = g(r.x, 'x'), y = g(r.y, 'y');
  const rect = { x, y, w: Math.max(M.MIN_SIDE, g(r.x + r.w, 'x') - x), h: Math.max(M.MIN_SIDE, g(r.y + r.h, 'y') - y) };
  kindMenu(e.clientX, e.clientY, (k) => makeFrame(k, rect), 'New frame', () => quickStart({ x: rect.x, y: rect.y, rect }));
}
// a gesture given up (a second finger, the menu, a cancelled pointer): whatever it moved goes back
function cancelOp(op = U.op) {
  U.op = null;
  showGuides(); if (D.marquee) D.marquee.style.display = 'none';
  if (!op) return;
  clearTimeout(op.dwellT);
  if (op.type === 'move') for (const [id, s] of op.start) Object.assign(byId(id) || {}, s);
  if (op.type === 'resize') Object.assign(op.f, op.start);
  if (op.type === 'wire') { endWireDraft(op); U.hover = null; }
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
  const low = k.toLowerCase(), any = U.sel.size > 0;
  let fn = null;
  if ((k === 'Delete' || k === 'Backspace') && U.wire) fn = () => removeWire(U.wire);
  else if (k === 'Delete' || k === 'Backspace') fn = () => deleteFrames(new Set(U.sel));
  else if (arrows[k] && any) fn = () => nudge(arrows[k]);
  else if (ctrl && (low === 'd' || low === 'j') && !e.shiftKey) fn = () => duplicateFrames(new Set(U.sel));
  else if (ctrl && low === 'a') fn = () => { U.sel = new Set(M.shown(T.frames).map((f) => f.id)); renderFrames(); };
  else if (ctrl && low === 'g') fn = () => (e.shiftKey ? ungroupSelected() : groupSelected());
  else if (ctrl && (e.code === 'BracketRight' || e.code === 'BracketLeft') && any) {   // (by code: Shift turns ] into })
    const up = e.code === 'BracketRight';
    fn = () => (e.shiftKey ? restack(up ? M.toFront : M.toBack) : stepBy(up ? 1 : -1));
  } else if (!ctrl && low === 'h' && !e.shiftKey && any) fn = () => toggleHidden();
  else if (!ctrl && low === 'l' && !e.shiftKey && any) fn = () => toggleLocked();
  // (F alone is full screen, as in every tab: layout.js fullScreen; Shift+F fits)
  else if (!ctrl && k === 'F' && e.shiftKey) fn = fitSel;
  else if (!ctrl && k === '0') fn = () => zoomTo(1);
  else if (!ctrl && k === 'Enter' && U.sel.size === 1) fn = () => goLive(selected()[0]);
  else if (!ctrl && k === 'F2' && U.sel.size === 1) fn = () => nameFrame(selected()[0]);
  if (!fn) return;
  e.preventDefault(); fn();
}
// The arrows move the selection a pixel (ten with Shift); a run of presses is one step to undo, and table:move goes once
// they stop
function nudge([dx, dy]) {
  const ids = new Set(selected().filter((f) => !f.hidden).map((f) => f.id)), key = [...ids].sort().join(',');
  if (!ids.size) return;
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
  else if (U.wire) pickWire(null);
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
  return M.hitFrame(M.shown(T.frames), M.toTable(T.view, clientX - r.left, clientY - r.top));
}
// Things dropped into a frame (table:drop-frame with sources): true when its module took them
export function dropOntoFrame(frame, list) {
  if (!frame || frame.kind === 'note' || !frame.doc) return false;
  const detail = { from: [], sources: [list].flat(), onto: frame, table: T, handled: false };
  dispatchEvent(new CustomEvent('table:drop-frame', { detail }));
  return detail.handled;
}
// The same, resolving once they are in
export async function addToFrame(frame, list) {
  const detail = { from: [], sources: [list].flat(), onto: frame, table: T, handled: false };
  dispatchEvent(new CustomEvent('table:drop-frame', { detail }));
  await detail.job;
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
    const f = await sourceFrameAt(src, at, ok);
    if (f === false) return;
    if (f) { made++; at = { x: f.x + f.w + 40, y: f.y }; }
  }
  if (made > 1) toast(`Added ${made} frames`);
}
// One dropped thing as a frame of its own, its top-left at the table point `at` (frameFor): the frame, null when it
// couldn't be made, false when another table opened meanwhile
export async function sourceFrameAt(src, at, ok = here()) {
  let got;
  try { got = await frameFor(src, at); } catch (err) { toast(err.message, true); return null; }
  if (!ok()) { dropInput(got?.fresh); return false; }   // (another table opened meanwhile: a picture uploaded for it goes)
  if (!got) { toast('That can\'t go on the table', true); return null; }
  got.frame.label = got.frame.label || nextLabel(got.frame.kind);
  const f = await makeFrame(got.frame.kind, got.frame, { ...got, ok });
  if (f && got.after) got.after(f);   // (a 3D frame's scene is filled once it is made: table-frames.js frameFor)
  return f;
}

// ---------------------------------------------------------------------------
// the sidebar's Frame pane: the frames, and the selected one's label, size, place and lock
// ---------------------------------------------------------------------------
function renderPanel() {
  const s = selected(), one = s.length === 1 ? s[0] : null;
  const sig = JSON.stringify([[...U.sel], T.groups, T.frames.map((f) => [f.id, f.label, f.w, f.h, f.locked, f.hidden, f.group, stillOf(f) || f.preview || '',
    ...(U.sel.has(f.id) ? [f.x, f.y, f.opacity] : [])])]);
  if (sig !== U.propsSig) { U.propsSig = sig; propsChanged('frames'); }   // (the Properties pane shows the selected frames' place and size)
  if (sig === U.panelSig || D.panel.contains(document.activeElement) && document.activeElement.matches('input')) return;
  U.panelSig = sig;
  D.panel.replaceChildren(
    section('Frames', null, help('Drag on empty table to make a frame there; double-tap empty table for the quick starts. Let a wire go on a frame to add an input, or on an input to replace it. Double-click the name above a frame, or press F2, to name it. Double-click a frame, or press Enter, to open it at full size (with nothing in it: what to start it with); Esc comes back. Wheel zooms, Space + drag pans, Shift+F fits, F is full screen. The list is the frames as layers, the top one drawn on top: drag a row by its grip to restack it, or onto a group\'s row to put it in the group. Shift-click a row for a range, Ctrl-click to add or drop one. Double-click a name to rename it. Right click a row or a frame, or hold a finger on it, for the rest. Keys: Ctrl+G groups, Ctrl+Shift+G ungroups, Ctrl+J duplicates, Ctrl+] and Ctrl+[ step up and down, with Shift to the top and bottom, H hides, L locks. A hidden frame keeps its place but is left out of the table, the box, Fit and a story\'s rows. Arrange on the bar lines up two or more frames, on the grid when it is on.'),
      ...(T.frames.length ? frameListArea() : [hint('No frames yet.')])),
    section('Frame', null, one ? frameFields(one) : hint(s.length ? `${s.length} frames selected` : 'Select a frame.')));
}
// The frames as the editor lists layers (ui.js layerRowsEl; layer-stack.js rowsOf, moveRow): top first, groups as rows.
// Over it: a search, the kinds to show and Selected only (frame-list.js says which rows show); a long list starts with
// its groups and a story's scenes folded.
function frameFinder() {
  const F = U.find;
  const relist = () => { D.listHost?.replaceChildren(frameList()); };
  const q = h('input', { type: 'search', class: 'frame-find', placeholder: 'Find frames', value: F.q, 'aria-label': 'Find frames by name or kind' });
  q.addEventListener('input', () => { F.q = q.value; relist(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ''; F.q = ''; relist(); } });
  const kinds = NEW_KINDS.filter((k) => T.frames.some((f) => f.kind === k));
  const chip = (label, on, fn, title) => {
    const b = h('button', { type: 'button', class: `chip frame-find-chip${on ? ' on' : ''}`, 'aria-pressed': String(!!on), title }, label);
    b.addEventListener('click', () => { fn(); b.classList.toggle('on'); b.setAttribute('aria-pressed', String(b.classList.contains('on'))); relist(); });
    return b;
  };
  return h('div', { class: 'frame-finder' }, q,
    h('div', { class: 'frame-find-chips' },
      kinds.length > 1 ? kinds.map((k) => chip(M.KIND_LABEL[k], F.kinds.has(k), () => { if (F.kinds.has(k)) F.kinds.delete(k); else F.kinds.add(k); }, `Only ${M.KIND_LABEL[k]} frames`)) : null,
      chip('Selected only', F.selOnly, () => { F.selOnly = !F.selOnly; }, 'Only the selected frames')));
}
function frameListArea() {
  D.listHost = h('div', { class: 'frame-list-host' }, frameList());
  return [T.frames.length > 8 ? frameFinder() : null, D.listHost];
}
function frameList() {
  const find = { ...U.find, sel: U.sel };
  const sceneName = (id) => {
    const f = T.frames.find((x) => x.story?.scene === id), at = f && U.story?.shotAt?.(f.story.shot);
    return at ? at.sc.slug || `Scene ${at.si + 1}` : null;
  };
  const rows = listRows(T.frames, T.groups, { find, sceneName, folded: (id) => U.fold.get(id) });
  const eff = foldedGroups(T.frames, T.groups);
  if (!rows.length) return hint(filtering(find) ? 'No frames match.' : 'No frames yet.');
  const thumbOf = (f) => {
    const url = stillOf(f) || f.preview || null;
    return url ? h('img', { src: url, alt: '', draggable: false, loading: 'lazy' }) : h('span', { class: 'frame-row-kind' }, icon(KIND_ICON[f.kind]));
  };
  const eye = (list) => {
    const off = list.every((f) => f.hidden);
    return iconBtn(off ? 'Show (H)' : 'Hide (H)', icon(off ? 'eyeoff' : 'eye'), () => setHidden(list, !off), { class: `icon-btn ico-btn${off ? ' on' : ''}` });
  };
  const lock = (list) => {
    const on = list.every((f) => f.locked);
    return iconBtn(on ? 'Unlock (L)' : 'Lock (L)', icon(on ? 'lock' : 'unlock'), () => setLocked(list, !on), { class: `icon-btn ico-btn${on ? ' on' : ''}` });
  };
  const groupRow = (g, members) => {
    const folded = !!eff.find((x) => x.id === g.id)?.collapsed;
    return {
      cls: 'frame-group-row', sel: members.length > 0 && members.every((f) => U.sel.has(f.id)), off: members.every((f) => f.hidden),
      onclick: (ev) => rowTap(ev, { group: g, members }),
      thumb: h('span', { class: 'layer-group-mark' }, icon('copy')), name: g.name, hint: `${members.length} frames`,
      buttons: [iconBtn(folded ? 'Open the group' : 'Fold the group', icon(folded ? 'right' : 'chevdown'), () => stackStep(() => { g.collapsed = !folded; })),
        lock(members), eye(members), iconBtn('Ungroup (Ctrl+Shift+G)', icon('close'), () => ungroupSelected([g.id]))],
    };
  };
  const sceneRow = (sc, members) => ({
    cls: 'frame-group-row frame-scene-row', sel: members.length > 0 && members.every((f) => U.sel.has(f.id)), off: members.every((f) => f.hidden),
    onclick: (ev) => rowTap(ev, { members }),
    thumb: h('span', { class: 'layer-group-mark' }, icon('film')), name: sc.name, hint: `${members.length} frame${members.length === 1 ? '' : 's'}`,
    buttons: [iconBtn(sc.folded ? 'Open the scene' : 'Fold the scene', icon(sc.folded ? 'right' : 'chevdown'), () => { U.fold.set(sc.id, !sc.folded); D.listHost?.replaceChildren(frameList()); }),
      lock(members), eye(members)],
  });
  const reorder = !filtering(find);
  const list = layerRowsEl(rows.map((r) => (r.group ? groupRow(r.group, r.members) : r.scene ? sceneRow(r.scene, r.members) : {
    cls: `frame-row${r.in ? ' in-group' : ''}`, sel: U.sel.has(r.layer.id), off: !!r.layer.hidden,
    onclick: (ev) => rowTap(ev, { frame: r.layer }),
    thumb: thumbOf(r.layer),
    name: [icon(KIND_ICON[r.layer.kind]), h('span', { class: 'frame-row-label' }, r.layer.label)],
    hint: `${r.layer.w}×${r.layer.h}${r.layer.hidden ? ' · hidden' : ''}`,
    buttons: [lock([r.layer]), eye([r.layer])],
  })), { onReorder: reorder ? (from, to) => {
    const a = rows[from]?.real, b = rows[to]?.real;
    if (a == null || b == null) return;
    stackStep(() => { T.frames = ST.moveRow(T.frames, eff, a, b); });
  } : null });
  [...list.children].forEach((el, i) => { el.dataset.row = rows[i].group ? `g:${rows[i].group.id}` : rows[i].scene ? `s:${rows[i].scene.id}` : rows[i].layer.id; });
  pressMenu(list, (e) => {
    const it = rows[[...list.children].indexOf(e.target.closest('.layer-row'))];
    if (it?.group || it?.scene) U.sel = new Set(it.members.map((f) => f.id));
    frameMenu(e.clientX, e.clientY, it?.layer || null);
  }, { ok: (e) => !e.target.closest('button, .layer-grip, input') });
  return list;
}
// the selected frame's row in view (table:select; a row tapped in the list is in view already, so it stays put)
function showSelectedRow() {
  D.listHost?.querySelector('.layer-row.sel')?.scrollIntoView({ block: 'nearest' });
}
// A tap on a row: Shift picks the range from the last row tapped, Ctrl (or Alt) adds or drops it, else it alone (and
// in view). The same row tapped again soon: on its name, rename it; elsewhere, open it. A group's row picks its members.
function rowTap(ev, { frame: f = null, group: g = null, members = [] }) {
  const id = f ? f.id : g ? `g:${g.id}` : `s:${members[0]?.story?.scene}`, now = Date.now(), again = U.rowTap?.id === id && now - U.rowTap.t < DOUBLE_MS;
  U.rowTap = again ? null : { id, t: now };
  if (again && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
    if (ev.target.closest?.('.layer-name')) return renameRow(id);
    if (f && f.kind !== 'note' && !f.hidden) return goLive(f);
    return;
  }
  const these = f ? [f] : members;
  if (ev.shiftKey && U.anchor && byId(U.anchor)) {
    const range = ST.rangeOf(T.frames, byId(U.anchor), these[these.length - 1]);
    U.sel = new Set([...range, ...these].map((x) => x.id));
  } else if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    const all = these.every((x) => U.sel.has(x.id));
    for (const x of these) { if (all) U.sel.delete(x.id); else U.sel.add(x.id); }
  } else {
    U.sel = new Set(these.map((x) => x.id));
    const shownOnes = M.shown(these);
    if (shownOnes.length && !isLive()) { if (f) reveal(f); else selectFrames(shownOnes.map((x) => x.id), { scroll: true }); }
  }
  if (f) U.anchor = f.id;
  renderFrames();
}
// A row's name typed over (a frame's renames its document too; a group's is the group's own)
// A frame's name changed: its document's follows
// (one undo step: Undo puts the old name back on both)
function setName(f, v) {
  const id = f.id, was = f.label;
  const put = (label) => {
    const g = byId(id);
    if (!g) return;
    g.label = label; U.panelSig = ''; renderFrames(); changed();
    renameDoc(g, label).catch((e) => toast(`Couldn't rename its document: ${e.message}`, true));
  };
  put(v);
  if (was !== v) record({ undo: () => put(was), redo: () => put(v) });
}
// A note's text typed from its focus to its blur, as one undo step (while it is typed in, the box's own undo works)
function textStep(id, was, now) {
  if (was === now) return;
  const put = (t) => {
    const f = byId(id);
    if (!f) return;
    f.text = t; changed();
    const ta = U.els.get(id)?.querySelector('textarea.frame-text');
    if (ta && ta.value !== t) ta.value = t;
  };
  record({ undo: () => put(was), redo: () => put(now) });
}
// Name a frame: typed over its label on the table, or in the Frame pane's list when its tile can't be seen
export function nameFrame(f) {
  const el = U.els.get(f?.id), name = el?.querySelector('.frame-name');
  const r = name?.getBoundingClientRect(), box = D.stage.getBoundingClientRect();
  if (isLive() || f.hidden || !r || r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return renameRow(f.id);
  el.querySelector('.frame-rename')?.remove();
  const was = f.label || '', ok = here();
  const input = h('input', { type: 'text', class: 'frame-rename', value: was, maxLength: 120, 'aria-label': 'Name' });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove(); name.classList.remove('hidden');
    if (keep && v && v !== was && ok() && byId(f.id) === f) setName(f, v);
    U.panelSig = ''; renderFrames();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  name.classList.add('hidden'); name.after(input);
  setTimeout(() => { if (!done) { input.focus(); input.select(); } }, 0);   // (after the press that asked for it has finished)
}
function renameRow(id) {
  if (sidebar.current() !== 'frame') sidebar.show('frame');
  const row = D.panel.querySelector(`.layer-row[data-row="${CSS.escape(id)}"] .layer-name`);
  const g = id.startsWith('g:') ? T.groups.find((x) => `g:${x.id}` === id) : null, f = g ? null : byId(id);
  if (!row || (!g && !f)) return;
  const was = g ? g.name : f.label, ok = here();
  const input = h('input', { type: 'text', class: 'frame-row-rename', value: was, maxLength: 120, 'aria-label': 'Name' });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (keep && v && v !== was && ok()) {
      if (g) stackStep(() => { g.name = v; });
      else if (byId(f.id) === f) setName(f, v);
    }
    input.blur();
    U.panelSig = ''; renderFrames();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  row.replaceChildren(input);
  input.focus(); input.select();
}
// The one selected frame's actions. Its name, place, size, opacity, resolution, lock and hide are the Properties pane's
// (framesProps below); what it comes out at is the Output tab's (output-panel.js).
function frameFields(f) {
  return [
    h('div', { class: 'row wrap' }, f.kind !== 'note' ? button('Open', () => goLive(f), { cls: 'small primary' }) : null,
      button('Duplicate', () => duplicateFrames(new Set([f.id]))),
      button('Delete', () => deleteFrames(new Set([f.id])), { cls: 'small ghost danger', disabled: !!f.locked }))];
}

// ---------------------------------------------------------------------------
// the Properties pane's rows for frames on the table (web/props-panel.js; props-rules.js says which show). Several frames:
// one edit goes to all of them, as one undo step; a locked frame keeps its place and size.
// ---------------------------------------------------------------------------
// frames placed or sized by fn(frame) → { x?, y?, w?, h? }: one undo step; a live frame's module takes a new size at once
function setGeomAll(list, fn) {
  const ids = new Set(list.map((f) => byId(f.id)).filter((f) => f && !f.locked).map((f) => f.id));   // (by id: a move may have made new objects)
  if (!ids.size) return;
  const before = geomOf(ids), moved = [];
  for (const f of T.frames) {
    if (!ids.has(f.id)) continue;
    const was = [f.w, f.h];
    Object.assign(f, fn(f)); moved.push(f);
    if (liveFrame()?.id === f.id) {
      placeLive();
    }
  }
  recordGeom(before, geomOf(ids));
  renderFrames(); changed(); tellMoved(moved);
}
// a frame field set on several frames (setFrameField each), one undo step for them all
export function setFramesField(ids, patch) {
  const list = [...ids].map(byId).filter(Boolean);
  if (list.length === 1) return setFrameField(list[0].id, patch);
  const keys = Object.keys(patch), before = new Map(list.map((f) => [f.id, Object.fromEntries(keys.map((k) => [k, f[k] ?? null]))]));
  for (const f of list) setFrameField(f.id, patch, { record: false });
  record({ undo: () => { for (const [id, p] of before) setFrameField(id, p, { record: false }); },
    redo: () => { for (const f of list) setFrameField(f.id, patch, { record: false }); } });
  return list;
}
function renameFrame(was, v) {
  const f = byId(was.id);
  if (!f) return;
  setName(f, String(v).trim() || M.KIND_LABEL[f.kind]);   // (its document's name follows: the document bar and pickers show the frame's name)
}
// what the frame's document is made at: an image's canvas (and its megapixels), a video's sequence size and frame rate,
// a sound's length (read from its saved document)
// a sound frame's length (a picture's size is the Output tab's)
function resolutionRow(f, list = [f]) {
  const ok = here(), text = h('span', { class: 'props-res' }, `${f.w}×${f.h}`);
  const later = (fill) => fill().then((s) => { if (ok()) text.textContent = s; }).catch(() => {});
  const docOf = () => api(`/api/store/${M.DOC_KIND[f.kind]}/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false });
  if (f.kind === 'sound') {
    text.textContent = '…';
    if (f.doc) later(async () => `${mixLength((await docOf())?.payload?.items).toFixed(2)} s`);
    return field('Length', text);
  }
  return null;
}
function framesRows(ctx, ids) {
  const list = framesPicked(ctx), one = list.length === 1 ? list[0] : null;
  const all = (k, d = null) => shared(list.map((f) => f[k] ?? d));
  const fresh = () => list.map((f) => byId(f.id)).filter(Boolean);   // (the frames as they are now, when an edit lands)
  const free = list.filter((f) => !f.locked), still = !free.length;
  const pos = (k, label) => ({ id: k, label, group: 'Place', get: () => all(k), step: T.grid.on ? T.grid.size : 1, disabled: still,
    set: (v) => setGeomAll(list, () => ({ [k]: snapNum(v, T.grid) })) });
  return [
    pos('x', 'X'), pos('y', 'Y'),
    { id: 'opacity', label: 'Opacity', group: 'Look', get: () => all('opacity', 1), min: 0, max: 1, step: 0.01, digits: 2,
      set: (v) => setFramesField(list.map((f) => f.id), { opacity: v >= 1 ? null : v }) },
    ids.includes('resolution') ? { id: 'resolution', label: 'Resolution', group: 'Look', el: resolutionRow(list[0], list) } : null,
    one ? { id: 'name', label: 'Name', type: 'text', group: 'Frame', get: () => one.label, set: (v) => renameFrame(one, v) } : null,
    { id: 'lock', label: 'Locked', type: 'toggle', group: 'Frame', get: () => shared(list.map((f) => !!f.locked)), set: (on) => setLocked(fresh(), on) },
    { id: 'hide', label: 'Hidden', type: 'toggle', group: 'Frame', get: () => shared(list.map((f) => !!f.hidden)), set: (on) => setHidden(fresh(), on) },
  ].filter(Boolean);
}
// the selected frames; a live frame with nothing picked in it is the one selected
const framesPicked = () => { const s = selected(); return s.length ? s : liveFrame() && byId(liveFrame().id) ? [byId(liveFrame().id)] : []; };
registerProps('frames', {
  picked: framesPicked,
  title: (ctx, list) => (list.length === 1 ? list[0].label || M.KIND_LABEL[list[0].kind] : `${list.length} frames`),
  rows: framesRows,
});

// ---------------------------------------------------------------------------
// the bar over the table: fit, 100%, the grid and snapping, a new frame, the zoom
// ---------------------------------------------------------------------------
function buildBar() {
  const gridChip = gzChip('▦ Grid', () => { T.grid.on = !T.grid.on; gridChip.classList.toggle('on', T.grid.on); applyView(); changed(); },
    { on: T.grid.on, title: 'Snap frames to the grid' });
  const gridSize = h('select', { 'aria-label': 'Grid size', onchange: () => { T.grid.size = +gridSize.value; applyView(); changed(); } },
    [16, 32, 64, 128, 256].map((v) => h('option', { value: v }, `${v} px`)));
  D.syncBar = () => { gridChip.classList.toggle('on', !!T.grid.on); gridSize.value = String(T.grid.size); };
  const newBtn = button('＋ New frame ▾', () => {
    const r = newBtn.getBoundingClientRect(), { w, h: hh } = stageSize();
    kindMenu(r.left, r.bottom + 4, newAtCentre, 'New frame', () => quickStart({ ...M.toTable(T.view, w / 2, hh / 2), centre: true }));
  });
  const arrangeBtn = button([icon('rows'), 'Arrange ▾'], () => {
    const r = arrangeBtn.getBoundingClientRect();
    arrangeMenu(r.left, r.bottom + 4);
  }, { title: 'Align, spread, size or tidy the selected frames (two or more)' });
  D.syncArrange = () => { arrangeBtn.disabled = selected().filter((f) => !f.hidden).length < 2 || isLive(); };
  const PREVIEW = [['hover', 'On hover'], ['always', 'Always'], ['off', 'Off']];
  const previewBtn = button('Previews ▾', () => {
    const r = previewBtn.getBoundingClientRect(), now = previewMode();
    openPressMenu(r.left, r.bottom + 4, [PREVIEW.map(([m, label]) => ({ label, on: m === now, run: () => setPreviewMode(m) }))], 'Previews');
  }, { title: 'When video and sound frames play their preview on the table' });
  const samplingChip = gzChip('Sampling preview', () => setSamplerPreview(!samplerPreview()), { on: samplerPreview(), title: 'Show a run as it samples' });
  onSamplerPreview((on) => samplingChip.classList.toggle('on', on));
  const windowChip = gzChip('Preview window', () => setPreviewWindow(!previewWindow()), { on: previewWindow(), title: 'Show the sampling preview in a floating window, not in its frame' });
  onPreviewWindow((on) => windowChip.classList.toggle('on', on));
  D.zoom = h('button', { type: 'button', class: 'btn small ghost table-zoom', title: 'Zoom: tap for 100%', onclick: () => zoomTo(1) }, '100%');
  D.bar = h('div', { class: 'table-bar' },
    button('Fit', fitSel, { title: 'Fit all, or the selected frames (Shift+F)' }),
    button('100%', () => zoomTo(1), { title: 'Zoom to 100% (0)' }),
    gridChip, gridSize, snapBar(['edges'], () => {}), newBtn, arrangeBtn, previewBtn, samplingChip, windowChip,
    info('Sampling preview shows a run as it samples: a moving clip for video, a still for images. Off, ComfyUI makes no previews at all, which saves a little on every step. A run already going keeps what it started with. Preview window puts it in a floating window you can drag and resize; it comes up with a run\'s first picture and goes when the run ends. Off, the preview shows inside the run\'s own frame, and the small step line has a button that brings the window back.'),
    h('span', { class: 'table-bar-gap' }), D.zoom);
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
  D.wires = svgEl('svg', { class: 'table-wires', 'aria-hidden': 'true' });   // (first: under the frames, riding the pan and zoom)
  D.wireDraft = svgEl('path', { class: 'wire-draft', style: 'display:none' });
  D.wires.append(D.wireDraft);
  D.ports = h('div', { class: 'table-ports' });
  D.world = h('div', { class: 'table-world' }, D.wires, D.frames, D.ports, D.guides, D.marquee, D.handles);
  D.live = h('div', { class: 'live-layer' });   // (a live frame's mount: over the stage, outside the zoomed world)
  D.stage.append(D.world, D.live);
  buildBar();
  D.tab.querySelector('.stage').prepend(D.bar);
  fullScreen(D.tab, { viewer: D.stage, title: 'Full screen table' });
  D.stage.addEventListener('pointerdown', onDown);
  D.stage.addEventListener('pointermove', onMove);
  D.stage.addEventListener('pointerup', onUp);
  D.stage.addEventListener('pointercancel', onUp);
  D.stage.addEventListener('pointerleave', () => { if (!U.op) setHover(null); });
  D.stage.addEventListener('wheel', onWheel, { passive: false });
  D.stage.addEventListener('dragover', onDragOver);
  D.stage.addEventListener('dragleave', (e) => { if (!D.stage.contains(e.relatedTarget)) hoverDrop(null); });
  D.stage.addEventListener('drop', onDrop);
  pressMenu(D.stage, stageMenu, { ok: (e) => !isLive() && !e.target.closest?.('.max-btn, .pull-tab, .wire-out, .frame-run') });
  document.addEventListener('keydown', onKey);
  addEventListener('keydown', onLiveUndoKey, true);
  setLiveSteps({ undo: () => liveStep('undo'), redo: () => liveStep('redo'), can: () => ORDER.can() });
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
    noteRev(kind, m.id, m.rev);
    clearTimeout(stillT); stillT = setTimeout(() => refreshStills([kind]), 300);
  });
  onProject(() => unlive());   // (the TabSet loads the project's tables itself)
  // a result waiting for an image frame's document (imagetools.js keeps them in deck.imagetools.owed): its badge follows
  let owedT = 0;
  const owedSoon = () => { clearTimeout(owedT); owedT = setTimeout(renderFrames, 200); };
  onServer('deck_generation', owedSoon);
  addEventListener('storage', (e) => { if (e.key === 'deck.imagetools.owed') owedSoon(); });
  addEventListener('edit:pending', (e) => {
    const { doc, n } = e.detail || {};
    if (doc == null) return;
    if (n > 0) PENDING.set(doc, n); else PENDING.delete(doc);
    owedSoon();
  });
  addEventListener('table:select', () => { if (!isLive()) requestAnimationFrame(showSelectedRow); });
  import('./frame-menu.js').catch((e) => console.warn('frame menu', e));   // (Edit ▸, Make from this note, Compare, Open in …: table:menu)
  import('./story.js').then((m) => { U.story = m; }).catch(() => {});   // (a story table's scene names, for the list)
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
// A copy of a table beside it: the server copies it with a copy of each document its frames own (two frames never share
// one: deleting one would take the other's), their VFX documents too, and leaves a story with its own table
async function duplicateTable(id) {
  if (!(await switchTable(id))) return;
  await U.tabs.duplicate();   // (its leave() lets go of a live frame first: beforeLeave; its last save is in the copy)
}
// another screen came on: let go of the live frame and any gesture
export function pauseTable() {
  if (!U.wired) return;
  cancelOp(); closePressMenu(); unlive(); pausePreviews();
  U.space = false;
}
