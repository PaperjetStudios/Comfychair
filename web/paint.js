import { h, store, toast, clamp, seg, field, section, help, rangeField, button, hint, pctFmt, colorField, openSheet, closeSheet, actions, propNum } from './ui.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Painting in the Editor: brushes with pen pressure and tilt, an eraser, blank canvas layers, undo.
// A layer being painted keeps its pixels in a canvas (l.img becomes that canvas: it answers naturalWidth like
// the image did, so the editor draws and hit-tests it as before). The pixels are saved as a PNG named after its
// content (/api/paint), a moment after the last stroke, and the layer then names that file like any input image.
// The editor hands its side over once with bindPaint(); P holds the tool and brush settings.
// ---------------------------------------------------------------------------
export const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#f8bbd0', '#90caf9'];

// Brushes. size: canvas px; flow: how much one dab lays down (soft brushes build up); hard: the solid part of a dab;
// spacing: between dabs, a share of their width; pSize / pAlpha: how much pen pressure changes width / strength;
// tilt: 'shade' (tilting a pencil lays a wider, lighter side stroke), 'spread' (an airbrush sprays wider).
const BRUSHES = {
  pencil: { label: 'Pencil', size: 4, opacity: 1, flow: 0.8, hard: 0.85, spacing: 0.15, pSize: 0.4, pAlpha: 0.85, tilt: 'shade' },
  ink: { label: 'Ink', size: 10, opacity: 1, flow: 1, hard: 0.95, spacing: 0.08, pSize: 0.9, pAlpha: 0, tilt: null },
  airbrush: { label: 'Airbrush', size: 80, opacity: 0.7, flow: 0.06, hard: 0, spacing: 0.08, pSize: 0.2, pAlpha: 1, tilt: 'spread' },
  marker: { label: 'Marker', size: 28, opacity: 0.55, flow: 1, hard: 0.9, spacing: 0.06, pSize: 0.25, pAlpha: 0, tilt: null },
  eraser: { label: 'Eraser', size: 40, opacity: 1, flow: 1, hard: 0.7, spacing: 0.08, pSize: 0.5, pAlpha: 0, tilt: null },
};
const BLEND = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter' };
export const BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['add', 'Add']];
export const blendOp = (l) => BLEND[l.blend] || 'source-over';

// tools: [id, name, key]; 'move' is the editor's own move / resize / crop
const TOOLS = [
  ['move', 'Move, resize and crop layers', 'v'],
  ['brush', 'Brush', 'b'], ['eraser', 'Eraser', 'e'],
];
const KEYS = Object.fromEntries(TOOLS.map(([t, , k]) => [k, t]));

export const P = {
  tool: 'move',
  brush: store.get('deck.paint.brush', 'ink'),
  color: store.get('deck.paint.color', '#000000'),
  smooth: store.get('deck.paint.smooth', 0.35),
  set: store.get('deck.paint.set', {}),   // per brush: { size, opacity } as last used
  recent: store.get('deck.paint.recent', []),
  penOnly: false,   // fingers don't draw: on once a pen touches the canvas
};
export const painting = () => P.tool !== 'move';
const brushKey = () => (P.tool === 'eraser' ? 'eraser' : P.brush);
const bset = (k = brushKey()) => ({ ...BRUSHES[k], ...(P.set[k] || {}) });
function setBrush(k, o) { P.set[k] = { ...(P.set[k] || {}), ...o }; store.set('deck.paint.set', P.set); }

let X = null;   // the editor's side: { E, canvas(), viewer(), toCanvas(e), view(), zoom, frame(), redraw(), render(), changed(), active() }
const E = () => X.E;

