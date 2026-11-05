import { layerListPart, layersFloating } from './float-layers.js';
import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import {
  $, actions, button, clamp, clone, closeSheet, field, h, hint, iconBtn, layerRowsEl, numField, openSheet, panelTop, rangeField,
  section, seg, sheetOpen, store, uid, undoToast, help, withHelp, toggle, chip, info, toast, icon, iconize, numSlider, popover, closePopover,
} from './ui.js';
import {
  applyToLayer, canBake, C, CAM, EVEN, FPS, HIST, camsOf, cutTo, dropCuts, newCamera, setActiveCam, shots, stretchCuts, trimCuts, MODES, R, ROOM, SC, TEMP, TYPES, current, defaultScene, dropHolds, dropKeys, holdStart, frames, framesFor, hasKeys, hooks, keyCount, addKey, bakeBase, sampleChan,
  namesFor, pivotOf, pivotsFor, sameTab, save, selItem, setSC, write, isPosable, isBoneKeyed
} from './scene-data.js';
import { FIG_TABS, adjustTab, faceTab, handsTab, jointsTab, movesTab, partsTab, posesTab, promptProps } from './scene-pose.js';
import { shotProps } from './scene-shots.js';
import { rigProps } from './scene-rig.js';
import { boneProps } from './scene-skin.js';
import {
  HAND, addObject, aimCameraAt, axesToView, camGizmo, cameraFromView, canPivot, canTurnAxes, faceCamera, lookAtLayer, originMode, turnAxesBy, changed, draw, fit, handMode, jointMode, lookThrough, makePhoto, makeSplatHere, newCameraPose, orientLabel,
  originEditing, originTo, boxHost, setBoxEdit, pivotMoved, pivotToView, pose, putOrigin, rebuildRoom, recentre, refresh, removeLayer, removeSelected, resetPivot, select, selectJoint, setAimEdit, setFree, setMode, setOrient, setOriginEdit, syncMeshes, viewer, SCN
} from './scene-view.js';
import { ORIENTS, nextOrient } from './gizmo-orient.js';
import { drawnScale } from './origin-math.js';
import { RENDERED, busy, cancelRender, letGo, play, renderColorVideo, renderDepthVideo, renderPoseVideo, saveFrame as saveFramePic, saveStill as saveStillPic, seek, stopPlay } from './scene-export.js';
import { AREA, jumpKey, keyHere, maxBar, renderKeys, renderTransport, toEnd, toStart, unkeyHere, wireSheetKeys } from './scene-keys.js';
import { commandFor, keysList } from './scene-shortcuts.js';
import { PIP, togglePip, wirePip } from './scene-pip.js';
import { scaleOf as bakeScale } from './bake-math.js';
import { SPLAT_BLUR } from './splat-depth.js';
import { toggleGrid3 } from './gizmo.js';
import { hasMode, modeDef, modeList, modeOf, modeSections } from './scene-modes.js';
import { syncRef, toggleRef } from './scene-ref.js';
import { addPicture, fitPicture, sceneToPicture } from './scene-picture.js';
import { setupsRow } from './setups.js';
import { sceneKey } from './setups-rules.js';
import { keysPast, stretchAll } from './keys.js';
import { offsetField } from './scene-offset.js';
import { refOn as scaleRefOn, scaleProps, setRef as setScaleRef, startStand } from './scene-scale.js';
import { registerUndo, syncUndo } from './undo-dock.js';
import { ownsKey } from './key-focus.js';

// ---- UI ----------------------------------------------------------------------
let statusText = '';
export function setStatus(t) { statusText = t; const s = $('#sceneStatus'); if (s) s.textContent = t; }

export function renderToolbar() {
  const tb = $('#sceneToolbar');
  if (!tb) return;
  const cam = camGizmo(), can = !!selItem() || cam;   // (the director view's camera has Move and Rotate)
  // a joint turns (Rotate); a hand or foot can also be dragged (Move, with IK)
  const ok = (m) => can && !(cam && m === 'scale') && !(originEditing() && (m === 'scale' || (m === 'rotate' && !canTurnAxes(selItem())))) && (!R.joint || m === 'rotate' || (m === 'translate' && !!FIGURE.IK[R.joint]));
  const mode = R.joint ? jointMode() : originEditing() ? originMode() : R.mode;
  tb.querySelectorAll('[data-mode]').forEach((b) => { b.classList.toggle('on', ok(b.dataset.mode) && b.dataset.mode === mode); b.disabled = !ok(b.dataset.mode); });
  // the gizmo's axes: the button shows the ones in use and a tap goes on to the next
  const ob = tb.querySelector('[data-orient]'), [, , oi] = ORIENTS.find(([k]) => k === R.orient) || ORIENTS[0];
  if (ob.dataset.orient !== R.orient) { ob.dataset.orient = R.orient; ob.replaceChildren(icon(oi)); }
  const nx = ORIENTS.find(([k]) => k === nextOrient(R.orient))[1];
  ob.title = `Gizmo axes: ${orientLabel()}${R.orient === 'view' ? ' (screen right, up, toward you)' : R.orient === 'local' ? ' (the object\'s own)' : ''}. Tap for ${nx} (Q)`;
  ob.setAttribute('aria-label', `Gizmo axes: ${orientLabel()}`);
  const ob2 = tb.querySelector('[data-origin]'), edit = originEditing(), one = !!selItem() && !R.joint;
  ob2.disabled = !one; ob2.classList.toggle('on', edit); ob2.setAttribute('aria-pressed', edit);
  tb.querySelector('[data-face]').disabled = !one;
  tb.querySelector('[data-selcam]').classList.toggle('hidden', R.sel == null || !modeOf().select);
  const pb = tb.querySelector('[data-pivot]'), moved = pivotMoved();
  pb.disabled = !canPivot(); pb.classList.toggle('on', moved); pb.setAttribute('aria-pressed', moved);
  tb.querySelector('[data-pivot-reset]').classList.toggle('hidden', !moved);
  const ov = R.depth || (!!SC.ref && SC.ref.on !== false) || scaleRefOn();
  tb.querySelector('[data-overlays]').classList.toggle('on', ov);
  syncRef();
  // contextual: the transform tools and the snapping only while something can be moved (they fade in and out)
  tb.querySelector('[data-ctx=transform]').classList.toggle('ctx-off', !can);
  viewer.querySelector('.gz-3d')?.classList.toggle('ctx-off', !can);
  const fb = tb.querySelector('[data-free]'), fixed = modeOf().view === 'free';   // (Create object only has the free view)
  fb.classList.toggle('hidden', fixed);
  fb.classList.toggle('on', R.free); fb.setAttribute('aria-pressed', R.free);
  fb.title = R.free ? 'Director view: back to looking through the camera (V)' : 'Director view: look around the scene freely, the camera drawn in it (V)';
  tb.querySelector('[data-camview]').classList.toggle('hidden', !canCamToView());
  const pipBtn = tb.querySelector('[data-pip]');
  pipBtn.classList.toggle('hidden', !R.free); pipBtn.classList.toggle('on', PIP.on);
  const vb = tb.querySelector('[data-viewcut]');
  if (vb) {
    vb.classList.toggle('on', !!R.viewCut); vb.setAttribute('aria-pressed', !!R.viewCut);
    vb.textContent = R.viewCut ? 'Cut' : 'Cam';
    vb.title = R.viewCut
      ? 'View: Cut (Shift+V). Playback follows the shot list. With the camera selected, or in Camera mode, you still see the camera you edit. A drag does nothing while another camera is on show: switch to Cam to move it. Renders always follow the cuts.'
      : 'View: the camera you edit (Shift+V). Renders still follow the cuts.';
  }
  syncUndo();
}

