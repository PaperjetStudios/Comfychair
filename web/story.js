import {
  $, h, store, uid, clone, api, toast, undoToast, button, iconBtn, seg, field, section, help, info, note, placeholder,
  fileButton, textArea, chip, icon, openSheet, closeSheet, actions, openOverlay,
} from './ui.js';
import { S, inputUrl, isMine, onServer, previewUrl, switchTab, thumbUrl } from './core.js';
import { ROLES, queueRun, roleField, template, valuesByRole } from './make.js';
import { clipUrl, openImagePicker, openVideoPicker, pickFrame, uploadImage } from './media.js';
import { renderFields, setVal } from './generate.js';
import { TabSet } from './tabs.js';
import { fullScreen } from './layout.js';
import { BLANK as COMP_BLANK, createEditor } from './editor-engine.js';
import { openCompare } from './compare.js';
import { addPicture as addCharPicture, castSection, characterById, characterSection, characters, mainPicture, mentionBox, onCharacters } from './characters.js';
import { castLines, mentioned, plain, speakerOf } from './cast.js';

// ---------------------------------------------------------------------------
// story: a storyboard for writing a story down and sorting it out. A story is a title, notes (free writing or a
// script) and scenes in order; a scene has a slug line, a summary and shots in order; a shot says what we see,
// the action or dialogue, how it's framed, how long it runs, how far along it is, and has frames (pictures).
// Four views of the same story: the canvas (the shot big, to draw and lay out its frame, with its scene's shots as a
// filmstrip under it), a board (cards with big frames, the classic storyboard), an outline (a list, for writing) and
// the script (a screenplay page). Tap a shot to edit it in the side panel; drag the grip (pen or finger) or use the
// arrows to reorder. The look-at-it-big view (lightbox) steps through every shot's frame, and compares two.
//
// A shot's frame is a composition (s.comp): the Editor's engine (editor-engine.js) mounted on the canvas view, with
// its layers (pictures, frames from clips, drawings, blank canvases), brushes, selections and crop. Its flattened
// picture is saved like a painted layer (/api/paint, named after its pixels) as s.canvas, and is the shot's frame
// unless one of its other frames (pictures made for it) is picked.
//
// Frames come from an image template run on the shot's description plus the story's style line (make.js queueRun),
// from pictures already here (the image picker) or from the device. A frame made for a shot lands on it when the run
// finishes: the run ids wait on the shot (pending) until then, so a reload or another tab picks them up too.
// A frame can go on to Generate, VFX or the Editor, and "Shots to video" lays the chosen frames on the Video tab's
// timeline in order, each for its shot's length.
// ---------------------------------------------------------------------------

const SIZES = [['wide', 'Wide', 'wide shot'], ['medium', 'Medium', 'medium shot'], ['close', 'Close', 'close-up'], ['ecu', 'Extreme close', 'extreme close-up']];
const ANGLES = [['eye', 'Eye level', 'eye level'], ['low', 'Low', 'low angle'], ['high', 'High', 'high angle'], ['over', 'Overhead', 'overhead shot'],
  ['dutch', 'Dutch', 'dutch angle'], ['pov', 'POV', 'point of view shot'], ['ots', 'Over shoulder', 'over-the-shoulder shot']];
const MOVES = [['static', 'Static'], ['pan', 'Pan'], ['tilt', 'Tilt'], ['push', 'Push in'], ['pull', 'Pull back'], ['track', 'Track'],
  ['handheld', 'Handheld'], ['crane', 'Crane'], ['zoom', 'Zoom']];
const DURS = [1, 2, 3, 4, 5, 6, 8, 10];
const STATUS = [['idea', 'Idea'], ['drafted', 'Drafted'], ['made', 'Made']];
const ASPECTS = [['16:9', 16 / 9], ['2.39:1', 2.39], ['4:3', 4 / 3], ['1:1', 1], ['9:16', 9 / 16]];
const AREA = 1024 * 1024;   // frames are about a megapixel, whatever their shape

// a template's width / height / batch fields (by input name: the Size group isn't called Width)
const ROLE = {
  ...ROLES,
  width: (f) => f.kind === 'int' && f.input === 'width',
  height: (f) => f.kind === 'int' && f.input === 'height',
  batchSize: (f) => f.kind === 'int' && f.input === 'batch_size',
};

const newShot = (o = {}) => ({ id: uid(), what: '', action: '', size: '', angle: '', move: '', dur: 3, status: 'idea', frames: [], pick: null, pending: [], comp: null, canvas: null, ...o });
const newScene = (o = {}) => ({ id: uid(), slug: '', summary: '', collapsed: false, shots: [newShot()], ...o });
const BLANK = () => ({ title: '', notes: '', style: '', aspect: '16:9', tpl: null, batch: 1, scenes: [newScene()] });
let P = BLANK();
const VIEWS = [['canvas', 'canvas', 'Canvas'], ['board', 'board', 'Board'], ['outline', 'list', 'Outline'], ['script', 'text', 'Script']];
const U = { sel: null, doc: null, char: null, view: store.get('deck.story.view', 'canvas') };
if (!VIEWS.some(([v]) => v === U.view)) U.view = 'canvas';

let tabs = null, tabsReady = null;
const ensureTabs = () => tabsReady || (tabsReady = tabs ? tabs.start() : Promise.resolve());
const persist = () => tabs?.changed();
const shown = () => $('#tab-story')?.classList.contains('active');

