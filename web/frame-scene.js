// 3D frames on the table: going live mounts the 3D engine (scene.js mountScene) in the frame at 1:1: its viewer and
// key sheet move into the frame and its panel into the sidebar's pane. There is one engine and one WebGL context, so
// the elements move between the page's 3D tab and the frame; coming back draws the still (the shot camera's view),
// saves and puts them back. The frame's document is a scene (scene-tabs), opened through the 3D tab's one TabSet.
// Image frames dropped on a 3D frame go into its scene as a background picture or a 3D photo; so do pictures dropped on
// it from the Shelf or a picker (table:drop-frame sources).
// Models, splats and motions dropped on it (files, or a run's outputs) go into its scene (landInScene); a clip goes in as
// the reference over the view. A Track motion result, a dropped model and a run's 3D output make new 3D frames
// (sceneFrameFrom, table-frames.js frameFor). Its panel's Render and Save frame hand what they make to onSceneOut.
//
// The Frame pane gets a 3D section for one selected 3D frame: its size (the scene's picture), length, frame rate and which
// videos Render makes (scene-ui.js / scene-data.js setters; off screen through withSceneDoc or its saved document).
//
// table.js's events (detail.handled = true when taken here): table:live, table:unlive, table:resize, table:drop-frame.
import { api, field, h, help, hint, rangeField, section, toast, toggle, chips } from './ui.js';
import { isLive } from './live.js';
import { uploadImage } from './media.js';
import { sceneModule } from './run.js';
import { sidebar } from './sidebar.js';
import { besideSpot, editDoc, putStill, sourcePicture, stillOf } from './table-frames.js';
import { nextBeside } from './table-model.js';
import { dropKind } from './drop-files.js';
import { kindOf } from './kinds.js';
import { S } from './core.js';
import { frameChanged, refreshStills, selectedFrames } from './table.js';
import { openPressMenu } from './press-menu.js';

const F = { seq: 0, mounted: null, m: null, size: null };   // mounted: the frame the engine is in; size: the scene's when it went live

const PANE = { title: 'Objects', icon: 'cube', host: false };

// ---- live ----
addEventListener('table:live', (e) => {
  const { frame, root } = e.detail;
  if (frame.kind !== 'scene') return;
  e.detail.handled = true;
  live(frame, root).catch((err) => { console.error(err); toast(`Couldn't open the 3D frame: ${err.message}`, true); });
});

async function live(frame, root) {
  const seq = ++F.seq, say = (t) => root.replaceChildren(h('div', { class: 'frame-loading', role: 'status' }, t));
  say('Opening…');
  if (!frame.doc) return say('This frame has no scene');
  const m = F.m = await sceneModule();
  const t = m.sceneTabs();
  try {
    await t.ready();
    for (let k = 0; k < 2 && t.active?.id !== frame.doc; k++) {   // (openQuiet gives up quietly when it is raced)
      await t.openQuiet(frame.doc);
      if (seq !== F.seq || !isLive(frame.id)) return;
    }
  } catch (err) { toast(err.message, true); }
  if (seq !== F.seq || !isLive(frame.id)) return;
  if (t.active?.id !== frame.doc) return say('Couldn\'t open this frame\'s scene');
  // the slots the engine's viewer and key sheet take, in a stage as the 3D tab has them (the sheet's menus open there)
  const viewer = h('div', { class: 'viewer' }), transport = h('div', { class: 'transport' });
  root.classList.add('scene-frame');
  root.replaceChildren(h('div', { class: 'stage editor-stage' }, viewer, transport));
  const pane = sidebar.pane('layers', PANE);
  m.mountScene({ host: root, viewer, transport, panel: pane, active: () => isLive(frame.id) });   // (its full screen is the frame's own)
  F.mounted = frame.id;
  const ui = F.ui = await import('./scene-ui.js');   // (loaded with the engine already)
  if (F.mounted === frame.id) {
    ui.OUT.rendered = (gens) => tell(frame, { gens });
    ui.OUT.saved = (picture, kind) => tell(frame, { picture, kind });
  }
  m.setSceneSize(frame.w, frame.h);   // (the frame's size is the scene's picture)
  F.size = m.sceneSize();
  m.show();
  sidebar.refresh(); sidebar.show('layers');
}

addEventListener('table:resize', (e) => {
  const { frame } = e.detail;
  if (frame.kind !== 'scene' || F.mounted !== frame.id) return;
  e.detail.handled = true;
  F.m.setSceneSize(frame.w, frame.h);
  F.size = F.m.sceneSize();
});

