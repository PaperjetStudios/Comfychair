// 3D frames on the table: going live mounts the 3D engine (scene.js mountScene) in the frame at 1:1: its viewer and
// key sheet move into the frame and its panel into the sidebar's pane. There is one engine and one WebGL context, so
// the elements move between the page's 3D tab and the frame; coming back draws the still (the shot camera's view),
// saves and puts them back. The frame's document is a scene (scene-tabs), opened through the 3D tab's one TabSet.
// Image frames dropped on a 3D frame go into its scene as a background picture or a 3D photo; so do pictures dropped on
// it from the Shelf or a picker (table:drop-frame sources).
//
// table.js's events (detail.handled = true when taken here): table:live, table:unlive, table:resize, table:drop-frame.
import { h, toast } from './ui.js';
import { isLive } from './live.js';
import { uploadImage } from './media.js';
import { sceneModule } from './run.js';
import { sidebar } from './sidebar.js';
import { putStill, sourcePicture, stillOf } from './table-frames.js';
import { frameChanged, refreshStills } from './table.js';
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
    for (let k = 0; k < 2 && t.active?.id !== frame.doc; k++) {   // (switchTo gives up quietly when it is raced)
      await t.switchTo(frame.doc);
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
  const { frame } = e.detail;
  if (frame.kind !== 'scene') return;
  F.seq++;
  if (F.mounted !== frame.id) return;
  e.detail.handled = true;
  F.mounted = null;
  const m = F.m, t = m.sceneTabs(), id = frame.doc;
  // the size changed in the panel while open: the frame takes it
  const s = m.sceneSize(), resized = F.size && (s.w !== F.size.w || s.h !== F.size.h);
  if (resized) Object.assign(frame, { w: s.w, h: s.h });
  const still = t.active?.id === id ? m.sceneStill() : null;   // (drawn and read now, before the engine moves)
  m.hide();
  m.unmountScene();
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

// ---- image frames dropped on a 3D frame: into its scene ----
addEventListener('table:drop-frame', (e) => {
  const d = e.detail;
  if (d.handled || d.onto.kind !== 'scene' || !d.onto.doc) return;
  const pics = [...(d.from || []).filter((f) => f.kind === 'image' && f.id !== d.onto.id), ...(d.sources || []).map((src) => ({ src }))];
  if (!pics.length) return;
  d.handled = true;
  if (F.mounted && F.mounted !== d.onto.id) { toast('Leave the open 3D frame first', true); return; }
  const r = document.querySelector(`.frame[data-id="${CSS.escape(d.onto.id)}"]`)?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : innerHeight / 2;
  const go = (how) => dropInto(d.onto, pics, how).catch((err) => toast(`Couldn't add to the scene: ${err.message}`, true));
  openPressMenu(x, y, [[
    { label: pics.length > 1 ? 'Background pictures' : 'Background picture', run: () => go('picture') },
    { label: pics.length > 1 ? '3D photos (MoGe, on the card)' : '3D photo (MoGe, on the card)', run: () => go('photo') },
  ]], 'Add to the scene as');
});

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
// off screen (the 3D tab's TabSet, so its saves keep their rev), changed, saved and drawn as the frame's still.
async function dropInto(onto, pics, how) {
  const m = F.m = await sceneModule(), t = m.sceneTabs();
  const live = F.mounted === onto.id;
  if (!live) {
    await t.ready();
    for (let k = 0; k < 2 && t.active?.id !== onto.doc; k++) await t.switchTo(onto.doc);
    if (t.active?.id !== onto.doc) throw new Error('its scene would not open');
    if (F.mounted) throw new Error('another 3D frame opened meanwhile');
    m.show();   // (the engine is built and drawn in the hidden 3D tab)
  }
  let n = 0;
  for (const f of pics) {
    try {
      const name = await pictureOf(f);
      if (how === 'photo') await m.makePhoto(name); else await m.addPicture(name);
      n++;
    } catch (err) { toast(err.message, true); }
    if (!live && F.mounted) return;   // (it went live meanwhile: the rest is the live frame's)
  }
  if (!n) return;
  if (!live && !F.mounted && t.active?.id === onto.doc) {
    await new Promise((r) => setTimeout(r, 400));   // (the pictures' textures load)
    if (!F.mounted && t.active?.id === onto.doc) {
      const still = m.sceneStill();
      if (!F.mounted) m.hide();
      await saveStill(t, onto.doc, still);
    }
  }
  if (how === 'picture') toast(n === 1 ? `Added a background picture to "${onto.label}"` : `Added ${n} background pictures to "${onto.label}"`);
}
