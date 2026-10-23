// ComfyDeck tablet UI. Plain ES modules, no build step.

const $ = (s) => document.querySelector(s);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opts);
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error((data && data.detail) || text || r.statusText);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 7000 : 2500);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  templates: [], tpl: null,
  values: {}, seedMode: {}, imageMp: {}, imageCrop: {}, sizeMode: {}, loraFolder: {}, builder: {}, lastSeed: {},
  projects: [], project: store.get('deck.project', null),
  batch: 1, connected: false, queueRemaining: 0,
  history: new Map(), historyDone: false,
  myPrompts: new Set(), viewing: null,   // generation currently in the viewer
  executingNode: null, debug: [], debugCounts: {},
};

// ---------------------------------------------------------------------------
// templates + fields
// ---------------------------------------------------------------------------
function stateKey(id) { return `deck.tpl.${id}`; }
function persist() {
  if (!S.tpl) return;
  store.set(stateKey(S.tpl.id), { values: S.values, seedMode: S.seedMode, imageMp: S.imageMp, imageCrop: S.imageCrop, sizeMode: S.sizeMode, loraFolder: S.loraFolder, builder: S.builder });
}

async function loadTemplates(refresh = false) {
  try {
    S.templates = await api('/api/templates' + (refresh ? '?refresh=1' : ''));
  } catch (e) { toast('Could not load templates: ' + e.message, true); S.templates = []; }
  const sel = $('#tplSel');
  sel.replaceChildren(...S.templates.map((t) => h('option', { value: t.id }, t.name + (t.error ? ' (error)' : ''))));
  if (!S.templates.length) {
    $('#fields').replaceChildren(h('div', { class: 'note warn' }, 'No templates yet. Export a workflow from ComfyUI with Workflow → Export (API), tag nodes with @, and put it in the templates/ folder.'));
    return;
  }
  const want = (S.tpl && S.tpl.id) || store.get('deck.tplId', null);
  selectTemplate(S.templates.find((t) => t.id === want) ? want : S.templates[0].id);
}

function selectTemplate(id, overrideValues = null) {
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

function renderFields() {
  const t = S.tpl;
  const notes = [];
  if (t.error) notes.push(h('div', { class: 'note err' }, t.error));
  for (const w of t.warnings) notes.push(h('div', { class: 'note warn' }, w));
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
  $('#fields').replaceChildren(...groups);
  if (!S.snippets) loadSnippets().then(() => renderFields());
}

function setVal(key, v) { S.values[key] = v; persist(); }

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
  const entries = () => [{ id: '', name: 'Template default' }, ...(S.snippets || [])
    .filter((x) => x.category === PRESET_CATEGORY)
    .map((x) => { try { return { ...x, p: JSON.parse(x.text) }; } catch { return null; } })
    .filter((x) => x && groupEntryApplies(x.p, fs, g.label))
    .sort((a, b) => ['workflow', 'model', 'global'].indexOf(a.p.scope) - ['workflow', 'model', 'global'].indexOf(b.p.scope) || a.created - b.created)];
  const stateKey2 = `deck.saved.${S.tpl.id}.${g.label}`;
  const curId = () => String(store.get(stateKey2, ''));
  const label = h('span', { class: 'snip-pos' });
  const show = () => {
    const l = entries(), i = Math.max(0, l.findIndex((x) => String(x.id) === curId()));
    label.textContent = `${i + 1}/${l.length} · ${l[i].name}${l[i].p ? ` · ${scopeName(l[i].p.scope)}` : ''}`;
  };
  const go = (d) => {
    const l = entries(), i = Math.max(0, l.findIndex((x) => String(x.id) === curId()));
    const x = l[(i + d + l.length) % l.length];
    store.set(stateKey2, String(x.id));
    if (x.p) applyGroupEntry(x.p, fs);
    else for (const f of fs) { S.values[f.key] = f.value; delete S.seedMode[f.key]; delete S.sizeMode[f.key]; }
    persist(); renderFields();
  };
  const saveOver = async () => {
    const x = entries().find((y) => String(y.id) === curId());
    if (!x || !x.p) return saveNew();
    try {
      await api('/api/snippets', { method: 'POST', body: { id: x.id, category: PRESET_CATEGORY, name: x.name, text: JSON.stringify(captureGroup(fs, x.p.scope, g.label)) } });
      await loadSnippets(true); show(); toast(`Saved over "${x.name}"`);
    } catch (e) { toast(e.message, true); }
  };
  const saveNew = () => {
    let scope = 'workflow';
    const name = h('input', { type: 'text', placeholder: `Name, e.g. "${g.label} – fast"` });
    const seg = h('div', { class: 'seg' }, SCOPES.map(([k, l]) => h('button', { type: 'button', class: k === scope ? 'on' : '',
      onclick: (e) => { scope = k; [...seg.children].forEach((b) => b.classList.toggle('on', b === e.target)); } }, l)));
    openSheet(h('h3', {}, `Save ${g.label}`),
      h('div', { class: 'hint', style: 'margin-bottom:8px' }, `Saves: ${fs.map((f) => f.label).join(', ')}.`),
      name, seg,
      h('div', { class: 'hint', style: 'margin-top:6px' }, `This workflow: ${S.tpl.name}. This model: ${currentModel() || '(no model setting here)'}. Everywhere: any template with the same kind of node.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        if (scope === 'model' && !currentModel()) return toast('This template has no model setting', true);
        try {
          const r = await api('/api/snippets', { method: 'POST', body: { category: PRESET_CATEGORY, name: name.value.trim() || g.label,
            text: JSON.stringify(captureGroup(fs, scope, g.label)) } });
          store.set(stateKey2, String(r.id));
          await loadSnippets(true); closeSheet(); renderFields(); toast(`Saved "${r.name}"`);
        } catch (e) { toast(e.message, true); }
      } }, 'Save')));
  };
  const del = async () => {
    const x = entries().find((y) => String(y.id) === curId());
    if (!x || !x.p) return toast('The template default can\'t be deleted');
    try { await api(`/api/snippets/${x.id}`, { method: 'DELETE' }); store.set(stateKey2, ''); await loadSnippets(true); renderFields(); toast(`Deleted "${x.name}"`); }
    catch (e) { toast(e.message, true); }
  };
  show();
  return h('div', { class: 'part-head saved-bar' }, h('b', {}, 'Saved'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Previous saved ${g.label}`, onclick: () => go(-1) }, '◀'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Next saved ${g.label}`, onclick: () => go(1) }, '▶'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Save over this ${g.label}`, title: 'Save over this one', onclick: saveOver }, '💾'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Save ${g.label} as new`, title: 'Save as new', onclick: saveNew }, '＋'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete this saved ${g.label}`, onclick: del }, '🗑'),
    label);
}

// A width + height pair on one node renders as a single size picker; everything else as usual.
function groupFieldEls(fs) {
  const out = [];
  for (const f of fs) {
    if (f.kind === 'int' && f.input === 'width') {
      const fh = fs.find((x) => x.node === f.node && x.input === 'height' && x.kind === 'int');
      if (fh) { out.push(sizeField(f, fh)); continue; }
    }
    if (f.kind === 'int' && f.input === 'height' && fs.some((x) => x.node === f.node && x.input === 'width' && x.kind === 'int')) continue;
    out.push(fieldEl(f));
  }
  return out;
}

const ASPECT_PRESETS = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4],
  ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9]];

// Natural size of an input image, for "Match image" (cached; null until loaded)
const imgDims = new Map();
function inputDims(name, onLoad) {
  if (imgDims.has(name)) return imgDims.get(name);
  imgDims.set(name, null);
  const img = new Image();
  img.onload = () => { imgDims.set(name, [img.naturalWidth, img.naturalHeight]); onLoad(); };
  img.src = `/api/input?name=${encodeURIComponent(name)}`;
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
  const mpIn = h('input', { type: 'number', inputMode: 'decimal', min: 0.05, step: 0.05, value: m.mp });
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
  const seg = h('div', { class: 'seg wrap' });
  const draw = () => {
    [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.a === m.aspect));
    const isCustom = m.aspect === 'custom';
    custom.classList.toggle('hidden', !isCustom);
    mpRow.classList.toggle('hidden', isCustom);
    showReadout();
  };
  for (const [k] of [...(imgField ? [['Match image']] : []), ...ASPECT_PRESETS, ['Custom']]) {
    const id = k === 'Custom' ? 'custom' : k === 'Match image' ? 'image' : k;
    seg.append(h('button', { type: 'button', 'data-a': id, onclick: () => { m.aspect = id; applyPreset(); persist(); draw(); } }, k));
  }
  const setMp = (n) => { m.mp = Math.max(0.05, Math.round(n * 100) / 100); mpIn.value = m.mp; applyPreset(); };
  mpIn.addEventListener('change', () => setMp(parseFloat(mpIn.value) || m.mp));
  const mpRow = h('div', { class: 'field' },
    h('label', { class: 'lbl' }, h('span', {}, 'Megapixels'), h('span', {}, `sides snap to ${step}`)),
    h('div', { class: 'stepper' },
      h('button', { type: 'button', onclick: () => setMp(m.mp - 0.05), 'aria-label': 'Fewer megapixels' }, '−'), mpIn,
      h('button', { type: 'button', onclick: () => setMp(m.mp + 0.05), 'aria-label': 'More megapixels' }, '+')),
    h('div', { class: 'seg' }, [0.25, 0.4, 0.5, 1, 2].map((v) => h('button', { type: 'button', onclick: () => setMp(v) }, `${v}`))));
  // custom width/height edits go through numberField's own setVal; keep the readout in step
  custom.addEventListener('change', () => setTimeout(showReadout));
  custom.addEventListener('click', () => setTimeout(showReadout));
  if (m.aspect === 'image') applyPreset();   // the image (or its crop) may have changed since
  draw();
  return h('div', { class: 'field size-field' },
    h('label', { class: 'lbl' }, h('span', {}, 'Size'), readout), seg, mpRow, custom);
}

function numberField(f, isFloat) {
  const step = f.step || (isFloat ? 0.01 : 1);
  const dec = isFloat ? Math.max(0, (String(step).split('.')[1] || '').length) : 0;
  const clamp = (n) => {
    if (Number.isNaN(n)) n = Number(f.value) || 0;
    if (f.min != null) n = Math.max(f.min, n);
    if (f.max != null) n = Math.min(f.max, n);
    return isFloat ? Number(n.toFixed(Math.min(dec, 6))) : Math.round(n);
  };
  const input = h('input', { type: 'number', inputMode: isFloat ? 'decimal' : 'numeric', step, value: S.values[f.key] });
  let range = null;
  const sync = (n, from) => {
    n = clamp(n); setVal(f.key, n);
    if (from !== input) input.value = n;
    if (range && from !== range) range.value = n;
  };
  input.addEventListener('change', () => sync(parseFloat(input.value), input));
  const bump = (dir) => sync(Number(S.values[f.key]) + dir * step, null);
  const hasRange = f.min != null && f.max != null && (f.max - f.min) / step <= 4000 && (f.max - f.min) <= 10000;
  if (hasRange) {
    range = h('input', { type: 'range', min: f.min, max: f.max, step, value: S.values[f.key] });
    range.addEventListener('input', () => sync(parseFloat(range.value), range));
  }
  return h('div', { class: 'field' },
    h('label', { class: 'lbl' }, h('span', {}, f.label), hasRange ? h('span', {}, `${f.min}–${f.max}`) : null),
    h('div', { class: 'stepper' },
      h('button', { type: 'button', onclick: () => bump(-1), 'aria-label': 'Decrease' }, '−'),
      input,
      h('button', { type: 'button', onclick: () => bump(1), 'aria-label': 'Increase' }, '+')),
    range);
}

function seedField(f) {
  const mode = S.seedMode[f.key] || 'random';
  const input = h('input', { type: 'number', inputMode: 'numeric', value: S.values[f.key] });
  input.addEventListener('change', () => { setVal(f.key, Math.max(0, parseInt(input.value || '0', 10))); });
  const seg = h('div', { class: 'seg' });
  const setMode = (m) => { S.seedMode[f.key] = m; persist(); [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.m === m)); };
  for (const [m, label] of [['random', '🎲 Random'], ['fixed', 'Fixed'], ['increment', '+1 each run']]) {
    seg.append(h('button', { type: 'button', 'data-m': m, class: m === mode ? 'on' : '', onclick: () => setMode(m) }, label));
  }
  const last = S.lastSeed[f.key];
  return h('div', { class: 'field', 'data-key': f.key },
    h('label', { class: 'lbl' }, h('span', {}, f.label), h('span', { class: 'last-seed' }, last != null ? `last: ${last}` : '')),
    h('div', { class: 'row' }, input,
      h('button', { type: 'button', class: 'btn small', style: 'flex:none', title: 'Use last seed',
        onclick: () => { if (S.lastSeed[f.key] != null) { input.value = S.lastSeed[f.key]; setVal(f.key, S.lastSeed[f.key]); setMode('fixed'); } } }, '↺ last')),
    seg);
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
  return h('div', { class: 'field' }, h('label', { class: 'lbl' }, f.label), filter, sel);
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
  return h('div', { class: 'field' }, h('label', { class: 'lbl' }, f.label), ta);
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

function isMainPrompt(f) {
  if (f.kind !== 'text' || !f.multiline || /negative/i.test(f.input + ' ' + f.group)) return false;
  const first = (S.tpl?.fields || []).find((x) => x.kind === 'text' && x.multiline && !/negative/i.test(x.input + ' ' + x.group));
  return first && first.key === f.key;
}

async function loadSnippets(force = false) {
  if (S.snippets && !force) return S.snippets;
  try { S.snippets = await api('/api/snippets'); } catch { S.snippets = []; }
  return S.snippets;
}

// Reference tags for this model, numbered from what the template has (image slots, boxes).
function promptTags() {
  const fs = S.tpl?.fields || [];
  const images = Math.max(1, fs.filter((x) => x.kind === 'image').length);
  const boxes = Math.max(1, ...fs.filter((x) => x.kind === 'boxes').map((x) => (S.values[x.key] || []).length));
  const n = (k, from = 1) => Array.from({ length: k }, (_, i) => i + from);
  switch (S.tpl?.tag_style) {
    case 'h3': return [...n(images).map((i) => `<Picture ${i}>`), ...n(3).map((i) => `Subject ${i}`)];
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

// "Subject 1: …" labels are added here, so saved characters stay label-free and fit any slot.
const stripSubjectLabel = (t) => String(t || '').replace(/^\s*subject\s*\d+\s*[:.\-–]\s*/i, '');

function subjectLines(subjects) {
  return subjects.map((x, i) => {
    const text = stripSubjectLabel(x.text).trim().replace(/[.\s]+$/, '');
    if (!text) return '';
    const tag = x.pic ? pictureTag(x.pic) : null;
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
  const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete this saved ${cat.toLowerCase()}`, onclick: async () => {
    const sn = lib()[idx()];
    if (!sn) return;
    try { await api(`/api/snippets/${sn.id}`, { method: 'DELETE' }); await loadSnippets(true); showPos(); toast('Deleted from saved'); }
    catch (e) { toast(e.message, true); }
  } }, '🗑');
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
    const i = idx();
    put(l[i < 0 ? (d > 0 ? 0 : l.length - 1) : (i + d + l.length) % l.length].text);
  };
  const save = async () => {
    const text = clean(get()).trim();
    if (!text) return toast('Nothing to save', true);
    if (idx() >= 0) return toast('Already saved');
    try { await api('/api/snippets', { method: 'POST', body: { category: cat, text } }); await loadSnippets(true); showPos(); toast(`Saved to ${cat}`); }
    catch (e) { toast(e.message, true); }
  };
  showPos();
  const el = h('div', { class: 'prompt-part' },
    h('div', { class: 'part-head' }, h('b', {}, label), pos,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Previous saved ${cat.toLowerCase()}`, onclick: () => step(-1) }, '◀'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Next saved ${cat.toLowerCase()}`, onclick: () => step(1) }, '▶'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Save this ${cat.toLowerCase()}`, onclick: save }, '💾'), del, ...extra),
    ta, below);
  return { el, ta };
}

