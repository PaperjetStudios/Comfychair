import { $, h, api, toast, clamp, button, iconBtn, seg, field, section, hint, help, note, placeholder, rangeField, mediaCard, toggle, textArea, pctFmt } from './ui.js';
import { S, inputUrl, thumbUrl, onServer, switchTab } from './core.js';
import { bareSource, cardMedia, clipLabel, clipUrl, genLabel, openImagePicker, openVideoPicker, pickFrame, projectOutputs, soundInput, uploadImage } from './media.js';
import { hooks as genHooks } from './generate.js';
import { adoptGenerations, queueRun, roleField, runAndWait, template, valuesByRole, waitGen } from './make.js';
import { openGeneration } from './run.js';
import { addToEditor, useInGenerate } from './editor.js';
import { addToTimeline } from './video.js';
import { clipInput } from './vfield.js';
import { TabSet } from './tabs.js';
import { maximizable } from './layout.js';
import { sendToCraft } from './craft.js';

// ---------------------------------------------------------------------------
// VFX: one effect per tab, run on a clip (or from a still) with LTX-2.5 and friends. Each effect
// is a template (deck-ltx-*) whose tagged fields are found by their group names (make.js ROLES), or a
// server job (keying). The viewer wipes between the source and a result; points and motion
// paths are drawn on it. Results go back to the Video timeline.
// ---------------------------------------------------------------------------
const FPS = 24;   // LTX runs at 24 fps; lengths are 8n+1 frames

// group: the sideNav-like family; tpl: the template it runs; needs: the inputs it shows
const EFFECTS = [
  { id: 'delogo', group: 'Quick', label: 'Remove watermark', job: 'delogo', needs: ['source', 'boxes'],
    help: 'Draw a box over each logo, caption or mark (or tap Find). Quality fills the boxes with ProPainter from what the other frames show behind them; the rest of the picture is left exactly as it was. Fast is instant but smears the box.' },
  { id: 'depth', group: 'Quick', label: 'Depth map', tpl: 'deck-depth-video', still: 'deck-depth-image', maxLen: 20, needs: ['source?', 'first?', 'len', 'depthModel'],
    lenHelp: 'Up to 20 s at 24 fps. The depth is worked out over the whole clip, so it stays steady from frame to frame.',
    help: 'A grey depth map (near is white) of a clip, or of a picture when there is no clip: Video Depth Anything. Use it as H3 control, in Layout to render, or for compositing.' },
  { id: 'ripple', group: 'Restyle', label: 'Ripple edit', tpl: 'deck-ltx-ripple', needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    help: 'Change the first frame (in Generate with an edit template, or in the Editor), and the change carries through the whole clip.' },
  { id: 'lora', group: 'Restyle', label: 'LoRA restyle', tpl: 'deck-ltx-v2v-lora', needs: ['source', 'loras', 'prompt', 'len', 'res', 'seed'],
    help: 'Runs the clip through an IC-LoRA: deblur, colourise, restore, day to night, head swap and so on. Pick the LoRA and its strength, and describe the result in the prompt (for colourise, name the colours): with an empty prompt the change is faint.' },
  { id: 'alpha', group: 'Key', label: 'Alpha Gen', tpl: 'deck-ltx-alpha', needs: ['source', 'len', 'res'],
    help: 'Makes a black-and-white matte of the main subject (white = keep). Then use it with "Apply matte", or as a mask.' },
  { id: 'colorkey', group: 'Key', label: 'Colour key', job: 'key', needs: ['source', 'keycolor'],
    help: 'Cuts out a green or blue screen. Quick: runs on the server with ffmpeg, no GPU.' },
  { id: 'mattekey', group: 'Key', label: 'Apply matte', job: 'key', needs: ['source', 'matte'],
    help: 'Uses a matte clip (white = keep) as the clip\'s see-through channel, so lower tracks show through.' },
  { id: 'refine', group: 'Key', label: 'Refine matte', job: 'matte', needs: ['source?', 'matte', 'matte2', 'refine'],
    help: 'Cleans up a matte or mask (white = keep), or combines two: SAM3\'s and Alpha Gen\'s, say. Grow or shrink it, fill holes, steady it, harden or soften the edge. Quick: ffmpeg on the server, no GPU. Then Use as matte / mask.' },
  { id: 'mask', group: 'Remove', label: 'Mask (SAM3)', tpl: 'deck-sam3-video-mask', needs: ['source', 'points', 'prompt', 'len'],
    help: 'Tap the thing to cut out on the frame (Exclude marks what to leave out), or describe it. SAM3 follows it through the clip and makes a mask clip.' },
  { id: 'inpaint', group: 'Remove', label: 'Replace', tpl: 'deck-ltx-inpaint', mult: 64, needs: ['source', 'matte', 'prompt', 'len', 'res', 'seed'],
    help: 'Paints something new where a mask clip is white (make one with Mask (SAM3) or Alpha Gen) and keeps the rest of the picture. Describe the whole shot with the new thing in it.' },
  { id: 'extend', group: 'Generate', label: 'Extend frame', tpl: 'deck-ltx-inpaint', mult: 64, needs: ['source', 'canvas', 'first?', 'prompt', 'len', 'res', 'seed'],
    help: 'Puts the clip on a bigger or differently shaped canvas (portrait to landscape, say) and paints the rest (outpainting). Pick the canvas, then drag the clip on the preview or set its size and place. Describe the whole wider shot. For new parts that should look like a reference (a character, a room), make a start frame: the first frame on its canvas, filled in by an image edit with your references; the clip then grows out of it.' },
  { id: 'cleanplate', group: 'Remove', label: 'Clean plate', tpl: 'deck-ltx-cleanplate', needs: ['source', 'prompt', 'len', 'res', 'seed'],
    help: 'Removes people and other moving things from the whole clip and fills in the background. Name what to remove in the prompt.' },
  { id: 't2v', group: 'Generate', label: 'Text / image to video', tpl: 'deck-ltx-t2v', needs: ['first?', 'voice', 'prompt', 'len', 'size', 'loras', 'seed'],
    help: 'A new clip from a prompt, optionally starting from a still. Give it a Voice (a few seconds of someone speaking) and the speech in the clip takes on that voice.' },
  { id: 'a2v', group: 'Generate', label: 'Sound to video', tpl: 'deck-ltx-a2v', needs: ['sound', 'first?', 'prompt', 'len', 'size', 'loras', 'seed'],
    help: 'A clip that moves to a sound: speech (lips follow it), music (movement follows the beat) or effects. Pick the sound (a sound file, or the sound of a clip, cut to the part you want), describe the shot, and optionally a start image. The clip is as long as the sound, up to Length, and keeps the sound as it is.' },
  { id: 'layout', group: 'Generate', label: 'Layout to render', tpl: 'deck-ltx-layout', mult: 64, needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    help: 'Turns a rough layout clip (a 3D tab render in Clay or Colour, or blocked-out footage) into a finished shot that keeps its layout and motion.' },
  { id: 'tracks', group: 'Generate', label: 'Motion paths', tpl: 'deck-ltx-tracks', mult: 64, needs: ['first', 'tracks', 'prompt', 'len', 'res', 'seed'],
    help: 'Draw paths on the start image: things under a path\'s start move along it.' },
  { id: 'ingredients', group: 'Generate', label: 'Ingredients sheet', tpl: 'deck-ltx-ingredients', mult: 64, needs: ['first', 'prompt', 'len', 'res', 'seed'],
    help: 'One image with the people and props cut out on a plain white background (Alpha Gen can cut them out), and the place in the prompt. Two whole photos side by side come back as a split screen.' },
  { id: 'upscale', group: 'Generate', label: 'Upscale', tpl: 'deck-ltx-upscale', needs: ['source', 'prompt', 'len', 'outsize', 'seed'],
    help: 'Adds detail at a larger size. Describe the look (light, film, sharpness), not the things in it.' },
  { id: 'animate', group: 'Performance', label: 'Replace character', tpl: 'deck-h3-animate', needs: ['source', 'first', 'len', 'res', 'steps', 'seed'],
    res: [[384, '384p'], [480, '480p'], [576, '576p']], maxLen: 30,
    help: 'Re-renders the person in the clip as the character in the still: the clip\'s motion, face, camera, light and sound are kept (Viggle-Animate on H3). Long clips run in 5 s windows.' },
  { id: 'faceswap', group: 'Performance', label: 'Face only', tpl: 'deck-h3-faceswap', needs: ['source', 'first', 'len', 'res', 'steps', 'blend', 'seed'],
    res: [[384, '384'], [512, '512'], [640, '640']], maxLen: 30,
    help: 'Swaps only the face: it is followed through the clip, re-rendered as the character\'s face with the same expressions, and blended back. Hair, body and the rest of the shot stay. Works best when the face is large in frame.' },
  { id: 'drive', group: 'Performance', label: 'Drive a still', tpl: 'deck-h3-drive', sd: 'deck-h3-drive-sd', posed: 'deck-h3-drive-posed', needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    res: [[384, '384p'], [448, '448p'], [576, '576p']], maxLen: 15,
    help: 'The character in the still acts out the clip: body, hands and face follow the clip\'s pose (H3 with pose control), in a new shot described by the prompt. Call the character <Subject 1> and the still <Picture 1>, and name their clothes and look: otherwise the outfit can drift.' },
  { id: 'ltxdrive', group: 'Performance', label: 'Drive a still (LTX)', tpl: 'deck-ltx-drive', sd: 'deck-ltx-drive-sd', posed: 'deck-ltx-drive-posed', mult: 64, needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    res: [[448, '448p'], [576, '576p'], [704, '704p']],
    help: 'Like Drive a still, on LTX-2.5: the still is the first frame and the clip\'s pose (body, hands, face) moves it. Keeps the still\'s scene and look closely. Describe the person and what they do; the sound is made from the prompt.' },
  { id: 'pose', group: 'Performance', label: 'Pose preview', tpl: 'deck-pose-video', sd: 'deck-pose-sdpose', needs: ['source', 'len'],
    help: 'Shows what Drive a still will follow: the clip\'s body, hands and face as a stick figure.' },
];
const GROUPS = ['Quick', 'Restyle', 'Key', 'Remove', 'Generate', 'Performance'];
const fx = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];

