// A VFX effect's fields in the Edit pane (edit-ops.js opFields for a video op with `vfx`): what the VFX tab's panel shows
// for it, on an op's options (this device's) and the frame's own state (frame.ops[op]: its marks, mattes and key), less the
// source (the frame's own clip). Marks are placed on the open frame (frame-overlay.js); here are their counts and Clear.
//
//   vfxFields(op, e, st, io) -> DOM[]
//     op: the edit op; e: its vfx-rules.js effect; st: the state shown (options over the frame's state)
//     io: { set(k, v, redraw?) (an option), setFrame(k, v) (the frame's state, every selected frame), redraw(), live (the
//           first frame is open), frame (it), tool (the overlay's tool in use), setTool(name), neg, setNeg(on),
//           compare() (or null: no result to compare yet), clipLen (seconds of the frame's clip, or null) }
//   clipsOf(frame), pickClip(frame, set, title)   a video frame's clips (with their trims), and a sheet to pick one
//   imageSize(name, area), imageNat(name)         a picture's size (for a run's Width / Height and paths)
import { sizeChoices, sizeOrMatch } from './size-picker.js';
import { h, api, toast, button, field, seg, hint, help, note, info, rangeField, toggle, textArea, colorField, seedField, openSheet, closeSheet,
  section, actions, icon } from './ui.js';
import { S, inputUrl, previewUrl } from './core.js';
import { bareSource, clipLabel, soundInput, uploadImage } from './media.js';
import { openSourcePicker } from './source-picker.js';
import { pictureInput } from './picture-input.js';
import { keyRangeFields, loraChoice, restyleLora } from './clip-effects.js';
import { roleField, template } from './make.js';
import { ALPHA, ASPECTS, CANVAS, FACE, KEY, REFINE, RES, SAM, lenFrames, needsOf, resOf, shortSideSize, tplIdOf } from './vfx-rules.js';
import { TALK_ENGINES, talkKey } from './talk.js';
import { characterById, characters, loadCharacters, mainPicture } from './characters.js';
import { DOC_KIND } from './table-model.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const copy = (v) => JSON.parse(JSON.stringify(v ?? null));

// area: at most that many pixels (0: as it is); sides to multiples of 32
export const imageSize = (name, area = 0) => new Promise((res) => {
  const im = new Image();
  im.onload = () => {
    const k = area ? Math.min(1, Math.sqrt(area / (im.naturalWidth * im.naturalHeight))) : 1;
    res([Math.round((im.naturalWidth * k) / 32) * 32, Math.round((im.naturalHeight * k) / 32) * 32]);
  };
  im.onerror = () => res(null);
  im.src = inputUrl(name);
});
export const imageNat = (name) => new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res(null); im.src = inputUrl(name); });

// ---- clips on the table's video frames (a matte, a sound's clip) ----
export async function clipsOf(frame) {
  if (!frame?.doc) return [];
  const vid = await import('./video.js');
  const t = vid.videoTabs?.();
  if (t?.active?.id === frame.doc) await t.flush();   // (the open edit's latest)
  const d = await api(`/api/store/${DOC_KIND.video}/${frame.doc}${qs()}`, { busy: false }).catch(() => null);
  return (d?.payload?.items || []).filter((it) => it.kind === 'video' && it.src && (it.src.generation != null || it.src.media)).map((it) => {
    const end = it.out ?? it.dur;
    return { it, src: { ...bareSource(it.src), ...(it.label && { label: it.label }), trim: { start: it.in || 0, ...(end ? { len: +(end - (it.in || 0)).toFixed(4) } : {}) } } };
  });
}
// a sheet to pick one clip: this frame's first, then the other video frames' on the table (source-picker.js, This table tab)
export function pickClip(frame, set, title = 'Pick a clip') {
  return openSourcePicker({ kinds: ['video'], want: 'clip', title, frame, onPick: set });
}

