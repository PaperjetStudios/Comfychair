// The table's Edit pane: what a frame can be turned into, for every kind, applied to all the selected frames.
// One section per kind in the selection ("Image · 3 frames"): quick icons, the op list (grouped), its options, where the
// result lands, and Run. Ops that need painting or a live engine are listed greyed with the reason and an "Open the frame"
// button. The rules are in edit-rules.js, the ops' fields and runners in edit-ops.js, the many-frame runner in edit-run.js
// (all loaded on demand: a missing one leaves a placeholder here).
//
//   showOp(kind, id, frames)   select an op in the pane (the frame menu's Edit ▸ items) and put the pane on show
//   runEdit()                  Run for the section last used (Ctrl+Enter and the action bar call it while the pane is on show)
//   editState()                { label, can, why } for the action bar: "Run <op>", whether it can, and why not (null)
//   editActive()               the pane is the one on show
// `make:state` is sent when editState may have changed (the action bar listens).
import { h, store, toast, button, iconBtn, seg, field, hint, help, note, section, runBar } from './ui.js';
import { S, setBatch } from './core.js';
import { stop } from './generate.js';
import { sidebar } from './sidebar.js';
import { icon } from './icons.js';
import * as Table from './table.js';

const KINDS = ['image', 'video', 'sound', 'scene'];
const WORD = { image: 'Image', video: 'Video', sound: 'Sound', scene: '3D' };
const P = { el: null, frames: [], mods: {}, loaded: false, loading: null, focus: null, status: new Map(), pending: new Map(), batchIns: new Set(), vfx: null, fresh: new Map() };

// ---------------------------------------------------------------------------
// the modules we lean on, loaded on demand (a failure leaves a note instead of a pane)
// ---------------------------------------------------------------------------
function load() {
  return P.loading ||= Promise.all(['edit-rules', 'edit-ops', 'edit-run'].map((n) =>
    import(`./${n}.js`).then((m) => { P.mods[n] = m; }, (e) => { P.mods[n] = null; (P.errs ||= []).push(`${n}: ${e.message}`); })))
    .then(() => { P.loaded = true; draw(); tellState(); });
}
const rules = () => P.mods['edit-rules'];

// the op as the rules give it, with the runner side (fields, run) from edit-ops.js where that has it
function opOf(kind, id) {
  const base = (P.ops.get(kind) || []).find((o) => o.id === id);
  if (!base) return null;
  const m = P.mods['edit-ops'];
  const extra = m?.opOf?.(id, kind) || m?.OPS?.[id] || (Array.isArray(m?.OPS) ? m.OPS.find((o) => o.id === id && (!o.kind || o.kind === kind)) : null) || m?.ops?.[id];
  return extra && extra !== base ? { ...base, ...extra } : base;
}

// can this op run on these frames now: { ok, why }
export function verdict(op, kind) {
  const live = !!sidebar.context().live && sidebar.context().live.kind === kind && P.frames.some((f) => f.id === sidebar.context().live.id);
  let r = true;
  try { r = rules()?.canRun ? rules().canRun(op, { live }) : true; } catch (e) { r = String(e.message || e); }
  if (r === false) return { ok: false, why: op.why || 'Open the frame to use this' };
  if (typeof r === 'string') return { ok: false, why: r };
  if (r && typeof r === 'object') {
    const bad = r.ok === false || r.can === false || (r.ok == null && r.can == null && !!r.why);
    return bad ? { ok: false, why: r.why || op.why || 'Open the frame to use this' } : { ok: true, why: null };
  }
  return { ok: true, why: null };
}

// ---------------------------------------------------------------------------
// remembered choices
// ---------------------------------------------------------------------------
const optsKey = (kind, id) => `deck.edit.${kind}.${id}`;
const optsFor = (kind, id) => (P.fresh.get(optsKey(kind, id)) || (P.fresh.set(optsKey(kind, id), store.get(optsKey(kind, id), {}) || {}), P.fresh.get(optsKey(kind, id))));
const saveOpts = (kind, id) => store.set(optsKey(kind, id), optsFor(kind, id));
const quickIds = (kind) => {
  let q = [];
  try { q = rules()?.quickOf ? rules().quickOf(kind) : []; } catch { q = []; }
  return (q || []).map((x) => (typeof x === 'string' ? { id: x } : Array.isArray(x) ? { label: x[0], icon: x[1], id: [].concat(x[2])[0] } : x)).filter((x) => x?.id);
};
function currentOp(kind) {
  const list = P.ops.get(kind) || [];
  const want = store.get(`deck.edit.op.${kind}`, null);
  return list.find((o) => o.id === want) || list.find((o) => verdict(o, kind).ok) || list[0] || null;
}
const targetOf = (kind, live) => store.get(`deck.edit.target.${kind}`, null) || (live ? 'layer' : 'new');

