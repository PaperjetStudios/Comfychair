// A LoRA picked from a list you can search, in place of a dropdown too long to scroll: a button showing the choice, and a menu with a search box.
// loraPicker({ options, value, label(o), empty, others, otherLabel(o), onPick(o), onCivitai(words), aria }):
//   options: what can be picked; empty: the text of the "nothing" row (none: there is no such row); others: more names, shown only when searching (another
//   model's folder, say); onCivitai: a last row that takes the words to Civitai's search. Arrow keys move, Enter picks, Esc closes.
import { api, button, chip, chips, closePopover, field, h, help, iconBtn, note, numSlider, openSheet, placeholder, popover, sheetStillOpen } from './ui.js';
import { foldersOf, matchNames, withLora } from './lora-match.js';
import { icon } from './icons.js';
import { openCivitai } from './civitai.js';

const MOST = 200;   // rows drawn at once: more words narrow it down

export function loraPicker({ options, value = '', label = (o) => o, empty = null, others = [], otherLabel = (o) => o, onPick, onCivitai = null, aria = 'LoRA', shown = null }) {
  const btn = h('button', { type: 'button', class: 'lora-pick', 'aria-haspopup': 'listbox', 'aria-label': aria, title: shown || (value ? label(value) : empty || '') },
    h('span', { class: 'lora-pick-name' }, shown || (value ? label(value) : empty || '')), icon('chevdown'));
  btn.addEventListener('click', () => {
    const box = h('input', { type: 'search', placeholder: 'Search', 'aria-label': `Search ${aria}`, enterkeyhint: 'search' });
    const list = h('div', { class: 'lora-pick-list', role: 'listbox' });
    let rows = [], at = -1;
    const mark = (i) => {
      rows[at]?.classList.remove('at');
      at = i;
      rows[at]?.classList.add('at');
      rows[at]?.scrollIntoView({ block: 'nearest' });
    };
    const row = (text, fn, { on = false, cls = '' } = {}) => {
      const b = h('button', { type: 'button', role: 'option', class: `lora-pick-row${on ? ' on' : ''}${cls ? ` ${cls}` : ''}`, 'aria-selected': String(on), title: text, onclick: () => { closePopover(); fn(); } }, text);
      rows.push(b);
      return b;
    };
    const draw = () => {
      const q = box.value.trim(), found = matchNames(options, q, label), more = q ? matchNames(others, q, otherLabel) : [];
      rows = []; at = -1;
      list.replaceChildren(
        ...(empty && !q ? [row(empty, () => onPick(''), { on: !value })] : []),
        ...found.slice(0, MOST).map((o) => row(label(o), () => onPick(o), { on: o === value })),
        ...(more.length ? [h('div', { class: 'hint lora-pick-head' }, 'Other folders')] : []),
        ...more.slice(0, MOST).map((o) => row(otherLabel(o), () => onPick(o), { on: o === value })),
        ...(!found.length && !more.length ? [h('div', { class: 'hint lora-pick-head' }, 'None of yours match')] : []),
        ...(found.length + more.length > MOST ? [h('div', { class: 'hint lora-pick-head' }, 'More than fit here: type more of the name')] : []),
        ...(onCivitai ? [row(q ? `Search Civitai for "${q}"` : 'Find on Civitai', () => onCivitai(q), { cls: 'lora-pick-civ' })] : []));
      if (q && rows.length) mark(0);
    };
    box.addEventListener('input', draw);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) mark((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length); }
      else if (e.key === 'Enter') { e.preventDefault(); rows[at]?.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); btn.focus(); }
    });
    draw();
    popover(btn, h('div', { class: 'lora-pick-menu' }, box, list));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    if (matchMedia('(pointer: fine)').matches) box.focus();   // (on a tablet the keyboard comes up only when the box is tapped)
  });
  return btn;
}