// effects that follow a pose can read it with DWPose (CPU) or SDPose (GPU): e.sd is the SDPose take on e.tpl
const tplId = (e) => (e.sd && T.poser === 'sdpose' ? e.sd : e.still && !T.source && T.first ? e.still : e.tpl);
const tplOf = (e) => tplId(e) && S.templates.find((t) => t.id === tplId(e));

// Viggle-Animate's distilled schedules (shift 3): points = Euler updates + 1
const STEPS = { 3: '1.0, 0.8571428571428571, 0.6, 0.0',
  5: '1.0, 0.9230769230769231, 0.8181818181818182, 0.6666666666666666, 0.42857142857142855, 0.0',
  7: '1.0, 0.9473684210526315, 0.8823529411764706, 0.8, 0.6923076923076923, 0.5454545454545454, 0.3333333333333333, 0.0' };
const RES = [[544, '544p'], [704, '704p'], [1088, '1088p']];
const resOf = (e) => { const r = e.res || RES; return r.some(([v]) => v === T.res) ? T.res : r[1][0]; };

const SIZES = [['Match source', null], ['1280×704', [1280, 704]], ['704×1280', [704, 1280]], ['960×544', [960, 544]],
  ['544×960', [544, 960]], ['1024×1024', [1024, 1024]], ['1920×1088', [1920, 1088]]];

const FACE = { grow: 1.05, feather: 0.25, chin: 0.82 };   // Face only's blend outline (Deck Face Uncrop)
// Refine matte (POST /api/video/matte): combine two mattes, then grow/shrink, fill holes, steady, edge, feather
const REFINE = { combine: 'union', grow: 0, close: 0, smooth: 0, feather: 0, low: 0, high: 1, invert: false };
// Extend frame: the canvas's shape (width / height; 0 = the source's own) and where the clip sits on it
const CANVAS = { aspect: 16 / 9, scale: 1, cx: 0.5, cy: 0.5 };
const BLANK = () => ({ op: 'ripple', source: null, first: null, matte: null, sound: null, voice: null, prompt: '', loras: [], len: 5, res: 704, size: null, seed: -1,
  points: { positive: [], negative: [] }, pointsAt: 0, tracks: [], key: { color: '#00ff00', similarity: 0.12, blend: 0.08, spill: 0.5, invert: false },
  steps: 3, blend: 'face', face: { ...FACE }, results: [], showing: null, matte2: null, refine: { ...REFINE }, canvas: { ...CANVAS }, boxes: [], delogo: 'quality' });
let T = BLANK();
let tabs = null;
// What a run keeps of the tab that made it (params.__face), so History's Edit can open it here again: the settings, not the takes
const tabState = () => { const { results, showing, ...rest } = T; return JSON.parse(JSON.stringify(rest)); };
// cmp: the result on the left instead of the source (comparing takes); layout: 'wipe' or 'side'
// pose: the source's finished pose video for the drives ({ key, r }: r null when there is none, undefined while
// looking); remake: the next drive makes the pose again
const UI = { wipe: 0.5, draw: null, srcInfo: null, playing: false, neg: false, cmp: null, layout: 'wipe', rate: 1, pose: null, remake: false };

// ---- inputs ----
function changed(redraw = true) { tabs?.changed(); if (redraw) render(); }

// From the Video tab (or anywhere): open a VFX tab on this clip
export async function sendToVfx(src, { label = null, trim = null } = {}) {
  switchTab('vfx');
  await ensureTabs();
  T.source = { ...bareSource(src), ...(trim && { trim }), ...(label && { label }) };
  T.showing = null; UI.srcInfo = null;
  changed();
  toast('Clip set as the VFX source: pick an effect');
}

// From the Board or History ("Use as…"): one input of the open VFX tab. role: 'source' | 'matte' (clips),
// 'sound' | 'voice' (sounds, or a clip's sound), 'first' (an input image name). When the effect on show doesn't
// take it, the toast names the ones that do.
const ROLE_NAMES = { source: 'Source clip', matte: 'Matte clip', sound: 'Sound', voice: 'Voice', first: 'Start image' };
export async function useInVfx(role, value, { label = null } = {}) {
  if (role === 'source') return sendToVfx(value, { label });
  switchTab('vfx');
  await ensureTabs();
  T[role] = role === 'first' ? value : bareSource(value);
  changed();
  const uses = (e) => e.needs.some((n) => n.replace('?', '') === role);
  toast(uses(fx(T.op)) ? `${ROLE_NAMES[role]} set` : `${ROLE_NAMES[role]} set: ${EFFECTS.filter(uses).map((e) => e.label).join(', ')} use it`);
}

function sourceField(role = 'source') {
  const isSrc = role === 'source';
  const v = isSrc ? T.source : T.matte;
  const fxDef = fx(T.op);
  const set = (val) => {
    if (isSrc) { T.source = val; UI.srcInfo = null; T.showing = null; } else T.matte = val;
    changed();
  };
  const title = isSrc ? 'Source clip' : (T.op === 'cleanplate' ? 'Mask clip' : 'Matte clip');
  return clipInput({ label: title, value: v, url: isSrc ? clipUrl(v) : null, name: clipLabel(v), onChange: set,   // (a matte is only picked: no player)
    pick: () => openVideoPicker({ title, onPick: set }),
    onEdit: (val) => { T.source = val; changed(false); drawViewer(); poseLine(); },
    loader: () => ({ rate: 0, nth: 1, mapped: true }), budget: () => (fxDef.needs.includes('len') ? { secs: T.len } : null),
    below: isSrc && fxDef.posed ? h('div', { id: 'vfxPose' }) : null,
    buttons: isSrc ? [] : [button('From results…', () => pickResult(set), { title: 'An Alpha Gen or mask result from this tab' })] });
}

function firstField(optional) {
  const pick = () => openImagePicker({ title: T.op === 'ingredients' ? 'Ingredients sheet' : ['animate', 'faceswap', 'drive', 'ltxdrive'].includes(T.op) ? 'Character' : 'First frame', mp: () => 0,
    onPick: (name) => { T.first = name; changed(); } });
  const takeFrame = async () => {
    const url = clipUrl(T.source);
    if (!url) return toast('Choose a source clip first', true);
    const blob = await pickFrame({ url, title: 'Frame to edit' });
    if (!blob) return;
    const r = await uploadImage(blob, { source: 'vfx', filename: 'frame.png' });
    T.first = r.name; changed();
    return r.name;
  };
  const edit = ['ripple', 'animate', 'faceswap', 'drive', 'ltxdrive'].includes(T.op);
  const label = T.op === 'ingredients' ? 'Ingredients sheet' : T.op === 'ripple' ? 'Edited first frame' : T.op === 'layout' ? 'Look (first frame)'
    : ['animate', 'faceswap', 'drive', 'ltxdrive'].includes(T.op) ? 'Character'
    : T.op === 'extend' ? 'Start frame (optional)' : optional ? 'Start image (optional)' : 'Start image';
  return field(label, T.first ? h('img', { class: 'vfx-still', src: thumbUrl(T.first, 480), alt: '' }) : null,
    h('div', { class: 'row wrap' },
      button(T.first ? 'Change…' : 'Choose…', pick, { cls: T.first ? '' : 'primary' }),
      T.source ? button('Take from clip…', takeFrame, { title: 'A frame of the source clip' }) : null,
      T.first && edit ? button('Edit in Generate', () => useInGenerate(T.first, 'Frame set: edit it, then pick the result here')) : null,
      T.first && edit ? button('Edit in Editor', () => addToEditor(T.first)) : null,
      T.op === 'extend' && T.source ? button('Make start frame…', makeStartFrame, { title: 'The first frame on its canvas, to fill in with an image edit and your reference pictures' }) : null,
      T.first ? button('Clear', () => { T.first = null; changed(); }) : null),
    T.op === 'ripple' ? help('Take the clip\'s first frame, change it (Edit in Generate with an edit template, or in the Editor), then Choose… the edited picture here.') : null,
    T.op === 'animate' ? help('One person, whole body or face as in the clip. Best: Take from clip…, then repaint the person as the character (Edit in Generate), so pose and framing match.') : null);
}

// Extend frame's start frame: the clip's first frame (at its trim) on the canvas, the new parts flat grey, opened in
// an image edit with room for reference pictures. The edited picture, picked back here as the start frame, is the
// look LTX carries on into the new parts.
const EDIT_TPL = 'deck-qwen21-edit';
async function makeStartFrame() {
  const v = V.a;
  if (!v?.videoWidth) return toast('Let the clip load first', true);
  const t0 = T.source?.trim?.start || 0;
  if (Math.abs(v.currentTime - t0) > 0.02) { v.pause(); v.currentTime = t0; await new Promise((r) => v.addEventListener('seeked', r, { once: true })); }
  const b = clipBox(), A = canvasAspect();
  let W = v.videoWidth / b.w, H = W / A;
  const k = Math.min(1, 2048 / Math.max(W, H));
  W = Math.round((W * k) / 16) * 16; H = Math.round((H * k) / 16) * 16;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(v, b.left * W, b.top * H, b.w * W, b.h * H);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  let r;
  try { r = await uploadImage(blob, { source: 'vfx', filename: 'start-frame.png' }); } catch (err) { return toast(err.message, true); }
  const t = S.templates.find((x) => x.id === EDIT_TPL && !x.error);
  if (!t || !genHooks.openShot) { useInGenerate(r.name, 'Start frame on its canvas: fill in the grey, then pick the result here'); return; }
  const img = t.fields.find((f) => f.kind === 'image');
  const prompt = t.fields.find((f) => f.kind === 'text' && /edit|prompt/i.test(f.group) && f.input === 'prompt');
  const values = { [img.key]: r.name };
  if (prompt) values[prompt.key] = `Fill the flat grey areas of Picture 1 so the scene continues naturally beyond the original frame${T.prompt.trim() ? `: ${T.prompt.trim()}` : ''}. `
    + 'Keep everything that is already in Picture 1 exactly as it is. Add the people and things from the reference pictures where they belong.';
  switchTab('generate');
  await genHooks.openShot({ workflow: t.id, values }, 'Start frame');
  toast('Fill in the grey (add your references under More references), then pick the result as the start frame');
}

