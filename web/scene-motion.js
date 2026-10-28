// Motion made elsewhere onto a figure: text to motion and video mocap (ComfyUI templates that save a
// motion .npz/.json), or a motion file. The server reads it (app/motion.py) into 22 joint positions per
// frame; motion.js turns those into the figure's keys from the playhead.
import { FIG, R, SC, rawCurrent, dropKeys, frames, putKeys, sameTab } from './scene-data.js';
import { api, button, clone, field, fileButton, h, help, hint, note, openSheet, closeSheet, rangeField, seg, store, toast, undoToast, toggle, textArea } from './ui.js';
import { S, onServer } from './core.js';
import { openVideoPicker } from './media.js';
import { queueRun } from './make.js';
import { changed } from './scene-view.js';
import { toKeys } from './motion.js';
import { reduceTracks } from './scene-keys.js';
import { track } from './keys.js';

const TEXT_TPL = 'deck-motion-text', MOCAP_TPL = 'deck-mocap';
const tpl = (id) => S.templates.find((t) => t.id === id && !t.error);
const ST = { prompt: '', secs: 5, busy: null, to: null };   // busy: what's being made, for the panel; to: the figure it goes on
// where a motion lands (all three imports): from: 'head' (at the playhead, replacing the keys it covers) |
// 'all' (from the start, the figure's other keys go); path: 'travel' (the clip's path) | 'spot' (stays where it is);
// rise: the hips go up and down with the clip; fit: its size matched to the figure by leg length. Kept per device.
// thin: the keys reduced as they land (the sheet's Reduce keys settings), not one every 2 frames.
const PLACE = { from: 'head', path: 'travel', rise: true, fit: true, thin: false, ...store.get('deck.scene.motionPlace', {}) };
const keepPlace = () => store.set('deck.scene.motionPlace', PLACE);

function apply(id, m, label) {
  const o = SC.objects.find((x) => x.id === id);
  if (!o) return toast('That figure is gone', true);
  const all = PLACE.from === 'all', f0 = all ? 0 : R.f, v = rawCurrent(o, FIG), last = frames() - 1;
  const keys = toKeys(m, v, { f0, every: 2, maxF: last, travel: PLACE.path !== 'spot', rise: PLACE.rise, fit: PLACE.fit });
  if (keys.length < 2) return toast('No time left after the playhead: move it back', true);
  const before = clone(o), ok = sameTab(), end = keys[keys.length - 1].f;
  dropKeys(o, all ? () => true : (f) => f >= f0 && f <= end); putKeys(o, keys, FIG);
  let thin = '';
  if (PLACE.thin) {
    const tracks = Object.keys(o.chans).map((ch) => track(o, ch, { id: o.id, kind: 'figure' }));
    const [a, b] = reduceTracks(tracks, undefined, { pick: new Set(tracks.flatMap((T) => T.keys.filter((k) => k.f >= f0 && k.f <= end))) });
    thin = ` · ${a} → ${b} keys`;
  }
  o.stepsFollow = false;
  changed();
  const cut = m.frames.length / (m.fps || 30) > (end - f0) / 24 + 0.1;
  undoToast(`${label}: keys to ${(end / 24).toFixed(1)} s${cut ? ' (cut at the end of the scene)' : ''}${thin}`, () => {
    if (!ok()) return;
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, before); changed();
  });
}

