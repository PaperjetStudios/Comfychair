import {
  $, h, store, clamp, clamp01, clone, cycleIndex, api, toast, undoToast, openOverlay, openSheet, sheetStillOpen, nameSheet,
  button, iconBtn, seg, field, hint, placeholder, note, cycleBar, help, info, numSlider,
  insertAtCursor, toggle, textArea, seedField as uiSeedField, imageInput, chips, chip,
} from './ui.js';
import { ASPECT_PRESETS, S, deleteSnippet, inputUrl, loadSnippets, saveSnippet, savedEntries, thumbUrl } from './core.js';
import { clipLabel, clipUrl, openImagePicker, openVideoPicker, soundInput } from './media.js';
import { RUN, fmtDur, notifyPrepare, openJobs } from './run.js';
import { queueRun } from './make.js';
import { zoomPan } from './layout.js';

import { clipInput } from './vfield.js';
import { PREFS } from './prefs.js';
import { FULL, openCrop, openSketch, templateAspect } from './editor.js';
import { openMaskPainter } from './maskpaint.js';
import { icon } from './icons.js';
import { kreaTag } from './cast.js';
import { openCivitai } from './civitai.js';
import { openDescribe, openImprove, tplTarget } from './prompthelp.js';

// ---------------------------------------------------------------------------
// templates + fields
// ---------------------------------------------------------------------------
export function stateKey(id) { return `deck.tpl.${id}`; }
// gentabs.js plugs in here (it imports this file, so this file can't import it): edited() after every
// edit, flush() before a run, decorate() after fields are drawn, pick() for a template change,
// templatesLoaded() once the template list is in, openShot() for "open as new tab"
export const hooks = {};
// The old per-template localStorage copy is still written: it is the starting point of a project's first tab
export function persist() {
  if (!S.tpl) return;
  store.set(stateKey(S.tpl.id), { values: S.values, seedMode: S.seedMode, imageMp: S.imageMp, imageCrop: S.imageCrop, sizeMode: S.sizeMode, loraFolder: S.loraFolder, builder: S.builder });
  hooks.edited?.();
  dispatchEvent(new Event('deck:generate'));   // the template or a value changed (the 3D tab can match its length)
}

export async function loadTemplates(refresh = false) {
  let failed = null;
  try {
    S.templates = await api('/api/templates' + (refresh ? '?refresh=1' : ''));
  } catch (e) { failed = e; S.templates = []; }
  fillTemplates();
  if (!S.templates.length) {
    $('#fields').replaceChildren(failed
      ? note(`Couldn't load templates: ${failed.message}. They load by themselves once ComfyChair answers.`, 'err')
      : note('No templates yet. Export a workflow from ComfyUI with Workflow → Export (API), tag nodes with @, and put it in the templates/ folder.', 'warn'));
    return;
  }
  const want = (S.tpl && S.tpl.id) || store.get('deck.tplId', null);
  const id = S.templates.find((t) => t.id === want) ? want : S.templates[0].id;
  if (hooks.templatesLoaded) hooks.templatesLoaded(id); else selectTemplate(id);
}

// The template list, narrowed by what it makes (video, image, audio) and then by model. The template in use always
// stays in the list, so narrowing it never swaps the settings under you.
const MEDIA = [['', 'All types'], ['video', 'Video'], ['image', 'Image'], ['audio', 'Audio'], ['other', 'Other']];
function fillTemplates() {
  const type = $('#tplType'), fam = $('#tplFam'), sel = $('#tplSel');
  const F = store.get('deck.tplFilter', { media: '', family: '' });
  const has = (m) => !m || S.templates.some((t) => t.media === m);
  if (!has(F.media)) F.media = '';
  type.replaceChildren(...MEDIA.filter(([m]) => has(m)).map(([m, l]) => h('option', { value: m }, l)));
  type.value = F.media;
  const fams = [...new Set(S.templates.filter((t) => !F.media || t.media === F.media).map((t) => t.family || 'Other'))].sort();
  if (F.family && !fams.includes(F.family)) F.family = '';
  fam.replaceChildren(h('option', { value: '' }, 'All models'), ...fams.map((f) => h('option', { value: f }, f)));
  fam.value = F.family;
  const cur = S.tpl?.id;
  const shown = S.templates.filter((t) => t.id === cur || ((!F.media || t.media === F.media) && (!F.family || (t.family || 'Other') === F.family)));
  sel.replaceChildren(...shown.map((t) => h('option', { value: t.id }, t.name + (t.error ? ' (error)' : ''))));
  if (cur) sel.value = cur;
  return { F, shown };
}
export function wireTemplateFilter() {
  const pick = (k) => (e) => {
    const F = store.get('deck.tplFilter', { media: '', family: '' });
    F[k] = e.target.value;
    if (k === 'media') F.family = '';
    store.set('deck.tplFilter', F);
    const prev = S.tpl?.id;
    const { shown } = fillTemplates();
    const fits = (t) => (!F.media || t.media === F.media) && (!F.family || (t.family || 'Other') === F.family);
    if (prev && !fits(S.templates.find((t) => t.id === prev) || {})) {   // the one in use is outside the filter: take the first that fits
      const first = shown.find(fits);
      if (first) { $('#tplSel').value = first.id; $('#tplSel').dispatchEvent(new Event('change')); }
    }
  };
  $('#tplType').addEventListener('change', pick('media'));
  $('#tplFam').addEventListener('change', pick('family'));
}

export function selectTemplate(id, overrideValues = null) {
  if (hooks.pick) return hooks.pick(id, overrideValues);   // the tab decides what a template change means
  const t = S.templates.find((x) => x.id === id);
  if (!t) return;
  S.tpl = t;
  fillTemplates();   // (the template in use is always listed)
  $('#tplSel').value = id;
  store.set('deck.tplId', id);
  const saved = store.get(stateKey(id), {});
  S.values = {}; S.seedMode = saved.seedMode || {}; S.imageMp = saved.imageMp || {}; S.imageCrop = saved.imageCrop || {}; S.sizeMode = saved.sizeMode || {}; S.loraFolder = saved.loraFolder || {}; S.builder = saved.builder || {};
  for (const f of t.fields) {
    const sv = saved.values ? saved.values[f.key] : undefined;
    // keep a saved choice only if it's still a valid option (models get renamed/removed)
    const valid = sv !== undefined && !(f.kind === 'choice' && f.options.length && !f.options.includes(sv));
    S.values[f.key] = valid ? sv : f.value;
  }
  if (overrideValues) {
    for (const [k, v] of Object.entries(overrideValues)) if (k in S.values) S.values[k] = v;
    for (const f of t.fields) if (f.kind === 'seed' && overrideValues[f.key] !== undefined) S.seedMode[f.key] = 'fixed';
    S.sizeMode = {};  // re-derive aspect + MP from the reused width/height
  }
  renderFields();
  persist();
}

let shownTpl = null;   // the template the settings were last drawn for
export function renderFields() {
  const t = S.tpl;
  const notes = [];
  if (t.error) notes.push(note(t.error, 'err'));
  for (const w of t.warnings) notes.push(note(w, 'warn'));
  $('#tplNotes').replaceChildren(...notes);

  const openState = store.get('deck.groupsOpen', {});
  const groups = [];
  for (const g of t.groups) {
    const fs = t.fields.filter((f) => f.group === g.label);
    if (!fs.length) continue;
    const key = `${t.id}:${g.label}`;
    const det = h('details', { class: 'group', open: openState[key] ?? g.label !== 'Advanced' },
      h('summary', {}, g.label),
      h('div', { class: 'group-body' }, g.label !== 'Advanced' ? groupPresetBar(g, fs) : null, groupFieldEls(fs)));
    det.addEventListener('toggle', () => { const o = store.get('deck.groupsOpen', {}); o[key] = det.open; store.set('deck.groupsOpen', o); });
    groups.push(det);
  }
  // A full redraw must not move the user: keep the panel's scroll and the focused control
  // (unless the template changed and the user asked for the top then: Settings ⚙)
  const root = $('#fields'), panel = root.closest('.panel');
  const y = panel && !(PREFS.tplScrollTop && shownTpl && shownTpl !== t.id) ? panel.scrollTop : 0;
  shownTpl = t.id;
  const ae = document.activeElement, fe = ae && root.contains(ae) ? ae.closest('.field[data-key]') : null;
  const at = fe ? { key: fe.dataset.key, i: [...fe.querySelectorAll(ae.tagName)].indexOf(ae), s: ae.selectionStart, e: ae.selectionEnd } : null;
  root.replaceChildren(...groups, shotBar());   // (the panel order, app-wide: what goes in, how it's made, then the saved shots)
  hooks.decorate?.();
  if (panel) panel.scrollTop = y;
  if (at && at.i >= 0) {
    const el = [...root.querySelectorAll('.field[data-key]')].find((x) => x.dataset.key === at.key)?.querySelectorAll(ae.tagName)[at.i];
    if (el) {
      el.focus({ preventScroll: true });
      if (at.s != null) { try { el.setSelectionRange(at.s, at.e); } catch { /* number inputs have no selection */ } }
      if (panel) panel.scrollTop = y;
    }
  }
  if (!S.snippets) loadSnippets().then(() => renderFields());
}

// Show a template with a ready state (what a tab holds): values already in S.values; the rest here
export function installState(t, st) {
  S.tpl = t;
  fillTemplates();   // (the template in use is always listed)
  $('#tplSel').value = t.id;
  store.set('deck.tplId', t.id);
  S.seedMode = st.seedMode || {}; S.imageMp = st.imageMp || {}; S.imageCrop = st.imageCrop || {}; S.sizeMode = st.sizeMode || {};
  S.loraFolder = st.loraFolder || {}; S.builder = st.builder || {};
  renderFields();
  dispatchEvent(new Event('deck:generate'));
}

export function setVal(key, v) { S.values[key] = v; persist(); }

// ---------------------------------------------------------------------------
// saved shots: the whole template at once (prompt and its builder parts, images and crops, every
// setting, seed modes), for this workflow. ◀ ▶ load the previous/next shot (with an Undo),
// 💾 saves over the loaded one, ＋ saves a new one. Stored with the snippets, so every device sees them.
// ---------------------------------------------------------------------------
const SHOT_CATEGORY = 'Saved shot';

