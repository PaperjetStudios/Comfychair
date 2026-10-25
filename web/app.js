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

// Every number box is also a slider: drag left or right on it to change the value (its whole min–max
// range over about 300 px, snapped to its step); a tap still types. While dragging it has
// data-scrubbing set and fires 'input'; letting go fires one 'change', like typing does.
const SCRUB_PX = 300;
document.addEventListener('pointerdown', (e) => {
  const inp = e.target.closest?.('input[type=number]');
  if (!inp || inp.disabled || e.button > 0 || document.activeElement === inp) return;
  const x0 = e.clientX, y0 = e.clientY, v0 = parseFloat(inp.value) || 0;
  const min = parseFloat(inp.min), max = parseFloat(inp.max);
  const step = parseFloat(inp.step) || (Number.isInteger(v0) && inp.inputMode === 'numeric' ? 1 : 0.01);
  const span = Number.isFinite(min) && Number.isFinite(max) ? max - min : NaN;
  // per pixel: the range over SCRUB_PX, or a step every 2 px when the range is huge (seeds) or open
  const perPx = Number.isFinite(span) && span <= 1e5 ? span / SCRUB_PX : step / 2;
  const dec = (String(inp.step).split('.')[1] || '').length;
  let on = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(ev.clientY - y0)) return;
      on = true; inp.blur(); inp.dataset.scrubbing = '1'; inp.classList.add('scrubbing');
      try { inp.setPointerCapture(ev.pointerId); } catch { /* the pointer is gone */ }
    }
    ev.preventDefault();
    let v = v0 + dx * perPx;
    v = Math.round(v / step) * step;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    v = Number(v.toFixed(Math.min(6, Math.max(dec, step < 1 ? 2 : 0))));
    if (String(v) !== inp.value) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  const end = () => {
    inp.removeEventListener('pointermove', move); inp.removeEventListener('pointerup', end); inp.removeEventListener('pointercancel', end);
    if (!on) return;
    delete inp.dataset.scrubbing; inp.classList.remove('scrubbing');
    // the tap that ends a drag shouldn't open the keyboard
    inp.addEventListener('click', (c) => { c.preventDefault(); inp.blur(); }, { once: true, capture: true });
    setTimeout(() => inp.blur());
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  inp.addEventListener('pointermove', move);
  inp.addEventListener('pointerup', end);
  inp.addEventListener('pointercancel', end);
}, true);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

// timeout: give up (and say so) instead of hanging when the server or the Wi-Fi is gone. Uploads and
// slow lookups pass a longer one. An error's .data holds the server's detail when it's an object.
// busy: what the progress bar says while it runs (default: a guess from the path for anything that
// isn't a GET; false for none). Uploads go through XHR so the bar can show how much has been sent.
async function api(path, { method = 'GET', body, form, timeout = form ? 300000 : 30000, busy: label } = {}) {
  if (label === undefined) label = method === 'GET' ? false : busyLabel(method, path);
  const b = label ? busy(label) : null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const opts = { method, headers: {}, signal: ctl.signal };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let r, text;
  try {
    r = form ? await xhrSend(path, method, form, ctl.signal, b) : await fetch(path, opts);
    text = await r.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'ComfyDeck didn\'t answer in time (is the server running?)' : 'Can\'t reach ComfyDeck (is the server running and on this network?)');
  } finally { clearTimeout(timer); b?.done(); }
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const d = data && data.detail;
    const err = new Error((d && typeof d === 'object' ? d.message : d) || text || r.statusText);
    if (d && typeof d === 'object') err.data = d;
    throw err;
  }
  return data;
}

// fetch() can't report upload progress; this answers like a fetch Response (ok, status, text())
function xhrSend(path, method, form, signal, b) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, path);
    x.upload.onprogress = (e) => { if (e.lengthComputable) b?.set(null, e.loaded / e.total); };
    x.upload.onload = () => b?.set('Processing…', null);
    x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, statusText: x.statusText, text: async () => x.responseText });
    x.onerror = () => reject(new TypeError('network'));
    x.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => x.abort());
    x.send(form);
  });
}

// ---------------------------------------------------------------------------
// busy bar: a progress bar along the top saying what's happening while something slow runs, and a
// spinner on the button that was tapped to start it. It shows after 150 ms so quick calls don't flash.
// busy(label) → { set(label, frac), done() }; frac 0–1, or null when there's no telling how long.
// ---------------------------------------------------------------------------
const BUSY = new Set();
let busyTimer = 0, lastTap = { el: null, t: 0 };
document.addEventListener('click', (e) => { lastTap = { el: e.target.closest?.('button, .btn') || null, t: Date.now() }; }, true);
function busy(label) {
  const t = { label, frac: null, btn: null,
    set(l, f = null) { if (l) t.label = l; t.frac = f; drawBusy(); },
    done() { if (!BUSY.delete(t)) return; if (t.btn && ![...BUSY].some((o) => o.btn === t.btn)) t.btn.classList.remove('working'); drawBusy(); } };
  if (lastTap.el?.isConnected && Date.now() - lastTap.t < 1000) {
    t.btn = lastTap.el;
    setTimeout(() => { if (BUSY.has(t)) t.btn.classList.add('working'); }, 150);
  }
  BUSY.add(t); drawBusy();
  return t;
}
function drawBusy() {
  const el = $('#busy');
  if (!BUSY.size) { clearTimeout(busyTimer); busyTimer = 0; el.classList.add('hidden'); return; }
  if (el.classList.contains('hidden')) {
    if (!busyTimer) busyTimer = setTimeout(() => { busyTimer = 0; if (BUSY.size) { el.classList.remove('hidden'); drawBusy(); } }, 150);
    return;
  }
  const t = [...BUSY].at(-1), pct = t.frac == null ? null : Math.round(t.frac * 100);
  el.classList.toggle('indet', pct == null);
  el.querySelector('.busy-fill').style.width = pct == null ? '' : `${pct}%`;
  el.querySelector('.busy-label').textContent = pct == null ? t.label : `${t.label} ${pct}%`;
}
const BUSY_LABELS = [[/\/to-input$/, 'Preparing image…'], [/\/inputs\/crop$/, 'Cropping…'], [/\/(upload|media)$/, 'Uploading…'],
  [/\/video\/render$/, 'Rendering video…'], [/\/scene\/render$/, 'Sending depth video…'], [/\/generate$/, 'Sending to ComfyUI…']];
function busyLabel(method, path) {
  if (method === 'DELETE') return 'Deleting…';
  const p = path.split('?')[0];
  return (BUSY_LABELS.find(([re]) => re.test(p)) || [null, 'Working…'])[1];
}

// action: { label, fn } adds a button (e.g. Undo) and keeps the toast up a little longer
let toastTimer;
function toast(msg, err = false, action = null) {
  const t = $('#toast');
  // replaceChildren() would turn a null into the text "null", so only pass the button when there is one
  t.replaceChildren(h('span', {}, msg), ...(action ? [h('button', { type: 'button', class: 'btn small toast-act', onclick: () => {
    t.classList.add('hidden'); action.fn();
  } }, action.label)] : []));
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 7000 : action ? 6000 : 2500);
}
const undoToast = (msg, fn) => toast(msg, false, { label: '↶ Undo', fn });

// Deleting a saved snippet (settings, prompt part, prompt set) with an Undo that saves it again
async function deleteSnippet(sn, msg, after) {
  await api(`/api/snippets/${sn.id}`, { method: 'DELETE' });
  await loadSnippets(true); after();
  undoToast(msg, async () => {
    try {
      await api('/api/snippets', { method: 'POST', body: { category: sn.category, name: sn.name, text: sn.text } });
      await loadSnippets(true); after(); toast('Restored');
    } catch (e) { toast(e.message, true); }
  });
}

// ---------------------------------------------------------------------------
// overlays and the back button: each sheet / full-screen editor adds a history entry, so Android's
// back gesture (and the browser's back) closes the top overlay instead of leaving the app.
// close(true) is called when it was closed by going back.
// ---------------------------------------------------------------------------
const OV = [];
let popSkip = 0;
function overlayOpened(close) { OV.push(close); history.pushState({ deckOverlay: OV.length }, ''); }
function overlayClosed(close) {
  const i = OV.lastIndexOf(close);
  if (i < 0) return;
  OV.splice(i, 1);
  popSkip++; history.back();
}
addEventListener('popstate', () => {
  if (popSkip) { popSkip--; return; }
  const close = OV.pop();
  if (close && close(true) === false) { OV.push(close); history.pushState({ deckOverlay: OV.length }, ''); }  // it said no (unsaved work)
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const S = {
  templates: [], tpl: null,
  values: {}, seedMode: {}, imageMp: {}, imageCrop: {}, sizeMode: {}, loraFolder: {}, builder: {}, lastSeed: {},
  projects: [], project: store.get('deck.project', null),
  batch: 1, connected: false, queueRemaining: 0,
  history: new Map(), historyDone: false,
  // runs queued from this device (kept across reloads), so only their previews and results take over
  // the viewer; other tablets' runs just show as "busy"
  myPrompts: new Set(store.get('deck.myPrompts', [])), viewing: null,   // generation currently in the viewer
  activePid: null,   // what ComfyUI is running right now, whoever queued it
  executingNode: null, debug: [], debugCounts: {},
};
function addMine(pid) {
  S.myPrompts.add(pid);
  store.set('deck.myPrompts', [...S.myPrompts].slice(-300));
}
const isMine = (pid) => !!pid && S.myPrompts.has(pid);

// ---------------------------------------------------------------------------
// templates + fields
// ---------------------------------------------------------------------------
function stateKey(id) { return `deck.tpl.${id}`; }
function persist() {
  if (!S.tpl) return;
  store.set(stateKey(S.tpl.id), { values: S.values, seedMode: S.seedMode, imageMp: S.imageMp, imageCrop: S.imageCrop, sizeMode: S.sizeMode, loraFolder: S.loraFolder, builder: S.builder });
}

async function loadTemplates(refresh = false) {
  let failed = null;
  try {
    S.templates = await api('/api/templates' + (refresh ? '?refresh=1' : ''));
  } catch (e) { failed = e; S.templates = []; }
  const sel = $('#tplSel');
  sel.replaceChildren(...S.templates.map((t) => h('option', { value: t.id }, t.name + (t.error ? ' (error)' : ''))));
  if (!S.templates.length) {
    $('#fields').replaceChildren(failed
      ? h('div', { class: 'note err' }, `Couldn't load templates: ${failed.message}. They load by themselves once ComfyDeck answers.`)
      : h('div', { class: 'note warn' }, 'No templates yet. Export a workflow from ComfyUI with Workflow → Export (API), tag nodes with @, and put it in the templates/ folder.'));
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
  $('#fields').replaceChildren(shotBar(), ...groups);
  if (!S.snippets) loadSnippets().then(() => renderFields());
}

function setVal(key, v) { S.values[key] = v; persist(); }

// ---------------------------------------------------------------------------
// saved shots: the whole template at once (prompt and its builder parts, images and crops, every
// setting, seed modes), for this workflow. ◀ ▶ load the previous/next shot (with an Undo),
// 💾 saves over the loaded one, ＋ saves a new one. Stored with the snippets, so every device sees them.
// ---------------------------------------------------------------------------
const SHOT_CATEGORY = 'Saved shot';
const clone = (x) => JSON.parse(JSON.stringify(x ?? null));

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
  const stateKey2 = `deck.shot.${S.tpl.id}`;
  const entries = () => (S.snippets || []).filter((x) => x.category === SHOT_CATEGORY)
    .map((x) => { try { return { ...x, p: JSON.parse(x.text) }; } catch { return null; } })
    .filter((x) => x && x.p.workflow === S.tpl.id)
    .sort((a, b) => a.created - b.created);
  const curId = () => String(store.get(stateKey2, ''));
  const l = entries(), i = l.findIndex((x) => String(x.id) === curId());
  const go = (d) => {
    const list = entries();
    if (!list.length) return toast('No saved shots yet: ＋ saves this one');
    const at = list.findIndex((x) => String(x.id) === curId());
    const x = list[at < 0 ? (d > 0 ? 0 : list.length - 1) : (at + d + list.length) % list.length];
    const before = captureShot(), beforeId = curId();
    store.set(stateKey2, String(x.id));
    applyShot(x.p);
    undoToast(`Loaded shot "${x.name}"`, () => { store.set(stateKey2, beforeId); applyShot(before); });
  };
  const saveNew = () => {
    const name = h('input', { type: 'text', placeholder: 'Name, e.g. "Market walk – wide"' });
    openSheet(h('h3', {}, 'Save shot'),
      h('div', { class: 'hint', style: 'margin-bottom:8px' }, `Saves everything in ${S.tpl.name}: the prompt (and its parts), images, LoRAs and every setting.`),
      name,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('/api/snippets', { method: 'POST', body: { category: SHOT_CATEGORY, name: name.value.trim() || `Shot ${entries().length + 1}`,
            text: JSON.stringify(captureShot()) } });
          store.set(stateKey2, String(r.id));
          await loadSnippets(true); closeSheet(); renderFields(); toast(`Saved shot "${r.name}"`);
        } catch (e) { toast(e.message, true); }
      } }, 'Save')));
    setTimeout(() => name.focus(), 50);
  };
  const saveOver = async () => {
    const x = entries().find((y) => String(y.id) === curId());
    if (!x) return saveNew();
    try {
      await api('/api/snippets', { method: 'POST', body: { id: x.id, category: SHOT_CATEGORY, name: x.name, text: JSON.stringify(captureShot()) } });
      await loadSnippets(true); renderFields(); toast(`Saved over "${x.name}"`);
    } catch (e) { toast(e.message, true); }
  };
  const del = async () => {
    const x = entries().find((y) => String(y.id) === curId());
    if (!x) return toast('No saved shot loaded');
    store.set(stateKey2, '');
    try { await deleteSnippet(x, `Deleted shot "${x.name}"`, renderFields); } catch (e) { toast(e.message, true); }
  };
  return h('div', { class: 'part-head saved-bar shot-bar' }, h('b', {}, 'Shots'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous saved shot', onclick: () => go(-1) }, '◀'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next saved shot', onclick: () => go(1) }, '▶'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Save over this shot', title: 'Save over this one', onclick: saveOver }, '💾'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Save as a new shot', title: 'Save as new', onclick: saveNew }, '＋'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete this saved shot', onclick: del }, '🗑'),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back to the template defaults', title: 'Template defaults: the prompt and settings as the template file has them',
      onclick: () => {
        const before = captureShot(), beforeId = curId();
        store.set(stateKey2, '');
        applyShot({ values: Object.fromEntries(S.tpl.fields.map((f) => [f.key, f.value])) });
        undoToast('Back to the template defaults', () => { store.set(stateKey2, beforeId); applyShot(before); });
      } }, '↺'),
    h('span', { class: 'snip-pos' }, !l.length ? 'No saved shots · ＋ saves everything here'
      : i < 0 ? `${l.length} saved · none loaded` : `${i + 1}/${l.length} · ${l[i].name}`));
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
    store.set(stateKey2, '');
    try { await deleteSnippet(x, `Deleted "${x.name}"`, renderFields); }
    catch (e) { toast(e.message, true); }
  };
  show();
  return h('div', { class: 'part-head saved-bar' }, h('b', {}, 'Presets'),
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
  const setMp = (n) => { m.mp = Math.min(16, Math.max(0.05, Math.round(n * 100) / 100)); mpIn.value = m.mp; applyPreset(); };
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
  return h('div', { class: 'field' },
    h('label', { class: 'lbl' }, h('span', {}, f.label), hasRange ? h('span', {}, `${lo}–${hi}`) : null),
    h('div', { class: 'stepper' },
      h('button', { type: 'button', onclick: () => bump(-1), 'aria-label': 'Decrease' }, '−'),
      input,
      h('button', { type: 'button', onclick: () => bump(1), 'aria-label': 'Increase' }, '+')),
    range);
}

