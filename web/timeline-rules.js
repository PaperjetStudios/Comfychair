// ---------------------------------------------------------------------------
// The timeline's rules, with no DOM (node tests them: tests/timeline_rules.test.mjs). Video and Sound share them
// through web/timeline.js. A timeline document is plain data:
//   d = { tracks: [{ id, kind, hidden?, muted?, locked?, solo?, name?, h? }],
//         items: [{ id, track, kind, at, in, out, dur?, fadeIn?, fadeOut?, chans? }], markers?: [{ t, label }] }
//   o = { minLen = 0.1, still(it) (no source time; default kind 'image'), fps?, canDrop(it, track)?, uid()? }
// Selection is { sel: id | null, multi: id[] }: sel the primary (st.sel, the inspector's clip), multi the others.
// Edits change d in place: clip objects are edited where they stand (the gizmo, the inspector and history.js
// hold them), d.items / d.markers are replaced or spliced, and each edit returns what it did.
// A clip on a locked track is never moved, trimmed, slipped, split, nudged or deleted.
// Times are seconds. An image clip (still) has no source time: trimming its start or splitting it changes its length.
//
// Contract for the engines (the object web/timeline.js timeline(st, o) returns; later waves use these names):
//   TL.pick(it, ev)          click / Shift (range) / Ctrl or Alt (toggle) on a clip; it null = deselect. Sets st.sel, st.multi.
//   TL.picked() → item[]     the selection, primary first
//   TL.isSel(it) → bool      in the selection (primary or multi)
//   TL.place(ids)            restyle only these clips after a drag frame (no full render)
//   TL.tool                  get / set: 'select' | 'razor' | 'ripple' | 'slip' | 'hand'
//   TL.marquee               the box being drawn on the lanes: { t0, t1, tracks: id[] } | null
//   TL.toolStrip() → element the tool strip (Select V, Razor C, Ripple B, Slip Y, Hand H), one per timeline, mounted in the tool bar
//   TL.trackHead(tr, { label, extra }) → element   a track's head: hide (video), mute, solo, lock, a name renamed in place,
//                            drag to reorder among its kind, a height grip (tr.h); extra: the engine's own buttons
//   st.open: clip ids whose keyframe lanes are twirled open (not saved with the doc)
//   o.lanes?.(it, { pps }) → HTMLElement[]   the open clip's keyframe rows (web/key-lanes.js keyLaneRows), put under its
//                            track's row in .tl-inner, a row with no .tl-head of its own gets a left padding of headW. The engines pass
//                            keyLaneRows(it, { pps, fps, tc, channels: [{ ch, label }], eases: [names], base: { ch: unset value },
//                            seek(t), changed() }) with changed = their persist (one undo step).
// ---------------------------------------------------------------------------

import { snapT } from './workarea-math.js';
import { boxPick as stackBoxPick } from './layer-stack.js';

const EPS = 1e-6;
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const r6 = (v) => +v.toFixed(6) || 0;   // (no -0)
const idOf = (o) => (o?.uid ? o.uid() : rid());
const isStill = (it, o) => (o?.still ? !!o.still(it) : it.kind === 'image');
const minOf = (o) => o?.minLen ?? 0.1;
const trackOf = (d, id) => d.tracks.find((t) => t.id === id) || null;
const locked = (d, it) => !!trackOf(d, it.track)?.locked;
const cloneItem = (it) => ({ ...it, ...(it.chans && { chans: structuredClone(it.chans) }) });

// ---- lengths ----
export const lenOf = (it, o) => Math.max(minOf(o), (it.out ?? (it.dur || 3)) - (it.in || 0));
export const endOf = (it, o) => it.at + lenOf(it, o);
// clips that may be edited: these ids, not on a locked track
export const editable = (d, ids) => d.items.filter((it) => ids.includes(it.id) && !locked(d, it));

