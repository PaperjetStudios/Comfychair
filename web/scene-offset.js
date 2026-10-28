// The offset layer's panel (scene-data.js has the sums): slide, turn and scale a whole move (a mocap clip most
// often) without touching its keys, key that sparsely, and bake it in when it's right.
import { R, bakeOffset, hasKeys, keyOffset, newOffset, offAt, setOffset } from './scene-data.js';
import { button, field, h, info, numField, toast, toggle } from './ui.js';
import { changed, draw, pose } from './scene-view.js';

const ABOUT = 'Moves, turns and scales the whole animation on top of its keys, which stay as they are: slide a captured move '
  + 'to another spot, aim it another way, make it bigger. Gizmo moves the offset: dragging the figure (or turning a joint, '
  + 'for that limb on every frame) changes the offset instead of the keys. Key the offset to change it over time (it eases '
  + 'between its own keys, shown in the key sheet under Offset). Bake writes it into the keys and removes it.';

export function offsetField(o) {
  if (!o.off) {
    return field(['Offset layer', info(ABOUT)], h('div', { class: 'row wrap' },
      button('Add offset layer', () => { o.off = newOffset(o); R.offEdit = o.id; changed(); toast('The gizmo now moves the offset'); })));
  }
  const v = offAt(o);
  const num = (label, k, opts) => numField(label, v[k], (x) => { if (Number.isFinite(x)) setOffset(o, { [k]: x }); }, changed,
    { live: () => { pose(R.f); draw(); }, digits: 2, step: 0.01, min: -20, max: 20, ...opts });
  return field(['Offset layer', info(ABOUT)], h('div', { class: 'offset-box' },
    h('div', { class: 'row wrap' },
      toggle('Gizmo moves the offset', R.offEdit === o.id, (on) => { R.offEdit = on ? o.id : null; changed(); }),
      toggle('Show it', o.off.on !== false, (on) => { o.off.on = on; changed(); })),
    h('div', { class: 'row' }, num('X', 'x'), num('Up', 'y', { min: -5, max: 10 }), num('Z', 'z')),
    h('div', { class: 'row' }, num('Turn (°)', 'ry', { digits: 0, step: 1, min: -360, max: 360 }), num('Scale', 's', { min: 0.05, max: 10, step: 0.01 })),
    h('div', { class: 'row wrap' },
      button(hasKeys(o.off) ? 'Key offset here' : 'Key offset (animate it)', () => { keyOffset(o); changed(); }, { title: 'A key on the offset at the playhead' }),
      button('Bake into keys', () => { bakeOffset(o); changed(); toast('Offset baked into the keys'); }),
      button('Remove', () => { delete o.off; if (R.offEdit === o.id) R.offEdit = null; changed(); }, { cls: 'small danger' }))));
}
