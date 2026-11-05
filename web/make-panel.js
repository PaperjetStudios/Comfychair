// The table's Make panel: a template's fields for what is selected on the table, and Run. It draws the Generate tab's
// own field controls (generate.js renderFields with its own state: fieldTarget { state }), so seed modes, LoRAs, saved
// setups and the prompt builder work the same, but its settings are its own: each frame keeps them (frame.make, saved
// with the table), and nothing selected keeps one set for this device. The Generate tab's template and values are never
// touched (make-rules.js settingsFor / settingsPayload).
//
//   nothing (or a note): text-to-image and text-to-video; each result is a new frame beside the last
//   an image frame:      image templates; the frame's picture goes into the template's first picture, its size is the
//                        output size, and results land as layers in it (live or not: imagetools.js landMade, owed runs)
//   a video frame:       video templates; Pick a frame puts an image frame's picture in a slot; results land as clips.
//                        (VFX effects are the Edit pane's video ops: edit-ops.js lands their results)
//   a 3D frame:          its templates; results go into the scene (frame-scene.js landInScene), else the Shelf
//   a sound frame:       sound templates; the sounds made go into its mix (frame-sound.js, as a drop)
// Templates an Edit op runs on that kind (an upscale, a clean-up) are the Edit pane's, not offered here (make-rules.js).
// Several frames of a kind selected: Run on N frames, one run each with the shown settings, each landing in its own
// frame. A selected note with words: they are the prompt.
//
//   renderMake(host, frames)   draw the panel into host for the selection (the sidebar calls it; table:select redraws it)
//   runMake()                  Run (the Generate button and Ctrl+Enter call it while the table is on screen)
//   makeState()                { label, why } for the action bar's button: what Run makes for the selection, and why
//                              it can't (null when it can); `make:state` says when it may have changed
import { h, api, store, toast, button, iconBtn, seg, field, hint, help, info, note, runBar, clone } from './ui.js';
import { S, CURRENT_EDIT, setBatch } from './core.js';
import { afterQueued, fieldState, fieldTarget, fieldsBorrowed, mainPromptKey, preparePictures, renderFields, runBuilder, runValues, stop } from './generate.js';
import { setupsRow } from './setups.js';
import { tplKey } from './setups-rules.js';
import { refused } from './tabs.js';
import { queueRun, waitGen } from './make.js';
import { openSourcePicker } from './source-picker.js';
import { landMade, owedTo } from './imagetools.js';
import { isLive } from './live.js';
import { currentTab, onNavigate } from './navigation.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND, nextBeside, toStage } from './table-model.js';
import * as Table from './table.js';
import { LANDS, canvasRect, carryWords, familiesOf, frameImageField, frameSize, makeFrames, makeTarget, noteText, pickTemplate, repointable, selfPicked, settingsFor,
  settingsPayload, sizePair, templatesFor, wireFields, withClip } from './make-rules.js';
import { fieldKind, isFrameWire, wireLabel } from './wire-rules.js';
import { icon } from './icons.js';
import { frameAudio, frameImage, frameSource, frameStill, frameVideo } from './frame-source.js';

const HELD = new Set();   // wire pictures a queued run has yet to read: settleInputs leaves them be
const P = { fresh: [], host: null, frames: [], table: null, key: null, st: null, els: null, prog: null, batchIn: null };
const KIND_WORD = { none: 'a new frame', image: 'this picture', video: 'this video', scene: 'this 3D frame', sound: 'this sound frame' };
const SHOT_KINDS = new Set(['image', 'video', 'boxes', 'seed', 'mask']);   // a run's own content, not a setting (gentabs.js)
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;
const lastTpl = (kind) => store.get(`deck.make.tpl.${kind}`, null);
const onTable = () => currentTab() === 'table';

// the selection: from the event, else what the table says now
const selection = () => Table.selectedFrames() || P.frames;
const tableNow = () => {
  const frames = Table.tableFrames() || P.table?.frames;
  return frames ? { frames, view: P.table?.view } : null;
};
// a frame changed (its settings): the table saves it as it is
const frameSaved = () => Table.frameChanged();
const keyOf = (kind, frame) => `${kind}:${frame?.id || ''}`;

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
export function renderMake(host = P.host, frames = P.frames) {
  if (host) P.host = host;
  P.frames = frames || [];
  draw();
}

