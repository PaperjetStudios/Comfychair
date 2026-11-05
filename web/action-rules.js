// Recorded actions (a short set of runs to repeat on other frames, layers or clips), their rules with no DOM
// (node --test tests/action_rules.test.mjs). web/actions.js records, plays and draws; this decides what may be recorded,
// what a replay runs, and where each step's result is picked up for the next. Plain data in, plain data out.
//
// A step: { kind: 'image'|'video'|'sound'|'scene'|'make', op (an Edit op id, or a template id for make), label, values,
//   target: 'frame'|'layer'|'self', batch, scope?: 'whole'|'selected' (image), on?, lands?, seeds? (make) }
// A play target: { id, mode: 'frames'|'layers'|'clips', frame, label, layer?, item?, main? }; id never changes while it plays.
// A play state: { n, step, pending: [ids], targets: [live targets], failed: [{ id, label, step, why }], done, stopped? }
//
//   stepOf(ev, keys?)              { step, why }: the event of a run as a step (step null and why set when it can't be recorded)
//   cleanValues(kind, op, values, keys?)   the values less what belongs to one run (marks, the red mask, a take's own content)
//   isTerminal(step)               true when nothing can follow it (it places its own result, or lands in another kind of frame)
//   canAppend(steps, step)         '' when step may follow steps, else why not
//   targetsFor(ctx)                { mode, kind, targets } what a play runs on: ctx { kind, scope, frames, openFrame, layers, clips, mode? }
//   canPlay(steps, mode, kind)     '' when the set can run on targets of that mode and kind, else why not
//   replayValues(step, index)      the step's values for target number index, seeds made fresh / kept / stepped
//   nextTarget(target, step, result)  the target after a step ran: result { into, layer, items, gens }; null when it can't go on
//   itemsOfRuns(items, genIds)     the items made by those runs (src.generation)
//   planPlay(steps, targets)       the first play state
//   advance(state, id, outcome)    a new state: outcome { ok: true, next } puts the target on, { ok: false, why } drops only it
//   stop(state)                    a new state that has stopped (what ran stays)
//   summary(state, name)           the end toast: "Night look: 4 of 5 done; Frame B failed at step 2 (reason)"
//   describeStep(step, index?)     one line for the step list: "1 Edit from a prompt · 'night' · layer"
import { KIND_WORD, defaultTarget, opById, resultKind, targetsOf, whyNot } from './edit-rules.js';
import { NOT_SETUP } from './vfx-rules.js';
import { omit } from './setups-rules.js';

// Not imported (edit-ops.js and make-panel.js pull in the DOM): copied from edit-ops.js PER_SHOT and make-panel.js
// SHOT_KINDS. stepOf and cleanValues take them as an argument so the callers can pass the real lists.
export const PER_SHOT = [...new Set(['matte', 'first', ...NOT_SETUP])];
export const SHOT_KINDS = ['image', 'video', 'boxes', 'seed', 'mask'];
// ops that make nothing to carry on with (they open something outside)
const NO_RESULT = ['scene:blender'];
// each pair: the seed's value key and its mode key, as an Edit op keeps them (Image Edit: eseed / eseedMode)
const SEED_KEYS = [['eseed', 'eseedMode'], ['seed', 'seedMode']];

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const KINDS = ['image', 'video', 'sound', 'scene'];

// What one run owns is left out: the same list a saved setup leaves out, and for a take the fields that hold its content.
export function cleanValues(kind, op, values, { perShot = PER_SHOT, shotKinds = SHOT_KINDS, fields = [] } = {}) {
  if (kind !== 'make') return omit(values, perShot);
  // a take's values are keyed by field; the kind of the field says what it holds
  const drop = fields.filter((f) => shotKinds.includes(f?.kind)).map((f) => f.key);
  return omit(values, drop);
}

// Why a run can't be recorded ('' when it can). Unknown or unprovable ops are refused: a step that can't replay is worse than none.
function whyNotRecorded(kind, op, ev) {
  if (!KINDS.includes(kind)) return 'Unknown kind of edit';
  if (!op) return 'Unknown edit';
  if (op.takes) return `${op.label} takes other kinds of frame, so it can't repeat on one`;
  if (NO_RESULT.includes(`${kind}:${op.id}`)) return `${op.label} opens something outside and makes nothing`;
  const why = whyNot(op, { live: false, opts: ev.values || {} });
  if (why) return why;
  // the red mask painted on the open frame (the op's own rule covers ewhere, swapWhere and skinWhere)
  if (kind === 'image' && ev.values?.rfrom === 'painted') return 'The area is painted on the open frame';
  return '';
}

