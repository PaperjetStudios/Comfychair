// Motion made elsewhere onto a figure: text to motion and video mocap (ComfyUI templates that save a
// motion .npz/.json), or a motion file. The server reads it (app/motion.py) into 22 joint positions per
// frame; motion.js turns those into the figure's keys from the playhead.
import { CAM, FIG, OBJ, R, SC, rawCurrent, dropKeys, frames, migrateKeys, putKeys, sameTab, sample } from './scene-data.js';
import { api, button, clone, field, fileButton, h, help, hint, note, openSheet, closeSheet, rangeField, seg, store, toast, uid, undoToast, toggle, textArea } from './ui.js';
import { S, onServer } from './core.js';
import { openVideoPicker } from './media.js';
import { queueRun } from './make.js';
import { changed } from './scene-view.js';
import * as FIGURE from './figure.js';
import { matchProportions, toKeys, toWorld } from './motion.js';
import { sceneFromTrack } from './track-math.js';
import { reduceTracks } from './scene-keys.js';
import { track } from './keys.js';

const TEXT_TPL = 'deck-motion-text', MOCAP_TPL = 'deck-mocap';
const tpl = (id) => S.templates.find((t) => t.id === id && !t.error);
const ST = { prompt: '', secs: 5, busy: null, to: null };   // busy: what's being made, for the panel; to: the figure it goes on
// where a motion lands (all three imports): from: 'head' (at the playhead, replacing the keys it covers) |
// 'all' (from the start, the figure's other keys go); path: 'travel' (the clip's path) | 'spot' (stays where it is);
// rise: the hips go up and down with the clip; fit: its size matched to the figure by leg length. Kept per device.
// thin: the keys reduced as they land (the sheet's Reduce keys settings), not one every 2 frames.
// cam: From video also tracks the clip and adds its camera (Mocap camera), the body placed in the world through it.
// match: the figure's shape (o.shape) and size changed to the capture's proportions first (then fit is moot).
// steady / bones / feet: the video-mocap clean-up (app/motion.py). Feet are planted after the body is in the world.
// person: which detected person, when a clip has several.
const PLACE = { from: 'head', path: 'travel', rise: true, fit: true, thin: false, cam: false, match: false,
  steady: true, bones: true, feet: true, person: 0, ...store.get('deck.scene.motionPlace', {}) };
const keepPlace = () => store.set('deck.scene.motionPlace', PLACE);

// With "Match its proportions": the figure's lengths (legs, arms, torso, shoulders, hips, neck: its other shape
// sliders stay) and size from the capture, so the keys can take the clip's metres as they are. Returns how to place
// it ({ sy, scale: 1, hipY }), or null.
const MATCHED = ['legs', 'arms', 'torso', 'shoulders', 'hips', 'neck'];
function matched(o, m) {
  if (!PLACE.match) return null;
  const { sy, shape } = matchProportions(m.frames, o.body);
  o.shape = { ...Object.fromEntries(Object.entries(o.shape || {}).filter(([k]) => !MATCHED.includes(k))), ...shape };
  if (!Object.keys(o.shape).length) delete o.shape;
  return { sy, scale: 1, hipY: (FIGURE.hipsHeight(o.body, o.shape) - Math.abs(FIGURE.restOffsets(o.body).lhip[1])) * sy };
}
const sized = (v, mt) => (mt ? { ...v, sx: mt.sy, sy: mt.sy, sz: mt.sy } : v);
const heightNote = (o, mt) => (mt ? ` · shaped to the capture, ${(FIGURE.heightOf(o.body, o.shape) * mt.sy).toFixed(2)} m tall` : '');

// steady and bone lengths on the server, in the capture's own frame. Feet wait until the body is in the world.
function cleanOf() {
  return { smooth: PLACE.steady !== false, bones: PLACE.bones !== false };
}
async function planted(m) {
  if (PLACE.feet === false || !m?.frames || m.frames.length < 2) return m;
  try {
    const out = await api('/api/motion/clean', { method: 'POST', body: { fps: m.fps || 24, frames: m.frames, hands: m.hands, face: m.face, clean: { feet: true, ground: true } } });
    return { ...m, frames: out.frames, hands: out.hands || m.hands, face: out.face || m.face, contacts: out.contacts };
  } catch (e) { toast(e.message, true); return m; }
}
const lift = (frames, dy) => frames?.map((P) => P.map(([x, y, z]) => [x, y + dy, z]));

async function apply(id, m, label) {
  m = await planted(m);
  const o = SC.objects.find((x) => x.id === id);
  if (!o) return toast('That figure is gone', true);
  const before = clone(o), ok = sameTab(), mt = matched(o, m);
  const all = PLACE.from === 'all', f0 = all ? 0 : R.f, v = sized(rawCurrent(o, FIG), mt), last = frames() - 1;
  const keys = toKeys(m, v, { f0, every: 2, maxF: last, travel: PLACE.path !== 'spot', rise: PLACE.rise, fit: PLACE.fit, ...(mt ? { scale: mt.scale, hipY: mt.hipY } : {}) });
  const undo = () => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, before); };
  if (keys.length < 2) { undo(); return toast('No time left after the playhead: move it back', true); }
  land(o, m, keys, f0, label, undo, ok, heightNote(o, mt));
}
// the keys onto the figure (replacing what they cover), reduced if asked, with an undo toast
function land(o, m, keys, f0, label, undo, ok, extra = '') {
  const all = PLACE.from === 'all', end = keys[keys.length - 1].f;
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
  undoToast(`${label}: keys to ${(end / 24).toFixed(1)} s${cut ? ' (cut at the end of the scene)' : ''}${thin}${extra}`, () => {
    if (!ok()) return;
    undo(); changed();
  });
}

