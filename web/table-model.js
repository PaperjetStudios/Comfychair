// A table's rules, with no DOM: the saved payload, frames and their geometry (hit tests, the marquee, moving, resizing,
// snapping, z-order), the view (fit, zoom about a point) and the row layout a story table uses. table.js draws and
// drives it; tests/table_model.test.mjs checks it in node.
//
//   payload: { v: 1, view: { x, y, z }, grid: { on, size }, groups: [{ id, name, collapsed }],
//              frames: [{ id, key, kind, doc, x, y, w, h, label, locked?, hidden?, group?, story?: { scene, shot }, text?, preview?, fit?, fitBox? }],
//              wires: [{ id, from, to, kind, n, on, frame? }] (web/wire-rules.js: a frame's output plugged into another's inputs), story? }
// The frames are a layer stack (web/layer-stack.js rules: groups, rows, moving rows): key is the frame's id, group the
// id of its group in groups (members sit next to each other). A hidden frame isn't drawn, picked, boxed or fitted; it keeps its place.
// (text: a note's words; preview: the picture an image frame was made from, shown until its document has a still;
// fit: an image frame sized by its layers, w, h then the area they cover, fitBox: that area in the edit (frame-image.js))
// Table units are pixels at zoom 1. A frame's w, h is its canvas size. The screen point of a table point p is
// p * z + (x, y). Frames later in the list sit on top.

import { snapNearest, snapStep } from './snap-math.js';
import { normalize } from './layer-stack.js';
import { migrateWires } from './wire-rules.js';

export const KINDS = ['image', 'video', 'scene', 'sound', 'note'];
// the saved document kind each frame kind owns (a note has none: its text is on the frame)
export const DOC_KIND = { image: 'edit-tabs', video: 'video-tabs', scene: 'scene-tabs', sound: 'sound-tabs' };
// The frames whose documents the server says another table owns (a refused save's 409 names them: { docs: [[kind, id]] },
// kind a store kind). Their ids: the open table drops exactly these from its copy (never their documents) and saves again.
export function foreignFrames(frames, docs) {
  const bad = new Set((Array.isArray(docs) ? docs : []).filter((d) => Array.isArray(d) && d.length === 2).map(([k, i]) => `${k}\u0000${i}`));
  if (!bad.size) return [];
  return (frames || []).filter((f) => f && f.doc && DOC_KIND[f.kind] && bad.has(`${DOC_KIND[f.kind]}\u0000${f.doc}`)).map((f) => f.id);
}
// The frame documents the other tables own ([[store kind, id]]), from the tables' list read in full (?full=true): what a
// refusal names when the server is older and doesn't say (app/store.py _owned_docs, frames only)
export function docsOwnedElsewhere(tables, exceptId) {
  const out = [];
  for (const t of Array.isArray(tables) ? tables : []) {
    if (!t || t.id === exceptId) continue;
    for (const f of t.payload?.frames || []) if (f && DOC_KIND[f.kind] && typeof f.doc === 'string' && f.doc) out.push([DOC_KIND[f.kind], f.doc]);
  }
  return out;
}
export const KIND_LABEL = { image: 'Image', video: 'Video', scene: '3D', sound: 'Sound', note: 'Note' };
// On a version-2 project the work lives on tables and these engines' documents belong to a frame: their TabSets (tabs.js) make no blank
// "Edit 1" / "Mix 1" / "main" of their own and may sit with no open document. Version 1 keeps the old behaviour.
export const ENGINE_KINDS = new Set(['edit-tabs', 'video-tabs', 'sound-tabs', 'scene-tabs', 'vfx-tabs', 'gen-tabs']);
export const sitsEmpty = (kind, project) => ENGINE_KINDS.has(kind) && (project?.version || 1) >= 2;
export const MIN_SIDE = 16;
// A frame's output: what its runs, renders and exports come out at (frame.out { w, h }). Its w and h on the table are only its preview's
// size, so moving or resizing it there never changes this. Sound and notes have no picture, so no output size.
export const HAS_OUTPUT = new Set(['image', 'video', 'scene']);
export const outputOf = (f) => (f?.out?.w > 0 && f.out.h > 0 ? { w: f.out.w, h: f.out.h } : f?.w && f?.h ? { w: f.w, h: f.h } : null);
// the preview's size for a new output: the same longest side, the output's shape (the same size when the shape hasn't changed)
export function tileShape(f, out) {
  if (Math.abs(f.w / f.h - out.w / out.h) < 0.01) return { w: f.w, h: f.h };
  const k = Math.max(f.w, f.h) / Math.max(out.w, out.h);
  return { w: Math.max(MIN_SIDE, Math.round(out.w * k)), h: Math.max(MIN_SIDE, Math.round(out.h * k)) };
}
// a frame just drawn on the table: small on the table isn't small out: under 1 MP comes out at 1 MP, the same shape
export function drawnOutput(r) {
  if (r.w * r.h < 1e6) return sizeForMp(r.w, r.h, 1);
  return { w: Math.max(16, Math.round(r.w / 16) * 16), h: Math.max(16, Math.round(r.h / 16) * 16) };
}

