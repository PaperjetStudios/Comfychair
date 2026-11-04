// The Edit pane's ops, wired: each op's options (fields) and its run on one frame, wrapping what already does the work
// (the Image tools, the Video tab's clip effects and maps, the VFX tab, the Sound tab's voice tools, the 3D tab's
// clean-up and rigging). The list and its rules are web/edit-rules.js; web/edit-run.js runs an op on many frames.
//
//   optsOf(kind, id)                    the op's options as kept on this device (deck.edit.<kind>.<id>), defaults filled in
//   saveOpts(kind, id, opts)            keep them
//   opValues / setOpValues(kind, id, opts[, v])   what a setup of the op keeps, and showing one (setups.js)
//   opFields(kind, id, opts, ctx)       DOM[]: the op's options (ctx: { redraw(), frames }); opts is changed in place and kept
//   runOp(kind, id, frame, opts, ctx)   one run on one frame. ctx: { target ('frame' | 'layer' | 'self'), into (the frame its
//                                       result goes in: a new one beside, or this one), tab (into's document), batch, live,
//                                       frames (the selection), onRun(gens, to) (a run queued that lands later) }.
//                                       Resolves { gens? (queued runs), job? (a promise of the landed result), landed? }
//   OP_DEFAULTS                         the starting options per 'kind:id'
import { api, button, field, h, help, hint, rangeField, seg, store, textArea, toggle, colorField } from './ui.js';
import { CURRENT_EDIT, S } from './core.js';
import { bareSource, clipLabel, grabFrame, openVideoPicker, soundSource } from './media.js';
import { adoptGenerations, queueRun, template, valuesByRole, waitGen, ROLES } from './make.js';
import { CLIP_FX, KEY_DEFAULT, keyRangeFields, loraChoice, restyleLoras, runClipStep } from './clip-effects.js';
import { pictureInput } from './picture-input.js';
import { isLive } from './live.js';
import { DOC_KIND } from './table-model.js';
import { opById, resultLabel } from './edit-rules.js';
import { omit } from './setups-rules.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');

export const OP_DEFAULTS = {
  'video:grab': { at: '' },
  'video:delogo': { mode: 'quality' },
  'video:maps': { op: 'depth', depthModel: 'large', edgeAmount: 'normal', poser: 'dwpose' },
  'video:restyle': { lora: null, strength: 1, prompt: '' },
  'video:upscale': { prompt: '', outsize: 'FullHD' },
  'video:upvideo': { scale: 2 },
  'video:upvideofast': { scale: 2 },
  'video:cleanplate': { prompt: '' },
  'video:replace': { target: '', prompt: '' },
  'video:mask': { prompt: '' },
  'video:colorkey': { color: '#00ff00', ...KEY_DEFAULT },
  'video:mattekey': { matte: null, invert: false },
  'video:refine': { matte: null },
  'video:inpaint': { matte: null, prompt: '' },
  'video:animate': { first: '' },
  'video:faceswap': { first: '' },
  'video:drive': { first: '', prompt: '' },
  'video:ltxdrive': { first: '', prompt: '' },
  'video:layout': { first: '', prompt: '' },
  'video:foley': { prompt: '', len: 8 },
  'sound:voice': { steps: ['vocals', 'dereverb', 'denoise'] },
  'sound:foley': { prompt: '', len: 8 },
  'sound:gain': { gain: 1 },
  'sound:normalise': { normalize: true },
  'scene:cleanup': { mode: 'quads', amount: null, tex: 2048 },
};
const KEY = (kind, id) => `deck.edit.${kind}.${id}`;
export function optsOf(kind, id) {
  if (kind === 'image') return IT?.toolState?.() || {};   // (the Image tools keep their own settings)
  return { ...(OP_DEFAULTS[`${kind}:${id}`] || {}), ...store.get(KEY(kind, id), {}) };
}
export function saveOpts(kind, id, opts) {
  if (kind === 'image') return;
  store.set(KEY(kind, id), opts);
}

