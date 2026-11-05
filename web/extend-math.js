// Extend's sums: how much the canvas grows on each side, and the parts of the grown canvas that are marked to be drawn.
// Pure (node --test tests/extend_math.test.mjs); web/inpaint.js uses them for the Extend tool.
//   d: { l, r, t, b } pixels added on each side
//   grownSize(w, h, d)         { w, h } of the canvas once grown
//   bothSides(w, h, share)     d growing every side by share of the longer side (a multiple of 8)
//   toShape(w, h, aspect)      d growing the shorter way, split evenly, until the canvas is that shape (a multiple of 8 each side)
//   newParts(w, h, d, o)       the grown canvas's new strips as rects { x, y, w, h }, each reaching o px into the old picture
//   overlapOf(w, h, share)     o: how much of the old edge joins the mask, a share of the longer side
export const NONE = Object.freeze({ l: 0, r: 0, t: 0, b: 0 });
export const any = (d) => !!(d && (d.l || d.r || d.t || d.b));

export const grownSize = (w, h, d) => ({ w: w + d.l + d.r, h: h + d.t + d.b });

export function bothSides(w, h, share) {
  const add = Math.round(Math.max(w, h, 1) * share / 8) * 8;
  return { l: add, r: add, t: add, b: add };
}

export function toShape(w, h, aspect) {
  if (!(aspect > 0) || !w || !h) return { ...NONE };
  if (w / h < aspect) { const add = Math.round((h * aspect - w) / 16) * 8; return { l: add, r: add, t: 0, b: 0 }; }
  const add = Math.round((w / aspect - h) / 16) * 8;
  return { l: 0, r: 0, t: add, b: add };
}

export const overlapOf = (w, h, share) => Math.round(Math.max(w, h) * share);

export function newParts(w0, h0, d, o) {
  const { w, h } = grownSize(w0, h0, d), rects = [];
  if (d.l) rects.push({ x: 0, y: 0, w: d.l + o, h });
  if (d.r) rects.push({ x: w - d.r - o, y: 0, w: d.r + o, h });
  if (d.t) rects.push({ x: 0, y: 0, w, h: d.t + o });
  if (d.b) rects.push({ x: 0, y: h - d.b - o, w, h: d.b + o });
  return rects;
}