function seedField(f) {
  const mode = S.seedMode[f.key] || 'random';
  const input = h('input', { type: 'number', inputMode: 'numeric', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, value: S.values[f.key] });
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
  const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete this saved ${cat.toLowerCase()}`, onclick: async () => {
    const sn = lib()[idx()];
    if (!sn) return;
    try { await deleteSnippet(sn, `Deleted "${sn.name}" from saved`, showPos); }
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
      try { await deleteSnippet(sn, `Deleted set "${sn.name}"`, show); }
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

const thumbUrl = (name, px = 320) => `/api/input?name=${encodeURIComponent(name)}&thumb=${px}`;

function mpInput(get, set) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min: 0, max: 16, step: 0.05, value: get() });
  input.addEventListener('change', () => {
    const n = Math.min(16, Math.max(0, parseFloat(input.value) || 0));
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
  const thumb = h('button', { type: 'button', class: 'thumb', onclick: pick, 'aria-label': 'Choose video' },
    src && src.o ? mediaEl(src.o, { thumb: true }) : h('span', { class: 'hint' }, '+ video'));
  return h('div', { class: 'field', 'data-key': f.key },
    h('label', { class: 'lbl' }, h('span', {}, f.label), h('span', {}, src ? src.label : 'empty')),
    h('div', { class: 'imgfield' }, thumb,
      h('div', { class: 'actions' },
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: pick }, 'Choose…'),
          v ? h('button', { type: 'button', class: 'btn small', onclick: () => { setVal(f.key, null); renderFields(); } }, 'Clear') : null))));
}

// this project's video outputs, newest first, plus the Video tab's uploaded clips
async function openVideoPicker({ title, onPick }) {
  const grid = h('div', { class: 'grid gallery' });
  const file = h('input', { type: 'file', accept: 'video/*', class: 'hidden' });
  const picked = (val) => { closeSheet(); onPick(val); };
  const card = (o, label, val) => {
    const c = h('button', { class: 'card' }, h('div', { class: 'media' }, mediaEl(o, { thumb: true })),
      h('div', { class: 'meta' }, h('span', { class: 'name' }, label)));
    c.addEventListener('click', () => picked(val));
    return c;
  };
  const draw = async () => {
    grid.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    if (!S.history.size) await loadHistory();
    let media = [];
    try { media = (await api('/api/media')).filter((m) => m.kind === 'video'); } catch { /* the outputs still show */ }
    const items = [];
    for (const g of S.history.values()) {
      if (g.project_id !== S.project || g.status !== 'done') continue;
      g.outputs.forEach((o, i) => {
        if (o.kind === 'video') items.push({ t: g.finished || g.created, el: () => card(o, `#${g.id} ${g.template}`, { generation: g.id, index: i }) });
      });
    }
    for (const m of media) items.push({ t: m.created, el: () => card(m, m.label, { media: m.name }) });
    items.sort((x, y) => y.t - x.t);
    grid.replaceChildren(...(items.length ? items.slice(0, 300).map((x) => x.el())
      : [h('div', { class: 'placeholder' }, 'No videos in this project yet. Generate one or upload a clip.')]));
  };
  file.addEventListener('change', async () => {
    const fl = file.files[0]; file.value = '';
    if (!fl) return;
    toast(`Uploading ${fl.name}…`);
    const form = new FormData(); form.append('file', fl);
    try { const m = await api('/api/media', { method: 'POST', form }); picked({ media: m.name }); }
    catch (e) { toast('Upload failed: ' + e.message, true); }
  });
  openSheet(h('h3', {}, title),
    h('div', { class: 'picker-bar' },
      h('button', { type: 'button', class: 'btn small primary', onclick: () => file.click() }, 'Upload…')),
    grid, file);
  draw();
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
    const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame', scene: '3d' };
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
    case 'video': return videoField(f);
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
  const odd = S.tpl.fields.filter((f) => f.kind === 'text' && unmatchedBraces(values[f.key]));
  if (odd.length && !confirm(`${odd.map((f) => f.label).join(', ')}: the { } don't match, so some wildcard text would go to the model as written. Generate anyway?`)) return;
  const btn = $('#genBtn'); btn.disabled = true;
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
function adoptGenerations(gens) {
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
async function stop(pid = RUN.pid, { ask = true } = {}) {
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
async function keepAwake(on) {
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
// "it's done": a chime, ✓ in the tab title, and a system notification where allowed (HTTPS)
// ---------------------------------------------------------------------------
let audioCtx = null;
function notifyPrepare() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  if (window.Notification && isSecureContext && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function chime(ok = true) {
  if (!audioCtx || store.get('deck.chime', true) === false) return;
  const t = audioCtx.currentTime;
  (ok ? [660, 880] : [440, 330]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.32);
  });
}
const BASE_TITLE = document.title;
function notifyDone(g) {
  const ok = g.status === 'done';
  const took = runTime(g);
  if (took == null || took > 15 || document.hidden) chime(ok);  // quick image runs stay quiet while you watch
  try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]); } catch { /* not supported */ }
  if (document.hidden) {
    document.title = `${ok ? '✓ Done' : '✕ Failed'} · ${BASE_TITLE}`;
    if (window.Notification && Notification.permission === 'granted') {
      const title = ok ? `#${g.id} is done` : `#${g.id} failed`;
      const opts = { body: ok ? `${g.template}${took ? ` · ${fmtDur(took)}` : ''}` : (g.error || ''), tag: 'comfydeck', icon: 'icon-192.png' };
      // Android only shows notifications through the service worker
      (navigator.serviceWorker?.controller ? navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts))
        : Promise.resolve().then(() => new Notification(title, opts))).catch(() => { /* not allowed here */ });
    }
  }
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
  if (!isMine(S.activePid)) return;  // another device's run: its previews are its own
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
  // a still preview is drawn once, then the loop sleeps until the next frame arrives (showLive
  // wakes it); only an animated preview keeps it running
  P.raf = P.frames.length > 1 ? requestAnimationFrame(tick) : 0;
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
  runChip(value, max, text || '');
}

// The same progress on the Generate tab, for when another tab is open: a chip with the percentage
// (a spinner before the steps start), then ✓ or ! when it ends. CSS hides it on the Generate tab itself.
function runChip(value, max, text) {
  const chip = $('#runChip'), tab = chip.parentElement;
  const state = !text ? null : /^Finished/.test(text) ? 'done' : /^(Stopped|Failed)/.test(text) ? 'fail'
    : /another device/.test(text) ? 'other' : 'run';
  // a ✓ or ! stays until the Generate tab is opened, so it's still there after a long time away
  if (!state && /\b(done|fail)\b/.test(chip.className) && !tab.classList.contains('active')) return;
  const pct = max ? Math.round((100 * value) / max) : null;
  chip.className = 'tab-chip' + (state ? ` ${state}` : ' hidden') + ((state === 'run' || state === 'other') && pct == null ? ' spin' : '');
  chip.textContent = state === 'done' ? '✓' : state === 'fail' ? '!' : pct != null ? `${pct}%` : '';
  tab.style.setProperty('--run', state === 'run' && pct != null ? `${pct}%` : '0%');
  tab.title = state ? `Generate · ${text}` : 'Generate';
}

// ---------------------------------------------------------------------------
// run stages: "Loading models → Encoding prompt → Sampling 13/20 → Decoding → Saving" with timings
// ---------------------------------------------------------------------------
const RUN = { pid: null, stages: [], current: null, title: '', step: null, t0: 0, stageT0: 0, done: new Set(), timer: 0 };

