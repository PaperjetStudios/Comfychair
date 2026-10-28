import { h, api, toast, undoToast, uid, button, iconBtn, field, section, help, textArea, chip, icon, hint } from './ui.js';
import { S, thumbUrl, onServer, onProject } from './core.js';
import { openImagePicker } from './media.js';
import { suggest, typing } from './cast.js';

// ---------------------------------------------------------------------------
// characters: a project's people (and creatures), for the Story tab and whoever else needs them. Each is a document
// of the 'characters' kind in the project folder (app/store.py): a name, who they are, their look (what prompts
// say about them), reference pictures (one is the main one), a voice from the Sound tab's voice library, notes.
// Writing names them with @Name (web/cast.js); prompts then carry their look and their main picture.
//   await loadCharacters(); characters(); onCharacters(fn) (after any change);
//   castSection({ open, onOpen }) and characterSection(c, { done, extra }) for a side panel; mentionBox(ta)
// ---------------------------------------------------------------------------
const KIND = 'characters';
const C = { list: [], pid: undefined, ready: null, voices: null, timers: new Map(), saving: new Set(), subs: new Set() };
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const url = (id = '') => `/api/store/${KIND}${id ? `/${id}` : ''}${qs()}`;

export const characters = () => C.list;
export const characterById = (id) => C.list.find((c) => c.id === id) || null;
export const mainPicture = (c) => (c?.main && c.pics.includes(c.main) ? c.main : c?.pics[0] || null);
export function onCharacters(fn) { C.subs.add(fn); return () => C.subs.delete(fn); }
const tell = () => C.subs.forEach((f) => { try { f(); } catch (e) { console.warn(e); } });

const fromDoc = (d) => {
  const p = d.payload || {};
  return { id: d.id, rev: d.rev, name: d.name || '', desc: p.desc || '', look: p.look || '', notes: p.notes || '',
    pics: Array.isArray(p.pics) ? p.pics.filter((x) => typeof x === 'string') : [], main: p.main || null, voice: p.voice || null };
};
const payloadOf = (c) => ({ desc: c.desc, look: c.look, notes: c.notes, pics: c.pics, main: c.main, voice: c.voice });

// every character of the open project (again after a project switch, or another device's change)
export function loadCharacters() {
  if (C.pid === S.project && C.ready) return C.ready;
  const pid = S.project;
  C.pid = pid;
  C.ready = (async () => {
    let list = [];
    try {
      const rows = await api(url(), { busy: false });
      list = (await Promise.all(rows.map((r) => api(url(r.id), { busy: false }).catch(() => null)))).filter(Boolean).map(fromDoc);
    } catch { /* offline: none for now, the next store message tries again */ }
    if (pid !== S.project) return;
    C.list = list;
    tell();
  })();
  return C.ready;
}
onProject(() => { C.ready = null; C.list = []; loadCharacters(); });
// another device's change to one character: that one is read again (one with changes still to save here keeps them)
onServer('store', async (m) => {
  if (m.kind !== KIND || m.scope !== 'project' || (m.project_id ?? null) !== (S.project ?? null) || !m.id) return;
  const pid = S.project, have = characterById(m.id);
  if (have && (C.timers.has(m.id) || C.saving.has(m.id) || (have.rev || 0) >= m.rev)) return;   // ours, or not newer
  if (m.deleted) { if (have) { C.list = C.list.filter((x) => x !== have); tell(); } return; }
  let d;
  try { d = await api(url(m.id), { busy: false }); } catch { return; }
  if (pid !== S.project || C.timers.has(m.id) || C.saving.has(m.id)) return;
  const now = characterById(m.id);
  if (now) { if ((now.rev || 0) < d.rev) Object.assign(now, fromDoc(d)); } else C.list.push(fromDoc(d));
  tell();
});

