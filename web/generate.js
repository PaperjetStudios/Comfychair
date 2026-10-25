import {
  $, h, store, clamp, clamp01, clone, cycleIndex, api, toast, undoToast, openOverlay, openSheet, sheetStillOpen, nameSheet,
  button, iconBtn, seg, field, hint, placeholder, note, cycleBar,
} from './ui.js';
import { ASPECT_PRESETS, S, addMine, deleteSnippet, inputUrl, loadSnippets, saveSnippet, savedEntries, thumbUrl } from './core.js';
import { openImagePicker, openVideoPicker } from './media.js';
import { RUN, fmtDur, notifyPrepare, onGeneration, openJobs, syncWithServer } from './run.js';
import { videoEditor } from './vfield.js';
import { FULL, openCrop, openSketch, templateAspect } from './editor.js';

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
}

export async function loadTemplates(refresh = false) {
  let failed = null;
  try {
    S.templates = await api('/api/templates' + (refresh ? '?refresh=1' : ''));
  } catch (e) { failed = e; S.templates = []; }
  const sel = $('#tplSel');
  sel.replaceChildren(...S.templates.map((t) => h('option', { value: t.id }, t.name + (t.error ? ' (error)' : ''))));
  if (!S.templates.length) {
    $('#fields').replaceChildren(failed
      ? note(`Couldn't load templates: ${failed.message}. They load by themselves once ComfyDeck answers.`, 'err')
      : note('No templates yet. Export a workflow from ComfyUI with Workflow → Export (API), tag nodes with @, and put it in the templates/ folder.', 'warn'));
    return;
  }
  const want = (S.tpl && S.tpl.id) || store.get('deck.tplId', null);
  const id = S.templates.find((t) => t.id === want) ? want : S.templates[0].id;
  if (hooks.templatesLoaded) hooks.templatesLoaded(id); else selectTemplate(id);
}

export function selectTemplate(id, overrideValues = null) {
  if (hooks.pick) return hooks.pick(id, overrideValues);   // the tab decides what a template change means
  const t = S.templates.find((x) => x.id === id);
  if (!t) return;
  S.tpl = t;
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
  const root = $('#fields'), panel = root.closest('.panel'), y = panel ? panel.scrollTop : 0;
  const ae = document.activeElement, fe = ae && root.contains(ae) ? ae.closest('.field[data-key]') : null;
  const at = fe ? { key: fe.dataset.key, i: [...fe.querySelectorAll(ae.tagName)].indexOf(ae), s: ae.selectionStart, e: ae.selectionEnd } : null;
  root.replaceChildren(shotBar(), ...groups);
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
  $('#tplSel').value = t.id;
  store.set('deck.tplId', t.id);
  S.seedMode = st.seedMode || {}; S.imageMp = st.imageMp || {}; S.imageCrop = st.imageCrop || {}; S.sizeMode = st.sizeMode || {};
  S.loraFolder = st.loraFolder || {}; S.builder = st.builder || {};
  renderFields();
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
        hint(`This workflow: ${S.tpl.name}. This model: ${currentModel() || '(no model setting here)'}. Everywhere: any template with the same kind of node.`, 'sheet-hint')],
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
  const mpIn = h('input', { type: 'number', inputMode: 'decimal', min: 0.05, max: 16, step: 0.05, value: m.mp });
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
  const setMp = (n) => { m.mp = Math.min(16, Math.max(0.05, Math.round(n * 100) / 100)); mpIn.value = m.mp; applyPreset(); };
  mpIn.addEventListener('change', () => setMp(parseFloat(mpIn.value) || m.mp));
  const mpRow = field(['Megapixels', h('span', {}, `sides snap to ${step}`)],
    stepper(mpIn, (d) => setMp(m.mp + d * 0.05), 'megapixels'),
    seg([0.25, 0.4, 0.5, 1, 2].map((v) => [v, `${v}`]), null, setMp, { action: true }));
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
  [/per_row|columns|^rows$/, 1, 16], [/spacing|gap|padding|margin|border/, 0, 256]];
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
  const input = h('input', { type: 'number', inputMode: isFloat ? 'decimal' : 'numeric', step, min: lo ?? undefined, max: hi ?? undefined, value: S.values[f.key] });
  let range = null;
  const sync = (n, from) => {
    n = clamp(n); setVal(f.key, n);
    if (from !== input) input.value = n;
    if (range && from !== range) range.value = n;
  };
  input.addEventListener('change', () => sync(parseFloat(input.value), input));
  input.addEventListener('input', () => { if (input.dataset.scrubbing) sync(parseFloat(input.value), input); });
  const bump = (dir) => sync(Number(S.values[f.key]) + dir * step, null);
  const hasRange = lo != null && hi != null && (hi - lo) / step <= 4000 && (hi - lo) <= 10000;
  if (hasRange) {
    range = h('input', { type: 'range', min: lo, max: hi, step, value: S.values[f.key] });
    range.addEventListener('input', () => sync(parseFloat(range.value), range));
  }
  return field([f.label, hasRange ? h('span', {}, `${lo}–${hi}`) : null], stepper(input, bump), range);
}