const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The table's grid on screen, in pixels: the fine step (a step too fine to see is drawn coarser, so a main line stays on a main line) and the main one, every fourth
export const GRID_MAIN = 4;
export function gridSteps(size, z) {
  let fine = size * z;
  while (fine < 10) fine *= GRID_MAIN;
  return { fine, main: fine * GRID_MAIN };
}
export const blankTable = () => ({ v: 1, view: { x: 0, y: 0, z: 1 }, grid: { on: true, size: 64 }, groups: [], frames: [], wires: [] });

// A saved payload made whole (an older or partial one, or one from another device), so the surface can trust it
export function migrateTable(p) {
  const b = blankTable(), v = p?.view || {}, g = p?.grid || {};
  const out = { ...p, v: 1, view: { x: num(v.x, 0), y: num(v.y, 0), z: num(v.z, 1) || 1 },
    grid: { on: g.on ?? b.grid.on, size: Math.max(4, num(g.size, b.grid.size)) },
    groups: (Array.isArray(p?.groups) ? p.groups : []).filter((x) => x?.id != null).map((x) => ({ id: String(x.id), name: String(x.name ?? 'Group'), collapsed: !!x.collapsed })),
    frames: (p?.frames || []).filter((f) => f && KINDS.includes(f.kind)).map((f) => ({ ...f,
      id: String(f.id || rid()), doc: f.doc ?? null, label: f.label ?? KIND_LABEL[f.kind],
      x: num(f.x, 0), y: num(f.y, 0), w: Math.max(MIN_SIDE, num(f.w, 512)), h: Math.max(MIN_SIDE, num(f.h, 512)) })) };
  for (const f of out.frames) { f.key = f.id; if (f.group != null) f.group = String(f.group); }
  for (const f of out.frames) if (HAS_OUTPUT.has(f.kind) && !(f.out?.w > 0 && f.out.h > 0)) f.out = { w: f.w, h: f.h };   // (from when the table size was the output)
  for (const f of out.frames) {   // (the frame's main source, main-rules.js: a layer key or an item id in its document)
    if (f.main == null || f.main === '' || typeof f.main === 'object') delete f.main; else f.main = String(f.main);
  }
  out.frames = normalize(out.frames, out.groups);   // (members together; a group with no frames, or a frame's lost group, goes)
  out.wires = migrateWires(p?.wires, out.frames);   // (a wire naming a frame that is gone goes)
  if (!out.story) delete out.story;
  return out;
}

// A new frame over rect (table units), sides at least MIN_SIDE. extra: doc, label, text, story…
export function newFrame(kind, rect, extra = {}) {
  const w = Math.max(MIN_SIDE, Math.round(rect.w)), h = Math.max(MIN_SIDE, Math.round(rect.h));
  const f = { id: rid(), kind, doc: null, label: KIND_LABEL[kind] || kind, x: Math.round(rect.x), y: Math.round(rect.y), w, h,
    ...(HAS_OUTPUT.has(kind) && { out: { w, h } }), ...extra };
  f.key = f.id;
  return f;
}
// the frames on show (a hidden one keeps its place but is skipped by the pointer, the box, Fit and the story's rows)
export const shown = (frames) => frames.filter((f) => !f.hidden);

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