// a matte clip (white = keep), kept on the frame
function matteField(k, label, io, st, tip) {
  const v = st[k];
  const set = (val) => io.setFrame(k, val ? { ...bareSource(val), ...(val.label && { label: val.label }), ...(val.trim && { trim: val.trim }) } : null);
  return field(label, h('div', { class: 'row wrap' },
    h('span', { class: 'grow' }, v ? clipLabel(v) : 'None yet'),
    button('Pick…', () => openSourcePicker({ kinds: ['video'], want: 'clip', title: label, onPick: set }), { cls: 'small' }),
    io.frame ? button('From the table…', () => pickClip(io.frame, set, label), { cls: 'small', title: 'A clip on this frame\'s timeline, or on another video frame' }) : null,
    v ? button('Clear', () => set(null), { cls: 'small ghost' }) : null), tip ? help(tip) : null);
}

// a tool's toggle on the open frame (or why it can't be used here)
const toolBtn = (io, name, on, off) => (io.live
  ? button(io.tool === name ? on : off, () => io.setTool(io.tool === name ? null : name), { cls: `small${io.tool === name ? ' primary' : ''}`, 'aria-pressed': String(io.tool === name) })
  : null);

function pointsFields(st, io) {
  const p = st.points || { positive: [], negative: [] }, n = (p.positive?.length || 0) + (p.negative?.length || 0);
  return h('div', { class: 'edit-marks' },
    h('div', { class: 'row wrap' },
      toolBtn(io, 'points', 'Placing points', 'Place points'),
      io.live ? seg([['0', 'Include'], ['1', 'Exclude']], io.neg ? '1' : '0', (v) => io.setNeg(v === '1')) : null,
      n ? button('Clear', () => { io.setFrame('points', { positive: [], negative: [] }); io.setFrame('pointsAt', 0); }, { cls: 'small ghost' }) : null),
    hint(n ? `${p.positive?.length || 0} point${p.positive?.length === 1 ? '' : 's'} in, ${p.negative?.length || 0} out, at ${(st.pointsAt || 0).toFixed(2)} s`
      : io.live ? 'No points yet: tap the thing on the frame, or name it below.' : 'No points: name it below, or open the frame to tap it.'));
}
function boxesFields(st, io, find) {
  const n = (st.boxes || []).length;
  return h('div', { class: 'edit-marks' },
    h('div', { class: 'row wrap' },
      toolBtn(io, 'boxes', 'Drawing boxes', 'Draw boxes'),
      button('Find', find, { cls: 'small', title: 'Looks for a mark that stays put while the picture moves' }),
      n ? button('Undo box', () => io.setFrame('boxes', st.boxes.slice(0, -1)), { cls: 'small ghost' }) : null,
      n ? button('Clear', () => io.setFrame('boxes', []), { cls: 'small ghost' }) : null),
    hint(n ? `${n} box${n > 1 ? 'es' : ''} on this frame` : 'No boxes: Run looks for the mark itself (Find).'),
    help('Make each box a little bigger than the mark, shadow and glow included. Find looks for edges that stay put while the picture moves; on a still shot it finds nothing. Boxes snap to the grid and edges set on the frame.'));
}
function pathsFields(st, io) {
  const n = (st.tracks || []).length;
  return h('div', { class: 'edit-marks' },
    h('div', { class: 'row wrap' },
      toolBtn(io, 'paths', 'Drawing paths', 'Draw paths'),
      n ? button('Undo path', () => io.setFrame('tracks', st.tracks.slice(0, -1)), { cls: 'small ghost' }) : null,
      n ? button('Clear', () => io.setFrame('tracks', []), { cls: 'small ghost' }) : null),
    hint(`${n} path${n === 1 ? '' : 's'}`));
}

function keyFields(st, io) {
  const k = { ...KEY, ...(st.key || {}) }, save = () => io.setFrame('key', { ...k });
  return [colorField('Key colour', () => k.color, (c) => { k.color = c; save(); }),
    io.live ? toolBtn(io, 'color', 'Picking: tap the frame', 'Pick from the frame') : null,
    ...keyRangeFields(k, save)];
}

