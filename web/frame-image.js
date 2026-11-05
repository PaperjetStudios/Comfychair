// Image frames on the table: going live mounts the editor (editor.js mountEditor) in the frame at 1:1, with its panel in
// the sidebar's Layers pane; coming back draws the still, saves and puts the editor back where it was. The frame's
// document is an edit tab (edit-tabs), opened through the Image tab's one TabSet. Frames dropped on an image frame
// become layers in it, each as its still; so do pictures dropped on it from the Shelf or a picker (sources).
//
// table.js's events (detail.handled = true when taken here): table:live, table:unlive, table:frame-field, table:drop-frame.
//
// A frame's size is fixed, or fitted to its layers (frame.fit === true: the editor's Canvas → Fit layers, E.size null).
// A fitted frame's w/h are the area its layers covered when it was last open (frame.fitBox: { x, y, w, h } in the edit's
// own pixels), so its tile has their shape and the Make panel their size. A frame without `fit` is fixed, as before.
// Choosing Fit layers in the open editor fits the frame on coming back; a size set on the table (the handles, Size and
// MP, the MP box, undo) makes it fixed; the Frame pane's Fit layers / Fixed size sets it either way.
import { outputOf, tileShape } from './table-model.js';
import { $, h, api, toast, field, help, seg } from './ui.js';
import { CURRENT_EDIT, S } from './core.js';
import { E, editTabs, editorFrame, editorStill, editorStillBlob, editorToFixed, mountEditor, persistEditor, renderEditor, unmountEditor } from './editor.js';
import { uploadImage } from './media.js';
import { draggingPicture, droppedFiles, dropKind } from './drop-files.js';
import { isLive } from './live.js';
import { sidebar } from './sidebar.js';
import { frameChanged, refreshStills, selectedFrames, tableFrames, frameById } from './table.js';
import { dropInput, editDoc, sourcePicture } from './table-frames.js';

const F = { seq: 0, mounted: null };   // mounted: the id of the frame the editor is in
const eng = () => CURRENT_EDIT.eng;
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');

// ---- live ----
addEventListener('table:live', (e) => {
  const { frame, root } = e.detail;
  if (frame.kind !== 'image') return;
  e.detail.handled = true;
  if (fitResized(frame)) { toFixed(frame); queueMicrotask(frameChanged); }   // (an output size set since)
  live(frame, root);
});

async function live(frame, root) {
  const seq = ++F.seq;
  root.replaceChildren(h('div', { class: 'frame-loading', role: 'status' }, 'Opening…'));
  if (!frame.doc) { root.replaceChildren(h('div', { class: 'frame-loading' }, 'This frame has no document')); return; }
  const t = editTabs();
  try {
    await t.ready();
    await t.openQuiet(frame.doc);   // (it says itself when it couldn't: a conflict on the edit being left, a missing document)
  } catch (err) { toast(err.message, true); }
  // (switchTo drops out quietly when another switch came after it: only mount if this frame is still the one, and its edit the one open)
  if (seq !== F.seq || !isLive(frame.id)) return;
  if (t.active?.id !== frame.doc) { root.replaceChildren(h('div', { class: 'frame-loading' }, 'Couldn\'t open this frame\'s edit')); return; }
  root.replaceChildren();
  wireDrop(root, frame);
  mountEditor({ host: root, active: () => isLive(frame.id) });
  F.mounted = frame.id;
  sidebar.pane('layers', { title: 'Layers', icon: 'rows', host: true }).append($('#editorPanel'));   // (mountEditor put the panel beside the stage; it belongs in the sidebar)
  applySize(frame);
  sidebar.refresh();
}

