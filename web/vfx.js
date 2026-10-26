import { $, h, api, toast, clamp, button, iconBtn, seg, field, section, hint, help, note, placeholder, rangeField, mediaCard } from './ui.js';
import { S, inputUrl, thumbUrl, onServer, switchTab } from './core.js';
import { cardMedia, genLabel, openImagePicker, openVideoPicker, pickFrame, projectOutputs, uploadImage } from './media.js';
import { adoptGenerations } from './generate.js';
import { openGeneration } from './run.js';
import { addToEditor, useInGenerate } from './editor.js';
import { addToTimeline } from './video.js';
import { videoEditor } from './vfield.js';
import { TabSet } from './tabs.js';
import { maximizable } from './layout.js';

// ---------------------------------------------------------------------------
// VFX: one effect per tab, run on a clip (or from a still) with LTX-2.5 and friends. Each effect
// is a template (deck-ltx-*) whose tagged fields are found by their group names (see ROLES), or a
// server job (keying). The viewer wipes between the source and a result; points and motion
// paths are drawn on it. Results go back to the Video timeline.
// ---------------------------------------------------------------------------
const FPS = 24;   // LTX runs at 24 fps; lengths are 8n+1 frames

// group: the sideNav-like family; tpl: the template it runs; needs: the inputs it shows
const EFFECTS = [
  { id: 'ripple', group: 'Restyle', label: 'Ripple edit', tpl: 'deck-ltx-ripple', needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    help: 'Change the first frame (in Generate with an edit template, or in the Editor), and the change carries through the whole clip.' },
  { id: 'lora', group: 'Restyle', label: 'LoRA restyle', tpl: 'deck-ltx-v2v-lora', needs: ['source', 'loras', 'prompt', 'len', 'res', 'seed'],
    help: 'Runs the clip through an IC-LoRA: deblur, colourise, restore, day to night, head swap and so on. Pick the LoRA and its strength.' },
  { id: 'alpha', group: 'Key', label: 'Alpha Gen', tpl: 'deck-ltx-alpha', needs: ['source', 'len', 'res'],
    help: 'Makes a black-and-white matte of the main subject (white = keep). Then use it with "Apply matte", or as a mask.' },
  { id: 'colorkey', group: 'Key', label: 'Colour key', job: 'key', needs: ['source', 'keycolor'],
    help: 'Cuts out a green or blue screen. Quick: runs on the server with ffmpeg, no GPU.' },
  { id: 'mattekey', group: 'Key', label: 'Apply matte', job: 'key', needs: ['source', 'matte'],
    help: 'Uses a matte clip (white = keep) as the clip\'s see-through channel, so lower tracks show through.' },
  { id: 'mask', group: 'Remove', label: 'Mask (SAM3)', tpl: 'deck-sam3-video-mask', needs: ['source', 'points', 'prompt'],
    help: 'Tap the thing to cut out on the frame (Exclude marks what to leave out), or describe it. SAM3 follows it through the clip and makes a mask clip.' },
  { id: 'cleanplate', group: 'Remove', label: 'Clean plate', tpl: 'deck-ltx-cleanplate', needs: ['source', 'prompt', 'len', 'res', 'seed'],
    help: 'Removes people and other moving things from the whole clip and fills in the background. Name what to remove in the prompt (and the negative prompt in Generate).' },
  { id: 't2v', group: 'Generate', label: 'Text / image to video', tpl: 'deck-ltx-t2v', needs: ['first?', 'prompt', 'len', 'size', 'seed'],
    help: 'A new clip from a prompt, optionally starting from a still.' },
  { id: 'layout', group: 'Generate', label: 'Layout to render', tpl: 'deck-ltx-layout', needs: ['source', 'prompt', 'len', 'seed'],
    help: 'Turns a rough layout clip (a 3D tab render in Clay or Colour, or blocked-out footage) into a finished shot that keeps its layout and motion.' },
  { id: 'tracks', group: 'Generate', label: 'Motion paths', tpl: 'deck-ltx-tracks', mult: 64, needs: ['first', 'tracks', 'prompt', 'len', 'res', 'seed'],
    help: 'Draw paths on the start image: things under a path\'s start move along it.' },
  { id: 'ingredients', group: 'Generate', label: 'Ingredients sheet', tpl: 'deck-ltx-ingredients', needs: ['first', 'prompt', 'len', 'size', 'seed'],
    help: 'One image with the characters, props and place laid out; say in the prompt where each one sits on the sheet.' },
  { id: 'upscale', group: 'Generate', label: 'Upscale', tpl: 'deck-ltx-upscale', needs: ['source', 'prompt'],
    help: 'Adds detail at a larger size. Describe the look (light, film, sharpness), not the things in it.' },
];
const GROUPS = ['Restyle', 'Key', 'Remove', 'Generate'];
const fx = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];

