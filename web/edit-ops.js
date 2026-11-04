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
//   frameOps(frame, id), setFrameOps(frames, id, patch)   what a frame keeps for an op (frame.ops[id], saved with the table:
//                                       the marks placed on it, its mattes, key, canvas and results); a video op with `vfx`
//                                       runs on its options over this (vfxState)
//   cachedClip(frame, then)             the frame's first clip as last read (null until read; then() once it is)
//   liveClipTime(frame)                 seconds into that clip at the open frame's playhead (points keep it)
//   compareFor(frame, id)               a function that wipes the frame's clip against its newest result of the op on the open
//                                       frame (frame-overlay.js compare), or null when there's none
import { api, field, h, help, hint, rangeField, seg, store, textArea, toast, toggle } from './ui.js';
import { CURRENT_EDIT, S } from './core.js';
import { bareSource, clipUrl, grabFrame, soundSource } from './media.js';
import { adoptGenerations, queueRun, roleField, template, valuesByRole, waitGen, ROLES } from './make.js';
import { CLIP_FX, loraChoice, restyleLoras, runClipStep } from './clip-effects.js';
import { isLive } from './live.js';
import { DOC_KIND } from './table-model.js';
import { OPS, opById, resultLabel } from './edit-rules.js';
import { ALPHA, BLANK, CANVAS, FRAME_KEYS, KEY as KEY_SET, NOT_SETUP, REFINE, SAM, boxesFromFind, buildRun, delogoBody, delogoRunBody, effectById, keyBody, matteBody,
  missingInput, needsOf, poseBody } from './vfx-rules.js';
import { imageNat, imageSize, vfxFields } from './vfx-fields.js';
import { characterById } from './characters.js';
import { omit } from './setups-rules.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');

export const OP_DEFAULTS = {
  'video:grab': { at: '' },
  'video:maps': { op: 'depth', depthModel: 'large', edgeAmount: 'normal', poser: 'dwpose' },
  'video:restyle': { lora: null, strength: 1, prompt: '' },
  'video:upscale': { prompt: '', outsize: 'FullHD' },
  'video:upvideo': { scale: 2 },
  'video:upvideofast': { scale: 2 },
  'video:cleanplate': { prompt: '' },
  'video:replace': { target: '', prompt: '' },
  'video:foley': { prompt: '', len: 8 },
  'sound:voice': { steps: ['vocals', 'dereverb', 'denoise'] },
  'sound:foley': { prompt: '', len: 8 },
  'sound:gain': { gain: 1 },
  'sound:normalise': { normalize: true },
  'scene:cleanup': { mode: 'quads', amount: null, tex: 2048 },
};
// a VFX op's options: the VFX tab's settings (vfx-rules.js BLANK), less what the frame keeps; len null: the clip's length
const vfxDefaults = () => ({ ...omit(BLANK(), [...FRAME_KEYS, 'op', 'source', 'results', 'showing']), len: null, first: null, poser: 'dwpose',
  outsize: 'FullHD', sam: { ...SAM }, alpha: { ...ALPHA } });
for (const o of OPS.video) if (o.vfx) OP_DEFAULTS[`video:${o.id}`] = vfxDefaults();

// ---- what a frame keeps per op (frame.ops[id]), saved with the table ----
export const frameOps = (frame, id) => frame?.ops?.[id] || {};
let TableMod = null;
const tableReady = import('./table.js').then((m) => { TableMod = m; return m; }).catch(() => null);
export function setFrameOps(frames, id, patch) {
  for (const f of frames || []) {
    if (!f) continue;
    f.ops = { ...(f.ops || {}), [id]: { ...(f.ops?.[id] || {}), ...JSON.parse(JSON.stringify(patch)) } };
  }
  if (TableMod) TableMod.frameChanged(); else tableReady.then((m) => m?.frameChanged());
}
// a VFX op's state on a frame: its options, the frame's marks, mattes and key over them
export function vfxState(kind, id, opts, frame) {
  return { ...(OP_DEFAULTS[`${kind}:${id}`] ? JSON.parse(JSON.stringify(OP_DEFAULTS[`${kind}:${id}`])) : {}), ...JSON.parse(JSON.stringify(opts || {})),
    points: { positive: [], negative: [] }, pointsAt: 0, boxes: [], tracks: [], matte: null, matte2: null,
    key: { ...KEY_SET }, refine: { ...REFINE }, canvas: { ...CANVAS }, ...JSON.parse(JSON.stringify(frameOps(frame, id))) };
}

