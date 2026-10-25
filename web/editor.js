import {
  $, h, store, api, clamp01, busy, toast, undoToast, openOverlay, sheetOpen, openSheet, closeSheet, button, iconBtn, actions,
  seg, field, section, hint, propNum, layerRowsEl, panelTop,
} from './ui.js';
import { ASPECT_PRESETS, S, inputUrl, switchTab, thumbUrl } from './core.js';
import { openImagePicker, registerPickerSource, uploadImage } from './media.js';
import { TabSet } from './tabs.js';
import { mpInput, persist, renderFields } from './generate.js';

// ---------------------------------------------------------------------------
// sketch pad: draw an image (e.g. the source for image-to-image) with a pen or finger.
// Pen pressure sets the stroke width. Once a pen touches the canvas, finger touches are ignored
// (palm rejection) until "Pen only" is switched off.
// ---------------------------------------------------------------------------
const SWATCHES = ['#000000', '#ffffff', '#7f7f7f', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#f8bbd0', '#90caf9'];

export function openSketch({ base = null, aspect = 1, onDone }) {
  const st = { tool: 'pen', color: store.get('deck.sketch.color', '#000000'), size: store.get('deck.sketch.size', 12),
    penOnly: false, bg: '#ffffff', undo: [], redo: [] };
  const cv = h('canvas', { class: 'sketch-canvas' });
  const stage = h('div', { class: 'sketch-stage' }, cv);
  const ctx2 = cv.getContext('2d', { willReadFrequently: true });

  const resize = (a) => {  // ~1 MP at the chosen aspect, sides a multiple of 16
    const w = Math.round(Math.sqrt(1e6 * a) / 16) * 16, hh = Math.round(Math.sqrt(1e6 / a) / 16) * 16;
    cv.width = w; cv.height = hh;
    ctx2.fillStyle = st.bg; ctx2.fillRect(0, 0, w, hh);
    sizeInfo.textContent = `${w}×${hh}`;
    fit();
  };
  // show the whole canvas at the largest size that fits the stage, keeping its aspect
  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.min((r.width - 20) / cv.width, (r.height - 20) / cv.height);
    cv.style.width = `${Math.floor(cv.width * k)}px`; cv.style.height = `${Math.floor(cv.height * k)}px`;
  };
  const snapshot = () => {
    st.undo.push(ctx2.getImageData(0, 0, cv.width, cv.height));
    if (st.undo.length > 15) st.undo.shift();
    st.redo = [];
  };
  const restore = (from, to) => {
    if (!from.length) return;
    to.push(ctx2.getImageData(0, 0, cv.width, cv.height));
    const img = from.pop();
    if (img.width !== cv.width || img.height !== cv.height) { cv.width = img.width; cv.height = img.height; fit(); }
    ctx2.putImageData(img, 0, 0);
  };

  // drawing
  let stroke = null;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
  const width = (e) => st.size * (e.pointerType === 'pen' ? 0.15 + 0.85 * (e.pressure || 0.5) : 1);
  const segment = (from, to, w) => {
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.strokeStyle = st.tool === 'eraser' ? st.bg : st.color;
    ctx2.lineWidth = w; ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
    ctx2.beginPath(); ctx2.moveTo(...from); ctx2.lineTo(...to); ctx2.stroke();
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') { st.penOnly = true; penBtn.classList.add('on'); }
    if (st.penOnly && e.pointerType === 'touch') return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    snapshot();
    stroke = { id: e.pointerId, last: pos(e) };
    ctx2.fillStyle = st.tool === 'eraser' ? st.bg : st.color;  // a tap leaves a dot
    ctx2.beginPath(); ctx2.arc(...stroke.last, width(e) / 2, 0, Math.PI * 2); ctx2.fill();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (coalesced.length ? coalesced : [e])) {
      const p = pos(ev);
      segment(stroke.last, p, width(ev));
      stroke.last = p;
    }
  });
  const end = (e) => { if (stroke && e.pointerId === stroke.id) stroke = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  // toolbar
  const toolSeg = seg([['pen', '✎ Pen'], ['eraser', '⌫ Eraser']], st.tool, (t) => { st.tool = t; });
  const colorIn = h('input', { type: 'color', value: st.color });
  const setColor = (c) => {
    st.color = c; colorIn.value = c; store.set('deck.sketch.color', c);
    if (st.tool === 'eraser') { st.tool = 'pen'; toolSeg.set('pen'); }
  };
  colorIn.addEventListener('input', () => setColor(colorIn.value));
  const swatches = h('div', { class: 'swatches' }, SWATCHES.map((c) =>
    h('button', { type: 'button', style: `background:${c}`, 'aria-label': `Colour ${c}`, onclick: () => setColor(c) })));
  const sizeVal = h('span', { class: 'hint' }, `${st.size}px`);
  const sizeIn = h('input', { type: 'range', min: 1, max: 120, step: 1, value: st.size });
  sizeIn.addEventListener('input', () => { st.size = Number(sizeIn.value); sizeVal.textContent = `${st.size}px`; store.set('deck.sketch.size', st.size); });
  const penBtn = button('Pen only', () => { st.penOnly = !st.penOnly; penBtn.classList.toggle('on', st.penOnly); },
    { title: 'Ignore finger touches while drawing' });
  const sizeInfo = h('span', { class: 'hint' });
  const aspSeg = seg(ASPECT_PRESETS.map(([k, a]) => [a, k]), null, (a) => { snapshot(); resize(a); }, { wrap: true, action: true });

  const overlay = h('div', { class: 'sketch' },
    h('div', { class: 'sketch-bar' },
      toolSeg, swatches, colorIn,
      h('label', { class: 'sketch-size' }, 'Size', sizeIn, sizeVal),
      penBtn,
      iconBtn('Undo', '↶', () => restore(st.undo, st.redo)),
      iconBtn('Redo', '↷', () => restore(st.redo, st.undo)),
      button('Clear', () => { snapshot(); ctx2.fillStyle = st.bg; ctx2.fillRect(0, 0, cv.width, cv.height); }),
      h('div', { class: 'spacer' }),
      button('Cancel', () => close(), { cls: 'small ghost' }),
      button('Use drawing', async (e) => {
        e.target.disabled = true;
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        try {
          const r = await uploadImage(blob, { source: 'drawing', filename: 'drawing.png' });
          close(false, true); onDone(r.name, r);
        } catch (err) { toast('Save failed: ' + err.message, true); e.target.disabled = false; }
      }, { cls: 'small primary' })),
    stage,
    h('div', { class: 'sketch-foot' }, h('span', { class: 'hint' }, 'Canvas'), aspSeg, sizeInfo));
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  // Cancel, back gesture or leaving the page with strokes on the canvas asks first
  const close = openOverlay(overlay, { dirty: () => st.undo.length > 0, ask: 'Throw away this drawing?', onClose: () => ro.disconnect() });

  resize(aspect);
  if (base) {  // draw over an existing image: canvas takes its aspect
    const img = new Image();
    img.onload = () => {
      resize(img.naturalWidth / img.naturalHeight);
      ctx2.drawImage(img, 0, 0, cv.width, cv.height);
    };
    img.src = inputUrl(base);
  }
}