// how an effect's inputs find their template fields: by kind, then by the group (node title) name
const ROLES = {
  source: (f) => f.kind === 'video' && !/mask|matte/i.test(f.group),
  matte: (f) => f.kind === 'video' && /mask|matte/i.test(f.group),
  first: (f) => f.kind === 'image',
  prompt: (f) => f.kind === 'text' && /prompt/i.test(f.group) && !/negative/i.test(f.group),
  points: (f) => f.kind === 'text' && /points/i.test(f.group),
  tracks: (f) => f.kind === 'text' && /tracks|paths/i.test(f.group),
  len: (f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(f.label),
  width: (f) => f.kind === 'int' && /^width$/i.test(f.group),
  height: (f) => f.kind === 'int' && /^height$/i.test(f.group),
  res: (f) => f.kind === 'int' && /resolution/i.test(f.group),
  lora: (f) => f.kind === 'choice' && f.input === 'lora_name',
  strength: (f) => f.kind === 'float' && f.input === 'strength_model',
  seed: (f) => f.kind === 'seed',
  loras: (f) => f.kind === 'loras',
};
const tplOf = (e) => e.tpl && S.templates.find((t) => t.id === e.tpl);
const roleField = (t, role) => t?.fields.find(ROLES[role]);

const SIZES = [['Match source', null], ['1280×704', [1280, 704]], ['704×1280', [704, 1280]], ['960×544', [960, 544]],
  ['544×960', [544, 960]], ['1024×1024', [1024, 1024]], ['1920×1088', [1920, 1088]]];

const BLANK = () => ({ op: 'ripple', source: null, first: null, matte: null, prompt: '', loras: [], len: 5, res: 704, size: null, seed: -1,
  points: { positive: [], negative: [] }, pointsAt: 0, tracks: [], key: { color: '#00ff00', similarity: 0.12, blend: 0.08, spill: 0.5, invert: false },
  results: [], showing: null });
let T = BLANK();
let tabs = null;
const UI = { wipe: 0.5, draw: null, srcInfo: null, playing: false, neg: false };

// ---- inputs ----
const srcLabel = (s) => {
  if (!s) return 'none';
  if (s.generation != null) { const g = S.history.get(s.generation); return g ? genLabel(g) : `#${s.generation}`; }
  return s.label || (s.media || '').split('_').slice(1).join('_') || s.media;
};
const srcUrl = (s) => {
  if (!s) return null;
  if (s.generation != null) return S.history.get(s.generation)?.outputs[s.index || 0]?.url || null;
  if (s.media) return `/files/media/${encodeURIComponent(s.media)}`;
  return null;
};
const bare = (s) => (s.generation != null ? { generation: s.generation, index: s.index || 0 } : { media: s.media });

function changed(redraw = true) { tabs?.changed(); if (redraw) render(); }

// From the Video tab (or anywhere): open a VFX tab on this clip
export async function sendToVfx(src, { label = null, trim = null } = {}) {
  switchTab('vfx');
  await ensureTabs();
  T.source = { ...bare(src), ...(trim && { trim }), ...(label && { label }) };
  T.showing = null; UI.srcInfo = null;
  changed();
  toast('Clip set as the VFX source: pick an effect');
}

function sourceField(role = 'source') {
  const isSrc = role === 'source';
  const v = isSrc ? T.source : T.matte;
  const title = isSrc ? 'Source clip' : (T.op === 'cleanplate' ? 'Mask clip' : 'Matte clip');
  const pick = () => openVideoPicker({ title, onPick: (val) => {
    if (isSrc) { T.source = val; UI.srcInfo = null; T.showing = null; } else T.matte = val;
    changed();
  } });
  const url = srcUrl(v);
  if (!isSrc || !url) {
    return field([title, h('span', {}, srcLabel(v))], h('div', { class: 'row wrap' }, button(v ? 'Change…' : 'Choose…', pick, { cls: v ? '' : 'primary' }),
      v ? button('Clear', () => { if (isSrc) T.source = null; else T.matte = null; changed(); }) : null,
      !isSrc ? button('From results…', () => pickResult((val) => { T.matte = val; changed(); }), { title: 'An Alpha Gen or mask result from this tab' }) : null));
  }
  const base = bare(v);
  const fxDef = fx(T.op);
  const ed = videoEditor({
    url, source: base, trim: v.trim, crop: v.crop,
    loader: () => ({ rate: 0, nth: 1, mapped: true }),
    budget: () => (fxDef.needs.includes('len') ? { secs: T.len } : null),
    onChange: (trim, crop) => { T.source = { ...base, ...(v.label && { label: v.label }), ...(trim && { trim }), ...(crop && { crop }) }; changed(false); drawViewer(); },
  });
  return field([title, h('span', {}, srcLabel(v))], ed,
    h('div', { class: 'row wrap' }, button('Change…', pick), button('Clear', () => { T.source = null; T.showing = null; changed(); })));
}

function firstField(optional) {
  const pick = () => openImagePicker({ title: T.op === 'ingredients' ? 'Ingredients sheet' : 'First frame', mp: () => 0,
    onPick: (name) => { T.first = name; changed(); } });
  const takeFrame = async () => {
    const url = srcUrl(T.source);
    if (!url) return toast('Choose a source clip first', true);
    const blob = await pickFrame({ url, title: 'Frame to edit' });
    if (!blob) return;
    const r = await uploadImage(blob, { source: 'vfx', filename: 'frame.png' });
    T.first = r.name; changed();
    return r.name;
  };
  const label = T.op === 'ingredients' ? 'Ingredients sheet' : T.op === 'ripple' ? 'Edited first frame' : optional ? 'Start image (optional)' : 'Start image';
  return field(label, T.first ? h('img', { class: 'vfx-still', src: thumbUrl(T.first, 480), alt: '' }) : null,
    h('div', { class: 'row wrap' },
      button(T.first ? 'Change…' : 'Choose…', pick, { cls: T.first ? '' : 'primary' }),
      T.source ? button('Take from clip…', takeFrame, { title: 'A frame of the source clip' }) : null,
      T.first && T.op === 'ripple' ? button('Edit in Generate', () => useInGenerate(T.first, 'Frame set: edit it, then pick the result here')) : null,
      T.first && T.op === 'ripple' ? button('Edit in Editor', () => addToEditor(T.first)) : null,
      T.first ? button('Clear', () => { T.first = null; changed(); }) : null),
    T.op === 'ripple' ? help('Take the clip\'s first frame, change it (Edit in Generate with an edit template, or in the Editor), then Choose… the edited picture here.') : null);
}

function lorasField(t) {
  const stack = roleField(t, 'loras'), one = roleField(t, 'lora');
  const f = stack || one;
  if (!f) return null;
  const opts = f.options.filter((o) => /ltx/i.test(o));
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
  const missing = e.tpl && !t;
  const runBtn = button(e.job ? (e.id === 'colorkey' ? 'Key clip' : 'Cut out with matte') : 'Run', run, { cls: 'primary', disabled: !!missing });

  const effect = section('Effect', null,
    GROUPS.map((g) => h('div', { class: 'vfx-group' }, h('span', { class: 'vfx-group-name' }, g),
      seg(EFFECTS.filter((x) => x.group === g).map((x) => [x.id, x.label]), T.op, (id) => { T.op = id; UI.draw = null; changed(); }, { wrap: true }))),
    help(e.help),
    missing ? note(`Template ${e.tpl} isn't installed yet. It comes with the LTX-2.5 setup.`) : null,
    t?.error ? note(t.error, 'err') : null);

  const inputs = section('Source', null,
    needs.has('source') ? sourceField('source') : null,
    needs.has('first') ? firstField(e.needs.includes('first?')) : null,
    needs.has('matte') ? sourceField('matte') : null,
    needs.has('points') ? pointsFields() : null,
    needs.has('tracks') ? tracksFields() : null);

  const prompt = needs.has('prompt') ? section('Prompt', null,
    h('textarea', { rows: 4, value: T.prompt, placeholder: e.id === 'mask' ? 'What to cut out, e.g. "the man in the red coat"' : 'Describe the result',
      oninput: (ev) => { T.prompt = ev.target.value; tabs?.changed(); } })) : null;

  const settings = section('Settings', null,
    needs.has('keycolor') ? keyFields() : null,
    needs.has('loras') ? lorasField(t) : null,
    needs.has('len') ? rangeField('Length', () => T.len, (v) => { T.len = v; }, { min: 1, max: 10, step: 1 / 3,
      fmt: (v) => `${v.toFixed(1)}s · ${lenFrames(v)} frames`, onChange: () => changed(), help: 'LTX makes 8n+1 frames at 24 fps; long clips need a lot of memory.' }) : null,
    needs.has('res') ? field('Resolution', seg([[544, '544p'], [704, '704p'], [1088, '1088p']], T.res, (v) => { T.res = Number(v); changed(false); }),
      help('The short side, in pixels. 704p takes about 1.5 minutes for 5 s on this card; 1088p about 3.')) : null,
    needs.has('size') ? field('Size', h('select', { onchange: (ev) => { T.size = SIZES[ev.target.value][1]; changed(false); } },
      SIZES.map(([l, s], i) => h('option', { value: i, selected: JSON.stringify(s) === JSON.stringify(T.size) }, l)))) : null,
    needs.has('seed') ? field('Seed', h('div', { class: 'row' },
      h('input', { type: 'number', value: T.seed < 0 ? '' : T.seed, placeholder: 'random', min: 0,
        onchange: (ev) => { T.seed = ev.target.value === '' ? -1 : Math.max(0, Math.floor(Number(ev.target.value))); changed(false); } }))) : null,
    h('div', { class: 'row' }, runBtn));

  body.replaceChildren(h('div', { class: 'panel-body' }, effect, inputs, prompt, settings, resultsSection()));
  drawViewer();
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
    button('Details', () => openGeneration(g.id)));
}

