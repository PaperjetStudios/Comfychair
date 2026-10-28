import { h, store, toast, clamp, openOverlay, button, iconBtn, seg, numSlider, help } from './ui.js';
import { icon } from './icons.js';
import { inputUrl } from './core.js';

// ---------------------------------------------------------------------------
// Mask painter: paint over a Generate picture (as cropped) where an edit may change it. The painted part shows as a
// red tint; the saved mask is a white-on-black PNG (white = change), the picture's size as cropped.
// The pen paints (pressure sets the width, as on the sketch pad), fingers paint until a pen has been seen; two
// fingers pan and zoom (Pen only: one finger pans too), a two-finger tap undoes, three redoes. The brush size is
// in screen pixels, so zooming in paints finer. The Editor's tool strip and brush ring styles are reused.
// openMaskPainter({ picture, crop, mask, onDone(blob, box) }): mask is the current mask's input name (to edit it);
// onDone gets the PNG and the painted area's box ({x, y, w, h} fractions), or (null, null) when nothing is painted.
// ---------------------------------------------------------------------------
const MAX_SIDE = 2048;   // the server scales the mask to the output anyway
const TINT = '#ff2d2d';
const UNDO_MAX = 20;

function loadImage(url) {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

// the painted area's box as fractions, or null when nothing is painted (alpha above a trace)
export function maskBox(data, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] <= 16) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
}