// run a template and wait for its motion
async function run(id, template, values, label) {
  const t = tpl(template);
  if (!t) return toast(`Template ${template} isn't installed yet`, true);
  const field = (re) => t.fields.find((f) => re(f));
  const vals = {};
  for (const [test, v] of values) { const f = field(test); if (f && v != null) vals[f.key] = v; }
  try {
    const gens = await queueRun({ template, values: vals });
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

// A past run's motion (History, the Board, Use as…) onto a figure: the one selected, else the first in the scene
export async function motionOnto(src, label) {
  const o = SC.objects.find((x) => x.id === R.sel && x.type === 'figure') || figures()[0];
  if (!o) return toast('Add a person to the scene first, then use the motion on them', true);
  try { apply(o.id, await api('/api/motion/from', { method: 'POST', body: { generation: src.generation, index: src.index } }), label); }
  catch (e) { toast(e.message, true); }
}

// the placement choices, the same in the panel and the two sheets; onto: which figure (when there are several)
const figures = () => SC.objects.filter((x) => x.type === 'figure');
const target = (o) => (figures().some((x) => x.id === ST.to) ? ST.to : o.id);
function placeFields(o) {
  const tog = (k, label) => toggle(label, PLACE[k], (on) => { PLACE[k] = on; keepPlace(); });
  const figs = figures();
  const onto = figs.length > 1 ? h('select', { onchange: (e) => { ST.to = e.target.value; } }, ...figs.map((x) => h('option', { value: x.id, selected: x.id === target(o) }, x.name))) : null;
  return [
    h('div', { class: 'row wrap' },
      field('Starts', seg([['head', 'At the playhead'], ['all', 'Replace all keys']], PLACE.from, (v) => { PLACE.from = v; keepPlace(); })),
      field('Path', seg([['travel', 'Follow the clip'], ['spot', 'On the spot']], PLACE.path, (v) => { PLACE.path = v; keepPlace(); }))),
    h('div', { class: 'row wrap' }, tog('rise', 'Hips rise and fall with it'), tog('fit', 'Scale it to this figure'), tog('thin', 'Fewer keys (reduce as it lands)')),
    onto ? field('Onto', onto) : null];
}

function textSheet(o) {
  const ta = textArea(() => ST.prompt, (v) => { ST.prompt = v; }, { rows: 4, label: 'What the body does',
    placeholder: 'A person walks forward. The person sits down on a chair.' });
  openSheet(h('h3', {}, 'Text to motion'),
    help('Describe what the body does. Each sentence is a new part, in order. It starts from the playhead and replaces the keys it covers.'),
    field('Motion', ta),
    rangeField('Length', () => ST.secs, (v) => { ST.secs = v; }, { min: 1, max: 12, step: 0.5, fmt: (v) => `${v.toFixed(1)} s` }),
    placeFields(o),
    h('div', { class: 'actions' },
      button('Make motion', () => {
        if (!ST.prompt.trim()) return toast('Describe the motion first', true);
        closeSheet();
        run(target(o), TEXT_TPL, [[(f) => f.kind === 'text' && /prompt|motion|text/i.test(f.group), ST.prompt],
          [(f) => (f.kind === 'float' || f.kind === 'int') && /length|seconds|duration/i.test(f.label), ST.secs]], 'Text to motion');
      }, { cls: 'primary' }),
      button('Cancel', closeSheet)));
}

function videoSheet(o) {
  openSheet(h('h3', {}, 'Motion from video'),
    help('A clip of one person, whole body in view. The motion is made on the GPU and goes on the figure when it is done.'),
    placeFields(o),
    h('div', { class: 'actions' },
      button('Pick the clip…', () => {
        const id = target(o);
        openVideoPicker({ title: 'Video of a person', onPick: (val) => run(id, MOCAP_TPL, [[(f) => f.kind === 'video', val]], 'Motion from video') });
      }, { cls: 'primary' }),
      button('Cancel', closeSheet)));
}

export function motionField(o) {
  const text = tpl(TEXT_TPL), mocap = tpl(MOCAP_TPL);
  const imp = fileButton('Import file…', async ([file]) => {
    const form = new FormData(); form.append('file', file);
    try { apply(target(o), await api('/api/motion/file', { method: 'POST', form }), file.name); }
    catch (e) { toast(e.message, true); }
  }, { accept: '.npz,.json', cls: 'small' });
  return [
    field('Motion', h('div', { class: 'row wrap' },
      button('✨ From text…', () => textSheet(o), { disabled: !text, title: text ? 'Describe a motion' : `Needs the ${TEXT_TPL} template` }),
      button('🎥 From video…', () => videoSheet(o), { disabled: !mocap, title: mocap ? 'Copy a person\'s movement from a clip' : `Needs the ${MOCAP_TPL} template` }),
      imp),
      help('Whole-body motion from a description or a video of a person, made on the GPU, or from a motion file (.npz or .json with 22 joints per frame, SMPL order). Keys every 2 frames from the playhead.')),
    field('Where it goes', placeFields(o)),
    ST.busy ? hint(`Making: ${ST.busy}…`) : null,
    !text && !mocap ? note('Text to motion and video mocap need their ComfyUI nodes and templates (deck-motion-text, deck-mocap). Motion files import now.') : null,
  ];
}
