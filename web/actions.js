// Recorded actions: a short set of runs, recorded as they are made and played again on other frames or layers. The rules
// (what may be recorded, what a replay sends, where each step's result is picked up) are web/action-rules.js; this
// listens, plays and draws the row at the top of the Edit pane (edit-panel.js mounts it).
//
// Recording hears the runs that went: edit:ran (edit-run.js runOnFrames: the Edit pane and the frame menu; imagetools.js:
// the Layers pane's Image tools) and make:ran (make-panel.js Run on frames). Each becomes a step with its prompt and
// settings, never the picture, the red mask or the marks; one that can't replay is refused with "Not recorded: <why>".
// The steps are kept on this device (deck.actions.steps) and saved as a set in the saved setups (key `action`, global).
//
// Play runs step 1 for every target, waits for each result to land, then step 2 on that result, and so on. Targets
// (action-rules.js targetsFor): the selected frames of the first step's kind, or, when the first step ran on selected
// layers, the open picture's picked layers. A target that fails drops out; the others go on. Runs go only through
// edit-run.js runOnFrames (replay) and make-panel.js runWith, so they queue as any run does.
//
//   actionsRow()      the row element (one, kept: the pane puts it at its top on each draw)
//   actionsPlaying()  true while a set is playing (the Edit pane's Run waits)
import { h, button, info, store, toast, clone } from './ui.js';
import { CURRENT_EDIT } from './core.js';
import { liveFrame } from './live.js';
import { waitGen } from './make.js';
import { opById } from './edit-rules.js';
import { setupsRow, pickedSetup, setupsReady } from './setups.js';
import { differs } from './setups-rules.js';
import { pickedIds } from './timeline-rules.js';
import { stepOf, canAppend, targetsFor, canPlay, replayValues, nextTarget, planPlay, advance, stop, summary, describeStep } from './action-rules.js';

const KEY = 'action', STEPS = 'deck.actions.steps';
const loadSteps = () => { try { const s = store.get(STEPS, []); return Array.isArray(s) ? s : []; } catch { return []; } };
const A = { recording: false, steps: loadSteps(), play: null, stopped: false, el: null, open: false, why: '' };
// (each named in full: the server versions only a quoted './x.js', and an unversioned URL would be a second copy of the module)
const LOAD = { 'imagetools': () => import('./imagetools.js'), 'edit-ops': () => import('./edit-ops.js'), 'edit-run': () => import('./edit-run.js'),
  'make-panel': () => import('./make-panel.js'), 'table': () => import('./table.js'), 'video': () => import('./video.js'), 'sound': () => import('./sound.js') };
const mods = {};
const need = (n) => (mods[n] ||= LOAD[n]());

const keep = () => { try { store.set(STEPS, A.steps); } catch { /* storage off: they last this page */ } };
const fire = (name, detail) => dispatchEvent(new CustomEvent(name, { detail }));
export const actionsPlaying = () => !!A.play;

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------
const usable = (l) => l && !l.mask && !l.draft && !l.maskOf && !l.broken && l.name;
const openEng = (frame) => {
  const eng = CURRENT_EDIT.eng;
  return frame && eng?.E?.tab?.id === frame.doc && !eng.docOnly ? eng : null;
};
const pickedLayers = (frame) => (openEng(frame)?.picked?.() || []).filter(usable);

async function record(ev, keys = {}) {
  const { step, why } = stepOf(ev, keys);
  if (!step) return toast(`Not recorded: ${why}`, true);
  const no = canAppend(A.steps, step);
  if (no) return toast(`Not recorded: ${no}`, true);
  A.steps = [...A.steps, step];
  keep(); draw();
  toast(`Recorded step ${A.steps.length}: ${step.label}`);
}

addEventListener('edit:ran', async (e) => {
  if (!A.recording || A.play) return;
  const { step: s = {}, frames } = e.detail || {};
  const ev = { ...s };
  if (s.kind === 'image' && !s.scope) {   // (the Edit pane: on the open frame with the result as a layer, the picked layers when that is the choice)
    const { toolState } = await need('imagetools');
    const one = frames?.length === 1 ? frames[0] : null;
    ev.scope = one && liveFrame()?.id === one.id && s.target === 'layer' && toolState().scope === 'selected' && pickedLayers(one).length ? 'selected' : 'whole';
  }
  const { PER_SHOT } = await need('edit-ops');
  record(ev, { perShot: PER_SHOT });
});
addEventListener('make:ran', async (e) => {
  if (!A.recording || A.play) return;
  const d = e.detail || {}, { SHOT_KINDS } = await need('make-panel');
  record({ kind: 'make', ...d }, { fields: d.fields || [], shotKinds: [...SHOT_KINDS] });
});

