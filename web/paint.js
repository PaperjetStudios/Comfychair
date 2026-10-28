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
const OTHER = { shape: { size: 6, opacity: 1 }, fill: { opacity: 1 } };   // the shapes' line width, the fill's strength
const SHAPES = ['line', 'rect', 'ellipse'];
const BLEND = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter' };
export const BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['add', 'Add']];
export const blendOp = (l) => BLEND[l.blend] || 'source-over';

// tools: [id, name, key]; 'move' is the editor's own move / resize / crop
const TOOLS = [
  ['move', 'Move, resize and crop layers', 'v'],
  ['brush', 'Brush', 'b'], ['eraser', 'Eraser', 'e'],
  ['line', 'Line', 'l'], ['rect', 'Rectangle', 'r'], ['ellipse', 'Ellipse', 'o'],
  ['fill', 'Fill', 'g'], ['pick', 'Colour picker', 'i'],
  ['select', 'Rectangle select', 'm'], ['lasso', 'Lasso select', 'a'],
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
  shapeFill: store.get('deck.paint.shapeFill', false),   // rectangles and ellipses filled, not outlined
  constrain: false,   // square / circle / lines at 45° (also Shift, or a finger held down while the pen draws)
  tol: store.get('deck.paint.tol', 0.12), fillAll: store.get('deck.paint.fillAll', false),   // the fill: how alike, which pixels it looks at
  back: 'brush',   // the tool the colour picker goes back to
};
export const painting = () => P.tool !== 'move';
const brushKey = () => (P.tool === 'eraser' ? 'eraser' : P.tool === 'brush' ? P.brush : SHAPES.includes(P.tool) ? 'shape' : P.tool === 'fill' ? 'fill' : P.brush);
const bset = (k = brushKey()) => ({ ...(BRUSHES[k] || OTHER[k]), ...(P.set[k] || {}) });
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
export const undo = () => { if (P.sel?.float) cancelFloat(); else step(U.undo, U.redo, 'before'); };   // (a lifted selection just drops back)
export const redo = () => { commitFloat(); step(U.redo, U.undo, 'after'); };
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
// an empty buffer, and the live copy the layer is drawn from until the stroke is laid down
function openBuffers(l) {
  const cv = layerCanvas(l);
  const buf = scratch('buf', cv.width, cv.height), live = scratch('live', cv.width, cv.height);
  buf.ctx.clearRect(0, 0, cv.width, cv.height);
  live.ctx.globalCompositeOperation = 'source-over'; live.ctx.globalAlpha = 1;
  live.ctx.clearRect(0, 0, cv.width, cv.height); live.ctx.drawImage(cv, 0, 0);
  l.live = live.cv;
}
function beginStroke(e, l) {
  openBuffers(l);
  S = { l, id: e.pointerId, type: e.pointerType, b: bset(), erase: P.tool === 'eraser', bb: null, sm: null, last: null, carry: 0, raw: null, frame: 0, clip: clipOf(l) };
  moveStroke(e);
}