// ---- the story's parts ----
function locate(id) {
  for (const [si, sc] of P.scenes.entries()) {
    const i = sc.shots.findIndex((s) => s.id === id);
    if (i >= 0) return { sc, si, s: sc.shots[i], i };
  }
  return null;
}
const allShots = () => P.scenes.flatMap((sc) => sc.shots);
const ratio = () => (ASPECTS.find(([k]) => k === P.aspect) || ASPECTS[0])[1];
const secs = (shots) => shots.reduce((t, s) => t + (+s.dur || 0), 0);
const fmtSecs = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t} s`);
// the canvas's flattened picture as a frame; the chosen frame is the canvas unless another frame is picked
const canvasFrame = (s) => (s.canvas ? { id: 'canvas', input: s.canvas.name, canvas: true } : null);
const chosen = (s) => (s.pick === 'canvas' ? canvasFrame(s) : null) || s.frames.find((f) => f.id === s.pick) || canvasFrame(s) || s.frames[0] || null;
const framesOf = (s) => [canvasFrame(s), ...s.frames].filter(Boolean);
const frameThumb = (f, px = 480) => (f.input ? thumbUrl(f.input, px) : previewUrl(f.url, px));
const frameUrl = (f) => (f.input ? inputUrl(f.input) : f.url);
const isPaint = (name) => /\/paint\/[0-9a-f]+\.png$/.test(name || '');
const label3 = (list, v) => list.find(([k]) => k === v)?.[1] || '';
const camText = (s) => [label3(SIZES, s.size), label3(ANGLES, s.angle), label3(MOVES, s.move)].filter(Boolean).join(' · ');

// ---- editing ----
// structural edits redraw both sides; typing only saves (a redraw would take the cursor away)
function changed() { persist(); renderStage(); renderPanel(); }

// A text box (or one-line input) bound to obj[key]. Every box bound to the same thing follows as you type (a shot's
// description shows in its row, its card and the panel), and [data-show] spans take the text.
// mention: @Name suggestions under it (characters.js); the wrapper comes back, its box as .ta
function bound(obj, key, { rows = 1, placeholder = '', label = null, line = false, cls = '', mention = false } = {}) {
  const tag = `${obj.id || 'story'}.${key}`;
  const sync = (el) => {
    for (const o of document.querySelectorAll(`[data-bind="${tag}"]`)) if (o !== el && o.value !== obj[key]) { o.value = obj[key]; o.dispatchEvent(new Event('grow')); }
    for (const o of document.querySelectorAll(`[data-show="${tag}"]`)) o.textContent = obj[key] || o.dataset.empty || '';
  };
  let el;
  if (line) {
    el = h('input', { type: 'text', value: obj[key] || '', placeholder, 'aria-label': label || placeholder, class: cls });
    el.addEventListener('input', () => { obj[key] = el.value; persist(); sync(el); });
  } else {
    el = textArea(() => obj[key], (v) => { obj[key] = v; persist(); sync(el); }, { rows, placeholder, label: label || placeholder, max: 600 });
    if (cls) el.className = cls;
  }
  el.dataset.bind = tag;
  if (mention) { const w = mentionBox(el); w.ta = el; return w; }
  return el;
}

function addScene(after = null) {
  const sc = newScene();
  const at = after ? P.scenes.indexOf(after) + 1 : P.scenes.length;
  P.scenes.splice(at, 0, sc);
  U.sel = sc.shots[0].id;
  changed();
  requestAnimationFrame(() => $(`#storyStage [data-id="${sc.id}"] .st-slug`)?.focus());
}
function addShot(sc, after = null) {
  const s = newShot(after ? { size: after.size, angle: after.angle, dur: after.dur } : {});
  sc.collapsed = false;
  sc.shots.splice(after ? sc.shots.indexOf(after) + 1 : sc.shots.length, 0, s);
  U.sel = s.id;
  changed();
  requestAnimationFrame(() => $(`#storyStage [data-id="${s.id}"] textarea`)?.focus());
}
// up / down one place; past the end of its scene it moves on into the next (or back into the one before)
function moveShot(id, d) {
  const at = locate(id);
  if (!at) return;
  const { sc, si, s, i } = at, j = i + d;
  sc.shots.splice(i, 1);
  if (j >= 0 && j <= sc.shots.length) sc.shots.splice(j, 0, s);
  else if (P.scenes[si + d]) { const n = P.scenes[si + d]; n.collapsed = false; if (d < 0) n.shots.push(s); else n.shots.unshift(s); }
  else { sc.shots.splice(i, 0, s); return; }   // the very first or last shot: nowhere to go
  changed();
}
function moveScene(sc, d) {
  const i = P.scenes.indexOf(sc), j = i + d;
  if (j < 0 || j >= P.scenes.length) return;
  P.scenes.splice(i, 1); P.scenes.splice(j, 0, sc);
  changed();
}
const copyShot = (s) => {
  const c = clone(s);
  c.id = uid(); c.pending = [];
  c.frames = c.frames.map((f) => ({ ...f, id: uid(), was: f.id }));
  c.pick = c.frames.find((f) => f.was === s.pick)?.id || null;
  c.frames.forEach((f) => delete f.was);
  return c;
};
function duplicateShot(id) {
  const at = locate(id);
  if (!at) return;
  const c = copyShot(at.s);
  at.sc.shots.splice(at.i + 1, 0, c);
  U.sel = c.id;
  changed();
}
function duplicateScene(sc) {
  const c = { ...clone(sc), id: uid(), shots: sc.shots.map(copyShot) };
  P.scenes.splice(P.scenes.indexOf(sc) + 1, 0, c);
  changed();
}
// deleting keeps a copy of the scenes, for Undo (on this same tab only)
function withUndo(msg, fn) {
  const was = clone(P.scenes), tab = tabs?.active?.id;
  fn();
  changed();
  undoToast(msg, () => {
    if (tabs?.active?.id !== tab) return toast('That was on another story tab', true);
    P.scenes = was; changed();
  });
}
function deleteShot(id) {
  const at = locate(id);
  if (!at) return;
  withUndo(`Deleted shot ${at.si + 1}.${at.i + 1}`, () => {
    at.sc.shots.splice(at.i, 1);
    if (U.sel === id) U.sel = at.sc.shots[Math.min(at.i, at.sc.shots.length - 1)]?.id || null;
  });
}
function deleteScene(sc) {
  const i = P.scenes.indexOf(sc);
  withUndo(`Deleted scene ${i + 1}${sc.slug ? ` (${sc.slug})` : ''}`, () => {
    P.scenes.splice(i, 1);
    if (!P.scenes.length) P.scenes.push(newScene());
    if (!locate(U.sel)) U.sel = null;
  });
}
function select(id) {
  U.sel = id;
  if (U.view === 'canvas' && id) { openShot(id); renderStage(); renderPanel(); return; }
  for (const el of document.querySelectorAll('#storyStage [data-kind="shot"]')) el.classList.toggle('sel', el.dataset.id === U.sel);
  renderPanel();
}
// the shot before or after the selected one, across scenes
function step(d) {
  const list = allShots(), i = list.findIndex((s) => s.id === U.sel);
  const n = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + d))];
  if (n && n.id !== U.sel) select(n.id);
}

// ---- frames ----
const storyTemplates = () => S.templates.filter((t) => !t.error && t.media === 'image' && roleField(t, 'prompt', ROLE)
  && roleField(t, 'width', ROLE) && roleField(t, 'height', ROLE) && !t.fields.some((f) => f.kind === 'image' || f.kind === 'video'));
// the story's template: its pick if that's still installed, else the first text-to-image one
const storyTemplate = () => { const ts = storyTemplates(); return ts.find((t) => t.id === P.tpl) || ts[0] || null; };
// width × height for the story's shape at about a megapixel, on 64s, inside what the template's fields allow
function frameSize(t) {
  const r = ratio(), fit = (f, v) => Math.min(f?.max ?? 1e5, Math.max(f?.min ?? 64, v));
  return [fit(roleField(t, 'width', ROLE), Math.round(Math.sqrt(AREA * r) / 64) * 64), fit(roleField(t, 'height', ROLE), Math.round(Math.sqrt(AREA / r) / 64) * 64)];
}
// the prompt: framing, what we see, then the story's style
const promptOf = (s) => [[[SIZES.find(([k]) => k === s.size)?.[2], ANGLES.find(([k]) => k === s.angle)?.[2]].filter(Boolean).join(', '),
  plain(s.what.trim(), characters()), P.style.trim()].filter(Boolean).join(', '), ...castLines(castOf(s))].join('\n');
// the characters a shot brings in: named in what we see or the action, or speaking
const castOf = (s) => mentioned(`${s.what}\n${s.action}`, characters());

async function makeFrame(s) {
  const t = storyTemplate();
  if (!t) return toast('No text-to-image template is installed', true);
  if (!s.what.trim()) return toast('Write what we see first', true);
  const [w, hh] = frameSize(t);
  const values = valuesByRole(t, { prompt: promptOf(s), seed: -1, width: w, height: hh, batchSize: 1 }, ROLE);
  try {
    const gens = await queueRun({ template: t.id, values, batch: P.batch });
    s.pending.push(...gens.map((g) => g.id));
    changed();
    toast(gens.length > 1 ? `Making ${gens.length} frames (#${gens[0].id}…)` : `Making a frame (#${gens[0].id})`);
  } catch (e) { toast(e.message, true); }
}

// a run for a shot ended: its pictures become frames (once), and the run stops waiting on it
function settle(s, g) {
  s.pending = s.pending.filter((id) => id !== g.id);
  if (g.status === 'done') {
    const have = new Set(s.frames.filter((f) => f.gen === g.id).map((f) => f.index));
    const fresh = g.outputs.map((o, index) => ({ o, index })).filter(({ o, index }) => o.kind === 'image' && !have.has(index))
      .map(({ o, index }) => ({ id: uid(), gen: g.id, index, url: o.url }));
    s.frames.push(...fresh);
    if (fresh.length && !s.frames.some((f) => f.id === s.pick)) s.pick = fresh[0].id;
    if (fresh.length && s.status === 'idea') s.status = 'drafted';
  }
}
const pendingShot = (gid) => allShots().find((s) => s.pending.includes(gid));
// runs that ended while this story wasn't open (or on another device): look them up once it is
async function catchUp() {
  const tab = tabs?.active?.id, ids = allShots().flatMap((s) => s.pending);
  if (!ids.length) return;
  let any = false;
  for (const id of ids) {
    let g = S.history.get(id);
    if (!g || !['done', 'error', 'interrupted'].includes(g.status)) {
      try { g = await api(`/api/generations/${id}`, { busy: false }); } catch (e) { g = /not found/i.test(e.message) ? { id, status: 'gone', outputs: [] } : null; }
    }
    if (tabs?.active?.id !== tab) return;
    const s = pendingShot(id);
    if (g && s && ['done', 'error', 'interrupted', 'gone'].includes(g.status)) { settle(s, g); any = true; }
  }
  if (any) changed();
}

