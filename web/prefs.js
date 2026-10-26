// App-wide settings: one document in the global store (library/prefs/app.json), so every device and
// project shares them. PREFS holds the values (defaults until loaded); setPref saves; other devices'
// changes arrive as `store` messages. openPrefs() is the ⚙ sheet.
import { h, api, toast, openSheet, help, info } from './ui.js';
import { onServer } from './core.js';

const DOC = '/api/store/prefs/app?scope=global';
const DEFAULTS = { tplScrollTop: false };
export const PREFS = { ...DEFAULTS };
let rev = 0;

// what the sheet shows: [key, label, help]
const TOGGLES = [
  ['tplScrollTop', 'Jump to the top when the template changes',
    'Generate keeps your place in the settings when they redraw. With this on, picking a different template (or a tab with a different template) scrolls the settings back to the top.'],
];

export async function loadPrefs() {
  try {
    const d = await api(DOC, { busy: false });
    rev = d.rev; Object.assign(PREFS, DEFAULTS, d.payload);
  } catch { /* none saved yet (404) or offline: defaults */ }
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
    TOGGLES.map(([k, label, tip]) => h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: !!PREFS[k], onchange: (e) => setPref(k, e.target.checked) }), label, info(tip))));
}
