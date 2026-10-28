// Keyframes, the one engine every animated thing uses (the 3D tab, the Video tab's clips, the Editor's layers):
// a channel's keys [{ f, v, ease? }] sorted by frame, sampled and edited here without any DOM or scene.
// The key editing is the sums behind the 3D key sheet (scene-keys.js). A track is one
// channel of one item, { item, ch, id, kind }: .keys is that channel's list (item.chans[ch], sorted by f),
// each key { f, v, ease? }. A selection is a Set of key objects (a summary diamond in the sheet is just
// the keys under it). Nothing here saves: the caller does, once per gesture.

// Between two keys the blend runs through one of these (the key's own `ease`, else its layer's):
// smooth is the old smoothstep, linear the old Linear; in / out are cubic (the camera moves' slow start and stop); the others are new (const holds until the next key).
// The last three are curves through the keys, like Blender's and After Effects' graph: auto (smooth through
// each key), clamp (auto, but flat at a peak and never past the next key's value) and bezier (handles you drag).
export const EASES = [['', 'Layer default'], ['smooth', 'Smooth'], ['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['const', 'Constant'],
  ['auto', 'Auto'], ['clamp', 'Auto clamped'], ['bezier', 'Bezier']];
export const CURVES = new Set(['auto', 'clamp', 'bezier']);
export const easeFn = {
  smooth: (t) => t * t * (3 - 2 * t), linear: (t) => t, in: (t) => t * t * t, out: (t) => 1 - (1 - t) ** 3, const: () => 0,
};
// (a curve between two joint turns or pose names, which have no handles, blends smooth)
export const easeAt = (name, t) => (easeFn[name] || easeFn.smooth)(t);  // an unknown name (a newer file) reads as smooth

// ---- handles: a curve key's tangents, ti (in) and to (out), each [dt, dv] from the key (dt < 0 in, > 0 out) ----
// A key keeps its own handles only once they are dragged or it is made Bezier; otherwise they are worked out
// from its neighbours (auto: Catmull-Rom's slope, a third of the way to the next key; clamp: monotone, so a
// peak is flat and nothing overshoots). hb: true when the two handles are broken (move one on its own).
const isNum = (v) => typeof v === 'number';
export function autoSlope(list, i, clamp) {
  const k = list[i], p = list[i - 1], n = list[i + 1];
  if (!p || !n || !isNum(p.v) || !isNum(n.v)) return 0;   // (an end key: flat, as the curve holds past it)
  const s0 = (k.v - p.v) / (k.f - p.f), s1 = (n.v - k.v) / (n.f - k.f);
  let m = (n.v - p.v) / (n.f - p.f);
  if (clamp) {
    if (s0 * s1 <= 0) return 0;
    const lim = 3 * Math.min(Math.abs(s0), Math.abs(s1));
    if (Math.abs(m) > lim) m = Math.sign(m) * lim;
  }
  return m;
}
// list[i]'s handle on one side ('ti' | 'to') as [dt, dv]; mode: the segment's ease, for a key that has no curve of its own
export function handleOf(list, i, side, mode = 'auto') {
  const k = list[i];
  if (Array.isArray(k[side])) return k[side];
  const o = side === 'to' ? list[i + 1] : list[i - 1];
  const dt = o ? (o.f - k.f) / 3 : side === 'to' ? 1 : -1;
  const own = CURVES.has(k.ease) ? k.ease : mode;
  return [dt, autoSlope(list, i, own === 'clamp') * dt];
}
// the cubic between list[i] and list[i + 1] at frame f, the bezier solved in time (x(u) = f)
function curveAt(list, i, f, mode) {
  const a = list[i], b = list[i + 1], span = b.f - a.f;
  let [o0, ov] = handleOf(list, i, 'to', mode), [i0, iv] = handleOf(list, i + 1, 'ti', mode);
  o0 = Math.max(0, o0); i0 = Math.min(0, i0);
  const over = (o0 - i0) / span;
  if (over > 1) { o0 /= over; ov /= over; i0 /= over; iv /= over; }  // handles past each other: shortened, as Blender does
  const x1 = o0 / span, x2 = 1 + i0 / span, t = (f - a.f) / span;
  let u = t;
  if (Math.abs(x1 - 1 / 3) > 1e-9 || Math.abs(x2 - 2 / 3) > 1e-9) {  // (thirds: x(u) = u, nothing to solve)
    let lo = 0, hi = 1;
    for (let it = 0; it < 24; it++) {
      const w = 1 - u, x = 3 * w * w * u * x1 + 3 * w * u * u * x2 + u * u * u - t;
      if (Math.abs(x) < 1e-7) break;
      if (x > 0) hi = u; else lo = u;
      const dx = 3 * w * w * x1 + 6 * w * u * (x2 - x1) + 3 * u * u * (1 - x2);
      const nu = u - x / dx;
      u = dx > 1e-9 && nu > lo && nu < hi ? nu : (lo + hi) / 2;
    }
  }
  const w = 1 - u;
  return w * w * w * a.v + 3 * w * w * u * (a.v + ov) + 3 * w * u * u * (b.v + iv) + u * u * u * b.v;
}

// ---- sampling: a channel's value at frame f (held before its first key and after its last, eased between) ----
// lerp(a, b, e) blends two values (numbers by default; the 3D tab's joints slerp, a pose name steps)
export const lerpNum = (a, b, e) => a + (b - a) * e;
export function sampleKeys(list, f, { base, ease = 'smooth', lerp = lerpNum } = {}) {
  if (!list || !list.length) return base;
  if (f <= list[0].f) return list[0].v;
  const last = list[list.length - 1];
  if (f >= last.f) return last.v;
  let lo = 0, hi = list.length - 1;   // list[lo].f <= f < list[hi].f
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].f <= f) lo = mid; else hi = mid; }
  const a = list[lo], b = list[hi], mode = a.ease || ease;   // a key can set its own ease
  if (CURVES.has(mode) && lerp === lerpNum && isNum(a.v) && isNum(b.v)) return curveAt(list, lo, f, mode);
  return lerp(a.v, b.v, easeAt(mode, (f - a.f) / (b.f - a.f)));
}
// put (or change) the key at frame f in chans[ch]; its ease stays unless one is given ('' clears it)
export function putKey(chans, ch, f, v, ease) {
  const list = (chans[ch] ||= []);
  const cv = Array.isArray(v) ? [...v] : v;
  const k = list.find((x) => x.f === f);
  if (k) { k.v = cv; if (ease !== undefined) { if (ease) k.ease = ease; else delete k.ease; } return k; }
  const n = { f, v: cv, ...(ease ? { ease } : {}) };
  list.push(n); list.sort(byF);
  return n;
}
// take away chans[ch]'s key at frame f (the channel goes when it's the last)
export function removeKey(chans, ch, f) {
  const list = chans?.[ch];
  if (!list) return;
  const keep = list.filter((k) => k.f !== f);
  if (keep.length) chans[ch] = keep; else delete chans[ch];
}
// the frame of chans[ch]'s next key after f (dir 1) or before it (-1), or undefined
export const nextKey = (chans, ch, f, dir = 1) => { const l = chans?.[ch] || []; return dir > 0 ? l.find((k) => k.f > f)?.f : l.findLast((k) => k.f < f)?.f; };

