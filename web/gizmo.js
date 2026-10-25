// Shared by every transform gizmo (2D handles on the video preview now, the 3D poser through smoothGizmo): the
// weighted feel of a handle, the snapping settings (remembered per device) and the toggles for them.
import { h, store, openSheet, closeSheet, seg, field, hint, button, actions } from './ui.js';

// ---- snapping settings: one set for all gizmos, saved on this device ----
const DEFAULTS = { grid: false, gridPct: 5, edges: true, rot: false, rotStep: 15, scale: false, scaleStep: 5 };
export const snap = { ...DEFAULTS, ...store.get('deck.snap', {}) };
const saveSnap = () => store.set('deck.snap', snap);
// Alt (desktop) turns snapping off for the length of a drag; a tablet has no modifier, so it uses the toggles
export const snapOn = (key, ev) => !!snap[key] && !ev?.altKey;

export const snapStep = (v, step) => Math.round(v / step) * step;
export const normDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ---- weight: critically damped springs ----
// A handle follows the pointer like it has mass: each value is pulled toward the pointer's value by a
// critically damped spring (no overshoot, ~4.7/omega seconds to settle), solved exactly per frame.
// Fast jitter is smoothed away (it can't move a spring that slowly), a slow drag lags only by
// 2*speed/omega and catches up on release. A small dead zone (deadzone()) ignores sub-pixel wobble.
export const WEIGHT = { scale: 12, move: 24, rotate: 18, anchor: 28 };   // omega, rad/s: heavier = lower
export const DEAD_PX = { scale: 3, move: 2, rotate: 2, anchor: 2 };

// pointer offset (dx, dy) with a dead zone of r px: nothing until it leaves, then it catches up
// continuously (no jump) and is exact again beyond 7r
export function deadzone(dx, dy, r) {
  const d = Math.hypot(dx, dy);
  if (d <= r) return [0, 0];
  const eff = d - r * Math.max(0, 1 - (d - r) / (6 * r));
  return [(dx * eff) / d, (dy * eff) / d];
}

export class Weight {
  // chans: { key: [startValue, omega] }; onFrame(values) after every step; onSettle() after release
  constructor(chans, onFrame, onSettle) {
    this.c = {}; this.onFrame = onFrame; this.onSettle = onSettle; this.down = true; this.last = performance.now();
    for (const [k, [v, w]] of Object.entries(chans)) this.c[k] = { x: v, v: 0, t: v, w };
    this.raf = requestAnimationFrame(() => this.tick());
  }
  aim(k, t) { this.c[k].t = t; }
  get(k) { return this.c[k].x; }
  values() { return Object.fromEntries(Object.entries(this.c).map(([k, c]) => [k, c.x])); }
  tick() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    let moving = false;
    for (const c of Object.values(this.c)) {
      const e = c.x - c.t;
      if (Math.abs(e) < 1e-4 && Math.abs(c.v) < 1e-3) { c.x = c.t; c.v = 0; continue; }
      const k = Math.exp(-c.w * dt), j = c.v + c.w * e;
      c.x = c.t + (e + j * dt) * k;
      c.v = (c.v - c.w * j * dt) * k;
      moving = true;
    }
    if (moving) this.onFrame(this.values());
    if (this.down || moving) this.raf = requestAnimationFrame(() => this.tick());
    else this.finish();
  }
  // let go: it keeps settling toward the last target, then onSettle runs (a timer covers frames that
  // never come, like a backgrounded page)
  release() {
    this.down = false;
    this.guard = setTimeout(() => this.finish(), 700);
  }
  finish() {
    if (this.done) return;
    this.done = true; clearTimeout(this.guard); cancelAnimationFrame(this.raf);
    for (const c of Object.values(this.c)) { c.x = c.t; c.v = 0; }
    this.onFrame(this.values());
    this.onSettle?.();
  }
  cancel() { this.done = true; clearTimeout(this.guard); cancelAnimationFrame(this.raf); }
}