// ---- selection ----
export const pickedIds = (s) => (s?.sel != null ? [s.sel, ...(s.multi || []).filter((x) => x !== s.sel)] : [...(s?.multi || [])]);
// a list of ids as the selection: sel stays if it is among them, else the last of them (layer-stack setPicked)
export function setPicked(list, sel = null) {
  const s = list.includes(sel) ? sel : list[list.length - 1] ?? null;
  return { sel: s, multi: list.filter((x) => x !== s) };
}
// A click on clip id (null: on nothing). shift: from the primary through id in `order` (ids in pick order:
// track by track, by time), the primary staying; without an order Shift adds. toggle (Ctrl / Alt): in or out.
export function pick(s, id, { shift = false, toggle = false, order = null } = {}) {
  if (id == null) return { sel: null, multi: [] };
  const cur = pickedIds(s);
  if (toggle) {
    if (cur.includes(id)) return setPicked(cur.filter((x) => x !== id), s.sel === id ? null : s.sel);
    return s?.sel != null ? { sel: s.sel, multi: [...(s.multi || []), id] } : { sel: id, multi: [...(s?.multi || [])] };
  }
  if (shift && s?.sel != null) {
    if (order) {
      const a = order.indexOf(s.sel), b = order.indexOf(id);
      if (a >= 0 && b >= 0) return setPicked(order.slice(Math.min(a, b), Math.max(a, b) + 1), s.sel);
    }
    return cur.includes(id) ? { sel: s.sel, multi: [...s.multi] } : { sel: s.sel, multi: [...(s.multi || []), id] };
  }
  return { sel: id, multi: [] };
}
// the pick order for Shift ranges: track by track (as listed), then by time
export function pickOrder(d) {
  const ti = (it) => d.tracks.findIndex((t) => t.id === it.track);
  return [...d.items].sort((a, b) => ti(a) - ti(b) || a.at - b.at).map((it) => it.id);
}
// the clips a box from t0 to t1 over these tracks touches
export function boxItems(d, { t0, t1, tracks }, o) {
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  return d.items.filter((it) => tracks.includes(it.track) && it.at < b && endOf(it, o) > a).map((it) => it.id);
}
// A box drawn over the lanes: the selection after it. op 'new' (what it touches), 'add' (Shift), 'sub' (Alt)
export function boxPick(s, touched, op = 'new') {
  return setPicked(stackBoxPick(touched, pickedIds(s), op), s?.sel ?? null);
}
// every clip that ends after t (from the playhead on); tracks: only these
export function selectFrom(items, t, { tracks = null, o } = {}) {
  return items.filter((it) => endOf(it, o) > t + EPS && (!tracks || tracks.includes(it.track))).map((it) => it.id);
}

// ---- snapping ----
// What a drag snaps to: 0, the playhead, other clips' edges, markers, the work area's ends (sorted, unique)
export function snapPoints(d, { exclude = [], t = null, area = null } = {}, o) {
  const ps = [0];
  if (t != null) ps.push(t);
  for (const it of d.items) if (!exclude.includes(it.id)) ps.push(it.at, endOf(it, o));
  for (const m of d.markers || []) ps.push(m.t);
  if (area) ps.push(area.a, area.b);
  return [...new Set(ps.filter(Number.isFinite).map(r6))].sort((a, b) => a - b);
}
// snap options from o: { points, tol (s), step (the frame grid; 0 off) }; snap false: none
const snapOf = (opts, o) => (opts.snap === false ? null : { points: opts.points || [], tol: opts.tol ?? 0, step: opts.step ?? (o?.fps ? 1 / o.fps : 0) });
// the smallest correction that puts one of these times on a point (or the grid); 0 when none is near
function snapShift(times, sn) {
  if (!sn) return 0;
  let best = null;
  for (const x of times) {
    const y = snapT(x, { points: sn.points, tol: sn.tol, step: 0 });
    if (y !== x && (best == null || Math.abs(y - x) < Math.abs(best))) best = y - x;
  }
  if (best != null) return best;
  if (sn.step > 0 && times.length) return snapT(times[0], { step: sn.step }) - times[0];
  return 0;
}

// ---- drags: grab the clips' state when the pointer goes down, then apply the whole drag to that each frame ----
export const grab = (d) => new Map(d.items.map((it) => [it.id, { at: it.at, in: it.in || 0, out: it.out ?? (it.dur || 3), track: it.track }]));

