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
  C, R, SC, defaultScene, frames, hooks, resetHistory, setC, setSC, upgrade
} from './scene-data.js';
import { buildToolbar, renderToolbar, showAll, syncMode, wireKeys } from './scene-ui.js';
import { setup } from './scene-view.js';
import { stopPlay } from './scene-export.js';
import { registerBuiltins } from './scene-builtin.js';
import { registerCamera } from './scene-camera.js';
export { addModeSection, registerMode } from './scene-modes.js';
export { addPhoto } from './scene-view.js';

registerCamera();     // camera moves (a section of Camera mode)
registerBuiltins();   // (the dependencies have run by now; a mode registered later goes after them)

// ---- tabs: each 3D scene is a document in the project folder ----
let ready = false, tabs = null, tabsReady = null;
const ensureTabs = () => tabsReady || (tabsReady = tabs ? tabs.start() : Promise.resolve());

// What this device kept before scenes became tabs (localStorage): moved into the first tab once (the key stays)
function legacyScene() {
  const sc = store.get(`deck.scene.${C.S.project ?? 'none'}`, null);
  return sc && sc.v === 1 ? upgrade(sc) : null;
}

// What a tab holds: the scene itself (and its mode). The undo list is not kept: a switch starts it afresh.
const sceneAdapter = {
  empty: defaultScene,
  migrate: (p) => (p.v === 1 && Array.isArray(p.objects) ? upgrade(p) : defaultScene()),
  dump: () => SC,
  load(p) {
    stopPlay();
    setSC(p); R.sel = null; R.joint = null; R.f = Math.min(R.f, frames() - 1);
    R.lastRender = null; R.renders = {};
    resetHistory(); syncMode();
    if (ready) showAll();
  },
};

function boot() {
  if (ready) return;
  setup(); buildToolbar(); wireKeys();
  ready = true;
}

// ---- entry points (called from app.js) ------------------------------------------------
export function init(helpers) {
  setC(helpers); R.autoKey = store.get('deck.scene.autokey', true) !== false;
  R.figTab = store.get('deck.scene.figtab', 'pose'); R.poseCat = store.get('deck.scene.posecat', 'stand');
  setSC(defaultScene());   // what shows until the tab opens
  hooks.ready = async () => { boot(); await ensureTabs(); };
  hooks.persist = () => tabs?.changed(); hooks.history = renderToolbar; hooks.tab = () => tabs?.active?.id ?? null;
  const mount = h('div', { class: 'scene-tabs' });
  $('#scenePanel').replaceChildren(h('div', { class: 'scene-head' }, h('div', { id: 'sceneModes', class: 'scene-modes' }), mount), h('div', { id: 'sceneBody' }));
  tabs = new TabSet({ kind: 'scene-tabs', mount, scope: 'project', newName: (n) => `Scene ${n}`, adapter: sceneAdapter, seed: legacyScene });
}

export function show() {
  boot();
  showAll();
  ensureTabs();
}

export function hide() { if (ready) { stopPlay(); tabs?.flush(); } }

// a new project has its own scenes (the tabs reload themselves)
export function projectChanged() {
  if (ready) stopPlay();
}

// open the scene saved with a "3d scene" generation, in a tab of its own
export async function open(scene, from = null) {
  if (!scene || scene.v !== 1) return toast('That scene is from another version', true);
  boot(); await ensureTabs();
  if (!tabs.active || !(await tabs.leave())) return;
  try {
    const name = from ? `Scene from #${from}` : tabs.freeName((n) => `Scene ${n}`);
    tabs.open(await tabs.create1({ name, payload: upgrade(clone(scene)), order: tabs.active.order + 0.5 }));
  } catch (e) { toast(e.message, true); }
}