// Aspect of the current template's output size, so a drawing matches what will be generated.
export function templateAspect() {
  const fs = S.tpl?.fields || [];
  const w = fs.find((f) => f.input === 'width'), hh = w && fs.find((f) => f.node === w.node && f.input === 'height');
  return w && hh ? Number(S.values[w.key]) / Number(S.values[hh.key]) : 1;
}

// ---------------------------------------------------------------------------
// editor: a simple Photoshop-style layer stack for cropping images and putting them together
// (character sheets, side-by-side refs). Each layer is an input image with a crop, a position and
// a scale. Everything is drawn client-side on a canvas, then uploaded as a new input image.
// ---------------------------------------------------------------------------
export const FULL = { x: 0, y: 0, w: 1, h: 1 };
const SEEDED = 'deck.editor.seeded';   // set once a tab has loaded: the old single-editor state then lives in the tabs
const BLANK = () => ({ v: 2, size: null, cols: 2, gap: 0, bg: '#000000', mp: 0, snap: true, arrange: null, layers: [] });
// a saved payload (an edit tab, or the old `deck.editor`) as editor state
function fromSaved(saved) {
  const e = { ...BLANK(), ...saved, arrange: saved.arrange || null };
  // layers: { name, crop: {x,y,w,h} as fractions, x, y (canvas px), scale, hidden, img }; the last
  // one is drawn on top. size: a fixed {w,h} canvas, or null to fit around the layers.
  e.layers = (saved.layers || []).map((l) => ({ name: l.name, crop: { ...(l.crop || FULL) },
    x: l.x, y: l.y, scale: l.x == null ? 1 : l.scale, hidden: !!l.hidden }));
  // The old auto-layout editor kept no positions: lay its images out once they load, in the same
  // order (its first image was leftmost, so it goes to the top of the list).
  if (saved.v !== 2 && e.layers.length) { e.arrange = saved.layout || 'row'; e.layers.reverse(); }
  delete e.layout;
  return e;
}
export const E = fromSaved(store.get(SEEDED, false) ? {} : store.get('deck.editor', {}));
E.sel = null; E.cropping = false; E.aspect = null; E.guides = [];   // guides: snap lines {x} or {y} while dragging
E.tab = null;   // the tab this state belongs to: { id, qs }