// Move these clips together by dt (and dTrack rows): the group snaps by whichever clip edge is nearest a point;
// none goes before 0. A row change goes for all or none: refused when a clip would leave the tracks, land on a
// locked track or one o.canDrop refuses. Returns { dt, dTrack } as applied.
export function moveSet(d, ids, g, dt, { dTrack = 0, ...opts } = {}, o) {
  const its = editable(d, ids).filter((it) => g.has(it.id));
  if (!its.length) return { dt: 0, dTrack: 0 };
  const base = its.map((it) => g.get(it.id));
  const lo = Math.min(...base.map((b) => b.at));
  let k = Math.max(dt, -lo);
  const times = its.flatMap((it, i) => [base[i].at + k, base[i].at + k + lenOf({ ...it, in: base[i].in, out: base[i].out }, o)]);
  k = Math.max(-lo, k + snapShift(times, snapOf(opts, o)));
  let rows = dTrack;
  if (rows) {
    const to = its.map((it, i) => d.tracks[d.tracks.findIndex((t) => t.id === base[i].track) + rows]);
    if (to.some((tr, i) => !tr || tr.locked || (o?.canDrop && !o.canDrop(its[i], tr)))) rows = 0;
    else its.forEach((it, i) => { it.track = to[i].id; });
  }
  if (!rows) its.forEach((it, i) => { it.track = base[i].track; });
  its.forEach((it, i) => { it.at = r6(base[i].at + k); });
  return { dt: r6(k), dTrack: rows };
}

// Trim one edge ('l' / 'r') of these clips by dt (dragClip's rules): a clip's start not before its source's start nor
// 0, its end not past its source (a still has none), at least minLen long. Snaps by the moving edge of the clip first in
// ids (the one grabbed), else the first of them on the timeline.
// ripple: the clip keeps its start, and the clips after it on its track follow the change of its end.
// Returns the applied dt.
export function trim(d, ids, g, side, dt, { ripple = false, ...opts } = {}, o) {
  const its = editable(d, ids).filter((it) => g.has(it.id));
  if (!its.length) return 0;
  const lead = its.find((it) => it.id === ids[0]) || its[0], minLen = minOf(o), b0 = g.get(lead.id);
  const edge = side === 'l' ? b0.at : b0.at + (b0.out - b0.in);
  let k = dt + snapShift([edge + dt], snapOf(opts, o));
  for (const it of its) {   // one delta that every clip can take
    const b = g.get(it.id), l = b.out - b.in;
    if (side === 'l') {
      if (!isStill(it, o)) k = Math.max(k, -b.in);
      if (!ripple) k = Math.max(k, -b.at);
      k = Math.min(k, l - minLen);
    } else {
      k = Math.max(k, minLen - l);
      if (!isStill(it, o) && it.dur) k = Math.min(k, it.dur - b.out);
    }
  }
  for (const it of its) {
    const b = g.get(it.id), oldEnd = b.at + (b.out - b.in);
    if (side === 'l') {
      if (ripple) { if (isStill(it, o)) it.out = r6(b.out - k); else it.in = r6(b.in + k); it.at = b.at; }
      else { it.at = r6(b.at + k); if (isStill(it, o)) it.out = r6(b.out - k); else it.in = r6(b.in + k); }
    } else it.out = r6(b.out + k);
    if (ripple) {
      const shift = side === 'l' ? -k : k;
      for (const x of d.items) {
        const bx = g.get(x.id);
        if (x === it || its.includes(x) || !bx || bx.track !== b.track || bx.at < oldEnd - EPS) continue;
        x.at = r6(Math.max(0, bx.at + shift));
      }
    }
  }
  return r6(k);
}

// Slip: the clip stays where it is and shows another part of its source (in and out move together, inside the
// source). A still has no source time: nothing happens. Returns the applied dt.
export function slip(d, id, g, dt, o) {
  const it = editable(d, [id])[0], b = it && g.get(id);
  if (!b || isStill(it, o)) return 0;
  let k = Math.max(dt, -b.in);
  if (it.dur) k = Math.min(k, it.dur - b.out);
  it.in = r6(b.in + k); it.out = r6(b.out + k);
  return r6(k);
}