addEventListener('table:unlive', (e) => {
  const { frame, root } = e.detail;
  if (frame.kind !== 'scene') return;
  F.seq++;
  if (F.mounted !== frame.id) return;
  e.detail.handled = true;
  F.mounted = null;
  if (F.ui) F.ui.OUT.rendered = F.ui.OUT.saved = null;
  const m = F.m, t = m.sceneTabs(), id = frame.doc;
  // the size changed in the panel while open: the frame takes it
  const s = m.sceneSize(), resized = F.size && (s.w !== F.size.w || s.h !== F.size.h);
  if (resized) Object.assign(frame, { w: s.w, h: s.h });
  const still = t.active?.id === id ? m.sceneStill() : null;   // (drawn and read now, before the engine moves)
  m.hide();
  m.unmountScene();
  m.dropFull(root);   // (the mount's own full screen: its pull tab and button go with it)
  sidebar.pane('layers').replaceChildren();
  if (resized) queueMicrotask(frameChanged);
  e.detail.wait?.push(saveStill(t, id, still));   // (the table waits for the save before trashing the scene)
});

// its scene saved, then its still (still: a promise of one, or null when the scene open was another and none was drawn)
async function saveStill(t, id, still) {
  const ok = await t.flush().catch(() => false);
  if (!still) return;
  const blob = await still.catch(() => null);
  if (ok || !t.conflict) await putStill('scene', id, blob);
  refreshStills(['scene']);
}

// ---- things dropped on a 3D frame: into its scene ----
// Image frames and pictures ask how (a background picture or a 3D photo); models, splats, motions and clips go straight in.
addEventListener('table:drop-frame', (e) => {
  const d = e.detail;
  if (d.handled || d.onto.kind !== 'scene' || !d.onto.doc) return;
  const frames = (d.from || []).filter((f) => f.kind === 'image' && f.id !== d.onto.id), srcs = d.sources || [];
  if (!frames.length && !srcs.length) return;
  d.handled = true;
  if (F.mounted && F.mounted !== d.onto.id) { toast('Leave the open 3D frame first', true); return; }
  dropOnScene(d.onto, frames, srcs).catch((err) => toast(`Couldn't add to the scene: ${err.message}`, true));
});

async function dropOnScene(onto, frames, srcs) {
  const items = await sceneItems(srcs);
  const pics = [...frames, ...items.filter((i) => i.kind === 'image').map((i) => ({ src: i.src }))];
  const rest = items.filter((i) => i.kind !== 'image');
  if (rest.length) await landItems(onto, rest);
  if (!pics.length) return;
  const r = document.querySelector(`.frame[data-id="${CSS.escape(onto.id)}"]`)?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : innerHeight / 2;
  const go = (how) => dropInto(onto, pics, how).catch((err) => toast(`Couldn't add to the scene: ${err.message}`, true));
  openPressMenu(x, y, [[
    { label: pics.length > 1 ? 'Background pictures' : 'Background picture', run: () => go('picture') },
    { label: pics.length > 1 ? '3D photos (MoGe, on the card)' : '3D photo (MoGe, on the card)', run: () => go('photo') },
  ]], 'Add to the scene as');
}

// Pictures (table:drop-frame sources) into a 3D frame's scene, as background pictures ('picture') or 3D photos ('photo'),
// without asking which (the quick-start sheet has asked already)
export function addToScene(onto, sources, how) {
  if (F.mounted && F.mounted !== onto.id) return Promise.reject(new Error('Leave the open 3D frame first'));
  return dropInto(onto, [sources].flat().map((src) => ({ src })), how);
}

// a frame's picture into the project's pictures: its still (or the picture it was made from); { src }: a dropped thing's
async function pictureOf(f) {
  if (f.src) {
    const p = await sourcePicture(f.src);
    if (!p) throw new Error('Only a picture can go into a 3D frame this way');
    return p.name;
  }
  const url = stillOf(f) || f.preview;
  if (!url) throw new Error(`"${f.label}" has no picture yet: open it once`);
  const r = await uploadImage(await (await fetch(url)).blob(), { mp: 0, source: 'table', filename: 'frame.png' });
  return r.name;
}