function draw() {
  try { drawPanel(); } finally { tellState(); }
}
function drawPanel() {
  const host = P.host;
  if (!host) return;
  if (!S.templates?.length) { host.replaceChildren(note('The templates are still loading.', 'warn')); P.key = null; return; }
  const { kind, frame } = makeTarget(P.frames);
  const list = templatesFor(S.templates, kind);
  if (!list.length) { host.replaceChildren(note(`No template here makes anything for ${KIND_WORD[kind]}.`, 'warn')); P.key = null; return; }
  if (!onTable()) return;   // (the fields are drawn once the table is on screen: the Generate tab keeps its own meanwhile)
  const key = keyOf(kind, frame);
  if (P.key !== key || !host.contains(P.els?.fields) || !list.some((t) => t.id === P.st?.tpl?.id) || fieldState() !== P.st) {
    if (P.key !== key || !host.contains(P.els?.fields)) {
      P.els = { fields: h('div', { class: 'make-fields' }), notes: h('div', { class: 'make-notes' }), basics: h('div', { class: 'make-basics' }),
        picker: h('div', { class: 'make-picker' }), head: h('div', { class: 'make-head' }), wires: h('div', { class: 'make-wires' }) };
      host.replaceChildren(h('div', { class: 'make-panel' }, P.els.head, P.els.picker, P.els.wires, P.els.notes, P.els.basics, P.els.fields));
    }
    if (P.key !== key || !list.some((t) => t.id === P.st?.tpl?.id)) {
      const settings = frame ? frame.make || null : store.get('deck.make.none', null);
      const want = pickTemplate(list, settings?.template, lastTpl(kind));
      P.st = withSave(settingsFor(list.find((t) => t.id === want), settings), kind, frame);
    }
    P.key = key;
    renderFields(target(kind, frame));
    fitFrame(kind, frame);
  }
  drawHead(kind, frame, list);
  drawWires(kind, frame);
}
const withSave = (st, kind, frame) => Object.assign(st, { save: () => keep(kind, frame) });

// What Run makes for the selection, as the action bar's button says it, and why it can't (null when it can)
const RUN_WORD = { none: 'Generate', image: 'Generate', video: 'Make video', scene: 'Make 3D', sound: 'Make sound' };
export function makeState() {
  let frames = [];
  try { frames = selection() || []; } catch { /* the table isn't up yet */ }
  const { kind, frame } = makeTarget(frames), n = makeFrames(frames).length;
  const label = (RUN_WORD[kind] || 'Generate') + (n > 1 ? ` on ${n} frames` : '');
  let why = null;
  const st = P.key === keyOf(kind, frame) ? P.st : null;
  if (!S.templates?.length) why = 'The templates are still loading';
  else if (!templatesFor(S.templates, kind).length) why = `No template makes anything for ${KIND_WORD[kind]}`;
  else if (frame && DOC_KIND[kind] && !frame.doc) why = `${frame.label || 'This frame'} has no document yet`;
  else if (st?.tpl?.error) why = `${st.tpl.name} has an error: pick another template`;
  return { label, why };
}
export const makeLabel = () => makeState().label;
let stateDue = false;
function tellState() {
  if (stateDue) return;
  stateDue = true;
  queueMicrotask(() => { stateDue = false; dispatchEvent(new CustomEvent('make:state')); });
}
addEventListener('deck:batch', () => { if (P.batchIn && document.activeElement !== P.batchIn) P.batchIn.value = S.batch; });

// where the fields draw, on this panel's own settings, and what they show differently here
function target(kind, frame) {
  return { host: P.els.fields, notes: P.els.notes, basics: P.els.basics, scope: P.host, state: P.st,
    replace: (f) => (kind === 'image' && frame && f === frameImageField(P.st.tpl) ? framePictureEl(frame)
      : f.key === mainPromptKey(P.st.tpl) ? notePromptEl() : wiredEl(kind, frame, f)),
    imageButtons: (f, set) => (kind === 'video' ? [button([icon('image'), 'Pick a frame'], () => pickFrame(f, set))] : []) };
}

