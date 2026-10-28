import {
  h, api, clamp01, busy, toast, undoToast, sheetOpen, openSheet, closeSheet, button, iconBtn, actions,
  seg, field, section, hint, propNum, layerRowsEl, panelTop, help, colorField, rangeField, pctFmt, clamp,
} from './ui.js';
import { ASPECT_PRESETS, S, inputUrl, switchTab, thumbUrl } from './core.js';
import { openImagePicker, uploadImage } from './media.js';
import { snapNearest } from './gizmo.js';
import { mpInput, persist, renderFields } from './generate.js';
import { openCraftSheet, sendToCraft } from './craft.js';
import { animated, anyKeys, keyTimes, keyedRange, refreshKeyed, value } from './keyed.js';
import { putKey } from './keys.js';
import { playKeys, transport } from './playback.js';
import { workArea } from './workarea.js';
import { frameSpan, playFrom, tickT } from './workarea-math.js';
import { framesToClip } from './scene-comp.js';
import { openGeneration } from './run.js';
import { BLENDS, blendOp, createPaint, isCanvas } from './paint.js';
import { icon } from './icons.js';
import * as G from './layer-geom.js';

// ---------------------------------------------------------------------------
// editor: a simple Photoshop-style layer stack for cropping images and putting them together
// (character sheets, side-by-side refs). Each layer is an input image with a crop, a position and
// a scale. Everything is drawn client-side on a canvas, then uploaded as a new input image.
// The engine is made once per host with createEditor(): the Editor tab (editor.js, its edit tabs) and the Story
// tab's shot canvas (story.js, one composition per shot) each have their own state, view, painter and undo.
// ---------------------------------------------------------------------------
export const FULL = { x: 0, y: 0, w: 1, h: 1 };
export const BLANK = () => ({ v: 2, size: null, cols: 2, gap: 0, bg: '#000000', mp: 0, snap: true, arrange: null, anim: null, layers: [] });
// a saved payload (an edit tab, or the old `deck.editor`) as editor state
export function fromSaved(saved) {
  const e = { ...BLANK(), ...saved, arrange: saved.arrange || null };
  // layers: { name, crop: {x,y,w,h} as fractions, x, y (canvas px), scale, rotation (degrees, about the kept part's
  // centre), flipX, flipY (layer-geom.js), opacity, hidden, chans (its keys), img,
  // blend (paint.js BLENDS), locked, label (the name shown, for a painted layer whose file is named after its pixels) };
  // the last one is drawn on top. size: a fixed {w,h} canvas, or null to fit around the layers. anim: see below.
  e.layers = (saved.layers || []).map((l) => ({ name: l.name, crop: { ...(l.crop || FULL) },
    x: l.x, y: l.y, scale: l.x == null ? 1 : l.scale, opacity: l.opacity ?? 1, hidden: !!l.hidden,
    blend: l.blend || 'normal', locked: !!l.locked, ...(l.label ? { label: l.label } : {}),
    ...(l.rotation ? { rotation: +l.rotation } : {}), ...(l.flipX ? { flipX: true } : {}), ...(l.flipY ? { flipY: true } : {}),
    ...(l.chans ? { chans: structuredClone(l.chans) } : {}) }));
  // The old auto-layout editor kept no positions: lay its images out once they load, in the same
  // order (its first image was leftmost, so it goes to the top of the list).
  if (saved.v !== 2 && e.layers.length) { e.arrange = saved.layout || 'row'; e.layers.reverse(); }
  delete e.layout;
  return e;
}

