// 3D tab: block out a shot (soft mannequins, boxes, a room, a camera move) and render it as a depth
// video for H3's Fun ControlNet (deck-h3-ctrl2v). Near is white and far is black, like Depth
// Anything, and the range is fixed over the whole clip so the depth doesn't flicker.
// It works like the Editor: a layer list (Camera, Room, objects), the selected layer's settings under
// it, and a gizmo on the selected object (Move / Rotate / Scale; tap it again to switch). The view is
// the shot camera. Anything with keyframes is animated, and changing it writes a key at the playhead.
// This file is the entry (app.js, run.js): the tabs and the glue. The pieces are scene-data.js (the
// scene and its undo), scene-view.js (three.js, the gizmo, photos), scene-export.js (playback and
// renders), scene-ui.js and scene-pose.js (the panel), scene-modes.js (the three modes).
import { TabSet } from './tabs.js';
import { $, clone, h, store, toast } from './ui.js';
import {
  C, R, SC, defaultScene, dropHolds, frames, hooks, rebaseHistory, resetHistory, save, setC, setSC, upgrade
} from './scene-data.js';
import { buildToolbar, renderKeys, renderPanel, renderToolbar, showAll, syncHud, syncMode, wireKeys } from './scene-ui.js';
import { loadPlaySettings, syncMaxBar } from './scene-keys.js';
import { SCN, fit, setup } from './scene-view.js';
import { initScale } from './scene-scale.js';
import { stopPlay } from './scene-export.js';
import { registerBuiltins } from './scene-builtin.js';
import { initModel } from './scene-model.js';
import { registerCamera } from './scene-camera.js';
import { registerImport } from './scene-import.js';
import { setBoneDrag, setBonePick } from './scene-view.js';
import { onBoneDrag, onBoneDragEnd, onBonePick } from './scene-skin.js';
import { registerRef } from './scene-ref.js';
import './scene-track.js';   // the footage and track-point layers a motion track makes
import './scene-picture.js';   // a picture as the scene's background
export { addModeSection, registerMode } from './scene-modes.js';
export { addPhoto, makePhoto } from './scene-view.js';
export { addModel, openObjectSheet } from './scene-import.js';
export { useAsRef } from './scene-ref.js';
export { motionOnto } from './scene-motion.js';
export { sceneStill } from './scene-export.js';
export { dropFull } from './scene-keys.js';
export { addPicture } from './scene-picture.js';

// The page's 3D tab: where the engine's elements live when no frame has them (index.html). The body is made here.
const PAGE = { host: $('#tab-scene'), viewer: $('#sceneViewer'), canvas: $('#sceneCanvas'), transport: $('#sceneTransport'),
  panel: $('#scenePanel'), body: h('div', { id: 'sceneBody' }) };
PAGE.active = () => PAGE.host.classList.contains('active');
PAGE.panel.replaceChildren(PAGE.body);
Object.assign(SCN, PAGE);

registerCamera();     // camera moves (a section of Camera mode)
registerBuiltins();   // (the dependencies have run by now; a mode registered later goes after them)
initModel();          // Create object's tools replace the placeholder panel
registerImport({ newTab });  // models, splats and starter scenes (scene-import.js)
setBonePick(onBonePick);    // a skinned model's bone dots are picked in the view (scene-view.js)
setBoneDrag({ move: onBoneDrag, end: onBoneDragEnd });   // ...and dragged: the chain reaches (ik.js)
registerRef();        // a reference picture or clip over the view (Edit scene and Camera)

// ---- tabs: each 3D scene is a document in the project folder ----
let ready = false, tabs = null;
const ensureTabs = () => tabs.ready();

// What this device kept before scenes became tabs (localStorage): moved into the first tab once (the key stays)
function legacyScene() {
  const sc = store.get(`deck.scene.${C.S.project ?? 'none'}`, null);
  return sc && sc.v === 1 ? upgrade(sc) : null;
}

// What a tab holds: the scene itself (and its mode). The undo list is not kept: a switch to another starts it afresh;
// the same scene opened again by this page (a frame let go and opened again) keeps its steps, as video and sound do.
let histDoc;   // the scene the undo list is about
const sceneAdapter = {
  empty: defaultScene,
  migrate: (p) => (p.v === 1 && Array.isArray(p.objects) ? upgrade(p) : defaultScene()),
  dump: () => SC,
  load(p, doc, { remote = false } = {}) {
    stopPlay(); dropHolds();
    setSC(p); R.sel = null; R.joint = null; R.f = Math.min(R.f, frames() - 1);
    R.lastRender = null; R.renders = {};
    const id = doc?.id ?? null, same = !remote && histDoc !== undefined && id != null && id === histDoc;   // (saved elsewhere: a fresh list)
    histDoc = id;
    if (same) rebaseHistory(); else resetHistory();
    syncMode();
    if (ready) showAll();
  },
};

function boot() {
  if (ready) return;
  setup(); buildToolbar(); initScale(); wireKeys();
  ready = true;
}