// ---- shapes: drawn whole into the buffer on every move, from where the pen went down to where it is ----
function beginShape(e, l) {
  openBuffers(l);
  const q = toLayer(l, X.toCanvas(e));
  S = { l, id: e.pointerId, type: e.pointerType, b: bset('shape'), erase: false, bb: null, frame: 0, shape: P.tool, a: q, z: q, shift: e.shiftKey, clip: clipOf(l) };
  drawShape();
}
function moveShape(e) {
  S.z = toLayer(S.l, X.toCanvas(e)); S.shift = e.shiftKey;
  drawShape();
}
function drawShape() {
  const c = SCR.buf.ctx, lw = Math.max(0.5, S.b.size / S.l.scale), filled = P.shapeFill && S.shape !== 'line';
  if (S.bb) { const o = intBox(S.bb, S.l.img); c.clearRect(o.x, o.y, o.w, o.h); }
  const { x: x0, y: y0 } = S.a;
  let { x: x1, y: y1 } = S.z;
  if (P.constrain || S.shift || touches.size) {   // a finger held down while the pen draws constrains too
    if (S.shape === 'line') {
      const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x1 - x0, y1 - y0);
      x1 = x0 + Math.cos(ang) * d; y1 = y0 + Math.sin(ang) * d;
    } else {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
  }
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
  c.save();
  c.globalAlpha = 1; c.strokeStyle = c.fillStyle = P.color; c.lineWidth = lw;
  c.lineCap = 'round'; c.lineJoin = S.shape === 'rect' ? 'miter' : 'round';
  c.beginPath();
  if (S.shape === 'line') { c.moveTo(x0, y0); c.lineTo(x1, y1); } else if (S.shape === 'rect') c.rect(x, y, w, hh);
  else c.ellipse(x + w / 2, y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
  if (filled) c.fill(); else c.stroke();
  c.restore();
  const pad = lw + 2, bb = { x: x - pad, y: y - pad, w: w + 2 * pad, h: hh + 2 * pad };
  S.bb = S.bb ? union(S.bb, bb) : bb;
  if (!S.frame) S.frame = requestAnimationFrame(showStroke);
}

// ---- fill: the pixels joined to the tapped one that look like it, on this layer or as all the layers show it ----
export function flood(img, W, H, x0, y0, tol) {
  const d = img.data, t = Math.round(clamp(tol, 0, 1) * 255), i0 = (y0 * W + x0) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const mask = new Uint8Array(W * H);
  const like = (p) => { const i = p * 4; return !mask[p] && Math.abs(d[i] - r0) <= t && Math.abs(d[i + 1] - g0) <= t && Math.abs(d[i + 2] - b0) <= t && Math.abs(d[i + 3] - a0) <= t; };
  let x1 = x0, x2 = x0, y1 = y0, y2 = y0;
  const stack = [x0, y0];
  while (stack.length) {   // scanlines: fill a run, then look for runs above and below it
    const y = stack.pop(), x = stack.pop(), row = y * W;
    if (!like(row + x)) continue;
    let l = x, r = x;
    while (l > 0 && like(row + l - 1)) l--;
    while (r < W - 1 && like(row + r + 1)) r++;
    mask.fill(1, row + l, row + r + 1);
    x1 = Math.min(x1, l); x2 = Math.max(x2, r); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= H) continue;
      let open = false;
      for (let i = l; i <= r; i++) {
        const ok = like(ny * W + i);
        if (ok && !open) stack.push(i, ny);
        open = ok;
      }
    }
  }
  // grow it a pixel, so it tucks under the soft edge of the lines around it
  const grown = mask.slice();
  for (let y = Math.max(0, y1 - 1); y <= Math.min(H - 1, y2 + 1); y++) {
    for (let x = Math.max(0, x1 - 1); x <= Math.min(W - 1, x2 + 1); x++) {
      const p = y * W + x;
      if (mask[p]) continue;
      if ((x > 0 && mask[p - 1]) || (x < W - 1 && mask[p + 1]) || (y > 0 && mask[p - W]) || (y < H - 1 && mask[p + W])) grown[p] = 1;
    }
  }
  const bx = Math.max(0, x1 - 1), by = Math.max(0, y1 - 1);
  return { mask: grown, bb: { x: bx, y: by, w: Math.min(W - 1, x2 + 1) - bx + 1, h: Math.min(H - 1, y2 + 1) - by + 1 } };
}
function fillAt(e, l) {
  const cv = layerCanvas(l), W = cv.width, H = cv.height;
  const q = toLayer(l, X.toCanvas(e)), x = Math.floor(q.x), y = Math.floor(q.y);
  if (x < 0 || y < 0 || x >= W || y >= H) { toast('Tap inside the layer to fill it', true); return; }
  let src;
  if (P.fillAll) {   // what every layer shows there, drawn in this layer's pixels
    const s = scratch('sample', W, H), k = 1 / l.scale;
    s.ctx.setTransform(1, 0, 0, 1, 0, 0); s.ctx.clearRect(0, 0, W, H);
    s.ctx.setTransform(k, 0, 0, k, -l.x * k + l.crop.x * W, -l.y * k + l.crop.y * H);
    X.composite(s.ctx);
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    src = s.ctx.getImageData(0, 0, W, H);
  } else src = cv.getContext('2d').getImageData(0, 0, W, H);
  const { mask, bb } = flood(src, W, H, x, y, P.tol);
  const buf = scratch('buf', W, H), img = buf.ctx.createImageData(bb.w, bb.h), n = parseInt(P.color.slice(1), 16);
  for (let yy = 0; yy < bb.h; yy++) {
    for (let xx = 0; xx < bb.w; xx++) {
      if (!mask[(bb.y + yy) * W + bb.x + xx]) continue;
      const i = (yy * bb.w + xx) * 4;
      img.data[i] = n >> 16; img.data[i + 1] = (n >> 8) & 255; img.data[i + 2] = n & 255; img.data[i + 3] = 255;
    }
  }
  buf.ctx.clearRect(0, 0, W, H);
  buf.ctx.putImageData(img, bb.x, bb.y);
  change(l, bb, (c) => laydown(c, buf.cv, bb, { b: bset('fill'), erase: false, clip: clipOf(l) }));
  X.redraw();
}

