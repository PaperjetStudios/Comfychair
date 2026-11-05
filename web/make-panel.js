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
//   runFrame(frame, { batch, replace })   one frame's workflow (frame.make) run as its own Run would, without it being
//                              selected or the pane open; resolves once the result has LANDED in the frame. replace: the
//                              result takes the place of what the frame's last chain run made (frame.make.ran.made), as
//                              Run from here does (chain-run.js); without it, results are added as Run adds them.
//   runWith(frame, { template, values, batch })   a recorded Make step played on a frame (actions.js): the template with
//                              these values over the frame's own settings (its slots, wires), never saved to the frame;
//                              resolves once the result has landed, as runFrame. `make:ran` { template, label, on, values,
//                              seeds, fields, batch } is sent after a Run from the pane queued on frames (what actions.js records).
// Each run records what it read on its frame (frame.make.ran: the stamps of its plugged sources, chain-rules.js), so the
// table can say which frames need a rerun. The wires row has Run from here / Rerun what uses this (chain-run.js).
import { resultName, templateProcess } from './run-name.js';
import { h, api, store, toast, uid, button, iconBtn, imageInput, seg, field, hint, toggle, help, info, note, clone } from './ui.js';
import { ASPECT_PRESETS, S, CURRENT_EDIT, inputUrl, previewUrl, thumbUrl } from './core.js';
import { modeOf } from './size-math.js';
import { afterQueued, fieldState, fieldTarget, fieldsBorrowed, mainPromptKey, preparePictures, renderFields, runBuilder, runValues, stop } from './generate.js';
import { cropPreview, openPictureCrop, pictureForRun, pictureSize } from './picture-input.js';
import { outputOf } from './table-model.js';
import { normalize } from './layer-stack.js';
import { setupsRow } from './setups.js';
import { tplKey } from './setups-rules.js';
import { refused } from './tabs.js';
import { queueRun, waitGen } from './make.js';
import { openSourcePicker } from './source-picker.js';
import { landMade, owedTo } from './imagetools.js';
import { isLive } from './live.js';
import { currentTab, onNavigate } from './navigation.js';
import { editDoc, flushDoc, frameStamp, freshStamps, stillOf } from './table-frames.js';
import { DOC_KIND, nextBeside, toStage } from './table-model.js';
import * as Table from './table.js';
import { LANDS, canvasRect, carryKept, familiesOf, frameImageField, frameSize, slotMode, makeFrames, makeTarget, noteText, pickTemplate, isOwnSlot, repointable, runValuesOf, seedsAfter,
  addHeld, frameLength, lengthField, lengthValue, outputOwns, selfPicked, settingsFor, settingsPayload, settleHeld, sizePair, templatesFor, templatesForFrame, wireFields, withClip } from './make-rules.js';
import { downstream, fieldKind, isFrameWire, wireLabel } from './wire-rules.js';
import { freshLayers, layerMarks, placeResults, sourceStamps, withSoundItem, withoutLayers } from './chain-rules.js';
import { icon } from './icons.js';
import { mountRunStrip } from './run-strip.js';
import { frameAudio, frameImage, frameSource, frameStill, frameVideo } from './frame-source.js';
import { keepMain } from './main-rules.js';

