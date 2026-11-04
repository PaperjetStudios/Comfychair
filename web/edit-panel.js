// The table's Edit pane: what a frame can be turned into, for every kind, applied to all the selected frames.
// One section per kind in the selection ("Image · 3 frames"): quick icons, the op list (grouped), its options, where the
// result lands, and Run. Ops that need painting or a live engine are listed greyed with the reason and an "Open the frame"
// button. The rules are in edit-rules.js, the ops' fields and runners in edit-ops.js, the many-frame runner in edit-run.js
// (loaded on demand: a missing one leaves a note here). A video op with marks to place (points, boxes, paths, a colour:
// op.tools) puts them over the open frame's picture (frame-overlay.js) while the pane is on show; they are kept on the
// frame (frame.ops[op]). Clip tools → VFX on an open video frame opens this pane on it. On the open image frame, with
// the result as a layer, Run on picks the whole picture or the selected layers (imagetools.js toolState().scope). A
// selected note gets a Make from this note button: its words are the Make pane's prompt (make-panel.js). What the
// selection can make of a kind none of it is (edit-rules.js crossOps: pictures and sounds into a video) is a section of
// its own ("Make video · from 2 frames"), its result always a new frame.
//
//   showOp(kind, id, frames)   select an op in the pane (the frame menu's Edit ▸ items) and put the pane on show
//   runEdit()                  Run for the section last used (Ctrl+Enter and the action bar call it while the pane is on show)
//   editState()                { label, can, why } for the action bar: "Run <op>", whether it can, and why not (null)
//   editActive()               the pane is the one on show
// `make:state` is sent when editState may have changed (the action bar listens).
import { h, store, toast, button, iconBtn, seg, field, hint, help, note, section, runBar } from './ui.js';
import { S, setBatch } from './core.js';
import { sidebar } from './sidebar.js';
import { icon } from './icons.js';
import * as Table from './table.js';
import { setupsRow } from './setups.js';
import { editKey } from './setups-rules.js';
import { toolState } from './imagetools.js';

const KINDS = ['image', 'video', 'sound', 'scene'];
const WORD = { image: 'Image', video: 'Video', sound: 'Sound', scene: '3D' };
const P = { el: null, frames: [], mods: {}, loaded: false, loading: null, focus: null, status: new Map(), pending: new Map(), into: new Map(), batchIns: new Set(), opts: new Map(), ov: null };

// ---------------------------------------------------------------------------
// the modules we lean on, loaded on demand (a failure leaves a note instead of a pane)
// ---------------------------------------------------------------------------
function load() {
  return P.loading ||= Promise.all(['edit-rules', 'edit-ops', 'edit-run'].map((n) =>
    import(`./${n}.js`).then((m) => { P.mods[n] = m; }, (e) => { P.mods[n] = null; (P.errs ||= []).push(`${n}: ${e.message}`); })))
    .then(() => { P.loaded = true; draw(); tellState(); });
}
const rules = () => P.mods['edit-rules'];
const ops = () => P.mods['edit-ops'];
const runner = () => P.mods['edit-run'];

// ---------------------------------------------------------------------------
// remembered choices: the op per kind, its options (edit-ops.js keeps them), the result's target per kind
// ---------------------------------------------------------------------------
// one options object per op while the pane is up (the fields change it in place; edit-ops.js saveOpts keeps it)
function optsFor(kind, id) {
  const k = `${kind}:${id}`;
  if (kind === 'image' || !P.opts.has(k)) P.opts.set(k, ops()?.optsOf(kind, id) || {});
  return P.opts.get(k);
}
const liveIn = (kind, frames) => { const l = sidebar.context().live; return !!l && l.kind === kind && frames.some((f) => f.id === l.id); };
// why op can't run on this kind's selected frames now ('' when it can)
export function whyNot(op, kind) {
  if (!op) return 'Nothing to run';
  return rules().whyNot(op, { live: liveIn(kind, ofKind(kind)), opts: { ...optsFor(kind, op.id), ...ops().frameOps(ofKind(kind)[0], op.id) } }) || '';
}
function currentOp(kind) {
  const list = P.ops.get(kind) || [];
  const want = store.get(`deck.edit.op.${kind}`, null);
  return list.find((o) => o.id === want) || list.find((o) => !whyNot(o, kind)) || list[0] || null;
}
function targetOf(op, kind) {
  if (isCross(kind)) return 'frame';   // (a cross-kind op's result is always a new frame)
  const can = rules().targetsOf(op), kept = store.get(`deck.edit.target.${kind}`, null);
  return can.includes(kept) ? kept : rules().defaultTarget(op, liveIn(kind, ofKind(kind)));
}

