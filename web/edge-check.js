// Is the subject of a picture cut off by its edges? No DOM (scene-import.js's Make a 3D object asks; tests/edge_check.test.mjs).
// Only a cut-out can say, through its see-through channel. An opaque picture gets no verdict: on real H3 frames a backdrop's
// vignette looks just like a subject reaching the edge, which raised false alarms. A stray hair isn't a cut: it takes a run of 2%
// of the edge.
const px = (w, x, y) => (y * w + x) * 4;

function longestRun(flags) {
  let best = 0, run = 0;
  for (const f of flags) { run = f ? run + 1 : 0; if (run > best) best = run; }
  return best;
}

export function cutEdges(d, w, h) {
  let seeThrough = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { seeThrough = true; break; }
  if (!seeThrough) return [];
  const lines = { top: [], bottom: [], left: [], right: [] };   // (the line next to the edge: a resized edge line is blurred)
  for (let x = 0; x < w; x++) { lines.top.push(px(w, x, Math.min(1, h - 1))); lines.bottom.push(px(w, x, Math.max(0, h - 2))); }
  for (let y = 0; y < h; y++) { lines.left.push(px(w, Math.min(1, w - 1), y)); lines.right.push(px(w, Math.max(0, w - 2), y)); }
  const out = [];
  for (const [edge, line] of Object.entries(lines)) {
    if (longestRun(line.map((i) => d[i + 3] > 128)) >= Math.max(3, line.length * 0.02)) out.push(edge);
  }
  return out;
}
// "the top and bottom"
export const edgeWords = (edges) => {
  const e = edges.map((x) => `the ${x}`);
  return e.length > 1 ? `${e.slice(0, -1).join(', ')} and ${e[e.length - 1]}` : e[0] || '';
};