// One builder for every template (stored on this device), so subjects and parts follow you when you
// switch workflow. Whole builders can be saved as named "prompt sets" on the server.
function builderState() {
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
const saveBuilder = () => store.set('deck.builder', S.pb);
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
    const tags = promptTags().filter((t) => !/^Subject \d+$/.test(t));
    const n = st.on ? Math.max(1, st.subjects.length) : (S.tpl?.tag_style === 'h3' ? 3 : 0);
    for (let i = 1; i <= n; i++) tags.push(`Subject ${i}`);
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
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move subject up', onclick: () => move(-1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move subject down', onclick: () => move(1) }, '↓'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove subject', onclick: () => {
          if (st.subjects.length > 1) st.subjects.splice(i, 1); else st.subjects[0] = { text: '', pic: null };
          sync(); redraw();
        } }, '✕')],
    });
    fixed(ta);
    return el;
  };

  const partEl = (cat) => {
    const { el, ta } = snippetEditor({
      cat, label: cat, placeholder: PART_HINTS[cat] || '', grow: false,
      get: () => st.parts[cat] || '', set: (t) => { st.parts[cat] = t; sync(); },
      extra: [h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Clear ${cat.toLowerCase()}`,
        onclick: () => { ta.value = ''; ta.dispatchEvent(new Event('input')); } }, '✕')],
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
      const i = cur(), j = i < 0 ? (d > 0 ? 0 : l.length - 1) : (i + d + l.length) % l.length;
      try {
        const v = JSON.parse(l[j].text);
        st.parts = v.parts || {}; st.subjects = v.subjects?.length ? v.subjects : [{ text: '', pic: null }];
      } catch { return toast('That saved set is damaged', true); }
      sync(); redraw(); toast(`Loaded "${l[j].name}"`);
    };
    const save = async () => {
      if (cur() >= 0) return toast('Already saved');
      const n = name.value.trim() || stripSubjectLabel(st.subjects[0]?.text || '').split(/\s+/).slice(0, 5).join(' ') || 'Prompt set';
      try { await api('/api/snippets', { method: 'POST', body: { category: SET_CATEGORY, name: n, text: snapshot() } }); await loadSnippets(true); name.value = ''; show(); toast(`Saved set "${n}"`); }
      catch (e) { toast(e.message, true); }
    };
    const del = async () => {
      const sn = sets()[cur()];
      if (!sn) return toast('Load a saved set first');
      try { await api(`/api/snippets/${sn.id}`, { method: 'DELETE' }); await loadSnippets(true); show(); toast('Set deleted'); }
      catch (e) { toast(e.message, true); }
    };
    show();
    return h('div', { class: 'prompt-part sets-bar' },
      h('div', { class: 'part-head' }, h('b', {}, 'Prompt set'), label,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous prompt set', onclick: () => load(-1) }, '◀'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next prompt set', onclick: () => load(1) }, '▶'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete this prompt set', onclick: del }, '🗑')),
      h('div', { class: 'row' }, name, h('button', { type: 'button', class: 'btn small', style: 'flex:none', onclick: save }, '💾 Save set')));
  };

  const draw = () => {
    if (st.on) {
      body.replaceChildren(setsBar(), ...order.flatMap((cat) => cat !== 'Subject' ? [partEl(cat)] : [
        h('div', { class: 'subjects' }, st.subjects.map(subjectEl),
          h('button', { type: 'button', class: 'btn small', onclick: () => { st.subjects.push({ text: '', pic: null }); saveBuilder(); redraw(); } }, '+ Add subject')),
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
  const mode = h('button', { type: 'button', class: 'btn small', onclick: async () => {
    if (!st.on) {
      await loadSnippets();
      // first time: keep what's already written, in "Other"
      const empty = !Object.values(st.parts).some((v) => (v || '').trim()) && !st.subjects.some((x) => (x.text || '').trim());
      if (empty && (S.values[f.key] || '').trim()) st.parts.Other = S.values[f.key];
    }
    st.on = !st.on; saveBuilder(); redraw();
  } });
  if (st.on) loadSnippets().then(draw); else draw();
  return h('div', { class: 'field prompt-field' },
    h('label', { class: 'lbl' }, h('span', {}, f.label), mode), body);
}

const PART_HINTS = {
  Subject: 'Who or what: Subject 1: a woman in her 30s, short red hair, green raincoat…',
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

const thumbUrl = (name, px = 320) => `/api/input?name=${encodeURIComponent(name)}&thumb=${px}`;

function mpInput(get, set) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min: 0, step: 0.05, value: get() });
  input.addEventListener('change', () => {
    const n = Math.max(0, parseFloat(input.value) || 0);
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

function imageField(f) {
  const v = S.values[f.key];
  if (S.imageMp[f.key] == null) S.imageMp[f.key] = 1;
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
    img.src = `/api/input?name=${encodeURIComponent(v)}`;
    try { await img.decode(); } catch { return toast('Could not load the image', true); }
    openCrop({ img, crop: cropped ? cropped.crop : FULL, onApply: (c) => {
      if (c.w > 0.999 && c.h > 0.999) delete S.imageCrop[f.key];
      else S.imageCrop[f.key] = { src: v, crop: c };
      persist(); renderFields();
    } });
  };
  const thumb = h('button', { type: 'button', class: 'thumb', onclick: pick, 'aria-label': 'Choose image' },
    cropped ? cropPreview(thumbUrl(cropped.src, 256), cropped.crop)
      : v ? h('img', { src: thumbUrl(v, 256), alt: v }) : h('span', { class: 'hint' }, '+ image'));
  return h('div', { class: 'field', 'data-key': f.key },
    h('label', { class: 'lbl' }, h('span', {}, f.label),
      h('span', {}, v ? String(v).split('/').pop() + (cropped ? ' · cropped' : '') : 'empty')),
    h('div', { class: 'imgfield' }, thumb,
      h('div', { class: 'actions' },
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: pick }, 'Choose…'),
          v ? h('button', { type: 'button', class: 'btn small', onclick: crop }, 'Crop…') : null,
          h('button', { type: 'button', class: 'btn small', onclick: () => openSketch({ base: v || null, aspect: templateAspect(), onDone: (name) => { setVal(f.key, name); renderFields(); } }) },
            v ? 'Draw on' : 'Draw'),
          v ? h('button', { type: 'button', class: 'btn small', onclick: () => { setVal(f.key, ''); renderFields(); } }, 'Clear') : null),
        mpInput(() => S.imageMp[f.key], (n) => { S.imageMp[f.key] = n; persist(); }))));
}

// ---------------------------------------------------------------------------
// image picker: a gallery of ComfyUI's input images and of history outputs, plus upload.
// Whatever is picked ends up as an image in ComfyUI's input folder, so onPick gets its name.
// multi: keep the sheet open and call onPick for every tap (the editor adds several at once).
// ---------------------------------------------------------------------------
async function openImagePicker({ title, mp = () => 0, onPick, multi = false, extra = null }) {
  let tab = store.get('deck.pickerTab2', 'project');
  let q = '';
  let inputs = null;
  const grid = h('div', { class: 'grid gallery' });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: multi, class: 'hidden' });
  const search = h('input', { type: 'text', placeholder: 'Filter by name…' });
  const seg = h('div', { class: 'seg' });

  const picked = (name, info, card) => {
    if (!multi) { closeSheet(); onPick(name, info); return; }
    onPick(name, info);
    if (card) card.classList.add('picked');
    toast('Added');
  };

  const card = (src, label, onclick, badge) => {
    const c = h('button', { class: 'card' },
      h('div', { class: 'media' }, src, badge ? h('span', { class: 'play' }, badge) : null),
      h('div', { class: 'meta' }, h('span', { class: 'name' }, label)));
    c.addEventListener('click', () => onclick(c));
    return c;
  };
  const inputCard = (n, badge) => card(h('img', { src: thumbUrl(n), alt: n, loading: 'lazy' }), n.split('/').pop(),
    (c) => picked(n, { name: n }, c), badge);

  const fromHistory = async (g, i, c) => {
    try {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST',
        body: { index: i, frame: 'last', mp: mp(), multiple: 16 } });
      picked(r.name, r, c);
    } catch (e) { toast(e.message, true); }
  };

  const loadInputs = async () => {
    if (inputs) return true;
    grid.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try { inputs = await api(`/api/inputs${S.project != null ? `?project_id=${S.project}` : ''}`); return true; }
    catch (e) { grid.replaceChildren(h('div', { class: 'note err' }, e.message)); return false; }
  };

  // This project: its uploads, editor saves and drawings plus everything it generated, newest first
  const drawProject = async () => {
    if (!await loadInputs()) return;
    if (!S.history.size) await loadHistory();
    const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame' };
    const items = inputs.project.filter((r) => r.source !== 'generation')
      .map((r) => ({ t: r.created, el: () => inputCard(r.name, SOURCE[r.source] || null) }));
    for (const g of S.history.values()) {
      if (g.project_id !== S.project || g.status !== 'done') continue;
      g.outputs.forEach((o, i) => {
        if (o.kind !== 'image' && o.kind !== 'video') return;
        items.push({ t: g.finished || g.created, el: () => card(mediaEl(o, { thumb: true }), `#${g.id} ${g.template}`,
          (c) => fromHistory(g, i, c), o.kind === 'video' ? 'last frame' : null) });
      });
    }
    items.sort((x, y) => y.t - x.t);
    grid.replaceChildren(...(items.length ? items.slice(0, 300).map((x) => x.el())
      : [h('div', { class: 'placeholder' }, 'Nothing in this project yet. Upload, draw, or pick from All inputs.')]));
  };

  const drawAll = async () => {
    if (!await loadInputs()) return;
    const list = inputs.all.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 400);
    grid.replaceChildren(...(list.length ? list.map((n) => inputCard(n))
      : [h('div', { class: 'placeholder' }, 'No input images match.')]));
  };

  const draw = () => {
    [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    search.classList.toggle('hidden', tab !== 'all');
    (tab === 'project' ? drawProject : drawAll)();
  };
  const projName = (S.projects.find((p) => p.id === S.project) || {}).name || 'This project';
  for (const [t, label] of [['project', projName], ['all', 'All inputs']]) {
    seg.append(h('button', { type: 'button', 'data-t': t, onclick: () => { tab = t; store.set('deck.pickerTab2', t); draw(); } }, label));
  }
  search.addEventListener('input', () => { q = search.value.toLowerCase(); drawAll(); });

  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const onFiles = async (input) => {
    const files = [...input.files]; input.value = '';
    if (!files.length) return;
    toast(`Uploading ${files.length}…`);
    for (const fl of files) {
      try {
        const r = await uploadImage(fl, { mp: mp(), source: 'upload' });
        inputs = null;
        picked(r.name, r, null);
        if (!multi) return;
      } catch (e) { toast('Upload failed: ' + e.message, true); return; }
    }
    draw();
  };
  file.addEventListener('change', () => onFiles(file));
  camera.addEventListener('change', () => onFiles(camera));

  openSheet(h('h3', {}, title),
    h('div', { class: 'picker-bar' }, seg,
      h('button', { type: 'button', class: 'btn small primary', onclick: () => file.click() }, 'Upload…'),
      h('button', { type: 'button', class: 'btn small', onclick: () => camera.click() }, '📷 Camera'),
      extra ? extra() : null,
      multi ? h('button', { type: 'button', class: 'btn small', onclick: closeSheet }, 'Done') : null),
    search, grid, file, camera);
  draw();
}

// Upload a File/Blob to ComfyUI's input folder, tagged with the open project.
function uploadImage(blob, { mp = 0, source = 'upload', filename = 'image.png' } = {}) {
  const fd = new FormData();
  fd.append('file', blob, blob.name || filename); fd.append('mp', mp); fd.append('multiple', 16);
  fd.append('source', source);
  if (S.project != null) fd.append('project_id', S.project);
  return api('/api/upload', { method: 'POST', form: fd });
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
  const list = h('div', { style: 'display:grid;gap:8px' });
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
      const val = h('span', { style: 'min-width:3.2em;text-align:right' }, Number(l.strength ?? 1).toFixed(2));
      const range = h('input', { type: 'range', min: -2, max: 2, step: 0.05, value: l.strength ?? 1 });
      range.addEventListener('input', () => { val.textContent = Number(range.value).toFixed(2); });
      range.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], strength: parseFloat(range.value) }; setVal(f.key, a); });
      const on = h('input', { type: 'checkbox', checked: l.enabled !== false, title: 'Enabled', style: 'width:26px;height:26px;accent-color:var(--accent)' });
      on.addEventListener('change', () => { const a = [...rows()]; a[i] = { ...a[i], enabled: on.checked }; save(a); });
      return h('div', { class: 'lora-row' + (l.enabled === false ? ' off' : '') },
        h('div', { class: 'top' }, on, sel,
          l.name ? h('button', { type: 'button', class: 'icon-btn info-btn', 'aria-label': 'LoRA info', title: 'Civitai info',
            onclick: () => openLoraInfo(l.name) }, 'i') : null,
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove LoRA', onclick: () => save(rows().filter((_, j) => j !== i)) }, '✕')),
        h('div', { class: 'row' }, range, val));
    }));
  };
  drawChips(); draw();
  return h('div', { class: 'field' },
    h('label', { class: 'lbl' }, h('span', {}, 'LoRA stack'), h('span', {}, f.options.length ? `${f.options.length} available` : 'none found')),
    folders.length ? chips : null,
    list,
    h('button', { type: 'button', class: 'btn small', style: 'margin-top:8px',
      onclick: () => save([...rows(), { name: '', strength: 1, enabled: true }]) }, '+ Add LoRA'));
}

function fieldEl(f) {
  switch (f.kind) {
    case 'text': return textField(f);
    case 'int': return numberField(f, false);
    case 'float': return numberField(f, true);
    case 'seed': return seedField(f);
    case 'choice': return choiceField(f);
    case 'bool': return boolField(f);
    case 'image': return imageField(f);
    case 'loras': return loraField(f);
    case 'boxes': return boxesField(f);
    default: return h('div', { class: 'hint' }, `${f.label}: unsupported`);
  }
}

// ---------------------------------------------------------------------------
// generate / stop
// ---------------------------------------------------------------------------
async function generate(parent = null) {
  if (!S.tpl || S.tpl.error) return toast('Pick a working template first', true);
  const values = {};
  for (const f of S.tpl.fields) {
    let v = S.values[f.key];
    if (f.kind === 'seed') v = (S.seedMode[f.key] || 'random') === 'random' ? -1 : Number(v);
    values[f.key] = v;
  }
  const btn = $('#genBtn'); btn.disabled = true;
  try {
    for (const f of S.tpl.fields) if (f.kind === 'image') values[f.key] = await cropForRun(f, values[f.key]);
    const pf = S.tpl.fields.find(isMainPrompt);
    const builder = pf && builderState().on ? { parts: S.pb.parts, subjects: S.pb.subjects } : null;
    const gens = await api('/api/generate', { method: 'POST', body: { template: S.tpl.id, values, batch: S.batch, project_id: S.project, parent, builder } });
    for (const g of gens) { S.myPrompts.add(g.prompt_id); S.history.set(g.id, g); }
    const lastGen = gens[gens.length - 1];
    for (const f of S.tpl.fields) {
      if (f.kind !== 'seed') continue;
      S.lastSeed[f.key] = lastGen.params[f.key];
      if (S.seedMode[f.key] === 'increment') S.values[f.key] = Number(S.values[f.key]) + S.batch;
    }
    persist(); refreshSeedLabels();
    toast(gens.length > 1 ? `Queued ${gens.length}` : 'Queued');
    keepAwake(true);
  } catch (e) {
    toast(e.message, true);
  } finally { btn.disabled = false; }
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

async function stop() {
  try { await api('/api/interrupt', { method: 'POST' }); toast('Stopping current run'); }
  catch (e) { toast(e.message, true); }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* needs HTTPS on most browsers; harmless if unavailable */ }
}

// ---------------------------------------------------------------------------
// live preview (canvas) + output viewer
// ---------------------------------------------------------------------------
const P = { frames: [], anim: null, idx: 0, last: 0, raf: 0 };
const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d');

function findImageStart(u8) {
  const lim = Math.min(u8.length - 12, 1024);
  for (let i = 0; i < lim; i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) return [i, 'image/jpeg'];
    if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47) return [i, 'image/png'];
    if (u8[i] === 0x52 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46 && u8[i + 3] === 0x46 &&
        u8[i + 8] === 0x57 && u8[i + 9] === 0x45 && u8[i + 10] === 0x42 && u8[i + 11] === 0x50) return [i, 'image/webp'];
  }
  return [-1, null];
}

async function onBinary(buf) {
  const u8 = new Uint8Array(buf);
  const evType = u8.length >= 4 ? new DataView(buf).getUint32(0) : -1;
  const [off, mime] = findImageStart(u8);
  if (off < 0) { logDebug(`binary type=${evType} ${u8.length}B (no image found)`); return; }
  let bmp;
  try { bmp = await createImageBitmap(new Blob([u8.subarray(off)], { type: mime })); } catch { return; }
  // VHS animated previews: [type][1][1][frame index][16-byte node id][jpeg]. Each frame goes in its
  // slot so the clip plays in order; frames refresh in place as sampling goes on.
  const dv = new DataView(buf);
  if (P.anim && off === 32 && dv.getUint32(4) === 1 && dv.getUint32(8) === 1) {
    const i = dv.getUint32(12) % Math.max(1, P.anim.length);
    if (P.frames[i]) P.frames[i].close();
    P.frames[i] = bmp;
  } else {  // a single still preview
    for (const f of P.frames) f?.close();
    P.frames = [bmp]; P.idx = 0;
  }
  showLive();
}

function showLive() {
  canvas.classList.remove('hidden');
  $('#viewer').classList.add('live');  // hides (and pauses) whatever output was showing
  $('#viewerMedia').querySelectorAll('video').forEach((v) => v.pause());
  $('#viewerBadge').classList.remove('hidden');
  if (!P.raf) P.raf = requestAnimationFrame(tick);
}

function tick(t) {
  P.raf = requestAnimationFrame(tick);
  if (!P.frames.length) return;
  const fps = (P.anim && P.anim.rate) || 8;
  if (P.frames.length > 1 && t - P.last < 1000 / fps) return;
  P.last = t;
  // step to the next frame we have, in clip order (slots fill in as the first step arrives)
  let f = null;
  for (let k = 0; k < P.frames.length && !f; k++) {
    P.idx = (P.idx + 1) % P.frames.length;
    f = P.frames[P.idx];
  }
  if (!f) return;
  if (canvas.width !== f.width || canvas.height !== f.height) { canvas.width = f.width; canvas.height = f.height; }
  ctx.drawImage(f, 0, 0);
}

function clearLive() {
  cancelAnimationFrame(P.raf); P.raf = 0;
  for (const f of P.frames) f?.close();
  P.frames = []; P.anim = null; P.idx = 0;
  canvas.classList.add('hidden');
  $('#viewerBadge').classList.add('hidden');
  $('#viewer').classList.remove('live');
}

function mediaEl(o, { controls = true, thumb = false } = {}) {
  if (o.kind === 'video') {
    return h('video', { src: thumb ? `${o.url}#t=0.1` : o.url, muted: true, loop: true, playsInline: true, autoplay: !thumb, controls: controls && !thumb, preload: thumb ? 'metadata' : 'auto' });
  }
  if (o.kind === 'audio') return h('audio', { src: o.url, controls: true });
  if (o.kind === 'image') return h('img', { src: o.url, alt: o.filename, loading: 'lazy' });
  return h('a', { href: o.url, target: '_blank' }, o.filename);
}

function showOutput(g, index = 0) {
  clearLive();
  $('#viewer').classList.remove('live');
  S.viewing = g.id;
  const o = g.outputs[index];
  const box = $('#viewerMedia');
  if (!o) { box.replaceChildren(h('div', { class: 'placeholder' }, g.status === 'error' ? `Error: ${g.error || ''}` : 'No outputs')); return; }
  const el = mediaEl(o);
  if (o.kind === 'image') el.addEventListener('click', () => openGeneration(g.id));
  box.replaceChildren(el);
  const strip = $('#outStrip');
  strip.replaceChildren(...(g.outputs.length > 1 ? g.outputs.map((oo, i) =>
    h('button', { class: 'thumb' + (i === index ? ' sel' : ''), onclick: () => showOutput(g, i) }, mediaEl(oo, { thumb: true }))) : []));
}

