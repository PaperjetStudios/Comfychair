// ---------------------------------------------------------------------------
// layer-stack: the rules of a stack of layers, with no DOM (the node tests load it). Layers are bottom first.
//   Groups: E.groups [{ id, name, opacity, blend, collapsed }]; a member says layer.group = id. Members always sit next to
//   each other. Hide and lock on a group set them on its members, so everything else reads the layers as ever.
//   Masks: a mask is a layer of its own (mask.maskOf = its owner's key) with its owner's geometry, drawn only as its owner's
//   see-through: alpha shows, erased hides. It sits right above its owner and is never a row of its own.
//   A mask with maskFor 'adjust' hides nothing: it says where the layer's Colour adjustments (web/adjust.js) apply.
//   Merge: the layers drawn as one new picture, at the place of the topmost, in their group if they share one. Undo brings them back.
//   Undo: stackState() is what a change to the stack changes (no pixels); applyState() puts it back on the same layer objects.
// ---------------------------------------------------------------------------
const FIELDS = ['crop', 'x', 'y', 'scale', 'opacity', 'hidden', 'blend', 'locked', 'label', 'rotation', 'flipX', 'flipY', 'group', 'maskOf', 'maskOff', 'clip', 'adjust', 'maskFor'];
const copy = (v) => (v && typeof v === 'object' ? { ...v } : v);

export function stackState(layers, groups = []) {
  return { groups: groups.map((g) => ({ ...g })), layers: layers.map((l) => ({ l, f: Object.fromEntries(FIELDS.map((k) => [k, copy(l[k])])) })) };
}
export const sameState = (a, b) => a.layers.length === b.layers.length && a.layers.every((x, i) => x.l === b.layers[i].l && JSON.stringify(x.f) === JSON.stringify(b.layers[i].f))
  && JSON.stringify(a.groups) === JSON.stringify(b.groups);
export function applyState(E, st) {
  E.groups = st.groups.map((g) => ({ ...g }));
  E.layers = st.layers.map(({ l, f }) => { for (const k of FIELDS) { const v = copy(f[k]); if (v === undefined) delete l[k]; else l[k] = v; } return l; });
}

// Masks with their owner, members together, nothing pointing at what's gone. Returns a new list of the same layers.
export function normalize(layers, groups = []) {
  const owners = new Set(layers.filter((l) => !l.maskOf).map((l) => l.key));
  const masks = new Map(layers.filter((l) => l.maskOf && owners.has(l.maskOf)).map((l) => [l.maskOf, l]));
  const out = [], placed = new Set();
  const put = (l) => { out.push(l); const m = l.key != null && masks.get(l.key); if (m) out.push(m); };
  for (const l of layers) {
    if (l.maskOf) continue;
    if (!l.group) { put(l); continue; }
    if (placed.has(l.group)) continue;
    placed.add(l.group);
    for (const o of layers) if (o.group === l.group && !o.maskOf) put(o);
  }
  const live = new Set(out.map((l) => l.group).filter(Boolean));
  for (let i = groups.length - 1; i >= 0; i--) if (!live.has(groups[i].id)) groups.splice(i, 1);
  for (const l of out) if (l.group && !groups.some((g) => g.id === l.group)) delete l.group;
  return out;
}
// these layers as one group, at the place of the topmost of them; a mask follows its owner
export function makeGroup(layers, groups, picked, id, name = `Group ${groups.length + 1}`) {
  const members = picked.filter((l) => !l.maskOf);
  if (members.length < 2) return layers;
  groups.push({ id, name, opacity: 1, blend: 'normal', collapsed: false });
  const top = Math.max(...members.map((l) => layers.indexOf(l)));
  const rest = layers.filter((l, i) => !members.includes(l) || i === top);
  const at = rest.indexOf(layers[top]);
  const inOrder = layers.filter((l) => members.includes(l));
  inOrder.forEach((l) => { l.group = id; });
  rest.splice(at, 1, ...inOrder);
  return normalize(rest, groups);
}
export function ungroup(layers, groups, id) {
  for (const l of layers) if (l.group === id) delete l.group;
  return normalize(layers, groups);
}
// what a merge can take: a picture that shows
const mergeable = (l) => !!l && !l.mask && !l.draft && !l.maskOf && !l.hidden;
// the layer l merges down into: the nearest showing one below it, in the same group; null if there is none
export function mergeBelow(layers, l) {
  if (!mergeable(l)) return null;
  for (let i = layers.indexOf(l) - 1; i >= 0; i--) {
    const o = layers[i];
    if (o.maskOf || o.mask || o.draft || o.hidden) continue;
    return (o.group || null) === (l.group || null) ? o : null;
  }
  return null;
}
// of these, what can merge, bottom first (a hidden one stays as it is)
export const mergeSet = (layers, picked) => layers.filter((l) => picked.includes(l) && mergeable(l));
// the group a merge stays in: the one they all share, if any
export const mergeGroup = (list) => (list[0]?.group && list.every((l) => l.group === list[0].group) ? list[0].group : null);
// the merged picture's pixels per canvas unit: as sharp as its sharpest layer, within what a canvas holds
export function mergeScale(list, w, h, maxPixels = 64e6, maxSide = 8192) {
  const k = Math.max(...list.map((l) => 1 / (l.scale || 1)));
  return Math.min(k, Math.sqrt(maxPixels / Math.max(1, w * h)), maxSide / Math.max(1, w, h));
}
// the stack with the list (and its masks) gone and the merged layer at the place of the topmost
export function mergedStack(layers, groups, list, merged) {
  const top = Math.max(...list.map((l) => layers.indexOf(l)));
  const keysGone = new Set(list.map((l) => l.key).filter((k) => k != null));
  const out = [];
  layers.forEach((l, i) => {
    if (i === top) out.push(merged);
    if (!list.includes(l) && !(l.maskOf && keysGone.has(l.maskOf))) out.push(l);
  });
  return normalize(out, groups);
}
// The list top first: a row is { group } (a group's heading) or { layer }. A collapsed group shows its heading only; masks aren't rows.
export function rowsOf(layers, groups = []) {
  const rows = [], seen = new Set();
  for (const l of [...layers].reverse()) {
    if (l.maskOf) continue;
    const g = l.group ? groups.find((x) => x.id === l.group) : null;
    if (g && !seen.has(g.id)) { seen.add(g.id); rows.push({ group: g }); }
    if (!g || !g.collapsed) rows.push({ layer: l, in: g || null });
  }
  return rows;
}
// A row dragged onto another's place (positions in rowsOf). A layer dropped on a member joins that group, dropped on an outsider it leaves; a group moves whole.
export function moveRow(layers, groups, from, to) {
  const rows = rowsOf(layers, groups), a = rows[from], b = rows[to];
  if (!a || !b || a === b) return layers;
  const inRow = (r) => (r.group ? layers.filter((l) => l.group === r.group.id && !l.maskOf) : [r.layer]);
  const moving = inRow(a), target = inRow(b);
  if (target.some((l) => moving.includes(l))) return layers;
  if (a.layer) {
    const g = b.in?.id || null;
    if (g) moving[0].group = g; else delete moving[0].group;
  }
  const rest = layers.filter((l) => !moving.includes(l));
  const down = to > from;   // (the list is top first: further down the list is lower in the stack)
  const anchor = down ? rest.indexOf(target[0]) : rest.indexOf(target[target.length - 1]) + 1;
  rest.splice(anchor, 0, ...moving);
  return normalize(rest, groups);
}
export const plainGroup = (g) => !g || ((g.opacity ?? 1) >= 1 && (!g.blend || g.blend === 'normal'));