// ---------------------------------------------------------------------------
// the selection, grouped by kind
// ---------------------------------------------------------------------------
function selection() {
  let frames = [];
  try { frames = Table.selectedFrames() || sidebar.context().frames || []; } catch { frames = sidebar.context().frames || []; }
  return frames.filter((f) => f.kind !== 'note');
}
const ofKind = (kind) => P.frames.filter((f) => f.kind === kind);

function plan() {
  P.frames = selection();
  let map = new Map();
  try { map = rules()?.opsFor ? rules().opsFor(P.frames) : new Map(); } catch (e) { console.error(e); }
  P.ops = map instanceof Map ? map : new Map(Object.entries(map || {}));
}
P.ops = new Map();

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
export function draw() {
  const el = P.el;
  if (!el) return;
  P.batchIns.clear();
  if (!P.loaded) { el.replaceChildren(note('The Edit tools are loading.', 'warn')); load(); return; }
  if (!rules()) { el.replaceChildren(note(`The Edit tools aren't available yet (${(P.errs || []).join('; ')}).`, 'warn')); return; }
  plan();
  const kinds = KINDS.filter((k) => ofKind(k).length && (P.ops.get(k) || []).length);
  if (!kinds.length) { hideVfx(); el.replaceChildren(note(P.frames.length ? 'Nothing to edit on these frames yet.' : 'Select a frame to edit it.', 'info')); tellState(); return; }
  if (!kinds.includes(P.focus)) P.focus = kinds[0];
  if (!kinds.includes('video')) hideVfx();
  el.replaceChildren(...kinds.map(sectionFor));
  tellState();
}

function sectionFor(kind) {
  const frames = ofKind(kind), op = currentOp(kind), live = sidebar.context().live;
  const liveHere = !!live && live.kind === kind && frames.some((f) => f.id === live.id);
  const v = op ? verdict(op, kind) : { ok: false, why: 'Nothing to run' };
  const kids = [];
  // quick icons (the Image tools' pattern)
  const quick = quickIds(kind).map((q) => ({ ...q, op: (P.ops.get(kind) || []).find((o) => o.id === q.id) })).filter((q) => q.op);
  if (quick.length) kids.push(h('div', { class: 'tool-quick' }, ...quick.map((q) => {
    const here = q.id === op?.id;
    return h('button', { type: 'button', class: `icon-btn tool-quick-btn${here ? ' on' : ''}`, title: q.label || q.op.label, 'aria-pressed': String(here),
      onclick: () => pick(kind, q.id) }, icon(q.icon || q.op.icon || 'sparkle'), h('span', {}, q.label || q.op.label));
  })));
  // the op list: one optgroup per group, ops that need the frame open say so
  const list = P.ops.get(kind) || [], groups = [...new Set(list.map((o) => o.group || 'Other'))];
  kids.push(h('select', { 'aria-label': `${WORD[kind]} edit`, onchange: (e) => pick(kind, e.target.value) },
    ...groups.map((g) => h('optgroup', { label: g }, ...list.filter((o) => (o.group || 'Other') === g).map((o) => {
      const ok = verdict(o, kind).ok;
      return h('option', { value: o.id, selected: o.id === op?.id, class: ok ? '' : 'edit-grey', title: ok ? '' : verdict(o, kind).why }, o.label + (ok ? '' : ' (open the frame)'));
    })))));
  if (op) {
    const full = opOf(kind, op.id) || op;
    if (full.help) kids.push(help(full.help));
    if (!v.ok) {
      kids.push(hint(v.why || 'Open the frame to use this', 'edit-why'),
        button([icon('fit'), 'Open the frame'], () => { Table.goLive(frames[0]); sidebar.show('layers'); }, { cls: 'small' }));
    } else {
      const host = h('div', { class: 'edit-fields' });
      const opts = optsFor(kind, op.id);
      const ctx = { kind, frames, live: liveHere, opts, redraw: draw, save: () => saveOpts(kind, op.id), size: null };
      try { host.append(...[full.fields ? full.fields(opts, ctx) : []].flat(Infinity).filter(Boolean)); }
      catch (e) { console.error(e); host.append(note(`${op.label}: ${e.message}`, 'warn')); }
      if (host.childNodes.length) kids.push(host);
    }
    if (kind === 'image' || kind === 'video' || kind === 'sound') {
      const t = targetOf(kind, liveHere);
      kids.push(field('Result', seg([['new', 'New frame'], ['layer', kind === 'image' ? 'Layer in this frame' : 'In this frame']], t, (x) => {
        store.set(`deck.edit.target.${kind}`, x); tellState();
      }), help('New frame puts each result in a new frame beside the one it came from. In this frame adds it to that frame itself (a layer, a clip or a track); it works while the frame is open.')));
    }
    kids.push(runRow(kind, op, frames, v));
    kids.push(statusList(kind, frames));
    if (kind === 'video') kids.push(vfxRow(frames));
  }
  const sec = section(`${WORD[kind]} · ${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`, null, ...kids);
  sec.dataset.kind = kind;
  sec.addEventListener('pointerdown', () => { if (P.focus !== kind) { P.focus = kind; tellState(); } }, true);
  sec.addEventListener('focusin', () => { if (P.focus !== kind) { P.focus = kind; tellState(); } });
  return sec;
}

