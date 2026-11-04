// Pictures dropped anywhere in the app, from a file window or another browser window. Places with their own drop (an
// open picture picker, the Video tab's timeline, the 3D view) take theirs first. Otherwise a picture goes to the slot
// under it; if it missed one, to the open tab's first empty slot; on the table (its sidebar, a pane), into the live
// frame or the one selected frame (table.js dropOntoFrame); on the Image tab, in as a layer; else to this project's
// pictures. Text dropped on a note on the table goes into its words.
import { $, h, sheetOpen, toast } from './ui.js';
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
      else if (!modal && await intoFrame(r.name)) layers++;
      else if (!modal && $('#tab-editor')?.classList.contains('active')) { await (await import('./editor.js')).addToEditor(r.name); layers++; }
      else saved++;
    } catch (e) { return toast(`Upload failed: ${e.message}`, true); }
  }
  if (saved) toast(saved === 1 ? 'Saved to this project\'s pictures' : `Saved ${saved} pictures to this project's`);
  else if (layers && !filled && $('#tab-table')?.classList.contains('active')) toast(layers === 1 ? 'Picture added to the frame' : `Added ${layers} pictures to the frame`);
  else if (filled && !layers) toast(filled === 1 ? 'Picture added' : `Added ${filled} pictures`);
}

// the table on screen: the live frame, else the one selected frame (not a note) takes the picture as a drop
async function intoFrame(name) {
  if (!$('#tab-table')?.classList.contains('active')) return false;
  const [Table, { liveFrame }] = await Promise.all([import('./table.js'), import('./live.js')]);
  const sel = Table.selectedFrames() || [];
  const f = liveFrame() || (sel.length === 1 ? sel[0] : null);
  return !!f && Table.dropOntoFrame(f, [{ input: name }]);
}

// Text dropped on a note frame (not on its words, where the browser puts it already): added to the end of them
const noteAt = (e) => (e.target.closest?.('textarea') ? null : e.target.closest?.('.frame.frame-note'));
const textOnly = (dt) => { const t = [...(dt?.types || [])]; return t.includes('text/plain') && !t.includes('Files'); };
document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || !textOnly(e.dataTransfer) || !noteAt(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (e) => {
  const n = !e.defaultPrevented && textOnly(e.dataTransfer) ? noteAt(e) : null;
  const ta = n?.querySelector('textarea.frame-text'), text = n ? e.dataTransfer.getData('text/plain') : '';
  if (!ta || !text) return;
  e.preventDefault();
  ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${text}` : text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

const wanted = (e) => !e.defaultPrevented && draggingPicture(e.dataTransfer)
  && ([...e.dataTransfer.types].includes('Files') || !e.target.closest?.('input, textarea, [contenteditable="true"]'));

let over = null;
const mark = (el) => { if (el !== over) { over?.classList.remove('drop-here'); el?.classList.add('drop-here'); over = el; } };
const done = () => { document.body.classList.remove('picture-drag'); mark(null); };

// A picture dragged by pointer from inside the app, a layer say (from: the element it starts on; thumb(): what follows the
// pointer once it has left that). move(x, y): the slot under it, if any. end(x, y): the slot it was let go on; no x, or no slot: null.
export function pictureDrag(from, thumb) {
  let ghost = null;
  const finish = () => { ghost?.remove(); ghost = null; document.body.classList.remove('slot-drag'); mark(null); };
  const under = (x, y) => document.elementFromPoint(x, y);
  return {
    move(x, y) {
      const el = under(x, y), away = !from.contains(el);
      document.body.classList.toggle('slot-drag', away);
      if (away && !ghost) document.body.append(ghost = h('div', { class: 'picture-ghost' }, thumb()));
      if (ghost) { ghost.hidden = !away; ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`; }
      const slot = slotAt(el);
      mark(slot?.el || null);
      return slot;
    },
    end(x, y) {
      finish();
      return x == null ? null : slotAt(under(x, y));
    },
  };
}

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