// Into the frame's scene through the engine: live, straight in (its still follows on leaving); else the scene is opened
// off screen (withSceneDoc), changed, saved and drawn as the frame's still.
async function dropInto(onto, pics, how) {
  let n = 0;
  await withSceneDoc(onto, async (m, { live }) => {
    for (const f of pics) {
      try {
        const name = await pictureOf(f);
        if (how === 'photo') await m.makePhoto(name); else await m.addPicture(name);
        n++;
      } catch (err) { toast(err.message, true); }
      if (!live && F.mounted) return false;   // (it went live meanwhile: the rest is the live frame's)
    }
    return n > 0;
  });
  if (n && how === 'picture') toast(n === 1 ? `Added a background picture to "${onto.label}"` : `Added ${n} background pictures to "${onto.label}"`);
}

// fn(m, { live }) runs with a 3D frame's scene open in the engine (m: scene.js): the live frame's as it is; else the
// scene is opened off screen (the 3D tab's TabSet, so its saves keep their rev), and once fn is done it is saved and
// drawn as the frame's still (not when fn returns false: nothing changed). Resolves with what fn returned. The Edit
// pane's 3D ops and pictures dropped on a 3D frame come through here.
// One at a time: the engine has one scene open, so a second job waits for the first (never call it from inside fn).
let queue = Promise.resolve();
export function withSceneDoc(frame, fn) {
  const run = queue.then(() => sceneDocNow(frame, fn));
  queue = run.catch(() => {});
  return run;
}
async function sceneDocNow(frame, fn) {
  if (!frame?.doc) throw new Error('This frame has no scene');
  const m = F.m = await sceneModule(), t = m.sceneTabs();
  const live = F.mounted === frame.id;
  if (!live) {
    if (F.mounted) throw new Error('Leave the open 3D frame first');
    await t.ready();
    for (let k = 0; k < 2 && t.active?.id !== frame.doc; k++) await t.openQuiet(frame.doc);
    if (t.active?.id !== frame.doc) throw new Error('its scene would not open');
    if (F.mounted) throw new Error('another 3D frame opened meanwhile');
    m.show();   // (the engine is built and drawn in the hidden 3D tab)
  }
  const out = await fn(m, { live });
  if (!live && out !== false && !F.mounted && t.active?.id === frame.doc) {
    await (await import('./scene-import.js')).whenLoaded();   // (the models' and splats' files)
    await new Promise((r) => setTimeout(r, 400));   // (the pictures' textures load)
    if (!F.mounted && t.active?.id === frame.doc) {
      const still = m.sceneStill();
      if (!F.mounted) m.hide();
      await saveStill(t, frame.doc, still);
    }
  }
  return out;
}

// ---- what goes into a scene ----
const MOTION_FILE = /\.(npz|bvh|json)$/i;
// Dropped things or a run's outputs as what a scene takes: [{ kind: 'mesh' | 'splat' | 'motion' | 'image' | 'video', ... }]
// (things a scene can't take are told and left out). outputs: a generation ({ id, outputs }: all of them), or a list of
// { generation, index } (a run's output), its output objects ({ url, kind?, filename, generation?, index? }), Files,
// { input } (a picture) or { media, kind } (the media library).
async function sceneItems(outputs) {
  const list = Array.isArray(outputs) ? outputs : outputs?.outputs && outputs.id != null
    ? outputs.outputs.map((o, index) => ({ ...o, generation: outputs.id, index })) : [outputs].filter(Boolean);
  const out = [];
  for (const x of list) {
    let it = null;
    if (x instanceof File) {
      const imp = await import('./scene-import.js');
      const k = imp.isSceneFile(x.name) ? 'mesh' : MOTION_FILE.test(x.name) ? 'motion' : dropKind(x);
      it = k === 'mesh' || k === 'motion' ? { kind: k, file: x, label: x.name.replace(/\.\w+$/, '') }
        : k === 'image' ? { kind: 'image', src: x } : null;
    } else if (x.input) it = { kind: 'image', src: x, name: x.input };
    else if (x.media) {
      const url = x.url || `/files/media/${encodeURIComponent(x.media)}`, label = x.label || x.media;
      it = x.kind === 'image' ? { kind: 'image', src: x } : x.kind === 'audio' ? null : { kind: 'video', src: { media: x.media }, url, label };
    } else if (x.generation != null || x.url) {
      let o = x.url ? x : null;
      const gen = x.generation ?? null, index = x.index || 0;
      if (!o) {
        const g = S.history?.get?.(gen) || await api(`/api/generations/${gen}`, { busy: false });
        o = g?.outputs?.[index];
      }
      if (o) {
        const k = kindOf(o), label = x.label || (gen != null ? `#${gen}` : (o.filename || '').replace(/\.\w+$/, ''));
        const src = gen != null ? { generation: gen, index } : null;
        if (k === 'mesh' || k === 'splat' || k === 'motion') it = { kind: k, url: o.url, label, gen, index, src };
        else if (k === 'image' && src) it = { kind: 'image', src };
        else if (k === 'video' && src) it = { kind: 'video', src, url: o.url, label };
      }
    }
    if (it) out.push(it);
    else toast(`${x.name || x.filename || x.label || 'That'} can't go into a 3D scene`, true);
  }
  return out;
}