// a figure's pose channels: the pose's name, a parameter, one joint's turn; the rest is where it stands
export const isPoseCh = (ch) => ch === 'pn' || ch.startsWith('j.') || ch.startsWith('m.');
export const kindOf = (o) => (!o ? 'cam' : o.type === 'figure' ? 'figure' : 'obj');  // photos and boxes share the OBJ values

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clampF = (f, n) => Math.max(0, Math.min(n - 1, Math.round(num(f))));
const byF = (a, b) => a.f - b.f;
const copyKey = (k) => JSON.parse(JSON.stringify(k));

// one channel of one item as a list of keys (setting .keys keeps item.chans free of empty lists)
export function track(item, ch, { id = null, kind = 'obj' } = {}) {
  return { item, ch, id, kind,
    get keys() { return item.chans?.[ch] || []; },
    set keys(v) { if (v.length) (item.chans ||= {})[ch] = v; else if (item.chans) delete item.chans[ch]; } };
}

export const trackOf = (tracks, key) => tracks.find((T) => T.keys.includes(key)) || null;
// forget keys that are no longer in the scene (after an undo, a deleted layer…)
export function prune(tracks, sel) {
  if (!sel.size) return;
  const all = new Set(tracks.flatMap((T) => T.keys));
  for (const k of sel) if (!all.has(k)) sel.delete(k);
}
export const allKeys = (tracks) => tracks.flatMap((T) => T.keys);
export function bounds(tracks, sel) {
  let lo = Infinity, hi = -Infinity;
  for (const T of tracks) for (const k of T.keys) if (sel.has(k)) { lo = Math.min(lo, k.f); hi = Math.max(hi, k.f); }
  return lo > hi ? null : [lo, hi];
}

// A gesture moves keys live: snapshot first, restore before each step, so a drag is a function of
// the pointer and not of the steps taken (a key pushed over another comes back when you drag away).
export function snapshot(tracks) {
  return tracks.map((T) => ({ T, keys: [...T.keys], copies: new Map(T.keys.map((k) => [k, copyKey(k)])) }));
}
export function restore(snap) {
  for (const { T, keys, copies } of snap) {
    T.keys = [...keys];
    for (const [k, c] of copies) { for (const p of Object.keys(k)) delete k[p]; Object.assign(k, copyKey(c)); }
  }
}

