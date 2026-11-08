// ---------------------------------------------------------------------------
// A character laid out as a table, with no DOM (tests/char_rows.test.mjs). A table whose payload says `character: <id>`
// is that character's own table: one row per stage of the character creator, top to bottom, each row a note with the
// stage's name and state at its start, then the stage's frames left to right. The frames carry
//   char: { stage, slot?, look, item?, auto? }
//   stage: 'refs' | 'elements' | 'canon' | 'object' | 'turn' | 'views' | 'sheets'   (STAGES, in row order)
//   slot:  what the frame holds for the stage: a media item's id ('refs', 'sheets'), an element's character id
//          ('elements': a character frame, its doc that id), 'main' ('canon'), 'model' | 'splat' ('object'), 'turn' |
//          'depth' | 'h3' ('turn'), a view key ('views'), 'sheet' ('sheets')
//   look:  the look the row set belongs to (a table shows one look at a time)
//   item:  the media item id the frame was made for, when it has one
//   auto:  the label the layout gave it, so a renamed frame keeps its name (as story frames do)
// The rules say what a table should have for a look (wanted), what it lacks or has too much of (planReconcile) and
// where it all goes (charLayout). frame-character.js drives it; later phases add the stages they build (the list of
// stages is here; a stage with no frames yet gets its note only).
// ---------------------------------------------------------------------------
import * as M from './table-model.js';
import { viewLabel } from './cast.js';

export const STAGES = ['refs', 'elements', 'canon', 'object', 'turn', 'views', 'sheets'];
export const STAGE_LABEL = { refs: 'References', elements: 'Elements', canon: 'Canon picture', object: '3D object', turn: 'Turntable', views: 'Views', sheets: 'Sheets' };
const PHOTO_ROLES = new Set(['face', 'body', 'ref', 'edit', 'detail']);
// the frame kind each stage's frames are
const KIND_OF = { refs: 'image', elements: 'character', canon: 'image', object: 'scene', turn: 'scene', views: 'image', sheets: 'image' };
export const NOTE_W = 360;
export const TILE = 320;   // (a reference's or view's tile: its longest side on the table)

export const isStageNote = (f) => f?.kind === 'note' && !!f.char?.stage && f.char.slot == null;
export const isStageFrame = (f) => !!f?.char?.stage && f.char.slot != null && f.kind !== 'note';
export const isCharFrame = (f) => isStageNote(f) || isStageFrame(f);
export const stageOf = (f) => (STAGES.includes(f?.char?.stage) ? f.char.stage : null);
const key = (c) => `${c.stage}\u0000${c.slot ?? ''}`;
export const autoLabelled = (f) => (f.char?.auto != null ? f.label === f.char.auto : true);

// a tile's size on the table for a picture of w × h (the output size stays the picture's: table-model outputOf)
export function tileSize(w, h, side = TILE) {
  if (!(w > 0 && h > 0)) return { w: side, h: side };
  const k = side / Math.max(w, h);
  return { w: Math.max(M.MIN_SIDE, Math.round(w * k)), h: Math.max(M.MIN_SIDE, Math.round(h * k)) };
}

// What a character table should have for a look: [{ stage, slot, kind, label, input? | doc?, item? }], notes left out
// (every stage gets one). c: a Character (char-model.js) on the look (c.withLook); elements: its elements (char-model.js
// elementsOf), each a character frame on the Elements row.
export function wanted(c, lookId = c?.lookNow?.id || null, { elements = [] } = {}) {
  if (!c) return [];
  const k = lookId && typeof c.withLook === 'function' ? c.withLook(lookId) : c;
  const look = k.lookNow || {}, out = [];
  for (const m of Array.isArray(k.media) ? k.media : []) {
    if (!m || !PHOTO_ROLES.has(m.role) || typeof m.src?.input !== 'string' || !m.src.input) continue;
    if (m.look && m.look !== look.id) continue;
    out.push({ stage: 'refs', slot: m.id, kind: 'image', label: m.label || roleLabel(m.role), input: m.src.input, item: m.id });
  }
  for (const e of elements) {
    if (!e?.id || e.partOf?.character !== k.id || (e.partOf.look && e.partOf.look !== look.id)) continue;
    out.push({ stage: 'elements', slot: e.id, kind: 'character', label: e.name || 'Element', doc: e.id });
  }
  for (const [vk, input] of Object.entries(look.views || {})) if (typeof input === 'string' && input) out.push({ stage: 'views', slot: vk, kind: 'image', label: viewLabel(vk), input });
  if (typeof look.sheet === 'string' && look.sheet) out.push({ stage: 'sheets', slot: 'sheet', kind: 'image', label: 'Sheet', input: look.sheet });
  for (const m of Array.isArray(k.media) ? k.media : []) {
    if (!m || m.role !== 'sheet' || typeof m.src?.input !== 'string' || !m.src.input || m.src.input === look.sheet) continue;
    if (m.look && m.look !== look.id) continue;
    out.push({ stage: 'sheets', slot: m.id, kind: 'image', label: m.label ? `Sheet · ${m.label}` : 'Sheet', input: m.src.input, item: m.id });
  }
  return out;
}
const ROLE = { face: 'Face', body: 'Body', ref: 'Reference', edit: 'Edit', detail: 'Detail' };
const roleLabel = (r) => ROLE[r] || 'Picture';

