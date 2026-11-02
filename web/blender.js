// Open in Blender: only on a desktop browser on the PC ComfyChair runs on, where the window can come up (sceneasset.py /api/scene/blender).
import { api, button, toast } from './ui.js';

const desktop = () => matchMedia('(pointer: fine)').matches;
let can = null;
const canOpen = () => (can ??= desktop() ? api('/api/scene/blender', { busy: false }).then((r) => !!r.can).catch(() => false) : Promise.resolve(false));
export const blenderFile = (url) => /^\/files\/projects\/.+\.(glb|gltf|fbx|obj)(\?.*)?$/i.test(url || '');

export async function openInBlender(url, name = 'The model') {
  try {
    await api('/api/scene/blender', { method: 'POST', body: { url }, busy: 'Opening Blender…' });
    toast(`${name} is opening in Blender. Saving there doesn't change it here.`);
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