// ---- edits ----
// Split at t: these clips if one of them is under t, else every clip under it (timeline.js split). The second half
// is a new clip right after the first; it gets its own keys (a still's move to its new start). Returns the new ids.
export function splitAt(d, ids, t, o) {
  const under = d.items.filter((it) => !locked(d, it) && t > it.at + 0.02 && t < endOf(it, o) - 0.02);
  const targets = under.some((it) => ids?.includes(it.id)) ? under.filter((it) => ids.includes(it.id)) : under;
  const made = [];
  for (const a of targets) {
    const e = endOf(a, o), b = { ...cloneItem(a), id: idOf(o), at: t, fadeIn: 0 };
    if (isStill(a, o)) {
      b.out = r6((a.in || 0) + e - t); a.out = r6((a.in || 0) + t - a.at);
      for (const l of Object.values(b.chans || {})) for (const k of l) k.f = +(k.f - (t - a.at)).toFixed(3);
    } else { b.in = r6((a.in || 0) + (t - a.at)); a.out = b.in; }
    a.fadeOut = 0;
    d.items.splice(d.items.indexOf(a) + 1, 0, b);
    made.push(b.id);
  }
  return made;
}
// Delete these clips (not on a locked track). Returns the ids that went.
export function removeItems(d, ids) {
  const gone = editable(d, ids).map((it) => it.id);
  d.items = d.items.filter((it) => !gone.includes(it.id));
  return gone;
}
// merged [a, b] intervals
function union(iv) {
  const s = [...iv].sort((x, y) => x[0] - y[0]), out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1] + EPS) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
// intervals minus what cover takes
function minus(iv, cover) {
  let out = iv;
  for (const [c0, c1] of cover) {
    out = out.flatMap(([a, b]) => (c1 <= a + EPS || c0 >= b - EPS ? [[a, b]]
      : [...(c0 > a + EPS ? [[a, c0]] : []), ...(c1 < b - EPS ? [[c1, b]] : [])]));
  }
  return out;
}
// Delete these clips and close the space they leave on each of their tracks: a later clip moves left by the empty
// time removed before it (space another clip still covers stays). Returns the ids that went.
export function rippleDelete(d, ids, o) {
  const its = editable(d, ids);
  const byTrack = new Map();
  for (const it of its) byTrack.set(it.track, [...(byTrack.get(it.track) || []), [it.at, endOf(it, o)]]);
  const gone = removeItems(d, ids);
  for (const [track, iv] of byTrack) {
    const rest = d.items.filter((x) => x.track === track);
    const holes = minus(union(iv), union(rest.map((x) => [x.at, endOf(x, o)])));
    for (const x of rest) {
      const s = holes.reduce((m, [a, b]) => m + Math.max(0, Math.min(b, x.at) - a), 0);
      if (s > EPS) x.at = r6(Math.max(0, x.at - s));
    }
  }
  return gone;
}
// Close the empty gap at t on a track: the clips after it move left by its length. Returns the length (0: no gap).
export function closeGap(d, track, t, o) {
  if (trackOf(d, track)?.locked) return 0;
  const on = d.items.filter((x) => x.track === track);
  if (on.some((x) => x.at <= t && endOf(x, o) > t)) return 0;
  const after = on.filter((x) => x.at >= t - EPS);
  if (!after.length) return 0;
  const a = on.filter((x) => endOf(x, o) <= t + EPS).reduce((m, x) => Math.max(m, endOf(x, o)), 0);
  const b = Math.min(...after.map((x) => x.at)), gap = b - a;
  if (gap <= EPS) return 0;
  for (const x of after) x.at = r6(x.at - gap);
  return r6(gap);
}
// Copies of these clips right after them (the group keeps its spacing), each with its own keys. Returns the new ids.
export function duplicate(d, ids, o) {
  const its = editable(d, ids);
  if (!its.length) return [];
  const off = Math.max(...its.map((x) => endOf(x, o))) - Math.min(...its.map((x) => x.at));
  const made = its.map((it) => ({ ...cloneItem(it), id: idOf(o), at: r6(it.at + off) }));
  d.items.push(...made);
  return made.map((x) => x.id);
}
// The clipboard for these clips: copies with at counted from the earliest of them
export function copy(d, ids) {
  const its = d.items.filter((it) => ids.includes(it.id));
  if (!its.length) return null;
  const t0 = Math.min(...its.map((x) => x.at));
  return { items: its.map((it) => ({ ...cloneItem(it), at: r6(it.at - t0) })) };
}
// A track a pasted clip may go on: there, not locked, and one o.canDrop takes
const takes = (tr, it, o) => tr && !tr.locked && (!o?.canDrop || o.canDrop(it, tr));
// Paste the clipboard at t: each clip on its own track if it may go there, else the first track that takes it
// (none: left out). New ids, own keys. insert: where a pasted clip would overlap a clip already on its track, the clips
// at and after t on that track move right by the pasted length (to the pasted clips' end) instead of cross-fading.
// Returns the new ids.
export function paste(d, clip, t, o, { insert = true } = {}) {
  const made = [], t0 = Math.max(0, t);
  for (const c of clip?.items || []) {
    const tr = takes(trackOf(d, c.track), c, o) ? trackOf(d, c.track) : d.tracks.find((x) => takes(x, c, o));
    if (!tr) continue;
    made.push({ ...cloneItem(c), id: idOf(o), track: tr.id, at: r6(Math.max(0, t + c.at)) });
  }
  if (insert) {
    for (const track of new Set(made.map((x) => x.track))) {
      const mine = made.filter((x) => x.track === track), old = d.items.filter((x) => x.track === track);
      const hits = mine.some((p) => old.some((x) => x.at < endOf(p, o) - EPS && endOf(x, o) > p.at + EPS));
      if (!hits) continue;
      const room = Math.max(...mine.map((p) => endOf(p, o))) - t0;
      for (const x of old) if (x.at >= t0 - EPS) x.at = r6(x.at + room);
    }
  }
  d.items.push(...made);
  return made.map((x) => x.id);
}
// Move these clips by dt (Alt+arrows), the group not before 0. Returns the applied dt.
export function nudge(d, ids, dt, o) {
  const its = editable(d, ids);
  if (!its.length) return 0;
  const k = Math.max(dt, -Math.min(...its.map((x) => x.at)));
  for (const it of its) it.at = r6(it.at + k);
  return r6(k);
}