// the key sheet (dope sheet, graph, selection and key edits) is scene-keys.js
export { renderKeys, renderTime, renderTransport } from './scene-keys.js';

// a slider: the view follows while dragging, the change is saved on letting go. keys: [item, names, channels] adds
// ◀ ◆ ▶ (keyBtns) to its label
export const slider = (label, get, set, { keys = null, ...opts } = {}) => {
  const el = rangeField(label, get, set, { ...opts, onInput: () => { pose(R.f); draw(); }, onChange: () => { save(); renderKeys(); } });
  return keys ? withKeys(el, label, ...keys) : el;
};

// ◀ ◆ ▶ beside a property, as in the Video and Editor tabs (Blender's keyframe dot): ◆ keys only these channels at
// the playhead with the values they show (filled: a key is here; lit: they are animated elsewhere), tapped on their
// key takes it away; ◀ ▶ jump to their keys before / after the playhead. The label goes yellow on a key, green between.
export function withKeys(el, label, item, names, chs) {
  const lists = () => chs.map((ch) => item.chans?.[ch] || []);
  const here = lists().length && lists().every((l) => l.some((k) => k.f === R.f));
  const anim = lists().some((l) => l.length);
  const frs = [...new Set(lists().flat().map((k) => k.f))].sort((a, b) => a - b);
  const dia = iconBtn(here ? `Take away the ${label} key here` : anim ? `Key ${label} here` : `Animate ${label}: a key here`, here ? '◆' : '◇', () => {
    if (here) {
      for (const ch of chs) {   // (a channel losing its last key stays as it looks now)
        const l = item.chans?.[ch];
        if (l && l.every((k) => k.f === R.f)) bakeBase(item, ch, sampleChan(item, ch, R.f));
      }
      dropKeys(item, (f, ch) => f === R.f && chs.includes(ch));
    } else addKey(item, names, null, new Set(chs));
    changed();
  });
  dia.classList.toggle('on', anim);
  const prev = frs.findLast((f) => f < R.f), next = frs.find((f) => f > R.f);
  const jump = (f, dir) => iconBtn(`${dir < 0 ? 'Previous' : 'Next'} ${label} key`, dir < 0 ? '◀' : '▶', () => seek(f), { hidden: !anim, disabled: f == null });
  el.querySelector('.lbl').append(h('span', { class: 'key-btns' }, jump(prev, -1), dia, jump(next, 1)));
  el.classList.add('keyed', ...(here ? ['k-here'] : anim ? ['k-anim'] : []));
  return el;
}
// a number slider (hold and pull it sideways: the view follows, the change is saved on letting go)
const num = (label, get, set, opts = {}) => numField(label, get(), set,
  () => { if (opts.after) opts.after(); changed(); },
  { digits: 2, live: () => { if (opts.after) opts.after(); syncMeshes(); pose(R.f); draw(); }, ...opts });
const easeSeg = (item) => field('Between keys', seg([['smooth', 'Ease'], ['linear', 'Linear']], item.ease, (v) => { item.ease = v; changed(); }));
const clearKeys = (item, names) => (hasKeys(item) ? button('Clear keys', () => { Object.assign(item.base, current(item, names)); item.chans = {}; changed(); }) : null);

// a layer placed from a character: when the character's current model or rig has changed, offer the new one (never by itself: finished shots stay as they are)
function charLink(o) {
  if (!o.char) return null;
  const row = hint('');
  import('./charstage.js').then(({ layerChar }) => { const el = layerChar(o); if (el) row.replaceWith(el); }).catch(() => {});
  return row;
}

function objectProps(o) {
  const names = namesFor(o);
  const cur = () => current(o, names);
  if (!isPosable(o)) return section(TYPES[o.type].label, () => select(null), charLink(o), placeProps(o, cur), isBoneKeyed(o) ? boneProps(o) : null);
  // a figure: its pose tools in tabs, big enough for fingers
  const tab = FIG_TABS.some(([k]) => k === R.figTab) ? R.figTab : 'pose';
  return section(o.name, () => select(null), charLink(o),
    seg(FIG_TABS, tab, (v) => { R.figTab = v; store.set('deck.scene.figtab', v); renderPanel(); }, { wrap: true }),
    { pose: posesTab, adjust: adjustTab, hands: handsTab, face: faceTab, move: movesTab, joint: jointsTab, parts: partsTab, place: placeProps }[tab](o, cur),
    o.type === 'rigged' ? rigProps(o) : null);
}

function duplicateObject(o) {
  const c = { ...clone(o), id: uid(), name: `${o.name} copy` };
  c.base.x += 0.6; (c.chans.x || []).forEach((k) => { k.v += 0.6; }); if (c.off) c.off.pv[0] += 0.6;
  SC.objects.push(c); save(); select(c.id);
}
// where it is, how big, its pivot; duplicate and delete
function placeProps(o, cur) {
  const names = namesFor(o);
  const even = (v) => write(o, names, { sx: v, sy: v, sz: v });
  const name = h('input', { type: 'text', value: o.name });
  name.addEventListener('change', () => { o.name = name.value.trim() || o.name; changed(); });
  const lock = { get: () => o.lockSize === true, set: (on) => { o.lockSize = on; save(); } };
  const sizeKeys = (el, label) => withKeys(el, label, o, names, ['sx', 'sy', 'sz']);
  return [
    field('Name', name),
    o.type === 'figure' ? field('Body', seg(FIGURE.BODIES, FIGURE.bodyOf(o.body), (v) => { o.body = v; changed(); })) : null,
    vecRow('Position (m)', o, names, [['x', 'X', 'x'], ['y', 'Y', 'y', 'Y (up)'], ['z', 'Z', 'z']], { min: -50, max: 50 }),
    vecRow('Rotation (°)', o, names, [['rx', 'X', 'x'], ['ry', 'Y', 'y'], ['rz', 'Z', 'z']], { min: -720, max: 720, step: 0.5, digits: 1, perPx: 0.5 }),
    o.type === 'figure' ? sizeKeys(num('Height (m)', () => cur().sy * FIGURE.heightOf(o.body, o.shape), (v) => even(Math.max(0.3, v) / FIGURE.heightOf(o.body, o.shape)), { min: 0.3, max: 2.5, step: 0.01 }), 'Height')
      : EVEN.has(o.type) ? sizeKeys(num('Scale', () => cur().sy, (v) => even(Math.max(0.0001, v)), { min: 0.0001, max: o.type === 'picture' ? 500 : 20, step: 0.001, digits: 4 }), 'Scale')
      : vecRow('Size (m)', o, names, [['sx', 'W', 'x', 'Width'], ['sy', 'H', 'y', 'Height'], ['sz', 'D', 'z', 'Depth']],
        { min: 0.01, max: 50, step: 0.01, perPx: 0.005, reset: { sx: TYPES[o.type].size[0], sy: TYPES[o.type].size[1], sz: TYPES[o.type].size[2] }, lock }),
    o.type === 'picture' ? null : scaleProps(o),   // (a real size means nothing for a backdrop)
    field('Pivot (where the gizmo turns it)', seg(pivotsFor(o), pivotsFor(o).some(([k]) => k === pivotOf(o)) ? pivotOf(o) : null,
      (v) => { o.pivot = v; resetPivot(); changed(); }, { wrap: true })),
    originProps(o, cur),
    applyProps(o),
    o.type === 'figure' ? shapeProps(o) : null,
    o.type === 'figure' ? toggle('Planted on the floor (Up lifts it off)', o.ground, (on) => { o.ground = on; changed(); }) : null,
    fitProps(o),
    o.type === 'picture' ? [
      button('🎥 Fit to the camera', () => fitPicture(o), { title: 'Fill the shot camera\'s frame, at the playhead' }),
      button('Make the scene the picture\'s shape', () => sceneToPicture(o), { title: `Make the scene's picture this shape (${o.pw} × ${o.ph}), so none of it is cut off` }),
      help('The picture on a flat plane, in its own shape, behind everything. It stays put when the camera moves. It is in colour renders but not depth ones. A tap on the view goes through it: pick it in the layer list.')] : null,
    o.type === 'photo' ? [
      button('🎥 Camera to the photo\'s view', () => { lookThrough(o); changed(); }),
      o.view ? null : button('Re-centre', () => recentre(o), { title: 'Stand it centred at the middle of the scene, on the floor and upright; the camera moves to the photo\'s view' }),
      help('The picture as a 3D mesh (MoGe). Keep camera moves small: nothing is behind what the picture shows. Render depth video, then use it with this picture as a reference.')] : null,
    easeSeg(o),
    hasKeys(o) || o.off ? offsetField(o) : null,
    h('div', { class: 'row wrap' },
      button('Duplicate', () => duplicateObject(o), { title: 'Duplicate (Shift+D)' }),
      clearKeys(o, names)),
    help('Drag the gizmo to move it; tap the object again (or W / E / R) for Rotate and Scale. With keys, a change sets a key at the playhead; with Auto key off it is held until ◆ Key (or until the playhead moves).')];
}

