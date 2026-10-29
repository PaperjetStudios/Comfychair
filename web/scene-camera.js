// Camera moves: a grid of ready-made moves (dolly, truck, pan, orbit, crane, zoom, shake...) for the
// camera in Camera mode. A move writes camera keys from the playhead in the scene's own key format:
// a start key (the camera as it is) and an end key (the camera moved), the start key carrying the
// easing; a shake writes a key every few frames. Plugged into the Camera mode's panel with addModeSection.
import * as THREE from './vendor/three.module.min.js';
import { button, clone, field, h, numField, section, seg, toast , help, toggle } from './ui.js';
import { CAM, FPS, OBJ, R, SC, TEMP, current, dropKeys, frames, putKeys, sample, selItem } from './scene-data.js';
import { changed, draw, pose } from './scene-view.js';
import { renderKeys, renderPanel, renderTime, renderTransport } from './scene-ui.js';
import { seek } from './scene-export.js';
import { addModeSection } from './scene-modes.js';

// ---- the moves: [id, label, icon paths (24 grid), what the amount is] ----
const A = (label, unit, def, min, max, step) => ({ k: 'a', label, unit, def, min, max, step });
const LENS = (def) => ({ k: 'lens', label: 'Lens change', unit: '%', def, min: 0, max: 50, step: 5 });
export const MOVES = [
  ['dolly-in', 'Dolly in', ['M12 20V5', 'M6.5 10.5L12 5l5.5 5.5'], [A('Distance', 'm', 2, 0.1, 15, 0.1)]],
  ['dolly-out', 'Dolly out', ['M12 4v15', 'M6.5 13.5L12 19l5.5-5.5'], [A('Distance', 'm', 2, 0.1, 15, 0.1)]],
  ['push-in', 'Push in', ['M12 20V8', 'M7.5 12L12 7.5l4.5 4.5', 'M6 4h12'], [A('Distance', 'm', 1, 0.1, 15, 0.1), LENS(15)]],
  ['pull-out', 'Pull out', ['M12 4v12', 'M7.5 12L12 16.5l4.5-4.5', 'M6 20h12'], [A('Distance', 'm', 1, 0.1, 15, 0.1), LENS(15)]],
  ['truck-left', 'Truck left', ['M20 12H5', 'M10.5 6.5L5 12l5.5 5.5'], [A('Distance', 'm', 2, 0.1, 15, 0.1)]],
  ['truck-right', 'Truck right', ['M4 12h15', 'M13.5 6.5L19 12l-5.5 5.5'], [A('Distance', 'm', 2, 0.1, 15, 0.1)]],
  ['pedestal-up', 'Pedestal up', ['M12 18V5', 'M6.5 10.5L12 5l5.5 5.5', 'M5 21h14'], [A('Height', 'm', 1, 0.1, 6, 0.1)]],
  ['pedestal-down', 'Pedestal down', ['M12 6v13', 'M6.5 13.5L12 19l5.5-5.5', 'M5 3h14'], [A('Height', 'm', 1, 0.1, 6, 0.1)]],
  ['pan-left', 'Pan left', ['M20 16A9 9 0 0 0 4 11', 'M4 11V6', 'M4 11h5'], [A('Angle', '°', 30, 1, 180, 1)]],
  ['pan-right', 'Pan right', ['M4 16A9 9 0 0 1 20 11', 'M20 11V6', 'M20 11h-5'], [A('Angle', '°', 30, 1, 180, 1)]],
  ['tilt-up', 'Tilt up', ['M6 18A9 9 0 0 1 17 6', 'M17 6h-5', 'M17 6v5'], [A('Angle', '°', 20, 1, 80, 1)]],
  ['tilt-down', 'Tilt down', ['M6 6a9 9 0 0 0 11 12', 'M17 18h-5', 'M17 18v-5'], [A('Angle', '°', 20, 1, 80, 1)]],
  ['orbit-left', 'Orbit left', ['M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4-3.6-4-8-4c-2 0-3.8.4-5.2 1', 'M6.8 6l-.2 3.4 3.3.6'], [A('Angle', '°', 60, 1, 360, 1)]],
  ['orbit-right', 'Orbit right', ['M20 12c0 2.2-3.6 4-8 4s-8-1.8-8-4 3.6-4 8-4c2 0 3.8.4 5.2 1', 'M17.2 6l.2 3.4-3.3.6'], [A('Angle', '°', 60, 1, 360, 1)]],
  ['crane-up', 'Crane up', ['M4 21h6', 'M7 21V9l10-4', 'M18 15V9', 'M15.5 11.5L18 9l2.5 2.5'], [A('Height', 'm', 2, 0.1, 8, 0.1)]],
  ['crane-down', 'Crane down', ['M4 21h6', 'M7 21V8l10 4', 'M18 8v6', 'M15.5 11.5L18 14l2.5-2.5'], [A('Height', 'm', 2, 0.1, 8, 0.1)]],
  ['zoom-in', 'Zoom in', ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20', 'M8 10.5h5', 'M10.5 8v5'], [A('Zoom', '×', 1.6, 1.1, 4, 0.1)]],
  ['zoom-out', 'Zoom out', ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20', 'M8 10.5h5'], [A('Zoom', '×', 1.6, 1.1, 4, 0.1)]],
  ['dolly-zoom', 'Dolly zoom', ['M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'], [A('Dolly in', 'm', 2, -10, 10, 0.1)]],
  ['shake', 'Handheld shake', ['M3 12l3-5 3 10 3-10 3 10 3-5h3'], [A('Strength', '', 1, 0.2, 4, 0.1)]],
];
export const EASE_OPTS = [['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['smooth', 'In-out']];
const LIMITS = { fov: [12, 90], pitch: 85 };   // the lens slider's range; looking straight up or down turns the view over

// ---- the math: the camera after a move (pure; values are the camera's keys px..roll) ----
const up = new THREE.Vector3(0, 1, 0);
const rad = THREE.MathUtils.degToRad, clampN = THREE.MathUtils.clamp;
const vec = (c, a, b, c2) => new THREE.Vector3(c[a], c[b], c[c2]);
const tanH = (fov) => Math.tan(rad(fov) / 2);
const fovFrom = (t) => (2 * Math.atan(t) * 180) / Math.PI;

// c: the camera now; p: { a, lens }; q: the point an orbit goes around ([x, z], else where the camera looks)
export function moved(c, id, p, q = null) {
  const P = vec(c, 'px', 'py', 'pz'), T = vec(c, 'tx', 'ty', 'tz'), f = T.clone().sub(P), d = f.length();
  f.normalize();
  const flat = f.clone().setY(0);   // a dolly rolls along the floor, not down the line of sight
  if (flat.lengthSq() < 1e-6) flat.copy(f);
  flat.normalize();
  const right = new THREE.Vector3().crossVectors(f, up);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  let fov = c.fov;
  const a = p.a, s = id.endsWith('-in') || id.endsWith('-up') || id.endsWith('-right') ? 1 : -1;
  const shift = (v) => { P.add(v); T.add(v); };
  switch (id) {
    case 'dolly-in': case 'dolly-out': shift(flat.clone().multiplyScalar(a * s)); break;
    case 'push-in': case 'pull-out':
      shift(flat.clone().multiplyScalar(a * s)); fov = clampN(fov * (1 - s * (p.lens ?? 15) / 100), ...LIMITS.fov); break;
    case 'truck-left': case 'truck-right': shift(right.clone().multiplyScalar(a * s)); break;
    case 'pedestal-up': case 'pedestal-down': shift(new THREE.Vector3(0, Math.max(0.1, P.y + a * s) - P.y, 0)); break;
    case 'pan-left': case 'pan-right': {
      // +angle about up turns the view to the left
      const g = f.clone().applyAxisAngle(up, rad(a) * (id === 'pan-left' ? 1 : -1));
      T.copy(P).addScaledVector(g, d); break;
    }
    case 'tilt-up': case 'tilt-down': {
      const pitch = Math.asin(clampN(f.y, -1, 1)), to = clampN(pitch + rad(a) * (id === 'tilt-up' ? 1 : -1), -rad(LIMITS.pitch), rad(LIMITS.pitch));
      T.copy(P).addScaledVector(f.clone().applyAxisAngle(right, to - pitch), d); break;
    }
    case 'orbit-left': case 'orbit-right': {
      // +angle about up carries the camera to its right; both it and its aim turn around the point, so framing holds
      const Q = q ? new THREE.Vector3(q[0], 0, q[1]) : T.clone().setY(0), r = rad(a) * (id === 'orbit-right' ? 1 : -1);
      for (const v of [P, T]) { const y = v.y; v.sub(Q).setY(0).applyAxisAngle(up, r).add(Q).setY(y); }
      break;
    }
    case 'crane-up': case 'crane-down': P.y = Math.max(0.1, P.y + a * (id === 'crane-up' ? 1 : -1)); break;   // the aim stays: it tips down as it rises
    case 'zoom-in': case 'zoom-out': fov = clampN(fovFrom(tanH(fov) / (s > 0 ? a : 1 / a)), ...LIMITS.fov); break;
    case 'dolly-zoom': {   // what it looks at keeps its size on screen while the room stretches
      const d2 = Math.max(0.5, d - a);
      fov = clampN(fovFrom((d * tanH(fov)) / d2), ...LIMITS.fov);
      P.copy(T).addScaledVector(f, -(d * tanH(c.fov)) / tanH(fov)); break;
    }
    default: throw new Error(`no move ${id}`);
  }
  return { px: P.x, py: P.y, pz: P.z, tx: T.x, ty: T.y, tz: T.z, fov, roll: c.roll || 0 };   // (a move leaves the roll as it was)
}

// a small repeatable noise (mulberry32) so a shake looks the same each time it is made
const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// the camera shaken: a hand's wobble of the camera (a centimetre or so) and of its aim (a fraction of a degree)
export function shaken(c, k, strength, rnd) {
  const P = vec(c, 'px', 'py', 'pz'), T = vec(c, 'tx', 'ty', 'tz'), f = T.clone().sub(P), d = f.length();
  f.normalize();
  const right = new THREE.Vector3().crossVectors(f, up).normalize(), u = new THREE.Vector3().crossVectors(right, f);
  const n = () => (rnd() * 2 - 1) * k * strength;
  P.addScaledVector(right, n() * 0.015).addScaledVector(u, n() * 0.015);
  T.addScaledVector(right, n() * d * 0.006).addScaledVector(u, n() * d * 0.006);
  return { px: P.x, py: P.y, pz: P.z, tx: T.x, ty: T.y, tz: T.z, fov: c.fov, roll: c.roll || 0 };
}

// ---- writing keys: whole-camera values at a frame, keyed on the channels that go anywhere (putKeys) ----
const SHAKE_STEP = 4;   // frames between a shake's keys

// Write a move onto cam from frame f0 to f1: the start key is the camera now, the end key the camera
// moved; keys between them are replaced (a shake bakes the camera's own motion in and shakes it).
// Returns false if there is no room.
export function writeMove(cam, id, p, { f0, f1, ease, around = null }) {
  if (f1 <= f0) return false;
  const start = current(cam, CAM, f0);
  TEMP.delete(cam);
  if (id === 'shake') {
    const fs = [];
    for (let f = f0; f < f1; f += SHAKE_STEP) fs.push(f);
    fs.push(f1);
    const base = fs.map((f) => current(cam, CAM, f)), rnd = rng(f0 * 977 + f1);
    dropKeys(cam, (f) => f >= f0 && f <= f1);
    putKeys(cam, fs.map((f, i) => {   // it builds up and dies away over the first and last fifth
      const t = (f - f0) / (f1 - f0), env = Math.min(1, t / 0.2, (1 - t) / 0.2);
      return { f, ...shaken(base[i], Math.max(0, env), p.a, rnd), ease: 'smooth' };
    }), CAM);
  } else {
    const end = moved(start, id, p, around);
    dropKeys(cam, (f) => f > f0 && f < f1);
    putKeys(cam, [{ f: f0, ...start, ease }, { f: f1, ...end }], CAM);
  }
  let mark = null;   // the shot list prefers this over guessing the move (a zoom may not key position)
  for (const list of Object.values(cam.chans || {})) { const k = list.find((x) => x.f === f0); if (k) { mark = k; break; } }
  if (mark) mark.mv = id;
  return true;
}

// ---- the panel ----
const ST = { id: 'dolly-in', vals: {}, secs: null, ease: 'smooth', fromHead: true, around: '' };
const val = (m) => Object.fromEntries(m[3].map((x) => [x.k, ST.vals[`${m[0]}.${x.k}`] ?? x.def]));
const NS = 'http://www.w3.org/2000/svg';
function icon(paths) {   // (built with the DOM, no innerHTML)
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', class: 'cam-ico', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}

// where the move starts and ends: from the playhead (else the start of the scene), as long as asked, as far as the scene goes
function span() {
  const f0 = ST.fromHead ? R.f : 0, secs = ST.secs ?? Math.min(3, SC.seconds);
  const want = Math.max(1, Math.round(secs * FPS)), f1 = Math.min(frames() - 1, f0 + want);
  return { f0, f1, short: f0 + want > frames() - 1 };
}
const orbitPoint = () => {   // the object an orbit goes around (else the point the camera looks at), where it is at the start
  const o = SC.objects.find((x) => x.id === (ST.around || R.sel));
  if (!o) return null;
  const v = sample(o, OBJ, span().f0);
  return [v.x, v.z];
};
const spec = () => {
  const m = MOVES.find((x) => x[0] === ST.id), sp = span();
  return { m, p: val(m), o: { ...sp, ease: ST.ease, around: /^orbit/.test(ST.id) ? orbitPoint() : null } };
};

function add() {
  const { m, p, o } = spec();
  if (!writeMove(SC.camera, m[0], p, o)) return toast('No room after the playhead: move it earlier, or untick From playhead', true);
  R.f = o.f0; changed();
  toast(`${m[1]} added: ${(o.f0 / FPS).toFixed(1)} to ${(o.f1 / FPS).toFixed(1)} s${o.short ? ' (cut short by the end of the scene)' : ''}`);
}

// plays the move from its start without keeping it: the keys are put on, played, then put back
function preview() {
  if (R.playing) return;
  const { m, p, o } = spec(), cam = SC.camera, keep = clone(cam.chans), was = R.f;
  if (!writeMove(cam, m[0], p, o)) return toast('No room after the playhead', true);
  R.playing = true; renderTransport();
  const t0 = performance.now();
  const done = () => {
    cam.chans = keep; R.playing = false; R.f = o.f0; renderTransport();
    if (was !== o.f0) seek(o.f0); else { pose(R.f); draw(); renderTime(); renderKeys(); renderPanel(); }
  };
  const step = (now) => {
    const f = o.f0 + Math.floor(((now - t0) / 1000) * FPS);
    if (!R.playing || f > o.f1) return done();
    R.f = f; pose(f); draw(); renderTime();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function build() {
  const m0 = () => MOVES.find((x) => x[0] === ST.id);
  const box = h('div', { class: 'cam-params' });
  const grid = h('div', { class: 'cam-moves' });
  const fill = () => {
    const m = m0();
    box.replaceChildren(h('div', { class: 'row wrap' },
      ...m[3].map((x) => numField(`${x.label}${x.unit ? ` (${x.unit})` : ''}`, val(m)[x.k], (v) => { ST.vals[`${m[0]}.${x.k}`] = v; }, () => {}, { min: x.min, max: x.max, step: x.step || 0.1 })),
      /^orbit/.test(m[0]) ? aroundField() : null));
  };
  const aroundField = () => {
    const sel = h('select', {}, h('option', { value: '' }, 'The point it looks at'), ...SC.objects.map((o) => h('option', { value: o.id }, o.name)));
    sel.value = ST.around || selItem()?.id || '';
    sel.addEventListener('change', () => { ST.around = sel.value; });
    return field('Around', sel);
  };
  for (const m of MOVES) {
    grid.append(h('button', { type: 'button', class: 'cam-move' + (m[0] === ST.id ? ' on' : ''), 'data-move': m[0], title: m[1],
      onclick: () => { ST.id = m[0]; grid.querySelectorAll('.cam-move').forEach((b) => b.classList.toggle('on', b.dataset.move === m[0])); fill(); } },
    icon(m[2]), h('span', {}, m[1])));
  }
  fill();
  const dur = numField('Duration (s)', ST.secs ?? Math.min(3, SC.seconds), (v) => { ST.secs = Math.max(0.2, v); }, () => {}, { min: 0.2, max: 15, step: 0.1, digits: 1 });
  return section('Camera moves', null,
    grid, box,
    h('div', { class: 'row wrap' }, dur,
      button('To the end', () => { ST.secs = Math.max(0.2, (frames() - 1 - (ST.fromHead ? R.f : 0)) / FPS); renderPanel(); }, { title: 'As long as the scene has left after the start' })),
    field('Easing', seg(EASE_OPTS, ST.ease, (v) => { ST.ease = v; })),
    toggle('From the playhead (off: from the start of the scene)', ST.fromHead, (on) => { ST.fromHead = on; }),
    h('div', { class: 'row wrap' }, button('Add move', add, { cls: 'small primary' }), button('▶ Preview', preview)),
    help('A move writes a key where it starts (the camera as it is now) and where it ends; undo takes it back. Keys in between are replaced. A shake writes a key every few frames.'));
}

export function registerCamera() { addModeSection('camera', build); }