// a mask stands exactly where its owner does
export function syncMask(m, o) {
  m.x = o.x; m.y = o.y; m.scale = o.scale; m.crop = o.crop;
  m.rotation = o.rotation; m.flipX = o.flipX; m.flipY = o.flipY;
}

// A mask on an owner that has none yet: the owner gets a key if it lacks one, the mask takes its geometry. Returns the new list.
export function attachMask(layers, groups, owner, mask, key) {
  owner.key ??= key;
  mask.maskOf = owner.key;
  syncMask(mask, owner);
  return normalize(layers.includes(mask) ? layers : [...layers, mask], groups);
}

// the grid: every pct% of the frame's width, from its corner
export const gridStep = (frameW, pct) => Math.max(1, frameW * pct / 100);
export const onGrid = (v, from, step) => from + Math.round((v - from) / step) * step;

// Duplicate: a copy of each of list (a mask in it stands for its owner; the red Masks layer and drafts are left out) over the topmost of
// them, in the same order and place, with its own mask copied too. A copy keeps its group. { newKey(), img(layer), name(layer) } come from
// the caller: img says what a copy draws (a painted layer's canvas can't be shared). Returns { layers, copies }.
export function duplicate(layers, groups, list, { newKey, img = (l) => l.img, name = (l) => l.label || l.name }) {
  const own = new Set();
  for (const l of list) own.add(l.maskOf ? layers.find((o) => o.key === l.maskOf && !o.maskOf) : l);
  const from = layers.filter((l) => own.has(l) && !l.mask && !l.draft);
  if (!from.length) return { layers, copies: [] };
  const twin = (l, extra) => {
    const c = { ...l, crop: { ...l.crop }, img: img(l), ...extra };
    for (const k of ['chans', 'adjust']) if (l[k]) c[k] = structuredClone(l[k]);
    for (const k of ['live', 'thumbEl', 'thumbRev']) delete c[k];
    return c;
  };
  const copies = [], made = [];
  for (const l of from) {
    const c = twin(l, { key: newKey(), label: `${name(l)} copy` }), m = l.key != null && layers.find((o) => o.maskOf === l.key);
    copies.push(c); made.push(c);
    if (m) made.push(twin(m, { key: newKey(), maskOf: c.key, label: `${name(c)} mask` }));
  }
  const top = from[from.length - 1], topMask = top.key != null ? layers.find((o) => o.maskOf === top.key) : null;
  const at = layers.indexOf(topMask || top) + 1;
  return { layers: normalize([...layers.slice(0, at), ...made, ...layers.slice(at)], groups), copies };
}
