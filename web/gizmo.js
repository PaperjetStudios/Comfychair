// Shared by every transform gizmo (2D handles on the video preview now, the 3D poser later): the
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

// ---- the toggles: on the preview, one tap each ----
// parts: which snaps this gizmo has, any of 'grid', 'edges', 'rot', 'scale'
const chipText = {
  grid: () => `▦ ${snap.gridPct}%`, edges: () => '⌖ Edges', rot: () => `∠ ${snap.rotStep}°`, scale: () => `⤢ ${snap.scaleStep}%`,
};
const chipOff = { grid: '▦ Grid', edges: '⌖ Edges', rot: '∠ Turn', scale: '⤢ Size' };
const chipTitle = { grid: 'Snap moving to a grid', edges: 'Snap to the frame edges and centre', rot: 'Snap rotating to steps', scale: 'Snap scaling to steps' };

export function snapBar(parts, onChange) {
  const chips = {};
  const show = () => parts.forEach((p) => {   // the step shows while it's on
    chips[p].textContent = snap[p] ? chipText[p]() : chipOff[p];
    chips[p].classList.toggle('on', !!snap[p]); chips[p].setAttribute('aria-pressed', String(!!snap[p]));
  });
  const chip = (p) => (chips[p] = h('button', { type: 'button', class: 'gz-chip', title: chipTitle[p],
    onclick: () => { snap[p] = !snap[p]; saveSnap(); show(); onChange?.(); } }));
  const bar = h('div', { class: 'gz-bar' }, parts.map(chip),
    h('button', { type: 'button', class: 'gz-chip', title: 'Snap settings', 'aria-label': 'Snap settings',
      onclick: () => settingsSheet(parts, () => { show(); onChange?.(); }) }, '⚙'));
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