// elapsed / stages: picking up a run that was already going (after a reload or a dropped connection)
function runStart(pid, { elapsed = 0, stages = [] } = {}) {
  const t0 = Date.now() - elapsed * 1000;
  Object.assign(RUN, { pid, stages, current: null, title: '', step: null, t0, stageT0: Date.now(), done: new Set(), endedAt: 0 });
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
// outcome: 'done' (the result follows as a deck_generation), 'stopped' or 'failed' (nothing follows,
// so the live preview goes now)
function runEnd(outcome = 'done') {
  if (!RUN.pid) return;
  clearInterval(RUN.timer);
  if (RUN.current) RUN.done.add(RUN.current);
  RUN.current = null; drawStages();
  const took = fmtDur((Date.now() - RUN.t0) / 1000);
  RUN.pid = null; RUN.endedAt = Date.now();
  setProgress(0, 0, outcome === 'done' ? `Finished in ${took}` : outcome === 'stopped' ? `Stopped after ${took}` : `Failed after ${took}`);
  if (outcome !== 'done') restoreViewer();
  // safety net: if the result never shows up (missed message), don't leave the LIVE frame up
  else setTimeout(() => { if (!RUN.pid && $('#viewer').classList.contains('live')) restoreViewer(); }, 15000);
  setTimeout(() => { if (!RUN.pid) { $('#stageBar').classList.add('hidden'); setProgress(0, 0, ''); } }, 6000);
}

// Drop the live preview and show the last result again
function restoreViewer() {
  clearLive();
  const g = S.viewing != null && S.history.get(S.viewing);
  if (g && g.outputs.length && !$('#viewerMedia').childElementCount) showOutput(g);
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
  for (const t of [S.tpl, ...S.templates]) if (t?.node_titles?.[id]) return t.node_titles[id].replace(/^@\s*\d*\s*/, '');
  return id;
}

function logDebug(line) {
  S.debug.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (S.debug.length > 300) S.debug.shift();
}

// One socket at a time. When it drops (the tablet slept, Wi-Fi blipped, the server restarted) it
// reconnects with a growing delay, and every (re)connect resyncs with the server, since anything
// sent while it was down is lost.
const WS = { sock: null, ping: 0, retry: 0, timer: 0, everOpen: false };
function connectWS() {
  clearTimeout(WS.timer);
  if (WS.sock && WS.sock.readyState <= 1) return;   // connecting or open already
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  WS.sock = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    WS.retry = 0; WS.everOpen = true;
    setServer(true);
    syncWithServer();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { onBinary(e.data); return; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    if (WS.sock !== ws) return;
    clearInterval(WS.ping);
    WS.sock = null;
    setServer(false);
    WS.timer = setTimeout(connectWS, Math.min(10000, 1000 * 2 ** WS.retry++));
  };
  clearInterval(WS.ping);
  WS.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
}

// Coming back to the tab (tablet woke up): the socket may be dead without knowing it yet, so open a
// fresh one if it isn't plainly open, and catch up either way.
function onResume() {
  document.title = BASE_TITLE;
  if (!WS.sock || WS.sock.readyState !== 1) { WS.retry = 0; if (WS.sock) { const s = WS.sock; WS.sock = null; try { s.close(); } catch { /* gone */ } } connectWS(); }
  else syncWithServer();
}

// Two separate things can be down: ComfyDeck itself (no socket) or ComfyUI behind it.
function setServer(on) { S.serverUp = on; showConn(); }
function setConn(on) { S.connected = on; showConn(); }
function showConn() {
  const server = S.serverUp !== false, comfy = S.connected;
  $('#connDot').classList.toggle('on', server && comfy);
  $('#connDot').title = !server ? 'Can\'t reach ComfyDeck' : comfy ? 'ComfyUI connected' : 'ComfyUI not connected';
  const banner = $('#connBanner');
  // a blip while reconnecting isn't worth a banner; only say something once it lasts
  clearTimeout(showConn.t);
  const text = !server ? 'Can\'t reach ComfyDeck. Reconnecting… (is the server running and the tablet on the same Wi-Fi?)'
    : !comfy ? 'ComfyDeck is up, but ComfyUI isn\'t connected. It reconnects by itself once ComfyUI is running.' : '';
  if (!text) { banner.classList.add('hidden'); return; }
  showConn.t = setTimeout(() => { banner.textContent = text; banner.classList.remove('hidden'); }, WS.everOpen || !server ? 2500 : 0);
}

// Catch up after a reload, a dropped socket or the tablet waking: what's running now (pick its
// progress back up if it's ours), and any results that landed while we weren't listening.
let syncing = null;
function syncWithServer() {
  syncing ||= (async () => {
    try {
      if (!S.projects.length) await loadProjects();
      if (!S.templates.length) await loadTemplates();
      try { const s = await api('/api/status'); setConn(s.comfy_connected); } catch { /* the socket says the rest */ }
      const jobs = await api('/api/jobs');
      const running = jobs.active.find((j) => j.status === 'running');
      S.activePid = running ? running.prompt_id : null;
      S.queueRemaining = jobs.active.length;
      $('#queueInfo').textContent = jobs.active.length ? ` · ${jobs.active.length}` : '';
      const wasRunning = RUN.pid;
      if (running && isMine(running.prompt_id)) {
        if (RUN.pid !== running.prompt_id) {
          runStart(running.prompt_id, { elapsed: running.elapsed || 0, stages: running.stages || [] });
          $('#viewerMedia').replaceChildren(); $('#outStrip').replaceChildren();
        }
        keepAwake(true);
      } else if (RUN.pid) runEnd();   // it ended while we weren't listening; the result is fetched below
      showBusy();
      // results we missed: fetch them, and show ours if it's newer than what's in the viewer
      const fresh = await api(`/api/generations?limit=30${S.project != null ? `&project_id=${S.project}` : ''}`);
      let newest = null;
      for (const g of fresh) {
        const old = S.history.get(g.id);
        S.history.set(g.id, g);
        if (old && old.status === g.status) continue;
        if (isMine(g.prompt_id) && (g.status === 'done' || g.status === 'error') && (!old || old.status === 'queued' || old.status === 'running')) {
          if (!newest || g.id > newest.id) newest = g;
        }
      }
      if (newest && (!S.viewing || newest.id > S.viewing) && !RUN.pid) {
        if (newest.status === 'done') showOutput(newest);
        else { clearLive(); $('#viewerMedia').replaceChildren(h('div', { class: 'placeholder' }, `Error: ${newest.error || ''}`)); }
        if (wasRunning || document.hidden) notifyDone(newest);
      } else if (!RUN.pid && $('#viewer').classList.contains('live')) restoreViewer();
      if (!jobs.active.length) keepAwake(false);
      if ($('#tab-history').classList.contains('active')) renderHistory();
    } catch (e) {
      logDebug(`sync failed: ${e.message}`);
    } finally { syncing = null; }
  })();
  return syncing;
}

// While another device's run is going, say so (its previews aren't shown here)
function showBusy() {
  if (RUN.pid || !S.activePid || isMine(S.activePid)) return;
  if (Date.now() - (RUN.endedAt || 0) < 6000) return;
  setProgress(0, 0, 'ComfyUI is busy with a run from another device');
}

function onMessage(m) {
  const d = m.data || {};
  S.debugCounts[m.type] = (S.debugCounts[m.type] || 0) + 1;
  // most run messages only matter here if the run is ours; other devices' runs show as "busy"
  const mine = d.prompt_id ? isMine(d.prompt_id) : isMine(S.activePid);
  switch (m.type) {
    case 'deck_comfy_status': setConn(d.connected); break;
    case 'status': {
      const q = d.status?.exec_info?.queue_remaining ?? 0;
      S.queueRemaining = q;
      $('#queueInfo').textContent = q ? ` · ${q}` : '';
      if (!q) {
        S.activePid = null;
        keepAwake(false);
        if (!RUN.pid && Date.now() - (RUN.endedAt || 0) > 6000) setProgress(0, 0, '');  // keep "Finished in …" up a while
      }
      break;
    }
    case 'execution_start':
      S.activePid = d.prompt_id;
      if (!mine) { showBusy(); break; }
      clearLive(); showLive(); setProgress(0, 0, 'Starting…');
      runStart(d.prompt_id);
      $('#viewerMedia').replaceChildren();
      $('#outStrip').replaceChildren();
      break;
    case 'execution_cached': break;
    case 'executing':
      S.executingNode = d.node;
      if (!d.node) { if (mine) runEnd(); S.activePid = null; }
      else if (!RUN.pid && mine) setProgress(0, 0, nodeName(d.node));  // no stage info (e.g. an older server)
      break;
    case 'deck_stages': runStages(d); break;
    case 'deck_stage': runStage(d); break;
    case 'deck_cached': runCached(d); break;
    case 'progress':
      if (!mine) {
        if (!RUN.pid) setProgress(d.value, d.max, `ComfyUI is busy with another device's run · ${d.value}/${d.max}`);
        break;
      }
      RUN.step = [d.value, d.max];
      if (RUN.pid) runText(); else setProgress(d.value, d.max, `${nodeName(d.node || S.executingNode)} · ${d.value}/${d.max}`);
      break;
    case 'VHS_latentpreview': // VideoHelperSuite animated sampler preview metadata
      if (mine) P.anim = { length: d.length || 1, rate: d.rate || 8 };
      logDebug(`VHS_latentpreview ${JSON.stringify(d)}`);
      break;
    case 'execution_interrupted':
      if (mine) runEnd('stopped');
      S.activePid = null;
      break;
    case 'execution_error':
      S.activePid = null;
      if (!mine) break;
      runEnd('failed');
      toast(`Error in ${d.node_type || 'node'}: ${d.exception_message || ''}`, true);
      break;
    case 'deck_generation': onGeneration(d); break;
    case 'deck_generation_deleted':
      S.history.delete(d.id); removeCard(d.id);
      document.querySelectorAll(`#board .tile[data-gen="${d.id}"]`).forEach((t) => { B.sel.delete(t.dataset.key); t.remove(); });
      if (GAL.el) galleryRefresh();
      break;
    case 'progress_state': case 'executed': case 'execution_success': break;
    default: logDebug(`${m.type} ${JSON.stringify(d).slice(0, 300)}`);
  }
}

function onGeneration(g) {
  const old = S.history.get(g.id);
  S.history.set(g.id, g);
  const finished = (g.status === 'done' || g.status === 'error') && (!old || old.status !== g.status);
  if (finished && isMine(g.prompt_id)) {
    // a result that lands while another of our runs is already previewing mustn't take over the viewer
    const busy = RUN.pid && RUN.pid !== g.prompt_id;
    if (g.status === 'done') {
      if (busy) toast(`#${g.id} finished (see History)`);
      else { showOutput(g); if (!RUN.pid && Date.now() - (RUN.endedAt || 0) > 6000) setProgress(0, 0, ''); }
    } else if (busy) toast(`#${g.id} failed: ${g.error || ''}`, true);
    else {
      clearLive();
      $('#viewerMedia').replaceChildren(h('div', { class: 'placeholder' }, `Error: ${g.error || ''}`));
    }
    notifyDone(g);
  }
  if ($('#tab-history').classList.contains('active')) updateCard(g);
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

// One generation changed: swap just its card (redrawing the grid reloads every video thumbnail)
function updateCard(g) {
  const grid = $('#historyGrid');
  const el = grid.querySelector(`.card[data-gen="${g.id}"]`);
  if (g.project_id !== S.project) { if (el) el.remove(); return; }
  if (el) { el.replaceWith(cardEl(g)); return; }
  const cards = [...grid.querySelectorAll('.card[data-gen]')];
  if (!cards.length) return renderHistory();
  const after = cards.find((c) => Number(c.dataset.gen) < g.id);
  if (after) after.before(cardEl(g));
  else if (S.historyDone) grid.append(cardEl(g));  // older than everything shown: only add if the list is complete
}
function removeCard(id) {
  const el = $('#historyGrid').querySelector(`.card[data-gen="${id}"]`);
  if (el) el.remove();
}

function cardEl(g) {
  const o = g.outputs[0];
  return h('button', { class: 'card', 'data-gen': g.id, onclick: () => openGeneration(g.id) },
    h('div', { class: 'media' },
      o ? mediaEl(o, { thumb: true }) : h('span', { class: 'hint' }, g.status),
      o && o.kind === 'video' ? h('span', { class: 'play' }, '▶ video') : null,
      g.outputs.length > 1 ? h('span', { class: 'play', style: 'left:6px;right:auto' }, `${g.outputs.length}`) : null),
    h('div', { class: 'meta' }, h('span', {}, `#${g.id} ${g.template}`),
      h('span', { class: `badge ${g.status}` }, g.status === 'done' && runTime(g) != null ? fmtDur(runTime(g)) : g.status)));
}

// S.sheetSeq counts sheets opened, so a slow lookup can tell whether its sheet is still the one showing
function openSheet(...content) {
  S.sheetGen = null;
  S.sheetSeq = (S.sheetSeq || 0) + 1;
  const wasOpen = !$('#sheet').classList.contains('hidden');
  $('#sheet').replaceChildren(
    h('button', { class: 'icon-btn close', onclick: () => closeSheet(), 'aria-label': 'Close' }, '✕'),
    ...content.flat().filter((c) => c != null && c !== false));
  $('#sheet').classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
  if (!wasOpen) overlayOpened(sheetBack);
  return S.sheetSeq;
}
const sheetBack = () => closeSheet(true);
function closeSheet(viaBack = false) {
  if ($('#sheet').classList.contains('hidden')) return;
  S.sheetGen = null;
  $('#sheet').querySelectorAll('video').forEach((v) => v.pause());
  $('#sheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden');
  if (viaBack !== true) overlayClosed(sheetBack);  // (used as a click handler too, so viaBack may be an event)
}
const sheetStillOpen = (seq) => seq === S.sheetSeq && !$('#sheet').classList.contains('hidden');

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
  const isScene = g.template === '3d scene';  // a depth video from the 3D tab, with its scene in the params
  const isPhoto = g.template === '3d photo';  // a picture as a mesh (MoGe), for the 3D tab
  const isEdit = g.template === 'video edit' || isScene || isPhoto;  // made in the Video or 3D tab: no template to replay
  const actions = isPhoto ? [
    h('button', { class: 'btn small primary', onclick: async () => {
      closeSheet(); switchTab('scene'); (await sceneModule()).addPhoto(g);
    } }, 'Add to 3D'),
  ] : isScene ? [
    h('button', { class: 'btn small primary', onclick: async () => {
      closeSheet(); switchTab('scene'); (await sceneModule()).open(g.params.scene);
    } }, 'Open in 3D'),
    h('button', { class: 'btn small', onclick: () => { closeSheet(); useControlVideo(g, g.params.scene || {}); } }, 'Use in H3 control'),
  ] : isEdit ? [] : [
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
    h('table', { class: 'params' }, Object.entries(g.params).filter(([k]) => !k.startsWith('__') && !(isScene && k === 'scene')).map(([k, v]) =>
      h('tr', {}, h('td', {}, labelFor(k)), h('td', { style: 'white-space:pre-wrap' }, fmt(v))))));
  S.sheetGen = g.id;
}

// The 3D tab (web/scene.js, with three.js) loads the first time it's needed.
let sceneMod = null;
async function sceneModule() {
  if (!sceneMod) {
    sceneMod = await import('./scene.js');
    sceneMod.init({ h, $, api, busy, toast, undoToast, store, S, uploadImage, useControlVideo, openSheet, closeSheet, iconBtn, propNum, propsTitle, layerRowsEl, openImagePicker });
  }
  return sceneMod;
}

// A depth video from the 3D tab into deck-h3-ctrl2v: its control video, size and length.
async function useControlVideo(g, sc) {
  if (!S.templates.find((t) => t.id === 'deck-h3-ctrl2v')) return toast('Template deck-h3-ctrl2v is missing', true);
  S.history.set(g.id, S.history.get(g.id) || g);
  switchTab('generate');
  if (S.tpl?.id !== 'deck-h3-ctrl2v') selectTemplate('deck-h3-ctrl2v');
  const fs = S.tpl.fields;
  const video = fs.find((f) => f.kind === 'video');
  if (video) setVal(video.key, { generation: g.id, index: 0 });
  const int = (re) => fs.find((f) => f.kind === 'int' && re.test(f.input === 'value' ? f.label : f.input));
  if (sc.width && int(/^width$/)) setVal(int(/^width$/).key, sc.width);
  if (sc.height && int(/^height$/)) setVal(int(/^height$/).key, sc.height);
  if (sc.seconds && int(/length/i)) setVal(int(/length/i).key, sc.seconds);
  S.pendingParent = { generation: g.id, index: 0 };
  renderFields();
  toast(`Control video #${g.id} set: add references and a prompt`);
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
  selectTemplate(g.template, { ...g.params, ...g.params.__wildcards });  // prompts with their {a|b} wildcards, not this run's picks
  switchTab('generate');
  if (g.outputs.length) showOutput(g);
  toast(`Loaded #${g.id}'s settings (seed fixed${g.params.__wildcards ? ', wildcards re-roll' : ''}). Edit and Generate.`);
}

// Queue the exact same settings again (same seed), without leaving where you are.
async function runAgain(g) {
  try {
    const values = Object.fromEntries(Object.entries(g.params).filter(([k]) => !k.startsWith('__')));
    const gens = await api('/api/generate', { method: 'POST', body: { template: g.template, values, batch: 1, project_id: g.project_id,
      parent: g.parent, builder: g.params.__builder || null } });
    adoptGenerations(gens);
    notifyPrepare(); keepAwake(true);
    const other = g.project_id !== S.project ? ` in ${(S.projects.find((p) => p.id === g.project_id) || {}).name || 'its own project'}` : '';
    toast(`Queued again as #${gens[0].id}${other}`);
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
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn small primary', onclick: async (e) => {
        e.target.disabled = true;
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        try {
          const r = await uploadImage(blob, { source: 'drawing', filename: 'drawing.png' });
          close(false, true); onDone(r.name, r);
        } catch (err) { toast('Save failed: ' + err.message, true); e.target.disabled = false; }
      } }, 'Use drawing')),
    stage,
    h('div', { class: 'sketch-foot' }, h('span', { class: 'hint' }, 'Canvas'), aspSeg, sizeInfo));
  document.body.append(overlay);
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  // Cancel, back gesture or leaving the page with strokes on the canvas asks first
  const unsaved = () => st.undo.length > 0;
  const guard = (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', guard);
  const close = (viaBack = false, saved = false) => {
    if (!saved && unsaved() && !confirm('Throw away this drawing?')) return false;
    ro.disconnect(); removeEventListener('beforeunload', guard);
    overlay.remove();
    if (!viaBack) overlayClosed(back);
    return true;
  };
  const back = () => close(true);
  overlayOpened(back);

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
// editor: a simple Photoshop-style layer stack for cropping images and putting them together
// (character sheets, side-by-side refs). Each layer is an input image with a crop, a position and
// a scale. Everything is drawn client-side on a canvas, then uploaded as a new input image.
// ---------------------------------------------------------------------------
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const E = (() => {
  const saved = store.get('deck.editor', {});
  const e = { size: null, cols: 2, gap: 0, bg: '#000000', mp: 0, snap: true, ...saved, arrange: saved.arrange || null };
  // layers: { name, crop: {x,y,w,h} as fractions, x, y (canvas px), scale, hidden, img }; the last
  // one is drawn on top. size: a fixed {w,h} canvas, or null to fit around the layers.
  e.layers = (saved.layers || []).map((l) => ({ name: l.name, crop: l.crop || { ...FULL },
    x: l.x, y: l.y, scale: l.x == null ? 1 : l.scale, hidden: !!l.hidden }));
  // The old auto-layout editor kept no positions: lay its images out once they load, in the same
  // order (its first image was leftmost, so it goes to the top of the list).
  if (saved.v !== 2 && e.layers.length) { e.arrange = saved.layout || 'row'; e.layers.reverse(); }
  delete e.layout;
  return e;
})();
E.sel = null; E.cropping = false; E.aspect = null; E.guides = [];   // guides: snap lines {x} or {y} while dragging

function persistEditor() {
  store.set('deck.editor', { v: 2, size: E.size, cols: E.cols, gap: E.gap, bg: E.bg, mp: E.mp, snap: E.snap, arrange: E.arrange,
    layers: E.layers.map((l) => ({ name: l.name, crop: l.crop, x: l.x, y: l.y, scale: l.scale, hidden: l.hidden })) });
}

const layerLoaded = (l) => !!(l.img && l.img.naturalWidth);
const ready = (l) => !l.broken && layerLoaded(l) && l.x != null;

function loadLayerImage(l) {
  if (l.img) return;
  const settle = () => {
    if (E.arrange) { if (E.layers.every((o) => o.broken || layerLoaded(o))) arrangeLayers(E.arrange); }
    else if (layerLoaded(l) && l.x == null) placeLayer(l);
    renderEditor();
  };
  l.img = new Image();
  l.img.onload = settle;
  l.img.onerror = () => { l.broken = true; settle(); };
  l.img.src = `/api/input?name=${encodeURIComponent(l.name)}`;
}

// the kept part of a layer in canvas px, and the whole image behind it (shown while cropping)
function layerRect(l) {
  const c = l.crop;
  return { x: l.x, y: l.y, w: c.w * l.img.naturalWidth * l.scale, h: c.h * l.img.naturalHeight * l.scale };
}
function imageRect(l) {
  const w = l.img.naturalWidth * l.scale, hh = l.img.naturalHeight * l.scale;
  return { x: l.x - l.crop.x * w, y: l.y - l.crop.y * hh, w, h: hh };
}
function unionRect(rs) {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}
const visibleLayers = () => E.layers.filter((l) => ready(l) && !l.hidden);
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

// The output area: the fixed size, or just big enough for every visible layer
function editorFrame() {
  if (E.size) return { x: 0, y: 0, w: E.size.w, h: E.size.h };
  const vis = visibleLayers();
  if (!vis.length) return null;
  const b = unionRect(vis.map(layerRect)), x = Math.floor(b.x), y = Math.floor(b.y);
  return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
}

function drawLayer(ctx, l) {
  const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop, r = layerRect(l);
  ctx.drawImage(l.img, c.x * W, c.y * H, Math.max(1, c.w * W), Math.max(1, c.h * H), r.x, r.y, r.w, r.h);
}

function composeEditor(target) {
  const f = editorFrame(), vis = visibleLayers();
  if (!f || !vis.length) return false;
  target.width = f.w; target.height = f.h;
  const ctx2 = target.getContext('2d');
  ctx2.imageSmoothingQuality = 'high';
  ctx2.fillStyle = E.bg; ctx2.fillRect(0, 0, f.w, f.h);
  ctx2.translate(-f.x, -f.y);
  vis.forEach((l) => drawLayer(ctx2, l));
  return true;
}

// One-off layouts: matching heights side by side (or in a grid), matching widths when stacked,
// rows centred. The top of the list goes first.
function arrangeLayers(layout) {
  E.arrange = null;
  const src = [...E.layers].reverse().filter((l) => !l.broken && layerLoaded(l)).map((l) =>
    ({ l, sw: Math.max(1, l.crop.w * l.img.naturalWidth), sh: Math.max(1, l.crop.h * l.img.naturalHeight) }));
  if (!src.length) return;
  const gap = Math.max(0, E.gap | 0);
  const put = (s, x, y, scale) => Object.assign(s.l, { x: Math.round(x), y: Math.round(y), scale });
  if (layout === 'column') {
    const w = Math.round(Math.min(...src.map((s) => s.sw)));
    let y = 0;
    for (const s of src) { put(s, 0, y, w / s.sw); y += Math.round((s.sh * w) / s.sw) + gap; }
  } else {
    const cols = layout === 'row' ? src.length : Math.max(1, E.cols | 0);
    const rowH = Math.round(Math.min(...src.map((s) => s.sh)));
    const rows = [];
    for (let i = 0; i < src.length; i += cols) rows.push(src.slice(i, i + cols));
    const rowW = rows.map((r) => r.reduce((a, s) => a + Math.round((s.sw * rowH) / s.sh), 0) + gap * (r.length - 1));
    const maxW = Math.max(...rowW);
    rows.forEach((r, ri) => {
      let x = (maxW - rowW[ri]) / 2;
      for (const s of r) { put(s, x, ri * (rowH + gap), rowH / s.sh); x += Math.round((s.sw * rowH) / s.sh) + gap; }
    });
  }
  if (E.size) {   // a fixed canvas: scale the arrangement to fit it, centred
    const b = unionRect(src.map((s) => layerRect(s.l)));
    const k = Math.min(E.size.w / b.w, E.size.h / b.h);
    const dx = (E.size.w - b.w * k) / 2, dy = (E.size.h - b.h * k) / 2;
    for (const { l } of src) Object.assign(l, { x: Math.round(dx + (l.x - b.x) * k), y: Math.round(dy + (l.y - b.y) * k), scale: l.scale * k });
  }
  persistEditor();
}

// A new image goes in the middle of what's already there, shrunk to fit inside it
function placeLayer(l) {
  const w = l.crop.w * l.img.naturalWidth, hh = l.crop.h * l.img.naturalHeight;
  const others = visibleLayers().filter((o) => o !== l);
  const f = E.size ? editorFrame() : others.length ? unionRect(others.map(layerRect)) : null;
  l.scale = f ? Math.min(1, f.w / w, f.h / hh) : 1;
  l.x = f ? Math.round(f.x + (f.w - w * l.scale) / 2) : 0;
  l.y = f ? Math.round(f.y + (f.h - hh * l.scale) / 2) : 0;
  E.sel = l; E.cropping = false;
  persistEditor();
}

// What a layer lines up with: the canvas (when it fits the layers, the other layers' bounds),
// or nothing when it's the only layer
function alignFrame(l) {
  const others = visibleLayers().filter((o) => o !== l).map(layerRect);
  return E.size ? editorFrame() : others.length ? unionRect(others) : null;
}

// Snap targets: the edges and centres of the align frame and of every other visible layer
const SNAP = 8;   // screen px
function snapTargets(l) {
  const rs = visibleLayers().filter((o) => o !== l).map(layerRect), f = alignFrame(l);
  if (f) rs.push(f);
  return { xs: rs.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]), ys: rs.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]) };
}
// the smallest shift (d) that puts one of vals on a target within thr, and that target (at)
function snapNearest(vals, targets, thr) {
  let best = null;
  for (const v of vals) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}

