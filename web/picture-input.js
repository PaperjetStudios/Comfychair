// One picture slot, the same wherever a picture is asked for: a template's image, a tool's reference, a VFX start frame.
// It picks (several, when there are slots to fill), crops, draws, has a size limit and takes dropped pictures and layers.
// The caller says what extra it needs (buttons, below); the rest comes with the slot.
import { h, api, button, imageInput, mpInput } from './ui.js';
import { inputUrl, thumbUrl } from './core.js';
import { cropCopy, openImagePicker } from './media.js';
import { pictureSlot } from './picture-drop.js';

const whole = (c) => c.w > 0.999 && c.h > 0.999;

// the whole picture greyed out, with the cropped part in colour on top
function cropPreview(src, c) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  return h('span', { class: 'crop-preview' },
    h('img', { class: 'under', src, alt: '' }),
    h('img', { class: 'kept', src, alt: '', style: `clip-path:inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})` }));
}

// What a run gets for a picture and its crop: a copy cut to the crop (one file per picture and crop), or the picture itself.
export async function pictureForRun(name, crop, mp = 0) {
  if (!name || !crop) return name;
  return (await api('/api/inputs/crop', { method: 'POST', body: { name, crop, mp, multiple: 16 } })).name;
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
    openImagePicker({ title, mp, multi: fills.length > 1, limit: fills.length, onPick: (n, info) => fills[at++]?.(n, info) });
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
  const el = imageInput({ label, tip, name: name ? name.split('/').pop() + (crop ? ' · cropped' : '') : '',
    thumb: crop ? cropPreview(thumbUrl(name, 256), crop) : name ? h('img', { src: thumbUrl(name, 256), alt: name }) : null,
    pick, onClear: onClear || (() => set('')),
    buttons: [name ? button('Crop…', cut) : null, ...buttons,
      button(name ? 'Draw on' : 'Draw', async () => (await editor()).openSketch({ base: name || null, aspect: aspect(), onDone: set }))],
    below: [setMp ? mpInput(mp, setMp) : null, ...below] });
  return pictureSlot(el, { give: set, mp, empty });
}