function captureShot() {
  const pb = builderState();
  return { workflow: S.tpl.id, values: clone(S.values), seedMode: clone(S.seedMode), sizeMode: clone(S.sizeMode),
    imageCrop: clone(S.imageCrop), imageMp: clone(S.imageMp), builder: pb.on ? clone(pb) : null };
}

function applyShot(p) {
  for (const f of S.tpl.fields) {
    if (!(f.key in p.values)) continue;
    const v = p.values[f.key];
    if (f.kind === 'choice' && f.options.length && !f.options.includes(v)) continue;  // model or option gone
    S.values[f.key] = v;
  }
  S.seedMode = p.seedMode || {}; S.sizeMode = p.sizeMode || {}; S.imageCrop = p.imageCrop || {}; S.imageMp = p.imageMp || {};
  const pb = builderState();
  if (p.builder) S.pb = { ...clone(p.builder), on: true };
  else pb.on = false;  // the prompt was written as plain text: show it that way
  saveBuilder(); persist(); renderFields();
}

function shotBar() {
  const curKey = `deck.shot.${S.tpl.id}`;
  const entries = () => savedEntries(SHOT_CATEGORY, (p) => p.workflow === S.tpl.id).sort((a, b) => a.created - b.created);
  const curId = () => String(store.get(curKey, ''));
  const loaded = () => entries().find((y) => String(y.id) === curId());
  const l = entries(), i = l.findIndex((x) => String(x.id) === curId());
  const switchTo = (id, p, msg) => {   // with an Undo back to what was there
    const before = captureShot(), beforeId = curId();
    store.set(curKey, id);
    applyShot(p);
    undoToast(msg, () => { store.set(curKey, beforeId); applyShot(before); });
  };
  const go = (d) => {
    const list = entries();
    if (!list.length) return toast('No saved shots yet: ＋ saves this one');
    const x = list[cycleIndex(list.findIndex((y) => String(y.id) === curId()), d, list.length)];
    switchTo(String(x.id), x.p, `Loaded shot "${x.name}"`);
  };
  const saveNew = () => nameSheet({ title: 'Save shot', placeholder: 'Name, e.g. "Market walk – wide"',
    hint: `Saves everything in ${S.tpl.name}: the prompt (and its parts), images, LoRAs and every setting.`,
    save: async (name) => {
      const r = await saveSnippet({ category: SHOT_CATEGORY, name: name || `Shot ${entries().length + 1}`, text: JSON.stringify(captureShot()) });
      store.set(curKey, String(r.id));
      renderFields(); toast(`Saved shot "${r.name}"`);
    } });
  const saveOver = async () => {
    const x = loaded();
    if (!x) return saveNew();
    try {
      await saveSnippet({ id: x.id, category: SHOT_CATEGORY, name: x.name, text: JSON.stringify(captureShot()) });
      renderFields(); toast(`Saved over "${x.name}"`);
    } catch (e) { toast(e.message, true); }
  };
  const del = async () => {
    const x = loaded();
    if (!x) return toast('No saved shot loaded');
    store.set(curKey, '');
    try { await deleteSnippet(x, `Deleted shot "${x.name}"`, renderFields); } catch (e) { toast(e.message, true); }
  };
  const defaults = () => switchTo('', { values: Object.fromEntries(S.tpl.fields.map((f) => [f.key, f.value])) }, 'Back to the template defaults');
  return cycleBar({ title: 'Shots', what: 'saved shot', prev: () => go(-1), next: () => go(1), cls: 'saved-bar shot-bar',
    buttons: [iconBtn('Save over this shot', '💾', saveOver), iconBtn('Save as a new shot', '＋', saveNew),
      iconBtn('Open this shot in a new tab', '⧉', () => { const x = loaded(); if (!x) return toast('No saved shot loaded'); hooks.openShot?.(x.p, x.name); }),
      iconBtn('Delete this saved shot', '🗑', del), iconBtn('Back to the template defaults', '↺', defaults)],
    pos: h('span', { class: 'snip-pos' }, !l.length ? 'No saved shots · ＋ saves everything here'
      : i < 0 ? `${l.length} saved · none loaded` : `${i + 1}/${l.length} · ${l[i].name}`) });
}

// ---------------------------------------------------------------------------
// saved settings per group (Seed, Sampler, LoRAs, Turbo LoRA…): ◀ ▶ cycle, 💾 save over, ＋ save new.
// The first entry is always the template's own default. A save is for this workflow, this model,
// or everywhere; model/everywhere entries match settings by node type + input (KSampler steps,
// LoRA stack…) so they also work in other templates. Stored with the prompt snippets.
// ---------------------------------------------------------------------------
const PRESET_CATEGORY = 'Saved settings';
const PRESET_KINDS = new Set(['int', 'float', 'choice', 'bool', 'seed', 'loras']);
const SCOPES = [['workflow', 'This workflow'], ['model', 'This model'], ['global', 'Everywhere']];

function fieldClass(f) { return (S.tpl.groups.find((g) => g.node === f.node) || {}).class || f.node; }
function semKey(f) { return f.kind === 'loras' ? `${fieldClass(f)}.__loras.${/turbo/i.test(f.group) ? 'turbo' : 'stack'}` : `${fieldClass(f)}.${f.input}`; }
function currentModel() {
  const mf = S.tpl.fields.find((x) => MODEL_INPUTS.includes(x.input));
  return mf ? S.values[mf.key] : null;
}
const keyFor = (f, scope) => (scope === 'workflow' ? f.key : semKey(f));

function captureGroup(fs, scope, group) {
  const values = {}, modes = {};
  for (const f of fs) {
    const k = keyFor(f, scope);
    values[k] = S.values[f.key];
    if (f.kind === 'seed') modes[k] = S.seedMode[f.key] || 'random';
    if (f.input === 'width' && S.sizeMode[f.key]) modes[`${k}#size`] = S.sizeMode[f.key];
  }
  return { scope, workflow: S.tpl.id, group, model: currentModel(), values, modes };
}

function groupEntryApplies(p, fs, group) {
  if (p.scope === 'workflow') return p.workflow === S.tpl.id && p.group === group;
  if (p.scope === 'model' && (!p.model || p.model !== currentModel())) return false;
  return fs.some((f) => semKey(f) in p.values);
}

function applyGroupEntry(p, fs) {
  for (const f of fs) {
    const k = keyFor(f, p.scope);
    if (!(k in p.values)) continue;
    const v = p.values[k];
    if (f.kind === 'choice' && f.options.length && !f.options.includes(v)) continue;  // model or option gone
    S.values[f.key] = v;
    if (p.modes[k]) S.seedMode[f.key] = p.modes[k];
    if (p.modes[`${k}#size`]) S.sizeMode[f.key] = p.modes[`${k}#size`];
  }
}

function groupPresetBar(g, fs) {
  fs = fs.filter((f) => PRESET_KINDS.has(f.kind));
  if (!fs.length) return null;
  const scopeName = (sc) => (SCOPES.find(([k]) => k === sc) || [, sc])[1].toLowerCase();
  const order = ['workflow', 'model', 'global'];
  const entries = () => [{ id: '', name: 'Template default' }, ...savedEntries(PRESET_CATEGORY, (p) => groupEntryApplies(p, fs, g.label))
    .sort((a, b) => order.indexOf(a.p.scope) - order.indexOf(b.p.scope) || a.created - b.created)];
  const curKey = `deck.saved.${S.tpl.id}.${g.label}`;
  const curId = () => String(store.get(curKey, ''));
  const loaded = () => entries().find((y) => String(y.id) === curId());
  const pos = h('span', { class: 'snip-pos' });
  const show = () => {
    const l = entries(), i = Math.max(0, l.findIndex((x) => String(x.id) === curId()));
    pos.textContent = `${i + 1}/${l.length} · ${l[i].name}${l[i].p ? ` · ${scopeName(l[i].p.scope)}` : ''}`;
  };
  const go = (d) => {
    const l = entries(), x = l[cycleIndex(Math.max(0, l.findIndex((y) => String(y.id) === curId())), d, l.length)];
    store.set(curKey, String(x.id));
    if (x.p) applyGroupEntry(x.p, fs);
    else for (const f of fs) { S.values[f.key] = f.value; delete S.seedMode[f.key]; delete S.sizeMode[f.key]; }
    persist(); renderFields();
  };
  const saveOver = async () => {
    const x = loaded();
    if (!x || !x.p) return saveNew();
    try {
      await saveSnippet({ id: x.id, category: PRESET_CATEGORY, name: x.name, text: JSON.stringify(captureGroup(fs, x.p.scope, g.label)) });
      show(); toast(`Saved over "${x.name}"`);
    } catch (e) { toast(e.message, true); }
  };
  const saveNew = () => {
    let scope = 'workflow';
    nameSheet({ title: `Save ${g.label}`, placeholder: `Name, e.g. "${g.label} – fast"`, hint: `Saves: ${fs.map((f) => f.label).join(', ')}.`,
      extra: [seg(SCOPES, scope, (k) => { scope = k; }),
        help(`This workflow: ${S.tpl.name}. This model: ${currentModel() || '(no model setting here)'}. Everywhere: any template with the same kind of node.`)],
      save: async (name) => {
        if (scope === 'model' && !currentModel()) throw new Error('This template has no model setting');
        const r = await saveSnippet({ category: PRESET_CATEGORY, name: name || g.label, text: JSON.stringify(captureGroup(fs, scope, g.label)) });
        store.set(curKey, String(r.id));
        renderFields(); toast(`Saved "${r.name}"`);
      } });
  };
  const del = async () => {
    const x = loaded();
    if (!x || !x.p) return toast('The template default can\'t be deleted');
    store.set(curKey, '');
    try { await deleteSnippet(x, `Deleted "${x.name}"`, renderFields); }
    catch (e) { toast(e.message, true); }
  };
  show();
  return cycleBar({ title: 'Presets', what: `saved ${g.label}`, prev: () => go(-1), next: () => go(1), cls: 'saved-bar', pos,
    buttons: [iconBtn(`Save over this ${g.label}`, '💾', saveOver), iconBtn(`Save ${g.label} as new`, '＋', saveNew),
      iconBtn(`Delete this saved ${g.label}`, '🗑', del)] });
}

