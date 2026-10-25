// Generate tabs and global generation presets (the panel's TabSet adapter).
//
// A tab stores {v:1, template, presetId|null, overrides:{key: value}, seedMode, imageMp, imageCrop,
// sizeMode, loraFolder, builder}: only the values that differ from what its preset gives, plus the
// per-tab UI state that goes with them. A preset (kind gen-presets, project scope) is {v:1, template,
// values:{key: value}} and holds the "settings" fields only; the prompt, seeds and media are per shot
// and live in the tab (their overrides are just their values). Shown values:
//   effective = { ...template defaults, ...preset.values, ...tab.overrides }
// S.values stays the working copy every field edits; persist() calls hooks.edited(), which re-derives
// the overrides from it (so an edit back to the inherited value drops the override) and saves the tab.
import { $, h, api, toast, undoToast, openSheet, closeSheet, nameSheet, sheetOpen, button, hint, actions, store, uid, clone } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { TabSet } from './tabs.js';
import { hooks, installState, mainPromptKey, persist, renderFields, stateKey } from './generate.js';

const SHOT_KINDS = new Set(['image', 'video', 'boxes', 'seed']);   // content of one run, not a setting
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tplById = (id) => S.templates.find((t) => t.id === id);
const settingKey = (t, f) => !SHOT_KINDS.has(f.kind) && f.key !== mainPromptKey(t);
const validFor = (f, v) => v !== undefined && !(f.kind === 'choice' && f.options.length && !f.options.includes(v));   // models get renamed/removed
const blankBuilder = () => ({ on: false, parts: {}, subjects: [{ text: '', pic: null }] });
const projQs = () => (S.project != null ? `?project_id=${S.project}` : '');