// an IC-LoRA a restyle can use: not the ones that come with their own pipeline (SDR to HDR, Alpha Gen, the other effects')
const restyleLora = (o) => /ic-lora/i.test(o) && !/sdr-to-hdr|alpha-gen|clean-plate|ingredients|layout|motion-track|in-outpaint|refine|upscaler/i.test(o);

function lorasField(t) {
  const stack = roleField(t, 'loras'), one = roleField(t, 'lora');
  const f = stack || one;
  if (!f) return null;
  // a stack (T2V) takes plain LoRAs; a single IC-LoRA slot takes IC-LoRAs (not SDR to HDR: that needs its own pipeline)
  const opts = f.options.filter((o) => /ltx/i.test(o) && (stack ? !/ic-lora|ripple/i.test(o) : restyleLora(o)));
  const list = opts.length ? opts : f.options;
  const cur = T.loras[0]?.name ?? (one ? f.value : null);
  const sel = h('select', { onchange: () => { T.loras = sel.value ? [{ name: sel.value, strength: T.loras[0]?.strength ?? 1, enabled: true }] : []; changed(); } },
    stack ? h('option', { value: '' }, '(none)') : null,
    list.map((o) => h('option', { value: o, selected: cur === o }, o.split('/').pop())));
  if (one && !T.loras.length && cur) T.loras = [{ name: cur, strength: 1, enabled: true }];
  return [field('LoRA', sel), T.loras[0] ? rangeField('Strength', () => T.loras[0].strength, (v) => { T.loras[0].strength = v; },
    { min: 0, max: 2, step: 0.05, onChange: () => changed(false) }) : null];
}

function keyFields() {
  const k = T.key;
  const sw = h('input', { type: 'color', value: k.color, oninput: () => { k.color = sw.value; changed(false); } });
  return [
    field('Key colour', sw, help('Or tap the screen colour on the preview (with Pick colour on).')),
    button(UI.draw === 'color' ? 'Picking: tap the preview' : 'Pick colour', () => { UI.draw = UI.draw === 'color' ? null : 'color'; render(); }, { cls: UI.draw === 'color' ? 'primary' : '' }),
    rangeField('Similarity', () => k.similarity, (v) => { k.similarity = v; }, { min: 0.01, max: 0.6, step: 0.01, onChange: () => changed(false),
      help: 'How close to the key colour a pixel must be to go clear. Raise it until the screen is gone.' }),
    rangeField('Edge blend', () => k.blend, (v) => { k.blend = v; }, { min: 0, max: 0.5, step: 0.01, onChange: () => changed(false) }),
    rangeField('Spill removal', () => k.spill, (v) => { k.spill = v; }, { min: 0, max: 1, step: 0.05, onChange: () => changed(false),
      help: 'Takes the green (or blue) cast off hair and edges.' }),
  ];
}

function pointsFields() {
  const n = T.points.positive.length + T.points.negative.length;
  return [
    h('div', { class: 'row wrap' },
      button(UI.draw === 'points' ? 'Placing points' : 'Place points', () => { UI.draw = UI.draw === 'points' ? null : 'points'; render(); }, { cls: UI.draw === 'points' ? 'primary' : '' }),
      seg([['0', 'Include'], ['1', 'Exclude']], UI.neg ? '1' : '0', (v) => { UI.neg = v === '1'; }),
      n ? button('Clear points', () => { T.points = { positive: [], negative: [] }; changed(); }) : null),
    hint(n ? `${T.points.positive.length} in, ${T.points.negative.length} out, on the frame at ${T.pointsAt.toFixed(2)}s` : 'No points yet: or describe it in the prompt.'),
  ];
}

// Remove watermark's boxes: fractions of the whole source frame, as drawn on the viewer (sent as fractions of the cropped clip)
function boxesFields() {
  const n = (T.boxes ||= []).length;
  return [
    h('div', { class: 'row wrap' },
      button(UI.draw === 'boxes' ? 'Drawing boxes' : 'Draw boxes', () => { UI.draw = UI.draw === 'boxes' ? null : 'boxes'; render(); }, { cls: UI.draw === 'boxes' ? 'primary' : '' }),
      button('Find', findBoxes, { disabled: !T.source }),
      n ? button('Undo box', () => { T.boxes.pop(); changed(); }) : null,
      n ? button('Clear', () => { T.boxes = []; changed(); }) : null),
    hint(n ? `${n} box${n > 1 ? 'es' : ''}. Drag a box to move it, its corner to size it, ✕ to remove it.` : 'No boxes yet: drag over the watermark on the picture.'),
    help('Make each box a little bigger than the mark, shadow and glow included. Find looks for edges that stay put while the picture moves; on a still shot it finds nothing.'),
  ];
}
const cropOf = () => T.source?.crop || { x: 0, y: 0, w: 1, h: 1 };
const clipFracs = (b) => { const c = cropOf(); return { x: (b.x - c.x) / c.w, y: (b.y - c.y) / c.h, w: b.w / c.w, h: b.h / c.h }; };
const delogoBody = () => ({ source: bareSource(T.source), trim: T.source.trim || null, crop: T.source.crop || null });

async function findBoxes() {
  try {
    const r = await api('/api/video/delogo/find', { method: 'POST', body: delogoBody(), timeout: 300000, busy: 'Looking for a watermark…' });
    if (!r.boxes.length) return toast('Nothing stays put in this clip: draw the boxes yourself', true);
    const c = cropOf();   // back to fractions of the whole frame
    T.boxes.push(...r.boxes.map((b) => ({ x: c.x + b.x * c.w, y: c.y + b.y * c.h, w: b.w * c.w, h: b.h * c.h })));
    UI.draw = 'boxes';
    changed();
    toast(`Found ${r.boxes.length}: check them on the picture`);
  } catch (err) { toast('Find failed: ' + err.message, true); }
}

async function runDelogo() {
  if (!T.boxes?.length) return toast('Draw a box over the watermark first', true);
  const quality = T.delogo !== 'fast';
  try {
    const g = await api('/api/video/delogo', { method: 'POST', timeout: quality ? 120000 : 3600000, busy: quality ? 'Queueing…' : 'Removing the watermark…',
      body: { ...delogoBody(), boxes: T.boxes.map(clipFracs), mode: quality ? 'quality' : 'fast', project_id: S.project } });
    S.history.set(g.id, g);
    if (quality) adoptGenerations([g]);
    T.results.push(g.id); T.showing = quality ? T.showing : g.id;
    UI.draw = null;
    changed();
    if (quality) toast(`Queued Remove watermark as #${g.id}`);
  } catch (err) { toast('Remove watermark failed: ' + err.message, true); }
}

function tracksFields() {
  return [h('div', { class: 'row wrap' },
    button(UI.draw === 'tracks' ? 'Drawing paths' : 'Draw paths', () => { UI.draw = UI.draw === 'tracks' ? null : 'tracks'; render(); }, { cls: UI.draw === 'tracks' ? 'primary' : '' }),
    T.tracks.length ? button('Undo path', () => { T.tracks.pop(); changed(); }) : null,
    T.tracks.length ? button('Clear paths', () => { T.tracks = []; changed(); }) : null),
  hint(`${T.tracks.length} path${T.tracks.length === 1 ? '' : 's'}. Drag on the start image from a thing to where it should go.`)];
}