// Set a layer's crop without moving the image under it
function setLayerCrop(l, c, ir = imageRect(l)) {
  l.crop = c;
  l.x = ir.x + c.x * ir.w; l.y = ir.y + c.y * ir.h;
}

// view: canvas px → screen px in the viewer (s = zoom, ox/oy = offset). It's refitted on every
// redraw, except while dragging, so the canvas doesn't jump around under the finger.
let EV = null, EVheld = false;
function fitView(w, hh) {
  if (EVheld && EV) return;
  const f = editorFrame(), rs = f ? [f] : [];
  if (E.size) rs.push(...visibleLayers().map(layerRect));   // show layers hanging off a fixed canvas too
  if (E.cropping && E.sel && ready(E.sel)) rs.push(imageRect(E.sel));
  if (!rs.length) { EV = null; return; }
  const b = unionRect(rs), pad = 28, top = 72;   // room above for the layer toolbar
  const s = Math.max(1e-3, Math.min((w - 2 * pad) / b.w, (hh - pad - top) / b.h));
  EV = { s, ox: (w - b.w * s) / 2 - b.x * s, oy: top + (hh - pad - top - b.h * s) / 2 - b.y * s };
}

const HANDLE = 22;   // touch radius of a corner handle, screen px
function drawBox(ctx, r, accent) {
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = accent; ctx.strokeStyle = '#000';
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

function drawEditorCanvas() {
  const cv = $('#editorCanvas'), any = E.layers.some(ready);
  $('#editorToolbar').classList.add('hidden');
  cv.classList.toggle('hidden', !any);
  $('#editorEmpty').classList.toggle('hidden', any);
  const f = editorFrame();
  $('#editorSize').textContent = any && f ? `${f.w}×${f.h} · ${(f.w * f.h / 1e6).toFixed(2)} MP` : '';
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
  if (!any || !w || !hh) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  fitView(w, hh);
  if (!EV) return;
  const { s, ox, oy } = EV, ctx = cv.getContext('2d');
  const scr = (r) => ({ x: ox + r.x * s, y: oy + r.y * s, w: r.w * s, h: r.h * s });
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, w, hh);
  ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
  if (f) { ctx.fillStyle = E.bg; ctx.fillRect(f.x, f.y, f.w, f.h); }
  visibleLayers().forEach((l) => drawLayer(ctx, l));
  ctx.restore();
  if (E.size && f) {   // shade whatever hangs off a fixed-size canvas
    const fr = scr(f);
    ctx.fillStyle = '#000a'; ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.rect(fr.x, fr.y, fr.w, fr.h); ctx.fill('evenodd');
  }
  const sel = E.sel && ready(E.sel) ? E.sel : null;
  if (!sel) return;
  if (E.cropping) {   // the whole image dimmed, the kept part on top of it
    const ir = scr(imageRect(sel));
    ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, w, hh);
    ctx.globalAlpha = 0.35; ctx.drawImage(sel.img, ir.x, ir.y, ir.w, ir.h); ctx.globalAlpha = 1;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s); drawLayer(ctx, sel); ctx.restore();
    ctx.strokeStyle = '#fff6'; ctx.lineWidth = 1; ctx.strokeRect(ir.x, ir.y, ir.w, ir.h);
  }
  drawBox(ctx, scr(layerRect(sel)), accent);
  ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1;
  for (const g of E.guides) {
    ctx.beginPath();
    if (g.x != null) { const x = Math.round(ox + g.x * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
    else { const y = Math.round(oy + g.y * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }
  placeEditorToolbar(scr(E.cropping ? imageRect(sel) : layerRect(sel)), w, hh);
}

// The Transform / Crop switch floats above the selected layer (below it, or inside, when there's no room)
function placeEditorToolbar(r, w, hh) {
  const bar = $('#editorToolbar');
  bar.classList.remove('hidden');
  for (const b of bar.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'crop') === E.cropping);
  bar.querySelector('[data-snap]').classList.toggle('on', E.snap);
  const bw = bar.offsetWidth, bh = bar.offsetHeight, m = 6, clear = 18;   // clear the corner handles
  let top = r.y - bh - clear;
  if (top < m) top = r.y + r.h + clear;
  bar.style.left = `${Math.min(w - bw - m, Math.max(m, r.x + r.w / 2 - bw / 2))}px`;
  bar.style.top = `${Math.min(hh - bh - m, Math.max(m, top))}px`;
}

function setEditorMode(crop) {
  if (!E.sel || E.cropping === crop) return;
  E.cropping = crop;
  if (crop) E.aspect = null;
  renderEditor();
}

// Drag on the canvas: a layer to move it, a corner of the selected one to resize it, and while
// cropping the crop box (or a new one inside the image). Double-tap a layer to crop it.
function wireEditor() {
  const cv = $('#editorCanvas');
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const point = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - EV.ox) / EV.s, y: (e.clientY - r.top - EV.oy) / EV.s };
  };
  const corner = (p, r) => {
    for (const k of ['nw', 'ne', 'sw', 'se']) {
      const x = k.includes('w') ? r.x : r.x + r.w, y = k.includes('n') ? r.y : r.y + r.h;
      if (Math.hypot(x - p.x, y - p.y) * EV.s < HANDLE) return k;
    }
    return null;
  };
  let drag = null, lastTap = { t: 0, l: null };
  cv.addEventListener('pointerdown', (e) => {
    if (!EV) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const p = point(e), sel = E.sel && ready(E.sel) ? E.sel : null;
    drag = null; EVheld = true;
    if (sel && E.cropping) {
      const ir = imageRect(sel), c = sel.crop, k = corner(p, layerRect(sel));
      const q = { x: clamp01((p.x - ir.x) / ir.w), y: clamp01((p.y - ir.y) / ir.h) };
      if (k) drag = { crop: true, ir, fx: k.includes('w') ? c.x + c.w : c.x, fy: k.includes('n') ? c.y + c.h : c.y };
      else if (inside(p, layerRect(sel))) drag = { crop: true, ir, move: true, q0: q, c0: { ...c } };
      else if (inside(p, ir)) drag = { crop: true, ir, fx: q.x, fy: q.y };
      else { EVheld = false; E.cropping = false; renderEditor(); }   // tapping outside the image finishes the crop
      return;
    }
    const k = sel && corner(p, layerRect(sel));
    if (k) {
      const r = layerRect(sel);
      drag = { resize: true, l: sel, ax: k.includes('w') ? r.x + r.w : r.x, ay: k.includes('n') ? r.y + r.h : r.y,
        cw: r.w / sel.scale, ch: r.h / sel.scale };
      return;
    }
    const hit = visibleLayers().reverse().find((l) => inside(p, layerRect(l)));
    if (!hit) { EVheld = false; if (E.sel) { E.sel = null; renderEditor(); } return; }
    const now = performance.now();
    if (hit === lastTap.l && now - lastTap.t < 350) {
      lastTap = { t: 0, l: null }; EVheld = false;
      E.sel = hit; E.cropping = true; E.aspect = null; renderEditor();
      return;
    }
    lastTap = { t: now, l: hit };
    drag = { l: hit, p0: p, x0: hit.x, y0: hit.y };
    if (E.sel !== hit) { E.sel = hit; renderEditor(); }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = point(e);
    if (drag.crop) {
      const l = E.sel, ir = drag.ir, W = l.img.naturalWidth, H = l.img.naturalHeight;
      const q = { x: clamp01((p.x - ir.x) / ir.w), y: clamp01((p.y - ir.y) / ir.h) };
      const c = drag.move
        ? { ...drag.c0, x: Math.min(1 - drag.c0.w, Math.max(0, drag.c0.x + q.x - drag.q0.x)),
          y: Math.min(1 - drag.c0.h, Math.max(0, drag.c0.y + q.y - drag.q0.y)) }
        : cropSpan(W, H, E.aspect, drag.fx, drag.fy, q.x, q.y);
      setLayerCrop(l, c, ir);
    } else if (drag.resize) {
      const l = drag.l, left = p.x < drag.ax, up = p.y < drag.ay;
      l.scale = Math.max(0.01, Math.abs(p.x - drag.ax) / drag.cw, Math.abs(p.y - drag.ay) / drag.ch);
      E.guides = [];
      if (E.snap && !e.altKey) {   // the dragged corner snaps on whichever axis is closer
        const t = snapTargets(l), thr = SNAP / EV.s;
        const ex = drag.ax + (left ? -1 : 1) * drag.cw * l.scale, ey = drag.ay + (up ? -1 : 1) * drag.ch * l.scale;
        const sx = snapNearest([ex], t.xs, thr), sy = snapNearest([ey], t.ys, thr);
        const g = sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d)) ? { x: sx.at } : sy ? { y: sy.at } : null;
        if (g) {
          l.scale = Math.max(0.01, g.x != null ? Math.abs(g.x - drag.ax) / drag.cw : Math.abs(g.y - drag.ay) / drag.ch);
          E.guides.push(g);
        }
      }
      l.x = Math.round(left ? drag.ax - drag.cw * l.scale : drag.ax);
      l.y = Math.round(up ? drag.ay - drag.ch * l.scale : drag.ay);
    } else {
      const l = drag.l;
      l.x = Math.round(drag.x0 + p.x - drag.p0.x);
      l.y = Math.round(drag.y0 + p.y - drag.p0.y);
      E.guides = [];
      if (E.snap && !e.altKey) {   // edges and centre snap to the canvas and the other layers
        const t = snapTargets(l), thr = SNAP / EV.s, r = layerRect(l);
        const sx = snapNearest([r.x, r.x + r.w / 2, r.x + r.w], t.xs, thr);
        const sy = snapNearest([r.y, r.y + r.h / 2, r.y + r.h], t.ys, thr);
        if (sx) { l.x = Math.round(l.x + sx.d); E.guides.push({ x: sx.at }); }
        if (sy) { l.y = Math.round(l.y + sy.d); E.guides.push({ y: sy.at }); }
      }
    }
    drag.moved = true;
    drawEditorCanvas();
  });
  const end = () => {
    const moved = drag && drag.moved;
    drag = null; EVheld = false; E.guides = [];
    if (moved) { lastTap = { t: 0, l: null }; persistEditor(); }
    renderEditor();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.parentElement.append(h('div', { id: 'editorToolbar', class: 'layer-toolbar hidden', role: 'toolbar', 'aria-label': 'Layer tool' },
    h('button', { type: 'button', 'data-mode': 'transform', title: 'Move and resize (V)', onclick: () => setEditorMode(false) }, '✥ Transform'),
    h('button', { type: 'button', 'data-mode': 'crop', title: 'Crop (C)', onclick: () => setEditorMode(true) }, '⛶ Crop'),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-snap': '', title: 'Snap to the canvas and other layers (hold Alt to skip)',
      onclick: () => { E.snap = !E.snap; persistEditor(); drawEditorCanvas(); } }, '⌖ Snap')));
  new ResizeObserver(() => { if (!EVheld) drawEditorCanvas(); }).observe(cv.parentElement);

  // V / C switch tool, Esc finishes a crop / deselects, Delete removes the selected layer, arrows nudge it
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-editor').classList.contains('active') || !$('#sheet').classList.contains('hidden')
      || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || !E.sel) return;
    const l = E.sel, n = e.shiftKey ? 10 : 1;
    const nudge = (dx, dy) => { if (E.cropping || !ready(l)) return; l.x += dx; l.y += dy; persistEditor(); };
    const keys = {
      Escape: () => { if (E.cropping) E.cropping = false; else E.sel = null; },
      v: () => { E.cropping = false; }, c: () => { E.cropping = true; E.aspect = null; },
      Enter: () => { E.cropping = false; },
      Delete: () => removeLayer(l), Backspace: () => removeLayer(l),
      ArrowLeft: () => nudge(-n, 0), ArrowRight: () => nudge(n, 0), ArrowUp: () => nudge(0, -n), ArrowDown: () => nudge(0, n),
    };
    if (!keys[e.key]) return;
    e.preventDefault(); keys[e.key](); renderEditor();
  });
}