// What a tab stores: the editor's settings and its layers (input image names + crop/position), all small.
// (Layers only ever name input images, so nothing here is a data URL or a blob.)
const dumpEditor = () => ({ v: 2, size: E.size, cols: E.cols, gap: E.gap, bg: E.bg, mp: E.mp, snap: E.snap, arrange: E.arrange,
  layers: E.layers.map((l) => ({ name: l.name, crop: l.crop, x: l.x, y: l.y, scale: l.scale, hidden: l.hidden })) });
// every edit ends up here: the tab saves itself shortly and its still follows
export function persistEditor() { tabs.changed(); stillSoon(); }

const tabMount = h('div', { class: 'editor-tabs' });
const tabs = new TabSet({ kind: 'edit-tabs', mount: tabMount, newName: (n) => `Edit ${n}`, seed: () => (store.get(SEEDED, false) ? null : dumpEditor()),
  adapter: {
    empty: BLANK,
    dump: dumpEditor,
    load(payload, doc) {
      if (E.tab?.id !== doc.id) stillNow(); else clearTimeout(stillTimer);   // a tab being left gets its still now (the draw is synchronous)
      stillDue = false;
      Object.assign(E, fromSaved(payload), { sel: null, cropping: false, aspect: null, guides: [], tab: { id: doc.id, qs: tabs.qs } });
      store.set(SEEDED, true);
      if (!doc.still && E.layers.length) stillSoon();
      renderEditor();
    },
  } });

// Resolves once a tab is open (or after ~8 s, e.g. offline), so other panels can write into the current tab
// without the first load replacing their change.
export async function editorTabsReady() {
  if (!tabs.started) tabs.start();
  for (let i = 0; i < 160 && !(tabs.active && E.tab?.id === tabs.active.id); i++) await new Promise((r) => setTimeout(r, 50));
}

// ---- the still: a picture of the composite, kept beside the tab so pickers can show it ----
const STILL_DELAY = 4000, STILL_MAX = 2048;
let stillTimer = 0, stillDue = false;
function stillSoon() {
  stillDue = true; clearTimeout(stillTimer);
  stillTimer = setTimeout(stillNow, STILL_DELAY);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && stillDue) stillNow(); });
