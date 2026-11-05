// Several frames on a table made into one, with no DOM (web/frame-combine.js reads the documents and makes the frame;
// tests/combine_rules.test.mjs checks this in node).
//
//   combineKind(frames)     what they make: only pictures an image, only 3D (with or without pictures) a scene, only sounds a mix,
//                           anything else a timeline. null when fewer than two can take part.
//   combinable(frames)      the ones that take part: a note, a hidden frame and a locked one stay as they are.
//   readingOrder(frames)    left to right along rows, top to bottom: the order clips go on a timeline.
//   combineImages(sources)  sources: [{ frame, payload, rect }] bottom first (rect: what of the edit the frame shows). Each frame's
//                           layers, groups and masks, as they sit on the table (or, stack: all centred on the largest canvas).
//   combineClips(sources)   sources: [{ tracks, items }] in order, each starting where the one before it ends.
//   combineScenes(payloads) the first scene's camera, room and shape, with every scene's objects where they were.
// Everything copied gets new ids: a duplicated frame's document has the same layer keys and clip ids as its original.

const rid = () => Math.random().toString(36).slice(2, 10);

export const combinable = (frames) => (frames || []).filter((f) => f && f.kind !== 'note' && !f.hidden && !f.locked);

export function combineKind(frames) {
  const list = combinable(frames);
  if (list.length < 2) return null;
  const kinds = new Set(list.map((f) => f.kind));
  if (kinds.size === 1 && kinds.has('image')) return 'image';
  if (kinds.size === 1 && kinds.has('sound')) return 'sound';
  if (kinds.has('scene') && [...kinds].every((k) => k === 'scene' || k === 'image')) return 'scene';
  return 'video';
}

export function readingOrder(frames) {
  const rows = [];
  for (const f of [...frames].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && f.y < row.top + row.h / 2) { row.list.push(f); row.h = Math.max(row.h, f.h); } else rows.push({ top: f.y, h: f.h, list: [f] });
  }
  return rows.flatMap((r) => r.list.sort((a, b) => a.x - b.x));
}

// Where each source's canvas sits on the new one, and how big that and its preview on the table are.
// Sizes are the frames' own output pixels. Their gaps on the table grow by the largest scale from table to output, so none overlap
// that didn't on the table.
export function canvasLayout(sources, { stack = false } = {}) {
  const fs = sources.map((s) => s.frame), left = Math.min(...fs.map((f) => f.x)), top = Math.min(...fs.map((f) => f.y));
  const k = Math.max(...sources.map((s) => Math.max(s.rect.w / s.frame.w, s.rect.h / s.frame.h)));
  if (stack) {
    const w = Math.max(...sources.map((s) => s.rect.w)), h = Math.max(...sources.map((s) => s.rect.h));
    return { size: { w, h }, at: sources.map((s) => ({ x: Math.round((w - s.rect.w) / 2), y: Math.round((h - s.rect.h) / 2) })),
      tile: { x: left, y: top, w: Math.max(1, Math.round(w / k)), h: Math.max(1, Math.round(h / k)) } };
  }
  const at = sources.map((s) => ({ x: Math.round((s.frame.x - left) * k), y: Math.round((s.frame.y - top) * k) }));
  const w = Math.max(...sources.map((s, i) => at[i].x + s.rect.w)), h = Math.max(...sources.map((s, i) => at[i].y + s.rect.h));
  return { size: { w, h }, at, tile: { x: left, y: top, w: Math.max(1, Math.round(w / k)), h: Math.max(1, Math.round(h / k)) } };
}

// A layer of a source moved by (dx, dy): its keyed position moves with it
function movedLayer(l, dx, dy) {
  const out = { ...structuredClone(l), x: (l.x || 0) + dx, y: (l.y || 0) + dy };
  for (const [ch, d] of [['x', dx], ['y', dy]]) {
    if (Array.isArray(out.chans?.[ch])) out.chans[ch] = out.chans[ch].map((key) => ({ ...key, v: key.v + d }));
  }
  return out;
}