// ---------------------------------------------------------------------------
// the selection, grouped by kind
// ---------------------------------------------------------------------------
function selection() {
  let frames = [];
  try { frames = Table.selectedFrames() || []; } catch { frames = sidebar.context().frames || []; }
  return frames.filter((f) => f.kind !== 'note');
}
// a kind's frames: those of it, or for a cross kind (no frame of it selected, "Make video") the frames its ops take
const ofKind = (kind) => {
  const cross = P.cross.get(kind);
  if (!cross) return P.frames.filter((f) => f.kind === kind);
  const takes = new Set(cross.flatMap((o) => o.takes || []));
  return P.frames.filter((f) => takes.has(f.kind));
};
const isCross = (kind) => P.cross.has(kind);

// the ops per kind of the selection, then what it can make of a kind none of it is (edit-rules.js crossOps)
function plan() {
  P.frames = selection();
  P.ops = rules().opsFor(P.frames);
  P.cross = new Map();
  for (const o of rules().crossOps?.(P.frames) || []) if (!P.ops.has(o.kind)) P.cross.set(o.kind, [...(P.cross.get(o.kind) || []), o]);
  for (const [kind, list] of P.cross) P.ops.set(kind, list);
}
P.ops = new Map();
P.cross = new Map();

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
export function draw() {
  const el = P.el;
  if (!el) return;
  P.batchIns.clear();
  if (!P.loaded) { el.replaceChildren(note('The Edit tools are loading.', 'warn')); load(); return; }
  if (!rules() || !ops() || !runner()) { el.replaceChildren(note(`The Edit tools aren't available (${(P.errs || []).join('; ')}).`, 'warn')); return; }
  plan();
  const kinds = KINDS.filter((k) => ofKind(k).length && (P.ops.get(k) || []).length).sort((a, b) => isCross(a) - isCross(b));   // (Make video last)
  const notes = notesSection();
  if (!kinds.length) { syncOverlay(null, null, []); el.replaceChildren(notes || note(P.frames.length ? 'Nothing to edit on these frames yet.' : 'Select a frame to edit it.', 'info')); tellState(); return; }
  if (!kinds.includes(P.focus)) P.focus = kinds[0];
  el.replaceChildren(...kinds.map(sectionFor), notes || '');
  if (!kinds.includes('video') || isCross('video')) syncOverlay(null, null, []);
  tellState();
}

function sectionFor(kind) {
  const frames = ofKind(kind), op = currentOp(kind), cross = isCross(kind);
  const why = whyNot(op, kind);
  const kids = [];
  // quick icons (the Image tools' pattern): each opens the first of its ops that can run here
  const have = new Set((P.ops.get(kind) || []).map((o) => o.id));
  const quick = cross ? [] : rules().quickOf(kind).filter((q) => q.ids.some((id) => have.has(id)));
  if (quick.length) kids.push(h('div', { class: 'tool-quick' }, ...quick.map((q) => {
    const here = q.ids.includes(op?.id);
    return h('button', { type: 'button', class: `icon-btn tool-quick-btn${here ? ' on' : ''}`, title: q.label, 'aria-pressed': String(here),
      onclick: () => pick(kind, q.ids.find((id) => !whyNot(rules().opById(kind, id), kind)) || q.ids[0]) }, icon(q.icon || 'sparkle'), h('span', {}, q.label));
  })));
  // the op list: one optgroup per group, ops that need the frame open say so
  kids.push(h('select', { 'aria-label': `${WORD[kind]} edit`, class: 'edit-op', onchange: (e) => pick(kind, e.target.value) },
    ...rules().groupsOf(kind).map(({ group, ops: list }) => ({ group, ops: list.filter((o) => have.has(o.id)) })).filter((g) => g.ops.length)
      .map(({ group, ops: list }) => h('optgroup', { label: group }, ...list.map((o) => {
      const w = whyNot(o, kind);
      return h('option', { value: o.id, selected: o.id === op?.id, class: w ? 'edit-grey' : '', title: w || '' }, o.label + (w ? ' (open the frame)' : ''));
    })))));
  if (op) {
    if (op.help) kids.push(help(op.help));
    kids.push(setupsRow({ key: editKey(kind, op.id), get: () => ops().opValues(kind, op.id, optsFor(kind, op.id), frames),
      set: (v) => { ops().setOpValues(kind, op.id, optsFor(kind, op.id), v, frames); draw(); } }));
    if (why) {
      kids.push(hint(why, 'edit-why'),
        button([icon('fit'), 'Open the frame'], () => {
          if (kind === 'image') optsFor(kind, op.id).op = op.id;   // (the Layers pane's tool: the Image tools' settings are shared)
          Table.goLive(frames[0]); if (kind === 'image') sidebar.show('layers');
        }, { cls: 'small edit-open' }));
    }
    // the options (shown greyed or not: an option can be what makes it need the open frame)
    const host = h('div', { class: 'edit-fields' });
    const live = liveIn(kind, frames.slice(0, 1)), ov = P.ov?.overlay.state();
    try {
      host.append(...ops().opFields(kind, op.id, optsFor(kind, op.id), { redraw: draw, frames, size: null, live,
        tool: live && ov?.frame?.id === frames[0]?.id ? ov.tool : null, neg: !!ov?.neg,
        setTool: (t) => { P.ov?.overlay.tool(t); draw(); }, setNeg: (on) => { P.ov?.overlay.neg(on); draw(); } }).filter(Boolean));
    } 
    catch (e) { console.error(e); host.append(note(`${op.label}: ${e.message}`, 'warn')); }
    if (host.childNodes.length) kids.push(host);
    const targets = rules().targetsOf(op);
    if (!why && !cross && !op.selfLands && targets.length > 1) {
      kids.push(field('Result', seg([['frame', 'New frame'], ['layer', kind === 'image' ? 'Layer in this frame' : 'In this frame']], targetOf(op, kind), (x) => {
        store.set(`deck.edit.target.${kind}`, x); draw();
      }), help('New frame puts each result in a new frame beside the one it came from. In this frame adds it to that frame itself: a layer, a clip or a track.')));
    }
    if (!why && kind === 'image' && liveIn(kind, frames.slice(0, 1)) && targetOf(op, kind) === 'layer') {
      const ST = toolState();
      kids.push(field('Run on', seg([['whole', 'Whole picture'], ['selected', 'Selected layers']], ST.scope === 'selected' ? 'selected' : 'whole', (v) => {
        ST.scope = v; store.set('deck.imagetools', ST); draw();
      }), help('Whole picture: the open picture as it looks. Selected layers: each selected layer on its own, its result a layer over it.')));
    }
    kids.push(runRow(kind, op, frames, why));
    kids.push(statusList(kind, frames));
  }
  if (kind === 'video' && !cross) syncOverlay(kind, op, frames);
  const sec = section(cross ? `Make ${WORD[kind].toLowerCase()} · from ${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`
    : `${WORD[kind]} · ${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`, null, ...kids);
  if (cross) sec.classList.add('edit-cross');
  sec.dataset.kind = kind;
  sec.addEventListener('pointerdown', () => { if (P.focus !== kind) { P.focus = kind; tellState(); } }, true);
  sec.addEventListener('focusin', () => { if (P.focus !== kind) { P.focus = kind; tellState(); } });
  return sec;
}

