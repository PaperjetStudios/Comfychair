// Motion made elsewhere onto a figure: text to motion and video mocap (ComfyUI templates that save a
// motion .npz/.json), or a motion file. The server reads it (app/motion.py) into 22 joint positions per
// frame; motion.js turns those into the figure's keys from the playhead.
import { FIG, R, SC, current, dropKeys, frames, putKeys, sameTab } from './scene-data.js';
import { api, button, clone, field, fileButton, h, help, hint, note, openSheet, closeSheet, rangeField, toast, undoToast } from './ui.js';
import { S, onServer } from './core.js';
import { openVideoPicker } from './media.js';
import { adoptGenerations } from './generate.js';
import { changed } from './scene-view.js';
import { toKeys } from './motion.js';

const TEXT_TPL = 'deck-motion-text', MOCAP_TPL = 'deck-mocap';
const tpl = (id) => S.templates.find((t) => t.id === id && !t.error);
const ST = { prompt: '', secs: 5, busy: null };   // busy: what's being made, for the panel

function apply(id, m, label) {
  const o = SC.objects.find((x) => x.id === id);
  if (!o) return toast('That figure is gone', true);
  const v = current(o, FIG), f0 = R.f, last = frames() - 1;
  const keys = toKeys(m, v, { f0, every: 2, maxF: last });
  if (keys.length < 2) return toast('No time left after the playhead: move it back', true);
  const before = clone(o), ok = sameTab(), end = keys[keys.length - 1].f;
  dropKeys(o, (f) => f >= f0 && f <= end); putKeys(o, keys, FIG);
  o.stepsFollow = false;
  changed();
  const cut = m.frames.length / (m.fps || 30) > (end - f0) / 24 + 0.1;
  undoToast(`${label}: keys to ${(end / 24).toFixed(1)} s${cut ? ' (cut at the end of the scene)' : ''}`, () => {
    if (!ok()) return;
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, before); changed();
  });
}

// run a template and wait for its motion
async function run(o, template, values, label) {
  const t = tpl(template);
  if (!t) return toast(`Template ${template} isn't installed yet`, true);
  const field = (re) => t.fields.find((f) => re(f));
  const vals = {};
  for (const [test, v] of values) { const f = field(test); if (f && v != null) vals[f.key] = v; }
  const id = o.id;
  try {
    const gens = await api('/api/generate', { method: 'POST', body: { template, values: vals, batch: 1, project_id: S.project } });
    adoptGenerations(gens);
    const gid = gens[0].id;
    ST.busy = `${label} #${gid}`; changed();
    toast(`${label}: queued as #${gid}. The keys go in when it's done.`);
    const off = onServer('deck_generation', async ({ data: g }) => {
      if (g?.id !== gid || (g.status !== 'done' && g.status !== 'error')) return;
      off(); ST.busy = null;
      if (g.status === 'error') { changed(); return toast(`${label} failed: ${g.error || ''}`, true); }
      try { apply(id, await api('/api/motion/from', { method: 'POST', body: { generation: gid } }), label); }
      catch (e) { toast(e.message, true); changed(); }
    });
  } catch (e) { toast(e.message, true); }
}

function textSheet(o) {
  const ta = h('textarea', { rows: 4, value: ST.prompt, placeholder: 'A person walks forward. The person sits down on a chair.',
    oninput: () => { ST.prompt = ta.value; } });
  openSheet(h('h3', {}, 'Text to motion'),
    help('Describe what the body does. Each sentence is a new part, in order. It starts from the playhead and replaces the keys it covers.'),
    field('Motion', ta),
    rangeField('Length', () => ST.secs, (v) => { ST.secs = v; }, { min: 1, max: 12, step: 0.5, fmt: (v) => `${v.toFixed(1)} s` }),
    h('div', { class: 'actions' },
      button('Make motion', () => {
        if (!ST.prompt.trim()) return toast('Describe the motion first', true);
        closeSheet();
        run(o, TEXT_TPL, [[(f) => f.kind === 'text' && /prompt|motion|text/i.test(f.group), ST.prompt],
          [(f) => (f.kind === 'float' || f.kind === 'int') && /length|seconds|duration/i.test(f.label), ST.secs]], 'Text to motion');
      }, { cls: 'primary' }),
      button('Cancel', closeSheet)));
}

function videoSheet(o) {
  openVideoPicker({ title: 'Video of a person', onPick: (val) => run(o, MOCAP_TPL,
    [[(f) => f.kind === 'video', val]], 'Motion from video') });
}

export function motionField(o) {
  const text = tpl(TEXT_TPL), mocap = tpl(MOCAP_TPL);
  const imp = fileButton('Import file…', async ([file]) => {
    const form = new FormData(); form.append('file', file);
    try { apply(o.id, await api('/api/motion/file', { method: 'POST', form }), file.name); }
    catch (e) { toast(e.message, true); }
  }, { accept: '.npz,.json', cls: 'small' });
  return [
    field('Motion', h('div', { class: 'row wrap' },
      button('✨ From text…', () => textSheet(o), { disabled: !text, title: text ? 'Describe a motion' : `Needs the ${TEXT_TPL} template` }),
      button('🎥 From video…', () => videoSheet(o), { disabled: !mocap, title: mocap ? 'Copy a person\'s movement from a clip' : `Needs the ${MOCAP_TPL} template` }),
      imp),
      help('Whole-body motion from a description or a video of a person, made on the GPU, or from a motion file (.npz or .json with 22 joints per frame, SMPL order). Keys every 2 frames from the playhead.')),
    ST.busy ? hint(`Making: ${ST.busy}…`) : null,
    !text && !mocap ? note('Text to motion and video mocap need their ComfyUI nodes and templates (deck-motion-text, deck-mocap). Motion files import now.') : null,
  ];
}