// What a table lacks or has too much of for a look, given what it should have (wanted) and its frames:
//   missing:      [wanted entry]  stage frames to make
//   missingNotes: [stage]         stages with no note
//   remove:       [frame id]      stage frames for nothing wanted (a picture taken out of the character), second notes
//   copies:       [{ frame, of }] a second frame for one slot (a duplicated frame): the caller decides what it becomes
//   renew:        [{ frame, input }] a frame whose slot now holds another picture (a view made again)
export function planReconcile(want, frames, { look = null } = {}) {
  const mine = frames.filter((f) => isCharFrame(f) && (look == null || f.char.look == null || f.char.look === look));
  const bySlot = new Map(), byStage = new Map(), remove = [], copies = [], renew = [];
  for (const f of mine) {
    if (isStageNote(f)) { (byStage.get(f.char.stage) || byStage.set(f.char.stage, []).get(f.char.stage)).push(f); continue; }
    (bySlot.get(key(f.char)) || bySlot.set(key(f.char), []).get(key(f.char))).push(f);
  }
  const wantKeys = new Map(want.map((w) => [key(w), w]));
  for (const [k, list] of bySlot) {
    const w = wantKeys.get(k);
    if (!w) { remove.push(...list.map((f) => f.id)); continue; }
    const keep = list[0];
    for (const f of list.slice(1)) copies.push({ frame: f.id, of: keep.id });
    if (w.input && keep.char.input && keep.char.input !== w.input) renew.push({ frame: keep.id, input: w.input });
  }
  const missing = want.filter((w) => !bySlot.has(key(w)));
  const missingNotes = STAGES.filter((s) => !byStage.has(s));
  for (const list of byStage.values()) remove.push(...list.slice(1).map((f) => f.id));
  return { missing, missingNotes, remove, copies, renew };
}

// A new stage frame or note for the table (its document is the caller's to make, except an element's: its doc is the
// element's character id, which the frame stands for and never owns). rect: where and how big.
export function stageFrame(w, rect, look) {
  const label = w.label || STAGE_LABEL[w.stage];
  return M.newFrame(KIND_OF[w.stage] || 'image', rect, { label, ...(w.doc ? { doc: w.doc } : {}),
    char: { stage: w.stage, slot: w.slot, look, ...(w.item ? { item: w.item } : {}), ...(w.input ? { input: w.input } : {}), auto: label } });
}
export function stageNote(stage, rect, look, text = '') {
  return M.newFrame('note', rect, { label: STAGE_LABEL[stage], text: text || STAGE_LABEL[stage], char: { stage, look, auto: STAGE_LABEL[stage] } });
}

// The rows laid out: each stage's note then its frames, in STAGES order, from (x0, y0); a stage's frames in the order they are
// in (the table's own order, so a frame dragged along its row keeps its place). Returns Map frame id -> { x, y }.
export function charLayout(frames, { x0 = 0, y0 = 0, gap = 40, rowGap = 120 } = {}) {
  const note = new Map(), rows = new Map(STAGES.map((s) => [s, []]));
  for (const f of frames) {
    const s = stageOf(f);
    if (!s) continue;
    if (isStageNote(f)) { if (!note.has(s)) note.set(s, f); } else rows.get(s).push(f);
  }
  const list = STAGES.map((s) => [note.get(s), ...rows.get(s)].filter(Boolean)).filter((r) => r.length);
  const laid = M.rowLayout(list, { x0, y0, gap, rowGap });
  return new Map(laid.flat().map((f) => [f.id, { x: Math.round(f.x), y: Math.round(f.y) }]));
}

// A stage's note text: its name on the first line, its state under it ("Running · depth render", "Waiting for you · 3 to review")
export const noteText = (stage, state = '') => [STAGE_LABEL[stage], state].filter(Boolean).join('\n');
