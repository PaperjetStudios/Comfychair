import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import {
  $, actions, button, clamp, clone, closeSheet, field, h, iconBtn, layerRowsEl, numField, openSheet, panelTop, rangeField,
  section, seg, sheetOpen, store, uid, undoToast, help, toggle, sizeSelect, chip, info, toast, icon, iconize,
} from './ui.js';
import {
  C, CAM, EVEN, FPS, HIST, camsOf, newCamera, setActiveCam, MODES, R, ROOM, SC, SIZES, TEMP, TYPES, current, defaultScene, dropHolds, dropKeys, holdStart, frames, framesFor, hasKeys, hooks, keyCount, keyTarget,
  namesFor, nextKeyFrame, pivotOf, pivotsFor, sameTab, save, selItem, setSC, write
} from './scene-data.js';
import { FIG_TABS, adjustTab, faceTab, handsTab, jointsTab, movesTab, partsTab, posesTab, promptProps } from './scene-pose.js';
import {
  HAND, addObject, camGizmo, cameraFromView, newCameraPose, changed, draw, fit, handMode, jointMode, lookThrough, makePhoto, makeSplatHere, pose, rebuildRoom, recentre, refresh,
  removeLayer, removeSelected, select, selectJoint, setFree, setMode, syncMeshes, viewer
} from './scene-view.js';
import { busy, cancelRender, letGo, play, renderColorVideo, renderDepthVideo, renderPoseVideo, saveFrame, seek, stopPlay } from './scene-export.js';
import { maxBar, renderKeys, renderTransport, wireSheetKeys } from './scene-keys.js';
import { hasMode, modeDef, modeList, modeOf, modeSections } from './scene-modes.js';
import { syncRef, toggleRef } from './scene-ref.js';
import { keysPast, stretchAll } from './keys.js';
import { offsetField } from './scene-offset.js';

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
  const rb = tb.querySelector('[data-ref]');
  rb.classList.toggle('on', !!SC.ref && SC.ref.on !== false); rb.setAttribute('aria-pressed', !!SC.ref && SC.ref.on !== false);
  rb.title = SC.ref ? 'Reference over the view: show or hide' : 'Reference over the view: pick a picture';
  syncRef();
  const fb = tb.querySelector('[data-free]'), fixed = modeOf().view === 'free';   // (Create object only has the free view)
  fb.classList.toggle('hidden', fixed);
  fb.classList.toggle('on', R.free); fb.setAttribute('aria-pressed', R.free);
  fb.title = R.free ? 'Director view: back to looking through the camera (V)' : 'Director view: look around the scene freely, the camera drawn in it (V)';
  tb.querySelector('[data-undo]').disabled = !HIST.undo.length;
  tb.querySelector('[data-redo]').disabled = !HIST.redo.length;
}

// the key sheet (dope sheet, graph, selection and key edits) is scene-keys.js
export { renderKeys, renderTime, renderTransport } from './scene-keys.js';

// a slider: the view follows while dragging, the change is saved on letting go
export const slider = (label, get, set, opts) => rangeField(label, get, set,
  { ...opts, onInput: () => { pose(R.f); draw(); }, onChange: () => { save(); renderKeys(); } });
// a number slider (hold and pull it sideways: the view follows, the change is saved on letting go)
const num = (label, get, set, opts = {}) => numField(label, get(), set,
  () => { if (opts.after) opts.after(); changed(); },
  { digits: 2, live: () => { if (opts.after) opts.after(); syncMeshes(); pose(R.f); draw(); }, ...opts });
const easeSeg = (item) => field('Between keys', seg([['smooth', 'Ease'], ['linear', 'Linear']], item.ease, (v) => { item.ease = v; changed(); }));
const clearKeys = (item, names) => (hasKeys(item) ? button('Clear keys', () => { Object.assign(item.base, current(item, names)); item.chans = {}; changed(); }) : null);