// the selected notes: their words drive Make (make-panel.js takes a selected note's text as the prompt)
function notesSection() {
  let sel = [];
  try { sel = Table.selectedFrames() || []; } catch { sel = sidebar.context().frames || []; }
  const notes = sel.filter((f) => f.kind === 'note');
  if (!notes.length) return null;
  const words = notes.find((f) => String(f.text || '').trim());
  return section(`Note · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`, null,
    words ? hint(`"${String(words.text).trim().slice(0, 120)}"`, 'edit-note-text') : hint('This note has no words yet', 'edit-why'),
    button([icon('sparkle'), 'Make from this note'], () => sidebar.show('make'), { cls: 'primary edit-note-make', disabled: !words,
      title: 'Its words are the prompt in the Make pane' }));
}

// Run, ×batch and Stop: as the Make panel's
function runRow(kind, op, frames, why) {
  const batchIn = h('input', { type: 'number', min: 1, max: 32, value: S.batch, inputMode: 'numeric', 'aria-label': 'How many', disabled: !!op.once,
    onchange: () => { batchIn.value = setBatch(batchIn.value); } });
  P.batchIns.add(batchIn);
  const n = frames.length;
  return runBar(
    button([icon('sparkle'), `Run on ${n} ${n === 1 ? 'frame' : 'frames'}`], () => { P.focus = kind; runEdit(); },
      { cls: 'primary edit-run', title: why || 'Run (Ctrl+Enter)', disabled: !!why }),
    h('label', { class: 'make-batch' }, '×', batchIn),
    iconBtn('Stop this device\'s run', icon('close'), () => runner().stopEdits()));
}
addEventListener('deck:batch', () => { for (const b of P.batchIns) if (document.activeElement !== b) b.value = S.batch; });

// one line per frame that has a run going, failed, or results on their way (to it, or to the frame made beside it)
function statusList(kind, frames) {
  const el = h('div', { class: 'edit-status', 'data-kind': kind });
  for (const f of frames) {
    const s = P.status.get(f.id), n = (P.pending.get(f.doc) || 0) + [...(P.into.get(f.id) || [])].reduce((a, d) => a + (P.pending.get(d) || 0), 0);
    if (!s && !n) continue;
    const text = s?.state === 'failed' ? `failed: ${s.why || ''}` : n ? `${n} on the way` : s?.state || '';
    el.append(h('div', { class: `edit-status-row ${s?.state || ''}` }, h('span', {}, f.label || 'Frame'), h('span', { class: 'hint' }, text)));
  }
  return el;
}