// ---- 3D: the same feel on three.js TransformControls ----
// Own settings (deck.snap3): the 3D grid is in metres, not % of a frame, and switching it on there
// shouldn't switch the video gizmo's grid on. Rotate steps are degrees; the size step is in the
// object's own units (metres for a box, a multiplier for a figure or photo).
const DEFAULTS3 = { grid: false, gridM: 0.25, rot: false, rotStep: 15, scale: false, scaleStep: 0.1 };
export const snap3 = { ...DEFAULTS3, ...store.get('deck.snap3', {}) };
const saveSnap3 = () => store.set('deck.snap3', snap3);
export const WEIGHT3 = { p: 22, q: 18, s: 12 };       // omega, rad/s, for position / rotation / scale (the video gizmo's, a touch lighter for move)
export const DEAD3 = { translate: 3, rotate: 3, scale: 4 };   // px of pen or finger wobble ignored at the start of a drag

// Wraps a TransformControls: its result becomes the target, the object follows through critically
// damped springs (Weight), and once the drag has settled settle() runs once. Snapping is
// TransformControls' own (set from snap3), so the target is already snapped and the spring only
// smooths toward it. TransformControls works from the drag's start values, so putting the smoothed
// transform back on the object between moves doesn't disturb it.
//   opts: canvas, fix(object, start) (tidy the raw result, e.g. keep a scale even), apply(object) (use the
//   object's transform, each frame), settle() (once), redraw()
export function smoothGizmo(tc, opts) {
  const { canvas } = opts;
  let w = null, start = null, p0 = null, touched = false, alt = false;
  const snaps = () => {
    tc.setTranslationSnap(snap3.grid && !alt ? snap3.gridM : null);
    tc.setRotationSnap(snap3.rot && !alt ? (snap3.rotStep * Math.PI) / 180 : null);
    tc.setScaleSnap(snap3.scale && !alt ? snap3.scaleStep : null);
  };
  snaps();
  // Alt (desktop) frees a drag; a tablet uses the toggles
  canvas.addEventListener('pointermove', (e) => { if (e.altKey !== alt) { alt = e.altKey; snaps(); } }, true);
  const read = (o) => ({ px: o.position.x, py: o.position.y, pz: o.position.z, qx: o.quaternion.x, qy: o.quaternion.y, qz: o.quaternion.z,
    qw: o.quaternion.w, sx: o.scale.x, sy: o.scale.y, sz: o.scale.z });
  const put = (o, v) => {
    o.position.set(v.px, v.py, v.pz); o.quaternion.set(v.qx, v.qy, v.qz, v.qw).normalize(); o.scale.set(v.sx, v.sy, v.sz);
  };

  // a dead zone on the pointer: wobble inside it does nothing, beyond it the drag catches up smoothly
  const pDown = tc.pointerDown.bind(tc), pMove = tc.pointerMove.bind(tc);
  tc.pointerDown = (p) => { p0 = p ? { x: p.x, y: p.y } : null; pDown(p); };
  tc.pointerMove = (p) => {
    if (p && p0) {
      const r = canvas.getBoundingClientRect();
      const [dx, dy] = deadzone((p.x - p0.x) * r.width / 2, -(p.y - p0.y) * r.height / 2, DEAD3[tc.mode] ?? 3);
      p = { ...p, x: p0.x + (dx * 2) / r.width, y: p0.y - (dy * 2) / r.height };
    }
    pMove(p);
  };

  tc.addEventListener('dragging-changed', (e) => {
    if (e.value) {
      if (w) w.finish();
      const o = tc.object;
      start = read(o); touched = false; snaps();
      const k = {};
      for (const n of Object.keys(start)) k[n] = [start[n], WEIGHT3[n[0]]];
      const mine = w = new Weight(k, (v) => {
        if (!touched) return;
        put(o, v); o.updateMatrixWorld(true); opts.apply(o);
      }, () => { if (w === mine) w = null; if (touched) opts.settle(); opts.redraw(); });
    } else if (w) w.release();
  });
  tc.addEventListener('objectChange', () => {
    if (!w || w.done) return;
    const o = tc.object;
    opts.fix?.(o, start);
    const t = read(o), cur = w.values();
    if (cur.qx * t.qx + cur.qy * t.qy + cur.qz * t.qz + cur.qw * t.qw < 0) { t.qx *= -1; t.qy *= -1; t.qz *= -1; t.qw *= -1; }  // the short way round
    if (!touched) touched = Object.keys(t).some((n) => Math.abs(t[n] - start[n]) > 1e-9);
    for (const n of Object.keys(t)) w.aim(n, t[n]);
    put(o, cur);   // the object stays where the spring has it; the next frame moves it on
  });
  return { settling: () => !!w };
}