// A width + height pair on one node renders as a single size picker; everything else as usual.
function groupFieldEls(fs) {
  const out = [];
  for (const f of fs) {
    if (f.kind === 'int' && f.input === 'width') {
      const fh = fs.find((x) => x.node === f.node && x.input === 'height' && x.kind === 'int');
      if (fh) { const el = sizeField(f, fh); el.dataset.key = f.key; out.push(el); continue; }
    }
    if (f.kind === 'int' && f.input === 'height' && fs.some((x) => x.node === f.node && x.input === 'width' && x.kind === 'int')) continue;
    if (f.kind === 'mask') continue;   // drawn inside its picture's field
    out.push(fieldEl(f));
  }
  return out;
}

// Natural size of an input image, for "Match image" (cached; null until loaded)
const imgDims = new Map();
function inputDims(name, onLoad) {
  if (imgDims.has(name)) return imgDims.get(name);
  imgDims.set(name, null);
  const img = new Image();
  img.onload = () => { imgDims.set(name, [img.naturalWidth, img.naturalHeight]); onLoad(); };
  img.src = inputUrl(name);
  return null;
}

const MP_STEPS = [0.25, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 4];
function sizeField(fw, fh) {
  const step = Math.max(fw.step || 8, fh.step || 8, 16);  // 16 suits every latent; resize nodes allow 1
  const lim = (n, f) => Math.min(f.max ?? Infinity, Math.max(f.min ?? step, n));
  // "Match image": the shape of the template's first image (as cropped), at the chosen megapixels
  const imgField = (S.tpl?.fields || []).find((x) => x.kind === 'image' && (!fw.image_node || x.node === fw.image_node));
  const imageAspect = () => {
    const name = imgField && S.values[imgField.key];
    const d = name && inputDims(name, () => { if (m.aspect === 'image') { applyPreset(); draw(); } });
    if (!d) return null;
    const c = S.imageCrop[imgField.key]?.src === name ? S.imageCrop[imgField.key].crop : FULL;
    return (d[0] * c.w) / (d[1] * c.h);
  };
  let m = S.sizeMode[fw.key];
  if (!m && fw.match_image && imgField) m = S.sizeMode[fw.key] = { aspect: 'image', mp: 1 };
  if (!m) {  // derive from the current numbers: nearest preset (within 3%), else custom
    const w = Number(S.values[fw.key]), hh = Number(S.values[fh.key]);
    const near = ASPECT_PRESETS.find(([, a]) => Math.abs(w / hh / a - 1) < 0.03);
    m = { aspect: near ? near[0] : 'custom', mp: Math.round((w * hh) / 1e4) / 100 };
    S.sizeMode[fw.key] = m;
  }
  const readout = h('span', {});
  const custom = h('div', { class: 'size-custom' }, numberField(fw, false), numberField(fh, false));
  const showReadout = () => {
    const w = S.values[fw.key], hh = S.values[fh.key];
    readout.textContent = m.aspect === 'image' && !imageAspect() ? 'matches the image once one is set'
      : `${w}×${hh} · ${((w * hh) / 1e6).toFixed(2)} MP`;
  };
  const applyPreset = () => {
    const a = m.aspect === 'image' ? imageAspect() : (ASPECT_PRESETS.find(([k]) => k === m.aspect) || [])[1];
    if (!a) return;
    const px = m.mp * 1e6;
    const w = lim(Math.round(Math.sqrt(px * a) / step) * step, fw);
    const hh = lim(Math.round(Math.sqrt(px / a) / step) * step, fh);
    S.values[fw.key] = w; S.values[fh.key] = hh;
    custom.querySelectorAll('input[type=number]').forEach((inp, i) => { inp.value = i ? hh : w; });
    persist(); showReadout();
  };
  const aspects = [...(imgField ? [['image', 'Match image']] : []), ...ASPECT_PRESETS.map(([k]) => [k, k]), ['custom', 'Custom']];
  const aspectSeg = seg(aspects, m.aspect, (id) => { m.aspect = id; applyPreset(); persist(); draw(); }, { wrap: true });
  const draw = () => {
    aspectSeg.set(m.aspect);
    const isCustom = m.aspect === 'custom';
    custom.classList.toggle('hidden', !isCustom);
    mpRow.classList.toggle('hidden', isCustom);
    showReadout();
  };
  // megapixels: tapped, not typed (Custom types the sides themselves)
  const setMp = (n) => { m.mp = Math.min(16, Math.max(0.05, Math.round(n * 100) / 100)); applyPreset(); };
  const mpRow = field(['Megapixels', h('span', {}, `sides snap to ${step}`)],
    seg(MP_STEPS.map((v) => [v, `${v}`]), m.mp, setMp, { wrap: true }));
  // custom width/height edits go through numberField's own setVal; keep the readout in step
  custom.addEventListener('change', () => setTimeout(showReadout));
  custom.addEventListener('click', () => setTimeout(showReadout));
  if (m.aspect === 'image') applyPreset();   // the image (or its crop) may have changed since
  draw();
  const el = field(['Size', readout], aspectSeg, mpRow, custom);
  el.classList.add('size-field');
  return el;
}

// − [box] +; bump(±1) steps the value
const stepper = (input, bump, what = '') => h('div', { class: 'stepper' },
  h('button', { type: 'button', onclick: () => bump(-1), 'aria-label': `Less ${what}`.trim() }, '−'), input,
  h('button', { type: 'button', onclick: () => bump(1), 'aria-label': `More ${what}`.trim() }, '+'));

// ComfyUI's own limits are often far past anything useful (steps to 10000, cfg to 100): number fields
// keep to these, matched on the input name or the label, inside ComfyUI's limits
const REALISTIC = [[/^steps$/, 1, 100], [/^cfg$/, 0, 20], [/denoise/, 0, 1], [/_percent$/, 0, 1], [/strength/, 0, 2],
  [/^(width|height)$/, 64, 4096], [/^shift$/, 0, 20], [/^(fps|frame_rate|force_rate)$/, 0, 60], [/^batch_size$/, 1, 16],
  [/megapixel/i, 0.05, 16], [/second/i, 1, 20], [/^(length|frames?|num_frames)$/, 1, 481], [/^crf$/, 0, 51],
  [/per_row|columns|^rows$/, 1, 16], [/spacing|gap|padding|margin|border/, 0, 256], [/^ref_boost/, 0, 10]];
function fieldRange(f) {
  const r = REALISTIC.find(([re]) => re.test(f.input) || re.test(f.label || ''));
  let min = f.min, max = f.max;
  if (r) { min = Math.max(min ?? -Infinity, r[1]); max = Math.min(max ?? Infinity, r[2]); }
  if (min > max) [min, max] = [f.min, f.max];  // the template's own range wins over a bad guess
  if (!Number.isFinite(max)) {  // nothing known: room above the current value, so it can still be dragged
    const v = Math.abs(Number(f.value) || 0);
    max = Math.max(f.kind === 'float' ? 10 : 1000, v * 4);
    if (!Number.isFinite(min)) min = 0;
  }
  return [Number.isFinite(min) ? min : null, Number.isFinite(max) ? max : null];
}

// tapped presets for some numbers: how much of the picture is made again; how hard a Krea edit follows its picture
const PRESETS = { denoise: [0.6, 0.8, 0.9, 1.0], ref_boost: [1, 2, 3, 4, 6], ref_boost_a: [1, 2, 3, 4, 6] };
function numberField(f, isFloat) {
  const step = f.step || (isFloat ? 0.01 : 1);
  const dec = isFloat ? Math.max(0, (String(step).split('.')[1] || '').length) : 0;
  const [lo, hi] = fieldRange(f);
  const clamp = (n) => {
    if (Number.isNaN(n)) n = Number(f.value) || 0;
    if (lo != null) n = Math.max(lo, n);
    if (hi != null) n = Math.min(hi, n);
    return isFloat ? Number(n.toFixed(Math.min(dec, 6))) : Math.round(n);
  };
  const hasRange = lo != null && hi != null && (hi - lo) / step <= 4000 && (hi - lo) <= 10000;
  // with a known range the box is a slider (a bar behind the number); without one it still scrubs
  const input = hasRange ? numSlider({ min: lo, max: hi, step, value: S.values[f.key], digits: dec, label: f.label })
    : h('input', { type: 'number', inputMode: isFloat ? 'decimal' : 'numeric', step, min: lo ?? undefined, max: hi ?? undefined, value: S.values[f.key] });
  // some numbers also have tapped presets (PRESETS)
  const taps = isFloat && PRESETS[f.input];
  const presets = taps
    ? chips(taps.map((x) => [x, f.input === 'denoise' ? x.toFixed(1) : String(x)]), Number(S.values[f.key]), (x) => sync(Number(x), null), { cls: 'denoise-presets' }) : null;
  const sync = (n, from) => {
    n = clamp(n); setVal(f.key, n);
    if (from !== input) input.set ? input.set(n) : (input.value = n);
    presets?.set(n);
  };
  input.addEventListener('change', () => sync(parseFloat(input.value), input));
  input.addEventListener('input', () => { if (input.dataset.scrubbing) sync(parseFloat(input.value), input); });
  const bump = (dir) => sync(Number(S.values[f.key]) + dir * step, null);
  return field([f.label, hasRange ? h('span', {}, `${lo}–${hi}`) : null], stepper(input, bump), presets);
}

function seedField(f) {
  const el = uiSeedField(f.label, { get: () => S.values[f.key], set: (v) => setVal(f.key, v),
    mode: () => S.seedMode[f.key] || 'random', setMode: (m) => { S.seedMode[f.key] = m; persist(); }, last: () => S.lastSeed[f.key] ?? null });
  el.dataset.key = f.key;
  return el;
}

