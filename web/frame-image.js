// Image frames on the table: going live mounts the editor (editor.js mountEditor) in the frame at 1:1, with its panel in
// the sidebar's Layers pane; coming back draws the still, saves and puts the editor back where it was. The frame's
// document is an edit tab (edit-tabs), opened through the Image tab's one TabSet. Frames dropped on an image frame
// become layers in it, each as its still; so do pictures dropped on it from the Shelf or a picker (sources).
//
// table.js's events (detail.handled = true when taken here): table:live, table:unlive, table:resize, table:drop-frame.
import { $, h, api, toast } from './ui.js';
import { CURRENT_EDIT, S } from './core.js';
import { E, editTabs, editorStill, editorStillBlob, mountEditor, persistEditor, renderEditor, unmountEditor } from './editor.js';
import { uploadImage } from './media.js';
import { draggingPicture, droppedFiles, dropKind } from './drop-files.js';
import { isLive } from './live.js';
import { sidebar } from './sidebar.js';
import { frameChanged, refreshStills, tableFrames } from './table.js';
import { editDoc, sourcePicture } from './table-frames.js';

const F = { seq: 0, mounted: null };   // mounted: the id of the frame the editor is in
const eng = () => CURRENT_EDIT.eng;
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');

// ---- live ----
addEventListener('table:live', (e) => {
  const { frame, root } = e.detail;
  if (frame.kind !== 'image') return;
  e.detail.handled = true;
  live(frame, root);
});

async function live(frame, root) {
  const seq = ++F.seq;
  root.replaceChildren(h('div', { class: 'frame-loading', role: 'status' }, 'Opening…'));
  if (!frame.doc) { root.replaceChildren(h('div', { class: 'frame-loading' }, 'This frame has no document')); return; }
  const t = editTabs();
  try {
    await t.ready();
    await t.switchTo(frame.doc);   // (it says itself when it couldn't: a conflict on the edit being left, a missing document)
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
        if (F.mounted !== frame.id) return;
        eng().addImage(r.name, { label: f.name.replace(/\.\w+$/, '') });
      } catch (err) { return toast(`Upload failed: ${err.message}`, true); }
    }
    renderEditor();
  });
}

// The frame's size is the edit's canvas: a size set on the table (Size and MP, the handles) is taken when it opens
function applySize(frame) {
  const s = E.size;
  if (s && s.w === frame.w && s.h === frame.h) return;
  E.size = { w: frame.w, h: frame.h }; E.sizeShape = null;
  persistEditor(); renderEditor();
}
addEventListener('table:resize', (e) => {
  const { frame } = e.detail;
  if (frame.kind !== 'image' || F.mounted !== frame.id) return;
  e.detail.handled = true;
  applySize(frame);
});

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail;
  if (frame.kind !== 'image') return;
  F.seq++;
  if (F.mounted !== frame.id) return;
  e.detail.handled = true;
  F.mounted = null;
  // a canvas size changed in the editor while open: the frame takes it
  const s = E.size, resized = s && (s.w !== frame.w || s.h !== frame.h);
  if (resized) Object.assign(frame, { w: s.w, h: s.h });
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
async function drawOffscreen(doc) {
  if (isLive('image')) { STALE.add(doc); return false; }
  const t = editTabs();
  await t.ready(); await t.switchTo(doc);
  if (t.active?.id !== doc || isLive('image')) return false;
  await settledStill();
  return true;
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
  const layers = [];
  const centred = (name, label, w, hh) => ({ name, label, x: Math.round((onto.w - (w || onto.w)) / 2), y: Math.round((onto.h - (hh || onto.h)) / 2) });
  for (const f of pics) {
    let blob = null;
    try { blob = await stillBlob(f); } catch (err) { toast(err.message, true); continue; }
    if (!blob) { toast(`"${f.label}" has no picture yet`, true); continue; }
    const r = await uploadImage(blob, { source: 'edit-tab', filename: 'edit.png' });
    layers.push(centred(r.name, f.label || null, r.width, r.height));
  }
  for (const src of sources) {
    let p = null;
    try { p = await sourcePicture(src); } catch (err) { toast(err.message, true); continue; }
    if (!p) { toast('Only a picture can go into an image frame', true); continue; }
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
    await putLayers(onto, layers);
    // its still is drawn by the editor: open the edit there (off screen) and draw it once the pictures are in (or later)
    try { await drawOffscreen(onto.doc); } catch (err) { console.warn(err); }
  }
  refreshStills(['image']);
  toast(layers.length === 1 ? `Added a layer to "${onto.label}"` : `Added ${layers.length} layers to "${onto.label}"`);
}

// the layers appended to the saved edit (table-frames.js editDoc: at its rev, once more if another save moved it)
function putLayers(onto, layers) {
  return editDoc('image', onto.doc, (p) => {
    p.layers = [...(p.layers || []), ...layers.map((l) => ({ name: l.name, crop: { x: 0, y: 0, w: 1, h: 1 }, x: l.x, y: l.y, scale: 1, opacity: 1, hidden: false,
      blend: 'normal', locked: false, label: l.label, key: Math.random().toString(36).slice(2, 10) }))];
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
