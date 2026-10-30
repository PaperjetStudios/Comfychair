import { $, h, store, api, toast, openOverlay, button, iconBtn, seg, numSlider } from './ui.js';
import { ASPECT_PRESETS, CURRENT_EDIT, S, inputUrl, switchTab } from './core.js';
import { registerPickerSource, uploadImage } from './media.js';
import { TabSet } from './tabs.js';
import { SWATCHES } from './paint.js';
import { BLANK, createEditor } from './editor-engine.js';
import { registerUndo } from './undo-dock.js';

export { ASPECTS, FULL, aspectCrop, cropSpan, openCrop, useInGenerate } from './editor-engine.js';

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
const tabMount = h('div', { class: 'editor-tabs' });
let tabs = null;
registerUndo('editor', { undo: () => ED.paint?.undo(), redo: () => ED.paint?.redo() });   // (the painting's history: undo-dock.js)
const ED = createEditor({
  canvas: $('#editorCanvas'), empty: $('#editorEmpty'), size: $('#editorSize'), anim: $('#editorAnim'), panel: $('#editorPanel'),
  initial: store.get(SEEDED, false) ? {} : store.get('deck.editor', {}),
  active: () => $('#tab-editor').classList.contains('active'),
  onChange: () => { tabs.changed(); stillSoon(); },   // the tab saves itself shortly and its still follows
  name: () => tabs?.active?.name,
  beforeRender: () => { if (!tabs.started) tabs.start(); },
  panelParts: (ed) => h('div', { class: 'panel-body' }, tabMount, ed.topRow(),
    ed.layerList(), ed.paintProps(), ed.inpaintProps(), ed.layerProps(), ed.animProps(), ed.canvasProps(), ed.exportProps()),   // (the panel order, app-wide)
});
export const { E } = ED;
export const persistEditor = () => ED.changed();
export const renderEditor = () => ED.render();

tabs = new TabSet({ kind: 'edit-tabs', mount: tabMount, newName: (n) => `Edit ${n}`, seed: () => (store.get(SEEDED, false) ? null : ED.dump()),
  adapter: {
    empty: BLANK,
    dump: () => ED.dump(),
    beforeLeave: () => ED.paint.savePaint(),   // painted layers get their files (and the tab their names) before it's left
    load(payload, doc) {
      if (E.tab?.id !== doc.id) stillNow(); else clearTimeout(stillTimer);   // a tab being left gets its still now (the draw is synchronous)
      stillDue = false;
      ED.load(payload);
      E.tab = { id: doc.id, qs: tabs.qs };
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
  if (ED.loading()) { stillTimer = setTimeout(stillNow, 1000); return; }   // images still loading
  stillDue = false;
  let cv = document.createElement('canvas');
  const has = ED.compose(cv);
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
  toast('Added to the Editor: Save as input when done');
}
