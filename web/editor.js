import { layerListPart } from './float-layers.js';
import { maskFloatPart } from './float-mask.js';
import { $, h, store, api, toast, openOverlay, button, iconBtn, seg, numSlider } from './ui.js';
import { ASPECT_PRESETS, CURRENT_EDIT, S, inputUrl, switchTab } from './core.js';
import { registerPickerSource, uploadImage } from './media.js';
import { TabSet } from './tabs.js';
import { SWATCHES } from './paint.js';
import { BLANK, createEditor } from './editor-engine.js';
import { landOwed } from './imagetools.js';
import { putStill } from './table-frames.js';
import { registerUndo } from './undo-dock.js';
import { isLive, liveFrame } from './live.js';
import { liveMain, setMain } from './frame-main.js';
import { registerProps, propsChanged } from './props-panel.js';

export { ASPECTS, FULL, aspectCrop, cropSpan, openCrop } from './editor-engine.js';

// ---------------------------------------------------------------------------
// sketch pad: draw an image (e.g. the source for image-to-image) with a pen or finger.
// Pen pressure sets the stroke width. Once a pen touches the canvas, finger touches are ignored
// (palm rejection) until "Pen only" is switched off.
// ---------------------------------------------------------------------------
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
  const sizeIn = numSlider({ min: 1, max: 120, step: 1, value: st.size, label: 'Brush size' });
  const setSize = () => { st.size = Number(sizeIn.value); sizeVal.textContent = `${st.size}px`; store.set('deck.sketch.size', st.size); };
  sizeIn.addEventListener('input', setSize); sizeIn.addEventListener('change', setSize);
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
// The Editor tab: the editor engine (editor-engine.js) on the tab's canvas, with its edit tabs, each a saved
// composition, and a still of each kept beside it for the pickers.
// ---------------------------------------------------------------------------
const SEEDED = 'deck.editor.seeded';   // set once a tab has loaded: the old single-editor state then lives in the tabs
let tabs = null;
registerUndo('editor', { undo: () => ED.paint?.undo(), redo: () => ED.paint?.redo() });   // (the painting's history: undo-dock.js)
// The elements the editor lives in. createEditor reads cfg.canvas once (and cfg.panel at every render), so it can't be re-pointed:
// mountEditor moves the page's own stage (viewer + canvas + size + anim bar) and panel into another host instead.
const ED_EL = { host: $('#tab-editor'), canvas: $('#editorCanvas'), empty: $('#editorEmpty'), size: $('#editorSize'), anim: $('#editorAnim'), panel: $('#editorPanel'),
  stage: $('#tab-editor .editor-stage'), active: null };
