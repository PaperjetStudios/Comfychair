import { h, iconBtn, rangeField } from './ui.js';
import { nextKey, putKey, removeKey, sampleKeys } from './keys.js';

// ---------------------------------------------------------------------------
// keyed: a property that can be animated, After Effects style, for the Video tab's clips and the Editor's
// layers (the keys and their maths are keys.js, the 3D tab's engine). A property has no keys until its ◆ is
// tapped: then it is animated, and changing it anywhere else in time puts a key there. ◀ ▶ jump between
// its keys; ◆ on a key takes that key away. item.chans[ch] holds its keys: f is the item's own time in
// seconds (a clip's source time, so moving or trimming the clip keeps the animation on the picture).
//
//   value(item, ch, t, base)            the property at time t (base when it has no keys)
//   setValue(item, ch, t, v, setBase)   a change: a key at t when animated, else the plain value
//   keyedRange(label, { item, ch, t, base, setBase, seek, …rangeField's options })
// ---------------------------------------------------------------------------
export const animated = (item, ch) => !!item.chans?.[ch]?.length;
export const anyKeys = (item) => !!item.chans && Object.values(item.chans).some((l) => l.length);
export const value = (item, ch, t, base) => sampleKeys(item.chans?.[ch], t, { base, ease: item.ease || 'smooth' });
export function setValue(item, ch, t, v, setBase) {
  if (animated(item, ch)) putKey(item.chans, ch, t, v);
  else setBase(v);
}
const keyAt = (item, ch, t) => (item.chans?.[ch] || []).some((k) => Math.abs(k.f - t) < 1e-3);
// every key time on any of the item's properties (the diamonds on a clip)
export const keyTimes = (item) => [...new Set(Object.values(item.chans || {}).flatMap((l) => l.map((k) => k.f)))].sort((a, b) => a - b);

// A slider for an animatable property: rangeField with ◀ ◆ ▶ beside its label. t(): the item's time now (seconds);
// base(): the plain value, setBase(v) sets it; seek(t): move the playhead to the item's time t; onKeys(): keys changed.
export function keyedRange(label, { item, ch, t, base, setBase, seek, onKeys, onInput, onChange, ...opts }) {
  const el = rangeField(label, () => value(item, ch, t(), base()), (v) => setValue(item, ch, t(), v, setBase),
    { ...opts, onInput, onChange });
  const diamond = iconBtn(`Key ${label}`, '◇', () => {
    const now = t();
    if (keyAt(item, ch, now)) removeKey(item.chans, ch, now);
    else { item.chans ||= {}; putKey(item.chans, ch, now, value(item, ch, now, base())); }
    if (item.chans && !Object.keys(item.chans).length) delete item.chans;
    paint(); onKeys?.();
  });
  const jump = (dir) => { const f = nextKey(item.chans, ch, t() + dir * 1e-3, dir); if (f != null) seek(f); };
  const prev = iconBtn(`Previous ${label} key`, '◀', () => jump(-1)), next = iconBtn(`Next ${label} key`, '▶', () => jump(1));
  const paint = () => {
    const on = animated(item, ch), here = on && keyAt(item, ch, t());
    diamond.textContent = here ? '◆' : '◇';
    diamond.classList.toggle('on', on);
    diamond.title = here ? `Take away this ${label} key` : on ? `Key ${label} here` : `Animate ${label}: a key here`;
    prev.hidden = next.hidden = !on;
  };
  const lbl = el.querySelector('.lbl'), readout = lbl.lastElementChild;   // (rangeField's value, right of the label)
  lbl.append(h('span', { class: 'key-btns' }, prev, diamond, next));
  el.classList.add('keyed');
  // the playhead moved: show the value there (not while the slider is being dragged or typed in)
  const input = el.querySelector('input');
  const fmt = opts.fmt || ((v) => v.toFixed(2));
  el.refresh = () => {
    if (animated(item, ch) && document.activeElement !== input && !input.dataset.scrubbing) {
      const v = value(item, ch, t(), base());
      input.set?.(v); if (readout) readout.textContent = fmt(v);
    }
    paint();
  };
  paint();
  return el;
}
// after the playhead moves: every keyed slider in root shows its value there
export const refreshKeyed = (root) => root?.querySelectorAll('.keyed').forEach((el) => el.refresh?.());
