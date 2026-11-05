// The keyframe lanes' rules (web/key-lanes.js), with no DOM: which keys a clip shows, where they sit, the
// selection and how it survives a move, the ordered group move on the fps grid, box select, paste.
// Keys are { f, v, ease?, … } with f in the clip's own source time (seconds); a clip is { id, at, in } with a shown length len.
const EPS = 1e-3;

// the keys a trimmed clip shows: those inside its source window [in, in + len]
export const shownKeys = (keys, inT, len) => (keys || []).filter((k) => k.f >= inT - EPS && k.f <= inT + len + EPS);
// source time <-> timeline time <-> x
export const keyTime = (it, f) => it.at + f - it.in;
export const keyX = (it, f, pps) => keyTime(it, f) * pps;
export const fAtX = (it, x, pps) => x / pps - it.at + it.in;

// ---- selection: strings that name a key by clip, channel and time, so a re-render finds it again ----
export const selKey = (id, ch, f) => `${id}|${ch}|${Math.round(f * 1e4)}`;
export const isSel = (sel, id, ch, f) => sel.has(selKey(id, ch, f));
// a click: alone, or (toggle) added / removed. Returns a new Set.
export function pickKey(sel, id, ch, f, toggle) {
  const k = selKey(id, ch, f);
  if (!toggle) return new Set([k]);
  const out = new Set(sel);
  if (out.has(k)) out.delete(k); else out.add(k);
  return out;
}
// after a move: moves is [[oldF, newF]...] for one channel; the selection follows its keys
export function remapSel(sel, id, ch, moves) {
  const out = new Set(sel), from = moves.map(([o]) => selKey(id, ch, o));
  const was = from.filter((k) => out.has(k));
  for (const k of was) out.delete(k);
  moves.forEach(([, n], i) => { if (was.includes(from[i])) out.add(selKey(id, ch, n)); });
  return out;
}

// ---- moving a group ----
// The range of shifts (seconds) the selected keys of one channel can take: inside [lo, hi] (the shown ends) and
// short of the nearest key that is not selected on each side by one frame. keys is sorted by f. Returns [min, max] with min <= 0 <= max.
export function moveRange(keys, selected, { lo, hi, fps }) {
  const gap = 1 / fps;
  let mn = -Infinity, mx = Infinity, prev = null;
  keys.forEach((k, i) => {
    if (!selected(k)) { prev = k; return; }
    const next = keys.slice(i + 1).find((x) => !selected(x));
    mn = Math.max(mn, Math.max(lo, prev ? prev.f + gap : -Infinity) - k.f);
    mx = Math.min(mx, Math.min(hi, next ? next.f - gap : Infinity) - k.f);
  });
  return [Math.min(0, mn), Math.max(0, mx)];
}
// the shift to use for a wish dt: on the frame grid when grid is on, and inside the range
export function clampShift(dt, [mn, mx], { fps, grid }) {
  let d = grid ? Math.round(dt * fps) / fps : dt;
  if (d < mn) d = grid ? Math.ceil(mn * fps - 1e-6) / fps : mn;
  if (d > mx) d = grid ? Math.floor(mx * fps + 1e-6) / fps : mx;
  return d < mn - 1e-9 || d > mx + 1e-9 ? 0 : d;
}
// where a key from f0 lands for shift d: rounded to a frame when grid is on, never outside [lo, hi]
export const movedF = (f0, d, { lo, hi, fps, grid }) => {
  const f = grid ? Math.round((f0 + d) * fps) / fps : f0 + d;
  return Math.max(lo, Math.min(hi, f));
};

// ---- box select within a row ----
// the keys whose diamond (pad px each side) touches the box between x0 and x1 px
export function boxKeys(keys, it, pps, x0, x1, pad = 5) {
  const a = Math.min(x0, x1) - pad, b = Math.max(x0, x1) + pad;
  return keys.filter((k) => { const x = keyX(it, k.f, pps); return x >= a && x <= b; });
}

// ---- paste ----
const shapeOf = (v) => (typeof v === 'number' ? 'n' : Array.isArray(v) ? `a${v.length}` : typeof v === 'string' ? 's' : 'o');
// a copy fits a channel when its values are the same kind as that channel's (a number onto a number…)
export const compatible = (src, dst) => !!src?.length && (!dst?.length || shapeOf(src[0].v) === shapeOf(dst[0].v));
// the copied keys with the first one at source time t, spacing kept, on the frame grid; keys outside [lo, hi] are dropped.
// Returns { keys: deep copies, dropped }.
export function pastePlan(src, t, { lo, hi, fps }) {
  const sorted = [...src].sort((a, b) => a.f - b.f), base = Math.round(t * fps) / fps, keys = [];
  let dropped = 0;
  for (const k of sorted) {
    const f = Math.round((base + k.f - sorted[0].f) * fps) / fps;
    if (f < lo - EPS || f > hi + EPS) { dropped++; continue; }
    keys.push({ ...JSON.parse(JSON.stringify(k)), f });
  }
  return { keys, dropped };
}
// existing keys with the new ones put in: a new key replaces one on the same frame
export const mergeKeys = (existing, added) => [...existing.filter((k) => !added.some((n) => Math.abs(n.f - k.f) < 1e-4)), ...added].sort((a, b) => a.f - b.f);

// ---- labels ----
export const fmtValue = (v) => (typeof v === 'number' ? (Math.round(v * 100) / 100).toFixed(2)
  : Array.isArray(v) ? v.map(fmtValue).join(', ') : v == null ? '' : String(v));
export const keyTitle = (label, k, t, tc) => `${label} ${fmtValue(k.v)} at ${tc(t)}`.replace('  ', ' ');
