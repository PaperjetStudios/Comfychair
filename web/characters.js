import { h, api, toast, undoToast, uid, button, iconBtn, field, section, help, textArea, chip, icon, hint } from './ui.js';
import { S, thumbUrl, onServer, onProject, isMine, previewUrl } from './core.js';
import { openImagePicker } from './media.js';
import { suggest, typing, VIEWS, VIEW_KEYS, VIEW_PROMPTS, viewPrompt, packViews } from './cast.js';
import { queueRun, template as installed, roleField, valuesByRole, ROLES } from './make.js';

// ---------------------------------------------------------------------------
// characters: a project's people (and creatures), for the Story tab and whoever else needs them. Each is a document
// of the 'characters' kind in the project folder (app/store.py): a name, who they are, their look (what prompts
// say about them), reference pictures (one is the main one), a voice from the Sound tab's voice library, notes.
// Writing names them with @Name (web/cast.js); prompts then carry their look and their main picture.
//   await loadCharacters(); characters(); onCharacters(fn) (after any change);
//   castSection({ open, onOpen }) and characterSection(c, { done, extra }) for a side panel; mentionBox(ta)
// A look pack: named views (front, three-quarter, side, back, face: web/cast.js VIEWS) made from the main picture
// with deck-krea2-identity (Make the views), each result kept, made again or thrown away; and a sheet, the kept
// views composed into one picture (POST /api/looks/sheet). Runs for views wait on the character (vpending) and land
// as candidates (cands) to review.
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
    pics: Array.isArray(p.pics) ? p.pics.filter((x) => typeof x === 'string') : [], main: p.main || null, voice: p.voice || null,
    views: Object.fromEntries(VIEW_KEYS.filter((k) => typeof p.views?.[k] === 'string').map((k) => [k, p.views[k]])),
    sheet: typeof p.sheet === 'string' ? p.sheet : null,
    vpending: Array.isArray(p.vpending) ? p.vpending.filter((x) => x && x.gen && VIEW_KEYS.includes(x.view)) : [],
    cands: Array.isArray(p.cands) ? p.cands.filter((x) => x && x.id && VIEW_KEYS.includes(x.view)) : [] };
};
const payloadOf = (c) => ({ desc: c.desc, look: c.look, notes: c.notes, pics: c.pics, main: c.main, voice: c.voice,
  views: c.views, sheet: c.sheet, vpending: c.vpending, cands: c.cands });

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
    viewsCatchUp();
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
  const c = { id: uid(), rev: 0, name: `Character ${n}`, desc: '', look: '', notes: '', pics: [], main: null, voice: null,
    views: {}, sheet: null, vpending: [], cands: [], ...o };
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

// ---- look packs: views made from the main picture, reviewed, and composed into a sheet ----
export const VIEW_TEMPLATE = 'deck-krea2-identity';
const VIEW_BOOST = 4;   // Reference strength: the template's 2 lets the outfit drift on a new pose; 4 keeps it
const VROLE = { ...ROLES, person: (f) => f.kind === 'image', width: (f) => f.kind === 'int' && f.input === 'width',
  height: (f) => f.kind === 'int' && f.input === 'height', boost: (f) => f.kind === 'float' && f.input === 'ref_boost' };
const pendingView = (c, k) => c.vpending.some((x) => x.view === k);
export const viewsReady = () => !!installed(VIEW_TEMPLATE);

// queue deck-krea2-identity for these views of c (default: the ones it lacks, not already on their way or to review)
export async function makeViews(c, keys = VIEW_KEYS.filter((k) => !c.views[k] && !pendingView(c, k) && !c.cands.some((x) => x.view === k))) {
  const t = installed(VIEW_TEMPLATE), src = mainPicture(c);
  if (!t) return toast(`${VIEW_TEMPLATE} isn't installed (README: Krea 2 identity edit)`, true);
  if (!src) return toast('Add a picture of them first: the views are made from the main one', true);
  if (!keys.length) return toast('Every view is there already (or on its way)');
  let n = 0;
  for (const k of keys) {
    const [, w, hh] = VIEW_PROMPTS[k];
    const values = valuesByRole(t, { person: src, prompt: viewPrompt(k), width: w, height: hh, boost: VIEW_BOOST, seed: -1 }, VROLE);
    try {
      const [g] = await queueRun({ template: t.id, values });
      c.vpending.push({ gen: g.id, view: k });
      n++;
    } catch (e) { toast(e.message, true); break; }
  }
  if (n) { changed(c); tell(); toast(n > 1 ? `Making ${n} views of ${c.name}: they come back here to keep or redo` : `Making the ${k2label(keys[0])} view`); }
}
const k2label = (k) => (VIEWS.find(([v]) => v === k)?.[1] || k).toLowerCase();

// a run for a view ended: its picture waits to be kept (once)
function settleView(c, g) {
  const p = c.vpending.find((x) => x.gen === g.id);
  if (!p) return false;
  c.vpending = c.vpending.filter((x) => x !== p);
  if (g.status === 'done') {
    (g.outputs || []).forEach((o, index) => {
      if (o.kind === 'image' && !c.cands.some((x) => x.gen === g.id && x.index === index)) c.cands.push({ id: uid(), view: p.view, gen: g.id, index, url: o.url });
    });
  } else if (g.status !== 'gone') toast(`The ${k2label(p.view)} view of ${c.name} failed${g.error ? `: ${g.error}` : ''}`, true);
  return true;
}
onServer('deck_generation', ({ data: g }) => {
  if (!g || !['done', 'error', 'interrupted'].includes(g.status) || !isMine(g.prompt_id)) return;
  const c = C.list.find((x) => x.vpending.some((p) => p.gen === g.id));
  if (c && settleView(c, g)) { changed(c); tell(); }
});
// views that finished while nothing here was listening (a reload, another device)
async function viewsCatchUp() {
  for (const c of [...C.list]) {
    let any = false;
    for (const p of [...c.vpending]) {
      let g = S.history.get(p.gen);
      if (!g || !['done', 'error', 'interrupted'].includes(g.status)) {
        try { g = await api(`/api/generations/${p.gen}`, { busy: false }); } catch (e) { g = /not found/i.test(e.message) ? { id: p.gen, status: 'gone' } : null; }
      }
      if (g && ['done', 'error', 'interrupted', 'gone'].includes(g.status)) any = settleView(c, g) || any;
    }
    if (any) { changed(c); tell(); }
  }
}

