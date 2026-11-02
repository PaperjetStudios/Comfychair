// The largest size a picked picture may have, as plain maths (tests/mp_cap.test.mjs). The sizes it gives are imageprep.prep's.
export const MP_STEPS = [[0, 'Full', 'Keep the picture\'s own size'], [0.5, '0.5'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']];

export function cappedSize(w, h, mp) {
  if (!mp || w * h <= mp * 1e6) return [w, h];
  const s = Math.sqrt((mp * 1e6) / (w * h));
  return [Math.max(1, Math.floor(w * s)), Math.max(1, Math.floor(h * s))];
}
const mpOf = (w, h) => {
  const v = (w * h) / 1e6;
  return `${v < 10 ? +v.toFixed(1) : Math.round(v)} MP`;
};
// what a picture is, and what it will be used at when that differs
export function capLabel(w, h, mp) {
  const [a, b] = cappedSize(w, h, mp), now = `${w}×${h} · ${mpOf(w, h)}`;
  return a === w && b === h ? now : `${now} → ${a}×${b} · ${mpOf(a, b)}`;
}
