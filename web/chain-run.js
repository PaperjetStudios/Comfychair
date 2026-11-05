// Rerun a chain of wired frames: a frame's workflow (frame.make), then each frame it feeds through ON wires, in run order
// (wire-rules.js chainOf / downstream), each waiting for the one before it to LAND so it reads its sources fresh. One
// chain at a time, sequential, with Stop, in the style of edit-run.js runOnFrames; every run goes through make-panel.js
// runFrame, so through make.js queueRun and comfy.queue like any other.
// A frame with no workflow (no frame.make.template) is skipped: its content passes through as it is. A failed step stops
// the chain with a toast naming the frame. Each result takes the place of what that frame's last chain run made
// (frame.make.ran.made; the old run stays in History). A frame's tile shows the pending badge while its step runs (the
// table's edit:pending count) and the Make pane one status row (chain:state).
//
//   runFromHere(frame)    this frame, then everything downstream of it
//   rerunUsers(frame)     everything downstream of it (not the frame itself)
//   runChain(frameIds, { onStep })   these frames in this order; onStep({ frame, state: 'running' | 'done' | 'failed' |
//                         'skipped', i, n }). Resolves { done: [frame], skipped: [frame], failed: { frame, error } | null, stopped }
//   stopChain()           stops after the step running now, and stops this device's run on the card (generate.js stop)
//   chainState()          { running, i, n, frame, label }: the step running now
//
// Events: chain:state (chainState()), edit:pending { doc, n } (table.js draws it on the frame's tile).
import { toast } from './ui.js';
import { stop } from './generate.js';
import * as Table from './table.js';
import { chainOf, downstream } from './wire-rules.js';
import { runFrame } from './make-panel.js';

const R = { running: false, stop: false, step: null };
const hasFlow = (f) => !!f?.make?.template;
export const chainRunning = () => R.running;
export const chainState = () => ({ running: R.running, ...(R.step || {}) });
const tell = () => dispatchEvent(new CustomEvent('chain:state', { detail: chainState() }));

// the pending badge on the frame's tile while its step runs: one more than its other runs on the way (edit-run.js pendingFor)
async function pending(doc, on) {
  if (!doc) return;
  let other = 0;
  try { other = (await import('./edit-run.js')).pendingFor(doc) || 0; } catch { /* no Edit pane runs */ }
  dispatchEvent(new CustomEvent('edit:pending', { detail: { doc, n: other + (on ? 1 : 0) } }));
}

export const runFromHere = (frame) => frame && runChain(chainOf(Table.tableWires() || [], frame.id));
export const rerunUsers = (frame) => frame && runChain(downstream(Table.tableWires() || [], frame.id));

export async function runChain(frameIds, { onStep = null } = {}) {
  const none = { done: [], skipped: [], failed: null, stopped: false };
  if (R.running) { toast('A chain is running already: wait for it, or Stop', true); return none; }
  const n = frameIds.map((id) => Table.frameById(id)).filter(hasFlow).length;
  if (!n) { toast('Nothing in this chain has a workflow yet: pick a template in a frame\'s Make pane first', true); return none; }
  R.running = true; R.stop = false;
  const tableId = Table.activeTableId();   // (a chain is one table's: another table opened meanwhile stops it)
  const done = [], skipped = [];
  let failed = null, i = 0, stopped = false;
  const step = (frame, state) => { try { onStep?.({ frame, state, i, n }); } catch (e) { console.warn(e); } };
  try {
    for (const id of frameIds) {
      if (R.stop) break;
      if (Table.activeTableId() !== tableId) { failed = { frame: null, error: new Error('another table opened') }; toast('The chain stopped: another table was opened', true); break; }
      const f = Table.frameById(id);
      if (!f) continue;   // (deleted meanwhile)
      if (!hasFlow(f)) { skipped.push(f); step(f, 'skipped'); continue; }
      i++;
      R.step = { i, n, frame: f.id, label: f.label || '' };
      tell(); step(f, 'running');
      pending(f.doc, true);
      try {
        await runFrame(f, { batch: 1, replace: true });
        done.push(f); step(f, 'done');
      } catch (e) {
        failed = { frame: f, error: e }; step(f, 'failed');
        if (!R.stop) toast(`The chain stopped at "${f.label || 'a frame'}": ${e?.message || e}`, true);
        break;
      } finally { pending(f.doc, false); }
    }
    if (R.stop) toast(done.length ? `Chain stopped after ${done.length} of ${n}` : 'Chain stopped');
    else if (!failed) toast(n > 1 ? `Chain done: ${done.length} frames ran` : `"${done[0]?.label || 'The frame'}" ran`);
  } finally {
    stopped = R.stop;
    R.running = false; R.stop = false; R.step = null;
    tell();
  }
  return { done, skipped, failed, stopped };
}

export function stopChain() {
  if (!R.running) return;
  R.stop = true;
  tell();
  stop();
}