function choiceField(f) {
  const opts = [...f.options];
  const cur = S.values[f.key];
  if (cur != null && !opts.includes(cur)) opts.unshift(cur);
  const sel = h('select', {}, opts.map((o) => h('option', { value: o }, f.options.includes(o) ? o : `${o} (missing)`)));
  sel.value = cur;
  sel.addEventListener('change', () => {
    setVal(f.key, sel.value);
    if (MODEL_INPUTS.includes(f.input)) renderFields();  // LoRA lists follow the model (folder filter)
  });
  let filter = null;
  if (opts.length > 15) {
    filter = h('input', { type: 'text', placeholder: `Filter ${opts.length} options…` });
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const o of sel.options) o.hidden = q && !o.value.toLowerCase().includes(q);
    });
  }
  return field(f.label, filter, sel);
}

function textField(f) {
  if (isMainPrompt(f)) return promptField(f);
  return field(f.label, textArea(() => S.values[f.key], (v) => setVal(f.key, v), { rows: f.multiline ? 4 : 1, grow: !!f.multiline }));
}

// ---------------------------------------------------------------------------
// prompt builder: the main prompt as separate parts (subject, camera, style…). Each part has saved
// snippets, shared across templates and devices, to cycle through. Tag chips insert the model's
// reference tags (<Picture 1>, <ref_image_0>…) where the cursor is.
// ---------------------------------------------------------------------------
const PARTS = {
  video: ['Subject', 'Action', 'Camera', 'Style', 'Lighting', 'Sound', 'Other'],
  image: ['Subject', 'Setting', 'Style', 'Lighting', 'Camera', 'Other'],
};

// the key of a template's main prompt: its first multiline text that isn't a negative prompt
export function mainPromptKey(t) {
  return (t?.fields || []).find((x) => x.kind === 'text' && x.multiline && !/negative/i.test(x.input + ' ' + x.group))?.key;
}
function isMainPrompt(f) {
  if (f.kind !== 'text' || !f.multiline || /negative/i.test(f.input + ' ' + f.group)) return false;
  return mainPromptKey(S.tpl) === f.key;
}

// Reference tags for this model, numbered from what the template has (image slots, boxes).
function promptTags() {
  const fs = S.tpl?.fields || [];
  const images = Math.max(1, fs.filter((x) => x.kind === 'image').length);
  const boxes = Math.max(1, ...fs.filter((x) => x.kind === 'boxes').map((x) => (S.values[x.key] || []).length));
  const n = (k, from = 1) => Array.from({ length: k }, (_, i) => i + from);
  switch (S.tpl?.tag_style) {
    case 'h3': return [...n(images).map((i) => `<Picture ${i}>`), ...n(3).map(subjectTag)];
    case 'klein': return [...n(images, 0).map((i) => `<ref_image_${i}>`), ...n(boxes).map((i) => `<obj_${i}>`)];
    case 'qwen': return n(images).map((i) => `Picture ${i}`);
    case 'krea': return n(images).map(kreaTag);
    case 'moss': return n(images).map((i) => `image ${i}`);
    default: return [];
  }
}

// The reference tag a subject can point at, in this model's own syntax (null: model has none).
function pictureTag(n) {
  switch (S.tpl?.tag_style) {
    case 'h3': return `<Picture ${n}>`;
    case 'klein': return `<ref_image_${n - 1}>`;
    case 'qwen': return `Picture ${n}`;
    case 'krea': return kreaTag(n);
    case 'moss': return `image ${n}`;
    default: return null;
  }
}

// How a prompt names subject N. MiniMax H3's reference guide labels them <Subject N> and defines each
// once ("<Subject 1> is the young woman in <Picture 1>, …"); other models get a plain "Subject N".
const subjectTag = (i) => (S.tpl?.tag_style === 'h3' ? `<Subject ${i}>` : `Subject ${i}`);

// Labels are added here, so saved characters stay label-free and fit any slot.
const stripSubjectLabel = (t) => String(t || '').replace(/^\s*<?subject\s*\d+>?\s*(?:[:.\-–]|is\b)\s*/i, '');

function subjectLines(subjects) {
  return subjects.map((x, i) => {
    const text = stripSubjectLabel(x.text).trim().replace(/[.\s]+$/, '');
    if (!text) return '';
    const tag = x.pic ? pictureTag(x.pic) : null;
    if (S.tpl?.tag_style === 'h3') {   // "<Subject 1> is a woman in a red coat, as shown in <Picture 1>."
      const desc = /^[A-Z][a-z\s]/.test(text) && !/^I\b/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
      const pic = tag && !text.includes(tag) ? `, as shown in ${tag}` : '';
      return `${subjectTag(i + 1)} is ${desc}${pic}.`;
    }
    return `Subject ${i + 1}: ${text}${tag ? ` (as in ${tag})` : ''}.`;
  }).filter(Boolean);
}

function composePrompt(st, order) {
  return order.flatMap((p) => p === 'Subject' ? subjectLines(st.subjects || []) : [(st.parts[p] || '').trim()])
    .filter(Boolean).join('\n');
}

// One text box with saved-snippet controls: ◀ ▶ cycle the library for `cat`, 💾 save, 🗑 delete.
// get/set read and write the box's text; `extra` adds buttons after the library controls.
function snippetEditor({ cat, label, get, set, placeholder, extra = [], below = null, clean = (t) => t, grow = true }) {
  const ta = textArea(get, (v) => { set(v); showPos(); }, { rows: 3, placeholder, grow, max: 260 });
  const pos = h('span', { class: 'snip-pos' });
  const lib = () => (S.snippets || []).filter((x) => x.category === cat);
  const idx = () => lib().findIndex((x) => x.text.trim() === clean(get()).trim());
  const what = cat.toLowerCase();
  const del = iconBtn(`Delete this saved ${what}`, '🗑', async () => {
    const sn = lib()[idx()];
    if (!sn) return;
    try { await deleteSnippet(sn, `Deleted "${sn.name}" from saved`, showPos); }
    catch (e) { toast(e.message, true); }
  });
  const showPos = () => {
    const l = lib(), i = idx();
    pos.textContent = l.length ? (i >= 0 ? `${i + 1}/${l.length} · ${l[i].name}` : `${l.length} saved`) : 'none saved';
    del.classList.toggle('invisible', i < 0);  // keep its space so the header never re-wraps
  };
  const put = (text) => { ta.value = text; set(text); showPos(); ta.dispatchEvent(new Event('grow')); };
  const step = (d) => {
    const l = lib();
    if (!l.length) return toast(`Nothing saved under ${cat} yet. Write one and tap 💾.`);
    put(l[cycleIndex(idx(), d, l.length)].text);
  };
  const save = async () => {
    const text = clean(get()).trim();
    if (!text) return toast('Nothing to save', true);
    if (idx() >= 0) return toast('Already saved');
    try { await saveSnippet({ category: cat, text }); showPos(); toast(`Saved to ${cat}`); }
    catch (e) { toast(e.message, true); }
  };
  showPos();
  const el = h('div', { class: 'prompt-part' },
    cycleBar({ title: label, what: `saved ${what}`, prev: () => step(-1), next: () => step(1), pos,
      buttons: [iconBtn(`Save this ${what}`, '💾', save), del, ...extra] }),
    ta, below);
  return { el, ta };
}

// One builder for every template (stored on this device), so subjects and parts follow you when you
// switch workflow. Whole builders can be saved as named "prompt sets" on the server.
export function builderState() {
  if (!S.pb) {
    S.pb = store.get('deck.builder', null);
    if (!S.pb) {  // carry over what an older version kept per template
      const old = Object.values((S.tpl && store.get(stateKey(S.tpl.id), {}).builder) || {})[0];
      S.pb = old ? { on: !!old.on, parts: old.parts || {}, subjects: old.subjects } : { on: false, parts: {} };
    }
    if (!S.pb.subjects) {
      S.pb.subjects = [{ text: stripSubjectLabel(S.pb.parts.Subject || ''), pic: null }];
      delete S.pb.parts.Subject;
    }
  }
  return S.pb;
}
export const saveBuilder = () => { store.set('deck.builder', S.pb); hooks.edited?.(); };
const SET_CATEGORY = 'Prompt set';

