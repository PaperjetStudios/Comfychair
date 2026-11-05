// The Properties pane's rules, without the page (web/props-panel.js draws it). Which rows a selection gets, what one
// row shows for several things at once, and an edit sent to all of them.
//
//   rowsFor({ kind, live, picked })  the row ids, in the order they show. kind: 'frames' (frames on the table, nothing
//     live), or the live frame's kind with its picked things: 'image' (layers: { flat }), 'video' (clips: { kind }),
//     'sound' (items). picked: what is selected, the primary first. No rows for nothing picked, or a kind with none.
//   shared(values)          the one value they all have, or MIXED (none given: MIXED too)
//   applyAll(items, set, v) set(item, v) on each; the number of items it went to
//   snapNum(v, grid)        v on the table's grid when it is on (grid: { on, size }), else rounded
//   lockedSize(size, axis, v, lock)   { w, h } with one side typed; lock keeps the shape
//   mixLength(items)        a mix's length in seconds: where its last item ends
import { snapStep } from './snap-math.js';

export const MIXED = Symbol('mixed');

const FRAME_ROWS = ['x', 'y', 'w', 'h', 'opacity', 'resolution', 'name', 'lock', 'hide'];
const VISUAL = new Set(['video', 'image', 'scene']);

export function rowsFor({ kind, live = false, picked = [] } = {}) {
  const list = (picked || []).filter(Boolean);
  if (!list.length) return [];
  const p = list[0], one = list.length === 1;
  if (kind === 'frames' && !live) {
    // (a name typed once for several frames would name them all alike; a note has no picture to measure)
    return FRAME_ROWS.filter((id) => (id === 'name' ? one : id === 'resolution' ? one && p.kind !== 'note' : true));
  }
  if (kind === 'image') {
    const turns = list.some((l) => !l.flat);   // (a painted canvas is resized, not turned)
    return ['x', 'y', 'scale', ...(turns ? ['rotation'] : []), 'opacity'];
  }
  if (kind === 'video') {
    const still = p.kind === 'image';
    return ['at', ...(still ? ['duration'] : ['in', 'out']),
      ...(VISUAL.has(p.kind) ? ['framing', 'x', 'y', 'scale', 'rotation', 'anchor', 'opacity'] : []),
      ...(p.kind === 'image' || p.kind === 'scene' ? [] : ['level']), 'fadeIn', 'fadeOut'];
  }
  if (kind === 'sound') return ['at', 'in', 'out', 'level', 'pan', 'fadeIn', 'fadeOut'];
  return [];
}

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : Object.is(a, b));
export function shared(values) {
  const vs = [...(values || [])];
  if (!vs.length) return MIXED;
  return vs.every((v) => same(v, vs[0])) ? vs[0] : MIXED;
}

export function applyAll(items, set, v) {
  let n = 0;
  for (const it of items || []) { if (it == null) continue; set(it, v); n++; }
  return n;
}

export const snapNum = (v, grid) => (grid?.on && grid.size ? snapStep(v, grid.size) : Math.round(v));

export function lockedSize({ w, h }, axis, v, lock = false, min = 16) {
  const r = w / (h || 1), n = Math.max(min, Math.round(v));
  if (axis === 'w') return { w: n, h: lock ? Math.max(min, Math.round(n / r)) : h };
  return { w: lock ? Math.max(min, Math.round(n * r)) : w, h: n };
}

export function mixLength(items) {
  let end = 0;
  for (const it of items || []) {
    const len = Math.max(0, (it.out ?? it.dur ?? 0) - (it.in || 0));
    end = Math.max(end, (it.at || 0) + len);
  }
  return end;
}