// Draw now (synchronously, so the state can't change under it), then encode and upload. Never blocks editing.
async function stillNow() {
  clearTimeout(stillTimer);
  const tab = E.tab;
  if (!stillDue || !tab) return;
  if (E.layers.some((l) => !l.broken && !ready(l))) { stillTimer = setTimeout(stillNow, 1000); return; }   // images still loading
  stillDue = false;
  let cv = document.createElement('canvas');
  const has = composeEditor(cv);
  if (has && Math.max(cv.width, cv.height) > STILL_MAX) {
    const k = STILL_MAX / Math.max(cv.width, cv.height), small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(cv.width * k)); small.height = Math.max(1, Math.round(cv.height * k));
    const c2 = small.getContext('2d'); c2.imageSmoothingQuality = 'high'; c2.drawImage(cv, 0, 0, small.width, small.height);
    cv = small;
  }
  const url = `/api/store/edit-tabs/${tab.id}/still${tab.qs}`;
  try {
    if (!has) { await fetch(url, { method: 'DELETE' }); return; }   // nothing to show any more
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const r = blob && await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob });
    if (r && !r.ok && r.status !== 404) console.warn('still not saved:', r.status);   // 404: the tab is gone
  } catch { stillDue = true; }   // offline: the next edit tries again
}

// Saved edits as a source in every image picker (media.js registerPickerSource)
registerPickerSource({ key: 'edit-tabs', label: 'Saved edits',
  async list(pid) {
    if (stillDue) { await tabs.flush(); await stillNow(); }   // the open tab's picture first, if it's behind
    const rows = await api(`/api/store/edit-tabs${pid != null ? `?project_id=${pid}` : ''}`);
    return rows.filter((d) => d.still).map((d) => ({ id: d.id, title: d.name, thumb: d.still.url, still: true }));
  },
  async pick(it, { mp, frame }) {
    const blob = frame || await (await fetch(it.thumb)).blob();
    const r = await uploadImage(blob, { mp, source: 'edit-tab', filename: 'edit.png' });
    return { ...r, from: { source: 'edit-tab', id: it.id } };   // (the input list tags it 'edit-tab'; the tab id rides along here)
  } });

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

// the kept part of a layer in canvas px, and the whole image behind it (shown while cropping)
function layerRect(l) {
  const c = l.crop;
  return { x: l.x, y: l.y, w: c.w * l.img.naturalWidth * l.scale, h: c.h * l.img.naturalHeight * l.scale };
}
function imageRect(l) {
  const w = l.img.naturalWidth * l.scale, hh = l.img.naturalHeight * l.scale;
  return { x: l.x - l.crop.x * w, y: l.y - l.crop.y * hh, w, h: hh };
}
function unionRect(rs) {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}
const visibleLayers = () => E.layers.filter((l) => ready(l) && !l.hidden);
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

// The output area: the fixed size, or just big enough for every visible layer
function editorFrame() {
  if (E.size) return { x: 0, y: 0, w: E.size.w, h: E.size.h };
  const vis = visibleLayers();
  if (!vis.length) return null;
  const b = unionRect(vis.map(layerRect)), x = Math.floor(b.x), y = Math.floor(b.y);
  return { x, y, w: Math.max(1, Math.ceil(b.x + b.w) - x), h: Math.max(1, Math.ceil(b.y + b.h) - y) };
}

function drawLayer(ctx, l) {
  const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop, r = layerRect(l);
  ctx.drawImage(l.img, c.x * W, c.y * H, Math.max(1, c.w * W), Math.max(1, c.h * H), r.x, r.y, r.w, r.h);
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
  const src = [...E.layers].reverse().filter((l) => !l.broken && layerLoaded(l)).map((l) =>
    ({ l, sw: Math.max(1, l.crop.w * l.img.naturalWidth), sh: Math.max(1, l.crop.h * l.img.naturalHeight) }));
  if (!src.length) return;
  const gap = Math.max(0, E.gap | 0);
  const put = (s, x, y, scale) => Object.assign(s.l, { x: Math.round(x), y: Math.round(y), scale });
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
    const b = unionRect(src.map((s) => layerRect(s.l)));
    const k = Math.min(E.size.w / b.w, E.size.h / b.h);
    const dx = (E.size.w - b.w * k) / 2, dy = (E.size.h - b.h * k) / 2;
    for (const { l } of src) Object.assign(l, { x: Math.round(dx + (l.x - b.x) * k), y: Math.round(dy + (l.y - b.y) * k), scale: l.scale * k });
  }
  persistEditor();
}

