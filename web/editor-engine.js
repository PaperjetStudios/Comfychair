import { sizeChoices, sizePicker } from './size-picker.js';
import { MP_STEPS } from './mp-cap.js';
import { ASPECTS, FULL, aspectCrop, cropSpan } from './crop-geometry.js';
export { ASPECTS, FULL, aspectCrop, cropSpan } from './crop-geometry.js';
import { store,
  h, api, clamp01, busy, toast, undoToast, sheetOpen, openSheet, closeSheet, loadingSheet, sheetStillOpen, button, iconBtn, actions,
  seg, field, section, hint, toggle, propNum, layerRowsEl, panelTop, help, colorField, rangeField, pctFmt, clamp, uid,
} from './ui.js';
import { ASPECT_PRESETS, S, inputUrl, switchTab, thumbUrl } from './core.js';
import { openImagePicker, uploadImage } from './media.js';
import { pictureDrag } from './picture-drop.js';
import { snap as gridSnap, snapBar, snapNearest, snapOn, snapStep } from './gizmo.js';
import * as ST from './layer-stack.js';
import { openCraftSheet, sendToCraft } from './craft.js';
import { isLive, liveFrame } from './live.js';
import { animated, anyKeys, keyTimes, keyedRange, refreshKeyed, value } from './keyed.js';
import { putKey } from './keys.js';
import { playKeys, transport } from './playback.js';
import { keyJumps } from './timeline.js';
import { workArea } from './workarea.js';
import { frameSpan, playFrom, tickT } from './workarea-math.js';
import { framesToClip } from './scene-comp.js';
import { BLENDS, blendOp, createPaint, fillField, isCanvas, makeCanvas } from './paint.js';
import * as A from './adjust.js';
import { gradedPicture, histOfPicture } from './adjust-draw.js';
import { adjustPanel } from './adjust-panel.js';
import { icon } from './icons.js';
import { cropShapeMenu, layerMenu, pickedFor } from './layer-menu.js';
import { openPressMenu, pressMenu } from './press-menu.js';
import * as G from './layer-geom.js';
import { densePlan, gridItem, gridPlan, fitToCell } from './layer-grid.js';
import { solidBounds } from './matte-edge.js';
import { inpaintSection, masksSection, runFill } from './inpaint.js';
import { editorRunKey, editorRunKeys, keepTyping } from './key-focus.js';
import { imageToolsSection, runImageTool } from './imagetools.js';
import { shared as sharedOf } from './props-rules.js';
import { propsRoot } from './props-panel.js';

// ---------------------------------------------------------------------------
// editor: a simple Photoshop-style layer stack for cropping images and putting them together
// (character sheets, side-by-side refs). Each layer is an input image with a crop, a position and
// a scale. Everything is drawn client-side on a canvas, then uploaded as a new input image.
// The engine is made once per host with createEditor(): the Editor tab (editor.js, its edit tabs) and the Story
// tab's shot canvas (story.js, one composition per shot) each have their own state, view, painter and undo.
// ---------------------------------------------------------------------------
export const BLANK = () => ({ v: 2, size: null, cols: 2, gap: 0, bg: '#000000', clear: false, out: 1, mp: 0, snap: true, arrange: null, anim: null, items: [], layers: [], groups: [] });
// a saved payload (an edit tab, or the old `deck.editor`) as editor state
const LAYER_CLIP = 'deck.layerclip';   // the layers Copy took, in a document's form: names of input pictures and their settings
export function fromSaved(saved) {
  const e = { ...BLANK(), ...saved, arrange: saved.arrange || null };
  // layers: { name, crop: {x,y,w,h} as fractions, x, y (canvas px), scale, rotation (degrees, about the kept part's
  // centre), flipX, flipY (layer-geom.js), opacity, hidden, chans (its keys), img,
  // blend (paint.js BLENDS), locked, label (the name shown, for a painted layer whose file is named after its pixels) };
  // the last one is drawn on top. size: a fixed {w,h} canvas, or null to fit around the layers. anim: see below.
  e.layers = (saved.layers || []).map((l) => ({ name: l.name, crop: { ...(l.crop || FULL) },
    x: l.x, y: l.y, scale: l.x == null ? 1 : l.scale, opacity: l.opacity ?? 1, hidden: !!l.hidden,
    blend: l.blend || 'normal', locked: !!l.locked, ...(l.label ? { label: l.label === 'Inpaint mask' ? 'Mask' : l.label } : {}), ...(l.mask ? { mask: true } : {}), ...(l.draft ? { draft: true } : {}), ...(l.canvas ? { canvas: true } : {}), ...(l.fill ? { fill: l.fill } : {}), ...(l.clip ? { clip: true } : {}),
    ...(l.rotation ? { rotation: +l.rotation } : {}), ...(l.flipX ? { flipX: true } : {}), ...(l.flipY ? { flipY: true } : {}),
    ...(l.chans ? { chans: structuredClone(l.chans) } : {}),
    ...(l.key ? { key: l.key } : {}), ...(l.group ? { group: l.group } : {}), ...(l.maskOf ? { maskOf: l.maskOf } : {}), ...(l.maskOff ? { maskOff: true } : {}), ...(l.maskFor ? { maskFor: l.maskFor } : {}), ...(l.adjust ? { adjust: structuredClone(l.adjust) } : {}) }));
  e.groups = (saved.groups || []).map((g) => ({ id: g.id, name: g.name || 'Group', opacity: g.opacity ?? 1, blend: g.blend || 'normal', collapsed: !!g.collapsed }));
  // The old auto-layout editor kept no positions: lay its images out once they load, in the same
  // order (its first image was leftmost, so it goes to the top of the list).
  if (saved.v !== 2 && e.layers.length) { e.arrange = saved.layout || 'row'; e.layers.reverse(); }
  delete e.layout;
  // items: boxes drawn for the Inpaint panel's Add item, { x, y, w, h } canvas px, desc (what goes there), ref (a picture to match, optional)
  e.items = (saved.items || []).map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, desc: i.desc || '', ref: i.ref || '' }));
  return e;
}