// fitting it into the scene: toward the camera, the camera at it, standing on what's under a tap, and locked when it's the background
function fitProps(o) {
  return field(['Fit into the scene', info('Face the camera turns its front (its own +Z, the blue axis) at the camera, around its pivot. Upright only turns it about the up axis, so it keeps standing. If the wrong side comes round, set its front with Edit origin and axes. Aim the camera keeps the camera where it stands and points it at this layer\'s pivot. Look at it brings the director view to this layer, so it orbits around it. Stand it on: the next tap puts its base there, on a splat or a model under the tap, else on the floor. Locked: a tap on the view goes through it, for a background splat. It stays in the layer list, and picking it there still moves it.', 'About fitting into the scene')],
    h('div', { class: 'row wrap' },
      button('🎥 Face the camera', () => faceCamera(o), { cls: 'small', title: 'T' }),
      isPosable(o) ? null : button('Upright only', () => faceCamera(o, true), { cls: 'small' }),
      button('Aim the camera at it', () => aimCameraAt(o), { cls: 'small' }),
      R.free ? button('Look at it', () => lookAtLayer(o), { cls: 'small' }) : null,
      o.type === 'picture' ? null : button('Stand it on…', () => startStand(o), { cls: 'small' })),
    toggle('Locked: taps on the view go through it', !!o.locked, (on) => { if (on) o.locked = true; else delete o.locked; changed(); }));
}

// Apply: the layer looks the same, and its scale, rotation or everything reads as nothing (bake-math.js)
function applyProps(o) {
  if (!canBake(o)) return null;
  const apply = (kind) => {
    const r = applyToLayer(o, kind);
    if (!r.ok) return toast(r.why, true);
    changed(); refresh();
    if (r.note) toast(r.note);
  };
  return field(['Apply', info('The layer stays exactly where it is and looks the same, but what you apply reads as nothing: Apply scale makes its scale 1, Apply rotation makes its rotation 0, and Apply transform does both and puts its position at 0, with its origin there. The gizmo and later changes then start clean. Files are not changed. A stretched layer loses its scale with its rotation. Anything with keys on what would go can\'t be applied.', 'About Apply')],
    h('div', { class: 'row wrap' },
      button('Apply scale', () => apply('scale'), { cls: 'small' }),
      button('Apply rotation', () => apply('rotation'), { cls: 'small' }),
      button('Apply transform', () => apply('all'), { cls: 'small' })));
}

// the layer's origin: what x, y, z mean, and what it turns and scales around in the view, in renders and between keys
function originProps(o, cur) {
  const editing = originEditing(), at = o.origin || [0, 0, 0], own = o.bake ? bakeScale(o.bake) : [1, 1, 1], size = drawnScale(cur(), EVEN.has(o.type)).map((v, i) => v * own[i]);
  const axis = (label, i) => numField(label, at[i] * size[i], (v) => {
    if (!Number.isFinite(v)) return;
    const next = [...(o.origin || [0, 0, 0])];
    next[i] = v / size[i];
    putOrigin(o, next);
  }, changed, { live: () => { pose(R.f); draw(); }, digits: 2, step: 0.01, min: -50, max: 50 });
  const axes = editing && canTurnAxes(o);
  return field(['Origin and axes', info('The origin is the point this layer really turns and scales around: in the view, in renders and between keys. Position is where this point is. Edit origin and axes (Y): Move drags the origin, Rotate turns the layer\'s own axes (its rotation offset), and the layer stays where it is. A tap on the layer, or Pivot at the view centre, puts the origin there. Red is X, green Y, blue Z, and the cone on Z is its front, which Face the camera points at the camera. Axes to this view: look at its front, then tap it. Grid and turn snapping work here too. A stretched layer has its scale applied when its axes turn; a figure, a rig or a picture keeps its axes. Rotation keys are adjusted and added the same way as position keys. X, Y and Z are metres from the layer\'s own base, along its own axes. On an animated layer, position keys are adjusted and added so it stays put on its keys; between keys its path can shift a little. On a figure, moves, pairs and captured motion treat this point as the figure\'s feet.')],
    h('div', { class: 'row wrap' },
      toggle('Edit origin and axes', editing, (on) => setOriginEdit(on)),
      ...pivotsFor(o).filter(([k]) => k !== 'set').map(([k, label]) => button(label, () => originTo(o, k), { cls: 'small', title: `Put the origin at: ${label}` })),
      o.origin ? button('Reset', () => { putOrigin(o, [0, 0, 0]); delete o.pivot; changed(); }, { cls: 'small', title: 'Back to the layer\'s own origin (it stays where it is)' }) : null),
    h('div', { class: 'row' }, axis('X', 0), axis('Y', 1), axis('Z', 2)),
    axes ? h('div', { class: 'row wrap' },
      button('Axes to this view', () => axesToView(o), { cls: 'small', title: 'Its front (the blue axis) comes toward you, the layer stays' }),
      ...['X', 'Y', 'Z'].map((a, i) => button(`${a} +90°`, () => turnAxesBy(o, i), { cls: 'small', title: `Turn its axes a quarter turn about its own ${a}, the layer stays` }))) : null);
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
  const lockBtn = (it) => iconBtn(it.locked ? `Unlock ${it.name}` : `Lock ${it.name}: taps on the view go through it`, icon(it.locked ? 'lock' : 'unlock'), () => { if (it.locked) delete it.locked; else it.locked = true; changed(); });
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
      onclick: () => select(o.id === R.sel ? null : o.id), buttons: [lockBtn(o), hideBtn(o, changed), delBtn(o.id, o.name)] });
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