// A new image goes in the middle of what's already there, shrunk to fit inside it
function placeLayer(l) {
  const w = l.crop.w * l.img.naturalWidth, hh = l.crop.h * l.img.naturalHeight;
  const others = visibleLayers().filter((o) => o !== l);
  const f = E.size ? editorFrame() : others.length ? unionRect(others.map(layerRect)) : null;
  l.scale = f ? Math.min(1, f.w / w, f.h / hh) : 1;
  l.x = f ? Math.round(f.x + (f.w - w * l.scale) / 2) : 0;
  l.y = f ? Math.round(f.y + (f.h - hh * l.scale) / 2) : 0;
  E.sel = l; E.cropping = false;
  persistEditor();
}

// What a layer lines up with: the canvas (when it fits the layers, the other layers' bounds),
// or nothing when it's the only layer
function alignFrame(l) {
  const others = visibleLayers().filter((o) => o !== l).map(layerRect);
  return E.size ? editorFrame() : others.length ? unionRect(others) : null;
}

// Snap targets: the edges and centres of the align frame and of every other visible layer
const SNAP = 8;   // screen px
function snapTargets(l) {
  const rs = visibleLayers().filter((o) => o !== l).map(layerRect), f = alignFrame(l);
  if (f) rs.push(f);
  return { xs: rs.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]), ys: rs.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]) };
}
// the smallest shift (d) that puts one of vals on a target within thr, and that target (at)
function snapNearest(vals, targets, thr) {
  let best = null;
  for (const v of vals) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}

// Set a layer's crop without moving the image under it
function setLayerCrop(l, c, ir = imageRect(l)) {
  l.crop = c;
  l.x = ir.x + c.x * ir.w; l.y = ir.y + c.y * ir.h;
}

// view: canvas px → screen px in the viewer (s = zoom, ox/oy = offset). It's refitted on every
// redraw, except while dragging, so the canvas doesn't jump around under the finger.
let EV = null, EVheld = false;
function fitView(w, hh) {
  if (EVheld && EV) return;
  const f = editorFrame(), rs = f ? [f] : [];
  if (E.size) rs.push(...visibleLayers().map(layerRect));   // show layers hanging off a fixed canvas too
  if (E.cropping && E.sel && ready(E.sel)) rs.push(imageRect(E.sel));
  if (!rs.length) { EV = null; return; }
  const b = unionRect(rs), pad = 28, top = 72;   // room above for the layer toolbar
  const s = Math.max(1e-3, Math.min((w - 2 * pad) / b.w, (hh - pad - top) / b.h));
  EV = { s, ox: (w - b.w * s) / 2 - b.x * s, oy: top + (hh - pad - top - b.h * s) / 2 - b.y * s };
}