// one item into the open scene (m: scene.js): true once it is in
async function putIn(m, it) {
  const imp = await import('./scene-import.js');
  if (it.file && it.kind === 'mesh') return (await imp.importFiles([it.file])) > 0;
  if (it.kind === 'mesh') return !!(await m.addModel(it.url, it.label, { gen: it.gen, index: it.index }));
  if (it.kind === 'splat') return !!(await imp.addSplat(it.url, it.label, { gen: it.gen, index: it.index }));
  if (it.kind === 'motion') {
    if (!it.file && !it.src) throw new Error('That motion is not a run\'s: drop its file instead');
    await figureFor();
    return !!(await m.motionOnto(it.file || it.src, it.label));
  }
  if (it.kind === 'image') { await m.addPicture(it.name || await pictureOf({ src: it.src })); return true; }
  if (it.kind === 'video') { await m.useAsRef({ kind: 'video', src: it.src, url: it.url, label: it.label }); return true; }
  return false;
}
// a motion needs someone to go on: a figure is added when the scene has nobody posable
async function figureFor() {
  const D = await import('./scene-data.js'), V = await import('./scene-view.js');
  if (D.SC.objects.some((o) => o.type === 'figure' || o.type === 'rigged')) return;
  const o = D.newObject('figure', { x: 0, z: 0 });
  D.SC.objects.push(o); D.save(); V.select(o.id);
}

async function landItems(frame, items) {
  let n = 0;
  await withSceneDoc(frame, async (m, { live }) => {
    for (const it of items) {
      try { if (await putIn(m, it)) n++; } catch (err) { toast(err.message, true); }
      if (!live && F.mounted) break;   // (it went live meanwhile: the rest is the live frame's)
    }
    return n > 0;
  });
  return n;
}

// A run's outputs (or dropped things: see sceneItems) into a 3D frame's scene: models, splats, motions (onto a figure,
// one added if there is none), pictures as background pictures and clips as the reference. Opened off screen unless
// the frame is live, saved, and its still drawn again. Resolves with how many went in.
export async function landInScene(frame, outputs) {
  if (frame?.kind !== 'scene' || !frame.doc) throw new Error('That isn\'t a 3D frame');
  const items = await sceneItems(outputs);
  return items.length ? landItems(frame, items) : 0;
}

// A new 3D frame holding a scene payload (a scene-tabs document's), beside `beside` (a frame) or after the last 3D
// frame; its still is drawn. Resolves with the frame (null if not made).
export async function sceneFrameFrom(payload, { label = '', beside = null, select = true } = {}) {
  const Table = await import('./table.js');
  const frames = Table.tableFrames() || [];
  const size = { w: Math.round(payload?.width) || 1024, h: Math.round(payload?.height) || 576 };
  const at = beside ? besideSpot(frames, beside, size) : nextBeside(frames, 'scene', size);
  const f = await Table.newFrameAt('scene', { ...at, ...size }, { payload, extra: label ? { label: String(label).slice(0, 120) } : {}, select });
  if (f) sceneStillSoon(f);
  return f || null;
}

// The Track motion sheet for a clip ({ src, url, label, from?, to? }): Create 3D scene makes a new 3D frame beside
// `frame` (the clip's own frame; default after the last 3D frame). Resolves once the sheet is open.
export async function trackToScene(clip, { frame = null } = {}) {
  const { openTrack } = await import('./track.js');
  return openTrack({ ...clip, frame, onScene: (sc, name) => sceneFrameFrom(sc, { label: name, beside: frame }) });
}

