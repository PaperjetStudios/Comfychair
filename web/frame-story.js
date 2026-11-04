// A story as a table: a table whose payload says `story: <story-tabs id>` lays that story out, a row per scene (a note
// with the scene's heading and summary, then its shots left to right), an image frame per shot. A shot's frame owns the
// shot's edit (s.doc, made once from the shot's old canvas s.comp); story.js keeps the story, this module keeps the
// table and the story in step (shot-rows.js has the rules):
//   - the story changed (a shot added, moved or deleted in the outline): missing frames are made, frames for shots
//     that are gone go (their edits to the trash), and the rows are laid again
//   - frames moved on the table (table:move): the rows say the scenes' and shots' order, the story follows, the rows
//     are laid again; a shot's frame deleted on the table deletes the shot (Undo on the table brings both back);
//     a shot's frame duplicated (Ctrl+D) is a copy of the shot
//   - a run queued for a shot's frame from the Make panel (make:queued) waits on the shot as story.js's own runs do,
//     so its pictures and clips land in the shot's frames and clips too (story.js settle / catchUp)
// The table's sidebar gets a Story pane: the story's outline, script and characters, the selected shot's fields, its
// Redraw and Make video, and To video (a video frame beside the rows with the chosen frames and clips on it).
import { h, api, store, toast, button, section, seg, hint, icon, uid, clone } from './ui.js';
import { S, CURRENT_EDIT, onServer, onProject } from './core.js';
import * as Table from './table.js';
import * as M from './table-model.js';
import { blankPayload, createDoc, copyDoc, loadStills, renameDoc, restoreDoc, stillOf, trashDoc } from './table-frames.js';
import { BLANK as COMP_BLANK } from './editor-engine.js';
import { sidebar } from './sidebar.js';
import { isLive } from './live.js';
import { onCharacters } from './characters.js';
import { uploadImage } from './media.js';
import { canvasRect, withClip } from './make-rules.js';
import { landMade, owedTo } from './imagetools.js';
import * as St from './story.js';
import * as R from './shot-rows.js';

const FS = {
  pid: undefined, tableId: null, storyId: null, storyOf: new Map(),   // the open table, its story; story id per table id
  seen: new Map(),      // shot id -> the frame id it had on this table at the last reconcile
  stash: new Map(),     // shot id -> { scene, i, s }: shots taken off with their frame (Undo on the table puts them back)
  laid: new Map(),      // frame id -> { x, y } where the last layout put it
  chain: Promise.resolve(), timer: 0, rows: false, relay: false, down: false, wantSel: null, stills: new Set(),
  named: new Set(),     // frame ids whose document's name was checked against their label since the table opened
  view: store.get('deck.storyPane.view', 'outline'), pane: null, drawT: 0,
};
const VIEWS = [['outline', 'Outline'], ['script', 'Script'], ['cast', 'Characters']];
if (!VIEWS.some(([v]) => v === FS.view)) FS.view = 'outline';
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const frames = () => (typeof Table.tableFrames === 'function' ? Table.tableFrames() : []);
const storyOpen = () => !!FS.storyId && St.storyTabs()?.active?.id === FS.storyId;
const frameOfShot = (id) => frames().find((f) => R.isShotFrame(f) && f.story.shot === id) || null;
const shotNum = (at) => `${at.si + 1}.${at.i + 1}`;