function addFrames(s, names) {
  const fresh = names.map((name) => ({ id: uid(), input: name }));
  s.frames.push(...fresh);
  if (fresh.length && !s.frames.some((f) => f.id === s.pick)) s.pick = fresh[0].id;
  if (s.status === 'idea') s.status = 'drafted';
  changed();
}
function pickFrames(s) {
  openImagePicker({ title: 'Add frames', multi: true, mp: () => 0, onPick: (name) => addFrames(s, [name]) });
}
async function uploadFrames(s, files) {
  const names = [];
  for (const f of files) {
    try { names.push((await uploadImage(f, { source: 'upload' })).name); } catch (e) { toast(`Upload failed: ${e.message}`, true); }
  }
  if (names.length) addFrames(s, names);
}
function removeFrame(s, f) {
  withUndo('Removed the frame', () => {
    s.frames = s.frames.filter((x) => x !== f);
    if (s.pick === f.id) s.pick = s.frames[0]?.id || null;
  });
}

// a frame as a picture in ComfyUI's input folder, which is what the image fields elsewhere take
// (a painted picture lives only here, out of ComfyUI: it goes up as an input the first time it's needed)
const UPLOADED = new Map();   // paint file -> its input name
async function frameInput(f, { mp = 0, multiple = 1 } = {}) {
  if (f.input && isPaint(f.input)) {
    if (!UPLOADED.has(f.input)) {
      const blob = await (await fetch(inputUrl(f.input))).blob();
      UPLOADED.set(f.input, (await uploadImage(blob, { mp, source: 'story', filename: 'shot.png' })).name);
    }
    return UPLOADED.get(f.input);
  }
  if (f.input) return f.input;
  const r = await api(`/api/generations/${f.gen}/to-input`, { method: 'POST', body: { index: f.index, frame: 'first', mp, multiple }, busy: 'Preparing the picture…' });
  return r.name;
}
async function toGenerate(f, label) {
  const fs = (S.tpl?.fields || []).filter((x) => x.kind === 'image');
  if (!fs.length) return toast(`${S.tpl?.name || 'The template'} in Generate takes no picture: pick one there that does (an edit or image-to-video), then send it again`, true);
  const put = async (fl) => {
    try {
      setVal(fl.key, await frameInput(f, { mp: S.imageMp[fl.key] ?? 1, multiple: 16 }));
      renderFields(); switchTab('generate');
      toast(`${label} set as ${fl.group} · ${fl.label}`);
    } catch (e) { toast(e.message, true); }
  };
  if (fs.length === 1) return put(fs[0]);
  openSheet(h('h3', {}, `Send ${label} to Generate as…`), h('div', { class: 'row wrap use-as' },
    fs.map((fl) => button(`${fl.group} · ${fl.label}`, () => { closeSheet(); put(fl); }, { cls: '' }))));
}
async function toVfx(f, label) {
  try { await (await import('./vfx.js')).useInVfx('first', await frameInput(f), { label }); } catch (e) { toast(e.message, true); }
}
async function toEditor(f) {
  try { const name = await frameInput(f); switchTab('editor'); await (await import('./editor.js')).addToEditor(name); } catch (e) { toast(e.message, true); }
}

// ---- the shot canvas: the Editor's engine on the canvas view, one composition per shot ----
// CV.shot is the shot whose composition the engine holds. Every edit writes it back to the shot (s.comp); its picture
// is drawn and saved a moment after the last one (and before another shot, story or project is opened).
const CV = { viewer: null, canvas: null, empty: null, eng: null, shot: null, timer: 0, seq: 0, drawing: null };
const RENDER_DELAY = 1500, RENDER_MAX = 2048;
// a new canvas: the story's shape at about a megapixel, white
const compSize = () => { const r = ratio(); return { w: Math.round(Math.sqrt(AREA * r) / 8) * 8, h: Math.round(Math.sqrt(AREA / r) / 8) * 8 }; };
const blankComp = () => ({ ...COMP_BLANK(), size: compSize(), bg: '#ffffff' });

