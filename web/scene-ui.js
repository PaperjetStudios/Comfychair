import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import {
  $, button, clone, closeSheet, field, h, iconBtn, layerRowsEl, openSheet, panelTop, propNum, rangeField,
  section, seg, sheetOpen, store, uid, undoToast, help
} from './ui.js';
import {
  C, CAM, EVEN, HIST, MODES, R, ROOM, SC, SIZES, TEMP, TYPES, current, defaultScene, frames, hooks, keyTarget,
  namesFor, pivotOf, pivotsFor, sameTab, save, selItem, setSC, write
} from './scene-data.js';
import { FIG_TABS, adjustTab, jointsTab, movesTab, partsTab, posesTab, promptProps } from './scene-pose.js';
import {
  addObject, camGizmo, cameraFromView, changed, draw, fit, jointMode, lookThrough, makePhoto, pose, rebuildRoom, refresh,
  removeSelected, select, selectJoint, setFree, setMode, syncMeshes, viewer
} from './scene-view.js';
import { busy, play, renderDepthVideo, renderPoseVideo, saveFrame, seek, stopPlay } from './scene-export.js';
import { maxBar, renderKeys, renderTransport, wireSheetKeys } from './scene-keys.js';
import { hasMode, modeDef, modeList, modeOf, modeSections } from './scene-modes.js';

// ---- UI ----------------------------------------------------------------------
let statusText = '';
export function setStatus(t) { statusText = t; const s = $('#sceneStatus'); if (s) s.textContent = t; }

export function renderToolbar() {
  const tb = $('#sceneToolbar');
  if (!tb) return;
  const cam = camGizmo(), can = !!selItem() || cam;   // (the director view's camera has Move and Rotate)
  // a joint turns (Rotate); a hand or foot can also be dragged (Move, with IK)
  const ok = (m) => can && !(cam && m === 'scale') && (!R.joint || m === 'rotate' || (m === 'translate' && !!FIGURE.IK[R.joint]));
  const mode = R.joint ? jointMode() : R.mode;
  tb.querySelectorAll('[data-mode]').forEach((b) => { b.classList.toggle('on', ok(b.dataset.mode) && b.dataset.mode === mode); b.disabled = !ok(b.dataset.mode); });
  tb.querySelector('[data-depth]').classList.toggle('on', R.depth);
  tb.querySelector('[data-undo]').disabled = !HIST.undo.length;
  tb.querySelector('[data-redo]').disabled = !HIST.redo.length;
}

// the key sheet (dope sheet, graph, selection and key edits) is scene-keys.js
export { renderKeys, renderTime, renderTransport } from './scene-keys.js';

// a slider: the view follows while dragging, the change is saved on letting go
export const slider = (label, get, set, opts) => rangeField(label, get, set,
  { ...opts, onInput: () => { pose(R.f); draw(); }, onChange: () => { save(); renderKeys(); } });
// a number box (drag it sideways like a slider: the view follows, the change is saved on letting go)
const num = (label, get, set, opts = {}) => propNum(label, +Number(get()).toFixed(opts.digits ?? 2), set,
  () => { if (opts.after) opts.after(); changed(); },
  { step: 'any', live: () => { if (opts.after) opts.after(); syncMeshes(); pose(R.f); draw(); }, ...opts });
const easeSeg = (item) => field('Between keys', seg([['smooth', 'Ease'], ['linear', 'Linear']], item.ease, (v) => { item.ease = v; changed(); }));
const clearKeys = (item, names) => (item.keys.length ? button('Clear keys', () => { Object.assign(item.base, current(item, names)); item.keys = []; changed(); }) : null);

function objectProps(o) {
  const names = namesFor(o);
  const cur = () => current(o, names);
  if (o.type !== 'figure') return section(TYPES[o.type].label, () => select(null), placeProps(o, cur));
  // a figure: its pose tools in tabs, big enough for fingers
  const tab = FIG_TABS.some(([k]) => k === R.figTab) ? R.figTab : 'pose';
  return section(o.name, () => select(null),
    seg(FIG_TABS, tab, (v) => { R.figTab = v; store.set('deck.scene.figtab', v); renderPanel(); }, { wrap: true }),
    { pose: posesTab, adjust: adjustTab, move: movesTab, joint: jointsTab, parts: partsTab, place: placeProps }[tab](o, cur));
}

