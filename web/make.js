import { api, SHEET, actions, button, closeSheet, h, openSheet } from './ui.js';
import { S, addMine, onServer, emitServer } from './core.js';
import { RUN } from './run-state.js';

// ---------------------------------------------------------------------------
// make: the one way a template run starts. Generate, VFX, the Video tab's clip effects, the Sound tab's
// makers, the 3D tab's motion and History's Run again all queue here, so every run is followed the same
// way (taken as this device's, shown when it lands) and recorded the same way: what it was made from is
// worked out on the server from the run's own inputs (app/main.py lineage) unless the caller names it,
// and face says which tab and settings made it, so Edit can reopen it there.
//
//   const gens = await queueRun({ template, values, batch?, parent?, builder?, face?, project?, timeout? });
//   const g = await waitGen(gens[0].id);                     // resolves when it's done, rejects on error
//   const values = valuesByRole(t, { source, prompt, len }); // template fields found by what they're for
// ---------------------------------------------------------------------------

// How a run's inputs find their template fields: by kind, then by the group (node title) name
export const ROLES = {
  source: (f) => f.kind === 'video' && !/mask|matte|pose/i.test(f.group),
  matte: (f) => f.kind === 'video' && /mask|matte/i.test(f.group),
  pose: (f) => f.kind === 'video' && /pose/i.test(f.group),   // a ready pose video (the drives' posed templates)
  first: (f) => f.kind === 'image',
  sound: (f) => f.kind === 'audio' && !/voice/i.test(f.group),
  voice: (f) => f.kind === 'audio' && /voice/i.test(f.group),
  prompt: (f) => f.kind === 'text' && /prompt/i.test(f.group) && !/negative/i.test(f.group) && f.input !== 'neg_coordinates',
  pointsPos: (f) => f.kind === 'text' && f.input === 'coordinates',
  pointsNeg: (f) => f.kind === 'text' && f.input === 'neg_coordinates',
  pframe: (f) => f.kind === 'int' && /points frame/i.test(f.group),
  mode: (f) => f.kind === 'choice' && f.input === 'prompt_mode',
  tracks: (f) => f.kind === 'text' && /tracks|paths/i.test(f.group),
  len: (f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(f.label),
  width: (f) => f.kind === 'int' && /^width$/i.test(f.group),
  height: (f) => f.kind === 'int' && /^height$/i.test(f.group),
  res: (f) => f.kind === 'int' && /resolution/i.test(f.group),
  steps: (f) => f.kind === 'text' && f.input === 'sigmas',
  blend: (f) => f.kind === 'choice' && f.input === 'shape',
  grow: (f) => f.kind === 'float' && f.input === 'grow',
  feather: (f) => f.kind === 'float' && f.input === 'feather',
  chin: (f) => f.kind === 'float' && f.input === 'chin',
  lora: (f) => f.kind === 'choice' && f.input === 'lora_name',
  strength: (f) => f.kind === 'float' && f.input === 'strength_model',
  outsize: (f) => f.kind === 'choice' && f.input === 'output_size',
  seed: (f) => f.kind === 'seed',
  score: (f) => f.input === 'score_threshold',   // (SAM3 on a clip: how sure it must be)
  confidence: (f) => f.input === 'confidence_threshold',   // (SAM3 on a picture)
  maxFound: (f) => f.input === 'max_detections',
  direction: (f) => f.input === 'direction',
  which: (f) => f.input === 'obj_id',
  margin: (f) => f.input === 'margin',
  follow: (f) => f.input === 'follow',
  steady: (f) => f.input === 'smooth',
  onlyMask: (f) => f.input === 'only_mask',
  hold: (f) => f.input === 'strength',
  loras: (f) => f.kind === 'loras',
  depthModel: (f) => f.kind === 'choice' && f.input === 'model',
  edgeAmount: (f) => (f.kind === 'float' || f.kind === 'int') && (f.input === 'threshold' || /edge amount/i.test(f.label)),
  depthSize: (f) => f.kind === 'int' && f.input === 'input_size',
};

export const template = (id) => S.templates.find((t) => t.id === id && !t.error) || null;
export const roleField = (t, role, roles = ROLES) => (roles[role] && t?.fields.find(roles[role])) || null;
// template t's values from values by role ({ source, prompt, … }); empty ones keep the template's own
export function valuesByRole(t, byRole, roles = ROLES) {
  const values = {};
  for (const [role, v] of Object.entries(byRole)) {
    const f = roleField(t, role, roles);
    if (f && v !== undefined && v !== null && v !== '') values[f.key] = v;
  }
  return values;
}

// Runs just queued from here. With an idle queue ComfyUI can start (or even finish) one before the
// queue reply arrives, so its websocket messages were taken for another device's: catch up then.
export function adoptGenerations(gens) {
  let missed = false;
  for (const g of gens) {
    addMine(g.prompt_id);
    const seen = S.history.get(g.id);
    if (!seen) S.history.set(g.id, g);   // never overwrite a newer status that came over the socket
    else if (seen.status === 'done' || seen.status === 'error') { S.history.delete(g.id); emitServer({ type: 'adopt_generation', data: seen }); }  // show it now
    if (g.prompt_id === S.activePid && RUN.pid !== S.activePid) missed = true;
  }
  if (missed) emitServer({ type: 'sync_requested' });
}

// Queue a template: values by field key (missing ones take the template's), parent only to override the
// server's lineage rule. Resolves with the queued generations, already followed.
// A batch: one press that sends several runs (several layers, clips, frames or models). Runs queued while one is open carry it, and the Queue
// panel cancels them together. A press that starts its own takes over from one still sending in the background.
let GROUP = null;
export function openGroup(label) {
  GROUP = { id: Math.random().toString(36).slice(2, 14), label: String(label || '').slice(0, 120) };
  return GROUP;
}
export function closeGroup(g) { if (GROUP === g) GROUP = null; }
// the server refused a run of a batch the Queue has cancelled: the loop sending them stops
export const batchCancelled = (e) => /That batch was cancelled/.test(e?.message || '');

export async function queueRun({ template: id, values = {}, batch = 1, parent = null, builder = null, face = null, project = S.project, timeout } = {}) {
  let gens;
  const send = (force) => api('/api/generate', { method: 'POST', ...(timeout && { timeout }),
    body: { template: id, values, batch, project_id: project, ...(parent && { parent }), ...(builder && { builder }), ...(face && { face }), ...(GROUP && { group: GROUP }),
      ...(force && { force: true }) } });
  try {
    try {
      gens = await send(false);
    } catch (e) {  // bigger than anything of its kind that has fitted on the card (app/sizelimits.py): ask, then send it anyway or not at all
      if (!(e.status === 409 && e.data?.tooBig)) throw e;
      if (!(await askTooBig(e.data.message))) throw Object.assign(new Error('Not run: too big for the card'), { tooBig: true });
      gens = await send(true);
    }
  } catch (e) {  // part of a batch may already be queued: follow those, then report the failure
    for (const g of e.data?.created || []) { addMine(g.prompt_id); S.history.set(g.id, g); }
    throw e;
  }
  adoptGenerations(gens);
  return gens;
}

// Run anyway or Cancel: true only for Run anyway. Closing the sheet any other way counts as Cancel.
function askTooBig(message) {
  return new Promise((resolve) => {
    let seq = 0, timer = 0;
    const end = (yes) => { clearInterval(timer); if (SHEET.seq === seq) closeSheet(); resolve(yes); };
    seq = openSheet(h('h3', {}, 'Bigger than the card has managed'), h('p', {}, message),
      actions(button('Cancel', () => end(false)), button('Run anyway', () => end(true), { cls: 'primary' })));
    timer = setInterval(() => {
      if (SHEET.seq !== seq || document.getElementById('sheetBackdrop')?.classList.contains('hidden')) { clearInterval(timer); resolve(false); }
    }, 300);
  });
}

// A run's end: resolves with the generation when it's done, rejects when it fails or is stopped
export function waitGen(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (g) => {
      if (done || !g || (g.status !== 'done' && g.status !== 'error' && g.status !== 'interrupted')) return;
      done = true; off(); clearInterval(timer);
      if (g.status === 'done') resolve(g); else reject(Object.assign(new Error(g.error || `#${g.id} ${g.status}`), { status: g.status }));
    };
    const off = onServer('deck_generation', ({ data }) => { if (data?.id === id) finish(data); });
    const timer = setInterval(() => api(`/api/generations/${id}`, { busy: false }).then(finish, () => {}), 5000);
  });
}

// Queue template id with its inputs by role and wait for it (the Video tab's clip effects)
export async function runAndWait(id, byRole, roles = ROLES) {
  const t = template(id);
  if (!t) throw new Error(`Template ${id} isn't installed`);
  const [g] = await queueRun({ template: id, values: valuesByRole(t, byRole, roles) });
  return waitGen(g.id);
}