export async function openMaskPainter({ picture, crop = null, mask = null, onDone }) {
  let img;
  try { img = await loadImage(inputUrl(picture)); } catch { return toast('Could not load the picture', true); }
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(c.x * img.naturalWidth), sy = Math.round(c.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(c.w * img.naturalWidth)), sh = Math.max(1, Math.round(c.h * img.naturalHeight));
  const k = Math.min(1, MAX_SIDE / Math.max(sw, sh)), W = Math.round(sw * k), H = Math.round(sh * k);

  const st = { tool: 'paint', size: store.get('deck.mask.size', 40), penOnly: false, undo: [], redo: [], dirty: false };
  const base = h('canvas', { class: 'mask-base', width: W, height: H });
  base.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  const cv = h('canvas', { class: 'mask-paint', width: W, height: H });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const layer = h('div', { class: 'mask-layer', style: `width:${W}px;height:${H}px` }, base, cv);
  const ring = h('div', { class: 'brush-ring hidden' });
  const stage = h('div', { class: 'mask-stage' }, layer, ring);

  if (mask) {   // editing: the saved mask (white = change) back as the red tint
    try {
      const m = await loadImage(inputUrl(mask));
      ctx.drawImage(m, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H), p = d.data;
      for (let i = 0; i < p.length; i += 4) { p[i + 3] = p[i]; p[i] = 255; p[i + 1] = 45; p[i + 2] = 45; }
      ctx.putImageData(d, 0, 0);
    } catch { toast('Could not load the mask; starting a new one', true); }
  }

  // ---- view: the layer is scaled by z and moved by (tx, ty) inside the stage ----
  const V = { z: 1, tx: 0, ty: 0 };
  const apply = () => { layer.style.transform = `translate(${V.tx}px, ${V.ty}px) scale(${V.z})`; };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    V.z = Math.min((r.width - 24) / W, (r.height - 24) / H);
    V.tx = (r.width - W * V.z) / 2; V.ty = (r.height - H * V.z) / 2;
    apply();
  };
  const zoomAt = (z, px, py) => {   // keep the picture point under (px, py) (stage px) where it is
    z = clamp(z, 0.05, 40);
    V.tx = px - (px - V.tx) * z / V.z; V.ty = py - (py - V.ty) * z / V.z; V.z = z;
    apply();
  };
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toPic = (e) => { const p = local(e); return [(p.x - V.tx) / V.z, (p.y - V.ty) / V.z]; };

  // ---- undo: the mask's alpha before each change ----
  const alpha = () => { const p = ctx.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H); for (let i = 0; i < a.length; i++) a[i] = p[i * 4 + 3]; return a; };
  const putAlpha = (a) => {
    const d = ctx.createImageData(W, H), p = d.data;
    for (let i = 0; i < a.length; i++) { const j = i * 4; p[j] = 255; p[j + 1] = 45; p[j + 2] = 45; p[j + 3] = a[i]; }
    ctx.putImageData(d, 0, 0);
  };
  const snapshot = () => {
    st.undo.push(alpha());
    if (st.undo.length > UNDO_MAX) st.undo.shift();
    st.redo = []; st.dirty = true;
    syncBar();
  };
  const step = (from, to) => {
    if (!from.length) return;
    to.push(alpha());
    putAlpha(from.pop());
    st.dirty = true;
    syncBar();
  };
  const undo = () => step(st.undo, st.redo), redo = () => step(st.redo, st.undo);
  const whole = (fn) => { snapshot(); ctx.save(); fn(); ctx.restore(); };

  // ---- strokes (as the sketch pad: round segments, pen pressure sets the width) ----
  let stroke = null;
  const width = (e) => (st.size / V.z) * (e.pointerType === 'pen' ? 0.15 + 0.85 * (e.pressure || 0.5) : 1);
  const paintTo = (e) => {
    ctx.globalCompositeOperation = st.tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = TINT; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const evs = e.getCoalescedEvents?.() || [];
    for (const ev of (evs.length ? evs : [e])) {
      const p = toPic(ev), w = width(ev);
      if (!stroke.last) { ctx.beginPath(); ctx.arc(p[0], p[1], w / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(...stroke.last); ctx.lineTo(...p); ctx.stroke(); }
      stroke.last = p;
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  const cancelStroke = () => { if (stroke) { putAlpha(st.undo.pop()); stroke = null; syncBar(); } };

  // ---- pointers ----
  const touches = new Map();
  let G = null;   // two or more fingers (or one, with Pen only): pan and zoom
  const startGesture = () => {
    const ps = [...touches.values()], m = mid(ps), d = spread(ps);
    G = { n: ps.length, t0: performance.now(), moved: 0, m, d, m0: m, d0: d };
  };
  const mid = (ps) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });
  const spread = (ps) => (ps.length > 1 ? Math.max(10, Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)) : 0);
  const moveGesture = () => {
    const ps = [...touches.values()], m = mid(ps), d = spread(ps);
    if (ps.length !== G.n) { G.m = m; G.d = d; G.n = ps.length; G.d0 ||= d; return; }   // a finger more or less: start again from here
    G.moved = Math.max(G.moved, Math.hypot(m.x - G.m0.x, m.y - G.m0.y), G.d0 && d ? Math.abs(d - G.d0) : 0);   // (a pinch is not a tap)
    V.tx += m.x - G.m.x; V.ty += m.y - G.m.y;
    if (d && G.d) zoomAt(V.z * d / G.d, m.x, m.y); else apply();
    G.m = m; G.d = d;
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    if (e.pointerType === 'pen' && !st.penOnly) { st.penOnly = true; syncBar(); }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, local(e));
      if (touches.size >= 2 || st.penOnly) {
        if (stroke?.type === 'touch') cancelStroke();   // the first finger was the start of a pinch
        if (!G) startGesture(); else G.n = 0;
        G.max = Math.max(G.max || 0, touches.size);
        return;
      }
    }
    if (stroke) return;
    snapshot();
    stroke = { id: e.pointerId, type: e.pointerType, last: null };
    paintTo(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, local(e));
      if (G) { moveGesture(); return; }
    }
    if (stroke && e.pointerId === stroke.id) paintTo(e);
    if (e.pointerType !== 'touch') showRing(e);
  });
  const up = (e) => {
    if (e.pointerType === 'touch' && touches.delete(e.pointerId) && G) {
      if (!touches.size) {
        const tap = performance.now() - G.t0 < 300 && G.moved < 12;
        if (tap && G.max === 2) undo(); else if (tap && G.max >= 3) redo();
        G = null;
      } else G.n = 0;
      return;
    }
    if (stroke && e.pointerId === stroke.id) stroke = null;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', () => ring.classList.add('hidden'));
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(V.z * Math.exp(-e.deltaY * 0.0015), p.x, p.y); }, { passive: false });
  const showRing = (e) => {
    const p = local(e), d = Math.max(4, st.size);
    Object.assign(ring.style, { width: `${d}px`, height: `${d}px`, left: `${p.x - d / 2}px`, top: `${p.y - d / 2}px` });
    ring.classList.remove('hidden');
  };

  // ---- the bar ----
  const sizeIn = numSlider({ min: 2, max: 300, step: 1, value: st.size, label: 'Brush size' });
  const setSize = () => { st.size = Number(sizeIn.value); store.set('deck.mask.size', st.size); };
  sizeIn.addEventListener('input', setSize); sizeIn.addEventListener('change', setSize);
  const toolSeg = seg([['paint', [icon('brush'), 'Paint']], ['erase', [icon('eraser'), 'Erase']]], st.tool, (t) => { st.tool = t; });
  const penBtn = button('Pen only', () => { st.penOnly = !st.penOnly; syncBar(); }, { title: 'Fingers pan and zoom, and don\'t paint' });
  const undoBtn = iconBtn('Undo (or tap with two fingers)', icon('undo'), undo);
  const redoBtn = iconBtn('Redo (or tap with three fingers)', icon('redo'), redo);
  const syncBar = () => {
    penBtn.classList.toggle('on', st.penOnly);
    undoBtn.disabled = !st.undo.length; redoBtn.disabled = !st.redo.length;
  };
  const save = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const box = maskBox(ctx.getImageData(0, 0, W, H).data, W, H);
    if (!box) { close(false, true); onDone(null, null); return; }
    const out = h('canvas', { width: W, height: H }), o = out.getContext('2d');   // white where painted, on black
    const white = h('canvas', { width: W, height: H }), w = white.getContext('2d');
    w.drawImage(cv, 0, 0); w.globalCompositeOperation = 'source-in'; w.fillStyle = '#fff'; w.fillRect(0, 0, W, H);
    o.fillStyle = '#000'; o.fillRect(0, 0, W, H); o.drawImage(white, 0, 0);
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    try { await onDone(blob, box); close(false, true); } catch (err) { toast(`Couldn't save the mask: ${err.message}`, true); btn.disabled = false; }
  };
  const overlay = h('div', { class: 'sketch mask-painter' },
    h('div', { class: 'sketch-bar' },
      toolSeg,
      h('label', { class: 'sketch-size' }, 'Size', sizeIn),
      penBtn, undoBtn, redoBtn,
      button('Invert', () => whole(() => { ctx.globalCompositeOperation = 'xor'; ctx.fillStyle = TINT; ctx.fillRect(0, 0, W, H); })),
      button('Fill all', () => whole(() => { ctx.fillStyle = TINT; ctx.fillRect(0, 0, W, H); })),
      button('Clear', () => whole(() => ctx.clearRect(0, 0, W, H))),
      iconBtn('Fit the picture in view', icon('fit'), fit),
      help('Paint over what the edit may change: it shows red. Everything else is kept exactly as it was (the result is put back onto your picture through the mask). Press harder with the pen for a wider line; the size is on screen, so zoom in for fine work. Once the pen has touched the screen, fingers stop painting (Pen only): two fingers pan and zoom, a two-finger tap undoes, three redoes. Invert swaps painted and kept. [ and ] change the size, B and E switch between paint and erase, Ctrl+Z undoes.'),
      h('div', { class: 'spacer' }),
      button('Cancel', () => close(), { cls: 'small ghost' }),
      button('Use mask', save, { cls: 'small primary' })),
    stage);
  // keys, as in the Editor: Ctrl+Z / Ctrl+Shift+Z, [ ] for the size, B / E for paint and erase
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) { e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo(); }
    else if (e.key === '[' || e.key === ']') { sizeIn.set(e.key === ']' ? st.size * 1.2 + 1 : st.size / 1.2 - 1); setSize(); }
    else if (k === 'b' || k === 'e') { st.tool = k === 'b' ? 'paint' : 'erase'; toolSeg.set(st.tool); }
    else return;
    e.stopImmediatePropagation();
  };
  document.addEventListener('keydown', onKey, true);
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  const close = openOverlay(overlay, { dirty: () => st.dirty, ask: 'Throw away this mask?',
    onClose: () => { ro.disconnect(); document.removeEventListener('keydown', onKey, true); } });
  syncBar();
  fit();
}