// Run, ×batch and Stop: as the Make panel's
function runRow(kind, op, frames, v) {
  const batchIn = h('input', { type: 'number', min: 1, max: 32, value: S.batch, inputMode: 'numeric', 'aria-label': 'How many', onchange: () => { batchIn.value = setBatch(batchIn.value); } });
  P.batchIns.add(batchIn);
  const n = frames.length;
  return runBar(
    button([icon('sparkle'), `Run on ${n} ${n === 1 ? 'frame' : 'frames'}`], () => { P.focus = kind; runEdit(); },
      { cls: 'primary edit-run', title: v.ok ? 'Run (Ctrl+Enter)' : v.why, disabled: !v.ok }),
    h('label', { class: 'make-batch' }, '×', batchIn),
    iconBtn('Stop this device\'s run', icon('close'), async () => { try { P.mods['edit-run']?.stopEdit?.(); } catch { /* */ } stop(); }));
}
addEventListener('deck:batch', () => { for (const b of P.batchIns) if (document.activeElement !== b) b.value = S.batch; });

// one line per frame that has a run going or failed
function statusList(kind, frames) {
  const rows = frames.map((f) => ({ f, s: P.status.get(f.id), n: P.pending.get(f.doc) || 0 })).filter((r) => r.s || r.n);
  const el = h('div', { class: 'edit-status', 'data-kind': kind });
  for (const { f, s, n } of rows) {
    const text = s?.state === 'failed' ? `failed: ${s.text || ''}` : n ? `${n} on the way` : s?.state || '';
    el.append(h('div', { class: `edit-status-row ${s?.state || ''}` }, h('span', {}, f.label || 'Frame'), h('span', { class: 'hint' }, text)));
  }
  return el;
}

// Video: "Full VFX panel…" hosts frame-vfx.js's panel, which draws points, boxes and mattes on the frame's own viewer
function vfxRow(frames) {
  const frame = frames[0];
  const host = h('div', { class: 'edit-vfx hidden' });
  const btn = button([icon('film'), 'Full VFX panel…'], () => toggleVfx(host, frame, btn), { cls: 'small' });
  btn.setAttribute('aria-expanded', String(!!P.vfx));
  const row = h('div', { class: 'edit-vfx-wrap' }, btn, host);
  if (P.vfx?.id === frame?.id) queueMicrotask(() => toggleVfx(host, frame, btn, true));
  return row;
}
async function toggleVfx(host, frame, btn, keep = false) {
  if (P.vfx && !keep) { hideVfx(); host.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); return; }
  try {
    const m = await import('./frame-vfx.js');
    P.vfx = { id: frame.id };
    host.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true');
    P.vfxMod = m;
    await m.showFrameVfx(host, frame);
  } catch (e) { P.vfx = null; host.replaceChildren(note(`The VFX panel isn't available yet (${e.message}).`, 'warn')); host.classList.remove('hidden'); }
}
function hideVfx() {
  if (!P.vfx) return;
  P.vfx = null;
  try { P.vfxMod?.hideFrameVfx(); } catch { /* */ }
}

