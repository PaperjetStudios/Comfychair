// Downloads: the top bar's button and its panel. What's coming in, with progress and Stop, and a history of what came in
// (app/downloads.py). Every device's button follows along through the deck_downloads message.
//   wireDownloads(btn), openDownloads(), showDownloads({ count, progress }), refreshDownloads()
import { $, api, button, h, help, hint, icon, iconBtn, linkBtn, note, openSheet, sheetOpen, toast } from './ui.js';
import { historyWords, progressWords } from './download-words.js';

export function showDownloads({ count = 0, progress = 0 } = {}) {
  const info = $('#dlInfo');
  if (info) info.textContent = count ? ` ${count > 1 ? `${count} · ` : ''}${Math.round(progress * 100)}%` : '';
}

export async function refreshDownloads() {
  try {
    const { active } = await api('/api/downloads', { busy: false });
    const got = active.reduce((n, d) => n + d.got, 0), total = active.reduce((n, d) => n + d.total, 0);
    showDownloads({ count: active.length, progress: total ? got / total : 0 });
  } catch { /* the button just stays as it was */ }
}

export function wireDownloads(btn) {
  btn.querySelector('#dlIcon').replaceChildren(icon('download'));
}

let timer = null;
export async function openDownloads() {
  const box = h('div', { class: 'jobs' });
  openSheet(h('h3', {}, 'Downloads'),
    help('LoRAs coming in from Civitai and the ones that came in. Stop throws away what came so far. Clear only empties this list: the files stay where they are.'),
    box);
  let shown = null, bars = new Map();
  const refresh = async () => {
    if (!sheetOpen() || !box.isConnected) { clearInterval(timer); timer = null; return; }
    let d;
    try { d = await api('/api/downloads', { busy: false }); } catch (e) { box.replaceChildren(note(e.message, 'err')); shown = null; return; }
    const got = d.active.reduce((n, x) => n + x.got, 0), total = d.active.reduce((n, x) => n + x.total, 0);
    showDownloads({ count: d.active.length, progress: total ? got / total : 0 });
    // the rows only rebuild when the list changes, so Stop stays under the finger; the numbers change in place
    const sig = JSON.stringify([d.active.map((x) => [x.id, x.stopping]), d.history.map((e) => [e.id, e.state, e.gone])]);
    if (sig !== shown) {
      shown = sig; bars = new Map();
      const live = d.active.map((x) => {
        const fill = h('div', { class: 'clip-progress-fill' }), words = h('span', { class: 'hint' });
        bars.set(x.id, { fill, words });
        return h('div', { class: 'job running dl-row' },
          h('div', { class: 'job-main' }, h('b', {}, x.name), x.version ? ` · ${x.version}` : '', x.family ? h('div', { class: 'hint' }, `to ${x.family}/`) : null,
            h('div', { class: 'clip-progress' }, fill, words)),
          button(x.stopping ? 'Stopping…' : 'Stop', async (e) => {
            if (!confirm(`Stop ${x.name}? What came so far is thrown away.`)) return;
            e.currentTarget.disabled = true;
            try { await api(`/api/clip/job/${x.job}/cancel`, { method: 'POST', busy: false }); refresh(); } catch (err) { toast(err.message, true); }
          }, { cls: 'small', disabled: x.stopping }));
      });
      const past = d.history.map((e) => h('div', { class: `job dl-row dl-${e.state}` },
        h('div', { class: 'job-main' }, h('b', {}, e.name), e.version ? ` · ${e.version}` : '',
          h('div', { class: 'hint' }, [historyWords(e), e.family ? `${e.family}/${e.file || ''}` : null].filter(Boolean).join(' · ')),
          e.error ? note(e.error, 'err') : null),
        e.link ? linkBtn('↗', e.link, { target: '_blank', rel: 'noopener', title: 'On Civitai' }) : null,
        iconBtn('Take off the list', '✕', async () => {
          try { await api(`/api/downloads/${e.id}`, { method: 'DELETE', busy: false }); refresh(); } catch (err) { toast(err.message, true); }
        })));
      box.replaceChildren(
        h('div', { class: 'lbl jobs-head' }, live.length ? `Downloading (${live.length})` : 'Nothing downloading'),
        ...live,
        h('div', { class: 'lbl jobs-head row dl-head' }, h('span', { class: 'grow' }, 'History'),
          past.length ? button('Clear', async () => {
            try { await api('/api/downloads', { method: 'DELETE', busy: false }); refresh(); } catch (err) { toast(err.message, true); }
          }, { cls: 'small', title: 'Empty this list. The files stay.' }) : null),
        ...(past.length ? past : [hint('None yet')]));
    }
    for (const x of d.active) {
      const b = bars.get(x.id);
      if (!b) continue;
      b.fill.style.width = `${Math.round(x.progress * 100)}%`;
      b.words.textContent = `${Math.round(x.progress * 100)}% · ${progressWords(x)}`;
    }
  };
  clearInterval(timer);
  timer = setInterval(refresh, 1000);
  refresh();
}