function promptField(f) {
  const order = PARTS[S.tpl?.tag_style === 'h3' ? 'video' : 'image'];
  const st = builderState();
  const images = Math.max(1, (S.tpl?.fields || []).filter((x) => x.kind === 'image').length);
  const body = h('div', { class: 'prompt-body' });
  const final = h('div', { class: 'hint final-prompt' });

  // tag chips float over whichever box has the cursor
  let lastTA = null;
  const chipsRow = h('div', { class: 'chips tag-chips' });   // (rebuilt as the tags change: plain chips, not a choice)
  const drawChips = () => {
    const tags = promptTags().filter((t) => !/^<?Subject \d+>?$/.test(t));
    const n = st.on ? Math.max(1, st.subjects.length) : (S.tpl?.tag_style === 'h3' ? 3 : 0);
    for (let i = 1; i <= n; i++) tags.push(subjectTag(i));
    chipsRow.replaceChildren(...tags.map((t) => chip(t, () => { if (lastTA) insertAtCursor(lastTA, t); else toast('Tap into a text box first'); }, { keepFocus: true })));
    chipsRow.classList.toggle('hidden', !tags.length);
  };
  const track = (ta) => {
    ta.addEventListener('focus', () => { lastTA = ta; ta.parentElement.insertBefore(chipsRow, ta); });
    return ta;
  };
  const fixed = (ta) => { ta.classList.add('fixed-ta'); return track(ta); };

  const sync = () => {
    if (!st.on) return;
    setVal(f.key, composePrompt(st, order));
    final.textContent = S.values[f.key] || '(empty)';
    saveBuilder();
  };
  // redraw without the panel jumping
  const redraw = () => { const p = $('.panel'), y = p ? p.scrollTop : 0; draw(); if (p) p.scrollTop = y; };

  const subjectEl = (x, i) => {
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= st.subjects.length) return;
      [st.subjects[i], st.subjects[j]] = [st.subjects[j], st.subjects[i]]; saveBuilder(); redraw();
    };
    const pics = pictureTag(1) ? h('select', { class: 'subject-pic', 'aria-label': `Reference picture for subject ${i + 1}` },
      h('option', { value: '' }, 'No reference picture'),
      Array.from({ length: images }, (_, k) => h('option', { value: k + 1 }, `Looks like ${pictureTag(k + 1)}`))) : null;
    if (pics) {
      pics.value = x.pic || '';
      pics.addEventListener('change', () => { x.pic = pics.value ? Number(pics.value) : null; sync(); });
    }
    const { el, ta } = snippetEditor({
      cat: 'Subject', label: `Subject ${i + 1}`, placeholder: i ? 'Another character or object…' : PART_HINTS.Subject,
      get: () => x.text || '', set: (t) => { x.text = t; sync(); }, clean: stripSubjectLabel, below: pics, grow: false,
      extra: [
        iconBtn('Move subject up', '↑', () => move(-1)),
        iconBtn('Move subject down', '↓', () => move(1)),
        iconBtn('Remove subject', '✕', () => {
          if (st.subjects.length > 1) st.subjects.splice(i, 1); else st.subjects[0] = { text: '', pic: null };
          sync(); redraw();
        })],
    });
    fixed(ta);
    return el;
  };

  const partEl = (cat) => {
    const { el, ta } = snippetEditor({
      cat, label: cat, placeholder: PART_HINTS[cat] || '', grow: false,
      get: () => st.parts[cat] || '', set: (t) => { st.parts[cat] = t; sync(); },
      extra: [iconBtn(`Clear ${cat.toLowerCase()}`, '✕', () => { ta.value = ''; ta.dispatchEvent(new Event('input')); })],
    });
    fixed(ta);
    return el;
  };

  // whole-builder prompt sets: ◀ ▶ load, 💾 save under a name, 🗑 delete
  const setsBar = () => {
    const sets = () => (S.snippets || []).filter((x) => x.category === SET_CATEGORY);
    const snapshot = () => JSON.stringify({ parts: st.parts, subjects: st.subjects });
    const cur = () => sets().findIndex((x) => x.text === snapshot());
    const label = h('span', { class: 'snip-pos' });
    const name = h('input', { type: 'text', placeholder: 'Name this prompt set…', class: 'set-name' });
    const show = () => {
      const l = sets(), i = cur();
      label.textContent = l.length ? (i >= 0 ? `${i + 1}/${l.length} · ${l[i].name}` : `${l.length} saved sets`) : 'no saved sets';
    };
    const load = (d) => {
      const l = sets();
      if (!l.length) return toast('No saved prompt sets yet. Name this one and tap 💾.');
      const j = cycleIndex(cur(), d, l.length);
      try {
        const v = JSON.parse(l[j].text);
        st.parts = v.parts || {}; st.subjects = v.subjects?.length ? v.subjects : [{ text: '', pic: null }];
      } catch { return toast('That saved set is damaged', true); }
      sync(); redraw(); toast(`Loaded "${l[j].name}"`);
    };
    const save = async () => {
      if (cur() >= 0) return toast('Already saved');
      const n = name.value.trim() || stripSubjectLabel(st.subjects[0]?.text || '').split(/\s+/).slice(0, 5).join(' ') || 'Prompt set';
      try { await saveSnippet({ category: SET_CATEGORY, name: n, text: snapshot() }); name.value = ''; show(); toast(`Saved set "${n}"`); }
      catch (e) { toast(e.message, true); }
    };
    const del = async () => {
      const sn = sets()[cur()];
      if (!sn) return toast('Load a saved set first');
      try { await deleteSnippet(sn, `Deleted set "${sn.name}"`, show); }
      catch (e) { toast(e.message, true); }
    };
    show();
    return h('div', { class: 'prompt-part sets-bar' },
      cycleBar({ title: 'Prompt set', what: 'prompt set', prev: () => load(-1), next: () => load(1), pos: label,
        buttons: [iconBtn('Delete this prompt set', '🗑', del)] }),
      h('div', { class: 'row' }, name, button('💾 Save set', save, { cls: 'small fixed' })));
  };

  const draw = () => {
    if (st.on) {
      body.replaceChildren(setsBar(), ...order.flatMap((cat) => cat !== 'Subject' ? [partEl(cat)] : [
        h('div', { class: 'subjects' }, st.subjects.map(subjectEl),
          button('+ Add subject', () => { st.subjects.push({ text: '', pic: null }); saveBuilder(); redraw(); })),
      ]), h('details', { class: 'desc' }, h('summary', {}, 'Final prompt'), final));
      sync();
    } else {
      const ta = track(textArea(() => S.values[f.key], (v) => setVal(f.key, v), { rows: 4 }));
      body.replaceChildren(ta);
    }
    body.prepend(chipsRow);
    lastTA = null;
    mode.textContent = st.on ? 'Plain text' : 'Build from parts';
    drawChips();
  };
  const mode = button('', async () => {
    if (!st.on) {
      await loadSnippets();
      // first time: keep what's already written, in "Other"
      const empty = !Object.values(st.parts).some((v) => (v || '').trim()) && !st.subjects.some((x) => (x.text || '').trim());
      if (empty && (S.values[f.key] || '').trim()) st.parts.Other = S.values[f.key];
    }
    st.on = !st.on; saveBuilder(); redraw();
  });
  if (st.on) loadSnippets().then(draw); else draw();
  // the prompt helper (prompthelp.js): a version picked from the builder becomes the plain prompt (Undo brings it back)
  const io = { get: () => S.values[f.key] || '', target: tplTarget(),
    set: (v) => { if (st.on) { st.on = false; saveBuilder(); } setVal(f.key, v); redraw(); },
    snapshot: () => ({ on: st.on, v: S.values[f.key] || '' }),
    restore: (x) => { st.on = x.on; saveBuilder(); if (!x.on) setVal(f.key, x.v); redraw(); } };
  const aid = h('span', { class: 'pa-btns' + (io.target ? '' : ' hidden') },
    iconBtn('Improve this prompt', '✦', () => openImprove(io)),
    iconBtn('Describe a picture', '👁', () => openDescribe(io)));
  const el = field([f.label, h('span', { class: 'pa-head' }, aid, mode)], body);
  el.classList.add('prompt-field');
  return el;
}

const PART_HINTS = {
  Subject: 'Who or what: a woman in her 30s, short red hair, green raincoat…',
  Action: 'What happens, in order: she turns to the camera and laughs…',
  Camera: 'Shot and movement: slow dolly-in, 35mm, shallow depth of field…',
  Style: 'Look: 1990s camcorder, film grain, muted colours…',
  Lighting: 'Light: golden hour, soft rim light…',
  Sound: 'Audio: rain on the window, distant traffic, she says "…"',
  Setting: 'Where: a rainy neon street at night…',
  Other: 'Anything else',
};

function boolField(f) {
  const el = toggle(f.label, S.values[f.key], (on) => setVal(f.key, on));
  el.classList.add('field');   // (gentabs marks overridden fields by .field[data-key])
  return el;
}

export function mpInput(get, set) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min: 0, max: 16, step: 0.05, value: get() });
  input.addEventListener('change', () => {
    const n = clamp(parseFloat(input.value) || 0, 0, 16);
    input.value = n; set(n);
  });
  return h('label', { class: 'mp' }, h('span', {}, 'Max MP'), input, info('0 = keep size'));
}

// the whole image greyed out, with the cropped part in colour on top
function cropPreview(src, c) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  return h('span', { class: 'crop-preview' },
    h('img', { class: 'under', src, alt: '' }),
    h('img', { class: 'kept', src, alt: '', style: `clip-path:inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})` }));
}

function imageField(f) {
  const v = S.values[f.key];
  if (S.imageMp[f.key] == null) S.imageMp[f.key] = f.mp ?? 1;
  const pick = () => openImagePicker({
    title: `${f.group} · ${f.label}`, mp: () => S.imageMp[f.key],
    onPick: (name, info) => {
      setVal(f.key, name);
      renderFields();
      if (info && info.width) toast(`Set ${f.label} (${info.width}×${info.height})`);
    },
  });
  // A crop is only a setting: the field keeps the original image, the thumb shows it with the
  // cut-off parts greyed out, and generate() sends a cropped copy (see cropForRun).
  const old = S.imageCrop[f.key];
  if (old && old.out && old.out === v) { setVal(f.key, old.src); delete old.out; return imageField(f); }  // saved by an older version
  const cropped = v && old && old.src === v ? old : null;
  if (!cropped) delete S.imageCrop[f.key];
  const crop = async () => {
    const img = new Image();
    img.src = inputUrl(v);
    openCrop({ img, crop: cropped ? cropped.crop : FULL, onApply: (c) => {   // (it opens at once and shows the picture loading)
      if (c.w > 0.999 && c.h > 0.999) delete S.imageCrop[f.key];
      else S.imageCrop[f.key] = { src: v, crop: c };
      if (mf && S.values[mf.key]?.name && !maskFits(S.values[mf.key], v, S.imageCrop[f.key]?.crop)) toast('The mask was cleared: it was painted on the old crop');
      persist(); renderFields();
    } });
  };
  const set = (name) => { setVal(f.key, name); renderFields(); };
  // a mask painted over this picture (its own pseudo field): it goes when the picture or its crop changes
  const mf = maskFieldOf(f);
  const mask = mf ? S.values[mf.key] : null;
  if (mask?.name && !maskFits(mask, v, cropped?.crop)) S.values[mf.key] = { ...mask, name: null, box: null, src: null, crop: null };
  const el = imageInput({ label: f.label, name: v ? String(v).split('/').pop() + (cropped ? ' · cropped' : '') : '',
    thumb: cropped ? cropPreview(thumbUrl(cropped.src, 256), cropped.crop) : v ? h('img', { src: thumbUrl(v, 256), alt: v }) : null,
    pick, onClear: () => set(''), buttons: [
      v ? button('Crop…', crop) : null,
      // an inpaint template runs on the mask alone: its painter is the main action until there is one
      v && mf ? (mf.required && !mask?.name
        ? button([icon('brush'), 'Paint area…'], () => paintMask(f, mf, v, cropped?.crop || null), { cls: 'small primary', 'data-paint': '1' })
        : button('Mask…', () => paintMask(f, mf, v, cropped?.crop || null))) : null,
      button(v ? 'Draw on' : 'Draw', () => openSketch({ base: v || null, aspect: templateAspect(), onDone: set }))],
    below: [mpInput(() => S.imageMp[f.key], (n) => { S.imageMp[f.key] = n; persist(); }),
      v && mf && S.values[mf.key]?.name ? maskSettings(f, mf, v, cropped?.crop || null) : null] });
  el.dataset.key = f.key;
  return el;
}