export function stepOf(ev, keys = {}) {
  const e = ev?.step || ev || {}, kind = e.kind;
  const refuse = (why) => ({ step: null, why });
  if (kind === 'make') {
    const id = e.template || e.op;
    if (!id) return refuse('No template to repeat');
    if (!KINDS.includes(e.on)) return refuse('The frame it ran on is unknown');
    const step = { kind, op: id, label: e.label || id, on: e.on, values: cleanValues('make', id, e.values || {}, keys),
      target: e.target === 'layer' || e.target === 'self' ? e.target : 'frame', batch: clampBatch(e.batch) };
    if (e.lands) step.lands = e.lands;
    const seeds = seedsOf(e.seeds);
    if (Object.keys(seeds).length) step.seeds = seeds;
    return { step, why: '' };
  }
  const op = KINDS.includes(kind) ? opById(kind, e.op) : null;
  const why = whyNotRecorded(kind, op, e);
  if (why) return refuse(why);
  const step = { kind, op: op.id, label: e.label || op.label, values: cleanValues(kind, op.id, e.values || {}, keys),
    target: targetsOf(op).includes(e.target) ? e.target : defaultTarget(op, false), batch: op.once ? 1 : clampBatch(e.batch) };
  if (kind === 'image') step.scope = e.scope === 'selected' ? 'selected' : 'whole';
  return { step, why: '' };
}

const clampBatch = (n) => Math.max(1, Math.min(32, Math.round(Number(n) || 1)));
// a take's seed fields: { key: { mode, value } } with a mode that is known
function seedsOf(seeds) {
  const out = {};
  for (const [k, s] of Object.entries(seeds || {})) {
    const mode = ['random', 'fixed', 'increment'].includes(s?.mode) ? s.mode : 'random';
    out[k] = { mode, value: Number(s?.value) || 0 };
  }
  return out;
}

// what kind of frame a step reads, and what kind its result lands in
const inKind = (s) => (s.kind === 'make' ? s.on : s.kind);
const outKind = (s) => (s.kind === 'make' ? s.lands || s.on : resultKind(opById(s.kind, s.op)));

// A result that places itself (a grabbed frame, a 3D object, an H3 upscale) or lands in a frame of another kind of its own
// (a photo in 3D, a track) can't be followed: where it went isn't known. Grab is the one that goes on: it makes an image frame.
export function isTerminal(step) {
  if (!step || step.kind === 'make') return false;
  const op = opById(step.kind, step.op);
  if (!op) return true;
  if (step.kind === 'video' && step.op === 'grab') return false;
  return !!op.selfLands || (!!op.newFrame && resultKind(op) !== op.kind);
}

export function canAppend(steps, step) {
  const last = (steps || [])[(steps || []).length - 1];
  if (!last) return '';
  if (isTerminal(last)) return `Nothing can follow "${last.label}": its result is a frame of its own`;
  if (outKind(last) !== inKind(step)) return `"${step.label}" works on ${KIND_WORD[inKind(step)] || inKind(step)}, and "${last.label}" makes ${KIND_WORD[outKind(last)] || outKind(last)}`;
  return '';
}

// What a play runs on. Pictures with "selected layers" run on the open frame's picked layers; a clip or sound set runs on the
// open frame's picked clips when it has any; otherwise it is the selected frames of the first step's kind (notes and other kinds left out).
export function targetsFor(ctx = {}) {
  const kind = ctx.kind, open = ctx.openFrame || null;
  const mode = ctx.mode || (kind === 'image' && ctx.scope === 'selected' ? 'layers'
    : (kind === 'video' || kind === 'sound') && open?.kind === kind && (ctx.clips || []).length ? 'clips' : 'frames');
  const name = (f) => f.label || f.id;
  if (mode === 'layers') {
    const ok = open?.kind === 'image';
    return { mode, kind, targets: ok ? [...new Set(ctx.layers || [])].map((k) => ({ id: k, mode, frame: open.id, label: `${name(open)} layer`, layer: k })) : [] };
  }
  if (mode === 'clips') {
    const ok = open && open.kind === kind;
    return { mode, kind, targets: ok ? [...new Set(ctx.clips || [])].map((c) => ({ id: c, mode, frame: open.id, label: `${name(open)} clip`, item: c })) : [] };
  }
  const seen = new Set(), targets = [];
  for (const f of ctx.frames || []) {
    if (!f || f.kind !== kind || seen.has(f.id)) continue;
    seen.add(f.id);
    targets.push({ id: f.id, mode: 'frames', frame: f.id, label: name(f) });
  }
  return { mode: 'frames', kind, targets };
}

// '' when the set can run on targets of this mode and kind. Layers and clips stay in their frame, so every step has to
// work on that kind and land back in it.
export function canPlay(steps, mode, kind) {
  if (!steps?.length) return 'Record some steps first';
  const first = steps[0], word = (k) => KIND_WORD[k] || k;
  for (const [i, s] of steps.entries()) if (s.kind !== 'make' && !opById(s.kind, s.op)) return `Step ${i + 1} "${s.label}" is no longer available`;
  if (inKind(first) !== kind) return `This set starts on ${word(inKind(first))}, and the selection is ${word(kind)}`;
  if (mode === 'layers' || mode === 'clips') {
    const need = mode === 'layers' ? 'image' : kind;
    if (mode === 'layers' && kind !== 'image') return 'Layers are pictures: this set starts on ' + word(inKind(first));
    if (mode === 'clips' && kind !== 'video' && kind !== 'sound') return 'Clips are in a video or sound frame: this set starts on ' + word(inKind(first));
    for (const [i, s] of steps.entries()) {
      if (s.kind === 'make') return `Step ${i + 1} "${s.label}" makes from the whole frame: select the frames on the table to play it`;
      if (inKind(s) !== need) return `Step ${i + 1} "${s.label}" works on ${word(inKind(s))}, and these are ${mode === 'layers' ? 'layers' : 'clips'} of ${word(need)}`;
      if (s.target === 'frame') return `Step ${i + 1} "${s.label}" makes a new frame; on ${mode === 'layers' ? 'layers' : 'clips'} it has to land in the same frame`;
    }
  }
  return '';
}

