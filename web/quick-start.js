// The quick-start sheet: a double tap on empty table (or Quick start… in the New frame menus) asks what to start
// there. The five kinds sit in a row at the top; under each, its starts as big cards, one tap each. A start makes its
// frame with the frame's top-left at the tapped point (on the grid when it is on), selects it, and for the starts
// from text or from a picture (a video, a 3D object) runs the Make panel's Run on it, so the result lands in that frame. Everything goes through the table's
// own paths (table.js newFrameAt / sourceFrameAt / dropOntoFrame, frame-scene.js addToScene); nothing new is saved
// apart from the choices remembered on this device (quick-start-rules.js).
//
//   openQuickStart({ x, y, rect?, kind?, centre? })   x, y: a table point. rect: a box drawn there (its size is the
//                                                     frame's). kind: the kind shown first. centre: the frame's middle at x, y.
import { sizePicker } from './size-picker.js';
import { drawnOutput } from './table-model.js';
import { h, store, toast, openSheet, closeSheet, button, chips, seg, field, help, hint, textArea, icon } from './ui.js';
import { S, ASPECT_PRESETS } from './core.js';
import { openSourcePicker } from './source-picker.js';
import { sidebar } from './sidebar.js';
import * as Table from './table.js';
import { blankPayload } from './table-frames.js';
import { emptyVideo, emptyScene } from './empty-docs.js';
import { FPS, NOTE_SIZE, SOUND_SIZE, lastChoice, makePayload, placeAt, rememberChoice, sizeFor, startTemplate } from './quick-start-rules.js';

const KIND_TABS = [['image', 'Image', 'image'], ['video', 'Video', 'film'], ['scene', '3D', 'cube'], ['sound', 'Sound', 'sound'], ['note', 'Note', 'text']];
const ratioOf = (k) => (ASPECT_PRESETS.find(([a]) => a === k) || ASPECT_PRESETS[0])[1];

export function openQuickStart({ x = 0, y = 0, rect = null, kind = null, centre = false } = {}) {
  const Q = { at: { x, y }, rect, centre, c: lastChoice(store, ASPECT_PRESETS), prompt: '' };
  if (kind) Q.c.kind = kind;
  const body = h('div', { class: 'qs-body' });
  const tabs = seg(KIND_TABS.map(([k, label, ic]) => [k, [icon(ic), h('span', {}, label)]]), Q.c.kind, (k) => {
    Q.c.kind = k; rememberChoice(store, { kind: k }); draw();
  });
  tabs.classList.add('qs-kinds');
  const draw = () => body.replaceChildren(...PANES[Q.c.kind](Q));
  openSheet(h('h3', {}, 'New frame'),
    help('Each card makes a frame here in one tap. From text, and a video or 3D object from a picture, make the frame and run the Make panel on it, so the result lands in the frame. Double-tap empty table to open this again.'),
    h('div', { class: 'quick-start' }, tabs, body));
  draw();
}

// ---------------------------------------------------------------------------
// the panes
// ---------------------------------------------------------------------------
const card = (ic, title, run, { cls = '', label = null } = {}) =>
  h('button', { type: 'button', class: `qs-card ${cls}`.trim(), 'aria-label': label || title, onclick: run }, icon(ic, 28), h('span', { class: 'qs-card-title' }, title));
const cards = (...list) => h('div', { class: 'qs-cards' }, list.filter(Boolean));

// the frame's rect: the box drawn, else size at the tapped point
const rectOf = (Q, size) => (Q.rect ? { ...Q.rect } : placeAt(Q.at, size, Table.tableGrid(), { centre: Q.centre }));
// the top-left for a frame sized by what it holds (a picture, a clip)
const cornerOf = (Q) => { const r = rectOf(Q, { w: 0, h: 0 }); return { x: r.x, y: r.y }; };

// A frame on the table over its rect (the box drawn is only its preview), coming out at size
const newOut = (kind, Q, size, opts = {}) => Table.newFrameAt(kind, rectOf(Q, size), { ...opts, extra: { ...opts.extra, out: { w: size.w, h: size.h } } });
// The size a kind comes out at, and its selector: remembered for the next new frame unless a box was drawn (that box's shape starts it)
function outputChoice(Q, kind) {
  Q.sizes ||= {};
  const first = () => {
    if (Q.rect) return drawnOutput(Q.rect);
    if (kind === 'image') return sizeFor(ratioOf(Q.c.aspect), Q.c.mp);
    const s = Q.c[kind];
    return { w: s[0], h: s[1] };
  };
  const size = () => (Q.sizes[kind] ||= first());
  const s = size();
  const picker = sizePicker({ label: 'Output size', w: s.w, h: s.h, mode: kind === 'image' && !Q.rect ? { aspect: Q.c.aspect, mp: Q.c.mp } : null,
    lim: (n) => Math.min(8192, Math.max(16, n)),
    onChange: (w, hh, m) => {
      Q.sizes[kind] = { w, h: hh };
      if (Q.rect) return;
      if (kind !== 'image') rememberChoice(store, { [kind]: [w, hh] });
      else if (m.aspect !== 'custom') { Object.assign(Q.c, { aspect: m.aspect, mp: m.mp }); rememberChoice(store, { aspect: m.aspect, mp: m.mp }); }
    } });
  return { size, picker };
}