function removeLayer(l) {
  const before = E.layers;
  E.layers = E.layers.filter((o) => o !== l);
  if (E.sel === l) { E.sel = null; E.cropping = false; }
  persistEditor();
  undoToast('Layer removed', () => { E.layers = before; E.sel = l; persistEditor(); renderEditor(); });
}

function renderEditor() {
  E.layers.forEach(loadLayerImage);
  if (E.sel && !E.layers.includes(E.sel)) E.sel = null;
  if (!E.sel || !ready(E.sel)) E.cropping = false;
  $('#editorPanel').replaceChildren(
    h('div', { class: 'group-body flat' },
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: addEditorImages }, '+ Add images'),
        E.layers.length ? h('button', { type: 'button', class: 'btn ghost', style: 'flex:none',
          onclick: () => {
            const before = E.layers;
            E.layers = []; E.sel = null; E.arrange = null; persistEditor(); renderEditor();
            undoToast(`Cleared ${before.length} layer${before.length > 1 ? 's' : ''}`, () => { E.layers = before; persistEditor(); renderEditor(); });
          } }, 'Clear all') : null),
      layerList(),
      E.sel ? layerProps(E.sel) : canvasProps()));
  drawEditorCanvas();
}

// Layer-panel pieces shared by the Editor and the 3D tab: icon buttons, number fields, the props
// title and the layer list.
const iconBtn = (label, text, fn, extra = {}) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label,
  ...extra, onclick: (e) => { e.stopPropagation(); fn(); } }, text);

// after() runs once the value is set (save and redraw)
// live: called while the box is dragged (after set), for a preview that doesn't rebuild the panel
function propNum(label, value, set, after, { min = -1e6, max = 1e6, step = 1, live = null } = {}) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min, max, step, value });
  const read = () => Math.min(max, Math.max(min, parseFloat(input.value) || 0));
  input.addEventListener('change', () => { set(read()); after(); });
  if (live) input.addEventListener('input', () => { if (input.dataset.scrubbing) { set(read()); live(); } });
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input);
}

const propsTitle = (title, onDone) => h('div', { class: 'props-title' }, h('span', {}, title),
  onDone ? h('button', { type: 'button', class: 'btn small ghost', onclick: onDone }, 'Done') : null);

// rows: [{ thumb (element), name, hint, sel, off, onclick, buttons: [elements] }]
const layerRowsEl = (rows) => h('div', { class: 'layers' }, rows.map((r) =>
  h('div', { class: 'layer-row' + (r.sel ? ' sel' : '') + (r.off ? ' off' : ''), onclick: r.onclick },
    h('span', { class: 'thumb' }, r.thumb),
    h('div', { class: 'layer-name' }, h('span', {}, r.name), h('span', { class: 'hint' }, r.hint || '')),
    h('div', { class: 'layer-btns' }, r.buttons || []))));

const editorIcon = iconBtn;
const editorNum = (label, value, set, opts) => propNum(label, value, set, () => { persistEditor(); renderEditor(); }, opts);

// Top of the list is drawn on top; tap a row to select that layer
function layerList() {
  if (!E.layers.length) return h('div', { class: 'hint' }, 'Add images from your inputs, generations or device, then tap one on the canvas to move, resize or crop it.');
  const move = (l, d) => {
    const i = E.layers.indexOf(l), j = i + d;
    if (j < 0 || j >= E.layers.length) return;
    [E.layers[i], E.layers[j]] = [E.layers[j], E.layers[i]];
    persistEditor(); renderEditor();
  };
  return layerRowsEl([...E.layers].reverse().map((l) => {
    const r = ready(l) ? layerRect(l) : null, cropped = l.crop.w < 0.999 || l.crop.h < 0.999;
    return {
      sel: l === E.sel, off: l.hidden || l.broken,
      onclick: () => { E.sel = l === E.sel ? null : l; E.cropping = false; renderEditor(); },
      thumb: h('img', { src: thumbUrl(l.name, 160), alt: '' }),
      name: l.name.split('/').pop(),
      hint: l.broken ? 'could not load' : !r ? 'loading…'
        : `${Math.round(r.w)}×${Math.round(r.h)}${cropped ? ' · cropped' : ''}${l.hidden ? ' · hidden' : ''}`,
      buttons: [
        editorIcon(l.hidden ? 'Show' : 'Hide', l.hidden ? '◌' : '◉', () => { l.hidden = !l.hidden; persistEditor(); renderEditor(); }),
        editorIcon('Bring forward', '↑', () => move(l, 1)),
        editorIcon('Send backward', '↓', () => move(l, -1))],
    };
  }));
}

function layerProps(l) {
  const title = propsTitle(E.cropping ? 'Crop' : 'Layer', () => { if (E.cropping) E.cropping = false; else E.sel = null; renderEditor(); });
  if (!ready(l)) {
    return h('div', { class: 'props' }, title,
      h('button', { type: 'button', class: 'btn small danger', onclick: () => { removeLayer(l); renderEditor(); } }, 'Delete layer'));
  }
  const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
  if (E.cropping) {
    const aspSeg = h('div', { class: 'seg wrap' }, ASPECTS.map(([label, a]) =>
      h('button', { type: 'button', class: E.aspect === a ? 'on' : '', onclick: () => {
        E.aspect = a;
        if (a) setLayerCrop(l, aspectCrop(W, H, a));
        persistEditor(); renderEditor();
      } }, label)));
    return h('div', { class: 'props' }, title,
      h('div', { class: 'hint' }, 'Drag the box or its corners on the canvas. Switch back to Transform, or tap outside the image, when you\'re done.'),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Aspect'), aspSeg),
      h('div', { class: 'hint' }, `Keeping ${Math.round(c.w * W)}×${Math.round(c.h * H)} of ${W}×${H} px`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small primary', onclick: () => { E.cropping = false; renderEditor(); } }, 'Finish crop'),
        h('button', { type: 'button', class: 'btn small', onclick: () => {
          E.aspect = null; setLayerCrop(l, { ...FULL }); persistEditor(); renderEditor();
        } }, 'Reset crop')));
  }
  const r = layerRect(l), cropped = c.w < 0.999 || c.h < 0.999;
  // scale around the layer's centre
  const setScale = (s) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    l.scale = s;
    const n = layerRect(l);
    l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
  };
  return h('div', { class: 'props' }, title,
    h('div', { class: 'hint layer-title' }, l.name.split('/').pop()),
    h('div', { class: 'row' },
      editorNum('X', Math.round(l.x), (v) => { l.x = v; }, { min: -E.size.w, max: E.size.w * 2, live: drawEditorCanvas }),
      editorNum('Y', Math.round(l.y), (v) => { l.y = v; }, { min: -E.size.h, max: E.size.h * 2, live: drawEditorCanvas }),
      editorNum('Scale %', Math.round(l.scale * 1000) / 10, (v) => setScale(v / 100), { min: 1, max: 1000, step: 'any', live: drawEditorCanvas })),
    h('div', { class: 'hint' }, `${Math.round(r.w)}×${Math.round(r.h)} px on the canvas · ${Math.round(c.w * W)}×${Math.round(c.h * H)} px of the image`),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn small', onclick: () => { E.cropping = true; E.aspect = null; renderEditor(); } }, 'Crop'),
      cropped ? h('button', { type: 'button', class: 'btn small', onclick: () => { setLayerCrop(l, { ...FULL }); persistEditor(); renderEditor(); } }, 'Reset crop') : null,
      h('button', { type: 'button', class: 'btn small', onclick: () => { setScale(1); persistEditor(); renderEditor(); } }, '100%')),
    alignControls(l),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => { removeLayer(l); renderEditor(); } }, 'Delete layer'),
    h('div', { class: 'hint' }, 'Drag it on the canvas to move it, or a corner to resize; it snaps to the canvas and other layers (hold Alt, or turn off Snap, to place it freely). Switch to Crop in the toolbar above it (or double-tap).'));
}