// where it is, how big, its pivot; duplicate and delete
function placeProps(o, cur) {
  const names = namesFor(o);
  const set = (k) => (v) => write(o, names, { [k]: v });
  const even = (v) => write(o, names, { sx: v, sy: v, sz: v });
  const name = h('input', { type: 'text', value: o.name });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(); });
  const xyz = (label, ks, opts) => field(label,
    h('div', { class: 'row' }, ...ks.map(([k, l, o2]) => num(l, () => cur()[k], set(k), { ...opts, ...o2 }))));
  return [
    field('Name', name),
    xyz('Position (m)', [['x', 'X'], ['y', 'Up', { min: -5, max: 10 }], ['z', 'Z']], { min: -20, max: 20 }),
    xyz('Rotation (°)', [['rx', 'X'], ['ry', 'Y'], ['rz', 'Z']], { digits: 0, min: -180, max: 180, step: 1 }),
    o.type === 'figure' ? num('Height (m)', () => cur().sy * FIGURE.HEIGHT, (v) => even(Math.max(0.3, v) / FIGURE.HEIGHT), { min: 0.3, max: 2.5 })
      : EVEN.has(o.type) ? num('Scale', () => cur().sy, (v) => even(Math.max(0.05, v)), { min: 0.05, max: 20 })
      : xyz('Size (m)', [['sx', 'Width'], ['sy', 'Height'], ['sz', 'Depth']], { min: 0.05, max: 20 }),
    field('Pivot (where the gizmo turns it)', seg(pivotsFor(o), pivotsFor(o).some(([k]) => k === pivotOf(o)) ? pivotOf(o) : null,
      (v) => { o.pivot = v; changed(); }, { wrap: true })),
    o.type === 'figure' ? [
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!o.ground,
        onchange: (e) => { o.ground = e.target.checked; changed(); } }), 'Planted on the floor (Up lifts it off)'),
      button('🎥 Face the camera', () => {
        const v = cur(), c = current(SC.camera, CAM);
        write(o, names, { ry: Math.round(THREE.MathUtils.radToDeg(Math.atan2(c.px - v.x, c.pz - v.z))) }); changed();
      })] : null,
    o.type === 'photo' ? [
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      help('The picture as a 3D mesh (MoGe). Keep camera moves small: nothing is behind what the picture shows. Render depth video, then use it with this picture as a reference.')] : null,
    easeSeg(o),
    h('div', { class: 'row wrap' },
      button('Duplicate', () => {
        const c = { ...clone(o), id: uid(), name: `${o.name} copy` };
        c.base.x += 0.6; c.keys.forEach((k) => { if (k.x != null) k.x += 0.6; });
        SC.objects.push(c); save(); select(c.id);
      }),
      clearKeys(o, names),
      button('Delete', removeSelected, { cls: 'small danger' })),
    help('Drag the gizmo to move it; tap the object again (or W / E / R) for Rotate and Scale. With keys, a change sets a key at the playhead; with Auto key off it is held until ◆ Key (or until the playhead moves).')];
}

export function setAutoKey(on) {
  R.autoKey = on; store.set('deck.scene.autokey', on);
  const b = $('#sceneAutoKey');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
}

function layerList() {
  const keys = (it) => (it.keys.length ? `${it.keys.length} key${it.keys.length > 1 ? 's' : ''}` : '');
  const hideBtn = (it, after) => iconBtn(it.hidden ? 'Show' : 'Hide', it.hidden ? '◌' : '◉', () => { it.hidden = !it.hidden; after(); });
  const rows = [{ sel: !R.sel, thumb: h('span', { class: 'scene-icon' }, '🎥'), name: 'Camera',
    hint: [`${SC.width}×${SC.height} · ${SC.seconds} s`, keys(SC.camera)].filter(Boolean).join(' · '), onclick: () => select(null) }];
  if (SC.room) {
    rows.push({ sel: R.sel === ROOM, off: SC.room.hidden, thumb: h('span', { class: 'scene-icon' }, '⌂'), name: 'Room',
      hint: `${SC.room.w}×${SC.room.d} m${SC.room.hidden ? ' · hidden' : ''}`, onclick: () => select(R.sel === ROOM ? null : ROOM),
      buttons: [hideBtn(SC.room, changed)] });
  }
  for (const o of [...SC.objects].reverse()) {
    rows.push({ sel: o.id === R.sel, off: o.hidden, thumb: h('span', { class: 'scene-icon' }, TYPES[o.type].icon), name: o.name,
      hint: [TYPES[o.type].label, keys(o), o.hidden ? 'hidden' : ''].filter(Boolean).join(' · '),
      onclick: () => select(o.id === R.sel ? null : o.id), buttons: [hideBtn(o, changed)] });
  }
  return layerRowsEl(rows);
}

