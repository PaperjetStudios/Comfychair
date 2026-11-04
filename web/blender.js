// Open in Blender: only on a desktop browser on the PC ComfyChair runs on, where the window can come up (sceneasset.py /api/scene/blender).
import { api, button, toast } from './ui.js';
import { renderUrl } from './splat-levels.js';

const desktop = () => matchMedia('(pointer: fine)').matches;
let can = null;
const canOpen = () => (can ??= desktop() ? api('/api/scene/blender', { busy: false }).then((r) => !!r.can).catch(() => false) : Promise.resolve(false));
export const blenderFile = (url) => /^\/files\/projects\/.+\.(glb|gltf|fbx|obj|ply|spz)(\?.*)?$/i.test(url || '');

export async function openInBlender(url, name = 'The model', { flip, note = '' } = {}) {
  try {
    await api('/api/scene/blender', { method: 'POST', body: { url, flip: !!flip }, busy: 'Opening Blender…' });
    toast(`${name} is opening in Blender${note}. Saving there doesn't change it here.`);
  } catch (e) { toast(e.message, true); }
}
// el shows only where Blender can open from this browser
export function onlyWhereBlender(el) {
  el.classList.add('hidden');
  canOpen().then((y) => el.classList.toggle('hidden', !y));
  return el;
}
export const blenderButton = (url, name) => (blenderFile(url) ? onlyWhereBlender(button('Open in Blender', () => openInBlender(url, name),
  { cls: 'small', title: 'Opens this model in Blender on this PC, for a look or for work by hand. Its file here isn\'t changed' })) : null);
// A splat layer: its full set (or densest level kept), stood up the way its Upside down says. .splat and .ksplat get no
// button: Blender can't read them. A trim isn't in the file, and an animated layer is many files, so the toast says which it got.
export function blenderSplatButton(o, trimmed) {
  const url = renderUrl(o);
  if (!blenderFile(url)) return null;
  const notes = [trimmed ? 'without its trim' : '', o.frames?.length ? 'first frame only' : ''].filter(Boolean);
  return onlyWhereBlender(button('Open in Blender', () => openInBlender(url, o.name, { flip: o.flip, note: notes.length ? ` (${notes.join(', ')})` : '' }),
    { cls: 'small', title: 'Opens this splat in Blender on this PC. Its file here isn\'t changed, and Blender can\'t export a splat back' }));
}
