// ---------------------------------------------------------------------------
// Wires between a table's frames, with no DOM (node tests them: tests/wire_rules.test.mjs). A wire carries a
// frame's output (its picture, its whole edit, its mix) into another frame's Make inputs; it is not a graph of
// operations. Saved on the table payload as
//   wires: [{ id, from, to, kind: 'image' | 'video' | 'sound', n, on, frame? }]
// from / to are frame ids (no run ids, so storage.attachments needs nothing). n numbers a target's inputs per kind in
// plug order ("Image 1", "Image 2", "Video 1"); it is renumbered after a removal, and a field re-pointed at a wire
// follows the wire's id, not its number. on: false keeps the wire but the field uses its own picked value.
// A template field of kind 'audio' takes a 'sound' wire: that mapping is made here only (fieldKind).
// A video frame can also be plugged in as a picture: a wire of kind 'image' from a video frame carries one frame of it,
// frame: 'first' | 'last' | 'playhead' | seconds (default 'first'); the same video may go in twice that way (its first
// and its last frame), never twice as the same frame.
// Every function returns new data; none changes what it is given.
// ---------------------------------------------------------------------------

export const WIRE_KINDS = ['image', 'video', 'sound'];
export const WIRE_LABEL = { image: 'Image', video: 'Video', sound: 'Sound' };
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

// the wire kind a template field takes (null: it takes none)
export const fieldKind = (f) => { const k = f?.kind === 'audio' ? 'sound' : f?.kind; return WIRE_KINDS.includes(k) ? k : null; };
// "Image 1"
export const wireLabel = (w) => `${WIRE_LABEL[w.kind] || w.kind} ${w.n}`;

// What a frame puts out, first the kind its port plugs by default ([]: no out port): a note nothing; a frame with
// nothing in it yet neither. A 3D frame puts out its still (a picture); a video frame its clip, or one frame of it.
const OUT = { image: ['image'], video: ['video', 'image'], sound: ['sound'], scene: ['image'] };
export function outKinds(frame) {
  if (!frame || frame.kind === 'note') return [];
  if (!frame.doc && !frame.preview) return [];
  return [...(OUT[frame.kind] || [])];
}
export const outKind = (frame) => outKinds(frame)[0] || null;