function objectProps(o) {
  const names = namesFor(o);
  const cur = () => current(o, names);
  if (o.type !== 'figure') return section(TYPES[o.type].label, () => select(null), placeProps(o, cur));
  // a figure: its pose tools in tabs, big enough for fingers
  const tab = FIG_TABS.some(([k]) => k === R.figTab) ? R.figTab : 'pose';
  return section(o.name, () => select(null),
    seg(FIG_TABS, tab, (v) => { R.figTab = v; store.set('deck.scene.figtab', v); renderPanel(); }, { wrap: true }),
    { pose: posesTab, adjust: adjustTab, hands: handsTab, face: faceTab, move: movesTab, joint: jointsTab, parts: partsTab, place: placeProps }[tab](o, cur));
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
    o.type === 'figure' ? field('Body', seg(FIGURE.BODIES, FIGURE.bodyOf(o.body), (v) => { o.body = v; changed(); })) : null,
    xyz('Position (m)', [['x', 'X'], ['y', 'Up', { min: -5, max: 10 }], ['z', 'Z']], { min: -20, max: 20, step: 0.01 }),
    xyz('Rotation (°)', [['rx', 'X'], ['ry', 'Y'], ['rz', 'Z']], { digits: 0, min: -360, max: 360, step: 1 }),
    o.type === 'figure' ? num('Height (m)', () => cur().sy * FIGURE.heightOf(o.body, o.shape), (v) => even(Math.max(0.3, v) / FIGURE.heightOf(o.body, o.shape)), { min: 0.3, max: 2.5, step: 0.01 })
      : EVEN.has(o.type) ? num('Scale', () => cur().sy, (v) => even(Math.max(0.001, v)), { min: 0.001, max: 20, step: 0.001, digits: 3 })
      : xyz('Size (m)', [['sx', 'Width'], ['sy', 'Height'], ['sz', 'Depth']], { min: 0.05, max: 20, step: 0.01 }),
    field('Pivot (where the gizmo turns it)', seg(pivotsFor(o), pivotsFor(o).some(([k]) => k === pivotOf(o)) ? pivotOf(o) : null,
      (v) => { o.pivot = v; changed(); }, { wrap: true })),
    o.type === 'figure' ? shapeProps(o) : null,
    o.type === 'figure' ? [
      toggle('Planted on the floor (Up lifts it off)', o.ground, (on) => { o.ground = on; changed(); }),
      button('🎥 Face the camera', () => {
        const v = cur(), c = current(SC.camera, CAM);
        write(o, names, { ry: Math.round(THREE.MathUtils.radToDeg(Math.atan2(c.px - v.x, c.pz - v.z))) }); changed();
      })] : null,
    o.type === 'photo' ? [
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      o.view ? null : button('Re-centre', () => recentre(o), { title: 'Stand it centred at the middle of the scene, on the floor and upright; the camera moves to the photo\'s view' }),
      help('The picture as a 3D mesh (MoGe). Keep camera moves small: nothing is behind what the picture shows. Render depth video, then use it with this picture as a reference.')] : null,
    easeSeg(o),
    hasKeys(o) || o.off ? offsetField(o) : null,
    h('div', { class: 'row wrap' },
      button('Duplicate', () => {
        const c = { ...clone(o), id: uid(), name: `${o.name} copy` };
        c.base.x += 0.6; (c.chans.x || []).forEach((k) => { k.v += 0.6; }); if (c.off) c.off.pv[0] += 0.6;
        SC.objects.push(c); save(); select(c.id);
      }),
      clearKeys(o, names)),
    help('Drag the gizmo to move it; tap the object again (or W / E / R) for Rotate and Scale. With keys, a change sets a key at the playhead; with Auto key off it is held until ◆ Key (or until the playhead moves).')];
}

// a figure's body shape (o.shape: percent per proportion, not keyed) and the plain anatomy shapes (o.anatomy)
function shapeProps(o) {
  const sh = () => o.shape || {};
  const set = (k) => (v) => { o.shape = { ...sh(), [k]: Math.round(v) }; if (!o.shape[k]) delete o.shape[k]; };
  return field('Body shape', h('div', { class: 'shape-grid' }, FIGURE.SHAPES.map(([k, label]) => {
    const [min, max] = FIGURE.shapeRange(k);
    return slider(label, () => sh()[k] || 0, set(k), { min, max, step: 1, fmt: (v) => (v ? `${v > 0 ? '+' : ''}${Math.round(v)}%` : '—') });
  })),
  h('div', { class: 'row wrap' },
    toggle('Anatomy (plain mannequin shapes)', o.anatomy, (on) => { o.anatomy = on; changed(); }),
    Object.keys(sh()).length ? button('Reset shape', () => { delete o.shape; changed(); }) : null),
  help('Proportions on top of the man or the woman: the joints move with them, so IK, the floor plant and the pose video follow. Height (m) above is the whole figure. Anatomy adds plain, low-detail shapes for reference in depth renders; it is off unless ticked.'));
}

