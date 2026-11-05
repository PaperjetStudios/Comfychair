import { h, api, toast, undoToast, uid, button, iconBtn, field, section, help, chip, icon, hint, seg, layerRowsEl, openSheet, closeSheet, textArea } from './ui.js';
import { S, thumbUrl, previewUrl, switchTab, templateName } from './core.js';
import { openImagePicker } from './media.js';
import { pictureSlot } from './picture-drop.js';
import { EXPRESSIONS, mentioned, packPictures, VIEW_KEYS } from './cast.js';
import { addLook, appearsIn, duplicateLook, figureBox, itemsOf, lineUp, MEDIA_ROLES, moveItem, removeItem, removeLook, staleness, viewsStamp } from './char-model.js';
import { queueRun, template as installed } from './make.js';
import { SHEET_TEMPLATES, markClipOf } from './markview-math.js';
import { addPicture, changed, characterById, characters, charBox, deleteCharacter, loadCharacters, makeExpressions, makeViews, mainPicture, newCharacter, packField, reviewRow,
  runsFor, setWorkingFor, tellCharacters, voiceOf, voices } from './characters.js';

// ---------------------------------------------------------------------------
// charstage: the Story tab's Characters view. The stage holds the cast, or one character's looks, what came back from
// the runs made for them, and their media in the user's own order. The side panel holds the writing, the look's words,
// its current 3D model and rig, the voice and the story links. Everything made for them comes back to To review
// (characters.js runsFor), so a character goes from photos to edits, sheets, views and models, and back.
// ---------------------------------------------------------------------------
const CS = { lineup: false, filter: 'all', rigTemplate: 'deck-autorig-human', stories: null, scores: new Map(), audition: null };
const EDIT_TEMPLATES = ['deck-krea2-edit', 'deck-klein9b-edit', 'deck-qwen21-edit', 'deck-moss-edit', 'deck-klein3-edit'];
const SHEETS = [['deck-h3-charsheet', 'Full'], ['deck-h3-charsheet-body', 'Body'], ['deck-h3-charsheet-bust', 'Bust'], ['deck-h3-charsheet-bust4', 'Short bust']];
const qs = (pid = S.project) => (pid != null ? `?project_id=${pid}` : '');
const said = (c, what) => { changed(c); tellCharacters(); if (what) toast(what); };

// ---- what's on the stage ----
export function renderCast(st, { open, onOpen, onBack }) {
  const top = st.scrollTop;
  const c = open && characterById(open);
  st.replaceChildren(...(c ? characterStage(c, onBack) : CS.lineup ? lineupStage(onOpen) : castStage(onOpen)));
  st.scrollTop = top;
}

function castStage(onOpen) {
  const cards = characters().map((c) => {
    const m = mainPicture(c);
    return h('button', { type: 'button', class: 'cs-card', 'aria-label': `${c.name}: open`, onclick: () => onOpen(c.id) },
      h('span', { class: 'cs-card-pic' }, m ? h('img', { src: thumbUrl(m, 320), alt: '', loading: 'lazy' }) : icon('person')),
      h('span', { class: 'cs-card-text' }, h('b', {}, c.name || 'Someone'),
        h('span', {}, c.role || c.desc || c.look || 'No description yet'),
        h('span', {}, `${c.looks.length} look${c.looks.length > 1 ? 's' : ''} · ${c.media.length} in media${c.cands.length ? ` · ${c.cands.length} to review` : ''}`)));
  });
  return [h('div', { class: 'cs-head' }, h('h2', {}, 'Characters'),
    button([icon('plus'), 'New character'], async () => onOpen((await newCharacter()).id), { cls: 'small primary' }),
    button('Bring in from a project', () => bringIn(onOpen), { cls: 'small' }),
    button('Line-up', () => { CS.lineup = true; tellCharacters(); }, { cls: 'small', disabled: !cards.length })),
  cards.length ? h('div', { class: 'cs-grid' }, cards) : hint('No characters yet.')];
}