// ---- saving: a change is written a moment after the last one; another device's newer copy wins (said so) ----
function changed(c, now = false) {
  clearTimeout(C.timers.get(c.id));
  C.timers.set(c.id, setTimeout(() => save(c), now ? 0 : 700));
}
async function save(c) {
  C.timers.delete(c.id);
  if (!C.list.includes(c)) return;
  if (C.saving.has(c.id)) { changed(c); return; }   // one write at a time per character
  C.saving.add(c.id);
  try {
    const r = await fetch(url(c.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: c.rev || 0, name: c.name.trim() || 'Someone', payload: payloadOf(c) }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) {
      toast(`${c.name || 'That character'} was changed on another device: showing that version`, true);
      if (d.doc) Object.assign(c, fromDoc(d.doc)); else C.list = C.list.filter((x) => x !== c);
      tell();
      return;
    }
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    c.rev = d.rev;
  } catch (e) { toast(`Character not saved yet: ${e.message}`, true); changed(c); } finally { C.saving.delete(c.id); }
}
export async function newCharacter(o = {}) {
  await loadCharacters();
  let n = C.list.length + 1;
  while (C.list.some((x) => x.name === `Character ${n}`)) n++;
  const c = { id: uid(), rev: 0, name: `Character ${n}`, desc: '', look: '', notes: '', pics: [], main: null, voice: null, ...o };
  C.list.push(c);
  changed(c, true);
  tell();
  return c;
}
async function deleteCharacter(c) {
  clearTimeout(C.timers.get(c.id));
  C.list = C.list.filter((x) => x !== c);
  tell();
  try { await api(url(c.id), { method: 'DELETE', busy: false }); } catch { /* never saved */ }
  undoToast(`Deleted ${c.name}`, async () => {
    try { C.list.push(fromDoc(await api(`/api/store/${KIND}/${c.id}/restore${qs()}`, { method: 'POST' }))); } catch { C.list.push(c); changed(c, true); }
    tell();
  });
}
export function addPicture(c, name) {
  if (!name || c.pics.includes(name)) return;
  c.pics.push(name);
  c.main ||= name;
  changed(c); tell();
}

async function loadVoices() {
  if (C.voices) return C.voices;
  try { C.voices = await api('/api/voice/voices', { busy: false }); } catch { C.voices = []; }
  tell();
  return C.voices;
}
export const voiceOf = (c) => (c?.voice && (C.voices || []).find((v) => v.id === c.voice)) || null;
export const voices = () => C.voices;

// ---- the side panel: the list, and one character open for editing ----
const face = (c, px = 96) => {
  const m = mainPicture(c);
  return m ? h('img', { src: thumbUrl(m, px), alt: '', loading: 'lazy' }) : h('span', { class: 'ch-noface' }, icon('person'));
};
export function castSection({ open = null, onOpen, extra = [] } = {}) {
  if (C.pid !== S.project || !C.ready) loadCharacters();
  const rows = C.list.map((c) => h('button', { type: 'button', class: `ch-row${c.id === open ? ' sel' : ''}`, 'aria-label': `${c.name}: edit`,
    onclick: () => onOpen(c.id === open ? null : c.id) },
  h('span', { class: 'ch-face' }, face(c)),
  h('span', { class: 'ch-text' }, h('b', { 'data-show': `char.${c.id}.name`, 'data-empty': 'Someone' }, c.name || 'Someone'),
    h('span', { class: 'ch-desc' }, c.desc || c.look || 'No description yet')),
  c.voice ? h('span', { class: 'ch-voice', title: 'Has a voice' }, icon('mic')) : null));
  return section('Characters', null,
    help('The people in this project\'s stories. Write @ and their name in a shot to bring them in: prompts then say how they look and use their main picture, and their lines can be spoken in their voice.'),
    rows.length ? h('div', { class: 'ch-list' }, rows) : hint('No characters yet.'),
    h('div', { class: 'row wrap' }, button([icon('plus'), 'New character'], async () => onOpen((await newCharacter()).id), { cls: 'small primary' }), ...extra));
}