// ---- the toggles: on the preview, one tap each ----
// parts: which snaps this gizmo has, any of 'grid', 'edges', 'rot', 'scale'
const chipText = {
  grid: () => `▦ ${snap.gridPct}%`, edges: () => '⌖ Edges', rot: () => `∠ ${snap.rotStep}°`, scale: () => `⤢ ${snap.scaleStep}%`,
};
const chipOff = { grid: '▦ Grid', edges: '⌖ Edges', rot: '∠ Turn', scale: '⤢ Size' };
const chipTitle = { grid: 'Snap moving to a grid', edges: 'Snap to the frame edges and centre', rot: 'Snap rotating to steps', scale: 'Snap scaling to steps' };

const S2 = { snap, save: saveSnap, text: chipText, off: chipOff, title: chipTitle, sheet: (parts, after) => settingsSheet(parts, after) };
export const snapBar = (parts, onChange) => chipBar(S2, parts, onChange);
function chipBar(S, parts, onChange) {
  const chips = {};
  const show = () => parts.forEach((p) => {   // the step shows while it's on
    chips[p].textContent = S.snap[p] ? S.text[p]() : S.off[p];
    chips[p].classList.toggle('on', !!S.snap[p]); chips[p].setAttribute('aria-pressed', String(!!S.snap[p]));
  });
  const chip = (p) => (chips[p] = h('button', { type: 'button', class: 'gz-chip', title: S.title[p],
    onclick: () => { S.snap[p] = !S.snap[p]; S.save(); show(); onChange?.(); } }));
  const bar = h('div', { class: 'gz-bar' }, parts.map(chip),
    h('button', { type: 'button', class: 'gz-chip', title: 'Snap settings', 'aria-label': 'Snap settings',
      onclick: () => S.sheet(parts, () => { show(); onChange?.(); }) }, '⚙'));
  show();
  return bar;
}

function settingsSheet(parts, after) {
  const row = (key, label, opts, fmt) => field(label, seg(opts.map((v) => [v, fmt(v)]), snap[key], (v) => { snap[key] = Number(v); saveSnap(); after(); }));
  openSheet(h('h3', {}, 'Snapping'),
    parts.includes('grid') ? row('gridPct', 'Grid size (% of the frame width)', [1, 2.5, 5, 10, 12.5], (v) => `${v}%`) : null,
    parts.includes('rot') ? row('rotStep', 'Rotate in steps of', [5, 15, 30, 45, 90], (v) => `${v}°`) : null,
    parts.includes('scale') ? row('scaleStep', 'Scale in steps of', [1, 5, 10, 25], (v) => `${v}%`) : null,
    hint('Each snap has its own on/off chip on the preview. On a desktop, hold Alt while dragging to drag freely.', 'sheet-hint'),
    actions(button('Done', closeSheet, { cls: 'small primary' })));
}

// the 3D bar: Grid (metres), Turn (degrees), Size (steps)
const S3 = {
  snap: snap3, save: saveSnap3,
  text: { grid: () => `▦ ${snap3.gridM} m`, rot: () => `∠ ${snap3.rotStep}°`, scale: () => `⤢ ${snap3.scaleStep}` },
  off: { grid: '▦ Grid', rot: '∠ Turn', scale: '⤢ Size' },
  title: { grid: 'Snap moving to a floor grid (shown on the floor)', rot: 'Snap rotating to steps', scale: 'Snap scaling to steps' },
  sheet(parts, after) {
    const row = (key, label, opts, fmt) => field(label, seg(opts.map((v) => [v, fmt(v)]), snap3[key], (v) => { snap3[key] = Number(v); saveSnap3(); after(); }));
    openSheet(h('h3', {}, 'Snapping'),
      row('gridM', 'Grid size', [0.05, 0.1, 0.25, 0.5, 1], (v) => `${v} m`),
      row('rotStep', 'Rotate in steps of', [5, 15, 30, 45, 90], (v) => `${v}°`),
      row('scaleStep', 'Scale in steps of (m, or × for a figure or photo)', [0.01, 0.05, 0.1, 0.25, 0.5], (v) => `${v}`),
      hint('Each snap has its own on/off chip on the stage. On a desktop, hold Alt while dragging to drag freely.', 'sheet-hint'),
      actions(button('Done', closeSheet, { cls: 'small primary' })));
  },
};
export const snapBar3 = (onChange) => chipBar(S3, ['grid', 'rot', 'scale'], onChange);