// ---------------------------------------------------------------------------
// what a play runs on
// ---------------------------------------------------------------------------
let LAYER_N = 0;
const TOKENS = new WeakMap(), LAYERS = new Map();
const tokenOf = (l) => { if (!TOKENS.has(l)) { const t = `layer-${++LAYER_N}`; TOKENS.set(l, t); LAYERS.set(t, l); } return TOKENS.get(l); };
const inKind = (s) => (s?.kind === 'make' ? s.on : s?.kind);
const CLIPS_WHY = 'Playing on picked clips isn\'t ready yet (each step works on a frame\'s first clip): unpick the clips, or close the frame, to play on the selected frames';

let VIDEO = null, SOUND = null;
need('video').then((m) => { VIDEO = m; }).catch(() => {});
need('sound').then((m) => { SOUND = m; }).catch(() => {});
function pickedClips(open) {
  const s = open?.kind === 'video' ? VIDEO?.videoDebug?.().V : open?.kind === 'sound' ? SOUND?.soundDebug?.().N : null;
  return s ? pickedIds(s) : [];
}
function selectedFrames() {
  try { return (mods.tableMod?.selectedFrames?.() || []).filter((f) => f.kind !== 'note'); } catch { return []; }
}
need('table').then((m) => { mods.tableMod = m; draw(); }).catch(() => {});

// { mode, kind, targets, why } for the steps now
function plan(steps = A.steps) {
  const first = steps[0], open = liveFrame();
  const ctx = { kind: inKind(first), scope: first?.scope, frames: selectedFrames(), openFrame: open };
  if (ctx.kind === 'image' && ctx.scope === 'selected') ctx.layers = pickedLayers(open).map(tokenOf);
  if ((ctx.kind === 'video' || ctx.kind === 'sound') && open?.kind === ctx.kind) ctx.clips = pickedClips(open);
  const p = targetsFor(ctx);
  let why = canPlay(steps, p.mode, p.kind);
  if (!why && p.mode === 'clips') why = CLIPS_WHY;
  if (!why && p.mode === 'layers' && !openEng(open)) why = 'Open the picture whose layers it plays on';
  if (!why && !p.targets.length) why = p.mode === 'layers' ? 'Pick the layers to play it on' : `Select the ${p.kind === 'scene' ? '3D' : p.kind} frames to play it on`;
  return { ...p, why };
}
const playWords = (p) => {
  const n = p.targets.length, word = p.mode === 'layers' ? 'layer' : p.mode === 'clips' ? 'clip' : 'frame';
  return n ? `▶ on ${n} ${word}${n === 1 ? '' : 's'}` : '▶ Play';
};

// ---------------------------------------------------------------------------
// play
// ---------------------------------------------------------------------------
const frameOf = (id) => mods.tableMod?.frameById?.(id) || null;
const settledRuns = (gens) => Promise.allSettled((gens || []).map((g) => waitGen(g.id)));
// an image frame's edit with nothing on its way any more (imagetools.js counts its runs and its saves)
async function quiet(tab, IT) {
  while (IT.inFlight(tab) > 0 && !A.stopped) await new Promise((go) => setTimeout(go, 400));
}