function seedField(f) {
  const mode = S.seedMode[f.key] || 'random';
  const input = h('input', { type: 'number', inputMode: 'numeric', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, value: S.values[f.key] });
  input.addEventListener('change', () => { setVal(f.key, Math.max(0, parseInt(input.value || '0', 10))); });
  const setMode = (m) => { S.seedMode[f.key] = m; persist(); modes.set(m); };
  const modes = seg([['random', '🎲 Random'], ['fixed', 'Fixed'], ['increment', '+1 each run']], mode, setMode);
  const last = S.lastSeed[f.key];
  const el = field([f.label, h('span', { class: 'last-seed' }, last != null ? `last: ${last}` : '')],
    h('div', { class: 'row' }, input,
      button('↺ last', () => { if (S.lastSeed[f.key] != null) { input.value = S.lastSeed[f.key]; setVal(f.key, S.lastSeed[f.key]); setMode('fixed'); } },
        { cls: 'small fixed', title: 'Use last seed' })),
    modes);
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

function autoGrow(ta, max = 420) {
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px'; };
  ta.addEventListener('input', grow);
  ta.addEventListener('grow', grow);
  requestAnimationFrame(grow);
}

function textField(f) {
  if (isMainPrompt(f)) return promptField(f);
  const ta = h('textarea', { rows: f.multiline ? 4 : 1, value: S.values[f.key] ?? '', spellcheck: true });
  ta.addEventListener('input', () => setVal(f.key, ta.value));
  if (f.multiline) autoGrow(ta);
  return field(f.label, ta);
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
    default: return [];
  }
}

function insertAtCursor(ta, text) {
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  const before = ta.value.slice(0, a), after = ta.value.slice(b);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = before + pad + text + (after && !/^\s/.test(after) ? ' ' : '') + after;
  const at = (before + pad + text).length + 1;
  ta.focus(); ta.setSelectionRange(at, at);
  ta.dispatchEvent(new Event('input'));
}