function setProgress(value, max, text) {
  $('#progBar').style.width = max ? `${(100 * value) / max}%` : '0';
  $('#progText').textContent = text || '';
}

// ---------------------------------------------------------------------------
// run stages: "Loading models → Encoding prompt → Sampling 13/20 → Decoding → Saving" with timings
// ---------------------------------------------------------------------------
const RUN = { pid: null, stages: [], current: null, title: '', step: null, t0: 0, stageT0: 0, done: new Set(), timer: 0 };

function runStart(pid) {
  Object.assign(RUN, { pid, stages: [], current: null, title: '', step: null, t0: Date.now(), stageT0: Date.now(), done: new Set() });
  clearInterval(RUN.timer);
  RUN.timer = setInterval(runText, 1000);
  drawStages(); runText();
}
function runStages(d) { if (d.prompt_id === RUN.pid) { RUN.stages = d.stages; drawStages(); } }
function runCached(d) {  // nodes ComfyUI reuses from the last run (models already loaded etc.)
  if (d.prompt_id !== RUN.pid) return;
  d.stages.forEach((s) => RUN.done.add(s)); drawStages();
}
function runStage(d) {
  if (d.prompt_id !== RUN.pid) return;
  if (d.stage && d.stage !== RUN.current) {
    if (RUN.current) RUN.done.add(RUN.current);
    // everything before the current stage in the list is finished
    const i = RUN.stages.indexOf(d.stage);
    RUN.stages.slice(0, Math.max(0, i)).forEach((s) => RUN.done.add(s));
    RUN.current = d.stage; RUN.stageT0 = Date.now(); RUN.step = null;
  }
  RUN.title = d.title;
  drawStages(); runText();
}
function runEnd() {
  if (!RUN.pid) return;
  clearInterval(RUN.timer);
  if (RUN.current) RUN.done.add(RUN.current);
  RUN.current = null; drawStages();
  const took = fmtDur((Date.now() - RUN.t0) / 1000);
  RUN.pid = null;
  setProgress(0, 0, `Finished in ${took}`);
  setTimeout(() => { if (!RUN.pid) { $('#stageBar').classList.add('hidden'); setProgress(0, 0, ''); } }, 6000);
}

function runText() {
  if (!RUN.pid) return;
  const total = fmtDur((Date.now() - RUN.t0) / 1000);
  const inStage = fmtDur((Date.now() - RUN.stageT0) / 1000);
  let text, val = 0, max = 0;
  if (!RUN.current) text = `Starting… · ${total}`;
  else if (RUN.step) {
    [val, max] = RUN.step;
    text = `${RUN.current} · ${RUN.title} · step ${val}/${max} · ${inStage}`;
  } else if (RUN.current === 'Sampling') {
    // before the first step ComfyUI is moving the model onto the GPU
    text = `Sampling · loading model onto the GPU… · ${inStage}`;
  } else text = `${RUN.current} · ${RUN.title} · ${inStage}`;
  setProgress(val, max, `${text}  (total ${total})`);
}

function drawStages() {
  const bar = $('#stageBar');
  bar.classList.toggle('hidden', !RUN.stages.length);
  bar.replaceChildren(...RUN.stages.map((s) => h('span', {
    class: 'stg' + (s === RUN.current ? ' on' : RUN.done.has(s) ? ' done' : '') }, RUN.done.has(s) && s !== RUN.current ? `✓ ${s}` : s)));
}

// ---------------------------------------------------------------------------
// websocket
// ---------------------------------------------------------------------------
function nodeName(id) {
  for (const t of S.templates) if (t.node_titles && t.node_titles[id]) return t.node_titles[id].replace(/^@\s*\d*\s*/, '');
  return id;
}

function logDebug(line) {
  S.debug.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (S.debug.length > 300) S.debug.shift();
}

function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { onBinary(e.data); return; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => { setConn(false); setTimeout(connectWS, 2000); };
  setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
}

function setConn(on) {
  S.connected = on;
  $('#connDot').classList.toggle('on', on);
  $('#connDot').title = on ? 'ComfyUI connected' : 'ComfyUI not connected';
}

function onMessage(m) {
  const d = m.data || {};
  S.debugCounts[m.type] = (S.debugCounts[m.type] || 0) + 1;
  switch (m.type) {
    case 'deck_comfy_status': setConn(d.connected); break;
    case 'status': {
      const q = d.status?.exec_info?.queue_remaining ?? 0;
      S.queueRemaining = q;
      $('#queueInfo').textContent = q ? ` · ${q}` : '';
      if (!q) { keepAwake(false); setProgress(0, 0, ''); }
      break;
    }
    case 'execution_start':
      clearLive(); showLive(); setProgress(0, 0, 'Starting…');
      runStart(d.prompt_id);
      $('#viewerMedia').replaceChildren();
      $('#outStrip').replaceChildren();
      break;
    case 'execution_cached': break;
    case 'executing':
      S.executingNode = d.node;
      if (!d.node) runEnd();
      else if (!RUN.pid) setProgress(0, 0, nodeName(d.node));  // no stage info (e.g. an older server)
      break;
    case 'deck_stages': runStages(d); break;
    case 'deck_stage': runStage(d); break;
    case 'deck_cached': runCached(d); break;
    case 'progress':
      RUN.step = [d.value, d.max];
      if (RUN.pid) runText(); else setProgress(d.value, d.max, `${nodeName(d.node || S.executingNode)} · ${d.value}/${d.max}`);
      break;
    case 'VHS_latentpreview': // VideoHelperSuite animated sampler preview metadata
      P.anim = { length: d.length || 1, rate: d.rate || 8 };
      logDebug(`VHS_latentpreview ${JSON.stringify(d)}`);
      break;
    case 'execution_interrupted': runEnd(); break;
    case 'execution_error':
      runEnd();
      toast(`Error in ${d.node_type || 'node'}: ${d.exception_message || ''}`, true);
      break;
    case 'deck_generation': onGeneration(d); break;
    case 'deck_generation_deleted':
      S.history.delete(d.id); renderHistory(); break;
    case 'progress_state': case 'executed': case 'execution_success': break;
    default: logDebug(`${m.type} ${JSON.stringify(d).slice(0, 300)}`);
  }
}

function onGeneration(g) {
  S.history.set(g.id, g);
  // a result that lands while another run is already previewing mustn't take over the viewer
  const busy = RUN.pid && RUN.pid !== g.prompt_id;
  if (g.status === 'done' && S.myPrompts.has(g.prompt_id)) {
    if (busy) toast(`#${g.id} finished (see History)`);
    else { showOutput(g); setProgress(0, 0, ''); }
    try { navigator.vibrate?.(60); } catch { /* not supported */ }
  }
  if (g.status === 'error' && S.myPrompts.has(g.prompt_id) && busy) toast(`#${g.id} failed: ${g.error || ''}`, true);
  else if (g.status === 'error' && S.myPrompts.has(g.prompt_id)) {
    clearLive();
    $('#viewerMedia').replaceChildren(h('div', { class: 'placeholder' }, `Error: ${g.error || ''}`));
  }
  if ($('#tab-history').classList.contains('active')) renderHistory();
  if ($('#tab-board').classList.contains('active') && (g.status === 'done' || 'pinned' in g)) boardChanged(g);
  if (S.sheetGen === g.id && !$('#sheet').classList.contains('hidden')) openGeneration(g.id);
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------
async function loadHistory(more = false) {
  const items = [...S.history.values()].filter((g) => g.project_id === S.project);
  const before = more && items.length ? Math.min(...items.map((g) => g.id)) : null;
  try {
    const rows = await api(`/api/generations?limit=60${S.project != null ? `&project_id=${S.project}` : ''}${before ? `&before=${before}` : ''}`);
    for (const g of rows) S.history.set(g.id, g);
    S.historyDone = rows.length < 60;
  } catch (e) { toast(e.message, true); }
  renderHistory();
}

function renderHistory() {
  const items = [...S.history.values()].filter((g) => g.project_id === S.project).sort((a, b) => b.id - a.id);
  $('#historyGrid').replaceChildren(...(items.length ? items.map(cardEl) : [h('div', { class: 'placeholder' }, 'Nothing generated in this project yet.')]));
  $('#moreHistory').classList.toggle('hidden', S.historyDone || !items.length);
}

function cardEl(g) {
  const o = g.outputs[0];
  return h('button', { class: 'card', onclick: () => openGeneration(g.id) },
    h('div', { class: 'media' },
      o ? mediaEl(o, { thumb: true }) : h('span', { class: 'hint' }, g.status),
      o && o.kind === 'video' ? h('span', { class: 'play' }, '▶ video') : null,
      g.outputs.length > 1 ? h('span', { class: 'play', style: 'left:6px;right:auto' }, `${g.outputs.length}`) : null),
    h('div', { class: 'meta' }, h('span', {}, `#${g.id} ${g.template}`),
      h('span', { class: `badge ${g.status}` }, g.status === 'done' && runTime(g) != null ? fmtDur(runTime(g)) : g.status)));
}

function openSheet(...content) {
  S.sheetGen = null;
  $('#sheet').replaceChildren(
    h('button', { class: 'icon-btn close', onclick: closeSheet, 'aria-label': 'Close' }, '✕'),
    ...content.flat().filter((c) => c != null && c !== false));
  $('#sheet').classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
}
function closeSheet() {
  S.sheetGen = null;
  $('#sheet').querySelectorAll('video').forEach((v) => v.pause());
  $('#sheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden');
}

function openGeneration(id) {
  const g = S.history.get(id);
  if (!g) return;
  let idx = 0;
  const big = h('div', { class: 'media-big' });
  const strip = h('div', { class: 'strip' });
  const draw = () => {
    big.replaceChildren(g.outputs[idx] ? mediaEl(g.outputs[idx]) : h('div', { class: 'placeholder' }, g.error || g.status));
    strip.replaceChildren(...(g.outputs.length > 1 ? g.outputs.map((o, i) =>
      h('button', { class: 'thumb' + (i === idx ? ' sel' : ''), onclick: () => { idx = i; draw(); } }, mediaEl(o, { thumb: true }))) : []));
  };
  draw();
  const t = S.templates.find((x) => x.id === g.template);
  const labelFor = (k) => {
    const f = t && t.fields.find((x) => x.key === k);
    return f ? `${f.group} · ${f.label}` : k;
  };
  const fmt = (v) => Array.isArray(v) && v.length && v[0].generation != null
    ? v.map((c) => `#${c.generation}  ${fmtT(c.start)} → ${c.end != null ? fmtT(c.end) : 'end'}`).join('\n')
    : Array.isArray(v) ? v.filter((l) => l.name && l.enabled !== false).map((l) => `${l.name} @ ${l.strength}`).join('\n') || '—'
    : typeof v === 'string' ? v : JSON.stringify(v);
  const cur = () => g.outputs[idx];
  const isEdit = g.template === 'video edit';  // made in the Video tab: no template, no workflow
  const actions = isEdit ? [] : [
    h('button', { class: 'btn small primary', onclick: () => { reuse(g); closeSheet(); } }, 'Replay & edit'),
    h('button', { class: 'btn small', onclick: () => runAgain(g) }, 'Run again'),
  ];
  if (g.outputs.some((o) => o.kind === 'image' || o.kind === 'video')) {
    actions.push(h('button', { class: 'btn small', onclick: () => sendToInput(g, idx, 'first') }, 'Use as input'));
    actions.push(h('button', { class: 'btn small', title: 'For videos: grab the final frame, e.g. to extend the shot',
      onclick: () => sendToInput(g, idx, 'last') }, 'Use last frame'));
  }
  if (!isEdit) actions.push(h('a', { class: 'btn small', href: `/api/generations/${g.id}/workflow`, style: 'display:grid;place-items:center;text-decoration:none' }, 'Workflow JSON'));
  if (cur()) actions.push(h('a', { class: 'btn small', href: cur().url, download: cur().filename, style: 'display:grid;place-items:center;text-decoration:none' }, 'Download'));
  actions.push(h('button', { class: 'btn small danger', onclick: async () => {
    if (!confirm(`Delete generation #${g.id} and its files?`)) return;
    try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); closeSheet(); } catch (e) { toast(e.message, true); }
  } }, 'Delete'));

  openSheet(
    h('h3', {}, `#${g.id} · ${g.template}`, ' ', h('span', { class: `badge ${g.status}` }, g.status),
      runTime(g) != null ? h('span', { class: 'hint', style: 'margin-left:8px' }, `took ${fmtDur(runTime(g))}`) : null),
    big, strip,
    h('div', { class: 'actions' }, actions),
    g.error ? h('div', { class: 'note err' }, g.error) : null,
    g.parent ? h('div', { class: 'hint' }, `Made from #${g.parent.generation}${g.parent.frame ? ` (${g.parent.frame} frame)` : ''}`) : null,
    h('table', { class: 'params' }, Object.entries(g.params).filter(([k]) => !k.startsWith('__')).map(([k, v]) =>
      h('tr', {}, h('td', {}, labelFor(k)), h('td', { style: 'white-space:pre-wrap' }, fmt(v))))));
  S.sheetGen = g.id;
}

// Load a past generation's settings into Generate to edit: prompt (and its builder parts), seed,
// images, LoRAs, sizes. The seed is set to Fixed so you get the same result until you change it.
function reuse(g) {
  if (!S.templates.find((t) => t.id === g.template)) return toast(`Template "${g.template}" no longer exists`, true);
  const b = g.params.__builder;
  if (b) {
    builderState();
    S.pb = { on: true, parts: { ...(b.parts || {}) }, subjects: (b.subjects || []).map((x) => ({ ...x })) };
    if (!S.pb.subjects.length) S.pb.subjects = [{ text: '', pic: null }];
    saveBuilder();
  } else if (S.pb) { S.pb.on = false; saveBuilder(); }  // written as plain text: show it that way
  selectTemplate(g.template, g.params);
  switchTab('generate');
  if (g.outputs.length) showOutput(g);
  toast(`Loaded #${g.id}'s settings (seed fixed). Edit and Generate.`);
}

// Queue the exact same settings again (same seed), without leaving where you are.
async function runAgain(g) {
  try {
    const values = Object.fromEntries(Object.entries(g.params).filter(([k]) => k !== '__builder'));
    const gens = await api('/api/generate', { method: 'POST', body: { template: g.template, values, batch: 1, project_id: g.project_id,
      parent: g.parent, builder: g.params.__builder || null } });
    for (const n of gens) { S.myPrompts.add(n.prompt_id); S.history.set(n.id, n); }
    toast(`Queued again as #${gens[0].id}`);
  } catch (e) { toast(e.message, true); }
}

async function sendToInput(g, index, frame) {
  const fields = (S.tpl?.fields || []).filter((f) => f.kind === 'image');
  if (!fields.length) return toast('The current template has no @-tagged image input', true);
  const go = async (f) => {
    try {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST',
        body: { index, frame, mp: S.imageMp[f.key] ?? 1, multiple: 16 } });
      S.values[f.key] = r.name; persist(); renderFields();
      S.pendingParent = r.source;
      closeSheet(); switchTab('generate');
      toast(`Set ${f.group} · ${f.label} (${r.width}×${r.height})`);
    } catch (e) { toast(e.message, true); }
  };
  if (fields.length === 1) return go(fields[0]);
  openSheet(h('h3', {}, 'Send to which image input?'),
    h('div', { class: 'actions' }, fields.map((f) => h('button', { class: 'btn', onclick: () => go(f) }, `${f.group} · ${f.label}`))));
}

// ---------------------------------------------------------------------------
// sketch pad: draw an image (e.g. the source for image-to-image) with a pen or finger.
// Pen pressure sets the stroke width. Once a pen touches the canvas, finger touches are ignored
// (palm rejection) until "Pen only" is switched off.
// ---------------------------------------------------------------------------
const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#f8bbd0', '#90caf9'];