function pickResult(onPick) {
  openVideoPicker({ title: 'Pick a matte or mask', onPick });
}

// ---- running ----
async function run() {
  const e = fx(T.op);
  if (e.needs.includes('source') && !T.source) return toast('Choose a source clip first', true);
  if (e.needs.includes('matte') && !T.matte) return toast(`Choose a ${T.op === 'cleanplate' ? 'mask' : 'matte'} clip first`, true);
  if (e.needs.includes('first') && !T.first) return toast('Choose the start image first', true);
  await tabs?.flush();
  if (e.job === 'key') return runKey(e);
  const t = tplOf(e);
  if (!t) return toast(`Template ${e.tpl} isn't installed yet`, true);
  const values = {};
  const put = (role, v) => { const f = roleField(t, role); if (f && v !== undefined && v !== null) values[f.key] = v; };
  put('source', T.source && { ...bare(T.source), ...(T.source.trim && { trim: T.source.trim }), ...(T.source.crop && { crop: T.source.crop }) });
  put('matte', T.matte && bare(T.matte));
  put('first', T.first);
  put('prompt', T.prompt);
  put('len', e.needs.includes('len') ? T.len : undefined);
  put('seed', e.needs.includes('seed') ? T.seed : undefined);
  if (e.needs.includes('loras')) {
    if (roleField(t, 'loras')) put('loras', T.loras);
    else if (T.loras[0]) { put('lora', T.loras[0].name); put('strength', T.loras[0].strength); }
  }
  if (e.needs.includes('res')) put('res', T.res);
  const size = T.size || (e.needs.includes('size') && T.first ? await imageSize(T.first) : null);
  if (e.needs.includes('size') && size) { put('width', size[0]); put('height', size[1]); }
  if (e.needs.includes('points')) put('points', JSON.stringify(await pointsPx()));
  if (e.needs.includes('tracks')) put('tracks', JSON.stringify(await tracksPx(t, values)));
  try {
    const parent = T.source?.generation != null ? { generation: T.source.generation, index: T.source.index || 0, frame: null } : null;
    const gens = await api('/api/generate', { method: 'POST', body: { template: t.id, values, batch: 1, project_id: S.project, parent } });
    adoptGenerations(gens);
    T.results.push(...gens.map((g) => g.id));
    changed();
    toast(`Queued ${e.label} as #${gens[0].id}`);
  } catch (err) { toast(err.message, true); }
}