// ---- tracks ----
export function trackLock(d, id, on) { const t = trackOf(d, id); if (t) t.locked = !!on; return !!t; }
export function trackSolo(d, id, on) { const t = trackOf(d, id); if (t) t.solo = !!on; return !!t; }
export function trackRename(d, id, name) {
  const t = trackOf(d, id), n = String(name ?? '').trim();
  if (!t) return false;
  if (n) t.name = n; else delete t.name;
  return true;
}
// Move a track to index i (clamped). Returns its new index, or -1.
export function trackReorder(d, id, i) {
  const from = d.tracks.findIndex((t) => t.id === id);
  if (from < 0) return -1;
  const [t] = d.tracks.splice(from, 1), to = Math.max(0, Math.min(d.tracks.length, i));
  d.tracks.splice(to, 0, t);
  return to;
}
// A track's height (px) inside min..max. Returns it.
export function trackHeight(d, id, h, { min = 24, max = 240 } = {}) {
  const t = trackOf(d, id);
  if (!t) return null;
  t.h = Math.round(Math.max(min, Math.min(max, h)));
  return t.h;
}
// The tracks as the export body takes them: solo folded into hidden / muted, the editor-only fields left out.
// Any soloed track: every other track is muted; any soloed video track: every other video track is hidden.
export function exportTracks(tracks) {
  const any = tracks.some((t) => t.solo), anyVid = tracks.some((t) => t.solo && t.kind === 'video');
  return tracks.map(({ solo, locked: _l, name: _n, h: _h, ...t }) => {
    const out = { ...t };
    if (any && !solo) out.muted = true;
    if (anyVid && !solo && t.kind === 'video') out.hidden = true;
    return out;
  });
}

// ---- markers: d.markers [{ t, label }] kept in time order; addressed by index ----
const sortMarkers = (d) => d.markers.sort((a, b) => a.t - b.t);
// A marker at t (one already there within 1 ms is kept). Returns its index.
export function addMarker(d, t, label = '') {
  d.markers = d.markers || [];
  const at = d.markers.findIndex((m) => Math.abs(m.t - t) < 1e-3);
  if (at >= 0) return at;
  const m = { t: r6(Math.max(0, t)), label: String(label) };
  d.markers.push(m); sortMarkers(d);
  return d.markers.indexOf(m);
}
// Move marker i to t. Returns its new index (-1: none).
export function moveMarker(d, i, t) {
  const m = d.markers?.[i];
  if (!m) return -1;
  m.t = r6(Math.max(0, t)); sortMarkers(d);
  return d.markers.indexOf(m);
}
export function removeMarker(d, i) {
  if (!d.markers?.[i]) return false;
  d.markers.splice(i, 1);
  return true;
}
export function renameMarker(d, i, label) {
  if (!d.markers?.[i]) return false;
  d.markers[i].label = String(label ?? '');
  return true;
}