// the settings of this frame (or of nothing selected) changed: keep them
function keep(kind, frame) {
  const st = P.st;
  if (!st?.tpl) return;
  store.set(`deck.make.tpl.${kind}`, st.tpl.id);
  if (!frame) { store.set('deck.make.none', settingsPayload(st)); return; }
  frame.make = settingsPayload(st, settleInputs(frame, st));
  frameSaved();
}

// The pictures Pick a frame copied in for this frame (frame.make.inputs, saved with it): one stays while a slot still uses it, and goes when
// the slot takes another picture or is cleared. What is left when the frame itself is deleted goes with Settings → Projects → Clean up leftovers
// (the table deletes frames in table.js, which can't reach this list).
function settleInputs(frame, st) {
  const used = JSON.stringify(st.values || {});
  const all = [...new Set([...(frame.make?.inputs || []), ...P.fresh.splice(0)])];
  const kept = (n) => used.includes(JSON.stringify(n)) || HELD.has(n);
  for (const n of all) if (!kept(n)) dropInput(n);
  return { inputs: all.filter(kept) };
}

// the frame's size is the output size (an image or video frame)
function fitFrame(kind, frame) {
  const st = P.st;
  if (!frame || !st || (kind !== 'image' && kind !== 'video')) return;
  const pair = sizePair(st.tpl), s = frameSize(pair, frame);
  if (!s || (st.values[pair[0].key] === s.w && st.values[pair[1].key] === s.h)) return;
  st.values[pair[0].key] = s.w; st.values[pair[1].key] = s.h;
  st.sizeMode[pair[0].key] = { aspect: 'custom', mp: Math.round((s.w * s.h) / 1e4) / 100 };
  renderFields(); keep(kind, frame);
}

// the template's saved setups: its fields as a key -> value map, less a run's own content (setups.js tpl:<template>)
function setupValues() {
  const st = P.st;
  return st ? Object.fromEntries(st.tpl.fields.filter((f) => !SHOT_KINDS.has(f.kind)).map((f) => [f.key, clone(st.values[f.key])])) : {};
}
function applySetup(kind, frame, v) {
  const st = P.st;
  if (!st || !v) return;
  for (const f of st.tpl.fields) {
    if (SHOT_KINDS.has(f.kind) || v[f.key] === undefined || (f.kind === 'choice' && f.options?.length && !f.options.includes(v[f.key]))) continue;
    st.values[f.key] = clone(v[f.key]);
  }
  st.sizeMode = {};
  renderFields(); keep(kind, frame); fitFrame(kind, frame);
}

function drawHead(kind, frame, list) {
  const t = P.st?.tpl;
  const fams = familiesOf(list), fam = t ? t.family || 'Other' : fams[0];
  const shown = list.filter((x) => (x.family || 'Other') === fam);
  const sel = h('select', { 'aria-label': 'Template', onchange: () => choose(kind, sel.value) },
    shown.map((x) => h('option', { value: x.id }, x.name + (x.error ? ' (error)' : ''))));
  if (t && shown.some((x) => x.id === t.id)) sel.value = t.id;
  const famSeg = seg(fams.map((f) => [f, f]), fam, (f) => { const first = list.find((x) => (x.family || 'Other') === f); if (first) choose(kind, first.id); }, { wrap: true });
  P.els.picker.replaceChildren(fams.length > 1 ? famSeg : null, sel,
    t ? setupsRow({ key: tplKey(t.id), get: setupValues, set: (v) => applySetup(kind, frame, v) }) : null);
  // (the batch is the action bar's: the stepper there and this box set the same S.batch)
  const batchIn = P.batchIn = h('input', { type: 'number', min: 1, max: 32, value: S.batch, inputMode: 'numeric', 'aria-label': 'How many',
    onchange: () => { batchIn.value = setBatch(batchIn.value); } });
  const owed = kind === 'image' && frame?.doc ? owedTo(frame.doc).length : 0;
  const n = makeFrames(P.frames).length;
  P.prog ||= { bar: h('div', { class: 'make-prog-bar' }), text: h('span', { class: 'make-prog-text' }) };
  P.els.head.replaceChildren(
    runBar(button([icon('sparkle'), n > 1 ? `Run on ${n} frames` : 'Run'], () => runMake(), { cls: 'primary make-run', title: 'Run (Ctrl+Enter)' }),
      h('label', { class: 'make-batch' }, '×', batchIn),
      iconBtn('Stop this device\'s run', icon('close'), () => stop())),
    h('div', { class: 'make-prog' }, P.prog.bar, P.prog.text),
    hint(n > 1 ? `For ${n} frames, one run each · ${landsWord(kind)}` : frame ? `For ${frame.label || 'the frame'} · ${landsWord(kind)}${owed ? ` · ${owed} on the way` : ''}` : `Lands as ${landsWord(kind)}`, 'make-for'));
  mirrorProgress();
  tellState();
}
const landsWord = (kind) => ({ frame: 'a new frame beside the last', layer: 'new layers in it', clip: 'clips on its timeline', mix: 'sounds in its mix', scene: 'in its scene' })[LANDS[kind]];