// a box to type a prompt in and Make (Ctrl+Enter); it opens under the cards when From text is tapped
function promptBox(Q, host, make) {
  const ta = textArea(() => Q.prompt, (v) => { Q.prompt = v; }, { rows: 3, placeholder: 'Describe it', label: 'Prompt' });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
  const go = () => { if (!Q.prompt.trim()) { ta.focus(); return toast('Type what to make first', true); } make(Q.prompt.trim()); };
  host.replaceChildren(h('div', { class: 'qs-prompt' }, ta, h('div', { class: 'row' }, button([icon('sparkle'), 'Make'], go, { cls: 'primary qs-make' }))));
  host.classList.remove('hidden');
  setTimeout(() => ta.focus(), 30);
}
const textCard = (Q, title, make) => {
  const host = h('div', { class: 'qs-text hidden' });
  return [card('sparkle', title, (e) => { e.currentTarget.classList.add('on'); promptBox(Q, host, make); }), host];
};

const PANES = {
  image(Q) {
    const { size, picker } = outputChoice(Q, 'image');
    const [textC, textHost] = textCard(Q, 'From text', (prompt) => fromText(Q, 'image', 'image-text', size(), prompt));
    const paste = card('paste', 'Paste', () => pasteImage(Q, paste._blob), { cls: 'hidden' });
    clipboardImage().then((b) => { if (b) { paste._blob = b; paste.classList.remove('hidden'); } });
    return [picker,
      cards(card('canvas', 'Blank canvas', () => blank(Q, 'image', size())),
        card('image', 'From pictures', () => pickPictures(Q)),
        textC, paste),
      textHost];
  },
  video(Q) {
    const { size, picker } = outputChoice(Q, 'video');
    const rows = [picker];
    rows.push(field('Frame rate', chips(FPS.map((f) => [f, `${f} fps`]), Q.c.fps, (v) => { Q.c.fps = +v; rememberChoice(store, { fps: +v }); })));
    const [textC, textHost] = textCard(Q, 'From text', (prompt) => fromText(Q, 'video', 'video-text', size(), prompt));
    return [...rows,
      cards(card('film', 'Blank sequence', () => blank(Q, 'video', size(), { ...emptyVideo(), size: [size().w, size().h], fps: Q.c.fps })),
        card('video', 'From a clip', () => { closeSheet(); openSourcePicker({ kinds: ['video'], want: 'clip', title: 'Start from a clip', onPick: (v) => fromSource(Q, { ...v, kind: 'video' }) }); }),
        textC,
        card('image', 'From a picture', () => pickPicture((name) => withPicture(Q, 'video', 'video-picture', size(), name), 'Picture to animate'))),
      textHost];
  },
  scene(Q) {
    const { size, picker } = outputChoice(Q, 'scene');
    const payload = () => ({ ...emptyScene(), width: size().w, height: size().h });
    const intoScene = (how) => pickPicture(async (name) => {
      const f = await newOut('scene', Q, size(), { payload: payload() });
      if (!f) return;
      try { await (await import('./frame-scene.js')).addToScene(f, [{ input: name }], how); } catch (e) { toast(`Couldn't add to the scene: ${e.message}`, true); }
    }, how === 'photo' ? 'Picture for a 3D photo' : 'Background picture');
    return [picker,
    cards(card('cube', 'Empty scene', () => blank(Q, 'scene', size(), payload())),
      card('photo', '3D photo from a picture', () => intoScene('photo')),
      card('image', 'Background picture', () => intoScene('picture')),
      card('person', 'Object from a picture', () => pickPicture((name) => withPicture(Q, 'scene', 'scene-object', size(), name, payload()), 'Picture of the object')))];
  },
  sound(Q) {
    const [textC, textHost] = textCard(Q, 'Music from text', (prompt) => fromText(Q, 'sound', 'sound-music', SOUND_SIZE, prompt));
    return [cards(card('sound', 'Empty mix', () => blank(Q, 'sound', SOUND_SIZE)),
      card('upload', 'From a file', () => {
        closeSheet();
        openSourcePicker({ kinds: ['audio', 'video'], want: 'sound', title: 'Start from a sound', onPick: async (src) => {
          const f = await Table.newFrameAt('sound', rectOf(Q, SOUND_SIZE), { payload: blankPayload('sound') });
          if (f && !Table.dropOntoFrame(f, [src])) toast('That sound couldn\'t go in the mix', true);
        } });
      }),
      textC), textHost];
  },
  note(Q) {
    return [cards(card('text', 'Blank note', async () => {
      closeSheet();
      const f = await Table.newFrameAt('note', rectOf(Q, NOTE_SIZE), { extra: { text: '' } });
      if (f) setTimeout(() => Table.goLive(f), 0);   // (its text takes the keys at once; after the sheet has given focus back)
    }))];
  },
};