async function keepView(c, x) {
  try {
    const r = await api(`/api/generations/${x.gen}/to-input`, { method: 'POST', body: { index: x.index, frame: 'first', mp: 0, multiple: 16 }, busy: 'Keeping the view…' });
    c.views[x.view] = r.name;
    c.cands = c.cands.filter((y) => y !== x);
    changed(c); tell();
  } catch (e) { toast(e.message, true); }
}
function dropCand(c, x) { c.cands = c.cands.filter((y) => y !== x); changed(c); tell(); }
function redoView(c, x) { dropCand(c, x); makeViews(c, [x.view]); }
function setView(c, k, name) { if (name) c.views[k] = name; else delete c.views[k]; changed(c); tell(); }

async function makeSheet(c) {
  const pics = packViews(c).map((k) => c.views[k]);
  if (pics.length < 2) return toast('Keep at least two views first', true);
  try {
    const r = await api('/api/looks/sheet', { method: 'POST', body: { pictures: pics, project_id: S.project }, busy: 'Making the sheet…' });
    c.sheet = r.name;
    changed(c); tell();
    toast(`${c.name}'s sheet is ready: shots can use it as their reference`);
  } catch (e) { toast(e.message, true); }
}

function packField(c) {
  const ok = viewsReady(), src = mainPicture(c);
  const slot = (k, label) => {
    const v = c.views[k], wait = pendingView(c, k);
    return h('div', { class: `ch-view${v ? ' on' : ''}` },
      v ? h('button', { type: 'button', class: 'ch-pic-img', 'aria-label': `${label} view: replace with a picture`,
        onclick: () => openImagePicker({ title: `${c.name}: ${label.toLowerCase()} view`, mp: () => 0, onPick: (n) => setView(c, k, n) }) },
      h('img', { src: thumbUrl(v, 240), alt: '', loading: 'lazy' }))
        : wait ? h('div', { class: 'ch-view-empty' }, h('span', { class: 'st-spin' }), h('span', {}, 'Making…'))
          : h('button', { type: 'button', class: 'ch-view-empty', 'aria-label': `${label} view: choose a picture`,
            onclick: () => openImagePicker({ title: `${c.name}: ${label.toLowerCase()} view`, mp: () => 0, onPick: (n) => setView(c, k, n) }) }, icon('plus')),
      h('span', { class: 'ch-view-lbl' }, label),
      v ? iconBtn(`Clear the ${label.toLowerCase()} view`, icon('close'), () => setView(c, k, null), { class: 'icon-btn st-frame-x' }) : null,
      !v && !wait && ok && src ? iconBtn(`Make the ${label.toLowerCase()} view`, icon('sparkle'), () => makeViews(c, [k]), { class: 'icon-btn ch-view-make' }) : null);
  };
  const review = c.cands.length ? h('div', { class: 'ch-cands' }, c.cands.map((x) => h('div', { class: 'ch-cand' },
    h('div', { class: 'ch-cand-img' }, h('img', { src: previewUrl(x.url, 320), alt: '', loading: 'lazy' }), h('span', { class: 'ch-view-lbl' }, VIEWS.find(([v]) => v === x.view)?.[1])),
    h('div', { class: 'ch-cand-btns' },
      iconBtn('Keep it', icon('check'), () => keepView(c, x), { class: 'icon-btn' }),
      iconBtn('Make it again', icon('refresh'), () => redoView(c, x), { class: 'icon-btn' }),
      iconBtn('Throw it away', icon('trash'), () => dropCand(c, x), { class: 'icon-btn' }))))) : null;
  const n = packViews(c).length;
  return field(['Look pack', h('span', {}, `${n}/${VIEWS.length}`)],
    help(`Views of them for shots to use: a close-up gets the face, a profile the side, from behind the back, otherwise the front or three-quarter. Make the views draws the missing ones from the main picture (${VIEW_TEMPLATE}); keep, redo or throw away each. A plus picks one from your pictures instead. The sheet puts the kept views side by side as one reference picture.`),
    h('div', { class: 'ch-views' }, VIEWS.map(([k, l]) => slot(k, l))),
    review ? h('p', { class: 'hint' }, 'New views to look at:') : null, review,
    c.sheet ? h('div', { class: 'ch-sheet' }, h('img', { src: thumbUrl(c.sheet, 480), alt: 'Character sheet', loading: 'lazy' }),
      iconBtn('Remove the sheet', icon('close'), () => { c.sheet = null; changed(c); tell(); }, { class: 'icon-btn st-frame-x' })) : null,
    h('div', { class: 'row wrap' },
      button([icon('sparkle'), 'Make the views'], () => makeViews(c), { cls: 'small primary', disabled: !ok || !src,
        title: !ok ? `${VIEW_TEMPLATE} isn't installed` : !src ? 'Add a picture of them first' : '' }),
      button([icon('grid'), c.sheet ? 'Sheet again' : 'Character sheet'], () => makeSheet(c), { cls: 'small', disabled: n < 2, title: n < 2 ? 'Keep at least two views first' : '' })));
}

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
    packField(c),
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