const ED_HOME = ED_EL.host;
const edTab = () => { try { return ED.E.tab?.id ?? null; } catch { return null; } };   // (null while createEditor is still running)
const ED = createEditor({
  canvas: ED_EL.canvas, empty: ED_EL.empty, size: ED_EL.size, anim: ED_EL.anim, panel: ED_EL.panel,
  initial: store.get(SEEDED, false) ? {} : store.get('deck.editor', {}),
  active: () => (ED_EL.active ? ED_EL.active() : ED_EL.host.classList.contains('active')),
  onChange: () => { tabs.changed(); stillSoon(); },   // the tab saves itself shortly and its still follows (a deleted main source stays pinned: mainOf finds nothing until Undo brings it back)
  // the live table frame's main source (frame-main.js): { id: the pinned layer's key } | null off the table
  main: () => liveMain('image', edTab()),
  setMain: (key) => { const m = liveMain('image', edTab()); if (m) setMain(m.frame.id, key).catch((e) => toast(e.message, true)); },
  name: () => tabs?.active?.name,
  beforeRender: () => { if (!tabs.started) tabs.start(); if (isLive('image')) { propsChanged('image'); dispatchEvent(new CustomEvent('editor:render')); } },   // (the Properties pane follows the picked layers; the Edit pane's Inpaint, Extend and mask rows too)
  newEdit: (payload) => (isLive('image') ? newFrameFrom(payload) : tabs.createFrom(payload, 'layers')),
  panelParts: (ed) => h('div', { class: 'panel-body' }, ed.topRow(),
    // (a mask being painted: its section first, with what to see and do; otherwise the panel order, app-wide. The list may be in its floating panel.
    // On the table the red mask is the floating Mask panel's (float-mask.js), Inpaint and Extend are tools of the Edit pane, and the canvas is in the Properties pane; the Image tab keeps them here.)
    layerListPart('image', ed.layerList()), isLive('image') ? maskFloatPart(ed) : null, ed.E.sel?.maskOf ? ed.layerProps() : null, ed.paintProps(),
    isLive('image') ? null : ed.masksProps(), isLive('image') ? null : ed.inpaintProps(), ed.E.sel?.maskOf ? null : ed.layerProps(), ed.animProps(), isLive('image') ? null : ed.canvasProps(), ed.exportProps()),
});
addEventListener('layers:float', () => { if (ED_EL.host !== ED_HOME) ED.render(); });
export const { E } = ED;
// On the table, the picked layers' X, Y, Scale, Rotation and Opacity are the sidebar's Properties pane's (web/props-panel.js)
registerProps('image', {
  when: () => !!ED.onTable(),
  picked: () => ED.picked().filter((l) => !l.maskOf && ED.ready(l)).map((l) => ({ flat: ED.plain(l), layer: l })),
  title: (ctx, list) => (list.length > 1 ? `${list.length} layers` : list[0].layer.label || list[0].layer.name?.split('/').pop() || 'Canvas'),
  rows: () => ED.propRows(),
  extra: () => (ED.onTable() ? ED.canvasProps() : null),   // (the edit's canvas, whatever is picked)
});
// a pin set or cleared elsewhere (the Make pane's unpin, the table's undo): the layer rows show it
addEventListener('table:frame-field', (e) => { if (e.detail?.keys?.includes('main') && e.detail.frame?.doc === E.tab?.id) ED.render(); });
// Mount the editor into `els.host` (stage first, panel after), and `els.active()` says when it takes keys. The TabSet keeps its host.
export function mountEditor(els) {
  ED_EL.host = els.host; ED_EL.active = els.active || null;
  els.host.append(ED_EL.stage, ED_EL.panel);
  ED.render();
}
// Back into the page's Image tab, as it was.
export function unmountEditor() {
  ED_EL.host = ED_HOME; ED_EL.active = null;
  ED_HOME.prepend(ED_EL.stage); ED_HOME.append(ED_EL.panel);
  ED.render();
}
export const persistEditor = () => ED.changed();
export const renderEditor = () => ED.render();
// The picture's area: { x, y, w, h } of the fixed canvas, or around its visible layers when it fits them (null: none yet)
export const editorFrame = () => ED.frame();
// Fit layers → a fixed canvas the size they fill now, the layers moved so they stay where they show (Canvas → Fixed size)
export const editorToFixed = () => ED.toFixed();
export const editTabs = () => tabs;

// Inside a live image frame, "Move to new edit" / "Open in a new edit": a new image frame beside it holding those layers
// (the engine stays on the live frame's edit). Resolves true once made, false when it couldn't be (said why).
async function newFrameFrom(payload) {
  const src = liveFrame();
  try {
    const tf = await import('./table-frames.js');
    const f = await tf.resultFrame(src, { label: `${src.label || 'Image'} layers` });
    if (!f?.doc) throw new Error('the new frame couldn\'t be made');
    await tf.editDoc('image', f.doc, (p) => { Object.assign(p, payload); });
    const fi = await import('./frame-image.js');
    fi.drawOffscreen(f.doc).catch(() => {});   // (an image frame is live: its still is drawn once that lets go)
    return true;
  } catch (e) { toast(`Couldn't make a new frame: ${e.message}`, true); return false; }
}