export function setAutoKey(on) {
  R.autoKey = on; store.set('deck.scene.autokey', on);
  const b = $('#sceneAutoKey');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
}

function layerList() {
  const keys = (it) => { const n = keyCount(it); return n ? `${n} key${n > 1 ? 's' : ''}` : ''; };
  const hideBtn = (it, after) => iconBtn(it.hidden ? 'Show' : 'Hide', it.hidden ? '◌' : '◉', () => { it.hidden = !it.hidden; after(); });
  const delBtn = (id, name) => iconBtn(`Delete ${name}`, '🗑', () => removeLayer(id));
  const rows = [{ sel: !R.sel, thumb: h('span', { class: 'scene-icon' }, icon('video')), name: SC.cams?.length ? `${SC.camera.name} (active of ${SC.cams.length + 1})` : 'Camera',
    hint: [`${SC.width}×${SC.height} · ${fmtSecs(SC.seconds)} s`, keys(SC.camera)].filter(Boolean).join(' · '), onclick: () => select(null) }];
  if (SC.room) {
    rows.push({ sel: R.sel === ROOM, off: SC.room.hidden, thumb: h('span', { class: 'scene-icon' }, icon('home')), name: 'Room',
      hint: `${SC.room.w}×${SC.room.d} m${SC.room.hidden ? ' · hidden' : ''}`, onclick: () => select(R.sel === ROOM ? null : ROOM),
      buttons: [hideBtn(SC.room, changed), delBtn(ROOM, 'the room')] });
  }
  for (const o of [...SC.objects].reverse()) {
    rows.push({ sel: o.id === R.sel, off: o.hidden, thumb: h('span', { class: 'scene-icon' }, iconize(TYPES[o.type].icon)), name: o.name,
      hint: [TYPES[o.type].label, keys(o), o.hidden ? 'hidden' : ''].filter(Boolean).join(' · '),
      onclick: () => select(o.id === R.sel ? null : o.id), buttons: [hideBtn(o, changed), delBtn(o.id, o.name)] });
  }
  return layerRowsEl(rows);
}

function roomProps() {
  const rm = SC.room;
  const re = () => rebuildRoom();
  return section('Room', () => select(null),
    h('div', { class: 'row' },
      num('Width (m)', () => rm.w, (v) => { rm.w = Math.max(1, v); }, { min: 1, max: 40, step: 0.1, digits: 1, after: re }),
      num('Depth (m)', () => rm.d, (v) => { rm.d = Math.max(1, v); }, { min: 1, max: 40, step: 0.1, digits: 1, after: re }),
      num('Height (m)', () => rm.h, (v) => { rm.h = Math.max(1, v); }, { min: 1, max: 10, step: 0.05, after: re })),
    field('Shape', seg([['room', 'Walls + ceiling'], ['walls', 'Walls'], ['floor', 'Floor only']], rm.walls ? (rm.ceiling ? 'room' : 'walls') : 'floor',
      (v) => { rm.walls = v !== 'floor'; rm.ceiling = v === 'room'; rebuildRoom(); changed(); })),
    help('Keep the walls about where the real ones should be: H3 sizes the room from them. Hide it (◉) for an open space.'));
}

// the scene's cameras: one is active (the view, the renders and a composition's clip look through it); the others
// keep their own keys until made active. Old scenes have the one.
function camerasField() {
  const name = h('input', { type: 'text', value: SC.camera.name || 'Camera', 'aria-label': 'Active camera name' });
  name.addEventListener('change', () => { SC.camera.name = name.value.trim() || SC.camera.name; changed(); });
  const others = (SC.cams || []).map((c) => h('div', { class: 'row cam-row' },
    h('span', { class: 'grow' }, c.name, h('span', { class: 'hint' }, keyCount(c) ? ` · ${keyCount(c)} keys` : '')),
    button('Make active', () => { setActiveCam(c); changed(); }, { title: `Look through ${c.name}` }),
    button('Delete', () => { SC.cams = SC.cams.filter((x) => x !== c); changed(); }, { cls: 'small danger', 'aria-label': `Delete ${c.name}` })));
  return field(['Cameras', info('The view, renders and the scene as a video clip look through the active camera. Each camera keeps its own keys (the others show in the key sheet too); make one active to move it with the view. New camera starts at the view you see in the director view, or a step behind the active camera.')],
    h('div', { class: 'row' }, name, h('span', { class: 'chip on' }, 'Active')),
    ...others,
    button('New camera', () => { const c = newCamera(); c.base = { ...c.base, ...newCameraPose() }; SC.cams.push(SC.camera); SC.camera = c; changed(); toast(`${c.name} is active`); },
      { title: 'A new camera, made active: at the view you see in the director view, else a step behind the active camera' }));
}

