// ---------------------------------------------------------------------------
// A 3D frame's renders as its output pins, with no DOM (tests/frame_outs.test.mjs). Every take the frame's Render and Save
// frame made is kept on the frame:
//   frame.outs: [{ id, kind: 'depth' | 'pose' | 'colour' | 'frame', type: 'video' | 'image', gen? | input?, shot?, at, use? }]
// A video is a run (gen: its id; storage.attachments keeps it while the table points at it), a picture one of the project's
// pictures (input: its name). Takes of one kind, type and shot share a pin (its id: slotId, "depth-video", "pose-image-2"),
// which carries the take marked use, else the newest. A wire from a pin says which (wire.out: the pin's id) and its kind is
// the pin's type, so a new take, or another one chosen, goes down the wires already plugged in. Taking a take off the
// list leaves its run in History and its picture in the project's pictures.
// Every function returns new data; none changes what it is given.
// ---------------------------------------------------------------------------

export const OUT_KINDS = ['depth', 'pose', 'colour', 'frame'];
const KIND_LABEL = { depth: 'Depth', pose: 'Pose', colour: 'Colour', frame: 'Frame' };
const TYPES = ['video', 'image'];
const rid = () => Math.random().toString(36).slice(2, 10);

export const slotId = (kind, type, shot = null) => `${kind}-${type}${shot != null ? `-${shot}` : ''}`;
const slotOf = (o) => slotId(o.kind, o.type, o.shot ?? null);
// "Depth video", "Pose picture · shot 2", "Frame"
export function outLabel(o) {
  const base = o.kind === 'frame' ? 'Frame' : `${KIND_LABEL[o.kind] || o.kind} ${o.type === 'video' ? 'video' : 'picture'}`;
  return o.shot != null ? `${base} · shot ${o.shot}` : base;
}
const okRef = (o) => (o.type === 'video' ? Number.isInteger(o.gen) : typeof o.input === 'string' && !!o.input);
const ok = (o) => !!o && OUT_KINDS.includes(o.kind) && TYPES.includes(o.type) && okRef(o);
// pins in a steady order: videos, then pictures, each by kind, then by shot
const rank = (o) => TYPES.indexOf(o.type) * 100 + OUT_KINDS.indexOf(o.kind) * 10;
const order = (a, b) => rank(a) - rank(b) || (a.shot ?? 0) - (b.shot ?? 0);

// A frame's takes made whole: a 3D frame's only, well-formed, each with an id (one without gets its pin's), oldest first
export function takesOf(frame) {
  if (frame?.kind !== 'scene' || !Array.isArray(frame.outs)) return [];
  const seen = new Set(), out = [];
  for (const o of frame.outs) {
    if (!ok(o)) continue;
    const id = String(o.id || slotOf(o));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...o, id });
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}
// The pins: one per kind, type and shot, with the take it carries (the one marked use, else the newest) and how many it has.
// [{ id (slotId), kind, type, shot?, take (its id), gen | input, at, count }]
export function outsOf(frame) {
  const by = new Map();
  for (const t of takesOf(frame)) { const k = slotOf(t); by.set(k, [...(by.get(k) || []), t]); }
  return [...by.entries()].map(([id, list]) => {
    const t = list.find((x) => x.use) || list[list.length - 1];
    return { id, kind: t.kind, type: t.type, ...(t.shot != null && { shot: t.shot }), take: t.id,
      ...(t.type === 'video' ? { gen: t.gen } : { input: t.input }), at: t.at, count: list.length };
  }).sort(order);
}
export const outOf = (frame, id) => outsOf(frame).find((o) => o.id === id) || null;
// A pin's takes, newest first, each with on: whether the pin carries it
export function takesFor(frame, id) {
  const pin = outOf(frame, id);
  return pin ? takesOf(frame).filter((t) => slotOf(t) === id).reverse().map((t) => ({ ...t, on: t.id === pin.take })) : [];
}

// What one render made of a kind and type, added as new takes that their pins now carry. made: [{ gen | input, shot? }]
// (shot: one of an Each shot render; none: one take). Nothing made: outs as they were.
export function keepOuts(outs, kind, type, made, at = Date.now()) {
  const list = Array.isArray(outs) ? outs : [];
  const fresh = (made || []).map((m) => ({ id: rid(), kind, type, ...(type === 'video' ? { gen: m.gen } : { input: m.input }),
    ...(m.shot != null && { shot: m.shot }), at, use: true })).filter(ok);
  if (!fresh.length) return list;
  const slots = new Set(fresh.map(slotOf));
  return [...list.map((o) => (o?.use && slots.has(slotOf(o)) ? (({ use, ...r }) => r)(o) : o)), ...fresh];
}
// The pin a take belongs to carries it from now on
export function useTake(outs, takeId) {
  const list = Array.isArray(outs) ? outs : [], t = list.find((o) => o?.id === takeId);
  if (!t) return list;
  const slot = slotOf(t);
  return list.map((o) => (o === t ? { ...o, use: true } : o?.use && slotOf(o) === slot ? (({ use, ...r }) => r)(o) : o));
}
// Takes off the list (their runs stay in History, their pictures in the project); a pin whose take went carries the newest left
export const dropTakes = (outs, ids) => (Array.isArray(outs) ? outs.filter((o) => !ids.includes(o?.id)) : []);
// A whole pin off: every take of it
export const dropPin = (outs, id) => (Array.isArray(outs) ? outs.filter((o) => !ok(o) || slotOf(o) !== id) : []);
