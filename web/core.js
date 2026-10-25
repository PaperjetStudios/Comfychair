// Shared by every panel: the state `S`, saved snippets, input-image URLs. Imports nothing but ui.js, so it
// is always evaluated before the panels (they import each other in cycles, used only inside functions).
import {
  $, h, store, api, toast, undoToast,
} from './ui.js';

// Deleting a saved snippet (settings, prompt part, prompt set) with an Undo that saves it again
export async function deleteSnippet(sn, msg, after) {
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
// state
// ---------------------------------------------------------------------------
export const S = {
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
export function addMine(pid) {
  S.myPrompts.add(pid);
  store.set('deck.myPrompts', [...S.myPrompts].slice(-300));
}
export const isMine = (pid) => !!pid && S.myPrompts.has(pid);

// Saved entries of a snippet category whose text is JSON (shots, presets), parsed into .p; keep(p)
// picks the ones that apply here
export function savedEntries(cat, keep = () => true) {
  return (S.snippets || []).filter((x) => x.category === cat)
    .map((x) => { try { return { ...x, p: JSON.parse(x.text) }; } catch { return null; } })
    .filter((x) => x && keep(x.p));
}
// Save (or, with an id, overwrite) a snippet and reload the list
export async function saveSnippet(body) {
  const r = await api('/api/snippets', { method: 'POST', body });
  await loadSnippets(true);
  return r;
}

export const ASPECT_PRESETS = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4],
  ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9]];

export async function loadSnippets(force = false) {
  if (S.snippets && !force) return S.snippets;
  try { S.snippets = await api('/api/snippets'); } catch { S.snippets = []; }
  return S.snippets;
}

export const inputUrl = (name) => `/api/input?name=${encodeURIComponent(name)}`;
export const thumbUrl = (name, px = 320) => `${inputUrl(name)}&thumb=${px}`;
export const fmtT = (t) => `${Number(t || 0).toFixed(2)}s`;

// the project picker's options (the picker itself is wired in app.js)
export async function loadProjects() {
  try { S.projects = await api('/api/projects'); } catch (e) { toast(e.message, true); return; }  // syncWithServer retries on reconnect
  if (!S.projects.find((p) => p.id === S.project)) S.project = S.projects[0]?.id ?? null;
  const sel = $('#projectSel');
  sel.replaceChildren(...S.projects.map((p) => h('option', { value: p.id }, p.name)), h('option', { value: '__new' }, '+ New project…'));
  sel.value = S.project;
}

// The tab switcher lives in app.js (it knows every panel); panels call it through here.
export let switchTab = () => {};
export function setSwitchTab(f) { switchTab = f; }

// Tiny pub/sub so modules needn't import each other: run.js owns the websocket and forwards
// messages (plus {type:'ws_open'} on every (re)connect); app.js announces a project switch.
const SERVER = new Map(), PROJECT = new Set();
export function onServer(type, fn) { if (!SERVER.has(type)) SERVER.set(type, new Set()); SERVER.get(type).add(fn); return () => SERVER.get(type).delete(fn); }
export function emitServer(m) { for (const fn of [...(SERVER.get(m.type) || [])]) { try { fn(m); } catch (e) { console.error(e); } } }
export function onProject(fn) { PROJECT.add(fn); return () => PROJECT.delete(fn); }
export function emitProject() { for (const fn of [...PROJECT]) { try { fn(S.project); } catch (e) { console.error(e); } } }

// Image-picker sources registered by panels (media.js registerPickerSource). Lives here, not in media.js,
// because panels register while the import cycle is still being evaluated and media.js may not have run yet.
export const PICKER_SOURCES = new Map();