const HANDLE = 22;   // touch radius of a corner handle, screen px
function drawBox(ctx, r, accent) {
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = accent; ctx.strokeStyle = '#000';
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

function drawEditorCanvas() {
  const cv = $('#editorCanvas'), any = E.layers.some(ready);
  $('#editorToolbar').classList.add('hidden');
  cv.classList.toggle('hidden', !any);
  $('#editorEmpty').classList.toggle('hidden', any);
  const f = editorFrame();
  $('#editorSize').textContent = any && f ? `${f.w}×${f.h} · ${(f.w * f.h / 1e6).toFixed(2)} MP` : '';
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
  if (E.cropping) {   // the whole image dimmed, the kept part on top of it
    const ir = scr(imageRect(sel));
    ctx.fillStyle = '#000a'; ctx.fillRect(0, 0, w, hh);
    ctx.globalAlpha = 0.35; ctx.drawImage(sel.img, ir.x, ir.y, ir.w, ir.h); ctx.globalAlpha = 1;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s); drawLayer(ctx, sel); ctx.restore();
    ctx.strokeStyle = '#fff6'; ctx.lineWidth = 1; ctx.strokeRect(ir.x, ir.y, ir.w, ir.h);
  }
  drawBox(ctx, scr(layerRect(sel)), accent);
  ctx.strokeStyle = '#ff3df2'; ctx.lineWidth = 1;
  for (const g of E.guides) {
    ctx.beginPath();
    if (g.x != null) { const x = Math.round(ox + g.x * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
    else { const y = Math.round(oy + g.y * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }
  placeEditorToolbar(scr(E.cropping ? imageRect(sel) : layerRect(sel)), w, hh);
}

// The Transform / Crop switch floats above the selected layer (below it, or inside, when there's no room)
function placeEditorToolbar(r, w, hh) {
  const bar = $('#editorToolbar');
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
  const cv = $('#editorCanvas');
  const point = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left - EV.ox) / EV.s, y: (e.clientY - r.top - EV.oy) / EV.s };
  };
  const corner = (p, r) => {
    for (const k of ['nw', 'ne', 'sw', 'se']) {
      const x = k.includes('w') ? r.x : r.x + r.w, y = k.includes('n') ? r.y : r.y + r.h;
      if (Math.hypot(x - p.x, y - p.y) * EV.s < HANDLE) return k;
    }
    return null;
  };
  let drag = null, lastTap = { t: 0, l: null };
  cv.addEventListener('pointerdown', (e) => {
    if (!EV) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const p = point(e), sel = E.sel && ready(E.sel) ? E.sel : null;
    drag = null; EVheld = true;
    if (sel && E.cropping) {
      const ir = imageRect(sel), c = sel.crop, k = corner(p, layerRect(sel));
      const q = { x: clamp01((p.x - ir.x) / ir.w), y: clamp01((p.y - ir.y) / ir.h) };
      if (k) drag = { crop: true, ir, fx: k.includes('w') ? c.x + c.w : c.x, fy: k.includes('n') ? c.y + c.h : c.y };
      else if (inside(p, layerRect(sel))) drag = { crop: true, ir, move: true, q0: q, c0: { ...c } };
      else if (inside(p, ir)) drag = { crop: true, ir, fx: q.x, fy: q.y };
      else { EVheld = false; E.cropping = false; renderEditor(); }   // tapping outside the image finishes the crop
      return;
    }
    const k = sel && corner(p, layerRect(sel));
    if (k) {
      const r = layerRect(sel);
      drag = { resize: true, l: sel, ax: k.includes('w') ? r.x + r.w : r.x, ay: k.includes('n') ? r.y + r.h : r.y,
        cw: r.w / sel.scale, ch: r.h / sel.scale };
      return;
    }
    const hit = visibleLayers().reverse().find((l) => inside(p, layerRect(l)));
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
      const l = E.sel, ir = drag.ir, W = l.img.naturalWidth, H = l.img.naturalHeight;
      const q = { x: clamp01((p.x - ir.x) / ir.w), y: clamp01((p.y - ir.y) / ir.h) };
      const c = drag.move
        ? { ...drag.c0, x: Math.min(1 - drag.c0.w, Math.max(0, drag.c0.x + q.x - drag.q0.x)),
          y: Math.min(1 - drag.c0.h, Math.max(0, drag.c0.y + q.y - drag.q0.y)) }
        : cropSpan(W, H, E.aspect, drag.fx, drag.fy, q.x, q.y);
      setLayerCrop(l, c, ir);
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
        const t = snapTargets(l), thr = SNAP / EV.s, r = layerRect(l);
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
  cv.parentElement.append(h('div', { id: 'editorToolbar', class: 'layer-toolbar hidden', role: 'toolbar', 'aria-label': 'Layer tool' },
    h('button', { type: 'button', 'data-mode': 'transform', title: 'Move and resize (V)', onclick: () => setEditorMode(false) }, '✥ Transform'),
    h('button', { type: 'button', 'data-mode': 'crop', title: 'Crop (C)', onclick: () => setEditorMode(true) }, '⛶ Crop'),
    h('span', { class: 'sep' }),
    h('button', { type: 'button', 'data-snap': '', title: 'Snap to the canvas and other layers (hold Alt to skip)',
      onclick: () => { E.snap = !E.snap; persistEditor(); drawEditorCanvas(); } }, '⌖ Snap')));
  new ResizeObserver(() => { if (!EVheld) drawEditorCanvas(); }).observe(cv.parentElement);

  // V / C switch tool, Esc finishes a crop / deselects, Delete removes the selected layer, arrows nudge it
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-editor').classList.contains('active') || sheetOpen()
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
}

function removeLayer(l) {
  const before = E.layers;
  E.layers = E.layers.filter((o) => o !== l);
  if (E.sel === l) { E.sel = null; E.cropping = false; }
  persistEditor();
  const tid = E.tab?.id;
  undoToast('Layer removed', () => {
    if (E.tab?.id !== tid) return toast('That layer was in another edit tab', true);
    E.layers = before; E.sel = l; persistEditor(); renderEditor();
  });
}

export function renderEditor() {
  if (!tabs.started) tabs.start();
  E.layers.forEach(loadLayerImage);
  if (E.sel && !E.layers.includes(E.sel)) E.sel = null;
  if (!E.sel || !ready(E.sel)) E.cropping = false;
  $('#editorPanel').replaceChildren(
    h('div', { class: 'panel-body' }, tabMount,
      panelTop(button('+ Add images', addEditorImages, { cls: 'primary' }), E.layers.length ? () => {
        const before = E.layers, tid = E.tab?.id;
        E.layers = []; E.sel = null; E.arrange = null; persistEditor(); renderEditor();
        undoToast(`Cleared ${before.length} layer${before.length > 1 ? 's' : ''}`, () => {
          if (E.tab?.id !== tid) return toast('Those layers were in another edit tab', true);
          E.layers = before; persistEditor(); renderEditor();
        });
      } : null),
      layerList(),
      E.sel ? layerProps(E.sel) : canvasProps()));
  drawEditorCanvas();
}

const editorChanged = () => { persistEditor(); renderEditor(); };
const editorNum = (label, value, set, opts) => propNum(label, value, set, editorChanged, opts);

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
    return {
      sel: l === E.sel, off: l.hidden || l.broken,
      onclick: () => { E.sel = l === E.sel ? null : l; E.cropping = false; renderEditor(); },
      thumb: h('img', { src: thumbUrl(l.name, 160), alt: '' }),
      name: l.name.split('/').pop(),
      hint: l.broken ? 'could not load' : !r ? 'loading…'
        : `${Math.round(r.w)}×${Math.round(r.h)}${cropped ? ' · cropped' : ''}${l.hidden ? ' · hidden' : ''}`,
      buttons: [
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
      hint('Drag the box or its corners on the canvas. Switch back to Transform, or tap outside the image, when you\'re done.'),
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
  // scale around the layer's centre
  const setScale = (s) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    l.scale = s;
    const n = layerRect(l);
    l.x = Math.round(cx - n.w / 2); l.y = Math.round(cy - n.h / 2);
  };
  const fr = editorFrame() || r;   // X / Y drag over the canvas and as much again either side (E.size is null when it fits the layers)
  return section('Layer', done,
    hint(l.name.split('/').pop(), 'layer-title'),
    h('div', { class: 'row' },
      editorNum('X', Math.round(l.x), (v) => { l.x = v; }, { min: Math.floor(fr.x - fr.w), max: Math.ceil(fr.x + fr.w * 2), live: drawEditorCanvas }),
      editorNum('Y', Math.round(l.y), (v) => { l.y = v; }, { min: Math.floor(fr.y - fr.h), max: Math.ceil(fr.y + fr.h * 2), live: drawEditorCanvas }),
      editorNum('Scale %', Math.round(l.scale * 1000) / 10, (v) => setScale(v / 100), { min: 1, max: 1000, step: 'any', live: drawEditorCanvas })),
    hint(`${Math.round(r.w)}×${Math.round(r.h)} px on the canvas · ${Math.round(c.w * W)}×${Math.round(c.h * H)} px of the image`),
    h('div', { class: 'row wrap' },
      button('Crop', () => { E.cropping = true; E.aspect = null; renderEditor(); }),
      cropped ? button('Reset crop', () => { setLayerCrop(l, { ...FULL }); editorChanged(); }) : null,
      button('100%', () => { setScale(1); editorChanged(); })),
    alignControls(l),
    del,
    hint('Drag it on the canvas to move it, or a corner to resize; it snaps to the canvas and other layers (hold Alt, or turn off Snap, to place it freely). Switch to Crop in the toolbar above it (or double-tap).'));
}

// Align buttons: 0 / 0.5 / 1 = start / centre / end of the align frame, per axis
function alignControls(l) {
  const f = alignFrame(l);
  const align = (axis) => (k) => {
    const r = layerRect(l);
    if (axis === 'x') l.x = Math.round(f.x + (f.w - r.w) * k); else l.y = Math.round(f.y + (f.h - r.h) * k);
    editorChanged();
  };
  return field(E.size ? 'Align to canvas' : 'Align to the other layers',
    seg([[0, '⇤ Left', 'Align left edges'], [0.5, '↔ Centre', 'Centre horizontally'], [1, 'Right ⇥', 'Align right edges']], null, align('x'), { action: true, disabled: !f }),
    seg([[0, '⤒ Top', 'Align top edges'], [0.5, '↕ Middle', 'Centre vertically'], [1, 'Bottom ⤓', 'Align bottom edges']], null, align('y'), { action: true, disabled: !f }));
}

function canvasProps() {
  const f = editorFrame();
  const sizeSeg = seg([['fit', 'Fit layers'], ['fixed', 'Fixed size']], E.size ? 'fixed' : 'fit', (v) => {
    if (v === 'fit') E.size = null;
    else if (!E.size) {
      // start from what the layers cover now, moved so it begins at 0,0
      if (f) for (const l of E.layers) if (l.x != null) { l.x -= f.x; l.y -= f.y; }
      E.size = f ? { w: f.w, h: f.h } : { w: 1024, h: 1024 };
    }
    editorChanged();
  });
  const bg = h('input', { type: 'color', value: E.bg });
  bg.addEventListener('input', () => { E.bg = bg.value; persistEditor(); drawEditorCanvas(); });
  return section('Canvas', null,
    field('Size', sizeSeg),
    E.size ? h('div', { class: 'row' },
      editorNum('Width', E.size.w, (v) => { E.size.w = v; }, { min: 64, max: 8192, step: 8 }),
      editorNum('Height', E.size.h, (v) => { E.size.h = v; }, { min: 64, max: 8192, step: 8 })) : null,
    field('Background', bg),
    field('Arrange layers', seg([['row', 'Side by side'], ['column', 'Stacked'], ['grid', 'Grid']], null,
      (m) => { arrangeLayers(m); renderEditor(); }, { action: true, disabled: !E.layers.length })),
    h('div', { class: 'row' },
      editorNum('Grid columns', E.cols, (v) => { E.cols = v; }, { min: 1, max: 12 }),
      editorNum('Gap (px)', E.gap, (v) => { E.gap = v; }, { min: 0, max: 400 })),
    mpInput(() => E.mp, (n) => { E.mp = n; persistEditor(); }),
    h('div', { class: 'row' },
      button('Save as input', saveEditor, { cls: 'primary' }),
      button('Download', downloadEditor, { cls: '' })));
}

function addEditorImages() {
  openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => {
    E.layers.push({ name, crop: { ...FULL }, scale: 1, hidden: false }); editorChanged();
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

async function downloadEditor() {
  const blob = await editorBlob();
  if (!blob) return toast('Add some images first', true);
  const a = h('a', { href: URL.createObjectURL(blob), download: `comfydeck_${Date.now()}.png` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

wireEditor();