// ---- the panel ----
function render() {
  const body = $('#vfxBody');
  if (!body) return;
  const e = fx(T.op), t = tplOf(e);
  const needs = new Set(e.needs.map((n) => n.replace('?', '')));
  const missing = tplId(e) && !t;
  const runBtn = button(e.job ? ({ colorkey: 'Key clip', refine: 'Refine matte', delogo: 'Remove watermark' }[e.id] || 'Cut out with matte') : 'Run', run, { cls: 'primary', disabled: !!missing });

  const effect = section('Effect', null,
    GROUPS.map((g) => h('div', { class: 'vfx-group' }, h('span', { class: 'vfx-group-name' }, g),
      seg(EFFECTS.filter((x) => x.group === g).map((x) => [x.id, x.label]), T.op, (id) => { T.op = id; UI.draw = null; changed(); }, { wrap: true }))),
    help(e.help),
    missing ? note(`Template ${tplId(e)} isn't installed yet. It comes with the LTX-2.5 setup.`) : null,
    t?.error ? note(t.error, 'err') : null);

  const inputs = section('Source', null,
    needs.has('source') ? sourceField('source') : null,
    needs.has('sound') ? soundInput(T.sound, (v) => { T.sound = v; changed(false); }, { title: 'The sound the clip moves to', label: 'Sound' }) : null,
    needs.has('first') ? firstField(e.needs.includes('first?')) : null,
    needs.has('voice') ? [soundInput(T.voice, (v) => { T.voice = v; changed(false); }, { title: 'A voice to speak with', label: 'Voice (optional)' }),
      help('About 5 seconds of one person speaking clearly. Cut it with Start and Length.')] : null,
    needs.has('matte') ? sourceField('matte') : null,
    needs.has('matte2') ? matte2Field() : null,
    needs.has('points') ? pointsFields() : null,
    needs.has('boxes') ? boxesFields() : null,
    needs.has('tracks') ? tracksFields() : null);

  const prompt = needs.has('prompt') ? section('Prompt', null,
    textArea(() => T.prompt, (v) => { T.prompt = v; tabs?.changed(); }, { rows: 4, label: 'Prompt',
      placeholder: e.id === 'mask' ? 'What to cut out, e.g. "the man in the red coat"' : 'Describe the result' })) : null;

  const settings = section('Settings', null,
    e.sd ? field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], T.poser || 'dwpose', (v) => { T.poser = v; changed(); }),
      help('DWPose runs on the CPU. SDPose uses the GPU and holds up better on hard poses, people turned away, hands near the body and stylised footage (up to 2 people).')) : null,
    needs.has('keycolor') ? keyFields() : null,
    needs.has('depthModel') ? field('Detail', seg([['large', 'Fine'], ['small', 'Fast']], T.depthModel || 'large', (v) => { T.depthModel = v; changed(false); }),
      help('Fine uses the Large model: the sharpest edges, steadiest depth. Fast uses Small: about five times quicker, softer.')) : null,
    needs.has('boxes') ? field('Quality', seg([['quality', 'Quality'], ['fast', 'Fast']], T.delogo || 'quality', (v) => { T.delogo = v; changed(false); }),
      help('Quality runs ProPainter on the GPU: about a minute for 10 s with small boxes. Fast is ffmpeg\'s delogo: seconds, but the box goes soft.')) : null,
    ...(needs.has('refine') ? refineFields() : []),
    ...(needs.has('canvas') ? canvasFields() : []),
    needs.has('loras') ? lorasField(t) : null,
    needs.has('len') ? rangeField('Length', () => T.len, (v) => { T.len = v; }, { min: 1, max: e.maxLen || 10, step: 1 / 3,
      fmt: (v) => (e.maxLen ? `${v.toFixed(1)}s` : `${v.toFixed(1)}s · ${lenFrames(v)} frames`), onChange: () => changed(),
      help: e.lenHelp || (e.maxLen ? 'Longer clips run as overlapping 5 s windows: time grows with length, memory doesn\'t.' : 'LTX makes 8n+1 frames at 24 fps; long clips need a lot of memory.') }) : null,
    needs.has('res') ? field('Resolution', seg(e.res || RES, resOf(e), (v) => { T.res = Number(v); changed(false); }),
      help(e.res ? 'The short side, in pixels. Higher is sharper and slower.' : 'The short side, in pixels. 704p takes about 1.5 minutes for 5 s on this card; 1088p about 3.')) : null,
    needs.has('steps') ? field('Steps', seg([[3, 'Fast'], [5, 'Balanced'], [7, 'Quality']], T.steps || 3, (v) => { T.steps = Number(v); changed(false); }),
      help('Fast is the upstream default (3 steps). Quality can over-sharpen.')) : null,
    needs.has('blend') ? field('Blend', seg([['face', 'Face'], ['oval', 'Head']], T.blend || 'face', (v) => { T.blend = v; changed(); }),
      help('Face keeps the original hair, neck and collar. Head pastes the whole tracked square (hair included), with a soft edge.')) : null,
    ...(needs.has('blend') ? faceFields() : []),
    needs.has('outsize') ? field('Output size', seg([['FullHD', 'Full HD'], ['4K', '4K']], T.outsize || 'FullHD', (v) => { T.outsize = v; changed(false); }),
      help('4K is tiled: much slower, same memory.')) : null,
    needs.has('size') ? field('Size', h('select', { onchange: (ev) => { T.size = SIZES[ev.target.value][1]; changed(false); } },
      SIZES.map(([l, s], i) => h('option', { value: i, selected: JSON.stringify(s) === JSON.stringify(T.size) }, l)))) : null,
    needs.has('seed') ? field('Seed', h('div', { class: 'row' },
      h('input', { type: 'number', value: T.seed < 0 ? '' : T.seed, placeholder: 'random', min: 0,
        onchange: (ev) => { T.seed = ev.target.value === '' ? -1 : Math.max(0, Math.floor(Number(ev.target.value))); changed(false); } }))) : null,
    h('div', { class: 'row wrap' }, runBtn, e.job ? null : button('Open in Generate', openInGenerate,
      { disabled: !!missing, title: 'The same template and values in a new Generate tab, to change any setting there' })));

  body.replaceChildren(h('div', { class: 'panel-body' }, effect, inputs, prompt, settings, resultsSection()));
  drawViewer();
  poseLine();
}

// ---- the drives' pose video: a finished Pose preview of the same clip, trim, crop and poser is followed instead of
// reading the pose again (POST /api/pose/find); without one, the drive makes it first ----
const POSE_TPL = { dwpose: 'deck-pose-video', sdpose: 'deck-pose-sdpose' };
const poseBody = () => ({ source: bareSource(T.source), trim: T.source.trim || null, crop: T.source.crop || null,
  poser: T.poser || 'dwpose', len: T.len, project_id: S.project });
const findPose = () => api('/api/pose/find', { method: 'POST', body: poseBody(), busy: false });

// the "Pose ready · #id" line under the source, looked up again when the clip, trim, crop, poser or Length change
async function poseLine() {
  const box = document.getElementById('vfxPose');
  if (!box || !T.source) return;
  const key = JSON.stringify(poseBody());
  if (UI.pose?.key !== key) {
    const look = UI.pose = { key, r: undefined };
    try { look.r = await findPose(); } catch { look.r = null; }
    if (UI.pose !== look) return;   // changed again while looking
  }
  const r = UI.pose.r, now = document.getElementById('vfxPose');
  if (r === undefined || !now) return;
  if (!r) { now.replaceChildren(); return; }
  now.replaceChildren(h('div', { class: 'row wrap' },
    button(`Pose ready · #${r.generation}`, () => openGeneration(r.generation), { title: 'The pose video the drive will follow: tap to see it' }),
    UI.remake ? h('span', { class: 'hint' }, 'Run reads it again') : null,
    button(UI.remake ? 'Use it' : 'Make again', () => { UI.remake = !UI.remake; poseLine(); },
      { cls: `small${UI.remake ? ' primary' : ''}`, title: UI.remake ? 'Follow this pose video' : 'Read the pose from the clip again on the next Run' })));
}

// A drive on a ready pose video: the clip's own one, or a Pose preview queued first and waited for. false when it
// can't be done (no posed template, the lookup or the queueing failed): the caller runs the reading template.
async function drivePosed(e, rv, queue) {
  const posed = S.templates.find((x) => x.id === e.posed && !x.error);
  const preview = S.templates.find((x) => x.id === POSE_TPL[T.poser || 'dwpose'] && !x.error);
  if (!posed) return false;
  let pose = null;
  if (!UI.remake) { try { pose = await findPose(); } catch { return false; } }
  if (pose) {
    try { await queue(posed, { ...rv, pose: { generation: pose.generation, index: pose.index } }, `using the pose from #${pose.generation}`); } catch { return false; }
    return true;
  }
  if (!preview) return false;
  let pg;
  try { pg = await queue(preview, { source: rv.source, len: rv.len, res: rv.res }, null); } catch { return false; }
  UI.remake = false; UI.pose = null;
  toast(`Making the pose first (#${pg.id}), then the drive`);
  (async () => {
    let done = null;
    try { done = await waitGen(pg.id); } catch { /* the pose run failed: the drive reads the pose itself */ }
    UI.pose = null; poseLine();
    const i = done ? done.outputs.findIndex((o) => o.kind === 'video') : -1;
    if (i >= 0) {
      try { await queue(posed, { ...rv, pose: { generation: done.id, index: i } }, `using the pose from #${done.id}`); return; } catch { /* below */ }
    }
    try { await queue(null, null, 'reading the pose itself'); } catch (err) { toast(err.message, true); }
  })();
  return true;
}

const lenFrames = (secs) => Math.max(1, Math.round((secs * FPS) / 8)) * 8 + 1;

function resultsSection() {
  const gens = T.results.map((id) => S.history.get(id)).filter(Boolean);
  if (!gens.length) return section('Output', null, hint('Results of this tab show here.'));
  return section('Output', null, h('div', { class: 'grid gallery vfx-results' }, gens.slice().reverse().map((g) => {
    const o = g.outputs.find((x) => x.kind === 'video') || g.outputs[0];
    const on = T.showing === g.id;
    const card = g.status === 'done' && o
      ? mediaCard(cardMedia(o), genLabel(g), () => { T.showing = on ? null : g.id; changed(); }, { badge: '▶', attrs: { class: `card${on ? ' picked' : ''}` } })
      : h('div', { class: 'card' }, h('div', { class: 'media' }, placeholder(g.status === 'error' ? `Failed: ${g.error || ''}` : 'Running…')),
        h('div', { class: 'meta' }, genLabel(g)));
    return card;
  })), T.showing ? resultActions(S.history.get(T.showing)) : null);
}

function resultActions(g) {
  if (!g || g.status !== 'done') return null;
  const i = Math.max(0, g.outputs.findIndex((x) => x.kind === 'video'));
  const o = g.outputs[i];
  const src = { generation: g.id, index: i };
  return h('div', { class: 'row wrap' },
    button('Add to timeline', async () => { await addToTimeline({ kind: 'video', src, url: o.url, label: genLabel(g), dur: o.duration || 0 }); toast('Added to the Video timeline'); }, { cls: 'primary' }),
    button('Use as source', () => { T.source = src; UI.srcInfo = null; T.showing = null; changed(); }),
    button('Use as matte / mask', () => { T.matte = src; T.op = T.op === 'alpha' || T.op === 'mask' ? (T.op === 'alpha' ? 'mattekey' : 'cleanplate') : T.op; changed(); }),
    button('Details', () => openGeneration(g.id)),
    button('Open in EffectCraft', (ev) => craftVfx(ev.currentTarget), { title: 'The source, matte and every take as layers, to keep working on the computer' }),
    compareSelect(g));
}