// What a setup of an op keeps (setups.js): its options, less the clip or picture it was pointed at. An image op is its
// Image tool's settings (imagetools.js toolValues).
const PER_SHOT = ['matte', 'first'];
export function opValues(kind, id, opts) {
  if (kind === 'image') return IT?.toolValues?.(id) || {};
  return omit(opts, PER_SHOT);
}
export function setOpValues(kind, id, opts, v) {   // (opts changed in place, then kept)
  if (kind === 'image') { IT?.setToolValues?.(id, v); return; }
  for (const k of Object.keys(opts)) if (!PER_SHOT.includes(k)) delete opts[k];
  Object.assign(opts, OP_DEFAULTS[`${kind}:${id}`] ? JSON.parse(JSON.stringify(OP_DEFAULTS[`${kind}:${id}`])) : {}, omit(v, PER_SHOT));
  saveOpts(kind, id, opts);
}

// ---- the Image tools, loaded once (they come with the editor) ----
let IT = null;
const itReady = import('./imagetools.js').then((m) => { IT = m; return m; }).catch(() => null);

// ---------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------
export function opFields(kind, id, opts, ctx = {}) {
  const o = opById(kind, id);
  if (!o) return [];
  const keep = () => saveOpts(kind, id, opts), redraw = () => { keep(); ctx.redraw?.(); };
  const set = (k) => (v) => { opts[k] = v; keep(); };
  const prompt = (label, k = 'prompt', placeholder = '') => field(label, textArea(() => opts[k] || '', set(k), { rows: 2, placeholder, label }));
  const matte = () => field('Matte clip', h('div', { class: 'row wrap' },
    h('span', { class: 'grow' }, opts.matte ? clipLabel(opts.matte) : 'None yet'),
    button('Pick…', () => openVideoPicker({ title: 'The matte clip (white = keep)', onPick: (v) => { opts.matte = { ...bareSource(v), ...(v.label && { label: v.label }) }; redraw(); } }),
      { cls: 'small' })));
  const picture = (label = 'Picture') => pictureInput({ label, name: opts.first || '', set: (n) => { opts.first = n || ''; redraw(); } });
  if (kind === 'image') {
    if (!IT) { itReady.then(() => ctx.redraw?.()); return [hint('Loading the image tools…')]; }
    return IT.toolFields(id, undefined, { redraw: () => ctx.redraw?.(), size: ctx.size || null, eng: null }) || [];
  }
  switch (`${kind}:${id}`) {
    case 'video:grab':
      return [field('At (seconds into the clip)', h('input', { type: 'number', min: 0, step: 0.04, value: opts.at ?? '', placeholder: 'its first frame',
        onchange: (e) => { opts.at = e.target.value; keep(); } })), help('Blank: the clip\'s first frame (its in point). The still lands as a new image frame, or as a layer in an image frame that is selected too.')];
    case 'video:delogo':
      return [field('How', seg([['quality', 'Quality'], ['fast', 'Fast']], opts.mode, (v) => { opts.mode = v; redraw(); })),
        help('Find looks for a mark that stays put while the picture moves; on a still shot it finds nothing, and the frame must be opened to draw the boxes. Quality fills them with ProPainter; Fast is instant but smears.')];
    case 'video:maps':
      return [seg([['depth', 'Depth'], ['canny', 'Canny'], ['scribble', 'Scribble'], ['pose', 'Pose']], opts.op, (v) => { opts.op = v; redraw(); }, { wrap: true }),
        opts.op === 'depth' ? field('Detail', seg([['large', 'Fine'], ['small', 'Fast']], opts.depthModel, (v) => { opts.depthModel = v; redraw(); })) : null,
        opts.op === 'canny' || opts.op === 'scribble' ? field('Amount', seg([['more', 'More lines'], ['normal', 'Normal'], ['less', 'Fewer']], opts.edgeAmount, (v) => { opts.edgeAmount = v; redraw(); })) : null,
        opts.op === 'pose' ? field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], opts.poser, (v) => { opts.poser = v; redraw(); })) : null].filter(Boolean);
    case 'video:restyle':
      return [...loraChoice(restyleLoras(), opts.lora, (v) => { opts.lora = v; redraw(); }, { get: () => opts.strength ?? 1, set: (v) => { opts.strength = v; } }, { onStrength: keep }),
        prompt('Prompt', 'prompt', 'Describe the result: with an empty prompt the change is faint')].filter(Boolean);
    case 'video:upscale':
      return [field('Size', seg([['FullHD', 'Full HD'], ['4K', '4K']], opts.outsize, (v) => { opts.outsize = v; redraw(); })), prompt('Look', 'prompt', 'Light, film, sharpness: not the things in it')];
    case 'video:upvideo': case 'video:upvideofast':
      return [field('Upscale', seg([[2, '×2'], [4, '×4']], opts.scale, (v) => { opts.scale = v; redraw(); }))];
    case 'video:cleanplate': return [prompt('Remove', 'prompt', 'What to take out, e.g. the people')];
    case 'video:replace': return [prompt('Find', 'target', 'What to replace, e.g. the red car'), prompt('Paint', 'prompt', 'The whole shot with the new thing in it')];
    case 'video:mask': return [prompt('Find', 'prompt', 'What to mask, e.g. the dog')];
    case 'video:colorkey':
      return [colorField('Key colour', () => opts.color, (c) => { opts.color = c; keep(); }), ...keyRangeFields(opts, keep)];
    case 'video:mattekey': return [matte(), toggle('Invert (keep what\'s black)', !!opts.invert, (on) => { opts.invert = on; keep(); })];
    case 'video:refine': return [matte(), help('The matte cleaned up with the VFX tab\'s settings; open the full VFX panel to change them.')];
    case 'video:inpaint': return [matte(), prompt('Paint', 'prompt', 'The whole shot with the new thing in it')];
    case 'video:animate': case 'video:faceswap': return [picture('Character')];
    case 'video:drive': case 'video:ltxdrive': return [picture('Still'), prompt('Prompt', 'prompt', 'The person, their clothes and what they do')];
    case 'video:layout': return [picture('First frame'), prompt('Prompt')];
    case 'video:foley': case 'sound:foley':
      return [prompt('Prompt (optional)', 'prompt', 'What to hear, e.g. footsteps on wet gravel'),
        rangeField('Length', () => opts.len ?? 8, (v) => { opts.len = v; }, { min: 1, max: 30, step: 0.5, digits: 1, fmt: (v) => `${v} s`, onChange: keep })];
    case 'sound:voice':
      return [field('Steps', h('div', { class: 'row wrap' }, ...[['vocals', 'Voice only'], ['dereverb', 'Less echo'], ['denoise', 'Less noise']].map(([k, label]) =>
        toggle(label, opts.steps.includes(k), (on) => { opts.steps = on ? [...new Set([...opts.steps, k])] : opts.steps.filter((x) => x !== k); keep(); }))))];
    case 'sound:gain':
      return [rangeField('Master level', () => opts.gain ?? 1, (v) => { opts.gain = v; }, { min: 0, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, onChange: keep })];
    case 'sound:normalise':
      return [toggle('Even out the loudness (−16 LUFS)', opts.normalize !== false, (on) => { opts.normalize = on; keep(); })];
    case 'scene:cleanup': {
      const modes = SCENE_MODES || (loadModes().then(() => ctx.redraw?.()), null);
      if (!modes) return [hint('Loading…')];
      const m = modes[opts.mode] || modes.quads;
      return [field('What to do', seg(Object.entries(modes).map(([k, v]) => [k, v.label]), opts.mode, (v) => { opts.mode = v; opts.amount = null; redraw(); })),
        help(m.help),
        field(`Amount (${m.unit})`, h('input', { type: 'number', min: m.min, max: m.max, step: m.step, value: opts.amount ?? m.value,
          onchange: (e) => { opts.amount = Math.max(m.min, Math.min(m.max, +e.target.value || m.value)); e.target.value = opts.amount; keep(); } })),
        opts.mode === 'quads' || opts.mode === 'voxel' ? field('Texture size', seg([[1024, '1K'], [2048, '2K'], [4096, '4K']], opts.tex, (v) => { opts.tex = v; redraw(); })) : null].filter(Boolean);
    }
    default: return [];
  }
}
let SCENE_MODES = null;
const loadModes = () => import('./scene-import.js').then((m) => { SCENE_MODES = m.cleanModes(); });

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;
// the frame's first clip (kinds: the item kinds that count) as a clip source with its trim, its label and url; the open
// edit's latest when it is live. frame-source.js frameClip when it gives one, else read here.
export async function clipOf(frame, kinds = frame.kind === 'sound' ? ['audio', 'video'] : ['video']) {
  try {
    const { frameClip } = await import('./frame-source.js');
    const c = kinds.includes(frame.kind === 'video' ? 'video' : 'audio') ? await frameClip(frame) : null;
    if (c) return { ...(c.src || c), ...(c.trim && { trim: c.trim }), ...(c.label && { label: c.label }), ...(c.url && { url: c.url }), ...(c.kind && { itemKind: c.kind }) };
  } catch { /* not there: read the document */ }
  if (!frame.doc) return null;
  if (isLive(frame.id)) {
    const mod = frame.kind === 'sound' ? await import('./sound.js') : await import('./video.js');
    const t = frame.kind === 'sound' ? mod.soundTabs?.() : mod.videoTabs?.();
    if (t?.active?.id === frame.doc) await t.flush();
  }
  const d = await api(docUrl(frame.kind, frame.doc), { busy: false }).catch(() => null);
  const it = (d?.payload?.items || []).find((x) => kinds.includes(x.kind) && x.src && (x.src.generation != null || x.src.media));
  if (!it) return null;
  const end = it.out ?? it.dur;
  return { ...bareSource(it.src), ...(it.label && { label: it.label }), ...(it.url && { url: it.url }), itemKind: it.kind,
    trim: { start: it.in || 0, ...(end ? { len: +(end - (it.in || 0)).toFixed(4) } : {}) } };
}
const needClip = async (frame, kinds) => {
  const c = await clipOf(frame, kinds);
  if (!c) throw new Error(`${frame.label || 'This frame'} has no ${kinds.includes('audio') && !kinds.includes('video') ? 'sound' : 'clip'} yet`);
  return c;
};
const secsOf = (src) => src.trim?.len || 10;
const liveEngine = (frame) => {
  const eng = CURRENT_EDIT.eng;
  return isLive(frame.id) && eng?.E?.tab?.id === frame.doc ? eng : null;
};