// A step's values for the index-th target. Random: a fresh seed each (-1). Fixed: the recorded seed on all. Increment: the
// recorded seed + index * batch, so no two targets share one (and each batch fits between them).
const seedFor = (mode, base, index, batch) => (mode === 'random' ? -1 : mode === 'increment' ? base + index * batch : base);
export function replayValues(step, index = 0) {
  const values = clone(step?.values || {}), batch = step?.batch || 1;
  for (const [vk, mk] of SEED_KEYS) {
    if (values[vk] === undefined && values[mk] === undefined) continue;
    const mode = values[mk] ?? 'random';
    values[vk] = seedFor(mode, Number(values[vk]) || 0, index, batch);
    values[mk] = mode === 'increment' ? 'fixed' : mode;   // the seed is already stepped: the tool must use it as it is
  }
  for (const [key, s] of Object.entries(step?.seeds || {})) values[key] = seedFor(s.mode, s.value, index, batch);
  return values;
}

// The items a set of runs made (an item's src.generation names its run)
export const itemsOfRuns = (items, genIds) => {
  const ids = new Set(genIds || []);
  return (items || []).filter((it) => ids.has(it?.src?.generation ?? it?.src?.gen));
};

// Where the next step starts. frames: 'frame' goes into the new frame, 'layer' stays in the frame with the landed layer as its
// main one, 'self' stays. layers: the layer the step made. clips: the clip a run made. null when the result doesn't say.
export function nextTarget(target, step, result = {}) {
  if (!target) return null;
  if (target.mode === 'layers') return result.layer ? { ...target, layer: result.layer } : null;
  if (target.mode === 'clips') {
    const made = itemsOfRuns(result.items, result.gens)[0];
    return made ? { ...target, item: made.id } : null;
  }
  if (step?.target === 'frame') {
    if (!result.into) return null;
    const { main, ...rest } = target;   // (the old frame's main layer means nothing in the new one)
    return { ...rest, frame: result.into };
  }
  if (step?.target === 'layer') return result.layer ? { ...target, main: result.layer } : null;
  return { ...target };
}

export function planPlay(steps, targets) {
  const list = (targets || []).map((t) => ({ ...t }));
  return { n: (steps || []).length, step: 0, pending: list.map((t) => t.id), targets: list, failed: [], done: !(steps || []).length || !list.length };
}

// One target landed (ok, with its next target) or failed. A failure drops only that target. When every target of the step
// has answered, the next step starts for the ones still live.
export function advance(state, id, outcome = {}) {
  if (state.done || !state.pending.includes(id)) return state;
  const s = { ...state, pending: state.pending.filter((p) => p !== id), targets: [...state.targets], failed: [...state.failed] };
  const at = s.targets.findIndex((t) => t.id === id), t = s.targets[at];
  if (outcome.ok && outcome.next) s.targets[at] = { ...outcome.next, id };
  else {
    s.targets.splice(at, 1);
    s.failed.push({ id, label: t?.label || id, step: state.step, why: outcome.why || 'it did not finish' });
  }
  if (!s.pending.length) {
    s.step += 1;
    s.pending = s.step < s.n ? s.targets.map((x) => x.id) : [];
    s.done = s.step >= s.n || !s.targets.length;
  }
  return s;
}

export const stop = (state) => ({ ...state, done: true, stopped: true, pending: [] });

export function summary(state, name = 'Actions') {
  const total = state.targets.length + state.failed.length;
  if (!total) return `${name}: nothing to run on`;
  const fails = state.failed.map((f) => `${f.label} failed at step ${f.step + 1} (${f.why})`);
  // a stopped play: those still live didn't finish
  const ok = state.stopped ? 0 : state.targets.length;
  return [`${name}: ${ok} of ${total} done${state.stopped ? ', stopped' : ''}`, ...fails].join('; ');
}

const promptOf = (values) => {
  const key = ['eprompt', 'prompt', 'text'].find((k) => typeof values?.[k] === 'string' && values[k].trim())
    || Object.keys(values || {}).find((k) => /prompt/i.test(k) && typeof values[k] === 'string' && values[k].trim());
  const t = key ? values[key].trim().replace(/\s+/g, ' ') : '';
  return t.length > 24 ? `'${t.slice(0, 23)}…'` : t ? `'${t}'` : '';
};
export function describeStep(step, index) {
  const parts = [step?.label || step?.op || 'Step', promptOf(step?.values), step?.target || 'frame'];
  if ((step?.batch || 1) > 1) parts.push(`× ${step.batch}`);
  const line = parts.filter(Boolean).join(' · ');
  return index == null ? line : `${index} ${line}`;
}