function refineFields(st, io) {
  const r = { ...REFINE, ...(st.refine || {}) }, save = () => io.setFrame('refine', { ...r });
  const num = (k, label, opts) => rangeField(label, () => r[k] ?? REFINE[k], (v) => { r[k] = v; }, { onChange: save, ...opts });
  const px = (v) => `${v > 0 ? '+' : ''}${Math.round(v)} px`;
  return [
    st.matte2 ? field('Combine', seg([['union', 'Either'], ['intersect', 'Both'], ['subtract', 'First minus second'], ['average', 'Average']], r.combine,
      (v) => { r.combine = v; save(); }, { wrap: true }),
    help('Either keeps what either matte keeps (fills gaps one misses). Both keeps only what they agree on (drops strays). Minus cuts the second out of the first.')) : null,
    num('grow', 'Grow / shrink', { min: -20, max: 20, step: 1, fmt: px, help: 'Plus dilates the edge outwards, minus erodes it inwards (a halo off, or fringe back).' }),
    num('close', 'Fill holes', { min: 0, max: 20, step: 1, fmt: (v) => `${Math.round(v)} px`, help: 'Closes holes and gaps up to this size (grows, then shrinks back).' }),
    num('smooth', 'Steady', { min: 0, max: 9, step: 1, fmt: (v) => (v > 1 ? `${Math.round(v)} frames` : 'off'), help: 'Averages each frame with its neighbours: less flicker at the edges, a little lag on fast moves.' }),
    num('low', 'Edge: black below', { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) }),
    num('high', 'Edge: white above', { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), help: 'Bring the two together for a hard edge; apart for a soft one.' }),
    num('feather', 'Feather', { min: 0, max: 30, step: 0.5, fmt: (v) => `${v.toFixed(1)} px`, help: 'Blurs the edge.' }),
    toggle('Invert (keep what\'s black)', r.invert, (on) => { r.invert = on; save(); }),
    button('Reset', () => io.setFrame('refine', { ...REFINE }), { cls: 'small' }),
  ];
}

function canvasFields(st, io) {
  const c = { ...CANVAS, ...(st.canvas || {}) }, save = () => io.setFrame('canvas', { ...c });
  const pct = (v) => `${Math.round(v * 100)}%`;
  const num = (k, label, opts) => rangeField(label, () => c[k], (v) => { c[k] = v; }, { onChange: save, fmt: pct, ...opts });
  return [
    field('Canvas', seg(ASPECTS.map(([v, l]) => [v, l]), ASPECTS.some(([v]) => Math.abs(v - (c.aspect || 0)) < 1e-6) ? c.aspect : 0,
      (v) => { c.aspect = Number(v); save(); io.redraw(); }, { wrap: true }),
    help('Its shape. The clip keeps its own resolution at size 1; the frame grows around it.')),
    num('scale', 'Clip size', { min: 0.3, max: 1.5, step: 0.01, help: '100% fits the clip inside the canvas.' }),
    num('cx', 'Across', { min: 0, max: 1, step: 0.01 }),
    num('cy', 'Up / down', { min: 0, max: 1, step: 0.01 }),
    button('Centre', () => { c.cx = 0.5; c.cy = 0.5; save(); io.redraw(); }, { cls: 'small' }),
  ];
}