// the scene's cameras: one is active (the one you edit). The picture while the clip plays, and every render, follow
// the shot list. The others keep their own keys until made active. Old scenes have the one.
function camerasField() {
  const name = h('input', { type: 'text', value: SC.camera.name || 'Camera', 'aria-label': 'Active camera name' });
  name.addEventListener('change', () => { SC.camera.name = name.value.trim() || SC.camera.name; changed(); });
  const clock = (f) => { const t = f / FPS; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const shotLine = (c) => shots().filter((s) => s.cam === c).map((s) => `Shot ${s.i} · ${clock(s.f0)}–${clock(s.f1 + 1)}`).join(', ');
  const here = shots().find((s) => R.f >= s.f0 && R.f <= s.f1);
  const row = (c, active) => h('div', { class: 'row cam-row wrap' },
    active ? name : h('span', { class: 'grow' }, c.name),
    h('span', { class: 'hint grow' }, shotLine(c) || (keyCount(c) ? `${keyCount(c)} keys` : '')),
    active ? h('span', { class: 'chip on' }, 'Active') : button('Make active', () => { setActiveCam(c); changed(); }, { title: `Look through ${c.name}` }),
    button('Cut here', () => { cutTo(c); changed(); toast(`Cut to ${c.name}`); }, { title: active ? 'Cut to this camera at the playhead (B)' : 'Cut to this camera at the playhead' }),
    active ? null : button('Delete', () => { SC.cams = SC.cams.filter((x) => x !== c); dropCuts((x) => x.cam === c.id); changed(); }, { cls: 'small danger', 'aria-label': `Delete ${c.name}` }));
  return field(['Cameras', info('The camera you edit is the active one: its moves, its gizmo, ◆ Key. The picture while the clip plays, and every render, follow the Shots row. Cut here writes a cut at the playhead. The first cut\'s camera is the shot from the start. New camera starts at the view you see in the director view, or a step behind the active camera.')],
    row(SC.camera, true),
    ...(SC.cams || []).map((c) => row(c, false)),
    here ? h('p', { class: 'hint' }, `Shot under the playhead: ${here.i} · ${here.cam.name}`) : null,
    button('New camera', addCamera,
      { title: 'A new camera, made active (Shift+C): at the view you see in the director view, else a step behind the active camera' }));
}
function addCamera() { const c = newCamera(); c.base = { ...c.base, ...newCameraPose() }; SC.cams.push(SC.camera); SC.camera = c; changed(); toast(`${c.name} is active`); }

// ---- Transform: a row per vector (Blender's N panel). Three boxes with their axis letter inside, coloured X red,
// Y (up) green, Z blue; typed, or held and pulled sideways at a steady rate (perPx: a metre per 100 px, a degree a px…;
// Shift on a mouse is finer); a double-tap puts one back (reset). ◀ ◆ ▶ key the row; lock: a chain that keeps the three
// in proportion (a change to one scales the others with it).
// ↺ beside the label puts the whole row back (reset).
//   vecRow(label, item, names, [[ch, letter, axis 'x'|'y'|'z', title?]], { min, max, step, digits, perPx, reset (a number, or one per channel), lock, carry })
//   lock: { get(), set(on) }; carry(patch) → the patch written (the camera's aim point going along with its position while aim is off)
function vecRow(label, item, names, ks, { min = -50, max = 50, step = 0.01, digits = 2, perPx = 0.01, reset = 0, lock = null, carry = (p) => p } = {}) {
  const cur = () => current(item, names);
  const put = (p) => write(item, names, carry(p));
  const setOne = (k, v) => {
    if (lock?.get()) {   // in proportion: every box by the same factor
      const c = cur(), f = c[k] ? v / c[k] : 1;
      if (Number.isFinite(f) && f > 0) return put(Object.fromEntries(ks.map(([ch]) => [ch, Math.max(min, Math.min(max, c[ch] * f))])));
    }
    put({ [k]: v });
  };
  const box = ([k, letter, axis, title]) => {
    const r = numSlider({ min, max, step, digits, value: cur()[k], label: `${label} ${title || letter}` });
    r.dataset.perpx = perPx;
    r.addEventListener('input', () => { if (r.dataset.scrubbing) { setOne(k, parseFloat(r.value)); syncMeshes(); pose(R.f); draw(); } });
    r.addEventListener('change', () => { setOne(k, parseFloat(r.value)); changed(); });
    const back = typeof reset === 'object' ? reset[k] : reset;
    r.addEventListener('dblclick', () => { r.blur(); put({ [k]: back }); changed(); });
    return h('label', { class: `vbox ax-${axis}`, title: `${title || letter} · double-tap: back to ${back}` }, h('b', {}, letter), r);
  };
  const el = field(label, h('div', { class: 'vec' }, ...ks.map(box)));
  const backs = ks.map(([k]) => (typeof reset === 'object' ? reset[k] : reset));
  withReset(el, `${label.replace(/ \(.*\)$/, '')} back to ${[...new Set(backs)].join(' ')}`, () => put(Object.fromEntries(ks.map(([k], i) => [k, backs[i]]))));
  if (lock) {
    const on = lock.get();
    const b = iconBtn(on ? 'Unlock proportions' : 'Lock proportions', '', () => { lock.set(!on); renderPanel(); });
    b.replaceChildren(icon(on ? 'link' : 'unlink')); b.classList.add('lock-btn'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    el.querySelector('.lbl > span').after(b);
  }
  return withKeys(el, label, item, names, ks.map(([k]) => k));
}
// a ↺ button beside a field's label: fn puts it back, then the scene saves and draws
function withReset(el, title, fn) {
  const b = iconBtn(title, '↺', () => { fn(); changed(); renderPanel(); }, { class: 'icon-btn reset-btn' });
  el.querySelector('.lbl > span')?.after(b);
  return el;
}
const camXYZ = (cam, label, ks, opts = {}) => vecRow(label, cam, CAM, ks, { min: -50, max: 50, ...opts });

// A camera with its aim off (cam.aim === false) has no point it looks at: moving it keeps the way it faces (the aim point goes along,
// unseen), and Pan and Tilt turn it. Pan 0 looks along -Z, positive turns left; Tilt positive looks up. The aim point stays the
// same distance ahead, so turning the aim back on picks up where it is.
const D2R = Math.PI / 180;
function panTilt(c) {
  const dx = c.tx - c.px, dy = c.ty - c.py, dz = c.tz - c.pz;
  return { pan: Math.atan2(-dx, -dz) / D2R, tilt: Math.atan2(dy, Math.hypot(dx, dz)) / D2R, d: Math.max(0.5, Math.hypot(dx, dy, dz)) };
}
function aimFrom(c, pan, tilt, d) {
  const a = pan * D2R, b = Math.max(-89.5, Math.min(89.5, tilt)) * D2R;
  return { tx: c.px - Math.sin(a) * Math.cos(b) * d, ty: c.py + Math.sin(b) * d, tz: c.pz - Math.cos(a) * Math.cos(b) * d };
}
function carryAim(cam) {
  return (p) => {
    if (cam.aim !== false) return p;
    const c = current(cam, CAM), out = { ...p };
    for (const [pk, tk] of [['px', 'tx'], ['py', 'ty'], ['pz', 'tz']]) if (pk in p) out[tk] = c[tk] + (p[pk] - c[pk]);
    return out;
  };
}

function cameraProps() {
  const cam = SC.camera, aim = cam.aim !== false;
  const mm = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);  // full-frame equivalent, from the vertical angle
  const fov0 = defaultScene().camera.base.fov;
  const turn = (k) => (v) => { const c = current(cam, CAM), t = panTilt(c); write(cam, CAM, aimFrom(c, k === 'pan' ? v : t.pan, k === 'tilt' ? v : t.tilt, t.d)); };
  // (the output size and the length are the frame's: the Output tab and the Frame pane's 3D section)
  return section('Camera', null,
    camerasField(),
    withReset(slider('Lens', () => current(cam, CAM).fov, (v) => write(cam, CAM, { fov: v }),
      { min: 12, max: 90, step: 0.5, fmt: (v) => `${Math.round(mm(v))} mm`, keys: [cam, CAM, ['fov']] }), `Lens back to ${Math.round(mm(fov0))} mm`, () => write(cam, CAM, { fov: fov0 })),
    camXYZ(cam, 'Position (m)', [['px', 'X', 'x'], ['py', 'Y', 'y', 'Y (up)'], ['pz', 'Z', 'z']], { carry: carryAim(cam) }),
    toggle('Aim at a point', aim, (on) => { if (on) delete cam.aim; else { cam.aim = false; setAimEdit(false); } changed(); renderPanel(); },
      { help: 'On, the camera always looks at its aim point: moving it turns it to keep looking there. Off, it keeps facing the way it does when it moves, and Pan and Tilt turn it.' }),
    aim ? [
      camXYZ(cam, 'Aims at (m)', [['tx', 'X', 'x'], ['ty', 'Y', 'y', 'Y (up)'], ['tz', 'Z', 'z']]),
      button(R.aimEdit ? '✓ Done moving the aim point' : 'Move the aim point', () => { setAimEdit(!R.aimEdit); renderPanel(); },
        { cls: `small${R.aimEdit ? ' on' : ''}`, title: 'The gizmo holds the point the camera looks at: drag it to set what the shot is on. Selecting a layer ends it.' }),
    ] : [
      withReset(slider('Pan', () => panTilt(current(cam, CAM)).pan, turn('pan'), { min: -180, max: 180, step: 0.5, fmt: (v) => `${v.toFixed(1)}°`, keys: [cam, CAM, ['tx', 'ty', 'tz']] }),
        'Pan back to 0°', () => turn('pan')(0)),
      withReset(slider('Tilt', () => panTilt(current(cam, CAM)).tilt, turn('tilt'), { min: -89.5, max: 89.5, step: 0.5, fmt: (v) => `${v.toFixed(1)}°`, keys: [cam, CAM, ['tx', 'ty', 'tz']] }),
        'Tilt back to 0° (level)', () => turn('tilt')(0)),
    ],
    withReset(slider('Roll', () => current(cam, CAM).roll, (v) => write(cam, CAM, { roll: v }),
      { min: -180, max: 180, step: 0.5, fmt: (v) => `${v.toFixed(1)}°`, keys: [cam, CAM, ['roll']],
        help: 'Tilts the camera around the way it looks. Positive banks it clockwise, so the picture turns anticlockwise. Key it to roll the view; motion tracking sets it from footage that turns.' }),
      'Roll back to 0°', () => write(cam, CAM, { roll: 0 })),
    easeSeg(cam),
    h('div', { class: 'row wrap' },
      clearKeys(cam, CAM),
      button('Reset view', () => { write(cam, CAM, { ...defaultScene().camera.base }); changed(); })),
    help('The view is the camera: drag empty space to orbit, two fingers to pan and zoom. With keys and Auto key on, each move sets a key at the playhead; with Auto key off it is only a look around until ◆ Key. Cut on the toolbar follows the shot list while the clip plays. While another camera is on show, a drag does not move this one.'));
}

// ---- the video's length: set here; 2–15 s, half seconds allowed. (A scene's old SC.lenMode is left as it is: unused.)
const LEN = [2, 15];
const fmtSecs = (v) => String(+Number(v).toFixed(2));
// a new length: keys after the end go, the playhead stays inside
function setLength(v) {
  SC.seconds = Math.round(clamp(v, ...LEN) * 100) / 100;
  const n = frames();
  for (const it of [...camsOf(), ...SC.objects]) dropKeys(it, (f) => f >= n);
  trimCuts(n);
  R.f = Math.min(R.f, n - 1);
}
const lengthChanged = () => { save(); refresh(); renderTransport(); renderPanel(); renderToolbar(); };
const animated = () => [...camsOf(), ...SC.objects];
const clampLen = (v) => Math.round(clamp(v, ...LEN) * 100) / 100;
// a new length; when it would cut keys off the end, ask first: stretch the animation to fit, or cut them
export function newLength(v) {
  const s = clampLen(v), cut = keysPast(animated(), framesFor(s)) + (SC.cuts || []).filter((c) => c.f >= framesFor(s)).length;
  if (!cut) { setLength(s); lengthChanged(); return; }
  openSheet(h('h3', {}, `Shorten to ${fmtSecs(s)} s?`),
    h('p', {}, `${cut} key${cut > 1 ? 's are' : ' is'} past ${fmtSecs(s)} s.`),
    actions(button('Cancel', () => { closeSheet(); renderPanel(); }),
      button('✂ Cut them', () => { closeSheet(); setLength(s); lengthChanged(); }, { cls: 'small danger' }),
      button('⇔ Stretch to fit', () => { closeSheet(); stretchTo(s); }, { cls: 'small primary' })));
}
// the whole animation stretched (or squeezed) to a new length, from frame 0: one undo step (the Frame pane's 3D section: stretchLength)
export function stretchTo(v) {
  const s = clampLen(v), before = clone(SC), ok = sameTab(), was = SC.seconds, from = frames();
  SC.seconds = s;
  stretchAll(animated(), from, frames());
  stretchCuts(from, frames());
  setLength(s); TEMP.clear();
  lengthChanged();
  undoToast(`Keys stretched ×${(s / was).toFixed(2)} to ${fmtSecs(s)} s`, () => {
    if (!ok()) return;
    setSC(before); R.f = Math.min(R.f, frames() - 1); TEMP.clear(); lengthChanged();
  });
}
// which videos the Render popup makes, one after another
const KINDS = [['depth', 'Depth video', renderDepthVideo], ['pose', 'Pose video', renderPoseVideo], ['colour', 'Colour video', renderColorVideo]];
const kindsOn = () => { const k = store.get('deck.scene.renderkinds', ['depth']); return Array.isArray(k) && k.length ? k : ['depth']; };
// the Render popup's ticks, as the Frame pane's 3D section reads and sets them (frame-scene.js)
export const renderKinds = () => kindsOn();
export function setRenderKinds(kinds) {
  const k = (kinds || []).filter((x) => KINDS.some(([id]) => id === x));
  store.set('deck.scene.renderkinds', k.length ? k : ['depth']);
}
export const RENDER_KINDS = KINDS.map(([id, label]) => [id, label]);
export const LENGTHS = LEN;

// Where the Render section's output goes. A 3D frame on the table sets these while it is open (frame-scene.js): rendered(gens)
// gets the videos one Render made, saved(picture, kind) a Save frame / depth / pose picture ('frame' | 'depth' | 'pose').
// Null (the 3D tab): they stay in History and the project's pictures.
export const OUT = { rendered: null, saved: null };

// The videos of kinds ('depth' | 'pose' | 'colour', default the Render popup's ticks) rendered one after another over the
// current scene: the generations they made (a cancelled or failed one stops the rest; what was made before it is kept)
export async function renderVideos(kinds = kindsOn()) {
  const figs = SC.objects.some((o) => o.type === 'figure' && !o.hidden);
  const todo = KINDS.filter(([k]) => kinds.includes(k) && (k !== 'pose' || figs));
  const made = RENDERED.list = [];
  try {
    for (const [, , fn] of todo) if (!await fn()) break;
  } finally { RENDERED.list = null; renderPanel(); }
  return made;
}
async function saveFrame() {
  const r = await saveFramePic();
  if (r) OUT.saved?.(r, 'frame');
  return r;
}
async function saveStill(kind) {
  const r = await saveStillPic(kind);
  if (r) OUT.saved?.(r, kind);
  return r;
}

function openRender() {
  const figs = SC.objects.some((o) => o.type === 'figure' && !o.hidden);
  const on = kindsOn().filter((k) => k !== 'pose' || figs);
  const flip = (k, v) => { const next = KINDS.map(([x]) => x).filter((x) => (x === k ? v : on.includes(x))); store.set('deck.scene.renderkinds', next); openRender(); };
  const go = async () => {
    if (!on.length) return toast('Tick at least one video to render', true);
    closeSheet();
    const to = OUT.rendered, gens = await renderVideos(on);
    if (gens.length) to?.(gens);
  };
  openSheet(h('h3', {}, 'Render'),
    help('Tick what to render. They run one after another over the same shot, and a cancelled or failed one stops the rest.'),
    field('Videos', h('div', { class: 'row wrap' }, ...KINDS.filter(([k]) => k !== 'pose' || figs).map(([k, l]) => toggle(l, on.includes(k), (v) => flip(k, v))))),
    field('Render', seg([['take', 'One take'], ['each', 'Each shot']], SC.renderShots === 'each' ? 'each' : 'take', (v) => { SC.renderShots = v; save(); }),
      help('One take is a single video, with the cuts in it. Each shot renders one video per shot.')),
    h('div', { class: 'row wrap' }, AREA.onlyToggle()),   // (Range only: the key sheet's work area)
    on.includes('depth') ? section('Depth', null,
      field(['Depth range', info('Follow the shot: each moment gets its own near and far (eased over about a second), so the depth keeps its contrast when the camera travels. A cut starts that range again. Whole clip: one near and far for the whole clip (steady greys, but a long camera move squeezes part of it into a few greys, and depth control lets go there).')],
        seg([['follow', 'Follow the shot'], ['clip', 'Whole clip']], SC.depthRange === 'clip' ? 'clip' : 'follow', (v) => { SC.depthRange = v; save(); })),
      field(['Depth from', info('The 3D shapes: depth worked out exactly from the objects and from each splat\'s points (Splat blur closes the gaps between them). The picture: the shot is rendered in colour first (splats at their full set, everything in view) and Video Depth Anything estimates its depth, which is smoother on a splat, but it is an estimate and takes longer. Both: the picture\'s depth, with the 3D objects\' exact depth laid over it.')],
        seg([['geometry', '3D shapes'], ['picture', 'The picture'], ['combo', 'Both']], SC.depthFrom || 'geometry', (v) => { SC.depthFrom = v; save(); })),
      SC.objects.some((o) => o.type === 'splat') && (SC.depthFrom || 'geometry') !== 'picture' ? withHelp(slider('Splat blur', () => SC.splatBlur ?? SPLAT_BLUR, (v) => { SC.splatBlur = v; }, { min: 0, max: 16, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
        'Blurs only the splats, before they join the rest of the depth, and closes the gaps between their points. More makes a patchy splat smooth, and blends what is in front of it into what is behind.') : null,
      slider('Soften edges', () => SC.blur, (v) => { SC.blur = v; }, { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} px` : 'off') }),
      help('Blurs the depth so H3 copies the shapes less literally. Use with deck-h3-ctrl2v (strength 1, end 0.4).')) : null,
    on.includes('pose') ? section('Pose', null,
      h('div', { class: 'row wrap' }, ...[['poseHands', 'Hands'], ['poseFace', 'Face points']].map(([k, l]) => toggle(l, SC[k] !== false, (v) => { SC[k] = v; save(); })))) : null,
    actions(button('Cancel', closeSheet), button(`Render ${on.length > 1 ? on.length + ' videos' : 'video'}`, go, { cls: 'primary', disabled: !on.length })));
}

// the panel's Render area: one big button (options live in its popup), a still, and the finished videos
// A setup of the scene's output (setups.js scene:out): how the prompts name and write things, and how renders are made
const OUT_SC = ['renderShots', 'depthRange', 'depthFrom', 'splatBlur', 'blur', 'poseHands', 'poseFace'];
function outValues() {
  const v = { promptNames: !!R.promptNames, shotFmt: R.shotFmt, renderKinds: kindsOn() };
  for (const k of OUT_SC) v[k] = SC[k] ?? null;
  return v;
}
function setOutValues(v) {
  if ('promptNames' in v) R.promptNames = !!v.promptNames;
  if (v.shotFmt) { R.shotFmt = v.shotFmt === 'ltx' ? 'ltx' : 'h3'; store.set('deck.scene.shotfmt', R.shotFmt); }
  if (Array.isArray(v.renderKinds)) store.set('deck.scene.renderkinds', v.renderKinds);
  for (const k of OUT_SC) if (k in v) { if (v[k] == null) delete SC[k]; else SC[k] = v[k]; }
  save(); renderPanel();
}

export function renderProps() {
  return section('Render', null,
    setupsRow({ key: sceneKey('out'), label: 'Setup', get: outValues, set: setOutValues }),
    busy ? button('✕ Cancel render', cancelRender, { cls: 'danger big-btn', title: 'Stop the render: nothing is saved' })
      : button('🎬 Render…', openRender, { cls: 'primary big-btn', title: 'Pick which videos to render (depth, pose, colour) and how' }),
    h('div', { class: 'row wrap' }, button('📷 Save frame', saveFrame, { title: 'Save this frame (Shift+S)' }),
      button('Save depth frame', () => saveStill('depth'), { disabled: busy, title: 'The depth of this frame, kept as a picture to use as a reference' }),
      SC.objects.some((o) => (o.type === 'figure' || o.type === 'rigged') && !o.hidden)
        ? button('Save pose frame', () => saveStill('pose'), { disabled: busy, title: 'The posable people of this frame as OpenPose stick figures, kept as a picture' }) : null),
    h('p', { id: 'sceneStatus', class: 'hint' }, statusText));
}

// a double-click on a blank scene: what can be added
addEventListener('dblclick', (e) => { if (e.target.id === 'sceneCanvas' && !SC.objects.length && !SC.room) openAdd(); });
async function openAdd() {
  const { attachedPictures, importButton, openObjectSheet } = await import('./scene-import.js');   // (scene-view imports this panel: no top-level import)
  const { addGroups, filterGroups } = await import('./object-rules.js');
  const picture = (title, mpKey, run) => { closeSheet(); C.openImagePicker({ title, ...(mpKey && { mpKey }), onPick: run }); };
  const run = {
    object: () => { closeSheet(); openObjectSheet(); },
    photo3d: () => picture('Picture to turn into 3D', '3d', makePhoto),
    sharp: () => picture('Picture to turn into a splat', '3d', makeSplatHere),
    background: () => picture('Background picture', null, addPicture),
    room: () => addObject(ROOM),
  };
  const groups = addGroups(TYPES, { room: !!SC.room, attached: attachedPictures(), bodies: FIGURE.BODIES });
  const list = h('div', { class: 'add-groups' });
  const draw = (q) => {
    const found = filterGroups(groups, q);
    list.replaceChildren(...(found.length ? found.map((g) => h('section', {}, h('h4', { class: 'wp-head' }, g.title),
      h('div', { class: 'chips' }, g.items.map((i) => chip(`${i.icon} ${i.label}`, () => (run[i.id] ? run[i.id]() : addObject(i.id, i.body ? { body: i.body } : undefined)), i.tip)))))
      : [hint('Nothing by that name')]));
  };
  const find = h('input', { type: 'search', class: 'wp-find', placeholder: 'Find', 'aria-label': 'Find something to add', oninput: (e) => draw(e.target.value) });
  draw('');
  openSheet(h('h3', {}, 'Add to the scene'), find,
    h('div', { class: 'row wrap' }, importButton(), help('Import takes glb, gltf, fbx, obj (with its .mtl and textures) or a splat: ply, splat, ksplat, spz. You can also drop the files on the 3D view.')),
    list);
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => find.focus(), 30);
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
  for (const o of SC.objects) if (o.type === 'splat') boxHost.changed(o);   // (its trim as it was: the mesh keeps what it was last told)
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
  el.replaceChildren(...modeList().map((m, i) => h('button', { type: 'button', class: m.key === cur ? 'on' : '', title: `${m.hint || m.label} (${i + 1})`,
    'aria-label': m.label, 'aria-pressed': m.key === cur, 'data-scene-mode': m.key, onclick: () => setSceneMode(m.key) }, iconize(m.icon))));
}

// the panel: the mode's own contents, then whatever has been plugged into that mode (addModeSection)
if (typeof addEventListener === 'function') addEventListener('layers:float', () => { if (SC) renderPanel(); });
export function renderPanel() {
  const body = SCN.body;
  if (!body || !SC) return;
  const def = modeOf();
  if (layersFloating()) layerListPart('scene', layerList());   // (in its floating panel, in every mode)
  body.replaceChildren(h('div', { class: 'panel-body' }, def.panel(), modeSections(def.key).map((build) => build()), def.out?.()));
}

export function editPanel() {
  return [
    panelTop(button('+ Add', openAdd, { cls: 'primary', title: 'Add to the scene (Shift+A)' }), SC.objects.length || SC.room ? () => {
      const before = clone(SC), ok = sameTab();
      SC.objects = []; SC.room = null; R.sel = null; rebuildRoom(); changed(); renderToolbar();
      undoToast('Scene cleared (the camera stays)', () => { if (ok()) { setSC(before); rebuildRoom(); changed(); } });
    } : null),
    layerListPart('scene', layerList()),
    selItem() ? objectProps(selItem()) : R.sel === ROOM && SC.room ? roomProps() : cameraProps()];
}
// what the scene makes, last in the panel (after the reference and imports)
export const editOut = () => [promptProps(), shotProps(), renderProps()];

// the camera on its own: seen through its lens (orbiting writes its keys), or from a free view of the room
export function cameraPanel() {
  return [
    section('View', null,
      seg([['shot', '🎥 Through the camera'], ['free', '🧭 Director view']], R.free ? 'free' : 'shot', (v) => { setFree(v === 'free'); renderPanel(); }),
      R.free ? [help('Look around freely: the camera is drawn as a frustum and orbiting here leaves it alone. Set the camera from what you see when it is framed.'),
        button('🎥 Camera to this view', camToView, { title: 'Move the active camera to exactly this view, lens included (C)' })]
        : help('You see what the camera sees: drag empty space to orbit it, two fingers to pan and zoom.')),
    cameraProps()];
}


// through the camera / the director view, from the view itself (Edit scene and Camera)
function toggleFree() {
  if (modeOf().view === 'free') return;
  setFree(!R.free); renderPanel();
}
// the active camera to exactly what the director view shows (the view's button, the panel's, C)
const canCamToView = () => R.free && !!modeOf().frustum;
function camToView() {
  if (!canCamToView()) { toast('Go to the director view first (V)', true); return; }
  cameraFromView(); changed();
  toast(TEMP.has(SC.camera) ? `${SC.camera.name || 'Camera'} moved here: press ◆ Key (J) to keep it, Auto key is off` : `${SC.camera.name || 'Camera'} moved to this view`);
}

// ---- the view's tool bar: the transform tools fade in when something can be moved (contextual), the view's
// overlays (depth, reference, scale person) are one menu, the director view a button. H hides every tool over the
// view (the HUD); N, in full screen, pulls the settings panel in and out (Blender's N).
export function buildToolbar() {
  viewer.append(h('div', { id: 'sceneToolbar', class: 'layer-toolbar scene-toolbar', role: 'toolbar', 'aria-label': 'Gizmo' },
    h('span', { class: 'tb-group ctx', 'data-ctx': 'transform' },
    ...MODES.map(([m, icon, key, name]) => h('button', { type: 'button', class: 'ico', 'data-mode': m, title: `${name} (${key.toUpperCase()})`,
      'aria-label': name, onclick: () => setMode(m) }, iconize(icon))),
    h('button', { type: 'button', class: 'ico', 'data-orient': '', onclick: () => setOrient(nextOrient(R.orient)) }),
    h('button', { type: 'button', class: 'ico', 'data-origin': '', 'aria-label': 'Edit origin and axes', onclick: () => setOriginEdit(!originEditing()),
      title: 'Edit origin and axes (Y): Move drags its origin, Rotate turns its axes, and the layer stays where it is' }, icon('target')),
    h('button', { type: 'button', class: 'ico', 'data-face': '', 'aria-label': 'Face the camera', onclick: () => { const o = selItem(); if (o) faceCamera(o); },
      title: 'Face the camera (T): its front (+Z) turns to the camera' }, icon('person')),
    h('button', { type: 'button', class: 'ico', 'data-pivot': '', 'aria-label': 'Pivot at the view centre', onclick: pivotToView,
      title: 'Pivot at the view centre: turn and scale around where the middle of the view meets it (until Reset or another pick)' }, icon('pivot-view')),
    h('button', { type: 'button', class: 'ico hidden', 'data-pivot-reset': '', 'aria-label': 'Reset pivot', onclick: resetPivot,
      title: 'Reset pivot: back to its own (Pivot in the panel)' }, icon('pivot-reset')),
    h('span', { class: 'sep' })),
    h('button', { type: 'button', class: 'ico hidden', 'data-selcam': '', 'aria-label': 'Select the camera', title: 'Select the camera (Esc): in the director view its gizmo comes on; tapping its outline does the same', onclick: () => select(null) }, icon('video')),
    h('button', { type: 'button', class: 'ico', 'data-free': '', 'aria-label': 'Director view', onclick: toggleFree }, icon('compass')),
    h('button', { type: 'button', class: 'ico hidden', 'data-camview': '', 'aria-label': 'Camera to this view', title: 'Camera to this view: move the active camera to exactly what you see, lens included (C)', onclick: camToView }, icon('camera')),
    h('button', { type: 'button', class: 'ico hidden', 'data-pip': '', 'aria-label': 'Mini camera view', title: 'Mini camera view (M): what the camera sees, in a box you can drag and resize',
      onclick: () => { togglePip(); renderToolbar(); } }, icon('image')),
    h('button', { type: 'button', class: 'ico', 'data-viewcut': '', 'aria-label': 'View cuts',
      onclick: () => { R.viewCut = !R.viewCut; store.set('deck.scene.viewcut', R.viewCut); pose(R.f); draw(); renderToolbar(); } }, 'Cut'),
    h('button', { type: 'button', class: 'ico', 'data-overlays': '', 'aria-label': 'Overlays', title: 'Overlays: depth, reference picture, scale person',
      onclick: (e) => overlayMenu(e.currentTarget) }, icon('contrast'))));
  wirePip({ viewer, canvas: SCN.canvas, draw, aspect: () => SC.width / SC.height });
  viewer.append(h('button', { type: 'button', class: 'max-btn hud-btn', id: 'sceneHud', onclick: () => setHud(!hudOff()) }));
  setHud(hudOff());
  // Undo / Redo: the app's dock (undo-dock.js), in the top bar and over the full-screen view
  registerUndo('scene', { undo: () => undo(), redo: () => undo(false), can: () => [HIST.undo.length > 0, HIST.redo.length > 0], sig: () => HIST.cur });
  viewer.append(maxBar(), h('div', { id: 'sceneModeBar', class: 'layer-toolbar scene-modebar', role: 'toolbar', 'aria-label': 'Mode' }));
}

// the view's overlays, in one menu
function overlayMenu(anchor) {
  popover(anchor, h('b', {}, 'Overlays'),
    toggle('Depth: what the render will use', R.depth, (on) => { R.depth = on; draw(); renderToolbar(); }),
    SC.ref ? toggle('Reference over the view', SC.ref.on !== false, () => { toggleRef(); }) : button('🖼 Reference picture…', () => { closePopover(); toggleRef(); }, { cls: 'small ghost' }),
    toggle('Scale person (1.8 m, only in the view)', scaleRefOn(), (on) => { setScaleRef(on); renderToolbar(); }),
    h('span', { class: 'hint' }, 'H hides every tool over the view; N pulls the panel out in full screen.'));
}

// the one-key commands (scene-shortcuts.js). Those for the key sheet do nothing where it is hidden (Create object).
const hasSheet = () => modeOf().lanes !== 'none';
const COMMAND = {
  faceCam: () => { const o = selItem(); if (o) faceCamera(o); },
  originEdit: () => { if (selItem() && !R.joint) setOriginEdit(!originEditing()); },
  camToView,
  pip: () => { if (R.free) { togglePip(); renderToolbar(); } },
  newCamera: () => { if (hasSheet()) addCamera(); },
  viewCut: () => $('#sceneToolbar [data-viewcut]')?.click(),
  cutHere: () => { if (!hasSheet()) return; cutTo(SC.camera); changed(); toast(`Cut to ${SC.camera.name || 'Camera'}`); },
  addKey: () => { if (hasSheet()) keyHere(); },
  delKey: () => { if (hasSheet()) unkeyHere(); },
  add: () => { setSceneMode('edit'); openAdd(); },
  duplicate: () => { const o = selItem(); if (o) duplicateObject(o); },
  gridSnap: () => toast(`Grid snapping ${toggleGrid3() ? 'on' : 'off'}`),
  fullScreen: () => maxBar().click(),
  saveFrame,
  mode1: () => setSceneMode(modeList()[0]?.key),
  mode2: () => setSceneMode(modeList()[1]?.key),
  mode3: () => setSceneMode(modeList()[2]?.key),
  keysHelp: () => popover($('#sceneToolbar'), h('b', {}, 'Keyboard shortcuts'),
    h('div', { style: 'display:grid;gap:8px;max-height:calc(100vh - 150px);overflow:auto' },
      ...keysList().map(([group, keys]) => h('div', {}, h('b', {}, group), ...keys.map((k) => h('div', { class: 'hint' }, k)))))),
};

// the HUD: every tool over the view, hidden or shown (kept per device)
const HUD = 'deck.scene.hudOff';
const hudOff = () => store.get(HUD, false) === true;
function setHud(off) {
  store.set(HUD, !!off);
  SCN.host.classList.toggle('hud-off', !!off);
  const b = $('#sceneHud');
  if (b) {
    b.replaceChildren(icon(off ? 'eye' : 'eyeoff'));
    b.title = off ? 'Show the tools over the view (H)' : 'Hide the tools over the view (H)';
    b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(!!off));
  }
}

// the engine moved to another host (scene.js mountScene): the HUD's state goes with it
export function syncHud(was) {
  if (was && was !== SCN.host) was.classList.remove('hud-off');
  setHud(hudOff());
}

export function wireKeys() {
  wireSheetKeys();
  // the panel's sliders, number boxes and buttons while it plays: held over the keys from touch to letting go
  // (a moment after, so the slider's change and the button's click are part of the hold)
  document.addEventListener('pointerdown', (e) => { if (SCN.body?.contains(e.target)) holdStart('panel'); }, true);
  const up = () => setTimeout(() => letGo('panel'));
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  document.addEventListener('keydown', (e) => {
    if (!SCN.active() || sheetOpen()) return;
    // (Undo: unless the control with the focus uses the key itself, key-focus.js: a slider just dragged doesn't)
    if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase()) && !e.altKey && !ownsKey(e)) {
      e.preventDefault(); undo(e.key.toLowerCase() === 'z' && !e.shiftKey);
      return;
    }
    if (e.target.closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {   // (the key sheet with the keys has taken it first: wireSheetKeys)
      e.preventDefault();
      if (R.joint) selectJoint(null); else select(null);
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const command = commandFor(e);
    if (command) { e.preventDefault(); COMMAND[command](); return; }
    const m = MODES.find(([, , k]) => k === e.key.toLowerCase());
    if (m) { e.preventDefault(); setMode(m[0]); }
    else if (e.key.toLowerCase() === 'k') { e.preventDefault(); setAutoKey(!R.autoKey); }
    else if (e.key.toLowerCase() === 'v') { e.preventDefault(); toggleFree(); }
    else if (e.key.toLowerCase() === 'h') { e.preventDefault(); setHud(!hudOff()); }
    else if (e.key.toLowerCase() === 'n') { const p = SCN.host.querySelector('.stage.maxed .pull-tab'); if (p) { e.preventDefault(); p.dispatchEvent(new MouseEvent('click', { bubbles: true })); } }
    else if (e.key.toLowerCase() === 'q') { e.preventDefault(); setOrient(nextOrient(R.orient)); toast(`Gizmo axes: ${orientLabel()}`); }
    else if (e.key === 'Escape') {   // (marked handled when it let go of something: a table's Esc then leaves the frame live)
      const used = HAND.on || (R.boxEdit && R.boxEdit === R.sel) || originEditing() || !!R.joint || R.sel != null;
      if (HAND.on) handMode(null); else if (R.boxEdit && R.boxEdit === R.sel) setBoxEdit(false); else if (originEditing()) setOriginEdit(false); else if (R.joint) selectJoint(null); else select(null);
      if (used) e.preventDefault();
    }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel) { e.preventDefault(); removeSelected(); }
    else if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key.toLowerCase() === 'p') { e.preventDefault(); stopPlay(); seek(AREA.stored()?.a ?? 0); play(); }   // from the start of the range
    else if (e.key === ',' || e.key === '.') { e.preventDefault(); stopPlay(); seek(R.f + (e.key === '.' ? 1 : -1)); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {  // a frame; with Shift, to the start / end (Blender)
      e.preventDefault(); stopPlay();
      const fwd = e.key === 'ArrowRight';
      if (e.shiftKey) { if (fwd) toEnd(); else toStart(); } else seek(R.f + (fwd ? 1 : -1));
    }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); jumpKey(e.key === 'ArrowUp' ? 1 : -1); }   // the next / previous key
    else if (e.key === 'Home') { e.preventDefault(); toStart(); }
    else if (e.key === 'End') { e.preventDefault(); toEnd(); }
  });
}