// ---- masks: paint where the edit may change the picture (web/maskpaint.js); the server puts every result back
// onto the picture through it (app/maskcomp.py). The value: { name, src, crop, box, feather, grow, fit }. ----
const FEATHERS = [[0, 'Hard'], [4, '4 px'], [8, '8 px'], [16, '16 px'], [32, '32 px'], [64, '64 px']];
const GROWS = [[0, 'None'], [4, '4 px'], [8, '8 px'], [16, '16 px'], [32, '32 px']];
const MASK_DEFAULT = { feather: 8, grow: 0, fit: false };
// inpainting a small area at the model's full size is the point: Crop to mask starts on there
const maskDefault = (mf) => (mf.required && mf.fit ? { ...MASK_DEFAULT, fit: true } : MASK_DEFAULT);
// an inpaint template's mask not painted yet (generate() stops on it)
const needsMask = () => (S.tpl?.fields || []).find((x) => x.kind === 'mask' && x.required && !S.values[x.key]?.name) || null;
const maskFieldOf = (f) => (S.tpl?.fields || []).find((x) => x.kind === 'mask' && x.image_key === f.key) || null;
const sameCrop = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
const maskFits = (m, v, crop) => !!v && m.src === v && sameCrop(m.crop, crop);

function paintMask(f, mf, v, crop) {
  const m = S.values[mf.key];
  openMaskPainter({ picture: v, crop, mask: m?.name || null, onDone: async (blob, box) => {
    const keep = { ...maskDefault(mf), ...(m || {}) };
    if (!blob) {
      if (m?.name) toast('Nothing painted: the mask is off');
      setVal(mf.key, { ...keep, name: null, box: null, src: null, crop: null }); renderFields();
      return;
    }
    const r = await fetch('/api/inputs/mask', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    setVal(mf.key, { ...keep, name: (await r.json()).name, src: v, crop, box });
    renderFields();
  } });
}

function maskSettings(f, mf, v, crop) {
  const m = { ...maskDefault(mf), ...S.values[mf.key] };
  const put = (o) => { setVal(mf.key, { ...m, ...o }); renderFields(); };
  const remove = () => {
    const was = S.values[mf.key];
    put({ name: null, box: null, src: null, crop: null });
    undoToast('Mask removed', () => { setVal(mf.key, was); renderFields(); });
  };
  const num = (x) => Number(x);
  const what = mf.required
    ? 'The painted part is made again from the prompt (Denoise 1.0 starts it from scratch; lower keeps more of the shapes and colours that were there). Every result is put back onto this picture through the mask, so the rest stays exactly as it was. Paint a little past the edges of what should change.'
    : mf.composite
    ? 'Only the painted part can change: every result is put back onto this picture through the mask, so the rest stays exactly as it was. If the result\'s shape differs from the picture, the picture is cropped from the middle to fit it first.'
    : 'The template takes the mask as its own mask input.';
  return h('div', { class: 'mask-set' },
    field('Mask', help(`${what} Tap the mask to paint more or less. Edge softness blends the border; Grow widens the painted part first.${mf.fit ? ' Crop to mask runs the edit on a box around the mask at the chosen size, then puts it back: more detail for a small area (the rest of the picture is not seen by the model).' : ''}`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'mask-thumb', title: 'Edit the mask', 'aria-label': 'Edit the mask', onclick: () => paintMask(f, mf, v, crop) },
          h('img', { src: thumbUrl(m.name, 128), alt: '' })),
        button('Edit…', () => paintMask(f, mf, v, crop)),
        iconBtn('Remove the mask', icon('trash'), remove))),
    mf.composite ? field('Edge softness', chips(FEATHERS, m.feather, (x) => put({ feather: num(x) }))) : null,
    mf.composite ? field('Grow', chips(GROWS, m.grow, (x) => put({ grow: num(x) }))) : null,
    mf.fit ? toggle('Crop to mask', m.fit, (on) => put({ fit: on })) : null);
}

// A video input (VHS_LoadVideoPath): the value is the clip's source, {generation, index} for an
// output or {media} for a file uploaded in the Video tab; the server turns it into the file's path.
// Trim and crop live in the value ({generation|media, trim, crop}), so tabs, shots and Run again
// keep them; the server applies them (loader inputs or an ffmpeg copy, see app/videoprep.py).
function videoField(f) {
  const v = S.values[f.key];
  const set = (val) => { setVal(f.key, val); renderFields(); };
  const el = clipInput({ label: f.label, value: v, url: clipUrl(v), name: clipLabel(v), onChange: set, onEdit: (val) => setVal(f.key, val),
    pick: () => openVideoPicker({ title: `${f.group} · ${f.label}`, onPick: set }),
    loader: () => videoLoader(f), budget: () => videoBudget(f) });
  loaderKnown(S.tpl.id)?.then(() => el.refresh());
  el.dataset.key = f.key;
  return el;
}

// a sound: a sound file or a clip's sound, with a cut ({generation|media, trim}); the server readies it
// for the loader (app/audioedit.prep)
function audioField(f) {
  const el = soundInput(S.values[f.key] || null, (v) => setVal(f.key, v), { title: `${f.group} · ${f.label}`, label: f.label });
  el.dataset.key = f.key;
  return el;
}

// the loader node's own settings next to a video field: rate, every-nth, and whether skip/cap are there
// for the server to use (they usually aren't tagged fields, so read them from the workflow itself)
const loaderWf = new Map();   // template id -> { wf, p: Promise }
function videoLoader(f) {
  const inp = loaderWf.get(S.tpl.id)?.wf?.[f.node]?.inputs;
  const val = (name) => S.values[`${f.node}.${name}`] ?? inp?.[name];
  return { rate: Number(val('force_rate')) || 0, nth: Number(val('select_every_nth')) || 1,
    mapped: !inp || ('skip_first_frames' in inp && 'frame_load_cap' in inp) };
}
function loaderKnown(id) {
  if (!loaderWf.has(id)) {
    const e = { wf: null };
    e.p = api(`/api/templates/${encodeURIComponent(id)}/workflow`).then((wf) => { e.wf = wf; }).catch(() => loaderWf.delete(id));
    loaderWf.set(id, e);
  }
  return loaderWf.get(id)?.p;
}

// the template's own length setting ("Length (seconds)", a frame count), if it has one, as a budget for the trim
function videoBudget(f) {
  const lf = S.tpl.fields.find((x) => x.node !== f.node && (x.kind === 'int' || x.kind === 'float') && /\b(length|duration|seconds|frames?)\b/i.test(x.label));
  const n = lf && Number(S.values[lf.key]);
  if (!(n > 0)) return null;
  return /second|duration/i.test(lf.label) && !/frame/i.test(lf.label) ? { secs: n } : { frames: n };
}

// LoRAs live in per-model folders (qwen/, krea/, h3/…). "Auto" shows the folder that matches the
// template's selected model; the chips pick a folder, or All.
const MODEL_INPUTS = ['unet_name', 'ckpt_name'];
const FOLDER_ALIASES = { h3: ['h3', 'minimax'], klein: ['klein', 'flux'], krea: ['krea'], qwen: ['qwen'], wan: ['wan'], ltx: ['ltx'] };

function autoLoraFolder(folders) {
  const mf = (S.tpl?.fields || []).find((x) => MODEL_INPUTS.includes(x.input));
  const model = String((mf && S.values[mf.key]) || '').toLowerCase();
  if (!model) return null;
  return folders.find((d) => (FOLDER_ALIASES[d.toLowerCase()] || [d.toLowerCase()]).some((w) => model.includes(w))) || null;
}

function loraField(f) {
  const list = h('div', { class: 'stack' });
  const rows = () => S.values[f.key] || [];
  const save = (arr) => { setVal(f.key, arr); draw(); };
  const folders = [...new Set(f.options.filter((o) => o.includes('/')).map((o) => o.split('/')[0]))].sort();
  const auto = autoLoraFolder(folders);
  const folderChips = h('div');
  const current = () => {
    const mode = S.loraFolder[f.key] ?? 'auto';
    return mode === 'auto' ? auto : mode === 'all' ? null : mode;
  };
  const drawChips = () => {
    const mode = S.loraFolder[f.key] ?? 'auto';
    folderChips.replaceChildren(chips([['auto', auto ? `Auto · ${auto}` : 'Auto · all'], ['all', 'All'], ...folders.map((d) => [d, d])], mode,
      (k) => { S.loraFolder[f.key] = k; persist(); draw(); }, { cls: 'folder-chips' }));
  };
  const draw = () => {
    const folder = current();
    const opts = folder ? f.options.filter((o) => o.startsWith(folder + '/')) : f.options;
    list.replaceChildren(...rows().map((l, i) => {
      const sel = h('select', {}, h('option', { value: '' }, `— choose LoRA${folder ? ` (${opts.length} in ${folder}/)` : ''} —`),
        opts.map((o) => h('option', { value: o }, folder ? o.slice(folder.length + 1) : o)));
      if (l.name && f.options.includes(l.name) && !opts.includes(l.name)) sel.append(h('option', { value: l.name }, `${l.name} (other folder)`));
      if (l.name && !f.options.includes(l.name)) sel.append(h('option', { value: l.name }, `${l.name} (missing)`));
      sel.value = l.name || '';
      sel.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], name: sel.value }; save(a); });
      const range = numSlider({ min: -2, max: 2, step: 0.05, value: l.strength ?? 1, digits: 2, label: 'Strength' });
      range.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], strength: parseFloat(range.value) }; setVal(f.key, a); });
      const on = h('input', { type: 'checkbox', checked: l.enabled !== false, title: 'Enabled' });
      on.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], enabled: on.checked }; save(a); });
      return h('div', { class: 'lora-row' + (l.enabled === false ? ' off' : '') },
        h('div', { class: 'top' }, on, sel,
          l.name ? iconBtn('LoRA info from Civitai', 'i', () => openLoraInfo(l.name), { class: 'icon-btn info-btn' }) : null,
          iconBtn('Remove LoRA', '✕', () => save(rows().filter((_, j) => j !== i)))),
        h('div', { class: 'row lora-strength' }, h('span', { class: 'hint' }, 'Strength'), range));
    }));
  };
  drawChips(); draw();
  return field(['LoRA stack', h('span', {}, f.options.length ? `${f.options.length} available` : 'none found')],
    folders.length ? folderChips : null,
    list,
    h('div', { class: 'row wrap' },
      button('+ Add LoRA', () => save([...rows(), { name: '', strength: 1, enabled: true }]), { cls: 'small add-btn' }),
      button('⤓ Civitai…', () => openCivitai({ family: current() || auto || folders[0], folders, onWord: addToPrompt,
        onDownloaded: () => loadTemplates(true),
        onAdd: ({ name }) => {   // into an empty row if there is one, else a new row
          const a = [...(S.values[f.key] || [])];
          if (a.some((l) => l.name === name)) return false;
          const i = a.findIndex((l) => !l.name);
          if (i >= 0) a[i] = { ...a[i], name }; else a.push({ name, strength: 1, enabled: true });
          setVal(f.key, a); renderFields();
        } }), { cls: 'small', title: 'Find and download LoRAs on Civitai' })));
}

