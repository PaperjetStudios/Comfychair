import { api } from './ui.js';
import { S, addMine, onServer } from './core.js';
import { RUN, onGeneration, syncWithServer } from './run.js';

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
  loras: (f) => f.kind === 'loras',
  depthModel: (f) => f.kind === 'choice' && f.input === 'model',
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
    else if (seen.status === 'done' || seen.status === 'error') { S.history.delete(g.id); onGeneration(seen); }  // show it now
    if (g.prompt_id === S.activePid && RUN.pid !== S.activePid) missed = true;
  }
  if (missed) syncWithServer();
}

// Queue a template: values by field key (missing ones take the template's), parent only to override the
// server's lineage rule. Resolves with the queued generations, already followed.
export async function queueRun({ template: id, values = {}, batch = 1, parent = null, builder = null, face = null, project = S.project, timeout } = {}) {
  let gens;
  try {
    gens = await api('/api/generate', { method: 'POST', ...(timeout && { timeout }),
      body: { template: id, values, batch, project_id: project, ...(parent && { parent }), ...(builder && { builder }), ...(face && { face }) } });
  } catch (e) {  // part of a batch may already be queued: follow those, then report the failure
    for (const g of e.data?.created || []) { addMine(g.prompt_id); S.history.set(g.id, g); }
    throw e;
  }
  adoptGenerations(gens);
  return gens;
}

// A run's end: resolves with the generation when it's done, rejects when it fails or is stopped
export function waitGen(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (g) => {
      if (done || !g || (g.status !== 'done' && g.status !== 'error' && g.status !== 'interrupted')) return;
      done = true; off(); clearInterval(timer);
      if (g.status === 'done') resolve(g); else reject(new Error(g.error || `#${g.id} ${g.status}`));
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
