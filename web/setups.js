// Setups: a parameter block's values saved under a name, for every project (store kind `setups`, global scope; the rules
// and keys are web/setups-rules.js). One row per block, mounted above its fields:
//
//   setupsRow({ key, get, set, label })   -> element. key: the block's key (or a function giving it, read on each draw);
//                                            get(): the values shown now; set(values): show these (the block redraws).
//
// The row: a list of the block's setups (newest first, "— none —" first), Save… (a name), Update (the picked one gets the
// values shown now; only when they differ), Rename and Delete (with Undo). Picking one shows its values, with Undo.
// Every setup is loaded in one call and kept; a `store` message for kind setups (another device, another tab) reloads.
// A tpl: key with no setups also lists that template's Generate defaults of this project (gen-presets) as read-only
// "(project)" entries, so nothing saved the old way is lost; Save… copies one into a setup.
import { h, api, toast, undoToast, nameSheet, button, iconBtn, store, uid, clone } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { differs, forKey, fromPreset, sortSetups, toSetup, tplOfKey } from './setups-rules.js';

const url = (id = '', tail = '') => `/api/store/setups${id ? `/${id}` : ''}${tail}?scope=global`;
let all = null, loading = null;   // every setup ({ id, name, rev, updated, key, values })
const presets = new Map();        // project id -> its gen-presets as read-only entries (or a promise of them)
const rows = new Set();
const pickKey = (k) => `deck.setup.${k}`;

