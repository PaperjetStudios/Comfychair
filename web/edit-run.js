// One Edit op on many frames (the Edit pane, the frame menu): each frame in turn, one failing doesn't stop the others.
// Where results land (the user's rule): from the table, a NEW frame beside the source ("<op> · <label>", made at once with
// its own document, table-frames.js resultFrame) unless the target is 'layer' (in the frame itself: a layer, a clip on its
// timeline, a sound in its mix). Runs that land in a video or sound frame are kept on this device (deck.edit.owed) and
// land after a reload; an image frame's go through the Image tools' own owed list.
//
//   runOnFrames(op, frames, opts?, { batch, target, selection })
//        op: an edit-rules.js op; frames: the frames to run on (others of other kinds are left alone); opts: the op's
//        options (edit-ops.js optsOf); target: 'frame' | 'layer' | 'self' (null: edit-rules.js defaultTarget per frame);
//        selection: everything selected (Grab frame looks there for an image frame to put the still in).
//        Resolves { done: [frame], failed: [{ item: frame, error }], skipped: [{ frame, why }], results: [{ frame, into, gens }] }
//   stopEdits()          stops after the frame being sent, and stops this device's run on the card
//   editRunning()        true while runOnFrames is going
//   stateOf(frameId)     'queueing' | 'queued' | 'failed' | null, with why: { state, why }
//   pendingFor(doc)      runs on their way to that document (this page's and the kept ones)
//
// Events: edit:state { frame, state, why }, edit:queued { frame, kind, op, gens, into, target }, edit:pending { doc, n },
// make:queued { frame, kind, gens, into, edit: true } (frame-story.js keeps a shot's runs by it), edit:grabbed (edit-ops.js).
import { api, store, toast } from './ui.js';
import { S } from './core.js';
import { isLive } from './live.js';
import { waitGen } from './make.js';
import { eachOne, failureText } from './tool-batch.js';
import { defaultTarget, planRuns, resultKind, resultLabel } from './edit-rules.js';
import { landOutput, optsOf, runOp } from './edit-ops.js';
import { landingRecord, owedCounts, sameRun, withOwed, withoutOwed } from './owed-runs.js';

const OWED = 'deck.edit.owed';
const R = { running: false, stop: false, states: new Map(), pending: new Map(), mine: new Set() };

const fire = (name, detail) => dispatchEvent(new CustomEvent(name, { detail }));
function setState(frame, state, why = null) {
  if (state) R.states.set(frame.id, { state, why }); else R.states.delete(frame.id);
  fire('edit:state', { frame, state, why });
}
export const stateOf = (id) => R.states.get(id) || null;
export const editRunning = () => R.running;

// ---- runs on their way, per landing document ----
const owedList = () => { try { return store.get(OWED, []) || []; } catch { return []; } };
const putOwed = (rec) => store.set(OWED, withOwed(owedList(), rec));
const dropOwed = (id) => store.set(OWED, withoutOwed(owedList(), id));
export function pendingFor(doc) {
  const kept = owedCounts(owedList().filter((r) => !R.mine.has(r.id)))[doc] || 0;
  return (R.pending.get(doc) || 0) + kept;
}
function bump(doc, by) {
  if (!doc) return;
  R.pending.set(doc, Math.max(0, (R.pending.get(doc) || 0) + by));
  fire('edit:pending', { doc, n: pendingFor(doc) });
}
// a run (or a job with no runs) counted on doc until it settles
function counted(doc, p, n = 1) {
  bump(doc, n);
  Promise.resolve(p).catch(() => {}).finally(() => bump(doc, -n));
}

// ---------------------------------------------------------------------------
export async function runOnFrames(op, frames, opts = optsOf(op.kind, op.id), { batch = 1, target = null, selection = frames } = {}) {
  if (R.running) { toast('An edit is still being sent: wait for it, or Stop', true); return { done: [], failed: [], skipped: [], results: [] }; }
  const { runs, skipped } = planRuns(frames, op, batch);
  if (!runs.length) {
    toast(skipped.length ? `${op.label}: ${skipped.map((s) => `${s.frame.label || 'a frame'} (${s.why})`).join(', ')}` : `Select a ${op.kind} frame first`, true);
    return { done: [], failed: [], skipped, results: [] };
  }
  R.running = true; R.stop = false;
  const results = [];
  for (const { frame } of runs) setState(frame, 'queueing');
  try {
    const out = await eachOne(runs, async ({ frame, batch: n }) => {
      if (R.stop) throw new Error('stopped');
      try {
        const r = await runFrame(op, frame, opts, { batch: n, target, selection });
        results.push(r);
        setState(frame, 'queued');
      } catch (e) { setState(frame, 'failed', e?.message || String(e)); throw e; }
    });
    const msg = failureText(op.label, out.failed, (x) => x.frame?.label || 'a frame');
    if (msg) toast(msg, true);
    else if (out.done.length) toast(out.done.length > 1 ? `${op.label}: sent for ${out.done.length} frames` : `${op.label}: sent`);
    return { done: out.done.map((x) => x.frame), failed: out.failed.map((f) => ({ item: f.item.frame, error: f.error })), skipped, results };
  } finally {
    R.running = false;
    setTimeout(() => { for (const { frame } of runs) if (R.states.get(frame.id)?.state === 'queued') setState(frame, null); }, 4000);
  }
}