// a text box bound to one of c's fields (it keeps the cursor through a redraw: data-bind)
function charBox(c, key, opts) {
  const ta = textArea(() => c[key], (v) => { c[key] = v; changed(c); }, { rows: 2, max: 400, ...opts });
  ta.dataset.bind = `char.${c.id}.${key}`;
  return ta;
}
export function characterSection(c, { done, extra = [] } = {}) {
  if (!C.voices) loadVoices();
  const name = h('input', { type: 'text', value: c.name, 'aria-label': 'Name', placeholder: 'Name' });
  name.dataset.bind = `char.${c.id}.name`;
  name.addEventListener('input', () => {
    c.name = name.value; changed(c);
    for (const o of document.querySelectorAll(`[data-show="char.${c.id}.name"]`)) o.textContent = c.name || o.dataset.empty;
  });
  const main = mainPicture(c);
  const pics = h('div', { class: 'ch-pics' }, c.pics.map((p) => h('div', { class: `ch-pic${p === main ? ' on' : ''}` },
    h('button', { type: 'button', class: 'ch-pic-img', 'aria-label': p === main ? 'The main picture' : 'Make this the main picture',
      onclick: () => { c.main = p; changed(c); tell(); } }, h('img', { src: thumbUrl(p, 240), alt: '', loading: 'lazy' })),
    p === main ? h('span', { class: 'st-frame-on' }, icon('check')) : null,
    iconBtn('Remove this picture', icon('close'), () => {
      c.pics = c.pics.filter((x) => x !== p);
      if (c.main === p) c.main = c.pics[0] || null;
      changed(c); tell();
    }, { class: 'icon-btn st-frame-x' }))));
  const vs = C.voices || [];
  const v = voiceOf(c);
  const voice = h('div', { class: 'chips' },
    chip('None', () => { c.voice = null; changed(c); tell(); }, { on: !c.voice }),
    vs.map((x) => chip(x.name, () => { c.voice = x.id; changed(c); tell(); }, { on: c.voice === x.id })));
  return section(`Character · ${c.name || 'Someone'}`, done,
    field('Name', name),
    field('Who they are', charBox(c, 'desc', { placeholder: 'e.g. the lighthouse keeper, tired and kind', label: 'Who they are' })),
    field('Look', charBox(c, 'look', { placeholder: 'e.g. a woman in her 30s, short black hair, red raincoat', label: 'Look' }),
      help('What prompts say about them: the face, hair, clothes. Kept short and the same every time, so they look alike from shot to shot.')),
    field(['Pictures', h('span', {}, `${c.pics.length}`)],
      help('Reference pictures. The main one (ticked; tap another to change it) goes to templates that take extra pictures, so the model can match the face and clothes.'),
      pics,
      h('div', { class: 'row wrap' },
        button([icon('image'), 'Add a picture'], () => openImagePicker({ title: `A picture of ${c.name || 'them'}`, mp: () => 0, onPick: (n) => addPicture(c, n) })),
        ...extra)),
    field('Voice', vs.length ? voice : hint('No voices saved yet: make one in the Sound tab (Voice tools).'),
      v ? h('audio', { src: v.url, controls: true, preload: 'none', class: 'ch-audio' }) : null,
      help('Their lines in a shot are spoken in this voice (the Sound tab\'s voice engines) for a video with sound.')),
    field('Notes', charBox(c, 'notes', { rows: 3, placeholder: 'Anything else: history, how they talk, what they want', label: 'Notes' })),
    h('div', { class: 'row wrap' }, button([icon('trash'), 'Delete'], () => { done?.(); deleteCharacter(c); }, { cls: 'small danger' })));
}

// ---- @Name while typing: chips of the matching characters under the box (and in the touch text popup) ----
export function mentionBox(ta) {
  const row = h('div', { class: 'chips ch-suggest hidden', 'aria-label': 'Characters' });
  const put = (c) => {
    const pos = ta.selectionStart ?? ta.value.length, t = typing(ta.value, pos);
    const from = t ? t.from : pos, text = `@${c.name.trim()} `;
    ta.focus();
    ta.setRangeText(text, from, pos, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    row.classList.add('hidden');
  };
  const show = () => {
    const t = document.activeElement === ta ? typing(ta.value, ta.selectionStart ?? 0) : null;
    const list = t ? suggest(C.list, t.query) : [];
    row.replaceChildren(...list.map((c) => chip(`@${c.name.trim()}`, () => put(c), { keepFocus: true })));
    row.classList.toggle('hidden', !list.length);
  };
  for (const ev of ['input', 'keyup', 'click']) ta.addEventListener(ev, show);
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) row.classList.add('hidden'); }, 150));
  ta._chipGroups = () => [['Characters', C.list.filter((c) => c.name.trim()).map((c) => [`@${c.name.trim()}`, `@${c.name.trim()} `]), true]];
  return h('div', { class: 'ch-mention' }, ta, row);
}