function compChanged() {
  const at = locate(CV.shot);
  if (!at) return;
  at.s.comp = CV.eng.dump();
  persist();
  clearTimeout(CV.timer);
  CV.timer = setTimeout(renderCanvas, RENDER_DELAY);
}
// the composition flattened and saved as the shot's canvas picture (s.canvas), which becomes its frame
async function renderCanvas() {
  clearTimeout(CV.timer);
  while (CV.drawing) await CV.drawing;
  const at = locate(CV.shot);
  if (!at || !at.s.comp) return;
  if (CV.eng.loading()) { CV.timer = setTimeout(renderCanvas, 800); return; }   // pictures still loading
  const s = at.s;
  let cv = document.createElement('canvas');
  if (!CV.eng.compose(cv)) {   // nothing left on it
    if (s.canvas) { s.canvas = null; if (s.pick === 'canvas') s.pick = s.frames[0]?.id || null; persist(); refreshThumbs(); }
    return;
  }
  if (Math.max(cv.width, cv.height) > RENDER_MAX) {
    const k = RENDER_MAX / Math.max(cv.width, cv.height), small = document.createElement('canvas');
    small.width = Math.round(cv.width * k); small.height = Math.round(cv.height * k);
    const c = small.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(cv, 0, 0, small.width, small.height);
    cv = small;
  }
  CV.drawing = (async () => {
    try {
      const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
      const r = await fetch('/api/paint', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { name, width, height } = await r.json();
      if (s.canvas?.name !== name || s.pick !== 'canvas') {
        s.canvas = { name, w: width, h: height }; s.pick = 'canvas';
        if (s.status === 'idea') s.status = 'drafted';
        persist(); refreshThumbs();
      }
    } catch { CV.timer = setTimeout(renderCanvas, 5000); }   // offline: try again
  })();
  try { await CV.drawing; } finally { CV.drawing = null; }
}
// the open shot's last strokes and picture, saved (before leaving it)
async function settleCanvas() {
  if (!CV.eng || !CV.shot) return;
  await CV.eng.paint.savePaint();
  if (CV.timer) await renderCanvas();
}

// put shot id's composition on the canvas (the one there is saved first)
async function openShot(id) {
  if (!CV.eng || CV.shot === id) return;
  const my = ++CV.seq;
  await settleCanvas();
  if (my !== CV.seq) return;   // another shot was asked for meanwhile
  CV.shot = id;
  const s = locate(id)?.s;
  CV.eng.load(s?.comp ? { ...s.comp, size: s.comp.size || compSize() } : blankComp());
  CV.eng.paint.reset();
  CV.eng.zoom.reset();
  drawEmpty();
  if (shown() && U.view === 'canvas') CV.eng.render();
}
const canvasShot = () => locate(CV.shot)?.s || null;

// a picture as a new layer: the first one covers the canvas, later ones go in the middle at their size or smaller
async function addPicture(name, { label = null, cover = null } = {}) {
  const s = canvasShot();
  if (!s) return;
  const E = CV.eng.E, f = E.size || compSize(), first = cover ?? !E.layers.length;
  if (!E.size) E.size = f;
  let o = {};
  if (first) {
    try {
      const img = new Image(); img.src = inputUrl(name); await img.decode();
      const k = Math.max(f.w / img.naturalWidth, f.h / img.naturalHeight);
      o = { x: Math.round((f.w - img.naturalWidth * k) / 2), y: Math.round((f.h - img.naturalHeight * k) / 2), scale: k };
    } catch { /* placed when it loads */ }
  }
  const l = CV.eng.addImage(name, { ...o, ...(label ? { label } : {}) });
  CV.eng.E.sel = l;
  CV.eng.render();
}
// draw over the shot's chosen frame: it goes on the canvas, with a see-through layer on top for the pen
async function drawOnFrame(s) {
  const f = chosen(s);
  if (!f) return startBlank();
  try {
    const name = await frameInput(f);
    await addPicture(name, { label: 'Frame', cover: true });
    CV.eng.paint.addBlank({ ...CV.eng.E.size, fill: null });
    CV.eng.paint.setTool('brush');
  } catch (e) { toast(e.message, true); }
}
// one of the shot's frames on its canvas, as a new layer covering it (a refined or generated picture to keep working on)
async function frameToCanvas(s, f) {
  if (U.view !== 'canvas') { U.view = 'canvas'; store.set('deck.story.view', 'canvas'); }
  U.sel = s.id;
  renderStage(); renderPanel();
  await openShot(s.id);
  try { await addPicture(await frameInput(f), { label: 'Frame', cover: true }); } catch (e) { toast(e.message, true); }
}
function startBlank() {
  if (!CV.eng.E.size) CV.eng.E.size = compSize();
  CV.eng.paint.setTool('brush');   // (an empty canvas gets a white layer to paint on)
}
function addPictures() {
  openImagePicker({ title: 'Add pictures to the shot', multi: true, mp: () => 0, onPick: (name) => addPicture(name) });
}
// any frame of any clip here (generated, imported or uploaded): scrub to it, it goes on the canvas
function frameFromVideo() {
  openVideoPicker({ title: 'Take a frame from a clip', onPick: async (v) => {
    const url = clipUrl(v);
    if (!url) return toast('That clip isn\'t loaded here yet', true);
    const blob = await pickFrame({ url, title: 'Pick the frame' });
    if (!blob) return;
    try { await addPicture((await uploadImage(blob, { source: 'story', filename: 'frame.png' })).name, { label: 'Clip frame' }); } catch (e) { toast(e.message, true); }
  } });
}

// what the canvas shows before anything is on it: the shot's frame (to draw over) or ways to start
function drawEmpty() {
  if (!CV.empty) return;
  const s = canvasShot(), f = s && chosen(s);
  CV.empty.replaceChildren(
    f ? h('img', { src: frameThumb(f, 1024), alt: '', class: 'st-cv-frame' }) : h('span', { class: 'st-noframe' }, icon('image')),
    s ? h('div', { class: 'row wrap st-cv-start' },
      f ? button([icon('brush'), 'Draw on this frame'], () => drawOnFrame(s), { cls: 'small primary' }) : null,
      button([icon('canvas'), 'Blank canvas'], startBlank, { cls: f ? 'small' : 'small primary' }),
      button([icon('image'), 'Add pictures'], addPictures),
      button([icon('film'), 'Frame from a clip'], frameFromVideo)) : h('span', {}, 'Tap a shot'));
}

function makeCanvas() {
  CV.canvas = h('canvas', { class: 'hidden', 'aria-label': 'The shot\'s canvas' });
  CV.empty = h('div', { class: 'placeholder st-cv-empty' });
  CV.viewer = h('div', { class: 'viewer st-cv-viewer' }, CV.canvas, CV.empty);
  CV.eng = createEditor({
    canvas: CV.canvas, empty: CV.empty, panel: $('#storyBody'),
    active: () => shown() && U.view === 'canvas',
    onChange: compChanged,
    docId: () => CV.shot,
    elsewhere: 'That was on another shot',
    name: () => { const at = locate(CV.shot); return at ? `Shot ${at.si + 1}.${at.i + 1}` : 'Shot'; },
    renderPanel: fillPanel,
  });
}

// ---- look at it big: one shot's frames full screen, stepping through the story; compare two ----
function openLightbox(id = U.sel) {
  const list = allShots().filter((s) => chosen(s));
  if (!list.length) return toast('No shot has a frame yet', true);
  let i = Math.max(0, list.findIndex((s) => s.id === id)), fi = null;
  const img = h('img', { alt: '' }), title = h('b', { class: 'cmp-title' }), what = h('p', { class: 'st-lb-what' });
  const strip = h('div', { class: 'st-lb-strip' });
  const num = (s) => { const at = locate(s.id); return at ? `${at.si + 1}.${at.i + 1}` : ''; };
  const draw = () => {
    const s = list[i], fs = framesOf(s), f = fs.find((x) => x.id === fi) || chosen(s);
    fi = f.id;
    img.src = frameUrl(f);
    const at = locate(s.id);
    title.textContent = `Shot ${num(s)}${at?.sc.slug ? ` · ${at.sc.slug}` : ''}  (${i + 1} of ${list.length})`;
    what.textContent = [s.what, s.action].filter((x) => x.trim()).join('  ·  ');
    strip.replaceChildren(...(fs.length > 1 ? fs.map((x) => h('button', { type: 'button', class: `st-lb-thumb${x.id === fi ? ' on' : ''}`, 'aria-label': x.canvas ? 'The canvas' : 'A frame',
      onclick: () => { fi = x.id; draw(); } }, h('img', { src: frameThumb(x, 160), alt: '' }), chosen(s) === x || chosen(s)?.id === x.id ? h('span', { class: 'st-frame-on' }, icon('check')) : null)) : []));
  };
  const go = (d) => { i = (i + d + list.length) % list.length; fi = null; draw(); };
  const compare = () => {
    const s = list[i], fs = framesOf(s), f = fs.find((x) => x.id === fi) || chosen(s);
    const other = f.id !== chosen(s).id ? { s, f: chosen(s), label: `${num(s)} chosen` } : list.length > 1 ? { s: list[(i + 1) % list.length], f: chosen(list[(i + 1) % list.length]) } : null;
    if (!other) return toast('Only one frame to look at', true);
    openCompare([{ o: { url: frameUrl(f), kind: 'image' }, label: `${num(s)}${f.canvas ? ' canvas' : ''}` },
      { o: { url: frameUrl(other.f), kind: 'image' }, label: other.label || num(other.s) }]);
  };
  const pick = () => { const s = list[i]; s.pick = fi; changed(); draw(); toast(`Shot ${num(s)}: frame chosen`); };
  const el = h('div', { class: 'cmp-view st-lightbox', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'cmp-top' }, title, h('span', { class: 'spacer' }),
      button([icon('check'), 'Choose'], pick, { title: 'Make this the shot\'s frame' }),
      button([icon('swap'), 'Compare'], compare, { title: 'This frame against the chosen one, or against the next shot' }),
      iconBtn('Close', icon('close'), () => close())),
    h('div', { class: 'st-lb-stage' }, img,
      iconBtn('Previous shot', icon('left'), () => go(-1), { class: 'icon-btn st-lb-prev' }),
      iconBtn('Next shot', icon('right'), () => go(1), { class: 'icon-btn st-lb-next' })),
    h('div', { class: 'cmp-bottom st-lb-bottom' }, what, strip));
  // a swipe sideways steps; arrows too
  let x0 = null;
  el.querySelector('.st-lb-stage').addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  el.querySelector('.st-lb-stage').addEventListener('pointerup', (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 60) go(e.clientX < x0 ? 1 : -1); x0 = null; });
  const key = (e) => { if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); else return; e.preventDefault(); };
  document.addEventListener('keydown', key);
  const close = openOverlay(el, { onClose: () => document.removeEventListener('keydown', key) });
  draw();
}