// another template: it starts from what this frame kept for it (if anything), with the prompt carried over
function choose(kind, id) {
  const t = (S.templates || []).find((x) => x.id === id);
  if (!t || !P.st) return;
  const { frame } = makeTarget(P.frames);
  const kept = frame ? frame.make : store.get('deck.make.none', null);
  P.st = withSave(carryWords(P.st, settingsFor(t, kept?.template === id ? kept : null)), kind, frame);
  keep(kind, frame);
  renderFields(target(kind, frame));
  fitFrame(kind, frame);
  draw();
}

// the frame's own picture, in place of the template's first picture slot
function framePictureEl(frame) {
  const still = stillOf(frame);
  return field(['Picture', h('span', {}, 'this frame')],
    h('div', { class: 'make-frame-pic' }, still ? h('img', { src: still, alt: '' }) : h('span', { class: 'hint' }, 'Empty frame')),
    help('The frame as it looks when Run is pressed.'));
}
// a selected note's words, in place of the prompt: they are what is sent
function notePromptEl() {
  const got = noteText(P.frames);
  if (!got) return null;
  return field(['Prompt', h('span', {}, `from ${got.note.label || 'the note'}`)],
    h('div', { class: 'make-note-text' }, got.text),
    help('A note is selected: its words are the prompt. Deselect the note to type one here.'));
}

// ---------------------------------------------------------------------------
// wires: the frames plugged into the selected frame (table.js wiresInto) fill the template's slots of their kind
// ---------------------------------------------------------------------------
// { inputs, map, use, spare } for the frame and the shown template (empty when nothing is plugged)
function wireState(kind, frame) {
  let inputs = [];
  try { if (frame && P.st?.tpl) inputs = Table.wiresInto(frame.id) || []; } catch { /* the table isn't up yet */ }
  return { inputs, ...wireFields(P.st?.tpl, kind, inputs, P.st?.wired) };
}
const sourceName = (w) => w.source?.label || 'a frame';
const wireWords = (w) => `${wireLabel(w)}${isFrameWire(w) ? ` (${w.frame} frame)` : ''} from ${sourceName(w)}`;
const setWired = (kind, frame, key, v) => {
  P.st.wired ||= {};
  if (v === undefined) delete P.st.wired[key]; else P.st.wired[key] = v;
  keep(kind, frame);
  renderFields(); drawWires(kind, frame);
};

// the field's slot, when an input is plugged into it and on: a chip in place of the picker, with an off switch and a menu to
// point the slot at another plugged input or to pick for itself (an off wire leaves the slot to its own picker; the row above lists it)
function wiredEl(kind, frame, f) {
  if (!frame || !fieldKind(f)) return null;
  const { inputs, map, use } = wireState(kind, frame), w = use[f.key];
  if (!w) return null;
  const others = repointable(f, inputs, map).filter((x) => x.id !== w.id);
  const menu = h('select', { 'aria-label': `Where ${f.label} comes from`, onchange: () => setWired(kind, frame, f.key, menu.value ? menu.value : false) },
    h('option', { value: w.id }, wireWords(w)), ...others.map((x) => h('option', { value: x.id }, wireWords(x))), h('option', { value: '' }, 'Pick myself'));
  menu.value = w.id;
  return field([f.label, h('span', {}, f.group || '')],
    h('div', { class: 'make-wire' }, h('span', { class: 'make-wire-chip' }, wireWords(w)),
      button('On', () => Table.setTableWire(w.id, { on: false }), { cls: 'small make-wire-on', title: 'Turn this input off: the slot uses its own picked value' }),
      menu),
    info(`Run fills this slot from the frame plugged in as ${wireLabel(w)}. Turn it off or pick myself to choose a value here instead.${kind === 'image' && fieldKind(f) === 'image' ? ' A frame with several layers comes from its saved still while another image frame is open (up to 1024 px).' : ''}`));
}