// Pictures dropped from the computer onto the live frame: layers in it (picture-drop.js only knows the Image tab's
// editor, and leaves a drop already taken alone)
function wireDrop(root, frame) {
  root.addEventListener('dragover', (e) => { if (draggingPicture(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  root.addEventListener('drop', async (e) => {
    if (!draggingPicture(e.dataTransfer) || !isLive(frame.id)) return;
    e.preventDefault();
    let files;
    try { files = (await droppedFiles(e.dataTransfer)).filter((f) => dropKind(f) === 'image'); } catch (err) { return toast(err.message, true); }
    if (!files.length) return toast('Drop a picture (PNG, JPG, WebP…)', true);
    for (const f of files) {
      try {
        const r = await uploadImage(f);
        if (F.mounted !== frame.id) { dropInput(r.name); return; }   // (the frame was let go meanwhile: nothing has it)
        eng().addImage(r.name, { label: f.name.replace(/\.\w+$/, '') });
      } catch (err) { return toast(`Upload failed: ${err.message}`, true); }
    }
    renderEditor();
  });
}

// The frame's output size is the edit's canvas. (Its size on the table is only its preview.)
// A fitted frame leaves the editor fitting its layers (an animation keeps a fixed canvas: the frame turns fixed).
function applySize(frame) {
  if (frame.fit === true && E.anim) { toFixed(frame); queueMicrotask(frameChanged); }
  if (frame.fit === true) {
    if (!E.size) return;
    E.size = null; E.sizeShape = null;
  } else {
    const s = E.size, o = outputOf(frame);
    if (s && s.w === o.w && s.h === o.h) return;
    if (!s) editorToFixed();   // (from fitting its layers: they stay where they show, the canvas's corner on theirs)
    E.size = o; E.sizeShape = null;
  }
  persistEditor(); renderEditor();
}
// the output size was set (a set size is fixed from now on): the open edit at once, a closed one in its document, so its runs read it now
addEventListener('table:frame-field', (e) => {
  const { frame, keys } = e.detail || {};
  if (frame?.kind !== 'image' || !keys?.includes('out')) return;
  const box = frame.fitBox;
  if (frame.fit === true) toFixed(frame);
  if (F.mounted === frame.id) { applySize(frame); return; }
  if (frame.doc) fixDoc(frame, box).catch((err) => toast(err.message, true));
});
// the open edit's canvas size was changed in its own panel: the frame's output size follows
addEventListener('editor:size', () => {
  const f = F.mounted != null && frameById(F.mounted);
  if (f && takeSize(f)) frameChanged();
});
// a closed frame's edit takes its output size as a fixed canvas; its layers stay where they show (box: where it was fitted)
async function fixDoc(f, box) {
  const o = outputOf(f);
  if (editTabs()?.active?.id === f.doc) {   // (the Image tab has its edit, off screen)
    if (!E.size) editorToFixed();
    E.size = o; E.sizeShape = null;
    persistEditor();
    return;
  }
  await editDoc('image', f.doc, (p) => {
    if (!p.size && box && (box.x || box.y)) for (const l of p.layers || []) {
      if (l.x == null) continue;
      l.x -= box.x; l.y -= box.y;
      for (const k of l.chans?.x || []) k.v -= box.x;
      for (const k of l.chans?.y || []) k.v -= box.y;
    }
    p.size = o;
  });
}

const fitResized = (f) => { const o = outputOf(f); return f.fit === true && !!f.fitBox && (f.fitBox.w !== o.w || f.fitBox.h !== o.h); };
function toFixed(f) { f.fit = false; delete f.fitBox; }
// what the open editor shows for the frame now: its size, and fitted or not (on coming back, and for the Frame pane)
function takeSize(frame) {
  const sig = () => JSON.stringify([outputOf(frame), frame.fit, frame.fitBox]), was = sig();
  const setOut = (o) => { frame.out = { w: o.w, h: o.h }; Object.assign(frame, tileShape(frame, frame.out)); };
  if (E.size) { toFixed(frame); setOut(E.size); }
  else {
    frame.fit = true;
    const r = editorFrame();
    if (r) { frame.fitBox = { x: r.x, y: r.y, w: r.w, h: r.h }; setOut(r); }
  }
  const moved = sig() !== was;
  if (moved) dispatchEvent(new CustomEvent('table:output', { detail: { frame } }));
  return moved;
}

// The Frame pane's Fit layers / Fixed size, for an image frame (the pane is table.js's: this part is added each time it
// is drawn). Open: the editor follows at once, and the frame takes its shape on coming back. Not open: its edit is
// changed where it is saved, and drawn off screen for its new shape (later, when another image frame is open).
sidebar.addTo('output', (el) => {
  const sel = selectedFrames() || [], f = sel.length === 1 ? sel[0] : null;
  const ok = f && f.kind === 'image' && f.doc;
  if (ok && fitResized(f)) { toFixed(f); queueMicrotask(frameChanged); }
  const fit = ok ? (F.mounted === f.id ? !E.size : f.fit === true) : null;
  const had = el.querySelector('.frame-fit-field');
  if (had && ok && had.dataset.frame === f.id && had.dataset.fit === String(fit)) return;   // (already there: its own insert calls this again)
  had?.remove();
  if (!ok) return;
  const at = el.querySelector('.output-size');
  if (!at) return;
  const row = field('Picture size', seg([['fit', 'Fit layers'], ['fixed', 'Fixed size']], fit ? 'fit' : 'fixed', (v) => setFit(f, v === 'fit')),
    help('Fit layers: the output is just big enough for its layers. Fixed size: the output is the size above; picking a size makes it fixed.'));
  row.classList.add('frame-fit-field'); row.dataset.frame = f.id; row.dataset.fit = String(fit);
  at.after(row);
});

async function setFit(f, on) {
  if (F.mounted === f.id) {
    if (on && E.anim) { toast('An animation keeps a fixed canvas', true); frameChanged(); return; }
    if (on) { E.size = null; E.sizeShape = null; } else if (!E.size) editorToFixed();
    persistEditor(); renderEditor();
    f.fit = on; if (!on) delete f.fitBox;   // (its output follows when it is let go: takeSize)
    frameChanged();
    return;
  }
  if (on === (f.fit === true)) return;
  const box = f.fitBox;
  f.fit = on; if (!on) delete f.fitBox;
  frameChanged();
  try {
    const t = editTabs();
    if (t?.active?.id === f.doc) {   // (the Image tab has its edit, off screen)
      if (on && E.anim) throw new Error('An animation keeps a fixed canvas');
      if (on) { E.size = null; E.sizeShape = null; } else if (!E.size) editorToFixed();
      if (!on) E.size = outputOf(f);
      persistEditor();
    } else {
      await editDoc('image', f.doc, (p) => {
        if (on && p.anim) throw new Error('An animation keeps a fixed canvas');
        if (on) { p.size = null; return; }
        if (!p.size && box && (box.x || box.y)) for (const l of p.layers || []) {   // (as Canvas → Fixed size: the layers stay where they show)
          if (l.x == null) continue;
          l.x -= box.x; l.y -= box.y;
          for (const k of l.chans?.x || []) k.v -= box.x;
          for (const k of l.chans?.y || []) k.v -= box.y;
        }
        p.size = outputOf(f);
      });
    }
    // its shape: the edit drawn off screen, then the area its layers cover (the frame keeps its size while one is open)
    if (on && (await drawOffscreen(f.doc)) && !E.size && t?.active?.id === f.doc && f.fit === true) {
      if (takeSize(f)) frameChanged();
    }
  } catch (err) {
    toast(err.message, true);
    f.fit = !on; if (!on && box) f.fitBox = box;
    frameChanged();
  }
  refreshStills(['image']);
}

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail;
  if (frame.kind !== 'image') return;
  F.seq++;
  if (F.mounted !== frame.id) return;
  e.detail.handled = true;
  F.mounted = null;
  // a canvas size changed in the editor while open, or Fit layers picked: the frame takes it
  const resized = takeSize(frame);
  const still = editorStill();   // (the composite is drawn at once, before anything moves; the upload follows)
  unmountEditor();
  if (resized) queueMicrotask(frameChanged);
  e.detail.wait?.push((async () => {   // (the table waits for the save before trashing the edit)
    try { await editTabs().leave(); } catch (err) { console.warn(err); }
    await still.catch(() => {});
    refreshStills(['image']);
    drawStale();
  })());
});

// ---- frames dropped on an image frame: each one's picture as a layer ----
addEventListener('table:drop-frame', (e) => {
  const { from = [], sources = [], onto } = e.detail;
  if (onto.kind !== 'image' || !onto.doc) return;
  const pics = from.filter((f) => f.kind === 'image' && f.doc && f.id !== onto.id);
  if (!pics.length && !sources.length) return;
  e.detail.handled = true;
  dropInto(onto, pics, sources).catch((err) => toast(`Couldn't add the layers: ${err.message}`, true));
});

// a frame's picture: its edit's still (the open edit's composite now, if that's the one: its still may be behind)
async function stillBlob(f) {
  if (editTabs()?.active?.id === f.doc) return editorStillBlob();
  const d = await api(`/api/store/edit-tabs/${f.doc}${qs()}`, { busy: false });
  if (d.still?.url) return (await fetch(d.still.url)).blob();
  // never opened, so never drawn (a frame made from a dropped picture): the editor opens it off screen, draws it and keeps its still
  if (!d.payload?.layers?.length) return null;
  if (isLive('image')) throw new Error(`"${f.label}" has no picture yet: open it once, or leave the open image frame first`);
  if (!(await drawOffscreen(f.doc))) return null;
  return editorStillBlob();
}

// An edit opened in the editor off screen, drawn once its pictures load, and its still kept. Never while an image frame
// is live: that would take the editor from under it; the edit is drawn once the live frame lets go (drawStale).
const STALE = new Set();   // edits whose still is behind, to draw when no image frame is live
// (exported: imagetools.js lands a result in a closed frame's edit this way, frame-source.js reads one at full size)
export async function drawOffscreen(doc) {
  if (isLive('image')) { STALE.add(doc); return false; }
  const t = editTabs();
  await t.ready(); await t.openQuiet(doc);
  if (t.active?.id !== doc || isLive('image')) return false;
  await settledStill();
  return t.active?.id === doc;   // (the Image screen shown meanwhile takes its own tab back: tabs.js reclaim)
}
async function drawStale() {
  for (const doc of [...STALE]) {
    if (isLive('image')) return;
    STALE.delete(doc);
    try { await drawOffscreen(doc); } catch (err) { console.warn(err); }
  }
  refreshStills(['image']);
}

// sources: pictures from the Shelf, a picker or the computer (table-frames.js sourcePicture), each a layer as it is
async function dropInto(onto, pics, sources = []) {
  const layers = [], fresh = [];   // fresh: pictures uploaded here, deleted again when the edit can't be saved with them
  const centred = (name, label, w, hh) => ({ name, label, x: Math.round((onto.w - (w || onto.w)) / 2), y: Math.round((onto.h - (hh || onto.h)) / 2) });
  for (const f of pics) {
    let blob = null;
    try { blob = await stillBlob(f); } catch (err) { toast(err.message, true); continue; }
    if (!blob) { toast(`"${f.label}" has no picture yet`, true); continue; }
    const r = await uploadImage(blob, { source: 'edit-tab', filename: 'edit.png' });
    fresh.push(r.name);
    layers.push(centred(r.name, f.label || null, r.width, r.height));
  }
  for (const src of sources) {
    let p = null;
    try { p = await sourcePicture(src); } catch (err) { toast(err.message, true); continue; }
    if (!p) { toast('Only a picture can go into an image frame', true); continue; }
    if (p.fresh) fresh.push(p.name);
    layers.push(centred(p.name, p.label || null, p.width, p.height));
  }
  if (!layers.length) return;
  const t = editTabs();
  if (isLive(onto.id) || t?.active?.id === onto.doc) {
    // the editor has this edit: the layers go in through it (its TabSet saves, its still follows)
    for (const l of layers) eng().addImage(l.name, { label: l.label, x: l.x, y: l.y });
    renderEditor();
    if (!isLive(onto.id)) await settledStill();
  } else {
    try { await putLayers(onto, layers); } catch (err) { dropInput(fresh); throw err; }
    // its still is drawn by the editor: open the edit there (off screen) and draw it once the pictures are in (or later)
    try { await drawOffscreen(onto.doc); } catch (err) { console.warn(err); }
  }
  refreshStills(['image']);
  toast(layers.length === 1 ? `Added a layer to "${onto.label}"` : `Added ${layers.length} layers to "${onto.label}"`);
}

// The layers appended to the saved edit (table-frames.js editDoc: at its rev, once more if another save moved it).
// onto: a frame, or { doc }. Each layer: { name, label, x, y } and any of a layer's own fields (scale, rotation, crop…),
// as the editor's addImage takes them. out: the edit's export scale at least this (an upscale's result). Exported for
// imagetools.js (a tool's result landing in a closed frame).
export function putLayers(onto, layers, { out = 0 } = {}) {
  return editDoc('image', onto.doc, (p) => {
    p.layers = [...(p.layers || []), ...layers.map(({ name, label, x, y, ...rest }) => ({ crop: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, opacity: 1, hidden: false,
      blend: 'normal', locked: false, ...rest, name, x, y, label, key: Math.random().toString(36).slice(2, 10) }))];
    if (out > (p.out || 1)) p.out = out;
  });
}

// the still once the editor's pictures have loaded (up to ~10 s)
async function settledStill() {
  for (let i = 0; i < 40 && eng()?.loading(); i++) await new Promise((r) => setTimeout(r, 250));
  await editorStill();
}

// A deleted frame's Make-panel pictures (frame.make.inputs: copies the panel made in the project's pictures) go with it.
// Undo brings the frame back but not these (they are copies, not the user's own pictures; the frame's Make settings
// then show them missing, and its inputs list is emptied so nothing tries to drop them twice). A picture another frame
// on this table still lists stays (Ctrl+D copies a frame's make settings). Pictures a character uses are refused by the
// server and stay too.
addEventListener('table:deleted', (e) => {
  const left = new Set(tableFrames().flatMap((f) => f.make?.inputs || []));
  for (const f of e.detail?.frames || []) {
    const names = f.make?.inputs;
    if (!Array.isArray(names) || !names.length) continue;
    f.make = { ...f.make, inputs: [] };
    for (const n of names) {
      if (left.has(n)) continue;
      api(`/api/inputs?name=${encodeURIComponent(n)}`, { method: 'DELETE', busy: false }).catch(() => {});
    }
  }
});