function samFields(st, io) {
  const s = { ...SAM, ...(st.sam || {}) }, save = () => io.set('sam', { ...s });
  return [rangeField('How sure', () => s.score, (v) => { s.score = v; }, { min: 0.05, max: 0.95, step: 0.05, onChange: save,
    help: 'What SAM3 needs to be sure of before it takes something it was asked for by name. Lower finds more, and may take the wrong things; higher finds less. Tapped points don\'t use this much.' }),
  field('Follow it', seg([['both', 'Both ways'], ['forward', 'Forward']], s.direction === 'forward' ? 'forward' : 'both', (v) => { s.direction = v; save(); }),
    help('From the frame you tapped on (the first frame when you name it). Forward leaves the frames before it empty.')),
  rangeField('Object number', () => s.which, (v) => { s.which = v; }, { min: -1, max: 9, step: 1, fmt: (v) => (v < 0 ? 'All' : String(v)), onChange: save,
    help: 'All puts everything SAM3 found in one mask. A number takes one of them, by SAM3\'s own numbering: it doesn\'t go by position, and some numbers are empty, so try a few.' })];
}
function alphaFields(st, io) {
  const a = { ...ALPHA, ...(st.alpha || {}) }, save = () => io.set('alpha', { ...a });
  const num = (k, label, o) => rangeField(label, () => a[k], (v) => { a[k] = v; }, { onChange: save, ...o });
  return [num('strength', 'Matte strength', { min: 0, max: 1.5, step: 0.05, help: 'How strongly the matte model is applied. It was trained at 1.' }),
    num('hold', 'Hold to the clip', { min: 0, max: 1, step: 0.05, help: 'How closely the matte keeps to the clip\'s picture. Lower lets the model drift.' }),
    ...(st.matte ? [num('margin', 'Crop room', { min: 0, max: 2, step: 0.05, help: 'Room round the thing on each side, as a share of its size.' }),
      field('Crop', seg([['auto', 'Auto'], ['still', 'Still'], ['follow', 'Follow']], a.follow, (v) => { a.follow = v; save(); io.redraw(); }),
        help('Still: one crop over everywhere the thing goes. Follow: a smaller crop that moves with it. Auto: still, unless that crop would be much bigger.')),
      a.follow === 'still' ? null : num('steady', 'Crop steadiness', { min: 0, max: 0.99, step: 0.01, help: 'How steady a following crop is.' }),
      toggle('Only the masked thing', a.onlyMask, (on) => { a.onlyMask = on; save(); io.redraw(); }),
      a.onlyMask ? num('grow', 'Past the mask', { min: 0, max: 0.5, step: 0.01, help: 'How far past the mask the matte is kept, as a share of the crop\'s short side.' }) : null] : [])];
}
function faceFields(st, io) {
  const f = { ...FACE, ...(st.face || {}) }, face = (st.blend || 'face') === 'face', save = () => io.set('face', { ...f });
  const num = (k, label, opts) => rangeField(label, () => f[k] ?? FACE[k], (v) => { f[k] = v; }, { fmt: (v) => v.toFixed(2), onChange: save, ...opts });
  return [face ? num('grow', 'Face size', { min: 0.8, max: 1.4, step: 0.01, help: 'How far past the face outline the new face reaches.' }) : null,
    num('feather', 'Edge softness', { min: 0.05, max: 1, step: 0.01, help: 'Lower gives a firmer edge; higher fades it out over a wider band.' }),
    face ? num('chin', 'Chin', { min: 0.5, max: 1.3, step: 0.01, help: 'Moves the lower edge. Lower it if the new face spills onto the neck or collar.' }) : null];
}
function lorasField(t, st, io) {
  const stack = roleField(t, 'loras'), one = roleField(t, 'lora'), f = stack || one;
  if (!f) return null;
  const opts = f.options.filter((o) => /ltx/i.test(o) && (stack ? !/ic-lora|ripple/i.test(o) : restyleLora(o)));
  const list = opts.length ? opts : f.options, loras = copy(st.loras || []);
  const cur = loras[0]?.name ?? (one ? f.value : null);
  return loraChoice(list, cur, (name) => io.set('loras', name ? [{ name, strength: loras[0]?.strength ?? 1, enabled: true }] : [], true),
    loras[0] && { get: () => loras[0].strength, set: (v) => { loras[0].strength = v; } }, { none: !!stack, onStrength: () => io.set('loras', loras) });
}

// the picture the effect starts from, or acts with; on the open frame, its frame at the playhead can be taken
const FIRST_LABEL = { ripple: 'Edited first frame', layout: 'Look (first frame)', animate: 'Character', faceswap: 'Character', drive: 'Character',
  ltxdrive: 'Character', extend: 'Start frame (optional)', talk: 'Who speaks (a picture)', ingredients: 'Ingredients sheet' };