function fieldEl(f) {
  const el = fieldBody(f);
  if (el.dataset && !el.dataset.key) el.dataset.key = f.key;   // gentabs marks overridden fields by it
  return el;
}
function fieldBody(f) {
  switch (f.kind) {
    case 'text': return textField(f);
    case 'int': return numberField(f, false);
    case 'float': return numberField(f, true);
    case 'seed': return seedField(f);
    case 'choice': return choiceField(f);
    case 'bool': return boolField(f);
    case 'image': return imageField(f);
    case 'video': return videoField(f);
    case 'audio': return audioField(f);
    case 'loras': return loraField(f);
    case 'boxes': return boxesField(f);
    default: return h('div', { class: 'hint' }, `${f.label}: unsupported`);
  }
}

// ---------------------------------------------------------------------------
// generate / stop
// ---------------------------------------------------------------------------
export async function generate() {
  if (!S.tpl || S.tpl.error) return toast('Pick a working template first', true);
  const values = {};
  for (const f of S.tpl.fields) {
    let v = S.values[f.key];
    if (f.kind === 'seed') v = (S.seedMode[f.key] || 'random') === 'random' ? -1 : Number(v);
    values[f.key] = v;
  }
  const odd = S.tpl.fields.filter((f) => f.kind === 'text' && unmatchedBraces(values[f.key]));
  if (odd.length && !confirm(`${odd.map((f) => f.label).join(', ')}: the { } don't match, so some wildcard text would go to the model as written. Generate anyway?`)) return;
  const nm = needsMask();
  if (nm) return toast(S.values[nm.image_key] ? 'Paint the area to change first' : 'Pick a picture, then paint the area to change', true);
  const btn = $('#genBtn'); btn.disabled = true;
  if (hooks.flush && !(await hooks.flush())) toast("Couldn't save this tab yet; running anyway");   // the saved tab should match what runs
  notifyPrepare();  // inside the tap: browsers only allow sound and notification prompts from a gesture
  keepAwake(true);
  try {
    for (const f of S.tpl.fields) if (f.kind === 'image') values[f.key] = await cropForRun(f, values[f.key]);
    for (const f of S.tpl.fields) {   // the picture goes as its cropped copy: the mask belongs to that (so Replay & edit keeps it)
      const m = f.kind === 'mask' ? values[f.key] : null;
      if (m?.name) values[f.key] = { ...m, src: values[f.image_key], crop: null };
    }
    const pf = S.tpl.fields.find(isMainPrompt);
    const builder = pf && builderState().on ? { parts: S.pb.parts, subjects: S.pb.subjects } : null;
    const gens = await queueRun({ template: S.tpl.id, values, batch: S.batch, builder, timeout: 120000 });   // (what it's made from: the server reads it off the inputs)
    const lastGen = gens[gens.length - 1];
    for (const f of S.tpl.fields) {
      if (f.kind !== 'seed') continue;
      S.lastSeed[f.key] = lastGen.params[f.key];
      if (S.seedMode[f.key] === 'increment') S.values[f.key] = Number(S.values[f.key]) + S.batch;
    }
    persist(); refreshSeedLabels();
    toast(gens.length > 1 ? `Queued ${gens.length}` : 'Queued');
  } catch (e) {
    if (!S.queueRemaining && !RUN.pid) keepAwake(false);
    toast(e.message, true);
  } finally { btn.disabled = false; }
}

// Wildcard prompts ({a|b}) with a missing or extra brace: count of braces with no partner.
function unmatchedBraces(v) {
  if (typeof v !== 'string' || !v.includes('|') || !/[{}]/.test(v)) return 0;
  let depth = 0, extra = 0;
  for (const ch of v) {
    if (ch === '{') depth++;
    else if (ch === '}') { if (depth) depth--; else extra++; }
  }
  return depth + extra;
}

// An image field's crop is applied per run: the server makes (or reuses) a copy named after the
// image and the crop, and only this run's values point at it.
async function cropForRun(f, v) {
  const c = S.imageCrop[f.key];
  if (!v || !c || c.src !== v) return v;
  const r = await api('/api/inputs/crop', { method: 'POST', body: { name: v, crop: c.crop, mp: S.imageMp[f.key] ?? 1, multiple: 16 } });
  return r.name;
}

function refreshSeedLabels() {
  for (const f of S.tpl.fields) {
    if (f.kind !== 'seed') continue;
    const el = document.querySelector(`.field[data-key="${CSS.escape(f.key)}"]`);
    if (!el) continue;
    el.querySelector('.last-seed').textContent = S.lastSeed[f.key] != null ? `last: ${S.lastSeed[f.key]}` : '';
    el.querySelector('input[type=number]').value = S.values[f.key];
  }
}

// Stop this device's run. It names the run, so a late tap can't stop the next one or another
// tablet's. Long runs ask first: Stop sits right next to Generate.
export async function stop(pid = RUN.pid, { ask = true } = {}) {
  if (!pid) {
    if (S.activePid) { toast('That run is from another device: stop it from the Queue'); openJobs(); }
    else toast('Nothing of yours is running');
    return;
  }
  const secs = RUN.pid === pid ? (Date.now() - RUN.t0) / 1000 : 0;
  if (ask && secs > 30 && !confirm(`Stop this run? It has been going for ${fmtDur(secs)}.`)) return;
  try {
    const r = await api('/api/interrupt', { method: 'POST', body: { prompt_id: pid } });
    toast(r.stopped === 'queued' ? 'Taken out of the queue' : r.stopped ? 'Stopping…' : 'That run had already finished');
  } catch (e) { toast(e.message, true); }
}

// Keep the screen on while runs are going, so the tablet doesn't sleep and drop the connection. The
// Wake Lock API needs HTTPS; over plain http a tiny silent looping video does the same job on most
// tablets (it has to be started from a tap, which Generate is).
let wakeLock = null, wakeVideo = null;
export async function keepAwake(on) {
  if (on && navigator.wakeLock && isSecureContext) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
      return;
    } catch { /* fall back to the video */ }
  }
  if (on) {
    if (!wakeVideo) {
      wakeVideo = h('video', { src: 'keepawake.mp4', muted: true, loop: true, playsInline: true, class: 'keep-awake', 'aria-hidden': 'true' });
      wakeVideo.setAttribute('playsinline', '');
      document.body.append(wakeVideo);
    }
    wakeVideo.play().catch(() => { /* not from a tap; the next Generate tries again */ });
  } else {
    try { if (wakeLock) await wakeLock.release(); } catch { /* already gone */ }
    wakeLock = null;
    if (wakeVideo) wakeVideo.pause();
  }
}

// ---------------------------------------------------------------------------
// layout boxes: tell layout-aware models (MOSS, Flux3 Klein) what goes where.
// Stored as fractions of the canvas, so they fit any output size.
// ---------------------------------------------------------------------------
function boxesField(f) {
  const boxes = S.values[f.key] || [];
  const preview = h('div', { class: 'boxes-preview', style: `aspect-ratio:${boxBackdrop().aspect}` },
    boxes.map((b, i) => h('span', { class: 'bx' + (b.type === 'text' ? ' text' : ''),
      style: `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%` }, String(i + 1))));
  const bg = boxBackdrop().image;
  if (bg) preview.style.backgroundImage = `url("${thumbUrl(bg, 320)}")`;
  const edit = () => openBoxEditor(f);
  return field([f.label, h('span', {}, boxes.length ? `${boxes.length} box${boxes.length > 1 ? 'es' : ''}` : 'none')],
    h('button', { type: 'button', class: 'boxes-btn', onclick: edit }, preview),
    h('div', { class: 'row' },
      button(boxes.length ? 'Edit boxes' : 'Draw boxes', edit),
      boxes.length ? button('Clear', () => { setVal(f.key, []); renderFields(); }) : null),
    hint(boxes.length ? boxes.map((b, i) => `${i + 1}: ${b.type === 'text' ? `text "${b.text || ''}"` : b.desc || 'object'}${b.ref ? ' + reference' : ''}`).join(' · ')
        : f.refs ? 'Optional. Mark where things go; describe each box, and give it a reference image if you like. In the prompt, refer to box 1 as <obj_1>.'
          : 'Optional. Mark where things go and describe each box.'));
}

// The canvas the boxes are drawn on: the image being edited if there is one, else the output size.
function boxBackdrop() {
  const img = (S.tpl?.fields || []).find((f) => f.kind === 'image' && S.values[f.key]);
  return { image: img ? S.values[img.key] : null, aspect: img ? (S.imgAspect?.[S.values[img.key]] || 1) : templateAspect() };
}

