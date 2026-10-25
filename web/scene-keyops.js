// Key editing without any DOM or scene: the sums behind the key sheet (scene-keys.js). A layer is
// { item, id, kind, names }: item.keys is its list (sorted by f), each key { f, ...values, ease? }.
// A selection is a Set of key objects. Nothing here saves: the caller does, once per gesture.

// Between two keys the blend runs through one of these (the key's own `ease`, else its layer's):
// smooth is the old smoothstep, linear the old Linear; the others are new (const holds until the next key).
export const EASES = [['', 'Layer default'], ['smooth', 'Smooth'], ['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['const', 'Constant']];
export const easeFn = {
  smooth: (t) => t * t * (3 - 2 * t), linear: (t) => t, in: (t) => t * t, out: (t) => 1 - (1 - t) * (1 - t), const: () => 0,
};
export const easeAt = (name, t) => (easeFn[name] || easeFn.smooth)(t);  // an unknown name (a newer file) reads as smooth

// a figure's pose channels; the rest of its key is where it stands
export const POSE = ['j', 'm', 'pn'];
export const kindOf = (o) => (!o ? 'cam' : o.type === 'figure' ? 'figure' : 'obj');  // photos and boxes share the OBJ values

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clampF = (f, n) => Math.max(0, Math.min(n - 1, Math.round(num(f))));
const byF = (a, b) => a.f - b.f;
const copyKey = (k) => JSON.parse(JSON.stringify(k));

export const layerOf = (layers, key) => layers.find((L) => L.item.keys.includes(key)) || null;
// forget keys that are no longer in the scene (after an undo, a deleted layer…)
export function prune(layers, sel) {
  if (!sel.size) return;
  const all = new Set(layers.flatMap((L) => L.item.keys));
  for (const k of sel) if (!all.has(k)) sel.delete(k);
}
export const allKeys = (layers) => layers.flatMap((L) => L.item.keys);
export function bounds(layers, sel) {
  let lo = Infinity, hi = -Infinity;
  for (const L of layers) for (const k of L.item.keys) if (sel.has(k)) { lo = Math.min(lo, k.f); hi = Math.max(hi, k.f); }
  return lo > hi ? null : [lo, hi];
}

// A gesture moves keys live: snapshot first, restore before each step, so a drag is a function of
// the pointer and not of the steps taken (a key pushed over another comes back when you drag away).
export function snapshot(layers) {
  return layers.map((L) => ({ L, keys: [...L.item.keys], copies: new Map(L.item.keys.map((k) => [k, copyKey(k)])) }));
}
export function restore(snap) {
  for (const { L, keys, copies } of snap) {
    L.item.keys = [...keys];
    for (const [k, c] of copies) { for (const p of Object.keys(k)) delete k[p]; Object.assign(k, copyKey(c)); }
  }
}

// put each selected key at map(f); one key per frame: a selected key replaces what it lands on, and of
// two selected keys landing together the later one (by its old frame) wins
function relocate(layers, sel, map, n) {
  for (const L of layers) {
    const mine = L.item.keys.filter((k) => sel.has(k));
    if (!mine.length) continue;
    const rest = L.item.keys.filter((k) => !sel.has(k)), placed = new Map();
    for (const k of mine) {
      k.f = clampF(map(k.f), n);
      const old = placed.get(k.f);
      if (old) sel.delete(old);
      placed.set(k.f, k);
    }
    L.item.keys = [...rest.filter((k) => !placed.has(k.f)), ...placed.values()].sort(byF);
  }
}

// shift by dt frames, as a block (it stops at the ends of the clip); returns the shift applied
export function moveBy(layers, sel, dt, n) {
  const b = bounds(layers, sel);
  if (!b) return 0;
  dt = Math.max(-b[0], Math.min(n - 1 - b[1], Math.round(num(dt))));
  if (dt) relocate(layers, sel, (f) => f + dt, n);
  return dt;
}
// stretch the selection in time around frame t0 (Blender's S in the dope sheet)
export function scaleAround(layers, sel, t0, s, n) {
  s = Math.max(0.05, Math.min(20, num(s, 1)));
  relocate(layers, sel, (f) => num(t0) + (f - num(t0)) * s, n);
  return s;
}
export function remove(layers, sel) {
  let c = 0;
  for (const L of layers) { const k = L.item.keys.filter((x) => !sel.has(x)); c += L.item.keys.length - k.length; L.item.keys = k; }
  sel.clear();
  return c;
}
// '' hands a key back to its layer's setting
export function setEase(sel, ease) {
  for (const k of sel) { if (ease && easeFn[ease]) k.ease = ease; else delete k.ease; }
}

// ---- clipboard: { v: 1, groups: [{ id, kind, keys }] } with the keys deep-copied ----
export function copy(layers, sel) {
  const groups = [];
  for (const L of layers) {
    const keys = L.item.keys.filter((k) => sel.has(k)).map(copyKey);
    if (keys.length) groups.push({ id: L.id ?? null, kind: L.kind, keys });
  }
  return groups.length ? { v: 1, groups } : null;
}
export const clipSpan = (clip) => {
  const fs = clip.groups.flatMap((g) => g.keys.map((k) => k.f));
  return [Math.min(...fs), Math.max(...fs)];
};
// which layer takes each group: the picked layer when the clipboard is one layer's and it fits;
// else the layer it came from; else the first free layer of its kind (another scene)
const fits = (g, L) => g.kind === L.kind;
export function targets(layers, clip, pick) {
  const used = new Set(), out = [];
  const take = (g, L) => { used.add(L); out.push([g, L]); };
  for (const g of clip.groups) {
    let L = clip.groups.length === 1 && pick && fits(g, pick) ? pick : null;
    L ||= layers.find((x) => !used.has(x) && (x.id ?? null) === g.id && fits(g, x));
    L ||= layers.find((x) => !used.has(x) && fits(g, x));
    if (L) take(g, L);
  }
  return out;
}
// paste with the first key landing at frame t, the spacing kept. A key past the end is dropped.
// A figure's pose onto another figure keeps that figure where it stands (fill gives its own values).
// Returns { keys: the new ones, dropped, groups: how many layers took any }
export function paste(layers, clip, t, n, { pick = null, fill = null } = {}) {
  const [lo] = clipSpan(clip), made = [];
  let dropped = 0, groups = 0;
  for (const [g, L] of targets(layers, clip, pick)) {
    const other = (g.id ?? null) !== (L.id ?? null);
    groups++;
    for (const src of g.keys) {
      const f = Math.round(num(t) + src.f - lo);
      if (f < 0 || f > n - 1) { dropped++; continue; }
      let k = copyKey(src); k.f = f;
      if (other && g.kind === 'figure' && fill) {
        const own = fill(L.item, L.names, f), keep = {};
        for (const p of L.names) keep[p] = POSE.includes(p) ? k[p] : own[p];
        k = { ...keep, f, ...(src.ease ? { ease: src.ease } : {}) };
      }
      L.item.keys = L.item.keys.filter((x) => x.f !== f);  // later wins
      L.item.keys.push(k); made.push(k);
    }
    L.item.keys.sort(byF);
  }
  return { keys: made, dropped, groups };
}

// ---- channels, for the graph: 'x', 'fov', or 'm.lean' (a figure parameter) ----
export const isScalar = (ch) => ch !== 'j' && ch !== 'pn' && ch !== 'm';
export const chanOf = (full, ch) => (ch.startsWith('m.') ? num(full.m?.[ch.slice(2)]) : num(full[ch]));
// write a value into a key; full is the key's complete values (a parameter key keeps the others)
export function setChan(k, ch, v, full) {
  if (!Number.isFinite(v)) return;
  if (ch.startsWith('m.')) { k.m = { ...(k.m ?? full.m ?? {}), [ch.slice(2)]: v }; }
  else k[ch] = v;
}