// The reference tag a subject can point at, in this model's own syntax (null: model has none).
function pictureTag(n) {
  switch (S.tpl?.tag_style) {
    case 'h3': return `<Picture ${n}>`;
    case 'klein': return `<ref_image_${n - 1}>`;
    case 'qwen': return `Picture ${n}`;
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
  const ta = h('textarea', { rows: 3, value: get(), spellcheck: true, placeholder });
  if (grow) autoGrow(ta, 260);
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
  ta.addEventListener('input', () => { set(ta.value); showPos(); });
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
  const chipsRow = h('div', { class: 'chips tag-chips' });
  const drawChips = () => {
    const tags = promptTags().filter((t) => !/^<?Subject \d+>?$/.test(t));
    const n = st.on ? Math.max(1, st.subjects.length) : (S.tpl?.tag_style === 'h3' ? 3 : 0);
    for (let i = 1; i <= n; i++) tags.push(subjectTag(i));
    chipsRow.replaceChildren(...tags.map((t) => h('button', { type: 'button', class: 'chip', onmousedown: (e) => e.preventDefault(),
      onclick: () => { if (lastTA) insertAtCursor(lastTA, t); else toast('Tap into a text box first'); } }, t)));
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
      const ta = track(h('textarea', { rows: 4, value: S.values[f.key] ?? '', spellcheck: true }));
      ta.addEventListener('input', () => setVal(f.key, ta.value));
      autoGrow(ta);
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
  const el = field([f.label, mode], body);
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
  const cb = h('input', { type: 'checkbox', checked: !!S.values[f.key] });
  cb.addEventListener('change', () => setVal(f.key, cb.checked));
  return h('label', { class: 'field toggle' }, cb, f.label);
}

export function mpInput(get, set) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min: 0, max: 16, step: 0.05, value: get() });
  input.addEventListener('change', () => {
    const n = clamp(parseFloat(input.value) || 0, 0, 16);
    input.value = n; set(n);
  });
  return h('label', { class: 'mp' }, h('span', {}, 'Max MP'), input,
    h('span', { class: 'hint' }, '0 = keep size'));
}

// the whole image greyed out, with the cropped part in colour on top
function cropPreview(src, c) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  return h('span', { class: 'crop-preview' },
    h('img', { class: 'under', src, alt: '' }),
    h('img', { class: 'kept', src, alt: '', style: `clip-path:inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})` }));
}

// An image or video input: a thumbnail to tap, its buttons beside it, and extra (the MP box) under them
function mediaInput(f, caption, thumb, pick, buttons, extra = null) {
  const el = field([f.label, h('span', {}, caption)],
    h('div', { class: 'imgfield' },
      h('button', { type: 'button', class: 'thumb', onclick: pick, 'aria-label': `Choose ${f.kind}` }, thumb),
      h('div', { class: 'actions' }, h('div', { class: 'row wrap' }, button('Choose…', pick), buttons), extra)));
  el.dataset.key = f.key;
  return el;
}