// Align buttons: 0 / 0.5 / 1 = start / centre / end of the align frame, per axis
function alignControls(l) {
  const f = alignFrame(l);
  const align = (axis, k) => {
    const r = layerRect(l);
    if (axis === 'x') l.x = Math.round(f.x + (f.w - r.w) * k); else l.y = Math.round(f.y + (f.h - r.h) * k);
    persistEditor(); renderEditor();
  };
  const seg = (axis, items) => h('div', { class: 'seg' }, items.map(([k, label, title]) =>
    h('button', { type: 'button', title, disabled: !f, onclick: () => align(axis, k) }, label)));
  return h('div', { class: 'field' },
    h('span', { class: 'lbl' }, E.size ? 'Align to canvas' : 'Align to the other layers'),
    seg('x', [[0, '⇤ Left', 'Align left edges'], [0.5, '↔ Centre', 'Centre horizontally'], [1, 'Right ⇥', 'Align right edges']]),
    seg('y', [[0, '⤒ Top', 'Align top edges'], [0.5, '↕ Middle', 'Centre vertically'], [1, 'Bottom ⤓', 'Align bottom edges']]));
}

function canvasProps() {
  const f = editorFrame();
  const sizeSeg = h('div', { class: 'seg' },
    h('button', { type: 'button', class: E.size ? '' : 'on', onclick: () => { E.size = null; persistEditor(); renderEditor(); } }, 'Fit layers'),
    h('button', { type: 'button', class: E.size ? 'on' : '', onclick: () => {
      if (E.size) return;
      // start from what the layers cover now, moved so it begins at 0,0
      if (f) for (const l of E.layers) if (l.x != null) { l.x -= f.x; l.y -= f.y; }
      E.size = f ? { w: f.w, h: f.h } : { w: 1024, h: 1024 };
      persistEditor(); renderEditor();
    } }, 'Fixed size'));
  const arrSeg = h('div', { class: 'seg' }, [['row', 'Side by side'], ['column', 'Stacked'], ['grid', 'Grid']].map(([m, label]) =>
    h('button', { type: 'button', disabled: !E.layers.length, onclick: () => { arrangeLayers(m); renderEditor(); } }, label)));
  const bg = h('input', { type: 'color', value: E.bg });
  bg.addEventListener('input', () => { E.bg = bg.value; persistEditor(); drawEditorCanvas(); });
  return h('div', { class: 'props' },
    propsTitle('Canvas'),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Size'), sizeSeg),
    E.size ? h('div', { class: 'row' },
      editorNum('Width', E.size.w, (v) => { E.size.w = v; }, { min: 64, max: 8192, step: 8 }),
      editorNum('Height', E.size.h, (v) => { E.size.h = v; }, { min: 64, max: 8192, step: 8 })) : null,
    h('label', { class: 'field', style: 'display:grid;justify-items:start' }, h('span', { class: 'lbl' }, 'Background'), bg),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Arrange layers'), arrSeg),
    h('div', { class: 'row', style: 'align-items:end' },
      editorNum('Grid columns', E.cols, (v) => { E.cols = v; }, { min: 1, max: 12 }),
      editorNum('Gap (px)', E.gap, (v) => { E.gap = v; }, { min: 0, max: 400 })),
    h('div', { class: 'field' }, mpInput(() => E.mp, (n) => { E.mp = n; persistEditor(); })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onclick: saveEditor }, 'Save as input'),
      h('button', { type: 'button', class: 'btn', onclick: downloadEditor }, 'Download')));
}

function addEditorImages() {
  openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => {
    E.layers.push({ name, crop: { ...FULL }, scale: 1, hidden: false }); persistEditor(); renderEditor();
  } });
}

function editorBlob() {
  const cv = document.createElement('canvas');
  if (!composeEditor(cv)) return Promise.resolve(null);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

async function saveEditor() {
  const b = busy('Putting the image together…');   // big layers take a moment to draw and encode
  try {
    const blob = await editorBlob();
    if (!blob) return toast('Add some images first', true);
    const r = await uploadImage(blob, { mp: E.mp, source: 'editor', filename: 'editor.png' });
    useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
  } catch (e) { toast('Save failed: ' + e.message, true); }
  finally { b.done(); }
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

// Crop rectangle (fractions of a W×H image) from a fixed corner (fx,fy) to the pointer, respecting
// the aspect lock (width/height in pixels, null = free) and the image bounds
function cropSpan(W, H, aspect, fx, fy, px, py) {
  let w = Math.abs(px - fx), hh = Math.abs(py - fy);
  if (aspect) {
    const maxW = px < fx ? fx : 1 - fx, maxH = py < fy ? fy : 1 - fy;
    hh = (w * W) / (aspect * H);
    if (hh > maxH) { hh = maxH; w = (hh * aspect * H) / W; }
    if (w > maxW) { w = maxW; hh = (w * W) / (aspect * H); }
  }
  w = Math.max(w, 0.02); hh = Math.max(hh, 0.02);
  return { x: px < fx ? fx - w : fx, y: py < fy ? fy - hh : fy, w, h: hh };
}

// the largest centred crop with that aspect
function aspectCrop(W, H, a) {
  let w = 1, hh = W / (a * H);
  if (hh > 1) { hh = 1; w = (a * H) / W; }
  return { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
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
  const span = (fx, fy, px, py) => cropSpan(W, H, aspect, fx, fy, px, py);
  const setAspect = (a) => {
    aspect = a;
    if (a) c = aspectCrop(W, H, a);
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

wireEditor();

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
// Past BLOB_CAP in memory the rest stream instead: tablets (iPad Safari above all) kill pages that
// hold too much.
const blobs = new Map();   // url -> { state: 'loading' | 'ready' | 'failed' | 'stream', src, size }
let preloadQueue = [], preloading = 0;
const BLOB_CAP = 400e6;
const srcFor = (it) => (blobs.get(it.url)?.state === 'ready' ? blobs.get(it.url).src : it.url);
const blobBytes = () => [...blobs.values()].reduce((a, b) => a + (b.size || 0), 0);

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
    if (blobBytes() > BLOB_CAP) { blobs.set(url, { state: 'stream' }); continue; }
    preloading++;
    fetch(url).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
      .then((b) => { if (blobs.has(url)) blobs.set(url, { state: 'ready', src: URL.createObjectURL(b), size: b.size }); })
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
  const before = V.items;
  V.items = V.items.filter((i) => i !== it);
  V.sel = null;
  timelineChanged();
  undoToast('Clip deleted', () => { V.items = before; V.sel = it.id; timelineChanged(); });
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
function numField(label, get, set, { step = 0.04, min = 0, max = 600 } = {}) {
  const inp = h('input', { type: 'number', inputMode: 'decimal', step, min, max, value: Number(get()).toFixed(2) });
  inp.addEventListener('change', () => { set(parseFloat(inp.value) || 0); timelineChanged(); });
  // dragged like a slider: show it on the timeline as it goes
  inp.addEventListener('input', () => { if (inp.dataset.scrubbing) { set(parseFloat(inp.value) || 0); renderTimeline(); syncMedia(); requestDraw(); } });
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
    if (it.kind === 'image') fields.push(numField('Duration (s)', () => len, (v) => { it.out = Math.max(MIN_LEN, v); }, { min: MIN_LEN, max: 60 }));
    else fields.push(
      numField('In (s)', () => it.in, (v) => { it.in = Math.max(0, Math.min(v, (it.out ?? it.dur) - MIN_LEN)); }, { max: it.dur || undefined }),
      numField('Out (s)', () => it.out ?? it.dur, (v) => { it.out = Math.max(it.in + MIN_LEN, it.dur ? Math.min(v, it.dur) : v); }, { max: it.dur || undefined }));
    fields.push(
      numField('Fade in (s)', () => it.fadeIn || 0, (v) => { it.fadeIn = Math.max(0, Math.min(v, len)); }, { step: 0.1, max: Math.max(0.1, len) }),
      numField('Fade out (s)', () => it.fadeOut || 0, (v) => { it.fadeOut = Math.max(0, Math.min(v, len)); }, { step: 0.1, max: Math.max(0.1, len) }));
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
  if (snapshotFrame.url) URL.revokeObjectURL(snapshotFrame.url);   // the previous frame's
  const url = snapshotFrame.url = URL.createObjectURL(blob), name = `frame_${tc(V.t).replace(/:/g, '-')}.png`;
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
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn small primary', onclick: () => {
        setVal(f.key, clean());
        close(false, true); renderFields();
      } }, 'Done')),
    h('div', { class: 'box-body' }, stage, list));
  document.body.append(overlay);
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  const tidy = (bs) => bs.map(({ x, y, w, h: hh, type, desc, text, ref }) =>
    ({ x, y, w, h: hh, type: type || 'obj', desc: desc || '', text: text || '', ...(ref && type !== 'text' ? { ref } : {}) }));
  const clean = () => tidy(boxes);
  const start = JSON.stringify(tidy(S.values[f.key] || []));
  const close = (viaBack = false, saved = false) => {
    // Cancel or the back gesture with changes: ask, rather than lose them
    if (!saved && JSON.stringify(clean()) !== start && !confirm('Throw away your changes to the boxes?')) return false;
    ro.disconnect(); overlay.remove();
    if (!viaBack) overlayClosed(back);
    return true;
  };
  const back = () => close(true);
  overlayOpened(back);
  draw();
}

// ---------------------------------------------------------------------------
// LoRA info from Civitai (looked up by the file's hash through rgthree-comfy)
// ---------------------------------------------------------------------------
async function openLoraInfo(name) {
  const seq = openSheet(h('h3', {}, name.split('/').pop()),
    h('div', { class: 'placeholder' }, 'Looking it up on Civitai… The first lookup hashes the file, which can take a little while.'));
  let r;
  try { r = await api(`/api/lora-info?name=${encodeURIComponent(name)}`, { timeout: 240000 }); } catch (e) {
    if (sheetStillOpen(seq)) openSheet(h('h3', {}, name.split('/').pop()), h('div', { class: 'note err' }, e.message));
    return;
  }
  if (!sheetStillOpen(seq)) return;  // closed, or something else opened, while it was looking
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
const B = { filter: store.get('deck.board.filter', 'all'), size: store.get('deck.board.size', 240), loadedFor: undefined,
  selecting: false, sel: new Set(), longPressed: false,   // sel: "<generation id>:<output index>"
  marked: new Set(store.get('deck.board.marked', [])) };  // generation ids marked for deletion
const boardVideos = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && !GAL.el) e.target.play().catch(() => {}); else e.target.pause();
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
  if (B.filter === 'marked' && !B.marked.size) B.filter = 'all';
  const filters = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['pinned', '★ Pinned'], ...(B.marked.size ? [['marked', '🗑 Marked']] : [])];
  const seg = h('div', { class: 'seg' }, filters.map(([k, l]) =>
    h('button', { type: 'button', class: B.filter === k ? 'on' : '', onclick: () => { B.filter = k; store.set('deck.board.filter', k); renderBoard(); } }, l)));
  const size = h('input', { type: 'range', min: 120, max: 520, step: 10, value: B.size, 'aria-label': 'Tile size' });
  size.addEventListener('input', () => { B.size = Number(size.value); store.set('deck.board.size', B.size); $('#board').style.setProperty('--tile', `${B.size}px`); });
  const count = h('span', { class: 'hint' });
  const selBtn = h('button', { type: 'button', class: 'btn small toggle-btn' + (B.selecting ? ' on' : ''),
    onclick: () => setBoardSelecting(!B.selecting) }, B.selecting ? 'Done' : '☑ Select');
  const delMarked = h('span', { class: 'hidden' });   // filled in once the project's generations are loaded
  bar.replaceChildren(seg, h('label', { class: 'board-size' }, 'Size', size), selBtn, delMarked, count, boardSelBar());
  $('#board').style.setProperty('--tile', `${B.size}px`);

  if (B.loadedFor !== S.project) {
    $('#board').replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try { await loadAllProjectGenerations(); } catch (e) { toast(e.message, true); }
  }
  const tiles = boardItems().map(({ g, o, i }) => boardTile(g, o, i));
  pauseBoard();
  $('#board').replaceChildren(...(tiles.length ? tiles : [h('div', { class: 'placeholder' },
    B.filter === 'pinned' ? 'Nothing pinned yet. Tap ☆ on any tile.'
      : B.filter === 'marked' ? 'Nothing marked. Mark things for deletion in the gallery (tap a tile).'
        : 'Nothing generated in this project yet.')]));
  $('#board').querySelectorAll('video').forEach((v) => boardVideos.observe(v));
  count.textContent = `${tiles.length} item${tiles.length === 1 ? '' : 's'}`;
  const nMarked = markedGens().length;
  if (nMarked) delMarked.replaceWith(h('button', { type: 'button', class: 'btn small danger', onclick: deleteMarked }, `Delete ${nMarked} marked`));
}