function roomProps() {
  const rm = SC.room;
  const re = () => rebuildRoom();
  return section('Room', () => select(null),
    h('div', { class: 'row' },
      num('Width (m)', () => rm.w, (v) => { rm.w = Math.max(1, v); }, { min: 1, max: 40, after: re }),
      num('Depth (m)', () => rm.d, (v) => { rm.d = Math.max(1, v); }, { min: 1, max: 40, after: re }),
      num('Height (m)', () => rm.h, (v) => { rm.h = Math.max(1, v); }, { min: 1, max: 10, after: re })),
    field('Shape', seg([['room', 'Walls + ceiling'], ['walls', 'Walls'], ['floor', 'Floor only']], rm.walls ? (rm.ceiling ? 'room' : 'walls') : 'floor',
      (v) => { rm.walls = v !== 'floor'; rm.ceiling = v === 'room'; rebuildRoom(); changed(); })),
    help('Keep the walls about where the real ones should be: H3 sizes the room from them. Hide it (◉) for an open space.'),
    button('Delete room', removeSelected, { cls: 'small danger' }));
}

function cameraProps() {
  const cam = SC.camera;
  const mm = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);  // full-frame equivalent, from the vertical angle
  const sizeSel = h('select', {}, ...SIZES.map(([w, hh]) => h('option', { value: `${w}x${hh}` }, `${w}×${hh}`)));
  sizeSel.value = `${SC.width}x${SC.height}`;
  if (sizeSel.value !== `${SC.width}x${SC.height}`) sizeSel.append(h('option', { value: `${SC.width}x${SC.height}`, selected: true }, `${SC.width}×${SC.height}`));
  sizeSel.addEventListener('change', () => { [SC.width, SC.height] = sizeSel.value.split('x').map(Number); save(); fit(); renderPanel(); });
  const secs = num(`Length (s) · ${frames()} frames`, () => SC.seconds, (v) => {
    SC.seconds = Math.max(2, Math.min(15, Math.round(v || 6)));
    const n = frames();
    for (const it of [SC.camera, ...SC.objects]) it.keys = it.keys.filter((k) => k.f < n);
    R.f = Math.min(R.f, n - 1);
  }, { min: 2, max: 15, step: 1, digits: 0, after: () => renderTransport(), live: null });
  return section('Camera', null,
    h('div', { class: 'row' }, field('Size', sizeSel), secs),
    slider('Lens', () => current(cam, CAM).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm` }),
    slider('Camera height', () => current(cam, CAM).py, (v) => write(cam, CAM, { py: v }),
      { min: 0.1, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    easeSeg(cam),
    h('div', { class: 'row wrap' },
      clearKeys(cam, CAM),
      button('Reset view', () => { write(cam, CAM, { ...defaultScene().camera.base }); changed(); })),
    help('The view is the camera: drag empty space to orbit, two fingers to pan and zoom. With keys and Auto key on, each move sets a key at the playhead; with Auto key off it is only a look around until ◆ Key.'));
}

function renderProps() {
  const figs = SC.objects.some((o) => o.type === 'figure' && !o.hidden);
  const use = (g, what) => button(`Use ${what} #${g.id} in H3 control`, () => C.useControlVideo(g, SC));
  return section('Render', null,
    slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
    help('Blurs the depth so H3 copies the shapes less literally. Use with deck-h3-ctrl2v (strength 1, end 0.4).'),
    h('div', { class: 'row wrap' },
      button('Render depth video', renderDepthVideo, { cls: 'small primary', disabled: busy }),
      figs ? button('Render pose video', renderPoseVideo, { disabled: busy, title: 'The posable people as OpenPose stick figures' }) : null,
      figs ? button('Render both', async () => { await renderDepthVideo(); await renderPoseVideo(); }, { disabled: busy, title: 'A depth video and a pose video of the same shot' }) : null,
      button('📷 Save frame', saveFrame)),
    R.renders.depth || R.renders.pose ? h('div', { class: 'row wrap' },
      R.renders.depth ? use(R.renders.depth, 'depth') : null, R.renders.pose ? use(R.renders.pose, 'pose') : null) : null,
    h('p', { id: 'sceneStatus', class: 'hint' }, statusText));
}

function openAdd() {
  const chip = (label, fn, title) => h('button', { type: 'button', class: 'chip', title, onclick: fn }, label);
  openSheet(h('h3', {}, 'Add to the scene'),
    h('div', { class: 'chips' }, ...Object.entries(TYPES).filter(([t, d]) => !['photo', 'model', 'splat'].includes(t) && !d.hide).map(([t, d]) => chip(`${d.icon} ${d.label}`, () => addObject(t))),
      SC.room ? null : chip('⌂ Room', () => addObject(ROOM)),
      chip('🖼 Photo in 3D…', () => {
        closeSheet(); C.openImagePicker({ title: 'Picture to turn into 3D', onPick: (name) => makePhoto(name) });
      }, 'Turn a picture into a 3D mesh (MoGe in ComfyUI) for camera moves')));
}

// ---- history, modes -----------------------------------------------------------------------
function undo(back = true) {
  const [from, to] = back ? [HIST.undo, HIST.redo] : [HIST.redo, HIST.undo];
  if (!from.length) return;
  stopPlay();
  const mode = SC.mode;
  to.push(HIST.cur); HIST.cur = from.pop();
  setSC(JSON.parse(HIST.cur)); SC.mode = mode; TEMP.clear(); R.joint = null;
  if (R.sel === ROOM ? !SC.room : R.sel && !selItem()) R.sel = null;
  R.f = Math.min(R.f, frames() - 1);
  save(); rebuildRoom(); refresh(); renderToolbar(); renderTransport(); renderPanel(); fit();
}

export function showAll() { rebuildRoom(); refresh(); renderModes(); renderToolbar(); renderTransport(); renderPanel(); fit(); }

// the tab's mode (SC.mode) is now the one in force: leave the old, enter the new
export function syncMode() {
  const def = modeOf();
  if (R.modeKey === def.key) return;
  modeDef(R.modeKey)?.exit?.();
  R.modeKey = def.key;
  if (!def.select) { R.sel = null; R.joint = null; }
  setFree(def.view === 'free');
  def.enter?.();
}
export function setSceneMode(key) {
  if (!hasMode(key) || key === modeOf().key) return;
  stopPlay(); SC.mode = key; syncMode(); showAll();
  hooks.persist();
}
// the switch at the top of the panel, one big segment per registered mode
function renderModes() {
  const el = $('#sceneModes');
  if (el) el.replaceChildren(seg(modeList().map((m) => [m.key, m.label, m.hint]), modeOf().key, setSceneMode));
}

// the panel: the mode's own contents, then whatever has been plugged into that mode (addModeSection)
export function renderPanel() {
  const body = $('#sceneBody');
  if (!body || !SC) return;
  const def = modeOf();
  body.replaceChildren(h('div', { class: 'panel-body' }, def.panel(), modeSections(def.key).map((build) => build())));
}

export function editPanel() {
  return [
    panelTop(button('+ Add', openAdd, { cls: 'primary' }), SC.objects.length || SC.room ? () => {
      const before = clone(SC), ok = sameTab();
      SC.objects = []; SC.room = null; R.sel = null; rebuildRoom(); changed(); renderToolbar();
      undoToast('Scene cleared (the camera stays)', () => { if (ok()) { setSC(before); rebuildRoom(); changed(); } });
    } : null),
    layerList(),
    selItem() ? objectProps(selItem()) : R.sel === ROOM && SC.room ? roomProps() : cameraProps(),
    renderProps(), promptProps()];
}

// the camera on its own: seen through its lens (orbiting writes its keys), or from a free view of the room
export function cameraPanel() {
  return [
    section('View', null,
      seg([['shot', '🎥 Through the camera'], ['free', '🧭 Director view']], R.free ? 'free' : 'shot', (v) => { setFree(v === 'free'); renderPanel(); }),
      R.free ? [help('Look around freely: the camera is drawn as a frustum and orbiting here leaves it alone. Set the camera from what you see when it is framed.'),
        button('🎥 Camera to this view', () => { cameraFromView(); changed(); })]
        : help('You see what the camera sees: drag empty space to orbit it, two fingers to pan and zoom.')),
    cameraProps(), renderProps()];
}


export function buildToolbar() {
  viewer.append(h('div', { id: 'sceneToolbar', class: 'layer-toolbar scene-toolbar', role: 'toolbar', 'aria-label': 'Gizmo' },
    ...MODES.map(([m, label, key]) => h('button', { type: 'button', 'data-mode': m, title: `${label.slice(2)} (${key.toUpperCase()})`,
      onclick: () => setMode(m) }, label)),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-depth': '', title: 'Show the depth the render will use',
      onclick: () => { R.depth = !R.depth; draw(); renderToolbar(); } }, '◐ Depth'),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-undo': '', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => undo() }, '↶'),
    h('button', { type: 'button', 'data-redo': '', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => undo(false) }, '↷')));
  viewer.append(maxBar());
}

export function wireKeys() {
  wireSheetKeys();
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-scene').classList.contains('active') || sheetOpen()
      || e.target.closest('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') { e.preventDefault(); undo(k === 'z' && !e.shiftKey); }
      return;
    }
    const m = MODES.find(([, , k]) => k === e.key.toLowerCase());
    if (m) { e.preventDefault(); setMode(m[0]); }
    else if (e.key.toLowerCase() === 'k') { e.preventDefault(); setAutoKey(!R.autoKey); }
    else if (e.key === 'Escape') { if (R.joint) selectJoint(null); else select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {  // a frame; with Shift, to the next key
      e.preventDefault(); stopPlay();
      const fwd = e.key === 'ArrowRight', [item] = keyTarget();
      const k = e.shiftKey && item ? (fwd ? item.keys.find((x) => x.f > R.f) : item.keys.findLast((x) => x.f < R.f)) : null;
      seek(k ? k.f : e.shiftKey ? R.f : R.f + (fwd ? 1 : -1));
    }
  });
}