const P = { fresh: [], host: null, frames: [], table: null, key: null, st: null, els: null };
const KIND_WORD = { none: 'a new frame', image: 'this picture', video: 'this video', scene: 'this 3D frame', sound: 'this sound frame' };
export const SHOT_KINDS = new Set(['image', 'video', 'boxes', 'seed', 'mask']);   // a run's own content, not a setting (gentabs.js)
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
  const list = templatesForFrame(S.templates, kind, frame);
  if (!list.length) { host.replaceChildren(note(`No template here makes anything for ${KIND_WORD[kind]}.`, 'warn')); P.key = null; return; }
  if (!onTable()) return;   // (the fields are drawn once the table is on screen: the Generate tab keeps its own meanwhile)
  const key = keyOf(kind, frame);
  if (P.key !== key || !host.contains(P.els?.fields) || !list.some((t) => t.id === P.st?.tpl?.id) || fieldState() !== P.st) {
    if (P.key !== key || !host.contains(P.els?.fields)) {
      P.els = { fields: h('div', { class: 'make-fields' }), notes: h('div', { class: 'make-notes' }), basics: h('div', { class: 'make-basics' }),
        picker: h('div', { class: 'make-picker' }), head: h('div', { class: 'make-head' }), wires: h('div', { class: 'make-wires' }),
        chain: h('div', { class: 'make-chain', role: 'status' }) };
      host.replaceChildren(h('div', { class: 'make-panel' }, P.els.head, P.els.chain, P.els.picker, P.els.wires, P.els.notes, P.els.basics, P.els.fields));
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
  drawChain();
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

// where the fields draw, on this panel's own settings, and what they show differently here
function target(kind, frame) {
  return { host: P.els.fields, notes: P.els.notes, basics: P.els.basics, scope: P.host, state: P.st,
    // (a picture or clip slot says where it comes from: wrap draws the choice over it, here its body unless it's picked by hand)
    replace: (f) => {
      if (f.key === mainPromptKey(P.st.tpl)) return notePromptEl();
      if (!frame || !isSlot(f)) return wiredEl(kind, frame, f);
      const mode = modeIn(kind, frame, f, P.st);
      return mode === 'layers' ? layersEl(kind, frame, f) : mode === 'wire' ? wiredEl(kind, frame, f) : null;
    },
    wrap: frame ? (f, el) => (isSlot(f) ? slotFromEl(kind, frame, f, el) : null) : null,
    // (what a slot shows, for the picture behind Draw boxes; undefined: picked by hand, the slot's own value)
    slotPicture: frame ? (f) => {
      if (!isSlot(f)) return undefined;
      const mode = modeIn(kind, frame, f, P.st), cur = Table.frameById(frame.id) || frame;
      if (mode === 'manual') return undefined;
      if (mode === 'layers') return P.layerUrl?.[f.key] || stillOf(cur) || cur.preview || null;
      const w = wireState(kind, frame).use[f.key], src = w && (Table.frameById(w.from) || w.source);
      return src ? stillOf(src) || (src.preview ? (src.kind === 'video' ? previewUrl(src.preview, 1024) : src.preview) : null) : null;
    } : null,
    // (a frame's size and length are its Output tab's)
    hide: frame ? (f) => outputOwns(P.st.tpl, kind, f) : null,
    imageButtons: (f, set) => (kind === 'video' ? [button([icon('image'), 'Pick a frame'], () => pickFrame(f, set))] : []) };
}

// a slot that can choose where its value comes from: a picture or a clip
const isSlot = (f) => fieldKind(f) === 'image' || fieldKind(f) === 'video';
const inputsOf = (frame) => { try { return Table.wiresInto(frame.id) || []; } catch { return []; } };
const modeIn = (kind, frame, f, st) => slotMode(st.tpl, kind, f, st, inputsOf(frame), { ownPicture: hasPicture(kind, frame) });

// the settings of this frame (or of nothing selected) changed: keep them
function keep(kind, frame) {
  const st = P.st;
  if (!st?.tpl) return;
  store.set(`deck.make.tpl.${kind}`, st.tpl.id);
  if (!frame) { store.set('deck.make.none', settingsPayload(st)); return; }
  frame.make = settingsPayload(st, { ...settleInputs(frame, st), ...ranOf(frame), ...heldOf(frame) });
  frameSaved();
}
// what the frame's last run read and made (frame.make.ran): kept through a change of its settings
const ranOf = (frame) => (frame?.make?.ran ? { ran: frame.make.ran } : {});
// the wire pictures its queued runs have yet to read (frame.make.held, make-rules settleHeld): kept through a change of its settings
const heldOf = (frame) => (frame?.make?.held?.length ? { held: frame.make.held } : {});

// The pictures Pick a frame copied in for this frame (frame.make.inputs, saved with it): one stays while a slot still uses it, and goes when
// the slot takes another picture or is cleared. What is left when the frame itself is deleted goes with Settings → Projects → Clean up leftovers
// (the table deletes frames in table.js, which can't reach this list).
function settleInputs(frame, st) {
  const used = JSON.stringify(st.values || {});
  const all = [...new Set([...(frame.make?.inputs || []), ...P.fresh.splice(0)])];
  const kept = (n) => used.includes(JSON.stringify(n));
  for (const n of all) if (!kept(n)) dropInput(n);
  return { inputs: all.filter(kept) };
}

// the frame's size is the output size (an image or video frame)
function fitFrame(kind, frame) {
  const st = P.st;
  if (!frame || !st || (kind !== 'image' && kind !== 'video')) return;
  const pair = sizePair(st.tpl), s = frameSize(pair, Table.frameById(frame.id) || frame);
  if (!s) return;
  const named = modeOf(s.w, s.h, ASPECT_PRESETS);   // (a frame saved in Custom shows chips again when they describe its size)
  const same = st.values[pair[0].key] === s.w && st.values[pair[1].key] === s.h;
  if (same && !(st.sizeMode[pair[0].key]?.aspect === 'custom' && named.aspect !== 'custom')) return;
  st.values[pair[0].key] = s.w; st.values[pair[1].key] = s.h;
  st.sizeMode[pair[0].key] = named;
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
  P.els.picker.replaceChildren(fams.length > 1 ? famSeg : null, sel, keepToggle(),
    t ? setupsRow({ key: tplKey(t.id), get: setupValues, set: (v) => applySetup(kind, frame, v) }) : null);
  const owed = kind === 'image' && frame?.doc ? owedTo(frame.doc).length : 0;
  const n = makeFrames(P.frames).length;
  P.els.head.replaceChildren(
    hint(n > 1 ? `For ${n} frames, one run each · ${landsWord(kind)}` : frame ? `For ${frame.label || 'the frame'} · ${landsWord(kind)}${owed ? ` · ${owed} on the way` : ''}` : `Lands as ${landsWord(kind)}`, 'make-for'));
  tellState();
}
const landsWord = (kind) => ({ frame: 'a new frame beside the last', layer: 'new layers in it', clip: 'clips on its timeline', mix: 'sounds in its mix', scene: 'in its scene' })[LANDS[kind]];

// Keep prompt, the Generate tab's own switch (gentabs.js, the same setting): on, a template change carries the prompt, pictures, size and a
// fixed seed over; off, the new template starts from its own prompt
const keepOn = () => store.get('deck.gen.keepOnSwitch', true);
function keepToggle() {
  const el = toggle('Keep the prompt and pictures when the template changes', keepOn(), (on) => store.set('deck.gen.keepOnSwitch', on),
    { help: 'On: a new template keeps the prompt, negative prompt, pictures, size and a fixed seed. Off: it starts from the template\'s own prompt and settings.' });
  el.classList.add('keep-toggle');
  return el;
}

// another template: it starts from what this frame kept for it (if anything), with the prompt and pictures carried over while Keep is on
function choose(kind, id) {
  const t = (S.templates || []).find((x) => x.id === id);
  if (!t || !P.st) return;
  const { frame } = makeTarget(P.frames);
  const kept = frame ? frame.make : store.get('deck.make.none', null);
  const next = settingsFor(t, kept?.template === id ? kept : null);
  P.st = withSave(keepOn() ? carryKept(P.st, next) : next, kind, frame);
  keep(kind, frame);
  renderFields(target(kind, frame));
  fitFrame(kind, frame);
  draw();
}

// the frame's own picture, in place of the template's first picture slot; with a main source pinned (frame.main), that layer
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
  return { inputs, ...wireFields(P.st?.tpl, kind, inputs, P.st?.wired, { ownPicture: hasPicture(kind, frame) }) };
}
// an image frame's own picture, as far as the panel can tell without opening it (its still, or its preview)
const hasPicture = (kind, frame) => kind !== 'image' || !frame || !!(stillOf(frame) || frame.preview);
const sourceName = (w) => w.source?.label || 'a frame';
const wireWords = (w) => `${wireLabel(w)}${isFrameWire(w) ? ` (${w.frame} frame)` : ''} from ${sourceName(w)}`;
const setWired = (kind, frame, key, v) => {
  P.st.wired ||= {};
  if (v === undefined) delete P.st.wired[key]; else P.st.wired[key] = v;
  keep(kind, frame);
  renderFields(); drawWires(kind, frame);
};

// Where a slot's value comes from: layers, a plugged input or picked by hand
function setFrom(kind, frame, f, mode) {
  P.st.from ||= {};
  if (mode === 'wire') {
    const { inputs, map } = wireState(kind, frame);
    const w = repointable(f, inputs, map).find((x) => x.on !== false) || inputs.find((x) => x.kind === fieldKind(f) && x.on !== false);
    if (!w) return;
    delete P.st.from[f.key];
    setWired(kind, frame, f.key, w.id);
    return;
  }
  P.st.from[f.key] = mode;
  setWired(kind, frame, f.key, false);
}
function slotFromEl(kind, frame, f, body) {
  const mode = modeIn(kind, frame, f, P.st);
  const plugged = inputsOf(frame).some((w) => w.kind === fieldKind(f) && w.on !== false);
  const options = [...(kind === 'image' && fieldKind(f) === 'image' ? [['layers', 'Layers']] : []), ...(plugged || mode === 'wire' ? [['wire', 'Plugged in']] : []), ['manual', 'Set here']];
  if (options.length < 2) return null;
  const el = h('div', { class: 'slot-from' }, seg(options, mode, (m) => setFrom(kind, frame, f, m)), body);
  el.dataset.key = f.key;
  return el;
}
// a picture slot filled from this frame's layers: all of them as the frame looks, or one (a pinned main source starts as that one)
function layersEl(kind, frame, f) {
  frame = Table.frameById(frame.id) || frame;
  const own = frameImageField(P.st.tpl)?.key === f.key, src = (P.st.layerSrc ||= {})[f.key] || {};
  const save = (patch) => { P.st.layerSrc[f.key] = { ...P.st.layerSrc[f.key], ...patch }; keep(kind, frame); };
  const chosen = () => (src.layer !== undefined ? src.layer : frame.main || '');
  const still = stillOf(frame) || frame.preview || null;
  const img = h('img', { src: still || '', alt: '' }), thumb = h('div', { class: 'thumb' }, still ? img : h('span', { class: 'hint' }, 'Empty frame'));
  let nat = () => { const o = outputOf(frame); return o ? [o.w, o.h] : null; };
  const sizeEl = pictureSize({ nat: () => nat(), mp: src.mp ?? (own ? 0 : f.mp ?? 1), onPick: (mp) => save({ mp }) });
  const menu = h('select', { 'aria-label': `Which layers ${f.label} comes from`, onchange: () => { save({ layer: menu.value }); renderFields(); } }, h('option', { value: '' }, 'All layers, as the frame looks'));
  menu.value = '';
  // (a saved edit whose layers were never opened has no keys yet: they get theirs here, so one can be chosen)
  const pickable = (l) => l && !l.maskOf && !l.mask && !l.draft;
  const keyed = async () => {
    const list = await layersOf(frame);
    if (liveEng(frame) || !list.some((l) => pickable(l) && l.key == null)) return list;
    await editDoc('image', frame.doc, (p) => { for (const l of p.layers || []) if (pickable(l) && l.key == null) l.key = uid(); });
    return layersOf(frame);
  };
  keyed().then((list) => {
    const usable = list.filter((l) => pickable(l) && l.key != null);
    menu.append(...usable.map((l) => h('option', { value: l.key }, l.label || String(l.name || '').split('/').pop() || 'Painted layer')));
    menu.value = usable.some((l) => l.key === chosen()) ? chosen() : '';
    const l = usable.find((x) => x.key === menu.value);
    (P.layerUrl ||= {})[f.key] = l?.name ? inputUrl(l.name) : null;
    if (l?.name) {
      if (!thumb.contains(img)) thumb.replaceChildren(img);
      img.src = thumbUrl(l.name, 256);
      const probe = new Image();
      probe.onload = () => { nat = () => [probe.naturalWidth, probe.naturalHeight]; sizeEl.refresh(); };
      probe.src = inputUrl(l.name);
    }
  }).catch(() => {});
  const crop = !own && still ? button('Crop…', () => openPictureCrop(img.src, src.crop || null, (c) => { save({ crop: c }); renderFields(); })) : null;
  return field([f.label, h('span', {}, src.crop ? 'from this frame · cropped' : 'from this frame')],
    help('Run sends this frame\'s layers here: all of them as the frame looks, or the one you choose.'),
    h('div', { class: 'imgfield' }, thumb, h('div', { class: 'actions' }, menu, crop, sizeEl)));
}

// the field's slot, when an input is plugged into it and on: a chip in place of the picker, with an off switch and a menu to
// point the slot at another plugged input or to pick for itself (an off wire leaves the slot to its own picker; the row above lists it)
function wiredEl(kind, frame, f) {
  if (!frame || !fieldKind(f)) return null;
  const { inputs, map, use } = wireState(kind, frame), w = use[f.key];
  if (!w) return null;
  const others = repointable(f, inputs, map).filter((x) => x.id !== w.id);
  const menu = h('select', { 'aria-label': `Where ${f.label} comes from`, onchange: () => { if (menu.value) setWired(kind, frame, f.key, menu.value); else setFrom(kind, frame, f, 'manual'); } },
    h('option', { value: w.id }, wireWords(w)), ...others.map((x) => h('option', { value: x.id }, wireWords(x))), h('option', { value: '' }, 'Pick myself'));
  menu.value = w.id;
  if (fieldKind(f) === 'image' || fieldKind(f) === 'video') return wiredPictureEl(kind, frame, f, w, menu);
  return field([f.label, h('span', {}, f.group || '')],
    h('div', { class: 'make-wire' }, h('span', { class: 'make-wire-chip' }, wireWords(w)),
      button('On', () => Table.setTableWire(w.id, { on: false }), { cls: 'small make-wire-on', title: 'Turn this input off: the slot uses its own picked value' }),
      menu),
    info(`Run fills this slot from the frame plugged in as ${wireLabel(w)}. Turn it off or pick myself to choose a value here instead.${kind === 'image' && fieldKind(f) === 'image' ? ' A frame with several layers comes from its saved still while another image frame is open (up to 1024 px).' : ''}`));
}

// a picture or clip slot a wire fills: the same slot as any other, showing the plugged frame. A picture's crop and the size it goes in at are
// kept on the wire, so the frame's next look is cut the same way at Run. Change gives the slot its own picker instead of the wire.
function wiredPictureEl(kind, frame, f, w, menu) {
  const isImage = fieldKind(f) === 'image', own = () => setFrom(kind, frame, f, 'manual');
  const src = Table.frameById(w.from) || w.source;
  const url = !src ? null : stillOf(src) || (src.preview ? (src.kind === 'video' ? previewUrl(src.preview, 256) : src.preview) : null);
  const words = wireWords(w);
  const pick = !isImage ? own : () => openSourcePicker({ kinds: ['image'], want: 'picture', title: f.label, onPick: (name) => {
    P.st.values[f.key] = name;
    own();
  } });
  const cut = () => openPictureCrop(url, w.crop || null, (crop) => Table.setTableWire(w.id, { crop }));
  const nat = () => {
    const o = outputOf(src), c = w.crop || { w: 1, h: 1 };
    return o ? [o.w * c.w, o.h * c.h] : null;
  };
  return imageInput({ label: f.label, name: `${words}${w.crop ? ' · cropped' : ''}`,
    thumb: !url ? h('span', { class: 'hint' }, 'No picture yet') : w.crop ? cropPreview(url, w.crop) : h('img', { src: url, alt: words }),
    pick, onClear: own,
    tip: `Run fills this slot from the frame plugged in as ${wireLabel(w)}. Change or clear it, or choose Pick myself, to use something else here instead.${kind === 'image' && isImage ? ' A frame with several layers comes from its saved still while another image frame is open (up to 1024 px).' : ''}`,
    buttons: [isFrameWire(w) && src ? button('Frame…', () => Table.chooseWireFrame(w.id), { title: 'Choose which frame of the video goes in' }) : null,
      isImage && url ? button('Crop…', cut) : null,
      button('On', () => Table.setTableWire(w.id, { on: false }), { cls: 'small make-wire-on', title: 'Turn this input off: the slot uses its own picked value' })],
    below: [isImage ? pictureSize({ nat, mp: w.mp ?? f.mp ?? 1, onPick: (mp) => Table.setTableWire(w.id, { mp }) }) : null, menu] });
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
    const opts = { ownPicture: hasPicture(kind, frame) }, offered = new Set();
    for (const f of selfPicked(t, kind, inputs, P.st.wired, opts)) {
      if (isSlot(f)) continue;   // (a picture or clip slot has its own choice)
      const w = repointable(f, inputs, map)[0], mine = isOwnSlot(t, kind, f, P.st.wired, opts);
      if (w) offered.add(w.id);
      if (w) rows.push(h('div', { class: 'make-wire-row' }, h('span', {}, mine ? `${f.label} is this frame's picture` : `${f.label} is picked here`),
        button(mine ? `Use ${wireLabel(w)} here` : `Use ${wireLabel(w)}`, () => setWired(kind, frame, f.key, w.id), { cls: 'small' })));
    }
    const unused = spare.filter((w) => !offered.has(w.id));   // (one offered by a "Use … here" button above is not listed again)
    if (unused.length) {
      rows.push(h('div', { class: 'make-wire-row' }, h('span', {}, `Not used: ${unused.map(wireWords).join(', ')}`),
        info(`This template has no slot of that kind (${[...new Set(unused.map((w) => wireLabel(w).replace(/ \d+$/, '').toLowerCase()))].join(', ')}), or its slots are taken by the other inputs. Pick another template, or unplug it.`)));
    }
  }
  if (frame) rows.push(...chainRows(frame));
  el.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// a chain (chain-run.js): this frame's workflow and everything it feeds, rerun in order; and whether it needs a rerun
// ---------------------------------------------------------------------------
const CHAIN = { running: false, i: 0, n: 0, label: '' };
const chainRun = (fn) => import('./chain-run.js').then((m) => m[fn](Table.frameById(makeTarget(P.frames).frame?.id) || makeTarget(P.frames).frame))
  .catch((e) => toast(e.message, true));
const stopChainNow = () => import('./chain-run.js').then((m) => m.stopChain()).catch(() => {});
function chainRows(frame) {
  let wires = [], stale = null;
  try { wires = Table.tableWires() || []; stale = Table.staleReasons().get(frame.id) || null; } catch { return []; }
  const down = downstream(wires, frame.id), flow = (f) => !!f?.make?.template;
  const self = flow(frame) || !!P.st?.tpl, feeds = wires.some((w) => w.from === frame.id && w.on !== false);
  const rows = [];
  if (stale) rows.push(h('div', { class: 'make-wire-row stale' }, icon('refresh'), h('span', {}, 'Needs rerun'), info(Table.staleWords(stale))));
  const btns = [];
  if (self || down.some((id) => flow(Table.frameById(id)))) {
    btns.push(button([icon('play'), 'Run from here'], () => chainRun('runFromHere'), { cls: 'small', disabled: CHAIN.running,
      title: down.length ? `This frame, then the ${down.length} it feeds, in order` : 'This frame\'s workflow, its result in place of the last chain run\'s' }));
  }
  if (feeds) btns.push(button([icon('forward'), 'Rerun what uses this'], () => chainRun('rerunUsers'), { cls: 'small', disabled: CHAIN.running, title: 'Each frame this one feeds, in order' }));
  if (btns.length) {
    rows.push(h('div', { class: 'make-wire-row' }, ...btns,
      info('Run from here runs this frame\'s workflow with its saved settings, waits for the result to land, then each frame it feeds, in order. A frame with no workflow passes its content through. Each result takes the place of what that frame\'s last chain run made; the old run stays in History. Run above adds as before.')));
  }
  return rows;
}
// the one status row while a chain runs
function drawChain() {
  const el = P.els?.chain;
  if (!el) return;
  if (!CHAIN.running) { el.replaceChildren(); return; }
  el.replaceChildren(h('span', {}, `Chain: ${CHAIN.i} of ${CHAIN.n}${CHAIN.label ? `, "${CHAIN.label}"` : ''}`),
    button([icon('close'), 'Stop'], stopChainNow, { cls: 'small', title: 'Stop the chain (and this device\'s run)' }));
}
// which frames need a rerun changed (table.js): the wires row says it again
addEventListener('table:stale', () => {
  if (!P.host || !P.st || !onTable()) return;
  const { kind, frame } = makeTarget(P.frames);
  if (frame && P.key === keyOf(kind, frame)) drawWires(kind, frame);
});
addEventListener('chain:state', (e) => {
  Object.assign(CHAIN, { running: false, i: 0, n: 0, label: '' }, e.detail || {});
  if (!P.host || !onTable()) return;
  drawChain();
  const { kind, frame } = makeTarget(P.frames);
  if (frame && P.key === keyOf(kind, frame)) drawWires(kind, frame);
});
// the frame's main source pinned or unpinned (table.js setFrameField): its picture field says so
// the frame's output size changed elsewhere (the Output tab, undo, an image fitting its layers): the Size field follows
const outputMoved = (e) => {
  const f = e.detail?.frame;
  if ((e.type === 'table:output' || e.detail?.keys?.includes('out')) && P.frames?.length === 1 && P.frames[0].id === f?.id) fitFrame(f.kind, f);
};
addEventListener('table:frame-field', outputMoved);
addEventListener('table:output', outputMoved);
addEventListener('table:frame-field', (e) => {
  if (!e.detail?.keys?.includes('main') || !P.host || !P.st || !onTable()) return;
  const { kind, frame } = makeTarget(P.frames);
  if (!frame || frame.id !== e.detail.frame?.id || P.key !== keyOf(kind, frame)) return;
  renderFields(target(kind, Table.frameById(frame.id) || frame)); tellState();
});
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
  const { use } = wireFields(t, kind, inputs, st.wired, { ownPicture: hasPicture(kind, frame) });
  for (const f of t.fields) {
    const w = use[f.key];
    if (!w) continue;
    const src = Table.frameById(w.from) || w.source;
    if (!src) throw new Error(`${wireLabel(w)} has no frame to come from`);
    const k = fieldKind(f);
    if (k === 'image') {
      const got = isFrameWire(w) ? { name: await frameStill(src, w.frame), fresh: true } : await frameImage(src, { multiple: 16 });
      if (got.fresh) made.push(got.name);
      // (the crop and size asked for. A copy of a picture made for this run goes with it; one of a kept picture stays with that picture, as any slot's does)
      const cut = await pictureForRun(got.name, w.crop || null, w.mp ?? f.mp ?? 1);
      if (got.fresh && cut !== got.name) made.push(cut);
      values[f.key] = cut;
      done.add(f.key);
    } else {
      const { label, ...clip } = await (k === 'video' ? frameVideo(src) : frameAudio(src));
      values[f.key] = clip;
    }
  }
  return done;
}
// the pictures made for a queued run: saved on the frame (frame.make.held: [{ name, gen }], make-rules addHeld / settleHeld) and
// dropped once every run that reads them has finished (done, failed, stopped or gone), never by what a slot shows. Settled
// here when the runs end, and again whenever the frame's table shows it (settleHeldOf), so a reload mid-run loses nothing.
// A frame no longer on the open table, its table switched meanwhile, is not written here: its table settles it when it opens.
function holdInputs(frame, names, gens) {
  if (!names.length) return;
  const cur = ofOpenTable(frame);
  if (cur) { cur.make = { ...(cur.make || {}), held: addHeld(cur.make?.held, names, gens) }; frameSaved(); }
  else names.forEach((n) => HOLDING.add(n));   // (not saved anywhere: this page lets it go when its runs end)
  Promise.allSettled(gens.map((g) => waitGen(g.id))).then(() => {
    const now = ofOpenTable(frame);
    if (now) return settleHeldOf(now);
    names.forEach((n) => { if (HOLDING.delete(n)) dropInput(n); });
  });
}
const HOLDING = new Set();   // wire pictures of a run whose frame wasn't on the open table when it was queued
// A frame's held pictures settled by their runs' status: what no waiting run reads goes. Returns once done.
const SETTLING = new Set();
async function settleHeldOf(frame) {
  const held = frame?.make?.held;
  if (!held?.length || SETTLING.has(frame.id)) return;
  SETTLING.add(frame.id);
  try {
    const status = new Map();
    for (const gen of new Set(held.map((x) => x.gen))) {
      const g = S.history.get(gen);
      if (g?.status && g.status !== 'queued' && g.status !== 'running') { status.set(gen, g.status); continue; }
      try { status.set(gen, (await api(`/api/generations/${gen}`, { busy: false }))?.status || null); }
      catch (e) { status.set(gen, e?.status === 404 || /not found/i.test(e?.message || '') ? 'gone' : null); }
    }
    const r = settleHeld(held, (gen) => status.get(gen) ?? null);
    if (!r.drop.length) return;
    r.drop.forEach(dropInput);
    const now = ofOpenTable(frame);
    if (now?.make) {
      const left = settleHeld(now.make.held, (gen) => status.get(gen) ?? null).held;   // (what was added meanwhile stays)
      now.make = { ...now.make, held: left };
      if (!left.length) delete now.make.held;
      frameSaved();
    }
  } finally { SETTLING.delete(frame.id); }
}
// every frame of the open table with held pictures (a reload mid-run: their runs may have ended while the page was away)
function settleTable() {
  let frames = [];
  try { frames = Table.tableFrames() || []; } catch { return; }
  for (const f of frames) if (f?.make?.held?.length) settleHeldOf(f).catch(() => {});
}
// The frame as the open table holds it now, or null when its table isn't the open one any more (a run settling after a
// switch must never change the open table: its result reaches its own frame through that frame's document)
const ofOpenTable = (frame) => (frame?.id ? Table.frameById(frame.id) : null);