function pick(kind, id) {
  store.set(`deck.edit.op.${kind}`, id);
  P.focus = kind;
  draw();
}

// ---------------------------------------------------------------------------
// exports the rest of the app calls
// ---------------------------------------------------------------------------
export function showOp(kind, id, frames) {
  if (id) store.set(`deck.edit.op.${kind}`, id);
  if (kind) P.focus = kind;
  if (frames) P.frames = frames.filter((f) => f.kind !== 'note');
  sidebar.show('edit');
  if (P.loaded) draw(); else load();
}

export const editActive = () => sidebar.current() === 'edit';

export function editState() {
  if (!P.loaded) return { label: 'Edit', can: false, why: 'The Edit tools are loading' };
  if (!rules()) return { label: 'Edit', can: false, why: 'The Edit tools are not available yet' };
  plan();
  const kind = (P.focus && ofKind(P.focus).length && P.ops.get(P.focus)?.length ? P.focus : KINDS.find((k) => ofKind(k).length && (P.ops.get(k) || []).length)) || null;
  if (!kind) return { label: 'Edit', can: false, why: P.frames.length ? 'Nothing to edit on these frames' : 'Select a frame to edit' };
  const op = currentOp(kind), v = verdict(op, kind);
  const run = P.mods['edit-run'];
  return { label: `Run ${op.label}`, can: v.ok && !!run?.runOnFrames, why: v.ok ? (run?.runOnFrames ? null : 'The Edit runner is not available yet') : v.why };
}

let running = false;
export async function runEdit() {
  if (running) return;
  if (!P.loaded) await load();
  const st = editState();
  if (!st.can) return toast(st.why || 'Nothing to run', true);
  const kind = P.focus, frames = ofKind(kind), op = opOf(kind, currentOp(kind).id);
  const opts = optsFor(kind, op.id), live = sidebar.context().live;
  const target = targetOf(kind, !!live && live.kind === kind && frames.some((f) => f.id === live.id));
  running = true;
  try {
    saveOpts(kind, op.id);
    await P.mods['edit-run'].runOnFrames(op, frames, opts, { batch: S.batch, target });
  } catch (e) { toast(e.message, true); }
  finally { running = false; draw(); }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let stateDue = false;
function tellState() {
  if (stateDue) return;
  stateDue = true;
  queueMicrotask(() => { stateDue = false; dispatchEvent(new CustomEvent('make:state')); });
}
function redrawLater() { if (editActive()) { clearTimeout(redrawLater.t); redrawLater.t = setTimeout(draw, 0); } else tellState(); }

// runs report here (edit-run.js): edit:queued { frame, state?, text? }, edit:pending { doc, n }
addEventListener('edit:queued', (e) => {
  const d = e.detail || {}, f = d.frame || (d.frames || [])[0];
  if (f?.id) P.status.set(f.id, { state: d.state || 'queued', text: d.text || '' });
  for (const g of d.frames || []) if (g?.id && g !== f) P.status.set(g.id, { state: d.state || 'queued', text: d.text || '' });
  redrawLater();
});
addEventListener('edit:state', (e) => {
  const d = e.detail || {};
  if (d.frame?.id) { if (d.state) P.status.set(d.frame.id, { state: d.state, text: d.text || '' }); else P.status.delete(d.frame.id); }
  redrawLater();
});
addEventListener('edit:pending', (e) => {
  const { doc, n } = e.detail || {};
  if (doc != null) { if (n) P.pending.set(doc, n); else P.pending.delete(doc); }
  redrawLater();
});
for (const ev of ['table:select', 'table:live', 'table:unlive']) addEventListener(ev, () => { setTimeout(() => { if (editActive()) draw(); else tellState(); }, 0); });
sidebar.onShow((name) => { if (name === 'edit') draw(); else hideVfx(); tellState(); });

P.el = sidebar.pane('edit', { title: 'Edit', icon: 'brush', when: (c) => c.frames.some((f) => f.kind !== 'note') });
load();