function openSketch({ base = null, aspect = 1, onDone }) {
  const st = { tool: 'pen', color: store.get('deck.sketch.color', '#000000'), size: store.get('deck.sketch.size', 12),
    penOnly: false, bg: '#ffffff', undo: [], redo: [] };
  const cv = h('canvas', { class: 'sketch-canvas' });
  const stage = h('div', { class: 'sketch-stage' }, cv);
  const ctx2 = cv.getContext('2d', { willReadFrequently: true });

  const resize = (a) => {  // ~1 MP at the chosen aspect, sides a multiple of 16
    const w = Math.round(Math.sqrt(1e6 * a) / 16) * 16, hh = Math.round(Math.sqrt(1e6 / a) / 16) * 16;
    cv.width = w; cv.height = hh;
    ctx2.fillStyle = st.bg; ctx2.fillRect(0, 0, w, hh);
    sizeInfo.textContent = `${w}×${hh}`;
    fit();
  };
  // show the whole canvas at the largest size that fits the stage, keeping its aspect
  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 20) / cv.width, (r.height - 20) / cv.height);
    cv.style.width = `${Math.floor(cv.width * k)}px`; cv.style.height = `${Math.floor(cv.height * k)}px`;
  };
  const snapshot = () => {
    st.undo.push(ctx2.getImageData(0, 0, cv.width, cv.height));
    if (st.undo.length > 15) st.undo.shift();
    st.redo = [];
  };
  const restore = (from, to) => {
    if (!from.length) return;
    to.push(ctx2.getImageData(0, 0, cv.width, cv.height));
    const img = from.pop();
    if (img.width !== cv.width || img.height !== cv.height) { cv.width = img.width; cv.height = img.height; fit(); }
    ctx2.putImageData(img, 0, 0);
  };

  // drawing
  let stroke = null;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  const width = (e) => st.size * (e.pointerType === 'pen' ? 0.15 + 0.85 * (e.pressure || 0.5) : 1);
  const segment = (from, to, w) => {
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.strokeStyle = st.tool === 'eraser' ? st.bg : st.color;
    ctx2.lineWidth = w; ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
    ctx2.beginPath(); ctx2.moveTo(...from); ctx2.lineTo(...to); ctx2.stroke();
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') { st.penOnly = true; penBtn.classList.add('on'); }
    if (st.penOnly && e.pointerType === 'touch') return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    snapshot();
    stroke = { id: e.pointerId, last: pos(e) };
    ctx2.fillStyle = st.tool === 'eraser' ? st.bg : st.color;  // a tap leaves a dot
    ctx2.beginPath(); ctx2.arc(...stroke.last, width(e) / 2, 0, Math.PI * 2); ctx2.fill();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (coalesced.length ? coalesced : [e])) {
      const p = pos(ev);
      segment(stroke.last, p, width(ev));
      stroke.last = p;
    }
  });
  const end = (e) => { if (stroke && e.pointerId === stroke.id) stroke = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  // toolbar
  const toolSeg = h('div', { class: 'seg' });
  for (const [t, label] of [['pen', '✎ Pen'], ['eraser', '⌫ Eraser']]) {
    toolSeg.append(h('button', { type: 'button', 'data-t': t, class: t === st.tool ? 'on' : '',
      onclick: () => { st.tool = t; [...toolSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); } }, label));
  }
  const colorIn = h('input', { type: 'color', value: st.color });
  const setColor = (c) => {
    st.color = c; colorIn.value = c; store.set('deck.sketch.color', c);
    if (st.tool === 'eraser') toolSeg.children[0].click();
  };
  colorIn.addEventListener('input', () => setColor(colorIn.value));
  const swatches = h('div', { class: 'swatches' }, SWATCHES.map((c) =>
    h('button', { type: 'button', style: `background:${c}`, 'aria-label': `Colour ${c}`, onclick: () => setColor(c) })));
  const sizeVal = h('span', { class: 'hint' }, `${st.size}px`);
  const sizeIn = h('input', { type: 'range', min: 1, max: 120, step: 1, value: st.size });
  sizeIn.addEventListener('input', () => { st.size = Number(sizeIn.value); sizeVal.textContent = `${st.size}px`; store.set('deck.sketch.size', st.size); });
  const penBtn = h('button', { type: 'button', class: 'btn small toggle-btn', title: 'Ignore finger touches while drawing',
    onclick: () => { st.penOnly = !st.penOnly; penBtn.classList.toggle('on', st.penOnly); } }, 'Pen only');
  const sizeInfo = h('span', { class: 'hint' });
  const aspSeg = h('div', { class: 'seg wrap' }, ASPECT_PRESETS.map(([k, a]) => h('button', { type: 'button',
    onclick: () => { snapshot(); resize(a); } }, k)));

  const overlay = h('div', { class: 'sketch' },
    h('div', { class: 'sketch-bar' },
      toolSeg, swatches, colorIn,
      h('label', { class: 'sketch-size' }, 'Size', sizeIn, sizeVal),
      penBtn,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', onclick: () => restore(st.undo, st.redo) }, '↶'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', onclick: () => restore(st.redo, st.undo) }, '↷'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { snapshot(); ctx2.fillStyle = st.bg; ctx2.fillRect(0, 0, cv.width, cv.height); } }, 'Clear'),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => overlay.remove() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn small primary', onclick: async (e) => {
        e.target.disabled = true;
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        try {
          const r = await uploadImage(blob, { source: 'drawing', filename: 'drawing.png' });
          overlay.remove(); onDone(r.name, r);
        } catch (err) { toast('Save failed: ' + err.message, true); e.target.disabled = false; }
      } }, 'Use drawing')),
    stage,
    h('div', { class: 'sketch-foot' }, h('span', { class: 'hint' }, 'Canvas'), aspSeg, sizeInfo));
  document.body.append(overlay);
  new ResizeObserver(fit).observe(stage);

  resize(aspect);
  if (base) {  // draw over an existing image: canvas takes its aspect
    const img = new Image();
    img.onload = () => {
      resize(img.naturalWidth / img.naturalHeight);
      ctx2.drawImage(img, 0, 0, cv.width, cv.height);
    };
    img.src = `/api/input?name=${encodeURIComponent(base)}`;
  }
}

// Aspect of the current template's output size, so a drawing matches what will be generated.
function templateAspect() {
  const fs = S.tpl?.fields || [];
  const w = fs.find((f) => f.input === 'width'), hh = w && fs.find((f) => f.node === w.node && f.input === 'height');
  return w && hh ? Number(S.values[w.key]) / Number(S.values[hh.key]) : 1;
}

// ---------------------------------------------------------------------------
// editor: crop images and join them into one (character sheets, side-by-side refs).
// Everything is drawn client-side on a canvas, then uploaded as a new input image.
// ---------------------------------------------------------------------------
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const E = {
  layers: [],   // { name, crop: {x,y,w,h} as fractions, img }
  layout: 'row', cols: 2, gap: 0, bg: '#000000', mp: 0,
  ...store.get('deck.editor', {}),
};
E.layers = (E.layers || []).map((l) => ({ name: l.name, crop: l.crop || { ...FULL }, scale: l.scale || null }));

function persistEditor() {
  store.set('deck.editor', { layout: E.layout, cols: E.cols, gap: E.gap, bg: E.bg, mp: E.mp,
    layers: E.layers.map((l) => ({ name: l.name, crop: l.crop, scale: l.scale })) });
}

function loadLayerImage(l) {
  if (l.img) return;
  l.img = new Image();
  l.img.onload = () => drawEditorCanvas();
  l.img.onerror = () => { l.broken = true; renderEditor(); };
  l.img.src = `/api/input?name=${encodeURIComponent(l.name)}`;
}

// Layout: images go into rows of `cols`. Images left on "match" share one height in a row (the
// smallest of them, so nothing is upscaled); "column" stacks them at a shared width instead. An
// image with its own scale keeps its proportions at that fraction of its (cropped) pixels, e.g. to
// keep a detailed reference sharp. Rows and stacked images are centred on the background.
function composeEditor(target) {
  const src = E.layers.filter((l) => l.img && l.img.naturalWidth).map((l) => {
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
    return { img: l.img, sx: c.x * W, sy: c.y * H, sw: Math.max(1, c.w * W), sh: Math.max(1, c.h * H), scale: l.scale };
  });
  if (!src.length) return false;
  const gap = Math.max(0, E.gap | 0);
  const matched = src.filter((s) => !s.scale);
  const ref = matched.length ? matched : src;
  const own = (s) => ({ w: Math.max(1, Math.round(s.sw * s.scale)), h: Math.max(1, Math.round(s.sh * s.scale)) });
  const ctx2 = target.getContext('2d');
  if (E.layout === 'column') {
    const w = Math.round(Math.min(...ref.map((s) => s.sw)));
    const sizes = src.map((s) => (s.scale ? own(s) : { w, h: Math.round((s.sh * w) / s.sw) }));
    target.width = Math.max(...sizes.map((z) => z.w));
    target.height = sizes.reduce((a, z) => a + z.h, 0) + gap * (src.length - 1);
    ctx2.fillStyle = E.bg; ctx2.fillRect(0, 0, target.width, target.height);
    let y = 0;
    src.forEach((s, i) => {
      const z = sizes[i];
      ctx2.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, Math.round((target.width - z.w) / 2), y, z.w, z.h);
      y += z.h + gap;
    });
    return true;
  }
  const cols = E.layout === 'row' ? src.length : Math.max(1, E.cols | 0);
  const rowH = Math.round(Math.min(...ref.map((s) => s.sh)));
  const sizes = src.map((s) => (s.scale ? own(s) : { w: Math.round((s.sw * rowH) / s.sh), h: rowH }));
  const rows = [];
  for (let i = 0; i < src.length; i += cols) rows.push(src.slice(i, i + cols).map((s, k) => ({ s, z: sizes[i + k] })));
  const rowHs = rows.map((r) => Math.max(...r.map((e) => e.z.h)));
  const rowW = rows.map((r) => r.reduce((a, e) => a + e.z.w, 0) + gap * (r.length - 1));
  target.width = Math.max(...rowW);
  target.height = rowHs.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
  ctx2.fillStyle = E.bg; ctx2.fillRect(0, 0, target.width, target.height);
  let y = 0;
  rows.forEach((r, ri) => {
    let x = Math.round((target.width - rowW[ri]) / 2);
    for (const { s, z } of r) {
      ctx2.drawImage(s.img, s.sx, s.sy, s.sw, s.sh, x, y + Math.round((rowHs[ri] - z.h) / 2), z.w, z.h);
      x += z.w + gap;
    }
    y += rowHs[ri] + gap;
  });
  return true;
}

function drawEditorCanvas() {
  const cv = $('#editorCanvas');
  const ok = composeEditor(cv);
  cv.classList.toggle('hidden', !ok);
  $('#editorEmpty').classList.toggle('hidden', ok);
  $('#editorSize').textContent = ok ? `${cv.width}×${cv.height} · ${(cv.width * cv.height / 1e6).toFixed(2)} MP` : '';
}

function renderEditor() {
  E.layers.forEach(loadLayerImage);
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= E.layers.length) return;
    [E.layers[i], E.layers[j]] = [E.layers[j], E.layers[i]];
    persistEditor(); renderEditor();
  };
  const layerRows = E.layers.map((l, i) => {
    const cropped = l.crop.w < 0.999 || l.crop.h < 0.999;
    return h('div', { class: 'layer-row' + (l.broken ? ' off' : '') },
      h('button', { type: 'button', class: 'thumb', onclick: () => cropLayer(l) }, h('img', { src: thumbUrl(l.name, 160), alt: '' })),
      h('div', { class: 'layer-name' }, h('span', {}, l.name.split('/').pop()),
        h('span', { class: 'hint' }, l.broken ? 'could not load' : cropped ? 'cropped' : 'full image')),
      h('div', { class: 'layer-btns' },
        h('button', { type: 'button', class: 'btn small', onclick: () => cropLayer(l) }, 'Crop'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move earlier', onclick: () => move(i, -1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move later', onclick: () => move(i, 1) }, '↓'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { E.layers.splice(i, 1); persistEditor(); renderEditor(); } }, '✕')),
      layerSize(l));
  });

  const seg = h('div', { class: 'seg' });
  for (const [m, label] of [['row', 'Side by side'], ['column', 'Stacked'], ['grid', 'Grid']]) {
    seg.append(h('button', { type: 'button', class: E.layout === m ? 'on' : '',
      onclick: () => { E.layout = m; persistEditor(); renderEditor(); } }, label));
  }
  const num = (label, key, min, max, step = 1) => {
    const input = h('input', { type: 'number', inputMode: 'numeric', min, max, step, value: E[key] });
    input.addEventListener('change', () => {
      E[key] = Math.min(max, Math.max(min, parseFloat(input.value) || 0)); input.value = E[key];
      persistEditor(); drawEditorCanvas();
    });
    return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input);
  };
  const bg = h('input', { type: 'color', value: E.bg });
  bg.addEventListener('input', () => { E.bg = bg.value; persistEditor(); drawEditorCanvas(); });

  $('#editorPanel').replaceChildren(
    h('div', { class: 'group-body flat' },
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: addEditorImages }, '+ Add images'),
        E.layers.length ? h('button', { type: 'button', class: 'btn ghost', style: 'flex:none',
          onclick: () => { E.layers = []; persistEditor(); renderEditor(); } }, 'Clear all') : null),
      layerRows.length ? h('div', { class: 'layers' }, layerRows)
        : h('div', { class: 'hint' }, 'Add images from your inputs, generations or device. Tap one to crop it.'),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Layout'), seg),
      h('div', { class: 'row', style: 'align-items:end' },
        E.layout === 'grid' ? num('Columns', 'cols', 1, 12) : null,
        num('Gap (px)', 'gap', 0, 400),
        h('label', { class: 'field', style: 'flex:none' }, h('span', { class: 'lbl' }, 'Background'), bg)),
      h('div', { class: 'field' }, mpInput(() => E.mp, (n) => { E.mp = n; persistEditor(); })),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: saveEditor }, 'Save as input'),
        h('button', { type: 'button', class: 'btn', onclick: downloadEditor }, 'Download'))));
  drawEditorCanvas();
}

// Per image: match the others' height (width when stacked), or keep a fraction of its own pixels
const LAYER_SCALES = [[null, 'Match others'], [0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, '100% (original)'], [1.5, '150%'], [2, '200%']];
function layerSize(l) {
  const sel = h('select', { 'aria-label': 'Size' }, LAYER_SCALES.map(([v, label]) =>
    h('option', { value: v ?? '', selected: (l.scale || null) === v }, label)));
  const W = l.img && l.img.naturalWidth, H = l.img && l.img.naturalHeight;
  const px = W && l.scale ? `${Math.round(W * l.crop.w * l.scale)}×${Math.round(H * l.crop.h * l.scale)} px`
    : E.layout === 'column' ? 'same width as the others' : 'same height as the others';
  sel.addEventListener('change', () => { l.scale = sel.value ? Number(sel.value) : null; persistEditor(); renderEditor(); });
  return h('label', { class: 'layer-size' }, h('span', { class: 'hint' }, 'Size'), sel, h('span', { class: 'hint' }, px));
}

function addEditorImages() {
  openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => {
    E.layers.push({ name, crop: { ...FULL } }); persistEditor(); renderEditor();
  } });
}

function editorBlob() {
  const cv = document.createElement('canvas');
  if (!composeEditor(cv)) return Promise.resolve(null);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

async function saveEditor() {
  const blob = await editorBlob();
  if (!blob) return toast('Add some images first', true);
  try {
    const r = await uploadImage(blob, { mp: E.mp, source: 'editor', filename: 'editor.png' });
    useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
  } catch (e) { toast('Save failed: ' + e.message, true); }
}

async function downloadEditor() {
  const blob = await editorBlob();
  if (!blob) return toast('Add some images first', true);
  const a = h('a', { href: URL.createObjectURL(blob), download: `comfydeck_${Date.now()}.png` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Offer the saved image to one of the current template's image inputs.
function useInGenerate(name, msg) {
  const fields = (S.tpl?.fields || []).filter((f) => f.kind === 'image');
  const go = (f) => {
    S.values[f.key] = name; persist(); renderFields(); closeSheet(); switchTab('generate');
    toast(`Set ${f.group} · ${f.label}`);
  };
  openSheet(h('h3', {}, msg),
    h('div', { class: 'media-big' }, h('img', { src: `/api/input?name=${encodeURIComponent(name)}`, alt: '' })),
    h('div', { class: 'hint', style: 'margin-top:8px' }, `It's now in your input images as ${name}.`),
    fields.length ? h('div', { class: 'actions' }, fields.map((f) =>
      h('button', { class: 'btn small', onclick: () => go(f) }, `Use for ${f.group} · ${f.label}`))) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn small ghost', onclick: closeSheet }, 'Keep editing')));
}

const ASPECTS = [['Free', null], ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9]];

function cropLayer(layer) {
  if (!layer.img || !layer.img.naturalWidth) return toast('Image still loading', true);
  openCrop({ img: layer.img, crop: layer.crop, onApply: (c) => { layer.crop = c; persistEditor(); renderEditor(); } });
}

// Crop popup for a loaded image; onApply gets {x,y,w,h} as fractions of it.
function openCrop({ img, crop = FULL, onApply }) {
  const W = img.naturalWidth, H = img.naturalHeight;
  let c = { ...crop };
  let aspect = null;   // width/height in pixels, null = free
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const box = h('div', { class: 'crop-box' }, ['nw', 'ne', 'sw', 'se'].map((k) => h('span', { class: `handle ${k}`, 'data-h': k })));
  const wrap = h('div', { class: 'crop-wrap' }, h('img', { src: img.src, draggable: false, alt: '' }), box);
  const info = h('span', { class: 'hint' });
  const draw = () => {
    Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
    info.textContent = `${Math.round(c.w * W)}×${Math.round(c.h * H)} px`;
  };
  // rectangle from a fixed corner (fx,fy) to the pointer, respecting the aspect lock and image bounds
  const span = (fx, fy, px, py) => {
    let w = Math.abs(px - fx), hh = Math.abs(py - fy);
    if (aspect) {
      const maxW = px < fx ? fx : 1 - fx, maxH = py < fy ? fy : 1 - fy;
      hh = (w * W) / (aspect * H);
      if (hh > maxH) { hh = maxH; w = (hh * aspect * H) / W; }
      if (w > maxW) { w = maxW; hh = (w * W) / (aspect * H); }
    }
    w = Math.max(w, 0.02); hh = Math.max(hh, 0.02);
    return { x: px < fx ? fx - w : fx, y: py < fy ? fy - hh : fy, w, h: hh };
  };
  const setAspect = (a) => {
    aspect = a;
    if (a) {   // largest centred box with that aspect
      let w = 1, hh = W / (a * H);
      if (hh > 1) { hh = 1; w = (a * H) / W; }
      c = { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
    }
    [...aspSeg.children].forEach((b) => b.classList.toggle('on', b.dataset.a === String(a)));
    draw();
  };
  const aspSeg = h('div', { class: 'seg wrap' }, ASPECTS.map(([label, a]) =>
    h('button', { type: 'button', 'data-a': String(a), class: a === null ? 'on' : '', onclick: () => setAspect(a) }, label)));

  let drag = null;
  const pt = (e) => { const r = wrap.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault(); wrap.setPointerCapture(e.pointerId);
    const p = pt(e), hk = e.target.dataset && e.target.dataset.h;
    if (hk) drag = { fx: hk.includes('w') ? c.x + c.w : c.x, fy: hk.includes('n') ? c.y + c.h : c.y };
    else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) drag = { move: true, p0: p, c0: { ...c } };
    else drag = { fx: p.x, fy: p.y };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e);
    if (drag.move) {
      c.x = Math.min(1 - c.w, Math.max(0, drag.c0.x + p.x - drag.p0.x));
      c.y = Math.min(1 - c.h, Math.max(0, drag.c0.y + p.y - drag.p0.y));
    } else c = span(drag.fx, drag.fy, p.x, p.y);
    draw();
  });
  const end = () => { drag = null; };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);

  openSheet(h('h3', {}, 'Crop'), aspSeg,
    h('div', { class: 'crop-stage' }, wrap),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small primary', onclick: () => { closeSheet(); onApply(c); } }, 'Apply'),
      h('button', { class: 'btn small', onclick: () => { c = { ...FULL }; setAspect(null); } }, 'Reset'),
      h('button', { class: 'btn small ghost', onclick: closeSheet }, 'Cancel'), info));
  draw();
}

