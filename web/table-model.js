// A table's rules, with no DOM: the saved payload, frames and their geometry (hit tests, the marquee, moving, resizing,
// snapping, z-order), the view (fit, zoom about a point) and the row layout a story table uses. table.js draws and
// drives it; tests/table_model.test.mjs checks it in node.
//
//   payload: { v: 1, view: { x, y, z }, grid: { on, size },
//              frames: [{ id, kind, doc, x, y, w, h, label, locked?, story?: { scene, shot }, text?, preview? }], story? }
// (text: a note's words; preview: the picture an image frame was made from, shown until its document has a still)
// Table units are pixels at zoom 1. A frame's w, h is its canvas size. The screen point of a table point p is
// p * z + (x, y). Frames later in the list sit on top.

import { snapNearest, snapStep } from './snap-math.js';

export const KINDS = ['image', 'video', 'scene', 'sound', 'note'];
// the saved document kind each frame kind owns (a note has none: its text is on the frame)
export const DOC_KIND = { image: 'edit-tabs', video: 'video-tabs', scene: 'scene-tabs', sound: 'sound-tabs' };
export const KIND_LABEL = { image: 'Image', video: 'Video', scene: '3D', sound: 'Sound', note: 'Note' };
// On a version-2 project the work lives on tables and these engines' documents belong to a frame: their TabSets (tabs.js) make no blank
// "Edit 1" / "Mix 1" / "main" of their own and may sit with no open document. Version 1 keeps the old behaviour.
export const ENGINE_KINDS = new Set(['edit-tabs', 'video-tabs', 'sound-tabs', 'scene-tabs', 'vfx-tabs', 'gen-tabs']);
export const sitsEmpty = (kind, project) => ENGINE_KINDS.has(kind) && (project?.version || 1) >= 2;
export const MIN_SIDE = 16;

const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const blankTable = () => ({ v: 1, view: { x: 0, y: 0, z: 1 }, grid: { on: true, size: 64 }, frames: [] });

// A saved payload made whole (an older or partial one, or one from another device), so the surface can trust it
export function migrateTable(p) {
  const b = blankTable(), v = p?.view || {}, g = p?.grid || {};
  const out = { ...p, v: 1, view: { x: num(v.x, 0), y: num(v.y, 0), z: num(v.z, 1) || 1 },
    grid: { on: g.on ?? b.grid.on, size: Math.max(4, num(g.size, b.grid.size)) },
    frames: (p?.frames || []).filter((f) => f && KINDS.includes(f.kind)).map((f) => ({ ...f,
      id: String(f.id || rid()), doc: f.doc ?? null, label: f.label ?? KIND_LABEL[f.kind],
      x: num(f.x, 0), y: num(f.y, 0), w: Math.max(MIN_SIDE, num(f.w, 512)), h: Math.max(MIN_SIDE, num(f.h, 512)) })) };
  if (!out.story) delete out.story;
  return out;
}

// A new frame over rect (table units), sides at least MIN_SIDE. extra: doc, label, text, story…
export function newFrame(kind, rect, extra = {}) {
  return { id: rid(), kind, doc: null, label: KIND_LABEL[kind] || kind,
    x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(MIN_SIDE, Math.round(rect.w)), h: Math.max(MIN_SIDE, Math.round(rect.h)), ...extra };
}

// ---- geometry ----
// a rect from two corners in any order
export const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
export const inside = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// the topmost frame under a table point, or null
export function hitFrame(frames, pt) {
  for (let i = frames.length - 1; i >= 0; i--) if (inside(frames[i], pt)) return frames[i];
  return null;
}
// the frames a marquee touches
export const framesIn = (frames, rect) => frames.filter((f) => overlaps(f, rect));

export function boundsOf(frames) {
  if (!frames.length) return null;
  const x = Math.min(...frames.map((f) => f.x)), y = Math.min(...frames.map((f) => f.y));
  return { x, y, w: Math.max(...frames.map((f) => f.x + f.w)) - x, h: Math.max(...frames.map((f) => f.y + f.h)) - y };
}