// The tab as an EffectCraft comp: the source over its trim, the matte, and each finished take (the one on show switched on)
function craftVfx(btn) {
  const takes = (T.results || []).map((id) => S.history.get(id)).filter((g) => g?.status === 'done');
  sendToCraft('vfx', { title: tabs?.active?.name || 'VFX',
    source: T.source && { ...bareSource(T.source), label: clipLabel(T.source), ...(T.source.trim && { trim: T.source.trim }) },
    matte: T.matte && bareSource(T.matte),
    results: takes.map((g) => ({ generation: g.id, index: Math.max(0, g.outputs.findIndex((x) => x.kind === 'video')),
      label: genLabel(g), showing: g.id === T.showing })) }, btn);
}

// the left side of the viewer: the source, or another take of this tab (to compare engines, seeds, settings)
function compareSelect(g) {
  const others = T.results.filter((id) => id !== g.id).map((id) => S.history.get(id)).filter((x) => x?.status === 'done');
  if (!others.length) return null;
  const sel = h('select', { onchange: () => { UI.cmp = Number(sel.value) || null; drawViewer(); } },
    h('option', { value: '' }, 'Compare with source'),
    others.slice().reverse().map((x) => h('option', { value: x.id, selected: UI.cmp === x.id }, `Compare with ${genLabel(x)}`)));
  return sel;
}

// the second matte for Refine matte: optional; what it does with the first is Combine
function matte2Field() {
  const v = T.matte2, set = (val) => { T.matte2 = val; changed(); };
  return field(['Combine with (optional)', h('span', {}, clipLabel(v))], h('div', { class: 'row wrap' },
    button(v ? 'Change…' : 'Choose…', () => openVideoPicker({ title: 'Second matte or mask', onPick: set })),
    v ? button('Clear', () => set(null)) : null,
    button('From results…', () => pickResult(set), { title: 'An Alpha Gen or mask result from this tab' })));
}

function refineFields() {
  const r = (T.refine ||= { ...REFINE });
  const num = (k, label, opts) => rangeField(label, () => r[k] ?? REFINE[k], (v) => { r[k] = v; }, { onChange: () => changed(false), ...opts });
  const px = (v) => `${v > 0 ? '+' : ''}${Math.round(v)} px`;
  return [
    T.matte2 ? field('Combine', seg([['union', 'Either'], ['intersect', 'Both'], ['subtract', 'First minus second'], ['average', 'Average']], r.combine,
      (v) => { r.combine = v; changed(false); }, { wrap: true }),
      help('Either keeps what either matte keeps (fills gaps one misses). Both keeps only what they agree on (drops strays). Minus cuts the second out of the first.')) : null,
    num('grow', 'Grow / shrink', { min: -20, max: 20, step: 1, fmt: px, help: 'Plus dilates the edge outwards, minus erodes it inwards (a halo off, or fringe back).' }),
    num('close', 'Fill holes', { min: 0, max: 20, step: 1, fmt: (v) => `${Math.round(v)} px`, help: 'Closes holes and gaps up to this size (grows, then shrinks back).' }),
    num('smooth', 'Steady', { min: 0, max: 9, step: 1, fmt: (v) => (v > 1 ? `${Math.round(v)} frames` : 'off'), help: 'Averages each frame with its neighbours: less flicker at the edges, a little lag on fast moves.' }),
    num('low', 'Edge: black below', { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) }),
    num('high', 'Edge: white above', { min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), help: 'Bring the two together for a hard edge; apart for a soft one.' }),
    num('feather', 'Feather', { min: 0, max: 30, step: 0.5, fmt: (v) => `${v.toFixed(1)} px`, help: 'Blurs the edge.' }),
    toggle('Invert (keep what\'s black)', r.invert, (on) => { r.invert = on; changed(false); }),
    button('Reset', () => { T.refine = { ...REFINE }; changed(); }, { cls: 'small' }),
  ];
}

async function runMatte() {
  const r = T.refine || REFINE;
  const body = { a: bareSource(T.matte), ...(T.matte2 && { b: bareSource(T.matte2) }), ...r, project_id: S.project };
  try {
    const g = await api('/api/video/matte', { method: 'POST', body, timeout: 900000, busy: 'Refining the matte…' });
    S.history.set(g.id, g);
    T.results.push(g.id); T.showing = g.id;
    changed();
  } catch (err) { toast('Refine matte failed: ' + err.message, true); }
}