// ---- entry points (called from app.js) ------------------------------------------------
export function init(helpers) {
  setC(helpers); R.autoKey = store.get('deck.scene.autokey', true) !== false; loadPlaySettings();
  R.figTab = store.get('deck.scene.figtab', 'pose'); R.poseCat = store.get('deck.scene.posecat', 'stand');
  setSC(defaultScene());   // what shows until the tab opens
  hooks.ready = async () => { boot(); await ensureTabs(); };
  hooks.persist = () => tabs?.changed(); hooks.history = renderToolbar; hooks.tab = () => tabs?.active?.id ?? null; hooks.held = renderKeys;
  tabs = new TabSet({ kind: 'scene-tabs', host: $('#tab-scene'), scope: 'project', newName: (n) => `Scene ${n}`, adapter: sceneAdapter, seed: legacyScene });
}

export function show() {
  boot();
  showAll();
  ensureTabs().catch(() => {});
}

export function hide() { if (ready) { stopPlay(); tabs?.flush(); } }

// the open scenes (tabs.js), for a 3D frame to switch to its own (the engine is built first: opening a scene draws it)
export const sceneTabs = () => { boot(); return tabs; };
// the open scene's picture size, as a 3D frame's size on the table asks (in steps of 16, as the size menu has them).
// true when it changed (and is saved).
export function setSceneSize(w, hh) {
  const W = Math.max(64, Math.round(w / 16) * 16), H = Math.max(64, Math.round(hh / 16) * 16);
  if (!w || !hh || (SC.width === W && SC.height === H)) return false;
  SC.width = W; SC.height = H;
  save();
  if (ready) { fit(); renderPanel(); }
  return true;
}
export const sceneSize = () => ({ w: SC.width, h: SC.height });
// does the open scene have anything in it (a frame's drop asks before it draws a still)
export const sceneHasContent = () => !!(SC.objects.length || SC.room);

// ---- where it shows: the 3D tab, or a frame on a table ----------------------------------------------------------
// Mount the engine into a host (a 3D frame's root). It has one WebGL context bound to its canvas, so the elements move:
// the viewer (canvas, bars, overlays) takes the place of `viewer` (a slot in host's .stage), the key bar and sheet take
// the place of `transport`, and the panel's body goes into `panel` (the sidebar's pane). active(): is it on show (the
// keys ask). Each host has its own full screen (scene-keys.js maxBar). unmountScene() puts them all back in the 3D tab;
// mounting the tab's own host does the same.
let away = null;   // while mounted elsewhere: [[element, its slot in the host (none for the body), its mark in the page]]
export function mountScene({ host, viewer, transport, panel, active = () => host.classList.contains('active') }) {
  boot();
  if (host === PAGE.host) return unmountScene();
  if (SCN.host === host) return;
  unmountScene();
  const move = (el, slot) => {
    const mark = document.createComment('the 3D engine is in a frame');
    el.before(mark);
    if (slot) slot.replaceWith(el); else panel.replaceChildren(el);
    return [el, slot, mark];
  };
  stopPlay();
  const was = SCN.host;
  away = [move(PAGE.viewer, viewer), move(PAGE.transport, transport), move(PAGE.body, null)];
  Object.assign(SCN, { host, panel, active });
  host.classList.add('scene-host');
  moved(was);
}
export function unmountScene() {
  if (!away) return;
  stopPlay();
  const was = SCN.host;
  for (const [el, slot, mark] of away) {
    if (slot) el.replaceWith(slot);   // (the host gets its slot back, should it mount again)
    mark.replaceWith(el);
  }
  away = null;
  was?.classList.remove('scene-host');
  Object.assign(SCN, PAGE);
  moved(was);
}
// after a move: the full screen, the HUD and the canvas's size follow the host (the viewer's ResizeObserver refits too)
function moved(was) {
  syncMaxBar(was); syncHud(was);
  fit();
}

// a new project has its own scenes (the tabs reload themselves)
export function projectChanged() {
  if (ready) stopPlay();
}

// a new tab holding a copy of this scene (from a template)
async function newTab(payload, name) {
  boot(); await ensureTabs();
  if (!tabs.active || !(await tabs.leave())) return;
  const taken = new Set(tabs.docs.map((d) => d.name));
  let nm = name;
  for (let i = 2; taken.has(nm); i++) nm = `${name} ${i}`;
  try { tabs.open(await tabs.create1({ name: nm, payload: upgrade(clone(payload)), order: tabs.active.order + 0.5 })); } catch (e) { toast(e.message, true); }
}

// open the scene saved with a "3d scene" generation, in a tab of its own
export async function open(scene, from = null, name = null) {
  if (!scene || scene.v !== 1) return toast('That scene is from another version', true);
  boot(); await ensureTabs();
  if (!tabs.active || !(await tabs.leave())) return;
  try {
    name ||= from ? `Scene from #${from}` : tabs.freeName((n) => `Scene ${n}`);
    tabs.open(await tabs.create1({ name, payload: upgrade(clone(scene)), order: tabs.active.order + 0.5 }));
  } catch (e) { toast(e.message, true); }
}