// The frames with those ids moved by dx, dy (a locked one stays). A new list; the others are the same objects.
export function moveFrames(frames, ids, dx, dy) {
  const set = new Set(ids);
  return frames.map((f) => (set.has(f.id) && !f.locked ? { ...f, x: Math.round(f.x + dx), y: Math.round(f.y + dy) } : f));
}

// z-order: the frames with those ids to the top (end of the list) or the bottom, keeping their own order
export function toFront(frames, ids) { const s = new Set(ids); return [...frames.filter((f) => !s.has(f.id)), ...frames.filter((f) => s.has(f.id))]; }
export function toBack(frames, ids) { const s = new Set(ids); return [...frames.filter((f) => s.has(f.id)), ...frames.filter((f) => !s.has(f.id))]; }

// A frame's rect after dragging one of its handles ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw') by dx, dy from where it
// was (frame: the rect at the start of the drag). keepAspect: a corner keeps the shape. snap(axis, v): where a moving
// edge lands ('x' or 'y', table units), for grid and edge snapping. The opposite side stays put.
export function resizeFrame(frame, handle, dx, dy, { keepAspect = false, min = MIN_SIDE, snap = null } = {}) {
  const s = snap || ((a, v) => v);
  let l = frame.x, t = frame.y, r = frame.x + frame.w, b = frame.y + frame.h;
  if (handle.includes('w')) l = Math.min(s('x', l + dx), r - min);
  if (handle.includes('e')) r = Math.max(s('x', r + dx), l + min);
  if (handle.includes('n')) t = Math.min(s('y', t + dy), b - min);
  if (handle.includes('s')) b = Math.max(s('y', b + dy), t + min);
  if (keepAspect && handle.length === 2) {
    const ar = frame.w / frame.h, w = r - l, h = b - t;
    // the side that moved further leads; the other follows the shape, from the fixed corner
    const nw = Math.max(min, Math.abs(w - frame.w) / frame.w >= Math.abs(h - frame.h) / frame.h ? w : h * ar), nh = Math.max(min, nw / ar);
    if (handle.includes('w')) l = r - nw; else r = l + nw;
    if (handle.includes('n')) t = b - nh; else b = t + nh;
  }
  return { ...frame, x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) };
}

// ---- snapping ----
// (snapNearest and snapStep: web/snap-math.js, which gizmo.js shares)
export { snapNearest, snapStep };

// where a moving edge at v lands: on another frame's edge or centre within thr, else on the grid (when it is on)
export function snapValue(v, axis, others, grid, thr, { edges = true } = {}) {
  const targets = edges ? others.flatMap((o) => (axis === 'x' ? [o.x, o.x + o.w / 2, o.x + o.w] : [o.y, o.y + o.h / 2, o.y + o.h])) : [];
  const hit = snapNearest([v], targets, thr);
  if (hit) return v + hit.d;
  return grid?.on ? snapStep(v, grid.size) : v;
}

// A moving rect snapped: its left, centre or right onto another frame's (and the same down), else its corner onto the
// grid. Returns { x, y, guides: [{ x } | { y }] } (the lines it snapped to, to draw while dragging).
export function snapRect(rect, others, grid, thr, { edges = true } = {}) {
  const guides = [];
  const axis = (p, s, k) => {
    const vals = [rect[p], rect[p] + rect[s] / 2, rect[p] + rect[s]];
    const hit = edges ? snapNearest(vals, others.flatMap((o) => [o[p], o[p] + o[s] / 2, o[p] + o[s]]), thr) : null;
    if (hit) { guides.push({ [k]: hit.at }); return rect[p] + hit.d; }
    return grid?.on ? snapStep(rect[p], grid.size) : rect[p];
  };
  return { x: axis('x', 'w', 'x'), y: axis('y', 'h', 'y'), guides };
}

