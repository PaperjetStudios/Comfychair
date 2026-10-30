import { h, store, toast, clamp, seg, field, section, help, rangeField, button, hint, pctFmt, colorField, openSheet, closeSheet, actions, propNum } from './ui.js';
import { icon } from './icons.js';
import { ASPECT_PRESETS } from './core.js';
import { snapNearest } from './gizmo.js';
import { apply, bounds, canvasToImage, imageToCanvas, invert, layerMatrix } from './layer-geom.js';

// ---------------------------------------------------------------------------
// Painting in the Editor: brushes with pen pressure and tilt, an eraser, blank canvas layers, undo.
// A layer being painted keeps its pixels in a canvas (l.img becomes that canvas: it answers naturalWidth like
// the image did, so the editor draws and hit-tests it as before). The pixels are saved as a PNG named after its
// content (/api/paint), a moment after the last stroke, and the layer then names that file like any input image.
// Each canvas host makes its own painter with createPaint(); P holds its tool and brush settings.
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
// (through its turn and mirrors: a stroke lands under the pen on a turned layer)
const toLayer = canvasToImage;

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

// One painter per canvas host (the Editor tab, the Story tab's shot canvas): its own tool, selection, stroke, undo and
// tool strip. ctx is the host's side: { E, canvas(), viewer(), toCanvas(e), view(), zoom, frame(), redraw(), render(),
// changed(), active(), composite(c), cancelDrag() }. Returns what the host calls, and the strip and brush ring to show.
export function createPaint(ctx) {
  const P = {
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
    selOp: 'new', selMove: 'outline', selAmt: store.get('deck.paint.selAmt', 8), last: null, lastAt: null, guides: [],   // selections: how a shape joins, what a drag moves, Expand / Contract px
    back: 'brush',   // the tool the colour picker goes back to
  };
  const painting = () => P.tool !== 'move';
  const brushKey = () => (P.tool === 'eraser' ? 'eraser' : P.tool === 'brush' ? P.brush : SHAPES.includes(P.tool) ? 'shape' : P.tool === 'fill' ? 'fill' : P.brush);
  const bset = (k = brushKey()) => ({ ...(BRUSHES[k] || OTHER[k]), ...(P.set[k] || {}) });
  function setBrush(k, o) { P.set[k] = { ...(P.set[k] || {}), ...o }; store.set('deck.paint.set', P.set); }

  const X = ctx;
  const E = () => X.E;

  // ---- layer pixels ----

  // A new blank layer to paint on: the canvas's size by default, see-through or filled
  function addBlank({ w, h: hh, fill = null }) {
    const cv = makeCanvas(Math.round(w), Math.round(hh));
    if (fill) { const c = cv.getContext('2d'); c.fillStyle = fill; c.fillRect(0, 0, cv.width, cv.height); }
    const f = X.frame();
    let n = 1;
    while (E().layers.some((o) => o.label === `Canvas ${n}`)) n++;   // the first free number in this edit
    const l = { name: null, label: `Canvas ${n}`, canvas: true, crop: { x: 0, y: 0, w: 1, h: 1 }, x: f ? f.x : 0, y: f ? f.y : 0, scale: 1, opacity: 1,
      hidden: false, blend: 'normal', img: cv };
    E().layers.push(l);
    E().sel = l; E().cropping = false;
    dirty(l, 200);
    X.changed(); X.render();
    return l;
  }
  function blankSheet() {
    const f = X.frame(), dw = f ? f.w : 1024, dh = f ? f.h : 1024;
    let w = dw, hh = dh, fill = store.get('deck.paint.blankFill', 'clear');
    // its size: the canvas's own by default, or a shape and megapixels tapped; Custom types the sides
    let shape = 'canvas', mp = 1;
    const sizeBox = h('div', {});
    const sizeOut = h('span', {});
    const drawSize = () => {
      const a = (ASPECT_PRESETS.find(([k]) => k === shape) || [])[1];
      if (shape === 'canvas') { w = dw; hh = dh; } else if (a) { w = Math.round(Math.sqrt(mp * 1e6 * a) / 8) * 8; hh = Math.round(Math.sqrt((mp * 1e6) / a) / 8) * 8; }
      sizeOut.textContent = `${w}×${hh}`;
      sizeBox.replaceChildren(shape === 'custom'
        ? h('div', { class: 'row' },
          propNum('Width', w, (v) => { w = v; sizeOut.textContent = `${w}×${hh}`; }, () => {}, { min: 16, max: 8192, step: 8 }),
          propNum('Height', hh, (v) => { hh = v; sizeOut.textContent = `${w}×${hh}`; }, () => {}, { min: 16, max: 8192, step: 8 }))
        : shape === 'canvas' ? null
          : field('Megapixels', seg([0.25, 0.5, 1, 1.5, 2, 4].map((v) => [v, `${v}`]), mp, (v) => { mp = v; drawSize(); }, { wrap: true })));
    };
    const shapeSeg = seg([['canvas', 'Canvas size'], ...ASPECT_PRESETS.map(([k]) => [k, k]), ['custom', 'Custom']], shape,
      (v) => { shape = v; drawSize(); }, { wrap: true });
    drawSize();
    openSheet(h('h3', {}, 'Blank canvas'),
      field(['Size', sizeOut], shapeSeg), sizeBox,
      field('Fill', seg([['clear', 'See-through'], ['white', 'White'], ['bg', 'Background colour']], fill, (v) => { fill = v; store.set('deck.paint.blankFill', v); })),
      actions(
        button('Add canvas', () => {
          closeSheet();
          addBlank({ w, h: hh, fill: fill === 'white' ? '#ffffff' : fill === 'bg' ? E().bg : null });
          if (!painting()) setTool('brush');
        }, { cls: 'small primary' }),
        button('Cancel', closeSheet, { cls: 'small ghost' })));
  }

  // ---- the inpaint mask: a see-through layer the canvas's size, painted red (only its alpha counts), kept out of the
  // picture (editor-engine visibleLayers) and read by the Inpaint panel (eng.composeMask) ----
  const maskLayerOf = () => E().layers.find((o) => o.mask) || null;
  function maskLayer(create = true) {
    let l = maskLayerOf();
    if (l || !create) return l;
    const f = X.frame();
    if (!f) { toast('Add a picture first', true); return null; }
    const cv = makeCanvas(f.w, f.h);
    l = { name: null, label: 'Inpaint mask', mask: true, crop: { x: 0, y: 0, w: 1, h: 1 }, x: f.x, y: f.y, scale: 1, opacity: 0.55, hidden: false, blend: 'normal', img: cv };
    E().layers.push(l);   // (on top; the selection stays where it is)
    dirty(l, 200);
    X.changed();
    return l;
  }
  // paint the mask with a brush: its layer picked, red ink
  function paintMask() {
    const l = maskLayer(true);
    if (!l) return;
    l.hidden = false; l.locked = false;
    E().sel = l;
    P.brush = 'ink'; store.set('deck.paint.brush', 'ink');
    setBrush('ink', { size: Math.max(bset('ink').size, 60) });
    P.tool = 'move';   // (so setTool does the rest)
    setTool('brush');
    setColor(MASK_RED, false);
    X.render();
  }
  const MASK_RED = '#ff2d2d';
  // 'clear' empties the mask, 'invert' swaps painted and not
  function maskOp(kind) {
    const m = maskLayer(false);
    if (!m) return;
    const w = m.img.width, hh = m.img.height, old = document.createElement('canvas');
    old.width = w; old.height = hh; old.getContext('2d').drawImage(m.img, 0, 0);
    change(m, { x: 0, y: 0, w, h: hh }, (c) => {
      c.clearRect(0, 0, w, hh);
      if (kind !== 'invert') return;
      c.fillStyle = MASK_RED; c.fillRect(0, 0, w, hh);
      c.globalCompositeOperation = 'destination-out'; c.drawImage(old, 0, 0);
    });
    X.render();
  }
  // the canvas grew: the mask layer takes the new frame f (canvas px), its old paint kept in place (the caller moved it with
  // the other layers), and the rects (canvas px) are marked
  function growMask(f, rects) {
    let l = maskLayerOf();
    const cv = makeCanvas(f.w, f.h), c = cv.getContext('2d');
    if (l) c.drawImage(l.img, l.x - f.x, l.y - f.y);
    else {
      l = { name: null, label: 'Inpaint mask', mask: true, crop: { x: 0, y: 0, w: 1, h: 1 }, x: f.x, y: f.y, scale: 1, opacity: 0.55, hidden: false, blend: 'normal' };
      E().layers.push(l);
    }
    c.fillStyle = MASK_RED;
    for (const r of rects) c.fillRect(r.x - f.x, r.y - f.y, r.w, r.h);
    Object.assign(l, { img: cv, x: f.x, y: f.y, scale: 1, hidden: false, crop: { x: 0, y: 0, w: 1, h: 1 } });
    dirty(l, 200);
  }

  // A painted canvas given a new size (Photoshop's Canvas Size): its pixels stay where they are, anchored by (ax, ay)
  // (0, .5 or 1 for the start, middle or end of each side), and what is added is see-through
  function resizeCanvasLayer(l, w, hh, ax = 0.5, ay = 0.5) {
    if (!isCanvas(l)) return;
    w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
    const ow = l.img.width, oh = l.img.height;
    if (w === ow && hh === oh) return;
    commitFloat(); P.sel && P.sel.cache.clear();
    const cv = makeCanvas(w, hh), dx = Math.round((w - ow) * ax), dy = Math.round((hh - oh) * ay);
    cv.getContext('2d').drawImage(l.img, dx, dy);
    l.img = cv;
    l.x -= dx * l.scale; l.y -= dy * l.scale;
    U.undo = U.undo.filter((e) => e.l !== l); U.redo = U.redo.filter((e) => e.l !== l);   // (their patches were cut for the old size)
    dirty(l, 200);
    X.changed(); X.render();
  }

  // ---- saving: a painted layer is uploaded a moment after its last change (and before the tab is left) ----
  const SAVE_DELAY = 1500;
  let saveTimer = 0, saving = null, saveFailed = false;
  function dirty(l, delay = SAVE_DELAY) {
    l.paintRev = (l.paintRev || 0) + 1;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePaint, delay);
  }
  async function savePaint() {
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
  const unsavedPaint = () => E().layers.some((l) => isCanvas(l) && l.paintRev && l.paintRev !== l.savedRev);

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
  const undo = () => { if (P.sel?.float) cancelFloat(); else step(U.undo, U.redo, 'before'); };   // (a lifted selection just drops back)
  const redo = () => { commitFloat(); step(U.redo, U.undo, 'after'); };
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
  function fillAt(e, l) {
    const cv = layerCanvas(l), W = cv.width, H = cv.height;
    const q = toLayer(l, X.toCanvas(e)), x = Math.floor(q.x), y = Math.floor(q.y);
    if (x < 0 || y < 0 || x >= W || y >= H) { toast('Tap inside the layer to fill it', true); return; }
    let src;
    if (P.fillAll) {   // what every layer shows there, drawn in this layer's pixels
      const s = scratch('sample', W, H);
      s.ctx.setTransform(1, 0, 0, 1, 0, 0); s.ctx.clearRect(0, 0, W, H);
      s.ctx.setTransform(...invert(layerMatrix(l)));   // canvas px -> this layer's pixels
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

  // ---- selections, as Photoshop has them. One selection for the whole canvas (P.sel = { m, ox, oy, rev, cb, cache, float }):
  // m is a canvas (white = selected, soft edges are fine) whose top-left sits at canvas px ox, oy, and cb is the box it
  // covers. It belongs to no layer: any layer can be painted inside it, and a layer's own copy of it (layerSel) is made
  // when that layer is painted, cut or lifted. The marquee tools make shapes that replace it, or (Shift) join it,
  // (Alt) leave it, (Shift + Alt) cross it. Dragging inside it moves the selection alone; Ctrl-drag, or Drag moves:
  // Pixels, lifts the pixels (float) and moves them with it, a corner scales either. Pixels go down when another
  // tool is picked, Place or Deselect (undo puts them back). ----
  const newCanvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
  const ID = [1, 0, 0, 1, 0, 0];
  function alphaBox(cv) {   // the box round the pixels that are at all selected, or null
    const w = cv.width, hh = cv.height, d = cv.getContext('2d').getImageData(0, 0, w, hh).data;
    let x0 = w, y0 = hh, x1 = -1, y1 = -1;
    for (let y = 0; y < hh; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] <= 8) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  // the area selections live in: the canvas and every layer, with a margin
  function workspace() {
    const rs = E().layers.filter((l) => l.img?.naturalWidth && l.x != null && !l.mask).map(bounds), f = X.frame();
    if (f) rs.push(f);
    if (!rs.length) rs.push({ x: 0, y: 0, w: 1024, h: 1024 });
    const x = Math.floor(Math.min(...rs.map((r) => r.x))) - 16, y = Math.floor(Math.min(...rs.map((r) => r.y))) - 16;
    return { x, y, w: clamp(Math.ceil(Math.max(...rs.map((r) => r.x + r.w))) + 16 - x, 32, 8192), h: clamp(Math.ceil(Math.max(...rs.map((r) => r.y + r.h))) + 16 - y, 32, 8192) };
  }
  // a selection just changed: its box is looked up again (and it goes when nothing is left)
  function settleSel(s) {
    s.rev++; s.cache.clear(); s.outline = null;
    const b = alphaBox(s.m);
    if (!b) { P.sel = null; return; }
    s.cb = { x: b.x + s.ox, y: b.y + s.oy, w: b.w, h: b.h };
    P.sel = s;
  }
  // combine a shape (draw(ctx, ox, oy) fills it white on the selection's canvas) with the selection by op
  function applyShape(draw, op) {
    let s = P.sel;
    if (!s || op === 'new') {
      commitFloat();
      const b = workspace();
      s = { m: newCanvas(b.w, b.h), ox: b.x, oy: b.y, rev: 0, cb: null, cache: new Map(), float: null, outline: null };
      op = 'add';
    } else commitFloat();
    const shape = newCanvas(s.m.width, s.m.height), sc = shape.getContext('2d');
    sc.fillStyle = '#fff'; sc.save(); draw(sc, s.ox, s.oy); sc.restore();
    const c = s.m.getContext('2d');
    c.globalCompositeOperation = op === 'sub' ? 'destination-out' : op === 'int' ? 'destination-in' : 'source-over';
    c.drawImage(shape, 0, 0);
    c.globalCompositeOperation = 'source-over';
    settleSel(s);
  }
  const polyShape = (poly) => (c, ox, oy) => { c.beginPath(); poly.forEach((p, i) => (i ? c.lineTo(p.x - ox, p.y - oy) : c.moveTo(p.x - ox, p.y - oy))); c.closePath(); c.fill(); };
  // a layer's pixels (not its see-through parts) as a selection
  function selectLayer(l, op = 'new') {
    if (!l?.img?.naturalWidth || l.x == null) return;
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
    applyShape((sc, ox, oy) => {
      const tmp = newCanvas(sc.canvas.width, sc.canvas.height), tc = tmp.getContext('2d');
      tc.translate(-ox, -oy); tc.transform(...layerMatrix(l));
      tc.drawImage(l.live || l.img, c.x * W, c.y * H, c.w * W, c.h * H, c.x * W, c.y * H, c.w * W, c.h * H);
      tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalCompositeOperation = 'source-in'; tc.fillStyle = '#fff'; tc.fillRect(0, 0, tmp.width, tmp.height);
      sc.drawImage(tmp, 0, 0);
    }, op);
    X.render();
  }
  const invertCanvas = (m) => { const n = newCanvas(m.width, m.height), c = n.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, n.width, n.height); c.globalCompositeOperation = 'destination-out'; c.drawImage(m, 0, 0); return n; };
  function dilate(m, r) {   // every point within r px of it
    const n = newCanvas(m.width, m.height), c = n.getContext('2d'), steps = clamp(Math.ceil(r * 1.5), 8, 48);
    for (const rr of [r, r / 2]) for (let k = 0; k < steps; k++) c.drawImage(m, Math.cos((k / steps) * 2 * Math.PI) * rr, Math.sin((k / steps) * 2 * Math.PI) * rr);
    c.drawImage(m, 0, 0);
    return n;
  }
  // the selection's canvas moved / scaled by T (canvas px -> canvas px)
  function transformed(s, T) {
    const n = newCanvas(s.m.width, s.m.height), c = n.getContext('2d');
    c.translate(-s.ox, -s.oy); c.transform(...T); c.drawImage(s.m, s.ox, s.oy);
    return n;
  }
  // the selection as seen from layer l's own pixels: { mask (the layer's size, white inside), bb (layer px box; w 0: none) }
  function layerSel(l) {
    const s = P.sel;
    if (!s || !l?.img) return null;
    const key = `${s.rev}|${l.x}|${l.y}|${l.scale}|${l.rotation || 0}|${l.flipX ? 1 : 0}${l.flipY ? 1 : 0}|${l.img.width}x${l.img.height}|${l.crop.x},${l.crop.y},${l.crop.w},${l.crop.h}`;
    const hit = s.cache.get(l);
    if (hit?.key === key) return hit;
    const cv = layerCanvas(l), mask = newCanvas(cv.width, cv.height), c = mask.getContext('2d');
    c.setTransform(...invert(layerMatrix(l))); c.drawImage(s.m, s.ox, s.oy);
    const b = alphaBox(mask), out = { key, mask, bb: b ? intBox(b, cv) : { x: 0, y: 0, w: 0, h: 0 } };
    s.cache.set(l, out);
    return out;
  }
  const clipOf = (l) => (P.sel && !P.sel.float ? layerSel(l)?.mask || null : null);
  // Move / Scale of the selection by dragging: T from the pointer
  function dragT(s, p) {
    const dx = p.x - S.p0.x, dy = p.y - S.p0.y, c0 = S.c0;
    if (!S.corner) return [1, 0, 0, 1, dx, dy];
    const k = S.corner, ax = k.includes('w') ? c0.x + c0.w : c0.x, ay = k.includes('n') ? c0.y + c0.h : c0.y;   // the opposite corner stays
    let sx = (p.x - ax) / ((k.includes('w') ? c0.x : c0.x + c0.w) - ax), sy = (p.y - ay) / ((k.includes('n') ? c0.y : c0.y + c0.h) - ay);
    sx = Math.max(0.02, sx); sy = Math.max(0.02, sy);
    if (P.constrain || S.shiftNow || touches.size) { const r = Math.max(sx, sy); sx = sy = r; }
    return [sx, 0, 0, sy, ax - ax * sx, ay - ay * sy];
  }
  function lift(l) {
    const s = P.sel, ls = layerSel(l);
    if (!s || s.float || !ls || ls.bb.w < 1) return false;
    const cv = l.img, bb = ls.bb, f = newCanvas(bb.w, bb.h), fc = f.getContext('2d');
    fc.drawImage(cv, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(ls.mask, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
    const holed = scratch('holed', cv.width, cv.height).ctx;   // the layer with the lifted pixels cut out
    holed.globalCompositeOperation = 'source-over';
    holed.clearRect(0, 0, cv.width, cv.height); holed.drawImage(cv, 0, 0);
    holed.globalCompositeOperation = 'destination-out'; holed.drawImage(ls.mask, 0, 0); holed.globalCompositeOperation = 'source-over';
    s.float = { l, cv: f, mask: ls.mask, src: { ...bb }, x: bb.x, y: bb.y, w: bb.w, h: bb.h, T: ID };
    showFloat(s);
    return true;
  }
  function showFloat(s) {
    const f = s.float, cv = f.l.img, live = scratch('live', cv.width, cv.height).ctx;
    live.globalCompositeOperation = 'source-over'; live.globalAlpha = 1;
    live.clearRect(0, 0, cv.width, cv.height);
    live.drawImage(SCR.holed.cv, 0, 0);
    live.drawImage(f.cv, f.x, f.y, f.w, f.h);
    f.l.live = live.canvas;
    X.redraw();
  }
  // the lifted pixels' box after T: the corners of where they were, through the layer and T and back
  function floatRect(f, T) {
    const M = layerMatrix(f.l), Mi = invert(M), b = f.src;
    const ps = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => apply(Mi, apply(T, apply(M, { x, y }))));
    const x = Math.min(...ps.map((p) => p.x)), y = Math.min(...ps.map((p) => p.y));
    return { x, y, w: Math.max(2, Math.max(...ps.map((p) => p.x)) - x), h: Math.max(2, Math.max(...ps.map((p) => p.y)) - y) };
  }
  function commitFloat() {
    const s = P.sel;
    if (!s?.float) return;
    const f = s.float, l = f.l;
    s.float = null; l.live = null;
    if (E().layers.includes(l)) {
      change(l, { x: 0, y: 0, w: l.img.width, h: l.img.height }, (c) => {
        c.globalCompositeOperation = 'destination-out'; c.drawImage(f.mask, 0, 0);
        c.globalCompositeOperation = 'source-over'; c.drawImage(f.cv, Math.round(f.x), Math.round(f.y), f.w, f.h);
      });
    }
    s.m = transformed(s, f.T);   // the selection stays on the pixels, where they are now
    settleSel(s);
    X.redraw();
  }
  function cancelFloat() {
    const s = P.sel;
    if (!s?.float) return;
    s.float.l.live = null; s.float = null;
    X.redraw(); syncStrip();
  }
  function dropSel() {
    if (!P.sel) return;
    commitFloat();
    if (P.sel) P.last = P.sel.m, P.lastAt = { ox: P.sel.ox, oy: P.sel.oy };   // (Reselect)
    P.sel = null;
    X.redraw();
  }
  function reselect() {
    if (!P.last) return;
    const s = { m: P.last, ox: P.lastAt.ox, oy: P.lastAt.oy, rev: 0, cb: null, cache: new Map(), float: null, outline: null };
    P.last = null;
    settleSel(s);
    X.render();
  }
  const selHit = (s, p) => {
    const b = s.cb;
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return false;
    const x = Math.floor(p.x - s.ox), y = Math.floor(p.y - s.oy);
    return x >= 0 && y >= 0 && x < s.m.width && y < s.m.height && s.m.getContext('2d').getImageData(x, y, 1, 1).data[3] > 100;
  };
  // the corner of the selection's box under the point (canvas px), if any
  function selCorner(s, p) {
    const v = X.view(), r = s.cb;
    for (const k of ['nw', 'ne', 'sw', 'se']) {
      const q = { x: k.includes('w') ? r.x : r.x + r.w, y: k.includes('n') ? r.y : r.y + r.h };
      if (Math.hypot(q.x - p.x, q.y - p.y) * v.s < 22) return k;
    }
    return null;
  }
  // how a new shape joins the selection: the mode picked, Shift adds, Alt leaves, both cross (as in Photoshop)
  const opOf = (e) => (e.shiftKey && e.altKey ? 'int' : e.shiftKey ? 'add' : e.altKey ? 'sub' : P.selOp);
  // snap lines: a point's x and y pulled onto the canvas's and the other layers' edges and centres (P.guides shows them)
  function snapPt(p, e) {
    P.guides = [];
    if (!X.snapOn?.() || e.ctrlKey) return p;
    const t = X.snaps(), thr = 8 / X.view().s, q = { ...p };
    const sx = snapNearest([p.x], t.xs, thr), sy = snapNearest([p.y], t.ys, thr);
    if (sx) { q.x = sx.at; P.guides.push({ x: sx.at }); }
    if (sy) { q.y = sy.at; P.guides.push({ y: sy.at }); }
    return q;
  }
  // a moved box's edges and centre snapped: the shift to add to the drag
  function snapBox(b, dx, dy) {
    P.guides = [];
    if (!X.snapOn?.()) return [dx, dy];
    const t = X.snaps(), thr = 8 / X.view().s, x = b.x + dx, y = b.y + dy;
    const sx = snapNearest([x, x + b.w / 2, x + b.w], t.xs, thr), sy = snapNearest([y, y + b.h / 2, y + b.h], t.ys, thr);
    if (sx) P.guides.push({ x: sx.at });
    if (sy) P.guides.push({ y: sy.at });
    return [dx + (sx ? sx.d : 0), dy + (sy ? sy.d : 0)];
  }
  function beginSelect(e) {
    const p = X.toCanvas(e), s = P.sel, op = opOf(e);
    const base = { id: e.pointerId, type: e.pointerType, select: true, p0: p };
    if (s && op === 'new') {
      const k = selCorner(s, p);
      if (k || selHit(s, p)) {
        const pixels = (P.selMove === 'pixels') !== (e.ctrlKey || e.metaKey);
        if (pixels) {
          const l = target();
          if (!canPaint(l) || !lift(l)) return;
        } else commitFloat();
        S = { ...base, mv: true, corner: k, pixels, c0: { ...P.sel.cb }, T: ID };
        return;
      }
    }
    if (s?.float) commitFloat();
    S = { ...base, poly: [snapPt(p, e)], op, shiftNow: false };
    X.redraw();
  }
  function moveSelect(e) {
    const p = X.toCanvas(e);
    S.shiftNow = e.shiftKey && S.op !== 'add' && S.op !== 'int';
    if (S.mv) {
      const s = P.sel;
      if (S.corner) { const q = snapPt(p, e); S.T = dragT(s, q); } else {
        const [dx, dy] = snapBox(S.c0, p.x - S.p0.x, p.y - S.p0.y);
        S.T = [1, 0, 0, 1, dx, dy];
      }
      if (S.pixels && s.float) { const r = floatRect(s.float, S.T); Object.assign(s.float, r, { T: S.T }); showFloat(s); } else X.redraw();
      return;
    }
    if (P.tool !== 'lasso') P.guides = [];
    if (P.tool === 'lasso') {
      const last = S.poly[S.poly.length - 1], v = X.view();
      if (Math.hypot(p.x - last.x, p.y - last.y) * v.s >= 3) S.poly.push(p);
    } else S.poly[1] = snapPt(p, e);
    X.redraw();
  }
  function endSelect() {
    P.guides = [];
    const d = S;
    S = null;
    if (d.mv) {
      const s = P.sel;
      if (!d.pixels && s) { s.m = transformed(s, d.T); settleSel(s); }
      syncStrip(); X.render();
      return;
    }
    let poly = d.poly;
    if (P.tool !== 'lasso') {
      const [a, b = a] = poly;
      let w = b.x - a.x, hh = b.y - a.y;
      if (P.constrain || d.shiftNow) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      poly = [a, { x: a.x + w, y: a.y }, { x: a.x + w, y: a.y + hh }, { x: a.x, y: a.y + hh }];
    }
    const r = polyBox(poly), v = X.view();
    if (poly.length < 3 || r.w * v.s < 4 || r.h * v.s < 4) { if (d.op === 'new') dropSel(); }   // a tap: nothing selected (a tap deselects, as in Photoshop)
    else applyShape(polyShape(poly), d.op);
    X.render();
  }
  function polyBox(poly) {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  // what the selection buttons do
  function selAction(kind, arg) {
    if (kind === 'all') {
      const f = X.frame() || (target() && bounds(target()));
      if (f) applyShape((c, ox, oy) => c.fillRect(f.x - ox, f.y - oy, f.w, f.h), 'new');
      return X.render();
    }
    if (kind === 'reselect') return reselect();
    if (kind === 'layer') return selectLayer(E().sel, arg || 'new');
    const s = P.sel;
    if (!s) return;
    commitFloat();
    const l = target(), ls = l && layerSel(l), bb = ls?.bb;
    const layerOp = ['clear', 'fill', 'copy', 'cut'].includes(kind);
    if (layerOp && (!l || !ls || bb.w < 1)) return toast(l ? 'The selection is not on this layer' : 'Pick a layer first', true);
    if (layerOp && l.locked && kind !== 'copy') return toast('That layer is locked', true);
    if (kind === 'clear') change(l, bb, (c) => { c.globalCompositeOperation = 'destination-out'; c.drawImage(ls.mask, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h); });
    else if (kind === 'fill') {
      const buf = scratch('buf', l.img.width, l.img.height).ctx;
      buf.clearRect(0, 0, l.img.width, l.img.height);
      buf.fillStyle = P.color; buf.fillRect(bb.x, bb.y, bb.w, bb.h);
      change(l, bb, (c) => laydown(c, buf.canvas, bb, { b: { opacity: 1 }, erase: false, clip: ls.mask }));
    } else if (kind === 'copy' || kind === 'cut') {   // to a new layer above, the same size and place as this one
      const cv = makeCanvas(l.img.width, l.img.height), c = cv.getContext('2d');
      c.drawImage(l.img, 0, 0);
      c.globalCompositeOperation = 'destination-in'; c.drawImage(ls.mask, 0, 0);
      const n = { name: null, label: `${l.label || l.name?.split('/').pop() || 'Layer'} ${kind === 'cut' ? 'cut' : 'copy'}`, crop: { ...l.crop }, x: l.x, y: l.y,
        scale: l.scale, rotation: l.rotation || 0, flipX: !!l.flipX, flipY: !!l.flipY, opacity: 1, hidden: false, blend: 'normal', img: cv };
      if (kind === 'cut') change(l, bb, (cc) => { cc.globalCompositeOperation = 'destination-out'; cc.drawImage(ls.mask, bb.x, bb.y, bb.w, bb.h, bb.x, bb.y, bb.w, bb.h); });
      const e = E();
      e.layers.splice(e.layers.indexOf(l) + 1, 0, n);
      e.sel = n;
      dirty(n, 200);
      X.changed();
    } else if (kind === 'tomask' || kind === 'unmask') {   // the selection added to, or taken off, the inpaint mask
      const m = maskLayer(true);
      if (!m) return;
      const red = newCanvas(s.m.width, s.m.height), rc = red.getContext('2d');
      rc.drawImage(s.m, 0, 0); rc.globalCompositeOperation = 'source-in'; rc.fillStyle = MASK_RED; rc.fillRect(0, 0, red.width, red.height);
      change(m, { x: 0, y: 0, w: m.img.width, h: m.img.height }, (c) => {
        c.globalCompositeOperation = kind === 'tomask' ? 'source-over' : 'destination-out';
        c.drawImage(red, s.ox - m.x, s.oy - m.y);
      });
      if (kind === 'tomask') toast('Added to the inpaint mask (Inpaint panel)');
    } else if (kind === 'invert') {
      s.m = invertCanvas(s.m); settleSel(s);
    } else if (kind === 'grow' || kind === 'shrink' || kind === 'feather') {
      const r = Math.max(1, arg || P.selAmt);
      if (kind === 'grow') s.m = dilate(s.m, r);
      else if (kind === 'shrink') s.m = invertCanvas(dilate(invertCanvas(s.m), r));
      else {
        const n = newCanvas(s.m.width, s.m.height), c = n.getContext('2d');
        if (!('filter' in c)) return toast('Feathering needs a newer browser', true);
        c.filter = `blur(${r / 2}px)`; c.drawImage(s.m, 0, 0);
        s.m = n;
      }
      settleSel(s);
    }
    X.render();
  }
  // the outline of the selection, one stroke wide in canvas px (two canvases: light and dark), looked up per width
  function outlineOf(s, t) {
    if (s.outline?.t === t) return s.outline;
    const w = s.m.width, hh = s.m.height, inner = newCanvas(w, hh), ic = inner.getContext('2d');
    ic.drawImage(s.m, 0, 0);
    ic.globalCompositeOperation = 'destination-in';
    for (const [dx, dy] of [[t, 0], [-t, 0], [0, t], [0, -t]]) ic.drawImage(s.m, dx, dy);
    const edge = newCanvas(w, hh), ec = edge.getContext('2d');
    ec.drawImage(s.m, 0, 0); ec.globalCompositeOperation = 'destination-out'; ec.drawImage(inner, 0, 0);
    ec.globalCompositeOperation = 'source-in';
    const tint = (col) => { const n = newCanvas(w, hh), c = n.getContext('2d'); c.drawImage(edge, 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = col; c.fillRect(0, 0, w, hh); return n; };
    s.outline = { t, light: tint('#fff'), dark: tint('#000') };
    return s.outline;
  }
  // the selection's outline (moved by the drag in progress), the shape being drawn, handles on the corners of the box
  function paintOverlay(ctx) {
    const v = X.view();
    if (!v) return;
    const s = P.sel, drawing = S?.select && S.poly ? S : null;
    if (!s && !drawing) return;
    ctx.save();
    ctx.translate(v.ox, v.oy); ctx.scale(v.s, v.s);
    const T = S?.mv ? S.T : s?.float ? s.float.T : ID;
    if (s) {
      const t = Math.max(1, Math.round(1.5 / v.s)), o = outlineOf(s, t);
      ctx.save(); ctx.transform(...T); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(o.dark, s.ox, s.oy); ctx.drawImage(o.light, s.ox + t * 0.5, s.oy + t * 0.5);
      ctx.restore();
    }
    if (drawing) {
      let poly = drawing.poly;
      if (P.tool !== 'lasso') { const [a, b = a] = poly; poly = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; }
      ctx.lineWidth = 1 / v.s;
      for (const [col, off] of [['#000', 0], ['#fff', 4]]) {
        ctx.strokeStyle = col; ctx.setLineDash([4 / v.s, 4 / v.s]); ctx.lineDashOffset = off / v.s;
        ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        if (P.tool !== 'lasso') ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
    if (s && !drawing && (P.tool === 'select' || P.tool === 'lasso')) {
      const r = s.cb, accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
      ctx.save(); ctx.fillStyle = accent; ctx.strokeStyle = '#000';
      for (const q of [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }]) {
        const a = apply(T, q), x = v.ox + a.x * v.s, y = v.oy + a.y * v.s;
        ctx.beginPath(); ctx.rect(x - 6, y - 6, 12, 12); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    if (P.guides.length && S?.select) {   // snap lines
      ctx.save(); ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1;
      const w = X.canvas().clientWidth, hh = X.canvas().clientHeight;
      for (const g of P.guides) {
        ctx.beginPath();
        if (g.x != null) { const x = Math.round(v.ox + g.x * v.s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); } else { const y = Math.round(v.oy + g.y * v.s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
      }
      ctx.restore();
    }
    placeSelBar(v);
  }

  // ---- the buttons that float over the selection: what you do to it next ----
  let selBar = null;
  function placeSelBar(v) {
    const s = P.sel, show = s && !S?.select && X.active();
    if (!selBar) {
      const b = (label, title, fn) => button(label, () => { fn(); }, { cls: 'small', title });
      selBar = h('div', { class: 'sel-bar hidden', role: 'toolbar', 'aria-label': 'Selection' },
        b('Invert', 'Swap what is selected (Ctrl+Shift+I)', () => selAction('invert')),
        b('Expand', 'Grow it by the panel\'s amount', () => selAction('grow')), b('Contract', 'Shrink it', () => selAction('shrink')),
        b('Feather', 'Soften its edge', () => selAction('feather')),
        b('+ Mask', 'Mark it for inpainting', () => selAction('tomask')), b('− Mask', 'Take it off the inpaint mask', () => selAction('unmask')),
        b('Delete', 'Clear it from the layer', () => selAction('clear')),
        b('Deselect', 'Ctrl+D', () => { dropSel(); X.render(); }));
      selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
      X.viewer().append(selBar);
    }
    selBar.classList.toggle('hidden', !show);
    if (!show) return;
    const r = s.cb, cv = X.canvas(), x0 = v.ox + r.x * v.s, y0 = v.oy + r.y * v.s, bw = selBar.offsetWidth, bh = selBar.offsetHeight;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    let top = y0 - bh - 8;
    if (top < 4) top = Math.min(ch - bh - 4, y0 + r.h * v.s + 8);
    if (top < 4) top = 4;
    const left = clamp(x0 + (r.w * v.s - bw) / 2, 4, Math.max(4, cw - bw - 4));
    selBar.style.left = `${cv.offsetLeft + left}px`; selBar.style.top = `${cv.offsetTop + top}px`;
  }

  // ---- hold a layer to select its pixels ----
  let LP = null, swallow = null;
  const stopLP = () => { if (LP) { clearTimeout(LP.t); LP = null; } };
  function fireLong(e) {
    LP = null;
    const l = X.hit?.(X.toCanvas(e));
    if (!l) return;
    X.cancelDrag(); cancelStroke(); S = null;
    E().sel = l;
    swallow = e.pointerId;
    if (P.tool !== 'select' && P.tool !== 'lasso') setTool('select');
    selectLayer(l, opOf(e));
    if (navigator.vibrate) navigator.vibrate(15);
  }
  function initLongPress() {
    const cv = X.canvas();
    cv.addEventListener('pointerdown', (e) => {
      stopLP();
      if (!X.active() || (e.pointerType === 'mouse' && e.button !== 0) || !['move', 'select', 'lasso'].includes(P.tool) || touches.size > 1 || e.ctrlKey) return;
      LP = { id: e.pointerId, x: e.clientX, y: e.clientY, t: setTimeout(() => fireLong(e), 520) };
    }, true);
    cv.addEventListener('pointermove', (e) => { if (LP && LP.id === e.pointerId && Math.hypot(e.clientX - LP.x, e.clientY - LP.y) > 8) stopLP(); }, true);
    for (const t of ['pointerup', 'pointercancel']) cv.addEventListener(t, stopLP, true);
    for (const t of ['pointerup', 'pointercancel', 'click']) window.addEventListener(t, (e) => {   // the press that selected a layer does nothing more
      if (swallow == null || (e.pointerId != null && e.pointerId !== swallow)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (t !== 'click') swallow = null; else setTimeout(() => { swallow = null; }, 0);
    }, true);
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
    const tap = painting() && performance.now() - G.t0 < 300 && G.moved < 12;   // (taps undo paint, so only while painting)
    if (tap && G.n === 2) undo(); else if (tap && G.n >= 3) redo();
    G = null;
  }

  // In Move mode one finger stays the editor's (move, resize, crop); a second one makes it a pinch.
  function moveModeDown(e) {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size < 2) return;
    e.stopImmediatePropagation(); e.preventDefault();
    X.cancelDrag();
    try { X.canvas().setPointerCapture(e.pointerId); } catch { /* already gone */ }
    if (!G) startGesture(); else G.n = Math.max(G.n, touches.size);
  }
  function onDown(e) {
    if (!X.active()) return;
    if (!painting()) { moveModeDown(e); return; }
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
    const marquee = P.tool === 'select' || P.tool === 'lasso';
    if (P.tool === 'pick' || (e.altKey && !marquee)) {   // the picker (Alt with any tool picks once; with a marquee it takes away from the selection)
      S = { pick: true, id: e.pointerId, type: e.pointerType, c: colorAt(e) };
      setColor(S.c, false);
      return;
    }
    if (marquee) { beginSelect(e); return; }   // (a selection needs no layer)
    let l = target();
    if (!l) {   // nothing selected (another document was opened): the top layer that can take paint
      l = [...E().layers].reverse().find((o) => o.img?.naturalWidth && o.x != null && !o.hidden && !o.locked) || null;
      if (l) { E().sel = l; X.render(); }
    }
    if (!canPaint(l)) return;
    if (P.tool === 'brush' || P.tool === 'eraser') beginStroke(e, l);
    else if (SHAPES.includes(P.tool)) beginShape(e, l);
    else if (P.tool === 'fill') fillAt(e, l);
  }
  function onMove(e) {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (G) { e.stopImmediatePropagation(); moveGesture(); return; }
    }
    if (!painting()) return;
    if (S && e.pointerId === S.id) {
      e.stopImmediatePropagation();
      if (S.pick) { S.c = colorAt(e); setColor(S.c, false); } else if (S.select) moveSelect(e); else if (S.shape) moveShape(e); else moveStroke(e);
    }
    if (e.pointerType !== 'touch') showRing(e);
  }
  function onUp(e) {
    if (!painting()) {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      const pinching = !!G;
      endTouch(e.pointerId);
      if (pinching) e.stopImmediatePropagation();   // (the editor's drag ended with the pinch)
      return;
    }
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
    if (P.sel?.float && !E().layers.includes(P.sel.float.l)) cancelFloat();   // its layer is gone
    for (const b of strip.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === P.tool);
    strip.querySelector('[data-act=undo]').disabled = !U.undo.length;
    strip.querySelector('[data-act=redo]').disabled = !U.redo.length;
    strip.querySelector('[data-act=fit]').classList.toggle('hidden', !X.zoom.zoomed());
    const sw = strip.querySelector('.paint-color');
    sw.style.setProperty('--c', P.color); sw.querySelector('input').value = P.color;
    X.canvas().style.cursor = painting() ? 'crosshair' : '';
  }
  function setTool(t) {
    if (t === P.tool) return;
    cancelStroke();
    if (t === 'pick' && P.tool !== 'move') P.back = P.tool;
    P.tool = t;
    const e = E();
    e.cropping = false;
    commitFloat();   // (the selection stays through any tool, as in Photoshop; the zoom stays too)
    if (t !== 'move' && t !== 'pick' && !target()) {   // something to paint on: the top layer that can be, or a new white canvas
      const l = [...e.layers].reverse().find((o) => o.img?.naturalWidth && o.x != null && !o.hidden && !o.locked);
      if (l) e.sel = l;
      else if (!e.layers.length) addBlank({ ...(X.frame() || { w: 1024, h: 1024 }), fill: '#ffffff' });
    }
    hideRing();
    X.render();
  }
  function setColor(c, keep = true) {
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
  function paintProps() {
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
      hint(l ? `On ${l.label || l.name?.split('/').pop() || 'the new canvas'}${l.locked ? ' (locked)' : ''}${P.sel && t !== 'select' && t !== 'lasso' ? ' · inside the selection' : ''}`
        : 'Pick a layer to paint on', 'layer-title'),
      P.sel && t !== 'select' && t !== 'lasso' ? button('Deselect', () => { dropSel(); X.render(); }) : null);
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
      const s = P.sel, act = (label, kind, title) => button(label, () => selAction(kind), { title, disabled: !s });
      return section('Selection', done, on,
        field('New shape', seg([['new', 'New'], ['add', 'Add'], ['sub', 'Subtract'], ['int', 'Intersect']], P.selOp, (v) => { P.selOp = v; },),
          help('How the next shape joins the selection. Without touching this: hold Shift to add, Alt to subtract, Shift + Alt to intersect.')),
        field('Dragging inside moves', seg([['outline', 'The selection'], ['pixels', 'The pixels']], P.selMove, (v) => { P.selMove = v; }),
          help('The selection alone (the pixels stay), or the selected pixels with it. Ctrl-drag does the other one.')),
        h('div', { class: 'row wrap' },
          button('Select all', () => selAction('all')), button('Deselect', () => { dropSel(); X.render(); }, { disabled: !s, title: 'Ctrl+D or Esc' }),
          act('Invert', 'invert', 'Ctrl+Shift+I'), button('Reselect', () => selAction('reselect'), { disabled: !!s || !P.last, title: 'Ctrl+Shift+D' }),
          button('Layer', () => selAction('layer'), { disabled: !E().sel, title: 'Select the picked layer\'s pixels (hold a layer on the canvas, or Ctrl-tap its row)' }),
          s?.float ? button('Place', () => { commitFloat(); X.render(); }, { cls: 'small primary', title: 'Put the moved pixels down (Enter)' }) : null),
        rangeField('Expand / contract by', () => P.selAmt, (v) => { P.selAmt = Math.round(v); store.set('deck.paint.selAmt', P.selAmt); }, { min: 1, max: 100, step: 1, fmt: (v) => `${Math.round(v)} px` }),
        h('div', { class: 'row wrap' }, act('Expand', 'grow'), act('Contract', 'shrink'), act('Feather', 'feather', 'Soften its edge by this much')),
        h('div', { class: 'row wrap' },
          act('Delete', 'clear', 'Clear what\'s selected (Delete)'), act('Fill', 'fill', 'Fill it with the colour'),
          act('Copy to layer', 'copy', 'A new layer with what\'s selected'), act('Cut to layer', 'cut', 'Move what\'s selected to a new layer')),
        h('div', { class: 'row wrap' },
          act('Add to inpaint mask', 'tomask', 'Mark it for inpainting'), act('Remove from mask', 'unmask', 'Take it off the inpaint mask')),
        colour,
        toggle(t === 'lasso' ? 'Keep shape when scaling' : 'Square / keep shape', P.constrain, () => { P.constrain = !P.constrain; }, 'Also: hold Shift once the drag has started, or rest a finger on the screen'),
        help(`${t === 'lasso' ? 'Draw round what you want.' : 'Drag a box; it snaps to the canvas and the other layers (the Snap button).'} Brushes, shapes and fill then stay inside it. Hold a layer on the canvas to select its pixels. Drag inside the selection to move it, a corner to scale it. ${gestures}`));
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'd' || (k === 'i' && e.shiftKey))) {   // Ctrl+D deselects, Ctrl+Shift+I inverts, Ctrl+Shift+D selects again
      e.preventDefault(); e.stopImmediatePropagation();
      if (k === 'i') selAction('invert'); else if (e.shiftKey) reselect(); else { dropSel(); X.render(); }
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

  // set up: the pointer, keys and the tool strip
  const cv = X.canvas();
  initLongPress();
  cv.addEventListener('pointerdown', onDown, true);
  cv.addEventListener('pointermove', onMove, true);
  cv.addEventListener('pointerup', onUp, true);
  cv.addEventListener('pointercancel', onUp, true);
  cv.addEventListener('pointerleave', hideRing);
  cv.addEventListener('wheel', (e) => {   // the wheel zooms about the pointer
    if (!X.active()) return;
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
  // the selection as a mask over the whole canvas (white inside), for a masked refine; null without one
  function selectionMask(frame) {
    const sl = P.sel;
    if (!sl || !frame) return null;
    commitFloat();
    const m = newCanvas(frame.w, frame.h), c = m.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, m.width, m.height);
    c.drawImage(P.sel.m, P.sel.ox - frame.x, P.sel.oy - frame.y);
    return m;
  }
  return {
    P, els: buildStrip(), painting, paintProps, paintOverlay, sync: syncStrip, savePaint, unsavedPaint, setTool, setColor,
    blankSheet, addBlank, dropSel, undo, redo, selectionMask, maskLayer, paintMask, hasSel: () => !!P.sel, selAction, selectLayer, resizeCanvasLayer, maskOp, growMask,
    reset() { cancelStroke(); dropSel(); U.undo = []; U.redo = []; U.bytes = 0; syncStrip(); },   // another document: its undo goes
  };
}
