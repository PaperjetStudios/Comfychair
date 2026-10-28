import { SC } from './scene-data.js';

// The 3D panel's modes: Edit scene, Camera, Create object. A mode says what the stage shows, what can
// be picked and which panel is on show; scene-builtin.js registers the three, and anything that comes
// later (camera presets, modelling tools) registers a mode or plugs a section into one from its own
// file, without touching the core. The tab remembers its mode as SC.mode.
//
//   registerMode({ key, label, icon, hint, panel, select, stage, view, lanes, frustum, enter, exit })
//     key      'edit' | 'camera' | 'create' | a new one; icon: its button on the 3D view (label / hint: its tooltip)
//     panel()  the nodes of the panel; out() the ones after the plug-in sections (what it makes: render, prompt)
//     select   objects can be picked on the stage and in the list (default true)
//     stage    'scene' shows the scene, 'empty' an empty modelling stage (default 'scene')
//     view     'shot' looks through the shot camera (orbiting writes its keys), 'free' is a free view
//     lanes    the key sheet: 'all' | 'camera' (the camera's row only) | 'none' (hidden)
//     frustum  in the free view, draw the shot camera as a frustum (default false)
//     enter() / exit()   run when the mode comes on show / goes
//   addModeSection(key, build)   build() returns nodes added at the end of that mode's panel
const REG = new Map(), PLUGS = new Map();

export function registerMode(def) {
  REG.set(def.key, { icon: '•', select: true, stage: 'scene', view: 'shot', lanes: 'all', frustum: false, panel: () => null, ...def });
}
export function addModeSection(key, build) {
  if (!PLUGS.has(key)) PLUGS.set(key, []);
  PLUGS.get(key).push(build);
}
export const modeDef = (key) => REG.get(key) || null;
export const hasMode = (key) => REG.has(key);
export const modeList = () => [...REG.values()];
// the tab's mode (a name nothing registered falls back to Edit scene)
export const modeOf = () => REG.get(SC.mode) || REG.get('edit');
export const modeSections = (key) => PLUGS.get(key) || [];

