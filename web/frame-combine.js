// Combine: the selected frames made into one new frame in their place (web/combine-rules.js says what they make). Pictures become
// layers of one image, clips and sounds go one after another on one timeline, 3D scenes share one scene. The originals leave the
// table as Delete takes them (their documents to the trash); one Undo brings them back and takes the new frame off. A 3D frame
// put on a timeline stays: its clip is live-linked to its scene.
// A picture's file stays: the new document uses it (storage.input_used).
import { api, toast } from './ui.js';
import { S, inputUrl, thumbUrl } from './core.js';
import { combinable, combineClips, combineImages, combineKind, combineScenes, readingOrder } from './combine-rules.js';
import { canvasRect } from './make-rules.js';
import { DOC_KIND, outputOf } from './table-model.js';
import { dropInput, flushDoc } from './table-frames.js';
import { soundTracks, videoTracks } from './empty-docs.js';
import { framesBusy, frameHere, leaveFrames, refreshStills, replaceFrames, tableFrames } from './table.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const readDoc = async (f) => { await flushDoc(f); return (await api(`/api/store/${DOC_KIND[f.kind]}/${f.doc}${qs()}`, { busy: false })).payload || {}; };

// A frame as what a timeline holds: its clips as they are; a picture or a scene as one clip. fresh: pictures copied for this.
async function clipsOf(f, fresh, newItem) {
  if (f.kind === 'video' || f.kind === 'sound') {
    const p = await readDoc(f);
    return (p.items || []).length ? { tracks: p.tracks || [], items: p.items } : null;
  }
  const one = 'one';
  if (f.kind === 'scene') {
    const d = await api(`/api/store/${DOC_KIND.scene}/${f.doc}${qs()}`, { busy: false }), p = d.payload || {};
    const m = { kind: 'scene', src: { scene: f.doc, look: 'color' }, label: d.name || f.label, dur: p.seconds || 6, nat: [p.width || 768, p.height || 448] };
    return { tracks: [{ id: one, kind: 'video' }], items: [newItem(m, one)] };
  }
  const { frameImage } = await import('./frame-source.js');
  const r = await frameImage(f);
  if (r.fresh) fresh.push(r.name);
  return { tracks: [{ id: one, kind: 'video' }], items: [newItem({ kind: 'image', src: { input: r.name }, url: inputUrl(r.name), thumb: thumbUrl(r.name, 160), label: f.label || r.name }, one)] };
}

// { kind, used, payload, rect, out, pictures }: what the frames make; used: the frames that gave something
async function imagePlan(list, stack) {
  const sources = [], used = [];
  for (const frame of list) {
    const payload = await readDoc(frame);
    if (!(payload.layers || []).length) continue;
    sources.push({ frame, payload, rect: frame.fit && frame.fitBox ? { ...frame.fitBox } : canvasRect(payload, frame) });
    used.push(frame);
  }
  if (!sources.length) return null;
  const r = combineImages(sources, { stack });
  return { kind: 'image', used, payload: r.payload, rect: r.tile, out: r.out };
}
async function timelinePlan(kind, list, fresh) {
  const { newItem } = await import('./video.js');
  const order = readingOrder(list), sources = [], used = [];
  for (const f of order) {
    try {
      const c = await clipsOf(f, fresh, newItem);
      if (c) { sources.push(c); used.push(f); } else toast(`"${f.label}" has nothing on its timeline: it stays`);
    } catch (e) { toast(`"${f.label}" stays: ${e.message}`, true); }
  }
  if (!sources.length) return null;
  const sound = kind === 'sound', { tracks, items } = combineClips(sources, { tracks: sound ? soundTracks() : videoTracks(), sound });
  // (it comes out at the largest of them, so nothing is shrunk by a small picture coming first)
  const area = (f) => { const o = outputOf(f); return o ? o.w * o.h : 0; };
  const first = [...used].sort((a, b) => area(b) - area(a))[0], left = Math.min(...list.map((f) => f.x)), top = Math.min(...list.map((f) => f.y));
  const base = sound ? { tracks, items, out: { name: '', format: 'm4a', gain: 1, normalize: false }, gens: [] } : { tracks, items, size: null, fps: 0, range: null };
  const out = outputOf(first);
  // (a 3D clip is live-linked to its scene's document, so that frame stays on the table)
  return { kind, used, gone: used.filter((f) => f.kind !== 'scene'), payload: base, rect: { x: left, y: top, w: first.w, h: first.h }, out: sound ? null : out };
}
async function scenePlan(list, fresh) {
  const scenes = list.filter((f) => f.kind === 'scene'), pictures = list.filter((f) => f.kind === 'image');
  const payloads = [];
  for (const f of scenes) payloads.push(await readDoc(f));
  const { frameImage } = await import('./frame-source.js'), names = [], used = [...scenes];
  for (const f of pictures) {
    try {
      const r = await frameImage(f);
      if (r.fresh) fresh.push(r.name);
      names.push(r.name); used.push(f);
    } catch (e) { toast(`"${f.label}" stays: ${e.message}`, true); }
  }
  const first = scenes[0];
  return { kind: 'scene', used, payload: combineScenes(payloads), pictures: names, out: outputOf(first),
    rect: { x: Math.min(...list.map((f) => f.x)), y: Math.min(...list.map((f) => f.y)), w: first.w, h: first.h } };
}