// ---- the stack: z-order steps and what Undo puts back ----
// The frames with those ids one step up (dir 1: toward the end of the list, on top) or down (-1). A frame in a group
// steps among its group's members and stays in it; a frame outside steps over a whole group; a group whose members are
// all picked steps as one. A picked neighbour holds a frame back (the picked keep their order). A new list.
export function stepZ(frames, ids, dir) {
  const sel = new Set(ids);
  const whole = new Set([...new Set(frames.map((f) => f.group).filter(Boolean))].filter((g) => frames.filter((f) => f.group === g).every((f) => sel.has(f.id))));
  // units, bottom first: { items, inside: the group it moves within, or null, picked }
  const units = [];
  for (const f of frames) {
    if (f.group && whole.has(f.group)) {
      const last = units[units.length - 1];
      if (last?.whole === f.group) last.items.push(f); else units.push({ items: [f], inside: null, whole: f.group, picked: true });
    } else units.push({ items: [f], inside: f.group || null, picked: sel.has(f.id) });
  }
  const order = dir > 0 ? [...units].reverse() : [...units];
  for (const u of order) {
    if (!u.picked) continue;
    const k = units.indexOf(u);
    let j = k + dir;
    const v = units[j];
    if (!v || v.picked) continue;
    if (u.inside) { if (v.inside !== u.inside) continue; }
    else if (v.inside) { while (units[j + dir]?.inside === v.inside) j += dir; }   // (over the whole group)
    units.splice(k, 1);
    units.splice(j, 0, u);   // (j counted before u came out: up, that is just past v; down, just before it)
  }
  return units.flatMap((u) => u.items);
}