// ---- presets (this project's gen-presets documents) ----
const presets = new Map();   // id -> { id, name, rev, template, values }
const seen = new Map();      // every preset ever loaded here: a tab pointing at one deleted elsewhere keeps showing it
let presetSeq = 0;
const purl = (id = '', tail = '') => `/api/store/gen-presets${id ? `/${id}` : ''}${tail}${projQs()}`;
async function pput(id, body) {   // api() drops the status; a 409 matters here
  try {
    const r = await fetch(purl(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, data };
  } catch { return { net: true }; }
}
const toPreset = (d) => ({ id: d.id, name: d.name, rev: d.rev, template: d.payload?.template, values: d.payload?.values || {} });
const remember = (p) => { presets.set(p.id, p); seen.set(p.id, p); };

// Reload the list (documents only when their rev moved). True when the preset this tab uses changed.
async function loadPresets() {
  const seq = ++presetSeq, pid = S.project;
  let list;
  try { list = await api(purl(), { busy: false }); } catch { return false; }
  const docs = await Promise.all(list.map((r) => {
    const had = presets.get(r.id);
    return had && had.rev === r.rev ? had : api(purl(r.id), { busy: false }).then(toPreset).catch(() => had || null);
  }));
  if (seq !== presetSeq || pid !== S.project) return false;
  const before = presets.get(cur.presetId);
  presets.clear();
  for (const p of docs) if (p) remember(p);
  updatePicker();
  const now = presets.get(cur.presetId);
  return !!(before && now && !eq(before.values, now.values));
}
const presetOf = (id) => (id ? presets.get(id) || seen.get(id) || null : null);

// ---- effective values ----
let cur = { presetId: null, overrides: {} };   // the open tab's inheritance
const inherited = (t, f, preset = presetOf(cur.presetId)) => {
  const pv = preset && preset.template === t.id && settingKey(t, f) ? preset.values[f.key] : undefined;
  return validFor(f, pv) ? pv : f.value;
};
function effective(t, c) {
  const preset = presetOf(c.presetId), out = {};
  for (const f of t.fields) out[f.key] = validFor(f, c.overrides[f.key]) ? clone(c.overrides[f.key]) : clone(inherited(t, f, preset));
  return out;
}
function diff(t = S.tpl, values = S.values, preset = presetOf(cur.presetId)) {
  const ov = {};
  for (const f of t.fields) if (f.key in values && !eq(values[f.key], inherited(t, f, preset))) ov[f.key] = clone(values[f.key]);
  return ov;
}
const settingValues = (t, values) => Object.fromEntries(t.fields.filter((f) => settingKey(t, f)).map((f) => [f.key, clone(values[f.key])]));

// ---- tab payload ----
function dump() {
  if (!S.tpl) return { v: 1 };
  const b = S.pb || (S.pb = blankBuilder());
  return { v: 1, template: S.tpl.id, presetId: cur.presetId, overrides: diff(), seedMode: clone(S.seedMode), imageMp: clone(S.imageMp),
    imageCrop: clone(S.imageCrop), sizeMode: clone(S.sizeMode), loraFolder: clone(S.loraFolder), builder: clone(b) };
}
function empty() {   // a new tab: same template and preset, nothing changed, blank prompt builder
  const t = S.tpl || S.templates[0];
  return { v: 1, template: t?.id, presetId: S.tpl && cur.presetId ? cur.presetId : null, overrides: {}, builder: null };
}
function payloadFor(t, values, extra = {}) {   // a payload for a state with no preset (a saved shot, the old localStorage state)
  return { v: 1, template: t.id, presetId: null, overrides: diff(t, values, null), seedMode: extra.seedMode || {}, imageMp: extra.imageMp || {},
    imageCrop: extra.imageCrop || {}, sizeMode: extra.sizeMode || {}, loraFolder: extra.loraFolder || {}, builder: extra.builder || null };
}
function seed() {
  const want = store.get('deck.tplId', null), t = tplById(want) || S.templates[0];
  const old = store.get(stateKey(t.id), {}), values = {};
  for (const f of t.fields) { const v = old.values?.[f.key]; values[f.key] = validFor(f, v) ? v : f.value; }
  return payloadFor(t, values, { ...old, builder: store.get('deck.builder', null) });
}
function load(p) {
  let t = tplById(p.template);
  if (!t) {
    t = S.tpl || S.templates[0];
    if (p.template) toast(`Template "${p.template}" isn't available: showing ${t.name}`, true);
    p = { ...p, template: t.id, presetId: null, overrides: {} };
  }
  cur = { presetId: p.presetId ?? null, overrides: clone(p.overrides || {}) };
  S.values = effective(t, cur);
  const b = p.builder ? clone(p.builder) : blankBuilder();
  if (!b.subjects?.length) b.subjects = [{ text: '', pic: null }];
  S.pb = { on: false, parts: {}, ...b };
  installState(t, p);
}

// ---- template change: this tab starts fresh for the new template (Undo puts it back) ----
function pick(id, over) {
  const t = tplById(id);
  if (!t || !tabs.active) { if (S.tpl) $('#tplSel').value = S.tpl.id; return; }
  if (S.tpl && id === S.tpl.id) {   // same template ("reuse these settings"): lay the values over this tab
    if (!over) return;
    for (const [k, v] of Object.entries(over)) if (k in S.values) S.values[k] = v;
    for (const f of t.fields) if (f.kind === 'seed' && over[f.key] !== undefined) S.seedMode[f.key] = 'fixed';
    S.sizeMode = {};
    renderFields(); persist();
    return;
  }
  const before = dump();
  load({ v: 1, template: id, presetId: null, overrides: {}, builder: before.builder });   // the prompt builder follows you, as it always did
  if (over) {
    for (const [k, v] of Object.entries(over)) if (k in S.values) S.values[k] = v;
    for (const f of t.fields) if (f.kind === 'seed' && over[f.key] !== undefined) S.seedMode[f.key] = 'fixed';
    renderFields();
  }
  persist();
  if (before.template) undoToast(`${t.name}: this tab starts fresh`, () => { load(before); persist(); });
}

// ---- the tabs ----
const mount = h('div', { id: 'genTabs', class: 'gen-tabs' });
$('.tpl-row').before(mount);
export const tabs = new TabSet({ kind: 'gen-tabs', mount, scope: 'project', newName: (n) => `Tab ${n}`,
  adapter: { empty, load, dump, migrate: (p) => (p && p.v === 1 && p.template ? p : empty()) }, seed, onSwitch: () => updatePicker() });
const baseStart = tabs.start.bind(tabs);
tabs.start = async () => { await loadPresets(); return baseStart(); };   // presets first: the tab's values depend on them

hooks.templatesLoaded = () => {
  if (tabs.started && tabs.active) { const p = dump(); load(p); updatePicker(); } else tabs.start();   // a reload of the templates re-reads the tab against them
};
hooks.pick = pick;
hooks.flush = () => tabs.flush();
hooks.edited = () => {
  if (!tabs.active || tabs.loading || !S.tpl) return;
  cur.overrides = diff();
  tabs.changed();
  decorate();
  updatePicker();
};
hooks.decorate = () => { decorate(); updatePicker(); };
hooks.openShot = async (p, name) => {
  const t = tplById(p.workflow);
  if (!t) return toast('That shot\'s template isn\'t available', true);
  if (!tabs.active || !(await tabs.leave())) return;
  const values = {};
  for (const f of t.fields) values[f.key] = validFor(f, p.values?.[f.key]) ? p.values[f.key] : f.value;
  const b = p.builder ? { ...clone(p.builder), on: true } : null;
  try { tabs.open(await tabs.create1({ name: String(name || 'Shot').slice(0, 120), payload: payloadFor(t, values, { ...p, builder: b }), order: tabs.active.order + 0.5 })); }
  catch (e) { toast(e.message, true); }
};

// ---- overridden fields: a marker and a reset ----
const pairKeys = (t, f) => {   // width and height are one control
  const o = f.input === 'width' ? 'height' : f.input === 'height' ? 'width' : null;
  const q = o && t.fields.find((x) => x.node === f.node && x.input === o && x.kind === 'int');
  return q ? [f.key, q.key] : [f.key];
};
function decorate() {
  const root = $('#fields');
  if (!root || !S.tpl) return;
  root.querySelectorAll('.ovr-btn').forEach((b) => b.remove());
  root.querySelectorAll('.field.ovr').forEach((e) => e.classList.remove('ovr'));
  const preset = presetOf(cur.presetId);
  if (!preset || preset.template !== S.tpl.id) return;
  const ov = diff();
  for (const f of S.tpl.fields) {
    if (!(f.key in ov) || !settingKey(S.tpl, f)) continue;
    const keys = pairKeys(S.tpl, f);
    const el = keys.map((k) => root.querySelector(`.field[data-key="${CSS.escape(k)}"]`)).find(Boolean);
    if (!el || el.classList.contains('ovr')) continue;
    el.classList.add('ovr');
    (el.querySelector('.lbl') || el).append(h('button', { type: 'button', class: 'ovr-btn', title: `Back to the preset's ${f.label}`,
      onclick: () => resetFields(keys) }, '↺ preset'));
  }
}
function resetFields(keys) {
  for (const k of keys) { const f = S.tpl.fields.find((x) => x.key === k); if (f) S.values[k] = clone(inherited(S.tpl, f)); }
  if (keys.some((k) => /^(width|height)$/.test(S.tpl.fields.find((x) => x.key === k)?.input))) S.sizeMode = {};
  persist(); renderFields();
}

// ---- the preset picker, beside the template picker ----
const pbtn = h('button', { type: 'button', class: 'btn small ghost preset-btn', title: 'Presets: what this tab inherits its settings from', onclick: () => presetSheet() });
$('#tplSel').after(pbtn);
function updatePicker() {
  if (!S.tpl) return;
  const p = presetOf(cur.presetId), n = p && p.template === S.tpl.id ? changedKeys().length : 0;
  pbtn.textContent = `${p ? p.name : 'No preset'}${n ? ` · ${n} changed` : ''}`;
  pbtn.classList.toggle('on', !!p);
}
const mine = () => [...presets.values()].filter((p) => p.template === S.tpl?.id).sort((a, b) => a.name.localeCompare(b.name));
const changedKeys = () => (presetOf(cur.presetId) ? Object.keys(diff()).filter((k) => settingKey(S.tpl, S.tpl.fields.find((f) => f.key === k) || {})) : []);

function presetSheet() {
  if (!S.tpl || !tabs.active) return;
  const list = mine(), pr = presetOf(cur.presetId), n = changedKeys().length;
  const row = (id, name) => h('div', { class: 'preset-row' + (cur.presetId === id ? ' on' : '') },
    h('button', { type: 'button', class: 'preset-pick', onclick: () => { closeSheet(); setPreset(id); } }, (cur.presetId === id ? '✓ ' : '') + name),
    id ? h('button', { type: 'button', class: 'icon-btn', title: 'Rename', 'aria-label': `Rename ${name}`, onclick: () => renamePreset(id) }, '✎') : null,
    id ? h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${name}`, onclick: () => deletePreset(id) }, '🗑') : null);
  openSheet(h('h3', {}, `Presets · ${S.tpl.name}`),
    hint('A tab inherits its settings from one preset and remembers only what you change. Change the preset and every tab that hasn\'t changed that setting follows. The prompt, seed and images stay with the tab.', 'sheet-hint'),
    h('div', { class: 'preset-list' }, row(null, 'No preset'), ...list.map((p) => row(p.id, p.name))),
    actions(
      n && pr ? button(`Save ${n} change${n > 1 ? 's' : ''} into "${pr.name}"`, () => { closeSheet(); saveIntoPreset(); }, { cls: 'primary' }) : null,
      button('Save this tab as a new preset', () => newPresetSheet(), { cls: n && pr ? '' : 'primary' }),
      n && pr ? button(`Reset ${n} to the preset`, () => { closeSheet(); resetFields(changedKeys()); }, { cls: 'ghost' }) : null));
}

// Pick a preset: its settings replace this tab's (prompt, seed and images stay). None: the tab keeps what it shows.
function setPreset(id) {
  const before = dump();
  if (id === cur.presetId) return;
  if (id) {
    cur.presetId = id;
    const keep = Object.fromEntries(Object.entries(cur.overrides).filter(([k]) => !settingKey(S.tpl, S.tpl.fields.find((f) => f.key === k) || {})));
    cur.overrides = keep;
    S.values = effective(S.tpl, cur);
    S.sizeMode = {};
    renderFields();
  } else { cur.presetId = null; renderFields(); }
  persist();
  undoToast(id ? `Settings from "${presetOf(id).name}"` : 'Preset detached: values unchanged', () => { load(before); persist(); });
}

async function saveIntoPreset() {
  const p = presets.get(cur.presetId);
  if (!p) return;
  const r = await pput(p.id, { rev: p.rev, name: p.name, payload: { v: 1, template: p.template, values: settingValues(S.tpl, S.values) } });
  if (!r.ok) { toast(r.status === 409 ? 'That preset changed on another device: it was reloaded, try again' : 'Couldn\'t save the preset', true); loadPresets(); return; }
  remember(toPreset(r.data));
  cur.overrides = diff();
  tabs.changed(); decorate(); updatePicker();
  toast(`Saved into "${p.name}"`);
}
function newPresetSheet() {
  nameSheet({ title: 'New preset', placeholder: 'Name, e.g. "Fast draft"', hint: `Saves this tab's settings for ${S.tpl.name}.`, save: async (name) => {
    if (!name) throw new Error('Type a name');
    const id = uid() + uid(), t = S.tpl;
    const r = await pput(id, { rev: 0, name: name.slice(0, 120), payload: { v: 1, template: t.id, values: settingValues(t, S.values) } });
    if (!r.ok) throw new Error('Couldn\'t save the preset');
    remember(toPreset(r.data));
    cur.presetId = id; cur.overrides = diff();
    tabs.changed(); renderFields();
    toast(`Preset "${name}" made; this tab uses it`);
  } });
}
function renamePreset(id) {
  const p = presets.get(id);
  nameSheet({ title: 'Rename preset', placeholder: p.name, saveLabel: 'Rename', save: async (name) => {
    if (!name) throw new Error('Type a name');
    const r = await pput(id, { rev: p.rev, name: name.slice(0, 120), payload: { v: 1, template: p.template, values: p.values } });
    if (!r.ok) { loadPresets(); throw new Error(r.status === 409 ? 'Changed on another device: reloaded, try again' : 'Couldn\'t rename'); }
    remember(toPreset(r.data)); updatePicker();
  } });
}