function firstField(e, st, io) {
  const optional = e.needs.includes('first?');
  const take = async () => {
    const { videoStill } = await import('./video.js');
    const blob = await videoStill();
    if (!blob) return toast('The frame has nothing to take yet', true);
    try { io.set('first', (await uploadImage(blob, { source: 'vfx', filename: 'frame.png' })).name, true); } catch (err) { toast(err.message, true); }
  };
  const edit = ['ripple', 'animate', 'faceswap', 'drive', 'ltxdrive'].includes(e.id);
  return pictureInput({ label: FIRST_LABEL[e.id] || (optional ? 'Start image (optional)' : 'Start image'), name: st.first || '',
    set: (n) => io.set('first', n || null, true), onClear: () => io.set('first', null, true),
    tip: e.id === 'ripple' ? 'Take the frame (or Grab frame), change it in its image frame (Edit from a prompt, Swap…), then Choose… the edited picture here.' : null,
    buttons: [io.live ? button('Take this frame', take, { title: 'The open frame\'s picture at the playhead' }) : null,
      st.first && edit ? button('As an image frame', async () => {   // (to change it there: its result is chosen here after)
        try {
          const f = await (await import('./edit-ops.js')).frameBeside(io.frame || null, { input: st.first }, { label: `Start · ${io.frame?.label || 'image'}` });
          if (f) toast(`${f.label} is beside the frame: change it there, then Choose… it here`);
        } catch (err) { toast(err.message, true); }
      }, { title: 'The picture as an image frame beside this one, to change with its Edit ops' }) : null] });
}

// ---- Talking shot: who, the line, its voice, spoken by the Sound tab's engines into the op's sound ----
const TALK = { voices: null, castFor: undefined, speaking: false };
function lineFields(st, io) {
  const L = { char: null, voice: null, engine: 'qwen', text: '', delivery: '', said: null, ...(st.talk || {}) }, save = (redraw) => io.set('talk', { ...L }, redraw);
  if (TALK.castFor !== S.project) { TALK.castFor = S.project; loadCharacters().then(() => io.redraw(), () => {}); }
  const cast = characters();
  if (!TALK.voices) { TALK.voices = []; api('/api/voice/voices', { busy: false }).then((v) => { TALK.voices = v || []; io.redraw(); }, () => {}); }
  const sel = (label, opts, cur, set) => {
    const el = h('select', { 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, selected: v === (cur || '') }, t)));
    el.addEventListener('change', () => set(el.value || null));
    return el;
  };
  const pickChar = (id) => {
    const c = characterById(id);
    L.char = c ? c.id : null;
    if (c?.voice) L.voice = c.voice;
    if (c && mainPicture(c)) io.set('first', mainPicture(c));
    save(true);
  };
  const speak = async () => {
    if (!L.voice) return toast('Choose a voice first', true);
    if (!L.text.trim()) return toast('Write the line first', true);
    TALK.speaking = true; io.redraw();
    try {
      const { waitJob } = await import('./clipimport.js');
      const r = await waitJob(await api('/api/voice/speak', { method: 'POST', busy: false, body: {
        lines: [{ voice: L.voice, text: L.text.trim(), delivery: L.delivery.trim() || null }], engine: L.engine || 'qwen', name: 'talk' } }));
      const m = r.lines[0];
      L.said = { key: talkKey(L), seconds: m.seconds };
      io.set('sound', { media: m.name });
      save();
    } catch (err) { toast(err.message, true); } finally { TALK.speaking = false; io.redraw(); }
  };
  const vs = TALK.voices || [];
  const stale = st.sound && L.said && L.said.key !== talkKey(L);
  return [
    cast.length ? field('Character', sel('Character', [['', 'None'], ...cast.filter((c) => c.name.trim()).map((c) => [c.id, c.name])], L.char, pickChar),
      help('Their main picture becomes the start image and their voice speaks the line; their look goes in the prompt.')) : null,
    field('Voice', vs.length ? sel('Voice', [['', 'Choose…'], ...vs.map((v) => [v.id, v.name])], L.voice, (v) => { L.voice = v; save(true); })
      : hint('No voices saved yet: a sound frame\'s Edit ▸ New voice makes one.')),
    field('Line', textArea(() => L.text, (v) => { L.text = v; save(); }, { rows: 2, label: 'The line', placeholder: 'What they say' })),
    field('Delivery', h('input', { type: 'text', value: L.delivery || '', placeholder: 'calm, angry, whispering…', 'aria-label': 'How it is said',
      onchange: (ev) => { L.delivery = ev.target.value.trim(); save(); } }), help('IndexTTS-2 and Fish S2 act it out (Qwen ignores it). It also goes in the prompt.')),
    field('Engine', seg(TALK_ENGINES, L.engine || 'qwen', (v) => { L.engine = v; save(); }, { wrap: true })),
    h('div', { class: 'row wrap' }, button([icon('mic'), st.sound && L.said ? 'Speak it again' : 'Speak the line'], speak, { cls: st.sound ? 'small' : 'small primary', disabled: TALK.speaking })),
    TALK.speaking ? hint('Speaking…') : null,
    stale ? note('The line changed since it was spoken: speak it again.') : null,
    soundInput(st.sound, (v) => { io.set('sound', v); L.said = null; save(true); }, { title: 'Someone speaking the line', label: 'Spoken line' }),
  ];
}