// The LoRA stack, wherever a run takes several: rows of on / picker / info / remove / strength, folder chips, + Add LoRA and Civitai.
// loraStack({ options, get(), set(rows), mode(), setMode(k), auto(folders), tip, onWord(word), onDownloaded(), onAdded() }):
//   mode: the folder shown ('auto', 'all' or a folder); auto: which folder Auto means here; onWord: a trigger word tapped;
//   onDownloaded: reload the installed list (awaited before Civitai offers Add); onAdded: a downloaded LoRA went in, so the panel builds again with the new list.
export function loraStack({ options, get, set, mode, setMode, auto: autoOf = () => null, tip = null, onWord = null, onDownloaded = null, onAdded = null }) {
  const list = h('div', { class: 'stack' });
  const save = (rows) => { set(rows); draw(); };
  const folders = foldersOf(options), auto = autoOf(folders);
  const current = () => { const m = mode(); return m === 'auto' ? auto : m === 'all' ? null : m; };
  const civitai = (q = '') => openCivitai({ q, family: current() || auto || folders[0], folders, onWord, onDownloaded,
    onAdd: ({ name }) => {
      const rows = withLora(get(), name);
      if (!rows) return false;
      save(rows);
      onAdded?.();
    } });
  const draw = () => {
    const folder = current(), opts = folder ? options.filter((o) => o.startsWith(`${folder}/`)) : options;
    list.replaceChildren(...get().map((l, i) => {
      const put = (o) => { const a = [...get()]; a[i] = { ...a[i], ...o }; return a; };
      const sel = loraPicker({ options: opts, value: l.name || '', label: (o) => (folder && o.startsWith(`${folder}/`) ? o.slice(folder.length + 1) : o),
        empty: `— choose LoRA${folder ? ` (${opts.length} in ${folder}/)` : ''} —`, others: options.filter((o) => !opts.includes(o)),
        shown: !l.name ? null : !options.includes(l.name) ? `${l.name} (missing)` : !opts.includes(l.name) ? `${l.name} (other folder)` : null,
        onPick: (name) => save(put({ name })), onCivitai: civitai });
      const range = numSlider({ min: -2, max: 2, step: 0.05, value: l.strength ?? 1, digits: 2, label: 'Strength' });
      range.addEventListener('change', () => set(put({ strength: parseFloat(range.value) })));
      const on = h('input', { type: 'checkbox', checked: l.enabled !== false, title: 'Enabled', 'aria-label': 'LoRA on' });
      on.addEventListener('change', () => save(put({ enabled: on.checked })));
      return h('div', { class: `lora-row${l.enabled === false ? ' off' : ''}` },
        h('div', { class: 'top' }, on, sel,
          l.name ? iconBtn('LoRA info from Civitai', 'i', () => openLoraInfo(l.name, onWord), { class: 'icon-btn info-btn' }) : null,
          iconBtn('Remove LoRA', '✕', () => save(get().filter((_, j) => j !== i)))),
        h('div', { class: 'row lora-strength' }, h('span', { class: 'hint' }, 'Strength'), range));
    }));
  };
  draw();
  return field(['LoRA stack', h('span', {}, options.length ? `${options.length} available` : 'none found')],
    tip ? help(tip) : null,
    folders.length ? chips([['auto', auto ? `Auto · ${auto}` : 'Auto · all'], ['all', 'All'], ...folders.map((d) => [d, d])], mode(), (k) => { setMode(k); draw(); }, { cls: 'folder-chips' }) : null,
    list,
    h('div', { class: 'row wrap' },
      button('+ Add LoRA', () => save([...get(), { name: '', strength: 1, enabled: true }]), { cls: 'small add-btn' }),
      button('⤓ Civitai…', () => civitai(), { cls: 'small', title: 'Find and download LoRAs on Civitai' })));
}

// ---------------------------------------------------------------------------
// LoRA info from Civitai (looked up by the file's hash through rgthree-comfy)
// ---------------------------------------------------------------------------
async function openLoraInfo(name, onWord) {
  const seq = openSheet(h('h3', {}, name.split('/').pop()),
    placeholder('Looking it up on Civitai… The first lookup hashes the file, which can take a little while.'));
  let r;
  try { r = await api(`/api/lora-info?name=${encodeURIComponent(name)}`, { timeout: 240000 }); } catch (e) {
    if (sheetStillOpen(seq)) openSheet(h('h3', {}, name.split('/').pop()), note(e.message, 'err'));
    return;
  }
  if (!sheetStillOpen(seq)) return;  // closed, or something else opened, while it was looking
  const textOf = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  const words = r.trained_words.map((w) => chip(w, (e) => { onWord?.(w); e.target.classList.add('added'); }, { title: 'Add to prompt' }));
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