// Pick a frame: a picture from the table (or anywhere the picker lists) into a video template's slot. A table frame's picture is
// uploaded by the picker only when picked and the picker doesn't track it: that copy (info.copied) is ours to
// drop with the slot (settleInputs). Anything else the picker hands back is the user's own picture and is never dropped here.
function pickFrame(f, set) {
  const { frame } = makeTarget(P.frames);
  openSourcePicker({ kinds: ['image'], want: 'picture', title: `${f.label}: pick a frame`, frame, mp: () => P.st?.imageMp[f.key] ?? 1,
    onPick: (name, info) => {
      if (info?.copied) P.fresh.push(name);
      set(name);
    } });
}

// ---------------------------------------------------------------------------
// a frame's picture (frame-source.js): the live editor's composite, else its edit drawn off screen, else its still;
// the wires into a frame (wire-rules.js, table.js wiresInto) fill the template's fields that take a picture, clip or sound
// ---------------------------------------------------------------------------
// (once per name in this page: a name let go by one path is never deleted again by another)
const DROPPED = new Set();
const dropInput = (name) => {
  if (!name || DROPPED.has(name)) return Promise.resolve();
  DROPPED.add(name);
  return api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});
};

// ---------------------------------------------------------------------------
// Run: one run per selected frame of the kind (nothing selected: one run, new frames)
// ---------------------------------------------------------------------------
let running = false;
// the action bar's Stop on the table: the chain going, else this device's run
export const stopMake = () => (CHAIN.running ? stopChainNow() : stop());
export async function runMake() {
  if (running) return;
  const sel = selection();
  if (sel !== P.frames) P.frames = sel || [];
  const { kind, frame } = makeTarget(P.frames);
  if (!P.host || P.key !== keyOf(kind, frame) || fieldState() !== P.st) draw();
  const st = P.st, t = st?.tpl;
  if (!t || t.error || P.key !== keyOf(kind, frame)) return toast('Pick a working template first', true);
  if (!templatesForFrame([t], kind, frame).length) return toast(`${t.name} doesn't make anything for ${KIND_WORD[kind]}`, true);
  const targets = kind === 'none' ? [null] : makeFrames(P.frames);
  const noDoc = targets.find((f) => f && DOC_KIND[kind] && !f.doc);
  if (noDoc) return toast(`${noDoc.label || 'A frame'} has no document yet`, true);
  const base = runValues();
  if (!base) return;
  const words = noteText(P.frames), pk = mainPromptKey(t);
  if (words && pk) base[pk] = words.text;
  const builder = words ? null : runBuilder();
  const tableId = Table.activeTableId();   // (new frames for its results go on this table, or to the Shelf if it isn't open then)
  const ran = kind === 'none' ? null : { template: t.id, label: t.name, on: kind, lands: kind, values: setupValues(), fields: t.fields.map((f) => ({ key: f.key, kind: f.kind })),
    seeds: Object.fromEntries(t.fields.filter((f) => f.kind === 'seed').map((f) => [f.key, { mode: st.seedMode?.[f.key] || 'random', value: Number(st.values[f.key]) || 0 }])),
    target: 'layer', batch: S.batch };   // (taken before the runs: an increasing seed moves on as they queue)
  running = true;
  let queued = 0;
  try {
    for (const f of targets) {
      let r = null;
      try {
        r = await queueOne({ kind, f, t, st, base, builder, batch: S.batch, prepare: preparePictures, afterQ: afterQueued });
        await land(kind, f, t, r.gens, r.sent, r.values, tableId);
        if (f) ranWhenDone(f, r.gens, r.stamps);
        dispatchEvent(new CustomEvent('make:queued', { detail: { frame: f, kind, gens: r.gens } }));
        queued += r.gens.length;
      } catch (e) {
        if (r?.sent) dropInput(r.sent.name);
        toast(targets.length > 1 ? `${f?.label || 'A frame'}: ${e.message}` : e.message, true);
      }
    }
    if (queued) toast(`${queued > 1 ? `Queued ${queued}` : 'Queued'}${targets.length > 1 ? ` on ${targets.length} frames` : ''}: ${landsWord(kind)}`);
    if (queued && ran) dispatchEvent(new CustomEvent('make:ran', { detail: ran }));
    if (P.els) drawHead(kind, frame, templatesForFrame(S.templates, kind, frame));
  } finally { running = false; }
}