// ---------------------------------------------------------------------------
// video: a Premiere-style timeline. Video tracks stack (V2 draws over V1), audio tracks mix, and
// clips that overlap on one track cross-fade. The preview composites the clips on a canvas;
// Export sends the same timeline to the server, which renders it with ffmpeg into History.
// ---------------------------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2, 10);
const HEAD_W = 84;    // track header column (px)
const LANE_H = 52;
const MIN_LEN = 0.1;
const V = {
  tracks: [], items: [], size: null, fps: 0, pps: 40,   // pps: timeline zoom, pixels per second
  t: 0, playing: false, clock: 0, loop: store.get('deck.video.loop', false), sel: null,
  els: new Map(), posters: new Map(), waves: new Map(),
};
const fmtT = (t) => `${Number(t || 0).toFixed(2)}s`;

function newItem({ kind, src, url, label, thumb = null, dur = 0 }, track) {
  return { id: uid(), track, kind, src, url, label, thumb, dur, at: 0, in: 0, out: kind === 'image' ? 3 : dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
}

(function loadTimeline() {
  const saved = store.get('deck.timeline', null);
  if (saved) Object.assign(V, { tracks: saved.tracks || [], items: saved.items || [], size: saved.size || null, fps: saved.fps || 0, pps: saved.pps || 40 });
  else {   // the old one-track clip list
    let at = 0;
    for (const c of store.get('deck.video', [])) {
      const it = newItem({ kind: 'video', src: { generation: c.generation, index: c.index }, url: c.url, label: c.label, dur: c.duration || 0 }, 'v1');
      Object.assign(it, { at, in: c.start || 0, out: c.end ?? (c.duration || null) });
      at += (it.out ?? 3) - it.in;
      V.items.push(it);
    }
  }
  if (!V.tracks.length) V.tracks = [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }];
})();

function persistTimeline() {
  store.set('deck.timeline', { tracks: V.tracks, items: V.items, size: V.size, fps: V.fps, pps: V.pps });
}

const itLen = (it) => Math.max(MIN_LEN, (it.out ?? (it.dur || 3)) - it.in);
const itEnd = (it) => it.at + itLen(it);
const trackOf = (it) => V.tracks.find((t) => t.id === it.track);
const tracksOf = (kind) => V.tracks.filter((t) => t.kind === kind);   // video: V1 (bottom) first
const trackName = (t) => `${t.kind === 'video' ? 'V' : 'A'}${tracksOf(t.kind).indexOf(t) + 1}`;
const zOf = (it) => tracksOf('video').findIndex((t) => t.id === it.track);
const seqEnd = () => V.items.reduce((m, it) => Math.max(m, itEnd(it)), 0);
const isVisual = (it) => it.kind === 'video' || it.kind === 'image';
const selItem = () => V.items.find((i) => i.id === V.sel) || null;
const fpsNow = () => V.fps || 24;
const tc = (t) => {
  const f = fpsNow(), m = Math.floor(t / 60), s = Math.floor(t % 60), fr = Math.min(f - 1, Math.floor((t % 1) * f + 1e-6));
  return `${m}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
};

// Overlap with the clip before (xin) and after (xout) it on the same track: the later clip fades
// in over the overlap; sound also fades the earlier one out. Mirrors videoedit._overlaps.
function xfades(it) {
  let xin = 0, xout = 0;
  for (const o of V.items) {
    if (o === it || o.track !== it.track) continue;
    if (o.at < it.at || (o.at === it.at && V.items.indexOf(o) < V.items.indexOf(it))) xin = Math.max(xin, Math.min(itEnd(o) - it.at, itLen(it), itLen(o)));
    else xout = Math.max(xout, Math.min(itEnd(it) - o.at, itLen(it), itLen(o)));
  }
  return { xin, xout };
}

function fadeGain(it, t, audio) {
  const local = t - it.at, len = itLen(it), { xin, xout } = xfades(it);
  const fi = Math.max(it.fadeIn || 0, xin), fo = Math.max(it.fadeOut || 0, audio ? xout : 0);
  let g = 1;
  if (fi > 0 && local < fi) g = Math.min(g, local / fi);
  if (fo > 0 && len - local < fo) g = Math.min(g, (len - local) / fo);
  return Math.max(0, Math.min(1, g));
}

// ---- playback: one media element per clip, kept in step with the timeline clock ----
// Preloading: each video/sound on the timeline is downloaded whole into memory (a blob: URL), so
// playback never waits on the network to start or seek. Until then clips stream from the server.
const blobs = new Map();   // url -> { state: 'loading' | 'ready' | 'failed', src }
let preloadQueue = [], preloading = 0;
const srcFor = (it) => (blobs.get(it.url)?.state === 'ready' ? blobs.get(it.url).src : it.url);

function preloadMedia() {
  const urls = new Set(V.items.filter((it) => it.kind !== 'image').map((it) => it.url));
  for (const [url, b] of blobs) {   // free what's no longer on the timeline
    if (urls.has(url)) continue;
    if (b.src) URL.revokeObjectURL(b.src);
    blobs.delete(url);
  }
  for (const url of urls) if (!blobs.has(url)) { blobs.set(url, { state: 'loading' }); preloadQueue.push(url); }
  while (preloading < 2 && preloadQueue.length) {
    const url = preloadQueue.shift();
    preloading++;
    fetch(url).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
      .then((b) => { if (blobs.has(url)) blobs.set(url, { state: 'ready', src: URL.createObjectURL(b) }); })
      .catch(() => { if (blobs.has(url)) blobs.set(url, { state: 'failed' }); })
      .finally(() => { preloading--; preloadMedia(); showPreload(); if (!V.playing) { syncMedia(); requestDraw(); } });
  }
  showPreload();
}

function showPreload() {
  const all = [...blobs.values()], done = all.filter((b) => b.state !== 'loading').length;
  const el = $('#vidLoad');
  if (el) el.textContent = done < all.length ? `Loading ${done}/${all.length}…` : '';
}

function mediaFor(it) {
  const m = V.els.get(it.id), src = srcFor(it);
  // switch to the downloaded copy only while stopped, so it can't flicker mid-playback
  if (m && (m.src === src || (V.playing && m.url === it.url))) return m.el;
  if (m && m.el.pause) m.el.pause();
  let el;
  if (it.kind === 'image') { el = new Image(); el.onload = requestDraw; }
  else {
    el = document.createElement(it.kind === 'audio' ? 'audio' : 'video');
    Object.assign(el, { preload: 'auto', playsInline: true, muted: true });
    el.addEventListener('loadeddata', requestDraw);
    el.addEventListener('seeked', requestDraw);
    el.addEventListener('loadedmetadata', () => gotDuration(it, el.duration));
  }
  el.src = src;
  V.els.set(it.id, { el, url: it.url, src });
  return el;
}

function gotDuration(it, d) {
  if (!isFinite(d) || !d || it.dur === d) return;
  it.dur = d;
  if (it.out == null || it.out > d) it.out = d;
  persistTimeline(); renderTimeline();
}

function pruneEls() {
  for (const [id, m] of V.els) {
    if (V.items.some((i) => i.id === id)) continue;
    if (m.el.pause) m.el.pause();
    m.el.removeAttribute('src');
    V.els.delete(id);
  }
}

function syncMedia() {
  for (const it of V.items) {
    if (it.kind === 'image') { mediaFor(it); continue; }
    const el = mediaFor(it), tr = trackOf(it);
    if (V.t < it.at || V.t >= itEnd(it)) {
      if (!el.paused) el.pause();
      // cue up a clip that's about to start so it begins cleanly
      if (it.at > V.t && it.at - V.t < 4 && !el.seeking && Math.abs(el.currentTime - it.in) > 0.05) el.currentTime = it.in;
      continue;
    }
    const want = it.in + V.t - it.at;
    el.muted = !!(tr && tr.muted) || !(it.volume > 0) || starting.get(el) === 'muted';
    el.volume = Math.min(1, (it.volume ?? 1) * fadeGain(it, V.t, true));
    if (V.playing) {
      if (el.paused) startMedia(el, want);
      else if (it.id !== V.master && Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.01) el.currentTime = want;
    }
  }
}

// Start a clip once (no re-seeking every frame while play() is pending, which is what made the
// preview flash black). Tablets can refuse to start sound outside a tap; then it plays muted.
const starting = new WeakMap();   // el -> 'pending' | 'muted' | time of a failed start
function startMedia(el, want) {
  const st = starting.get(el);
  if (st === 'pending' || (typeof st === 'number' && performance.now() - st < 1000)) return;
  if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
  starting.set(el, 'pending');
  el.play().then(() => starting.delete(el), () => {
    el.muted = true;
    return el.play().then(() => starting.set(el, 'muted'));
  }).catch(() => starting.set(el, performance.now()));
}

// Called from the Play tap: touch every clip's media while the tap still counts as a user gesture,
// so the clips that start later are allowed to play with sound.
function unlockMedia() {
  for (const it of V.items) {
    if (it.kind === 'image') continue;
    const el = mediaFor(it);
    if (!el.paused || starting.get(el) === 'pending') continue;
    if (starting.get(el) === 'muted') starting.delete(el);
    const muted = el.muted;
    el.muted = false;
    el.play().catch(() => {});
    el.pause();
    el.muted = muted;
  }
}

// Frame size: the chosen one, else the first visual clip's (like the export)
function seqSize() {
  if (V.size) return V.size;
  const first = V.items.filter(isVisual).sort((a, b) => a.at - b.at || zOf(a) - zOf(b))[0];
  const el = first && V.els.get(first.id)?.el;
  const w = el && (el.videoWidth || el.naturalWidth), hh = el && (el.videoHeight || el.naturalHeight);
  return w ? [w - (w % 2), hh - (hh % 2)] : [1280, 720];
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawFrame(); });
}

function drawFrame() {
  const cv = $('#vidCanvas');
  const [W, H] = seqSize();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; renderVideoPanel(); }   // the panel shows the size
  const layers = tracksOf('video').filter((tr) => !tr.hidden).map((tr) =>
    V.items.filter((it) => it.track === tr.id && V.t >= it.at && V.t < itEnd(it)).sort((a, b) => a.at - b.at));
  // A clip that's loading or seeking has no frame to draw: keep the last picture for a moment
  // rather than flashing black (or the track underneath).
  const ready = (it) => {
    const el = mediaFor(it);
    return it.kind === 'image' ? el.complete && el.naturalWidth > 0 : el.readyState >= 2 && !el.seeking;
  };
  if (!layers.flat().every(ready)) {
    V.holdSince = V.holdSince || performance.now();
    if (performance.now() - V.holdSince < 500) return;
  }
  V.holdSince = 0;
  const ctx = cv.getContext('2d');
  ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  for (const live of layers) {
    for (const it of live) {
      const el = mediaFor(it);
      const nw = el.videoWidth || el.naturalWidth, nh = el.videoHeight || el.naturalHeight;
      if (!nw || (it.kind === 'video' && el.readyState < 2)) continue;
      const s = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh) * (it.scale || 1);
      const dw = nw * s, dh = nh * s;
      ctx.globalAlpha = (it.opacity ?? 1) * fadeGain(it, V.t, false);
      ctx.drawImage(el, (W - dw) / 2 + (it.x || 0) * W, (H - dh) / 2 + (it.y || 0) * H, dw, dh);
    }
  }
  ctx.globalAlpha = 1;
}

function vidPlay() {
  if (!V.items.length) return;
  if (V.t >= seqEnd() - 0.01) V.t = 0;
  unlockMedia();
  V.playing = true; V.clock = performance.now() - V.t * 1000;
  syncMedia();   // start what's under the playhead inside the tap, too
  showPlayState(); requestAnimationFrame(vidTick);
}
function vidPause() {
  if (!V.playing) return;
  V.playing = false; syncMedia(); showPlayState(); requestDraw();
}
// While a clip is playing smoothly the timeline follows it (the "master"), so it never has to be
// corrected by seeking; the wall clock covers gaps, stills and clips that are still starting.
function masterTime() {
  const ok = (it) => it && it.kind !== 'image' && V.t >= it.at && V.t < itEnd(it) && V.els.has(it.id)
    && (({ el }) => !el.paused && !el.seeking && el.readyState >= 3)(V.els.get(it.id));
  let m = V.items.find((it) => it.id === V.master);
  if (!ok(m)) { m = V.items.find(ok); V.master = m ? m.id : null; }
  return m ? m.at + V.els.get(m.id).el.currentTime - m.in : null;
}

function vidTick() {
  if (!V.playing) return;
  const mt = masterTime();
  if (mt != null && Math.abs(mt - (performance.now() - V.clock) / 1000) < 0.5) V.clock = performance.now() - mt * 1000;
  V.t = (performance.now() - V.clock) / 1000;
  const end = seqEnd();
  if (V.t >= end) {
    if (V.loop && end > 0) { V.t = 0; V.clock = performance.now(); }
    else { V.t = end; vidPause(); updatePlayhead(); return; }
  }
  syncMedia(); drawFrame(); updatePlayhead(true);
  requestAnimationFrame(vidTick);
}
function vidSeek(t) {
  V.t = Math.max(0, t);
  if (V.playing) V.clock = performance.now() - V.t * 1000;
  syncMedia(); requestDraw(); updatePlayhead();
}
function showPlayState() { $('#vidPlay').textContent = V.playing ? '❚❚ Pause' : '▶ Play'; }

function updatePlayhead(follow = false) {
  const tl = $('#timeline'), ph = tl.querySelector('.tl-playhead');
  const x = HEAD_W + V.t * V.pps;
  if (ph) ph.style.left = `${x}px`;
  $('#vidTime').textContent = `${tc(V.t)} / ${tc(seqEnd())}`;
  if (follow && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft + HEAD_W)) tl.scrollLeft = x - HEAD_W - 30;
}

// ---- timeline drawing ----
function posterFor(it) {   // first frame of a video, as a small JPEG for the clip's filmstrip
  const p = V.posters.get(it.url);
  if (p) return p.startsWith('data:') ? p : null;
  V.posters.set(it.url, 'loading');
  const v = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', src: it.url });
  v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.1, (v.duration || 0) / 2); }, { once: true });
  v.addEventListener('seeked', () => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = Math.round((120 * v.videoHeight) / v.videoWidth) || 68;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    V.posters.set(it.url, c.toDataURL('image/jpeg', 0.7));
    v.removeAttribute('src'); v.load();
    renderTimeline();
  }, { once: true });
  v.addEventListener('error', () => V.posters.set(it.url, 'none'), { once: true });
  return null;
}

async function loadWave(url) {   // loudness peaks, 50 per second, for drawing audio clips
  V.waves.set(url, 'loading');
  try {
    const b = blobs.get(url);
    const buf = await (await fetch(b && b.state === 'ready' ? b.src : url)).arrayBuffer();
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
    const ch = audio.getChannelData(0), rate = 50, block = Math.floor(audio.sampleRate / rate);
    const peaks = new Float32Array(Math.ceil(ch.length / block));
    for (let i = 0; i < peaks.length; i++) {
      let m = 0;
      for (let j = i * block, e = Math.min(ch.length, j + block); j < e; j += 4) m = Math.max(m, Math.abs(ch[j]));
      peaks[i] = m;
    }
    const top = peaks.reduce((m, v) => Math.max(m, v), 0) || 1;   // scale quiet recordings up to full height
    V.waves.set(url, { peaks: peaks.map((v) => v / top), rate });
  } catch { V.waves.set(url, 'none'); }
  drawWaves();
}

function drawWaves() {
  document.querySelectorAll('#timeline canvas.wave').forEach((c) => {
    const it = V.items.find((i) => i.id === c.parentElement.dataset.id);
    const w = it && V.waves.get(it.url);
    if (it && !w) { loadWave(it.url); return; }
    if (!w || typeof w === 'string') return;
    const W = Math.min(8000, Math.max(1, Math.round(itLen(it) * V.pps))), H = LANE_H - 10;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#a7e8bd';
    for (let x = 0; x < W; x++) {
      const hh = Math.max(1, (w.peaks[Math.floor((it.in + x / V.pps) * w.rate)] || 0) * H);
      ctx.fillRect(x, (H - hh) / 2, 1, hh);
    }
  });
}

function clipEl(it) {
  const { xin } = xfades(it);
  const fi = Math.max(it.fadeIn || 0, xin);
  const bg = it.kind === 'video' ? posterFor(it) : it.kind === 'image' ? it.thumb || it.url : null;
  return h('div', { class: `tl-clip ${it.kind}` + (V.sel === it.id ? ' sel' : ''), 'data-id': it.id,
    style: `left:${it.at * V.pps}px;width:${Math.max(6, itLen(it) * V.pps)}px` + (bg ? `;background-image:url("${bg}")` : '') },
    it.kind === 'audio' ? h('canvas', { class: 'wave' }) : null,
    h('span', { class: 'tl-label' }, it.label),
    fi ? h('span', { class: 'tl-fade in', style: `width:${fi * V.pps}px` }) : null,
    it.fadeOut ? h('span', { class: 'tl-fade out', style: `width:${it.fadeOut * V.pps}px` }) : null,
    h('span', { class: 'tl-trim l' }), h('span', { class: 'tl-trim r' }));
}

function trackHead(tr) {
  const removable = tracksOf(tr.kind).length > 1 && !V.items.some((i) => i.track === tr.id);
  const tog = (key, on, off, title) => h('button', { type: 'button', class: 'tl-tog' + (tr[key] ? ' off' : ''), title,
    onclick: () => { tr[key] = !tr[key]; timelineChanged(); } }, tr[key] ? off : on);
  return h('div', { class: 'tl-head' },
    h('b', {}, trackName(tr)),
    h('div', { class: 'tl-head-btns' },
      tr.kind === 'video' ? tog('hidden', '👁', '◌', 'Show / hide this track') : null,
      tog('muted', '🔊', '🔇', 'Mute / unmute this track'),
      removable ? h('button', { type: 'button', class: 'tl-tog', title: 'Remove this empty track',
        onclick: () => { V.tracks = V.tracks.filter((t) => t !== tr); timelineChanged(); } }, '✕') : null));
}

function addTrack(kind) {
  const id = `${kind[0]}${uid()}`;
  V.tracks.push({ id, kind });
  return id;
}

function renderTimeline() {
  const tl = $('#timeline');
  const span = Math.max(seqEnd() + 10, (tl.clientWidth - HEAD_W) / V.pps);
  const major = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * V.pps >= 70) || 600;
  const ruler = h('div', { class: 'tl-ruler', style: `background-size:${(major * V.pps) / 5}px 100%` });
  for (let s = 0; s <= span; s += major) {
    ruler.append(h('span', { style: `left:${s * V.pps}px` }, s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s}s`));
  }
  const inner = h('div', { class: 'tl-inner', style: `width:${HEAD_W + span * V.pps}px` },
    h('div', { class: 'tl-row tl-ruler-row' },
      h('div', { class: 'tl-head tl-corner' },
        h('button', { type: 'button', class: 'tl-tog', title: 'Add a video track', onclick: () => { addTrack('video'); timelineChanged(); } }, '+V'),
        h('button', { type: 'button', class: 'tl-tog', title: 'Add an audio track', onclick: () => { addTrack('audio'); timelineChanged(); } }, '+A')),
      ruler));
  for (const tr of [...tracksOf('video')].reverse().concat(tracksOf('audio'))) {
    inner.append(h('div', { class: `tl-row ${tr.kind}` + (tr.hidden || tr.muted && tr.kind === 'audio' ? ' off' : '') },
      trackHead(tr),
      h('div', { class: 'tl-lane', 'data-track': tr.id }, V.items.filter((i) => i.track === tr.id).map(clipEl))));
  }
  inner.append(h('div', { class: 'tl-playhead' }));
  const { scrollLeft, scrollTop } = tl;
  tl.replaceChildren(inner);
  tl.scrollLeft = scrollLeft; tl.scrollTop = scrollTop;
  drawWaves(); pruneEls(); preloadMedia(); updatePlayhead();
  $('#vidEmpty').classList.toggle('hidden', V.items.length > 0);
}

