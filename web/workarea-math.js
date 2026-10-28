// ---------------------------------------------------------------------------
// The work area's maths (workarea.js draws it): a range { a, b, on } on a timeline that the playhead is bound to
// while `on`. Pure functions, no DOM, so node tests them (tests/workarea.test.mjs).
//
// Units are the timeline's own: seconds (Video, Sound, the Editor's animation) or frames (the 3D key sheet).
// A stored range is { a, b, on } with a < b; `on: false` keeps it but lets the playhead go anywhere.
// ---------------------------------------------------------------------------

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// A stored value as a usable range, or null: ordered, inside 0..len, at least minLen long. on defaults to true.
export function norm(r, len = Infinity, minLen = 0) {
  if (!r || !fin(r.a) || !fin(r.b)) return null;
  let a = Math.max(0, Math.min(r.a, r.b)), b = Math.max(r.a, r.b);
  if (fin(len)) b = Math.min(b, len);
  if (!(b - a > minLen) || b - a <= 1e-9) return null;
  return { a, b, on: r.on !== false };
}
// the range the playhead is bound to now (null: none, or switched off)
export function bound(r, len = Infinity, minLen = 0) {
  const n = norm(r, len, minLen);
  return n && n.on ? n : null;
}

export const clampT = (t, r) => (r ? Math.min(r.b, Math.max(r.a, t)) : t);

// Where play starts: inside the range it starts where it is; outside it, or at its end, from the in point.
// Without a range: from the start once it is at the end (eps: how near the end counts as the end).
export function playFrom(t, r, len, eps = 0) {
  if (r) return t < r.a || t >= r.b - eps ? r.a : t;
  return t >= len - eps ? 0 : t;
}

// One step of play: t is where the clock says the playhead is now. Past the end (the range's out point, else
// len) it goes back to the start (the in point, else 0) with loop on, else it stops at the end.
// inclusive: the end is the last frame (the 3D sheet's whole frames), so only t > end is past it.
export function tickT(t, r, len, loop, inclusive = false) {
  const a = r ? r.a : 0, b = r ? r.b : len;
  if (inclusive ? t > b : t >= b) {
    if (loop && b > a) return { t: a, wrap: true, stop: false };
    return { t: b, wrap: false, stop: true };
  }
  if (t < a) return { t: a, wrap: false, stop: false };
  return { t, wrap: false, stop: false };
}

// Snap t onto the nearest point within tol, else onto the step grid (step 0: no grid)
export function snapT(t, { step = 0, points = [], tol = 0 } = {}) {
  let best = null, d = tol;
  for (const p of points) if (fin(p) && Math.abs(p - t) <= d) { d = Math.abs(p - t); best = p; }
  if (best != null) return best;
  return step > 0 ? Math.round(t / step) * step : t;
}

// ---- edits: each returns the new range (or null) ----
// a range drawn from one time to another (either way round)
export function span(t0, t1, len = Infinity, minLen = 0) {
  return norm({ a: Math.min(t0, t1), b: Math.max(t0, t1), on: true }, len, minLen);
}
// the in point at t (I): without a range the out point is the end; an in point past the out point moves the
// out point to the end
export function setIn(r, t, len, minLen = 0) {
  const n = norm(r, len);
  const b = n && t < n.b - minLen ? n.b : len;
  return norm({ a: Math.max(0, t), b, on: n ? n.on : true }, len, minLen) || n;
}
// the out point at t (O): without a range the in point is the start; one before the in point moves it to the start
export function setOut(r, t, len, minLen = 0) {
  const n = norm(r, len);
  const a = n && t > n.a + minLen ? n.a : 0;
  return norm({ a, b: Math.min(len, t), on: n ? n.on : true }, len, minLen) || n;
}
// a handle dragged to t: the other end stays (and the range keeps at least minLen)
export function dragEnd(r, end, t, len, minLen = 0) {
  if (end === 'a') return { ...r, a: Math.max(0, Math.min(t, r.b - minLen)) };
  return { ...r, b: Math.min(len, Math.max(t, r.a + minLen)) };
}
// the whole range slid to start at a (its length kept, inside 0..len)
export function slide(r, a, len) {
  const w = r.b - r.a;
  const x = Math.max(0, fin(len) ? Math.min(len - w, a) : a);
  return { ...r, a: x, b: x + w };
}

// ---- exports ----
// The frames a render of the range covers: { first, count } of a timeline of `total` frames at fps (fps 1 for a
// timeline already in frames, with inclusive: the out point's frame is in it)
export function frameSpan(r, total, fps = 1, inclusive = false) {
  if (!r) return { first: 0, count: total };
  const first = Math.max(0, Math.min(total - 1, Math.round(r.a * fps)));
  const last = inclusive ? Math.round(r.b * fps) : Math.round(r.b * fps) - 1;
  return { first, count: Math.max(1, Math.min(total - 1, last) - first + 1) };
}

// Clips cut to the range a..b and moved so a is 0: what an export of only the range is made from. A clip outside
// it is left out; one across an end is trimmed there (a cut end loses its fade). len(it): its length on the
// timeline; still(it): no source time (an image: a trimmed start shortens it, and its keys move with its start).
// Keys of a clip with source time stay put: they are in the source's time, so the trim keeps them on the picture.
export function cutItems(items, r, { len, still = () => false }) {
  if (!r) return items;
  const out = [];
  for (const it of items) {
    const s = it.at, e = it.at + len(it);
    if (e <= r.a + 1e-9 || s >= r.b - 1e-9) continue;
    const ns = Math.max(s, r.a), ne = Math.min(e, r.b), head = ns - s;
    const c = { ...it, at: +(ns - r.a).toFixed(6) };
    if (still(it)) {
      c.out = (it.in || 0) + (ne - ns);
      if (head > 0 && it.chans) {
        c.chans = Object.fromEntries(Object.entries(it.chans).map(([ch, ks]) => [ch, ks.map((k) => ({ ...k, f: +(k.f - head).toFixed(6) }))]));
      }
    } else {
      c.in = (it.in || 0) + head;
      c.out = (it.in || 0) + (ne - s);
    }
    if (head > 1e-9) c.fadeIn = 0;
    if (ne < e - 1e-9) c.fadeOut = 0;
    out.push(c);
  }
  return out;
}