// ---- the view ----
// the view that shows bounds whole in a stage of stageW × stageH, pad pixels clear on every side
export function fitView(bounds, stageW, stageH, pad = 40, { min = 0.02, max = 2 } = {}) {
  if (!bounds || !bounds.w || !bounds.h) return { x: stageW / 2, y: stageH / 2, z: 1 };
  const z = clamp(Math.min((stageW - 2 * pad) / bounds.w, (stageH - 2 * pad) / bounds.h), min, max);
  return { x: stageW / 2 - (bounds.x + bounds.w / 2) * z, y: stageH / 2 - (bounds.y + bounds.h / 2) * z, z };
}
// zoomed by factor about the stage point (px, py), which stays over the same table point
export function zoomAt(view, px, py, factor, min = 0.02, max = 8) {
  const z = clamp(view.z * factor, min, max), k = z / view.z;
  return { x: px - (px - view.x) * k, y: py - (py - view.y) * k, z };
}
export const toTable = (view, px, py) => ({ x: (px - view.x) / view.z, y: (py - view.y) / view.z });
export const toStage = (view, x, y) => ({ x: x * view.z + view.x, y: y * view.z + view.y });
// the view that puts a frame at zoom exactly 1, centred in the stage (a live frame: engines can't work scaled)
export const liveView = (f, stageW, stageH) => ({ x: Math.round(stageW / 2 - (f.x + f.w / 2)), y: Math.round(stageH / 2 - (f.y + f.h / 2)), z: 1 });

// ---- layouts ----
// Rows of frames (a story's scenes, each a row of shots) laid left to right, each row below the last. Returns the same
// rows with every frame given its x, y (new objects).
export function rowLayout(rows, { gap = 40, rowGap = 80, x0 = 0, y0 = 0 } = {}) {
  let y = y0;
  return rows.map((row) => {
    let x = x0;
    const out = row.map((f) => { const g = { ...f, x, y }; x += f.w + gap; return g; });
    y += Math.max(0, ...row.map((f) => f.h)) + rowGap;
    return out;
  });
}

// the same, named as the story table asks for it: layoutRows(rows, { x, y, gap, rowGap })
export const layoutRows = (rows, { x = 0, y = 0, gap = 40, rowGap = 80 } = {}) => rowLayout(rows, { gap, rowGap, x0: x, y0: y });

// The frames grouped into rows, the way they sit: a frame joins a row when its top and bottom overlap the row's (the
// frames already in it, from top to bottom), or come within gap of it. Rows run top to bottom, each one left to right.
// (A story table reads its scenes and shot order back from where the frames were dragged.)
export function rowsOf(frames, { gap = 0 } = {}) {
  const rows = [];
  for (const f of [...frames].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((r) => f.y < r.bottom + gap && f.y + f.h > r.top - gap);
    if (row) { row.list.push(f); row.top = Math.min(row.top, f.y); row.bottom = Math.max(row.bottom, f.y + f.h); }
    else rows.push({ top: f.y, bottom: f.y + f.h, list: [f] });
  }
  return rows.sort((a, b) => a.top - b.top).map((r) => r.list.sort((a, b) => a.x - b.x || a.y - b.y));
}

// the view that shows a live frame's place on the table behind its mount (the frame fitted to the stage, pad clear)
export const liveBackdrop = (f, stageW, stageH, pad, { min = 0.02, max = 8 } = {}) => fitView(f, stageW, stageH, pad, { min, max });

// A free spot (top-left) for a new frame of size w × h beside the last frame of that kind (else right of everything,
// else the origin), moved on to the right until it overlaps nothing.
export function nextBeside(frames, kind, { w = 512, h = 512, gap = 40 } = {}) {
  const same = frames.filter((f) => f.kind === kind), last = same[same.length - 1];
  const all = boundsOf(frames);
  const spot = last ? { x: last.x + last.w + gap, y: last.y } : all ? { x: all.x + all.w + gap, y: all.y } : { x: 0, y: 0 };
  for (let i = 0; i < 1000; i++) {
    const hit = frames.find((f) => overlaps(f, { ...spot, w, h }));
    if (!hit) break;
    spot.x = hit.x + hit.w + gap;
  }
  return spot;
}

// ---- megapixels ----
export const mpOf = (w, h) => (w * h) / 1e6;
// w × h scaled to about mp megapixels, the same shape, each side a multiple of 16 (what the models want)
export function sizeForMp(w, h, mp) {
  const k = Math.sqrt((mp * 1e6) / (w * h));
  const r16 = (v) => Math.max(16, Math.round(v / 16) * 16);
  return { w: r16(w * k), h: r16(h * k) };
}