function timelineChanged() {
  persistTimeline(); renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw();
}

function renderVideo() { renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); }

// ---- timeline gestures: drag clips to move (also between tracks), drag their ends to trim ----
const timeAt = (e) => (e.clientX - $('#timeline .tl-inner').getBoundingClientRect().left - HEAD_W) / V.pps;

function dragWindow(onMove, onUp) {
  const up = (ev) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); onUp && onUp(ev); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

function startScrub(e) {
  e.preventDefault();
  vidPause();
  const go = (ev) => {
    let t = Math.max(0, timeAt(ev));
    for (const p of [0, ...V.items.flatMap((i) => [i.at, itEnd(i)])]) if (Math.abs(p - t) < 6 / V.pps) t = p;
    vidSeek(t);
  };
  go(e);
  dragWindow(go);
}

function startClipDrag(e, el) {
  const it = V.items.find((i) => i.id === el.dataset.id);
  if (!it) return;
  e.preventDefault();
  const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
  const x0 = e.clientX, y0 = e.clientY;
  const o = { at: it.at, in: it.in, out: it.out ?? (it.dur || 3) };
  if (V.sel !== it.id) {
    V.sel = it.id;
    $('#timeline').querySelectorAll('.tl-clip.sel').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
    renderVideoPanel();
  }
  const points = [0, V.t, ...V.items.filter((i) => i !== it).flatMap((i) => [i.at, itEnd(i)])];
  const snap = (t) => {
    let best = t, d = 8 / V.pps;
    for (const p of points) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
    return best;
  };
  let moved = false;
  dragWindow((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 5 && Math.abs(ev.clientY - y0) < 5) return;
    moved = true;
    const dt = (ev.clientX - x0) / V.pps;
    if (mode === 'move') {
      const len = o.out - o.in, at = Math.max(0, o.at + dt);
      const a1 = snap(at), a2 = snap(at + len) - len;   // snap whichever end is closer to something
      const d1 = a1 !== at ? Math.abs(a1 - at) : Infinity, d2 = a2 !== at ? Math.abs(a2 - at) : Infinity;
      it.at = Math.max(0, d1 <= d2 && d1 < Infinity ? a1 : d2 < Infinity ? a2 : at);
      const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tl-lane');
      const tr = lane && V.tracks.find((t) => t.id === lane.dataset.track);
      if (tr && (tr.kind === 'audio') === (it.kind === 'audio')) it.track = tr.id;
    } else if (mode === 'l') {
      let d = snap(o.at + dt) - o.at;
      if (it.kind !== 'image') d = Math.max(d, -o.in);   // not before the start of the source
      d = Math.max(-o.at, Math.min(d, o.out - o.in - MIN_LEN));
      it.at = o.at + d;
      if (it.kind === 'image') it.out = o.out - d; else it.in = o.in + d;
    } else {
      let out = o.in + snap(o.at + (o.out - o.in) + dt) - o.at;
      out = Math.max(o.in + MIN_LEN, it.kind === 'image' || !it.dur ? out : Math.min(out, it.dur));
      it.out = out;
    }
    renderTimeline(); syncMedia(); requestDraw();
  }, () => { if (moved) timelineChanged(); });
}

function wireTimeline() {
  const tl = $('#timeline');
  tl.addEventListener('pointerdown', (e) => {
    const clip = e.target.closest('.tl-clip');
    if (clip) startClipDrag(e, clip);
    else if (e.target.closest('.tl-ruler')) startScrub(e);
  });
  tl.addEventListener('click', (e) => {   // tap an empty spot: deselect and move the playhead there
    if (!e.target.classList.contains('tl-lane')) return;
    V.sel = null; vidPause(); vidSeek(Math.max(0, timeAt(e))); renderTimeline(); renderVideoPanel();
  });
  tl.addEventListener('wheel', (e) => {   // ctrl/pinch + wheel zooms around the pointer
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTimeline(V.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
  }, { passive: false });
  new ResizeObserver(() => renderTimeline()).observe(tl);
}

function zoomTimeline(pps, aroundT = V.t, clientX = null) {
  const tl = $('#timeline');
  const screenX = clientX != null ? clientX - tl.getBoundingClientRect().left : HEAD_W + V.t * V.pps - tl.scrollLeft;
  V.pps = Math.max(4, Math.min(400, pps));
  persistTimeline(); renderTimeline();
  tl.scrollLeft = HEAD_W + aroundT * V.pps - screenX;
}

function fitTimeline() {
  const tl = $('#timeline');
  zoomTimeline((tl.clientWidth - HEAD_W - 30) / Math.max(1, seqEnd()), 0, HEAD_W);
  tl.scrollLeft = 0;
}

// ---- editing ----
function splitAtPlayhead() {
  const t = V.t;
  const under = V.items.filter((it) => t > it.at + 0.02 && t < itEnd(it) - 0.02);
  const targets = under.some((it) => it.id === V.sel) ? under.filter((it) => it.id === V.sel) : under;
  if (!targets.length) return toast('Put the playhead over a clip to split it', true);
  for (const a of targets) {
    const end = itEnd(a), b = { ...a, id: uid(), at: t, fadeIn: 0 };
    if (a.kind === 'image') { b.out = end - t; a.out = t - a.at; } else { b.in = a.in + (t - a.at); a.out = b.in; }
    a.fadeOut = 0;
    V.items.splice(V.items.indexOf(a) + 1, 0, b);
  }
  timelineChanged();
}

function deleteSelected() {
  const it = selItem();
  if (!it) return;
  V.items = V.items.filter((i) => i !== it);
  V.sel = null;
  timelineChanged();
}

// Overlap this clip with the one before it on its track (moving it and everything after it on
// that track to the left), so the two cross-fade.
function crossfadePrev(it, d = 0.5) {
  const prev = V.items.filter((i) => i !== it && i.track === it.track && i.at < it.at)
    .sort((a, b) => itEnd(b) - itEnd(a))[0];
  if (!prev) return toast('There is no clip before this one on its track', true);
  d = Math.min(d, itLen(prev) / 2, itLen(it) / 2);
  const shift = it.at - (itEnd(prev) - d);
  for (const i of V.items) if (i.track === it.track && i.at >= it.at) i.at = Math.max(0, i.at - shift);
  timelineChanged();
}

function targetTrack(kind) {
  const want = kind === 'audio' ? 'audio' : 'video';
  const sel = selItem(), st = sel && trackOf(sel);
  if (st && st.kind === want) return st.id;
  return (tracksOf(want)[0] || {}).id || addTrack(want);
}

function probeDuration(url, tag) {
  return new Promise((res) => {
    const m = Object.assign(document.createElement(tag), { preload: 'metadata', muted: true });
    m.onloadedmetadata = () => { res(isFinite(m.duration) ? m.duration : 0); m.removeAttribute('src'); };
    m.onerror = () => res(0);
    m.src = url;
  });
}

// New clips go after the last clip on the selected clip's track (or V1 / A1)
async function addToTimeline(media) {
  if (media.kind !== 'image' && !media.dur) media.dur = await probeDuration(media.url, media.kind === 'audio' ? 'audio' : 'video');
  const it = newItem(media, targetTrack(media.kind));
  it.at = V.items.filter((i) => i.track === it.track).reduce((m, i) => Math.max(m, itEnd(i)), 0);
  V.items.push(it); V.sel = it.id;
  timelineChanged();
  return it;
}

async function addFromHistory() {
  if (!S.history.size) await loadHistory();
  const items = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done')
    .sort((a, b) => b.id - a.id)
    .flatMap((g) => g.outputs.map((o, i) => ({ g, o, i })).filter(({ o }) => ['video', 'image', 'audio'].includes(o.kind)));
  openSheet(h('h3', {}, 'Add from this project'),
    h('div', { class: 'picker-bar' }, h('span', { class: 'hint', style: 'flex:1' }, 'Tap to add in order. Videos and images go on the selected video track, sound on the audio track.'),
      h('button', { type: 'button', class: 'btn small', onclick: closeSheet }, 'Done')),
    h('div', { class: 'grid gallery' }, items.length ? items.map(({ g, o, i }) => {
      const c = h('button', { class: 'card' },
        h('div', { class: 'media' }, o.kind === 'audio' ? h('span', { class: 'placeholder' }, '♪') : mediaEl(o, { thumb: true }),
          o.kind === 'video' ? h('span', { class: 'play' }, '▶') : null),
        h('div', { class: 'meta' }, h('span', { class: 'name' }, `#${g.id} ${g.template}`)));
      c.addEventListener('click', async () => {
        c.classList.add('picked');
        await addToTimeline({ kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: `#${g.id} ${g.template}`, dur: o.duration || 0 });
        toast('Added');
      });
      return c;
    }) : h('div', { class: 'placeholder' }, 'Nothing generated in this project yet.')));
}

function addImages() {
  openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => addToTimeline({
    kind: 'image', src: { input: name }, url: `/api/input?name=${encodeURIComponent(name)}`,
    thumb: thumbUrl(name, 160), label: name.split('/').pop() }) });
}

async function addMediaFiles() {
  const grid = h('div', { class: 'grid gallery' }, h('div', { class: 'placeholder' }, 'Loading…'));
  const file = h('input', { type: 'file', accept: 'audio/*,video/*,image/*', multiple: true, class: 'hidden' });
  const add = (m) => addToTimeline({ kind: m.kind, src: { media: m.name }, url: m.url, label: m.label, thumb: m.kind === 'image' ? m.url : null });
  const card = (m) => {
    const c = h('button', { class: 'card' },
      h('div', { class: 'media' }, m.kind === 'audio' ? h('span', { class: 'placeholder' }, '♪') : mediaEl(m, { thumb: true })),
      h('div', { class: 'meta' }, h('span', { class: 'name' }, m.label)));
    c.addEventListener('click', async () => { c.classList.add('picked'); await add(m); toast('Added'); });
    return c;
  };
  const load = async () => {
    try {
      const list = await api('/api/media');
      grid.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'placeholder' }, 'No files yet. Upload music, a voice-over or a video.')]));
    } catch (e) { grid.replaceChildren(h('div', { class: 'note err' }, e.message)); }
  };
  file.addEventListener('change', async () => {
    const files = [...file.files]; file.value = '';
    for (const f of files) {
      toast(`Uploading ${f.name}…`);
      const form = new FormData(); form.append('file', f);
      try { await add(await api('/api/media', { method: 'POST', form })); }
      catch (e) { toast('Upload failed: ' + e.message, true); return; }
    }
    toast(files.length > 1 ? `Added ${files.length} files` : 'Added');
    load();
  });
  openSheet(h('h3', {}, 'Sound and files'),
    h('div', { class: 'picker-bar' },
      h('button', { type: 'button', class: 'btn small primary', onclick: () => file.click() }, 'Upload…'),
      h('span', { class: 'hint', style: 'flex:1' }, 'Music, voice-overs, or videos and images from elsewhere.'),
      h('button', { type: 'button', class: 'btn small', onclick: closeSheet }, 'Done')),
    grid, file);
  load();
}

// ---- inspector panel ----
function numField(label, get, set, { step = 0.04, min = 0, max } = {}) {
  const inp = h('input', { type: 'number', inputMode: 'decimal', step, min, max, value: Number(get()).toFixed(2) });
  inp.addEventListener('change', () => { set(parseFloat(inp.value) || 0); timelineChanged(); });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), inp);
}

function rangeField(label, get, set, { min, max, step, fmt }) {
  const val = h('span', {}, fmt(get()));
  const r = h('input', { type: 'range', min, max, step, value: get() });
  r.addEventListener('input', () => { set(parseFloat(r.value)); val.textContent = fmt(get()); renderTimeline(); syncMedia(); requestDraw(); });
  r.addEventListener('change', persistTimeline);
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, h('span', {}, label), val), r);
}

const SIZES = [['Match first clip', null], ['1280×720', [1280, 720]], ['1920×1080', [1920, 1080]], ['720×1280', [720, 1280]],
  ['1080×1920', [1080, 1920]], ['1024×1024', [1024, 1024]], ['832×480', [832, 480]], ['480×832', [480, 832]]];

function renderVideoPanel() {
  const it = selItem();
  const pct = (v) => `${Math.round(v * 100)}%`;
  const clip = it ? (() => {
    const len = itLen(it), tr = trackOf(it);
    const fields = [numField('Starts at (s)', () => it.at, (v) => { it.at = Math.max(0, v); })];
    if (it.kind === 'image') fields.push(numField('Duration (s)', () => len, (v) => { it.out = Math.max(MIN_LEN, v); }));
    else fields.push(
      numField('In (s)', () => it.in, (v) => { it.in = Math.max(0, Math.min(v, (it.out ?? it.dur) - MIN_LEN)); }, { max: it.dur || undefined }),
      numField('Out (s)', () => it.out ?? it.dur, (v) => { it.out = Math.max(it.in + MIN_LEN, it.dur ? Math.min(v, it.dur) : v); }, { max: it.dur || undefined }));
    fields.push(
      numField('Fade in (s)', () => it.fadeIn || 0, (v) => { it.fadeIn = Math.max(0, Math.min(v, len)); }, { step: 0.1 }),
      numField('Fade out (s)', () => it.fadeOut || 0, (v) => { it.fadeOut = Math.max(0, Math.min(v, len)); }, { step: 0.1 }));
    const fit = h('div', { class: 'seg' }, [['fit', 'Fit'], ['fill', 'Fill']].map(([k, label]) =>
      h('button', { type: 'button', class: (it.fit || 'fit') === k ? 'on' : '', onclick: () => { it.fit = k; timelineChanged(); } }, label)));
    return h('div', { class: 'vid-section' },
      h('div', { class: 'vid-title' }, h('b', {}, it.label),
        h('span', { class: 'hint' }, `${it.kind} on ${tr ? trackName(tr) : '?'} · ${fmtT(len)}${it.dur ? ` of ${fmtT(it.dur)}` : ''}`)),
      h('div', { class: 'vid-grid' }, fields),
      isVisual(it) ? [
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Framing'), fit),
        rangeField('Scale', () => it.scale ?? 1, (v) => { it.scale = v; }, { min: 0.1, max: 3, step: 0.01, fmt: pct }),
        rangeField('Position X', () => it.x || 0, (v) => { it.x = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
        rangeField('Position Y', () => it.y || 0, (v) => { it.y = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
        rangeField('Opacity', () => it.opacity ?? 1, (v) => { it.opacity = v; }, { min: 0, max: 1, step: 0.01, fmt: pct }),
      ] : null,
      it.kind !== 'image' ? rangeField('Volume', () => it.volume ?? 1, (v) => { it.volume = v; }, { min: 0, max: 2, step: 0.01,
        fmt: (v) => pct(v) + (v > 1 ? ' (preview plays at 100%)' : '') }) : null,
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn small', onclick: splitAtPlayhead, title: 'S' }, '✂ Split at playhead'),
        h('button', { type: 'button', class: 'btn small', onclick: () => crossfadePrev(it) }, '⤫ Cross-fade with previous'),
        isVisual(it) ? h('button', { type: 'button', class: 'btn small', onclick: () => { Object.assign(it, { x: 0, y: 0, scale: 1, opacity: 1, fit: 'fit' }); timelineChanged(); } }, 'Reset framing') : null,
        h('button', { type: 'button', class: 'btn small danger', onclick: deleteSelected, title: 'Delete' }, 'Delete clip')));
  })() : null;

  const sizeSel = h('select', {}, SIZES.map(([label, s], i) => h('option', { value: i, selected: JSON.stringify(s) === JSON.stringify(V.size) }, label)));
  if (V.size && !SIZES.some(([, s]) => JSON.stringify(s) === JSON.stringify(V.size))) sizeSel.append(h('option', { value: 'custom', selected: true }, V.size.join('×')));
  sizeSel.addEventListener('change', () => { V.size = SIZES[sizeSel.value]?.[1] || V.size; timelineChanged(); });
  const fpsSel = h('select', {}, [[0, 'Match first clip'], [16, '16'], [24, '24'], [25, '25'], [30, '30'], [60, '60']].map(([v, label]) =>
    h('option', { value: v, selected: V.fps === v }, label)));
  fpsSel.addEventListener('change', () => { V.fps = Number(fpsSel.value); timelineChanged(); });
  const exportBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => exportVideo(exportBtn) }, 'Export video');

  $('#videoPanel').replaceChildren(h('div', { class: 'group-body flat' },
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn small primary', onclick: addFromHistory }, '+ Clips'),
      h('button', { type: 'button', class: 'btn small', onclick: addImages }, '+ Images'),
      h('button', { type: 'button', class: 'btn small', onclick: addMediaFiles }, '+ Sound / files')),
    clip || h('div', { class: 'hint' }, V.items.length
      ? 'Tap a clip to edit it. Drag clips to move them (also onto other tracks), drag their ends to trim, and overlap two clips on a track to cross-fade. Higher video tracks draw on top.'
      : 'Add generated clips, images or sound. They line up on V1 / A1; drag them onto V2 to layer them over V1.'),
    h('div', { class: 'vid-section' },
      h('div', { class: 'vid-title' }, h('b', {}, 'Sequence'), h('span', { class: 'hint' }, `${seqSize().join('×')} · ${V.fps || 'auto'} fps · ${fmtT(seqEnd())}`)),
      h('div', { class: 'vid-grid' },
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Frame size'), sizeSel),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Frame rate'), fpsSel)),
      V.items.length ? h('div', { class: 'row' }, exportBtn,
        h('button', { type: 'button', class: 'btn ghost', style: 'flex:none', onclick: () => {
          if (!confirm('Remove every clip from the timeline?')) return;
          V.items = []; V.sel = null; vidSeek(0); timelineChanged();
        } }, 'Clear')) : null,
      V.items.length ? h('div', { class: 'hint' }, 'The export lands in History.') : null)));
}