// What a change to the stack changes (order, groups, group, hidden, locked), to put back by id: a frame gone since stays gone
export function stackSnap(frames, groups = []) {
  return { order: frames.map((f) => f.id), groups: groups.map((g) => ({ ...g })),
    f: Object.fromEntries(frames.map((f) => [f.id, { group: f.group, hidden: f.hidden, locked: f.locked }])) };
}
export const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The snapshot put back on these frames (the same objects): their order, groups and fields. Frames not in it (made
// since) keep their place after the ones that are. Returns { frames, groups }.
export function applySnap(frames, snap) {
  const at = new Map(snap.order.map((id, i) => [id, i]));
  const known = frames.filter((f) => at.has(f.id)).sort((a, b) => at.get(a.id) - at.get(b.id));
  const out = [...known, ...frames.filter((f) => !at.has(f.id))];
  for (const f of known) for (const [k, v] of Object.entries(snap.f[f.id])) { if (v === undefined) delete f[k]; else f[k] = v; }
  const groups = snap.groups.map((g) => ({ ...g }));
  return { frames: normalize(out, groups), groups };
}

// ---- arrange: align, distribute, same size, tidy ----
// Each takes the frames to arrange (in the order they were picked) and returns new objects for them, in the same order,
// with their new x, y (w, h for sameSize). A locked frame stays as it is. step: the grid's size when it is on, else 0:
// the line they align to, where a spread starts, each spread frame's leading edge and a tidy's corner land on it.
const onStep = (v, step) => (step ? snapStep(v, step) : Math.round(v));
const free = (f) => !f.locked;

// edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom', to the bounds of all of them
export function alignFrames(frames, edge, { step = 0 } = {}) {
  if (frames.length < 2) return frames.map((f) => ({ ...f }));
  const b = boundsOf(frames);
  const x = edge === 'left' || edge === 'hcenter' || edge === 'right';
  const [p, s] = x ? ['x', 'w'] : ['y', 'h'];
  const kind = { left: 0, top: 0, hcenter: 0.5, vcenter: 0.5, right: 1, bottom: 1 }[edge];
  if (kind == null) throw new Error(`no such edge: ${edge}`);
  const line = onStep(b[p] + b[s] * kind, step);
  return frames.map((f) => (free(f) ? { ...f, [p]: Math.round(line - f[s] * kind) } : { ...f }));
}

// axis 'x' | 'y'. By default the gaps between them come out even, the first and last staying put (centres: true: their
// centres evenly spaced instead); gap: a fixed gap from the first. Ordered by where they are along the axis.
export function distributeFrames(frames, axis, { gap = null, centres = false, step = 0 } = {}) {
  if (frames.length < 2) return frames.map((f) => ({ ...f }));
  const [p, s] = axis === 'y' ? ['y', 'h'] : ['x', 'w'];
  const sorted = [...frames].sort((a, b) => a[p] + a[s] / 2 - (b[p] + b[s] / 2));
  const first = sorted[0], last = sorted[sorted.length - 1], n = sorted.length;
  const to = new Map();
  if (centres && gap == null) {
    const c0 = first[p] + first[s] / 2, c1 = last[p] + last[s] / 2;
    sorted.forEach((f, i) => to.set(f, c0 + ((c1 - c0) * i) / (n - 1) - f[s] / 2));
  } else {
    const g = gap ?? (last[p] + last[s] - first[p] - sorted.reduce((a, f) => a + f[s], 0)) / (n - 1);
    let at = first[p];
    for (const f of sorted) { to.set(f, at); at += f[s] + g; }
  }
  return frames.map((f) => (free(f) ? { ...f, [p]: f === first && gap == null ? f[p] : onStep(to.get(f), step) } : { ...f }));
}

// which: 'w' | 'h' | 'both'; to: 'first' (the first of frames: the first picked) or 'largest' (by area)
export function sameSize(frames, which, { to = 'first' } = {}) {
  if (frames.length < 2) return frames.map((f) => ({ ...f }));
  const ref = to === 'largest' ? frames.reduce((a, f) => (f.w * f.h > a.w * a.h ? f : a)) : frames[0];
  return frames.map((f) => {
    if (!free(f)) return { ...f };
    return { ...f, ...(which !== 'h' ? { w: ref.w } : {}), ...(which !== 'w' ? { h: ref.h } : {}) };
  });
}

// Laid out tidy from where the first of them (in reading order) is: mode 'row' (side by side), 'column' (stacked) or
// 'grid' (as near square as the count allows; cols to say). Each row is as tall as its tallest, each frame centred
// in it; a stack's frames are centred on its widest. Sizes stay (a frame's size is its canvas). gap between them.
export function tidyRows(frames, { mode = 'grid', gap = 40, cols = 0, step = 0 } = {}) {
  if (frames.length < 2) return frames.map((f) => ({ ...f }));
  const reading = [...frames].sort((a, b) => (mode === 'row' ? a.x - b.x : mode === 'column' ? a.y - b.y : (a.y - b.y) || (a.x - b.x)));
  const b = boundsOf(frames), x0 = onStep(b.x, step), y0 = onStep(b.y, step);
  const to = new Map();
  if (mode === 'column') {
    const wide = Math.max(...reading.map((f) => f.w));
    let y = y0;
    for (const f of reading) { to.set(f, { x: Math.round(x0 + (wide - f.w) / 2), y }); y += f.h + gap; }
  } else {
    const n = mode === 'row' ? reading.length : Math.max(1, cols || Math.ceil(Math.sqrt(reading.length)));
    let y = y0;
    for (let i = 0; i < reading.length; i += n) {
      const row = reading.slice(i, i + n), tall = Math.max(...row.map((f) => f.h));
      let x = x0;
      for (const f of row) { to.set(f, { x, y: Math.round(y + (tall - f.h) / 2) }); x += f.w + gap; }
      y += tall + gap;
    }
  }
  return frames.map((f) => (free(f) ? { ...f, ...to.get(f) } : { ...f }));
}