// A frame-of-a-video choice made whole: 'first' | 'last' | 'playhead' | seconds (≥ 0); anything else is 'first'
export const FRAME_PICKS = ['first', 'last', 'playhead'];
export function framePick(v) {
  if (FRAME_PICKS.includes(v)) return v;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 'first';
}
// Whether a wire carries one frame of a video (a picture out of a video frame)
export const isFrameWire = (w) => w?.kind === 'image' && w.frame != null;
// (a wire's identity for repeats: from, to, kind, and which frame for a frame of a video)
const sameWire = (w, from, to, kind, frame) => w.from === from && w.to === to && w.kind === kind && (w.frame ?? null) === (frame ?? null);

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
// (frames given), no repeat of the same from → to of a kind (and frame); on defaults to true. A picture wire from a video
// frame (frames given) always says which frame; a frame field on any other wire goes.
export function migrateWires(wires, frames = null) {
  const byId = frames ? new Map(frames.map((f) => [String(f.id), f])) : null, seen = new Set(), out = [];
  for (const w of Array.isArray(wires) ? wires : []) {
    if (!w || w.from == null || w.to == null || !WIRE_KINDS.includes(w.kind)) continue;
    const from = String(w.from), to = String(w.to);
    if (from === to || (byId && (!byId.has(from) || !byId.has(to)))) continue;
    const fromVideo = byId ? byId.get(from).kind === 'video' : w.frame != null;
    const frame = w.kind === 'image' && fromVideo ? framePick(w.frame) : null;
    const k = `${from}\u0000${to}\u0000${w.kind}\u0000${frame ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const nw = { ...w, id: String(w.id || rid()), from, to, on: w.on !== false };
    if (frame != null) nw.frame = frame; else delete nw.frame;
    out.push(nw);
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

// Plug from → to. kind: the source frame's outKind unless given, and one of its outKinds. A picture out of a video
// frame carries frame (given, else 'first', or 'last' when the first is plugged there already). Refused (wire null, why)
// when a frame is missing, the source puts nothing out ('no-output'; a kind it doesn't put out: 'wrong-kind'), it would
// loop, or the same wire is there. Returns { wires, wire, why }.
export function addWire(wires, { from, to, kind = null, id = null, frame = null }, frames) {
  const src = frames.find((f) => f.id === from), dst = frames.find((f) => f.id === to);
  const no = (why) => ({ wires, wire: null, why });
  if (!src || !dst) return no('missing');
  const kinds = outKinds(src), k = kind || kinds[0];
  if (!k || !kinds.length) return no('no-output');
  if (!kinds.includes(k)) return no('wrong-kind');
  if (cycle(wires, from, to)) return no('cycle');
  let pick = null;
  if (k === 'image' && src.kind === 'video') {
    pick = frame != null ? framePick(frame) : ['first', 'last'].find((p) => !wires.some((w) => sameWire(w, from, to, k, p))) || 'first';
  }
  if (wires.some((w) => sameWire(w, from, to, k, pick))) return no('exists');
  const w = { id: id || rid(), from, to, kind: k, n: 0, on: true };
  if (pick != null) w.frame = pick;
  const out = renumber([...wires, w]);
  return { wires: out, wire: out[out.length - 1], why: null };
}
// One wire changed: on (true | false), frame (a picture out of a video only), n (its place among the target's inputs of
// its kind, 1 first: the rest move up or down). An id not there: the same list back.
export function setWire(wires, id, patch = {}) {
  const at = wires.findIndex((w) => w.id === id);
  if (at < 0) return wires;
  const w = { ...wires[at] };
  if ('on' in patch) w.on = patch.on !== false;
  if ('frame' in patch && isFrameWire(w)) w.frame = framePick(patch.frame);
  if ('mp' in patch) {   // (the megapixels an image wire's picture goes in at; 0: its own size)
    if (patch.mp != null && w.kind === 'image') w.mp = patch.mp; else delete w.mp;
  }
  if ('crop' in patch) {   // (what an image wire's picture is cut to at Run: fractions of it)
    if (patch.crop && w.kind === 'image') w.crop = { x: patch.crop.x, y: patch.crop.y, w: patch.crop.w, h: patch.crop.h };
    else delete w.crop;
  }
  let out = wires.map((x, i) => (i === at ? w : x));
  if (Number.isFinite(+patch.n) && patch.n != null) {
    const peers = out.filter((x) => x.to === w.to && x.kind === w.kind && x.id !== w.id);
    const n = Math.max(1, Math.min(peers.length + 1, Math.round(+patch.n)));
    // (the list's order is the plug order: the wire goes just before the peer now at n, else after the last)
    const rest = out.filter((x) => x.id !== w.id), before = peers[n - 1];
    const i = before ? rest.indexOf(before) : rest.indexOf(peers[peers.length - 1]) + 1;
    out = [...rest.slice(0, i), w, ...rest.slice(i)];
  }
  return renumber(out);
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
export const remap = (wires, idMap, opts = {}) => remapIds(wires, idMap, opts).wires;
// remap, and which new wire each copied one became: { wires, ids: Map(old wire id -> new wire id) } (a copied frame's
// frame.make.wired names wires by id: table.js duplicateFrames points it at the copies)
export function remapIds(wires, idMap, { inputs = false } = {}) {
  const m = idMap instanceof Map ? idMap : new Map(Object.entries(idMap || {}));
  const out = [], ids = new Map();
  for (const w of wires) {
    if (!m.has(w.to) || (!m.has(w.from) && !inputs)) continue;
    const nw = { ...w, id: rid(), from: m.get(w.from) ?? w.from, to: m.get(w.to) };
    ids.set(w.id, nw.id);
    out.push(nw);
  }
  return { wires: renumber(out), ids };
}
// A copied frame's re-pointed fields ({ fieldKey: wireId | false }) on the copied wires: a wire that wasn't copied frees its field
export function remapWired(wired, ids) {
  const out = {};
  for (const [k, v] of Object.entries(wired || {})) {
    if (v === false) out[k] = false;
    else if (ids.has(v)) out[k] = ids.get(v);
  }
  return out;
}

// ---- the wires as a one-way graph (the cycle guard keeps it one way): what a chain reruns (web/chain-run.js) ----
// Only ON wires carry anything: an off wire feeds nothing, so it chains nothing.
const onWires = (wires) => (wires || []).filter((w) => w && w.on !== false);
// the frames reachable from id along ON wires, one way (next: from -> to; back: to -> from)
function reach(wires, id, back) {
  const next = new Map();
  for (const w of onWires(wires)) {
    const [a, b] = back ? [w.to, w.from] : [w.from, w.to];
    next.set(a, [...(next.get(a) || []), b]);
  }
  const seen = new Set(), stack = [...(next.get(id) || [])];
  while (stack.length) {
    const f = stack.pop();
    if (f === id || seen.has(f)) continue;
    seen.add(f);
    stack.push(...(next.get(f) || []));
  }
  return seen;
}
// These frames in run order: each after every one of the set that feeds it (Kahn's sort; ties in the order the frames
// first appear in the wires). A loop can't be plugged, but one in a hand-edited list doesn't hang: what's left goes last.
export function runOrder(wires, ids) {
  const set = new Set(ids), ws = onWires(wires).filter((w) => set.has(w.from) && set.has(w.to));
  const first = [];
  for (const w of onWires(wires)) for (const f of [w.from, w.to]) if (set.has(f) && !first.includes(f)) first.push(f);
  for (const f of set) if (!first.includes(f)) first.push(f);
  const ins = new Map(first.map((f) => [f, 0]));
  for (const w of ws) ins.set(w.to, ins.get(w.to) + 1);
  const out = [], done = new Set();
  for (let more = true; more;) {
    more = false;
    for (const f of first) {
      if (done.has(f) || ins.get(f) > 0) continue;
      out.push(f); done.add(f); more = true;
      for (const w of ws) if (w.from === f) ins.set(w.to, ins.get(w.to) - 1);
      break;
    }
  }
  return [...out, ...first.filter((f) => !done.has(f))];
}
// The frames this one feeds through ON wires, near and far, in run order (not the frame itself)
export const downstream = (wires, frameId) => runOrder(wires, reach(wires, frameId, false));
// The frames that feed this one through ON wires, near and far, in run order (not the frame itself)
export const upstream = (wires, frameId) => runOrder(wires, reach(wires, frameId, true));
// A chain from this frame: it, then everything downstream, in run order
export const chainOf = (wires, frameId) => [frameId, ...downstream(wires, frameId)];
