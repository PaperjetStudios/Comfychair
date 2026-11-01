import { h, toast, button, openSheet, closeSheet, seg, hint } from './ui.js';
import { characters, loadCharacters, newCharacter, changed, tellCharacters } from './characters.js';
import { keepCandidate, MEDIA_ROLES } from './char-model.js';

// Use as… > Character: any output to a character, a look and what it is. A picture gets its own copy (its origin stays on
// the run, so the Board shows the run in use); a clip or a model stays the run's output, at its place in their media.
const ROLE_SLOT = { face: 'edit', body: 'edit', ref: 'edit', edit: 'edit', sheet: 'sheet', model: 'model', rig: 'rig', splat: 'splat', clip: 'clip' };
const rolesFor = (k) => (k === 'image' ? ['face', 'body', 'ref', 'edit', 'sheet'] : k === 'video' ? ['clip', 'sheet'] : k === 'splat' ? ['splat'] : ['model', 'rig']);

export async function sendToCharacter(g, index, o, toInput) {
  await loadCharacters();
  const kind = o.kind || (/\.(fbx|glb|gltf|obj)$/i.test(o.filename || '') ? 'mesh' : 'image');
  const roles = rolesFor(kind);
  let role = roles[0];
  const give = async (cid) => {
    try {
      const c = cid ? characters().find((x) => x.id === cid) : await newCharacter();
      const name = kind === 'image' ? (await toInput('first', 0, 16)).name : null;
      const x = { id: 'send', slot: ROLE_SLOT[role], look: c.lookNow.id, gen: g.id, index, url: o.url, kind };
      const item = keepCandidate(c, x, { name, id: `m${Date.now().toString(36)}` });
      if (item) item.role = role;
      if (name) c.lookNow.main ||= name;
      changed(c); tellCharacters();
      closeSheet();
      toast(`In ${c.name}'s media`);
    } catch (e) { toast(e.message, true); }
  };
  openSheet(h('h3', {}, 'Give it to a character'),
    roles.length > 1 ? seg(roles.map((r) => [r, MEDIA_ROLES.find(([k]) => k === r)?.[1] || r]), role, (v) => { role = v; }) : null,
    characters().length ? h('div', { class: 'ch-list' }, characters().map((c) => button(c.name, () => give(c.id)))) : hint('No characters yet.'),
    h('div', { class: 'row wrap' }, button('New character', () => give(null), { cls: 'small' }), button('Cancel', closeSheet, { cls: 'small' })));
}