// above the fields: wires that are off, slots left to themselves where an input is waiting, and inputs no slot takes
function drawWires(kind, frame) {
  const el = P.els?.wires;
  if (!el) return;
  const rows = [];
  if (frame && P.st?.tpl) {
    const { inputs, map, spare } = wireState(kind, frame), t = P.st.tpl;
    for (const [key, w] of Object.entries(map)) {
      if (w.on !== false) continue;
      const f = t.fields.find((x) => x.key === key);
      rows.push(h('div', { class: 'make-wire-row' }, h('span', {}, `${wireWords(w)} is off for ${f?.label || key}`),
        button('Turn on', () => Table.setTableWire(w.id, { on: true }), { cls: 'small' })));
    }
    for (const f of selfPicked(t, kind, inputs, P.st.wired)) {
      const w = repointable(f, inputs, map)[0];
      if (w) rows.push(h('div', { class: 'make-wire-row' }, h('span', {}, `${f.label} is picked here`), button(`Use ${wireLabel(w)}`, () => setWired(kind, frame, f.key, w.id), { cls: 'small' })));
    }
    if (spare.length) {
      rows.push(h('div', { class: 'make-wire-row' }, h('span', {}, `Not used: ${spare.map(wireWords).join(', ')}`),
        info(`This template has no slot of that kind (${[...new Set(spare.map((w) => wireLabel(w).replace(/ \d+$/, '').toLowerCase()))].join(', ')}), or its slots are taken by the other inputs. Pick another template, or unplug it.`)));
    }
  }
  el.replaceChildren(...rows);
}
// the table's wires changed (plugged, unplugged, on or off, a frame choice): the slots draw again
addEventListener('table:wires', () => {
  if (!P.host || !P.st || !onTable()) return;
  const { kind, frame } = makeTarget(P.frames);
  if (!frame || P.key !== keyOf(kind, frame)) return;
  renderFields(); drawWires(kind, frame); tellState();
});

// Run: each field a wire fills gets what the wire carries. A picture from an image frame is its own input when the frame is one
// plain picture (nothing made: never dropped here), else a copy; a picture out of a video is a grab of it; a video or sound is
// its one clip with the trim, or the rendered edit (frame-source.js). Every new input goes in made; the caller drops them if the
// run fails and otherwise holds them until the run has read them (holdInputs). Returns the keys filled (they skip the crop step).
async function resolveWires(kind, frame, t, st, values, made) {
  const done = new Set();
  if (!frame) return done;
  const inputs = Table.wiresInto(frame.id);
  if (!inputs.length) return done;
  const { use } = wireFields(t, kind, inputs, st.wired);
  for (const f of t.fields) {
    const w = use[f.key];
    if (!w) continue;
    const src = Table.frameById(w.from) || w.source;
    if (!src) throw new Error(`${wireLabel(w)} has no frame to come from`);
    const k = fieldKind(f);
    if (k === 'image') {
      if (isFrameWire(w)) { const name = await frameStill(src, w.frame); made.push(name); values[f.key] = name; }
      else { const got = await frameImage(src, { multiple: 16 }); if (got.fresh) made.push(got.name); values[f.key] = got.name; }
      done.add(f.key);
    } else {
      const { label, ...clip } = await (k === 'video' ? frameVideo(src) : frameAudio(src));
      values[f.key] = clip;
    }
  }
  return done;
}
// the pictures made for a queued run: tracked on the frame (frame.make.inputs, so settleInputs removes them later) and dropped as
// soon as every run has finished with them
function holdInputs(frame, names, gens) {
  if (!names.length) return;
  names.forEach((n) => HELD.add(n));
  frame.make = { ...(frame.make || {}), inputs: [...new Set([...(frame.make?.inputs || []), ...names])] };
  frameSaved();
  Promise.allSettled(gens.map((g) => waitGen(g.id))).then(() => {
    names.forEach((n) => { HELD.delete(n); dropInput(n); });
    if (frame.make?.inputs) { frame.make = { ...frame.make, inputs: frame.make.inputs.filter((n) => !names.includes(n)) }; frameSaved(); }
  });
}