async function put(id, body) {   // (api() drops the status; a 409 matters here)
  try {
    const r = await fetch(url(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, net: true }; }
}
function load(force = false) {
  if (loading) return loading;
  if (all && !force) return Promise.resolve(all);
  return (loading = api(`${url()}&full=true`, { busy: false })
    .then((list) => { all = (list || []).map(toSetup); }, () => { all ||= []; })
    .finally(() => { loading = null; drawAll(); }));
}
const upsert = (s) => { all = [...(all || []).filter((x) => x.id !== s.id), s]; };

// this project's old Generate defaults (read once per project)
function presetsHere() {
  const pid = S.project ?? null, had = presets.get(pid);
  if (Array.isArray(had)) return had;
  if (!had) {
    const qs = pid != null ? `&project_id=${pid}` : '';
    presets.set(pid, api(`/api/store/gen-presets?full=true${qs}`, { busy: false })
      .then((list) => { presets.set(pid, (list || []).map(fromPreset)); }, () => { presets.set(pid, []); })
      .finally(drawAll));
  }
  return [];
}

function listFor(k) {
  const mine = sortSetups(forKey(all || [], k));
  const tpl = tplOfKey(k);
  return mine.length || !tpl ? mine : sortSetups(forKey(presetsHere(), k));
}

export function setupsRow({ key, get, set, label = 'Setup' }) {
  const r = { el: h('div', { class: 'row setups-row' }), keyOf: typeof key === 'function' ? key : () => key, get, set, label, born: Date.now() };
  r.el._setups = r;
  rows.add(r);
  load();
  draw(r);
  return r.el;
}
export const redrawSetups = (el) => { if (el?._setups) draw(el._setups); };

function draw(r) {
  const k = r.keyOf();
  r.key = k;
  if (!k) { r.el.replaceChildren(); r.el.classList.add('hidden'); return; }
  r.el.classList.remove('hidden');
  const list = listFor(k), want = store.get(pickKey(k), null), cur = list.find((s) => s.id === want) || null;
  r.cur = cur;
  const sel = h('select', { class: 'setups-pick', 'aria-label': `${r.label}s saved for this`, title: all ? 'Saved setups' : 'Loading the saved setups…',
    onchange: () => choose(r, sel.value || null) },
  h('option', { value: '' }, all ? '— none —' : 'Loading…'),
  ...list.map((s) => h('option', { value: s.id, selected: s.id === cur?.id }, s.name)));
  if (!cur) sel.value = '';
  r.update = button('Update', () => update(r), { cls: 'small ghost', title: 'Save the values shown now into the picked setup' });
  r.rename = iconBtn('Rename this setup', '✎', () => rename(r));
  r.del = iconBtn('Delete this setup', '🗑', () => remove(r));
  r.el.replaceChildren(sel, button('Save…', () => saveNew(r), { cls: 'small ghost', title: 'Save the values shown now as a new setup, for every project' }), r.update, r.rename, r.del);
  enable(r);
}
function enable(r) {
  if (!r.update) return;
  const cur = r.cur, own = !!cur && !cur.readOnly;
  let changed = false;
  try { changed = own && differs(r.get(), cur.values); } catch { /* the block is gone */ }
  r.update.disabled = !changed;
  r.update.title = !cur ? 'Pick a setup first' : cur.readOnly ? 'A Generate default of this project: Save… makes it a setup' : changed ? `Save the values shown now into "${cur.name}"` : 'Nothing changed';
  r.rename.disabled = !own; r.del.disabled = !own;
}
function drawAll() {
  const now = Date.now();
  for (const r of [...rows]) {
    if (r.el.isConnected) { r.seen = true; draw(r); } else if (r.seen || now - r.born > 10000) rows.delete(r);
  }
}
// edits in a block change what Update can do: look again after any input (once per frame)
let due = 0;
function recheck() {
  if (due) return;
  due = requestAnimationFrame(() => { due = 0; for (const r of rows) if (r.el.isConnected) { r.seen = true; enable(r); } });
}
for (const ev of ['input', 'change', 'click', 'pointerup', 'keyup']) addEventListener(ev, recheck, true);

function choose(r, id) {
  const k = r.key;
  if (!id) { store.set(pickKey(k), null); r.cur = null; enable(r); return; }
  const s = listFor(k).find((x) => x.id === id);
  if (!s) return;
  let before = null;
  try { before = clone(r.get()); } catch { /* */ }
  store.set(pickKey(k), id);
  r.set(clone(s.values));
  drawAll();
  if (before && differs(before, s.values)) undoToast(`Setup "${s.name}"`, () => { store.set(pickKey(k), null); r.set(before); drawAll(); });
}

function saveNew(r) {
  const k = r.key;
  nameSheet({ title: `Save ${r.label.toLowerCase()}`, placeholder: 'Name, e.g. "Night look"', hint: 'Keeps the values shown now under a name. Setups are shared by every project: pick one to show its values again.',
    save: async (name) => {
      if (!name) throw new Error('Type a name');
      const id = uid() + uid();
      const res = await put(id, { rev: 0, name: name.slice(0, 120), payload: { v: 1, key: k, values: clone(r.get()) } });
      if (!res.ok) throw new Error('Couldn\'t save the setup');
      upsert(toSetup(res.data));
      store.set(pickKey(k), id);
      drawAll();
      toast(`Saved "${name}"`);
    } });
}
async function update(r) {
  const s = r.cur;
  if (!s || s.readOnly) return;
  const res = await put(s.id, { rev: s.rev, payload: { v: 1, key: s.key, values: clone(r.get()), ...(s.note && { note: s.note }) } });
  if (!res.ok) { toast(res.status === 409 ? 'That setup changed on another device: it was reloaded, try again' : 'Couldn\'t update the setup', true); load(true); return; }
  upsert(toSetup(res.data));
  drawAll();
  toast(`Updated "${s.name}"`);
}
function rename(r) {
  const s = r.cur;
  if (!s || s.readOnly) return;
  nameSheet({ title: 'Rename setup', placeholder: s.name, saveLabel: 'Rename', save: async (name) => {
    if (!name) throw new Error('Type a name');
    const res = await put(s.id, { rev: s.rev, name: name.slice(0, 120) });
    if (!res.ok) { load(true); throw new Error(res.status === 409 ? 'Changed on another device: reloaded, try again' : 'Couldn\'t rename'); }
    upsert(toSetup(res.data));
    drawAll();
  } });
}
async function remove(r) {
  const s = r.cur, k = r.key;
  if (!s || s.readOnly) return;
  try { await api(url(s.id), { method: 'DELETE', busy: false }); } catch (e) { toast(e.message, true); return; }
  all = (all || []).filter((x) => x.id !== s.id);
  store.set(pickKey(k), null);
  drawAll();
  undoToast(`Deleted "${s.name}"`, async () => {
    try {
      const doc = await api(url(s.id, '/restore'), { method: 'POST', busy: false });
      upsert(toSetup(doc));
      store.set(pickKey(k), s.id);
      drawAll();
    } catch (e) { toast(e.message, true); }
  });
}

// live: a setup saved elsewhere, or this project's old defaults changed
let lt = 0;
onServer('store', (m) => {
  if (m.kind === 'setups') { clearTimeout(lt); lt = setTimeout(() => load(true), 150); }
  else if (m.kind === 'gen-presets' && m.scope === 'project') { presets.delete(m.project_id ?? null); drawAll(); }
});
onServer('ws_open', () => { if (all) load(true); });
onProject(() => { presets.clear(); drawAll(); });