// ---------------------------------------------------------------------------
// which table is open: table.js has no "a table opened" event yet, so the tables TabSet's remembered tab is read
// (tabs.js keeps it as deck.tab.tables.<project>) when the frames change, the selection changes, and now and then
// ---------------------------------------------------------------------------
function reset() {
  FS.tableId = null; FS.storyId = null; FS.seen = new Map(); FS.stash = new Map(); FS.laid = new Map(); FS.wantSel = null; FS.named = new Set();
}
async function detect(table = null) {
  if (S.project !== FS.pid) { FS.pid = S.project; FS.storyOf.clear(); reset(); }
  const tid = store.get(`deck.tab.tables.${S.project ?? 'none'}`, null);
  if (!tid) return setTable(null, null);
  // (the event's table, when it is the open one and says its story: at start-up an event can carry the blank table
  // the open one is loaded into, so only a story it names is taken; anything else is asked of the server once)
  if (table?.story && table.frames === frames()) FS.storyOf.set(tid, table.story);
  if (!FS.storyOf.has(tid)) {
    let d = null;
    try { d = await api(`/api/store/tables/${tid}${qs()}`, { busy: false }); } catch { /* not saved yet, or gone */ }
    if (store.get(`deck.tab.tables.${S.project ?? 'none'}`, null) !== tid) return;   // (another table meanwhile)
    FS.storyOf.set(tid, d?.payload?.story || null);
  }
  setTable(tid, FS.storyOf.get(tid));
}
function setTable(tid, storyId) {
  if (tid === FS.tableId && storyId === FS.storyId) return;
  reset();
  FS.tableId = tid; FS.storyId = storyId || null;
  sidebar.refresh();
  drawPane();
  if (FS.storyId) soon(0);
}

// ---------------------------------------------------------------------------
// keeping the table and the story in step (one at a time)
// ---------------------------------------------------------------------------
function soon(ms = 150, { rows = false } = {}) {
  if (rows) FS.rows = true;
  clearTimeout(FS.timer);
  FS.timer = setTimeout(() => { FS.chain = FS.chain.then(reconcile).catch((e) => console.error('story table', e)); }, ms);
}

async function openStory() {
  const t = St.storyTabs();
  if (!t || !FS.storyId) return false;
  try { await t.ready(); } catch { /* it says why */ }
  if (t.active?.id !== FS.storyId) await t.switchTo(FS.storyId);
  return t.active?.id === FS.storyId;
}

const editDocs = async () => new Set((await api(`/api/store/edit-tabs${qs()}`, { busy: false })).map((r) => r.id));
const shotLabel = (at) => { const w = at.s.what.trim().replace(/\s+/g, ' '); return `${shotNum(at)}${w ? ` ${w.length > 40 ? `${w.slice(0, 39)}…` : w}` : ''}`; };
// A shot's edit: a copy of the one it was duplicated from, else its old canvas (s.comp), else a blank white one
async function shotDoc(at, have) {
  const { s } = at, label = shotLabel(at);
  if (s.docFrom && have.has(s.docFrom)) return copyDoc({ kind: 'image', doc: s.docFrom }, label);
  const size = R.shotSize(s, St.storyRatio());
  const payload = s.comp ? { ...clone(s.comp), size: s.comp.size || size } : { ...COMP_BLANK(), size, bg: '#ffffff' };
  return createDoc({ kind: 'image', label }, payload);
}