export function vfxFields(op, e, st, io) {
  const need = needsOf(e), t = template(tplIdOf(e, st)) || (tplIdOf(e, st) && S.templates.find((x) => x.id === tplIdOf(e, st)));
  const set = (k) => (v) => io.set(k, v);
  const out = [];
  if (tplIdOf(e, st) && !t) out.push(note(`Template ${tplIdOf(e, st)} isn't installed yet. It comes with the LTX-2.5 setup.`));
  if (t?.error) out.push(note(t.error, 'err'));
  // inputs
  if (need.has('sound')) out.push(soundInput(st.sound, (v) => io.set('sound', v, true), { title: 'The sound the clip moves to', label: 'Sound' }));
  if (need.has('line')) out.push(...lineFields(st, io));
  if (need.has('first')) out.push(firstField(e, st, io));
  if (need.has('voice')) out.push(soundInput(st.voice, (v) => io.set('voice', v, true), { title: 'A voice to speak with', label: 'Voice (optional)' }));
  if (need.has('matte')) out.push(matteField('matte', e.needs.includes('matte?') ? 'Matte clip (optional)' : 'Matte clip', io, st,
    e.id === 'alpha' ? 'A mask of one thing (white) from the same clip, made with Mask (SAM3): the cut-out is made on a crop round it, sharper, of just that thing.'
      : e.id === 'inpaint' ? 'White is painted over with the prompt; black is kept as it is.' : 'White keeps the picture; black goes see-through (or is removed).'));
  if (need.has('matte2')) out.push(matteField('matte2', 'Combine with (optional)', io, st));
  if (need.has('points')) out.push(pointsFields(st, io));
  if (need.has('boxes')) out.push(boxesFields(st, io, io.find));
  if (need.has('tracks')) out.push(pathsFields(st, io));
  // the prompt
  if (need.has('prompt')) {
    out.push(field(e.id === 'mask' ? 'Name it' : 'Prompt', textArea(() => st.prompt || '', (v) => io.set('prompt', v), { rows: 3, label: 'Prompt',
      placeholder: e.id === 'mask' ? 'What to cut out, e.g. "the man in the red coat"' : need.has('line') ? 'Leave empty for one made from the line' : 'Describe the result' })));
  }
  // settings
  if (e.sd) out.push(field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], st.poser || 'dwpose', (v) => io.set('poser', v, true)),
    help('DWPose runs on the CPU. SDPose uses the GPU and holds up better on hard poses, people turned away, hands near the body and stylised footage (up to 2 people).')));
  if (need.has('keycolor')) out.push(...keyFields(st, io));
  if (need.has('boxes')) out.push(field('Quality', seg([['quality', 'Quality'], ['fast', 'Fast']], st.delogo || 'quality', set('delogo')),
    help('Quality runs ProPainter on the GPU: about a minute for 10 s with small boxes. Fast is ffmpeg\'s delogo: seconds, but the box goes soft.')));
  if (need.has('refine')) out.push(...refineFields(st, io));
  if (need.has('sam')) out.push(...samFields(st, io));
  if (need.has('alpha')) out.push(...alphaFields(st, io));
  if (need.has('invert')) {
    const k = { ...(st.key || {}) };
    out.push(toggle('Invert (keep what\'s black)', !!k.invert, (on) => io.setFrame('key', { ...k, invert: on })));
  }
  if (need.has('canvas')) out.push(...canvasFields(st, io));
  if (need.has('loras') && t) out.push(lorasField(t, st, io));
  if (need.has('len')) {
    const max = e.maxLen || 10, whole = st.len == null;
    out.push(rangeField(whole ? 'Length (the clip\'s)' : 'Length', () => (st.len ?? Math.min(max, Math.max(1, io.clipLen || 5))), (v) => io.set('len', v),
      { min: 1, max, step: 1 / 3, fmt: (v) => (e.maxLen ? `${v.toFixed(1)}s` : `${v.toFixed(1)}s · ${lenFrames(v)} frames`), onChange: () => io.redraw(),
        help: e.lenHelp || (e.maxLen ? 'Longer clips run as overlapping 5 s windows: time grows with length, memory doesn\'t.' : 'LTX makes 8n+1 frames at 24 fps; long clips need a lot of memory.') }),
    whole ? null : button('Whole clip', () => io.set('len', null, true), { cls: 'small ghost', title: 'As long as the frame\'s clip (up to the most it takes)' }));
  }
  if (need.has('res')) out.push(sizeChoices({ label: 'Output size', choices: e.res || RES, value: resOf(e, st), onPick: (v, typed) => { io.set('resFree', typed); io.set('res', Number(v)); },
    sizeOf: (v) => shortSideSize(io.nat, v, e.mult), words: (v) => `${v}p`, custom: { label: 'Short side', min: 256, max: 2160, step: e.mult || 32 },
    tip: help(e.res ? 'The short side, in pixels. Higher is sharper and slower.' : 'The short side, in pixels. 704p takes about 1.5 minutes for 5 s on this card; 1088p about 3.') }));
  if (need.has('steps')) out.push(field('Steps', seg([[3, 'Fast'], [5, 'Balanced'], [7, 'Quality']], st.steps || 3, (v) => io.set('steps', Number(v))),
    help('Fast is the upstream default (3 steps). Quality can over-sharpen.')));
  if (need.has('blend')) {
    out.push(field('Blend', seg([['face', 'Face'], ['oval', 'Head']], st.blend || 'face', (v) => io.set('blend', v, true)),
      help('Face keeps the original hair, neck and collar. Head pastes the whole tracked square (hair included), with a soft edge.')), ...faceFields(st, io));
  }
  if (need.has('outsize')) out.push(sizeChoices({ label: 'Output size', choices: [['FullHD', 'Full HD'], ['4K', '4K']], value: st.outsize || 'FullHD', onPick: set('outsize'), sizeOf: (v) => (v === '4K' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 }), tip: help('4K is tiled: much slower, same memory.') }));
  if (need.has('size')) out.push(sizeOrMatch({ matchLabel: 'Same size as the source', size: st.size, onChange: set('size'), first: [1280, 704], step: e.mult || 32 }));
  if (need.has('seed')) {
    out.push(seedField('Seed', { get: () => st.seed ?? -1, set: (v) => io.set('seed', v), increment: false,
      mode: () => ((st.seed ?? -1) < 0 ? 'random' : 'fixed'), setMode: (m) => io.set('seed', m === 'random' ? -1 : Math.max(0, st.seed ?? 0), true) }));
  }
  if (io.compare) out.push(h('div', { class: 'row wrap' }, button([icon('swap'), 'Compare with the result'], io.compare, { cls: 'small', title: 'This frame\'s clip and its newest result, wiped across on the frame' })));
  return out.flat(Infinity).filter(Boolean);   // (a field may come as a list)
}