// The marks of the video op on show over the open frame (frame-overlay.js): only for one selected frame that is open, with
// the Edit pane on show. Each change is kept on the frame (frame.ops[op]) and the pane redrawn (its counts).
const MARKS = ['points', 'pointsAt', 'boxes', 'tracks', 'key'];
function syncOverlay(kind, op, frames) {
  const frame = frames.length === 1 ? frames[0] : null;
  const on = !!(op && kind === 'video' && frame && liveIn('video', [frame]) && editActive());
  if (!on && !P.ov) return;
  (P.ovLoad ||= import('./frame-overlay.js').then((m) => { P.ov = m; return m; })).then((m) => {
    if (!on) { m.overlay.hide(); return; }
    ops().cachedClip(frame, draw);   // (points keep the clip's time at the playhead)
    m.overlay.show(frame, { tools: op?.tools || [], value: ops().frameOps(frame, op.id),
      time: () => ops().liveClipTime(frame),
      onChange: (v) => { ops().setFrameOps([frame], op.id, Object.fromEntries(MARKS.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))); redrawLater(); } });
  }).catch((e) => console.warn('frame overlay', e));
}
addEventListener('overlay:tool', () => redrawLater());

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
  const ids = (frames || []).map((f) => f.id), sel = (Table.selectedFrames() || []).map((f) => f.id);
  if (ids.length && (ids.length !== sel.length || ids.some((x) => !sel.includes(x)))) Table.selectFrames(ids);
  sidebar.show('edit');
  if (P.loaded) draw(); else load();
}

export const editActive = () => sidebar.current() === 'edit';

function focusKind() {
  const ok = (k) => k && ofKind(k).length && (P.ops.get(k) || []).length;
  return ok(P.focus) ? P.focus : KINDS.find(ok) || null;
}
export function editState() {
  if (!P.loaded) return { label: 'Edit', can: false, why: 'The Edit tools are loading' };
  if (!rules() || !ops() || !runner()) return { label: 'Edit', can: false, why: 'The Edit tools are not available' };
  plan();
  const kind = focusKind();
  if (!kind) return { label: 'Edit', can: false, why: P.frames.length ? 'Nothing to edit on these frames' : 'Select a frame to edit' };
  const op = currentOp(kind), why = whyNot(op, kind) || (runner().editRunning() ? 'An edit is still being sent' : '');
  return { label: `Run ${op.label}`, can: !why, why: why || null };
}

export async function runEdit() {
  if (!P.loaded) await load();
  const st = editState();
  if (!st.can) return toast(st.why || 'Nothing to run', true);
  const kind = focusKind(), frames = ofKind(kind), op = currentOp(kind);
  const opts = optsFor(kind, op.id);
  ops().saveOpts(kind, op.id, opts);
  try {
    await runner().runOnFrames(op, frames, opts, { batch: S.batch, target: targetOf(op, kind), selection: P.frames });
  } catch (e) { toast(e.message, true); }
  finally { draw(); }
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

// runs report here (edit-run.js): edit:state { frame, state, why }, edit:queued { frame, into }, edit:pending { doc, n }
addEventListener('edit:state', (e) => {
  const d = e.detail || {};
  if (d.frame?.id) { if (d.state) P.status.set(d.frame.id, { state: d.state, why: d.why || '' }); else P.status.delete(d.frame.id); }
  redrawLater();
});
addEventListener('edit:queued', (e) => {
  const { frame, into } = e.detail || {};
  if (frame?.id && into?.doc && into.doc !== frame.doc) P.into.set(frame.id, new Set([...(P.into.get(frame.id) || []), into.doc]));
  redrawLater();
});
addEventListener('edit:pending', (e) => {
  const { doc, n } = e.detail || {};
  if (doc != null) { if (n) P.pending.set(doc, n); else P.pending.delete(doc); }
  redrawLater();
});
// Clip tools → VFX on an open video frame: this pane on show on it (its effects run on the frame's first clip)
import('./vfx.js').then(({ onSendToVfx }) => onSendToVfx(async () => {
  const l = sidebar.context().live;
  if (l?.kind !== 'video') return false;
  P.focus = 'video';
  showOp('video', null, [l]);
  toast('Pick an effect: it runs on this frame\'s clip');
  return true;
})).catch(() => {});
for (const ev of ['table:select', 'table:live', 'table:unlive']) addEventListener(ev, () => { setTimeout(() => { if (editActive()) draw(); else tellState(); }, 0); });
sidebar.onShow((name) => { if (name === 'edit') draw(); else syncOverlay(null, null, []); tellState(); });

P.el = sidebar.pane('edit', { title: 'Edit', icon: 'brush', when: (c) => c.frames.length > 0 });
load();