// Point every tab of this project that inherits `from` at `to` (only ids in `only`, if given): the open
// tab in memory, the others by writing their documents. Returns the ids moved.
async function repoint(from, to, only = null) {
  const moved = [];
  await tabs.flush();
  const ep = tabs.epoch;
  let list = [];
  try { list = await api(tabs.url(), { busy: false }); } catch (e) { throw new Error(`Couldn't list the tabs: ${e.message}`); }
  for (const row of list) {
    if (only && !only.includes(row.id)) continue;
    if (row.id === tabs.active?.id) {
      if (cur.presetId === from) { cur.presetId = to; moved.push(row.id); }
      continue;
    }
    let doc = await api(tabs.url(row.id), { busy: false }).catch(() => null);
    for (let tries = 0; doc && doc.payload?.presetId === from && tries < 2; tries++) {
      const r = await tabs.put(row.id, { rev: doc.rev, payload: { ...doc.payload, presetId: to } });
      if (r.ok) { moved.push(row.id); break; }
      doc = r.status === 409 ? r.data?.doc : null;   // saved elsewhere meanwhile: look again
    }
  }
  if (ep === tabs.epoch && moved.includes(tabs.active?.id)) { tabs.changed(); await tabs.flush(); }
  return moved;
}

// Delete: tabs that inherit it keep exactly its settings as a new preset "<name> (kept)", so nothing changes in them.
// Undo restores the preset and points those tabs back at it (the kept copy goes away).
async function deletePreset(id) {
  const p = presets.get(id);
  if (!p) return;
  closeSheet();
  try {
    const used = await countUsers(id);
    let keptId = null;
    if (used) {
      keptId = uid() + uid();
      const r = await pput(keptId, { rev: 0, name: `${p.name} (kept)`.slice(0, 120), payload: { v: 1, template: p.template, values: p.values } });
      if (!r.ok) throw new Error('Couldn\'t keep the settings');
      remember(toPreset(r.data));
    }
    const moved = keptId ? await repoint(id, keptId) : [];
    await api(purl(id), { method: 'DELETE', busy: false });
    presets.delete(id);
    renderFields();
    undoToast(keptId ? `Deleted "${p.name}"; ${moved.length} tab${moved.length === 1 ? '' : 's'} kept its settings as "${p.name} (kept)"` : `Deleted "${p.name}"`, async () => {
      try {
        const doc = await api(purl(id, '/restore'), { method: 'POST', busy: false });
        remember(toPreset(doc));
        if (keptId) {
          await repoint(keptId, id, moved);
          await api(purl(keptId), { method: 'DELETE', busy: false });
          presets.delete(keptId);
        }
        renderFields();
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); loadPresets(); }
}
async function countUsers(id) {
  await tabs.flush();
  let n = cur.presetId === id ? 1 : 0;
  const list = await api(tabs.url(), { busy: false }).catch(() => []);
  for (const row of list) {
    if (row.id === tabs.active?.id) continue;
    const doc = await api(tabs.url(row.id), { busy: false }).catch(() => null);
    if (doc?.payload?.presetId === id) n++;
  }
  return n;
}

const typing = () => !!document.activeElement?.closest?.('#fields') || sheetOpen();
let idle = 0;
function redrawWhenIdle() {
  clearTimeout(idle);
  if (typing()) { idle = setTimeout(redrawWhenIdle, 300); return; }
  renderFields();
}

// ---- live: a preset changed (here or on another device) ----
let pt = 0;
onServer('store', (m) => {
  if (m.kind !== 'gen-presets' || m.scope !== 'project' || (m.project_id ?? null) !== (S.project ?? null) || !tabs.started) return;
  clearTimeout(pt);
  pt = setTimeout(async () => {
    if (!(await loadPresets()) || !tabs.active || !S.tpl) return;
    // the tab's preset moved: its non-overridden settings follow
    const next = effective(S.tpl, cur), moved = Object.keys(next).filter((k) => !eq(next[k], S.values[k]));
    if (!moved.length) return;
    // state follows at once (so edits made meanwhile diff against the right thing); the redraw waits for the user to stop typing
    for (const k of moved) S.values[k] = next[k];
    if (S.tpl.fields.some((f) => moved.includes(f.key) && /^(width|height)$/.test(f.input))) S.sizeMode = {};
    redrawWhenIdle();
  }, 150);
});
onServer('ws_open', () => { if (tabs.started) loadPresets(); });
onProject(() => { presets.clear(); seen.clear(); });
