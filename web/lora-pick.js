// A LoRA picked from a list you can search, in place of a dropdown too long to scroll: a button showing the choice, and a menu with a search box.
// loraPicker({ options, value, label(o), empty, others, otherLabel(o), onPick(o), onCivitai(words), aria }):
//   options: what can be picked; empty: the text of the "nothing" row (none: there is no such row); others: more names, shown only when searching (another
//   model's folder, say); onCivitai: a last row that takes the words to Civitai's search. Arrow keys move, Enter picks, Esc closes.
import { closePopover, h, popover } from './ui.js';
import { matchNames } from './lora-match.js';
import { icon } from './icons.js';

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
