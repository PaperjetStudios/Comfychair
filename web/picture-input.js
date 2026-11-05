// One picture slot, the same wherever a picture is asked for: a template's image, a tool's reference, a VFX start frame.
// It picks (several, when there are slots to fill), crops, draws, has a size limit and takes dropped pictures and layers.
// The caller says what extra it needs (buttons, below); the rest comes with the slot.
import { h, api, button, imageInput } from './ui.js';
import { sizeChoices } from './size-picker.js';
import { capSize } from './size-math.js';
import { inputUrl, thumbUrl } from './core.js';
import { cropCopy } from './media.js';
import { openSourcePicker } from './source-picker.js';
import { pictureSlot } from './picture-drop.js';

const whole = (c) => c.w > 0.999 && c.h > 0.999;

// the whole picture greyed out, with the cropped part in colour on top
export function cropPreview(src, c) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  return h('span', { class: 'crop-preview' },
    h('img', { class: 'under', src, alt: '' }),
    h('img', { class: 'kept', src, alt: '', style: `clip-path:inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})` }));
}

// The crop sheet on a picture that isn't a file in the inputs (a plugged frame's still): done(the crop, or null for the whole picture)
export async function openPictureCrop(url, crop, done) {
  const { FULL, openCrop } = await import('./editor.js');
  const img = new Image();
  img.src = url;
  openCrop({ img, crop: crop || FULL, onApply: (c) => done(whole(c) ? null : c) });
}

// What a run gets for a picture and its crop: a copy cut to the crop (one file per picture and crop), or the picture itself.
export async function pictureForRun(name, crop, mp = 0) {
  if (!name || (!crop && !mp)) return name;
  return (await api('/api/inputs/crop', { method: 'POST', body: { name, crop: crop || { x: 0, y: 0, w: 1, h: 1 }, mp, multiple: 16 } })).name;
}

// The size a picture goes into a run at: the same selector as every output size, in megapixels because its shape is the picture's.
// nat(): the picture's size [w, h] as it is cut (null while unknown); onPick(mp), 0 for its own size. A big reference costs the card a lot.
export function pictureSize({ nat, mp, onPick }) {
  return sizeChoices({ label: 'Output size', choices: [[0.25, '0.25'], [0.5, '0.5'], [1, '1'], [2, '2'], [4, '4'], [0, 'Full']], value: mp, onPick,
    sizeOf: (v) => { const n = nat(); return n ? capSize(n[0], n[1], v) : null; }, words: (v) => (v ? `${v} MP at most` : 'its own size'),
    custom: { label: 'Megapixels', min: 0.05, max: 16, step: 0.05 } });
}

// name: the picture ('' for none). set(name, info): another one, or '' to clear it (onClear: instead, for that).
// mp(), setMp(n): the largest size a picked picture comes in at.
// crop, setCrop(c or null): a crop kept as a setting, so the original stays and pictureForRun cuts it for the run. Without setCrop,
// for a caller that works on the file itself (the VFX start frame), Crop… makes a cut copy and that becomes the picture.
// slots(): for a pick of several, what to call for each picture, starting with this slot's own.
// aspect(): the shape of a new drawing. buttons: more after Crop and Draw. below: under the size. empty: a drop that misses every slot may land here.
export function pictureInput({ label, title = label, name, set, onClear = null, mp = () => 0, setMp = null, crop = null, setCrop = null, slots = null,
  aspect = () => 1, buttons = [], below = [], tip = null, empty = !name }) {
  const pick = () => {
    const fills = slots?.() || [set];
    let at = 0;
    openSourcePicker({ kinds: ['image'], want: 'picture', title, mp, multi: fills.length > 1, limit: fills.length, onPick: (n, info) => fills[at++]?.(n, info) });
  };
  const editor = () => import('./editor.js');   // (it reaches this file through the image tools)
  const cut = async () => {
    const { FULL, openCrop } = await editor();
    const img = new Image();
    img.src = inputUrl(name);
    openCrop({ img, crop: crop || FULL, onApply: async (c) => {   // (it opens at once and shows the picture loading)
      if (setCrop) return setCrop(whole(c) ? null : c);
      if (!whole(c)) set((await cropCopy(img, c, mp())).name);
    } });
  };
  // (its size as cut, read from the picture itself, for the size it goes in at)
  let nat = null, sizeEl = null;
  if (setMp) {
    sizeEl = pictureSize({ nat: () => nat, mp: mp() ?? 1, onPick: setMp });
    if (name) {
      const probe = new Image();
      probe.onload = () => { const c = crop || { w: 1, h: 1 }; nat = [probe.naturalWidth * c.w, probe.naturalHeight * c.h]; sizeEl.refresh(); };
      probe.src = inputUrl(name);
    }
  }
  const el = imageInput({ label, tip, name: name ? name.split('/').pop() + (crop ? ' · cropped' : '') : '',
    thumb: crop ? cropPreview(thumbUrl(name, 256), crop) : name ? h('img', { src: thumbUrl(name, 256), alt: name }) : null,
    pick, onClear: onClear || (() => set('')),
    buttons: [name ? button('Crop…', cut) : null, ...buttons,
      button(name ? 'Draw on' : 'Draw', async () => (await editor()).openSketch({ base: name || null, aspect: aspect(), onDone: set }))],
    below: [sizeEl, ...below] });
  return pictureSlot(el, { give: set, mp, empty });
}
