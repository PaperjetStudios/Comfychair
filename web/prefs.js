// App-wide settings: one document in the global store (library/prefs/app.json), so every device and
// project shares them. PREFS holds the values (defaults until loaded); setPref saves; other devices'
// changes arrive as `store` messages. openPrefs() is the ⚙ sheet; its Projects section is projects.js.
import { h, api, toast, openSheet, help, toggle, section, field, seg, button, hint, note, linkBtn } from './ui.js';
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
    networkSection(),
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

// Network: how to reach ComfyChair from a tablet. The LAN address changes with the Wi-Fi network; the Tailscale one does not.
function networkSection() {
  const body = h('div', {}, hint('Loading…'));
  api('/api/network').then((n) => body.replaceChildren(...networkRows(n))).catch((e) => body.replaceChildren(note(e.message)));
  return section('Network', null,
    help('The address a tablet uses changes when this PC joins another Wi-Fi network, so a saved address or home-screen icon can stop working. The Tailscale address stays the same on every network. The .local name often survives a change too.'),
    body);
}

function networkRows(n) {
  const kinds = { lan: 'Wi-Fi / LAN', tailscale: 'Tailscale', mdns: 'Name' };
  const rows = n.addresses.map((a) => field(kinds[a.kind] + (a.iface && a.kind === 'lan' ? ` (${a.iface})` : ''),
    h('div', { class: 'row wrap' },
      h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.url),
      button('QR', () => showQr(a.url), { cls: 'small' }))));
  if (n.tailscale?.state === 'NeedsMachineAuth')
    rows.push(note('Tailscale is waiting for this machine to be approved in your Tailscale admin console; once approved its address works from any network'));
  if (n.cert) {
    rows.push(field('Certificate', hint(n.cert.expires ? `Expires ${new Date(n.cert.expires).toLocaleDateString()}` : 'Expiry unknown')));
    if (!n.cert.covers) rows.push(note("The certificate doesn't cover the current address. Restarting ComfyChair renews it."));
  }
  if (n.ca) rows.push(field('CA certificate', linkBtn('Download CA certificate', '/api/network/ca', { download: 'comfydeck-ca.crt' }),
    help('Install this once on each tablet so HTTPS works: Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate. iPad: open the file, then Settings > General > VPN & Device Management, install it, then Settings > General > About > Certificate Trust Settings.')));
  return rows;
}

// A QR code for one address, big enough to scan from a phone; Back returns to the settings sheet
function showQr(url) {
  openSheet(h('h3', {}, 'Scan to open'),
    h('div', { class: 'row', style: 'justify-content:center' },
      h('img', { src: `/api/network/qr.svg?url=${encodeURIComponent(url)}`, alt: `QR code for ${url}`, style: 'width:min(80vw,360px);height:auto;background:#fff;border-radius:8px' })),
    h('div', { class: 'row', style: 'justify-content:center' }, h('a', { href: url, target: '_blank', rel: 'noopener' }, url)),
    button('Back', openPrefs, { cls: 'small ghost' }));
}
