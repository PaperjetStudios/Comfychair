// App-wide settings: one document in the global store (library/prefs/app.json), so every device and
// project shares them. PREFS holds the values (defaults until loaded); setPref saves; other devices'
// changes arrive as `store` messages. openPrefs() is the ⚙ sheet; its Projects section is projects.js.
import { h, api, toast, openSheet, help, toggle, section, field, seg, button } from './ui.js';
import { onServer } from './core.js';
import { projectsSection } from './projects.js';

const DOC = '/api/store/prefs/app?scope=global';
const DEFAULTS = { tplScrollTop: false, civitaiNsfw: 'soft' };
export const PREFS = { ...DEFAULTS };
let rev = 0;

// what the sheet shows: [key, label, help]
const TOGGLES = [
  ['tplScrollTop', 'Jump to the top when the template changes',
    'Generate keeps your place in the settings when they redraw. With this on, picking a different template (or a tab with a different template) scrolls the settings back to the top.'],
];

export async function loadPrefs() {
  try {
    const d = await api(`${DOC}&optional=true`, { busy: false });   // (null: none saved yet)
    rev = d?.rev || 0; Object.assign(PREFS, DEFAULTS, d?.payload);
  } catch { /* offline: defaults */ }
}

export async function setPref(key, value) {
  PREFS[key] = value;
  const payload = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, PREFS[k]]));
  try {
    rev = (await api(DOC, { method: 'PUT', body: { name: 'Settings', payload, rev }, busy: false })).rev;
  } catch (e) {
    await loadPrefs();   // stale rev (changed on another device): take theirs, then apply this change on top
    if (PREFS[key] !== value) return setPref(key, value);
    toast(`Settings not saved: ${e.message}`, true);
  }
}

onServer('store', (m) => { if (m.kind === 'prefs' && m.id === 'app' && m.rev !== rev) loadPrefs(); });

export function openPrefs() {
  openSheet(h('h3', {}, 'Settings'),
    help('These apply on every device and in every project.'),
    TOGGLES.map(([k, label, tip]) => toggle(label, PREFS[k], (on) => setPref(k, on), { help: tip })),
    civitaiSection(),
    projectsSection(openPrefs));
}

// Civitai: the API key (kept on the server only: the page is told whether one is set, never the key) and how much
// NSFW the LoRA browser (civitai.js) shows
function civitaiSection() {
  const status = h('span', {}, '');
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Civitai API key', 'aria-label': 'Civitai API key', spellcheck: false });
  const remove = button('Remove', async () => {
    try { show(await api('/api/civitai/key', { method: 'DELETE' })); toast('Civitai key removed'); } catch (e) { toast(e.message, true); }
  }, { cls: 'small ghost' });
  const save = button('Save', async () => {
    const key = input.value.trim();
    if (!key) return toast('Paste your key first', true);
    try {
      show(await api('/api/civitai/key', { method: 'PUT', body: { key }, busy: 'Checking the key with Civitai' }));
      input.value = ''; toast('Civitai key saved');
    } catch (e) { toast(e.message, true); }
  }, { cls: 'small primary' });
  const show = (s) => {
    status.textContent = s?.set ? (s.user ? `Set as ${s.user}` : 'Set') : 'Not set';
    remove.classList.toggle('hidden', !s?.set);
    input.placeholder = s?.set ? 'Paste a new key to replace it' : 'Civitai API key';
  };
  show(null);
  api('/api/civitai/key').then(show).catch(() => { status.textContent = ''; });
  const helpText = h('span', {}, 'Some LoRAs on civitai.com only download with an API key. Make one at ',
    h('a', { href: 'https://civitai.com/user/account', target: '_blank', rel: 'noopener' }, 'civitai.com/user/account'),
    ' (API Keys), then paste it here. It stays on the ComfyChair server and is only sent to Civitai.');
  return section('Civitai', null,
    keyField(status, helpText, h('div', { class: 'row' }, input, save, remove)),
    field('NSFW pictures', help('Off: only safe-for-work LoRAs, and anything racier blurred. Soft: suggestive pictures shown, explicit ones blurred. All: nothing blurred. A blurred picture shows when tapped in a LoRA\'s page.'),
      seg([['off', 'Off'], ['soft', 'Soft'], ['all', 'All']], PREFS.civitaiNsfw, (v) => setPref('civitaiNsfw', v))));
}

// The key's field: its ⓘ opens a note with a link in it (info() popovers are plain text), shown under the label
function keyField(status, content, ...kids) {
  const tip = h('div', { class: 'note tip hidden' }, content);
  const b = h('button', { type: 'button', class: 'info-i', 'aria-label': 'About the API key', 'aria-expanded': 'false' }, 'ⓘ');
  b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    b.setAttribute('aria-expanded', String(!tip.classList.toggle('hidden')));
  });
  return field([['API key', b], status], tip, ...kids);
}