// ---- layer pixels ----
function makeCanvas(w, hh) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = hh;
  Object.defineProperties(cv, { naturalWidth: { get() { return this.width; } }, naturalHeight: { get() { return this.height; } } });
  return cv;
}
export const isCanvas = (l) => l.img instanceof HTMLCanvasElement;
// The layer's pixels as a canvas to paint on (an image layer is copied into one the first time)
function layerCanvas(l) {
  if (isCanvas(l)) return l.img;
  const cv = makeCanvas(l.img.naturalWidth, l.img.naturalHeight);
  cv.getContext('2d').drawImage(l.img, 0, 0);
  l.label ??= l.name.split('/').pop();   // it keeps the picture's name once it names its paint file
  l.img = cv;
  return cv;
}
// scratch canvases, reused (a stroke's dabs, the layer as it will look with the stroke)
const SCR = {};
function scratch(k, w, hh) {
  let s = SCR[k];
  if (!s || s.cv.width !== w || s.cv.height !== hh) {
    const cv = s?.cv || document.createElement('canvas');
    cv.width = w; cv.height = hh;
    s = SCR[k] = { cv, ctx: cv.getContext('2d') };
  }
  return s;
}
// canvas px -> the layer's own pixels (its crop and scale undone)
const toLayer = (l, p) => ({ x: (p.x - l.x) / l.scale + l.crop.x * l.img.naturalWidth, y: (p.y - l.y) / l.scale + l.crop.y * l.img.naturalHeight });

// A new blank layer to paint on: the canvas's size by default, see-through or filled
let blanks = 0;
export function addBlank({ w, h: hh, fill = null }) {
  const cv = makeCanvas(Math.round(w), Math.round(hh));
  if (fill) { const c = cv.getContext('2d'); c.fillStyle = fill; c.fillRect(0, 0, cv.width, cv.height); }
  const f = X.frame();
  const l = { name: null, label: `Canvas ${++blanks}`, crop: { x: 0, y: 0, w: 1, h: 1 }, x: f ? f.x : 0, y: f ? f.y : 0, scale: 1, opacity: 1,
    hidden: false, blend: 'normal', img: cv };
  E().layers.push(l);
  E().sel = l; E().cropping = false;
  dirty(l, 200);
  X.changed(); X.render();
  return l;
}
export function blankSheet() {
  const f = X.frame(), dw = f ? f.w : 1024, dh = f ? f.h : 1024;
  let w = dw, hh = dh, fill = store.get('deck.paint.blankFill', 'clear');
  openSheet(h('h3', {}, 'Blank canvas'),
    h('div', { class: 'row' },
      propNum('Width', w, (v) => { w = v; }, () => {}, { min: 16, max: 8192, step: 8 }),
      propNum('Height', hh, (v) => { hh = v; }, () => {}, { min: 16, max: 8192, step: 8 })),
    field('Fill', seg([['clear', 'See-through'], ['white', 'White'], ['bg', 'Background colour']], fill, (v) => { fill = v; store.set('deck.paint.blankFill', v); })),
    actions(
      button('Add canvas', () => {
        closeSheet();
        addBlank({ w, h: hh, fill: fill === 'white' ? '#ffffff' : fill === 'bg' ? E().bg : null });
        if (!painting()) setTool('brush');
      }, { cls: 'small primary' }),
      button('Cancel', closeSheet, { cls: 'small ghost' })));
}