function openBoxEditor(f) {
  let boxes = (S.values[f.key] || []).map((b) => ({ ...b }));
  let sel = boxes.length ? 0 : -1;
  let { image, aspect } = boxBackdrop();
  const canvas = h('div', { class: 'box-canvas' });
  const stage = h('div', { class: 'sketch-stage' }, canvas);
  const list = h('div', { class: 'box-list' });

  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 20) / aspect, r.height - 20);
    canvas.style.width = `${Math.floor(k * aspect)}px`; canvas.style.height = `${Math.floor(k)}px`;
  };
  if (image) {
    canvas.style.backgroundImage = `url("${inputUrl(image)}")`;
    const probe = new Image();
    probe.onload = () => { aspect = probe.naturalWidth / probe.naturalHeight; (S.imgAspect ||= {})[image] = aspect; fit(); };
    probe.src = inputUrl(image);
  }

  const draw = () => {
    canvas.replaceChildren(...boxes.map((b, i) => h('div', {
      class: 'bx' + (i === sel ? ' sel' : '') + (b.type === 'text' ? ' text' : ''), 'data-i': i,
      style: `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%` },
      h('span', { class: 'bx-num' }, String(i + 1)), h('span', { class: 'bx-handle', 'data-i': i }))));
    list.replaceChildren(...(boxes.length ? boxes.map((b, i) => {
      // a box's prompt is a prompt like the main one: several lines, saved ones to step through and save, the full-screen
      // writing box on a tap (app.js), and the prompt's tags (<Picture 1>, <obj_1>…) as chips there
      const tags = () => [['Tags', [...promptTags(), ...boxes.map((_, k) => `<obj_${k + 1}>`)].map((t) => [t, t]), true]];
      const { el: desc, ta: descTa } = snippetEditor({ cat: 'Box', label: b.type === 'text' ? 'How the words look' : 'What goes here', grow: true,
        placeholder: b.type === 'text' ? 'Look of the text (e.g. neon sign)' : 'What goes here', get: () => b.desc || '', set: (t) => { b.desc = t; } });
      descTa._chipGroups = tags;
      const txt = textArea(() => b.text || '', (t) => { b.text = t; }, { rows: 2, placeholder: 'The words to write', grow: true });
      txt._chipGroups = tags;
      const kind = seg([['obj', 'Object'], ['text', 'Text']], b.type || 'obj', (t) => { b.type = t; draw(); });
      const move = (d) => { const j = i + d; if (j < 0 || j >= boxes.length) return; [boxes[i], boxes[j]] = [boxes[j], boxes[i]]; sel = j; draw(); };
      return h('div', { class: 'box-item' + (i === sel ? ' sel' : ''), onclick: () => { if (sel !== i) { sel = i; draw(); } } },
        h('div', { class: 'row' }, h('b', { class: 'fixed' }, `${i + 1}`), kind,
          iconBtn('Earlier', '↑', () => move(-1)),
          iconBtn('Later', '↓', () => move(1)),
          iconBtn('Delete box', '✕', () => { boxes.splice(i, 1); sel = Math.min(sel, boxes.length - 1); draw(); })),
        b.type === 'text' ? txt : null, desc,
        f.refs && b.type !== 'text' ? h('div', { class: 'box-ref' },
          b.ref ? h('img', { src: thumbUrl(b.ref, 160), alt: '' }) : null,
          button(b.ref ? 'Change reference' : '+ Reference image', (e) => {
            e.stopPropagation();
            openImagePicker({ title: `Reference for box ${i + 1}`, onPick: (name) => { b.ref = name; draw(); } });
          }),
          b.ref ? iconBtn('Remove reference', '✕', () => { delete b.ref; draw(); }) : null) : null);
    }) : [hint('Drag on the picture to draw a box. Background things first, foreground last.')]));
  };

  // drag on empty space: new box; drag a box: move it; drag its corner: resize
  let drag = null;
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const p = pt(e), t = e.target;
    if (t.classList.contains('bx-handle')) { sel = Number(t.dataset.i); drag = { mode: 'resize', b: boxes[sel] }; }
    else if (t.closest('.bx')) { sel = Number(t.closest('.bx').dataset.i); drag = { mode: 'move', b: boxes[sel], p0: p, b0: { ...boxes[sel] } }; }
    else { boxes.push({ x: p.x, y: p.y, w: 0, h: 0, type: 'obj', desc: '' }); sel = boxes.length - 1; drag = { mode: 'new', b: boxes[sel], p0: p }; }
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e), b = drag.b;
    if (drag.mode === 'move') {
      b.x = Math.min(1 - b.w, Math.max(0, drag.b0.x + p.x - drag.p0.x));
      b.y = Math.min(1 - b.h, Math.max(0, drag.b0.y + p.y - drag.p0.y));
    } else if (drag.mode === 'resize') {
      b.w = Math.max(0.02, p.x - b.x); b.h = Math.max(0.02, p.y - b.y);
    } else {
      b.x = Math.min(p.x, drag.p0.x); b.y = Math.min(p.y, drag.p0.y);
      b.w = Math.abs(p.x - drag.p0.x); b.h = Math.abs(p.y - drag.p0.y);
    }
    const el = canvas.querySelector(`.bx[data-i="${sel}"]`);
    if (el) Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  });
  const end = () => {
    if (drag && drag.mode === 'new' && (drag.b.w < 0.02 || drag.b.h < 0.02)) { boxes.pop(); sel = boxes.length - 1; }
    drag = null; draw();
    const inp = [...list.querySelectorAll('.box-item.sel textarea')].pop();
    if (inp && !inp.value && !matchMedia('(pointer: coarse)').matches) inp.focus();   // (on a tablet a tap opens the writing box)
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  const overlay = h('div', { class: 'sketch boxes-editor' },
    h('div', { class: 'sketch-bar' }, h('b', {}, f.label),
      info(f.refs ? 'Object boxes: describe what goes there, optionally with a reference image. Text boxes: the words, then how they look.'
        : 'Object boxes: describe what goes there. Text boxes: the words, then how they look.'),
      h('div', { class: 'spacer' }),
      button('Cancel', () => close(), { cls: 'small ghost' }),
      button('Done', () => {
        setVal(f.key, clean());
        close(false, true); renderFields();
      }, { cls: 'small primary' })),
    h('div', { class: 'box-body' }, stage, list));
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  const tidy = (bs) => bs.map(({ x, y, w, h: hh, type, desc, text, ref }) =>
    ({ x, y, w, h: hh, type: type || 'obj', desc: desc || '', text: text || '', ...(ref && type !== 'text' ? { ref } : {}) }));
  const clean = () => tidy(boxes);
  const start = JSON.stringify(tidy(S.values[f.key] || []));
  // Cancel or the back gesture with changes: ask, rather than lose them
  const close = openOverlay(overlay, { dirty: () => JSON.stringify(clean()) !== start, ask: 'Throw away your changes to the boxes?',
    onClose: () => ro.disconnect() });
  draw();
}

// ---------------------------------------------------------------------------
// LoRA info from Civitai (looked up by the file's hash through rgthree-comfy)
// ---------------------------------------------------------------------------
async function openLoraInfo(name) {
  const seq = openSheet(h('h3', {}, name.split('/').pop()),
    placeholder('Looking it up on Civitai… The first lookup hashes the file, which can take a little while.'));
  let r;
  try { r = await api(`/api/lora-info?name=${encodeURIComponent(name)}`, { timeout: 240000 }); } catch (e) {
    if (sheetStillOpen(seq)) openSheet(h('h3', {}, name.split('/').pop()), note(e.message, 'err'));
    return;
  }
  if (!sheetStillOpen(seq)) return;  // closed, or something else opened, while it was looking
  const textOf = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  const words = r.trained_words.map((w) => chip(w, (e) => { addToPrompt(w); e.target.classList.add('added'); }, { title: 'Add to prompt' }));
  openSheet(h('h3', {}, r.name),
    !r.found ? note('Not found on Civitai (the file may be private, renamed from elsewhere, or not uploaded there).') : null,
    h('table', { class: 'params' },
      h('tr', {}, h('td', {}, 'File'), h('td', {}, r.file)),
      r.base_model ? h('tr', {}, h('td', {}, 'Base model'), h('td', {}, r.base_model)) : null,
      r.link ? h('tr', {}, h('td', {}, 'Civitai'), h('td', {}, h('a', { href: r.link, target: '_blank', rel: 'noopener' }, 'Open model page'))) : null),
    words.length ? field(['Trigger words', h('span', {}, 'tap to add to the prompt')], h('div', { class: 'chips' }, words)) : null,
    r.description ? h('details', { class: 'desc' }, h('summary', {}, 'Description'), h('div', { class: 'hint pre' }, textOf(r.description))) : null,
    r.media.length ? h('div', { class: 'grid gallery' }, r.media.map((m) =>
      h('div', { class: 'card' }, h('div', { class: 'media' }, m.type === 'video'
        ? h('video', { src: m.url, muted: true, loop: true, playsInline: true, controls: true, preload: 'metadata' })
        : h('img', { src: m.url, loading: 'lazy', alt: '' }))))) : null);
}

// Append text to the template's main prompt (the first multi-line text field).
export function addToPrompt(text) {
  const f = (S.tpl?.fields || []).find((x) => x.kind === 'text' && x.multiline) || (S.tpl?.fields || []).find((x) => x.kind === 'text');
  if (!f) return toast('This template has no prompt field', true);
  const cur = String(S.values[f.key] || '').trimEnd();
  if (cur.includes(text)) return toast(`"${text}" is already in the prompt`);
  setVal(f.key, cur ? `${cur}, ${text}` : text);
  renderFields(); toast(`Added "${text}" to ${f.group}`);
}

// ---------------------------------------------------------------------------
// zoom + pan on the generate preview: pinch or wheel to zoom, drag to pan, double-tap to reset
// ---------------------------------------------------------------------------
export function wireZoom() {
  const viewer = $('#viewer'), layer = $('#zoomLayer');
  const zp = zoomPan(viewer, () => layer, { min: 0.1, max: 20, snapOne: true, skip: (e) => !!e.target.closest('.zoom-ctl'),
    onChange: (s) => { $('#zoomReset').textContent = s === 1 ? '1:1' : `${Math.round(s * 100)}%`; } });
  $('#zoomIn').addEventListener('click', () => zp.zoomBy(1.5));
  $('#zoomOut').addEventListener('click', () => zp.zoomBy(1 / 1.5));
  $('#zoomReset').addEventListener('click', zp.reset);
}
