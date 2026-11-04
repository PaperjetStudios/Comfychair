// ---------------------------------------------------------------------------
// Wires between a table's frames, with no DOM (node tests them: tests/wire_rules.test.mjs). A wire carries a
// frame's output (its picture, its whole edit, its mix) into another frame's Make inputs; it is not a graph of
// operations. Saved on the table payload as
//   wires: [{ id, from, to, kind: 'image' | 'video' | 'sound', n, on }]
// from / to are frame ids (no run ids, so storage.attachments needs nothing). n numbers a target's inputs per kind in
// plug order ("Image 1", "Image 2", "Video 1"); it is renumbered after a removal, and a field re-pointed at a wire
// follows the wire's id, not its number. on: false keeps the wire but the field uses its own picked value.
// A template field of kind 'audio' takes a 'sound' wire: that mapping is made here only (fieldKind).
// Every function returns new data; none changes what it is given.
// ---------------------------------------------------------------------------

export const WIRE_KINDS = ['image', 'video', 'sound'];
export const WIRE_LABEL = { image: 'Image', video: 'Video', sound: 'Sound' };
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

// the wire kind a template field takes (null: it takes none)
export const fieldKind = (f) => { const k = f?.kind === 'audio' ? 'sound' : f?.kind; return WIRE_KINDS.includes(k) ? k : null; };
// "Image 1"
export const wireLabel = (w) => `${WIRE_LABEL[w.kind] || w.kind} ${w.n}`;

// What a frame puts out, or null (no out port): a note never; a frame with nothing in it yet neither.
// A 3D frame puts out its still (a picture).
export function outKind(frame) {
  if (!frame || frame.kind === 'note') return null;
  if (!frame.doc && !frame.preview) return null;
  return { image: 'image', video: 'video', sound: 'sound', scene: 'image' }[frame.kind] || null;
}

// n per target and kind, in the order the wires were plugged (their order in the list)
export function renumber(wires) {
  const seen = new Map();
  return wires.map((w) => {
    const k = `${w.to}\u0000${w.kind}`, n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return w.n === n ? w : { ...w, n };
  });
}

// A saved list made whole: well-formed wires only, none from a frame to itself, none naming a frame that is gone
// (frames given), no repeat of the same from → to of a kind; on defaults to true.
export function migrateWires(wires, frames = null) {
  const ids = frames ? new Set(frames.map((f) => String(f.id))) : null, seen = new Set(), out = [];
  for (const w of Array.isArray(wires) ? wires : []) {
    if (!w || w.from == null || w.to == null || !WIRE_KINDS.includes(w.kind)) continue;
    const from = String(w.from), to = String(w.to), k = `${from}\u0000${to}\u0000${w.kind}`;
    if (from === to || seen.has(k) || (ids && (!ids.has(from) || !ids.has(to)))) continue;
    seen.add(k);
    out.push({ ...w, id: String(w.id || rid()), from, to, on: w.on !== false });
  }
  return renumber(out);
}

// Whether a wire from → to would close a loop (or is a frame to itself): to already feeds from
export function cycle(wires, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const w of wires) next.set(w.from, [...(next.get(w.from) || []), w.to]);
  const seen = new Set(), stack = [to];
  while (stack.length) {
    const f = stack.pop();
    if (f === from) return true;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...(next.get(f) || []));
  }
  return false;
}

// Plug from → to. kind: the source frame's outKind unless given. Refused (wire null, why) when a frame is missing,
// the source puts nothing out, it would loop, or the same wire is there. Returns { wires, wire, why }.
export function addWire(wires, { from, to, kind = null, id = null }, frames) {
  const src = frames.find((f) => f.id === from), dst = frames.find((f) => f.id === to);
  const no = (why) => ({ wires, wire: null, why });
  if (!src || !dst) return no('missing');
  const k = kind || outKind(src);
  if (!k || !WIRE_KINDS.includes(k)) return no('no-output');
  if (cycle(wires, from, to)) return no('cycle');
  if (wires.some((w) => w.from === from && w.to === to && w.kind === k)) return no('exists');
  const out = renumber([...wires, { id: id || rid(), from, to, kind: k, n: 0, on: true }]);
  return { wires: out, wire: out[out.length - 1], why: null };
}
// Unplug these wires; the rest renumbered
export const removeWires = (wires, ids) => renumber(wires.filter((w) => !ids.includes(w.id)));
// Frames deleted: their wires go; the rest renumbered
export const dropFrames = (wires, frameIds) => renumber(wires.filter((w) => !frameIds.includes(w.from) && !frameIds.includes(w.to)));

// A frame's plugged inputs: image, then video, then sound, each by n
export function inputsFor(wires, frameId) {
  return wires.filter((w) => w.to === frameId)
    .sort((a, b) => WIRE_KINDS.indexOf(a.kind) - WIRE_KINDS.indexOf(b.kind) || a.n - b.n);
}

// Which template field each input goes into. The Nth input of a kind goes to the Nth field of that kind, skipping
// `skip` (a field key or keys: an image frame's own "this frame" field, make-rules frameImageField). overrides
// ({ fieldKey: wireId | false }, frame.make.wired): a wire id puts that wire in that field instead (same kind
// only; a wire that is gone frees the field); false keeps the field on its own value. An input no field takes is spare.
// Returns { map: { fieldKey: wire } (on or off), use: { fieldKey: wire } (on only), spare: [wire] }.
export function mapToFields(fields, inputs, { skip = [], overrides = {} } = {}) {
  const skips = new Set([].concat(skip ?? []).map((s) => (typeof s === 'object' ? s?.key : s)));
  const open = (fields || []).filter((f) => fieldKind(f) && !skips.has(f.key));
  const map = {}, taken = new Set();
  for (const f of open) {
    const ov = overrides?.[f.key];
    if (ov == null || ov === false) continue;
    const w = inputs.find((x) => x.id === ov);
    if (w && w.kind === fieldKind(f) && !taken.has(w.id)) { map[f.key] = w; taken.add(w.id); }
  }
  for (const kind of WIRE_KINDS) {
    const free = open.filter((f) => fieldKind(f) === kind && !(f.key in map) && overrides?.[f.key] !== false);
    const rest = inputs.filter((w) => w.kind === kind && !taken.has(w.id)).sort((a, b) => a.n - b.n);
    rest.forEach((w, i) => { if (free[i]) { map[free[i].key] = w; taken.add(w.id); } });
  }
  const use = Object.fromEntries(Object.entries(map).filter(([, w]) => w.on !== false));
  return { map, use, spare: inputs.filter((w) => !taken.has(w.id)) };
}

// Wires for copied frames (idMap: old frame id → new). A wire between two copied frames is copied onto the copies;
// with inputs: true a wire into a copied frame from one not copied is copied too (it still comes from the original).
// New wire ids; numbered on their own (renumber the list they join).
export function remap(wires, idMap, { inputs = false } = {}) {
  const m = idMap instanceof Map ? idMap : new Map(Object.entries(idMap || {}));
  const out = [];
  for (const w of wires) {
    if (!m.has(w.to) || (!m.has(w.from) && !inputs)) continue;
    out.push({ ...w, id: rid(), from: m.get(w.from) ?? w.from, to: m.get(w.to) });
  }
  return renumber(out);
}