async function runFrame(op, frame, opts, { batch, target, selection }) {
  const live = isLive(frame.id);
  const cross = frame.kind !== op.kind;   // (a cross-kind op, edit-rules.js takes: its result is always a new frame)
  const t = cross ? 'frame' : target || defaultTarget(op, live);
  let into = frame;
  if (t === 'frame' && !op.selfLands) {
    const tf = await import('./table-frames.js');
    if (!tf.resultFrame) throw new Error('New frames for results aren\'t ready yet');
    into = await tf.resultFrame(frame, { kind: resultKind(op), label: resultLabel(op, frame) });
    if (!into?.doc) throw new Error('The new frame for the result couldn\'t be made');
  }
  const ctx = { target: t, into, tab: into.doc, batch, live, frames: selection,
    onRun: (gens, to) => keep(gens, { ...to, op: op.id }) };
  const made = into !== frame ? into : null;   // (the empty frame made for the result: it goes again if nothing comes)
  const unmake = () => (made ? import('./table.js').then((T) => T.removeFrames([made.id])).catch(() => {}) : null);
  let res;
  try { res = await runOp(op.kind, op.id, frame, opts, ctx); } catch (e) { await unmake(); throw e; }
  const gens = res?.gens || [];
  if (res?.into) into = res.into;
  if (made && into !== made && !gens.length && !res?.job) unmake();   // (it put its result elsewhere itself)
  if (gens.length) for (const g of gens) counted(into.doc, waitGen(g.id));
  else if (res?.job) counted(into.doc, res.job);
  if (res?.job) {
    res.job.then(() => { if (into !== frame) fire('edit:landed', { frame, into, op: op.id }); })
      .catch((e) => { toast(`${op.label} failed on ${frame.label || 'a frame'}: ${e.message}`, true); if (!gens.length && into === made) unmake(); })
      .finally(() => { for (const g of gens) { dropOwed(g.id); R.mine.delete(g.id); } });
  }
  fire('edit:queued', { frame, kind: op.kind, op: op.id, gens, into, target: t });
  if (gens.length) fire('make:queued', { frame, kind: op.kind, gens, into, edit: true });
  return { frame, into, gens };
}

// runs that land in a video or sound frame, kept for a reload (an image frame's are the Image tools' own)
function keep(gens, to) {
  if (to.kind !== 'video' && to.kind !== 'sound') return;
  for (const g of gens) {
    R.mine.add(g.id);
    putOwed(landingRecord(g, { ...to, as: to.kind === 'sound' ? 'sound' : 'clip', project: S.project }));
  }
}

export async function stopEdits() {
  R.stop = true;
  try { await (await import('./generate.js')).stop(undefined, { ask: false }); } catch { /* nothing running here */ }
}

// ---- after a reload: the kept runs of this project land in their frames ----
let replayed = null;
async function replay() {
  if (S.project == null) return;
  if (replayed === S.project) return;
  replayed = S.project;
  const Table = await import('./table.js').catch(() => null);
  for (const rec of owedList()) {
    if (R.mine.has(rec.id) || (rec.project != null && rec.project !== S.project)) continue;
    R.mine.add(rec.id);
    (async () => {
      let g;
      try { g = await api(`/api/generations/${rec.id}`, { busy: false }); } catch (e) {
        if (e.status === 404) dropOwed(rec.id);
        R.mine.delete(rec.id);
        return;
      }
      if (!sameRun(rec, g)) { dropOwed(rec.id); R.mine.delete(rec.id); return; }
      const into = Table?.frameById?.(rec.frame) || { id: rec.frame, doc: rec.tab, kind: rec.kind, label: rec.label || '' };
      const p = g.status === 'done' ? Promise.resolve(g) : waitGen(rec.id);
      counted(rec.tab, p);
      try { await landOutput(into, await p, { label: rec.label || '' }); }
      catch (e) { toast(`${rec.label || `#${rec.id}`}: ${e.message}`, true); }
      dropOwed(rec.id); R.mine.delete(rec.id);
    })();
  }
}
setTimeout(() => { replay().catch(() => {}); }, 3000);
addEventListener('table:select', () => { replay().catch(() => {}); });
