// Snapping maths with no DOM, shared by gizmo.js (the viewers) and table-model.js (the table). node --test tests/snap_math.test.mjs
export const snapStep = (v, step) => Math.round(v / step) * step;
// the smallest shift (d) that puts one of vals on one of targets within thr, and that target (at); null if none is that near
export function snapNearest(vals, targets, thr) {
  let best = null;
  for (const v of vals) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}