// ---- the whole story at once ----
async function shotsToVideo() {
  const list = [];
  P.scenes.forEach((sc, si) => sc.shots.forEach((s, i) => { const f = chosen(s); if (f) list.push({ s, f, n: `${si + 1}.${i + 1}`, sc }); }));
  if (!list.length) return toast('No shot has a frame yet', true);
  const missing = allShots().length - list.length;
  try {
    const { addToTimeline } = await import('./video.js');
    switchTab('video');
    for (const { s, f, n, sc } of list) {
      await addToTimeline({ kind: 'image', src: f.input ? { input: f.input } : { generation: f.gen, index: f.index }, url: frameUrl(f),
        thumb: frameThumb(f, 160), label: `${n}${sc.slug ? ` ${sc.slug}` : ''}`, len: +s.dur || 3 });
    }
    toast(`${list.length} shot${list.length === 1 ? '' : 's'} on the Video timeline (${fmtSecs(secs(list.map((x) => x.s)))})${missing ? `; ${missing} without a frame left out` : ''}`);
  } catch (e) { toast(e.message, true); }
}

function storyText() {
  const out = [];
  const title = P.title.trim() || tabs?.active?.name || 'Story';
  out.push(title.toUpperCase(), '');
  if (P.notes.trim()) out.push(P.notes.trim(), '');
  P.scenes.forEach((sc, si) => {
    out.push(`SCENE ${si + 1}${sc.slug.trim() ? `: ${sc.slug.trim()}` : ''}  (${fmtSecs(secs(sc.shots))})`);
    if (sc.summary.trim()) out.push(sc.summary.trim());
    sc.shots.forEach((s, i) => {
      const cam = camText(s);
      out.push(`  ${si + 1}.${i + 1}  [${[cam, `${s.dur} s`, label3(STATUS, s.status)].filter(Boolean).join(' · ')}] ${s.what.trim()}`);
      if (s.action.trim()) out.push(...s.action.trim().split('\n').map((l) => `        ${l}`));
    });
    out.push('');
  });
  return out.join('\n').trim() + '\n';
}
async function copyText() {
  const text = storyText();
  try { await navigator.clipboard.writeText(text); toast('The outline is on the clipboard'); return; } catch { /* not over HTTPS: show it to copy by hand */ }
  const ta = h('textarea', { rows: 14, readOnly: true, value: text, class: 'st-copy' });
  openSheet(h('h3', {}, 'Outline as text'), help('Select it and copy (the clipboard needs HTTPS).'), ta);
  setTimeout(() => { ta.focus(); ta.select(); }, 50);
}

// ---- drag to reorder: the grip lifts a row, card or scene (pen, finger or mouse) and it drops where it's let go ----
// Shots can go into another scene (onto its list, or onto a folded one's head). The stage scrolls near its edges.
function dragStart(e, kind, id) {
  if (e.button > 0) return;
  e.preventDefault(); e.stopPropagation();
  const stage = $('#storyStage'), el = e.currentTarget.closest(`[data-kind="${kind}"]`);
  if (!el) return;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  const ghost = el.cloneNode(true);
  ghost.classList.add('st-ghost');
  Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
  document.body.append(ghost);
  el.classList.add('st-lifted');
  const grid = kind === 'shot' && U.view === 'board';
  let at = null, x = e.clientX, y = e.clientY, raf = 0;
  const mark = (t) => {
    stage.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
    if (t) t.el.classList.add(t.where === 'into' ? 'drop-into' : `drop-${t.where}`);
  };
  const find = () => {
    const under = document.elementsFromPoint(x, y).filter((n) => stage.contains(n) && !n.closest('.st-lifted'));
    const item = under.map((n) => n.closest(`[data-kind="${kind}"]`)).find(Boolean);
    if (item) {
      const b = item.getBoundingClientRect();
      return { el: item, id: item.dataset.id, where: (grid ? x < b.left + b.width / 2 : y < b.top + b.height / 2) ? 'before' : 'after' };
    }
    if (kind === 'shot') {   // an empty list, the space after the last shot, or a folded scene's head: the end of that scene
      const sc = under.map((n) => n.closest('[data-kind="scene"]')).find(Boolean);
      if (sc) return { el: sc.querySelector('.st-shots') || sc, scene: sc.dataset.id, where: 'into' };
    }
    return null;
  };
  const tick = () => {
    const sr = stage.getBoundingClientRect(), edge = 48;
    if (y < sr.top + edge) stage.scrollTop -= Math.ceil((sr.top + edge - y) / 4);
    else if (y > sr.bottom - edge) stage.scrollTop += Math.ceil((y - sr.bottom + edge) / 4);
    at = find(); mark(at);
    raf = requestAnimationFrame(tick);
  };
  const move = (ev) => {
    x = ev.clientX; y = ev.clientY;
    ghost.style.left = `${x - dx}px`; ghost.style.top = `${y - dy}px`;
  };
  const up = (ev) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf); ghost.remove(); el.classList.remove('st-lifted'); mark(null);
    if (ev.type === 'pointercancel' || !at) return;
    if (kind === 'scene') {
      const from = P.scenes.findIndex((s) => s.id === id), sc = P.scenes[from];
      if (at.id === id) return;
      P.scenes.splice(from, 1);
      const to = P.scenes.findIndex((s) => s.id === at.id) + (at.where === 'after' ? 1 : 0);
      P.scenes.splice(to, 0, sc);
    } else {
      const src = locate(id);
      if (!src || at.id === id) return;
      src.sc.shots.splice(src.i, 1);
      if (at.where === 'into') {
        const sc = P.scenes.find((s) => s.id === at.scene);
        if (!sc) { src.sc.shots.splice(src.i, 0, src.s); return; }
        sc.shots.push(src.s); sc.collapsed = false;
      } else {
        const t = locate(at.id);
        t.sc.shots.splice(t.i + (at.where === 'after' ? 1 : 0), 0, src.s);
      }
    }
    changed();
  };
  addEventListener('pointermove', move, { passive: true });
  addEventListener('pointerup', up); addEventListener('pointercancel', up);
  raf = requestAnimationFrame(tick);
}
const grip = (kind, id) => h('span', { class: 'st-grip', role: 'button', 'aria-label': 'Drag to move', title: 'Drag to move',
  onpointerdown: (e) => dragStart(e, kind, id), onclick: (e) => e.stopPropagation() }, icon('grip'));

// ---- the stage: the outline or the board ----
const statusDot = (s) => h('span', { class: `st-status ${s.status}`, title: label3(STATUS, s.status) });
function thumbOf(s) {
  const f = chosen(s);
  if (f) return h('img', { src: frameThumb(f), alt: '', loading: 'lazy', draggable: false });
  if (s.pending.length) return h('span', { class: 'st-making' }, h('span', { class: 'st-spin' }), 'Making…');
  return h('span', { class: 'st-noframe' }, icon('image'));
}