function imageField(f) {
  const v = S.values[f.key];
  if (S.imageMp[f.key] == null) S.imageMp[f.key] = f.mp ?? 1;
  const pick = () => openImagePicker({
    title: `${f.group} · ${f.label}`, mp: () => S.imageMp[f.key],
    onPick: (name, info) => {
      setVal(f.key, name);
      if (info && info.source) S.pendingParent = info.source;
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
    try { await img.decode(); } catch { return toast('Could not load the image', true); }
    openCrop({ img, crop: cropped ? cropped.crop : FULL, onApply: (c) => {
      if (c.w > 0.999 && c.h > 0.999) delete S.imageCrop[f.key];
      else S.imageCrop[f.key] = { src: v, crop: c };
      persist(); renderFields();
    } });
  };
  const set = (name) => { setVal(f.key, name); renderFields(); };
  return mediaInput(f, v ? String(v).split('/').pop() + (cropped ? ' · cropped' : '') : 'empty',
    cropped ? cropPreview(thumbUrl(cropped.src, 256), cropped.crop)
      : v ? h('img', { src: thumbUrl(v, 256), alt: v }) : h('span', { class: 'hint' }, '+ image'),
    pick, [
      v ? button('Crop…', crop) : null,
      button(v ? 'Draw on' : 'Draw', () => openSketch({ base: v || null, aspect: templateAspect(), onDone: set })),
      v ? button('Clear', () => set('')) : null],
    mpInput(() => S.imageMp[f.key], (n) => { S.imageMp[f.key] = n; persist(); }));
}

// A video input (VHS_LoadVideoPath): the value is the clip's source, {generation, index} for an
// output or {media} for a file uploaded in the Video tab; the server turns it into the file's path.
function videoSource(v) {
  if (v && v.generation != null) {
    const g = S.history.get(v.generation), o = g && g.outputs[v.index || 0];
    return o ? { o, label: `#${g.id} ${g.template}` } : { o: null, label: `#${v.generation} (not loaded)` };
  }
  if (v && v.media) return { o: { kind: 'video', url: `/files/media/${encodeURIComponent(v.media)}` }, label: v.media.split('_').slice(1).join('_') || v.media };
  return null;
}

function videoField(f) {
  const v = S.values[f.key];
  const src = videoSource(v);
  const pick = () => openVideoPicker({
    title: `${f.group} · ${f.label}`,
    onPick: (val) => {
      setVal(f.key, val);
      if (val.generation != null) S.pendingParent = { generation: val.generation, index: val.index };
      renderFields();
    },
  });
  if (!(src && src.o)) return mediaInput(f, src ? src.label : 'empty', h('span', { class: 'hint' }, '+ video'), pick,
    [v ? button('Clear', () => { setVal(f.key, null); renderFields(); }) : null]);
  // Trim and crop live in the value ({generation|media, trim, crop}), so tabs, shots and Run again
  // keep them; the server applies them (loader inputs or an ffmpeg copy, see app/videoprep.py).
  const base = v.generation != null ? { generation: v.generation, index: v.index } : { media: v.media };
  const edit = videoEditor({
    url: src.o.url, source: base, trim: v.trim, crop: v.crop,
    loader: () => videoLoader(f), budget: () => videoBudget(f),
    onChange: (trim, crop) => setVal(f.key, { ...base, ...(trim && { trim }), ...(crop && { crop }) }),
  });
  loaderKnown(S.tpl.id)?.then(() => edit.refresh());
  const el = field([f.label, h('span', {}, src.label)], edit,
    h('div', { class: 'row wrap' }, button('Choose…', pick), button('Clear', () => { setVal(f.key, null); renderFields(); })));
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
  const chips = h('div', { class: 'chips folder-chips' });
  const current = () => {
    const mode = S.loraFolder[f.key] ?? 'auto';
    return mode === 'auto' ? auto : mode === 'all' ? null : mode;
  };
  const drawChips = () => {
    const mode = S.loraFolder[f.key] ?? 'auto';
    chips.replaceChildren(...[['auto', auto ? `Auto · ${auto}` : 'Auto · all'], ['all', 'All'], ...folders.map((d) => [d, d])].map(([k, label]) =>
      h('button', { type: 'button', class: 'chip' + (mode === k ? ' on' : ''),
        onclick: () => { S.loraFolder[f.key] = k; persist(); drawChips(); draw(); } }, label)));
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
      const val = h('span', { class: 'range-val' }, Number(l.strength ?? 1).toFixed(2));
      const range = h('input', { type: 'range', min: -2, max: 2, step: 0.05, value: l.strength ?? 1 });
      range.addEventListener('input', () => { val.textContent = Number(range.value).toFixed(2); });
      range.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], strength: parseFloat(range.value) }; setVal(f.key, a); });
      const on = h('input', { type: 'checkbox', checked: l.enabled !== false, title: 'Enabled' });
      on.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], enabled: on.checked }; save(a); });
      return h('div', { class: 'lora-row' + (l.enabled === false ? ' off' : '') },
        h('div', { class: 'top' }, on, sel,
          l.name ? iconBtn('LoRA info from Civitai', 'i', () => openLoraInfo(l.name), { class: 'icon-btn info-btn' }) : null,
          iconBtn('Remove LoRA', '✕', () => save(rows().filter((_, j) => j !== i)))),
        h('div', { class: 'row' }, range, val));
    }));
  };
  drawChips(); draw();
  return field(['LoRA stack', h('span', {}, f.options.length ? `${f.options.length} available` : 'none found')],
    folders.length ? chips : null,
    list,
    button('+ Add LoRA', () => save([...rows(), { name: '', strength: 1, enabled: true }]), { cls: 'small add-btn' }));
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
    case 'loras': return loraField(f);
    case 'boxes': return boxesField(f);
    default: return h('div', { class: 'hint' }, `${f.label}: unsupported`);
  }
}

