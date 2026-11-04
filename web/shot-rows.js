// A story laid out as a table, with no DOM: which frames are a story's, the order the rows on the table say the
// scenes and shots are in, what a table is missing (or has too much of) for its story, and where everything goes.
// frame-story.js drives it; tests/story_rows.test.mjs checks it in node.
//
// A story table's frames: a note per scene at the start of its row (story: { scene }) and an image frame per shot
// (story: { scene, shot }), whose document is the shot's edit (s.doc). Rows are scenes top to bottom; a row's frames
// left to right are its note and its shots in order.
import * as M from './table-model.js';

export const isSceneNote = (f) => f?.kind === 'note' && !!f.story?.scene && !f.story.shot;
export const isShotFrame = (f) => f?.kind === 'image' && !!f.story?.shot;
export const isStoryFrame = (f) => isSceneNote(f) || isShotFrame(f);

// Frames in rows: a frame whose middle is inside a row's height so far joins it; each row left to right.
// (table-model.js rowsOf when it is there; this is the same rule, for when it isn't)
export function rowsOfFrames(frames) {
  const list = [...frames].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const f of list) {
    const c = f.y + f.h / 2, r = rows[rows.length - 1];
    if (r && c >= r.top && c <= r.bottom) { r.frames.push(f); r.top = Math.min(r.top, f.y); r.bottom = Math.max(r.bottom, f.y + f.h); }
    else rows.push({ top: f.y, bottom: f.y + f.h, frames: [f] });
  }
  return rows.map((r) => r.frames.sort((a, b) => a.x - b.x));
}
// table-model.js rowsOf's answer (whatever its exact shape: rows of frames, or { frames } each), else ours
export function rowsOf(frames, { gap = 40 } = {}) {
  let rows = null;
  if (typeof M.rowsOf === 'function') {
    try { rows = M.rowsOf(frames, { gap }); } catch { rows = null; }
    rows = Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? r : r?.frames)).filter(Array.isArray) : null;
  }
  return (rows || rowsOfFrames(frames)).map((r) => [...r].sort((a, b) => a.x - b.x));
}

// The scenes and their shots in the order rows of frames show them: [{ scene, shots: [shot ids] }].
// Each note starts its scene; shots before a row's first note go to that note's scene, a row with no note joins the
// scene above it (or, above every note, the first scene). null when no row has a note.
export function orderFromRows(rows) {
  const out = [], carry = [];
  for (const row of rows) {
    let cur = null;
    const pre = [];
    for (const f of row) {
      if (isSceneNote(f)) { cur = { scene: f.story.scene, shots: [...pre] }; pre.length = 0; out.push(cur); }
      else if (isShotFrame(f)) (cur ? cur.shots : pre).push(f.story.shot);
    }
    if (pre.length) (out.length ? out[out.length - 1].shots : carry).push(...pre);
  }
  if (!out.length) return null;
  out[0].shots.unshift(...carry);
  return out;
}

const shape = (story) => story.scenes.map((sc) => `${sc.id}:${sc.shots.map((s) => s.id).join(',')}`).join('|');
// The story put in that order (its scenes and shots moved, nothing made or lost). A scene with no note on the table
// keeps its place; a shot with no frame stays in its scene, at the end. True when anything moved.
export function applyOrder(story, order) {
  if (!order?.length) return false;
  const was = shape(story);
  const scenes = new Map(story.scenes.map((sc) => [sc.id, sc]));
  const shots = new Map(story.scenes.flatMap((sc) => sc.shots.map((s) => [s.id, s])));
  const placed = new Set(), seen = new Set(), lists = new Map();
  const next = [];
  for (const o of order) {
    const sc = scenes.get(o.scene);
    if (!sc || seen.has(sc.id)) continue;
    seen.add(sc.id);
    lists.set(sc.id, o.shots.map((id) => shots.get(id)).filter((s) => s && !placed.has(s.id) && placed.add(s.id)));
    next.push(sc);
  }
  story.scenes.forEach((sc, i) => { if (!seen.has(sc.id)) { lists.set(sc.id, []); next.splice(Math.min(i, next.length), 0, sc); } });
  for (const sc of story.scenes) for (const s of sc.shots) if (!placed.has(s.id)) lists.get(sc.id).push(s);
  for (const sc of next) sc.shots = lists.get(sc.id);
  story.scenes = next;
  return shape(story) !== was;
}

