// Pictures dropped anywhere in the app, from a file window or another browser window. Places with their own drop (an
// open picture picker, the Video tab's timeline, the 3D view) take theirs first. Otherwise a picture goes to the slot
// under it; if it missed one, to the open tab's first empty slot; on the Image tab, in as a layer; else to this project's pictures.
import { $, sheetOpen, toast } from './ui.js';
import { uploadImage } from './media.js';
import { draggingPicture, dropKind, droppedFiles } from './drop-files.js';

const SLOTS = new WeakMap();

// el takes dropped pictures. give(name) sets it; mp(): the size to upload at; empty: true fills it when a drop misses
// every slot (leave it out for a slot that shouldn't fill by itself).
export function pictureSlot(el, { give, mp = () => 0, empty = false }) {
  el.classList.add('picture-slot');
  SLOTS.set(el, { el, give, mp, empty });
  return el;
}

const slotAt = (target) => {
  const el = target?.closest?.('.picture-slot');
  return el && !(sheetOpen() && !el.closest('#sheet')) ? SLOTS.get(el) : null;
};
// the open tab's first empty slot that can be seen, not one used already by this drop
const nextEmpty = (used) => [...document.querySelectorAll('.tab.active .picture-slot')].map((el) => SLOTS.get(el))
  .find((s) => s?.empty && !used.has(s.el) && s.el.getClientRects().length);

async function take(dt, hit) {
  const got = droppedFiles(dt);
  let files;
  try { files = (await got).filter((f) => dropKind(f) === 'image'); }
  catch (e) { return toast(e.message, true); }
  if (!files.length) return toast('Drop a picture (PNG, JPG, WebP…)', true);
  const modal = sheetOpen(), used = new Set();
  let first = hit, filled = 0, layers = 0, saved = 0;
  for (const f of files) {
    const to = first || (modal ? null : nextEmpty(used));
    first = null;
    try {
      const r = await uploadImage(f, { mp: to?.mp() || 0 });
      if (to) { used.add(to.el); to.give(r.name); filled++; }
      else if (!modal && $('#tab-editor').classList.contains('active')) { await (await import('./editor.js')).addToEditor(r.name); layers++; }
      else saved++;
    } catch (e) { return toast(`Upload failed: ${e.message}`, true); }
  }
  if (saved) toast(saved === 1 ? 'Saved to this project\'s pictures' : `Saved ${saved} pictures to this project's`);
  else if (filled && !layers) toast(filled === 1 ? 'Picture added' : `Added ${filled} pictures`);
}

const wanted = (e) => !e.defaultPrevented && draggingPicture(e.dataTransfer)
  && ([...e.dataTransfer.types].includes('Files') || !e.target.closest?.('input, textarea, [contenteditable="true"]'));

let over = null;
const mark = (el) => { if (el !== over) { over?.classList.remove('drop-here'); el?.classList.add('drop-here'); over = el; } };
const done = () => { document.body.classList.remove('picture-drag'); mark(null); };

document.addEventListener('dragover', (e) => {
  if (!wanted(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('picture-drag');
  mark(slotAt(e.target)?.el || null);
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) done(); });
document.addEventListener('dragend', done);
document.addEventListener('drop', (e) => {
  done();
  if (!wanted(e)) return;
  e.preventDefault();   // (or the browser leaves the app to show the picture)
  take(e.dataTransfer, slotAt(e.target));
});