// A video capture with its camera: the clip's track (pans, tilts, roll, zoom; a camera that travels isn't solved)
// becomes a new camera, "Mocap camera", made active, with the footage behind it; the body goes into the world through
// that camera frame by frame, so in a panning shot it stays put while the camera turns. The camera is raised so
// the feet start on the floor. Its lens: SAM 3D Body's focal length when the capture says it, else 35 mm.
export async function applyWithCamera(id, m, tr, label) {
  const o = SC.objects.find((x) => x.id === id);
  if (!o) return toast('That figure is gone', true);
  if (!m.space || m.source !== 'sam3d-body') { toast('That motion has no camera to go with it: put on as usual', true); return apply(id, m, label); }
  const all = PLACE.from === 'all', f0 = all ? 0 : R.f, last = frames() - 1;
  const W = (m.size || tr.size)[0], lens = m.focal ? Math.max(8, Math.min(300, 36 * m.focal / W)) : 35;
  const sc = sceneFromTrack(tr, { lens, points: false, name: `Footage (${label})` });
  const nth = [SC.camera, ...(SC.cams || [])].filter((c) => /^Mocap camera/.test(c?.name || '')).length;
  const cam = { id: uid(), name: nth ? `Mocap camera ${nth + 1}` : 'Mocap camera', base: { ...sc.camera.base }, keys: sc.camera.keys, ease: 'linear', mute: false };
  migrateKeys(cam, CAM);
  const world = toWorld(m, (i) => sample(cam, CAM, i));
  const P0 = world.frames[0], dy = -Math.min(P0[10][1], P0[11][1]);   // (toes on the floor at the start)
  world.frames = lift(world.frames, dy);
  if (world.hands) { world.hands = { l: lift(world.hands.l, dy), r: lift(world.hands.r, dy) }; }
  if (world.face) world.face = lift(world.face, dy);
  const stood = await planted(world);
  const bd = sc.objects.find((x) => x.type === 'backdrop');
  if (bd) { bd.id = uid(); bd.at = f0; migrateKeys(bd, OBJ); }
  // camera and footage: raised by dy, from the motion's first frame (f0), nothing past the end
  for (const it of [cam, bd].filter(Boolean)) {
    for (const ch of it === cam ? ['py', 'ty'] : ['y']) { it.base[ch] += dy; for (const k of it.chans[ch] || []) k.v += dy; }
    for (const [ch, l] of Object.entries(it.chans)) { const keep = l.map((k) => ({ ...k, f: k.f + f0 })).filter((k) => k.f <= last); if (keep.length) it.chans[ch] = keep; else delete it.chans[ch]; }
  }
  const before = clone(SC), ok = sameTab(), mt = matched(o, m), v = sized(rawCurrent(o, FIG), mt);
  const root = stood.frames[0];
  const keys = toKeys(stood, { ...v, rx: 0, ry: 0, rz: 0, x: root[0][0], z: root[0][2] },
    { f0, every: 2, maxF: last, travel: true, rise: true, fit: false, ...(mt ? { scale: mt.scale, hipY: mt.hipY } : {}) });
  if (keys.length < 2) {   // (nothing lands: the shape goes back)
    const was = before.objects.find((x) => x.id === o.id)?.shape;
    if (was) o.shape = was; else delete o.shape;
    return toast('No time left after the playhead: move it back', true);
  }
  SC.cams = [...(SC.cams || []), SC.camera]; SC.camera = cam;
  if (bd) SC.objects.unshift(bd);
  o.ground = false;   // (its height comes from the capture, which the camera was raised to fit)
  land(o, stood, keys, f0, label, () => { for (const k of Object.keys(SC)) delete SC[k]; Object.assign(SC, before); }, ok,
    ` · Mocap camera made active${m.focal ? '' : ' (lens guessed: 35 mm)'}${heightNote(o, mt)}`);
}

// the clip's camera track on the server (Simple: no GPU), whole clip, as the Track panel would make it
async function trackClip(src) {
  const { job } = await api('/api/track', { method: 'POST', busy: false, body: { src, project_id: S.project, start: 0, end: null, method: 'klt' } });
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const s = await api(`/api/track/${job}`, { busy: false });
    if (s.state === 'done') return s.result;
    if (s.state !== 'running') throw new Error(`Tracking the camera: ${s.error || s.state}`);
  }
}