export function combineImages(sources, { stack = false, newId = rid } = {}) {
  const { size, at, tile } = canvasLayout(sources, { stack });
  const layers = [], groups = [];
  sources.forEach((s, i) => {
    const p = s.payload || {}, own = p.v === 2 ? p.layers || [] : [...(p.layers || [])].reverse();
    const dx = at[i].x - s.rect.x, dy = at[i].y - s.rect.y;
    const keys = new Map(own.filter((l) => l.key).map((l) => [l.key, newId()])), groupIds = new Map();
    for (const g of p.groups || []) {
      groupIds.set(g.id, newId());
      groups.push({ ...g, id: groupIds.get(g.id) });
    }
    // (several plain layers keep together under their frame's name, so the frame can be moved as one)
    const owners = own.filter((l) => !l.maskOf);
    let whole = null;
    if (!groupIds.size && owners.length > 1) {
      whole = newId();
      groups.push({ id: whole, name: s.frame.label || 'Frame', opacity: 1, blend: 'normal', collapsed: false });
    }
    for (const l of own) {
      const c = movedLayer(l, dx, dy);
      c.key = keys.get(l.key) || newId();
      if (l.maskOf) c.maskOf = keys.get(l.maskOf) || l.maskOf;
      if (l.group) c.group = groupIds.get(l.group);
      if (!c.group) delete c.group;
      if (whole && !l.maskOf) c.group = whole;
      if (owners.length === 1 && !l.maskOf && s.frame.label) c.label = l.label || s.frame.label;
      layers.push(c);
    }
  });
  const p0 = sources[0].payload || {}, anims = sources.map((s) => s.payload?.anim).filter(Boolean);
  return { tile, out: size,
    payload: { v: 2, size, cols: 2, gap: 0, bg: p0.bg || '#000000', clear: sources.every((s) => !!s.payload?.clear), out: Math.max(...sources.map((s) => s.payload?.out || 1)),
      mp: 0, snap: p0.snap !== false, arrange: null, anim: anims.length ? anims.reduce((a, b) => ((b.len || 0) > (a.len || 0) ? b : a)) : null, items: [], layers, groups } };
}

const clipLen = (it) => Math.max(0.1, (it.out ?? (it.dur || 3)) - (it.in || 0));
export const clipsEnd = (items) => (items || []).reduce((m, it) => Math.max(m, (it.at || 0) + clipLen(it)), 0);

// tracks: the new timeline's first tracks. A source's nth track of a kind goes on the nth of that kind (more are added); a track
// it hid or muted stays apart, so its clips stay hidden. sound: a sound edit's tracks have no kind and take anything it can hear.
export function combineClips(sources, { tracks = [], sound = false, newId = rid } = {}) {
  const out = { tracks: tracks.map((t) => ({ ...t })), items: [] };
  const kindOf = (t, it) => (sound ? 'sound' : t?.kind || (it?.kind === 'audio' ? 'audio' : 'video'));
  for (const src of sources) {
    const start = clipsEnd(out.items), ids = new Map((src.items || []).map((it) => [it.id, newId()])), onto = new Map(), used = {};
    const mapTrack = (it) => {
      if (onto.has(it.track)) return onto.get(it.track);
      const t = (src.tracks || []).find((x) => x.id === it.track), k = kindOf(t, it);
      if (t && (t.hidden || t.muted)) {
        const apart = { id: newId(), ...(sound ? {} : { kind: k }), ...(t.hidden && { hidden: true }), ...(t.muted && { muted: true }) };
        out.tracks.push(apart); onto.set(it.track, apart.id);
        return apart.id;
      }
      const n = used[k] = (used[k] || 0) + 1;
      let free = out.tracks.filter((x) => !x.hidden && !x.muted && kindOf(x) === k)[n - 1];
      if (!free) out.tracks.push(free = { id: newId(), ...(sound ? {} : { kind: k }) });
      onto.set(it.track, free.id);
      return free.id;
    };
    for (const it of src.items || []) {
      const c = { ...structuredClone(it), id: ids.get(it.id), track: mapTrack(it), at: (it.at || 0) + start };
      if (c.cont?.of) { if (ids.has(c.cont.of)) c.cont.of = ids.get(c.cont.of); else delete c.cont; }
      if (!sound && it.kind === 'video' && kindOf((src.tracks || []).find((x) => x.id === it.track), it) === 'audio') c.kind = 'audio';
      out.items.push(c);
    }
  }
  return out;
}

export function combineScenes(payloads, { newId = rid } = {}) {
  const first = structuredClone(payloads[0]);
  return { ...first,
    seconds: Math.max(...payloads.map((p) => p.seconds || 0)) || first.seconds,
    room: payloads.find((p) => p.room)?.room ? structuredClone(payloads.find((p) => p.room).room) : null,
    objects: payloads.flatMap((p) => (p.objects || []).map((o) => ({ ...structuredClone(o), id: newId() }))) };
}