// what the board shows with the current filter, newest first: [{g, o, i, key}]
function boardItems() {
  const items = [];
  const gens = [...S.history.values()].filter((g) => g.project_id === S.project && g.status === 'done').sort((a, b) => b.id - a.id);
  for (const g of gens) {
    if (B.filter === 'pinned' && !g.pinned) continue;
    if (B.filter === 'marked' && !B.marked.has(g.id)) continue;
    g.outputs.forEach((o, i) => {
      if (o.kind !== 'image' && o.kind !== 'video') return;
      if ((B.filter === 'image' || B.filter === 'video') && o.kind !== B.filter) return;
      items.push({ g, o, i, key: `${g.id}:${i}` });
    });
  }
  return items;
}

async function togglePin(g) {
  try { const r = await api(`/api/generations/${g.id}/pin`, { method: 'POST', body: { pinned: !g.pinned } }); S.history.set(r.id, r); boardChanged(r); }
  catch (err) { toast(err.message, true); }
}

// Marks are per generation (deleting takes the whole generation) and live in this browser only
function toggleMarked(id) {
  if (B.marked.has(id)) B.marked.delete(id); else B.marked.add(id);
  saveMarked();
}
function saveMarked() { store.set('deck.board.marked', [...B.marked]); }
function markedGens() { return [...B.marked].map((id) => S.history.get(id)).filter((g) => g && g.project_id === S.project); }

function boardTile(g, o, i) {
  const media = o.kind === 'video'
    ? h('video', { src: o.url, muted: true, loop: true, playsInline: true, preload: 'metadata' })
    : h('img', { src: o.url, loading: 'lazy', alt: '', draggable: false });
  const pin = h('button', { type: 'button', class: 'pin' + (g.pinned ? ' on' : ''), 'aria-label': g.pinned ? 'Unpin' : 'Pin',
    onclick: (e) => { e.stopPropagation(); togglePin(S.history.get(g.id) || g); } }, g.pinned ? '★' : '☆');
  const key = `${g.id}:${i}`;
  const tile = h('div', { class: 'tile' + (B.sel.has(key) ? ' sel' : '') + (B.marked.has(g.id) ? ' marked' : ''), 'data-gen': g.id, 'data-key': key,
    onclick: () => {
      if (B.longPressed) { B.longPressed = false; return; }   // the long press already selected it
      if (B.selecting) toggleBoardSel(key, tile); else openGallery(key);
    } }, media, pin, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
    h('span', { class: 'mark', 'aria-hidden': 'true' }, '🗑'),
    h('div', { class: 'tile-meta' }, `#${g.id} ${g.template}${o.kind === 'video' ? ' ▶' : ''}`));
  // long press: start selecting with this tile
  let timer = 0, start = null;
  tile.addEventListener('pointerdown', (e) => {
    B.longPressed = false;
    if (e.target.closest('.pin')) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      B.longPressed = true;
      if (!B.selecting) setBoardSelecting(true);
      if (!B.sel.has(key)) toggleBoardSel(key, $(`#board .tile[data-key="${key}"]`));
      try { navigator.vibrate?.(20); } catch { /* not supported */ }
    }, 500);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tile.addEventListener(ev, () => clearTimeout(timer));
  tile.addEventListener('pointermove', (e) => {   // a finger that moves is scrolling, not pressing
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearTimeout(timer);
  });
  tile.addEventListener('contextmenu', (e) => e.preventDefault());   // no image menu on long press
  tile.addEventListener('dragstart', (e) => e.preventDefault());     // nor the browser's own image drag, which cancels the press
  return tile;
}

// ---- board selection: pick tiles, then make a new edit from them, put them on the timeline, or delete
function setBoardSelecting(on) {
  B.selecting = on;
  if (!on) B.sel.clear();
  $('#board').classList.toggle('selecting', on);
  renderBoard();
}
function toggleBoardSel(key, tile) {
  if (B.sel.has(key)) B.sel.delete(key); else B.sel.add(key);
  tile?.classList.toggle('sel', B.sel.has(key));
  const bar = $('#boardBar .board-sel');
  if (bar) bar.replaceWith(boardSelBar());
}
function boardSelected() {   // [{g, o, i}] in board order
  return [...B.sel].map((k) => { const [id, i] = k.split(':').map(Number); const g = S.history.get(id); return g && g.outputs[i] ? { g, o: g.outputs[i], i } : null; })
    .filter(Boolean).sort((a, b) => b.g.id - a.g.id || a.i - b.i);
}
function boardSelBar() {
  if (!B.selecting) return h('span', { class: 'board-sel hidden' });
  const n = B.sel.size, items = boardSelected(), images = items.filter((x) => x.o.kind === 'image').length;
  const visibleKeys = () => [...$('#board').querySelectorAll('.tile[data-key]')].map((t) => t.dataset.key);
  return h('div', { class: 'board-sel' },
    h('b', {}, n ? `${n} selected` : 'Tap tiles to select'),
    h('button', { type: 'button', class: 'btn small', onclick: () => { visibleKeys().forEach((k) => B.sel.add(k)); renderBoard(); } }, 'All'),
    n ? h('button', { type: 'button', class: 'btn small', onclick: () => { B.sel.clear(); renderBoard(); } }, 'None') : null,
    h('button', { type: 'button', class: 'btn small primary', disabled: !images, onclick: boardToEditor }, `New edit${images ? ` (${images})` : ''}`),
    h('button', { type: 'button', class: 'btn small', disabled: !n, onclick: boardToVideo }, 'To video'),
    h('button', { type: 'button', class: 'btn small danger', disabled: !n, onclick: boardDelete }, 'Delete'));
}

// The selected images as a fresh Editor layout (side by side, or a grid for more than 3).
// Whatever was in the Editor can be brought back with Undo.
async function boardToEditor() { return itemsToEditor(boardSelected()); }
async function itemsToEditor(all) {
  const items = all.filter((x) => x.o.kind === 'image');
  if (!items.length) return toast('Select some images first', true);
  toast(`Preparing ${items.length} image${items.length > 1 ? 's' : ''}…`);
  const names = [];
  for (const { g, i } of items) {
    try {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index: i, frame: 'first', mp: 0, multiple: 1 } });
      names.push(r.name);
    } catch (e) { toast(`#${g.id}: ${e.message}`, true); }
  }
  if (!names.length) return;
  const before = { layers: E.layers, arrange: E.arrange, size: E.size };
  E.layers = names.reverse().map((name) => ({ name, crop: { ...FULL }, scale: 1, hidden: false }));  // first selected on top of the list
  E.sel = null; E.cropping = false; E.size = null;
  E.arrange = names.length > 3 ? 'grid' : 'row';
  E.cols = names.length > 3 ? Math.ceil(Math.sqrt(names.length)) : E.cols;
  persistEditor();
  setBoardSelecting(false);
  switchTab('editor');
  if (before.layers.length) undoToast(`New edit with ${names.length} image${names.length > 1 ? 's' : ''}`, () => {
    Object.assign(E, before); persistEditor(); renderEditor();
  });
}

// The selection onto the Video timeline, oldest first, after what's already there
async function boardToVideo() {
  const items = boardSelected().reverse();
  if (!items.length) return;
  for (const { g, o, i } of items) {
    await addToTimeline({ kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: `#${g.id} ${g.template}`, dur: o.duration || 0 });
  }
  setBoardSelecting(false);
  switchTab('video');
  toast(`Added ${items.length} to the timeline`);
}

// Deletes whole generations (with all their files), so say when that takes outputs that weren't picked
async function boardDelete() {
  const items = boardSelected();
  const gens = [...new Map(items.map((x) => [x.g.id, x.g])).values()];
  const extra = gens.reduce((a, g) => a + g.outputs.filter((o, i) => !B.sel.has(`${g.id}:${i}`)).length, 0);
  if (!await deleteGenerations(gens, extra ? `\n\nThat also deletes ${extra} other output${extra > 1 ? 's' : ''} of those generations.` : '')) return;
  setBoardSelecting(false);
}

async function deleteMarked() {
  if (await deleteGenerations(markedGens())) renderBoard();
}

// Asks first; returns false if nothing was deleted
async function deleteGenerations(gens, note = '') {
  if (!gens.length) return false;
  const pinned = gens.filter((g) => g.pinned).length;
  if (!confirm(`Delete ${gens.length} generation${gens.length > 1 ? 's' : ''} and their files? This can't be undone.` + note
    + (pinned ? `\n\n${pinned} of them ${pinned > 1 ? 'are' : 'is'} pinned.` : ''))) return false;
  let done = 0;
  for (const g of gens) {
    try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); S.history.delete(g.id); B.marked.delete(g.id); done++; }
    catch (e) { toast(`#${g.id}: ${e.message}`, true); }
  }
  saveMarked();
  if (GAL.el) galleryRefresh();
  toast(`Deleted ${done} generation${done === 1 ? '' : 's'}`);
  return done > 0;
}

function boardChanged(g) {
  if (GAL.el) return galleryRefresh();   // the board catches up when the gallery closes
  const tiles = $('#board').querySelectorAll(`.tile[data-gen="${g.id}"]`);
  if (!tiles.length || (B.filter === 'pinned' && !g.pinned) || (B.filter === 'marked' && !B.marked.has(g.id))) return renderBoard();
  tiles.forEach((t) => {
    const p = t.querySelector('.pin'); p.classList.toggle('on', !!g.pinned); p.textContent = g.pinned ? '★' : '☆';
    t.classList.toggle('marked', B.marked.has(g.id));
  });
}

// ---- board gallery: full screen, one big preview with a sliding row of thumbnails under it.
// Swipe (or ← →) to move through what the board is showing; pin, mark for deletion, edit.
const GAL = { el: null, items: [], idx: 0, key: null };
const galThumbs = new IntersectionObserver((entries) => {   // video thumbnails load their first frame once scrolled to
  for (const e of entries) if (e.isIntersecting) { e.target.preload = 'metadata'; galThumbs.unobserve(e.target); }
}, { rootMargin: '0px 400px' });

function openGallery(key) {
  GAL.items = boardItems();
  GAL.idx = Math.max(0, GAL.items.findIndex((x) => x.key === key));
  if (!GAL.items.length) return;
  pauseBoard();
  const main = h('div', { class: 'gal-main' });
  const el = h('div', { class: 'gal-view', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'gal-top' }, h('span', { class: 'gal-title' }), h('span', { class: 'gal-count hint' }),
      h('button', { type: 'button', class: 'btn small toggle-btn gal-strip-btn', title: 'Show or hide the thumbnails (T)', onclick: () => galleryStrip() }, 'Thumbnails'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => closeGallery() }, '✕')),
    h('div', { class: 'gal-stage' }, main,
      h('button', { type: 'button', class: 'gal-nav prev', 'aria-label': 'Previous', onclick: () => galleryGo(-1) }, '‹'),
      h('button', { type: 'button', class: 'gal-nav next', 'aria-label': 'Next', onclick: () => galleryGo(1) }, '›')),
    h('div', { class: 'gal-actions' }),
    h('div', { class: 'gal-strip' }));
  GAL.el = el;
  document.body.append(el);
  galleryStrip(store.get('deck.gallery.strip', true));
  wireGallerySwipe(main);
  galleryRender(true);
  overlayOpened(galleryBack);
}
const galleryBack = () => closeGallery(true);
// The thumbnail row can be hidden to give the preview the whole height (tall videos); remembered
function galleryStrip(on = GAL.el.classList.contains('no-strip')) {
  GAL.el.classList.toggle('no-strip', !on);
  GAL.el.querySelector('.gal-strip-btn').classList.toggle('on', on);
  store.set('deck.gallery.strip', on);
  if (on) GAL.el.querySelector('.gal-thumb.sel')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function closeGallery(viaBack = false) {
  if (!GAL.el) return;
  const key = GAL.items[GAL.idx]?.key;
  GAL.el.querySelectorAll('video').forEach((v) => v.pause());
  GAL.el.remove(); GAL.el = null; galThumbs.disconnect();
  if (viaBack !== true) overlayClosed(galleryBack);
  if ($('#tab-board').classList.contains('active')) {
    renderBoard().then(() => $(`#board .tile[data-key="${key}"]`)?.scrollIntoView({ block: 'center' }));
  }
}

// After pins / marks / deletes: rebuild the list, staying on the same item (or its neighbour if it went)
function galleryRefresh() {
  const key = GAL.items[GAL.idx]?.key;
  GAL.items = boardItems();
  if (!GAL.items.length) return closeGallery();
  const at = GAL.items.findIndex((x) => x.key === key);
  const same = at >= 0;
  GAL.idx = same ? at : Math.min(GAL.idx, GAL.items.length - 1);
  galleryRender(!same);
}

function galleryGo(d) {
  const n = Math.max(0, Math.min(GAL.items.length - 1, GAL.idx + d));
  if (n === GAL.idx) return;
  GAL.idx = n; galleryRender(true);
}

function galleryRender(newMedia = false) {
  const el = GAL.el, cur = GAL.items[GAL.idx];
  if (!el || !cur) return;
  const g = S.history.get(cur.g.id) || cur.g, { o, i } = cur;
  const marked = B.marked.has(g.id);
  el.querySelector('.gal-title').textContent = `#${g.id} ${g.template}`;
  el.querySelector('.gal-count').textContent = `${GAL.idx + 1} / ${GAL.items.length}`;
  el.querySelector('.gal-nav.prev').disabled = GAL.idx === 0;
  el.querySelector('.gal-nav.next').disabled = GAL.idx === GAL.items.length - 1;
  const main = el.querySelector('.gal-main');
  main.classList.toggle('marked', marked);
  if (newMedia || GAL.key !== cur.key) {
    main.querySelectorAll('video').forEach((v) => v.pause());
    galleryZoom(1);
    main.replaceChildren(o.kind === 'video'
      ? h('video', { src: o.url, muted: true, loop: true, playsInline: true, autoplay: true, controls: true })
      : h('img', { src: o.url, alt: o.filename, draggable: false }));
    for (const d of [-1, 1]) {   // warm the cache for the neighbours
      const nb = GAL.items[GAL.idx + d];
      if (nb && nb.o.kind === 'image') new Image().src = nb.o.url;
    }
  }
  GAL.key = cur.key;

  el.querySelector('.gal-actions').replaceChildren(...[
    h('button', { type: 'button', class: 'btn small' + (g.pinned ? ' on' : ''), onclick: () => togglePin(g) }, g.pinned ? '★ Pinned' : '☆ Pin'),
    h('button', { type: 'button', class: 'btn small' + (marked ? ' danger on' : ''), title: 'D',
      onclick: () => { toggleMarked(g.id); boardChanged(g); } }, marked ? '🗑 Marked' : '🗑 Mark'),
    o.kind === 'image' ? h('button', { type: 'button', class: 'btn small', onclick: () => { closeGallery(); itemsToEditor([cur]); } }, '✎ Edit') : null,
    h('button', { type: 'button', class: 'btn small', onclick: () => { closeGallery(); sendToInput(g, i, 'first'); } }, 'Use as input'),
    h('button', { type: 'button', class: 'btn small', onclick: () => openGeneration(g.id) }, 'Details'),
    h('a', { class: 'btn small', href: o.url, download: o.filename, style: 'display:grid;place-items:center;text-decoration:none' }, 'Download'),
    markedGens().length ? h('button', { type: 'button', class: 'btn small danger', onclick: deleteMarked }, `Delete ${markedGens().length} marked`) : null,
  ].filter(Boolean));

  const strip = el.querySelector('.gal-strip');
  if (strip.childElementCount !== GAL.items.length || newMedia) {
    galThumbs.disconnect();
    strip.replaceChildren(...GAL.items.map((x, n) => h('button', { type: 'button', class: 'gal-thumb', 'data-n': n, onclick: () => { GAL.idx = n; galleryRender(true); } },
      x.o.kind === 'video' ? h('video', { src: `${x.o.url}#t=0.1`, muted: true, playsInline: true, preload: 'none' })
        : h('img', { src: x.o.url, loading: 'lazy', alt: '', draggable: false }),
      h('span', { class: 'gal-badges' }))));
    strip.querySelectorAll('video').forEach((v) => galThumbs.observe(v));
  }
  strip.querySelectorAll('.gal-thumb').forEach((t, n) => {
    const x = GAL.items[n], xg = S.history.get(x.g.id) || x.g;
    t.classList.toggle('sel', n === GAL.idx);
    t.classList.toggle('marked', B.marked.has(xg.id));
    t.querySelector('.gal-badges').textContent = `${xg.pinned ? '★' : ''}${B.marked.has(xg.id) ? '🗑' : ''}${x.o.kind === 'video' ? '▶' : ''}`;
  });
  strip.querySelector('.gal-thumb.sel')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: newMedia ? 'smooth' : 'auto' });
}