// cfg: { canvas, empty, size?, anim? (the animation bar; none: no animating), panel, panelParts(eng) (what the panel
// shows) or renderPanel(eng) (the host fills it), active() (on show, no sheet over it), onChange() (after every edit), docId() (for Undo across documents),
// name() (for exports), initial (a saved payload), noLayers (the empty canvas's hint) }
export function createEditor(cfg) {
  const E = fromSaved(cfg.initial || {});
  E.multi = []; E.pickMode = false;   // multi: the layers selected along with E.sel (pickMode: a tap adds or drops a layer, for a screen with no Shift)
  E.sel = null; E.cropping = false; E.aspect = null; E.guides = []; E.itemDraw = false; E.itemSel = -1;   // itemDraw: the next drag draws an item box   // guides: snap lines {x} or {y} while dragging
  E.t = 0;   // the playhead, seconds (an animation)
  E.tab = null;   // the document this state belongs to (the Editor tab's: { id, qs })
  const $cv = cfg.canvas;
  let toolbar = null, paint = null;

  // What a tab stores: the editor's settings and its layers (input image names + crop/position), all small.
  // (Layers only ever name input images, so nothing here is a data URL or a blob. A new blank canvas has no file
  // until its first save, a moment later: it's left out until then.)
  const dumpEditor = (list = E.layers) => ({ v: 2, size: E.size, cols: E.cols, gap: E.gap, bg: E.bg, clear: !!E.clear, out: E.out || 1, mp: E.mp, snap: E.snap, arrange: E.arrange, anim: E.anim, items: E.items, groups: E.groups,
    layers: list.filter((l) => l.name).map((l) => (E.grow?.l === l ? { ...l, ...E.grow.was } : l)).map((l) => ({ ...(l.key ? { key: l.key } : {}), ...(l.group ? { group: l.group } : {}), ...(l.maskOf ? { maskOf: l.maskOf } : {}), ...(l.maskOff ? { maskOff: true } : {}), ...(l.maskFor ? { maskFor: l.maskFor } : {}), ...(l.adjust ? { adjust: l.adjust } : {}), name: l.name, crop: l.crop, x: l.x, y: l.y, scale: l.scale, opacity: l.opacity, hidden: l.hidden,
      blend: l.blend || 'normal', locked: !!l.locked, label: l.label || null, chans: l.chans || null, ...(l.mask ? { mask: true } : {}), ...(l.draft ? { draft: true } : {}), ...(l.canvas ? { canvas: true } : {}), ...(l.fill ? { fill: l.fill } : {}), ...(l.clip ? { clip: true } : {}),
      ...(l.rotation ? { rotation: l.rotation } : {}), ...(l.flipX ? { flipX: true } : {}), ...(l.flipY ? { flipY: true } : {}) })) });
  // every edit ends up here: an animated layer keys what moved, then the host saves (the Editor tab's tab and still)
  // (a crop waiting for its Extend button isn't an edit yet: what's noted and saved is the layer without it)
  function persistEditor() {
    settleGrow();
    const g = E.grow, now = g && { crop: g.l.crop, x: g.l.x, y: g.l.y };
    if (g) Object.assign(g.l, g.was);
    noteStack(); keyPose(); cfg.onChange?.();
    if (g) Object.assign(g.l, now);
  }

  // ---- undo for the stack itself: what a change did (moved, reordered, hid, grouped...) goes on the painter's history, next to its strokes ----
  let stackWas = null, stackAt = 0;
  function noteStack() {
    const now = ST.stackState(E.layers, E.groups);
    if (!stackWas || !paint) { stackWas = now; return; }
    if (ST.sameState(stackWas, now)) return;
    const t = Date.now();
    paint.pushStack(stackWas, now, cfg.docId?.() ?? E.tab?.id, t - stackAt < 500);   // (a slider's run of changes is one step)
    stackAt = t; stackWas = now;
  }
  function restoreStack(st) {
    ST.applyState(E, st);
    stackWas = ST.stackState(E.layers, E.groups);
    if (E.sel && !E.layers.includes(E.sel)) E.sel = null;
    cfg.onChange?.();
    renderEditor();
  }

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
    drawEditorCanvas(); EA.tp?.update(); paintAnimKeys(); refreshKeyed(cfg.panel); refreshKeyed(propsRoot());
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
        fps: () => E.anim?.fps || 24, loop: { get: () => EA.loop, set: (v) => { EA.loop = v; } }, area: WA,
        keys: keyJumps(() => (E.sel ? [E.sel] : E.layers).flatMap(keyTimes)),
        length: { get: () => E.anim?.len || 0, set: (v) => { E.anim.len = v; E.t = Math.min(E.t, v); editorChanged(); }, min: 0.5, max: 60 } });
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
      h('span', { class: 'tl-key grab', style: `left:${(f / E.anim.len) * 100}%`, title: 'Drag to move this key (every property keyed here) to another time. Tap to go to it.',
        onpointerdown: (e) => dragKeys(e, f) })));
  }
  // Drag a diamond along the bar: every key at that time, on the layers shown, moves with it (to a frame; a key already
  // there is replaced). A tap only goes to it.
  function dragKeys(e, f0) {
    if (e.button) return;
    e.preventDefault(); e.stopPropagation();
    const layers = E.sel ? [E.sel] : E.layers, same = (f) => Math.abs(f - f0) < 1e-3;
    const snap = layers.map((l) => ({ l, chans: l.chans ? JSON.parse(JSON.stringify(l.chans)) : null }));
    const x0 = e.clientX;
    let moved = false;
    const at = (ev) => clamp(atFrame(WA.at(ev.clientX)), 0, E.anim.len);
    const apply = (t) => {
      for (const { l, chans } of snap) {
        if (!chans) continue;
        const out = {};
        for (const [ch, list] of Object.entries(chans)) {
          const mv = list.filter((k) => same(k.f)).map((k) => ({ ...k, f: t }));
          out[ch] = [...list.filter((k) => !same(k.f) && Math.abs(k.f - t) > 1e-3), ...mv].sort((a, b) => a.f - b.f);
        }
        l.chans = out;
      }
    };
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      apply(at(ev));
      poseAt(E.t); drawEditorCanvas(); paintAnimKeys(); refreshKeyed(cfg.panel); refreshKeyed(propsRoot());
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) { editorSeek(f0); return; }
      editorChanged();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
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
  // (an inpaint draft, l.draft, shows but is left out of what is sent and saved until the Inpaint panel keeps it)
  // (a mask layer, l.mask, is a red tint over the canvas for the Masks panel: never part of the picture)
  // a painted canvas (or the inpaint mask) is resized, never turned or cropped; layers and other objects keep those
  const plain = (l) => !!(l && (l.canvas || l.mask || (l.label && /^Canvas \d+$/.test(l.label) && isCanvas(l))));   // (a canvas made before the flag has its numbered name)
  const visibleLayers = () => E.layers.filter((l) => ready(l) && !l.hidden && !l.mask && !l.maskOf);
  // the Select layers tool: what its box takes (as a tap on the canvas: a locked layer is picked from the list), and the box on show
  const boxLayers = () => visibleLayers().filter((l) => !l.locked && !l.draft);
  const dragBox = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  let boxShown = null;

  // The output area: the fixed size, or just big enough for every visible layer
  function editorFrame() {
    if (E.size) return { x: 0, y: 0, w: E.size.w, h: E.size.h };
    const vis = visibleLayers();
    if (!vis.length) return null;
    const b = unionRect(vis.map(bounds)), x = Math.floor(b.x), y = Math.floor(b.y);
    return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
  }

  // what a layer is drawn from: its pixels (with the stroke being painted, l.live), through its Colour adjustments
  let adjusting = false;   // (a slider or curve is moving: big pictures are graded small until it stops)
  // a blank canvas's own background (l.fill) goes behind its pixels here, so changing it never touches what was painted
  const PAPER = new WeakMap();   // l.img -> its pixels on their background
  function onPaper(l, src) {
    const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
    if (!l.fill || !W || !H) return src;
    const rev = l.paintRev || 0;
    let p = PAPER.get(l.img);
    if (p && p.src === src && p.fill === l.fill && p.rev === rev && src !== l.live) return p.cv;
    if (!p) { p = { cv: document.createElement('canvas') }; PAPER.set(l.img, p); }
    if (p.cv.width !== W || p.cv.height !== H) { p.cv.width = W; p.cv.height = H; }
    const c = p.cv.getContext('2d');
    c.fillStyle = l.fill; c.fillRect(0, 0, W, H);
    c.drawImage(src, 0, 0, W, H);
    Object.assign(p, { src, fill: l.fill, rev });
    return p.cv;
  }
  function pixelsOf(l) {
    const src = onPaper(l, l.live || l.img);
    if (!A.isOn(l.adjust)) return src;
    return gradedPicture(src, l.adjust, { owner: l.img, rev: l.paintRev || 0, quick: adjusting, live: !!l.live });
  }
  // (l.live: the layer with the stroke being painted on it, paint.js)
  // (a turned or mirrored layer is drawn through its turn about the kept part's centre)
  function drawLayer(ctx, l) {
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop, r = layerRect(l), t = G.turned(l), src = pixelsOf(l), kx = src.width / W || 1, ky = src.height / H || 1;
    if (t) { ctx.save(); ctx.transform(...G.turn(l)); }
    ctx.globalAlpha = clamp(l.opacity ?? 1, 0, 1);
    ctx.globalCompositeOperation = l.op || blendOp(l);
    ctx.drawImage(src, c.x * W * kx, c.y * H * ky, Math.max(1, c.w * W * kx), Math.max(1, c.h * H * ky), r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (t) ctx.restore();
  }
  // A canvas with Clip on is like overflow: hidden. The layers above it whose middle is over it are drawn only where the
  // canvas is (the nearest such canvas below a layer is the one that holds it)
  function clipOf(list, i) {
    const l = list[i], c = G.centre(l);
    for (let j = i - 1; j >= 0; j--) {
      const o = list[j];
      if (!o.clip || o.hidden) continue;
      const r = G.layerRect(o);
      if (c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h) return r;
    }
    return null;
  }
  // scratch canvases as big as what's being drawn on, with its transform (depth: a masked layer inside a group)
  const POOL = [];
  function scratchFor(ctx, depth) {
    const cv = (POOL[depth] ||= document.createElement('canvas'));
    if (cv.width !== ctx.canvas.width || cv.height !== ctx.canvas.height) { cv.width = ctx.canvas.width; cv.height = ctx.canvas.height; }
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(ctx.getTransform());
    c.imageSmoothingQuality = 'high';
    return c;
  }
  function pasteDown(ctx, cv, opacity, op) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = clamp(opacity ?? 1, 0, 1); ctx.globalCompositeOperation = op;
    ctx.drawImage(cv, 0, 0);
    ctx.restore();
  }
  const maskOfLayer = (l) => (l.key && !l.maskOff ? E.layers.find((m) => m.maskOf === l.key && ready(m)) || null : null);
  // a layer, seen through its mask if it has one
  function drawMasked(ctx, l, depth = 0) {
    const m = maskOfLayer(l);
    if (!m) return drawLayer(ctx, l);
    if (l.maskFor === 'adjust') {   // the mask says where its adjustments go: the plain layer, the adjusted one over it through the mask
      if (!A.isOn(l.adjust)) return drawLayer(ctx, l);
      const c = scratchFor(ctx, depth), over = scratchFor(ctx, depth + 1);
      drawLayer(c, { ...l, opacity: 1, op: 'source-over', adjust: null });
      drawLayer(over, { ...l, opacity: 1, op: 'source-over' });
      ST.syncMask(m, l);
      drawLayer(over, { ...m, opacity: 1, op: 'destination-in' });
      pasteDown(c, over.canvas, 1, 'source-over');
      return pasteDown(ctx, c.canvas, l.opacity, blendOp(l));
    }
    const c = scratchFor(ctx, depth);
    drawLayer(c, { ...l, opacity: 1, op: 'source-over' });
    ST.syncMask(m, l);
    drawLayer(c, { ...m, opacity: 1, op: 'destination-in' });
    pasteDown(ctx, c.canvas, l.opacity, blendOp(l));
  }
  // A layer's picture at its file's size, with its adjustments in (what an Image tool is sent)
  function layerPicture(l) {
    const base = onPaper(l, l.img), m = l.maskFor === 'adjust' ? maskOfLayer(l) : null, graded = A.isOn(l.adjust) ? gradedPicture(base, l.adjust, { owner: l.img, rev: l.paintRev || 0 }) : base;
    if (!m || graded === base) return graded;
    const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height;
    const make = () => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; return cv; };
    const over = make(), oc = over.getContext('2d'), out = make(), c = out.getContext('2d');
    oc.drawImage(graded, 0, 0, W, H); oc.globalCompositeOperation = 'destination-in'; oc.drawImage(m.img, 0, 0, W, H);
    c.drawImage(base, 0, 0, W, H); c.drawImage(over, 0, 0);
    return out;
  }
  // Over the picture on screen while a mask is being worked on: what it hides in red, or the mask itself in black and white
  let maskView = 'red';
  function boxOf(c, l, style) {
    c.save();
    if (G.turned(l)) c.transform(...G.turn(l));
    const r = layerRect(l);
    c.fillStyle = style; c.fillRect(r.x, r.y, r.w, r.h);
    c.restore();
  }
  function drawMaskView(ctx) {
    const m = E.sel?.maskOf ? E.sel : null, o = m && E.layers.find((x) => x.key === m.maskOf);
    if (!o || maskView === 'picture' || !ready(o) || !ready(m)) return;
    ST.syncMask(m, o);
    const c = scratchFor(ctx, 3);
    if (maskView === 'red') {
      drawLayer(c, { ...o, opacity: 1, op: 'source-over', adjust: null });
      boxOf(c, o, 'rgba(255, 40, 60, .55)');
      drawLayer(c, { ...m, opacity: 1, op: 'destination-out' });
    } else {
      const w = scratchFor(ctx, 4);
      drawLayer(w, { ...m, opacity: 1, op: 'source-over' });
      w.save(); w.setTransform(1, 0, 0, 1, 0, 0); w.globalCompositeOperation = 'source-in'; w.fillStyle = '#fff'; w.fillRect(0, 0, w.canvas.width, w.canvas.height); w.restore();
      boxOf(c, o, '#000');
      pasteDown(c, w.canvas, 1, 'source-over');
    }
    pasteDown(ctx, c.canvas, 1, 'source-over');
  }
  const groupOf = (l) => (l.group ? E.groups.find((g) => g.id === l.group) || null : null);
  function drawStack(ctx, all) {
    const list = all.filter((l) => !l.maskOf);
    const one = (c, l, i, depth) => {
      const r = clipOf(list, i);
      if (!r) return drawMasked(c, l, depth);
      c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
      drawMasked(c, l, depth);
      c.restore();
    };
    for (let i = 0; i < list.length;) {
      const g = groupOf(list[i]);
      if (ST.plainGroup(g)) { one(ctx, list[i], i, 0); i++; continue; }
      const c = scratchFor(ctx, 0);   // a group with its own opacity or blend: its members together, then that on the whole
      for (; i < list.length && list[i].group === g.id; i++) one(c, list[i], i, 1);
      pasteDown(ctx, c.canvas, g.opacity, blendOp(g));
    }
  }
  // move a layer so the box round it starts at x, y
  function placeBounds(l, x, y) {
    const b = bounds(l);
    l.x += x - b.x; l.y += y - b.y;
  }

  // clear: leave the background see-through (a download keeps its alpha; what is sent to a model stays opaque)
  // a transparency guide over the frame (drawn on screen only)
  function chequer(ctx, f, scale) {
    const n = 16 / scale;
    ctx.save(); ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
    ctx.fillStyle = '#9a9a9a'; ctx.fillRect(f.x, f.y, f.w, f.h); ctx.fillStyle = '#c8c8c8';
    for (let y = 0, r = 0; y < f.h; y += n, r++) for (let x = (r % 2) * n; x < f.w; x += n * 2) ctx.fillRect(f.x + x, f.y + y, n, n);
    ctx.restore();
  }

  // k: the size of the result as a multiple of the canvas (an export at 2× draws every layer twice as big: an upscaled layer's extra detail shows)
  // skip: layer keys left out (a chain rerun leaves out what its last run made: main-rules.js withoutMade)
  function composeEditor(target, clear = false, k = 1, { skip = null } = {}) {
    const gone = skip ? new Set(skip) : null;
    const f = editorFrame(), vis = visibleLayers().filter((l) => !l.draft && !(gone && l.key && gone.has(l.key)));   // (an inpaint draft is not part of the picture until kept)
    if (!f || !vis.length) return false;
    target.width = Math.round(f.w * k); target.height = Math.round(f.h * k);
    const ctx2 = target.getContext('2d');
    ctx2.imageSmoothingQuality = 'high';
    ctx2.scale(target.width / f.w, target.height / f.h);
    if (!clear) { ctx2.fillStyle = E.bg; ctx2.fillRect(0, 0, f.w, f.h); }
    ctx2.translate(-f.x, -f.y);
    drawStack(ctx2, vis);
    ctx2.setTransform(1, 0, 0, 1, 0, 0);   // (the caller gets a plain canvas: Inpaint's smear draws on it, and the frame's shift would paste the picture again, offset)
    return true;
  }

  // One layer drawn alone (a frame's main source: frame-source.js), on a see-through canvas the size of the box round it,
  // with its crop, turn, opacity, adjust and mask. Shown or hidden, it is drawn. Returns that box (canvas pixels), or null.
  function composeLayer(target, l) {
    if (!l || !ready(l)) return null;
    const b = bounds(l);
    if (!(b.w > 0 && b.h > 0)) return null;
    target.width = Math.max(1, Math.round(b.w)); target.height = Math.max(1, Math.round(b.h));
    const c = target.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.scale(target.width / b.w, target.height / b.h);
    c.translate(-b.x, -b.y);
    drawStack(c, [{ ...l, hidden: false, group: null, clip: false, blend: 'normal' }]);
    c.setTransform(1, 0, 0, 1, 0, 0);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }

  // The inpaint mask layers as a greyscale picture the frame's size (white = change), or null when nothing is painted.
  // box: the painted part as fractions of the frame; cover: the share of the frame it covers.
  // Kept until the frame or a mask layer (its pixels, place, size) changes: the Inpaint panel asks on every render
  let maskMemo = { key: null, out: null };
  const ids = new WeakMap();
  let lastId = 0;
  const idOf = (o) => { if (!ids.has(o)) ids.set(o, ++lastId); return ids.get(o); };
  function composeMask() {
    const f = editorFrame(), ms = E.layers.filter((l) => l.mask && ready(l) && !l.hidden);
    if (!f || !ms.length) return null;
    const key = [f.x, f.y, f.w, f.h, ...ms.map((l) => [idOf(l), idOf(l.img), l.paintRev || 0, l.x, l.y, l.scale, l.rotation || 0, l.flipX ? 1 : 0, l.flipY ? 1 : 0, l.crop.x, l.crop.y, l.crop.w, l.crop.h].join(','))].join('|');
    if (maskMemo.key !== key) maskMemo = { key, out: maskOf(f, ms) };
    return maskMemo.out;
  }
  function maskOf(f, ms) {
    const a = document.createElement('canvas');
    a.width = f.w; a.height = f.h;
    const c = a.getContext('2d');
    c.translate(-f.x, -f.y);
    ms.forEach((l) => drawLayer(c, { ...l, opacity: 1, blend: 'normal', live: null }));
    const d = c.getImageData(0, 0, f.w, f.h), p = d.data;
    let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = (y * f.w + x) * 4, v = Math.min(255, p[i + 3] * 8);   // (a soft, light or half-opacity stroke still counts: any ink is mask)
      p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
      if (v > 16) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (!n) return null;
    const out = document.createElement('canvas');
    out.width = f.w; out.height = f.h;
    out.getContext('2d').putImageData(d, 0, 0);
    return { canvas: out, box: { x: x0 / f.w, y: y0 / f.h, w: (x1 - x0 + 1) / f.w, h: (y1 - y0 + 1) / f.h }, cover: n / (f.w * f.h) };
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
  // The crop's shape: the largest centred box of it, and corner drags keep to it. Free (null) leaves the box and lets the corners go.
  function setCropAspect(l, a) {
    E.aspect = a;
    if (a) setLayerCrop(l, aspectCrop(l.img.naturalWidth, l.img.naturalHeight, a));
    editorChanged();
  }
  const GROW_GREY = '#808080';   // what an edit model is told to fill in
  const pastOn = (e) => e.ctrlKey || e.metaKey || !!E.cropPast || !!E.grow;
  // A crop past the edges waits (E.grow, layer-geom.js growFate) until Extend makes it a picture, or Cancel or leaving the crop puts it back.
  function settleGrow() {
    const fate = G.growFate(E.grow, E);
    if (!fate) return;
    if (fate === 'undo') Object.assign(E.grow.l, E.grow.was);
    E.grow = null;
  }
  function cancelGrow() {
    if (!E.grow) return;
    Object.assign(E.grow.l, E.grow.was);
    E.grow = null;
    renderEditor();
  }
  function applyGrow() {
    if (!E.grow) return;
    const { l, was } = E.grow, c = l.crop, at = { x: l.x, y: l.y };
    Object.assign(l, was);
    E.grow = null;
    growLayer(l, c, at);
    renderEditor();
  }
  // A crop past the picture's edges (c, the kept part at canvas place at): a new picture of that box, the new part neutral grey, over the layer, which hides.
  // A new layer and not this one changed: the painter's undo holds pixels of this one's size. The picture's see-through stays; a mask shows the new part.
  async function growLayer(l, c, at) {
    const b = busy('Adding the grey…');
    try {
      await paint.savePaint();
      const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, { w, h: hh, ix, iy } = G.grownPicture(c, W, H);
      const onto = (pic, fill) => {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = hh;
        const x = cv.getContext('2d');
        x.fillStyle = fill; x.fillRect(0, 0, w, hh); x.clearRect(ix, iy, W, H);
        x.imageSmoothingQuality = 'high';
        x.drawImage(pic, ix, iy, W, H);
        return cv;
      };
      const send = async (cv, filename) => (await uploadImage(await pngOf(cv), { mp: 0, source: 'editor', filename, multiple: 1 })).name;
      const m = E.layers.find((o) => o.maskOf === l.key && ready(o));
      const name = await send(onto(l.img, GROW_GREY), 'expanded.png'), mask = m ? await send(onto(m.img, '#fff'), 'expanded-mask.png') : null;
      const made = addImage(name, { label: `${layerName(l)} expanded`, x: at.x, y: at.y, scale: l.scale, opacity: l.opacity, blend: l.blend,
        ...(l.rotation && { rotation: l.rotation }), ...(l.flipX && { flipX: true }), ...(l.flipY && { flipY: true }), ...(l.group && { group: l.group }), ...(l.adjust && { adjust: { ...l.adjust } }),
        ...(l.maskOff && { maskOff: true }), ...(l.maskFor && { maskFor: l.maskFor }), ...(mask && { mask }) });
      E.layers = ST.placedOver(E.layers, E.groups, made, l);
      l.hidden = true;
      ST.handOver(E, { layer: l }, made);
      E.cropping = false;
      editorChanged();
      toast('Grey added: a new layer over the original. Edit from a prompt can fill it in');
    } catch (e) { toast(e.message, true); } finally { b.done(); }
  }
  // the crop trimmed to what is solid inside it (what the layer's see-through and its own mask leave), in place
  function trimCrop(l) {
    const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, c = l.crop;
    const x = Math.round(c.x * W), y = Math.round(c.y * H), w = Math.max(1, Math.round(c.w * W)), hh = Math.max(1, Math.round(c.h * H));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(l.img, -x, -y);
    const m = l.maskFor === 'adjust' ? null : maskOfLayer(l);
    if (m) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(m.img, -x, -y, W, H); }
    const b = solidBounds(ctx.getImageData(0, 0, w, hh).data, w, hh);
    if (!b) return toast('Nothing solid in the crop to trim to', true);
    if (b.w === w && b.h === hh) return toast('The crop is already tight: nothing see-through round the edge');
    E.aspect = null;
    setLayerCrop(l, { x: (x + b.x) / W, y: (y + b.y) / H, w: b.w / W, h: b.h / H });
    editorChanged();
  }

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
    if (f) { ctx.fillStyle = E.bg; ctx.fillRect(f.x, f.y, f.w, f.h); if (E.clear) chequer(ctx, f, s); }
    drawStack(ctx, E.layers.filter((l) => ready(l) && !l.hidden));
    drawMaskView(ctx);
    ctx.restore();
    const shown = E.sel?.maskOf ? E.sel : null;   // (its thumbnail in the list follows the painting)
    if (shown?.thumbEl?.isConnected && !shown.live && shown.thumbRev !== (shown.paintRev || 0)) fillMaskThumb(shown, shown.thumbEl);
    if (E.size && f) {   // shade whatever hangs off a fixed-size canvas
      const fr = scr(f);
      ctx.fillStyle = '#000a'; ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.rect(fr.x, fr.y, fr.w, fr.h); ctx.fill('evenodd');
    }
    if (!paint.painting()) paint.paintOverlay(ctx);   // (a selection stays visible under the Move tool)
    E.items.forEach((it, i) => {   // the boxes of the Inpaint panel's items, numbered like <obj_N> in the prompt
      const r = scr(it), on = i === E.itemSel;
      ctx.lineWidth = on ? 3 : 2; ctx.strokeStyle = '#2ee6d6'; ctx.fillStyle = '#2ee6d622';
      ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.font = '600 13px system-ui, sans-serif';
      const tag = String(i + 1), tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle = '#2ee6d6'; ctx.fillRect(r.x, r.y, tw, 20);
      ctx.fillStyle = '#000'; ctx.fillText(tag, r.x + 5, r.y + 15);
    });
    if (boxShown) {   // the Select layers tool's box
      const r = scr(boxShown);
      ctx.fillStyle = `${accent}22`; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
    }
    const sel = E.sel && ready(E.sel) ? E.sel : null;
    if (!sel) return;
    for (const m of E.multi) {   // the others selected with it: an outline
      if (!ready(m)) continue;
      const { pts } = boxPoints(m);
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (paint.painting()) {   // the layer being painted: a thin outline, no handles
      const { pts } = boxPoints(sel);
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5) : ctx.moveTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5)));
      ctx.closePath(); ctx.stroke();
      ctx.globalAlpha = 1;
      paint.paintOverlay(ctx);
      return;
    }
    if (E.cropping) {   // the whole image dimmed, the kept part on top of it
      ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, w, hh);
      ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s); ctx.transform(...G.layerMatrix(sel));
      ctx.globalAlpha = 0.35; ctx.drawImage(sel.img, 0, 0); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff6'; ctx.lineWidth = 1 / (s * sel.scale); ctx.strokeRect(0, 0, sel.img.naturalWidth, sel.img.naturalHeight);
      ctx.restore();
      ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
      if (G.pastEdge(sel.crop)) {   // the part past the picture's edges: the grey it will be
        const r = layerRect(sel);
        ctx.save(); ctx.transform(...G.turn(sel)); ctx.fillStyle = GROW_GREY; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.restore();
      }
      drawLayer(ctx, sel); ctx.restore();
    }
    if (f && gridSnap.grid && !E.cropping) {   // the grid moves snap to
      const step = ST.gridStep(f.w, gridSnap.gridPct) * s, fr = scr(f);
      ctx.strokeStyle = '#ffffff38'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = fr.x; x <= fr.x + fr.w + 0.5; x += step) { ctx.moveTo(Math.round(x) + 0.5, fr.y); ctx.lineTo(Math.round(x) + 0.5, fr.y + fr.h); }
      for (let y = fr.y; y <= fr.y + fr.h + 0.5; y += step) { ctx.moveTo(fr.x, Math.round(y) + 0.5); ctx.lineTo(fr.x + fr.w, Math.round(y) + 0.5); }
      ctx.stroke();
    }
    drawBox(ctx, sel, accent, { rotate: !E.cropping && !sel.locked && !plain(sel), crop: E.cropping });
    ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1;
    for (const g of E.guides) {
      ctx.beginPath();
      if (g.x != null) { const x = Math.round(ox + g.x * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
      else { const y = Math.round(oy + g.y * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }
    const tb = screenBox(E.cropping ? imageBounds(sel) : bounds(sel));
    if (E.grow) { const o = screenBox(bounds(sel)), x1 = Math.max(tb.x + tb.w, o.x + o.w), y1 = Math.max(tb.y + tb.h, o.y + o.h); tb.x = Math.min(tb.x, o.x); tb.y = Math.min(tb.y, o.y); tb.w = x1 - tb.x; tb.h = y1 - tb.y; }   // (clear of the box past the picture)
    if (!E.cropping && !sel.locked && !plain(sel)) { const { rot } = boxPoints(sel); tb.y = Math.min(tb.y, rot.y - 12); tb.h += screenBox(bounds(sel)).y - tb.y; }   // (clear of the rotate handle)
    placeEditorToolbar(tb, w, hh);
  }

  // The Transform / Crop switch floats above the selected layer (below it, or inside, when there's no room)
  function placeEditorToolbar(r, w, hh) {
    const bar = toolbar;
    bar.classList.remove('hidden');
    for (const b of bar.querySelectorAll('[data-mode]')) b.classList.toggle('on', (b.dataset.mode === 'crop') === E.cropping);
    bar.querySelector('[data-snap]').classList.toggle('on', E.snap);
    bar.querySelector('[data-mode=crop]').classList.toggle('hidden', plain(E.sel));
    for (const b of bar.querySelectorAll('[data-grow]')) b.classList.toggle('hidden', !E.grow);
    const bw = bar.offsetWidth, bh = bar.offsetHeight, m = 6, clear = 18;   // clear the corner handles
    let top = r.y - bh - clear;
    if (top < m) top = r.y + r.h + clear;
    bar.style.left = `${Math.min(w - bw - m, Math.max(m, r.x + r.w / 2 - bw / 2))}px`;
    bar.style.top = `${Math.min(hh - bh - m, Math.max(m, top))}px`;
  }

  function setEditorMode(crop) {
    if (!E.sel || E.cropping === crop || (crop && plain(E.sel))) return;
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
    // a point on the canvas pulled to the frame's and the layers' edges and middles (Snap on; Alt skips it)
    const stepScale = (v, e) => (snapOn('scale', e) ? Math.max(0.01, snapStep(v * 100, gridSnap.scaleStep) / 100) : v);
    const snapPoint = (p, e) => {
      E.guides = [];
      if (!E.snap || e.altKey) return { x: Math.round(p.x), y: Math.round(p.y) };
      const t = snapTargets(null), thr = SNAP / EV.s, sx = snapNearest([p.x], t.xs, thr), sy = snapNearest([p.y], t.ys, thr);
      if (sx) E.guides.push({ x: sx.at });
      if (sy) E.guides.push({ y: sy.at });
      return { x: Math.round(sx ? sx.at : p.x), y: Math.round(sy ? sy.at : p.y) };
    };
    // where the pointer is on the selected layer's image, as fractions of it
    const frac = (l, p) => { const q = G.canvasToImage(l, p); return { x: q.x / l.img.naturalWidth, y: q.y / l.img.naturalHeight }; };
    let drag = null, lastTap = { t: 0, l: null }, lastCorner = { t: 0, k: null }, held = [];
    // a second finger turns the press into a pinch (paint.js): what the first finger moved goes back
    // Alt+drag on a layer: past a small move the picked layers get copies, and the drag carries on with those. One undo step, with the move.
    const startCopy = (p) => {
      if (Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) * EV.s < 4) return false;
      drag.alt = false;
      const stack = E.layers, was = { sel: E.sel, multi: E.multi }, r = copyPicked();
      if (!r) return true;   // (nothing that copies: a plain move)
      Object.assign(drag, { copied: { stack, was }, l: r.copies[r.from.indexOf(drag.l)] || E.sel });
      const others = r.copies.filter((c) => c !== drag.l);
      if (others.length) drag.group = others.map((m) => [m, m.x, m.y]); else delete drag.group;
      renderEditor();
      return true;
    };
    // the drag didn't finish: the copies go
    const dropCopies = () => {
      if (!drag?.copied) return;
      E.layers = drag.copied.stack;
      Object.assign(E, drag.copied.was);
      drag.copied = null;
      renderEditor();
    };
    const cancelDrag = () => {
      if (!drag) return;
      for (const [l, x, y, scale, crop, rotation] of held) Object.assign(l, { x, y, scale, crop, rotation });
      drag.out?.end();
      dropCopies();
      drag = null; EVheld = false; E.guides = [];
      lastTap = { t: 0, l: null };   // (a pinch's first finger isn't half a double-tap)
      drawEditorCanvas();
    };
    // Panning like Photoshop: the middle button, Space and a drag, or a drag on the empty dark area (in Move mode). Registered
    // first and in the capture phase so it comes before the paint tools' handlers
    let pan = null, spaceHeld = false;
    const inField = (e) => /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
    document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !inField(e) && cfg.active()) { spaceHeld = true; if (!e.repeat) cv.style.cursor = 'grab'; e.preventDefault(); } });
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceHeld = false; if (!pan) cv.style.cursor = ''; } });
    const startPan = (e) => {
      const v = viewZoom.get();
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, v };
      try { cv.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      cv.style.cursor = 'grabbing';
    };
    // Right click or a long hold on the canvas, with no tool that uses the press itself: the layers' menu, for the layer under it
    const canvasMenuOk = () => !!EV && !EA.exporting && !paint.painting() && !paint.boxing() && !E.cropping && !E.itemDraw && !E.pickMode;
    // While cropping, the same press offers the crop's shape. (A hold outside the picture has finished the crop by the time it fires: no menu then.)
    const cropMenuOk = () => !!EV && !EA.exporting && !paint.painting() && E.cropping && !!E.sel && ready(E.sel);
    // (a mouse's right click means only this, so it works with every tool; a finger's long hold is left to a tool that draws)
    const clickMenuOk = () => !!EV && !EA.exporting && !E.cropping;
    const byMouse = (e) => e.type === 'contextmenu' && e.pointerType !== 'touch';
    let cropPress = false;
    pressMenu(cv, (e) => {
      cancelDrag(); EVheld = false;
      if (cropPress) {
        if (!cropMenuOk()) return;
        const l = E.sel;
        drawEditorCanvas();
        openPressMenu(e.clientX, e.clientY, cropShapeMenu(ASPECTS, E.aspect).map((g) => g.map((it) => ({ ...it, run: () => setCropAspect(l, it.aspect) }))), 'Crop shape');
        return;
      }
      const hit = visibleLayers().reverse().find((l) => !l.locked && G.insideLayer(l, point(e)));
      if (hit) ST.setPicked(E, pickedFor(picked(), hit));
      renderEditor();
      openLayerMenu(e.clientX, e.clientY);
    }, { ok: (e) => { cropPress = cropMenuOk(); return cropPress || canvasMenuOk() || (byMouse(e) && clickMenuOk()); } });
    cv.addEventListener('pointerdown', (e) => {
      if (!EV || EA.exporting || e.pointerType === 'touch') return;
      if (e.button === 2 && (clickMenuOk() || cropMenuOk())) { e.stopImmediatePropagation(); e.preventDefault(); return; }   // (it isn't a drag: the menu comes with its contextmenu event)
      if (e.button === 1 || (e.button === 0 && spaceHeld)) { e.stopImmediatePropagation(); e.preventDefault(); startPan(e); }
    }, true);
    cv.addEventListener('pointermove', (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      e.stopImmediatePropagation(); pan.moved = true;
      viewZoom.set(pan.v.z, pan.v.tx + e.clientX - pan.x, pan.v.ty + e.clientY - pan.y);
    }, true);
    const endPan = (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      const tap = pan.tap && !pan.moved;
      pan = null;
      if (tap && E.sel) { E.sel = null; renderEditor(); }
      cv.style.cursor = spaceHeld ? 'grab' : ''; e.stopImmediatePropagation(); };
    cv.addEventListener('pointerup', endPan, true); cv.addEventListener('pointercancel', endPan, true);
    cv.addEventListener('pointerdown', (e) => {
      if (!EV || EA.exporting) return;
      editorPause();
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      const p = point(e), sel = E.sel && ready(E.sel) ? E.sel : null;
      drag = null; EVheld = true;
      held = E.layers.map((l) => [l, l.x, l.y, l.scale, { ...l.crop }, l.rotation || 0]);
      if (paint.boxing() && !E.cropping) {   // the Select layers tool: a box from the corner pressed
        if (e.button === 0) drag = { box: true, a: p, b: p, op: e.altKey ? 'sub' : e.shiftKey ? 'add' : 'new', before: picked() };
        return;
      }
      if (E.itemDraw && e.button === 0) {   // a new item box from the corner pressed
        const q = snapPoint(p, e), it = { x: q.x, y: q.y, w: 0, h: 0, desc: '', ref: '' };
        E.items.push(it); E.itemSel = E.items.length - 1;
        drag = { item: it, p0: q };
        return;
      }
      if (sel && E.cropping) {   // (in the image's own fractions, so a turned layer crops the same)
        const c = sel.crop, k = corner(p, sel, true), raw = frac(sel, p), was = { crop: { ...c }, x: sel.x, y: sel.y };
        const q = { x: clamp01(raw.x), y: clamp01(raw.y) };
        // a corner tapped twice trims the crop to the solid part
        if (k && k === lastCorner.k && performance.now() - lastCorner.t < 350) { lastCorner = { t: 0, k: null }; EVheld = false; trimCrop(sel); return; }
        lastCorner = { t: performance.now(), k };
        if (k) drag = { crop: true, was, fx: k.includes('w') ? c.x + c.w : c.x, fy: k.includes('n') ? c.y + c.h : c.y };
        else if (G.insideLayer(sel, p)) drag = { crop: true, was, move: true, q0: pastOn(e) ? raw : q, c0: { ...c } };
        else if (raw.x >= 0 && raw.x <= 1 && raw.y >= 0 && raw.y <= 1) drag = { crop: true, was, fx: q.x, fy: q.y };
        else if (pastOn(e)) drag = { crop: true, was, fx: raw.x, fy: raw.y };   // (from outside the picture)
        else { EVheld = false; E.cropping = false; renderEditor(); }   // tapping outside the image finishes the crop
        return;
      }
      if (sel && !sel.locked && !plain(sel) && onRotate(p, sel)) {   // the round handle above the box turns it about its centre
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
      if (!hit) {   // the empty dark area: a drag pans the view; a tap deselects
        EVheld = false;
        if (e.pointerType !== 'touch' && e.button === 0) { startPan(e); pan.tap = E.sel; }
        else if (E.sel) { E.sel = null; renderEditor(); }
        return;
      }
      const now = performance.now();
      if (hit === lastTap.l && now - lastTap.t < 350) {
        lastTap = { t: 0, l: null }; EVheld = false;
        E.sel = hit; E.cropping = !plain(hit); E.aspect = null; renderEditor();
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey || E.pickMode) { EVheld = false; togglePick(hit); renderEditor(); return; }
      lastTap = { t: now, l: hit };
      const group = picked();
      drag = { l: hit, p0: p, x0: hit.x, y0: hit.y, was: { sel: E.sel, multi: E.multi }, alt: e.altKey, out: !e.altKey && canGive(hit) ? pictureDrag(cv, () => layerThumb(hit)) : null };
      if (group.length > 1 && group.includes(hit)) drag.group = group.filter((m) => m !== hit && !m.locked).map((m) => [m, m.x, m.y]);   // (the selection moves together)
      else if (E.sel !== hit || E.multi.length) { pickOnly(hit); renderEditor(); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = point(e);
      if (drag.box) {
        drag.b = p;
        drag.live ||= Math.hypot(p.x - drag.a.x, p.y - drag.a.y) * EV.s > 4;
        if (drag.live) {
          boxShown = dragBox(drag.a, p);
          ST.setPicked(E, ST.boxPick(boxLayers().filter((l) => G.touchesBox(l, boxShown)), drag.before, drag.op));
          E.cropping = false;
          drawEditorCanvas();
        }
        return;
      }
      if (drag.item) {
        const q = snapPoint(p, e), it = drag.item;
        it.x = Math.round(Math.min(drag.p0.x, q.x)); it.y = Math.round(Math.min(drag.p0.y, q.y));
        it.w = Math.round(Math.abs(q.x - drag.p0.x)); it.h = Math.round(Math.abs(q.y - drag.p0.y));
      } else if (drag.crop) {
        const l = E.sel, W = l.img.naturalWidth, H = l.img.naturalHeight;
        // (with Snap on, the crop's edges pull to the canvas and the other layers, like a layer's own edges do)
        const snapping = E.snap && !e.altKey, t = snapping ? snapTargets(l) : null, thr = SNAP / EV.s;
        E.guides = [];
        let pp = p;
        if (snapping && !drag.move) {   // the corner being dragged
          const sx = snapNearest([p.x], t.xs, thr), sy = snapNearest([p.y], t.ys, thr);
          pp = { x: sx ? sx.at : p.x, y: sy ? sy.at : p.y };
          if (sx) E.guides.push({ x: sx.at });
          if (sy) E.guides.push({ y: sy.at });
        }
        const past = pastOn(e), keep = (v, most) => (past ? v : Math.min(most, Math.max(0, v)));   // (Ctrl: past the picture's edges)
        const raw = frac(l, pp), q = past ? raw : { x: clamp01(raw.x), y: clamp01(raw.y) };
        const c = drag.move
          ? { ...drag.c0, x: keep(drag.c0.x + q.x - drag.q0.x, 1 - drag.c0.w), y: keep(drag.c0.y + q.y - drag.q0.y, 1 - drag.c0.h) }
          : cropSpan(W, H, E.aspect, drag.fx, drag.fy, q.x, q.y, past);
        if (snapping && drag.move && !G.turned(l)) {   // the kept part's edges and middle, on the canvas
          const ox = l.x - l.crop.x * W * l.scale, oy = l.y - l.crop.y * H * l.scale, kw = W * l.scale, kh = H * l.scale;
          const xs = [c.x, c.x + c.w / 2, c.x + c.w].map((f) => ox + f * kw), ys = [c.y, c.y + c.h / 2, c.y + c.h].map((f) => oy + f * kh);
          const sx = snapNearest(xs, t.xs, thr), sy = snapNearest(ys, t.ys, thr);
          if (sx) { c.x = keep(c.x + sx.d / kw, 1 - c.w); E.guides.push({ x: sx.at }); }
          if (sy) { c.y = keep(c.y + sy.d / kh, 1 - c.h); E.guides.push({ y: sy.at }); }
        }
        setLayerCrop(l, c);
      } else if (drag.rotate) {
        // snapping pulls to 15° steps nearby; Shift always steps by 15°; Alt is free
        const l = drag.l, deg = drag.r0 + ((Math.atan2(p.y - drag.c.y, p.x - drag.c.x) - drag.a0) * 180) / Math.PI;
        l.rotation = snapOn('rot', e) ? snapStep(deg, gridSnap.rotStep) : G.snapAngle(deg, e.altKey ? {} : e.shiftKey ? { step: 15 } : E.snap ? { pull: 4 } : {});
        const c = G.centre(l);   // (the centre stays put: rounding)
        l.x += drag.c.x - c.x; l.y += drag.c.y - c.y;
        E.guides = [];
      } else if (drag.tresize) {
        const l = drag.l, cos = Math.cos(drag.a), sin = Math.sin(drag.a);
        const dx = p.x - drag.anchor.x, dy = p.y - drag.anchor.y, lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;   // in the layer's own axes
        l.scale = stepScale(Math.max(0.01, Math.max((lx * drag.sx) / drag.cw, (ly * drag.sy) / drag.ch)), e);
        const hx = (drag.sx * drag.cw * l.scale) / 2, hy = (drag.sy * drag.ch * l.scale) / 2;
        const cx = drag.anchor.x + hx * cos - hy * sin, cy = drag.anchor.y + hx * sin + hy * cos;
        l.x = cx - (drag.cw * l.scale) / 2; l.y = cy - (drag.ch * l.scale) / 2;
        E.guides = [];
      } else if (drag.resize) {
        const l = drag.l, left = p.x < drag.ax, up = p.y < drag.ay;
        l.scale = stepScale(Math.max(0.01, Math.abs(p.x - drag.ax) / drag.cw, Math.abs(p.y - drag.ay) / drag.ch), e);
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
        if (drag.alt && !startCopy(p)) return;
        const l = drag.l;
        l.x = Math.round(drag.x0 + p.x - drag.p0.x);
        l.y = Math.round(drag.y0 + p.y - drag.p0.y);
        E.guides = [];
        if (E.snap && (!e.altKey || drag.copied)) {   // edges and centre snap to the canvas and the other layers (Alt skips it, unless it's making the copy)
          const t = snapTargets(l), thr = SNAP / EV.s, r = bounds(l);
          const sx = snapNearest([r.x, r.x + r.w / 2, r.x + r.w], t.xs, thr);
          const sy = snapNearest([r.y, r.y + r.h / 2, r.y + r.h], t.ys, thr);
          if (sx) { l.x = Math.round(l.x + sx.d); E.guides.push({ x: sx.at }); }
          if (sy) { l.y = Math.round(l.y + sy.d); E.guides.push({ y: sy.at }); }
        }
        if (snapOn('grid', drag.copied ? null : e) && editorFrame()) {   // the grid wins over the edges
          const f = editorFrame(), step = ST.gridStep(f.w, gridSnap.gridPct), r = bounds(l);
          l.x = Math.round(l.x + ST.onGrid(r.x, f.x, step) - r.x); l.y = Math.round(l.y + ST.onGrid(r.y, f.y, step) - r.y);
          E.guides = [];
        }
        for (const [m, mx, my] of drag.group || []) { m.x = mx + (l.x - drag.x0); m.y = my + (l.y - drag.y0); }
      }
      drag.moved = true;
      drag.out?.move(e.clientX, e.clientY);
      drawEditorCanvas();
    });
    const end = (e) => {
      const slot = drag?.out?.end(e?.type === 'pointerup' ? e.clientX : undefined, e?.clientY);
      if (slot) {   // let go on a picture slot: it takes a copy, and the layers and the selection go back as they were
        for (const [l, x, y, scale, crop, rotation] of held) Object.assign(l, { x, y, scale, crop, rotation });
        Object.assign(E, drag.was);
        drag.moved = false;
        lastTap = { t: 0, l: null };
        giveLayer(drag.l, slot);
      }
      if (e?.type === 'pointercancel') dropCopies();
      const moved = drag && drag.moved;
      if (drag?.crop && E.sel && G.pastEdge(E.sel.crop)) {   // past the edges: it waits for Extend, and the first was is what Cancel goes back to
        if (e?.type === 'pointercancel') Object.assign(E.sel, drag.was);
        else E.grow ||= { l: E.sel, was: drag.was };
      }
      boxShown = null;
      if (drag?.box && !drag.live) {   // a click: the layer under it, as a box that small would touch it
        const hit = boxLayers().reverse().find((l) => G.insideLayer(l, drag.a));
        ST.setPicked(E, ST.boxPick(hit ? [hit] : [], drag.before, drag.op));
      }
      if (drag?.item) {   // a box too small to mean anything was a click: gone
        const it = drag.item;
        if (it.w < 8 || it.h < 8) { E.items.splice(E.items.indexOf(it), 1); E.itemSel = -1; } else E.itemDraw = false;
      }
      drag = null; EVheld = false; E.guides = [];
      if (moved) { lastTap = { t: 0, l: null }; lastCorner = { t: 0, k: null }; persistEditor(); }
      renderEditor();
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.parentElement.append(toolbar = h('div', { class: 'layer-toolbar hidden', role: 'toolbar', 'aria-label': 'Layer tool' },
      h('button', { type: 'button', 'data-mode': 'transform', title: 'Move and resize (V). Alt+drag a layer to copy it', 'aria-label': 'Transform', onclick: () => setEditorMode(false) }, icon('move')),
      h('button', { type: 'button', 'data-mode': 'crop', title: 'Crop (C)', 'aria-label': 'Crop', onclick: () => setEditorMode(true) }, icon('crop')),
      h('button', { type: 'button', class: 'on hidden', 'data-grow': '', title: 'Make the new picture, with neutral grey in the new part (Enter)', onclick: applyGrow }, 'Extend'),
      h('button', { type: 'button', class: 'hidden', 'data-grow': '', title: 'Put the crop back (Esc)', 'aria-label': 'Cancel the extension', onclick: cancelGrow }, icon('close')),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', 'data-snap': '', title: 'Snap to the canvas and other layers (hold Alt to skip)', 'aria-label': 'Snap',
        onclick: () => { E.snap = !E.snap; persistEditor(); drawEditorCanvas(); } }, icon('target'))));
    new ResizeObserver(() => { if (!EVheld) drawEditorCanvas(); }).observe(cv.parentElement);
    // painting (paint.js): its pointer handlers come first while a paint tool is picked; its tool strip sits on the left
    paint = createPaint({
      E, canvas: () => cv, viewer: () => cv.parentElement, view: () => EV, zoom: viewZoom, frame: editorFrame,
      toCanvas: (e) => point(e), cancelDrag, redraw: drawEditorCanvas, render: renderEditor, changed: persistEditor, restoreStack, docId: () => cfg.docId?.() ?? E.tab?.id,
      hit: (p) => [...visibleLayers()].reverse().find((l) => G.insideLayer(l, p)) || null,
      maskFromSelection: () => {
        const l = E.sel?.maskOf ? E.layers.find((o) => o.key === E.sel.maskOf) : E.sel, m = l && E.layers.find((o) => l.key && o.maskOf === l.key);
        if (!l || !adjustable(l)) return toast('Pick a picture layer first', true);
        if (m) { pickOnly(m); paint.layerMaskOp(m, 'selection'); editorChanged(); } else addLayerMask(l);
      },
      snapOn: () => E.snap,
      snaps: () => { const rs = visibleLayers().map(bounds), f = editorFrame(); if (f) rs.push(f); return { xs: rs.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]), ys: rs.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]) }; },
      composite: (c) => { const f = editorFrame(); if (f) { c.fillStyle = E.bg; c.fillRect(f.x, f.y, f.w, f.h); } drawStack(c, visibleLayers()); },
      active: () => cfg.active() && !sheetOpen() && !EA.exporting,
    });
    cv.parentElement.append(...paint.els);

    // Ctrl+C / Ctrl+V: layers between edits. As copy and paste events: text being copied, a text box and a picture on the clipboard (the picture picker's Paste) are left alone
    const editing = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');
    document.addEventListener('copy', (e) => {
      if (!cfg.active() || sheetOpen() || editing(e) || !picked().length || String(getSelection() || '')) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', 'ComfyChair layers');   // (so an older picture on the clipboard doesn't win the paste)
      copySelected().catch((err) => toast(err.message, true));
    });
    // (only from the keys: on Linux a middle click is a paste event too, of whatever text is selected)
    let pasteKey = false;
    addEventListener('keydown', (e) => { pasteKey = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v'; }, true);
    document.addEventListener('paste', (e) => {
      const fromKeys = pasteKey;
      pasteKey = false;
      if (!fromKeys || !cfg.active() || sheetOpen() || editing(e) || !store.get(LAYER_CLIP, null)) return;
      if ([...(e.clipboardData?.items || [])].some((x) => x.type.startsWith('image/'))) return;
      e.preventDefault();
      pasteLayers();
    });
    // Ctrl+Enter or Shift+Enter runs the Image tool that's open, from its own text boxes too, and Ctrl+Enter in Inpaint runs Fill (editorRunKey).
    // Generate's Ctrl+Enter (app.js) is for the other tabs: here it would start a run of a panel that isn't on show. (On window: before paint.js's keys.)
    window.addEventListener('keydown', (e) => {
      if (!editorRunKeys(e) || !cfg.active() || sheetOpen() || !E.layers.some((l) => !l.mask && !l.draft)) return;
      const go = editorRunKey(e);
      if (!go && e.shiftKey) return;   // (a new line in another panel's box)
      e.preventDefault(); e.stopPropagation();
      if (!go || e.repeat) return;   // (a key held down starts one run)
      if (E.grow) return toast('Press Extend or Cancel on the crop first', true);
      if (e.target.matches?.('input')) e.target.dispatchEvent(new Event('change', { bubbles: true }));   // (a number just typed counts: it's only saved on change)
      if (go === 'fill') runFill(eng); else runImageTool(eng);
    }, true);
    // V / C switch tool, Esc finishes a crop / deselects, Delete removes the selected layer, arrows nudge it
    document.addEventListener('keydown', (e) => {
      if (cfg.active() && !sheetOpen() && E.sel && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'e' && !e.target.closest('input, textarea, select')) {
        e.preventDefault();
        return picked().length > 1 ? mergeSelected() : mergeDown(E.sel);
      }
      if (cfg.active() && !sheetOpen() && E.sel && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j' && !e.target.closest('input, textarea, select')) {
        e.preventDefault();
        return duplicateSelected();
      }
      if (!cfg.active() || sheetOpen()
        || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || !E.sel) return;
      const l = E.sel, n = e.shiftKey ? 10 : 1;
      const nudge = (dx, dy) => { if (E.cropping || !ready(l)) return; l.x += dx; l.y += dy; persistEditor(); };
      const keys = {
        Escape: () => { if (E.grow) cancelGrow(); else if (E.cropping) E.cropping = false; else if (E.multi.length) E.multi = []; else E.sel = null; },
        v: () => { E.cropping = false; }, c: () => { if (!plain(l)) { E.cropping = true; E.aspect = null; } },
        Enter: () => { if (E.grow) applyGrow(); else E.cropping = false; },
        Delete: () => (E.multi.length ? deleteSelected() : removeLayer(l)), Backspace: () => (E.multi.length ? deleteSelected() : removeLayer(l)),
        ArrowLeft: () => nudge(-n, 0), ArrowRight: () => nudge(n, 0), ArrowUp: () => nudge(0, -n), ArrowDown: () => nudge(0, n),
      };
      if (!keys[e.key]) return;
      e.preventDefault(); keys[e.key](); renderEditor();
    });
    // an animation's keys (← → only when no layer is selected: they nudge a selected one, so , . step then)
    playKeys(() => !!E.anim && cfg.active() && !sheetOpen(), () => EA.tp,
      () => (E.sel ? { ArrowLeft: null, ArrowRight: null } : {}));
  }

  function removeLayer(l) {
    const before = E.layers;
    E.layers = ST.normalize(E.layers.filter((o) => o !== l), E.groups);
    if (E.sel === l) { E.sel = null; E.cropping = false; }
    if (E.sel?.maskOf === l.key) { E.sel = null; E.cropping = false; }
    persistEditor();
    const tid = docId();
    undoToast('Layer removed', () => {
      if (docId() !== tid) return toast(cfg.elsewhere || 'That layer was in another edit tab', true);
      E.layers = before; E.sel = l; persistEditor(); renderEditor();
    });
  }

  function renderEditor() {
    cfg.beforeRender?.();
    for (const l of E.layers) l.key ||= uid();   // (what a mask and a group know a layer by)
    E.layers.forEach(loadLayerImage);
    for (const m of E.layers) if (m.maskOf) { const o = E.layers.find((x) => x.key === m.maskOf); if (o) ST.syncMask(m, o); }
    if (E.sel && !E.layers.includes(E.sel)) { E.sel = E.multi.find((l) => E.layers.includes(l)) || null; E.multi = E.multi.filter((l) => l !== E.sel); }
    E.multi = E.multi.filter((l) => E.layers.includes(l) && l !== E.sel);
    if (!E.sel) { E.multi = []; E.pickMode = false; }
    settleGrow();
    if (!E.sel || !ready(E.sel)) E.cropping = false;
    if (cfg.renderPanel) cfg.renderPanel(eng);
    else if (cfg.panel) {
      const top = cfg.panel.scrollTop, typing = keepTyping(cfg.panel);   // (the panel built again stays where it was scrolled)
      cfg.panel.replaceChildren(...[].concat(cfg.panelParts(eng)).filter(Boolean));
      typing();
      if (cfg.panel.scrollTop !== top) cfg.panel.scrollTop = top;
    }
    animBar();
    drawEditorCanvas();
    paint.sync();
  }
  // the panel's top row: add images, a blank canvas (more of the host's own after), clear all
  function topRow(more = []) {
    return panelTop([button('+ Add images', addEditorImages, { cls: 'primary' }),
      h('button', { type: 'button', class: 'icon-btn ico-btn', title: 'Blank canvas: a new empty layer to paint on', 'aria-label': 'Blank canvas',
        onclick: paint.blankSheet }, icon('canvas')), ...more]);
  }
  function clearLayers() {
    const before = E.layers, tid = docId();
    E.layers = []; E.sel = null; E.multi = []; E.arrange = null; persistEditor(); renderEditor();
    undoToast(`Cleared ${before.length} layer${before.length > 1 ? 's' : ''}`, () => {
      if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
      E.layers = before; persistEditor(); renderEditor();
    });
  }

  // (a change of the canvas's size is told, so an open frame's output size follows: frame-image.js)
  let toldSize = null;
  const editorChanged = () => {
    persistEditor(); renderEditor();
    const sig = JSON.stringify(E.size || null);
    if (sig !== toldSize) { toldSize = sig; dispatchEvent(new CustomEvent('editor:size')); }
  };
  const editorNum = (label, value, set, opts) => propNum(label, value, set, editorChanged, opts);

  const layerName = (l) => l.label || l.name?.split('/').pop() || 'Canvas';
  // a painted layer's thumbnail, drawn from its pixels (the server's thumbnails are JPEGs: no see-through)
  // a mask as it works: white shows, black hides
  function maskThumb(m) {
    const cv = h('canvas', { class: 'paint-thumb' });
    if (ready(m)) fillMaskThumb(m, cv);
    return cv;
  }
  function fillMaskThumb(m, cv) {
    m.thumbEl = cv; m.thumbRev = m.paintRev || 0;
    const W = m.img.naturalWidth || m.img.width, H = m.img.naturalHeight || m.img.height, k = Math.min(1, 88 / Math.max(W, H));
    cv.width = Math.max(1, Math.round(W * k)); cv.height = Math.max(1, Math.round(H * k));
    const c = cv.getContext('2d');
    c.drawImage(m.img, 0, 0, cv.width, cv.height);
    c.globalCompositeOperation = 'source-in'; c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    c.globalCompositeOperation = 'destination-over'; c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
  }
  function canvasThumb(src) {
    const k = Math.min(1, 88 / Math.max(src.width, src.height)), cv = h('canvas', { class: 'paint-thumb' });
    cv.width = Math.max(1, Math.round(src.width * k)); cv.height = Math.max(1, Math.round(src.height * k));
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    return cv;
  }

  // ---- several layers at once: E.sel is the first, E.multi the rest; edits in the panel go to all of them ----
  const picked = () => (E.sel ? [E.sel, ...E.multi.filter((l) => l !== E.sel && E.layers.includes(l))] : []);
  function togglePick(l) {
    const all = picked();
    if (!all.length) E.sel = l;
    else if (all.includes(l)) { const rest = all.filter((o) => o !== l); E.sel = rest[0] || null; E.multi = rest.slice(1); }
    else E.multi = [...all.slice(1), l];
    E.cropping = false;
  }
  const pickOnly = (l) => { E.sel = l; E.multi = []; E.cropping = false; };

  // Top of the list is drawn on top; tap a row to select that layer
  // a copy of each selected layer over them, in the same place, picked (undo takes it away: a change to the stack). A painted layer gets a canvas of its own.
  function duplicateSelected() { if (copyPicked()) editorChanged(); }
  function copyPicked() {
    const copyCanvas = (l) => {
      if (!(l.img instanceof HTMLCanvasElement)) return l.img;
      const cv = makeCanvas(l.img.width, l.img.height);   // (paint.js's: it says its size as a picture does, or the copy never counts as loaded)
      cv.getContext('2d').drawImage(l.img, 0, 0);
      return cv;
    };
    const r = ST.duplicate(E.layers, E.groups, picked().filter(ready), { newKey: uid, img: copyCanvas, name: layerName });
    if (!r.copies.length) { toast('Select a picture layer first', true); return null; }
    E.layers = r.layers; E.sel = r.copies[r.copies.length - 1]; E.multi = r.copies.slice(0, -1);
    return r;
  }
  function layerList() {
    if (!E.layers.length) return h('div', {}, hint('Add images from your inputs, generations or device, then tap one on the canvas to move, resize or crop it.'),
      store.get(LAYER_CLIP, null) ? button([icon('paste'), 'Paste layers'], pasteLayers, { cls: 'small', title: 'The layers you copied (Ctrl+V)' }) : null);
    const rows = ST.rowsOf(E.layers, E.groups);
    // (the list shows the top layer first: a place in it is the same place counted from the other end)
    const reorder = (from, to) => { E.layers = ST.moveRow(E.layers, E.groups, from, to); editorChanged(); };
    const several = picked(), hiddenCount = ST.hiddenOnes(E.layers).count;
    const bar = h('div', { class: 'row wrap layer-pick' },
      h('button', { type: 'button', class: `btn small${E.pickMode ? ' on' : ''}`, 'aria-pressed': String(!!E.pickMode),
        title: 'Taps on the list and the canvas add or drop layers from the selection. Also: Shift on the canvas, Alt in the list. Shift in the list selects a range',
        onclick: () => { E.pickMode = !E.pickMode; renderEditor(); } }, 'Select several'),
      iconBtn('Layer actions', icon('more'), (ev) => { const r = ev.currentTarget.getBoundingClientRect(); openLayerMenu(r.left, r.bottom + 4); }),
      help('Right click a layer or the canvas, or hold a finger on it, for what you can do with the selected layers. Pressing a layer that isn\'t selected selects it alone first. Merge draws the layers into one new picture: crops, turns, opacity and masks are drawn in. It keeps the lowest layer\'s blend, for the whole picture, so layers with a blend other than Normal can look different. A hidden layer isn\'t merged. Locked or animated layers can\'t be merged. Undo brings them back. Save each as input makes every layer its own input in this project, at its file\'s full pixels, with its crop, turn and opacity and a see-through background. Save as one input makes them one input the size of their shared box, on the Background colour, at Export size and Max MP. Open in a new edit puts them in a new tab, where they stay in place and can be changed without touching this edit. A hidden layer that is selected is included.'),
      several.length > 1 ? hint(`${several.length} selected`) : null,
      snapBar(['grid', 'rot', 'scale'], () => drawEditorCanvas()));
    const groupRow = (g) => {
      const members = E.layers.filter((l) => l.group === g.id && !l.maskOf), allOff = members.every((l) => l.hidden), allLocked = members.every((l) => l.locked);
      const pct = h('input', { type: 'number', min: 0, max: 100, step: 5, value: Math.round((g.opacity ?? 1) * 100), 'aria-label': `${g.name} opacity (%)`, title: 'Opacity of the group as one', class: 'layer-group-pct',
        onclick: (e) => e.stopPropagation(), onchange: (e) => { g.opacity = clamp(Number(e.target.value) / 100 || 0, 0, 1); editorChanged(); } });
      const blendSel = h('select', { 'aria-label': `${g.name} blend`, title: 'Blend of the group as one', onclick: (e) => e.stopPropagation(), onchange: (e) => { g.blend = e.target.value; editorChanged(); } },
        BLENDS.map(([v, l]) => h('option', { value: v, selected: v === (g.blend || 'normal') }, l)));
      return {
        sel: members.length && members.every((l) => several.includes(l)), off: allOff,
        onclick: () => { E.sel = members[members.length - 1]; E.multi = members.slice(0, -1); E.cropping = false; renderEditor(); },
        thumb: h('span', { class: 'layer-group-mark' }, icon('copy')), name: g.name, hint: `${members.length} layers`,
        buttons: [pct, blendSel,
          iconBtn(g.collapsed ? 'Open the group' : 'Fold the group', icon(g.collapsed ? 'right' : 'chevdown'), () => { g.collapsed = !g.collapsed; editorChanged(); }),
          iconBtn(allLocked ? 'Unlock the group' : 'Lock the group', icon(allLocked ? 'lock' : 'unlock'), () => { members.forEach((l) => { l.locked = !allLocked; }); editorChanged(); }),
          iconBtn(allOff ? 'Show the group' : 'Hide the group', allOff ? '◌' : '◉', () => { members.forEach((l) => { l.hidden = !allOff; }); editorChanged(); }),
          iconBtn('Ungroup', icon('close'), () => { E.layers = ST.ungroup(E.layers, E.groups, g.id); editorChanged(); })],
      };
    };
    const maskBtns = (l) => {
      const m = E.layers.find((x) => x.maskOf === l.key);
      if (!m) return [iconBtn(paint.hasSel() ? 'Add a mask from the selection' : 'Add a mask: paint on it to hide parts of this layer', icon('contrast'), () => addLayerMask(l))];
      return [h('button', { type: 'button', class: `mask-thumb${E.sel === m ? ' on' : ''}${l.maskOff ? ' off' : ''}`, 'aria-label': `Paint the mask of ${layerName(l)}`, title: 'Its mask: white shows, black hides. Tap to paint on it; tap again to go back to the layer',
        onclick: (e) => { e.stopPropagation(); if (E.sel === m) pickOnly(l); else { pickOnly(m); if (!paint.painting()) paint.setTool('eraser'); } renderEditor(); } }, maskThumb(m))];
    };
    const list = layerRowsEl(rows.map(({ group: g, layer: l, in: inGroup }) => {
      if (g) return groupRow(g);
      const r = ready(l) ? layerRect(l) : null, cropped = l.crop.w < 0.999 || l.crop.h < 0.999;
      const blend = l.blend && l.blend !== 'normal' ? ` · ${BLENDS.find(([v]) => v === l.blend)?.[1].toLowerCase()}` : '';
      return {
        cls: inGroup ? 'in-group' : '',
        sel: several.includes(l), off: l.hidden || l.broken,
        // (painting the selected layer: tapping it again keeps it, so the brush always has a layer)
        onclick: (ev) => {
          if ((ev?.ctrlKey || ev?.metaKey) && ev.altKey) { paint.selectLayer(l, ev.shiftKey ? 'add' : 'new'); return; }   // Ctrl+Alt-tap: its pixels become the selection
          if (ev?.shiftKey && !E.pickMode && E.sel) { ST.setPicked(E, ST.rangeOf(E.layers, E.sel, l)); E.cropping = false; renderEditor(); return; }   // from the selected layer through this one
          if (ev?.ctrlKey || ev?.metaKey || ev?.shiftKey || ev?.altKey || E.pickMode) { togglePick(l); renderEditor(); return; }
          if (l === E.sel && !E.multi.length && !paint.painting()) { E.sel = null; E.cropping = false; } else pickOnly(l);
          renderEditor();
        },
        thumb: layerThumb(l),
        name: layerName(l),
        hint: l.broken ? 'could not load' : !r ? 'loading…'
          : `${Math.round(r.w)}×${Math.round(r.h)}${cropped ? ' · cropped' : ''}${blend}${anyKeys(l) ? ' · animated' : ''}${l.hidden ? ' · hidden' : ''}`,
        buttons: [
          pinBtn(l),
          l.locked ? h('button', { type: 'button', class: 'icon-btn ico-btn on', 'aria-label': 'Unlock', title: 'Locked: tap to unlock',
            onclick: (e) => { e.stopPropagation(); l.locked = false; editorChanged(); } }, icon('lock')) : null,
          ...maskBtns(l),
          iconBtn(l.hidden ? 'Show' : 'Hide', l.hidden ? '◌' : '◉', () => { l.hidden = !l.hidden; editorChanged(); }),
          iconBtn('Delete layer', icon('trash'), () => { removeLayer(l); renderEditor(); })],
      };
    }), { onReorder: reorder, dragOut: (i, from) => {
      const l = rows[i].layer;
      if (!l || !canGive(l)) return null;
      const d = pictureDrag(from, () => layerThumb(l));
      return { move: (x, y) => !!d.move(x, y), end: (x, y) => { const slot = d.end(x, y); if (slot) giveLayer(l, slot); return !!slot; } };
    } });
    pressMenu(list, (e) => {
      const it = rows[[...list.children].indexOf(e.target.closest('.layer-row'))];
      if (it?.group) ST.setPicked(E, E.layers.filter((l) => l.group === it.group.id && !l.maskOf));
      else if (it?.layer) ST.setPicked(E, pickedFor(picked(), it.layer));
      if (it) E.cropping = false;
      renderEditor();
      openLayerMenu(e.clientX, e.clientY);
    }, { ok: (e) => !e.target.closest('button, .layer-grip') });
    return h('div', {}, bar, list);
  }

  // The frame's main source (a table frame: cfg.main() gives { id } with the pinned layer's key, or null off the table): what
  // Make, the Edit ops and a wire out of the frame take while it is set (frame-source.js). One per frame.
  const pinnable = (l) => !!l && !l.mask && !l.maskOf && !l.draft && !!l.name;
  const mainKey = () => cfg.main?.()?.id ?? null;
  function setMainLayer(l) {
    if (!cfg.main?.()) return;
    if (l && !pinnable(l)) return toast('Only a picture or a painted layer can be the main source', true);
    if (l) { l.key ||= uid(); persistEditor(); }   // (its key saved with the edit, so the pin finds it again)
    cfg.setMain?.(l ? l.key : null);
    renderEditor();
  }
  // on the pinned row (on), and on the selected one (off) to pin it
  function pinBtn(l) {
    if (!cfg.main?.() || !pinnable(l)) return null;
    const on = !!l.key && l.key === mainKey();
    if (!on && l !== E.sel) return null;
    return h('button', { type: 'button', class: `icon-btn ico-btn${on ? ' on' : ''}`, 'aria-pressed': String(on),
      'aria-label': on ? 'Not the main source' : 'Main source',
      title: on ? 'The main source: Make and the Edit tools take this layer alone. Tap to unpin' : 'Make this the main source: Make and the Edit tools take this layer alone',
      onclick: (e) => { e.stopPropagation(); setMainLayer(on ? null : l); } }, icon('pin'));
  }

  // What can be done with the selected layers (web/layer-menu.js says what's offered, and in what order)
  const LAYER_ACTIONS = {
    main: () => { const l = picked()[0]; setMainLayer(l && l.key && l.key === mainKey() ? null : l); },
    all: () => { const vis = E.layers.filter((l) => !l.mask && !l.draft && !l.maskOf); E.sel = vis[vis.length - 1] || null; E.multi = vis.slice(0, -1); renderEditor(); },
    none: () => { E.sel = null; E.multi = []; E.pickMode = false; renderEditor(); },
    several: () => { E.pickMode = !E.pickMode; renderEditor(); },
    copy: () => copySelected(), paste: () => pasteLayers(), duplicate: () => duplicateSelected(),
    group: () => { E.layers = ST.makeGroup(E.layers, E.groups, picked(), uid()); E.multi = []; editorChanged(); },
    mergeDown: () => mergeDown(picked()[0]), mergeSelected: () => mergeSelected(),
    saveEach: () => saveEach(), saveTogether: () => saveTogether(), openNew: () => openSelected(), moveNew: () => moveToNewEdit(),
    delete: () => deleteSelected(), deleteHidden: () => deleteHidden(), clear: () => clearLayers(),
  };
  function openLayerMenu(x, y) {
    const on = picked();
    const groups = layerMenu({ layers: E.layers.filter((l) => !l.mask && !l.draft && !l.maskOf).length, selected: on.length, pictures: selectedPictures().length,
      hidden: ST.hiddenOnes(E.layers).count, clip: !!store.get(LAYER_CLIP, null), pickMode: E.pickMode, newEdit: !!cfg.newEdit, table: !!onTable(),
      mergeDown: on.length === 1 && !!ST.mergeBelow(E.layers, on[0]), mergeSet: on.length > 1 && ST.mergeSet(E.layers, on).length >= 2,
      main: cfg.main?.() && on.length === 1 && pinnable(on[0]) ? { on: !!on[0].key && on[0].key === mainKey() } : null });
    openPressMenu(x, y, groups.map((g) => g.map((it) => ({ ...it, run: LAYER_ACTIONS[it.id] }))), 'Layers');
  }

  // A mask for this layer: a painted layer of its own, as big as the picture (the brush shows, the eraser hides); all showing to start with, or just the selection if there is one
  function addLayerMask(l) {
    if (!ready(l)) return;
    const fromSel = paint.hasSel();
    const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height;
    const m = paint.addBlank({ w: W, h: H, fill: '#ffffff' });
    l.key ||= uid();
    Object.assign(m, { maskOf: l.key, label: `${layerName(l)} mask` });
    ST.syncMask(m, l);
    E.layers = ST.normalize(E.layers, E.groups);
    E.sel = m; E.multi = [];
    if (fromSel) paint.layerMaskOp(m, 'selection');
    if (!paint.painting()) paint.setTool('eraser');
    editorChanged();
  }
  function maskProps(m) {
    const o = E.layers.find((x) => x.key === m.maskOf);
    if (!o) return null;
    return section(`Mask of ${layerName(o)}`, () => { pickOnly(o); renderEditor(); },
      help('Hide paints black on the mask and hides that part of the layer; Show paints it back. A soft or see-through brush hides part way. It moves and scales with its layer, and the red is only on screen: it never goes in the picture.'),
      field('Paint', seg([['eraser', 'Hide'], ['brush', 'Show']], ['eraser', 'brush'].includes(paint.P.tool) ? paint.P.tool : null, (t) => { paint.setTool(t); renderEditor(); })),
      field('See', seg([['red', 'Red on hidden'], ['grey', 'Black and white'], ['picture', 'Result']], maskView, (v) => { maskView = v; drawEditorCanvas(); })),
      field('It works on', help('Layer: what it hides is gone from the picture. Colour only: the whole layer shows, and the Colour section\'s curves and sliders apply only where the mask is white.'),
        seg([['layer', 'Layer'], ['adjust', 'Colour only']], o.maskFor === 'adjust' ? 'adjust' : 'layer', (v) => { if (v === 'adjust') o.maskFor = 'adjust'; else delete o.maskFor; editorChanged(); })),
      h('div', { class: 'row wrap' },
        button('Invert', () => { paint.layerMaskOp(m, 'invert'); editorChanged(); }, { cls: 'small', title: 'Swap what shows and what hides' }),
        button('Show all', () => { paint.layerMaskOp(m, 'all'); editorChanged(); }, { cls: 'small' }),
        button('Hide all', () => { paint.layerMaskOp(m, 'none'); editorChanged(); }, { cls: 'small' }),
        button('From selection', () => { paint.layerMaskOp(m, 'selection'); editorChanged(); }, { cls: 'small', disabled: !paint.hasSel(), title: 'Show only what is selected' })),
      field('Soften its edge', h('div', { class: 'row wrap' }, ...[4, 16, 48].map((r) => button(`${r} px`, () => { paint.layerMaskOp(m, 'soften', r); editorChanged(); }, { cls: 'small', title: `Blur the mask by ${r} px of the picture` })))),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: `btn small${o.maskOff ? ' on' : ''}`, onclick: () => { o.maskOff = !o.maskOff; editorChanged(); } }, o.maskOff ? 'Switched off' : 'Switch off'),
        button('Delete the mask', () => { E.layers = E.layers.filter((x) => x !== m); delete o.maskFor; pickOnly(o); editorChanged(); }, { cls: 'small danger' })));
  }

  // The selected layer's Colour section; kept while it stays selected, so a curve isn't rebuilt under the pointer
  let colourOf = null;
  const adjustable = (l) => ready(l) && !l.mask && !l.draft && !l.maskOf;
  function layerLook(l) { return A.histThrough(histOfPicture(l.img, l.crop), l.adjust); }
  // what's under a layer as one small picture, to match it to its surroundings
  function belowLook(l) {
    const f = editorFrame(), list = visibleLayers().filter((o) => !o.draft), at = list.indexOf(l);
    if (!f || at < 1) throw new Error('Nothing showing below it');
    const k = Math.min(1, 640 / Math.max(f.w, f.h)), cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(f.w * k)); cv.height = Math.max(1, Math.round(f.h * k));
    const c = cv.getContext('2d');
    c.scale(k, k); c.translate(-f.x, -f.y);
    drawStack(c, list.slice(0, at));
    return histOfPicture(cv);
  }
  function adjustProps(l) {
    if (!adjustable(l)) return null;
    if (colourOf?.layer === l) { colourOf.sync(); return colourOf.el; }
    const others = () => [
      ...(visibleLayers().indexOf(l) > 0 ? [['below', 'Everything below it']] : []),
      ...E.layers.map((o, i) => [i, o]).filter(([, o]) => o !== l && adjustable(o)).reverse().map(([i, o]) => [o.key || `at${i}`, layerName(o)]),
    ];
    const otherHist = async (id) => {
      if (id === 'below') return belowLook(l);
      const o = E.layers.find((x, i) => adjustable(x) && (x.key || `at${i}`) === id);
      if (!o) throw new Error('That layer has gone');
      return layerLook(o);
    };
    colourOf = { layer: l, ...adjustPanel({
      get: () => l.adjust || null, set: (a) => { if (a) l.adjust = a; else delete l.adjust; },
      onInput: () => { adjusting = true; drawEditorCanvas(); },
      onChange: () => { adjusting = false; persistEditor(); drawEditorCanvas(); },   // (no rebuild of the panel: the graph stays under the pointer)
      hist: async () => histOfPicture(l.img, l.crop), others, otherHist }) };
    return colourOf.el;
  }

  // Match colour, for the selected layers: curves on each so they look like one of them, or like all of them averaged (nothing else about them changes)
  let matchTo = null, matchStrength = 0.8;   // (the layer, or 'all'; kept while the panel redraws)
  function groupColour(ls) {
    const list = ls.filter(adjustable);
    if (list.length < 2) return null;
    if (matchTo !== 'all' && !list.includes(matchTo)) matchTo = list[0];
    const go = () => {
      try {
        const ref = matchTo === 'all' ? null : matchTo;
        const want = ref ? layerLook(ref) : A.averageLook(list.map(layerLook));
        if (!want) return toast('None of them has anything showing to match', true);
        let done = 0;
        for (const l of list) {
          if (l === ref) continue;
          const curves = A.matchCurves(A.histThrough(histOfPicture(l.img, l.crop), { ...l.adjust, curves: null }), want, { strength: matchStrength });
          if (!curves) continue;
          const a = A.clean({ ...l.adjust, curves });
          if (a) l.adjust = a; else delete l.adjust;
          done++;
        }
        editorChanged();
        toast(`${done} ${done === 1 ? 'layer' : 'layers'} matched${ref ? ` to ${layerName(ref)}` : ' to their average'}`);
      } catch (e) { toast(`Match failed: ${e.message}`, true); }
    };
    const pick = h('select', { 'aria-label': 'Match colour to', onchange: (e) => { matchTo = e.target.value === 'all' ? 'all' : list[+e.target.value]; } },
      list.map((l, i) => h('option', { value: i, selected: l === matchTo }, layerName(l))),
      h('option', { value: 'all', selected: matchTo === 'all' }, 'Their average'));
    return h('div', {},
      field('Match colour to', help('Gives each selected layer curves for the brightness and colour spread of the one picked, which stays as it is. Their average moves them all to a look in between, each layer counting the same whatever its size. A layer\'s sliders stay; its curves are replaced. Similar pictures match best: lower Strength when they show very different things. Select one layer to fine-tune its curves.'), pick),
      rangeField('Strength', () => matchStrength, (v) => { matchStrength = v; }, { min: 0, max: 1, step: 0.05, fmt: pctFmt }),
      button('Match colour', go, { cls: 'small primary', title: 'Curves on each selected layer' }));
  }

  // ---- Copy and paste layers, between the edits of this browser (store: they last until something else is copied) ----
  async function copySelected() {
    await paint.savePaint();   // (a painted layer needs its file first)
    const list = ST.clipOf(E.layers, picked().filter(ready)), saved = dumpEditor(list);
    if (!saved.layers.length) return toast('Select a picture layer first', true);
    store.set(LAYER_CLIP, { layers: saved.layers, groups: saved.groups });
    const n = saved.layers.filter((l) => !l.maskOf).length;
    toast(`${n} ${n === 1 ? 'layer' : 'layers'} copied: open another edit and Paste`);
    renderEditor();
  }
  function pasteLayers() {
    const clip = store.get(LAYER_CLIP, null);
    if (!clip?.layers?.length) return toast('Copy some layers first', true);
    const r = ST.pastedLayers(clip.layers, clip.groups || [], { newKey: uid, newGroup: uid });
    const made = fromSaved({ layers: r.layers }).layers;
    E.groups = [...E.groups, ...r.groups];
    E.layers = ST.normalize([...E.layers, ...made], E.groups);
    const pics = made.filter((l) => !l.maskOf);
    E.sel = pics[pics.length - 1] || null; E.multi = pics.slice(0, -1); E.cropping = false;
    editorChanged();
    toast(`${pics.length} ${pics.length === 1 ? 'layer' : 'layers'} pasted`);
  }
  // The selected layers, with their masks, out of this edit into a new one, where they had been on the canvas
  async function moveToNewEdit() {
    await paint.savePaint();   // (a painted layer needs its file first)
    const list = ST.clipOf(E.layers, picked().filter(ready)), saved = dumpEditor(list), before = E.layers, tid = docId();
    if (!saved.layers.length) return toast('Select a picture layer first', true);
    E.layers = ST.normalize(E.layers.filter((l) => !list.includes(l)), E.groups);
    E.sel = null; E.multi = []; E.cropping = false;
    persistEditor();
    const made = await cfg.newEdit({ ...saved, size: null, anim: null, arrange: null, items: [] });   // (true: a new frame beside the live one took them)
    if (made === false || (made !== true && docId() === tid)) { E.layers = before; persistEditor(); renderEditor(); return toast('Couldn\'t open a new edit: the layers stay here', true); }
    const n = saved.layers.filter((l) => !l.maskOf).length;
    toast(`${n} ${n === 1 ? 'layer' : 'layers'} moved to ${made === true ? 'a new frame beside this one' : 'this new edit'}`);
  }
  function deleteSelected() {
    const before = E.layers, was = picked(), tid = docId(), { keep, count } = ST.withoutPicked(E.layers, was);
    if (!count) return toast('Those layers are locked', true);
    E.layers = ST.normalize(keep, E.groups);
    E.sel = null; E.multi = []; E.cropping = false;
    persistEditor(); renderEditor();
    undoToast(`${count} ${count === 1 ? 'layer' : 'layers'} removed`, () => {
      if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
      E.layers = before; ST.setPicked(E, was); persistEditor(); renderEditor();
    });
  }
  function deleteHidden() {
    const before = E.layers, tid = docId(), { count, keep } = ST.hiddenOnes(E.layers);
    if (!count) return;
    E.layers = ST.normalize(keep, E.groups);
    if (E.sel && !E.layers.includes(E.sel)) E.sel = null;
    E.multi = E.multi.filter((l) => E.layers.includes(l));
    persistEditor(); renderEditor();
    undoToast(`${count} hidden ${count === 1 ? 'layer' : 'layers'} removed`, () => {
      if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
      E.layers = before; persistEditor(); renderEditor();
    });
  }

  // Grid: the selected pictures packed tight or in equal cells (web/layer-grid.js). gridCrops remembers what a grid cut, so another grid starts
  // from the picture's own crop, whatever the last one's cells were; a crop changed by hand since then is the new start.
  const GRID_PREFS = 'deck.layergrid', GRID_DEFAULTS = { pack: 'dense', cols: 0, gap: 0, crop: false };
  const gridCrops = new WeakMap();
  // ...and gridSpots the order it laid them out in, so another grid keeps it unless a picture has been moved since
  const gridSpots = new WeakMap();
  function makeGrid(ls) {
    const o = store.get(GRID_PREFS, GRID_DEFAULTS), dense = (o.pack || 'dense') === 'dense';
    const set = ls.filter((l) => ready(l) && !l.locked && !l.hidden && !plain(l)).sort((a, b) => E.layers.indexOf(b) - E.layers.indexOf(a));   // (top of the list first)
    if (set.length < 2) return toast('A grid needs two or more pictures that show and aren\'t locked', true);
    const bases = set.map((l) => { const m = gridCrops.get(l); return m && JSON.stringify(l.crop) === m.made ? m.base : l.crop; });
    const items = set.map((l, i) => gridItem(l, bases[i], o.crop));
    const spots = set.map((l) => gridSpots.get(l)), same = spots.every((m, i) => m && m.made === JSON.stringify(bounds(set[i])));
    const where = { frame: E.size ? editorFrame() : null, origin: unionRect(set.map(bounds)), cols: o.cols, gap: o.gap,
      ...(same ? { order: set.map((_, i) => i).sort((a, b) => spots[a].rank - spots[b].rank) } : {}) };
    const { cells, order } = dense ? densePlan(items, { ...where, fill: o.crop }) : gridPlan(items, where);
    set.forEach((l, i) => {
      Object.assign(l, fitToCell(l, bases[i], cells[i], o.crop, dense));
      if (o.crop) gridCrops.set(l, { base: bases[i], made: JSON.stringify(l.crop) }); else gridCrops.delete(l);
    });
    order.forEach((i, rank) => gridSpots.set(set[i], { rank, made: JSON.stringify(bounds(set[i])) }));
    editorChanged();
  }
  function gridControls(ls) {
    const o = store.get(GRID_PREFS, GRID_DEFAULTS);
    const save = (patch) => { store.set(GRID_PREFS, { ...o, ...patch }); renderEditor(); };
    const most = Math.min(8, ls.length);
    return field('Grid', help('Puts the selected pictures in a grid, as big as the canvas allows if it has a fixed size. Dense packs them edge to edge at their own shapes, in rows of differing heights (or columns), so the only space between them is the Gap; a number sets about how many go in a row. Equal cells gives every picture a cell of the same size, so a picture of another shape has space around it; a number sets the columns. They keep their reading order on the canvas; a pile goes in list order, top first. Auto picks what suits their shapes best. Crop off shows each whole picture. Crop on cuts what sticks out, around the middle, so the pictures fill the canvas in Dense and their cells in Equal cells; it also straightens a picture turned at an angle, to the nearest quarter. A hidden or locked layer stays where it is. Undo brings the old places back.'),
      seg([['dense', 'Dense'], ['cells', 'Equal cells']], o.pack || 'dense', (v) => save({ pack: v })),
      seg([[0, 'Auto'], ...Array.from({ length: most }, (_, i) => [i + 1, String(i + 1)])], o.cols > most ? 0 : o.cols, (v) => save({ cols: v }), { wrap: true }),
      rangeField('Gap', () => o.gap, (v) => { o.gap = v; store.set(GRID_PREFS, { ...o }); }, { min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)} px` }),
      h('div', { class: 'row wrap' }, toggle('Crop to fill', o.crop, (on) => save({ crop: on })), button('Make grid', () => makeGrid(ls), { cls: 'small primary', title: 'Lay them out with these settings' })));
  }

  // The panel for two or more selected layers: each change goes to every one of them
  function groupProps(ls) {
    const done = () => { E.sel = null; E.multi = []; E.pickMode = false; renderEditor(); };
    const each = (fn) => { for (const l of ls) if (ready(l)) fn(l); editorChanged(); };
    const bx = unionRect(ls.filter(ready).map(bounds));
    const f = E.size ? editorFrame() : bx;
    const mixed = (get) => new Set(ls.map(get)).size > 1;
    const same = (get, d) => (mixed(get) ? d : get(ls[0]));
    const aligner = (axis) => (k) => each((l) => {
      const r = bounds(l);
      if (axis === 'x') l.x += Math.round(f.x + (f.w - r.w) * k - r.x); else l.y += Math.round(f.y + (f.h - r.h) * k - r.y);
    });
    // spread the layers so the gaps between them are equal (the outermost two stay where they are)
    const spread = (axis) => {
      const k = axis === 'x' ? ['x', 'w'] : ['y', 'h'], rs = ls.filter(ready).map((l) => [l, bounds(l)]).sort((a, b) => a[1][k[0]] - b[1][k[0]]);
      if (rs.length < 3) return toast('Spread needs three or more layers', true);
      const first = rs[0][1], last = rs[rs.length - 1][1], total = last[k[0]] + last[k[1]] - first[k[0]];
      const gap = (total - rs.reduce((a, [, r]) => a + r[k[1]], 0)) / (rs.length - 1);
      let at = first[k[0]];
      for (const [l, r] of rs) { l[k[0]] = Math.round(l[k[0]] + at - r[k[0]]); at += r[k[1]] + gap; }
      editorChanged();
    };
    const scaleBy = (m) => each((l) => {
      const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      l.scale = Math.max(0.01, l.scale * m);
      const n = layerRect(l); l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
    });
    const turn = (d) => each((l) => {
      if (plain(l)) return;
      const c0 = G.centre(l); l.rotation = G.snapAngle((l.rotation || 0) + d); const c1 = G.centre(l); l.x += c0.x - c1.x; l.y += c0.y - c1.y;
    });
    const nudge = (dx, dy) => each((l) => { l.x += dx; l.y += dy; });
    const allOn = (k) => ls.every((l) => l[k]);
    return section(`${ls.length} layers`, done,
      hint(ls.map(layerName).join(', '), 'layer-title'),
      onTable() ? null : rangeField('Opacity', () => same((l) => l.opacity ?? 1, 1), (v) => { for (const l of ls) l.opacity = clamp(v, 0, 1); },
        { min: 0, max: 1, step: 0.01, fmt: pctFmt, def: 1, onInput: drawEditorCanvas, onChange: editorChanged }),   // (on the table: the Properties pane's)
      field('Blend', seg(BLENDS, mixed((l) => l.blend || 'normal') ? null : (ls[0].blend || 'normal'), (v) => each((l) => { l.blend = v; }), { wrap: true })),
      field('Size', h('div', { class: 'row wrap' }, button('Bigger ×1.1', () => scaleBy(1.1), { cls: 'small' }), button('Smaller ×0.9', () => scaleBy(0.9), { cls: 'small' }),
        button('100%', () => each((l) => { const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2; l.scale = 1; const n = layerRect(l); l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2); }), { cls: 'small' }),
        button('Match the first', () => { const w = layerRect(ls[0]).w; each((l) => { const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2; l.scale = Math.max(0.01, l.scale * w / r.w); const n = layerRect(l); l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2); }); }, { cls: 'small', title: 'Every layer the first one\'s width on the canvas' }))),
      groupColour(ls),
      h('div', { class: 'row wrap ed-turns' },
        iconBtn('Turn a quarter left', icon('rotl'), () => turn(-90)), iconBtn('Turn a quarter right', icon('rotr'), () => turn(90)),
        iconBtn('Mirror left to right', icon('fliph'), () => each((l) => { l.flipX = !l.flipX; })), iconBtn('Mirror top to bottom', icon('flipv'), () => each((l) => { l.flipY = !l.flipY; }))),
      field('Move all', h('div', { class: 'row wrap' }, ...[['◀', -10, 0], ['▲', 0, -10], ['▼', 0, 10], ['▶', 10, 0]].map(([t, dx, dy]) => button(t, () => nudge(dx, dy), { cls: 'small', title: `Nudge every layer ${Math.abs(dx || dy)} px` })))),
      field(E.size ? 'Align to canvas' : 'Align to each other',
        seg([[0, '⇤ Left'], [0.5, '↔ Centre'], [1, 'Right ⇥']], null, aligner('x'), { action: true }),
        seg([[0, '⤒ Top'], [0.5, '↕ Middle'], [1, 'Bottom ⤓']], null, aligner('y'), { action: true })),
      field('Spread evenly', h('div', { class: 'row wrap' }, button('Across', () => spread('x'), { cls: 'small' }), button('Down', () => spread('y'), { cls: 'small' }))),
      gridControls(ls),
      h('div', { class: 'row wrap' },
        button(allOn('hidden') ? 'Show all' : 'Hide all', () => { const on = !allOn('hidden'); each((l) => { l.hidden = on; }); }, { cls: 'small' }),
        button(allOn('locked') ? 'Unlock all' : 'Lock all', () => { const on = !allOn('locked'); each((l) => { l.locked = on; }); }, { cls: 'small' }),
        button(`Delete ${ls.length} layers`, () => {
          const before = E.layers, tid = docId();
          E.layers = E.layers.filter((l) => !ls.includes(l)); E.sel = null; E.multi = []; persistEditor(); renderEditor();
          undoToast(`${ls.length} layers removed`, () => {
            if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
            E.layers = before; persistEditor(); renderEditor();
          });
        }, { cls: 'small danger' })),
      help('Drag any selected layer on the canvas to move them all, or Alt+drag to copy them. Opacity, Blend and the buttons change every selected layer; the Image tools panel, set to Selected layers, runs on each one in turn. Select one layer to edit it alone.'));
  }

  // a layer's turn, about its centre (pulled to 15° steps, layer-geom.js snapAngle)
  const layerTurn = (l) => (v) => { const c0 = G.centre(l); l.rotation = G.snapAngle(v); const c1 = G.centre(l); l.x += c0.x - c1.x; l.y += c0.y - c1.y; };
  // One layer's X, Y, Scale, Rotation (not a painted canvas: it is resized) and Opacity: sliders, with ◀ ◆ ▶ to key them while
  // animating (keyed.js; the layer keys its own pose). The Layer section's, or on the table the Properties pane's.
  function layerXform(l) {
    l.rotation ??= 0;
    const setRotation = layerTurn(l);
    // scale around the layer's centre (where it is now: X may have moved it since this was built)
    const setScale = (s) => {
      const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      l.scale = s;
      const n = layerRect(l);
      l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
    };
    const fr = editorFrame() || layerRect(l);   // X / Y drag over the canvas and as much again either side (E.size is null when it fits the layers)
    const prop = (label, ch, set, opts) => (E.anim
      ? keyedRange(label, { item: l, ch, direct: true, t: () => E.t, base: () => l[ch], setBase: set, seek: editorSeek,
        onKeys: () => { poseAt(E.t); editorChanged(); }, onInput: drawEditorCanvas, onChange: editorChanged, ...opts })
      : rangeField(label, () => l[ch], set, { onInput: drawEditorCanvas, onChange: editorChanged, ...opts }));
    const px = { step: 1, digits: 0, fmt: (v) => String(Math.round(v)) };
    return {
      x: prop('X', 'x', (v) => { l.x = Math.round(v); }, { ...px, min: Math.floor(fr.x - fr.w), max: Math.ceil(fr.x + fr.w * 2) }),
      y: prop('Y', 'y', (v) => { l.y = Math.round(v); }, { ...px, min: Math.floor(fr.y - fr.h), max: Math.ceil(fr.y + fr.h * 2) }),
      scale: prop('Scale', 'scale', (v) => setScale(Math.max(0.01, v)), { min: 0.01, max: 4, step: 0.01, fmt: pctFmt, def: 1 }),
      rotation: plain(l) ? null : prop('Rotation', 'rotation', (v) => setRotation(v), { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°`, def: 0 }),
      opacity: prop('Opacity', 'opacity', (v) => { l.opacity = clamp(v, 0, 1); }, { min: 0, max: 1, step: 0.01, fmt: pctFmt, def: 1 }),
    };
  }
  // The Properties pane's rows for the picked layers (web/props-panel.js). One layer: its own sliders (above). Several: one
  // value for them all, "mixed" where they differ; an edit goes to each (moved, scaled and turned about its own centre),
  // through editorChanged (saved, the stack noted for undo).
  function propRows() {
    const ls = picked().filter((l) => !l.maskOf && ready(l));
    if (!ls.length) return [];
    if (ls.length === 1) {
      const xf = layerXform(ls[0]);
      return ['x', 'y', 'scale', 'rotation', 'opacity'].filter((k) => xf[k]).map((k) => ({ id: k, el: xf[k], group: k === 'opacity' ? 'Look' : 'Transform' }));
    }
    const each = (fn) => (v) => { for (const l of ls) if (!l.locked) fn(l, v); editorChanged(); };
    const scaleTo = (l, s) => { const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2; l.scale = Math.max(0.01, s); const n = layerRect(l); l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2); };
    const all = (get) => sharedOf(ls.map(get));
    return [
      { id: 'x', label: 'X', group: 'Transform', get: () => all((l) => Math.round(l.x)), set: each((l, v) => { l.x = Math.round(v); }) },
      { id: 'y', label: 'Y', group: 'Transform', get: () => all((l) => Math.round(l.y)), set: each((l, v) => { l.y = Math.round(v); }) },
      { id: 'scale', label: 'Scale', group: 'Transform', get: () => all((l) => l.scale ?? 1), min: 0.01, max: 4, step: 0.01, digits: 2, set: each(scaleTo) },
      { id: 'rotation', label: 'Rotation', unit: '°', group: 'Transform', get: () => all((l) => l.rotation || 0), min: -180, max: 180, step: 1, digits: 0,
        set: each((l, v) => { if (!plain(l)) layerTurn(l)(v); }) },
      { id: 'opacity', label: 'Opacity', group: 'Look', get: () => all((l) => l.opacity ?? 1), min: 0, max: 1, step: 0.01, digits: 2, set: (v) => { for (const l of ls) l.opacity = clamp(v, 0, 1); editorChanged(); } },
    ];
  }

  function layerProps(l) {
    const done =() => { if (E.cropping) E.cropping = false; else E.sel = null; renderEditor(); };
    const del = button('Delete layer', () => { removeLayer(l); renderEditor(); }, { cls: 'small danger' });
    if (!ready(l)) return section('Layer', done, del);
    const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop;
    if (E.cropping) {
      return section('Crop', done,
        help('Drag the box or its corners on the canvas. Right-click or long-hold it to pick a shape. Double-tap a corner to trim the crop to the solid part of a picture with see-through in it. Switch back to Transform, or tap outside the image, when you\'re done.'),
        toggle('Past the edges', !!E.cropPast, (v) => { E.cropPast = v; renderEditor(); }, { help: 'Or hold Ctrl while you drag. The box can go past the picture, and the new part is neutral grey. Adjust it as often as you like, then press Extend (or Enter) to make a new layer over this one, which hides. Cancel (or Esc) puts the crop back, and so does leaving the crop without extending. Then Image tools → Edit from a prompt can fill the grey in. This worked in a test: Fill the plain grey area, continuing the picture naturally. Keep everything else exactly the same. The model draws the whole picture again, so a face can change a little: to keep the rest exact, paint the grey as the red mask and use The red mask.' }),
        field('Aspect', seg(ASPECTS.map(([label, a]) => [a, label]), E.aspect, (a) => setCropAspect(l, a), { wrap: true })),
        hint(E.grow ? `Extending ${W}×${H} to ${Math.round(c.w * W)}×${Math.round(c.h * H)} px` : `Keeping ${Math.round(c.w * W)}×${Math.round(c.h * H)} of ${W}×${H} px`),
        E.grow ? h('div', { class: 'row' },
          button('Extend', applyGrow, { cls: 'small primary', title: 'Enter' }),
          button('Cancel', cancelGrow, { title: 'Esc' })) : h('div', { class: 'row' },
          button('Finish crop', () => { E.cropping = false; renderEditor(); }, { cls: 'small primary' }),
          button('Reset crop', () => { E.aspect = null; setLayerCrop(l, { ...FULL }); editorChanged(); })));
    }
    const r = layerRect(l), cropped = c.w < 0.999 || c.h < 0.999;
    const setRotation = layerTurn(l);
    const quarter = (d) => { setRotation((l.rotation || 0) + d); editorChanged(); };
    const flip = (k) => { l[k] = !l[k]; editorChanged(); };
    const flat = plain(l);
    // (on the table, X, Y, Scale, Rotation and Opacity are the sidebar's Properties pane's: eng.propRows)
    const xf = onTable() ? {} : layerXform(l);
    return section('Layer', done,
      hint(layerName(l), 'layer-title'),
      xf.x, xf.y, xf.scale, xf.rotation,
      h('div', { class: 'row wrap ed-turns' },
        flat ? null : iconBtn('Turn a quarter left', icon('rotl'), () => quarter(-90)), flat ? null : iconBtn('Turn a quarter right', icon('rotr'), () => quarter(90)),
        h('button', { type: 'button', class: `icon-btn${l.flipX ? ' on' : ''}`, 'aria-label': 'Mirror left to right', title: 'Mirror left to right', 'aria-pressed': String(!!l.flipX), onclick: () => flip('flipX') }, icon('fliph')),
        h('button', { type: 'button', class: `icon-btn${l.flipY ? ' on' : ''}`, 'aria-label': 'Mirror top to bottom', title: 'Mirror top to bottom', 'aria-pressed': String(!!l.flipY), onclick: () => flip('flipY') }, icon('flipv')),
        !E.anim && l.rotation ? iconBtn('No turn', icon('reset'), () => { setRotation(0); editorChanged(); }) : null),
      xf.opacity,
      field('Blend', seg(BLENDS, l.blend || 'normal', (v) => { l.blend = v; editorChanged(); }, { wrap: true })),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: `btn small${l.locked ? ' on' : ''}`, title: 'No painting, moving or resizing it on the canvas',
          onclick: () => { l.locked = !l.locked; editorChanged(); } }, icon(l.locked ? 'lock' : 'unlock'), l.locked ? 'Locked' : 'Lock')),
      hint(`${Math.round(r.w)}×${Math.round(r.h)} px on the canvas · ${Math.round(c.w * W)}×${Math.round(c.h * H)} px of the image`),
      h('div', { class: 'row wrap' },
        flat ? null : button('Crop', () => { paint.setTool('move'); E.cropping = true; E.aspect = null; renderEditor(); }),
        cropped && !flat ? button('Reset crop', () => { setLayerCrop(l, { ...FULL }); editorChanged(); }) : null,
        button('100%', () => {
          const r = layerRect(l), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          l.scale = 1;
          const n = layerRect(l);
          l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
          editorChanged();
        })),
      flat && isCanvas(l) ? canvasSizeFields(l) : null,
      flat && !l.mask ? fillField('Background', () => l.fill || null, (c) => {
        if (c) l.fill = c; else delete l.fill;
        l.paintRev = (l.paintRev || 0) + 1;   // (what its Colour adjustments were worked out from has changed)
        persistEditor(); drawEditorCanvas();
      }, help('Behind what is painted on this canvas. Painted strokes stay as they are, and the eraser shows it. On a canvas made before this could change, an old fill is part of the painting and stays on top.')) : null,
      alignControls(l),
      del,
      help('Drag it on the canvas to move it, a corner to resize, or the round handle above it to turn it (it pulls to 15° steps; Shift steps by 15°, Alt turns freely); it snaps to the canvas and other layers (hold Alt, or turn off Snap, to place it freely). Switch to Crop in the toolbar above it (or double-tap).' + (flat ? ' A canvas is resized (below), not turned or cropped.' : '')));
  }

  // A painted canvas's size in its own pixels, any width and height; the anchor says which part stays put
  function canvasSizeFields(l) {
    const cw = l.img.width, ch = l.img.height, d = { w: cw, h: ch, ax: 0.5, ay: 0.5 };
    const grid = h('div', { class: 'anchor-grid', role: 'group', 'aria-label': 'Anchor' });
    const drawGrid = () => grid.replaceChildren(...[0, 0.5, 1].flatMap((ay) => [0, 0.5, 1].map((ax) =>
      h('button', { type: 'button', class: ax === d.ax && ay === d.ay ? 'on' : '', 'aria-label': `Anchor ${ay === 0 ? 'top' : ay === 1 ? 'bottom' : 'middle'} ${ax === 0 ? 'left' : ax === 1 ? 'right' : 'centre'}`,
        onclick: () => { d.ax = ax; d.ay = ay; drawGrid(); } }))));
    drawGrid();
    const clip = toggle('Hide what hangs over it', !!l.clip, (on) => { l.clip = on; editorChanged(); },
      { help: 'Like overflow: hidden. Layers above this canvas whose middle is over it are shown only where the canvas is; drag one out past the middle and it is free again.' });
    return field('Canvas size', clip,
      sizePicker({ label: 'Size', w: cw, h: ch, step: 1, lim: (n) => Math.min(8192, Math.max(1, n)), onChange: (nw, nh) => { d.w = nw; d.h = nh; } }),
      h('div', { class: 'row wrap' },
      grid,
      button('Resize', () => { paint.resizeCanvasLayer(l, d.w, d.h, d.ax, d.ay); }, { cls: 'small primary', title: 'Change the canvas\'s size; the pixels stay where the anchor holds them, new parts are see-through' })));
  }

  // Crop the whole picture (every layer): the canvas becomes the part kept, fixed at that size
  async function cropCanvas() {
    const f = editorFrame();
    if (!f) return toast('Add some images first', true);
    if (E.anim) return toast('An animation keeps its canvas', true);
    const full = document.createElement('canvas');
    composeEditor(full);
    const k = Math.min(1, 1600 / Math.max(full.width, full.height)), prev = document.createElement('canvas');
    prev.width = Math.max(1, Math.round(full.width * k)); prev.height = Math.max(1, Math.round(full.height * k));
    prev.getContext('2d').drawImage(full, 0, 0, prev.width, prev.height);
    const img = new Image();
    img.src = prev.toDataURL('image/jpeg', 0.85);
    openCrop({ img, crop: FULL, onApply: (c) => {
      const nx = Math.round(f.x + c.x * f.w), ny = Math.round(f.y + c.y * f.h), nw = Math.max(1, Math.round(c.w * f.w)), nh = Math.max(1, Math.round(c.h * f.h));
      if (nw === f.w && nh === f.h) return;
      for (const l of E.layers) { l.x -= nx; l.y -= ny; }   // (the kept part's corner becomes the origin)
      E.size = { w: nw, h: nh }; E.sizeShape = null;
      editorChanged();
      toast(`Cropped to ${nw}×${nh}: Fit layers brings the rest back into view`);
    } });
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

  // a fixed canvas: the resolution selector (sides a multiple of 8)
  function fixedSizeFields() {
    const { w, h: hh } = E.size;
    return sizePicker({ label: 'Output size', w, h: hh, step: 8, lim: (n) => Math.min(8192, Math.max(64, n)),
      mode: E.sizeMode && E.sizeMode.key === `${w}x${hh}` ? E.sizeMode.mode : null,
      onChange: (nw, nh, mode) => { E.size = { w: nw, h: nh }; E.sizeShape = null; E.sizeMode = { mode, key: `${nw}x${nh}` }; editorChanged(); } });
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
      button('Crop canvas…', cropCanvas, { disabled: !E.layers.some((l) => !l.mask), title: 'Crop the whole picture: every layer, together' }),
      colorField('Background', () => E.bg, (c) => { E.bg = c; persistEditor(); drawEditorCanvas(); }),
      toggle('See-through background (Download as a PNG with alpha)', E.clear, (on) => { E.clear = on; persistEditor(); drawEditorCanvas(); },
        { help: 'Download leaves the background out, so only the layers show and the rest is transparent. The checks on the canvas are only a guide. Saving to Generate and sending to a model stay on the Background colour.' }),
      field('Arrange layers', seg([['row', 'Side by side'], ['column', 'Stacked'], ['grid', 'Grid']], null,
        (m) => { arrangeLayers(m); renderEditor(); }, { action: true, disabled: !E.layers.length })),
      h('div', { class: 'row' },
        editorNum('Grid columns', E.cols, (v) => { E.cols = v; }, { min: 1, max: 12 }),
        editorNum('Gap (px)', E.gap, (v) => { E.gap = v; }, { min: 0, max: 400 })));
  }

  // this edit is an image frame open on the table: the frame (its results go in frames beside it, not to another screen)
  const onTable = () => (isLive('image') && liveFrame()?.doc === docId() ? liveFrame() : null);
  // what the edit makes: a picture to use as an input (on the table: Flatten, a new image frame), a download, a PhotoCraft document
  function exportProps() {
    if (!E.layers.length) return null;
    const table = !!onTable();
    return section('Export', null,
      E.anim ? h('div', { class: 'row wrap' }, button('Export clip', (ev) => exportEditorClip(ev.currentTarget), { cls: 'primary', title: table ? 'The animation as a clip, in a new video frame beside this one' : 'The animation as a video in History' }),
        WA.onlyToggle()) : null,
      sizeChoices({ label: 'Export size', choices: [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], value: E.out || 1, onPick: (v) => { E.out = v; persistEditor(); renderEditor(); },
        sizeOf: (v) => { const f = editorFrame(); return f ? { w: Math.round(f.w * v), h: Math.round(f.h * v) } : null; }, custom: { label: 'Times', min: 0.25, max: 4, step: 0.25 } }),
      sizeChoices({ label: 'Largest size', choices: MP_STEPS.map(([v, l]) => [v, l]), value: E.mp || 0, onPick: (v) => { E.mp = v; persistEditor(); },
        words: (v) => (v ? `${v} MP at most` : 'its own size'), custom: { label: 'Megapixels', min: 0.05, max: 16, step: 0.05 } }),
      h('div', { class: 'row wrap' },
        table ? button(E.anim ? 'Flatten this frame' : 'Flatten', saveEditor, { cls: E.anim ? 'small' : 'small primary', title: 'Every layer as one picture, in a new image frame beside this one' })
          : button(E.anim ? 'Save this frame as input' : 'Save as input', saveEditor, { cls: E.anim ? 'small' : 'small primary' }),
        button('Download', downloadEditor),
        button('Open in PhotoCraft', (ev) => craftEditor(ev.currentTarget), { title: 'Every layer as its own layer, to keep editing on the computer' }),
        button('Craft documents…', () => openCraftSheet())));
  }

  // ---- the selected layers on their own: inputs in this project, one input, or a new edit ----
  const selectedPictures = () => { const on = picked(); return E.layers.filter((l) => on.includes(l) && ready(l) && !l.mask && !l.draft && !l.maskOf); };
  const pngOf = (cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('The picture is too big to save'))), 'image/png'));
  // a layer alone at its file's own pixels, as it shows (crop, turn, opacity), with nothing behind it
  function layerAlone(l) {
    const b = bounds(l), k = 1 / l.scale, cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(b.w * k)); cv.height = Math.max(1, Math.round(b.h * k));
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high'; c.scale(k, k); c.translate(-b.x, -b.y);
    drawMasked(c, { ...l, blend: 'normal', live: null });   // (through its mask, if it has one)
    return cv;
  }
  const canGive = (l) => ready(l) && !l.mask && !l.draft && !l.maskOf;
  const layerThumb = (l) => (isCanvas(l) || (l.fill && ready(l)) ? canvasThumb(onPaper(l, l.img)) : h('img', { src: thumbUrl(l.name, 160), alt: '' }));
  // a layer dragged onto a picture slot (a tool's reference, say): the slot gets an input of it as it shows; the layer stays in the stack
  async function giveLayer(l, slot) {
    const b = busy('Copying the layer…');
    try {
      if (paint.unsavedPaint()) await paint.savePaint();
      slot.give((await uploadImage(await pngOf(layerAlone(l)), { mp: slot.mp(), source: 'editor', filename: 'layer.png', multiple: 1 })).name);
    } catch (e) { toast('Copy failed: ' + e.message, true); } finally { b.done(); }
  }
  // the work on the selected layers: unsaved paint first, so they are as they show
  async function onSelected(say, work) {
    const b = busy(say);
    try {
      if (paint.unsavedPaint()) await paint.savePaint();
      const list = selectedPictures();
      if (!list.length) return toast('Select a layer first', true);
      await work(list);
    } catch (e) { toast('Save failed: ' + e.message, true); } finally { b.done(); }
  }
  // an input in this project, as Save as input makes one, without leaving the Image tab
  const saveEach = () => onSelected('Saving the layers…', async (list) => {
    for (const l of list) await uploadImage(await pngOf(layerAlone(l)), { mp: 0, source: 'editor', filename: 'layer.png', multiple: 1, board: l.label || 'Saved layer' });
    toast(list.length > 1 ? `${list.length} layers saved as inputs` : 'Layer saved as an input');
  });
  const saveTogether = () => onSelected('Putting the layers together…', async (list) => {
    const b = unionRect(list.map(bounds)), x = Math.floor(b.x), y = Math.floor(b.y), w = Math.max(1, Math.ceil(b.x + b.w) - x), hh = Math.max(1, Math.ceil(b.y + b.h) - y);
    const k = E.out || 1, cv = document.createElement('canvas');
    cv.width = Math.round(w * k); cv.height = Math.round(hh * k);
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high'; c.scale(k, k);
    c.fillStyle = E.bg; c.fillRect(0, 0, w, hh);
    c.translate(-x, -y);
    drawStack(c, list);
    const r = await uploadImage(await pngOf(cv), { mp: E.mp, source: 'editor', filename: 'layers.png', board: 'Saved layers' });
    toast(`Saved as an input, ${r.width}×${r.height}`);
  });
  // These layers as one new picture, as they look: crops, turns, opacity, masks and blends are drawn in. Its input is an upload like any
  // other layer's; the old layers stay on the undo history.
  async function mergeLayers(list, say) {
    if (list.length < 2) return toast('Pick at least two layers that show', true);
    if (list.some((l) => l.locked)) return toast('Unlock the layers first', true);
    if (list.some(anyKeys)) return toast('An animated layer can\'t be merged', true);
    if (!list.every(ready)) return toast('The images are still loading', true);
    const tid = docId(), b = busy(say);
    try {
      if (paint.unsavedPaint()) await paint.savePaint();
      const box = unionRect(list.map(bounds)), x = Math.floor(box.x), y = Math.floor(box.y), w = Math.max(1, Math.ceil(box.x + box.w) - x), hh = Math.max(1, Math.ceil(box.y + box.h) - y);
      const group = ST.mergeGroup(list), k = ST.mergeScale(list, w, hh), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(hh * k));
      const c = cv.getContext('2d');
      c.imageSmoothingQuality = 'high'; c.scale(cv.width / w, cv.height / hh); c.translate(-x, -y);
      // (a group they share still applies to the merged layer, so it isn't drawn in as well)
      drawStack(c, group ? list.map(({ group: _, ...l }) => l) : list);
      const up = await uploadImage(await pngOf(cv), { mp: 0, source: 'editor', filename: 'merged.png', multiple: 1 });
      await new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = inputUrl(up.name); });   // (no gap on the canvas when it swaps)
      if (docId() !== tid) return toast(cfg.elsewhere || 'Those layers were in another edit tab', true);
      const low = list[0], merged = { key: uid(), name: up.name, label: `${layerName(list[list.length - 1])} (merged)`, crop: { ...FULL }, x, y, scale: w / cv.width, opacity: 1, hidden: false,
        blend: low.blend || 'normal', ...(group ? { group } : {}) };
      E.layers = ST.mergedStack(E.layers, E.groups, list, merged);
      E.sel = merged; E.multi = []; E.cropping = false;
      editorChanged();
      toast(list.some((l) => (l.blend || 'normal') !== 'normal') ? `Merged ${list.length} layers: a blend now applies to the whole picture, so it can look different (Undo brings them back)` : `Merged ${list.length} layers`);
    } catch (e) { toast('Merge failed: ' + e.message, true); } finally { b.done(); }
  }
  const mergeDown = (l) => { const o = ST.mergeBelow(E.layers, l); return o ? mergeLayers([o, l], 'Merging down…') : toast('Nothing showing below it to merge into', true); };
  const mergeSelected = () => mergeLayers(ST.mergeSet(E.layers, picked()), 'Merging the layers…');
  const openSelected = () => onSelected('Opening a new edit…', async (list) => {
    const keys = E.anim && list.some((l) => anyKeys(l));   // (an animation keeps its fixed canvas; otherwise the new edit fits its layers)
    const d = dumpEditor(E.layers.filter((l) => list.includes(l) || list.some((o) => o.key && o.key === l.maskOf)));   // (each with its mask; its group comes with it, and an unused group drops on load)
    await cfg.newEdit({ ...d, size: keys ? E.size : null, anim: keys ? E.anim : null, arrange: null, items: [], layers: d.layers.map((l) => ({ ...l, hidden: false })) });
  });

  // The edit as a layered PhotoCraft document: each layer cropped as here and placed where it sits on the canvas
  async function craftEditor(btn) {
    if (paint.unsavedPaint()) await paint.savePaint();   // PhotoCraft reads each layer's file
    const f = editorFrame(), layers = E.layers.filter((l) => ready(l) && l.name && !l.maskOf);
    if (!f || !layers.length) return toast('Add some images first', true);
    // PhotoCraft documents take no turns: a turned or mirrored layer goes as a picture of itself, turned, in its box
    const baked = async (l) => {
      const b = bounds(l), cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(b.w)); cv.height = Math.max(1, Math.round(b.h));
      const c = cv.getContext('2d');
      c.imageSmoothingQuality = 'high'; c.translate(-b.x, -b.y);
      drawMasked(c, { ...l, opacity: 1, blend: 'normal', live: null });
      const r = await fetch('/api/paint', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await new Promise((res) => cv.toBlob(res, 'image/png')) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { name: (await r.json()).name, b };
    };
    let list;
    try {
      list = await Promise.all(layers.map(async (l) => {
        const base = { name: layerName(l).replace(/\.[a-z]+$/i, ''), hidden: !!l.hidden, opacity: l.opacity ?? 1, blend: l.blend || 'normal' };
        if (G.turned(l) || maskOfLayer(l) || A.isOn(l.adjust) || l.fill) { const { name, b } = await baked(l); return { ...base, src: { input: name }, crop: { ...FULL }, rect: { x: b.x - f.x, y: b.y - f.y, w: b.w, h: b.h } }; }
        const r = layerRect(l);
        return { ...base, src: { input: l.name }, crop: l.crop, rect: { x: r.x - f.x, y: r.y - f.y, w: r.w, h: r.h } };
      }));
    } catch (e) { return toast(`Couldn't ready a turned layer: ${e.message}`, true); }
    sendToCraft('photo', { title: cfg.name?.() || 'Edit', canvas: { w: f.w, h: f.h, bg: E.bg }, layers: list }, btn, { frame: onTable() });
  }

  // a picture as a new layer on top (o: label, fit 'cover' or 'contain' to fill the canvas whatever its size, locked...)
  // (o.mask: a picture of the new layer's own size, added with it as its mask, one undo step)
  function addImage(name, { mask, ...o } = {}) {
    const l = { name, crop: { ...FULL }, scale: 1, opacity: 1, hidden: false, ...o };
    E.layers.push(l);
    if (mask) E.layers = ST.attachMask(E.layers, E.groups, l, { name: mask, label: `${layerName(l)} mask`, opacity: 1, hidden: false, blend: 'normal' }, uid());
    editorChanged();
    return l;
  }

  // The sampler's picture as a layer on top of the stack while a run goes: drawn like any layer, so it rides the view and everything else carries
  // on under it. A draft with no file, so it's never saved, sent or merged; locked, so a tap goes to what's below. src null takes it away.
  // size: the area to fill while the canvas has nothing else to measure. The run's result lands as its own new layer.
  function runPreview(src, { opacity = 1, size = null } = {}) {
    let l = E.layers.find((x) => x.runPreview);
    if (!src) {
      if (!l) return;
      E.layers.splice(E.layers.indexOf(l), 1);
      if (E.sel === l) E.sel = null;
      E.multi = (E.multi || []).filter((x) => x !== l);
      renderEditor();
      return;
    }
    const fresh = !l;
    if (fresh) {
      l = { key: `run-${uid()}`, runPreview: true, draft: true, locked: true, label: 'Sampling…', img: document.createElement('canvas'), crop: { ...FULL }, scale: 1, x: 0, y: 0, opacity: 1, hidden: false, blend: 'normal' };
      E.layers.push(l);
    } else if (E.layers[E.layers.length - 1] !== l) { E.layers.splice(E.layers.indexOf(l), 1); E.layers.push(l); }
    const W = src.width, H = src.height, im = l.img;
    if (im.width !== W || im.height !== H) { im.width = W; im.height = H; }
    im.naturalWidth = W; im.naturalHeight = H;
    im.getContext('2d').drawImage(src, 0, 0);
    const under = E.layers.filter((x) => x !== l && ready(x) && !x.hidden && !x.mask && !x.maskOf);
    const b = under.length ? unionRect(under.map(bounds)) : null;
    const f = E.size ? { x: 0, y: 0, ...E.size } : b || (size ? { x: 0, y: 0, ...size } : { x: 0, y: 0, w: W, h: H });
    l.scale = Math.min(f.w / W, f.h / H);
    l.x = f.x + (f.w - W * l.scale) / 2; l.y = f.y + (f.h - H * l.scale) / 2;
    l.opacity = opacity;
    drawEditorCanvas();
    if (fresh) renderEditor();
  }

  function addEditorImages() {
    openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => {
      E.layers.push({ name, crop: { ...FULL }, scale: 1, opacity: 1, hidden: false }); editorChanged();
    } });
  }
  // a double-click on a blank canvas: the picker
  cfg.empty?.parentElement?.addEventListener('dblclick', () => { if (!E.layers.length) addEditorImages(); });

  function editorBlob(clear = false, k = 1) {
    const cv = document.createElement('canvas');
    if (!composeEditor(cv, clear, k)) return Promise.resolve(null);
    return new Promise((res) => cv.toBlob(res, 'image/png'));
  }

  async function saveEditor() {
    const b = busy('Putting the image together…');   // big layers take a moment to draw and encode
    try {
      const blob = await editorBlob(false, E.out || 1);
      if (!blob) return toast('Add some images first', true);
      const at = onTable();
      if (at) {   // (on the table: a new image frame beside this one, of the picture's own size)
        const r = await uploadImage(blob, { mp: E.mp, source: 'editor', filename: 'editor.png' });
        const f = await (await import('./edit-ops.js')).frameBeside(at, { input: r.name, width: r.width, height: r.height }, { label: `Flat · ${at.label || 'image'}` });
        if (!f) throw new Error('it couldn\'t go on the table (it is in your pictures)');
        return toast(`${f.label}: a new frame beside this one`);
      }
      const r = await uploadImage(blob, { mp: E.mp, source: 'editor', filename: 'editor.png', board: 'Saved picture' });
      (await import('./generate.js')).useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
    } catch (e) { toast('Save failed: ' + e.message, true); }
    finally { b.done(); }
  }

  // The animation as a clip in History: each frame drawn here, the frames made a clip on the server (as the 3D tab's
  // scenes are), and that clip rendered like a one-clip Video edit
  async function exportEditorClip(btn) {
    editorPause();
    if (!visibleLayers().length) return toast('Add some images first', true);
    if (E.layers.some((l) => !l.broken && !ready(l))) return toast('The images are still loading', true);
    if (E.grow) return toast('Press Extend or Cancel on the crop first', true);
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
      const at = onTable();
      if (at) {   // (on the table: the clip lands in a new video frame beside this one when it is rendered)
        const { runBeside } = await import('./edit-ops.js');
        runBeside(at, g, 'video', 'Clip').then((f) => toast(`${f.label}: the clip is in a new frame`), () => {});
        toast('Rendering: the clip goes in a new video frame beside this one');
      } else (await import('./run.js')).openGeneration(g.id);
    } catch (e) { toast('Export failed: ' + e.message, true); }
    finally { EA.exporting = false; poseAt(E.t = t0); drawEditorCanvas(); btn.disabled = false; btn.textContent = label; }
  }

  async function downloadEditor() {
    const blob = await editorBlob(E.clear, E.out || 1);
    if (!blob) return toast('Add some images first', true);
    const a = h('a', { href: URL.createObjectURL(blob), download: `comfydeck_${Date.now()}.png` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const docId = () => cfg.docId?.() ?? E.tab?.id;
  // another document in this host: its state, posed at the start, nothing selected
  function load(payload) {
    editorPause();
    Object.assign(E, fromSaved(payload || {}), { sel: null, multi: [], pickMode: false, cropping: false, grow: null, aspect: null, guides: [], t: 0 });
    E.layers = ST.normalize(E.layers, E.groups);
    stackWas = null;   // (a fresh start for this document's undo)
    poseAt(0);
  }
  const eng = {
    E, render: renderEditor, draw: drawEditorCanvas, changed: persistEditor, runPreview, load, dump: dumpEditor, compose: composeEditor, composeLayer,
    blob: editorBlob, frame: editorFrame, toFixed: toFixedSize, composeMask, drawLayer, layerPicture, bounds, layerRect, ready, loading: () => E.layers.some((l) => !l.broken && !ready(l)), addImage, pause: editorPause,
    zoom: viewZoom, get paint() { return paint; },
    // the panel's parts, for the host to lay out
    topRow, layerList, layerProps: () => (picked().length > 1 ? groupProps(picked()) : E.sel?.maskOf ? maskProps(E.sel) : E.sel ? [layerProps(E.sel), E.cropping ? null : adjustProps(E.sel)] : null), picked, propRows, onTable, plain, animProps, canvasProps, exportProps,
    paintProps: () => paint.paintProps(),
    masksProps: () => masksSection(eng),
    inpaintProps: () => inpaintSection(eng),
    toolsProps: () => imageToolsSection(eng),
  };
  wireEditor();
  return eng;
}

// Crop popup for a loaded image; onApply gets {x,y,w,h} as fractions of it; onCancel runs after Cancel.
// img: an Image (a picture still loading is fine: the sheet opens at once with a spinner and fills in when it's in)
export async function openCrop({ img, crop = FULL, onApply, onCancel = null }) {
  if (!img.naturalWidth) {
    const seq = loadingSheet('Crop', 'Loading the picture…');
    try { await img.decode(); } catch { if (sheetStillOpen(seq)) closeSheet(); return toast('Could not load the image', true); }
    if (!sheetStillOpen(seq)) return;   // (closed while it loaded)
  }
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
      button('Cancel', () => { closeSheet(); onCancel?.(); }, { cls: 'small ghost' }), info));
  draw();
}