// ---------------------------------------------------------------------------
// landing: a clip on a video frame's timeline, a sound in a sound frame's mix, a picture as a layer
// ---------------------------------------------------------------------------
export async function landOutput(into, g, { label = '' } = {}) {
  const outs = (g.outputs || []).map((o, index) => ({ o, index }));
  if (into.kind === 'video') {
    const { landClip } = await import('./make-panel.js');
    let n = 0;
    for (const { o, index } of outs.filter(({ o }) => o.kind === 'video' || o.kind === 'image' || o.kind === 'audio')) {
      if (await landClip(into, { kind: o.kind, src: { generation: g.id, index }, url: o.url, label: label || `#${g.id}`, dur: o.duration || 0 }, false)) n++;
    }
    if (!n) throw new Error(`#${g.id} is done but couldn't go on ${into.label || 'the video'}'s timeline: it is in the Shelf`);
    return n;
  }
  const want = into.kind === 'sound' ? ['audio', 'video'] : ['image'];
  const list = outs.filter(({ o }) => want.includes(o.kind)).map(({ index }) => ({ generation: g.id, index }));
  if (!list.length || !(await dropInto(into, list))) throw new Error(`#${g.id} is done but couldn't go in ${into.label || 'the frame'}: it is in the Shelf`);
  return list.length;
}
async function dropInto(into, list) {
  const Table = await import('./table.js');
  return Table.dropOntoFrame(Table.frameById(into.id) || into, list);
}
// runs that land when they're done (also told to ctx.onRun, which keeps them for a reload)
function follow(gens, into, ctx, label) {
  ctx.onRun?.(gens, { tab: into.doc, frame: into.id, kind: into.kind, label });
  return Promise.all(gens.map((g) => (g.status === 'done' ? Promise.resolve(g) : waitGen(g.id)).then((done) => landOutput(into, done, { label }))));
}
// a result made by a helper that waits itself (clip effects, server jobs): { generation, index, url, dur } or a media name
async function landMade(into, made, label) {
  if (made.media) {
    if (into.kind === 'video') {
      const { landClip } = await import('./make-panel.js');
      const s = await soundSource({ media: made.media }).catch(() => null);
      return landClip(into, { kind: made.kind || 'audio', src: { media: made.media }, url: s?.url || `/files/media/${encodeURIComponent(made.media)}`, label, dur: 0 }, false);
    }
    if (!(await dropInto(into, [{ media: made.media, kind: made.kind || 'audio' }]))) throw new Error(`${label} couldn't go in ${into.label || 'the frame'}`);
    return 1;
  }
  const g = S.history.get(made.generation) || await api(`/api/generations/${made.generation}`, { busy: false });
  return landOutput(into, g, { label });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
export async function runOp(kind, id, frame, opts = optsOf(kind, id), ctx = {}) {
  const o = opById(kind, id);
  if (!o) throw new Error(`Unknown edit ${kind}:${id}`);
  const into = ctx.into || frame, label = `${o.label} · ${frame.label || 'frame'}`;
  if (kind === 'image') return runImage(o, frame, ctx);
  if (kind === 'scene') return runScene(o, frame, opts);
  if (kind === 'sound') return runSound(o, frame, opts, { ...ctx, into }, label);
  return runVideo(o, frame, opts, { ...ctx, into }, label);
}

async function runImage(o, frame, ctx) {
  const it = await itReady;
  if (!it?.runToolOn) throw new Error('The image tools aren\'t ready');
  const eng = ctx.target === 'layer' ? liveEngine(frame) : null;
  let src = null;
  if (!eng) {
    const { frameSource } = await import('./frame-source.js');
    src = await frameSource(frame, { multiple: 1 });
    if (!src) throw new Error(`${frame.label || 'That frame'} is empty`);
  }
  const r = await it.runToolOn(o.id, { tab: ctx.tab || frame.doc, src, eng, batch: ctx.batch || 1 });
  return Array.isArray(r) ? { gens: r } : r || {};
}

const SCENE_LINE = { p: Promise.resolve() };   // (one 3D op at a time: each opens its scene in the one engine)
function runScene(o, frame, opts) {
  const job = SCENE_LINE.p.then(async () => {
    const [{ withSceneDoc }, si] = await Promise.all([import('./frame-scene.js'), import('./scene-import.js')]);
    return withSceneDoc(frame, async () => {
      const type = o.id === 'splat' ? 'splat' : 'model', obj = si.sceneObject(o.id === 'blender' ? 'model' : type) || (o.id === 'blender' ? si.sceneObject('splat') : null);
      if (!obj) throw new Error(`${frame.label || 'This 3D frame'} has no ${type} in it`);
      if (type === 'model' && o.id !== 'blender' && obj.gen == null && !/^\/files\/projects\//.test(obj.url || '')) throw new Error('Only a model that is a file in this project can be cleaned up or rigged');
      if (o.id === 'cleanup') { await si.runCleanup(obj, { mode: opts.mode, amount: opts.amount, tex: opts.tex }); return true; }
      if (o.id === 'righuman' || o.id === 'rigany') {
        await si.rigRun(obj.gen, obj.genIndex || 0, obj.name, o.tpl, { skinned: o.id === 'rigany', url: obj.url, like: si.likeOf(obj) });
        return true;
      }
      if (o.id === 'splat') { await si.remakeSplat(obj); return true; }
      if (o.id === 'blender') {
        const { blenderFile, openInBlender } = await import('./blender.js');
        if (!blenderFile(obj.url)) throw new Error('Only a file in this project opens in Blender');
        await openInBlender(obj.url, obj.name, obj.type === 'splat' ? { flip: obj.flip } : {});
        return false;
      }
      throw new Error(`Unknown 3D edit ${o.id}`);
    });
  });
  SCENE_LINE.p = job.catch(() => {});
  return { job };
}

async function runSound(o, frame, opts, ctx, label) {
  const into = ctx.into;
  if (o.id === 'gain' || o.id === 'normalise') {
    const patch = o.id === 'gain' ? { gain: Number(opts.gain ?? 1) } : { normalize: opts.normalize !== false };
    const snd = isLive(frame.id) ? await import('./sound.js') : null;
    if (snd && snd.soundTabs?.()?.active?.id === frame.doc) snd.setOut(patch);
    else {
      const { editDoc } = await import('./table-frames.js');
      await editDoc('sound', frame.doc, (p) => { p.out = { ...(p.out || {}), ...patch }; });
    }
    return { landed: true };
  }
  if (o.id === 'voice') {
    const st = await api('/api/voice/status', { busy: false }).catch(() => null);
    if (st && !st.installed) throw new Error('The AI voice tools aren\'t installed on the server yet (README: Sound tab → Voice tools)');
    const src = await needClip(frame, ['audio', 'video']);
    const { waitJob } = await import('./clipimport.js');
    const started = await api('/api/voice/isolate', { method: 'POST', busy: false,
      body: { source: bareSource(src), trim: src.trim || null, steps: opts.steps?.length ? opts.steps : ['vocals'], name: `${src.label || frame.label || 'sound'}-voice` } });
    const job = waitJob(started).then((m) => landMade(into, { media: m.name, kind: 'audio' }, `${src.label || frame.label || 'Sound'} (voice)`));
    return { job };
  }
  if (o.id === 'foley') return foley(frame, opts, ctx, label, ['video']);
  throw new Error(`Unknown sound edit ${o.id}`);
}

async function foley(frame, opts, ctx, label, kinds) {
  const t = template('deck-mmaudio-foley');
  if (!t) throw new Error('deck-mmaudio-foley isn\'t installed yet');
  const src = await needClip(frame, kinds);
  const values = valuesByRole(t, { source: { ...bareSource(src), ...(src.trim && { trim: src.trim }) }, prompt: opts.prompt || undefined, seed: -1 });
  const lenF = t.fields.find((f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(`${f.label} ${f.input} ${f.group}`));
  if (lenF) values[lenF.key] = Math.min(opts.len ?? 8, src.trim?.len || 30);
  const gens = await queueRun({ template: t.id, values, batch: ctx.batch || 1 });
  return { gens, job: follow(gens, ctx.into, ctx, label) };
}

// the clip effects of the Video tab (clip-effects.js runClipStep): run and waited for, then landed
const STEP_OF = { restyle: (x) => ({ op: 'restyle', prompt: x.prompt, lora: x.lora, strength: x.strength }), cleanplate: (x) => ({ op: 'cleanplate', prompt: x.prompt }),
  replace: (x) => ({ op: 'replace', target: x.target, prompt: x.prompt }), cutout: () => ({ op: 'cutout' }), upscale: (x) => ({ op: 'upscale', prompt: x.prompt, outsize: x.outsize }),
  colorkey: (x) => ({ op: 'colorkey', color: x.color, similarity: x.similarity, blend: x.blend, spill: x.spill, invert: x.invert }) };
// effects run through the frame's own VFX document (frame-vfx.js), so they are also in its VFX Output
const VFX_PATCH = {
  mask: (x) => ({ prompt: x.prompt || '', points: { positive: [], negative: [] } }),
  alpha: () => ({ matte: null }),
  mattekey: (x) => ({ matte: x.matte, key: { ...KEY_DEFAULT, color: '#00ff00', invert: !!x.invert } }),
  refine: (x) => ({ matte: x.matte, matte2: null }),
  inpaint: (x) => ({ matte: x.matte, prompt: x.prompt || '' }),
  animate: (x) => ({ first: x.first || null }), faceswap: (x) => ({ first: x.first || null }),
  drive: (x) => ({ first: x.first || null, prompt: x.prompt || '' }), ltxdrive: (x) => ({ first: x.first || null, prompt: x.prompt || '' }),
  layout: (x) => ({ first: x.first || null, prompt: x.prompt || '' }),
};

async function runVideo(o, frame, opts, ctx, label) {
  const into = ctx.into;
  if (o.id === 'grab') return grab(frame, opts, ctx);
  if (o.id === 'foley') return foley(frame, opts, ctx, label, ['video']);
  const src = await needClip(frame, ['video']);
  const n = Math.max(1, ctx.batch || 1);
  if (STEP_OF[o.id]) {
    if (o.id === 'restyle' && !opts.lora) throw new Error('Pick the LoRA first');
    if (o.id === 'replace' && !opts.target?.trim()) throw new Error('Say what to replace first');
    const step = STEP_OF[o.id](opts), source = { ...bareSource(src), ...(src.trim && { trim: src.trim }) };
    const job = (async () => {
      for (let i = 0; i < n; i++) await landMade(into, await runClipStep(step, source, secsOf(src)), label);
    })();
    return { job };
  }
  if (o.id === 'maps') {
    const { queueMap } = await import('./video-maps.js');
    const gens = [];
    for (let i = 0; i < n; i++) gens.push(...(await queueMap(src, opts)).gens);
    return { gens, job: follow(gens, into, ctx, label) };
  }
  if (o.id === 'upvideo' || o.id === 'upvideofast') {
    const t = template(o.tpl);
    if (!t) throw new Error(`${o.tpl} isn't installed yet`);
    const values = valuesByRole(t, { source: { ...bareSource(src), ...(src.trim && { trim: src.trim }) } });
    const sf = t.fields.find((f) => f.input === 'scale_by');
    if (sf) values[sf.key] = Number(opts.scale) || 2;
    const gens = await queueRun({ template: t.id, values, batch: n });
    return { gens, job: follow(gens, into, ctx, label) };
  }
  if (o.id === 'delogo') return delogo(src, opts, ctx, label);
  if (o.id === 'finish') {
    if (src.generation == null) throw new Error('Only a run can be finished: this clip is a file');
    const g = S.history.get(src.generation) || await api(`/api/generations/${src.generation}`, { busy: false });
    if (!/^deck-h3-|^h3 (upscale|regenerate)$/.test(g?.template || '')) throw new Error(`#${src.generation} isn't an H3 run: use Use as → Finish with H3 on it`);
    const info = await api('/api/h3/regen', { busy: false });
    if (!info.available) throw new Error(info.reason || 'Regenerate needs its refiner LoRA in models/loras');
    const r = await api('/api/h3/upscale', { method: 'POST', busy: false,
      body: { generation: g.id, index: src.index || 0, scale: 1.5, strength: 'medium', regen: { quality: 'standard', lora: info.loras[0].name, target: '1080p' } } });
    S.history.set(r.id, r);
    adoptGenerations([r]);
    return { gens: [r], job: follow([r], into, ctx, label) };
  }
  if (VFX_PATCH[o.id]) {
    if (['mattekey', 'refine', 'inpaint'].includes(o.id) && !opts.matte) throw new Error('Pick the matte clip first');
    if (['animate', 'faceswap', 'drive', 'ltxdrive', 'layout'].includes(o.id) && !opts.first) throw new Error('Choose the picture first');
    const fv = await import('./frame-vfx.js'), { runVfxOn } = await import('./vfx.js');
    const doc = await fv.ensureDoc(frame);
    const all = [], jobs = [];
    const onQueued = (gens, { aside }) => { if (aside) return; all.push(...gens); jobs.push(follow(gens, into, ctx, label)); };
    for (let i = 0; i < n; i++) {
      await runVfxOn(doc, { op: o.id, source: { ...bareSource(src), ...(src.trim && { trim: src.trim }), ...(src.label && { label: src.label }) },
        ...(src.trim?.len && { len: Math.min(30, Math.max(1, Math.round(src.trim.len))) }), ...VFX_PATCH[o.id](opts) }, { onQueued });
    }
    return { gens: all, job: Promise.all(jobs) };
  }
  throw new Error(`${o.label} can't run from here yet`);
}

// Remove watermark with Find: the boxes found on the clip, then filled (POST /api/video/delogo, as the VFX tab's)
async function delogo(src, opts, ctx, label) {
  const body = { source: bareSource(src), trim: src.trim || null, crop: null };
  const found = await api('/api/video/delogo/find', { method: 'POST', body, timeout: 300000, busy: false });
  if (!found.boxes?.length) throw new Error('Nothing stays put in this clip: open the frame and draw the boxes in the VFX panel');
  const quality = opts.mode !== 'fast';
  const g = await api('/api/video/delogo', { method: 'POST', timeout: quality ? 120000 : 3600000, busy: false,
    body: { ...body, boxes: found.boxes, mode: quality ? 'quality' : 'fast', project_id: S.project } });
  S.history.set(g.id, g);
  if (quality) adoptGenerations([g]);
  return { gens: [g], job: follow([g], ctx.into, ctx, label) };
}

// Grab frame: a still of the clip at opts.at (its in point when blank). Into the selected image frame as a layer when one is
// selected and the target is a layer; else a new image frame of the picture's size, beside the video.
async function grab(frame, opts, ctx) {
  const src = await needClip(frame, ['video']);
  const at = opts.at === '' || opts.at == null ? null : (src.trim?.start || 0) + Math.max(0, Number(opts.at) || 0);
  const name = await grabFrame(src, { at });
  const Table = await import('./table.js');
  const onto = ctx.target === 'layer' ? (ctx.frames || []).find((f) => f.kind === 'image' && f.doc) : null;
  let into = null;
  if (onto && Table.dropOntoFrame(Table.frameById(onto.id) || onto, [{ input: name }])) into = onto;
  else {
    const info = grabFrame.last || {}, { besideSpot } = await import('./table-frames.js');
    const size = { w: info.width || frame.w, h: info.height || frame.h };
    const at = besideSpot ? besideSpot(Table.tableFrames() || [], frame, size) : { x: frame.x + frame.w + 40, y: frame.y };
    into = await Table.sourceFrameAt({ input: name, width: info.width, height: info.height, label: resultLabel(opById('video', 'grab'), frame) }, at);
  }
  dispatchEvent(new CustomEvent('edit:grabbed', { detail: { frame, input: name, into: into || null } }));
  if (!into) throw new Error('The frame was grabbed but couldn\'t go on the table: it is in your pictures');
  return { landed: true, into };
}

// ROLES is re-exported for the pane's own checks (which field a template gives a role)
export { ROLES, CLIP_FX };