// another project's character, its own copy of everything (POST /api/projects/{id}/characters/copy)
async function bringIn(onOpen) {
  const others = S.projects.filter((p) => p.id !== S.project);
  const list = h('div', { class: 'ch-list' }, hint('Loading…'));
  openSheet(h('h3', {}, 'Bring in a character'), help('Makes this project its own copy of their pictures, clips and models, so either project can change or delete theirs. The voice stays shared: voices belong to every project.'), list,
    h('div', { class: 'row wrap' }, button('Cancel', closeSheet)));
  const rows = [];
  for (const p of others) {
    try {
      for (const r of await api(`/api/store/characters${qs(p.id)}`, { busy: false })) {
        rows.push(h('button', { type: 'button', class: 'ch-row', onclick: async () => {
          try {
            const d = await api(`/api/projects/${S.project}/characters/copy`, { method: 'POST', busy: `Copying ${r.name}…`, timeout: 300000, body: { from_project: p.id, id: r.id } });
            closeSheet();
            toast(`${d.name} is in this project now`);
            setTimeout(() => onOpen(d.id), 600);
          } catch (e) { toast(e.message, true); }
        } }, h('span', { class: 'ch-text' }, h('b', {}, r.name), h('span', { class: 'ch-desc' }, p.name))));
      }
    } catch { /* that project's list can't be read: the rest still can */ }
  }
  list.replaceChildren(...(rows.length ? rows : [hint('No other project has characters.')]));
}