// put each selected key at map(f); one key per frame in a channel: a selected key replaces what it lands
// on, and of two selected keys landing together the later one (by its old frame) wins
function relocate(tracks, sel, map, n) {
  for (const T of tracks) {
    const mine = T.keys.filter((k) => sel.has(k));
    if (!mine.length) continue;
    const rest = T.keys.filter((k) => !sel.has(k)), placed = new Map();
    for (const k of mine) {
      k.f = clampF(map(k.f), n);
      const old = placed.get(k.f);
      if (old) sel.delete(old);
      placed.set(k.f, k);
    }
    T.keys = [...rest.filter((k) => !placed.has(k.f)), ...placed.values()].sort(byF);
  }
}

// shift by dt frames, as a block (it stops at the ends of the clip); returns the shift applied
export function moveBy(tracks, sel, dt, n) {
  const b = bounds(tracks, sel);
  if (!b) return 0;
  dt = Math.max(-b[0], Math.min(n - 1 - b[1], Math.round(num(dt))));
  if (dt) relocate(tracks, sel, (f) => f + dt, n);
  return dt;
}
// stretch the selection in time around frame t0 (Blender's S in the dope sheet)
export function scaleAround(tracks, sel, t0, s, n) {
  s = Math.max(0.05, Math.min(20, num(s, 1)));
  relocate(tracks, sel, (f) => num(t0) + (f - num(t0)) * s, n);
  return s;
}
export function remove(tracks, sel) {
  let c = 0;
  for (const T of tracks) { const k = T.keys.filter((x) => !sel.has(x)); c += T.keys.length - k.length; T.keys = k; }
  sel.clear();
  return c;
}
// '' hands a key back to its layer's setting. Auto and clamp work their handles out (any kept ones go);
// Bezier keeps the handles the key has now, so the curve doesn't jump (tracks: where to find its neighbours).
export function setEase(sel, ease, tracks = []) {
  if (ease === 'bezier') for (const T of tracks) { const l = T.keys; l.forEach((k, i) => { if (sel.has(k)) fixHandles(l, i, k.ease || ''); }); }
  for (const k of sel) {
    if (ease && (easeFn[ease] || CURVES.has(ease))) k.ease = ease; else delete k.ease;
    if (ease === 'auto' || ease === 'clamp') { delete k.ti; delete k.to; delete k.hb; }
  }
}
// give list[i] its own handles, as they are now (mode: its segment's ease when it has no curve of its own)
function fixHandles(list, i, mode) {
  const k = list[i], m = CURVES.has(mode) ? mode : 'auto';
  if (!isNum(k.v)) return;
  const ti = handleOf(list, i, 'ti', m), to = handleOf(list, i, 'to', m);
  k.ti = [...ti]; k.to = [...to];
}
// broken handles move one at a time; aligned ones keep a straight line through the key
export function setBroken(sel, on) { for (const k of sel) { if (on) k.hb = true; else delete k.hb; } }
// drag list[i]'s handle on one side to [dt, dv] (a handle can't cross its key in time). The key gets its own
// handles; an auto key becomes Bezier. Unless broken, the other handle turns to the same slope (its length kept).
export function moveHandle(list, i, side, dt, dv, mode = 'auto') {
  const k = list[i];
  if (!isNum(k.v)) return;
  if (!Array.isArray(k.ti) || !Array.isArray(k.to)) fixHandles(list, i, k.ease || mode);
  if (k.ease === 'auto' || k.ease === 'clamp') k.ease = 'bezier';
  dt = side === 'to' ? Math.max(0.01, dt) : Math.min(-0.01, dt);
  k[side] = [dt, dv];
  if (!k.hb) { const o = side === 'to' ? 'ti' : 'to', s = dv / dt; k[o] = [k[o][0], s * k[o][0]]; }
}