// ---- saving: a painted layer is uploaded a moment after its last change (and before the tab is left) ----
const SAVE_DELAY = 1500;
let saveTimer = 0, saving = null, saveFailed = false;
function dirty(l, delay = SAVE_DELAY) {
  l.paintRev = (l.paintRev || 0) + 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePaint, delay);
}
export async function savePaint() {
  clearTimeout(saveTimer);
  while (saving) await saving;
  saving = (async () => {
    let saved = false;
    for (const l of [...E().layers]) {
      while (isCanvas(l) && l.paintRev && l.paintRev !== l.savedRev) {
        const rev = l.paintRev;
        const blob = await new Promise((res) => l.img.toBlob(res, 'image/png'));
        try {
          const r = await fetch('/api/paint', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
          l.name = (await r.json()).name; l.savedRev = rev;
          saveFailed = false;
          if (E().layers.includes(l)) { X.changed(); saved = true; }
        } catch (e) {
          if (!saveFailed) toast(`Painting not saved yet: ${e.message}`, true);
          saveFailed = true;
          saveTimer = setTimeout(savePaint, 5000);
          return;
        }
      }
    }
    if (saved && !S) X.render();   // (the layer thumbnails)
  })();
  try { await saving; } finally { saving = null; }
}
export const unsavedPaint = () => E().layers.some((l) => isCanvas(l) && l.paintRev && l.paintRev !== l.savedRev);

// ---- undo: each change keeps the pixels it covered, before and after ----
const U = { undo: [], redo: [], bytes: 0 };
const UNDO_BYTES = 160 << 20;
function pushUndo(l, x, y, before, after) {
  U.undo.push({ l, x, y, before, after });
  U.bytes += (before.data.length + after.data.length);
  for (const e of U.redo) U.bytes -= e.before.data.length + e.after.data.length;
  U.redo = [];
  while (U.undo.length > 1 && U.bytes > UNDO_BYTES) { const e = U.undo.shift(); U.bytes -= e.before.data.length + e.after.data.length; }
  syncStrip();
}
function step(from, to, which) {
  while (from.length) {
    const e = from.pop();
    if (!E().layers.includes(e.l) || !isCanvas(e.l)) { U.bytes -= e.before.data.length + e.after.data.length; continue; }   // its layer is gone
    e.l.img.getContext('2d').putImageData(e[which], e.x, e.y);
    to.push(e);
    dirty(e.l);
    X.redraw();
    break;
  }
  syncStrip();
}
export const undo = () => step(U.undo, U.redo, 'before');
export const redo = () => step(U.redo, U.undo, 'after');
// Run fn(ctx) on the layer's pixels inside the box, as one undo step
function change(l, box, fn) {
  const cv = layerCanvas(l), c = cv.getContext('2d');
  const x = clamp(Math.floor(box.x), 0, cv.width), y = clamp(Math.floor(box.y), 0, cv.height);
  const w = clamp(Math.ceil(box.x + box.w), 0, cv.width) - x, hh = clamp(Math.ceil(box.y + box.h), 0, cv.height) - y;
  if (w < 1 || hh < 1) return;
  const before = c.getImageData(x, y, w, hh);
  c.save(); fn(c); c.restore();
  pushUndo(l, x, y, before, c.getImageData(x, y, w, hh));
  dirty(l);
}

// ---- strokes: dabs go into a buffer at full strength, and the buffer goes onto the layer at the brush's
// opacity (so a stroke never darkens where it crosses itself), or cuts it away for the eraser ----
let S = null;   // the stroke being drawn
function target() {
  const l = E().sel;
  if (!l || !l.img || !l.img.naturalWidth || l.x == null) return null;
  return l;
}
function canPaint(l) {
  if (!l) { toast('Pick a layer to paint on (or add a blank canvas)', true); return false; }
  if (l.locked) { toast('That layer is locked', true); return false; }
  if (l.hidden) { toast('That layer is hidden', true); return false; }
  return true;
}
function sample(e, l) {
  const q = toLayer(l, X.toCanvas(e));
  const pen = e.pointerType === 'pen';
  q.p = pen ? clamp(e.pressure || 0, 0.02, 1) : 1;   // (a finger or mouse draws at full pressure)
  q.t = pen ? clamp(Math.hypot(e.tiltX || 0, e.tiltY || 0) / 60, 0, 1) : 0;
  return q;
}
function beginStroke(e, l) {
  const cv = layerCanvas(l), b = bset();
  const buf = scratch('buf', cv.width, cv.height), live = scratch('live', cv.width, cv.height);
  buf.ctx.clearRect(0, 0, cv.width, cv.height);
  live.ctx.globalCompositeOperation = 'source-over'; live.ctx.globalAlpha = 1;
  live.ctx.clearRect(0, 0, cv.width, cv.height); live.ctx.drawImage(cv, 0, 0);
  l.live = live.cv;
  S = { l, id: e.pointerId, type: e.pointerType, b, erase: P.tool === 'eraser', bb: null, sm: null, last: null, carry: 0, raw: null, frame: 0 };
  moveStroke(e);
}
function moveStroke(e) {
  const evs = e.getCoalescedEvents?.() || [];
  const k = 1 - 0.9 * clamp(P.smooth, 0, 1);   // the stabiliser: the line follows the pen at this rate
  for (const ev of (evs.length ? evs : [e])) {
    const q = sample(ev, S.l);
    S.raw = q;
    S.sm = S.sm ? { x: S.sm.x + (q.x - S.sm.x) * k, y: S.sm.y + (q.y - S.sm.y) * k, p: S.sm.p + (q.p - S.sm.p) * Math.max(k, 0.4), t: q.t } : q;
    lineTo(S.sm);
  }
  if (!S.frame) S.frame = requestAnimationFrame(showStroke);
}
// dabs along the line from the last one, `spacing` apart
function lineTo(q) {
  const a = S.last;
  if (!a) { dab(q); S.last = q; S.carry = gap(q); return; }
  const d = Math.hypot(q.x - a.x, q.y - a.y);
  let at = S.carry;
  while (at <= d) {
    const t = d ? at / d : 1, m = { x: a.x + (q.x - a.x) * t, y: a.y + (q.y - a.y) * t, p: a.p + (q.p - a.p) * t, t: a.t + (q.t - a.t) * t };
    dab(m);
    at += gap(m);
  }
  S.carry = at - d; S.last = q;
}
function radius(q) {
  const b = S.b;
  let r = (b.size / 2) * (1 - b.pSize * (1 - q.p)) / S.l.scale;
  if (b.tilt === 'shade') r *= 1 + 2 * q.t; else if (b.tilt === 'spread') r *= 1 + q.t;
  return Math.max(0.4, r);
}
const gap = (q) => Math.max(0.5, S.b.spacing * 2 * radius(q));
function dab(q) {
  const b = S.b, r = radius(q), c = SCR.buf.ctx;
  let a = b.flow * (1 - b.pAlpha * (1 - q.p));
  if (b.tilt === 'shade') a *= 1 - 0.6 * q.t;
  if (a <= 0) return;
  c.globalAlpha = Math.min(1, a);
  if (b.hard >= 0.99 || r < 1.5) c.fillStyle = P.color;
  else {
    const g = c.createRadialGradient(q.x, q.y, r * b.hard, q.x, q.y, r);
    g.addColorStop(0, P.color); g.addColorStop(1, `${P.color}00`);
    c.fillStyle = g;
  }
  c.beginPath(); c.arc(q.x, q.y, r, 0, Math.PI * 2); c.fill();
  const bb = { x: q.x - r - 2, y: q.y - r - 2, w: 2 * r + 4, h: 2 * r + 4 };
  S.bb = S.bb ? union(S.bb, bb) : bb;
}
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
const intBox = (bb, cv) => {
  const x = clamp(Math.floor(bb.x), 0, cv.width), y = clamp(Math.floor(bb.y), 0, cv.height);
  return { x, y, w: clamp(Math.ceil(bb.x + bb.w), 0, cv.width) - x, h: clamp(Math.ceil(bb.y + bb.h), 0, cv.height) - y };
};
// the buffer put onto ctx (the layer, or its live copy) at the brush's opacity
function laydown(c, src, bb) {
  if (bb.w < 1 || bb.h < 1) return;
  c.globalAlpha = S.b.opacity;
  c.globalCompositeOperation = S.erase ? 'destination-out' : 'source-over';
  c.drawImage(src, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
}
// the live copy: the layer, with the stroke so far on it
function showStroke() {
  if (!S) return;
  S.frame = 0;
  if (!S.bb) return;
  const cv = S.l.img, bb = intBox(S.bb, cv), lc = SCR.live.ctx;
  lc.clearRect(bb.x, bb.y, bb.w, bb.h);
  lc.drawImage(cv, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h);
  laydown(lc, SCR.buf.cv, bb);
  X.redraw();
}
function endStroke() {
  if (!S) return;
  cancelAnimationFrame(S.frame);
  if (S.raw && S.sm) lineTo(S.raw);   // the stabiliser catches up with where the pen lifted
  const s = S, bb = s.bb;
  S = null; s.l.live = null;
  if (bb) change(s.l, bb, (c) => { S = s; laydown(c, SCR.buf.cv, intBox(bb, s.l.img)); S = null; });
  X.redraw();
}
function cancelStroke() {
  if (!S) return;
  cancelAnimationFrame(S.frame);
  S.l.live = null; S = null;
  X.redraw();
}

// ---- the pointer: the pen paints; fingers paint until a pen has been seen, two fingers pan and zoom,
// a two-finger tap undoes and a three-finger tap redoes ----
const touches = new Map();   // touch pointer id -> { x, y } (client px)
let G = null;   // a gesture with two or more fingers
function startGesture() {
  const [a, b] = [...touches.values()];
  G = { t0: performance.now(), n: touches.size, moved: 0, v0: X.zoom.get(), m0: mid(a, b), d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function moveGesture() {
  if (!G || touches.size < 2) return;
  const [a, b] = [...touches.values()], m = mid(a, b), d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
  G.moved = Math.max(G.moved, Math.hypot(m.x - G.m0.x, m.y - G.m0.y), Math.abs(d - G.d0));
  const r = X.canvas().getBoundingClientRect(), v = G.v0;
  const z = clamp(v.z * d / G.d0, 0.1, 40);
  // the canvas point under the first midpoint stays under the fingers
  const bx = (G.m0.x - r.left - v.tx) / v.z, by = (G.m0.y - r.top - v.ty) / v.z;
  X.zoom.set(z, m.x - r.left - bx * z, m.y - r.top - by * z);
}
function endTouch(id) {
  touches.delete(id);
  if (!G || touches.size) return;
  const tap = performance.now() - G.t0 < 300 && G.moved < 12;
  if (tap && G.n === 2) undo(); else if (tap && G.n >= 3) redo();
  G = null;
}

function onDown(e) {
  if (!painting() || !X.active()) return;
  e.stopImmediatePropagation(); e.preventDefault();
  hideRing();
  if (e.pointerType === 'pen' && !P.penOnly) { P.penOnly = true; X.render(); }
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      if (S && S.type === 'touch') cancelStroke();   // the first finger was the start of a pinch, not a stroke
      if (!G) startGesture(); else G.n = Math.max(G.n, touches.size);
      return;
    }
    if (P.penOnly) return;
  }
  if (S || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const l = target();
  if (!canPaint(l)) return;
  try { X.canvas().setPointerCapture(e.pointerId); } catch { /* already gone */ }
  if (P.tool === 'brush' || P.tool === 'eraser') beginStroke(e, l);
}
function onMove(e) {
  if (!painting()) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G) { moveGesture(); return; }
  }
  if (S && e.pointerId === S.id) { e.stopImmediatePropagation(); moveStroke(e); }
  if (e.pointerType !== 'touch') showRing(e);
}
function onUp(e) {
  if (!painting()) return;
  e.stopImmediatePropagation();
  if (e.pointerType === 'touch') endTouch(e.pointerId);
  if (S && e.pointerId === S.id) { if (e.type === 'pointercancel') cancelStroke(); else endStroke(); }
}

// the brush outline under a hovering pen (or the mouse)
let ring = null;
function showRing(e) {
  if (!ring || !(P.tool === 'brush' || P.tool === 'eraser')) return hideRing();
  const v = X.view(), l = target();
  if (!v) return hideRing();
  const r = X.viewer().getBoundingClientRect(), d = Math.max(4, bset().size * v.s);
  Object.assign(ring.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` });
  ring.classList.toggle('off', !l || !!l.locked);
  ring.classList.remove('hidden');
}
function hideRing() { ring?.classList.add('hidden'); }

// ---- the tool strip down the left of the canvas ----
let strip = null;
function syncStrip() {
  if (!strip) return;
  for (const b of strip.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === P.tool);
  strip.querySelector('[data-act=undo]').disabled = !U.undo.length;
  strip.querySelector('[data-act=redo]').disabled = !U.redo.length;
  strip.querySelector('[data-act=fit]').classList.toggle('hidden', !X.zoom.zoomed());
  const sw = strip.querySelector('.paint-color');
  sw.style.setProperty('--c', P.color); sw.querySelector('input').value = P.color;
}
export function setTool(t) {
  if (t === P.tool) return;
  cancelStroke();
  P.tool = t;
  const e = E();
  e.cropping = false;
  if (t === 'move') X.zoom.reset();
  else if (!target()) {   // something to paint on: the top layer that can be, or a new white canvas
    const l = [...e.layers].reverse().find((o) => o.img?.naturalWidth && o.x != null && !o.hidden && !o.locked);
    if (l) e.sel = l;
    else if (!e.layers.length) addBlank({ ...(X.frame() || { w: 1024, h: 1024 }), fill: '#ffffff' });
  }
  hideRing();
  X.render();
}
export function setColor(c, keep = true) {
  P.color = c; store.set('deck.paint.color', c);
  if (keep) { P.recent = [c, ...P.recent.filter((x) => x !== c)].slice(0, 8); store.set('deck.paint.recent', P.recent); }
  if (P.tool === 'eraser' || P.tool === 'move') { P.tool = 'brush'; X.render(); }
  syncStrip();
}
function buildStrip() {
  const tb = (t, name, k) => h('button', { type: 'button', 'data-tool': t, title: `${name} (${k.toUpperCase()})`, 'aria-label': name,
    onclick: () => setTool(t) }, icon(t));
  const colorIn = h('input', { type: 'color', value: P.color, 'aria-label': 'Colour' });
  colorIn.addEventListener('input', () => setColor(colorIn.value, false));
  colorIn.addEventListener('change', () => setColor(colorIn.value));
  const act = (a, name, fn) => h('button', { type: 'button', 'data-act': a, title: name, 'aria-label': name, onclick: fn }, icon(a));
  strip = h('div', { class: 'paint-strip', role: 'toolbar', 'aria-label': 'Paint tools', 'aria-orientation': 'vertical' },
    TOOLS.map(([t, name, k]) => tb(t, name, k)),
    h('span', { class: 'sep' }),
    h('label', { class: 'paint-color', title: 'Colour' }, colorIn),
    act('undo', 'Undo (Ctrl+Z, or tap with two fingers)', undo),
    act('redo', 'Redo (Ctrl+Shift+Z)', redo),
    act('fit', 'Fit the canvas in view', () => { X.zoom.reset(); }));
  ring = h('div', { class: 'brush-ring hidden' });
  return [strip, ring];
}

// ---- the side panel's settings for the tool ----
export function paintProps() {
  if (!painting()) return null;
  const l = target();
  const k = brushKey();
  const keepB = (o) => { setBrush(k, o); };
  const swatches = h('div', { class: 'swatches' }, [...new Set([...P.recent, ...SWATCHES])].slice(0, 16).map((c) =>
    h('button', { type: 'button', style: `background:${c}`, class: c === P.color ? 'on' : '', 'aria-label': `Colour ${c}`, onclick: () => { setColor(c); X.render(); } })));
  return section(P.tool === 'eraser' ? 'Eraser' : 'Brush', () => setTool('move'),
    hint(l ? `On ${l.label || l.name?.split('/').pop() || 'the new canvas'}${l.locked ? ' (locked)' : ''}` : 'Pick a layer to paint on', 'layer-title'),
    P.tool === 'brush' ? field('Brush', seg(Object.entries(BRUSHES).filter(([id]) => id !== 'eraser').map(([id, o]) => [id, o.label]), P.brush, (v) => {
      P.brush = v; store.set('deck.paint.brush', v); X.render();
    }, { wrap: true })) : null,
    rangeField('Size', () => bset(k).size, (v) => keepB({ size: Math.round(v) }), { min: 1, max: 400, step: 1, fmt: (v) => `${Math.round(v)} px` }),
    rangeField(P.tool === 'eraser' ? 'Strength' : 'Opacity', () => bset(k).opacity, (v) => keepB({ opacity: clamp(v, 0.01, 1) }),
      { min: 0.01, max: 1, step: 0.01, fmt: pctFmt }),
    rangeField('Smoothing', () => P.smooth, (v) => { P.smooth = clamp(v, 0, 1); store.set('deck.paint.smooth', P.smooth); }, { min: 0, max: 1, step: 0.01, fmt: pctFmt }),
    P.tool !== 'eraser' ? colorField('Colour', () => P.color, (c) => setColor(c, false), swatches) : null,
    h('div', { class: 'row wrap' },
      button('Pen only', () => { P.penOnly = !P.penOnly; X.render(); }, { cls: `small${P.penOnly ? ' on' : ''}`, title: 'Fingers pan and zoom, and don\'t paint' }),
      button('Blank canvas', blankSheet, { title: 'A new empty layer to paint on' })),
    help('The pen paints: press harder for a wider or stronger line, tilt a pencil to shade. Once the pen has touched the canvas, fingers stop painting (Pen only). Two fingers pan and zoom; tap with two fingers to undo, three to redo. [ and ] change the size. Smoothing steadies the line (it trails the pen a little).'));
}

// ---- keys: tool letters, [ ] for the size, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y ----
function onKey(e) {
  if (!X.active() || e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    if (!U.undo.length && !U.redo.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (k === 'y' || e.shiftKey) redo(); else undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (KEYS[k] && !(k === 'v' && !painting())) { e.preventDefault(); e.stopImmediatePropagation(); setTool(KEYS[k]); return; }
  if (painting() && (e.key === '[' || e.key === ']')) {
    e.preventDefault();
    const kk = brushKey(), s = bset(kk).size;
    setBrush(kk, { size: clamp(Math.round(e.key === ']' ? s * 1.2 + 1 : s / 1.2 - 1), 1, 400) });
    X.render();
    return;
  }
  // the layout keys (Delete removes the layer, arrows nudge it, Esc deselects) don't apply while painting
  if (painting() && ['Delete', 'Backspace', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'c'].includes(e.key)) {
    if (e.key === 'Escape') setTool('move');
    e.preventDefault(); e.stopImmediatePropagation();
  }
}

// Set up once: the editor's side, the pointer, keys and the tool strip (returned, for the viewer)
export function bindPaint(ctx) {
  X = ctx;
  const cv = X.canvas();
  cv.addEventListener('pointerdown', onDown, true);
  cv.addEventListener('pointermove', onMove, true);
  cv.addEventListener('pointerup', onUp, true);
  cv.addEventListener('pointercancel', onUp, true);
  cv.addEventListener('pointerleave', hideRing);
  cv.addEventListener('wheel', (e) => {   // the wheel zooms about the pointer while painting
    if (!painting()) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect(), v = X.zoom.get(), z = clamp(v.z * Math.exp(-e.deltaY * 0.0015), 0.1, 40);
    const px = e.clientX - r.left, py = e.clientY - r.top;
    X.zoom.set(z, px - (px - v.tx) * z / v.z, py - (py - v.ty) * z / v.z);
  }, { passive: false });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePaint(); });
  return buildStrip();
}
export const paintSync = () => syncStrip();