// ---- Extend frame: the canvas and the clip's place on it ----
const ASPECTS = [[0, 'Source'], [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 5, '4:5'], [21 / 9, '21:9']];
const srcAspect = () => (V.a?.videoWidth ? V.a.videoWidth / V.a.videoHeight : 16 / 9);
const canvasAspect = () => (T.canvas?.aspect || srcAspect());
// the clip's box on the canvas, in fractions of the canvas (app/videoedit.canvas_plan does the same in pixels)
function clipBox() {
  const c = T.canvas || CANVAS, sa = srcAspect(), A = canvasAspect();
  const [w, h] = sa > A ? [c.scale, (c.scale * A) / sa] : [(c.scale * sa) / A, c.scale];
  return { left: c.cx - w / 2, top: c.cy - h / 2, w, h };
}
function canvasFields() {
  const c = (T.canvas ||= { ...CANVAS });
  const num = (k, label, opts) => rangeField(label, () => c[k], (v) => { c[k] = v; layoutCanvas(); }, { onChange: () => changed(false), ...opts });
  return [
    field('Canvas', seg(ASPECTS.map(([v, l]) => [v, l]), ASPECTS.some(([v]) => Math.abs(v - (c.aspect || 0)) < 1e-6) ? c.aspect : 0,
      (v) => { c.aspect = Number(v); changed(); }, { wrap: true }),
      help('Its shape. The clip keeps its own resolution at size 1; the frame grows around it.')),
    num('scale', 'Clip size', { min: 0.3, max: 1.5, step: 0.01, fmt: pctFmt, help: '100% fits the clip inside the canvas. Drag the clip on the preview to move it.' }),
    num('cx', 'Across', { min: 0, max: 1, step: 0.01, fmt: pctFmt }),
    num('cy', 'Up / down', { min: 0, max: 1, step: 0.01, fmt: pctFmt }),
    button('Centre', () => { Object.assign(c, { scale: c.scale, cx: 0.5, cy: 0.5 }); changed(); }, { cls: 'small' }),
  ];
}
// the viewer while setting up: the canvas (checkered) with the clip on it, draggable
function layoutCanvas() {
  const box = document.querySelector('#vfxStage .vfx-canvas');
  if (!box) return;
  const st = document.getElementById('vfxStage').getBoundingClientRect(), A = canvasAspect();
  const w = Math.min(st.width - 16, (st.height - 16) * A);   // as big as the stage allows, at the canvas's shape
  Object.assign(box.style, { width: `${Math.max(40, w)}px`, height: `${Math.max(40, w / A)}px` });
  const b = clipBox();
  Object.assign(box.querySelector('video').style, { left: `${b.left * 100}%`, top: `${b.top * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
}
function canvasView(video) {
  const box = h('div', { class: 'vfx-canvas' }, video);
  let grab = null;
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault(); box.setPointerCapture(e.pointerId);
    const c = T.canvas || CANVAS;
    grab = { x: e.clientX, y: e.clientY, cx: c.cx, cy: c.cy, r: box.getBoundingClientRect() };
  });
  box.addEventListener('pointermove', (e) => {
    if (!grab) return;
    const c = (T.canvas ||= { ...CANVAS });
    c.cx = clamp(grab.cx + (e.clientX - grab.x) / grab.r.width, -0.5, 1.5);
    c.cy = clamp(grab.cy + (e.clientY - grab.y) / grab.r.height, -0.5, 1.5);
    layoutCanvas();
  });
  const end = () => { if (grab) { grab = null; changed(false); render(); } };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  video.addEventListener('loadedmetadata', layoutCanvas);
  return box;
}

function pickResult(onPick) {
  openVideoPicker({ title: 'Pick a matte or mask', onPick });
}

function faceFields() {
  const f = (T.face ||= { ...FACE }), face = (T.blend || 'face') === 'face';
  const num = (k, label, opts) => rangeField(label, () => f[k] ?? FACE[k], (v) => { f[k] = v; },
    { fmt: (v) => v.toFixed(2), onChange: () => changed(false), ...opts });
  return [
    face ? num('grow', 'Face size', { min: 0.8, max: 1.4, step: 0.01, help: 'How far past the face outline the new face reaches.' }) : null,
    num('feather', 'Edge softness', { min: 0.05, max: 1, step: 0.01, help: 'Lower gives a firmer edge; higher fades it out over a wider band.' }),
    face ? num('chin', 'Chin', { min: 0.5, max: 1.3, step: 0.01,
      help: 'Moves the lower edge. Lower it if the new face spills onto the neck or collar (red patches, a second jawline).' }) : null,
  ];
}

// ---- running ----
// what's missing before effect e can run, or null
function missingInput(e) {
  if (e.needs.includes('source') && !T.source) return 'Choose a source clip first';
  if (e.needs.includes('matte') && !T.matte) return `Choose a ${T.op === 'cleanplate' ? 'mask' : 'matte'} clip first`;
  if (e.needs.includes('first') && !T.first) return 'Choose the start image first';
  if (e.needs.includes('sound') && !T.sound) return 'Choose the sound first';
  if (e.still && !T.source && !T.first) return 'Choose a clip or a picture first';
  return null;
}


// What a template effect sends: { t (the template, with its SDPose / still variant), values (by field key), rv (the
// same by role, for the drives' posed and pose templates) }, or a message saying why it can't. loose: for Open in
// Generate, where missing things can be filled in later
async function buildRun(e, loose = false) {
  const t = tplOf(e);
  if (!t) return `Template ${tplId(e)} isn't installed yet`;
  const values = {}, rv = {};
  const put = (role, v) => { const f = roleField(t, role); if (f && v !== undefined && v !== null) { values[f.key] = v; rv[role] = v; } };
  put('source', T.source && { ...bareSource(T.source), ...(T.source.trim && { trim: T.source.trim }), ...(T.source.crop && { crop: T.source.crop }) });
  put('matte', T.matte && bareSource(T.matte));
  if (e.needs.some((n) => n.startsWith('first'))) put('first', T.first);   // (one picture per tab: only the effects that take one)
  if (e.needs.includes('sound')) put('sound', T.sound);
  if (e.needs.includes('voice')) put('voice', T.voice);
  put('prompt', T.prompt.trim() ? T.prompt : undefined);   // empty: keep the template's own prompt
  put('len', e.needs.includes('len') ? T.len : undefined);
  put('seed', e.needs.includes('seed') ? T.seed : undefined);
  if (e.needs.includes('loras')) {
    if (roleField(t, 'loras')) put('loras', T.loras);
    else if (T.loras[0]) { put('lora', T.loras[0].name); put('strength', T.loras[0].strength); }
  }
  if (e.needs.includes('res')) put('res', resOf(e));
  if (e.needs.includes('steps')) put('steps', STEPS[T.steps] || STEPS[3]);
  if (e.needs.includes('blend')) {
    put('blend', T.blend || 'face');
    for (const k of ['grow', 'feather', 'chin']) put(k, T.face?.[k] ?? FACE[k]);
  }
  if (e.needs.includes('depthModel')) {   // Large at 448 px fits a 12 GB card (dev/make_quick_templates.py SIZES)
    const small = T.depthModel === 'small';
    put('depthModel', small ? 'video_depth_anything_vits.pth' : 'video_depth_anything_vitl.pth');
    put('depthSize', small ? 518 : 448);
  }
  if (e.needs.includes('outsize')) put('outsize', T.outsize || 'FullHD');
  const size = T.size || (e.needs.includes('size') && T.first ? await imageSize(T.first) : null);
  if (e.needs.includes('size') && size) { put('width', size[0]); put('height', size[1]); }
  if (e.needs.includes('points')) {
    const pts = await pointsPx(), clicked = pts.positive.length > 0;
    put('pointsPos', JSON.stringify(pts.positive)); put('pointsNeg', JSON.stringify(pts.negative));
    put('mode', clicked ? 'point' : 'text');
    put('pframe', clicked ? Math.max(0, Math.round((T.pointsAt - (T.source?.trim?.start || 0)) * FPS)) : 0);
    if (!clicked && !T.prompt.trim() && !loose) return 'Tap the thing on the picture, or describe it';
  }
  if (e.needs.includes('tracks') && T.first) put('tracks', JSON.stringify(await tracksPx(t, values)));
  if (e.needs.includes('canvas') && T.source) {   // the clip on its canvas, and the mask of what to paint, made on the server first
    try {
      const c = T.canvas || CANVAS, a = canvasAspect();
      const r = await api('/api/video/canvas', { method: 'POST', busy: 'Setting up the canvas…', timeout: 900000,
        body: { source: bareSource(T.source), trim: T.source.trim || null, aspect: a, scale: c.scale, cx: c.cx, cy: c.cy } });
      put('source', r.video); put('matte', r.mask);
    } catch (err) { return 'Couldn\'t set up the canvas: ' + err.message; }
  }
  return { t, values, rv };
}

const parentOf = () => (T.source?.generation != null ? { generation: T.source.generation, index: T.source.index || 0, frame: null } : null);

async function run() {
  const e = fx(T.op);
  const miss = missingInput(e);
  if (miss) return toast(miss, true);
  await tabs?.flush();
  if (e.job === 'key') return runKey(e);
  if (e.job === 'matte') return runMatte();
  if (e.job === 'delogo') return runDelogo();
  const b = await buildRun(e);
  if (typeof b === 'string') return toast(b, true);
  const { t, values, rv } = b;
  const parent = parentOf();   // the source clip, also when the run gets a canvas made from it
  const tab = T, face = { kind: 'vfx', state: tabState() };
  // queue template tt (null: this effect's own, with values) with values by role; how: added to the toast (null: no toast)
  const queue = async (tt, roles, how) => {
    const vals = roles ? valuesByRole(tt, roles) : values;
    const gens = await queueRun({ template: (tt || t).id, values: vals, parent, face });
    tab.results.push(...gens.map((g) => g.id));
    if (tab === T) changed(); else tabs?.changed();
    if (how !== null) toast(`Queued ${e.label} as #${gens[0].id}${how ? `, ${how}` : ''}`);
    return gens[0];
  };
  if (e.posed && T.source && await drivePosed(e, rv, queue)) return;
  try { await queue(null, null, ''); } catch (err) { toast(err.message, true); }
}

// The effect's template with the values Run would send, in a new Generate tab: every field can be changed there.
// A drive with a ready pose video opens the posed template on it.
async function openInGenerate() {
  const e = fx(T.op);
  await tabs?.flush();
  const b = await buildRun(e, true);
  if (typeof b === 'string') return toast(b, true);
  let { t, values } = b;
  const posed = e.posed && S.templates.find((x) => x.id === e.posed && !x.error);
  if (posed && T.source && !UI.remake) {
    try {
      const pose = await findPose();
      if (pose) { t = posed; values = valuesByRole(posed, { ...b.rv, pose: { generation: pose.generation, index: pose.index } }); }
    } catch { /* the reading template, as it is */ }
  }
  if (!genHooks.openShot) return toast('The Generate tab isn\'t ready yet', true);
  switchTab('generate');
  await genHooks.openShot({ workflow: t.id, values }, tabs?.active?.name ? `${tabs.active.name} · ${e.label}` : e.label);
  toast(`Opened ${e.label} in Generate`);
}

async function runKey(e) {
  const body = { source: bareSource(T.source), trim: T.source.trim || null, mode: e.id === 'colorkey' ? 'color' : 'matte', project_id: S.project };
  if (e.id === 'colorkey') Object.assign(body, T.key);
  else Object.assign(body, { matte: bareSource(T.matte), invert: T.key.invert });
  try {
    const g = await api('/api/video/key', { method: 'POST', body, timeout: 900000, busy: 'Keying…' });
    S.history.set(g.id, g);
    T.results.push(g.id); T.showing = g.id;
    changed();
  } catch (err) { toast('Keying failed: ' + err.message, true); }
}

const imageSize = (name) => new Promise((res) => {
  const im = new Image();
  im.onload = () => res([Math.round(im.naturalWidth / 32) * 32, Math.round(im.naturalHeight / 32) * 32]);
  im.onerror = () => res(null);
  im.src = inputUrl(name);
});

// the points are kept as fractions of the (cropped) frame; SAM3 wants pixels of the clip it reads
async function pointsPx() {
  const info = await srcInfo();
  const c = T.source?.crop || { x: 0, y: 0, w: 1, h: 1 };
  const W = (info?.width || 1) * c.w, H = (info?.height || 1) * c.h;
  const px = (p) => ({ x: ((p.x - c.x) / c.w) * W, y: ((p.y - c.y) / c.h) * H });
  return { positive: T.points.positive.map(px), negative: T.points.negative.map(px) };
}
// paths are fractions of the start image; the tracks node wants pixels of the image as the template resizes it
// (short side to Resolution, both sides multiples of 32), or of an explicit Width / Height
async function tracksPx(t, values) {
  const nat = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res(null); im.src = inputUrl(T.first); });
  let w = values[roleField(t, 'width')?.key], hgt = values[roleField(t, 'height')?.key];
  if (!(w && hgt) && nat) {
    const k = T.res / Math.min(nat[0], nat[1]), m = fx(T.op).mult || 32;
    w = Math.round((nat[0] * k) / m) * m; hgt = Math.round((nat[1] * k) / m) * m;
  }
  w ||= 1; hgt ||= 1;
  return T.tracks.map((tr) => tr.map((p) => ({ x: Math.round(p.x * w), y: Math.round(p.y * hgt) })));
}
async function srcInfo() {
  if (!T.source) return null;
  if (!UI.srcInfo) { try { UI.srcInfo = await api('/api/videos/probe', { method: 'POST', body: { source: bareSource(T.source) } }); } catch { UI.srcInfo = null; } }
  return UI.srcInfo;
}

// ---- viewer: source / result wipe, and drawing points and paths ----
const V = { a: null, b: null, still: null, ov: null, stroke: null, box: null };

// the source's trimmed part in its own time, [start, end); end is Infinity when it runs to the clip's end
const srcSpan = () => { const t = T.source?.trim, s = t?.start || 0; return [s, t?.len != null ? s + t.len : Infinity]; };

// while playing: the source stays inside its trim and both sides loop (a result is as long as the trim)
function keepInTrim() {
  if (!UI.playing) return;
  const [s, e] = srcSpan(), src = V.a && !V.a.dataset.result ? V.a : null;
  if ((src && (src.currentTime >= e - 0.02 || src.ended)) || V.b?.ended || (!V.b && src?.ended)) {
    if (src) src.currentTime = s;
    if (V.a && !src) V.a.currentTime = 0;
    if (V.b) V.b.currentTime = 0;
    for (const v of [V.a, V.b]) v?.play().catch(() => {});
  }
  showTime();
  requestAnimationFrame(keepInTrim);
}

