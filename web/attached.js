// The pictures attached to the 3D object panel (scene-import.js), as this device keeps them per project: names only, so it writes no
// file of its own. The source picker shows them over Recent (source-picker.js), and × there lets one go.
import { S } from './core.js';
import { store } from './ui.js';

export const attachedKey = () => `deck.scene.object.${S.project ?? 'none'}`;
export const attachedViews = () => { const d = store.get(attachedKey(), {}); return d && typeof d === 'object' ? d : {}; };
export const attachedNames = () => Object.values(attachedViews()).filter((n) => typeof n === 'string' && n);
// a picture no longer attached: the panel follows (attached:change)
export function detach(name) {
  store.set(attachedKey(), Object.fromEntries(Object.entries(attachedViews()).filter(([, n]) => n !== name)));
  dispatchEvent(new CustomEvent('attached:change'));
}