async function runKey(e) {
  const body = { source: bare(T.source), mode: e.id === 'colorkey' ? 'color' : 'matte', project_id: S.project };
  if (e.id === 'colorkey') Object.assign(body, T.key);
  else Object.assign(body, { matte: bare(T.matte), invert: T.key.invert });
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
  if (!UI.srcInfo) { try { UI.srcInfo = await api('/api/videos/probe', { method: 'POST', body: { source: bare(T.source) } }); } catch { UI.srcInfo = null; } }
  return UI.srcInfo;
}

// ---- viewer: source / result wipe, and drawing points and paths ----
const V = { a: null, b: null, still: null, ov: null, stroke: null };

function drawViewer() {
  const stage = $('#vfxStage');
  if (!stage) return;
  const e = fx(T.op);
  const res = T.showing && S.history.get(T.showing);
  const resUrl = res?.status === 'done' ? (res.outputs.find((x) => x.kind === 'video') || res.outputs[0])?.url : null;
  const stillMode = e.needs.includes('tracks') || (!T.source && T.first);
  const aUrl = stillMode ? null : srcUrl(T.source);
  const want = `${aUrl}|${resUrl}|${stillMode ? T.first : ''}`;
  if (stage.dataset.want !== want) {
    stage.dataset.want = want;
    V.a = aUrl ? h('video', { src: aUrl, muted: true, playsInline: true, preload: 'auto', class: 'vfx-a' }) : null;
    V.b = resUrl ? h('video', { src: resUrl, muted: true, playsInline: true, preload: 'auto', class: 'vfx-b' }) : null;
    V.still = stillMode && T.first ? h('img', { src: inputUrl(T.first), class: 'vfx-a', alt: '' }) : null;
    V.ov = h('canvas', { class: 'vfx-ov' });
    const base = V.a || V.still;
    const media = h('div', { class: 'vfx-media' }, base, V.b, V.ov);
    if (V.a && V.b) setWipe(UI.wipe);
    stage.replaceChildren(base || V.b ? media : placeholder('Choose a source clip or a start image'));
    const fit = () => sizeOverlay();
    (V.a || V.b)?.addEventListener('loadedmetadata', () => { if (V.a && T.source?.trim) V.a.currentTime = T.source.trim.start; fit(); });
    V.still?.addEventListener('load', fit);
    wireOverlay(media);
    if (V.a && V.b) V.b.addEventListener('timeupdate', () => { if (Math.abs(V.a.currentTime - V.b.currentTime - (T.source?.trim?.start || 0)) > 0.15) V.a.currentTime = V.b.currentTime + (T.source?.trim?.start || 0); });
  }
  stage.classList.toggle('drawing', !!UI.draw);
  sizeOverlay();
  renderTransport();
}

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
    if (V.a && V.b) { wiping = true; media.setPointerCapture(ev.pointerId); setWipe(p.x); }
  });
  media.addEventListener('pointermove', (ev) => {
    if (V.stroke) { const p = pt(ev), l = V.stroke[V.stroke.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) > 0.01) { V.stroke.push(p); paintOverlay(); } }
    else if (wiping) setWipe(pt(ev).x);
  });
  const up = () => {
    if (V.stroke) { if (V.stroke.length > 1) { T.tracks.push(simplify(V.stroke)); V.stroke = null; changed(); } else V.stroke = null; }
    wiping = false;
  };
  media.addEventListener('pointerup', up); media.addEventListener('pointercancel', up);
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
    for (const v of vids) UI.playing ? v.play().catch(() => {}) : v.pause();
    renderTransport();
  };
  const step = (n) => { UI.playing = false; for (const v of vids) { v.pause(); v.currentTime = Math.max(0, v.currentTime + n / FPS); } renderTransport(); };
  bar.replaceChildren(...[
    iconBtn('Back one frame', '⏮', () => step(-1)),
    button(UI.playing ? '❚❚ Pause' : '▶ Play', play, { cls: 'small primary', disabled: !vids.length }),
    iconBtn('Forward one frame', '⏭', () => step(1)),
    V.a && V.b ? h('span', { class: 'hint' }, 'Drag across the picture to wipe: source left, result right') : null,
    UI.draw ? h('span', { class: 'hint' }, { points: 'Tap to place points', tracks: 'Drag to draw a path', color: 'Tap the screen colour' }[UI.draw]) : null].filter(Boolean));
}

// ---- tabs and wiring ----
async function ensureTabs() {
  if (!tabs.started) await tabs.start();
  for (let i = 0; i < 160 && !tabs.active; i++) await new Promise((r) => setTimeout(r, 50));
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
      load(payload) { T = { ...BLANK(), ...payload }; UI.srcInfo = null; UI.draw = null; render(); },
    } });
  maximizable($('#tab-vfx .stage'), $('#tab-vfx .viewer'), { onChange: () => sizeOverlay() });
  addEventListener('resize', () => { if ($('#tab-vfx').classList.contains('active')) sizeOverlay(); });
  // a result finishing (or failing) redraws its card
  onServer('deck_generation', (m) => { const id = m.data?.id; if (T.results.includes(id)) { setTimeout(render, 0); } });
}
