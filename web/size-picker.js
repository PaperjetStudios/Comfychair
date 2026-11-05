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
import { h, field, seg, toggle } from './ui.js';
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

// The same selector where a tool can't take any proportions: its result keeps its source's shape, or a model takes only certain sizes.
// Chips, the size it comes out at beside the label, and Custom to type a value when the tool can take any.
//   choices [[value, label], …]; value the one in use; onPick(value)
//   sizeOf(value) → { w, h } it comes out at (null while unknown; words(value) or the chip's label is shown instead)
//   custom { label, min, max, step }: typing the same kind of value as the chips; left out when the model takes only these
//   tip: a help() for the label
export function sizeChoices({ label, choices, value, onPick, sizeOf = null, words = null, custom = null, tip = null }) {
  let cur = value;
  const readout = h('span', {});
  const listed = (v) => choices.find(([x]) => String(x) === String(v));
  const show = () => {
    const s = sizeOf?.(cur);
    readout.textContent = s ? `${s.w}×${s.h} · ${((s.w * s.h) / 1e6).toFixed(2)} MP` : words?.(cur) ?? listed(cur)?.[1] ?? String(cur);
  };
  const box = custom ? h('input', { type: 'number', inputMode: 'decimal', min: custom.min, max: custom.max, step: custom.step, value: cur, 'aria-label': custom.label }) : null;
  const boxField = custom ? field(custom.label, box) : null;
  const pick = (v, typed = false) => { cur = v; show(); onPick(v, typed); };
  box?.addEventListener('change', () => {
    const n = Math.min(custom.max, Math.max(custom.min, Number(box.value) || custom.min));
    box.value = n;
    pick(n, true);
  });
  const chips = seg([...choices, ...(custom ? [['custom', 'Custom']] : [])], listed(cur) ? cur : 'custom', (id) => {
    boxField?.classList.toggle('hidden', id !== 'custom');
    if (id !== 'custom') pick(listed(id)[0]);
  }, { wrap: true });
  boxField?.classList.toggle('hidden', !!listed(cur));
  show();
  const el = field([label, readout], tip, chips, boxField);
  el.classList.add('size-field');
  el.refresh = show;
  return el;
}

// A size that can follow its source: on, nothing is chosen; off, the resolution selector. size [w, h] or null; onChange([w, h] or null).
export function sizeOrMatch({ label = 'Output size', matchLabel, size, onChange, first = [1280, 720], step = 16 }) {
  const el = h('div', { class: 'size-or-match' });
  let cur = size;
  const draw = () => el.replaceChildren(toggle(matchLabel, !cur, (on) => { cur = on ? null : [...first]; onChange(cur); draw(); }),
    cur ? sizePicker({ label, w: cur[0], h: cur[1], step, lim: (n) => Math.min(8192, Math.max(step, n)), onChange: (w, hh) => { cur = [w, hh]; onChange(cur); } }) : '');
  draw();
  return el;
}
