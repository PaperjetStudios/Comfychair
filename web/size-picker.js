// The app's picture-size picker: proportions as chips (1:1, 16:9 … Custom), megapixels as chips, and with Custom the
// width × height typed, sides snapping to the step. Make's Size field (generate.js) and a frame's Resolution (the
// Properties pane, the Size and MP sheet: table.js) both use it. The maths: web/size-math.js.
//
//   const el = sizePicker({ w, h, onChange(w, h, mode) })   el is a field (label: Size + a readout)
//   options: label, step (16), lim(n, 'w' | 'h') a side kept in range, mode { aspect, mp } (kept by the caller, changed
//     in place; default: derived from w × h), extra [[id, label]] more proportions before the presets (aspectOf(id) gives
//     their w / h, null while unknown), custom: an element of the caller's own for the typed sides (its number boxes are
//     kept in step), read() → { w, h } the size shown now (default: the last one chosen), note(mode) → words instead of
//     the readout, onMode(mode) when the proportions or megapixels change
//   el.apply()   the proportions and megapixels applied again (an "extra" proportion became known); el.redraw()
import { h, field, seg } from './ui.js';
import { ASPECT_PRESETS } from './core.js';
import { MP_STEPS, modeOf, presetSize, snapSide } from './size-math.js';

export function sizePicker({ w, h: hh, onChange, label = 'Size', step = 16, lim = null, mode = null, extra = [], aspectOf = () => null,
  custom = null, read = null, note = () => null, onMode = () => {} }) {
  const keep = lim || ((n) => Math.max(step, n));
  const m = mode || modeOf(w, hh, ASPECT_PRESETS);
  let cur = { w, h: hh };
  const size = () => (read ? read() : cur);
  const readout = h('span', {});
  const showReadout = () => {
    const s = size();
    readout.textContent = note(m) || `${s.w}×${s.h} · ${((s.w * s.h) / 1e6).toFixed(2)} MP`;
  };
  // the typed sides: the caller's own boxes, or two of ours that snap to the step
  const own = !custom;
  const box = (axis, text) => {
    const inp = h('input', { type: 'number', inputMode: 'numeric', step, min: step, value: cur[axis], 'aria-label': text });
    inp.addEventListener('change', () => {
      const n = snapSide(parseFloat(inp.value), step);
      cur = { ...cur, [axis]: keep(n, axis) };
      inp.value = cur[axis];
      onChange?.(cur.w, cur.h, m); showReadout();
    });
    return field(text, inp);
  };
  const sides = custom || h('div', { class: 'size-custom size-sides' }, box('w', 'Width'), box('h', 'Height'));
  const syncSides = () => sides.querySelectorAll('input[type=number]').forEach((inp, i) => { inp.value = i ? cur.h : cur.w; });
  const apply = () => {
    const a = extra.some(([id]) => id === m.aspect) ? aspectOf(m.aspect) : (ASPECT_PRESETS.find(([k]) => k === m.aspect) || [])[1];
    if (!a) return;
    cur = presetSize(a, m.mp, step, keep);
    syncSides();
    onChange?.(cur.w, cur.h, m); showReadout();
  };
  const aspects = [...extra, ...ASPECT_PRESETS.map(([k]) => [k, k]), ['custom', 'Custom']];
  let pick = false;   // an extra proportion and Custom fold the proportions into one button; it unfolds them
  const aspectSeg = seg(aspects, m.aspect, (id) => { m.aspect = id; pick = false; apply(); onMode(m); draw(); }, { wrap: true });
  const aspectBtn = h('button', { type: 'button', class: 'icon-btn aspect-btn', onclick: () => { pick = true; draw(); } }, '⊞');
  // megapixels: tapped, not typed (Custom types the sides themselves)
  const setMp = (n) => { m.mp = Math.min(16, Math.max(0.05, Math.round(n * 100) / 100)); apply(); onMode(m); };
  const mpRow = field(['Megapixels', h('span', {}, `sides snap to ${step}`)], seg(MP_STEPS.map((v) => [v, `${v}`]), m.mp, setMp, { wrap: true }));
  const draw = () => {
    aspectSeg.set(m.aspect);
    const named = extra.find(([id]) => id === m.aspect);
    const folded = (named || m.aspect === 'custom') && !pick;
    aspectSeg.classList.toggle('hidden', !!folded);
    aspectBtn.classList.toggle('hidden', !folded);
    aspectBtn.title = `Proportions: ${named ? named[1] : 'Custom'} (tap to pick another)`; aspectBtn.setAttribute('aria-label', aspectBtn.title);
    const isCustom = m.aspect === 'custom';
    sides.classList.toggle('hidden', !isCustom);
    mpRow.classList.toggle('hidden', isCustom);
    showReadout();
  };
  if (!own) { sides.addEventListener('change', () => setTimeout(showReadout)); sides.addEventListener('click', () => setTimeout(showReadout)); }
  draw();
  const el = field([label, readout], aspectSeg, aspectBtn, mpRow, sides);
  el.classList.add('size-field');
  el.apply = apply; el.redraw = draw; el.mode = m;
  return el;
}