// Pick a frame: a picture from the table (or anywhere the picker lists) into a video template's slot. A table frame's picture is
// uploaded by the picker only when picked and the picker doesn't track it: that copy (info is just its name and size) is ours to
// drop with the slot (settleInputs). Anything else the picker hands back is the user's own picture and is never dropped here.
function pickFrame(f, set) {
  const { frame } = makeTarget(P.frames);
  openSourcePicker({ kinds: ['image'], want: 'picture', title: `${f.label}: pick a frame`, frame, mp: () => P.st?.imageMp[f.key] ?? 1,
    onPick: (name, info) => {
      if (info && Object.keys(info).sort().join() === 'height,name,width') P.fresh.push(name);
      set(name);
    } });
}

// ---------------------------------------------------------------------------
// a frame's picture (frame-source.js): the live editor's composite, else its edit drawn off screen, else its still;
// the wires into a frame (wire-rules.js, table.js wiresInto) fill the template's fields that take a picture, clip or sound
// ---------------------------------------------------------------------------
const dropInput = (name) => api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});

// ---------------------------------------------------------------------------
// Run: one run per selected frame of the kind (nothing selected: one run, new frames)
// ---------------------------------------------------------------------------
let running = false;
export async function runMake() {
  if (running) return;
  const sel = selection();
  if (sel !== P.frames) P.frames = sel || [];
  const { kind, frame } = makeTarget(P.frames);
  if (!P.host || P.key !== keyOf(kind, frame) || fieldState() !== P.st) draw();
  const st = P.st, t = st?.tpl;
  if (!t || t.error || P.key !== keyOf(kind, frame)) return toast('Pick a working template first', true);
  if (!templatesFor([t], kind).length) return toast(`${t.name} doesn't make anything for ${KIND_WORD[kind]}`, true);
  const targets = kind === 'none' ? [null] : makeFrames(P.frames);
  const noDoc = targets.find((f) => f && DOC_KIND[kind] && !f.doc);
  if (noDoc) return toast(`${noDoc.label || 'A frame'} has no document yet`, true);
  const base = runValues();
  if (!base) return;
  const words = noteText(P.frames), pk = mainPromptKey(t);
  if (words && pk) base[pk] = words.text;
  const builder = words ? null : runBuilder();
  running = true;
  let queued = 0;
  try {
    for (const f of targets) {
      let sent = null;
      const made = [];   // (inputs made for the wires into this frame)
      try {
        const values = clone(base);
        const imgF = kind === 'image' ? frameImageField(t) : null;
        if (imgF) { sent = await frameSource(f, { multiple: 16 }); values[imgF.key] = sent.name; }
        if (f && (kind === 'image' || kind === 'video')) {   // (each frame's own size)
          const pair = sizePair(t), s = frameSize(pair, f);
          if (s) { values[pair[0].key] = s.w; values[pair[1].key] = s.h; }
        }
        const wired = await resolveWires(kind, f, t, st, values, made);
        if (imgF) wired.add(imgF.key);
        await preparePictures(values, wired);
        const batch = S.batch;
        const gens = await queueRun({ template: t.id, values, batch, builder, timeout: 120000 });
        afterQueued(gens, batch);
        holdInputs(f, made.splice(0), gens);
        await land(kind, f, t, gens, sent, values);
        dispatchEvent(new CustomEvent('make:queued', { detail: { frame: f, kind, gens } }));
        queued += gens.length;
      } catch (e) {
        if (sent) dropInput(sent.name);
        made.forEach(dropInput);
        toast(targets.length > 1 ? `${f?.label || 'A frame'}: ${e.message}` : e.message, true);
      }
    }
    if (queued) toast(`${queued > 1 ? `Queued ${queued}` : 'Queued'}${targets.length > 1 ? ` on ${targets.length} frames` : ''}: ${landsWord(kind)}`);
    if (P.els) drawHead(kind, frame, templatesFor(S.templates, kind));
  } finally { running = false; }
}