// One frame's run queued (null: nothing selected, new frames): its own picture and size, the wires into it resolved, the
// pictures prepared (prepare(values, skip)), afterQ(gens, batch) once queued. What a failed step made is dropped here; the
// picture sent is the caller's to drop if landing fails. Returns { gens, sent, values, stamps (what the wires read), before
// (an image frame's layer keys and names before the run, when asked: chain landing) }.
async function queueOne({ kind, f, t, st, base, builder, batch, prepare, afterQ, layersBefore = false }) {
  let sent = null;
  const made = [];   // (inputs made for the wires into this frame)
  try {
    const values = clone(base);
    if (f && (kind === 'image' || kind === 'video')) {   // (each frame's own size)
      const pair = sizePair(t), s = frameSize(pair, Table.frameById(f.id) || f);
      if (s) { values[pair[0].key] = s.w; values[pair[1].key] = s.h; }
    }
    if (f && (kind === 'video' || kind === 'sound')) {   // (each frame's own length)
      const lf = lengthField(t), secs = frameLength(Table.frameById(f.id) || f, t);
      if (lf && secs > 0) values[lf.key] = lengthValue(lf, secs);
    }
    const stamps = f ? await readStamps(f) : null;
    const wired = await resolveWires(kind, f, t, st, values, made);
    // (slots set to this frame's layers: all of them, or one. All of them leaves out what its last chain run made, so a rerun never reads its
    // own last result: main-rules.js withoutMade. The frame's own first slot keeps what it sent for placing the result.)
    if (f && kind === 'image') for (const fld of t.fields) {
      if (fieldKind(fld) !== 'image' || modeIn(kind, f, fld, st) !== 'layers') continue;
      const own = frameImageField(t)?.key === fld.key, src = st.layerSrc?.[fld.key] || {}, cur = Table.frameById(f.id) || f;
      const whole = src.layer === '' || (src.layer === undefined && !cur.main);
      const from = src.layer ? { ...cur, main: src.layer } : src.layer === '' ? { ...cur, main: null } : cur;
      let got;
      try { got = await frameSource(from, { multiple: 16, without: whole ? cur.make?.ran?.made || null : null }); }
      catch (e) { throw /is empty$/.test(e.message) ? new Error(`${fld.label} needs a picture: ${f.label || 'this frame'} is empty. Set it here or plug an input in`) : e; }
      if (own) sent = got; else made.push(got.name);
      const cut = await pictureForRun(got.name, own ? null : src.crop || null, src.mp ?? (own ? 0 : fld.mp ?? 1));
      if (cut !== got.name) made.push(cut);
      values[fld.key] = cut;
      wired.add(fld.key);
    }
    await prepare(values, wired);
    const before = layersBefore && kind === 'image' && f ? layerMarks(await layersOf(f)) : null;   // (keys and names: chain-rules freshLayers)
    const gens = await queueRun({ template: t.id, values, batch, builder, timeout: 120000 });
    afterQ(gens, batch);
    holdInputs(f, made.splice(0), gens);
    return { gens, sent, values, stamps, before };
  } catch (e) {
    if (sent) dropInput(sent.name);
    made.forEach(dropInput);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// what a run read (frame.make.ran, chain-rules.js): the stamp of each source plugged in by an ON wire, read fresh (a source
// open with edits not yet saved is saved first, so the stamp is of what the run reads)
// ---------------------------------------------------------------------------
async function readStamps(f) {
  let ins = [];
  try { ins = (Table.wiresInto(f.id) || []).filter((w) => w.on !== false); } catch { return {}; }
  if (!ins.length) return {};
  const srcs = ins.map((w) => Table.frameById(w.from)).filter(Boolean);
  await Promise.all(srcs.map((x) => flushDoc(x)));
  await freshStamps(srcs).catch(() => {});
  return sourceStamps(Table.tableWires() || [], f.id, Table.tableFrames() || [], frameStamp);
}
// frame.make.ran set (made: what a chain run landed; undefined keeps the last chain run's), saved with the table
function recordRan(f, sources, made = undefined) {
  const cur = ofOpenTable(f);
  if (!cur) return;   // (its table isn't open now: not recorded)
  const was = cur.make?.ran;
  const keepMade = made !== undefined ? made : was?.made;
  cur.make = { ...(cur.make || {}), ran: { at: Date.now(), sources: sources || {}, ...(keepMade ? { made: keepMade } : {}) } };
  frameSaved();
}
// a Run from the pane: what it read is recorded once a run of it is done (its results are added; made stays the chain's)
function ranWhenDone(f, gens, stamps) {
  Promise.allSettled(gens.map((g) => waitGen(g.id))).then((rs) => { if (rs.some((x) => x.status === 'fulfilled')) recordRan(f, stamps); });
}

// ---------------------------------------------------------------------------
// one frame's run, as its own Run would, without the frame being selected or the pane open (chain-run.js)
// ---------------------------------------------------------------------------
// the settings a frame runs with: the pane's own when it shows this frame, else its saved ones (frame.make); null: none
function settingsOf(f) {
  if (P.st?.tpl && P.key === keyOf(f.kind, f)) return P.st;
  const t = templatesForFrame(S.templates, f.kind, f).find((x) => x.id === f.make?.template);
  if (!t) return null;
  const st = settingsFor(t, f.make);
  st.save = () => { const cur = Table.frameById(f.id) || f; cur.make = settingsPayload(st, { ...(cur.make?.inputs ? { inputs: cur.make.inputs } : {}), ...ranOf(cur), ...heldOf(cur) }); frameSaved(); };
  return st;
}
// pictures as their cropped copies, masks with the picture they were painted on (generate.js preparePictures, for these settings)
async function preparePicturesOf(st, values, skip = new Set()) {
  for (const f of st.tpl.fields) {
    if (f.kind !== 'image' || skip.has(f.key)) continue;
    const c = st.imageCrop?.[f.key];
    values[f.key] = await pictureForRun(values[f.key], c && c.src === values[f.key] ? c.crop : null, st.imageMp?.[f.key] ?? 1);
  }
  for (const f of st.tpl.fields) {
    const m = f.kind === 'mask' ? values[f.key] : null;
    if (m?.name) values[f.key] = { ...m, src: values[f.image_key], crop: null };
  }
  return values;
}

export async function runFrame(frame, { batch = 1, replace = false } = {}) {
  const f = ofOpenTable(frame), kind = f?.kind, name = f?.label || frame?.label || 'This frame';
  if (!f) throw new Error(`${name} isn't on the open table`);
  if (kind === 'note') throw new Error('A note has no workflow');
  if (!S.templates?.length) throw new Error('The templates are still loading');
  const st = settingsOf(f), t = st?.tpl;
  if (!t) throw new Error(`${name} has no workflow: pick a template in its Make pane`);
  if (t.error) throw new Error(`${t.name} has an error: pick another template for ${name}`);
  if (DOC_KIND[kind] && !f.doc) throw new Error(`${name} has no document yet`);
  const pk = mainPromptKey(t);
  const builder = pk && st.pb?.on ? { parts: st.pb.parts, subjects: st.pb.subjects } : null;
  const afterQ = (gens, n) => {
    if (st === fieldState()) return afterQueued(gens, n);
    Object.assign(S.lastSeed, seedsAfter(st, gens, n));
    st.save?.();
  };
  const r = await queueOne({ kind, f, t, st, base: runValuesOf(st), builder, batch, prepare: (v, skip) => preparePicturesOf(st, v, skip), afterQ, layersBefore: true });
  dispatchEvent(new CustomEvent('make:queued', { detail: { frame: f, kind, gens: r.gens } }));
  let made;
  try { made = await landNow(kind, f, t, r, replace); } catch (e) { if (r.sent && kind !== 'image') dropInput(r.sent.name); throw e; }
  recordRan(f, r.stamps, replace ? made || [] : undefined);
  if (P.host && onTable()) draw();
  return { gens: r.gens, made };
}

export async function runWith(frame, { template, values = {}, batch = 1 } = {}) {
  const f = ofOpenTable(frame), kind = f?.kind, name = f?.label || frame?.label || 'This frame';
  if (!f) throw new Error(`${name} isn't on the open table`);
  if (!S.templates?.length) throw new Error('The templates are still loading');
  const t = templatesForFrame(S.templates, kind, f).find((x) => x.id === template);
  if (!t) throw new Error(`${template} doesn't make anything for ${KIND_WORD[kind] || 'this frame'}`);
  if (t.error) throw new Error(`${t.name} has an error`);
  if (DOC_KIND[kind] && !f.doc) throw new Error(`${name} has no document yet`);
  const st = settingsFor(t, f.make?.template === t.id ? f.make : null);   // (its own slots and wires; the recorded values over them)
  for (const fld of t.fields) {
    if (values[fld.key] === undefined) continue;
    st.values[fld.key] = clone(values[fld.key]);
    if (fld.kind === 'seed') st.seedMode[fld.key] = 'fixed';   // (the seed is the replay's own: -1 a fresh one)
  }
  const r = await queueOne({ kind, f, t, st, base: runValuesOf(st), builder: null, batch, prepare: (v, skip) => preparePicturesOf(st, v, skip),
    afterQ: (gens, n) => { Object.assign(S.lastSeed, seedsAfter(st, gens, n)); }, layersBefore: true });
  dispatchEvent(new CustomEvent('make:queued', { detail: { frame: f, kind, gens: r.gens } }));
  let made;
  try { made = await landNow(kind, f, t, r, false); } catch (e) { if (r.sent && kind !== 'image') dropInput(r.sent.name); throw e; }
  if (P.host && onTable()) draw();
  return { gens: r.gens, made };
}

// the runs done (the ones that worked); all failed: the first one's error
async function doneRuns(gens) {
  const rs = await Promise.allSettled(gens.map((g) => waitGen(g.id)));
  const ok = rs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw rs.find((x) => x.status === 'rejected')?.reason || new Error('The run failed');
  return ok;
}
// A run's results into its frame, resolving once they are there; replace: in place of what the last chain run made
// (frame.make.ran.made, and nothing else). Returns what landed (layer keys, item ids) where that can be told, else null.
async function landNow(kind, f, t, r, replace) {
  const old = replace ? f.make?.ran?.made || [] : [];
  if (kind === 'image') {
    await landLayers(f, t, r.gens, r.sent);
    const done = await doneRuns(r.gens);
    const names = await waitLayers(f, r.before || new Set(), templateProcess(t.name), done.length);
    if (!names.length) throw new Error(`the result isn't in "${f.label || 'the frame'}" yet (it lands when the frame next opens; the run is in History)`);
    if (replace) await removeLayers(f, keepMain(old, Table.frameById(f.id) || f, { layers: await layersOf(f) }).filter((n) => !names.includes(n)));   // (never the main source)
    await flushDoc(f);
    return names;
  }
  const done = await doneRuns(r.gens);
  if ((kind === 'video' || kind === 'sound') && replace) return landInPlace(kind, f, done, old);
  for (const d of done) {
    if (kind === 'video') await landClips(f, d);
    else if (kind === 'sound') landSounds(f, d);
    else if (kind === 'scene') await landScene(f, d);
    else inShelf(d);
  }
  return null;
}

// an image frame's layers, as they are now: the open editor's when the frame is live, else its saved edit's
function liveEng(f) {
  const eng = CURRENT_EDIT.eng;
  return isLive(f.id) && eng?.E?.tab?.id === f.doc && !eng.docOnly ? eng : null;
}
async function layersOf(f) {
  const eng = liveEng(f);
  if (eng) return eng.E.layers || [];
  return (await api(docUrl('image', f.doc), { busy: false }).catch(() => null))?.payload?.layers || [];
}
// the layers a run landed (imagetools.js landMade names them after the template): up to a minute for them to be there
async function waitLayers(f, before, label, want) {
  let names = [];
  for (let i = 0; i < 120; i++) {
    names = freshLayers(before, await layersOf(f), label);
    if (names.length >= want) break;
    await new Promise((go) => setTimeout(go, 500));
  }
  return names;
}
// the last chain run's layers (by key) out of the frame, and only those: from the open editor, else from the saved edit
async function removeLayers(f, names) {
  if (!names.length) return;
  const eng = liveEng(f);
  if (eng) {
    const r = withoutLayers(eng.E.layers, names);
    if (!r.removed) return;
    eng.E.layers = normalize(r.layers, eng.E.groups || []);
    if (eng.E.sel && !eng.E.layers.includes(eng.E.sel)) eng.E.sel = null;
    if (Array.isArray(eng.E.multi)) eng.E.multi = eng.E.multi.filter((l) => eng.E.layers.includes(l));
    eng.changed(); eng.render();
    return;
  }
  const changed = await editDoc('image', f.doc, (p) => {
    const r = withoutLayers(p.layers, names);
    if (!r.removed) return false;
    p.layers = normalize(r.layers, p.groups || []);
  });
  if (!changed) return;
  try { await (await import('./frame-image.js')).drawOffscreen(f.doc); } catch (e) { console.warn(e); }
  Table.refreshStills(['image']).catch(() => {});
}
// a video or sound frame: the run's outputs into its saved document, the first in place of the last chain run's item (its
// track, place, trim start and transform kept), the rest at the end; an open timeline saves first and picks it up after
async function landInPlace(kind, f, done, old) {
  const medias = [];
  for (const d of done) {
    for (const [index, o] of (d.outputs || []).entries()) {
      const ok = kind === 'video' ? o.kind === 'video' || o.kind === 'image' : o.kind === 'audio';
      if (!ok) continue;
      const dur = o.kind === 'image' ? 0 : o.duration || await durationOf(o.url);
      medias.push({ kind: o.kind, src: { generation: d.id, index }, url: o.url, label: resultName(d, S.templates), dur });
    }
  }
  if (!medias.length) { done.forEach(inShelf); return old; }
  await flushDoc(f);
  let made = old;
  const newId = () => Math.random().toString(36).slice(2, 10);
  await editDoc(kind, f.doc, (p) => {
    const r = placeResults(p, keepMain(old, Table.frameById(f.id) || f, p), medias, { append: kind === 'video' ? withClip : withSoundItem, newId });   // (never in place of the main source)
    made = r.made;
    Object.assign(p, r.payload);
  });
  Table.refreshStills([kind]).catch(() => {});
  return made;
}

function land(kind, frame, t, gens, sent, values, tableId = Table.activeTableId()) {
  if (kind === 'image') return landLayers(frame, t, gens, sent);
  for (const g of gens) {
    waitGen(g.id).then((done) => (kind === 'none' ? landFrames(done, values, t, tableId) : kind === 'video' ? landClips(frame, done)
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
    landMade(frame.doc, src, g, { label: templateProcess(t.name), nth: i });
    waitGen(g.id).catch(() => {}).finally(() => setTimeout(() => { if (P.host) draw(); }, 1500));   // (the count of runs on the way)
  });
}

// nothing selected: each output a new frame beside the last one
async function landFrames(done, values, t, tableId = Table.activeTableId()) {
  if (Table.activeTableId() !== tableId) {   // (another table is open now: the result never lands on that one)
    const name = Table.tableName(tableId);
    return toast(`#${done.id} is done; it was made on ${name ? `"${name}"` : 'another table'}, so it is in the Shelf`, false,
      { label: 'On the table…', fn: async () => (await import('./useas.js')).openUseAs(done, 0) });
  }
  const pair = sizePair(t), size = pair ? { w: Number(values[pair[0].key]) || 1024, h: Number(values[pair[1].key]) || 1024 } : { w: 1024, h: 1024 };
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'image' || o.kind === 'video');
  if (!outs.length) return inShelf(done);
  for (const { o, index } of outs) {
    if (Table.activeTableId() !== tableId) return inShelf(done);
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
    if (await landClip(frame, { kind: o.kind, src: { generation: done.id, index }, url: o.url, label: resultName(done, S.templates), dur: o.duration || 0 }, false)) n++;
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

// (the run line and the sampling preview are run-strip.js's: one strip for every pane and every kind of frame)
mountRunStrip();

// ---------------------------------------------------------------------------
// wiring: the selection on the table, a frame going live, leaving the table
// ---------------------------------------------------------------------------
addEventListener('table:select', (e) => { P.table = e.detail?.table || P.table; renderMake(P.host, e.detail?.frames || []); settleTable(); });
addEventListener('table:live', (e) => { P.table = e.detail?.table || P.table; if (e.detail?.frame) renderMake(P.host, [e.detail.frame]); });
addEventListener('table:unlive', () => { if (P.host) draw(); });
addEventListener('table:open', () => setTimeout(settleTable, 0));   // (a table opened: its frames' held wire pictures settled)
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

