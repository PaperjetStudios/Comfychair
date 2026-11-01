// Dragging a saved tab along rows that wrap (no DOM: tests/tab_order.test.mjs). rects: each chip's { left, top, w, h } where it sits.
// Where the lifted chip would land, with its middle at x, y: a chip counts as before it if its row is above, or it is on the same row and its middle is to the left.
export function dropIndex(rects, from, x, y) {
  let to = 0;
  rects.forEach((q, i) => {
    if (i === from) return;
    const above = y >= q.top + q.h, level = y >= q.top && y < q.top + q.h;
    if (above || (level && q.left + q.w / 2 < x)) to++;
  });
  return to;
}
// How far chip i slides to make room, as [dx, dy]: to the place of the chip next to it, which may be on another row
export function slideOf(rects, from, to, i) {
  const by = from < to && i > from && i <= to ? -1 : from > to && i >= to && i < from ? 1 : 0;
  if (!by) return null;
  const a = rects[i], b = rects[i + by];
  return [b.left - a.left, b.top - a.top];
}