function land(kind, frame, t, gens, sent, values) {
  if (kind === 'image') return landLayers(frame, t, gens, sent);
  for (const g of gens) {
    waitGen(g.id).then((done) => (kind === 'none' ? landFrames(done, values, t) : kind === 'video' ? landClips(frame, done)
      : kind === 'sound' && frame?.doc ? landSounds(frame, done) : kind === 'scene' && frame ? landScene(frame, done) : inShelf(done)))
      .catch((e) => toast(`${t.name} failed: ${e.message}`, true));
  }
}

// image frame: each run a new layer in it, now if it is open, else when it next opens (owed runs, by its document's id)
async function landLayers(frame, t, gens, sent) {
  let rect = sent?.rect;
  if (!rect) {
    const eng = isLive(frame.id) && CURRENT_EDIT.eng?.E?.tab?.id === frame.doc ? CURRENT_EDIT.eng : null;
    rect = eng?.frame?.();
    if (!rect && frame.fit && frame.fitBox) rect = { ...frame.fitBox };   // (a frame sized by its layers: where they were last)
    if (!rect) rect = canvasRect((await api(docUrl('image', frame.doc), { busy: false }).catch(() => null))?.payload, frame);
  }
  const src = { name: sent?.name || null, px: sent ? sent.px : [rect.w, rect.h], rect, copy: !!sent };
  gens.forEach((g, i) => {
    landMade(frame.doc, src, g, { label: t.name, nth: i });
    waitGen(g.id).catch(() => {}).finally(() => setTimeout(() => { if (P.host) draw(); }, 1500));   // (the count of runs on the way)
  });
}

// nothing selected: each output a new frame beside the last one
async function landFrames(done, values, t) {
  const pair = sizePair(t), size = pair ? { w: Number(values[pair[0].key]) || 1024, h: Number(values[pair[1].key]) || 1024 } : { w: 1024, h: 1024 };
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'image' || o.kind === 'video');
  if (!outs.length) return inShelf(done);
  for (const { o, index } of outs) {
    const T = tableNow(), stage = document.querySelector('#tab-table .table-stage');
    const r = stage?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 };
    let at;
    if (T?.frames && T.view) {
      const spot = nextBeside(T.frames, o.kind === 'video' ? 'video' : 'image', size);
      const p = toStage(T.view, spot.x, spot.y);
      at = { x: r.left + p.x, y: r.top + p.y };
    } else at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    await Table.dropOnTable([{ generation: done.id, index }], at.x, at.y);
  }
}

// video frame: each output a clip at the end of its first video track, in the open timeline if this frame is live
export async function landClips(frame, done) {
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'video' || o.kind === 'image');
  let n = 0;
  for (const { o, index } of outs) {
    if (await landClip(frame, { kind: o.kind, src: { generation: done.id, index }, url: o.url, label: `#${done.id}`, dur: o.duration || 0 }, false)) n++;
    else toast(`#${done.id} is done but couldn't go on ${frame.label}'s timeline: it is in the Shelf`, true);
  }
  if (n) toast(`#${done.id}: on ${frame.label || 'the video'}'s timeline`);
}
// one clip onto a video frame's timeline (the open one when it is live); true once it is there
export async function landClip(frame, media, tell = true) {
  const vid = isLive(frame.id) ? await import('./video.js') : null;
  let ok = true;
  if (vid && vid.videoTabs?.()?.active?.id === frame.doc) await vid.addToTimeline(media);
  else {
    if (!media.dur && media.kind === 'video') media.dur = await durationOf(media.url);
    ok = await appendClip(frame, media);
  }
  if (tell) toast(ok ? `On ${frame.label || 'the video'}'s timeline` : `Couldn't put it on ${frame.label}'s timeline`, !ok);
  return ok;
}

