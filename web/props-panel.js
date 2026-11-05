// The sidebar's Properties pane: the standard numbers of whatever is picked, in one place. Frames on the table (place,
// size, opacity, resolution, name, lock, hide), or inside a live frame the picked layers, clips or sound items (their
// transform, opacity, times and level). web/props-rules.js says which rows a selection gets; the engines build them.
//
//   registerProps(kind, { picked(ctx) → [what is picked, the primary first], rows(ctx, ids) → rows, title?(ctx), when?(ctx), extra?(ctx) → element })
//     extra: a live frame's own section under the rows, whatever is picked (an image frame's Canvas).
//     kind: 'frames' (the table's frames) or a live frame's kind ('image', 'video', 'sound'). ctx: sidebar.context().
//     A row: { id, label, el, group? } (the engine's own field, edits going through its own code), or
//     { id, label, get, set, min?, max?, step?, digits?, unit?, type?: 'num' | 'text' | 'toggle', disabled?, group? }:
//     get() may answer MIXED (props-rules.js) and the box shows "mixed"; set(v) is the edit, sent to all of them.
//   propsChanged(kind)  an engine's selection or values changed: the pane draws again soon (not while one of its boxes
//     is being typed in: once that box lets go)
//   propsRoot()         the pane's element (for keyed.js refreshKeyed while the playhead moves)
//   numRow(row), textRow(row)  a row's field, for an engine composing its own
//
// It draws again on table:select, table:live / table:unlive (at once, even mid-typing: the box would edit what is no
// longer picked) and table:frame-field.
import { h, field, section, hint, numSlider, toggle } from './ui.js';
import { sidebar } from './sidebar.js';
import { MIXED, rowsFor } from './props-rules.js';

const P = { prov: new Map(), el: null, timer: 0, dirty: false, sig: '' };
const WAIT_MS = 40;

export function registerProps(kind, prov) {
  P.prov.set(kind, prov);
  propsChanged(kind);
}
export const propsRoot = () => P.el;
export { MIXED };

const typing = () => {
  const a = document.activeElement;
  return !!(P.el && a && P.el.contains(a) && a.matches('input:not([type=checkbox]), textarea, select'));
};

export function propsChanged() {
  clearTimeout(P.timer);
  P.timer = setTimeout(() => draw(false), WAIT_MS);
}

// a number box: a slider when it has a range, else a plain number (a typed value; dragged sideways like the others)
export function numRow({ label, get, set, min = null, max = null, step = 1, digits = null, unit = '', disabled = false }) {
  const v = get(), mixed = v === MIXED;
  const ranged = Number.isFinite(min) && Number.isFinite(max);
  const inp = ranged ? numSlider({ min, max, step, digits, value: mixed ? min : v, label })
    : h('input', { type: 'number', inputMode: 'decimal', step, value: mixed ? '' : (digits != null ? Number(v).toFixed(digits) : v), 'aria-label': label });
  if (mixed) { inp.value = ''; inp.placeholder = 'mixed'; }
  inp.disabled = !!disabled;
  inp.addEventListener('change', () => {
    const n = parseFloat(inp.value);
    if (!Number.isFinite(n)) return;
    set(ranged ? Math.min(max, Math.max(min, n)) : n);
  });
  return field(unit ? [label, h('span', { class: 'props-unit' }, unit)] : label, inp);
}
export function textRow({ label, get, set, disabled = false }) {
  const v = get(), mixed = v === MIXED;
  const inp = h('input', { type: 'text', value: mixed ? '' : (v ?? ''), placeholder: mixed ? 'mixed' : '', maxLength: 120, 'aria-label': label, disabled: !!disabled });
  inp.addEventListener('change', () => set(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  return field(label, inp);
}
const toggleRow = ({ label, get, set, disabled = false }) => {
  const v = get(), el = toggle(label, v === true, (on) => set(on));
  if (v === MIXED) el.input.indeterminate = true;
  el.input.disabled = !!disabled;
  return el;
};
const rowEl = (r) => r.el || (r.type === 'text' ? textRow(r) : r.type === 'toggle' ? toggleRow(r) : numRow(r));

// the provider for this selection: the live frame's engine when something is picked in it, else the table's frames
function choose(ctx) {
  const live = ctx.live, eng = live && P.prov.get(live.kind);
  if (eng) {
    let picked = [];
    try { picked = (eng.when ? eng.when(ctx) : true) ? eng.picked(ctx) || [] : []; } catch (e) { console.error(e); }
    if (picked.length) return { kind: live.kind, prov: eng, picked };
  }
  const fr = P.prov.get('frames');
  if (!fr) return null;
  let picked = [];
  try { picked = fr.picked(ctx) || []; } catch (e) { console.error(e); }
  return picked.length ? { kind: 'frames', prov: fr, picked } : null;
}

function draw(force) {
  if (!P.el) return;
  if (sidebar.current() !== 'props') { P.dirty = true; return; }
  if (!force && typing()) { P.dirty = true; return; }
  P.dirty = false;
  const ctx = sidebar.context(), got = choose(ctx);
  let extra = null;
  try { extra = ctx.live ? P.prov.get(ctx.live.kind)?.extra?.(ctx) || null : null; } catch (e) { console.error(e); }
  if (!got) {
    P.el.replaceChildren(section('Properties', null, hint(ctx.live ? 'Pick a layer, clip or sound to see its properties.' : 'Select a frame.')), ...(extra ? [extra] : []));
    return;
  }
  const ids = rowsFor({ kind: got.kind, live: got.kind !== 'frames', picked: got.picked });
  let rows = [];
  try { rows = got.prov.rows(ctx, ids) || []; } catch (e) { console.error(e); }
  const order = new Map(ids.map((id, i) => [id, i]));
  rows = rows.filter((r) => r && order.has(r.id) && !('el' in r && !r.el)).sort((a, b) => order.get(a.id) - order.get(b.id));
  const title = got.prov.title?.(ctx, got.picked) || 'Properties';
  // rows in their groups, each group a section (the pane's jump strip, layout.js sideNav, lists them)
  const groups = [];
  for (const r of rows) {
    const g = r.group || title;
    let at = groups.find((x) => x.name === g);
    if (!at) groups.push(at = { name: g, els: [] });
    try { at.els.push(rowEl(r)); } catch (e) { console.error(`Properties row ${r.id}`, e); }
  }
  const top = P.el.scrollTop;
  // (what is shown, named over the first group)
  P.el.replaceChildren(...(groups.length ? groups.map((g, i) => section(g.name, null, i === 0 && g.name !== title ? hint(title, 'props-title') : null, g.els))
    : [section(title, null, hint('Nothing to set here.'))]), ...(extra ? [extra] : []));
  P.el.scrollTop = top;
  sidebar.refresh();
}

function mount() {
  P.el = sidebar.pane('props', { title: 'Properties', icon: 'settings', when: (c) => c.frames.length > 0 || !!c.live });
  P.el.classList.add('props-pane');
  P.el.addEventListener('focusout', () => { if (P.dirty) setTimeout(() => { if (P.dirty && !typing()) draw(false); }, 0); });
  sidebar.onShow((name) => { if (name === 'props') draw(true); });
}
mount();

const now = () => { clearTimeout(P.timer); P.timer = setTimeout(() => draw(true), 0); };
for (const ev of ['table:select', 'table:live', 'table:unlive']) addEventListener(ev, now);
addEventListener('table:frame-field', () => propsChanged('frames'));