// One step on one target, queued; resolves { wait } (a promise of the outcome once it has landed) or an outcome now.
async function queueStep(step, target, index, landed) {
  const values = replayValues(step, index), frame = frameOf(target.frame);
  if (!frame) return { ok: false, why: 'its frame is gone' };
  if (step.kind === 'make') {
    const MP = await need('make-panel');
    let queued;
    const wasQueued = new Promise((go) => { queued = go; });
    const onQ = (e) => { if (e.detail?.frame?.id === frame.id) queued(); };
    addEventListener('make:queued', onQ);
    const run = MP.runWith(frame, { template: step.op, values, batch: step.batch || 1 })
      .then((r) => ({ ok: true, next: nextTarget(target, step, { layer: r.made?.[0] || r.gens?.[0]?.id || 'landed' }) }), (e) => ({ ok: false, why: e.message }))
      .finally(() => { removeEventListener('make:queued', onQ); queued(); });
    await wasQueued;   // (each target's run in the queue before the next one's, in order)
    return { wait: run };
  }
  const op = opById(step.kind, step.op);
  if (!op) return { ok: false, why: `"${step.label}" is no longer available` };
  const [ER, EO, IT] = await Promise.all([need('edit-run'), need('edit-ops'), need('imagetools')]);
  let layers = null, layer = null;
  if (step.kind === 'image') {
    IT.setToolValues(op.id, values);
    if (target.mode === 'layers') {
      layer = LAYERS.get(target.layer);
      const eng = openEng(frame);
      if (!eng || !layer || !eng.E.layers.includes(layer)) return { ok: false, why: 'its layer is gone, or the picture was closed' };
      layers = [layer];
    } else layers = [];   // (a frame: its whole picture)
  }
  const opts = step.kind === 'image' ? EO.optsOf('image', op.id) : { ...clone(EO.OP_DEFAULTS[`${step.kind}:${op.id}`] || {}), ...values };
  const t = target.mode === 'layers' ? 'layer' : step.target;
  const res = await ER.runOnFrames(op, [frame], opts, { batch: step.batch || 1, target: t, selection: [frame], replay: true, layers });
  const r = res.results?.[0];
  if (!r) return { ok: false, why: res.failed?.[0]?.error || res.skipped?.[0]?.why || 'it wasn\'t sent' };
  const wait = (async () => {
    const into = r.into || frame;
    if (step.kind === 'image') {
      const rs = await settledRuns(r.gens);
      if (rs.length && rs.every((x) => x.status === 'rejected')) return { ok: false, why: rs[0].reason?.message || 'the run failed' };
      await quiet(into.doc, IT);
      const mine = landed.find((d) => (layer ? d.from === layer : d.tab === into.doc));
      if (!mine) return { ok: false, why: 'its result didn\'t land' };
      return { ok: true, next: nextTarget(target, { ...step, target: t }, { into: into.id, layer: mine.layer ? tokenOf(mine.layer) : 'landed' }) };
    }
    try {
      if (r.job) await r.job;
      else if (r.gens?.length) {
        const rs = await settledRuns(r.gens);
        if (rs.every((x) => x.status === 'rejected')) return { ok: false, why: rs[0].reason?.message || 'the run failed' };
      }
    } catch (e) { return { ok: false, why: e?.message || String(e) }; }
    return { ok: true, next: nextTarget(target, { ...step, target: t }, { into: into.id, layer: r.gens?.[0]?.id || 'landed' }) };
  })();
  return { wait };
}

async function play() {
  if (A.play) return;
  const steps = clone(A.steps), p = plan(steps);
  if (p.why) return toast(p.why, true);
  const set = pickedSetup(KEY), name = set && !differs(set.values, { v: 1, steps }) ? set.name : 'Actions';
  const IT = await need('imagetools');
  const kept = new Map();   // (the Image tools' settings, put back once it is over)
  for (const s of steps) if (s.kind === 'image' && !kept.has(s.op)) kept.set(s.op, IT.toolValues(s.op));
  const order = new Map(p.targets.map((t, i) => [t.id, i]));
  A.stopped = false; A.recording = false;
  let st = planPlay(steps, p.targets);
  A.play = st;
  draw(); fire('make:state');
  const landed = [];
  const onLanded = (e) => landed.push(e.detail || {});
  addEventListener('imagetools:landed', onLanded);
  try {
    while (!st.done) {
      if (A.stopped) { st = stop(st); break; }
      const step = steps[st.step], now = st.step;
      landed.length = 0;
      const waits = [];
      for (const target of st.targets) {
        if (A.stopped) break;
        let out;
        try { out = await queueStep(step, target, order.get(target.id) ?? 0, landed); } catch (e) { out = { ok: false, why: e?.message || String(e) }; }
        if (out.wait) waits.push(out.wait.then((o) => [target.id, o], (e) => [target.id, { ok: false, why: e?.message || String(e) }]));
        else waits.push(Promise.resolve([target.id, out]));
      }
      if (A.stopped) { st = stop(st); break; }
      A.play = { ...st, queued: true }; draw();
      const outs = await Promise.race([Promise.all(waits), stopped()]);
      if (!outs) { st = stop(st); break; }
      for (const [id, o] of outs) st = advance(st, id, o.ok && !o.next ? { ok: false, why: 'where its result went isn\'t known' } : o);
      if (st.step === now) break;   // (nothing answered: never loop on the same step)
      A.play = st; draw();
    }
  } finally {
    removeEventListener('imagetools:landed', onLanded);
    for (const [op, v] of kept) IT.setToolValues(op, v);
    A.play = null; A.stopped = false;
    LAYERS.clear();
    toast(summary(st, name), !!st.failed.length);
    draw(); fire('make:state');
  }
}
let stopWake = null;
const stopped = () => new Promise((go) => { stopWake = () => go(null); });
function stopPlay() {
  if (!A.play) return;
  A.stopped = true;
  stopWake?.();
}