// the clip into the frame's saved document (its rev, so an edit elsewhere isn't overwritten: read again and retry)
async function appendClip(frame, media) {
  for (let tries = 0; tries < 3; tries++) {
    const d = await api(docUrl('video', frame.doc), { busy: false }).catch(() => null);
    if (!d) return false;
    const payload = withClip(d.payload, media, Math.random().toString(36).slice(2, 10));
    const r = await fetch(docUrl('video', frame.doc), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: d.rev, name: d.name, payload }) }).catch(() => null);
    if (r?.ok) return true;
    if (r?.status !== 409) return false;
    if (refused({ status: 409, data: await r.json().catch(() => null) })) return false;   // (a refusal, not a newer rev: no retry)
  }
  return false;
}
function durationOf(url) {
  return new Promise((done) => {
    const v = document.createElement('video');
    const end = (d) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); done(d); };
    const timer = setTimeout(() => end(0), 8000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => end(0);
    v.src = url;
  });
}

// sound frame: each sound it made into its mix (frame-sound.js takes it as a drop: the open mix when it is live)
export function landSounds(frame, done) {
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'audio');
  if (!outs.length) return inShelf(done);
  const still = Table.frameById(frame.id);
  if (!still || !Table.dropOntoFrame(still, outs.map(({ index }) => ({ generation: done.id, index })))) inShelf(done);
}

// 3D frame: what it made goes into its scene (frame-scene.js landInScene(frame, outputs), each output with its generation
// and index), else it is in the Shelf
async function landScene(frame, done) {
  const fs = await import('./frame-scene.js').catch(() => null);
  if (!fs?.landInScene) return inShelf(done);
  const outs = (done.outputs || []).map((o, index) => ({ ...o, generation: done.id, index }));
  try { await fs.landInScene(Table.frameById(frame.id) || frame, outs); } catch (e) { toast(e.message, true); inShelf(done); }
}

// anything with nowhere to go: the result is in the Shelf (History) already
function inShelf(done) {
  toast(`#${done.id} is done: it is in the Shelf`, false, { label: 'On the table…', fn: async () => (await import('./useas.js')).openUseAs(done, 0) });
}

// ---------------------------------------------------------------------------
// progress: the run line of the Generate tab (run.js setProgress), mirrored here
// ---------------------------------------------------------------------------
let mirrored = false;
function mirrorProgress() {
  const bar = document.getElementById('progBar'), text = document.getElementById('progText');
  if (!P.prog || !bar || !text) return;
  const copy = () => { P.prog.bar.style.width = bar.style.width || '0'; P.prog.text.textContent = text.textContent || ''; };
  copy();
  if (mirrored) return;
  mirrored = true;
  const mo = new MutationObserver(copy);
  mo.observe(bar, { attributes: true, attributeFilter: ['style'] });
  mo.observe(text, { childList: true, characterData: true, subtree: true });
}

// ---------------------------------------------------------------------------
// wiring: the selection on the table, a frame going live, leaving the table
// ---------------------------------------------------------------------------
addEventListener('table:select', (e) => { P.table = e.detail?.table || P.table; renderMake(P.host, e.detail?.frames || []); });
addEventListener('table:live', (e) => { P.table = e.detail?.table || P.table; if (e.detail?.frame) renderMake(P.host, [e.detail.frame]); });
addEventListener('table:unlive', () => { if (P.host) draw(); });
onNavigate((name) => {
  if (name === 'table') { if (P.host) draw(); return; }
  if (fieldsBorrowed()) { fieldTarget(null); if (S.tpl) renderFields(); }   // (another screen: the fields draw the Generate tab's own again)
  P.key = null;
});
// the template list came in (or changed): draw again
let tplSeen = null;
addEventListener('deck:generate', () => {
  if (S.templates !== tplSeen) { tplSeen = S.templates; P.key = null; if (P.host) draw(); }
});
// the sidebar's Make pane, once it exists
import('./sidebar.js').then(({ sidebar }) => {
  const el = sidebar?.pane?.('make', { title: 'Make', icon: 'sparkle' });
  if (el && !P.host) renderMake(el, P.frames);
}).catch(() => { /* no sidebar yet: whoever has a place for the panel calls renderMake */ });

