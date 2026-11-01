// Mark views' sums, with no DOM (markviews.js is the sheet; tests/markviews.test.mjs checks these).
export const ANGLES = ['Front', 'Front 3/4 left', 'Left', 'Back 3/4 left', 'Back', 'Back 3/4 right', 'Right', 'Front 3/4 right',
  'Top', 'Bottom', 'Face front', 'Face 3/4', 'Face side', 'Detail'];
// the steps a mark goes through, in this order
export const STEPS = [['up', 'Upscale'], ['delight', 'De-light'], ['cut', 'Cut out']];
export const stepsOn = (on) => STEPS.map(([k]) => k).filter((k) => on[k]);
// the frame shown at a time (a step lands exactly on a frame's start, which float sums can put just under it)
export const frameAt = (t, fps) => Math.max(0, Math.floor(t * fps + 0.001));
// a mark set on a frame: an angle has one frame (marking it again moves it); Detail can be many. In clip order.
export function setMark(marks, label, frame) {
  if (marks.some((m) => m.label === label && m.frame === frame)) return marks;   // (already here: a made picture stays)
  const rest = marks.filter((m) => (label === 'Detail' ? !(m.label === label && m.frame === frame) : m.label !== label));
  return [...rest, { label, frame }].sort((a, b) => a.frame - b.frame);
}
// what a character's look pack takes from the finished views: its one three-quarter and one side view, left before right
const PACK = { front: ['Front'], three: ['Front 3/4 left', 'Front 3/4 right'], side: ['Left', 'Right'], back: ['Back'], face: ['Face front'] };
export function packFrom(results) {
  const out = {};
  for (const [view, labels] of Object.entries(PACK)) {
    const r = labels.map((l) => results.find((x) => x.label === l)).find(Boolean);
    if (r) out[view] = r.name;
  }
  return out;
}
// the character and object sheets (an H3 clip with a picture cut from it)
export const SHEET_TEMPLATES = new Set(['deck-h3-charsheet', 'deck-h3-charsheet-bust', 'deck-h3-charsheet-bust4', 'deck-h3-objectsheet']);
// a sheet's run, or its upscale or regenerate (a new run that says it was made from a sheet)
export const isSheetRun = (g) => SHEET_TEMPLATES.has(g.template) || !!g.params?.sheet;
// which output Mark views works on, or -1: an H3 run's clip (an upscale's "h3 ..." runs too), from the clip or from the sheet picture beside it
export function markClipOf(g, index) {
  if (!/^(deck-h3-|h3 )/.test(g.template || '')) return -1;
  return g.outputs[index]?.kind === 'video' ? index : g.outputs.findIndex((o) => o.kind === 'video');
}
// the marks with no picture for their frame yet, and those with one (a moved mark loses its picture until it's made again)
export const toMake = (marks) => marks.filter((m) => !m.name);
export const madeOf = (marks) => marks.filter((m) => m.name);
// the file name a finished view keeps
export const viewFile = (label) => `view-${label.toLowerCase().replace(/\//g, '-').replace(/[^a-z0-9-]+/g, '-')}.png`;
// what the 3D object sheet's slots take from the finished views
export function slotPicks(results) {
  const out = {};
  for (const r of results) if (['Front', 'Left', 'Back', 'Right'].includes(r.label)) out[r.label] = r.name;
  return out;
}