let running = false;
// frames: the selection. stack: images all centred on the largest canvas instead of as they sit on the table.
export async function combineFrames(frames, { stack = false } = {}) {
  const list = combinable(frames), kind = combineKind(list);
  if (!kind) { toast('Select two or more frames to combine (not notes, hidden or locked ones)', true); return null; }
  if (running) return null;
  if (framesBusy(list)) { toast(`"${framesBusy(list).label}" is still waiting for a result: combine once it has landed`, true); return null; }
  running = true;
  const fresh = [], ok = frameHere();
  let made = null;
  try {
    await leaveFrames(list);
    // (bottom first, as the table stacks them: selection order is not stacking order)
    const stacked = tableFrames().filter((f) => list.some((x) => x.id === f.id));
    const plan = kind === 'image' ? await imagePlan(stacked, stack) : kind === 'scene' ? await scenePlan(stacked, fresh) : await timelinePlan(kind, list, fresh);
    if (!plan || !ok()) { dropInput(fresh); if (ok()) toast('Those frames have nothing in them to combine yet', true); return null; }
    if (plan.used.length < 2) { dropInput(fresh); toast('Only one of those frames has anything in it, so there is nothing to combine', true); return null; }
    made = await replaceFrames(plan.gone || plan.used, plan.kind, plan.rect, { payload: plan.payload, out: plan.out, ok });
    if (!made) { dropInput(fresh); return null; }
    if (plan.kind === 'image') {
      await (await import('./frame-image.js')).drawOffscreen(made.doc).catch((e) => console.warn(e));
      await refreshStills(['image']);
    } else if (plan.kind === 'scene') {
      const Scene = await import('./frame-scene.js');
      if (plan.pictures.length) await Scene.landInScene(made, plan.pictures.map((input) => ({ input }))).catch((e) => toast(e.message, true));
      else Scene.sceneStillSoon(made);
    } else await refreshStills([plan.kind]);
    return made;
  } catch (e) {
    dropInput(fresh); toast(`Couldn't combine: ${e.message}`, true);
    return null;
  } finally { running = false; }
}

// the frame menu's items for this selection (frame-menu.js), none when they can't be combined
export function combineEntries(frames) {
  const kind = combineKind(frames);
  if (!kind) return [];
  const run = (opts) => () => combineFrames(frames, opts);
  const label = { image: 'Combine into one image', video: 'Combine onto a new timeline', sound: 'Combine into one mix', scene: 'Combine into one 3D scene' }[kind];
  return [{ label, keys: 'Ctrl+E', run: run() }, ...(kind === 'image' ? [{ label: 'Combine as a stack', run: run({ stack: true }) }] : [])];
}