// What a table lacks or has too much of for its story. seen: Map shot id -> the frame id it had on this table (a shot
// whose frame is gone since was taken off the table: its shot goes too).
//   missingShots: [{ scene, shot }]  shots with no frame (new ones)
//   goneShots:    [shot id]          shots whose frame was deleted on the table
//   copies:       [{ frame, shot }]  a second frame for a shot (a duplicated frame): it becomes a copy of the shot
//   missingNotes: [scene id]         scenes with no note
//   remove:       [frame id]         notes and shot frames for nothing in the story, and second notes
export function planReconcile(story, frames, { seen = new Map() } = {}) {
  const shotIds = new Map(story.scenes.flatMap((sc) => sc.shots.map((s) => [s.id, sc.id])));
  const sceneIds = new Set(story.scenes.map((sc) => sc.id));
  const byShot = new Map(), byScene = new Map(), remove = [];
  for (const f of frames) {
    if (isShotFrame(f)) {
      if (!shotIds.has(f.story.shot)) { remove.push(f.id); continue; }
      (byShot.get(f.story.shot) || byShot.set(f.story.shot, []).get(f.story.shot)).push(f);
    } else if (isSceneNote(f)) {
      if (!sceneIds.has(f.story.scene)) { remove.push(f.id); continue; }
      (byScene.get(f.story.scene) || byScene.set(f.story.scene, []).get(f.story.scene)).push(f);
    }
  }
  const missingShots = [], goneShots = [], copies = [], missingNotes = [];
  for (const [shot, scene] of shotIds) {
    const list = byShot.get(shot) || [];
    if (!list.length) { (seen.has(shot) ? goneShots : missingShots).push(seen.has(shot) ? shot : { scene, shot }); continue; }
    const keep = list.find((f) => f.id === seen.get(shot)) || list[0];
    for (const f of list) if (f !== keep) copies.push({ frame: f.id, shot });
  }
  for (const sc of story.scenes) {
    const list = byScene.get(sc.id) || [];
    if (!list.length) missingNotes.push(sc.id);
    remove.push(...list.slice(1).map((f) => f.id));
  }
  return { missingShots, goneShots, copies, missingNotes, remove };
}

// The size of a shot's frame: its edit's canvas when it has one, else the story's shape at about a megapixel
export function shotSize(s, ratio) {
  const z = s?.comp?.size;
  if (z?.w > 0 && z?.h > 0) return { w: Math.round(z.w), h: Math.round(z.h) };
  return M.sizeForMp(ratio, 1, 1);
}
export const NOTE_W = 480;

// The rows laid out: a scene's note then its shots, scene under scene, from (x0, y0). Returns Map frame id -> { x, y }.
// (table-model.js layoutRows when it is there, else rowLayout)
export function storyLayout(story, frames, { x0 = 0, y0 = 0, gap = 40, rowGap = 120 } = {}) {
  const note = new Map(), shot = new Map();
  for (const f of frames) { if (isSceneNote(f)) note.set(f.story.scene, f); else if (isShotFrame(f)) shot.set(f.story.shot, f); }
  const rows = story.scenes.map((sc) => [note.get(sc.id), ...sc.shots.map((s) => shot.get(s.id))].filter(Boolean)).filter((r) => r.length);
  let laid = null;
  if (typeof M.layoutRows === 'function') {
    try { laid = M.layoutRows(rows, { x: x0, y: y0, gap, rowGap }); } catch { laid = null; }
    const flat = Array.isArray(laid) ? laid.flat() : [];
    if (flat.length !== rows.flat().length || !flat.every((f) => f && f.id && Number.isFinite(f.x) && Number.isFinite(f.y))) laid = null;
  }
  laid ||= M.rowLayout(rows, { x0, y0, gap, rowGap });
  return new Map(laid.flat().map((f) => [f.id, { x: Math.round(f.x), y: Math.round(f.y) }]));
}

// A scene's note: its heading on the first line, its summary under it; and back
export const noteText = (sc) => [sc.slug || '', sc.summary || ''].join('\n').replace(/\n$/, '');
export function fromNote(text) {
  const [first, ...rest] = String(text || '').split('\n');
  return { slug: first.trim(), summary: rest.join('\n').trim() };
}