// ---- the height line-up ----
function lineupStage() {
  const space = 420, cast = characters(), { rows, scale } = lineUp(cast, space);
  const figs = rows.map(({ c, px, cm, guessed }, i) => {
    const front = c.views.front || mainPicture(c);
    const box = h('div', { class: 'cs-fig-box', style: `height:${Math.round(px)}px` }, front ? null : icon('person'));
    if (front) {
      const img = h('img', { alt: c.name, crossOrigin: 'anonymous', style: `height:${Math.round(px)}px` });
      img.addEventListener('load', () => fitFigure(img, px), { once: true });
      img.src = `/api/input?name=${encodeURIComponent(front)}`;
      box.replaceChildren(img);
    }
    const move = (to) => { moveItem(C_order(), i, to); saveOrder(); tellCharacters(); };
    return h('div', { class: 'cs-fig' }, box, h('div', { class: 'cs-fig-foot' },
      h('div', { class: 'cs-fig-lbl' }, h('b', {}, c.name), h('br'), guessed ? 'no height' : `${Math.round(cm)} cm`),
      h('div', { class: 'cs-fig-move' },
        i > 0 ? iconBtn('Move left', icon('left'), () => move(i - 1), { class: 'icon-btn' }) : null,
        i < rows.length - 1 ? iconBtn('Move right', icon('right'), () => move(i + 1), { class: 'icon-btn' }) : null)));
  });
  return [h('div', { class: 'cs-head' }, h('h2', {}, 'Line-up'),
    help('Each character at their height, standing on one floor. The lines are 10 cm apart. A cut-out picture lines up by the figure itself; a picture with a background is sized by the whole picture, so its top and feet are a guess. A character with no height stands at the average: set it under Who they are.'),
    button('Back to the cast', () => { CS.lineup = false; tellCharacters(); }, { cls: 'small' })),
  h('div', { class: 'cs-line-scroll' }, h('div', { class: 'cs-line', style: `--cm10:${scale * 10}px` }, figs))];
}
const C_order = () => characters();
async function saveOrder() {
  try { await api(`/api/store/characters/reorder${qs()}`, { method: 'POST', busy: false, body: { ids: characters().map((c) => c.id) } }); } catch (e) { toast(e.message, true); }
}
// a cut-out's figure is what stands to scale, not the empty picture around it
function fitFigure(img, px) {
  try {
    const n = 96, k = n / Math.max(img.naturalWidth, img.naturalHeight), w = Math.max(1, Math.round(img.naturalWidth * k)), hh = Math.max(1, Math.round(img.naturalHeight * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, hh);
    const b = figureBox(x.getImageData(0, 0, w, hh).data, w, hh);
    if (!b) return;
    const full = px / b.h;
    img.style.height = `${Math.round(full)}px`;
    img.style.marginBottom = `${-Math.round(full * b.bottom)}px`;
    img.parentElement.style.overflow = 'hidden';
  } catch { /* it can't be read: the whole picture stands for them */ }
}

// ---- one character ----
function characterStage(c, onBack) {
  const l = c.lookNow;
  const looks = h('div', { class: 'cs-looks' }, c.looks.map((x) => chip(x.name, () => { c.active = x.id; said(c); }, { on: x.id === l.id })),
    iconBtn('A new look', icon('plus'), () => { addLook(c); said(c); }, { class: 'icon-btn' }),
    iconBtn('A copy of this look to change', icon('copy'), () => { duplicateLook(c, l); said(c); }, { class: 'icon-btn' }),
    c.looks.length > 1 ? iconBtn('Remove this look', icon('trash'), () => {
      const snapshot = [c.looks.slice(), c.active];
      removeLook(c, l.id); said(c);
      undoToast(`Removed ${l.name}`, () => { [c.looks, c.active] = snapshot; said(c); });
    }, { class: 'icon-btn' }) : null);
  return [
    h('div', { class: 'cs-head' }, iconBtn('All the characters', icon('left'), onBack, { class: 'icon-btn' }), h('h2', {}, c.name || 'Someone'),
      button([icon('image'), 'Add pictures'], () => openImagePicker({ title: `Pictures of ${c.name || 'them'}`, multi: true, mp: () => 0, onPick: (n) => addPicture(c, n) }), { cls: 'small primary' })),
    looks,
    block('To review', reviewRow(c, (x) => likeness(c, { generation: x.gen, index: x.index }, x.id, (x.kind || 'image') === 'image'))),
    h('div', { class: 'cs-block' }, packField(c)),
    expressionBlock(c),
    block('Make from this look', makeRow(c)),
    mediaBlock(c),
  ].filter(Boolean);
}
const block = (title, el) => (el ? h('div', { class: 'cs-block' }, h('h3', {}, title), el) : null);

function expressionBlock(c) {
  const slot = ([k, label]) => {
    const v = c.expressions[k], wait = c.vpending.some((x) => x.slot === `expr:${k}` && x.look === c.lookNow.id);
    return pictureSlot(h('div', { class: `ch-view${v ? ' on' : ''}` },
      v ? h('button', { type: 'button', class: 'ch-pic-img', 'aria-label': `${label}: replace`, onclick: () => pickExpr(c, k, label) }, h('img', { src: thumbUrl(v, 240), alt: '', loading: 'lazy' }))
        : wait ? h('div', { class: 'ch-view-empty' }, h('span', { class: 'st-spin' }), h('span', {}, 'Making…'))
          : h('button', { type: 'button', class: 'ch-view-empty', 'aria-label': `${label}: choose a picture`, onclick: () => pickExpr(c, k, label) }, icon('plus')),
      h('span', { class: 'ch-view-lbl' }, label),
      v ? iconBtn(`Clear ${label}`, icon('close'), () => { delete c.expressions[k]; said(c); }, { class: 'icon-btn st-frame-x' }) : null), { give: (n) => { c.expressions[k] = n; said(c); } });
  };
  const n = Object.keys(c.expressions).length;
  return h('div', { class: 'cs-block' }, h('h3', {}, 'Expressions', h('span', {}, `${n}/${EXPRESSIONS.length}`)),
    h('div', { class: 'ch-views' }, EXPRESSIONS.map(slot)),
    h('div', { class: 'row wrap' }, button([icon('sparkle'), 'Make the expressions'], () => makeExpressions(c), { cls: 'small', disabled: !mainPicture(c), title: mainPicture(c) ? '' : 'Add a picture of them first' })));
}
const pickExpr = (c, k, label) => openImagePicker({ title: `${c.name}: ${label.toLowerCase()}`, mp: () => 0, onPick: (n) => { c.expressions[k] = n; said(c); } });

function makeRow(c) {
  const main = mainPicture(c), t = SHEETS.filter(([id]) => installed(id));
  return h('div', { class: 'row wrap' },
    button([icon('sparkle'), 'Edit in Generate'], () => editInGenerate(c, main), { cls: 'small', disabled: !main }),
    ...t.map(([id, label]) => button(`${label} sheet`, () => makeSheet(c, id), { cls: 'small', disabled: !main, title: `${id}: an orbit and close shots of them, as a clip and a sheet picture` })),
    button([icon('cube'), 'Make a 3D object'], () => makeModel(c), { cls: 'small', disabled: !main }));
}

// ---- out to the other tabs, and back ----
async function editInGenerate(c, name, slot = 'edit') {
  const { selectTemplate, setVal, renderFields } = await import('./generate.js');
  const fits = (t) => t?.fields?.some((f) => f.kind === 'image');
  const now = EDIT_TEMPLATES.includes(S.tpl?.id) ? S.tpl : installed(EDIT_TEMPLATES.find((id) => installed(id)));
  if (!fits(now)) return toast('No edit template is installed', true);
  if (S.tpl?.id !== now.id) await selectTemplate(now.id);
  const f = S.tpl.fields.find((x) => x.kind === 'image');
  setVal(f.key, name);
  setWorkingFor(c, slot);
  renderFields();
  switchTab('generate');
  toast(`${f.label}: set. What you make comes back to ${c.name}.`);
}

async function makeSheet(c, id) {
  const t = installed(id);
  if (!t) return toast(`${id} isn't installed`, true);
  const refs = t.fields.filter((f) => f.kind === 'image' && f.group === 'References');
  const pics = [...VIEW_KEYS.filter((k) => k !== 'face').map((k) => c.views[k]), c.views.face, mainPicture(c)].filter(Boolean);
  const order = [...new Set(pics)];
  if (!refs.length || !order.length) return toast('Add a picture of them first', true);
  const values = Object.fromEntries(refs.slice(0, order.length).map((f, i) => [f.key, order[i]]));
  try {
    const gens = await queueRun({ template: id, values });
    runsFor(c, gens, 'sheet', { made: { template: id, views: viewsStamp(c.views) } });
    toast(`Making ${c.name}'s sheet: it comes back to To review`);
  } catch (e) { toast(e.message, true); }
}

async function makeModel(c, settings = null) {
  const v = c.views, main = mainPicture(c);
  const picks = {};
  if (v.front) picks.Front = v.front;
  if (v.side) picks.Left = v.side;
  if (v.back) picks.Back = v.back;
  if (!picks.Front && main) picks.Front = main;
  const look = c.lookNow.id;
  await (await import('./run.js')).sceneModule();   // (the 3D code sets itself up on first use: the sheet needs that, the 3D tab needn't have been opened)
  (await import('./scene-import.js')).openObjectSheet(picks.Front, c.name, picks, { settings, character: {
    queued: (g, slot, template, used) => {
      const x = characterById(c.id);
      if (x) runsFor(x, [g], slot, { look, made: { template, settings: used, views: viewsStamp(x.looks.find((y) => y.id === look)?.views) } });
    } } });
}

async function rig(c, item, template = CS.rigTemplate) {
  const t = installed(template);
  if (!t) return toast(`Rigging needs the UniRig nodes (ComfyUI-UniRig) and the ${template} template`, true);
  if (item?.src?.generation == null) return toast('Choose a model made by a run first', true);
  try {
    const up = await api('/api/scene/mesh', { method: 'POST', busy: 'Sending the model to ComfyUI…', body: { generation: item.src.generation, index: item.src.index ?? 0 } });
    const f = t.fields.find((x) => x.group === 'Model');   // (the mesh's path: a text field)
    const gens = await queueRun({ template, values: f ? { [f.key]: up.file_path } : {} });
    runsFor(c, gens, 'rig', { made: { template, from: item.id } });
    toast(`${c.name}: rigging queued as #${gens[0].id}. It comes back to To review.`);
  } catch (e) { toast(e.message, true); }
}

// into the open 3D scene, remembering whose it is (so it can follow them later, when asked)
async function placeInScene(c, item) {
  if (!item.url && item.src?.generation != null) {
    const g = await api(`/api/generations/${item.src.generation}`, { busy: false });
    item.url = g.outputs?.[item.src.index ?? 0]?.url || '';
  }
  if (!item.url) return toast('That file is gone', true);
  switchTab('scene');
  await (await import('./run.js')).sceneModule();
  const opts = { gen: item.src.generation ?? null, index: item.src.index ?? 0 };
  const name = `${c.name}${c.looks.length > 1 ? ` · ${c.lookNow.name}` : ''}`;
  let o;
  try {
    if (item.role === 'rig') o = await (await import('./scene-rig.js')).addRigged(item.url, name, opts);
    else o = await (await import('./scene-import.js')).addModel(item.url, name, opts);
  } catch (e) { return toast(e.message, true); }
  if (o) { o.char = { id: c.id, look: item.look || c.lookNow.id, item: item.id }; (await import('./scene-data.js')).save(); }
}

// the 3D tab's panel: a layer from a character, and the current model or rig when that has changed
export function layerChar(o) {
  const c = characterById(o.char?.id), l = c?.looks.find((x) => x.id === o.char.look);
  if (!c || !l) return null;
  const cur = o.type === 'rigged' ? l.rig : l.model;
  const item = c.media.find((m) => m.id === cur);
  if (!item || item.id === o.char.item) return h('p', { class: 'hint' }, `${c.name} · ${l.name}`);
  return h('div', { class: 'row wrap' }, h('span', { class: 'cs-stale' }, `${c.name} has a newer ${o.type === 'rigged' ? 'rig' : 'model'}.`),
    button(`Update to current ${o.type === 'rigged' ? 'rig' : 'model'}`, () => updateLayer(o, c, item), { cls: 'small',
      title: 'A new layer standing where this one does; this one is hidden, and keeps its poses and keys' }));
}
async function updateLayer(o, c, item) {
  const data = await import('./scene-data.js');
  const { addRigged } = await import('./scene-rig.js'), { addModel } = await import('./scene-import.js');
  try {
    if (!item.url) item.url = (await api(`/api/generations/${item.src.generation}`, { busy: false })).outputs?.[item.src.index ?? 0]?.url || '';
    const opts = { gen: item.src.generation ?? null, index: item.src.index ?? 0 };
    const n = await (o.type === 'rigged' ? addRigged : addModel)(item.url, o.name, opts);
    if (!n) return;
    n.base = { ...n.base, x: o.base.x, y: o.base.y, z: o.base.z, ry: o.base.ry };
    n.char = { ...o.char, item: item.id };
    o.hidden = true;
    data.save();
    toast(`${o.name}: updated. The old layer is hidden and keeps its poses.`);
  } catch (e) { toast(e.message, true); }
}

// ---- the media: their own order ----
const thumbOf = (m) => h('span', { class: 'cs-thumb' },
  m.src?.input ? h('img', { src: thumbUrl(m.src.input, 160), alt: '', loading: 'lazy' })
    : m.kind === 'image' && m.url ? h('img', { src: previewUrl(m.url, 160), alt: '', loading: 'lazy' })
      : m.kind === 'video' && m.url ? h('video', { src: m.url, muted: true, preload: 'metadata', playsInline: true })
        : icon(m.role === 'rig' ? 'figure' : 'cube'));
const roleLabel = (r) => MEDIA_ROLES.find(([k]) => k === r)?.[1] || r;

function mediaBlock(c) {
  const roles = [...new Set(c.media.map((m) => m.role))];
  if (CS.filter !== 'all' && !roles.includes(CS.filter)) CS.filter = 'all';
  const shown = c.media.filter((m) => CS.filter === 'all' || m.role === CS.filter);
  const rows = shown.map((m) => {
    const l = c.lookNow, isMain = m.src?.input && l.main === m.src.input;
    return {
      thumb: thumbOf(m), name: m.label || roleLabel(m.role),
      hint: m.look ? c.looks.find((x) => x.id === m.look)?.name || '' : c.looks.length > 1 ? 'Every look' : '',
      sel: isMain, onclick: null,
      buttons: [
        m.src?.input ? iconBtn(isMain ? 'The main picture' : 'Make this the main picture', icon('check'), () => { l.main = m.src.input; said(c); }, { class: `icon-btn${isMain ? ' on' : ''}` }) : null,
        m.src?.input ? iconBtn('Edit in Generate', icon('sparkle'), () => editInGenerate(c, m.src.input), { class: 'icon-btn' }) : null,
        m.src?.input ? iconBtn('Layer it in the Image tab', icon('canvas'), async () => { switchTab('editor'); (await import('./editor.js')).addToEditor(m.src.input); }, { class: 'icon-btn' }) : null,
        m.kind === 'video' && m.src?.generation != null ? iconBtn('Mark views', icon('film'), () => markViews(m), { class: 'icon-btn' }) : null,
        ['model', 'rig'].includes(m.role) ? iconBtn('Place in the 3D scene', icon('cube'), () => placeInScene(c, m), { class: 'icon-btn' }) : null,
        m.src?.input ? roleSelect(c, m) : null,
        iconBtn('Take it out of this character', icon('close'), () => {
          const was = c.media.slice(), looks = structuredClone(c.looks);
          removeItem(c, m.id); said(c);
          undoToast('Taken out. The file stays until it is deleted.', () => { c.media = was; c.looks = looks; said(c); });
        }, { class: 'icon-btn' }),
      ].filter(Boolean),
    };
  });
  const body = rows.length ? layerRowsEl(rows, { onReorder: (from, to) => {
    const a = c.media.indexOf(shown[from]), b = c.media.indexOf(shown[to]);
    moveItem(c.media, a, b);
    said(c);
  } }) : hint('Nothing here yet: add photos of their face and body, or drop them anywhere on this page.');
  const box = h('div', { class: 'cs-block cs-media' }, h('h3', {}, 'Media', h('span', {}, `${c.media.length}`)),
    roles.length > 1 ? h('div', { class: 'chips' }, chip('All', () => { CS.filter = 'all'; tellCharacters(); }, { on: CS.filter === 'all' }),
      roles.map((r) => chip(roleLabel(r), () => { CS.filter = r; tellCharacters(); }, { on: CS.filter === r }))) : null,
    body);
  return pictureSlot(box, { give: (n) => addPicture(c, n), empty: true });
}
function roleSelect(c, m) {
  const sel = h('select', { 'aria-label': 'What it is', onchange: () => { m.role = sel.value; said(c); } },
    MEDIA_ROLES.filter(([k]) => ['face', 'body', 'ref', 'edit'].includes(k)).map(([k, l]) => h('option', { value: k }, l)));
  sel.value = m.role;
  return sel;
}
async function markViews(m) {
  try {
    const g = await api(`/api/generations/${m.src.generation}`, { busy: false }), i = markClipOf(g, m.src.index ?? 0);
    if (i < 0) return toast('Mark views works on an H3 run\'s clip', true);
    (await import('./markviews.js')).openMarkViews(g, i);
  } catch (e) { toast(e.message, true); }
}

// ---- likeness: how close a picture is to this look (POST /api/looks/check) ----
function likeness(c, image, key, can = true) {
  if (!can) return null;
  const got = CS.scores.get(key);
  return h('div', { class: 'cs-row' },
    got ? h('span', { class: `cs-score${got.drift ? ' bad' : ''}`, title: got.drift ? 'It has drifted from their look' : 'It keeps their look' }, `Look ${got.look}${got.colour != null ? ` · colours ${got.colour}` : ''}`) : null,
    button('Check likeness', async () => {
      const pictures = packPictures(c);
      if (!pictures.length) return toast('Add a picture of them first', true);
      try {
        const r = await api('/api/looks/check', { method: 'POST', busy: 'Comparing…', timeout: 180000, body: { image, characters: [{ id: c.id, pictures }] } });
        CS.scores.set(key, r.results[c.id]);
        tellCharacters();
      } catch (e) { toast(e.message, true); }
    }, { cls: 'small' }));
}

// ---- the side panel ----
export function charPanel(c, { goShot, done }) {
  return [whoSection(c, done), lookSection(c), modelSection(c), voiceSection(c), storySection(c, goShot)];
}
function line(c, key, label, opts = {}) {
  const i = h('input', { type: opts.type || 'text', value: c[key] ?? '', 'aria-label': label, placeholder: opts.placeholder || '', ...(opts.type === 'number' ? { min: 1, max: 400, inputMode: 'numeric' } : {}) });
  i.dataset.bind = `char.${c.id}.${key}`;
  i.addEventListener('input', () => {
    c[key] = opts.type === 'number' ? (Number(i.value) > 0 ? Number(i.value) : null) : i.value;
    changed(c);
    for (const o of document.querySelectorAll(`[data-show="char.${c.id}.${key}"]`)) o.textContent = c[key] || o.dataset.empty;
  });
  return field(label, i);
}
function whoSection(c, done) {
  return section(`Who they are`, done,
    line(c, 'name', 'Name'),
    line(c, 'role', 'Role in the story', { placeholder: 'e.g. the lead, her rival' }),
    line(c, 'height_cm', 'Height (cm)', { type: 'number' }),
    field('In a line', charBox(c, 'desc', { label: 'In a line', placeholder: 'e.g. the lighthouse keeper, tired and kind' })),
    field('Their story', charBox(c, 'bio', { label: 'Their story', rows: 6, max: 8000, placeholder: 'Where they come from, what they want, what they hide' })),
    field('Notes', charBox(c, 'notes', { rows: 3, label: 'Notes', placeholder: 'How they talk, habits, anything else' })),
    h('div', { class: 'row wrap' }, button([icon('trash'), 'Delete'], () => { done?.(); deleteCharacter(c); }, { cls: 'small danger' })));
}
function lookSection(c) {
  const l = c.lookNow;
  const name = h('input', { type: 'text', value: l.name, 'aria-label': 'Look name' });
  name.dataset.bind = `look.${c.id}.${l.id}.name`;
  name.addEventListener('change', () => { l.name = name.value.trim() || 'Look'; said(c); });
  const ta = textArea(() => l.text, (v) => { l.text = v; changed(c); }, { rows: 4, max: 800, label: 'How they look', placeholder: 'e.g. a woman in her 30s, short black hair, red raincoat' });
  ta.dataset.bind = `look.${c.id}.${l.id}.look`;
  const io = { get: () => l.text, set: (v) => { l.text = v; ta.value = v; changed(c); }, target: { media: 'image', family: 'generic' } };
  return section(`Look · ${l.name}`, null,
    field('Name of this look', name),
    field('How they look', ta, help('What prompts say about them in this look: the face, hair, clothes. Kept short and the same every time, so they look alike from shot to shot. A shot chooses which look it uses.')),
    h('div', { class: 'row wrap' }, button([icon('eye'), 'Describe a picture'], async () => (await import('./prompthelp.js')).openDescribe(io), { cls: 'small' })));
}

// ---- the model and rig are this look's settings: choose another, or make them again as they were made or changed ----
function modelSection(c) {
  const l = c.lookNow, st = staleness(c, l);
  const choose = (role, key, none) => {
    const list = itemsOf(c, role, l.id);
    return h('div', { class: 'chips' }, chip(none, () => { l[key] = null; said(c); }, { on: !l[key] }),
      list.map((m, i) => chip(m.label || `${roleLabel(role)} ${i + 1}`, () => { l[key] = m.id; said(c); }, { on: l[key] === m.id, title: m.made?.template || '' })));
  };
  const model = c.media.find((m) => m.id === l.model), rigged = c.media.find((m) => m.id === l.rig);
  const tplChoice = seg([['deck-autorig-human', 'Human'], ['deck-autorig-any', 'Anything']], rigged?.made?.template && !CS.rigTouched ? rigged.made.template : CS.rigTemplate, (v) => { CS.rigTemplate = v; CS.rigTouched = true; tellCharacters(); });
  const rigWith = () => (CS.rigTouched ? CS.rigTemplate : rigged?.made?.template || CS.rigTemplate);
  return section('Model and rig', null,
    help('Each look keeps its current 3D model and rig. Old versions stay in the media, so you can go back. Make again and Rig again start from how the current one was made, and the result waits in To review; it becomes the current one only when you keep it. A layer already in a scene doesn\'t change until you tell it to.'),
    h('div', { class: `cs-part${st.model ? ' stale' : ''}` }, h('b', {}, 'Model'), choose('model', 'model', 'None'),
      st.model ? h('span', { class: 'cs-stale' }, 'The views changed after this was made.') : null,
      model?.made?.template ? h('span', { class: 'hint' }, templateName(model.made.template)) : null,
      h('div', { class: 'row wrap' },
        button(model ? 'Make again' : 'Make a 3D object', () => makeModel(c, model?.made?.settings || null), { cls: 'small', disabled: !mainPicture(c) }),
        model ? button('Place in the 3D scene', () => placeInScene(c, model), { cls: 'small' }) : null)),
    h('div', { class: `cs-part${st.rig ? ' stale' : ''}` }, h('b', {}, 'Rig'), choose('rig', 'rig', 'None'),
      st.rig ? h('span', { class: 'cs-stale' }, 'The model changed after this rig was made.') : null,
      field('Rig for', tplChoice),
      h('div', { class: 'row wrap' },
        button(rigged ? 'Rig again' : 'Rig the model', () => rig(c, model, rigWith()), { cls: 'small', disabled: !model, title: model ? '' : 'Choose a model first' }),
        rigged ? button('Place in the 3D scene', () => placeInScene(c, rigged), { cls: 'small' }) : null)));
}

function voiceSection(c) {
  const vs = voices() || [], v = voiceOf(c);
  const text = h('input', { type: 'text', 'aria-label': 'A line to hear', placeholder: 'A line to hear them say', value: CS.auditionText || '' });
  text.dataset.bind = `audition.${c.id}`;
  text.addEventListener('input', () => { CS.auditionText = text.value; });
  return section('Voice', null,
    help('Their lines in a shot are spoken in this voice. Make a voice opens the Sound tab\'s Voice tools; come back and it is listed here.'),
    vs.length ? h('div', { class: 'chips' }, chip('None', () => { c.voice = null; said(c); }, { on: !c.voice }),
      vs.map((x) => chip(x.name, () => { c.voice = x.id; said(c); }, { on: c.voice === x.id }))) : hint('No voices saved yet.'),
    v ? h('audio', { src: v.url, controls: true, preload: 'none', class: 'ch-audio' }) : null,
    v ? field('Audition', text, h('div', { class: 'row wrap' }, button('Say it', () => audition(c, v), { cls: 'small' }))) : null,
    CS.audition?.c === c.id ? h('audio', { src: CS.audition.url, controls: true, autoplay: true, class: 'ch-audio' }) : null,
    h('div', { class: 'row wrap' }, button([icon('mic'), 'Make a voice'], () => switchTab('sound'), { cls: 'small' })));
}
async function audition(c, v) {
  const line_ = (CS.auditionText || '').trim();
  if (!line_) return toast('Write a line first', true);
  const old = CS.audition;
  try {
    const { waitJob } = await import('./clipimport.js');
    const r = await waitJob(await api('/api/voice/speak', { method: 'POST', busy: 'Speaking…', body: { lines: [{ voice: v.id, text: line_ }], engine: 'qwen', name: `audition-${c.id}` } }));
    const m = r.lines[0];
    CS.audition = { c: c.id, url: m.url, name: m.name };
    tellCharacters();
    if (old?.name) api(`/api/media?name=${encodeURIComponent(old.name)}`, { method: 'DELETE', busy: false }).catch(() => {});   // (only the last one stays)
  } catch (e) { toast(e.message, true); }
}

function storySection(c, goShot) {
  if (!CS.stories) {
    CS.stories = [];
    loadStories();
  }
  const found = appearsIn(c, CS.stories, mentioned, characters());
  const others = characters().filter((x) => x.id !== c.id);
  const rel = c.relations.map((r, i) => h('div', { class: 'cs-row' },
    h('b', {}, characterById(r.to)?.name || 'Someone'),
    (() => { const t = h('input', { type: 'text', value: r.what || '', 'aria-label': 'Who they are to them', placeholder: 'e.g. her sister' });
      t.dataset.bind = `rel.${c.id}.${i}`;
      t.addEventListener('input', () => { r.what = t.value; changed(c); }); return t; })(),
    iconBtn('Remove', icon('close'), () => { c.relations.splice(i, 1); said(c); }, { class: 'icon-btn' })));
  const free = others.filter((x) => !c.relations.some((r) => r.to === x.id));
  const scenes = [...new Map(found.map((f) => [f.scene, f])).values()];
  const arcs = scenes.map((f) => {
    const ta = textArea(() => c.arcs[f.scene] || '', (v) => { if (v.trim()) c.arcs[f.scene] = v; else delete c.arcs[f.scene]; changed(c); }, { rows: 2, max: 800, label: `Scene ${f.sceneIndex + 1}`, placeholder: 'Where they are in this scene' });
    ta.dataset.bind = `arc.${c.id}.${f.scene}`;
    return field(`${f.storyName}: scene ${f.sceneIndex + 1}`, ta);
  });
  return section('Story', null,
    field('Appears in', found.length ? h('div', {}, found.map((f) => h('div', { class: 'cs-appear' },
      button(`${f.storyName} ${f.sceneIndex + 1}.${f.shotIndex + 1}`, () => goShot(f), { cls: 'small' }),
      f.frame ? likeness(c, f.frame, `${f.story}:${f.shot}`) : null))) : hint('No shot names them yet: write @ and their name in a shot.')),
    field('Others', rel.length ? h('div', {}, rel) : null,
      free.length ? h('div', { class: 'chips' }, free.map((x) => chip([icon('plus'), x.name], () => { c.relations.push({ to: x.id, what: '' }); said(c); }))) : null),
    arcs.length ? field('Their arc', ...arcs) : null);
}
// the project's stories, as saved (another story's shots aren't open here)
async function loadStories() {
  try {
    const rows = await api(`/api/store/story-tabs${qs()}`, { busy: false });
    const docs = (await Promise.all(rows.map((r) => api(`/api/store/story-tabs/${r.id}${qs()}`, { busy: false }).catch(() => null)))).filter(Boolean);
    for (const d of docs) for (const sc of d.payload?.scenes || []) for (const s of sc.shots || []) {
      const f = (s.frames || []).find((x) => x.id === s.pick) || (s.frames || [])[0];
      if (f) s.frameRef = f.input ? { input: f.input } : f.gen ? { generation: f.gen, index: f.index ?? 0 } : null;
    }
    CS.stories = docs;
    tellCharacters();
  } catch { /* offline: empty for now */ }
}
export const forgetStories = () => { CS.stories = null; };