// ---------------------------------------------------------------------------
// generate / stop
// ---------------------------------------------------------------------------
export async function generate(parent = null) {
  if (!S.tpl || S.tpl.error) return toast('Pick a working template first', true);
  const values = {};
  for (const f of S.tpl.fields) {
    let v = S.values[f.key];
    if (f.kind === 'seed') v = (S.seedMode[f.key] || 'random') === 'random' ? -1 : Number(v);
    values[f.key] = v;
  }
  const odd = S.tpl.fields.filter((f) => f.kind === 'text' && unmatchedBraces(values[f.key]));
  if (odd.length && !confirm(`${odd.map((f) => f.label).join(', ')}: the { } don't match, so some wildcard text would go to the model as written. Generate anyway?`)) return;
  const btn = $('#genBtn'); btn.disabled = true;
  if (hooks.flush && !(await hooks.flush())) toast("Couldn't save this tab yet; running anyway");   // the saved tab should match what runs
  notifyPrepare();  // inside the tap: browsers only allow sound and notification prompts from a gesture
  keepAwake(true);
  try {
    for (const f of S.tpl.fields) if (f.kind === 'image') values[f.key] = await cropForRun(f, values[f.key]);
    const pf = S.tpl.fields.find(isMainPrompt);
    const builder = pf && builderState().on ? { parts: S.pb.parts, subjects: S.pb.subjects } : null;
    let gens;
    try {
      gens = await api('/api/generate', { method: 'POST', timeout: 120000, body: { template: S.tpl.id, values, batch: S.batch, project_id: S.project, parent, builder } });
    } catch (e) {  // part of a batch may already be queued: follow those, then report the failure
      for (const g of e.data?.created || []) { addMine(g.prompt_id); S.history.set(g.id, g); }
      throw e;
    }
    adoptGenerations(gens);
    const lastGen = gens[gens.length - 1];
    for (const f of S.tpl.fields) {
      if (f.kind !== 'seed') continue;
      S.lastSeed[f.key] = lastGen.params[f.key];
      if (S.seedMode[f.key] === 'increment') S.values[f.key] = Number(S.values[f.key]) + S.batch;
    }
    persist(); refreshSeedLabels();
    toast(gens.length > 1 ? `Queued ${gens.length}` : 'Queued');
  } catch (e) {
    if (parent && !S.pendingParent && !e.data?.created) S.pendingParent = parent;  // nothing ran: keep the lineage for the retry
    if (!S.queueRemaining && !RUN.pid) keepAwake(false);
    toast(e.message, true);
  } finally { btn.disabled = false; }
}