tabs = new TabSet({ kind: 'edit-tabs', host: $('#tab-editor'), newName: (n) => `Edit ${n}`, seed: () => (store.get(SEEDED, false) ? null : ED.dump()),
  adapter: {
    empty: BLANK,
    dump: () => ED.dump(),
    beforeLeave: () => ED.paint.savePaint(),   // painted layers get their files (and the tab their names) before it's left
    load(payload, doc, { remote = false } = {}) {
      if (E.tab?.id !== doc.id) stillNow(); else clearTimeout(stillTimer);   // a tab being left gets its still now (the draw is synchronous)
      stillDue = false;
      ED.load(payload, { id: doc.id ?? null, remote });   // (another document, or this one saved elsewhere: a fresh undo history)
      E.tab = doc.id ? { id: doc.id, qs: tabs.qs } : null;   // (no id: tabs.js resetting the engine when no document is open)
      store.set(SEEDED, true);
      if (doc.id && !doc.still && E.layers.length) stillSoon();
      renderEditor();
      landOwed(ED);   // (runs that finished, or are still going, since this edit was last open here)
    },
  } });

// Resolves once a tab is open (or after ~8 s, e.g. offline), so other panels can write into the current tab
// without the first load replacing their change.
export const editorTabsReady = () => tabs.ready();
// A new Image tab, as the strip's ＋ makes one: shows the Editor, opens and selects it. Resolves true once it is the
// open tab, false when it couldn't be made (left unsaved, offline: the strip has said why).
export async function newEditTab() {
  switchTab('editor');   // (its panel, with the strip, is drawn there)
  await tabs.ready();
  const was = E.tab?.id;
  await tabs.create();
  return !!E.tab && E.tab.id !== was;
}

// ---- the still: a picture of the composite, kept beside the tab so pickers can show it ----
const STILL_DELAY = 4000, STILL_MAX = 2048;
let stillTimer = 0, stillDue = false;
function stillSoon() {
  stillDue = true; clearTimeout(stillTimer);
  stillTimer = setTimeout(stillNow, STILL_DELAY);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && stillDue) stillNow(); });
// The composite, shrunk to STILL_MAX: { has, cv }. (Synchronous, so the state can't change under it.)
function stillCanvas() {
  let cv = document.createElement('canvas');
  const has = ED.compose(cv);
  if (has && Math.max(cv.width, cv.height) > STILL_MAX) {
    const k = STILL_MAX / Math.max(cv.width, cv.height), small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(cv.width * k)); small.height = Math.max(1, Math.round(cv.height * k));
    const c2 = small.getContext('2d'); c2.imageSmoothingQuality = 'high'; c2.drawImage(cv, 0, 0, small.width, small.height);
    cv = small;
  }
  return { has, cv };
}
// The composite as a PNG Blob without uploading (null when there is nothing to show).
export function editorStillBlob() {
  const { has, cv } = stillCanvas();
  return has ? new Promise((res) => cv.toBlob(res, 'image/png')) : Promise.resolve(null);
}
// Draw now and upload, even if the timer hasn't fired.
export async function editorStill() { stillDue = true; await stillNow(); }
// Draw now (synchronously, so the state can't change under it), then encode and upload. Never blocks editing.
async function stillNow() {
  clearTimeout(stillTimer);
  const tab = E.tab;
  if (!stillDue || !tab) return;
  if (ED.loading()) { stillTimer = setTimeout(stillNow, 1000); return; }   // images still loading
  stillDue = false;
  const { has, cv } = stillCanvas();
  try {   // (table-frames.js putStill: null deletes the still, the table's stills follow)
    const blob = has ? await new Promise((res) => cv.toBlob(res, 'image/png')) : null;
    await putStill('image', tab.id, blob);
  } catch { stillDue = true; }   // offline: the next edit tries again
}

CURRENT_EDIT.eng = ED;   // (the picker's Current edit button)

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

// Another panel's picture as a new layer in the open edit tab (the VFX tab's first frame, say)
export async function addToEditor(name) {
  await editorTabsReady();
  ED.addImage(name);
  switchTab('editor');
  toast('Added to the Image tab: Save as input when done');
}

export async function useInGenerate(...args) { return (await import('./generate.js')).useInGenerate(...args); }