async function exportVideo(btn) {
  vidPause();
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const g = await api('/api/video/render', { method: 'POST', body: {
      project_id: S.project, width: V.size && V.size[0], height: V.size && V.size[1], fps: V.fps || null,
      tracks: V.tracks.map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),
      items: V.items.map((it) => ({ track: it.track, src: it.src, at: it.at, in: it.in, out: it.out ?? it.dur,
        x: it.x, y: it.y, scale: it.scale, fit: it.fit, opacity: it.opacity, volume: it.volume,
        fade_in: it.fadeIn, fade_out: it.fadeOut })) } });
    S.history.set(g.id, g);
    openGeneration(g.id);
  } catch (e) { toast('Export failed: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Export video'; }
}

// Full screen for the preview and its controls. Browsers without element full screen (older
// iPads) get the same look by pinning the stage over the page.
const vidStage = () => $('#tab-video .stage');
const vidFullscreen = () => (document.fullscreenElement || document.webkitFullscreenElement) === vidStage()
  || vidStage().classList.contains('pseudo-fs');

function exitVideoFullscreen() {
  const stage = vidStage();
  stage.classList.remove('pseudo-fs');
  if ((document.fullscreenElement || document.webkitFullscreenElement) === stage) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function toggleVideoFullscreen() {
  if (vidFullscreen()) return exitVideoFullscreen();
  const stage = vidStage(), req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  const fallback = () => { stage.classList.add('pseudo-fs'); showFullscreenState(); };
  if (!req) return fallback();
  try { Promise.resolve(req.call(stage)).catch(fallback); } catch { fallback(); }
}

function showFullscreenState() {
  const on = vidFullscreen();
  $('#vidFull').textContent = on ? '✕' : '⛶';
  $('#vidFull').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  requestDraw();
}

// The frame under the playhead at the sequence's full size: save it as an input or download it
async function snapshotFrame() {
  if (!V.items.length) return toast('Add something to the timeline first', true);
  vidPause();
  if (vidFullscreen()) exitVideoFullscreen();   // the popup lives outside the full-screen stage
  const cv = $('#vidCanvas');
  drawFrame();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) return toast('Could not grab the frame', true);
  const url = URL.createObjectURL(blob), name = `frame_${tc(V.t).replace(/:/g, '-')}.png`;
  openSheet(h('h3', {}, `Frame at ${tc(V.t)}`),
    h('div', { class: 'media-big' }, h('img', { src: url, alt: '' })),
    h('div', { class: 'hint', style: 'margin-top:8px' }, `${cv.width}×${cv.height}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small primary', onclick: async () => {
        try {
          const r = await uploadImage(blob, { mp: 0, source: 'snapshot', filename: name });
          useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
        } catch (e) { toast('Save failed: ' + e.message, true); }
      } }, 'Save as input'),
      h('a', { class: 'btn small', href: url, download: name, style: 'display:grid;place-items:center;text-decoration:none' }, 'Download'),
      h('button', { class: 'btn small ghost', onclick: closeSheet }, 'Close')));
}

function wireVideoTransport() {
  const step = (d) => { vidPause(); vidSeek(V.t + d); };
  $('#vidStart').addEventListener('click', () => { vidPause(); vidSeek(0); });
  $('#vidPrev').addEventListener('click', () => step(-1 / fpsNow()));
  $('#vidNext').addEventListener('click', () => step(1 / fpsNow()));
  $('#vidPlay').addEventListener('click', () => (V.playing ? vidPause() : vidPlay()));
  $('#vidSnap').addEventListener('click', snapshotFrame);
  $('#vidFull').addEventListener('click', toggleVideoFullscreen);
  document.addEventListener('fullscreenchange', showFullscreenState);
  document.addEventListener('webkitfullscreenchange', showFullscreenState);
  const loopBtn = $('#vidLoop');
  const showLoop = () => { loopBtn.classList.toggle('on', V.loop); loopBtn.setAttribute('aria-pressed', String(V.loop)); };
  loopBtn.addEventListener('click', () => { V.loop = !V.loop; store.set('deck.video.loop', V.loop); showLoop(); });
  showLoop();
  $('#tlTools').replaceChildren(
    h('button', { type: 'button', class: 'btn small', title: 'Split at playhead (S)', onclick: splitAtPlayhead }, '✂ Split'),
    h('button', { type: 'button', class: 'btn small', title: 'Delete selected clip (Del)', onclick: deleteSelected }, '🗑 Delete'),
    h('span', { class: 'hint tl-tip' }, 'Drag clips to move · drag ends to trim · overlap to cross-fade'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Zoom out', onclick: () => zoomTimeline(V.pps / 1.5) }, '−'),
    h('button', { type: 'button', class: 'btn small', onclick: fitTimeline }, 'Fit'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Zoom in', onclick: () => zoomTimeline(V.pps * 1.5) }, '+'));
  wireTimeline();
  showPlayState();
  // Premiere-ish keys while the Video tab is open
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-video').classList.contains('active') || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const keys = {
      ' ': () => (V.playing ? vidPause() : vidPlay()),
      ArrowLeft: () => step(e.shiftKey ? -1 : -1 / fpsNow()),
      ArrowRight: () => step(e.shiftKey ? 1 : 1 / fpsNow()),
      Home: () => { vidPause(); vidSeek(0); },
      End: () => { vidPause(); vidSeek(seqEnd()); },
      s: splitAtPlayhead, c: splitAtPlayhead, f: toggleVideoFullscreen,
      Escape: () => { if (vidStage().classList.contains('pseudo-fs')) { exitVideoFullscreen(); showFullscreenState(); } },
      Delete: deleteSelected, Backspace: deleteSelected,
      '=': () => zoomTimeline(V.pps * 1.5), '+': () => zoomTimeline(V.pps * 1.5), '-': () => zoomTimeline(V.pps / 1.5),
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });
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
  return h('div', { class: 'field' },
    h('label', { class: 'lbl' }, h('span', {}, f.label), h('span', {}, boxes.length ? `${boxes.length} box${boxes.length > 1 ? 'es' : ''}` : 'none')),
    h('button', { type: 'button', class: 'boxes-btn', onclick: edit }, preview),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('button', { type: 'button', class: 'btn small', onclick: edit }, boxes.length ? 'Edit boxes' : 'Draw boxes'),
      boxes.length ? h('button', { type: 'button', class: 'btn small', onclick: () => { setVal(f.key, []); renderFields(); } }, 'Clear') : null),
    h('div', { class: 'hint', style: 'margin-top:4px' },
      boxes.length ? boxes.map((b, i) => `${i + 1}: ${b.type === 'text' ? `text "${b.text || ''}"` : b.desc || 'object'}${b.ref ? ' + reference' : ''}`).join(' · ')
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
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 20) / aspect, r.height - 20);
    canvas.style.width = `${Math.floor(k * aspect)}px`; canvas.style.height = `${Math.floor(k)}px`;
  };
  if (image) {
    canvas.style.backgroundImage = `url("/api/input?name=${encodeURIComponent(image)}")`;
    const probe = new Image();
    probe.onload = () => { aspect = probe.naturalWidth / probe.naturalHeight; (S.imgAspect ||= {})[image] = aspect; fit(); };
    probe.src = `/api/input?name=${encodeURIComponent(image)}`;
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
      const seg = h('div', { class: 'seg' }, [['obj', 'Object'], ['text', 'Text']].map(([t, l]) =>
        h('button', { type: 'button', class: (b.type || 'obj') === t ? 'on' : '', onclick: () => { b.type = t; draw(); } }, l)));
      const move = (d) => { const j = i + d; if (j < 0 || j >= boxes.length) return; [boxes[i], boxes[j]] = [boxes[j], boxes[i]]; sel = j; draw(); };
      return h('div', { class: 'box-item' + (i === sel ? ' sel' : ''), onclick: () => { if (sel !== i) { sel = i; draw(); } } },
        h('div', { class: 'row' }, h('b', { style: 'flex:none' }, `${i + 1}`), seg,
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Earlier', onclick: () => move(-1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Later', onclick: () => move(1) }, '↓'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete box', onclick: () => { boxes.splice(i, 1); sel = Math.min(sel, boxes.length - 1); draw(); } }, '✕')),
        b.type === 'text' ? txt : null, desc,
        f.refs && b.type !== 'text' ? h('div', { class: 'box-ref' },
          b.ref ? h('img', { src: thumbUrl(b.ref, 160), alt: '' }) : null,
          h('button', { type: 'button', class: 'btn small', onclick: (e) => {
            e.stopPropagation();
            openImagePicker({ title: `Reference for box ${i + 1}`, onPick: (name) => { b.ref = name; draw(); } });
          } }, b.ref ? 'Change reference' : '+ Reference image'),
          b.ref ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove reference',
            onclick: (e) => { e.stopPropagation(); delete b.ref; draw(); } }, '✕') : null) : null);
    }) : [h('div', { class: 'hint' }, 'Drag on the picture to draw a box. Background things first, foreground last.')]));
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
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => overlay.remove() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => {
        setVal(f.key, boxes.map(({ x, y, w, h: hh, type, desc, text, ref }) =>
          ({ x, y, w, h: hh, type: type || 'obj', desc: desc || '', text: text || '', ...(ref && type !== 'text' ? { ref } : {}) })));
        overlay.remove(); renderFields();
      } }, 'Done')),
    h('div', { class: 'box-body' }, stage, list));
  document.body.append(overlay);
  new ResizeObserver(fit).observe(stage);
  draw();
}

// ---------------------------------------------------------------------------
// LoRA info from Civitai (looked up by the file's hash through rgthree-comfy)
// ---------------------------------------------------------------------------
async function openLoraInfo(name) {
  openSheet(h('h3', {}, name.split('/').pop()),
    h('div', { class: 'placeholder' }, 'Looking it up on Civitai… The first lookup hashes the file, which can take a little while.'));
  let r;
  try { r = await api(`/api/lora-info?name=${encodeURIComponent(name)}`); } catch (e) {
    openSheet(h('h3', {}, name.split('/').pop()), h('div', { class: 'note err' }, e.message)); return;
  }
  const textOf = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  const words = r.trained_words.map((w) => h('button', { type: 'button', class: 'chip', title: 'Add to prompt',
    onclick: (e) => { addToPrompt(w); e.target.classList.add('added'); } }, w));
  openSheet(h('h3', {}, r.name),
    !r.found ? h('div', { class: 'note warn' }, 'Not found on Civitai (the file may be private, renamed from elsewhere, or not uploaded there).') : null,
    h('table', { class: 'params' },
      h('tr', {}, h('td', {}, 'File'), h('td', {}, r.file)),
      r.base_model ? h('tr', {}, h('td', {}, 'Base model'), h('td', {}, r.base_model)) : null,
      r.link ? h('tr', {}, h('td', {}, 'Civitai'), h('td', {}, h('a', { href: r.link, target: '_blank', rel: 'noopener' }, 'Open model page'))) : null),
    words.length ? h('div', { class: 'field', style: 'margin-top:10px' },
      h('label', { class: 'lbl' }, h('span', {}, 'Trigger words'), h('span', {}, 'tap to add to the prompt')),
      h('div', { class: 'chips' }, words)) : null,
    r.description ? h('details', { class: 'desc' }, h('summary', {}, 'Description'), h('div', { class: 'hint', style: 'white-space:pre-wrap' }, textOf(r.description))) : null,
    r.media.length ? h('div', { class: 'grid gallery', style: 'margin-top:10px' }, r.media.map((m) =>
      h('div', { class: 'card' }, h('div', { class: 'media' }, m.type === 'video'
        ? h('video', { src: m.url, muted: true, loop: true, playsInline: true, controls: true, preload: 'metadata' })
        : h('img', { src: m.url, loading: 'lazy', alt: '' }))))) : null);
}

// Append text to the template's main prompt (the first multi-line text field).
function addToPrompt(text) {
  const f = (S.tpl?.fields || []).find((x) => x.kind === 'text' && x.multiline) || (S.tpl?.fields || []).find((x) => x.kind === 'text');
  if (!f) return toast('This template has no prompt field', true);
  const cur = String(S.values[f.key] || '').trimEnd();
  if (cur.includes(text)) return toast(`"${text}" is already in the prompt`);
  setVal(f.key, cur ? `${cur}, ${text}` : text);
  renderFields(); toast(`Added "${text}" to ${f.group}`);
}

// ---------------------------------------------------------------------------
// board: every output in the project as a pin board. Pin favourites, filter, resize the tiles.
// Videos play (muted) while on screen.
// ---------------------------------------------------------------------------
const B = { filter: store.get('deck.board.filter', 'all'), size: store.get('deck.board.size', 240), loadedFor: undefined };
const boardVideos = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) e.target.play().catch(() => {}); else e.target.pause();
  }
}, { threshold: 0.25 });

async function loadAllProjectGenerations() {
  let before = null;
  for (let page = 0; page < 20; page++) {
    const rows = await api(`/api/generations?limit=200${S.project != null ? `&project_id=${S.project}` : ''}${before ? `&before=${before}` : ''}`);
    for (const g of rows) S.history.set(g.id, g);
    if (rows.length < 200) break;
    before = Math.min(...rows.map((g) => g.id));
  }
  B.loadedFor = S.project;
}

async function renderBoard() {
  const bar = $('#boardBar');
  const seg = h('div', { class: 'seg' }, [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['pinned', '★ Pinned']].map(([k, l]) =>
    h('button', { type: 'button', class: B.filter === k ? 'on' : '', onclick: () => { B.filter = k; store.set('deck.board.filter', k); renderBoard(); } }, l)));
  const size = h('input', { type: 'range', min: 120, max: 520, step: 10, value: B.size, 'aria-label': 'Tile size' });
  size.addEventListener('input', () => { B.size = Number(size.value); store.set('deck.board.size', B.size); $('#board').style.setProperty('--tile', `${B.size}px`); });
  const count = h('span', { class: 'hint' });
  bar.replaceChildren(seg, h('label', { class: 'board-size' }, 'Size', size), count);
  $('#board').style.setProperty('--tile', `${B.size}px`);

  if (B.loadedFor !== S.project) {
    $('#board').replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try { await loadAllProjectGenerations(); } catch (e) { toast(e.message, true); }
  }
  const tiles = [];
  const gens = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done').sort((a, b) => b.id - a.id);
  for (const g of gens) {
    if (B.filter === 'pinned' && !g.pinned) continue;
    g.outputs.forEach((o, i) => {
      if (o.kind !== 'image' && o.kind !== 'video') return;
      if ((B.filter === 'image' || B.filter === 'video') && o.kind !== B.filter) return;
      tiles.push(boardTile(g, o, i));
    });
  }
  pauseBoard();
  $('#board').replaceChildren(...(tiles.length ? tiles : [h('div', { class: 'placeholder' },
    B.filter === 'pinned' ? 'Nothing pinned yet. Tap ☆ on any tile.' : 'Nothing generated in this project yet.')]));
  $('#board').querySelectorAll('video').forEach((v) => boardVideos.observe(v));
  count.textContent = `${tiles.length} item${tiles.length === 1 ? '' : 's'}`;
}

function boardTile(g, o, i) {
  const media = o.kind === 'video'
    ? h('video', { src: o.url, muted: true, loop: true, playsInline: true, preload: 'metadata' })
    : h('img', { src: o.url, loading: 'lazy', alt: '' });
  const pin = h('button', { type: 'button', class: 'pin' + (g.pinned ? ' on' : ''), 'aria-label': g.pinned ? 'Unpin' : 'Pin',
    onclick: async (e) => {
      e.stopPropagation();
      try { const r = await api(`/api/generations/${g.id}/pin`, { method: 'POST', body: { pinned: !g.pinned } }); S.history.set(r.id, r); }
      catch (err) { toast(err.message, true); }
    } }, g.pinned ? '★' : '☆');
  return h('div', { class: 'tile', 'data-gen': g.id, onclick: () => openGeneration(g.id) }, media, pin,
    h('div', { class: 'tile-meta' }, `#${g.id} ${g.template}${o.kind === 'video' ? ' ▶' : ''}`));
}

function boardChanged(g) {
  const tiles = $('#board').querySelectorAll(`.tile[data-gen="${g.id}"]`);
  if (!tiles.length || (B.filter === 'pinned' && !g.pinned)) return renderBoard();
  tiles.forEach((t) => { const p = t.querySelector('.pin'); p.classList.toggle('on', !!g.pinned); p.textContent = g.pinned ? '★' : '☆'; });
}

function pauseBoard() { document.querySelectorAll('#board video').forEach((v) => { boardVideos.unobserve(v); v.pause(); }); }

// ---------------------------------------------------------------------------
// zoom + pan on the generate preview: pinch or wheel to zoom, drag to pan, double-tap to reset
// ---------------------------------------------------------------------------
const Z = { s: 1, x: 0, y: 0 };
function wireZoom() {
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

// ---------------------------------------------------------------------------
// full screen (hides the browser bars on the tablet)
// ---------------------------------------------------------------------------
function wireFullscreen() {
  const btn = $('#fsBtn');
  if (!document.documentElement.requestFullscreen) { btn.classList.add('hidden'); return; }
  btn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) { toast('Full screen not available: ' + e.message, true); }
  });
  document.addEventListener('fullscreenchange', () => btn.classList.toggle('on', document.fullscreenElement === document.documentElement));
}