// ---------------------------------------------------------------------------
// the starts
// ---------------------------------------------------------------------------
async function blank(Q, kind, size, payload) {
  closeSheet();
  await newOut(kind, Q, size, payload ? { payload } : {});
}

function pickPicture(onPick, title = 'Start from a picture') {
  closeSheet();
  openSourcePicker({ kinds: ['image'], want: 'picture', title, onPick: (name, info) => Promise.resolve(onPick(name, info)).catch((e) => toast(e.message, true)) });
}

// Pictures ticked for a new image frame: the first makes it (at that picture's size), the rest go in as layers over it, in the order ticked.
// They arrive one at a time, some after an upload, so they queue here.
function pickPictures(Q) {
  closeSheet();
  const waiting = [];
  let frame = null, running = false, failed = false;
  const work = async () => {
    if (running) return;
    running = true;
    try {
      while (waiting.length && !failed) {
        const list = waiting.splice(0);
        if (!frame) {
          frame = await Table.sourceFrameAt(list.shift(), cornerOf(Q));
          if (!frame) { failed = true; break; }
          Table.selectFrames([frame.id]);
        }
        if (list.length) await Table.addToFrame(frame, list);
      }
    } catch (e) { toast(e.message, true); } finally { running = false; }
  };
  openSourcePicker({ kinds: ['image'], want: 'picture', title: 'Start from pictures', multi: true,
    onPick: (name, info) => { waiting.push({ input: name, width: info?.width, height: info?.height }); work(); } });
}

// a picture, clip or file as a frame of its own (the same as dropping it on the table there)
async function fromSource(Q, src) {
  const f = await Table.sourceFrameAt(src, cornerOf(Q));
  if (f) Table.selectFrames([f.id]);
}

// The template a start uses: the last one used for it, else the Make panel's last for that kind
function templateFor(start, kind) {
  const t = startTemplate(S.templates, start, store.get(`deck.quick.tpl.${start}`, null),
    ...(kind === 'image' ? [store.get('deck.make.tpl.none', null)] : []), store.get(`deck.make.tpl.${kind}`, null), store.get('deck.make.tpl.none', null));
  if (!t) toast(S.templates?.length ? 'No template here makes that yet' : 'The templates are still loading', true);
  else store.set(`deck.quick.tpl.${start}`, t.id);
  return t;
}
// settings kept before for this template (nothing selected on the table keeps one set: its preset and changes stay)
const baseFor = (t) => { const b = store.get('deck.make.none', null); return b?.template === t.id ? b : null; };

// From text: the frame, its Make settings with the prompt, selected, then Run (the result lands in it)
async function fromText(Q, kind, start, size, prompt) {
  const t = templateFor(start, kind);
  if (!t) return;
  closeSheet();
  const f = await newOut(kind, Q, size, { payload: kind === 'video' ? { ...emptyVideo(), size: [size.w, size.h], fps: Q.c.fps } : undefined,
    extra: { make: makePayload(t, { prompt }, baseFor(t)) } });
  if (!f) return;
  const mp = await import('./make-panel.js');
  sidebar.show('make');
  await mp.runMake();
}

// From a picture: the frame with its Make settings holding the picture, selected, then Run (the result lands in it)
async function withPicture(Q, kind, start, size, name, payload) {
  const t = templateFor(start, kind);
  if (!t) return;
  const f = await newOut(kind, Q, size, { payload: payload || (kind === 'video' ? { ...emptyVideo(), size: [size.w, size.h], fps: Q.c.fps } : undefined),
    extra: { make: makePayload(t, { picture: name }, baseFor(t)) } });
  if (!f) return;
  const mp = await import('./make-panel.js');
  sidebar.show('make');
  await mp.runMake();
}

// ---- paste ----
// the clipboard's first picture, or null (no permission, nothing there, or a browser without clipboard.read)
async function clipboardImage() {
  try {
    if (!navigator.clipboard?.read) return null;
    for (const it of await navigator.clipboard.read()) {
      const type = it.types.find((x) => x.startsWith('image/'));
      if (type) return await it.getType(type);
    }
  } catch { /* not allowed, or nothing to read */ }
  return null;
}
async function pasteImage(Q, blob) {
  closeSheet();
  if (!blob) return toast('No picture on the clipboard', true);
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  await fromSource(Q, new File([blob], `pasted.${ext}`, { type: blob.type }));
}