// Swipe sideways on the big preview to move; the picture follows the finger. Pinch, the wheel or
// a double-tap zooms (images and videos); while zoomed one finger pans instead of swiping.
const GZ = { s: 1, x: 0, y: 0 };
function galleryZoom(s, x, y) {
  if (s <= 1.01) { s = 1; x = 0; y = 0; }
  Object.assign(GZ, { s, x, y });
  const m = GAL.el?.querySelector('.gal-main > *');
  if (m) m.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
  GAL.el?.classList.toggle('zoomed', s !== 1);
}
function wireGallerySwipe(main) {
  const zoomAt = (f, cx, cy) => {   // keep the point under (cx, cy) where it is
    const r = main.getBoundingClientRect(), qx = cx - (r.left + r.width / 2), qy = cy - (r.top + r.height / 2);
    const s = Math.max(1, Math.min(8, GZ.s * f)); f = s / GZ.s;
    galleryZoom(s, qx - f * (qx - GZ.x), qy - f * (qy - GZ.y));
  };
  const pts = new Map();
  let start = null, pinch = null, lastTap = 0;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  main.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {   // second finger: pinch, and forget any swipe the first one started
      start = null; main.style.transform = '';
      pinch = mid();
      for (const id of pts.keys()) { try { main.setPointerCapture(id); } catch { /* synthetic */ } }
      return;
    }
    if (pts.size > 2) return;
    const m = main.firstElementChild;
    // leave the bottom of an unzoomed video to its own controls (scrubbing)
    if (GZ.s === 1 && m?.tagName === 'VIDEO' && e.clientY > m.getBoundingClientRect().bottom - 50) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, horiz: null, pan: GZ.s > 1, zx: GZ.x, zy: GZ.y, moved: false };
    if (start.pan) { try { main.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
  });
  main.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const now = mid();
      if (pinch.d > 0) zoomAt(now.d / pinch.d, now.x, now.y);
      galleryZoom(GZ.s, GZ.x + now.x - pinch.x, GZ.y + now.y - pinch.y);
      pinch = now;
      return;
    }
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 10) start.moved = true;
    if (start.pan) return galleryZoom(GZ.s, start.zx + dx, start.zy + dy);
    if (start.horiz == null && start.moved) {
      start.horiz = Math.abs(dx) > Math.abs(dy);
      if (start.horiz) { try { main.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
    }
    if (start.horiz) main.style.transform = `translateX(${dx}px)`;
  });
  const end = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pinch) { if (!pts.size) pinch = null; return; }   // the rest of a pinch isn't a swipe or a tap
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, { horiz, pan, moved } = start;
    start = null;
    if (!pan && horiz) {
      main.style.transition = 'transform .15s'; main.style.transform = '';
      setTimeout(() => { main.style.transition = ''; }, 160);
      if (Math.abs(dx) > Math.min(80, main.clientWidth / 6)) galleryGo(dx < 0 ? 1 : -1);
    }
    if (!moved && e.type === 'pointerup') {   // double-tap: zoom in there, or back out
      if (Date.now() - lastTap < 300) { lastTap = 0; if (GZ.s > 1) galleryZoom(1); else zoomAt(2.5, e.clientX, e.clientY); }
      else lastTap = Date.now();
    }
  };
  main.addEventListener('pointerup', end); main.addEventListener('pointercancel', end);
  main.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY); }, { passive: false });
}

document.addEventListener('keydown', (e) => {
  if (!GAL.el || !$('#sheet').classList.contains('hidden') || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
  const cur = GAL.items[GAL.idx];
  const keys = {
    ArrowLeft: () => galleryGo(-1), ArrowRight: () => galleryGo(1),
    Home: () => galleryGo(-GAL.items.length), End: () => galleryGo(GAL.items.length),
    Escape: () => closeGallery(),
    t: () => galleryStrip(),
    p: () => togglePin(S.history.get(cur.g.id) || cur.g),
    d: () => { toggleMarked(cur.g.id); boardChanged(cur.g); },
    e: () => { if (cur.o.kind === 'image') { closeGallery(); itemsToEditor([cur]); } },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

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
        ? h('button', { type: 'button', class: 'btn small', onclick: async (e) => {
            e.stopPropagation();
            const who = isMine(j.prompt_id) ? '' : ' It was started from another device.';
            if (!confirm(`Stop ${j.id ? `#${j.id}` : 'this run'}?${who}`)) return;
            await stop(j.prompt_id, { ask: false }); refresh();
          } }, 'Stop')
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
  try { S.projects = await api('/api/projects'); } catch (e) { toast(e.message, true); return; }  // syncWithServer retries on reconnect
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
  B.sel.clear();
  if ($('#tab-board').classList.contains('active')) renderBoard();
  if (sceneMod) sceneMod.projectChanged();
});

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name);
    if (b.dataset.tab === name) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'generate' && !RUN.pid) runChip(0, 0, $('#progText').textContent);   // lets go of a finished ✓ / !
  if (name === 'history') loadHistory();
  if (name === 'editor') renderEditor();
  if (name === 'video') renderVideo(); else vidPause();
  if (name === 'board') renderBoard(); else { closeGallery(); pauseBoard(); }
  if (name === 'scene') sceneModule().then((m) => m.show()).catch((e) => toast(`3D view: ${e.message}`, true));
  else if (sceneMod) sceneMod.hide();
  $('.actionbar').classList.toggle('hidden', ['editor', 'video', 'board', 'scene'].includes(name));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('#tplSel').addEventListener('change', (e) => selectTemplate(e.target.value));
$('#reloadTpl').addEventListener('click', async () => { await loadTemplates(true); toast('Templates and model lists reloaded'); });
$('#genBtn').addEventListener('click', () => { const p = S.pendingParent; S.pendingParent = null; generate(p); });
$('#stopBtn').addEventListener('click', () => stop());
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume(); });
addEventListener('pageshow', (e) => { if (e.persisted) onResume(); });   // restored from the back/forward cache
addEventListener('online', onResume);

// Two tabs (or the PWA and a browser tab) share these settings: when the other one changes them,
// pick the change up here instead of quietly writing the old values back over it.
addEventListener('storage', (e) => {
  if (!S.tpl || !e.key) return;
  if (e.key === stateKey(S.tpl.id)) selectTemplate(S.tpl.id);
  else if (e.key === 'deck.builder') { S.pb = null; renderFields(); }
  else if (e.key === 'deck.myPrompts') S.myPrompts = new Set(store.get('deck.myPrompts', []));
});
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
  const close = (viaBack = false) => {
    if (!src) return;
    const s = src;
    src = null;
    box.classList.add('hidden');
    ta.blur();
    s.dispatchEvent(new Event('change', { bubbles: true }));
    s.dispatchEvent(new Event('grow'));
    if (viaBack !== true) overlayClosed(back);
  };
  const back = () => close(true);
  // Undo: chips change the text from code, which the keyboard's own undo can't reverse, so keep
  // snapshots: one before each chip, one per burst of typing.
  let undo = [], lastTyped = -Infinity, prev = null;
  const state = () => ({ v: ta.value, a: ta.selectionStart, b: ta.selectionEnd });
  const undoBtn = h('button', { type: 'button', class: 'btn small', disabled: true, onmousedown: (ev) => ev.preventDefault(), onclick: () => {
    const u = undo.pop();
    if (!u) return;
    ta.value = u.v; ta.focus(); ta.setSelectionRange(u.a, u.b);
    ta.dispatchEvent(new Event('input'));
    undoBtn.disabled = !undo.length;
  } }, '↶ Undo');
  // wildcard keys, since { | } are a few keyboard pages deep. { } wraps a selection as the first option.
  const typeRaw = (fn) => {
    snap(); lastTyped = -Infinity;
    const a = ta.selectionStart, b = ta.selectionEnd;
    const [text, caret] = fn(ta.value.slice(a, b), ta.value.slice(b));
    ta.focus(); ta.setRangeText(text, a, b, 'end');
    ta.setSelectionRange(a + caret, a + caret);
    ta.dispatchEvent(new Event('input'));
  };
  const key = (label, title, fn) => h('button', { type: 'button', class: 'btn small key', title,
    onmousedown: (ev) => ev.preventDefault(), onclick: () => typeRaw(fn) }, label);
  const keys = h('div', { class: 'text-pop-keys' },
    key('{ }', 'Wildcard group: one option is picked at random each run', (sel) => sel ? [`{${sel}|}`, sel.length + 2] : ['{}', 1]),
    key('|', 'Next option', () => ['|', 1]),
    key('}→', 'Jump past the end of this group', (sel, after) => { const i = after.indexOf('}'); return [sel, sel.length + (i >= 0 ? i + 1 : 0)]; }));
  const snap = (st = state()) => {
    undo.push(st);
    if (undo.length > 100) undo.shift();
    undoBtn.disabled = false;
  };
  ta.addEventListener('input', (e) => {   // only real typing has an inputType; chips and undo don't
    if (e.inputType) {
      if (prev && performance.now() - lastTyped > 1500) snap(prev);
      lastTyped = performance.now();
    }
    prev = state();
  });
  const box = h('div', { class: 'text-pop hidden', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'text-pop-bar' }, title, keys, undoBtn,
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
    if (!src) overlayOpened(back);
    src = t;
    title.textContent = t.closest('.prompt-part')?.querySelector('.part-head b')?.textContent
      || t.closest('.field')?.querySelector('.lbl')?.firstChild?.textContent || 'Text';
    ta.value = t.value;
    ta.placeholder = t.placeholder || '';
    undo = []; lastTyped = -Infinity; undoBtn.disabled = true; prev = { v: ta.value, a: ta.value.length, b: ta.value.length };
    // the prompt's tag chips (<Picture 1>, <Subject 1>…) move in here; on touch screens the panel hides them
    const list = [...(t.closest('.prompt-field')?.querySelectorAll('.tag-chips .chip') || [])].map((c) => c.textContent);
    const chip = (label, text = label) => h('button', { type: 'button', class: 'chip',
      title: typeof text === 'string' ? text.replace(/[§¶↵]/g, '') : label,
      onmousedown: (ev) => ev.preventDefault(), onclick: () => { snap(); lastTyped = -Infinity; insertPhrase(ta, text); } }, label);
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
  try { const s = await api('/api/status', { timeout: 8000 }); setConn(s.comfy_connected); } catch { /* server down: the socket keeps retrying */ }
  await loadProjects();
  await loadTemplates();
  loadHistory();
  connectWS();   // its first open runs syncWithServer: picks up a run that's already going
  // The service worker (HTTPS only) keeps an offline page and lets Android show "done" notifications
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
