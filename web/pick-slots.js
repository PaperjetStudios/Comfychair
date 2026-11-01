// Ticking several pictures in the image picker, and which slots of a template they fill. No DOM (tests/pick_slots.test.mjs).

// The slots a pick from this field fills: the field itself, then the empty ones of its group, going on from it and round to
// the start. A group here is several image inputs under one title (H3's References); a field alone gets just itself.
export function slotsFrom(fields, key, values) {
  const me = (fields || []).find((f) => f.key === key);
  if (!me) return [key];
  const group = fields.filter((f) => f.kind === 'image' && f.group === me.group);
  const at = group.indexOf(me);
  const after = [...group.slice(at + 1), ...group.slice(0, at)];
  return [key, ...after.filter((f) => !values?.[f.key]).map((f) => f.key)];
}

// sel: a Map of key -> item, in the order they were ticked. False when there is no room for it.
export function tick(sel, item, on, limit = Infinity) {
  if (!on) { sel.delete(item.key); return true; }
  if (sel.has(item.key)) return true;
  if (sel.size >= limit) return false;
  sel.set(item.key, item);
  return true;
}

// Everything from one row position to another ticked (shift-click), in the direction clicked. Items that can't be ticked
// (a clip that needs a frame chosen) are passed over. False when it ran out of room.
export function tickRange(sel, items, from, to, limit = Infinity) {
  const step = to >= from ? 1 : -1;
  for (let i = from; i !== to + step; i += step) {
    if (items[i]?.get && !tick(sel, items[i], true, limit)) return false;
  }
  return true;
}