function shotRow(sc, si, s, i) {
  return h('div', { class: `st-row${U.sel === s.id ? ' sel' : ''}`, 'data-kind': 'shot', 'data-id': s.id,
    onclick: (e) => { if (!e.target.closest('textarea, input, button, .st-grip')) select(s.id); } },
  grip('shot', s.id),
  h('span', { class: 'st-num' }, `${si + 1}.${i + 1}`),
  h('button', { type: 'button', class: 'st-thumb', style: `aspect-ratio:${ratio()}`, 'aria-label': `Shot ${si + 1}.${i + 1}: edit`, onclick: () => select(s.id) }, thumbOf(s)),
  h('div', { class: 'st-row-text' },
    (() => { const w = bound(s, 'what', { placeholder: 'What we see', label: `Shot ${si + 1}.${i + 1}: what we see`, mention: true }); w.ta.addEventListener('focus', () => { if (U.sel !== s.id) select(s.id); }); return w; })(),
    h('div', { class: 'st-row-meta' }, statusDot(s), h('span', {}, [camText(s), `${s.dur} s`, s.frames.length ? `${s.frames.length} frame${s.frames.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')))),
  h('div', { class: 'st-row-btns' }, iconBtn('Move up', icon('up'), () => moveShot(s.id, -1)), iconBtn('Move down', icon('down'), () => moveShot(s.id, 1))));
}

function shotCard(sc, si, s, i) {
  return h('div', { class: `st-card${U.sel === s.id ? ' sel' : ''}`, 'data-kind': 'shot', 'data-id': s.id, onclick: () => select(s.id) },
    h('div', { class: 'st-card-img', style: `aspect-ratio:${ratio()}` }, thumbOf(s),
      h('span', { class: 'st-card-num' }, `${si + 1}.${i + 1}`), grip('shot', s.id),
      s.frames.length > 1 ? h('span', { class: 'st-card-count' }, `${s.frames.length}`) : null),
    h('div', { class: 'st-card-text' },
      h('span', { class: 'st-what', 'data-show': `${s.id}.what`, 'data-empty': 'What we see…' }, s.what || 'What we see…'),
      h('span', { class: 'st-card-meta' }, statusDot(s), [camText(s), `${s.dur} s`].filter(Boolean).join(' · '))));
}

function sceneMenu(sc, si) {
  const go = (fn) => () => { closeSheet(); fn(); };
  openSheet(h('h3', {}, `Scene ${si + 1}${sc.slug ? ` · ${sc.slug}` : ''}`), h('div', { class: 'tab-menu' },
    button([icon('plus'), 'Add a shot'], go(() => addShot(sc)), { cls: 'ghost' }),
    button([icon('plus'), 'New scene after this'], go(() => addScene(sc)), { cls: 'ghost' }),
    button([icon('up'), 'Move up'], go(() => moveScene(sc, -1)), { cls: 'ghost', disabled: si === 0 }),
    button([icon('down'), 'Move down'], go(() => moveScene(sc, 1)), { cls: 'ghost', disabled: si === P.scenes.length - 1 }),
    button([icon('copy'), 'Duplicate'], go(() => duplicateScene(sc)), { cls: 'ghost' }),
    button([icon('trash'), 'Delete'], go(() => deleteScene(sc)), { cls: 'ghost danger' })));
}

function sceneEl(sc, si, board) {
  const fold = iconBtn(sc.collapsed ? 'Open the scene' : 'Fold the scene', icon('chevron'), () => { sc.collapsed = !sc.collapsed; changed(); }, { class: 'icon-btn st-fold' });
  return h('div', { class: `st-scene${sc.collapsed ? ' collapsed' : ''}`, 'data-kind': 'scene', 'data-id': sc.id },
    h('div', { class: 'st-scene-head' },
      grip('scene', sc.id), fold,
      h('span', { class: 'st-num st-scene-num' }, `${si + 1}`),
      bound(sc, 'slug', { line: true, placeholder: 'Scene heading, e.g. INT. KITCHEN - NIGHT', label: `Scene ${si + 1} heading`, cls: 'st-slug' }),
      h('span', { class: 'st-meta' }, `${sc.shots.length} shot${sc.shots.length === 1 ? '' : 's'} · ${fmtSecs(secs(sc.shots))}`),
      iconBtn('Add a shot', icon('plus'), () => addShot(sc)),
      iconBtn('Scene options', icon('more'), () => sceneMenu(sc, si))),
    sc.collapsed ? null : [
      bound(sc, 'summary', { placeholder: 'What happens in this scene', label: `Scene ${si + 1} summary`, cls: 'st-summary', mention: true }),
      h('div', { class: board ? 'st-shots st-cards' : 'st-shots st-rows' },
        sc.shots.map((s, i) => (board ? shotCard(sc, si, s, i) : shotRow(sc, si, s, i))),
        h('button', { type: 'button', class: board ? 'st-add-card' : 'st-add-row', onclick: () => addShot(sc, sc.shots[sc.shots.length - 1]) }, icon('plus'), 'Shot'))]);
}

// ---- the canvas view: the selected shot big, its scene's shots as a filmstrip under it ----
function canvasStage(st) {
  if (!U.sel || !locate(U.sel)) U.sel = allShots()[0]?.id || null;
  const at = locate(U.sel);
  if (at && CV.shot !== at.s.id) openShot(at.s.id);
  if (!at) return st.replaceChildren(placeholder('No shots yet'), h('div', { class: 'st-end' }, button([icon('plus'), 'Scene'], () => addScene(), { cls: 'small' })));
  const { sc, si, s, i } = at, list = allShots(), k = list.indexOf(s);
  const head = h('div', { class: 'st-cv-head' },
    h('span', { class: 'st-num st-scene-num' }, `${si + 1}.${i + 1}`),
    h('span', { class: 'st-cv-what', 'data-show': `${s.id}.what`, 'data-empty': 'What we see…' }, s.what || 'What we see…'),
    statusDot(s),
    iconBtn('Previous shot', icon('left'), () => step(-1), { disabled: k <= 0 }),
    iconBtn('Next shot', icon('right'), () => step(1), { disabled: k >= list.length - 1 }),
    iconBtn('Look at the frames big', icon('maximize'), () => openLightbox(s.id)));
  // the scene's shots; the arrows at the ends go to the scene before or after
  const tile = (x, j) => h('button', { type: 'button', class: `st-film-tile${x === s ? ' sel' : ''}`, 'data-id': x.id, 'aria-label': `Shot ${si + 1}.${j + 1}`,
    title: x.what || `Shot ${si + 1}.${j + 1}`, onclick: () => select(x.id) },
  h('span', { class: 'st-film-img', style: `aspect-ratio:${ratio()}` }, thumbOf(x)),
  h('span', { class: 'st-film-meta' }, statusDot(x), `${si + 1}.${j + 1}`, h('span', { class: 'st-film-dur' }, `${x.dur} s`)));
  const near = (d) => P.scenes[si + d]?.shots[0];
  const film = h('div', { class: 'st-film', role: 'list', 'aria-label': `Scene ${si + 1}'s shots` },
    h('div', { class: 'st-film-scene' },
      iconBtn('The scene before', icon('left'), () => { const n = P.scenes[si - 1]; if (n?.shots.length) select(n.shots[n.shots.length - 1].id); }, { disabled: !near(-1) }),
      h('span', { class: 'st-film-slug', title: sc.slug || `Scene ${si + 1}` }, h('b', {}, `${si + 1}`), ` ${sc.slug || 'Scene'}`),
      iconBtn('The scene after', icon('right'), () => select(near(1).id), { disabled: !near(1) })),
    sc.shots.map(tile),
    h('button', { type: 'button', class: 'st-film-add', onclick: () => addShot(sc, sc.shots[sc.shots.length - 1]), 'aria-label': 'A shot at the end of the scene' }, icon('plus')));
  drawEmpty();
  st.replaceChildren(head, CV.viewer, film);
  requestAnimationFrame(() => film.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
// only the pictures changed (a canvas was saved): the strip and cards follow, the panel too unless something in it is
// being typed in
function refreshThumbs() {
  if (!shown()) return;
  if (U.view !== 'outline' || !document.activeElement?.closest('#storyStage')) renderStage();
  if (!document.activeElement?.closest('#storyBody textarea, #storyBody input')) renderPanel();
}

// ---- the script view: a screenplay page (scene headings, action, the characters' lines) ----
// A shot's action / dialogue is read line by line: "NAME: words" (or "@Name: words") is a line of dialogue, a line in
// brackets on its own a parenthetical, anything else action.
// (a speaker in capitals, or a character's name in any case)
function scriptLines(text) {
  const out = [], cast = characters();
  for (const raw of (text || '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const m = speakerOf(l);
    if (m && m.text.trim() && (m.who === m.who.toUpperCase() || l.startsWith('@') || cast.some((c) => c.name.trim().toLowerCase() === m.who.toLowerCase()))) {
      out.push({ kind: 'line', who: m.who, paren: m.paren, text: plain(m.text, cast) });
    } else if (/^\(.*\)$/.test(l)) out.push({ kind: 'paren', text: l });
    else out.push({ kind: 'action', text: plain(l, cast) });
  }
  return out;
}
function scriptStage(st) {
  const page = h('div', { class: 'st-script' },
    h('h2', { class: 'st-sc-title' }, (P.title || tabs?.active?.name || 'Story').toUpperCase()),
    P.scenes.map((sc, si) => [
      h('h3', { class: 'st-sc-slug' }, `${si + 1}. ${(sc.slug || 'Scene').toUpperCase()}`),
      sc.summary.trim() ? h('p', { class: 'st-sc-action st-sc-summary' }, plain(sc.summary.trim(), characters())) : null,
      sc.shots.map((s, i) => h('div', { class: `st-sc-shot${U.sel === s.id ? ' sel' : ''}`, 'data-kind': 'shot', 'data-id': s.id, onclick: () => select(s.id) },
        h('span', { class: 'st-sc-num' }, `${si + 1}.${i + 1}`),
        s.what.trim() ? h('p', { class: 'st-sc-action' }, plain(s.what.trim(), characters())) : null,
        scriptLines(s.action).map((ln) => (ln.kind === 'line'
          ? h('div', { class: 'st-sc-line' }, h('p', { class: 'st-sc-who' }, ln.who.toUpperCase()),
            ln.paren ? h('p', { class: 'st-sc-paren' }, ln.paren) : null, h('p', { class: 'st-sc-words' }, ln.text))
          : h('p', { class: ln.kind === 'paren' ? 'st-sc-paren' : 'st-sc-action' }, ln.text))),
        !s.what.trim() && !s.action.trim() ? h('p', { class: 'st-sc-action st-sc-empty' }, 'Nothing written for this shot yet') : null))]));
  st.replaceChildren(page);
}

export function renderStage() {
  const st = $('#storyStage');
  if (!st) return;
  const board = U.view === 'board';
  st.classList.toggle('board', board);
  st.classList.toggle('canvas', U.view === 'canvas');
  st.classList.toggle('script', U.view === 'script');
  if (U.view === 'canvas') { canvasStage(st); renderBar(); return; }
  if (U.view === 'script') { scriptStage(st); renderBar(); return; }
  const head = board ? h('div', { class: 'st-head' }, h('b', { class: 'st-board-title', 'data-show': 'story.title', 'data-empty': tabs?.active?.name || 'Story' }, P.title || tabs?.active?.name || 'Story'))
    : h('div', { class: 'st-head' },
      bound(P, 'title', { line: true, placeholder: tabs?.active?.name || 'Title', label: 'Title', cls: 'st-title' }),
      bound(P, 'notes', { rows: 4, placeholder: 'Notes, ideas, the script: anything goes here', label: 'Notes', cls: 'st-notes', mention: true }));
  st.replaceChildren(head, ...P.scenes.map((sc, si) => sceneEl(sc, si, board)),
    h('div', { class: 'st-end' }, button([icon('plus'), 'Scene'], () => addScene(), { cls: 'small' })));
  renderBar();
}

// the bar's buttons: an icon and a word, just the icon on a phone (the word stays its name)
const barBtn = (ic, text, fn, title) => button([icon(ic), h('span', { class: 'st-bar-lbl' }, text)], fn, { title, 'aria-label': text });
function renderBar() {
  const bar = $('#storyBar');
  if (!bar) return;
  const n = allShots().length, framed = allShots().filter(chosen).length;
  bar.replaceChildren(
    seg(VIEWS.map(([v, ic, l]) => [v, [icon(ic), h('span', { class: 'st-bar-lbl' }, l)], l]), U.view, (v) => { U.view = v; store.set('deck.story.view', v); renderStage(); renderPanel(); }),
    barBtn('plus', 'Scene', () => addScene(), 'A new scene at the end'),
    barBtn('video', 'Shots to video', shotsToVideo, 'Every shot\'s chosen frame on the Video tab\'s timeline, in order, each for its length'),
    barBtn('copy', 'Copy as text', copyText, 'The outline as plain text'),
    h('span', { class: 'timecode' }, `${P.scenes.length} sc · ${n} shots · ${framed}/${n} framed · ${fmtSecs(secs(allShots()))}`));
}

// ---- the side panel: the shot being edited, then the story's frame settings ----
function shotSection(at) {
  const { sc, si, s, i } = at, n = `${si + 1}.${i + 1}`, f = chosen(s);
  const toggleChips = (list, key) => h('div', { class: 'chips' }, list.map(([v, l]) => chip(l, () => { s[key] = s[key] === v ? '' : v; changed(); }, { on: s[key] === v })));
  const t = storyTemplate();
  const on = (fr) => fr.id === f?.id;
  const frames = h('div', { class: 'st-frames' },
    framesOf(s).map((fr) => h('div', { class: `st-frame${on(fr) ? ' on' : ''}`, style: `aspect-ratio:${ratio()}` },
      h('button', { type: 'button', class: 'st-frame-img', 'aria-label': on(fr) ? 'The chosen frame (tap to see it big)' : 'Choose this frame',
        onclick: () => { if (on(fr)) openLightbox(s.id); else { s.pick = fr.id; changed(); } } }, h('img', { src: frameThumb(fr, 320), alt: '', loading: 'lazy' })),
      on(fr) ? h('span', { class: 'st-frame-on' }, icon('check')) : null,
      fr.canvas ? h('span', { class: 'st-frame-tag' }, 'Canvas')
        : h('div', { class: 'st-frame-btns' },
          iconBtn('Put it on the canvas', icon('canvas'), () => frameToCanvas(s, fr), { class: 'icon-btn' }),
          iconBtn('Remove this frame', icon('close'), () => removeFrame(s, fr), { class: 'icon-btn' })))),
    s.pending.map((id) => h('div', { class: 'st-frame st-frame-wait', style: `aspect-ratio:${ratio()}` },
      h('span', { class: 'st-spin' }), h('span', {}, S.history.get(id)?.status === 'running' ? 'Making…' : 'Waiting…'))));
  const lbl = `frame ${n}`;
  return section(`Shot ${n}${sc.slug ? ` · ${sc.slug}` : ''}`, () => select(null),
    field('What we see', bound(s, 'what', { rows: 3, placeholder: 'e.g. @Mara at the window, rain running down the glass', label: 'What we see', mention: true })),
    field('Action / dialogue', bound(s, 'action', { rows: 2, placeholder: 'MARA: He isn\'t coming.', label: 'Action / dialogue', mention: true })),
    castChips(s),
    field('Shot size', seg(SIZES.map(([v, l]) => [v, l]), s.size, (v) => { s.size = v; changed(); }, { wrap: true })),
    field('Angle', toggleChips(ANGLES, 'angle')),
    field('Camera move', toggleChips(MOVES, 'move')),
    field('Length', seg(DURS.map((d) => [d, `${d} s`]), s.dur, (v) => { s.dur = v; changed(); }, { wrap: true })),
    field('Status', seg(STATUS, s.status, (v) => { s.status = v; changed(); })),
    U.view !== 'canvas' ? button([icon('canvas'), 'Open on the canvas'], () => { U.view = 'canvas'; store.set('deck.story.view', 'canvas'); select(s.id); }, { title: 'Draw and lay out this shot\'s frame' }) : null,
    field([`Frames`, h('span', {}, `${framesOf(s).length}`)],
      help('The canvas is the picture drawn and laid out on the canvas view. Tap a frame to make it the shot\'s chosen one (the board shows it, Shots to video uses it); tap the chosen one to see it big. The canvas button on a frame puts it on the canvas as a new layer.'),
      frames,
      h('div', { class: 'row wrap' },
        button([icon('sparkle'), 'Generate frame'], () => makeFrame(s), { cls: 'small primary', disabled: !t }),
        info(t ? `${t.name || t.id}, ${frameSize(t).join('×')}, ${P.batch} per run. Prompt: ${promptOf(s) || '(write what we see first)'}` : 'No text-to-image template is installed.', 'The prompt it sends')),
      h('div', { class: 'row wrap' },
        button([icon('image'), 'From pictures…'], () => pickFrames(s), { title: 'Pictures already here: this project\'s, every input, edits' }),
        fileButton([icon('upload'), 'Upload…'], (fs) => uploadFrames(s, fs), { accept: 'image/*', multiple: true }))),
    f ? field('Send the chosen frame', h('div', { class: 'row wrap' },
      button('To Generate', () => toGenerate(f, lbl), { title: 'Into the picture field of the template open in Generate' }),
      button('To VFX', () => toVfx(f, lbl), { title: 'The VFX tab\'s start image' }),
      button('To the Editor', () => toEditor(f)))) : null,
    h('div', { class: 'row wrap st-shot-btns' },
      button([icon('up'), 'Up'], () => moveShot(s.id, -1)), button([icon('down'), 'Down'], () => moveShot(s.id, 1)),
      button([icon('plus'), 'Shot after'], () => addShot(sc, s)),
      button([icon('copy'), 'Duplicate'], () => duplicateShot(s.id)),
      button([icon('trash'), 'Delete'], () => deleteShot(s.id), { cls: 'small danger' })));
}

function shapeIcon(r) {   // a little frame of the shape itself
  const w = r >= 1 ? 20 : Math.round(20 * r), hh = r >= 1 ? Math.round(20 / r) : 20;
  const s = icon('rect'); s.replaceChildren();
  const p = document.createElementNS(s.namespaceURI, 'rect');
  for (const [k, v] of Object.entries({ x: (24 - w) / 2, y: (24 - hh) / 2, width: w, height: hh, rx: 1 })) p.setAttribute(k, v);
  s.append(p);
  return s;
}

function framesSection() {
  const ts = storyTemplates(), t = storyTemplate();
  const sel = h('select', { 'aria-label': 'Image template' }, ts.map((x) => h('option', { value: x.id, selected: x === t }, x.name || x.id)));
  sel.addEventListener('change', () => { P.tpl = sel.value; changed(); });
  return section('Frames', null,
    help('How Generate frame makes a shot\'s pictures: the shot\'s framing and description, then this style line, through a text-to-image template.'),
    field('Style', bound(P, 'style', { rows: 2, placeholder: 'e.g. cinematic film still, 35mm, soft light, muted colours', label: 'Style' }),
      help('Added to every frame\'s prompt, so the shots look alike.')),
    field('Shape', seg(ASPECTS.map(([k, r]) => [k, [shapeIcon(r), k]]), P.aspect, (v) => { P.aspect = v; changed(); }, { wrap: true })),
    ts.length ? field('Template', sel) : note('No text-to-image template is installed (one with a prompt, a width and a height, and no picture input).'),
    field('Frames per run', seg([1, 2, 3, 4].map((n) => [n, String(n)]), P.batch, (v) => { P.batch = v; persist(); renderPanel(); })));
}

// a character open in the panel (null: none), scrolled to
function openCharacter(id) {
  U.char = id;
  renderPanel();
  if (id) requestAnimationFrame(() => [...document.querySelectorAll('#storyBody .section-title span')].find((x) => x.textContent.startsWith('Character ·'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
async function frameToCharacter(c, s) {
  const f = chosen(s);
  if (!c || !f) return;
  try { addCharPicture(c, await frameInput(f)); toast(`Added to ${c.name}'s pictures`); } catch (e) { toast(e.message, true); }
}
// the characters a shot brings in, as chips (tap one to open them)
function castChips(s) {
  const cast = castOf(s);
  if (!cast.length) return null;
  return field('In this shot', h('div', { class: 'chips' }, cast.map((c) => chip([h('span', { class: 'ch-chip-face' }, mainPicture(c) ? h('img', { src: thumbUrl(mainPicture(c), 64), alt: '' }) : icon('person')), c.name],
    () => openCharacter(c.id), { title: c.look || c.desc || c.name, on: U.char === c.id }))));
}

// The panel: the shot, then (on the canvas view) the canvas's tools, then the characters, then the story's frame settings. The brush's
// settings come first while painting. A redraw keeps the cursor in the box being typed in.
function fillPanel() {
  const body = $('#storyBody');
  if (!body) return;
  const at = U.sel && locate(U.sel);
  if (!at) U.sel = null;
  const ed = U.view === 'canvas' && at && CV.shot === at.s.id ? CV.eng : null;
  const parts = [ed?.paintProps(), at ? shotSection(at) : section('Shot', null, placeholder('Tap a shot to edit it here')),
    ...(ed ? [section('Layers', null, ed.topRow([iconBtn('Frame from a clip', icon('film'), frameFromVideo, { class: 'icon-btn ico-btn' })]), ed.layerList()),
      ed.layerProps(), ed.canvasProps()] : []),
    castSection({ open: U.char, onOpen: openCharacter }),
    U.char && characterById(U.char) ? characterSection(characterById(U.char), { done: () => openCharacter(null),
      extra: at && chosen(at.s) ? [button([icon('canvas'), 'The shot\'s frame'], () => frameToCharacter(characterById(U.char), at.s), { title: 'Add this shot\'s frame as one of their pictures' })] : [] }) : null,
    framesSection()].filter(Boolean);
  const a = document.activeElement, key = a && body.contains(a) ? a.dataset?.bind : null;
  const range = key && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  body.replaceChildren(...parts);
  if (key) {
    const n = body.querySelector(`[data-bind="${key}"]`);
    if (n) { n.focus({ preventScroll: true }); if (range) try { n.setSelectionRange(...range); } catch { /* not a text box */ } }
  }
}
export function renderPanel() {
  if (U.view === 'canvas' && CV.eng && CV.shot && CV.shot === U.sel) CV.eng.render();   // (it fills the panel, fillPanel)
  else fillPanel();
}

export function renderStory() { renderStage(); renderPanel(); ensureTabs(); }

// ---- tabs: each story is a document in the project folder ----
function migrate(p) {
  const d = BLANK();
  const shot = (s) => ({ ...newShot(), ...s, frames: Array.isArray(s.frames) ? s.frames : [], pending: Array.isArray(s.pending) ? s.pending : [] });
  const scenes = (Array.isArray(p.scenes) ? p.scenes : []).map((sc) => ({ ...newScene(), ...sc, shots: (sc.shots || []).map(shot) }));
  return { ...d, ...p, scenes: scenes.length ? scenes : d.scenes };
}
const adapter = {
  empty: BLANK,
  migrate,
  dump: () => P,
  beforeLeave: settleCanvas,   // the open shot's strokes and picture are saved into the story being left
  load(p, doc) {
    P = migrate(p);
    if (U.doc !== doc?.id) { U.doc = doc?.id; CV.shot = null; ++CV.seq; clearTimeout(CV.timer); }   // another story: its shots' canvases
    if (!locate(U.sel)) U.sel = null;
    renderStage(); renderPanel();
    setTimeout(catchUp, 0);
  },
};

export function wireStory() {
  const mount = h('div', { class: 'vid-tabs' });
  $('#storyPanel').replaceChildren(mount, h('div', { id: 'storyBody', class: 'panel-body' }));
  tabs = new TabSet({ kind: 'story-tabs', mount, scope: 'project', newName: (n) => `Story ${n}`, adapter });
  fullScreen($('#tab-story'));
  makeCanvas();
  onCharacters(() => { if (!shown()) return; if (U.view === 'script') renderStage(); renderPanel(); });
  // a frame run for a shot here ends: this device queued it, so this device files the pictures (another device
  // showing the same story gets them with the save); anything else just redraws its waiting tiles
  onServer('deck_generation', ({ data: g }) => {
    const s = g && pendingShot(g.id);
    if (!s) return;
    if (['done', 'error', 'interrupted'].includes(g.status) && isMine(g.prompt_id)) {
      settle(s, g);
      if (g.status !== 'done') toast(`Frame #${g.id} failed${g.error ? `: ${g.error}` : ''}`, true);
      changed();
    } else if (shown()) setTimeout(() => { renderStage(); renderPanel(); }, 0);
  });
}

// for the headless UI checks (dev/): the live state
export const storyDebug = () => ({ P, U, tabs });