// ---- the frame's first clip, kept as last read: its length for the fields, the playhead's time in it for points ----
const CLIPS = new Map();   // frame id -> { doc, clip, at }
export function cachedClip(frame, then = null) {
  if (!frame) return null;
  const c = CLIPS.get(frame.id);
  if (!c || c.doc !== frame.doc || performance.now() - c.at > 4000) {
    const rec = { doc: frame.doc, clip: c?.clip ?? null, at: performance.now() };
    CLIPS.set(frame.id, rec);
    clipOf(frame).then((clip) => { const was = JSON.stringify(rec.clip); rec.clip = clip; if (JSON.stringify(clip) !== was) then?.(); }, () => {});
  }
  return CLIPS.get(frame.id).clip;
}
let VID = null;
const vidReady = import('./video.js').then((m) => { VID = m; }).catch(() => null);
export function liveClipTime(frame) {
  const clip = CLIPS.get(frame?.id)?.clip, it = clip?.item;
  const t = VID?.videoTime?.() ?? 0;
  return it ? Math.max(0, (it.in || 0) + t - (it.at || 0)) : t;
}
// the newest result of op id on frame that is a clip, wiped against the frame's clip on the open frame
export function compareFor(frame, id) {
  const ids = frameOps(frame, id).results || [];
  if (!ids.length) return null;
  return async () => {
    let g = null;
    for (const gid of [...ids].reverse()) {
      const x = S.history.get(gid) || await api(`/api/generations/${gid}`, { busy: false }).catch(() => null);
      if (x?.status === 'done' && x.outputs?.some((o) => o.kind === 'video')) { g = x; break; }
    }
    if (!g) throw new Error('No result to compare yet: it is still being made, or it was deleted');
    const clip = await clipOf(frame);
    const a = clip && (clipUrl(clip) || clip.url);
    if (!a) throw new Error(`${frame.label || 'This frame'} has no clip to compare`);
    const { overlay } = await import('./frame-overlay.js');
    await vidReady;
    if (!overlay.compare(a, g.outputs.find((o) => o.kind === 'video').url, { labels: [clip.label || 'Clip', `#${g.id}`] })) throw new Error('Open the frame to compare');
  };
}
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
// A VFX op's setup also keeps the frame's key, matte clean-up and canvas (the first selected frame's; shown on all of them).
const PER_SHOT = [...new Set(['matte', 'first', ...NOT_SETUP])];
const FRAME_SETTINGS = ['key', 'refine', 'canvas'];
export function opValues(kind, id, opts, frames = []) {
  if (kind === 'image') return IT?.toolValues?.(id) || {};
  const o = opById(kind, id), f = frameOps(frames[0], id);
  return omit({ ...opts, ...(o?.vfx ? Object.fromEntries(FRAME_SETTINGS.filter((k) => f[k] != null).map((k) => [k, f[k]])) : {}) }, PER_SHOT);
}
export function setOpValues(kind, id, opts, v, frames = []) {   // (opts changed in place, then kept)
  if (kind === 'image') { IT?.setToolValues?.(id, v); return; }
  const vfx = !!opById(kind, id)?.vfx;
  for (const k of Object.keys(opts)) if (!PER_SHOT.includes(k)) delete opts[k];
  Object.assign(opts, OP_DEFAULTS[`${kind}:${id}`] ? JSON.parse(JSON.stringify(OP_DEFAULTS[`${kind}:${id}`])) : {}, omit(v, vfx ? [...PER_SHOT, ...FRAME_SETTINGS] : PER_SHOT));
  saveOpts(kind, id, opts);
  if (vfx && frames.length) setFrameOps(frames, id, Object.fromEntries(FRAME_SETTINGS.map((k) => [k, v[k] ?? (k === 'key' ? { ...KEY_SET } : k === 'refine' ? { ...REFINE } : { ...CANVAS })])));
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
  if (kind === 'image') {
    if (!IT) { itReady.then(() => ctx.redraw?.()); return [hint('Loading the image tools…')]; }
    return IT.toolFields(id, undefined, { redraw: () => ctx.redraw?.(), size: ctx.size || null, eng: null }) || [];
  }
  if (o.vfx) {   // a VFX effect: its fields on the op's options and the first frame's own state (every selected frame gets changes)
    const frames = (ctx.frames || []).filter((f) => f.kind === kind), frame = frames[0] || null;
    const st = vfxState(kind, id, opts, frame);
    return vfxFields(o, effectById(o.vfx), st, {
      set: (k, v, rd = false) => { opts[k] = v; keep(); if (rd) ctx.redraw?.(); },
      setFrame: (k, v) => { setFrameOps(frames, id, { [k]: v }); ctx.redraw?.(); },
      redraw: () => ctx.redraw?.(), frame, live: !!ctx.live,
      tool: ctx.tool || null, setTool: ctx.setTool || (() => {}), neg: !!ctx.neg, setNeg: ctx.setNeg || (() => {}),
      compare: ctx.live && frame ? (() => { const go = compareFor(frame, id); return go && (() => go().catch((e) => toast(e.message, true))); })() : null,
      clipLen: cachedClip(frame, () => ctx.redraw?.())?.trim?.len ?? null,
      find: () => findBoxes(frame, opts).then(() => ctx.redraw?.(), (e) => toast(e.message, true)) });
  }
  switch (`${kind}:${id}`) {
    case 'video:grab':
      return [field('At (seconds into the clip)', h('input', { type: 'number', min: 0, step: 0.04, value: opts.at ?? '', placeholder: 'its first frame',
        onchange: (e) => { opts.at = e.target.value; keep(); } })), help('Blank: the clip\'s first frame (its in point). The still lands as a new image frame, or as a layer in an image frame that is selected too.')];
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
  replace: (x) => ({ op: 'replace', target: x.target, prompt: x.prompt }), cutout: () => ({ op: 'cutout' }), upscale: (x) => ({ op: 'upscale', prompt: x.prompt, outsize: x.outsize }) };
async function runVideo(o, frame, opts, ctx, label) {
  const into = ctx.into;
  if (o.id === 'grab') return grab(frame, opts, ctx);
  if (o.id === 'foley') return foley(frame, opts, ctx, label, ['video']);
  if (o.vfx) return runVfx(o, frame, opts, ctx, label);
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
  throw new Error(`${o.label} can't run from here yet`);
}

// ---------------------------------------------------------------------------
// the VFX effects: the op's options over the frame's own state (its marks, mattes, key), on the frame's first clip.
// Template effects queue through vfx-rules.js buildRun (as the VFX tab's Run); keying, matte clean-up and watermark
// removal are server jobs (vfx-rules.js keyBody, matteBody, delogoRunBody). Each run is kept on the frame (results).
// ---------------------------------------------------------------------------
const probe = (source) => api('/api/videos/probe', { method: 'POST', body: { source: bareSource(source) }, busy: false }).catch(() => null);
const remember = (frame, id, gens) => setFrameOps([frame], id, { results: [...(frameOps(frame, id).results || []), ...gens.map((g) => g.id)].slice(-8) });

// st for frame: the op's options, its frame state, and the frame's clip as the source (when the effect takes one)
async function stateOn(o, frame, opts) {
  const e = effectById(o.vfx), st = vfxState('video', o.id, opts, frame);
  const clip = needsOf(e).has('source') ? await needClip(frame, ['video']) : null;
  st.source = clip ? { ...bareSource(clip), ...(clip.trim && { trim: clip.trim }), ...(clip.label && { label: clip.label }) } : null;
  if (st.len == null) st.len = Math.min(e.maxLen || 10, Math.max(1, Math.round(clip?.trim?.len || 5)));
  return { e, st };
}

// Remove watermark's Find: the boxes it finds go on the frame (fractions of the whole frame), added to any drawn there
export async function findBoxes(frame, opts) {
  const { st } = await stateOn(opById('video', 'delogo'), frame, opts);
  const r = await api('/api/video/delogo/find', { method: 'POST', body: delogoBody(st), timeout: 300000, busy: 'Looking for a watermark…' });
  if (!r.boxes?.length) throw new Error('Nothing stays put in this clip: draw the boxes on the open frame');
  const boxes = [...(st.boxes || []), ...boxesFromFind(st, r.boxes)];
  setFrameOps([frame], 'delogo', { boxes });
  toast(`Found ${r.boxes.length}: check them on the frame`);
  return boxes;
}

async function runVfx(o, frame, opts, ctx, label) {
  const { e, st } = await stateOn(o, frame, opts);
  const into = ctx.into, n = Math.max(1, ctx.batch || 1);
  const job = async (url, body, timeout = 900000) => {
    const g = await api(url, { method: 'POST', body, timeout, busy: false });
    S.history.set(g.id, g);
    remember(frame, o.id, [g]);
    return { gens: [g], job: follow([g], into, ctx, label) };
  };
  if (e.job === 'delogo') {
    if (!st.boxes?.length) st.boxes = await findBoxes(frame, opts);
    const r = await job('/api/video/delogo', delogoRunBody(st, S.project), st.delogo !== 'fast' ? 120000 : 3600000);
    if (st.delogo !== 'fast') adoptGenerations(r.gens);
    return r;
  }
  const miss = missingInput(e, st);
  if (miss) throw new Error(miss);
  if (e.job === 'key') return job('/api/video/key', keyBody(e, st, S.project));
  if (e.job === 'matte') return job('/api/video/matte', matteBody(st, S.project));
  let info;
  const deps = { template: (id) => S.templates.find((t) => t.id === id) || null, roleField, imageSize, imageNat, character: characterById,
    sourceInfo: async () => (info ??= st.source ? await probe(st.source) : null),
    aspect: async () => { const i = st.source ? (info ??= await probe(st.source)) : null; return i?.width ? i.width / i.height : 16 / 9; },
    canvas: (body) => api('/api/video/canvas', { method: 'POST', busy: false, timeout: 900000, body }) };
  const b = await buildRun(e, st, deps);
  if (typeof b === 'string') throw new Error(b);
  let { t, values } = b;
  if (e.posed && st.source) {   // a drive follows the clip's ready pose video when there is one (a Pose preview of the same clip)
    const posed = template(e.posed);
    const pose = posed ? await api('/api/pose/find', { method: 'POST', body: poseBody(st, S.project), busy: false }).catch(() => null) : null;
    if (pose) { t = posed; values = valuesByRole(posed, { ...b.rv, pose: { generation: pose.generation, index: pose.index } }); }
  }
  const parent = st.source?.generation != null ? { generation: st.source.generation, index: st.source.index || 0, frame: null } : null;
  const { results, ...kept } = st;
  const gens = await queueRun({ template: t.id, values, batch: n, parent, face: { kind: 'vfx', state: { ...kept, op: e.id } } });
  remember(frame, o.id, gens);
  return { gens, job: follow(gens, into, ctx, label) };
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