// ---- the colour picker: the colour on screen under the pen (every layer, as shown) ----
function colorAt(e) {
  const cv = X.canvas(), r = cv.getBoundingClientRect();
  const x = clamp(Math.floor((e.clientX - r.left) * cv.width / r.width), 0, cv.width - 1);
  const y = clamp(Math.floor((e.clientY - r.top) * cv.height / r.height), 0, cv.height - 1);
  const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
  return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
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
// (o.clip: a selection's mask; only what's inside it goes down)
function laydown(c, src, bb, o = S) {
  if (bb.w < 1 || bb.h < 1) return;
  if (o.clip) {
    const t = scratch('clip', src.width, src.height).ctx;
    t.clearRect(bb.x, bb.y, bb.w, bb.h);
    t.drawImage(src, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(o.clip, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h);
    t.globalCompositeOperation = 'source-over';
    src = t.canvas;
  }
  c.globalAlpha = o.b.opacity;
  c.globalCompositeOperation = o.erase ? 'destination-out' : 'source-over';
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
  if (bb) change(s.l, bb, (c) => laydown(c, SCR.buf.cv, intBox(bb, s.l.img), s));
  X.redraw();
}
function cancelStroke() {
  if (!S) return;
  cancelAnimationFrame(S.frame);
  if (S.l) S.l.live = null;
  S = null;
  X.redraw();
}

// ---- selections (rectangle and lasso) on the layer being painted: P.sel = { l, poly (layer px), mask (a canvas
// the layer's size, opaque inside), bb, float }. Painting, shapes and fill stay inside it. Dragging inside it lifts
// the pixels (float: { cv, src, x, y, w, h }) to move them, a corner scales them; they go down as one undo step when
// another tool is picked, the selection is dropped, or Done. ----
const selOf = (l) => (P.sel && P.sel.l === l ? P.sel : null);
const clipOf = (l) => selOf(l)?.mask || null;
function polyBox(poly) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function setSel(l, poly) {
  const cv = layerCanvas(l), mask = document.createElement('canvas');
  mask.width = cv.width; mask.height = cv.height;
  const c = mask.getContext('2d');
  c.fillStyle = '#fff'; c.beginPath(); poly.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.fill();
  const bb = intBox(polyBox(poly), cv);
  P.sel = bb.w >= 1 && bb.h >= 1 ? { l, poly, mask, bb, float: null } : null;
}
function inPoly(poly, q) {   // even-odd ray test
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// the rectangle the selection covers now (moved and scaled, while lifted)
const selRect = (s) => (s.float ? { x: s.float.x, y: s.float.y, w: s.float.w, h: s.float.h } : { ...s.bb });
function lift(s) {
  if (s.float) return;
  const l = s.l, cv = l.img, bb = s.bb;
  const f = document.createElement('canvas');
  f.width = bb.w; f.height = bb.h;
  const fc = f.getContext('2d');
  fc.drawImage(cv, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
  fc.globalCompositeOperation = 'destination-in';
  fc.drawImage(s.mask, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
  const holed = scratch('holed', cv.width, cv.height).ctx;   // the layer with the lifted pixels cut out
  holed.globalCompositeOperation = 'source-over';
  holed.clearRect(0, 0, cv.width, cv.height); holed.drawImage(cv, 0, 0);
  holed.globalCompositeOperation = 'destination-out'; holed.drawImage(s.mask, 0, 0); holed.globalCompositeOperation = 'source-over';
  s.float = { cv: f, src: { ...bb }, x: bb.x, y: bb.y, w: bb.w, h: bb.h };
  showFloat(s);
}
function showFloat(s) {
  const cv = s.l.img, live = scratch('live', cv.width, cv.height).ctx, f = s.float;
  live.globalCompositeOperation = 'source-over'; live.globalAlpha = 1;
  live.clearRect(0, 0, cv.width, cv.height);
  live.drawImage(SCR.holed.cv, 0, 0);
  live.drawImage(f.cv, f.x, f.y, f.w, f.h);
  s.l.live = live.canvas;
  X.redraw();
}
// where a point of the lifted pixels ends up
const floatPoint = (f, p) => ({ x: f.x + (p.x - f.src.x) * f.w / f.src.w, y: f.y + (p.y - f.src.y) * f.h / f.src.h });
function commitFloat() {
  const s = P.sel;
  if (!s?.float) return;
  const f = s.float, l = s.l;
  s.float = null; l.live = null;
  if (!E().layers.includes(l)) return;
  change(l, { x: 0, y: 0, w: l.img.width, h: l.img.height }, (c) => {
    c.globalCompositeOperation = 'destination-out'; c.drawImage(s.mask, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.drawImage(f.cv, f.x, f.y, f.w, f.h);
  });
  setSel(l, s.poly.map((p) => floatPoint(f, p)));   // the selection stays on the pixels, where they are now
  X.redraw();
}
function cancelFloat() {
  const s = P.sel;
  if (!s?.float) return;
  s.float = null; s.l.live = null;
  X.redraw(); syncStrip();
}
export function dropSel() {
  if (!P.sel) return;
  commitFloat();
  P.sel = null;
  X.redraw();
}
// the corner of the selection's box under the point (canvas px), if any
function selCorner(s, p) {
  const v = X.view(), l = s.l, r = selRect(s);
  for (const k of ['nw', 'ne', 'sw', 'se']) {
    const q = toCanvasPt(l, { x: k.includes('w') ? r.x : r.x + r.w, y: k.includes('n') ? r.y : r.y + r.h });
    if (Math.hypot(q.x - p.x, q.y - p.y) * v.s < 22) return k;
  }
  return null;
}
const toCanvasPt = (l, q) => ({ x: l.x + (q.x - l.crop.x * l.img.naturalWidth) * l.scale, y: l.y + (q.y - l.crop.y * l.img.naturalHeight) * l.scale });
function beginSelect(e, l) {
  layerCanvas(l);
  const p = X.toCanvas(e), q = toLayer(l, p), s = selOf(l);
  const base = { id: e.pointerId, type: e.pointerType, select: true, sl: l, p0: q };
  const k = s && selCorner(s, p);
  if (s && (k || inPoly(s.float ? s.poly.map((pt) => floatPoint(s.float, pt)) : s.poly, q))) {
    lift(s);
    const f = s.float;
    S = { ...base, move: !k, corner: k, f0: { x: f.x, y: f.y, w: f.w, h: f.h } };
    return;
  }
  commitFloat();
  S = { ...base, poly: [q], shift: e.shiftKey };
  P.sel = null;
  X.redraw();
}
function moveSelect(e) {
  const l = S.sl, q = toLayer(l, X.toCanvas(e));
  if (S.move || S.corner) {
    const s = P.sel, f = s.float, f0 = S.f0, dx = q.x - S.p0.x, dy = q.y - S.p0.y;
    if (S.move) { f.x = Math.round(f0.x + dx); f.y = Math.round(f0.y + dy); } else {
      const k = S.corner, ax = k.includes('w') ? f0.x + f0.w : f0.x, ay = k.includes('n') ? f0.y + f0.h : f0.y;   // the opposite corner stays
      let w = Math.max(2, Math.abs(q.x - ax)), hh = Math.max(2, Math.abs(q.y - ay));
      if (P.constrain || e.shiftKey || touches.size) { const r = Math.max(w / f0.w, hh / f0.h); w = f0.w * r; hh = f0.h * r; }   // keep its shape
      f.w = w; f.h = hh; f.x = k.includes('w') ? ax - w : ax; f.y = k.includes('n') ? ay - hh : ay;
    }
    showFloat(s);
    return;
  }
  S.shift = e.shiftKey;
  if (P.tool === 'lasso') {
    const last = S.poly[S.poly.length - 1], v = X.view();
    if (Math.hypot(q.x - last.x, q.y - last.y) * l.scale * v.s >= 3) S.poly.push(q);
  } else S.poly[1] = q;
  X.redraw();
}
function endSelect() {
  const s = S;
  S = null;
  if (s.move || s.corner) { syncStrip(); X.render(); return; }
  const l = s.sl;
  let poly = s.poly;
  if (P.tool !== 'lasso') {
    const [a, b = a] = poly;
    let w = b.x - a.x, hh = b.y - a.y;
    if (P.constrain || s.shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
    poly = [a, { x: a.x + w, y: a.y }, { x: a.x + w, y: a.y + hh }, { x: a.x, y: a.y + hh }];
  }
  const r = polyBox(poly);
  if (poly.length < 3 || r.w * l.scale * X.view().s < 4 || r.h * l.scale * X.view().s < 4) P.sel = null;   // a tap: nothing selected
  else setSel(l, poly);
  X.render();
}
// what the selection buttons do
function selAction(kind) {
  const s = P.sel;
  if (!s) return;
  commitFloat();
  const l = s.l, cur = P.sel, bb = cur.bb;
  if (kind === 'clear') change(l, bb, (c) => { c.globalCompositeOperation = 'destination-out'; c.drawImage(cur.mask, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h); });
  else if (kind === 'fill') {
    const buf = scratch('buf', l.img.width, l.img.height).ctx;
    buf.clearRect(0, 0, l.img.width, l.img.height);
    buf.fillStyle = P.color; buf.fillRect(bb.x, bb.y, bb.w, bb.h);
    change(l, bb, (c) => laydown(c, buf.canvas, bb, { b: { opacity: 1 }, erase: false, clip: cur.mask }));
  } else if (kind === 'copy' || kind === 'cut') {   // to a new layer above, the same size and place as this one
    const cv = makeCanvas(l.img.width, l.img.height), c = cv.getContext('2d');
    c.drawImage(l.img, 0, 0);
    c.globalCompositeOperation = 'destination-in'; c.drawImage(cur.mask, 0, 0);
    const n = { name: null, label: `${l.label || l.name?.split('/').pop() || 'Layer'} ${kind === 'cut' ? 'cut' : 'copy'}`, crop: { ...l.crop }, x: l.x, y: l.y,
      scale: l.scale, opacity: 1, hidden: false, blend: 'normal', img: cv };
    if (kind === 'cut') change(l, bb, (cc) => { cc.globalCompositeOperation = 'destination-out'; cc.drawImage(cur.mask, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h); });
    const e = E();
    e.layers.splice(e.layers.indexOf(l) + 1, 0, n);
    e.sel = n; P.sel = null;
    dirty(n, 200);
    X.changed();
  } else if (kind === 'all') {
    const w = l.img.width, hh = l.img.height;
    setSel(l, [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: hh }, { x: 0, y: hh }]);
  }
  X.render();
}
// marching ants round the selection (and the one being drawn), handles on its corners
export function paintOverlay(ctx) {
  const v = X.view();
  const l = target();
  if (!v || !l) return;
  const s = selOf(l), drawing = S?.select && S.poly ? S : null;
  if (!s && !drawing) return;
  const scr = (q) => { const p = toCanvasPt(l, q); return { x: v.ox + p.x * v.s, y: v.oy + p.y * v.s }; };
  let poly;
  if (drawing) {
    poly = drawing.poly;
    if (P.tool !== 'lasso') { const [a, b = a] = poly; poly = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; }
  } else poly = s.float ? s.poly.map((p) => floatPoint(s.float, p)) : s.poly;
  const pts = poly.map(scr);
  ctx.save();
  ctx.lineWidth = 1;
  for (const [col, off] of [['#000', 0], ['#fff', 4]]) {
    ctx.strokeStyle = col; ctx.setLineDash([4, 4]); ctx.lineDashOffset = off;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (!drawing || P.tool !== 'lasso') ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (s && !drawing && (P.tool === 'select' || P.tool === 'lasso')) {
    const r = selRect(s), accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
    ctx.fillStyle = accent; ctx.strokeStyle = '#000';
    for (const q of [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }]) {
      const p = scr(q);
      ctx.beginPath(); ctx.rect(p.x - 6, p.y - 6, 12, 12); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
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
    if (S?.shape && S.type !== 'touch') { drawShape(); return; }   // a finger held while the pen draws a shape: constrained
    if (P.penOnly) return;
  }
  if (S || (e.pointerType === 'mouse' && e.button !== 0)) return;
  try { X.canvas().setPointerCapture(e.pointerId); } catch { /* already gone */ }
  if (P.tool === 'pick' || e.altKey) {   // the picker (Alt with any tool picks once)
    S = { pick: true, id: e.pointerId, type: e.pointerType, c: colorAt(e) };
    setColor(S.c, false);
    return;
  }
  const l = target();
  if (!canPaint(l)) return;
  if (P.tool === 'brush' || P.tool === 'eraser') beginStroke(e, l);
  else if (SHAPES.includes(P.tool)) beginShape(e, l);
  else if (P.tool === 'fill') fillAt(e, l);
  else if (P.tool === 'select' || P.tool === 'lasso') beginSelect(e, l);
}
function onMove(e) {
  if (!painting()) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G) { moveGesture(); return; }
  }
  if (S && e.pointerId === S.id) {
    e.stopImmediatePropagation();
    if (S.pick) { S.c = colorAt(e); setColor(S.c, false); } else if (S.select) moveSelect(e); else if (S.shape) moveShape(e); else moveStroke(e);
  }
  if (e.pointerType !== 'touch') showRing(e);
}
function onUp(e) {
  if (!painting()) return;
  e.stopImmediatePropagation();
  if (e.pointerType === 'touch') { endTouch(e.pointerId); if (S?.shape) drawShape(); }
  if (!S || e.pointerId !== S.id) return;
  if (S.pick) {
    const c = S.c; S = null;
    setColor(c);
    if (P.tool === 'pick') setTool(P.back);   // back to what it was picking a colour for
    else X.render();
  } else if (S.select) { if (e.type === 'pointercancel') { S = null; X.redraw(); } else endSelect(); } else if (e.type === 'pointercancel') cancelStroke(); else endStroke();
}

// the brush outline under a hovering pen (or the mouse)
let ring = null;
function showRing(e) {
  if (!ring || !(P.tool === 'brush' || P.tool === 'eraser' || SHAPES.includes(P.tool))) return hideRing();
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
  if (P.sel && (P.sel.l !== target() || !E().layers.includes(P.sel.l))) { commitFloat(); P.sel = null; }   // another layer: the selection goes
  for (const b of strip.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === P.tool);
  strip.querySelector('[data-act=undo]').disabled = !U.undo.length;
  strip.querySelector('[data-act=redo]').disabled = !U.redo.length;
  strip.querySelector('[data-act=fit]').classList.toggle('hidden', !X.zoom.zoomed());
  const sw = strip.querySelector('.paint-color');
  sw.style.setProperty('--c', P.color); sw.querySelector('input').value = P.color;
  X.canvas().style.cursor = painting() ? 'crosshair' : '';
}
export function setTool(t) {
  if (t === P.tool) return;
  cancelStroke();
  if (t === 'pick' && P.tool !== 'move') P.back = P.tool;
  P.tool = t;
  const e = E();
  e.cropping = false;
  if (t === 'move') { dropSel(); X.zoom.reset(); } else commitFloat();
  if (t !== 'move' && t !== 'pick' && !target()) {   // something to paint on: the top layer that can be, or a new white canvas
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
  if (P.tool === 'eraser' || P.tool === 'move') setTool('brush');
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
  const t = P.tool, keepB = (o) => { setBrush(k, o); };
  const swatches = h('div', { class: 'swatches' }, [...new Set([...P.recent, ...SWATCHES])].slice(0, 16).map((c) =>
    h('button', { type: 'button', style: `background:${c}`, class: c === P.color ? 'on' : '', 'aria-label': `Colour ${c}`, onclick: () => { setColor(c); X.render(); } })));
  const toggle = (label, on, flip, title) => button(label, () => { flip(); X.render(); }, { cls: `small${on ? ' on' : ''}`, title });
  const size = (label) => rangeField(label, () => bset(k).size, (v) => keepB({ size: Math.round(v) }), { min: 1, max: 400, step: 1, fmt: (v) => `${Math.round(v)} px` });
  const opacity = (label = 'Opacity') => rangeField(label, () => bset(k).opacity, (v) => keepB({ opacity: clamp(v, 0.01, 1) }), { min: 0.01, max: 1, step: 0.01, fmt: pctFmt });
  const colour = colorField('Colour', () => P.color, (c) => setColor(c, false), swatches);
  const penOnly = toggle('Pen only', P.penOnly, () => { P.penOnly = !P.penOnly; }, 'Fingers pan and zoom, and don\'t paint');
  const on = t === 'pick' ? null : h('div', { class: 'row wrap' },
    hint(l ? `On ${l.label || l.name?.split('/').pop() || 'the new canvas'}${l.locked ? ' (locked)' : ''}${selOf(l) && t !== 'select' && t !== 'lasso' ? ' · inside the selection' : ''}`
      : 'Pick a layer to paint on', 'layer-title'),
    selOf(l) && t !== 'select' && t !== 'lasso' ? button('Deselect', () => { dropSel(); X.render(); }) : null);
  const done = () => setTool('move');
  const gestures = 'Two fingers pan and zoom; tap with two fingers to undo, three to redo.';
  if (t === 'brush' || t === 'eraser') {
    return section(t === 'eraser' ? 'Eraser' : 'Brush', done, on,
      t === 'brush' ? field('Brush', seg(Object.entries(BRUSHES).filter(([id]) => id !== 'eraser').map(([id, o]) => [id, o.label]), P.brush, (v) => {
        P.brush = v; store.set('deck.paint.brush', v); X.render();
      }, { wrap: true })) : null,
      size('Size'), opacity(t === 'eraser' ? 'Strength' : 'Opacity'),
      rangeField('Smoothing', () => P.smooth, (v) => { P.smooth = clamp(v, 0, 1); store.set('deck.paint.smooth', P.smooth); }, { min: 0, max: 1, step: 0.01, fmt: pctFmt }),
      t === 'brush' ? colour : null,
      h('div', { class: 'row wrap' }, penOnly, button('Blank canvas', blankSheet, { title: 'A new empty layer to paint on' })),
      help(`The pen paints: press harder for a wider or stronger line, tilt a pencil to shade. Once the pen has touched the canvas, fingers stop painting (Pen only). ${gestures} [ and ] change the size; Alt picks a colour. Smoothing steadies the line (it trails the pen a little).`));
  }
  if (SHAPES.includes(t)) {
    return section('Shapes', done, on,
      t !== 'line' ? field('Draw', seg([[false, 'Outline'], [true, 'Filled']], P.shapeFill, (v) => { P.shapeFill = v === true || v === 'true'; store.set('deck.paint.shapeFill', P.shapeFill); X.render(); })) : null,
      t === 'line' || !P.shapeFill ? size('Line width') : null, opacity(),
      colour,
      h('div', { class: 'row wrap' },
        toggle(t === 'line' ? 'Snap to 45°' : 'Square / circle', P.constrain, () => { P.constrain = !P.constrain; }, 'Also: hold Shift, or rest a finger on the screen while the pen draws'),
        penOnly),
      help(`Drag from one corner to the other (a line from end to end). Hold Shift, or rest a finger on the screen while the pen draws, for a square, a circle or a line at 45°. ${gestures}`));
  }
  if (t === 'fill') {
    return section('Fill', done, on,
      rangeField('Tolerance', () => P.tol, (v) => { P.tol = clamp(v, 0, 1); store.set('deck.paint.tol', P.tol); }, { min: 0, max: 1, step: 0.01, fmt: pctFmt }),
      field('Look at', seg([[false, 'This layer'], [true, 'All layers']], P.fillAll, (v) => { P.fillAll = v === true || v === 'true'; store.set('deck.paint.fillAll', P.fillAll); })),
      opacity(), colour, penOnly,
      help(`Tap to fill the area of like colour around that point. Tolerance: how different a colour can be and still count. All layers: fills on this layer, up to the lines you see on the others (draw lines on one layer, colour on another). ${gestures}`));
  }
  if (t === 'select' || t === 'lasso') {
    const s = selOf(l), act = (label, kind, title) => button(label, () => selAction(kind), { title, disabled: !s });
    return section('Selection', done, on,
      h('div', { class: 'row wrap' },
        act('Delete', 'clear', 'Clear what\'s selected (Delete)'), act('Fill', 'fill', 'Fill it with the colour'),
        act('Copy to layer', 'copy', 'A new layer with what\'s selected'), act('Cut to layer', 'cut', 'Move what\'s selected to a new layer')),
      h('div', { class: 'row wrap' },
        button('Select all', () => selAction('all'), { disabled: !l }),
        button('Deselect', () => { dropSel(); X.render(); }, { disabled: !s, title: 'Esc' }),
        s?.float ? button('Place', () => { commitFloat(); X.render(); }, { cls: 'small primary', title: 'Put the moved pixels down (Enter)' }) : null),
      colour,
      toggle(t === 'lasso' ? 'Keep shape when scaling' : 'Square / keep shape', P.constrain, () => { P.constrain = !P.constrain; }, 'Also: hold Shift, or rest a finger on the screen'),
      help(`${t === 'lasso' ? 'Draw round what you want.' : 'Drag a box.'} Brushes, shapes and fill then stay inside it. Drag inside it to move what's selected, a corner to scale it; it goes down when you pick another tool, Place or Deselect (undo puts it back). The Editor has no masks, so there's no mask from a selection. ${gestures}`));
  }
  return section('Colour picker', done, colour,
    help('Touch the canvas and slide to pick the colour under the pen; it goes back to the tool you had. With a brush, shape or fill, hold Alt and click to pick without switching.'));
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
    if (e.key === 'Escape') { if (P.sel) dropSel(); else setTool('move'); X.render(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && P.sel) selAction('clear');
    else if (e.key === 'Enter' && P.sel?.float) { commitFloat(); X.render(); }
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
  new ResizeObserver(() => {   // too tall for the canvas (a phone): two columns
    if (!strip) return;
    strip.classList.remove('two');
    strip.classList.toggle('two', strip.scrollHeight > X.viewer().clientHeight - 16);
  }).observe(X.viewer());
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePaint(); });
  return buildStrip();
}
export const paintSync = () => syncStrip();