// ---- clipboard: { v: 2, groups: [{ id, kind, ch, keys }] } with the keys deep-copied ----
export function copy(tracks, sel) {
  const groups = [];
  for (const T of tracks) {
    const keys = T.keys.filter((k) => sel.has(k)).map(copyKey);
    if (keys.length) groups.push({ id: T.id ?? null, kind: T.kind, ch: T.ch, keys });
  }
  return groups.length ? { v: 2, groups } : null;
}
export const clipSpan = (clip) => {
  const fs = clip.groups.flatMap((g) => g.keys.map((k) => k.f));
  return [Math.min(...fs), Math.max(...fs)];
};
// which item takes each source item's channels: the picked item when the clipboard is one item's and it
// fits; else the item it came from; else the first free item of its kind (another scene). Returns
// [[group, track]...]: a channel the target doesn't have is left out.
export function targets(tracks, clip, pick) {
  const layers = [...new Map(tracks.map((T) => [T.item, T])).values()];   // (a track stands for its item)
  const srcs = [...new Map(clip.groups.map((g) => [`${g.id ?? ''}|${g.kind}`, g])).values()];
  const used = new Set(), to = new Map();
  for (const g of srcs) {
    const key = `${g.id ?? ''}|${g.kind}`;
    let L = srcs.length === 1 && pick && pick.kind === g.kind ? layers.find((x) => x.item === pick.item) : null;
    L ||= layers.find((x) => !used.has(x) && (x.id ?? null) === (g.id ?? null) && x.kind === g.kind);
    L ||= layers.find((x) => !used.has(x) && x.kind === g.kind);
    if (L) { used.add(L); to.set(key, L); }
  }
  const out = [];
  for (const g of clip.groups) {
    const L = to.get(`${g.id ?? ''}|${g.kind}`), T = L && tracks.find((x) => x.item === L.item && x.ch === g.ch);
    if (T) out.push([g, T]);
  }
  return out;
}
// paste with the first key landing at frame t, the spacing kept. A key past the end is dropped.
// A figure's pose onto another figure keeps that figure where it stands (its location channels are left out).
// Returns { keys: the new ones, dropped, groups: how many channels took any }
export function paste(tracks, clip, t, n, { pick = null } = {}) {
  const [lo] = clipSpan(clip), made = [];
  const withPose = new Set(clip.groups.filter((g) => isPoseCh(g.ch)).map((g) => g.id ?? null));
  let dropped = 0, groups = 0;
  for (const [g, T] of targets(tracks, clip, pick)) {
    if (g.kind === 'figure' && (g.id ?? null) !== (T.id ?? null) && withPose.has(g.id ?? null) && !isPoseCh(g.ch)) continue;
    groups++;
    for (const src of g.keys) {
      const f = Math.round(num(t) + src.f - lo);
      if (f < 0 || f > n - 1) { dropped++; continue; }
      const k = copyKey(src); k.f = f;
      T.keys = T.keys.filter((x) => x.f !== f);  // later wins
      T.keys = [...T.keys, k]; made.push(k);
    }
    T.keys = [...T.keys].sort(byF);
  }
  return { keys: made, dropped, groups };
}

// ---- a new scene length with the animation stretched (or squeezed) to it ----
// Every key of every item (each channel: the camera's, an object's, a figure's joints, fingers and
// parameters) goes from frame f to round(f * to / from), from frame 0; keys that land on one frame merge (the
// later one wins), and nothing goes past the new last frame. from, to: frame counts. Returns the factor.
export function stretchAll(items, from, to) {
  const k = num(to, 1) / Math.max(1, num(from, 1));
  for (const item of items) {
    const tracks = Object.keys(item?.chans || {}).map((ch) => track(item, ch));
    relocate(tracks, new Set(allKeys(tracks)), (f) => f * k, Math.max(1, Math.round(num(to, 1))));
  }
  return k;
}
// how many keys a new length of n frames would cut off (the plain length change drops them)
export const keysPast = (items, n) => items.reduce((c, it) => c + Object.values(it?.chans || {}).reduce((d, l) => d + l.filter((x) => x.f >= n).length, 0), 0);

// ---- live recording: what a held gizmo or slider did over a stretch of playback, as keys ----
// samples: [{ f, v }] in the order they were taken (one per frame shown; playback may loop, so f can
// jump back). Each unbroken run (f going up) replaces the keys inside its span with every `every`-th
// sample from its start, plus its last one (so the release is exact). A later run wins where runs
// overlap. Returns a new sorted list; the keys outside the runs are kept as they are.
export function recordInto(list, samples, every = 3) {
  every = Math.max(1, Math.round(num(every, 3)));
  const runs = [];
  let run = null;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.f)) continue;
    const f = Math.round(s.f);
    if (run && f === run[run.length - 1].f) { run[run.length - 1] = { f, v: s.v }; continue; }   // (the same frame again: the newer value)
    if (!run || f < run[run.length - 1].f) runs.push(run = []);
    run.push({ f, v: s.v });
  }
  let out = [...(list || [])];
  for (const r of runs) {
    const a = r[0].f, b = r[r.length - 1].f;
    out = out.filter((k) => k.f < a || k.f > b);
    let last = -Infinity;
    for (let i = 0; i < r.length; i++) {
      if (i < r.length - 1 && r[i].f - last < every) continue;   // (a slow tablet skips frames: count frames, not samples)
      last = r[i].f;
      out.push({ f: r[i].f, v: Array.isArray(r[i].v) ? [...r[i].v] : r[i].v });
    }
  }
  return out.sort(byF);
}

// ---- channels, for the graph: 'x', 'fov', or 'm.lean' (a figure parameter) ----
export const isScalar = (ch) => ch !== 'pn' && !ch.startsWith('j.');
export function setChan(k, v) {
  if (Number.isFinite(v)) k.v = v;
}