// The 3D Render section's run on a frame's scene, off screen unless it is live: kinds 'depth' | 'pose' | 'colour'
// (default: the Render popup's ticks). Resolves with the generations made ([] when cancelled or failed before any);
// landing them is the caller's.
export async function renderScene(frame, { kinds } = {}) {
  return withSceneDoc(frame, async () => (await import('./scene-ui.js')).renderVideos(kinds));
}
// One picture of a frame's scene at its playhead: 'frame' (lit clay), 'depth' or 'pose', kept in the project's pictures.
// Resolves with it ({ name, width, height }) or null; landing it is the caller's.
export async function sceneImage(frame, kind = 'frame') {
  const r = await withSceneDoc(frame, async () => {
    const E = await import('./scene-export.js');
    return (kind === 'frame' ? await E.saveFrame() : await E.saveStill(kind)) || false;
  });
  return r || null;
}

// Its still drawn again soon (off screen; a live frame's is drawn as it closes). Resolves true once drawn.
export function sceneStillSoon(frame) {
  if (!frame?.doc || F.mounted === frame.id) return Promise.resolve(false);
  return withSceneDoc(frame, async () => true).then(() => true, () => false);
}

// ---- the open 3D frame's Render and Save frame output ----
// fn(frame, { gens } | { picture, kind }) gets what the live frame's panel made: the videos of one Render, or a Save
// frame / depth / pose picture (kind 'frame' | 'depth' | 'pose'). Returns a function that stops it.
const OUTS = new Set();
export function onSceneOut(fn) { OUTS.add(fn); return () => OUTS.delete(fn); }
function tell(frame, out) {
  for (const fn of OUTS) { try { fn(frame, out); } catch (err) { console.error(err); } }
}

// ---- the Frame pane's 3D section: size, length, frame rate, what Render makes ----
sidebar.addTo('frame', (el) => {
  const sel = selectedFrames() || [], f = sel.length === 1 ? sel[0] : null;
  const had = el.querySelector(':scope > .frame-scene-props');
  if (had && had.dataset.frame === (f?.kind === 'scene' && f.doc ? f.id : '')) return;   // (already there: its own insert calls this again)
  had?.remove();
  if (!f || f.kind !== 'scene' || !f.doc) return;
  const body = h('div', { class: 'frame-scene-body' }, h('span', { class: 'hint' }, 'Loading…'));
  const sec = section('3D scene', null, body);
  sec.classList.add('frame-scene-props'); sec.dataset.frame = f.id;
  el.append(sec);
  fillSceneSection(f, body).catch((e) => body.replaceChildren(h('span', { class: 'hint' }, `Couldn't read the scene: ${e.message}`)));
});

async function fillSceneSection(f, body) {
  const [D, ui] = await Promise.all([import('./scene-data.js'), import('./scene-ui.js')]);
  const live = () => F.mounted === f.id;
  const p = live() ? { seconds: D.SC.seconds } : (await api(`/api/store/scene-tabs/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false }))?.payload || {};
  let secs = Number(p.seconds) || 5;
  const sizeKey = `${f.w}x${f.h}`;
  const kinds = new Set(ui.renderKinds());
  body.replaceChildren(
    field('Size', chips(D.SIZES.map((s) => [s.join('x'), s.join('×')]), sizeKey, (v) => setSceneFrameSize(f, ...v.split('x').map(Number))),
      help('The frame\'s size is the scene\'s picture: renders are this size. Any other size: Size and MP… above.')),
    rangeField('Length', () => secs, (v) => { secs = v; }, { min: ui.LENGTHS[0], max: ui.LENGTHS[1], step: 0.5,
      fmt: (v) => `${+Number(v).toFixed(2)} s · ${D.framesFor(v)} frames`,
      onChange: () => withSceneDoc(f, async () => { ui.newLength(secs); }).catch((e) => toast(e.message, true)) }),
    hint(`${D.FPS} fps (a 3D scene's frame rate is fixed)`),
    field('Render makes', h('div', { class: 'row wrap' }, ...ui.RENDER_KINDS.map(([id, label]) => toggle(label, kinds.has(id), (on) => {
      if (on) kinds.add(id); else kinds.delete(id);
      ui.setRenderKinds([...kinds]);
    }))), help('The videos Render… makes of the scene, one after another: depth, pose (the posable people) and colour.')));
}

// a 3D frame's size: the frame on the table, and its scene's picture (the open one at once, else its saved document)
async function setSceneFrameSize(f, w, hh) {
  if (!w || !hh) return;
  f.w = w; f.h = hh; frameChanged();
  try {
    if (F.mounted === f.id) { F.m.setSceneSize(w, hh); F.size = F.m.sceneSize(); }
    else await editDoc('scene', f.doc, (p) => { if (p.width === w && p.height === hh) return false; p.width = w; p.height = hh; });
  } catch (e) { toast(e.message, true); }
}