// ---------------------------------------------------------------------------
// the row
// ---------------------------------------------------------------------------
const HELP = 'Record, then run Edit pane tools, Image tools in the Layers pane, or Make on frames: each run is a step, with its prompt and settings '
  + '(not the picture, the red mask or marks; moves, adjustments and masks by hand aren\'t recorded). A run that needs the open frame (a painted area, '
  + 'marks, Inpaint, Extend) isn\'t recorded. Save the steps as a set to keep them for every project. Play runs the set on the selected frames of the '
  + 'kind it starts on, or, when its first step ran on selected layers, on the open picture\'s picked layers: step 1 on all of them, then each next '
  + 'step on what the step before made. With a batch, only the first result goes on; the others stay as variations. A frame that fails drops out and '
  + 'the others go on; what it made stays. Seeds: random gets a fresh one each, fixed keeps it, increasing steps on per target.';

let setupsEl = null;
export function actionsRow() {
  if (!A.el) {
    A.el = h('div', { class: 'actions-row' });
    setupsEl = setupsRow({ key: KEY, label: 'Action set', get: () => ({ v: 1, steps: clone(A.steps) }),
      set: (v) => { if (A.play) return toast('Stop the set playing first', true); A.steps = clone(v?.steps || []); keep(); draw(); } });
  }
  draw();
  return A.el;
}

function draw() {
  const el = A.el;
  if (!el) return;
  const n = A.steps.length, p = A.play ? null : plan();
  if (p) shown = `${playWords(p)}|${p.why}`;
  const rec = button(A.recording ? `■ Recording · ${n} step${n === 1 ? '' : 's'}` : '● Record', () => {
    A.recording = !A.recording;
    if (A.recording) toast('Recording: each run you make now is a step');
    draw();
  }, { cls: `small actions-rec${A.recording ? ' on' : ''}`, 'aria-pressed': String(A.recording), disabled: !!A.play,
    title: A.recording ? 'Stop recording' : 'Record the runs you make as steps' });
  const playing = A.play ? `Step ${Math.min(A.play.step + 1, A.play.n)} of ${A.play.n} · ${A.play.targets.length} going` : null;
  const go = A.play
    ? button('■ Stop', stopPlay, { cls: 'small actions-stop', title: 'Stop after what is being sent: what ran stays' })
    : button(playWords(p), () => play().catch((e) => toast(e.message, true)), { cls: 'small primary actions-play', disabled: !!p.why, title: p.why || `Play the ${n} step${n === 1 ? '' : 's'}` });
  const list = h('details', { class: 'actions-steps', open: A.open, ontoggle: (e) => { A.open = e.target.open; } },
    h('summary', {}, n ? `${n} step${n === 1 ? '' : 's'}` : 'No steps yet'),
    ...A.steps.map((s, i) => h('div', { class: 'actions-step' + (A.play && A.play.step === i ? ' now' : '') },
      h('span', {}, describeStep(s, i + 1)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Take out step ${i + 1}`, title: 'Take this step out', disabled: !!A.play,
        onclick: () => { A.steps = A.steps.filter((_, j) => j !== i); keep(); draw(); } }, '×'))));
  el.replaceChildren(h('div', { class: 'row wrap actions-bar' }, rec, go, playing ? h('span', { class: 'hint actions-now' }, playing) : null, info(HELP, 'About recorded actions')),
    setupsEl, list);
}

// what Play says follows the selection, the open frame and its picked layers
let due = 0, shown = '';
const later = () => {
  if (due) return;
  due = requestAnimationFrame(() => {
    due = 0;
    if (!A.el?.isConnected || A.play) return;
    const p = plan(), now = `${playWords(p)}|${p.why}`;
    if (now !== shown) draw();
  });
};
for (const ev of ['table:select', 'table:live', 'table:unlive', 'editor:render']) addEventListener(ev, later);
// the set picked on this device, once the setups are in, when nothing is kept here yet
setupsReady().then(() => {
  if (A.steps.length) return draw();
  const s = pickedSetup(KEY);
  if (s?.values?.steps?.length) { A.steps = clone(s.values.steps); keep(); }
  draw();
}).catch(() => {});