// the time bar runs over what is shown: a result from 0, the source over its trim (in the trim's own time)
function span() {
  const src = V.a && !V.a.dataset.result ? V.a : null, [s, e] = srcSpan();
  const clock = V.b || V.a;
  const len = V.b?.duration || (src ? Math.min(e, src.duration || Infinity) - s : V.a?.duration) || 0;
  return { src, s: src ? s : 0, clock, len: Number.isFinite(len) ? len : 0 };
}

function seekTo(t) {
  const { src, s, len } = span();
  t = clamp(t, 0, len);
  if (V.b) V.b.currentTime = t;
  if (V.a) V.a.currentTime = src ? s + t : t;
  showTime();
}

function showTime() {
  const bar = $('#vfxTime'), out = $('#vfxClock');
  if (!bar || !out) return;
  const { s, clock, len } = span();
  const t = clock ? clamp(clock.currentTime - (clock === V.b ? 0 : s), 0, len) : 0;
  bar.max = len || 0;
  if (document.activeElement !== bar) bar.value = t;
  bar.style.setProperty('--p', len ? `${(t / len) * 100}%` : '0%');
  const f = (x) => `${x.toFixed(2)}`;
  out.textContent = `${f(t)} / ${f(len)} s · frame ${Math.round(t * FPS) + 1}`;
}

function drawViewer() {
  const stage = $('#vfxStage');
  if (!stage) return;
  const e = fx(T.op);
  const res = T.showing && S.history.get(T.showing);
  const resUrl = res?.status === 'done' ? resultUrl(res) : null;
  const cmp = resUrl && UI.cmp && UI.cmp !== T.showing && S.history.get(UI.cmp);
  const cmpUrl = cmp?.status === 'done' ? resultUrl(cmp) : null;
  const stillMode = !cmpUrl && (e.needs.includes('tracks') || (!T.source && T.first));
  const aUrl = cmpUrl || (stillMode ? null : clipUrl(T.source));
  const offset = cmpUrl ? 0 : (T.source?.trim?.start || 0);   // a result starts at 0; the source at its trim
  const side = UI.layout === 'side' && !!aUrl && !!resUrl;
  const canvasMode = e.needs.includes('canvas') && !!aUrl && !resUrl && !cmpUrl;   // Extend frame, before a result
  const want = `${aUrl}|${resUrl}|${stillMode ? T.first : ''}|${side}|${canvasMode}`;
  if (stage.dataset.want !== want) {
    stage.dataset.want = want;
    V.a = aUrl ? h('video', { src: aUrl, muted: true, playsInline: true, preload: 'auto', class: 'vfx-a', ...(cmpUrl && { 'data-result': '1' }) }) : null;
    V.b = resUrl ? h('video', { src: resUrl, muted: true, playsInline: true, preload: 'auto', class: 'vfx-b' }) : null;
    V.still = stillMode && T.first ? h('img', { src: inputUrl(T.first), class: 'vfx-a', alt: '' }) : null;
    V.ov = side || canvasMode ? null : h('canvas', { class: 'vfx-ov' });
    const base = V.a || V.still;
    const tags = V.a && V.b ? [h('span', { class: 'vfx-tag left' }, cmpUrl ? genLabel(cmp) : 'Source'), h('span', { class: 'vfx-tag right' }, genLabel(res))] : [];
    const media = h('div', { class: `vfx-media${side ? ' side' : ''}` }, base, V.b, V.ov, ...tags);
    if (V.a && V.b && !side) setWipe(UI.wipe);
    stage.replaceChildren(canvasMode ? canvasView(V.a) : base || V.b ? media : placeholder('Choose a source clip or a start image'));
    const fit = () => sizeOverlay();
    (V.a || V.b)?.addEventListener('loadedmetadata', () => { if (V.a && offset) V.a.currentTime = offset; fit(); });
    V.still?.addEventListener('load', fit);
    if (V.ov) wireOverlay(media);
    if (V.a && V.b) V.b.addEventListener('timeupdate', () => { if (Math.abs(V.a.currentTime - V.b.currentTime - offset) > 0.15) V.a.currentTime = V.b.currentTime + offset; });
  }
  const trimKey = cmpUrl ? '' : JSON.stringify(T.source?.trim || null);
  if (stage.dataset.trim !== trimKey) {   // the trim changed: show its first frame
    stage.dataset.trim = trimKey;
    if (V.a && !cmpUrl && V.a.readyState >= 1) { V.a.currentTime = offset; if (V.b) V.b.currentTime = 0; }
  }
  if (canvasMode) layoutCanvas();
  stage.classList.toggle('drawing', !!UI.draw);
  sizeOverlay();
  renderTransport();
}

const resultUrl = (g) => (g.outputs.find((x) => x.kind === 'video') || g.outputs[0])?.url;

function sizeOverlay() {
  const base = V.a || V.still || V.b;
  if (!V.ov || !base) return;
  const r = base.getBoundingClientRect();
  if (!r.width) return;
  V.ov.width = Math.round(r.width); V.ov.height = Math.round(r.height);
  paintOverlay();
}