async function reconcile() {
  const tid = FS.tableId, rows = FS.rows;
  FS.rows = false;
  if (!FS.storyId || !tid) return;
  if (!(await openStory()) || FS.tableId !== tid) { drawPane(); return; }
  const P = St.storyDoc(), list = frames();
  let story = false, table = false;
  const still = () => FS.tableId === tid && storyOpen() && frames() === list;   // (nothing switched under an await)

  // frames moved: the rows say the order
  if (rows) {
    const mine = list.filter(R.isStoryFrame);
    R.carryRows(mine, FS.laid);   // (a scene's note dragged on its own takes its shots along)
    story = R.applyOrder(P, R.orderFromRows(R.rowsOf(mine))) || story;
  }
  // frames back from an Undo on the table: their shots come back where they were
  for (const f of list) {
    const id = R.isShotFrame(f) && !St.shotAt(f.story.shot) && FS.stash.has(f.story.shot) ? f.story.shot : null;
    if (!id) continue;
    const { scene, i, s } = FS.stash.get(id), sc = P.scenes.find((x) => x.id === scene) || P.scenes[P.scenes.length - 1];
    FS.stash.delete(id);
    if (sc) { sc.shots.splice(Math.min(i, sc.shots.length), 0, s); story = true; }
  }
  const plan = R.planReconcile(P, list, { seen: FS.seen });
  // a shot's frame deleted on the table: the shot goes too (kept for an Undo there)
  for (const id of plan.goneShots) {
    const at = St.shotAt(id);
    if (!at) continue;
    FS.stash.set(id, { scene: at.sc.id, i: at.i, s: at.s });
    at.sc.shots.splice(at.i, 1);
    FS.seen.delete(id);
    story = true;
  }
  // a shot's frame duplicated: the copy is a copy of the shot, with the copied edit as its own
  for (const { frame, shot } of plan.copies) {
    const f = list.find((x) => x.id === frame), c = f && St.shotCopyAfter(shot, { doc: f.doc });
    if (!c) continue;
    delete c.docFrom;
    f.story = { scene: St.shotAt(c.id).sc.id, shot: c.id };
    story = table = true;
  }
  // frames for nothing in the story (a shot or scene deleted in the outline): they go, and a shot's edit to the trash
  if (plan.remove.length) {
    const gone = new Set(plan.remove), docs = new Set(St.storyShots().map((s) => s.doc).filter(Boolean));
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (!gone.has(f.id)) continue;
      list.splice(i, 1);
      if (f.doc && !docs.has(f.doc)) trashDoc(f).catch((e) => console.warn(e));
      if (R.isShotFrame(f)) FS.seen.delete(f.story.shot);
    }
    table = true;
  }
  // every shot has its edit: the frame's when it has one, else made once (from its old canvas)
  for (const s of St.storyShots()) {
    const f = frameOfShot(s.id);
    if (f?.doc && !s.doc) { s.doc = f.doc; story = true; }
    if (f && s.doc && f.doc !== s.doc) { f.doc = s.doc; table = true; }
  }
  const need = St.storyShots().filter((s) => !s.doc || !frameOfShot(s.id));
  if (need.length) {
    let have;
    try { have = await editDocs(); } catch (e) { toast(`Couldn't read the shots' edits: ${e.message}`, true); return; }
    for (const s of need) {
      if (s.doc && have.has(s.doc)) continue;
      if (s.doc) {   // its edit went to the trash with its frame: back it comes
        try { await restoreDoc({ kind: 'image', doc: s.doc }); have.add(s.doc); continue; } catch { /* gone for good: a new one */ }
      }
      const at = St.shotAt(s.id);
      if (!at) continue;
      try { s.doc = await shotDoc(at, have); delete s.docFrom; have.add(s.doc); story = true; } catch (e) { toast(`Couldn't make shot ${shotNum(at)}'s edit: ${e.message}`, true); }
      if (!still()) { if (story && storyOpen()) St.storyChanged(); return; }
    }
  }
  // the frames missing: a note for each scene, an image frame for each shot
  const ratio = St.storyRatio(), base = M.sizeForMp(ratio, 1, 1);
  const origin = M.boundsOf(list.filter(R.isStoryFrame)) || { x: 0, y: 0 };
  for (const id of plan.missingNotes) {
    if (!P.scenes.some((sc) => sc.id === id)) continue;
    list.push(M.newFrame('note', { x: origin.x, y: origin.y, w: R.NOTE_W, h: base.h }, { label: 'Scene', story: { scene: id }, text: '' }));
    table = true;
  }
  for (const s of St.storyShots()) {
    if (frameOfShot(s.id) || !s.doc) continue;
    const at = St.shotAt(s.id);
    const label = shotLabel(at);
    list.push(M.newFrame('image', { x: origin.x, y: origin.y, ...R.shotSize(s, ratio) }, { label, doc: s.doc, story: { scene: at.sc.id, shot: s.id, auto: label } }));
    table = true;
  }
  // labels, scenes and notes' words follow the story. A shot frame's label is "1.2 What we see…" and its edit is named
  // the same, unless it was renamed on the table (then it is the user's: it stays)
  const renamed = [];
  for (const f of list) {
    if (R.isShotFrame(f)) {
      const at = St.shotAt(f.story.shot);
      if (!at) continue;
      if (f.story.scene !== at.sc.id) { f.story = { ...f.story, scene: at.sc.id }; table = true; }
      const label = shotLabel(at);
      if (!R.autoLabelled(f)) continue;
      if (f.label !== label || f.story.auto !== label) { f.label = label; f.story = { ...f.story, auto: label }; table = true; renamed.push(f); }
      else if (!FS.named.has(f.id)) renamed.push(f);
    } else if (R.isSceneNote(f)) {
      const si = P.scenes.findIndex((sc) => sc.id === f.story.scene), sc = P.scenes[si];
      if (!sc) continue;
      const label = `Scene ${si + 1}`, text = R.noteText(sc), typing = document.activeElement?.closest?.(`.frame[data-id="${f.id}"]`);
      if (f.label !== label) { f.label = label; table = true; }
      if (!typing && (f.text || '') !== text) { f.text = text; table = true; }
    }
  }
  // the rows laid again (not while a frame is open or being dragged: it would move under the hand)
  if (!isLive() && !FS.down) {
    const pos = R.storyLayout(P, list, { x0: Math.round(origin.x), y0: Math.round(origin.y) });
    for (const f of list) {
      const p = pos.get(f.id);
      if (p && (f.x !== p.x || f.y !== p.y)) { f.x = p.x; f.y = p.y; table = true; }
    }
    FS.laid = pos;
    FS.relay = false;
  } else { FS.relay = true; if (rows) FS.rows = true; }   // (laid once it is let go)
  FS.seen = new Map(list.filter(R.isShotFrame).map((f) => [f.story.shot, f.id]));
  if (story) St.storyChanged();
  if (table) Table.frameChanged();
  for (const f of renamed) { FS.named.add(f.id); renameDoc(f, f.label).catch((e) => console.warn('shot edit name', e)); }
  if (FS.wantSel) { const f = frameOfShot(FS.wantSel); if (f) { FS.wantSel = null; selectFrame(f); } }
  badges();
  await stills();
}