// run a template and wait for its motion
async function run(id, template, values, label, then = apply) {
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
      try { await then(id, await api('/api/motion/from', { method: 'POST', body: { generation: gid, clean: cleanOf() } }), label); }
      catch (e) { toast(e.message, true); changed(); }
    });
  } catch (e) { toast(e.message, true); }
}

// A past run's motion (History, the Board, Use as…) onto a figure: the one selected, else the first in the scene
export async function motionOnto(src, label) {
  const o = SC.objects.find((x) => x.id === R.sel && (x.type === 'figure' || x.type === 'rigged')) || figures()[0];
  if (!o) return toast('Add a person to the scene first, then use the motion on them', true);
  try { await apply(o.id, await api('/api/motion/from', { method: 'POST', body: { generation: src.generation, index: src.index, clean: cleanOf() } }), label); }
  catch (e) { toast(e.message, true); }
}

// the placement choices, the same in the panel and the two sheets; onto: which figure (when there are several)
const figures = () => SC.objects.filter((x) => x.type === 'figure' || x.type === 'rigged');
const target = (o) => (figures().some((x) => x.id === ST.to) ? ST.to : o.id);
function placeFields(o) {
  const tog = (k, label) => toggle(label, PLACE[k], (on) => { PLACE[k] = on; keepPlace(); });
  const figs = figures();
  const onto = figs.length > 1 ? h('select', { onchange: (e) => { ST.to = e.target.value; } }, ...figs.map((x) => h('option', { value: x.id, selected: x.id === target(o) }, x.name))) : null;
  return [
    h('div', { class: 'row wrap' },
      field('Starts', seg([['head', 'At the playhead'], ['all', 'Replace all keys']], PLACE.from, (v) => { PLACE.from = v; keepPlace(); })),
      field('Path', seg([['travel', 'Follow the clip'], ['spot', 'On the spot']], PLACE.path, (v) => { PLACE.path = v; keepPlace(); }))),
    h('div', { class: 'row wrap' }, tog('rise', 'Hips rise and fall with it'), tog('fit', 'Scale it to this figure'), tog('thin', 'Fewer keys (reduce as it lands)'),
      tog('match', 'Match its proportions'),
      help('Match its proportions: the figure takes the captured person\'s leg, arm and torso lengths, shoulder and hip width, neck and height (Body shape and size on the Place tab; its other shape sliders stay), so the move lands with less stretching: feet plant, hands reach. Undo puts the figure back too.')),
    h('div', { class: 'row wrap' }, tog('steady', 'Steady'), tog('bones', 'Keep bone lengths'), tog('feet', 'Plant feet'),
      help('Clean-up for a clip. Steady eases jitter and follows a fast move. Keep bone lengths stops a limb stretching when the depth is noisy. Plant feet holds a foot that stays down, and sets the floor from those steps. It runs after the body is in the world, so a camera pan does not drag a planted foot. A camera that travels (a dolly, or walking with it handheld) is not solved yet: the body still moves with that camera.')),
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
    h('div', { class: 'row wrap' }, toggle('With its camera', PLACE.cam, (on) => { PLACE.cam = on; keepPlace(); }),
      field('Person', h('input', { type: 'number', min: 0, max: 16, step: 1, value: PLACE.person || 0, 'aria-label': 'Person number',
        onchange: (e) => { PLACE.person = Math.max(0, Math.min(16, Math.round(+e.target.value) || 0)); keepPlace(); } })),
      help('Also tracks the clip (on the server, no GPU) and adds its camera as a new camera, Mocap camera, made active, with the clip as the backdrop. The body is placed in the world through that camera, so in a panning shot it stays where it is while the camera turns. Only a camera that turns is solved: pans, tilts, roll and zoom. A camera that travels (a dolly, walking with it handheld) is not solved yet, so the body moves with the camera instead. The lens comes from the capture when it says (newer Deck Save Body Motion), else 35 mm. Person is which one, when the clip has several (0 is the first).')),
    h('div', { class: 'actions' },
      button('Pick the clip…', () => {
        const id = target(o);
        openVideoPicker({ title: 'Video of a person', onPick: (val) => {
          if (!PLACE.cam) return run(id, MOCAP_TPL, [[(f) => f.kind === 'video', val],
            [(f) => /person/i.test(f.label), PLACE.person || 0]], 'Motion from video');
          const tr = trackClip(val);
          tr.catch(() => {});   // (reported when the motion lands)
          run(id, MOCAP_TPL, [[(f) => f.kind === 'video', val],
            [(f) => /person/i.test(f.label), PLACE.person || 0]], 'Motion from video', async (fid, m, label) => applyWithCamera(fid, m, await tr, label));
        } });
      }, { cls: 'primary' }),
      button('Cancel', closeSheet)));
}

export function motionField(o) {
  const text = tpl(TEXT_TPL), mocap = tpl(MOCAP_TPL);
  const imp = fileButton('Import file…', async ([file]) => {
    const form = new FormData(); form.append('file', file);
    form.append('smooth', PLACE.steady === false ? '0' : '1'); form.append('bones', PLACE.bones === false ? '0' : '1');
    try { await apply(target(o), await api('/api/motion/file', { method: 'POST', form }), file.name); }
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