// cfg: { canvas, empty, size?, anim? (the animation bar; none: no animating), panel, panelParts(eng) (what the panel
// shows) or renderPanel(eng) (the host fills it), active() (on show, no sheet over it), onChange() (after every edit), docId() (for Undo across documents),
// name() (for exports), initial (a saved payload), noLayers (the empty canvas's hint) }
export function createEditor(cfg) {
  const E = fromSaved(cfg.initial || {});
  E.sel = null; E.cropping = false; E.aspect = null; E.guides = [];   // guides: snap lines {x} or {y} while dragging
  E.t = 0;   // the playhead, seconds (an animation)
  E.tab = null;   // the document this state belongs to (the Editor tab's: { id, qs })
  const $cv = cfg.canvas;
  let toolbar = null, paint = null;

  // What a tab stores: the editor's settings and its layers (input image names + crop/position), all small.
  // (Layers only ever name input images, so nothing here is a data URL or a blob. A new blank canvas has no file
  // until its first save, a moment later: it's left out until then.)
  const dumpEditor = () => ({ v: 2, size: E.size, cols: E.cols, gap: E.gap, bg: E.bg, mp: E.mp, snap: E.snap, arrange: E.arrange, anim: E.anim,
    layers: E.layers.filter((l) => l.name).map((l) => ({ name: l.name, crop: l.crop, x: l.x, y: l.y, scale: l.scale, opacity: l.opacity, hidden: l.hidden,
      blend: l.blend || 'normal', locked: !!l.locked, label: l.label || null, chans: l.chans || null,
      ...(l.rotation ? { rotation: l.rotation } : {}), ...(l.flipX ? { flipX: true } : {}), ...(l.flipY ? { flipY: true } : {}) })) });
  // every edit ends up here: an animated layer keys what moved, then the host saves (the Editor tab's tab and still)
  function persistEditor() { keyPose(); cfg.onChange?.(); }

  // ---- animation: layers keyed over time like After Effects, on keys.js (the engine the Video tab's clips and the 3D tab use) ----
  // E.anim: null (a still) or { len, fps, range? } (seconds, frames a second; range: the work area, workarea.js). A layer's keys are l.chans[ch] = [{ f: seconds, v }], and
  // l.x / l.y / l.scale / l.opacity always hold its pose at the playhead, so everything that draws, drags or hit-tests reads
  // those as before: moving the playhead poses the layers (poseAt), and a change keys whichever animated property it moved
  // (keyPose). An animation keeps a fixed canvas, and exports as a clip (frames → /api/scene/clip → /api/video/render).
  const ANIM = ['x', 'y', 'scale', 'opacity', 'rotation'];
  const EA = { playing: false, loop: true, exporting: false, tp: null, keys: null };
  const atFrame = (t) => { const f = E.anim?.fps || 24; return Math.round(t * f) / f; };
  // the work area: a teal range over the bar's scrub that the playhead is bound to (Alt+I / Alt+O: I and O pick paint tools)
  const scrubBox = () => EA.tp?.el.querySelector('.scrub-wrap');
  const WA = workArea({
    get: () => E.anim?.range || null,
    set: (r) => { if (!E.anim) return; if (r) E.anim.range = r; else delete E.anim.range; persistEditor(); },
    len: () => E.anim?.len || 0, t: () => E.t, seek: (t) => editorSeek(t), step: () => 1 / (E.anim?.fps || 24), minLen: () => 1 / (E.anim?.fps || 24),
    at: (x) => { const r = scrubBox().getBoundingClientRect(); return (x - r.left) / Math.max(1, r.width) * (E.anim?.len || 0); },
    pos: (t) => `${(t / (E.anim?.len || 1)) * 100}%`,
    points: () => [0, E.t, ...(E.sel ? [E.sel] : E.layers).flatMap(keyTimes)],
    alt: true, changed: () => { EA.tp?.update(); renderEditor(); },
  });
  function poseAt(t) {
    for (const l of E.layers) for (const ch of ANIM) if (animated(l, ch)) l[ch] = value(l, ch, t, l[ch]);
  }
  function keyPose() {
    if (!E.anim || EA.exporting) return;
    for (const l of E.layers) for (const ch of ANIM) {
      if (animated(l, ch) && l[ch] != null && Math.abs(l[ch] - value(l, ch, E.t, l[ch])) > 1e-6) putKey(l.chans, ch, E.t, l[ch]);
    }
  }
  // the playhead moved: pose the layers there and show it
  function editorSeek(t) {
    if (!E.anim) return;
    E.t = WA.clamp(clamp(EA.playing ? t : atFrame(t), 0, E.anim.len));
    poseAt(E.t);
    drawEditorCanvas(); EA.tp?.update(); paintAnimKeys(); refreshKeyed(cfg.panel);
  }
  function editorPlay() {
    if (!E.anim || EA.playing) return;
    E.t = playFrom(E.t, WA.bound(), E.anim.len, 1e-3);
    EA.playing = true;
    let last = performance.now();
    const tick = (now) => {
      if (!EA.playing || !E.anim) return;
      let t = E.t + (now - last) / 1000;
      last = now;
      const st = tickT(t, WA.bound(), E.anim.len, EA.loop);   // (inside the work area while it is on)
      t = st.t; if (st.stop) EA.playing = false;
      editorSeek(t);
      if (EA.playing) requestAnimationFrame(tick); else editorPause();
    };
    requestAnimationFrame(tick);
  }
  function editorPause() {
    if (!EA.playing) return;
    EA.playing = false;
    editorSeek(E.t);   // (on a frame again, where keys go)
  }
  const editorPlayer = { playing: () => EA.playing, play: editorPlay, pause: editorPause, seek: editorSeek, t: () => E.t, len: () => E.anim?.len || 0 };
  // The bar under the canvas while animating: the shared transport, its scrub bar showing the keys of the selected layer
  // (of every layer, when none is)
  function animBar() {
    const bar = cfg.anim;
    if (!bar) return;
    bar.classList.toggle('hidden', !E.anim);
    if (!E.anim) { editorPause(); return; }
    if (!EA.tp) {
      EA.tp = transport(editorPlayer, { step: { by: () => 1 / (E.anim?.fps || 24), label: 'one frame' }, scrub: true, frames: true,
        fps: () => E.anim?.fps || 24, loop: { get: () => EA.loop, set: (v) => { EA.loop = v; } }, area: WA });
      const scrub = EA.tp.el.querySelector('.scrub');
      EA.keys = h('span', { class: 'anim-keys' });
      const wrap = h('span', { class: 'scrub-wrap' });
      scrub.replaceWith(wrap); wrap.append(scrub, EA.keys, ...WA.el());
      bar.append(EA.tp.el);
    }
    E.t = Math.min(E.t, E.anim.len);
    WA.sync(); EA.tp.update(); paintAnimKeys();
  }
  function paintAnimKeys() {
    if (!EA.keys || !E.anim) return;
    const times = [...new Set((E.sel ? [E.sel] : E.layers).flatMap(keyTimes))];
    EA.keys.replaceChildren(...times.filter((f) => f <= E.anim.len).map((f) =>
      h('span', { class: 'tl-key', style: `left:${(f / E.anim.len) * 100}%` })));
  }
  // Start animating: the canvas becomes a fixed size (if it fit the layers) and the playhead goes to the start
  function startAnim() {
    if (!E.size) toFixedSize();
    E.anim = { len: 3, fps: 24 }; E.t = 0;
    poseAt(0); editorChanged();
  }
  // A fixed canvas the size of what the layers cover now, moved (keys too) so it begins at 0,0
  function toFixedSize() {
    const f = editorFrame();
    if (f) {
      for (const l of E.layers) {
        if (l.x == null) continue;
        l.x -= f.x; l.y -= f.y;
        for (const k of l.chans?.x || []) k.v -= f.x;
        for (const k of l.chans?.y || []) k.v -= f.y;
      }
    }
    E.size = f ? { w: f.w, h: f.h } : { w: 1024, h: 1024 };
  }

  const layerLoaded = (l) => !!(l.img && l.img.naturalWidth);
  const ready = (l) => !l.broken && layerLoaded(l) && l.x != null;

  function loadLayerImage(l) {
    if (l.img) return;
    const settle = () => {
      if (E.arrange) { if (E.layers.every((o) => o.broken || layerLoaded(o))) arrangeLayers(E.arrange); }
      else if (layerLoaded(l) && l.x == null) placeLayer(l);
      renderEditor();
    };
    l.img = new Image();
    l.img.onload = settle;
    l.img.onerror = () => { l.broken = true; settle(); };
    l.img.src = inputUrl(l.name);
  }

  // the kept part of a layer in canvas px before it's turned (layer-geom.js), the box round what it covers once turned,
  // and the box round the whole image behind it (shown while cropping)
  const layerRect = G.layerRect, bounds = G.bounds;
  function imageBounds(l) {
    const W = l.img.naturalWidth, H = l.img.naturalHeight;
    return unionRect([[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => { const q = G.imageToCanvas(l, { x, y }); return { x: q.x, y: q.y, w: 0, h: 0 }; }));
  }
  function unionRect(rs) {
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  }
  const visibleLayers = () => E.layers.filter((l) => ready(l) && !l.hidden);

  // The output area: the fixed size, or just big enough for every visible layer
  function editorFrame() {
    if (E.size) return { x: 0, y: 0, w: E.size.w, h: E.size.h };
    const vis = visibleLayers();
    if (!vis.length) return null;
    const b = unionRect(vis.map(bounds)), x = Math.floor(b.x), y = Math.floor(b.y);
    return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
  }

  // (l.live: the layer with the stroke being painted on it, paint.js)
  // (a turned or mirrored layer is drawn through its turn about the kept part's centre)
  function drawLayer(ctx, l) {
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop, r = layerRect(l), t = G.turned(l);
    if (t) { ctx.save(); ctx.transform(...G.turn(l)); }
    ctx.globalAlpha = clamp(l.opacity ?? 1, 0, 1);
    ctx.globalCompositeOperation = blendOp(l);
    ctx.drawImage(l.live || l.img, c.x * W, c.y * H, Math.max(1, c.w * W), Math.max(1, c.h * H), r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (t) ctx.restore();
  }
  // move a layer so the box round it starts at x, y
  function placeBounds(l, x, y) {
    const b = bounds(l);
    l.x += x - b.x; l.y += y - b.y;
  }

  function composeEditor(target) {
    const f = editorFrame(), vis = visibleLayers();
    if (!f || !vis.length) return false;
    target.width = f.w; target.height = f.h;
    const ctx2 = target.getContext('2d');
    ctx2.imageSmoothingQuality = 'high';
    ctx2.fillStyle = E.bg; ctx2.fillRect(0, 0, f.w, f.h);
    ctx2.translate(-f.x, -f.y);
    vis.forEach((l) => drawLayer(ctx2, l));
    return true;
  }

  // One-off layouts: matching heights side by side (or in a grid), matching widths when stacked,
  // rows centred. The top of the list goes first.
  function arrangeLayers(layout) {
    E.arrange = null;
    const src = [...E.layers].reverse().filter((l) => !l.broken && layerLoaded(l)).map((l) => {
      if (l.x == null) Object.assign(l, { x: 0, y: 0 });
      const b = bounds(l);
      return { l, sw: Math.max(1, b.w / l.scale), sh: Math.max(1, b.h / l.scale) };
    });
    if (!src.length) return;
    const gap = Math.max(0, E.gap | 0);
    const put = (s, x, y, scale) => { s.l.scale = scale; placeBounds(s.l, Math.round(x), Math.round(y)); };
    if (layout === 'column') {
      const w = Math.round(Math.min(...src.map((s) => s.sw)));
      let y = 0;
      for (const s of src) { put(s, 0, y, w / s.sw); y += Math.round((s.sh * w) / s.sw) + gap; }
    } else {
      const cols = layout === 'row' ? src.length : Math.max(1, E.cols | 0);
      const rowH = Math.round(Math.min(...src.map((s) => s.sh)));
      const rows = [];
      for (let i = 0; i < src.length; i += cols) rows.push(src.slice(i, i + cols));
      const rowW = rows.map((r) => r.reduce((a, s) => a + Math.round((s.sw * rowH) / s.sh), 0) + gap * (r.length - 1));
      const maxW = Math.max(...rowW);
      rows.forEach((r, ri) => {
        let x = (maxW - rowW[ri]) / 2;
        for (const s of r) { put(s, x, ri * (rowH + gap), rowH / s.sh); x += Math.round((s.sw * rowH) / s.sh) + gap; }
      });
    }
    if (E.size) {   // a fixed canvas: scale the arrangement to fit it, centred
      const b = unionRect(src.map((s) => bounds(s.l)));
      const k = Math.min(E.size.w / b.w, E.size.h / b.h);
      const dx = (E.size.w - b.w * k) / 2, dy = (E.size.h - b.h * k) / 2;
      for (const { l } of src) {
        const lb = bounds(l);
        l.scale *= k;
        placeBounds(l, Math.round(dx + (lb.x - b.x) * k), Math.round(dy + (lb.y - b.y) * k));
      }
    }
    persistEditor();
  }

  // A new image goes in the middle of what's already there, shrunk to fit inside it (l.fit: grown or shrunk to fit
  // inside, 'contain', or to cover it, 'cover', once: a shot's base picture)
  function placeLayer(l) {
    const w = l.crop.w * l.img.naturalWidth, hh = l.crop.h * l.img.naturalHeight;
    const others = visibleLayers().filter((o) => o !== l);
    const f = E.size ? editorFrame() : others.length ? unionRect(others.map(bounds)) : null;
    l.scale = !f ? 1 : l.fit === 'cover' ? Math.max(f.w / w, f.h / hh) : l.fit === 'contain' ? Math.min(f.w / w, f.h / hh) : Math.min(1, f.w / w, f.h / hh);
    delete l.fit;
    l.x = f ? Math.round(f.x + (f.w - w * l.scale) / 2) : 0;
    l.y = f ? Math.round(f.y + (f.h - hh * l.scale) / 2) : 0;
    E.sel = l; E.cropping = false;
    persistEditor();
  }

  // What a layer lines up with: the canvas (when it fits the layers, the other layers' bounds),
  // or nothing when it's the only layer
  function alignFrame(l) {
    const others = visibleLayers().filter((o) => o !== l).map(bounds);
    return E.size ? editorFrame() : others.length ? unionRect(others) : null;
  }

  // Snap targets: the edges and centres of the align frame and of every other visible layer
  const SNAP = 8;   // screen px
  function snapTargets(l) {
    const rs = visibleLayers().filter((o) => o !== l).map(bounds), f = alignFrame(l);
    if (f) rs.push(f);
    return { xs: rs.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]), ys: rs.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]) };
  }

  // Set a layer's crop without moving the image under it (turned, too)
  function setLayerCrop(l, c) { Object.assign(l, G.cropKeepingPlace(l, c)); }

  // view: canvas px → screen px in the viewer (s = zoom, ox/oy = offset). It's refitted on every
  // redraw, except while dragging, so the canvas doesn't jump around under the finger. While painting,
  // two fingers (or the wheel) zoom and pan on top of the fit: VZ = { z, tx, ty }, screen = fitted * z + t.
  let EV = null, EVfit = null, EVheld = false, VZ = { z: 1, tx: 0, ty: 0 };
  function fitView(w, hh) {
    if (!(EVheld && EVfit)) {
      const f = editorFrame(), rs = f ? [f] : [];
      if (E.size) rs.push(...visibleLayers().map(bounds));   // show layers hanging off a fixed canvas too
      if (E.cropping && E.sel && ready(E.sel)) rs.push(imageBounds(E.sel));
      if (!rs.length) { EV = EVfit = null; return; }
      const strip = $cv.parentElement.querySelector('.paint-strip');
      const b = unionRect(rs), pad = 28, left = (strip?.offsetWidth || 36) + 16, top = 72;   // room left for the paint tools, above for the layer toolbar
      const s = Math.max(1e-3, Math.min((w - pad - left) / b.w, (hh - pad - top) / b.h));
      EVfit = { s, ox: left + (w - pad - left - b.w * s) / 2 - b.x * s, oy: top + (hh - pad - top - b.h * s) / 2 - b.y * s };
    }
    EV = { s: EVfit.s * VZ.z, ox: EVfit.ox * VZ.z + VZ.tx, oy: EVfit.oy * VZ.z + VZ.ty };
  }
  const viewZoom = {
    get: () => ({ ...VZ }),
    set(z, tx, ty) { VZ = { z, tx, ty }; drawEditorCanvas(); paint.sync(); },
    reset() { if (viewZoom.zoomed()) { VZ = { z: 1, tx: 0, ty: 0 }; drawEditorCanvas(); } paint.sync(); },
    zoomed: () => VZ.z !== 1 || VZ.tx !== 0 || VZ.ty !== 0,
  };

  const HANDLE = 22;   // touch radius of a corner handle, screen px
  const ROT_OFF = 34;   // the rotate handle: this far out from the middle of the top side, screen px
  // the box's corners (screen px: nw, ne, se, sw, turned with the layer) and the rotate handle above its top side
  function boxPoints(l, crop = false) {
    const pts = crop ? cropCorners(l) : G.corners(l), a = ((l.rotation || 0) * Math.PI) / 180;
    const sc = pts.map((q) => ({ x: EV.ox + q.x * EV.s, y: EV.oy + q.y * EV.s }));
    const top = { x: (sc[0].x + sc[1].x) / 2, y: (sc[0].y + sc[1].y) / 2 };
    return { pts: sc, top, rot: { x: top.x + Math.sin(a) * ROT_OFF, y: top.y - Math.cos(a) * ROT_OFF } };
  }
  // the crop's corners on the canvas, from the image (nw, ne, se, sw)
  const cropCorners = (l) => {
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
    return [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]].map(([x, y]) => G.imageToCanvas(l, { x: x * W, y: y * H }));
  };
  function drawBox(ctx, l, accent, { rotate = false, crop = false } = {}) {
    const { pts, top, rot } = boxPoints(l, crop);
    ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = accent; ctx.strokeStyle = '#000';
    if (rotate) {   // a stalk up to a round handle
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rot.x, rot.y); ctx.strokeStyle = accent; ctx.stroke(); ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(rot.x, rot.y, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(rot.x, rot.y, 5, -Math.PI * 0.9, Math.PI * 0.4); ctx.stroke();
    }
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }
  // the screen-px box round the selected layer, for the toolbar
  const screenBox = (r) => ({ x: EV.ox + r.x * EV.s, y: EV.oy + r.y * EV.s, w: r.w * EV.s, h: r.h * EV.s });

  function drawEditorCanvas() {
    const cv = $cv, any = E.layers.some(ready);
    toolbar.classList.add('hidden');
    cv.classList.toggle('hidden', !any);
    cfg.empty?.classList.toggle('hidden', any);
    const f = editorFrame();
    if (cfg.size) cfg.size.textContent = any && f ? `${f.w}×${f.h} · ${(f.w * f.h / 1e6).toFixed(2)} MP` : '';
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
    if (!any || !w || !hh) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    fitView(w, hh);
    if (!EV) return;
    const { s, ox, oy } = EV, ctx = cv.getContext('2d');
    const scr = (r) => ({ x: ox + r.x * s, y: oy + r.y * s, w: r.w * s, h: r.h * s });
    const css = getComputedStyle(document.documentElement), accent = css.getPropertyValue('--accent').trim() || '#fff';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = css.getPropertyValue('--stage-bg').trim() || '#14161c'; ctx.fillRect(0, 0, w, hh);
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
    if (f) { ctx.fillStyle = E.bg; ctx.fillRect(f.x, f.y, f.w, f.h); }
    visibleLayers().forEach((l) => drawLayer(ctx, l));
    ctx.restore();
    if (E.size && f) {   // shade whatever hangs off a fixed-size canvas
      const fr = scr(f);
      ctx.fillStyle = '#000a'; ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.rect(fr.x, fr.y, fr.w, fr.h); ctx.fill('evenodd');
    }
    const sel = E.sel && ready(E.sel) ? E.sel : null;
    if (!sel) return;
    if (paint.painting()) {   // the layer being painted: a thin outline, no handles
      const { pts } = boxPoints(sel);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = accent; ctx.lineWidth = 1;
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5) : ctx.moveTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5)));
      ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      paint.paintOverlay(ctx);
      return;
    }
    if (E.cropping) {   // the whole image dimmed, the kept part on top of it
      ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, w, hh);
      ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s); ctx.transform(...G.layerMatrix(sel));
      ctx.globalAlpha = 0.35; ctx.drawImage(sel.img, 0, 0); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff6'; ctx.lineWidth = 1 / (s * sel.scale); ctx.strokeRect(0, 0, sel.img.naturalWidth, sel.img.naturalHeight);
      ctx.restore();
      ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s); drawLayer(ctx, sel); ctx.restore();
    }
    drawBox(ctx, sel, accent, { rotate: !E.cropping && !sel.locked, crop: E.cropping });
    ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1;
    for (const g of E.guides) {
      ctx.beginPath();
      if (g.x != null) { const x = Math.round(ox + g.x * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
      else { const y = Math.round(oy + g.y * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }
    const tb = screenBox(E.cropping ? imageBounds(sel) : bounds(sel));
    if (!E.cropping && !sel.locked) { const { rot } = boxPoints(sel); tb.y = Math.min(tb.y, rot.y - 12); tb.h += screenBox(bounds(sel)).y - tb.y; }   // (clear of the rotate handle)
    placeEditorToolbar(tb, w, hh);
  }

  // The Transform / Crop switch floats above the selected layer (below it, or inside, when there's no room)
  function placeEditorToolbar(r, w, hh) {
    const bar = toolbar;
    bar.classList.remove('hidden');
    for (const b of bar.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'crop') === E.cropping);
    bar.querySelector('[data-snap]').classList.toggle('on', E.snap);
    const bw = bar.offsetWidth, bh = bar.offsetHeight, m = 6, clear = 18;   // clear the corner handles
    let top = r.y - bh - clear;
    if (top < m) top = r.y + r.h + clear;
    bar.style.left = `${Math.min(w - bw - m, Math.max(m, r.x + r.w / 2 - bw / 2))}px`;
    bar.style.top = `${Math.min(hh - bh - m, Math.max(m, top))}px`;
  }

  function setEditorMode(crop) {
    if (!E.sel || E.cropping === crop) return;
    E.cropping = crop;
    if (crop) E.aspect = null;
    renderEditor();
  }

  // Drag on the canvas: a layer to move it, a corner of the selected one to resize it, and while
  // cropping the crop box (or a new one inside the image). Double-tap a layer to crop it.
  function wireEditor() {
    const cv = $cv;
    const point = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left - EV.ox) / EV.s, y: (e.clientY - r.top - EV.oy) / EV.s };
    };
    // the corner of the selected layer's box (turned with it) under the pointer: nw, ne, se or sw
    const scrOf = (p) => ({ x: EV.ox + p.x * EV.s, y: EV.oy + p.y * EV.s });
    const corner = (p, l, crop = false) => {
      const q = scrOf(p), { pts } = boxPoints(l, crop);
      const i = pts.findIndex((c) => Math.hypot(c.x - q.x, c.y - q.y) < HANDLE);
      return i < 0 ? null : ['nw', 'ne', 'se', 'sw'][i];
    };
    const onRotate = (p, l) => { const q = scrOf(p), { rot } = boxPoints(l); return Math.hypot(rot.x - q.x, rot.y - q.y) < HANDLE; };
    // where the pointer is on the selected layer's image, as fractions of it
    const frac = (l, p) => { const q = G.canvasToImage(l, p); return { x: q.x / l.img.naturalWidth, y: q.y / l.img.naturalHeight }; };
    let drag = null, lastTap = { t: 0, l: null }, held = [];
    // a second finger turns the press into a pinch (paint.js): what the first finger moved goes back
    const cancelDrag = () => {
      if (!drag) return;
      for (const [l, x, y, scale, crop, rotation] of held) Object.assign(l, { x, y, scale, crop, rotation });
      drag = null; EVheld = false; E.guides = [];
      lastTap = { t: 0, l: null };   // (a pinch's first finger isn't half a double-tap)
      drawEditorCanvas();
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!EV || EA.exporting) return;
      editorPause();
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      const p = point(e), sel = E.sel && ready(E.sel) ? E.sel : null;
      drag = null; EVheld = true;
      held = E.layers.map((l) => [l, l.x, l.y, l.scale, { ...l.crop }, l.rotation || 0]);
      if (sel && E.cropping) {   // (in the image's own fractions, so a turned layer crops the same)
        const c = sel.crop, k = corner(p, sel, true), raw = frac(sel, p);
        const q = { x: clamp01(raw.x), y: clamp01(raw.y) };
        if (k) drag = { crop: true, fx: k.includes('w') ? c.x + c.w : c.x, fy: k.includes('n') ? c.y + c.h : c.y };
        else if (G.insideLayer(sel, p)) drag = { crop: true, move: true, q0: q, c0: { ...c } };
        else if (raw.x >= 0 && raw.x <= 1 && raw.y >= 0 && raw.y <= 1) drag = { crop: true, fx: q.x, fy: q.y };
        else { EVheld = false; E.cropping = false; renderEditor(); }   // tapping outside the image finishes the crop
        return;
      }
      if (sel && !sel.locked && onRotate(p, sel)) {   // the round handle above the box turns it about its centre
        const c = G.centre(sel);
        drag = { rotate: true, l: sel, c, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: sel.rotation || 0 };
        return;
      }
      const k = sel && !sel.locked && corner(p, sel);
      if (k && !((sel.rotation || 0) % 360)) {
        const r = layerRect(sel);
        drag = { resize: true, l: sel, ax: k.includes('w') ? r.x + r.w : r.x, ay: k.includes('n') ? r.y + r.h : r.y,
          cw: r.w / sel.scale, ch: r.h / sel.scale };
        return;
      }
      if (k) {   // a turned layer resizes along its own sides, from the opposite corner
        const r = layerRect(sel), pts = G.corners(sel), i = ['nw', 'ne', 'se', 'sw'].indexOf(k);
        drag = { tresize: true, l: sel, anchor: pts[(i + 2) % 4], sx: k.includes('w') ? -1 : 1, sy: k.includes('n') ? -1 : 1,
          cw: r.w / sel.scale, ch: r.h / sel.scale, a: ((sel.rotation || 0) * Math.PI) / 180 };
        return;
      }
      const hit = visibleLayers().reverse().find((l) => !l.locked && G.insideLayer(l, p));   // (a locked layer is picked from the list)
      if (!hit) { EVheld = false; if (E.sel) { E.sel = null; renderEditor(); } return; }
      const now = performance.now();
      if (hit === lastTap.l && now - lastTap.t < 350) {
        lastTap = { t: 0, l: null }; EVheld = false;
        E.sel = hit; E.cropping = true; E.aspect = null; renderEditor();
        return;
      }
      lastTap = { t: now, l: hit };
      drag = { l: hit, p0: p, x0: hit.x, y0: hit.y };
      if (E.sel !== hit) { E.sel = hit; renderEditor(); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = point(e);
      if (drag.crop) {
        const l = E.sel, W = l.img.naturalWidth, H = l.img.naturalHeight, raw = frac(l, p);
        const q = { x: clamp01(raw.x), y: clamp01(raw.y) };
        const c = drag.move
          ? { ...drag.c0, x: Math.min(1 - drag.c0.w, Math.max(0, drag.c0.x + q.x - drag.q0.x)),
            y: Math.min(1 - drag.c0.h, Math.max(0, drag.c0.y + q.y - drag.q0.y)) }
          : cropSpan(W, H, E.aspect, drag.fx, drag.fy, q.x, q.y);
        setLayerCrop(l, c);
      } else if (drag.rotate) {
        // snapping pulls to 15° steps nearby; Shift always steps by 15°; Alt is free
        const l = drag.l, deg = drag.r0 + ((Math.atan2(p.y - drag.c.y, p.x - drag.c.x) - drag.a0) * 180) / Math.PI;
        l.rotation = G.snapAngle(deg, e.altKey ? {} : e.shiftKey ? { step: 15 } : E.snap ? { pull: 4 } : {});
        const c = G.centre(l);   // (the centre stays put: rounding)
        l.x += drag.c.x - c.x; l.y += drag.c.y - c.y;
        E.guides = [];
      } else if (drag.tresize) {
        const l = drag.l, cos = Math.cos(drag.a), sin = Math.sin(drag.a);
        const dx = p.x - drag.anchor.x, dy = p.y - drag.anchor.y, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;   // in the layer's own axes
        l.scale = Math.max(0.01, Math.max((lx * drag.sx) / drag.cw, (ly * drag.sy) / drag.ch));
        const hx = (drag.sx * drag.cw * l.scale) / 2, hy = (drag.sy * drag.ch * l.scale) / 2;
        const cx = drag.anchor.x + hx * cos - hy * sin, cy = drag.anchor.y + hx * sin + hy * cos;
        l.x = cx - (drag.cw * l.scale) / 2; l.y = cy - (drag.ch * l.scale) / 2;
        E.guides = [];
      } else if (drag.resize) {
        const l = drag.l, left = p.x < drag.ax, up = p.y < drag.ay;
        l.scale = Math.max(0.01, Math.abs(p.x - drag.ax) / drag.cw, Math.abs(p.y - drag.ay) / drag.ch);
        E.guides = [];
        if (E.snap && !e.altKey) {   // the dragged corner snaps on whichever axis is closer
          const t = snapTargets(l), thr = SNAP / EV.s;
          const ex = drag.ax + (left ? -1 : 1) * drag.cw * l.scale, ey = drag.ay + (up ? -1 : 1) * drag.ch * l.scale;
          const sx = snapNearest([ex], t.xs, thr), sy = snapNearest([ey], t.ys, thr);
          const g = sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d)) ? { x: sx.at } : sy ? { y: sy.at } : null;
          if (g) {
            l.scale = Math.max(0.01, g.x != null ? Math.abs(g.x - drag.ax) / drag.cw : Math.abs(g.y - drag.ay) / drag.ch);
            E.guides.push(g);
          }
        }
        l.x = Math.round(left ? drag.ax - drag.cw * l.scale : drag.ax);
        l.y = Math.round(up ? drag.ay - drag.ch * l.scale : drag.ay);
      } else {
        const l = drag.l;
        l.x = Math.round(drag.x0 + p.x - drag.p0.x);
        l.y = Math.round(drag.y0 + p.y - drag.p0.y);
        E.guides = [];
        if (E.snap && !e.altKey) {   // edges and centre snap to the canvas and the other layers
          const t = snapTargets(l), thr = SNAP / EV.s, r = bounds(l);
          const sx = snapNearest([r.x, r.x + r.w / 2, r.x + r.w], t.xs, thr);
          const sy = snapNearest([r.y, r.y + r.h / 2, r.y + r.h], t.ys, thr);
          if (sx) { l.x = Math.round(l.x + sx.d); E.guides.push({ x: sx.at }); }
          if (sy) { l.y = Math.round(l.y + sy.d); E.guides.push({ y: sy.at }); }
        }
      }
      drag.moved = true;
      drawEditorCanvas();
    });
    const end = () => {
      const moved = drag && drag.moved;
      drag = null; EVheld = false; E.guides = [];
      if (moved) { lastTap = { t: 0, l: null }; persistEditor(); }
      renderEditor();
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.parentElement.append(toolbar = h('div', { class: 'layer-toolbar hidden', role: 'toolbar', 'aria-label': 'Layer tool' },
      h('button', { type: 'button', 'data-mode': 'transform', title: 'Move and resize (V)', 'aria-label': 'Transform', onclick: () => setEditorMode(false) }, icon('move')),
      h('button', { type: 'button', 'data-mode': 'crop', title: 'Crop (C)', 'aria-label': 'Crop', onclick: () => setEditorMode(true) }, icon('crop')),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', 'data-snap': '', title: 'Snap to the canvas and other layers (hold Alt to skip)', 'aria-label': 'Snap',
        onclick: () => { E.snap = !E.snap; persistEditor(); drawEditorCanvas(); } }, icon('target'))));
    new ResizeObserver(() => { if (!EVheld) drawEditorCanvas(); }).observe(cv.parentElement);
    // painting (paint.js): its pointer handlers come first while a paint tool is picked; its tool strip sits on the left
    paint = createPaint({
      E, canvas: () => cv, viewer: () => cv.parentElement, view: () => EV, zoom: viewZoom, frame: editorFrame,
      toCanvas: (e) => point(e), cancelDrag, redraw: drawEditorCanvas, render: renderEditor, changed: persistEditor,
      composite: (c) => { const f = editorFrame(); if (f) { c.fillStyle = E.bg; c.fillRect(f.x, f.y, f.w, f.h); } visibleLayers().forEach((l) => drawLayer(c, l)); },
      active: () => cfg.active() && !sheetOpen() && !EA.exporting,
    });
    cv.parentElement.append(...paint.els);

    // V / C switch tool, Esc finishes a crop / deselects, Delete removes the selected layer, arrows nudge it
    document.addEventListener('keydown', (e) => {
      if (!cfg.active() || sheetOpen()
        || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || !E.sel) return;
      const l = E.sel, n = e.shiftKey ? 10 : 1;
      const nudge = (dx, dy) => { if (E.cropping || !ready(l)) return; l.x += dx; l.y += dy; persistEditor(); };
      const keys = {
        Escape: () => { if (E.cropping) E.cropping = false; else E.sel = null; },
        v: () => { E.cropping = false; }, c: () => { E.cropping = true; E.aspect = null; },
        Enter: () => { E.cropping = false; },
        Delete: () => removeLayer(l), Backspace: () => removeLayer(l),
        ArrowLeft: () => nudge(-n, 0), ArrowRight: () => nudge(n, 0), ArrowUp: () => nudge(0, -n), ArrowDown: () => nudge(0, n),
      };
      if (!keys[e.key]) return;
      e.preventDefault(); keys[e.key](); renderEditor();
    });
    // an animation's keys (Space, and ← → Home End when no layer is selected: those nudge a selected one)
    playKeys(() => !!E.anim && cfg.active() && !sheetOpen(), () => EA.tp,
      () => (E.sel ? { ArrowLeft: null, ArrowRight: null, Home: null, End: null } : {}));
  }

  function removeLayer(l) {
    const before = E.layers;
    E.layers = E.layers.filter((o) => o !== l);
    if (E.sel === l) { E.sel = null; E.cropping = false; }
    persistEditor();
    const tid = docId();
    undoToast('Layer removed', () => {
      if (docId() !== tid) return toast(cfg.elsewhere || 'That layer was in another edit tab', true);
      E.layers = before; E.sel = l; persistEditor(); renderEditor();
    });
  }

  function renderEditor() {
    cfg.beforeRender?.();
    E.layers.forEach(loadLayerImage);
    if (E.sel && !E.layers.includes(E.sel)) E.sel = null;
    if (!E.sel || !ready(E.sel)) E.cropping = false;
    if (cfg.renderPanel) cfg.renderPanel(eng);
    else if (cfg.panel) cfg.panel.replaceChildren(...[].concat(cfg.panelParts(eng)).filter(Boolean));
    animBar();
    drawEditorCanvas();
    paint.sync();
  }
  // the panel's top row: add images, a blank canvas (more of the host's own after), clear all
  function topRow(more = []) {
    return panelTop([button('+ Add images', addEditorImages, { cls: 'primary' }),
      h('button', { type: 'button', class: 'icon-btn ico-btn', title: 'Blank canvas: a new empty layer to paint on', 'aria-label': 'Blank canvas',
        onclick: paint.blankSheet }, icon('canvas')), ...more], E.layers.length ? () => {
      const before = E.layers, tid = docId();
      E.layers = []; E.sel = null; E.arrange = null; persistEditor(); renderEditor();
      undoToast(`Cleared ${before.length} layer${before.length > 1 ? 's' : ''}`, () => {
        if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
        E.layers = before; persistEditor(); renderEditor();
      });
    } : null);
  }

  const editorChanged = () => { persistEditor(); renderEditor(); };
  const editorNum = (label, value, set, opts) => propNum(label, value, set, editorChanged, opts);

  const layerName = (l) => l.label || l.name?.split('/').pop() || 'Canvas';
  // a painted layer's thumbnail, drawn from its pixels (the server's thumbnails are JPEGs: no see-through)
  function canvasThumb(src) {
    const k = Math.min(1, 88 / Math.max(src.width, src.height)), cv = h('canvas', { class: 'paint-thumb' });
    cv.width = Math.max(1, Math.round(src.width * k)); cv.height = Math.max(1, Math.round(src.height * k));
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    return cv;
  }

  // Top of the list is drawn on top; tap a row to select that layer
  function layerList() {
    if (!E.layers.length) return hint('Add images from your inputs, generations or device, then tap one on the canvas to move, resize or crop it.');
    const move = (l, d) => {
      const i = E.layers.indexOf(l), j = i + d;
      if (j < 0 || j >= E.layers.length) return;
      [E.layers[i], E.layers[j]] = [E.layers[j], E.layers[i]];
      editorChanged();
    };
    return layerRowsEl([...E.layers].reverse().map((l) => {
      const r = ready(l) ? layerRect(l) : null, cropped = l.crop.w < 0.999 || l.crop.h < 0.999;
      const blend = l.blend && l.blend !== 'normal' ? ` · ${BLENDS.find(([v]) => v === l.blend)?.[1].toLowerCase()}` : '';
      return {
        sel: l === E.sel, off: l.hidden || l.broken,
        // (painting the selected layer: tapping it again keeps it, so the brush always has a layer)
        onclick: () => { E.sel = l === E.sel && !paint.painting() ? null : l; E.cropping = false; renderEditor(); },
        thumb: isCanvas(l) ? canvasThumb(l.img) : h('img', { src: thumbUrl(l.name, 160), alt: '' }),
        name: layerName(l),
        hint: l.broken ? 'could not load' : !r ? 'loading…'
          : `${Math.round(r.w)}×${Math.round(r.h)}${cropped ? ' · cropped' : ''}${blend}${anyKeys(l) ? ' · animated' : ''}${l.hidden ? ' · hidden' : ''}`,
        buttons: [
          l.locked ? h('button', { type: 'button', class: 'icon-btn ico-btn on', 'aria-label': 'Unlock', title: 'Locked: tap to unlock',
            onclick: (e) => { e.stopPropagation(); l.locked = false; editorChanged(); } }, icon('lock')) : null,
          iconBtn(l.hidden ? 'Show' : 'Hide', l.hidden ? '◌' : '◉', () => { l.hidden = !l.hidden; editorChanged(); }),
          iconBtn('Bring forward', '↑', () => move(l, 1)),
          iconBtn('Send backward', '↓', () => move(l, -1))],
      };
    }));
  }

  function layerProps(l) {
    const done = () => { if (E.cropping) E.cropping = false; else E.sel = null; renderEditor(); };
    const del = button('Delete layer', () => { removeLayer(l); renderEditor(); }, { cls: 'small danger' });
    if (!ready(l)) return section('Layer', done, del);
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
    if (E.cropping) {
      return section('Crop', done,
        help('Drag the box or its corners on the canvas. Switch back to Transform, or tap outside the image, when you\'re done.'),
        field('Aspect', seg(ASPECTS.map(([label, a]) => [a, label]), E.aspect, (a) => {
          E.aspect = a;
          if (a) setLayerCrop(l, aspectCrop(W, H, a));
          editorChanged();
        }, { wrap: true })),
        hint(`Keeping ${Math.round(c.w * W)}×${Math.round(c.h * H)} of ${W}×${H} px`),
        h('div', { class: 'row' },
          button('Finish crop', () => { E.cropping = false; renderEditor(); }, { cls: 'small primary' }),
          button('Reset crop', () => { E.aspect = null; setLayerCrop(l, { ...FULL }); editorChanged(); })));
    }
    const r = layerRect(l), cropped = c.w < 0.999 || c.h < 0.999;
    l.rotation ??= 0;
    // a turn keeps the centre where it is
    const setRotation = (v) => { const c0 = G.centre(l); l.rotation = G.snapAngle(v); const c1 = G.centre(l); l.x += c0.x - c1.x; l.y += c0.y - c1.y; };
    const quarter = (d) => { setRotation((l.rotation || 0) + d); editorChanged(); };
    const flip = (k) => { l[k] = !l[k]; editorChanged(); };
    // scale around the layer's centre
    const setScale = (s) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      l.scale = s;
      const n = layerRect(l);
      l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
    };
    const fr = editorFrame() || r;   // X / Y drag over the canvas and as much again either side (E.size is null when it fits the layers)
    // X, Y, Scale and Opacity: sliders, with ◀ ◆ ▶ to key them while animating (keyed.js; the layer keys its own pose)
    const prop = (label, ch, set, opts) => (E.anim
      ? keyedRange(label, { item: l, ch, direct: true, t: () => E.t, base: () => l[ch], setBase: set, seek: editorSeek,
        onKeys: () => { poseAt(E.t); editorChanged(); }, onInput: drawEditorCanvas, onChange: editorChanged, ...opts })
      : rangeField(label, () => l[ch], set, { onInput: drawEditorCanvas, onChange: editorChanged, ...opts }));
    const px = { step: 1, digits: 0, fmt: (v) => String(Math.round(v)) };
    return section('Layer', done,
      hint(layerName(l), 'layer-title'),
      prop('X', 'x', (v) => { l.x = Math.round(v); }, { ...px, min: Math.floor(fr.x - fr.w), max: Math.ceil(fr.x + fr.w * 2) }),
      prop('Y', 'y', (v) => { l.y = Math.round(v); }, { ...px, min: Math.floor(fr.y - fr.h), max: Math.ceil(fr.y + fr.h * 2) }),
      prop('Scale', 'scale', (v) => setScale(Math.max(0.01, v)), { min: 0.01, max: 4, step: 0.01, fmt: pctFmt, def: 1 }),
      prop('Rotation', 'rotation', (v) => setRotation(v), { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°`, def: 0 }),
      h('div', { class: 'row wrap ed-turns' },
        iconBtn('Turn a quarter left', icon('rotl'), () => quarter(-90)), iconBtn('Turn a quarter right', icon('rotr'), () => quarter(90)),
        h('button', { type: 'button', class: `icon-btn${l.flipX ? ' on' : ''}`, 'aria-label': 'Mirror left to right', title: 'Mirror left to right', 'aria-pressed': String(!!l.flipX), onclick: () => flip('flipX') }, icon('fliph')),
        h('button', { type: 'button', class: `icon-btn${l.flipY ? ' on' : ''}`, 'aria-label': 'Mirror top to bottom', title: 'Mirror top to bottom', 'aria-pressed': String(!!l.flipY), onclick: () => flip('flipY') }, icon('flipv')),
        !E.anim && l.rotation ? iconBtn('No turn', icon('reset'), () => { setRotation(0); editorChanged(); }) : null),
      prop('Opacity', 'opacity', (v) => { l.opacity = clamp(v, 0, 1); }, { min: 0, max: 1, step: 0.01, fmt: pctFmt, def: 1 }),
      field('Blend', seg(BLENDS, l.blend || 'normal', (v) => { l.blend = v; editorChanged(); }, { wrap: true })),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: `btn small${l.locked ? ' on' : ''}`, title: 'No painting, moving or resizing it on the canvas',
          onclick: () => { l.locked = !l.locked; editorChanged(); } }, icon(l.locked ? 'lock' : 'unlock'), l.locked ? 'Locked' : 'Lock')),
      hint(`${Math.round(r.w)}×${Math.round(r.h)} px on the canvas · ${Math.round(c.w * W)}×${Math.round(c.h * H)} px of the image`),
      h('div', { class: 'row wrap' },
        button('Crop', () => { paint.setTool('move'); E.cropping = true; E.aspect = null; renderEditor(); }),
        cropped ? button('Reset crop', () => { setLayerCrop(l, { ...FULL }); editorChanged(); }) : null,
        button('100%', () => { setScale(1); editorChanged(); })),
      alignControls(l),
      del,
      help('Drag it on the canvas to move it, a corner to resize, or the round handle above it to turn it (it pulls to 15° steps; Shift steps by 15°, Alt turns freely); it snaps to the canvas and other layers (hold Alt, or turn off Snap, to place it freely). Switch to Crop in the toolbar above it (or double-tap).'));
  }

  // Align buttons: 0 / 0.5 / 1 = start / centre / end of the align frame, per axis
  function alignControls(l) {
    const f = alignFrame(l);
    const align = (axis) => (k) => {   // (by the box the layer covers, turned or not)
      const r = bounds(l);
      if (axis === 'x') l.x += Math.round(f.x + (f.w - r.w) * k - r.x); else l.y += Math.round(f.y + (f.h - r.h) * k - r.y);
      editorChanged();
    };
    return field(E.size ? 'Align to canvas' : 'Align to the other layers',
      seg([[0, '⇤ Left', 'Align left edges'], [0.5, '↔ Centre', 'Centre horizontally'], [1, 'Right ⇥', 'Align right edges']], null, align('x'), { action: true, disabled: !f }),
      seg([[0, '⤒ Top', 'Align top edges'], [0.5, '↕ Middle', 'Centre vertically'], [1, 'Bottom ⤓', 'Align bottom edges']], null, align('y'), { action: true, disabled: !f }));
  }

  // Animate the layers: how long, how many frames a second
  function animProps() {
    if (!E.layers.length) return null;
    if (!E.anim) {
      return section('Animation', null,
        help('Animate the layers like After Effects: tap ◆ beside X, Y, Scale or Opacity for a key, move the playhead, change it, and it keys again. It exports as a clip.'),
        button('Animate', startAnim, { cls: 'small' }));
    }
    return section('Animation', null,
      h('div', { class: 'row' },
        editorNum('Length (s)', E.anim.len, (v) => { E.anim.len = v; E.t = Math.min(E.t, v); }, { min: 0.5, max: 60, step: 0.5 }),
        field('Frame rate', seg([[12, '12'], [24, '24'], [30, '30']], E.anim.fps, (v) => { E.anim.fps = Number(v); E.t = atFrame(E.t); editorChanged(); }))),
      hint(anyKeys(E.sel || {}) || E.layers.some(anyKeys) ? 'Keys show on the bar under the canvas (the selected layer\'s, or every layer\'s).'
        : 'Select a layer and tap ◆ beside a property to key it here.'),
      button('Stop animating', () => { editorPause(); E.anim = null; editorChanged(); },
        { cls: 'small', title: 'Back to a still: the layers stay as they are at the playhead (their keys are kept for next time)' }));
  }

  // a fixed canvas: a shape and megapixels tapped (sides a multiple of 8); Custom types the sides
  const CANVAS_MP = [0.25, 0.5, 1, 1.5, 2, 4, 8];
  function fixedSizeFields() {
    const { w, h: hh } = E.size, mp = Math.round((w * hh) / 1e4) / 100;
    const near = ASPECT_PRESETS.find(([, a]) => Math.abs(w / hh / a - 1) < 0.03);
    const shape = E.sizeShape || (near ? near[0] : 'custom');
    const apply = (k, m) => {
      E.sizeShape = k;
      const a = (ASPECT_PRESETS.find(([x]) => x === k) || [])[1];
      if (a) E.size = { w: Math.round(Math.sqrt(m * 1e6 * a) / 8) * 8, h: Math.round(Math.sqrt((m * 1e6) / a) / 8) * 8 };
      editorChanged();
    };
    return [
      field(['Shape', h('span', {}, `${w}×${hh} · ${mp} MP`)],
        seg([...ASPECT_PRESETS.map(([k]) => [k, k]), ['custom', 'Custom']], shape, (k) => apply(k, mp), { wrap: true })),
      shape === 'custom'
        ? h('div', { class: 'row' },
          editorNum('Width', w, (v) => { E.size.w = v; }, { min: 64, max: 8192, step: 8 }),
          editorNum('Height', hh, (v) => { E.size.h = v; }, { min: 64, max: 8192, step: 8 }))
        : field('Megapixels', seg(CANVAS_MP.map((v) => [v, `${v}`]), CANVAS_MP.find((v) => Math.abs(v - mp) < 0.03) ?? null,
          (m) => apply(shape, m), { wrap: true })),
    ];
  }

  function canvasProps() {
    const sizeSeg = seg([['fit', 'Fit layers'], ['fixed', 'Fixed size']], E.size ? 'fixed' : 'fit', (v) => {
      if (v === 'fit') {
        if (E.anim) { toast('An animation keeps a fixed canvas', true); renderEditor(); return; }
        E.size = null;
      } else if (!E.size) toFixedSize();
      editorChanged();
    });
    return section('Canvas', null,
      field('Size', sizeSeg),
      E.size ? fixedSizeFields() : null,
      colorField('Background', () => E.bg, (c) => { E.bg = c; persistEditor(); drawEditorCanvas(); }),
      field('Arrange layers', seg([['row', 'Side by side'], ['column', 'Stacked'], ['grid', 'Grid']], null,
        (m) => { arrangeLayers(m); renderEditor(); }, { action: true, disabled: !E.layers.length })),
      h('div', { class: 'row' },
        editorNum('Grid columns', E.cols, (v) => { E.cols = v; }, { min: 1, max: 12 }),
        editorNum('Gap (px)', E.gap, (v) => { E.gap = v; }, { min: 0, max: 400 })));
  }

  // what the edit makes: a picture to use as an input, a download, or a PhotoCraft document
  function exportProps() {
    if (!E.layers.length) return null;
    return section('Export', null,
      E.anim ? h('div', { class: 'row wrap' }, button('Export clip', (ev) => exportEditorClip(ev.currentTarget), { cls: 'primary', title: 'The animation as a video in History' }),
        WA.onlyToggle()) : null,
      mpInput(() => E.mp, (n) => { E.mp = n; persistEditor(); }),
      h('div', { class: 'row wrap' },
        button(E.anim ? 'Save this frame as input' : 'Save as input', saveEditor, { cls: E.anim ? 'small' : 'small primary' }),
        button('Download', downloadEditor),
        button('Open in PhotoCraft', (ev) => craftEditor(ev.currentTarget), { title: 'Every layer as its own layer, to keep editing on the computer' }),
        button('Craft documents…', () => openCraftSheet())));
  }

  // The edit as a layered PhotoCraft document: each layer cropped as here and placed where it sits on the canvas
  async function craftEditor(btn) {
    if (paint.unsavedPaint()) await paint.savePaint();   // PhotoCraft reads each layer's file
    const f = editorFrame(), layers = E.layers.filter((l) => ready(l) && l.name);
    if (!f || !layers.length) return toast('Add some images first', true);
    // PhotoCraft documents take no turns: a turned or mirrored layer goes as a picture of itself, turned, in its box
    const baked = async (l) => {
      const b = bounds(l), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(b.w)); cv.height = Math.max(1, Math.round(b.h));
      const c = cv.getContext('2d');
      c.imageSmoothingQuality = 'high'; c.translate(-b.x, -b.y);
      drawLayer(c, { ...l, opacity: 1, blend: 'normal', live: null });
      const r = await fetch('/api/paint', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await new Promise((res) => cv.toBlob(res, 'image/png')) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { name: (await r.json()).name, b };
    };
    let list;
    try {
      list = await Promise.all(layers.map(async (l) => {
        const base = { name: layerName(l).replace(/\.[a-z]+$/i, ''), hidden: !!l.hidden };
        if (G.turned(l)) { const { name, b } = await baked(l); return { ...base, src: { input: name }, crop: { ...FULL }, rect: { x: b.x - f.x, y: b.y - f.y, w: b.w, h: b.h } }; }
        const r = layerRect(l);
        return { ...base, src: { input: l.name }, crop: l.crop, rect: { x: r.x - f.x, y: r.y - f.y, w: r.w, h: r.h } };
      }));
    } catch (e) { return toast(`Couldn't ready a turned layer: ${e.message}`, true); }
    sendToCraft('photo', { title: cfg.name?.() || 'Edit', canvas: { w: f.w, h: f.h, bg: E.bg }, layers: list }, btn);
  }

  // a picture as a new layer on top (o: label, fit 'cover' or 'contain' to fill the canvas whatever its size, locked...)
  function addImage(name, o = {}) {
    const l = { name, crop: { ...FULL }, scale: 1, opacity: 1, hidden: false, ...o };
    E.layers.push(l); editorChanged();
    return l;
  }

  function addEditorImages() {
    openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => {
      E.layers.push({ name, crop: { ...FULL }, scale: 1, opacity: 1, hidden: false }); editorChanged();
    } });
  }

  function editorBlob() {
    const cv = document.createElement('canvas');
    if (!composeEditor(cv)) return Promise.resolve(null);
    return new Promise((res) => cv.toBlob(res, 'image/png'));
  }

  async function saveEditor() {
    const b = busy('Putting the image together…');   // big layers take a moment to draw and encode
    try {
      const blob = await editorBlob();
      if (!blob) return toast('Add some images first', true);
      const r = await uploadImage(blob, { mp: E.mp, source: 'editor', filename: 'editor.png' });
      useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
    } catch (e) { toast('Save failed: ' + e.message, true); }
    finally { b.done(); }
  }

  // The animation as a clip in History: each frame drawn here, the frames made a clip on the server (as the 3D tab's
  // scenes are), and that clip rendered like a one-clip Video edit
  async function exportEditorClip(btn) {
    editorPause();
    if (!visibleLayers().length) return toast('Add some images first', true);
    if (E.layers.some((l) => !l.broken && !ready(l))) return toast('The images are still loading', true);
    const { fps, len } = E.anim, t0 = E.t, label = btn.textContent;
    const { first, count: n } = frameSpan(WA.exportRange(), Math.max(1, Math.round(len * fps)), fps);   // Range only: the work area's frames
    const cv = document.createElement('canvas');
    EA.exporting = true; btn.disabled = true;
    try {
      const made = await framesToClip(n, fps, (k) => { poseAt((first + k) / fps); composeEditor(cv); return cv; },
        (k) => { btn.textContent = `Frame ${k}/${n}`; });
      poseAt(t0);
      btn.textContent = 'Rendering…';
      const g = await api('/api/video/render', { method: 'POST', busy: 'Rendering…', body: {
        project_id: S.project, fps, tracks: [{ id: 'v1', kind: 'video' }],
        items: [{ track: 'v1', at: 0, in: 0, out: made.duration, name: cfg.name?.() || 'Edit', src: { clip: made.clip },
          x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1 }] } });
      S.history.set(g.id, g);
      openGeneration(g.id);
    } catch (e) { toast('Export failed: ' + e.message, true); }
    finally { EA.exporting = false; poseAt(E.t = t0); drawEditorCanvas(); btn.disabled = false; btn.textContent = label; }
  }

  async function downloadEditor() {
    const blob = await editorBlob();
    if (!blob) return toast('Add some images first', true);
    const a = h('a', { href: URL.createObjectURL(blob), download: `comfydeck_${Date.now()}.png` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const docId = () => cfg.docId?.() ?? E.tab?.id;
  // another document in this host: its state, posed at the start, nothing selected
  function load(payload) {
    editorPause();
    Object.assign(E, fromSaved(payload || {}), { sel: null, cropping: false, aspect: null, guides: [], t: 0 });
    poseAt(0);
  }
  const eng = {
    E, render: renderEditor, draw: drawEditorCanvas, changed: persistEditor, load, dump: dumpEditor, compose: composeEditor,
    blob: editorBlob, frame: editorFrame, ready, loading: () => E.layers.some((l) => !l.broken && !ready(l)), addImage, pause: editorPause,
    zoom: viewZoom, get paint() { return paint; },
    // the panel's parts, for the host to lay out
    topRow, layerList, layerProps: () => (E.sel ? layerProps(E.sel) : null), animProps, canvasProps, exportProps,
    paintProps: () => paint.paintProps(),
  };
  wireEditor();
  return eng;
}

// Offer the saved image to one of the current template's image inputs.
export function useInGenerate(name, msg) {
  const fields = (S.tpl?.fields || []).filter((f) => f.kind === 'image');
  const go = (f) => {
    S.values[f.key] = name; persist(); renderFields(); closeSheet(); switchTab('generate');
    toast(`Set ${f.group} · ${f.label}`);
  };
  openSheet(h('h3', {}, msg),
    h('div', { class: 'media-big' }, h('img', { src: inputUrl(name), alt: '' })),
    hint(`It's now in your input images as ${name}.`, 'sheet-hint'),
    fields.length ? actions(fields.map((f) => button(`Use for ${f.group} · ${f.label}`, () => go(f)))) : null,
    actions(button('Keep editing', closeSheet, { cls: 'small ghost' })));
}

export const ASPECTS = [['Free', null], ...ASPECT_PRESETS];

// Crop rectangle (fractions of a W×H image) from a fixed corner (fx,fy) to the pointer, respecting
// the aspect lock (width/height in pixels, null = free) and the image bounds
export function cropSpan(W, H, aspect, fx, fy, px, py) {
  let w = Math.abs(px - fx), hh = Math.abs(py - fy);
  if (aspect) {
    const maxW = px < fx ? fx : 1 - fx, maxH = py < fy ? fy : 1 - fy;
    hh = (w * W) / (aspect * H);
    if (hh > maxH) { hh = maxH; w = (hh * aspect * H) / W; }
    if (w > maxW) { w = maxW; hh = (w * W) / (aspect * H); }
  }
  w = Math.max(w, 0.02); hh = Math.max(hh, 0.02);
  return { x: px < fx ? fx - w : fx, y: py < fy ? fy - hh : fy, w, h: hh };
}

// the largest centred crop with that aspect
export function aspectCrop(W, H, a) {
  let w = 1, hh = W / (a * H);
  if (hh > 1) { hh = 1; w = (a * H) / W; }
  return { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
}

// Crop popup for a loaded image; onApply gets {x,y,w,h} as fractions of it.
export function openCrop({ img, crop = FULL, onApply }) {
  const W = img.naturalWidth, H = img.naturalHeight;
  let c = { ...crop };
  let aspect = null;   // width/height in pixels, null = free
  const box = h('div', { class: 'crop-box' }, ['nw', 'ne', 'sw', 'se'].map((k) => h('span', { class: `handle ${k}`, 'data-h': k })));
  const wrap = h('div', { class: 'crop-wrap' }, h('img', { src: img.src, draggable: false, alt: '' }), box);
  const info = h('span', { class: 'hint' });
  const draw = () => {
    Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
    info.textContent = `${Math.round(c.w * W)}×${Math.round(c.h * H)} px`;
  };
  const span = (fx, fy, px, py) => cropSpan(W, H, aspect, fx, fy, px, py);
  const setAspect = (a) => {
    aspect = a;
    if (a) c = aspectCrop(W, H, a);
    aspSeg.set(a);
    draw();
  };
  const aspSeg = seg(ASPECTS.map(([label, a]) => [a, label]), null, setAspect, { wrap: true });

  let drag = null;
  const pt = (e) => { const r = wrap.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault(); wrap.setPointerCapture(e.pointerId);
    const p = pt(e), hk = e.target.dataset && e.target.dataset.h;
    if (hk) drag = { fx: hk.includes('w') ? c.x + c.w : c.x, fy: hk.includes('n') ? c.y + c.h : c.y };
    else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) drag = { move: true, p0: p, c0: { ...c } };
    else drag = { fx: p.x, fy: p.y };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e);
    if (drag.move) {
      c.x = Math.min(1 - c.w, Math.max(0, drag.c0.x + p.x - drag.p0.x));
      c.y = Math.min(1 - c.h, Math.max(0, drag.c0.y + p.y - drag.p0.y));
    } else c = span(drag.fx, drag.fy, p.x, p.y);
    draw();
  });
  const end = () => { drag = null; };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);

  openSheet(h('h3', {}, 'Crop'), aspSeg,
    h('div', { class: 'crop-stage' }, wrap),
    actions(
      button('Apply', () => { closeSheet(); onApply(c); }, { cls: 'small primary' }),
      button('Reset', () => { c = { ...FULL }; setAspect(null); }),
      button('Cancel', closeSheet, { cls: 'small ghost' }), info));
  draw();
}