// Runs just queued from here. With an idle queue ComfyUI can start (or even finish) one before the
// queue reply arrives, so its websocket messages were taken for another device's: catch up then.
export function adoptGenerations(gens) {
  let missed = false;
  for (const g of gens) {
    addMine(g.prompt_id);
    const seen = S.history.get(g.id);
    if (!seen) S.history.set(g.id, g);   // never overwrite a newer status that came over the socket
    else if (seen.status === 'done' || seen.status === 'error') { S.history.delete(g.id); onGeneration(seen); }  // show it now
    if (g.prompt_id === S.activePid && RUN.pid !== S.activePid) missed = true;
  }
  if (missed) syncWithServer();
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
      const desc = h('input', { type: 'text', value: b.desc || '', placeholder: b.type === 'text' ? 'Look of the text (e.g. neon sign)' : 'What goes here' });
      desc.addEventListener('input', () => { b.desc = desc.value; });
      const txt = h('input', { type: 'text', value: b.text || '', placeholder: 'The words to write' });
      txt.addEventListener('input', () => { b.text = txt.value; });
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
    const inp = list.querySelector('.box-item.sel input:last-of-type');
    if (inp && !inp.value) inp.focus();
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  const overlay = h('div', { class: 'sketch boxes-editor' },
    h('div', { class: 'sketch-bar' }, h('b', {}, f.label),
      h('span', { class: 'hint' }, f.refs ? 'Object boxes: describe what goes there, optionally with a reference image. Text boxes: the words, then how they look.'
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
  const words = r.trained_words.map((w) => h('button', { type: 'button', class: 'chip', title: 'Add to prompt',
    onclick: (e) => { addToPrompt(w); e.target.classList.add('added'); } }, w));
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
const Z = { s: 1, x: 0, y: 0 };
export function wireZoom() {
  const viewer = $('#viewer'), layer = $('#zoomLayer');
  const apply = () => {
    layer.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
    $('#zoomReset').textContent = Z.s === 1 ? '1:1' : `${Math.round(Z.s * 100)}%`;
    viewer.classList.toggle('zoomed', Z.s !== 1);
  };
  const zoomAt = (factor, cx, cy) => {
    const r = viewer.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    let s = Math.min(20, Math.max(0.1, Z.s * factor));
    if (Math.abs(s - 1) < 0.04) s = 1;  // snap back to fit when passing through 100%
    Z.x = px - (px - Z.x) * (s / Z.s); Z.y = py - (py - Z.y) * (s / Z.s); Z.s = s;
    if (s === 1) { Z.x = 0; Z.y = 0; }
    apply();
  };
  const centre = (f) => { const r = viewer.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); };
  $('#zoomIn').addEventListener('click', () => centre(1.5));
  $('#zoomOut').addEventListener('click', () => centre(1 / 1.5));
  $('#zoomReset').addEventListener('click', () => { Z.s = 1; Z.x = 0; Z.y = 0; apply(); });
  // rotating the tablet changes the viewer's size, so old pan offsets could leave the image off-screen
  let lastSize = '';
  new ResizeObserver(() => {
    const r = viewer.getBoundingClientRect(), size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (lastSize && size !== lastSize && Z.s !== 1) { Z.s = 1; Z.x = 0; Z.y = 0; apply(); }
    lastSize = size;
  }).observe(viewer);
  viewer.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY); }, { passive: false });

  const pts = new Map();
  let last = null, moved = false, lastTap = 0;
  viewer.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom-ctl')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 2 || Z.s !== 1) { try { viewer.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
    last = [...pts.values()];
    const now = Date.now();
    if (pts.size === 1 && now - lastTap < 300) { if (Z.s !== 1) { Z.s = 1; Z.x = 0; Z.y = 0; apply(); } else zoomAt(2.5, e.clientX, e.clientY); moved = true; }
    lastTap = now;
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cur = [...pts.values()];
    if (cur.length === 2 && last && last.length === 2) {
      const d = (a) => Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      const mid = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
      const lmid = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
      Z.x += mid.x - lmid.x; Z.y += mid.y - lmid.y;
      zoomAt(d(cur) / Math.max(1, d(last)), mid.x, mid.y);
      moved = true;
    } else if (cur.length === 1 && Z.s !== 1 && last) {
      const dx = cur[0].x - last[0].x, dy = cur[0].y - last[0].y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      Z.x += dx; Z.y += dy; apply();
    }
    last = cur;
  });
  const up = (e) => { pts.delete(e.pointerId); last = [...pts.values()]; };
  viewer.addEventListener('pointerup', up); viewer.addEventListener('pointercancel', up);
  // a drag or pinch shouldn't also count as a tap on the image (which opens its details)
  viewer.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}