// ---------------------------------------------------------------------------
// queue: what's running and waiting, how long things take, ETA from recent runs of the same template
// ---------------------------------------------------------------------------
const runTime = (g) => (g.finished ? g.finished - (g.started || g.created) : null);
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
    : `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
}

let jobsTimer = null;
async function openJobs() {
  const box = h('div', { class: 'jobs' });
  openSheet(h('h3', {}, 'Queue'), box);
  const refresh = async () => {
    if ($('#sheet').classList.contains('hidden') || !box.isConnected) { clearInterval(jobsTimer); jobsTimer = null; return; }
    let d;
    try { d = await api('/api/jobs'); } catch (e) { box.replaceChildren(h('div', { class: 'note err' }, e.message)); return; }
    const row = (j, right, actions) => h('div', { class: `job ${j.status}`, onclick: () => j.id && openGeneration(j.id) },
      h('div', { class: 'job-main' }, h('b', {}, j.id ? `#${j.id} ` : ''), j.template,
        h('div', { class: 'hint' }, right)), actions);
    const active = d.active.map((j) => row(j,
      j.status === 'running'
        ? `running ${fmtDur(j.elapsed)}${j.typical ? ` of ~${fmtDur(j.typical)}` : ''}`
        : `waiting ${fmtDur(j.waiting)} · ${j.eta != null ? `starts in ~${fmtDur(j.eta - (j.typical || 0))}, done in ~${fmtDur(j.eta)}` : 'no timing yet for this template'}`,
      j.status === 'running'
        ? h('button', { type: 'button', class: 'btn small', onclick: async (e) => { e.stopPropagation(); await stop(); refresh(); } }, 'Stop')
        : h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
            e.stopPropagation();
            try { await api('/api/queue/cancel', { method: 'POST', body: { prompt_id: j.prompt_id } }); refresh(); } catch (err) { toast(err.message, true); }
          } }, 'Cancel')));
    const recent = d.recent.map((g) => row(g,
      `${g.status === 'done' ? `took ${fmtDur(g.duration)}` : g.status} · finished ${new Date(g.finished * 1000).toLocaleTimeString()}`, null));
    box.replaceChildren(
      h('div', { class: 'lbl jobs-head' }, d.active.length ? `Running and waiting (${d.active.length})` : 'Nothing running'),
      ...active,
      h('div', { class: 'lbl jobs-head' }, 'Recent runs'),
      ...(recent.length ? recent : [h('div', { class: 'hint' }, 'None yet')]));
  };
  clearInterval(jobsTimer);
  jobsTimer = setInterval(refresh, 1000);
  refresh();
}

// ---------------------------------------------------------------------------
// projects, tabs, wiring
// ---------------------------------------------------------------------------
async function loadProjects() {
  try { S.projects = await api('/api/projects'); } catch (e) { toast(e.message, true); return; }
  if (!S.projects.find((p) => p.id === S.project)) S.project = S.projects[0]?.id ?? null;
  const sel = $('#projectSel');
  sel.replaceChildren(...S.projects.map((p) => h('option', { value: p.id }, p.name)), h('option', { value: '__new' }, '+ New project…'));
  sel.value = S.project;
}

$('#projectSel').addEventListener('change', async (e) => {
  if (e.target.value === '__new') {
    const name = prompt('Project name');
    if (name && name.trim()) {
      try { const p = await api('/api/projects', { method: 'POST', body: { name } }); S.project = p.id; } catch (err) { toast(err.message, true); }
    }
    await loadProjects();
  } else S.project = Number(e.target.value);
  store.set('deck.project', S.project);
  S.historyDone = false; loadHistory();
});

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'editor') renderEditor();
  if (name === 'video') renderVideo(); else vidPause();
  if (name === 'board') renderBoard(); else pauseBoard();
  $('.actionbar').classList.toggle('hidden', ['editor', 'video', 'board'].includes(name));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('#tplSel').addEventListener('change', (e) => selectTemplate(e.target.value));
$('#reloadTpl').addEventListener('click', async () => { await loadTemplates(true); toast('Templates and model lists reloaded'); });
$('#genBtn').addEventListener('click', () => { const p = S.pendingParent; S.pendingParent = null; generate(p); });
$('#stopBtn').addEventListener('click', stop);
$('#jobsBtn').addEventListener('click', openJobs);
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#moreHistory').addEventListener('click', () => loadHistory(true));
const setBatch = (n) => { S.batch = Math.max(1, Math.min(32, n)); $('#batchVal').textContent = S.batch; };
$('#batchMinus').addEventListener('click', () => setBatch(S.batch - 1));
$('#batchPlus').addEventListener('click', () => setBatch(S.batch + 1));
$('#debugBtn').addEventListener('click', () => {
  const counts = Object.entries(S.debugCounts).map(([k, v]) => `${k}: ${v}`).join('\n');
  openSheet(h('h3', {}, 'Websocket log'),
    h('div', { class: 'hint', style: 'margin-bottom:6px' }, 'Message counts, then unhandled messages. Useful for checking what a custom node sends.'),
    h('div', { class: 'log' }, counts + '\n\n' + (S.debug.slice().reverse().join('\n') || '(nothing unhandled yet)')));
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.queueRemaining) keepAwake(true); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#genBtn').click();
});

// Drag the bar between preview and settings: sideways in landscape, up/down in portrait.
// The size is remembered per orientation; double-tap puts it back.
function wireSplitters() {
  const root = document.documentElement;
  const portrait = () => matchMedia('(max-width: 900px), (orientation: portrait)').matches;
  const restore = () => {
    const w = store.get('deck.split.panelW', null), hh = store.get('deck.split.stageH', null);
    if (w) root.style.setProperty('--panel-w', `${w}px`); else root.style.removeProperty('--panel-w');
    if (hh) root.style.setProperty('--stage-h', `${hh}px`); else root.style.removeProperty('--stage-h');
  };
  restore();
  document.querySelectorAll('.splitter').forEach((sp) => {
    let lastTap = 0;
    sp.addEventListener('pointerdown', (e) => {
      if (Date.now() - lastTap < 300) { store.set('deck.split.panelW', null); store.set('deck.split.stageH', null); restore(); return; }
      lastTap = Date.now();
      e.preventDefault();
      try { sp.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      sp.classList.add('dragging');
      const tab = sp.closest('.tab').getBoundingClientRect();
      const move = (ev) => {
        if (portrait()) {
          const v = Math.round(Math.min(tab.height - 160, Math.max(140, ev.clientY - tab.top - 8)));
          root.style.setProperty('--stage-h', `${v}px`); store.set('deck.split.stageH', v);
        } else {
          const v = Math.round(Math.min(tab.width - 240, Math.max(300, tab.right - ev.clientX - 8)));
          root.style.setProperty('--panel-w', `${v}px`); store.set('deck.split.panelW', v);
        }
      };
      const up = () => { sp.classList.remove('dragging'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
    });
  });
}

// Common phrases for MiniMax H3 prompts, after ComfyUI's H3 prompt guide (docs.comfy.org): shots
// start with [Shot N] and later ones cut at a timestamp; ambience and sound effects go in
// overall_soundscape, background score in non_diegetic_music (N/A for none); speech goes in <d></d>.
// § marks where the cursor lands; ¶ puts the phrase on a new last line (the audio fields); ↵ on a
// new line before the audio fields (shots). A function gets the prompt and returns the phrase.
const H3_PHRASES = [
  ['Structure', [
    ['Next shot', nextShot],
    ['Soundscape:', '¶overall_soundscape: '],
    ['Score:', '¶non_diegetic_music: '],
    ['Dissolve to', 'the shot dissolves to §'],
    ['Fade to black', 'the shot fades to black'],
  ]],
  ['Shots', [
    ['Establishing', 'a wide establishing shot of §'],
    ['Wide', 'a wide shot of §'],
    ['Full body', 'a full shot of § from head to toe'],
    ['Medium', 'a medium shot of §'],
    ['Close-up', 'a close-up of §'],
    ['Extreme CU', 'an extreme close-up of §'],
    ['Two-shot', 'a two-shot of § and '],
    ['Over shoulder', 'an over-the-shoulder shot from behind §, looking at '],
    ['Reaction', 'a reaction close-up of §'],
    ['Insert', 'an insert shot of § in detail'],
    ['POV', 'a first-person POV shot through the eyes of §'],
    ['Low angle', 'a low-angle shot looking up at §'],
    ['High angle', 'a high-angle shot looking down at §'],
    ['Overhead', 'a top-down overhead shot of §'],
    ['Dutch angle', 'a tilted Dutch-angle shot of §'],
    ['Profile', 'a side profile shot of §'],
    ['From behind', 'a shot from behind § as '],
    ['Silhouette', '§ silhouetted against the light'],
  ]],
  ['Camera', [
    ['Static', 'locked-off static camera'],
    ['Handheld', 'subtle handheld shake'],
    ['Push in', 'the camera slowly pushes in'],
    ['Pull back', 'the camera slowly pulls back'],
    ['Pan left', 'the camera pans left'],
    ['Pan right', 'the camera pans right'],
    ['Tilt up', 'the camera tilts up'],
    ['Tilt down', 'the camera tilts down'],
    ['Truck left', 'the camera trucks left alongside §'],
    ['Truck right', 'the camera trucks right alongside §'],
    ['Crane up', 'the camera cranes up to reveal §'],
    ['Crane down', 'the camera cranes down to §'],
    ['Orbit', 'the camera orbits slowly around §'],
    ['Follow', 'the camera follows § from behind'],
    ['Lead', 'the camera moves backwards ahead of § as they walk toward it'],
    ['Zoom in', 'a slow zoom in on §'],
    ['Zoom out', 'a slow zoom out'],
    ['Whip pan', 'a fast whip pan to §'],
    ['Dolly zoom', 'a dolly zoom: the background stretches while § stays the same size'],
    ['Rack focus', 'rack focus from § to '],
    ['Drone', 'an aerial drone shot sweeping over §'],
    ['Slow motion', 'in slow motion'],
  ]],
  ['Lens', [
    ['Shallow DOF', 'shallow depth of field, soft blurred background'],
    ['Deep focus', 'deep focus, everything sharp'],
    ['Wide lens', 'wide-angle lens with strong perspective'],
    ['Telephoto', 'telephoto lens, compressed background'],
    ['Eye level', 'at eye level'],
  ]],
  ['Sound', [
    ['No score', '¶non_diegetic_music: N/A'],
    ['Silent', '¶overall_soundscape: N/A'],
    ['Says <d>', 'says: <d>§</d>'],
    ['Voice-over', 'says in an off-screen voiceover: <d>§</d>'],
    ['Music in scene', 'music playing from a source within the scene: §'],
    ['Room tone', 'quiet room tone'],
    ['Breath & cloth', 'subtle room air, clothing movement, and controlled breathing'],
    ['Ambience', 'ambient sound of §'],
    ['No voices', 'No voice.'],
  ]],
  ['Clean-up', [
    ['One take', 'One continuous shot, no cuts.'],
    ['No subtitles', 'No subtitles, on-screen text or watermarks.'],
  ]],
];

// The next "[Shot N] At mm:ss.mmm, the camera cuts to", 3 s after the last cut (or [Shot 1] first)
function nextShot(text) {
  const nums = [...text.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1]));
  if (!nums.length) return '↵[Shot 1] §';
  const times = [...text.matchAll(/\bAt (\d+):(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  const n = Math.max(...nums) + 1;
  const t = (times.length ? times[times.length - 1] : 0) + 3;
  const stamp = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`;
  return `↵[Shot ${n}] At ${stamp}, the camera cuts to §`;
}

// Insert a phrase at the cursor; "§" in it marks where the cursor goes, else after the phrase.
// A leading "¶" adds it as a new last line instead, "↵" as a new line above the audio fields.
function insertPhrase(ta, text) {
  if (typeof text === 'function') text = text(ta.value);
  if (text.startsWith('↵')) {   // a new line, above the audio fields if there are any
    const m = ta.value.search(/\n\s*(overall_soundscape|non_diegetic_music)\s*:/);
    const at = m >= 0 ? m : ta.value.replace(/\s+$/, '').length;
    ta.value = ta.value.slice(0, at).replace(/\s+$/, '') + ta.value.slice(at);
    const pos = ta.value.slice(0, at).replace(/\s+$/, '').length;
    ta.setSelectionRange(pos, pos);
    text = (pos ? '\n' : '') + text.slice(1);
  }
  if (text.startsWith('¶')) {
    ta.value = ta.value.replace(/\s+$/, '');
    ta.setSelectionRange(ta.value.length, ta.value.length);
    text = (ta.value ? '\n' : '') + text.slice(1);
  }
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  let before = ta.value.slice(0, a);
  const after = ta.value.slice(b);
  const at = text.indexOf('§'), clean = text.replace('§', '');
  // continuing a sentence ("…her face" + "the camera pans left") gets a comma; after "of", "the"… a space
  const comma = !clean.startsWith('\n') && /[\w)]\s*$/.test(before) && /^[a-z]/.test(clean)
    && !/\b(says|of|and|to|the|a|an|at|in|on|by|with|from|as)\s*$/i.test(before);
  if (comma) before = before.replace(/\s+$/, '');
  const pad = comma ? ', ' : before && !/\s$/.test(before) && !clean.startsWith('\n') ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  ta.value = before + pad + clean + tail + after;
  const pos = before.length + pad.length + (at >= 0 ? at : clean.length + tail.length);
  ta.focus(); ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
}

// Touch screens: tapping a text box in a settings panel opens it in a popup at the top, sized to
// the space above the on-screen keyboard. Typing goes straight through to the original box (as
// input events), so everything listening to it keeps working.
function wireTextPopup() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  let src = null;
  const ta = h('textarea', { spellcheck: true });
  const title = h('b');
  const tags = h('div', { class: 'text-pop-tags' });   // the prompt's tag chips, beside the text
  const close = () => {
    if (!src) return;
    const s = src;
    src = null;
    box.classList.add('hidden');
    ta.blur();
    s.dispatchEvent(new Event('change', { bubbles: true }));
    s.dispatchEvent(new Event('grow'));
  };
  const box = h('div', { class: 'text-pop hidden', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'text-pop-bar' }, title,
      h('button', { type: 'button', class: 'btn small primary', onclick: close }, 'Done')),
    h('div', { class: 'text-pop-body' }, ta, tags));
  document.body.append(box);
  const vv = window.visualViewport;
  const fit = () => {
    box.style.top = `${vv ? vv.offsetTop : 0}px`;
    box.style.height = `${vv ? vv.height : innerHeight}px`;
  };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  ta.addEventListener('input', () => {
    if (!src) return;
    src.value = ta.value;
    src.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t === ta || t.tagName !== 'TEXTAREA' || t.readOnly || !t.closest('.panel')) return;
    src = t;
    title.textContent = t.closest('.prompt-part')?.querySelector('.part-head b')?.textContent
      || t.closest('.field')?.querySelector('.lbl')?.firstChild?.textContent || 'Text';
    ta.value = t.value;
    ta.placeholder = t.placeholder || '';
    // the prompt's tag chips (<Picture 1>, Subject 1…) move in here; on touch screens the panel hides them
    const list = [...(t.closest('.prompt-field')?.querySelectorAll('.tag-chips .chip') || [])].map((c) => c.textContent);
    const chip = (label, text = label) => h('button', { type: 'button', class: 'chip',
      title: typeof text === 'string' ? text.replace(/[§¶↵]/g, '') : label,
      onmousedown: (ev) => ev.preventDefault(), onclick: () => insertPhrase(ta, text) }, label);
    const phrases = S.tpl?.tag_style === 'h3' && t.closest('.prompt-field') ? H3_PHRASES : [];
    // phrase groups fold: tap a heading to open or close it (remembered)
    const open = store.get('deck.phraseGroups', { Structure: true });
    const group = ([name, items]) => {
      const body = h('div', { class: 'text-pop-group' + (open[name] ? '' : ' hidden') }, items.map(([l, x]) => chip(l, x)));
      const head = h('button', { type: 'button', class: 'text-pop-head', onmousedown: (ev) => ev.preventDefault(), onclick: () => {
        open[name] = !open[name]; store.set('deck.phraseGroups', open);
        body.classList.toggle('hidden', !open[name]); head.classList.toggle('open', !!open[name]);
      } }, name);
      head.classList.toggle('open', !!open[name]);
      return [head, body];
    };
    tags.replaceChildren(...list.map((x) => chip(x)), ...phrases.flatMap(group));
    tags.classList.toggle('hidden', !list.length && !phrases.length);
    tags.classList.toggle('wide', phrases.length > 0);
    t.blur();
    box.classList.remove('hidden');
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

(async function init() {
  wireSplitters();
  wireTextPopup();
  wireVideoTransport();
  wireZoom();
  wireFullscreen();
  connectWS();
  try { const s = await api('/api/status'); setConn(s.comfy_connected); } catch { /* server down */ }
  await loadProjects();
  await loadTemplates();
  loadHistory();
})();
