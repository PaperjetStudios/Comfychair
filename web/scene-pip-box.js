// Where the mini camera view's box goes (no DOM: tests/scene_pip.test.mjs)
const MIN_PX = 120, MAX_SHARE = 0.7;
// the box in canvas px, whole and inside the canvas: { x, y, w, h }. A share w is how wide; its height follows the shot's shape.
export function pipBox({ x, y, w }, cw, ch, aspect) {
  let bw = Math.max(Math.min(MIN_PX, cw), Math.min(w * cw, cw * MAX_SHARE));
  let bh = bw / aspect;
  if (bh > ch * MAX_SHARE) { bh = ch * MAX_SHARE; bw = bh * aspect; }
  bw = Math.round(bw); bh = Math.round(bh);
  return { x: Math.round(Math.max(0, Math.min(cw - bw, x * cw))), y: Math.round(Math.max(0, Math.min(ch - bh, y * ch))), w: bw, h: bh };
}