// ---------------------------------------------------------------------------
// the shots' frames: a badge on the label bar (how far along, clips, runs waiting), and a still from the chosen frame
// when the edit has none yet (it was never opened)
// ---------------------------------------------------------------------------
function badges() {
  if (!storyOpen()) return;
  for (const f of frames()) {
    if (!R.isShotFrame(f)) continue;
    const at = St.shotAt(f.story.shot), bar = document.querySelector(`.frame[data-id="${f.id}"] .frame-label`);
    if (!at || !bar) continue;
    let b = bar.querySelector('.frame-story');
    if (!b) { b = h('span', { class: 'frame-story', role: 'status' }); bar.append(b); }
    const { s } = at, owed = new Set(owedTo(f.doc).map((r) => r.id));   // (runs landing as layers: the table counts those)
    const waiting = s.pending.filter((id) => !owed.has(id)).length + s.vpending.length;
    const text = [St.shotStatus(s), s.clips.length ? `${s.clips.length} clip${s.clips.length > 1 ? 's' : ''}` : '', waiting ? `${waiting} making` : ''].filter(Boolean).join(' · ');
    if (b.textContent !== text) b.textContent = text;
    b.className = `frame-story st-${s.status}`;
    b.title = `Shot ${shotNum(at)}: ${text}`;
  }
}