function paintOverlay() {
  const cv = V.ov;
  if (!cv?.width) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const e = fx(T.op);
  if (V.a && V.b) {   // the wipe line
    ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(UI.wipe * W) - 1, 0, 2, H);
  }
  if (e.needs.includes('points')) {
    const dot = (p, col) => { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); };
    T.points.positive.forEach((p) => dot(p, '#43a047'));
    T.points.negative.forEach((p) => dot(p, '#e53935'));
  }
  if (e.needs.includes('boxes')) {
    for (const b of [...(T.boxes || []), ...(V.box ? [V.box.b] : [])]) {
      const [x, y, w, hh] = [b.x * W, b.y * H, b.w * W, b.h * H];
      ctx.fillStyle = 'rgba(229, 57, 53, 0.18)'; ctx.fillRect(x, y, w, hh);
      ctx.lineWidth = 2; ctx.strokeStyle = '#e53935'; ctx.strokeRect(x, y, w, hh);
      if (UI.draw === 'boxes') {   // the corner to size it, and ✕ to remove it
        ctx.fillStyle = '#e53935'; ctx.fillRect(x + w - 7, y + hh - 7, 14, 14);
        ctx.beginPath(); ctx.arc(x + w, y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(x + w - 4, y - 4); ctx.lineTo(x + w + 4, y + 4); ctx.moveTo(x + w + 4, y - 4); ctx.lineTo(x + w - 4, y + 4); ctx.stroke();
      }
    }
  }
  if (e.needs.includes('tracks')) {
    for (const tr of [...T.tracks, ...(V.stroke ? [V.stroke] : [])]) {
      if (!tr.length) continue;
      ctx.strokeStyle = '#fdd835'; ctx.lineWidth = 3; ctx.beginPath();
      tr.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.stroke();
      const a = tr[tr.length - 1], b = tr[Math.max(0, tr.length - 2)];
      const ang = Math.atan2((a.y - b.y) * H, (a.x - b.x) * W);
      ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H);
      ctx.lineTo(a.x * W - 12 * Math.cos(ang - 0.5), a.y * H - 12 * Math.sin(ang - 0.5));
      ctx.lineTo(a.x * W - 12 * Math.cos(ang + 0.5), a.y * H - 12 * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fillStyle = '#fdd835'; ctx.fill();
      ctx.beginPath(); ctx.arc(tr[0].x * W, tr[0].y * H, 5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// a path as at most 8 control points (the tracks node splines through them)
function simplify(pts) {
  if (pts.length <= 8) return pts;
  const out = [];
  for (let i = 0; i < 8; i++) out.push(pts[Math.round((i * (pts.length - 1)) / 7)]);
  return out;
}

function wireOverlay(media) {
  const pt = (ev) => { const r = V.ov.getBoundingClientRect(); return { x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp((ev.clientY - r.top) / r.height, 0, 1) }; };
  let wiping = false;
  media.addEventListener('pointerdown', (ev) => {
    const p = pt(ev);
    if (UI.draw === 'points') {
      T.points[UI.neg ? 'negative' : 'positive'].push(p);
      if (V.a) T.pointsAt = V.a.currentTime;
      changed(); return;
    }
    if (UI.draw === 'color') {
      const base = V.a || V.still;
      if (!base) return;
      const c = document.createElement('canvas');
      c.width = base.videoWidth || base.naturalWidth; c.height = base.videoHeight || base.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(base, 0, 0);
      const [R, G, B] = ctx.getImageData(Math.floor(p.x * c.width), Math.floor(p.y * c.height), 1, 1).data;
      T.key.color = '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('');
      UI.draw = null; changed(); return;
    }
    if (UI.draw === 'tracks') { media.setPointerCapture(ev.pointerId); V.stroke = [p]; paintOverlay(); return; }
    if (UI.draw === 'boxes') { boxDown(p, media, ev); return; }
    if (V.a && V.b) { wiping = true; media.setPointerCapture(ev.pointerId); setWipe(p.x); }
  });
  media.addEventListener('pointermove', (ev) => {
    if (V.box) boxMove(pt(ev));
    else if (V.stroke) { const p = pt(ev), l = V.stroke[V.stroke.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) > 0.01) { V.stroke.push(p); paintOverlay(); } }
    else if (wiping) setWipe(pt(ev).x);
  });
  const up = () => {
    if (V.box) boxUp();
    if (V.stroke) { if (V.stroke.length > 1) { T.tracks.push(simplify(V.stroke)); V.stroke = null; changed(); } else V.stroke = null; }
    wiping = false;
  };
  media.addEventListener('pointerup', up); media.addEventListener('pointercancel', up);
}

// boxes: drag on the picture for a new one; on a box to move it, on its corner to size it; ✕ removes it
function boxDown(p, media, ev) {
  const r = V.ov.getBoundingClientRect(), near = (ax, ay, px) => Math.hypot((p.x - ax) * r.width, (p.y - ay) * r.height) < px;
  const boxes = (T.boxes ||= []);
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (near(b.x + b.w, b.y, 14)) { boxes.splice(i, 1); changed(); return; }
    const corner = near(b.x + b.w, b.y + b.h, 18), inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    if (corner || inside) {
      boxes.splice(i, 1);
      V.box = { mode: corner ? 'size' : 'move', p0: p, b0: { ...b }, b: { ...b } };
      media.setPointerCapture(ev.pointerId); paintOverlay(); return;
    }
  }
  V.box = { mode: 'new', p0: p, b: { x: p.x, y: p.y, w: 0, h: 0 } };
  media.setPointerCapture(ev.pointerId);
}
function boxMove(p) {
  const B = V.box, { p0, b0 } = B;
  if (B.mode === 'new') B.b = { x: Math.min(p.x, p0.x), y: Math.min(p.y, p0.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
  else if (B.mode === 'move') B.b = { ...b0, x: clamp(b0.x + p.x - p0.x, 0, 1 - b0.w), y: clamp(b0.y + p.y - p0.y, 0, 1 - b0.h) };
  else B.b = { ...b0, w: clamp(b0.w + p.x - p0.x, 0.01, 1 - b0.x), h: clamp(b0.h + p.y - p0.y, 0.01, 1 - b0.y) };
  paintOverlay();
}
function boxUp() {
  const { b } = V.box;
  V.box = null;
  if (b.w > 0.005 && b.h > 0.005) T.boxes.push(b);
  changed();
}

function setWipe(x) {
  UI.wipe = x;   // each side clipped, so a see-through result shows the checkerboard, not the source under it
  if (V.b) V.b.style.clipPath = `inset(0 0 0 ${x * 100}%)`;
  if (V.a && V.b) V.a.style.clipPath = `inset(0 ${(1 - x) * 100}% 0 0)`;
  paintOverlay();
}

function renderTransport() {
  const bar = $('#vfxTransport');
  if (!bar) return;
  const vids = [V.a, V.b].filter(Boolean);
  const play = () => {
    UI.playing = !UI.playing;
    if (UI.playing && V.a && !V.a.dataset.result) {   // from the trim's start when outside it
      const [s, e] = srcSpan();
      if (V.a.currentTime < s - 0.05 || V.a.currentTime >= e - 0.02) { V.a.currentTime = s; if (V.b) V.b.currentTime = 0; }
    }
    for (const v of vids) UI.playing ? v.play().catch(() => {}) : v.pause();
    if (UI.playing) requestAnimationFrame(keepInTrim);
    renderTransport();
  };
  const step = (n) => { UI.playing = false; for (const v of vids) v.pause(); const { clock, s } = span(); if (clock) seekTo(clock.currentTime - (clock === V.b ? 0 : s) + n / FPS); renderTransport(); };
  const time = h('input', { type: 'range', id: 'vfxTime', class: 'vfx-time', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time',
    disabled: !vids.length, oninput: (ev) => seekTo(parseFloat(ev.target.value)) });
  const rate = (r) => { UI.rate = r; for (const v of vids) v.playbackRate = r; renderTransport(); };
  for (const v of vids) { v.playbackRate = UI.rate; v.onseeked = v.onloadedmetadata = showTime; }
  bar.replaceChildren(...[
    h('div', { class: 'vfx-timebar' }, time, h('span', { id: 'vfxClock', class: 'vfx-clock' })),
    iconBtn('Back to the start', '⇤', () => { step(0); seekTo(0); }),
    iconBtn('Back one frame', '⏮', () => step(-1)),
    button(UI.playing ? '❚❚ Pause' : '▶ Play', play, { cls: 'small primary', disabled: !vids.length }),
    iconBtn('Forward one frame', '⏭', () => step(1)),
    vids.length ? seg([[0.25, '¼×'], [0.5, '½×'], [1, '1×']], UI.rate, rate) : null,
    V.a && V.b ? seg([['wipe', 'Wipe'], ['side', 'Side by side']], UI.layout, (v) => { UI.layout = v; UI.playing = false; drawViewer(); }) : null,
    V.a && V.b && UI.layout === 'wipe' ? h('span', { class: 'hint' }, 'Drag across the picture to wipe') : null,
    UI.draw ? h('span', { class: 'hint' }, { points: 'Tap to place points', tracks: 'Drag to draw a path', color: 'Tap the screen colour' }[UI.draw]) : null].filter(Boolean));
  showTime();
}

// ---- tabs and wiring ----
async function ensureTabs() {
  if (!tabs.started) await tabs.start();
  for (let i = 0; i < 160 && !tabs.active; i++) await new Promise((r) => setTimeout(r, 50));
}

// A run's settings (params.__face.state) in a new tab, to change and run again (History's Edit)
export async function openVfxState(state, name) {
  switchTab('vfx');
  await ensureTabs();
  if (tabs.active && !(await tabs.leave())) return;
  try {
    tabs.open(await tabs.create1({ name: String(name || 'Shot').slice(0, 120), payload: { ...BLANK(), ...state, results: [], showing: null },
      order: tabs.active ? tabs.active.order + 0.5 : undefined }));
  } catch (e) { toast(e.message, true); }
}
export function renderVfx() { ensureTabs(); render(); }
export function vfxPause() { UI.playing = false; for (const v of [V.a, V.b]) v?.pause(); }

export function wireVfx() {
  const panel = $('#vfxPanel');
  if (!panel) return;
  const mount = h('div', { class: 'vfx-tabs' });
  panel.replaceChildren(mount, h('div', { id: 'vfxBody' }));
  tabs = new TabSet({ kind: 'vfx-tabs', mount, scope: 'project', newName: (n) => `Shot ${n}`,
    adapter: {
      empty: BLANK,
      migrate: (p) => ({ ...BLANK(), ...p, key: { ...BLANK().key, ...(p.key || {}) }, points: { ...BLANK().points, ...(p.points || {}) } }),
      dump: () => ({ ...T }),
      load(payload) { T = { ...BLANK(), ...payload }; UI.srcInfo = null; UI.draw = null; UI.cmp = null; render(); },
    } });
  maximizable($('#tab-vfx .stage'), $('#tab-vfx .viewer'), { onChange: () => sizeOverlay() });
  addEventListener('resize', () => { if ($('#tab-vfx').classList.contains('active')) { sizeOverlay(); layoutCanvas(); } });
  // a result finishing (or failing) redraws its card
  onServer('deck_generation', (m) => { const id = m.data?.id; if (T.results.includes(id)) { setTimeout(render, 0); } });
}

// ---- effects on Video clips (video.js): one step of a clip's effect stack, run and waited for ----
// A step is { op, prompt, lora, strength, res, outsize, target, color }. source is a clip source
// ({generation, index} | {media}) with an optional trim {start, len} (seconds). Resolves with
// { generation, index, url, dur } of the step's result.
export const CLIP_FX = [
  ['restyle', 'LoRA restyle', 'An IC-LoRA (colourise, restore, deblur, day to night…) with a prompt describing the result.'],
  ['cleanplate', 'Clean plate', 'Removes people and moving things and fills in the background.'],
  ['replace', 'Replace', 'Finds what you name (SAM3) and paints the prompt in its place.'],
  ['cutout', 'Cut out (Alpha Gen)', 'Cuts out the main subject: the rest goes see-through.'],
  ['colorkey', 'Colour key', 'Keys out a green or blue screen (no GPU).'],
  ['upscale', 'Upscale', 'More detail at Full HD or 4K. Slow.'],
];
const MAX_SECS = 10;

const outOf = (g) => {
  const i = Math.max(0, g.outputs.findIndex((o) => o.kind === 'video'));
  return { generation: g.id, index: i, url: g.outputs[i].url, dur: g.outputs[i].duration || 0 };
};

export async function runClipStep(step, source, secs) {
  const src = { ...bareSource(source),
    ...(source.trim && { trim: source.trim }) };
  const len = Math.min(MAX_SECS, secs);
  const res = step.res || 704;
  const key = (body) => api('/api/video/key', { method: 'POST', timeout: 900000, busy: false,
    body: { source: { ...src, trim: undefined }, trim: source.trim, project_id: S.project, ...body } }).then((g) => { S.history.set(g.id, g); return g; });
  switch (step.op) {
    case 'restyle':
      return outOf(await runAndWait('deck-ltx-v2v-lora', { source: src, prompt: step.prompt, lora: step.lora, strength: step.strength ?? 1, len, res }));
    case 'cleanplate':
      return outOf(await runAndWait('deck-ltx-cleanplate', { source: src, prompt: step.prompt, len, res }));
    case 'upscale':
      return outOf(await runAndWait('deck-ltx-upscale', { source: src, prompt: step.prompt, len, outsize: step.outsize || 'FullHD' }));
    case 'replace': {
      if (!step.target?.trim()) throw new Error('Replace: say what to replace');
      const mask = outOf(await runAndWait('deck-sam3-video-mask', { source: src, prompt: step.target, mode: 'text', len }));
      return outOf(await runAndWait('deck-ltx-inpaint', { source: src, matte: { generation: mask.generation, index: mask.index }, prompt: step.prompt, len, res }));
    }
    case 'cutout': {
      const matte = outOf(await runAndWait('deck-ltx-alpha', { source: src, len, res }));
      return outOf(await key({ mode: 'matte', matte: { generation: matte.generation, index: matte.index } }));
    }
    case 'colorkey':
      return outOf(await key({ mode: 'color', color: step.color || '#00ff00', similarity: step.similarity ?? 0.12, blend: 0.08, spill: 0.5 }));
    default:
      throw new Error(`Unknown effect ${step.op}`);
  }
}

// the IC-LoRAs a restyle step can use (as the LoRA restyle effect lists them)
export function restyleLoras() {
  const f = roleField(template('deck-ltx-v2v-lora'), 'lora');
  return (f?.options || []).filter(restyleLora);
}
