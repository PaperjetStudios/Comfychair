// ---------------------------------------------------------------------------
// Continuing a clip, with no DOM (node tests them: tests/continue_rules.test.mjs). A clip B is made as a continuation
// of clip A: A's last `lap` seconds guide the motion, B's file starts with those frames, and B sits on A's track at
// endOf(A) - lap so the two overlap and the timeline dissolves across it. B keeps a record of what it was made from:
//   B.cont = { of: A's clip id, from: "<generation>:<index>" (a string), end: A's used end in source seconds when
//              B was made, lap: seconds }
// Times are seconds in the timeline or in a clip's source, as each function says.
// ---------------------------------------------------------------------------

import { lenOf, endOf } from './timeline-rules.js';

export const CONT_TEMPLATES = { ltx: 'deck-ltx-continue', h3: 'deck-h3-continue' };
// the guide frame counts each family allows, and the one chosen first
export const LAPS = { ltx: [9, 17, 25], h3: [5, 22, 39] };
export const LAP_DEFAULT = { ltx: 17, h3: 22 };

const usedEnd = (it) => it.out ?? it.dur;
const r6 = (v) => +v.toFixed(6) || 0;

// the model family of a template id: 'ltx' | 'h3' | null
export function familyOf(templateId) {
  const s = String(templateId || '');
  return s.startsWith('deck-ltx-') ? 'ltx' : s.startsWith('deck-h3-') ? 'h3' : null;
}
// the template that continues a clip made with this one, or null
export const continueTemplate = (templateId) => CONT_TEMPLATES[familyOf(templateId)] || null;
// the largest allowed count <= n (the smallest when n is below all)
export function lapFrames(family, n) {
  const l = LAPS[family] || [];
  if (!l.length) return n;
  let best = l[0];
  for (const v of l) if (v <= n) best = v;
  return best;
}
// "<generation>:<index>" for a clip made by a run, else null
export const sourceKey = (it) => (typeof it?.src?.generation === 'number' ? `${it.src.generation}:${it.src.index || 0}` : null);

// The last `frames` frames of the clip's used range, in whole frames: { start, len, frames }, source seconds.
export function tailTrim(it, frames, fps = 24) {
  const top = Math.min(usedEnd(it) ?? (it.dur || 3), it.dur ?? Infinity);
  const end = Math.round(top * fps);
  const s = Math.max(Math.round((it.in || 0) * fps), end - frames);
  return { start: s / fps, len: (end - s) / fps, frames: end - s };
}
// the cont record for a clip made from A now
export const contOf = (A, lap) => ({ of: A.id, from: sourceKey(A), end: usedEnd(A), lap });

export const childrenOf = (items, id) => items.filter((c) => c.cont?.of === id);
// every clip downstream of id through cont.of, upstream before downstream, not id itself; safe against cycles
export function chainFrom(items, id) {
  const out = [], seen = new Set([id]);
  let layer = [id];
  while (layer.length) {
    const next = [];
    for (const p of layer) for (const c of childrenOf(items, p)) if (!seen.has(c.id)) { seen.add(c.id); out.push(c.id); next.push(c.id); }
    layer = next;
  }
  return out;
}

// { [clipId]: 'gone' | 'changed' | 'trimmed' | 'upstream' } for continued clips that no longer match their upstream
export function staleOf(items, fps = 24) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const memo = new Map();
  const why = (c, path) => {
    if (!c.cont) return null;
    if (memo.has(c.id)) return memo.get(c.id);
    const A = byId.get(c.cont.of);
    let r = null;
    if (!A) r = 'gone';
    else if (sourceKey(A) !== c.cont.from) r = 'changed';
    else if (Math.abs((usedEnd(A) ?? 0) - c.cont.end) > 1 / fps) r = 'trimmed';
    else if (!path.has(A.id) && why(A, new Set([...path, c.id]))) r = 'upstream';
    memo.set(c.id, r);
    return r;
  };
  const out = {};
  for (const it of items) { const r = why(it, new Set([it.id])); if (r) out[it.id] = r; }
  return out;
}

// B goes on A's track, overlapping A's end by lap; later clips on the track move right to make room; B's own
// continuations follow. Mutates. Returns B.
export function placeAfter(items, A, B, lap) {
  B.track = A.track;
  B.at = Math.max(0, endOf(A) - lap);
  const bEnd = endOf(B);
  const others = items.filter((c) => c !== A && c !== B && c.track === B.track && c.cont?.of !== B.id);
  const hit = others.filter((c) => c.at >= B.at && c.at < bEnd).sort((a, b) => a.at - b.at)[0];
  if (hit) {
    const d = bEnd - hit.at, from = hit.at;
    for (const c of items) if (c !== A && c !== B && c.track === B.track && c.at >= from) c.at = r6(c.at + d);
  }
  settle(items, B.id);
  return B;
}

// Put each continuation of clip id at endOf(parent) - its lap on the parent's track, moving the clips from its old
// start on by the same amount (either way), then do the same for it. Used after a clip's length changed. Cycle safe.
export function settle(items, id, seen = new Set()) {
  if (seen.has(id)) return;
  seen.add(id);
  const P = items.find((c) => c.id === id);
  if (!P) return;
  for (const C of childrenOf(items, id)) {
    if (seen.has(C.id)) continue;
    const target = Math.max(0, endOf(P) - C.cont.lap);
    const d = target - C.at;
    const moving = items.filter((c) => c.track === P.track && c.at >= C.at && !seen.has(c.id));
    if (!moving.includes(C)) moving.push(C);
    C.track = P.track;
    for (const c of moving) c.at = r6(c.at + d);
    settle(items, C.id, seen);
  }
}

// Where to sample colour for matching B to A, in each clip's source seconds: { ref, src, lap }.
export function seamWindows(A, B, w = 0.5) {
  const lap = Math.max(0, endOf(A) - B.at);
  const aIn = A.in || 0, aEnd = usedEnd(A) ?? aIn;
  const ref = { start: Math.max(aIn, aEnd - w), len: Math.min(w, aEnd - aIn) };
  const bLen = lenOf(B);
  const src = bLen - lap < 0.1
    ? { start: B.in || 0, len: Math.min(w, bLen) }
    : { start: (B.in || 0) + lap, len: Math.min(w, bLen - lap) };
  return { ref, src, lap };
}

// the clip just before B on its track (audio is skipped for picture clips), or null
export function prevOnTrack(items, B) {
  const pic = (k) => k !== 'audio';
  let best = null;
  for (const c of items) {
    if (c === B || c.track !== B.track || !(c.at < B.at)) continue;
    if (pic(B.kind) ? !pic(c.kind) : c.kind !== B.kind) continue;
    if (!best || c.at > best.at) best = c;
  }
  return best;
}