function cameraProps() {
  const cam = SC.camera;
  const mm = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);  // full-frame equivalent, from the vertical angle
  const sizeSel = sizeSelect(SIZES.map((s) => [s.join('×'), s]), [SC.width, SC.height], ([w, hh]) => { SC.width = w; SC.height = hh; save(); fit(); renderPanel(); });
  return section('Camera', null,
    camerasField(),
    field('Size', sizeSel), lengthProps(),
    slider('Lens', () => current(cam, CAM).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm` }),
    slider('Camera height', () => current(cam, CAM).py, (v) => write(cam, CAM, { py: v }),
      { min: 0.1, max: 6, step: 0.01, fmt: (v) => `${v.toFixed(2)} m` }),
    slider('Roll', () => current(cam, CAM).roll, (v) => write(cam, CAM, { roll: v }),
      { min: -180, max: 180, step: 0.5, fmt: (v) => `${v.toFixed(1)}°`,
        help: 'Tilts the camera around the way it looks. Positive banks it clockwise, so the picture turns anticlockwise. Key it to roll the view; motion tracking sets it from footage that turns.' }),
    easeSeg(cam),
    h('div', { class: 'row wrap' },
      clearKeys(cam, CAM),
      button('Reset view', () => { write(cam, CAM, { ...defaultScene().camera.base }); changed(); })),
    help('The view is the camera: drag empty space to orbit, two fingers to pan and zoom. With keys and Auto key on, each move sets a key at the playhead; with Auto key off it is only a look around until ◆ Key.'));
}

// ---- the video's length: the Generate panel's video template's (Match generate), or set here (Custom).
// SC.lenMode: 'match' | 'custom' (scenes from before it are custom); 2–15 s, half seconds allowed.
const LEN = [2, 15];
const fmtSecs = (v) => String(+Number(v).toFixed(2));
// the length of the video template picked in Generate, in seconds (a frame count goes over its fps,
// else 24), or null when what is picked there isn't a video template with a length
export function generateSeconds() {
  const t = C?.S?.tpl;
  if (!t?.fields || !(t.fields.some((f) => f.kind === 'video') || Object.values(t.node_titles || {}).some((n) => /video/i.test(n)))) return null;
  const isNum = (f) => f.kind === 'float' || f.kind === 'int', txt = (f) => `${f.label} ${f.input}`;
  const f = t.fields.find((x) => isNum(x) && /length|seconds|duration|frames/i.test(txt(x)));
  const val = (x) => +(C.S.values?.[x.key] ?? x.value);
  if (!f || !(val(f) > 0)) return null;
  const inFrames = /frame/i.test(txt(f)) || (/^(length|num_frames)$/.test(f.input) && !/sec|duration/i.test(f.label));
  const fps = t.fields.find((x) => isNum(x) && /fps|frame.?rate/i.test(txt(x)));
  return inFrames ? val(f) / ((fps && val(fps)) || FPS) : val(f);
}
// a new length: keys after the end go, the playhead stays inside
function setLength(v) {
  SC.seconds = Math.round(clamp(v, ...LEN) * 100) / 100;
  const n = frames();
  for (const it of [...camsOf(), ...SC.objects]) dropKeys(it, (f) => f >= n);
  R.f = Math.min(R.f, n - 1);
}
const lengthChanged = () => { save(); refresh(); renderTransport(); renderPanel(); renderToolbar(); };
const animated = () => [...camsOf(), ...SC.objects];
const clampLen = (v) => Math.round(clamp(v, ...LEN) * 100) / 100;
// a new length; when it would cut keys off the end, ask first: stretch the animation to fit, or cut them
function newLength(v, mode = SC.lenMode) {
  const s = clampLen(v), cut = keysPast(animated(), framesFor(s));
  if (!cut) { setLength(s); SC.lenMode = mode; lengthChanged(); return; }
  openSheet(h('h3', {}, `Shorten to ${fmtSecs(s)} s?`),
    h('p', {}, `${cut} key${cut > 1 ? 's are' : ' is'} past ${fmtSecs(s)} s.`),
    actions(button('Cancel', () => { closeSheet(); renderPanel(); }),
      button('✂ Cut them', () => { closeSheet(); setLength(s); SC.lenMode = mode; lengthChanged(); }, { cls: 'small danger' }),
      button('⇔ Stretch to fit', () => { closeSheet(); stretchTo(s, mode); }, { cls: 'small primary' })));
}
// the whole animation stretched (or squeezed) to a new length, from frame 0: one undo step
function stretchTo(v, mode = 'custom') {
  const s = clampLen(v), before = clone(SC), ok = sameTab(), was = SC.seconds, from = frames();
  SC.seconds = s;
  stretchAll(animated(), from, frames());
  setLength(s); SC.lenMode = mode; TEMP.clear();
  lengthChanged();
  undoToast(`Keys stretched ×${(s / was).toFixed(2)} to ${fmtSecs(s)} s`, () => {
    if (!ok()) return;
    setSC(before); R.f = Math.min(R.f, frames() - 1); TEMP.clear(); lengthChanged();
  });
}
function openStretch() {
  const g = generateSeconds();
  let want = SC.seconds;
  openSheet(h('h3', {}, 'Stretch keys to…'),
    rangeField('New length', () => want, (v) => { want = v; }, { min: LEN[0], max: LEN[1], step: 0.5, fmt: (v) => `${fmtSecs(v)} s · ${framesFor(v)} frames` }),
    help('Every key of every layer moves in time with the new length, from the start: longer slows the whole animation down, shorter speeds it up. Keys that land on the same frame merge.'),
    actions(button('Cancel', closeSheet),
      g != null ? button(`Match generate length · ${fmtSecs(clampLen(g))} s`, () => { closeSheet(); stretchTo(g, 'match'); }) : null,
      button('⇔ Stretch', () => { closeSheet(); if (Math.abs(want - SC.seconds) >= 0.005) stretchTo(want, 'custom'); }, { cls: 'small primary' })));
}
// Match generate: take the Generate template's length when it differs (on show, and when Generate changes)
export function syncLength() {
  if (SC?.lenMode !== 'match') return;
  const g = generateSeconds();
  if (g == null || Math.abs(clamp(g, ...LEN) - SC.seconds) < 0.005) return;
  newLength(g, 'match');
}
function lengthProps() {
  const mode = SC.lenMode === 'match' ? 'match' : 'custom', g = generateSeconds();
  const choice = seg([['match', 'Match generate', 'The length of the video template picked in Generate'], ['custom', 'Custom']], mode, (v) => {
    SC.lenMode = v;
    if (v === 'match' && g != null) syncLength(); else { save(); renderPanel(); }
  });
  const label = `Length · ${fmtSecs(SC.seconds)} s · ${frames()} frames`;
  const stretch = h('div', { class: 'row wrap' }, button('⇔ Stretch keys to…', openStretch, { title: 'A new length with the whole animation stretched or squeezed to fit' }));
  if (mode === 'match') {
    return [field([label, h('span', { class: 'hint' }, g == null ? 'no video template in Generate' : C.S.tpl.name)], choice,
      help('Follows the length of the video template picked in Generate (2–15 s). With no video template there, the length stays as it is.')), stretch];
  }
  let want = SC.seconds;
  return [field(label, choice),
    rangeField('Custom length', () => want, (v) => { want = v; }, { min: LEN[0], max: LEN[1], step: 0.5, fmt: (v) => `${fmtSecs(v)} s · ${framesFor(v)} frames`,
      onChange: () => { if (Math.abs(want - SC.seconds) < 0.005) return; newLength(want, 'custom'); } }), stretch];
}

export function renderProps() {
  const figs = SC.objects.some((o) => o.type === 'figure' && !o.hidden);
  const use = (g, what) => button(`Use ${what} #${g.id} in H3 control`, () => C.useControlVideo(g, SC));
  return section('Render', null,
    slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
    help('Blurs the depth so H3 copies the shapes less literally. Use with deck-h3-ctrl2v (strength 1, end 0.4).'),
    busy ? h('div', { class: 'row wrap' }, button('✕ Cancel render', cancelRender, { cls: 'small danger', title: 'Stop the render: nothing is saved' }))
      : h('div', { class: 'row wrap' },
        button('Render depth video', renderDepthVideo, { cls: 'small primary' }),
        figs ? button('Render pose video', renderPoseVideo, { title: 'The posable people as OpenPose stick figures' }) : null,
        figs ? button('Render both', async () => { if (await renderDepthVideo()) await renderPoseVideo(); }, { title: 'A depth video and a pose video of the same shot' }) : null,
        button('🎞 Render colour video', renderColorVideo, { title: 'The shot as it looks, over the scene\'s length, at its size: splats at their full set' }),
        button('📷 Save frame', saveFrame)),
    figs ? h('div', { class: 'row wrap' }, ...[['poseHands', 'Hands in the pose video'], ['poseFace', 'Face points in the pose video']].map(([k, l]) =>
      toggle(l, SC[k] !== false, (on) => { SC[k] = on; save(); }))) : null,
    R.renders.depth || R.renders.pose ? h('div', { class: 'row wrap' },
      R.renders.depth ? use(R.renders.depth, 'depth') : null, R.renders.pose ? use(R.renders.pose, 'pose') : null) : null,
    h('p', { id: 'sceneStatus', class: 'hint' }, statusText));
}

function openAdd() {
  openSheet(h('h3', {}, 'Add to the scene'),
    h('div', { class: 'chips' }, ...Object.entries(TYPES).filter(([t, d]) => !['photo', 'model', 'splat'].includes(t) && !d.hide).flatMap(([t, d]) => (t === 'figure'
      ? FIGURE.BODIES.map(([b, l]) => chip(`${d.icon} ${d.label} (${l.toLowerCase()})`, () => addObject(t, { body: b })))
      : [chip(`${d.icon} ${d.label}`, () => addObject(t))])),
      SC.room ? null : chip('⌂ Room', () => addObject(ROOM)),
      chip('🖼 Photo in 3D…', () => {
        closeSheet(); C.openImagePicker({ title: 'Picture to turn into 3D', onPick: (name) => makePhoto(name) });
      }, 'Turn a picture into a 3D mesh (MoGe in ComfyUI) for camera moves'),
      chip('Photo as a splat…', () => {
        closeSheet(); C.openImagePicker({ title: 'Picture to turn into a splat', onPick: (name) => makeSplatHere(name) });
      }, 'Turn a picture into Gaussian splats (Apple SHARP): softer and more lifelike than the mesh, for small camera moves')));
}

// ---- history, modes -----------------------------------------------------------------------
function undo(back = true) {
  const [from, to] = back ? [HIST.undo, HIST.redo] : [HIST.redo, HIST.undo];
  if (!from.length) return;
  const mode = SC.mode;
  dropHolds();   // (it plays on, with the scene undone)
  to.push(HIST.cur); HIST.cur = from.pop();
  setSC(JSON.parse(HIST.cur)); SC.mode = mode; TEMP.clear(); R.joint = null;
  if (R.sel === ROOM ? !SC.room : R.sel && !selItem()) R.sel = null;
  R.f = Math.min(R.f, frames() - 1);
  save(); rebuildRoom(); refresh(); renderToolbar(); renderTransport(); renderPanel(); fit();
}

export function showAll() { rebuildRoom(); refresh(); renderToolbar(); renderModes(); renderTransport(); renderPanel(); fit(); }

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
// the switch on the view, beside full screen: an icon button per registered mode
function renderModes() {
  const el = $('#sceneModeBar');
  if (!el) return;
  const cur = modeOf().key;
  el.replaceChildren(...modeList().map((m) => h('button', { type: 'button', class: m.key === cur ? 'on' : '', title: m.hint || m.label,
    'aria-label': m.label, 'aria-pressed': m.key === cur, 'data-scene-mode': m.key, onclick: () => setSceneMode(m.key) }, iconize(m.icon))));
}

// the panel: the mode's own contents, then whatever has been plugged into that mode (addModeSection)
export function renderPanel() {
  const body = $('#sceneBody');
  if (!body || !SC) return;
  const def = modeOf();
  body.replaceChildren(h('div', { class: 'panel-body' }, def.panel(), modeSections(def.key).map((build) => build()), def.out?.()));
}

export function editPanel() {
  return [
    panelTop(button('+ Add', openAdd, { cls: 'primary' }), SC.objects.length || SC.room ? () => {
      const before = clone(SC), ok = sameTab();
      SC.objects = []; SC.room = null; R.sel = null; rebuildRoom(); changed(); renderToolbar();
      undoToast('Scene cleared (the camera stays)', () => { if (ok()) { setSC(before); rebuildRoom(); changed(); } });
    } : null),
    layerList(),
    selItem() ? objectProps(selItem()) : R.sel === ROOM && SC.room ? roomProps() : cameraProps()];
}
// what the scene makes, last in the panel (after the reference and imports)
export const editOut = () => [promptProps(), renderProps()];

// the camera on its own: seen through its lens (orbiting writes its keys), or from a free view of the room
export function cameraPanel() {
  return [
    section('View', null,
      seg([['shot', '🎥 Through the camera'], ['free', '🧭 Director view']], R.free ? 'free' : 'shot', (v) => { setFree(v === 'free'); renderPanel(); }),
      R.free ? [help('Look around freely: the camera is drawn as a frustum and orbiting here leaves it alone. Set the camera from what you see when it is framed.'),
        button('🎥 Camera to this view', () => { cameraFromView(); changed(); })]
        : help('You see what the camera sees: drag empty space to orbit it, two fingers to pan and zoom.')),
    cameraProps()];
}


// through the camera / the director view, from the view itself (Edit scene and Camera)
function toggleFree() {
  if (modeOf().view === 'free') return;
  setFree(!R.free); renderPanel();
}

export function buildToolbar() {
  viewer.append(h('div', { id: 'sceneToolbar', class: 'layer-toolbar scene-toolbar', role: 'toolbar', 'aria-label': 'Gizmo' },
    ...MODES.map(([m, icon, key, name]) => h('button', { type: 'button', class: 'ico', 'data-mode': m, title: `${name} (${key.toUpperCase()})`,
      'aria-label': name, onclick: () => setMode(m) }, iconize(icon))),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', class: 'ico', 'data-depth': '', title: 'Depth: show the depth the render will use', 'aria-label': 'Depth',
      onclick: () => { R.depth = !R.depth; draw(); renderToolbar(); } }, icon('contrast')),
    h('button', { type: 'button', class: 'ico', 'data-ref': '', 'aria-label': 'Reference', onclick: toggleRef }, icon('reference')),
    h('button', { type: 'button', class: 'ico', 'data-free': '', 'aria-label': 'Director view', onclick: toggleFree }, icon('compass')),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-undo': '', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => undo() }, '↶'),
    h('button', { type: 'button', 'data-redo': '', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => undo(false) }, '↷')));
  viewer.append(maxBar(), h('div', { id: 'sceneModeBar', class: 'layer-toolbar scene-modebar', role: 'toolbar', 'aria-label': 'Mode' }));
}

export function wireKeys() {
  wireSheetKeys();
  // the panel's sliders, number boxes and buttons while it plays: held over the keys from touch to letting go
  // (a moment after, so the slider's change and the button's click are part of the hold)
  document.addEventListener('pointerdown', (e) => { if (e.target.closest?.('#sceneBody')) holdStart('panel'); }, true);
  const up = () => setTimeout(() => letGo('panel'));
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
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
    else if (e.key.toLowerCase() === 'v') { e.preventDefault(); toggleFree(); }
    else if (e.key === 'Escape') { if (HAND.on) handMode(null); else if (R.joint) selectJoint(null); else select(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {  // a frame; with Shift, to the next key
      e.preventDefault(); stopPlay();
      const fwd = e.key === 'ArrowRight', [item] = keyTarget();
      const k = e.shiftKey && item ? nextKeyFrame(item, R.f, fwd ? 1 : -1) : null;
      seek(k != null ? k : e.shiftKey ? R.f : R.f + (fwd ? 1 : -1));
    }
  });
}