async function pngOf(url, max = 1536) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}
async function stills() {
  const want = () => frames().filter((f) => R.isShotFrame(f) && f.doc && !stillOf(f)).map((f) => ({ f, at: St.shotAt(f.story.shot) }))
    .map((x) => ({ ...x, c: x.at && St.chosenFrame(x.at.s) })).filter((x) => x.c && !FS.stills.has(`${x.f.doc}:${x.c.id}`));
  if (!want().length) return;
  await loadStills(['image']);   // (what the server has now: never write over a still the edit drew)
  let n = 0;
  for (const { f, c } of want()) {
    FS.stills.add(`${f.doc}:${c.id}`);
    try {
      const blob = await pngOf(St.frameSrcUrl(c));
      const r = await fetch(`/api/store/edit-tabs/${f.doc}/still${qs()}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
      if (r.ok) n++;
    } catch (e) { console.warn('shot still', e); }
  }
  if (n) Table.refreshStills(['image']);
}

// ---------------------------------------------------------------------------
// selection, both ways
// ---------------------------------------------------------------------------
// a frame selected on the table, as a tap on it would (table.js has no selectFrames yet: a pointer down and up on it)
function selectFrame(f) {
  if (typeof Table.selectFrames === 'function') return Table.selectFrames([f.id]);
  if (isLive()) return;
  const sel = Table.selectedFrames?.() || [];
  if (sel.length === 1 && sel[0].id === f.id) return;
  const el = document.querySelector(`.table-frames .frame[data-id="${f.id}"] .frame-label`);
  if (!el) return;
  const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, pointerId: 31337, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: r.left + 4, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
}
addEventListener('table:select', (e) => {
  detect(e.detail?.table);
  const sel = e.detail?.frames || [];
  if (!storyOpen() || sel.length !== 1) return drawSoon();
  const f = sel[0];
  if (R.isShotFrame(f) && St.shotAt(f.story.shot) && St.selectedShot() !== f.story.shot) St.selectShot(f.story.shot, { quiet: true });
  drawSoon();
});

St.onStory((type, detail) => {
  if (!FS.storyId) return;
  if (type === 'select') {
    if (!detail || !storyOpen()) return drawSoon();
    const f = frameOfShot(detail);
    if (f) selectFrame(f); else FS.wantSel = detail;
    drawSoon();
    return;
  }
  if (type === 'change' || type === 'load') soon(type === 'load' ? 0 : 150);
  drawSoon();
});

// ---------------------------------------------------------------------------
// the table's events: moves, frames coming and going, a frame let go, runs queued from the Make panel
// ---------------------------------------------------------------------------
const onStoryTable = () => !!FS.storyId && storyOpen();
addEventListener('table:move', (e) => {
  if (!onStoryTable() || !(e.detail?.frames || []).some(R.isStoryFrame)) return;
  soon(60, { rows: true });
});
addEventListener('table:open', (e) => detect(e.detail?.table));   // (if table.js gains one)
addEventListener('table:unlive', () => { if (FS.storyId) soon(200, { rows: FS.rows }); });
// (in case a move ends without table:move: a story frame not where the layout put it, once the pointer is up)
addEventListener('pointerdown', (e) => { if (e.target.closest?.('#tab-table .table-stage')) FS.down = true; }, true);
addEventListener('pointerup', () => {
  if (!FS.down) return;
  FS.down = false;
  if (!onStoryTable()) return;
  setTimeout(() => {
    const moved = frames().some((f) => { const p = FS.laid.get(f.id); return R.isStoryFrame(f) && p && (p.x !== f.x || p.y !== f.y); });
    if (moved || FS.rows) soon(60, { rows: true });
    else if (FS.relay) soon(60);
  }, 0);
}, true);
addEventListener('pointercancel', () => { FS.down = false; }, true);

// the frames' elements come and go (a table loaded, a frame deleted, an Undo): look again
function watchFrames() {
  const el = document.querySelector('#tab-table .table-frames');
  if (!el) return false;
  new MutationObserver(() => { detect(); if (FS.storyId) { badges(); soon(200); } }).observe(el, { childList: true });
  return true;
}
const watchT = setInterval(() => { if (watchFrames()) clearInterval(watchT); }, 500);
// another table picked from the tabs, while the table is on screen
setInterval(() => { if (document.querySelector('#tab-table.active')) detect(); }, 800);
onProject(() => { FS.pid = undefined; detect(); });

// a note's words typed on the table: the scene's heading (first line) and summary
document.addEventListener('input', (e) => {
  const fe = e.target.closest?.('.frame.frame-note');
  if (!fe || !onStoryTable()) return;
  const f = Table.frameById?.(fe.dataset.id);
  if (!R.isSceneNote(f)) return;
  const sc = St.storyDoc().scenes.find((x) => x.id === f.story.scene);
  if (!sc) return;
  Object.assign(sc, R.fromNote(e.target.value));
  for (const k of ['slug', 'summary']) for (const o of document.querySelectorAll(`[data-bind="${sc.id}.${k}"]`)) if (o.value !== sc[k]) o.value = sc[k];
  St.storyPersist();
});
// words typed in the outline (headings, summaries, what we see): the notes and labels follow
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.bind?.split('.').pop();
  if (onStoryTable() && ['slug', 'summary', 'what'].includes(k) && (e.target.closest?.('.st-view, #storyStage, #storyBody') || FS.pane?.contains(e.target))) soon(500);
});

// a run queued for a shot's frame: it waits on the shot, as Generate frame / Redraw / Make the video do (story.js settle)
addEventListener('make:queued', (e) => {
  const { frame, kind, gens } = e.detail || {};
  if (!R.isShotFrame(frame) || !onStoryTable()) return;
  const at = St.shotAt(frame.story.shot), ids = (gens || []).map((g) => g.id).filter((id) => id != null);
  if (!at || !ids.length) return;
  (kind === 'video' ? at.s.vpending : at.s.pending).push(...ids);
  if (kind !== 'video') at.s.layered = [...new Set([...(at.s.layered || []), ...ids])];   // (the Make panel landed them as layers)
  St.storyChanged();
});
onServer('deck_generation', () => { if (onStoryTable()) { badges(); drawSoon(); } });

// Every picture made for a shot with an edit lands as a layer in that edit: the edit is the shot's picture, and its
// frames (s.frames, filled by story.js settle) are the record of what was made, to pick from and compare. The Make
// panel lands its own runs (make:queued above marks them); Generate frame and Redraw (the Story pane, the Story tab)
// land here, once each (s.layered: the shot's waiting runs already sent to its edit).
let layering = false;
async function layerRuns() {
  if (layering) return;
  layering = true;
  try {
    for (const s of St.storyShots()) {
      if (!s.doc || !s.pending.length) continue;
      const owed = new Set(owedTo(s.doc).map((r) => r.id)), done = new Set(s.layered || []);
      const fresh = s.pending.filter((id) => !done.has(id) && !owed.has(id));
      const keep = (s.layered || []).filter((id) => s.pending.includes(id));
      if (!fresh.length) { if (keep.length !== (s.layered || []).length) { s.layered = keep; St.storyPersist(); } continue; }
      s.layered = [...keep, ...fresh];
      St.storyPersist();
      const doc = s.doc, at = St.shotAt(s.id);
      let rect;
      try { rect = canvasRect((await api(`/api/store/edit-tabs/${doc}${qs()}`, { busy: false })).payload, R.shotSize(s, St.storyRatio())); } catch { continue; }
      for (const [nth, id] of fresh.entries()) {
        let g = S.history.get(id);
        if (!g?.prompt_id) { try { g = await api(`/api/generations/${id}`, { busy: false }); } catch { continue; } }
        landMade(doc, { name: null, px: [rect.w, rect.h], rect, copy: false }, g, { label: at ? `Shot ${shotNum(at)}` : 'Shot', nth });
      }
    }
  } finally { layering = false; }
}
St.onStory((type) => { if (type === 'change' || type === 'load') setTimeout(() => layerRuns().catch((e) => console.warn('shot layers', e)), 0); });

// the Story tab's ways into a shot's edit go to its frame here while this story's table is on screen
const tableShown = () => !!document.querySelector('#tab-table.active') && onStoryTable();
async function openFrame(s) {
  const f = tableShown() && frameOfShot(s.id);
  if (!f) return false;
  Table.goLive?.(f);
  return true;
}
async function toFrame(s, name) {
  const f = tableShown() && frameOfShot(s.id);
  if (!f || !Table.goLive) return false;
  Table.goLive(f);
  const ed = await import('./editor.js');
  for (let i = 0; i < 60; i++) {   // (the frame's edit opening: a few seconds at most)
    if (isLive(f.id) && ed.editTabs().active?.id === s.doc && CURRENT_EDIT.eng && !document.querySelector('.live-layer .frame-loading')) {
      CURRENT_EDIT.eng.addImage(name, { label: 'Frame' });
      CURRENT_EDIT.eng.render?.();
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  toast('The frame didn\'t open: try again', true);
  return true;
}
St.shotDocHooks({ toFrame, openFrame });

// ---------------------------------------------------------------------------
// To video: a video frame beside the rows, its timeline the shots' clips (else their chosen frames) in order
// ---------------------------------------------------------------------------
function durationOf(url) {
  return new Promise((done) => {
    const v = document.createElement('video');
    const end = (d) => { clearTimeout(t); v.removeAttribute('src'); v.load(); done(d); };
    const t = setTimeout(() => end(0), 8000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => end(0);
    v.src = url;
  });
}
async function toVideo() {
  if (!storyOpen()) return;
  const { media, missing } = St.storyMedia();
  if (!media.length) return toast('No shot has a frame yet', true);
  let p = blankPayload('video');
  for (const m of media) {
    const dur = m.kind === 'video' ? await durationOf(m.url) : 0;
    p = withClip(p, { src: m.src, url: m.url, label: m.label, dur, kind: m.kind }, uid());
    const it = p.items[p.items.length - 1];
    if (m.kind === 'image') { it.out = m.len; it.thumb = m.thumb || null; }
  }
  const list = frames(), b = M.boundsOf(list.filter(R.isStoryFrame)) || { x: 0, y: 0, w: 0, h: 0 };
  const size = M.sizeForMp(St.storyRatio(), 1, 1), title = St.storyDoc().title.trim() || St.storyTabs()?.active?.name || 'Story';
  const f = M.newFrame('video', { x: b.x + b.w + 160, y: b.y, ...size }, { label: `${title} · video` });
  try { f.doc = await createDoc(f, p); } catch (e) { return toast(`Couldn't make the video: ${e.message}`, true); }
  if (frames() !== list) return toast('The table changed: try again', true);
  list.push(f);
  Table.frameChanged();
  selectFrame(f);
  toast(`${media.length} shot${media.length === 1 ? '' : 's'} on "${f.label}"${missing ? `; ${missing} without a frame left out` : ''}`);
}

// ---------------------------------------------------------------------------
// the Story pane
// ---------------------------------------------------------------------------
const pane = () => (FS.pane ||= sidebar.pane('story', { title: 'Story', icon: 'story', when: () => !!FS.storyId }));
function drawSoon() { cancelAnimationFrame(FS.drawT); FS.drawT = requestAnimationFrame(drawPane); }

// the shot's frame's picture as one of the shot's frames, chosen (what Redraw and Make the video start from)
async function takePicture(s, f) {
  const url = f && stillOf(f);
  if (!url) return toast('The frame has no picture yet: open it and draw, or make one', true);
  try {
    const r = await uploadImage(await (await fetch(url)).blob(), { source: 'story', filename: 'shot.png' });
    const fr = { id: uid(), input: r.name };
    s.frames.push(fr); s.pick = fr.id;
    if (s.status === 'idea') s.status = 'drafted';
    St.storyChanged();
    return fr;
  } catch (e) { toast(e.message, true); return null; }
}
async function withPicture(s, f, run) {
  if (!St.chosenFrame(s) && !(await takePicture(s, f))) return;
  run(s);
}
function makeSection(at) {
  const { s } = at, f = frameOfShot(s.id), rt = St.refineTemplate(s), vt = St.videoTemplate(s), ok = !!(St.chosenFrame(s) || (f && stillOf(f)));
  return section('Make', null,
    h('div', { class: 'row wrap' },
      f ? button([icon('fit'), 'Open the frame'], () => Table.goLive?.(f), { cls: 'small primary', title: 'Draw and lay out the shot\'s picture (Enter)' }) : null,
      f ? button([icon('image'), 'Use the frame\'s picture'], () => takePicture(s, f), { title: 'The frame\'s picture as the shot\'s chosen frame: Redraw and Make the video start from it' }) : null),
    h('div', { class: 'row wrap' },
      button([icon('sparkle'), 'Redraw'], () => withPicture(s, f, (x) => St.refineShot(x)), { disabled: !rt || !ok, title: rt ? `${rt.name || rt.id}, the story's Redraw settings` : 'No image-to-image or edit template is installed' }),
      button([icon('video'), 'Make the video'], () => withPicture(s, f, (x) => St.makeVideo(x)), { disabled: !vt || !ok, title: vt ? `${vt.name || vt.id}, ${s.dur} s` : 'No image-to-video template is installed' })));
}
function addShot() {
  const P = St.storyDoc(), sel = Table.selectedFrames?.() || [];
  const one = sel.length === 1 ? sel[0] : null, scene = one?.story?.scene || St.shotAt(St.selectedShot())?.sc.id;
  const sc = P.scenes.find((x) => x.id === scene) || P.scenes[P.scenes.length - 1];
  if (!sc) return St.addScene();
  St.addShot(sc, sc.shots[sc.shots.length - 1] || null);
}
function onGoShot(link) {
  if (link?.story && link.story !== FS.storyId) return toast('That shot is in another story', true);
  St.selectShot(link.shot);
}

export function drawPane() {
  const el = pane();
  if (!el) return;
  if (!FS.storyId) return el.replaceChildren(section('Story', null, hint('Open a story\'s table to see its story here.')));
  if (!storyOpen()) return el.replaceChildren(section('Story', null, hint('Opening the story…')));
  const sel = St.selectedShot(), at = sel && St.shotAt(sel), P = St.storyDoc();
  const host = h('div', { class: 'st-pane-view' });
  St.renderStoryView(host, FS.view, { onGoShot });
  const n = St.storyShots().length;
  const parts = [
    section(P.title.trim() || St.storyTabs()?.active?.name || 'Story', null,
      h('div', { class: 'row wrap st-pane-bar' },
        button([icon('plus'), 'Scene'], () => St.addScene(), { title: 'A new scene at the end: a new row' }),
        button([icon('plus'), 'Shot'], addShot, { title: 'A shot at the end of the selected frame\'s scene' }),
        button([icon('video'), 'To video'], toVideo, { title: 'A video frame beside the rows with every shot\'s clip, or its chosen frame for its length, in order' })),
      hint(`${P.scenes.length} scene${P.scenes.length === 1 ? '' : 's'} · ${n} shot${n === 1 ? '' : 's'}`)),
    at ? St.shotPanel(at) : null,
    at ? makeSection(at) : null,
    section(VIEWS.find(([v]) => v === FS.view)[1], null,
      seg(VIEWS, FS.view, (v) => { FS.view = v; store.set('deck.storyPane.view', v); drawPane(); }), host),
  ].filter(Boolean);
  // (a redraw keeps the cursor in the box being typed in)
  const a = document.activeElement, key = a && el.contains(a) ? a.dataset?.bind : null;
  const range = key && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  const top = el.scrollTop;
  el.replaceChildren(...parts);
  el.scrollTop = top;
  if (key) {
    const m = el.querySelector(`[data-bind="${key}"]`);
    if (m) { m.focus({ preventScroll: true }); if (range) try { m.setSelectionRange(...range); } catch { /* not a text box */ } }
  }
}
onCharacters(() => { if (onStoryTable() && FS.view !== 'outline') drawSoon(); });

pane();
detect();

// for the headless UI checks (dev/)
export const storyTableDebug = () => ({ FS, reconcile: () => { soon(0); return new Promise((r) => setTimeout(() => FS.chain.then(r), 10)); } });
