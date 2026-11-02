import {
  $, h, store, api, toast, openSheet, closeSheet, sheetStillOpen, button, chip, iconBtn, actions, fileButton, seg, placeholder, note, mediaCard, field, pickButtons, info,
} from './ui.js';
import { fmtTime } from './playback.js';
import { MP_STEPS, capLabel } from './mp-cap.js';
import { runBar } from './run-bar.js';
import { cardPicture, kindTile, madeBy } from './kinds.js';
import { S, CURRENT_EDIT as CURRENT, PICKER_SOURCES as SOURCES, inputUrl, previewUrl, switchTab, thumbUrl } from './core.js';
import { heightGrip, maximizable, zoomPan } from './layout.js';
import { fmtDur, runTime } from './run-state.js';
import { fetchHistory as loadHistory } from './generation-data.js';
import { tick, tickRange, addFrame, frameIndex, byTag, tagsIn } from './pick-slots.js';
import { draggingPicture, dropKind, droppedFiles } from './drop-files.js';

// This project's finished outputs of the given kinds, newest first: [{ g, o, i, t }]
export async function projectOutputs(kinds) {
  if (!S.history.size) await loadHistory();
  const items = [];
  for (const g of S.history.values()) {
    if (g.project_id !== S.project || g.status !== 'done') continue;
    g.outputs.forEach((o, i) => { if (kinds.includes(o.kind)) items.push({ g, o, i, t: g.finished || g.created }); });
  }
  return items.sort((x, y) => y.t - x.t);
}
// a run by its template, an imported file by its name
export const genLabel = (g) => `#${g.id} ${(g.template === 'import' || g.template === 'saved') && g.params?.label ? g.params.label : madeBy(g) || g.template}`;
// a card's picture: a thumbnail, or a note for sound
export const cardMedia = (o, g = null) => cardPicture(o, g);   // (kinds.js: a still, a waveform, or what the kind is)

// A run as a card, the same in History, the VFX tab's takes and the Sound tab's makers: its output (kind: the one to
// show when it made several), ▶ on a clip, how many it made, and its state (waiting, running, failed, or how long it
// took). onPick(g) on a tap; picked: drawn as the one on show.
export function outputCard(g, { kind = null, onPick, picked = false } = {}) {
  const i = kind ? Math.max(0, g.outputs.findIndex((x) => x.kind === kind)) : 0, o = g.status === 'done' ? g.outputs[i] : null;
  const took = g.status === 'done' ? runTime(g) : null;
  const media = o ? cardMedia(o, g)
    : placeholder(g.status === 'error' ? `Failed: ${g.error || ''}` : g.status === 'queued' ? 'Waiting…' : g.status === 'interrupted' ? 'Stopped' : 'Running…');
  return mediaCard([media, g.outputs.length > 1 ? h('span', { class: 'play count' }, `${g.outputs.length}`) : null], null, () => onPick?.(g), {
    badge: o?.kind === 'video' ? '▶' : null, attrs: { 'data-gen': g.id, class: `card${picked ? ' picked' : ''}` },
    meta: [h('span', { class: 'name' }, genLabel(g)), h('span', { class: `badge ${g.status}` }, took != null ? fmtDur(took) : g.status)] });
}

// A sheet of cards to pick from: bar holds its buttons, load() returns the cards (or a message)
export function pickerSheet(title, bar, load) {
  const grid = h('div', { class: 'grid gallery' });
  const draw = async () => {
    grid.replaceChildren(placeholder('Loading…'));
    try { const cards = await load(); grid.replaceChildren(...[cards].flat()); }
    catch (e) { grid.replaceChildren(note(e.message, 'err')); }
  };
  draw.seq = openSheet(h('h3', {}, title), h('div', { class: 'picker-bar' }, bar), grid);
  draw();
  return draw;
}

// Pictures dropped on an open picker sheet (from the desktop or another window) go to give(files). One listener on
// the sheet; DROP is the open picker's, live while its sheet is (sheetStillOpen).
let DROP = null;
function dropPictures(seq, give) {
  DROP = { seq, give };
  const el = $('#sheet');
  if (el.dataset.drop) return;
  el.dataset.drop = '1';
  const live = (e) => DROP && sheetStillOpen(DROP.seq) && draggingPicture(e.dataTransfer);
  el.addEventListener('dragover', (e) => { if (!live(e)) return; e.preventDefault(); el.classList.add('dropping'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', async (e) => {
    el.classList.remove('dropping');
    if (!live(e)) return;
    e.preventDefault();
    const { give } = DROP;
    try {
      const fs = (await droppedFiles(e.dataTransfer)).filter((f) => dropKind(f) === 'image');
      if (fs.length) give(fs); else toast('Drop a picture (PNG, JPG, WebP…)', true);
    } catch (err) { toast(err.message, true); }
  });
}

// The webcam, where the camera button can't ask for it (a desktop browser ignores capture and opens the file
// chooser): a live view and Take picture. onFile(PNG File); Cancel runs back(). The camera goes off when the sheet
// does, however it closes.
const desktop = () => matchMedia('(pointer: fine)').matches;
const hasWebcam = async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return false;   // (HTTPS only)
  try { return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'videoinput'); } catch { return false; }
};
async function takePhoto({ onFile, back }) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'The browser wasn\'t allowed to use the camera' : `Can't open the camera: ${e.message}`, true); return; }
  const v = h('video', { muted: true, playsInline: true, autoplay: true, class: 'frame-video' });
  v.srcObject = stream;
  const stop = () => { clearInterval(watch); stream.getTracks().forEach((t) => t.stop()); };
  const watch = setInterval(() => { if (!v.isConnected || v.closest('.hidden')) stop(); }, 500);
  const take = () => {
    if (!v.videoWidth) return toast('The camera is still starting', true);
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    cv.toBlob((b) => {
      if (!b) return toast('Couldn\'t take the picture', true);
      stop(); closeSheet(); onFile(new File([b], `camera-${Date.now()}.png`, { type: 'image/png' }));
    }, 'image/png');
  };
  openSheet(h('h3', {}, 'Camera'), h('div', { class: 'media-big' }, v),
    actions(button('Take picture', take, { cls: 'primary' }), button('Cancel', () => { stop(); back(); }, { cls: 'ghost' })));
}

// A media-library card with a 🗑 on it: asks, deletes the file for good (the server refuses one a project uses), drops the card
export function withMediaDelete(card, m) {
  const del = iconBtn('Delete this file', '🗑', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete ${m.label || m.name} for good? Its copies and thumbnails go too.`)) return;
    try {
      await api(`/api/media?name=${encodeURIComponent(m.name)}`, { method: 'DELETE' });
      card.remove(); toast('Deleted');
    } catch (err) { toast(err.message, true); }
  });
  del.classList.add('card-del');
  card.querySelector('.media')?.append(del);
  return card;
}
export const uploadMedia = (file) => { const form = new FormData(); form.append('file', file); return api('/api/media', { method: 'POST', form }); };

// this project's video outputs, newest first, plus the Video tab's uploaded clips
// ---- recently used: a strip of the last pictures or clips picked, at the top of each picker, to hop between them ----
// kept per device; an entry whose file is gone drops out when its thumbnail fails to load.
// entry: {k (what makes it the same one), label, kind ('img' | 'video'), src (the thumbnail), val (what the picker hands back)}
const RECENT_MAX = 14;
const recentList = (what) => { const l = store.get(`deck.recent.${what}`, []); return Array.isArray(l) ? l : []; };
function rememberRecent(what, e) {
  store.set(`deck.recent.${what}`, [e, ...recentList(what).filter((x) => x.k !== e.k)].slice(0, RECENT_MAX));
}
// the strip for the picker open now: it goes after the picker's bar. pick(val) is what a tap does.
function recentStrip(what, pick) {
  const strip = h('div', { class: 'recent-strip', role: 'group', 'aria-label': 'Recently used' });
  const draw = () => {
    const l = recentList(what);
    strip.classList.toggle('hidden', !l.length);
    strip.replaceChildren(h('span', { class: 'recent-lbl' }, 'Recent'), ...l.map((e) => {
      const pic = e.kind === 'video' ? h('video', { src: `${e.src}#t=0.1`, muted: true, preload: 'metadata', playsInline: true })
        : h('img', { src: e.src, alt: '', loading: 'lazy' });
      pic.addEventListener('error', () => { store.set(`deck.recent.${what}`, recentList(what).filter((x) => x.k !== e.k)); draw(); });
      return h('button', { type: 'button', class: 'recent-item', title: e.label, 'aria-label': e.label, onclick: () => pick(e.val) }, pic);
    }));
  };
  draw();
  $('#sheet .picker-bar').after(strip);
  return strip;
}

export function openVideoPicker({ title, onPick }) {
  const picked = (val) => {
    const g = val.generation != null ? S.history.get(val.generation) : null, o = g?.outputs[val.index || 0];
    if (o?.url?.startsWith('/files/')) rememberRecent('video', { k: `g${val.generation}.${val.index || 0}`, label: genLabel(g), kind: 'img', src: previewUrl(o.url, 160), val: bareSource(val) });
    else if (val.media) rememberRecent('video', { k: `m${val.media}`, label: clipLabel(val), kind: 'video', src: `/files/media/${encodeURIComponent(val.media)}`, val: { media: val.media } });
    closeSheet(); onPick(val);
  };
  pickerSheet(title, [
    fileButton('Upload…', async ([fl]) => {
      try { const m = await uploadMedia(fl); picked({ media: m.name }); }
      catch (e) { toast('Upload failed: ' + e.message, true); }
    }, { accept: 'video/*', cls: 'small primary' }),
    button('From a link or big file…', () => import('./clipimport.js').then((m) => m.openClipImport({ onSaved: (e) => onPick({ media: e.name }) })))], async () => {
    let media = [];
    try { media = (await api('/api/media')).filter((m) => m.kind === 'video'); } catch { /* the outputs still show */ }
    const items = (await projectOutputs(['video'])).map(({ g, o, i, t }) =>
      ({ t, el: () => mediaCard(cardMedia(o), genLabel(g), () => picked({ generation: g.id, index: i }), { badge: '▶' }) }));
    for (const m of media) items.push({ t: m.created, el: () => withMediaDelete(mediaCard(cardMedia(m), m.label, () => picked({ media: m.name }), { badge: '▶' }), m) });
    items.sort((x, y) => y.t - x.t);
    return items.length ? items.slice(0, 300).map((x) => x.el()) : placeholder('No videos in this project yet. Generate one or upload a clip.');
  });
  recentStrip('video', picked);
}

// Sounds: the media library's sound files and this project's sound outputs, then clips (their sound is
// used). onPick gets a source: {generation, index} | {media}.
export function openSoundPicker({ title = 'Pick a sound', onPick, clips = true }) {
  const picked = (val) => { closeSheet(); onPick(val); };
  const head = (text) => h('h4', { class: 'picker-head' }, text);
  pickerSheet(title, [
    fileButton('Upload…', async ([fl]) => {
      try { const m = await uploadMedia(fl); picked({ media: m.name }); }
      catch (e) { toast('Upload failed: ' + e.message, true); }
    }, { accept: 'audio/*,video/*', cls: 'small primary' }),
    button('From a link or big file…', () => import('./clipimport.js').then((m) =>
      m.openClipImport({ title: 'Import a sound', sound: true, onSaved: (e) => onPick({ media: e.name }) })))], async () => {
    let media = [];
    try { media = await api('/api/media'); } catch { /* the outputs still show */ }
    const card = (o, label, src) => ({ t: o.t, el: () => (src.media ? withMediaDelete : (c) => c)(mediaCard(cardMedia(o), label, () => picked(src)), o) });
    const sounds = (await projectOutputs(['audio'])).map(({ g, o, i, t }) => card({ ...o, t }, genLabel(g), { generation: g.id, index: i }));
    const vids = clips ? (await projectOutputs(['video'])).map(({ g, o, i, t }) => card({ ...o, t }, genLabel(g), { generation: g.id, index: i })) : [];
    for (const m of media) {
      if (m.kind === 'audio') sounds.push(card({ ...m, t: m.created }, m.label, { media: m.name }));
      else if (clips && m.kind === 'video') vids.push(card({ ...m, t: m.created }, m.label, { media: m.name }));
    }
    const byTime = (x, y) => y.t - x.t;
    sounds.sort(byTime); vids.sort(byTime);
    if (!sounds.length && !vids.length) return placeholder('No sounds yet. Upload one, or bring one in from a link or a big file.');
    return [sounds.length ? [head('Sounds'), sounds.slice(0, 300).map((x) => x.el())] : null,
      vids.length ? [head('Clips (their sound)'), vids.slice(0, 300).map((x) => x.el())] : null].filter(Boolean);
  });
}

// ---- clip and sound sources: {generation, index} for an output, {media} for a file in the media library ----
// (a picked one may also carry trim, crop and a label)
export function bareSource(v) { return v.generation != null ? { generation: v.generation, index: v.index || 0 } : { media: v.media }; }
// where a clip source plays, from the history loaded so far (null: not loaded, or gone)
export function clipUrl(v) {
  if (!v) return null;
  if (v.generation != null) return S.history.get(v.generation)?.outputs[v.index || 0]?.url || null;
  return v.media ? `/files/media/${encodeURIComponent(v.media)}` : null;
}
export function clipLabel(v) {
  if (!v) return 'none';
  if (v.generation != null) { const g = S.history.get(v.generation); return g ? genLabel(g) : `#${v.generation} (not loaded)`; }
  return v.label || (v.media || '').split('_').slice(1).join('_') || v.media;
}

// What a sound source is called and where it plays, from the media list / history: {label, url, kind} or null
export async function soundSource(v) {
  if (!v) return null;
  if (v.generation != null) {
    if (!S.history.size) await loadHistory();
    const g = S.history.get(v.generation), o = g?.outputs[v.index];
    return o ? { label: genLabel(g), url: o.url, kind: o.kind } : null;
  }
  if (v.media) {
    let list = [];
    try { list = await api('/api/media'); } catch { /* offline */ }
    const m = list.find((x) => x.name === v.media);
    return m ? { label: m.label, url: m.url, kind: m.kind } : null;
  }
  return null;
}

// A picked sound with a player and a cut (Start, Length in seconds): value {generation, index} | {media},
// with trim {start, len}. onChange(value or null) on every change; title names the picker.
export function soundInput(value, onChange, { title = 'Pick a sound', label = 'Sound' } = {}) {
  const box = h('div', { class: 'sound-input' });
  const pick = () => openSoundPicker({ title, onPick: (v) => { value = v; onChange(v); draw(); } });
  const draw = async () => {
    if (!value) {
      box.replaceChildren(field([label, h('span', {}, 'none')], pickButtons(false, pick, null)));
      return;
    }
    const src = await soundSource(value);
    const player = src ? h('audio', { src: src.url, controls: true, preload: 'metadata' }) : note('That sound is gone: pick another', 'err');
    const t = value.trim || {};
    const num = (v, ph, lbl) => h('input', { type: 'number', inputMode: 'decimal', min: 0, step: 0.1, value: v ?? '', placeholder: ph, 'aria-label': lbl });
    const start = num(t.start, '0', 'Start (s)'), len = num(t.len, 'all', 'Length (s)');
    const setTrim = () => {
      const st = Math.max(0, parseFloat(start.value) || 0), ln = parseFloat(len.value);
      value = { ...bareSource(value), ...((st > 0 || ln > 0) && { trim: { start: st, ...(ln > 0 && { len: ln }) } }) };
      onChange(value);
    };
    start.addEventListener('change', setTrim); len.addEventListener('change', setTrim);
    const fromHere = button('Start here', () => { if (player.currentTime != null) { start.value = player.currentTime.toFixed(2); setTrim(); } },
      { cls: 'small', title: 'Start the cut where the player is' });
    box.replaceChildren(field([label, h('span', {}, src ? `${src.label}${src.kind === 'video' ? ' (its sound)' : ''}` : '')], player,
      h('div', { class: 'sound-cut' }, h('label', {}, 'Start (s)', start), h('label', {}, 'Length (s)', len), fromHere),
      pickButtons(true, pick, () => { value = null; onChange(null); draw(); })));
  };
  draw();
  return box;
}

// Take the sound out of a clip into the media library (a toast says so); resolves the media entry
export async function extractSound(source, { trim = null, name = null } = {}) {
  const m = await api('/api/audio/extract', { method: 'POST', body: { source, trim, name }, busy: 'Taking the sound out…', timeout: 600000 });
  toast(`Saved ${m.label} to the media library`);
  return m;
}

// A clip's sound, taken out and put on the Sound tab's timeline (the Sound tab opens on it)
export async function soundToSoundTab(source, { trim = null, name = null } = {}) {
  try {
    const m = await api('/api/audio/extract', { method: 'POST', body: { source, trim, name }, busy: 'Taking the sound out…', timeout: 600000 });
    switchTab('sound');
    await (await import('./sound.js')).addToSound({ media: m.name });
    toast(`${m.label} is on the Sound tab (and in the media library)`);
    return m;
  } catch (e) { toast('Couldn\'t take the sound out: ' + e.message, true); return null; }
}

// ---------------------------------------------------------------------------
// Extra sources for the image picker (a tab each, next to "This project" and "All inputs").
//   registerPickerSource({ key, label, list(projectId) -> Promise<item[]>, pick(item, { mp, frame }) -> Promise<result> })
// item:   { id, title, thumb (image url), badge?, still?: bool, video?: url, ...anything pick() needs }
//         still: a picture of it exists (thumb); video: a clip the user may take a frame from.
//         Both set: the user chooses; only video: straight to the frame picker; only still: picked at once.
// pick:   frame is a PNG Blob when the user chose a frame (pickFrame below), else null (use the still).
//         Returns what onPick gets: { name, ... } where name is an image in ComfyUI's input folder, normally
//         from uploadImage(blob, { mp, source: 'edit-tab' }). Throw to show a toast.
// Example (the real one for saved video edits is at the end of video.js; it takes the frame from the tab's newest render):
//   registerPickerSource({ key: 'video-tabs', label: 'Saved video edits',
//     list: async (pid) => (await api(`/api/store/video-tabs?project_id=${pid}`)).map((d) =>
//       ({ id: d.id, title: d.name, thumb: d.still?.url, still: !!d.still, video: d.render?.url })),
//     pick: async (it, { mp, frame }) => uploadImage(frame || await (await fetch(it.thumb)).blob(), { mp, source: 'video-tab' }) });
// ---------------------------------------------------------------------------
export function registerPickerSource(src) { SOURCES.set(src.key, src); }

// The open Editor tab, for the picker's "Current edit" button: the edit as it is now, exported and picked at once
const currentEditReady = () => !!CURRENT.eng?.E.layers.some((l) => !l.hidden && !l.mask);

// Scrub a video and take one frame: a sheet with the clip, a slider and frame steps.
// Resolves a PNG Blob of the shown frame, or null on Cancel (Back, if given, runs after). grab(t), if given, makes
// the frame instead (a Blob for the time shown: the link still takes it from the full-quality video).
export function pickFrame({ url, title = 'Pick a frame', fps = 24, back = null, grab = null }) {
  return new Promise((resolve) => {
    const v = h('video', { src: `${url}#t=0.001`, muted: true, playsInline: true, preload: 'auto', class: 'frame-video' });
    const slider = h('input', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time' });
    const lbl = h('span', { class: 'timecode' }, fmtTime(0));
    const seek = (t) => { v.currentTime = Math.max(0, Math.min(v.duration || 0, t)); };
    const step = (n) => { v.pause(); seek(v.currentTime + n / fps); };
    v.addEventListener('loadedmetadata', () => { slider.max = v.duration; });
    v.addEventListener('timeupdate', () => { slider.value = v.currentTime; lbl.textContent = `${fmtTime(v.currentTime, fps)} / ${fmtTime(v.duration, fps)}`; });
    v.addEventListener('error', () => toast("Couldn't load that video", true));
    slider.addEventListener('input', () => { v.pause(); seek(Number(slider.value)); });
    const done = (blob) => { closeSheet(); resolve(blob); if (!blob) back?.(); };
    const use = async () => {
      if (!v.videoWidth) return toast('The video is still loading', true);
      if (v.seeking) await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      if (grab) {
        v.pause();
        toast('Taking the frame…');
        try { return done(await grab(v.currentTime)); } catch (e) { return toast(e.message, true); }
      }
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
      cv.toBlob((b) => (b ? done(b) : toast("Couldn't grab that frame", true)), 'image/png');
    };
    openSheet(h('h3', {}, title), h('div', { class: 'media-big' }, v), slider,
      h('div', { class: 'row frame-bar' }, iconBtn('Back one frame', '⏮', () => step(-1)), lbl, iconBtn('Forward one frame', '⏭', () => step(1))),
      actions(button('Use this frame', use, { cls: 'primary' }), button('Cancel', () => done(null), { cls: 'ghost' })));
  });
}

// Frames out of a clip for a picture input. room: how many fit (1: Use this frame; more: Add this frame, as many as fit, then Done).
// Resolves with [{ frame (index), t, blob (the frame as shown, only asked for by wantBlob), thumb }], or null for Back. Last frame: the clip's end, as a pick by itself.
export function pickFrames({ url, title = 'Pick a frame', fps = 24, frames = 0, room = 1, wantBlob = false }) {
  const many = room > 1;
  return new Promise((resolve) => {
    const v = h('video', { src: `${url}#t=0.001`, muted: true, playsInline: true, preload: 'auto', class: 'frame-video' });
    const slider = h('input', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time' });
    const lbl = h('span', { class: 'timecode' }, fmtTime(0));
    const list = [];
    const strip = h('div', { class: 'frame-strip' });
    const doneBtn = button('Done', () => finish(list.length ? list : null), { cls: 'primary' });
    const seek = (t) => { v.currentTime = Math.max(0, Math.min(v.duration || 0, t)); };
    const step = (n) => { v.pause(); seek((frameIndex(v.currentTime, fps, frames) + n + 0.5) / fps); };
    const finish = (out) => { closeSheet(); resolve(out); };
    const draw = () => {
      strip.replaceChildren(...list.map((x) => h('span', { class: 'frame-chip' },
        h('button', { type: 'button', class: 'frame-chip-img', 'aria-label': `Go to frame ${x.frame}`, title: `Frame ${x.frame}`, onclick: () => seek(x.t) }, h('img', { src: x.thumb, alt: '' })),
        h('span', { class: 'frame-chip-n' }, `${x.frame}`),
        iconBtn(`Take out frame ${x.frame}`, '✕', () => { list.splice(list.indexOf(x), 1); draw(); }, { class: 'icon-btn st-frame-x' }))));
      doneBtn.firstChild.textContent = list.length ? `Done (${list.length})` : 'Done';
      doneBtn.disabled = !list.length;
    };
    v.addEventListener('loadedmetadata', () => { slider.max = v.duration; });
    v.addEventListener('timeupdate', () => { slider.value = v.currentTime; lbl.textContent = `${fmtTime(v.currentTime, fps)} / ${fmtTime(v.duration, fps)} · frame ${frameIndex(v.currentTime, fps, frames)}`; });
    v.addEventListener('error', () => toast("Couldn't load that video", true));
    slider.addEventListener('input', () => { v.pause(); seek(Number(slider.value)); });
    // the frame on show: its index and a small picture (and the whole frame, for a clip the server can't cut by index)
    const grabNow = async () => {
      if (!v.videoWidth) { toast('The video is still loading', true); return null; }
      v.pause();
      if (v.seeking) await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      const k = Math.min(1, 200 / Math.max(v.videoWidth, v.videoHeight)), small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(v.videoWidth * k)); small.height = Math.max(1, Math.round(v.videoHeight * k));
      small.getContext('2d').drawImage(v, 0, 0, small.width, small.height);
      const out = { frame: frameIndex(v.currentTime, fps, frames), t: v.currentTime, thumb: small.toDataURL('image/jpeg', 0.8) };
      if (wantBlob) {
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        cv.getContext('2d').drawImage(v, 0, 0);
        out.blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      }
      return out;
    };
    const lastFrame = async () => {
      if (!many) return finish([{ frame: 'last', t: 0, thumb: null }]);
      if (!v.duration) return toast('The video is still loading', true);
      seek(v.duration);
      await new Promise((r) => { if (v.seeking) v.addEventListener('seeked', r, { once: true }); else r(); });
      const f = await grabNow();
      if (!f) return;
      if (!addFrame(list, { ...f, frame: 'last' }, room)) return toast(`There's room for ${room} here: take one out first`, true);
      draw();
    };
    const add = async () => {
      const f = await grabNow();
      if (!f) return;
      if (!many) return finish([f]);
      if (!addFrame(list, f, room)) return toast(`There's room for ${room} here: take one out first`, true);
      draw();
    };
    openSheet(h('h3', {}, title), h('div', { class: 'media-big' }, v), slider,
      h('div', { class: 'row frame-bar' }, iconBtn('Back one frame', '⏮', () => step(-1)), lbl, iconBtn('Forward one frame', '⏭', () => step(1))),
      many ? strip : null,
      actions(button(many ? 'Add this frame' : 'Use this frame', add, { cls: many ? '' : 'primary' }),
        many ? doneBtn : null,
        !wantBlob ? button('Last frame', lastFrame, { cls: 'small' }) : null,
        button('Back', () => finish(null), { cls: 'ghost' })));
    draw();
  });
}

// ---------------------------------------------------------------------------
// image picker: a gallery of ComfyUI's input images and of history outputs, plus upload.
// Whatever is picked ends up as an image in ComfyUI's input folder, so onPick gets its name.
// multi: tap pictures to tick them (shift-click a run of them; limit: how many fit), then Add calls onPick for each, in the
// order ticked. Uploads, crops and the rest get ticked too. The ticks live on opts, so they survive the sheets that replace the picker.
// ---------------------------------------------------------------------------
const MP_INFO = 'The most megapixels the picture may have when it is used. A bigger one is resampled into a new, smaller copy, and the original stays. A smaller one is never made bigger. Full keeps it as it is. Lower sizes use less memory and load quicker, but give less detail: SHARP looks at a picture at 1536 px square, so below about 2.4 MP a splat starts to go softer.';
const mpKeyOf = (key) => `deck.picker.mp.${key}`;
// a picture's resampled copy, at most mp megapixels: the same name back when it already fits (main.resize_input)
export const resizeInput = (name, mp) => api('/api/inputs/resize', { method: 'POST', body: { name, mp, project_id: S.project } });
// the row of sizes: for a picture named here, or (with no name) for the one set() is told about; remembered per kind of work when key is given
export function maxMpRow(name, onPick, key = null, init = null) {
  const saved = key ? store.get(mpKeyOf(key), null) : null;
  let wh = null, cur = saved ?? 0;
  init?.(cur);
  const label = h('span', { class: 'hint' });
  const show = () => { label.textContent = wh ? capLabel(wh[0], wh[1], cur) : ''; };
  const row = seg(MP_STEPS, cur, (v) => { cur = v; if (key) store.set(mpKeyOf(key), v); show(); onPick(v); }, { wrap: true });
  if (name) { const im = new Image(); im.onload = () => { wh = [im.naturalWidth, im.naturalHeight]; show(); }; im.src = inputUrl(name); }
  return h('span', { class: 'pk-mp' }, h('span', { class: 'hint' }, 'Max MP'), row, label, info(MP_INFO, 'About the largest size'));
}
// before a 3D job that comes with a picture already chosen: the size to use it at. done(name) gets the copy, or the same name.
export function askMaxMp(name, done, key = '3d') {
  let mp = 0;
  const go = async () => {
    closeSheet();
    try { done(mp ? (await resizeInput(name, mp)).name : name); } catch (e) { toast(e.message, true); }
  };
  openSheet(h('h3', {}, 'Largest size for this picture'), h('div', { class: 'media-big' }, h('img', { src: inputUrl(name), alt: '' })),
    maxMpRow(name, (v) => { mp = v; }, key, (v) => { mp = v; }),
    actions(button('Cancel', closeSheet), button('Continue', go, { cls: 'primary' })));
}

export function openImagePicker(opts) {
  const { title, mp: callerMp = () => 0, onPick, limit = Infinity } = opts;
  // the largest size: chosen here (opts.maxMp, kept on opts so it survives the sheets that replace the picker; remembered per kind of
  // work with opts.mpKey), else what the caller asks for. A picture already in the inputs is only made smaller when it was chosen here.
  if (opts.maxMp === undefined) opts.maxMp = opts.mpKey ? store.get(mpKeyOf(opts.mpKey), null) : null;
  const mp = () => opts.maxMp ?? callerMp();
  const capped = async (name, info2) => {
    if (!opts.maxMp) return { name, info: info2 };
    const r = await resizeInput(name, opts.maxMp);
    return r.name === name ? { name, info: info2 } : { name: r.name, info: r };
  };
  const multi = !!opts.multi && limit > 1;
  const sel = multi ? (opts.sel ||= new Map()) : null;   // key -> item, in the order ticked
  let tab = store.get('deck.pickerTab2', 'project');
  if (tab !== 'project' && tab !== 'all' && !SOURCES.has(tab)) tab = 'project';
  let q = '';
  let inputs = null;
  const search = h('input', { type: 'text', placeholder: 'Filter by name…' });
  let max = null;   // the big view's full-screen toggle

  const remember = (name) => rememberRecent('image', { k: name, label: name.split('/').pop(), kind: 'img', src: thumbUrl(name), val: name });
  const full = () => toast(`There's room for ${limit} here: untick one first`, true);
  const picked = (name, info) => {
    if (multi) {
      if (tick(sel, { ...inputItem(name), get: async () => ({ name, info }) }, true, limit)) paintTicks(); else full();
      return;
    }
    max?.exit();
    remember(name);
    closeSheet();
    capped(name, info).then((r) => onPick(r.name, r.info)).catch((e) => toast(e.message, true));
  };
  // Add: every ticked picture, in order. Each one's copy is made now (a History output becomes an input only if it is used).
  const addTicked = async () => {
    const list = [...sel.values()];
    sel.clear();
    max?.exit();
    closeSheet();
    let n = 0;
    for (const it of list) {
      try {
        const r = await it.get();
        remember(r.name);
        const c = await capped(r.name, r.info);
        await onPick(c.name, c.info);
        n++;
      } catch (e) { toast(e.message, true); }
    }
    if (n) toast(n === 1 ? 'Added' : `Added ${n} pictures`);
  };
  const removeInput = async (n) => {
    if (!confirm(`Delete ${n.split('/').pop()} for good? Every copy goes (here and in ComfyUI), and its thumbnails.`)) return;
    try {
      await api(`/api/inputs?name=${encodeURIComponent(n)}`, { method: 'DELETE' });
      inputs = null; toast('Deleted'); draw();
    } catch (e) { toast(e.message, true); }
  };
  const historyGet = async (g, i, frame = 'last') => {
    const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST',
      body: { index: i, frame, mp: mp(), multiple: 16 } });
    return { name: r.name, info: r };
  };
  const fromHistory = async (g, i) => {
    try { const r = await historyGet(g, i); picked(r.name, r.info); } catch (e) { toast(e.message, true); }
  };
  const roomLeft = () => (multi ? limit - sel.size : 1);
  // a clip's frames, by the room this input has: one is used straight away; several are ticked, each made only if it's added
  const framesFrom = async (g, i, o) => {
    const room = roomLeft();
    if (room < 1) return full();
    const list = await pickFrames({ url: o.url, title: genLabel(g), fps: o.fps || 24, frames: o.frames || 0, room });
    if (list && !multi) {
      try { const r = await historyGet(g, i, list[0].frame); picked(r.name, r.info); } catch (e) { toast(e.message, true); openImagePicker(opts); }
      return;
    }
    if (list) for (const f of list) {
      tick(sel, { key: `g${g.id}.${i}@${f.frame}`, title: `${genLabel(g)} · ${f.frame === 'last' ? 'last frame' : `frame ${f.frame}`}`, thumb: f.thumb || previewUrl(o.url, 320),
        get: () => historyGet(g, i, f.frame) }, true, limit);
    }
    openImagePicker(opts);
  };

  // Each tab lists items for the big view: { key, title, thumb, full (what the big view shows), video?, cropSrc (a picture to crop), badge?, use(), get? (makes the picture: { name, info }; none: it needs a choice first, so it can't be ticked), del? }
  // This project: its uploads, editor saves and drawings plus everything it generated, newest first
  const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame', scene: '3d', smaller: 'smaller', 'edit-tab': 'edit tab', 'video-tab': 'video edit', story: 'story', link: 'link', camera: 'camera', vfx: 'vfx', sheet: 'sheet' };
  const inputItem = (n, badge = null) => ({ key: n, title: n.split('/').pop(), thumb: thumbUrl(n), full: inputUrl(n), cropSrc: inputUrl(n), badge,
    use: () => picked(n, { name: n }), get: async () => ({ name: n, info: { name: n } }), del: () => removeInput(n) });
  const projectItems = async () => {
    const items = inputs.project.filter((r) => r.source !== 'generation')
      .map((r) => ({ t: r.created, it: inputItem(r.name, SOURCE[r.source] || null) }));
    for (const { g, o, i, t } of await projectOutputs(['image', 'video'])) {
      items.push({ t, it: { key: `g${g.id}.${i}`, title: genLabel(g), run: { g, i }, thumb: previewUrl(o.url, 320), full: o.url, video: o.kind === 'video', cropSrc: o.kind === 'image' ? o.url : null,
        badge: o.kind === 'video' ? 'frames' : null, use: () => (o.kind === 'video' ? framesFrom(g, i, o) : fromHistory(g, i)), get: o.kind === 'video' ? null : () => historyGet(g, i), delNote: 'That one is in History: delete it there' } });
    }
    const every = items.sort((x, y) => y.t - x.t).map((x) => x.it), tags = tagsIn(every);
    if (opts.tag && !tags.includes(opts.tag)) opts.tag = null;   // (the last one with that tag was deleted)
    drawTags(tags);
    return byTag(every, opts.tag).slice(0, 300);   // (filtered first, so an old upload isn't lost behind 300 newer runs)
  };
  const allItems = () => inputs.all.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 400).map((n) => inputItem(n));

  // a registered source (registerPickerSource): its items for this project; Use picks the still, a frame, or asks
  const sourceItems = async (src) => {
    const take = async (it, frame, nested = false) => {
      try { const r = await src.pick(it, { mp: mp(), frame }); picked(r.name, r); } catch (e) { toast(e.message, true); }
      if (nested && multi) openImagePicker(opts);   // (the choice / frame sheet replaced the picker)
    };
    const frameOf = async (it) => {
      const room = roomLeft();
      if (room < 1) return full();
      const list = await pickFrames({ url: it.video, title: it.title, room, wantBlob: true });
      if (!list) return openImagePicker(opts);
      if (!multi) return take(it, list[0].blob, true);
      for (const f of list) {
        tick(sel, { key: `${src.key}.${it.id}@${f.frame}`, title: `${it.title} · frame ${f.frame}`, thumb: f.thumb,
          get: async () => { const r = await src.pick(it, { mp: mp(), frame: f.blob }); return { name: r.name, info: r }; } }, true, limit);
      }
      openImagePicker(opts);
    };
    const use = (it) => {
      if (it.video && it.still) {
        openSheet(h('h3', {}, it.title), h('div', { class: 'media-big' }, h('img', { src: it.thumb, alt: '' })),
          actions(button('Use the saved still', () => { closeSheet(); take(it, null, true); }, { cls: 'primary' }),
            button('Pick a frame…', () => frameOf(it)), button('Back', () => openImagePicker(opts), { cls: 'ghost' })));
      } else if (it.video) frameOf(it);
      else take(it, null);
    };
    return (await src.list(S.project)).map((it) => ({ key: String(it.id), title: it.title, thumb: it.thumb, full: it.thumb || it.video,
      video: !it.thumb, cropSrc: it.thumb && !it.video ? it.thumb : null, badge: it.badge || null, use: () => use(it),
      get: it.video ? null : async () => { const r = await src.pick(it, { mp: mp(), frame: null }); return { name: r.name, info: r }; } }));
  };
  const EMPTY = { project: 'Nothing in this project yet. Upload, draw, or pick from All inputs.', all: 'No input images match.' };

  // the project tab's filter, one tag at a time. It lives on opts, so it survives the sheets that replace the picker.
  const tagRow = h('div', { class: 'chips pk-tags' });
  const setTag = (t) => { opts.tag = t; draw(); };
  const drawTags = (tags) => tagRow.replaceChildren(chip('All', () => setTag(null), { on: !opts.tag }), ...tags.map((t) => chip(t, () => setTag(t), { on: opts.tag === t })));
  const projName = (S.projects.find((p) => p.id === S.project) || {}).name || 'This project';
  const tabs = seg([['project', projName], ['all', 'All inputs'], ...[...SOURCES.values()].map((x) => [x.key, x.label])], tab, (t) => { tab = t; store.set('deck.pickerTab2', t); curKey = null; draw(); });
  const onFiles = async (files, source = 'upload') => {
    toast(`Uploading ${files.length}…`);
    for (const fl of files) {
      if (multi && sel.size >= limit) { full(); break; }
      try {
        const r = await uploadImage(fl, { mp: mp(), source });
        inputs = null;
        picked(r.name, r);
        if (!multi) return;
      } catch (e) { toast('Upload failed: ' + e.message, true); return; }
    }
    draw();
  };
  const useCurrentEdit = async () => {
    const eng = CURRENT.eng;
    if (eng.loading()) return toast('The edit\'s images are still loading', true);
    try {
      const blob = await eng.blob();
      if (!blob) return toast('The edit has no pictures yet', true);
      const r = await uploadImage(blob, { mp: mp(), source: 'editor', filename: 'editor.png' });
      inputs = null;
      picked(r.name, r);
    } catch (e) { toast(`Couldn't export the edit: ${e.message}`, true); }
  };
  const reopen = () => openImagePicker(opts);
  const webcam = button('📷 Camera', () => takePhoto({ back: reopen, onFile: async (f) => { await onFiles([f], 'camera'); if (multi) reopen(); } }),
    { cls: 'small hidden', title: 'Take a picture with the webcam' });
  if (desktop()) hasWebcam().then((y) => webcam.classList.toggle('hidden', !y));

  // the big view with ‹ › (swipe, ← →), what the picture can do, and the rows of what there is
  let items = [], cur = 0, curKey = null;
  const main = h('div', { class: 'gal-main' });
  const prev = h('button', { type: 'button', class: 'gal-nav prev', 'aria-label': 'Previous', onclick: () => go(-1) }, '‹');
  const next = h('button', { type: 'button', class: 'gal-nav next', 'aria-label': 'Next', onclick: () => go(1) }, '›');
  const stage = h('div', { class: 'gal-stage pk-stage' }, main, prev, next);
  const zoom = zoomPan(main, () => main.firstElementChild, { swipe: (d) => go(d) });
  const name = h('span', { class: 'pk-name' });
  // multi: adds what is ticked, or the picture on show when nothing is. One that needs a choice (a clip's frame) asks first, and is ticked after.
  const useCurrent = () => {
    const it = items[cur];
    if (!multi) return it?.use();
    if (sel.size) return addTicked();
    if (it && !it.get) return it.use();
    if (it) { tick(sel, it, true, limit); addTicked(); }
  };
  const useBtn = button('Use this picture', useCurrent, { cls: 'primary' });
  // (what's ticked waits on Add; a clip on show can still give more frames)
  const moreBtn = multi ? button('Choose frames…', () => items[cur]?.use(), { cls: 'small' }) : null;
  const clearBtn = multi ? button('Clear', () => { sel.clear(); paintTicks(); }, { cls: 'small ghost', title: 'Untick every picture' }) : null;
  const delBtn = button('Delete…', () => { const it = items[cur]; if (it.del) it.del(); else toast(it.delNote, true); },
    { cls: 'small danger', title: 'Delete this picture for good (uploads and saved pictures, not History)' });
  // Crop…: cut the picture on show first (a new copy is the one picked); Cancel comes back here
  const cropBtn = button('Crop…', async () => {
    const it = items[cur];
    max?.exit();
    const img = new Image();
    img.src = it.cropSrc;
    const { openCrop } = await import('./editor.js');   // (it imports this file)
    openCrop({ img, onCancel: reopen, onApply: async (c) => {
      try {
        const W = img.naturalWidth, H = img.naturalHeight, cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(c.w * W)); cv.height = Math.max(1, Math.round(c.h * H));
        cv.getContext('2d').drawImage(img, c.x * W, c.y * H, c.w * W, c.h * H, 0, 0, cv.width, cv.height);
        const blob = await pngBlob(cv);
        if (!blob) throw new Error('Couldn\'t cut that picture');
        const r = await uploadImage(blob, { mp: mp(), source: 'crop' });
        inputs = null;
        picked(r.name, r);
        if (multi) reopen();
      } catch (e) { toast(e.message, true); reopen(); }
    } });
  }, { cls: 'small', title: 'Cut the picture first: the cropped copy is the one picked (the original stays)' });
  // what the picture on show is, and what it will be used at
  const mpLabel = h('span', { class: 'hint' });
  let shownWH = null;
  // (a picture already in the inputs only comes down when it was chosen here; a run's or an upload's follows the caller too)
  const capNow = () => (items[cur]?.del ? opts.maxMp || 0 : mp() || 0);
  const showMp = () => { mpSeg.set(capNow()); mpLabel.textContent = shownWH ? capLabel(shownWH[0], shownWH[1], capNow()) : ''; };
  const mpSeg = seg(MP_STEPS, opts.maxMp ?? 0, (v) => { opts.maxMp = v; if (opts.mpKey) store.set(mpKeyOf(opts.mpKey), v); showMp(); }, { wrap: true });
  const mpRow = h('span', { class: 'pk-mp' }, h('span', { class: 'hint' }, 'Max MP'), mpSeg, mpLabel, info(MP_INFO, 'About the largest size'));
  const bar = h('div', { class: 'gal-actions pk-actions' }, name, mpRow, useBtn, moreBtn, clearBtn, cropBtn, delBtn);
  const runRow = h('div', { class: 'strip gal-run' });   // the files its run made, and what to do with its clip (run-bar.js)
  const showRun = (it) => {
    if (!it?.run) return runRow.replaceChildren();
    const { g, i } = it.run, keyOf = (n) => `g${g.id}.${n}`;
    runBar(runRow, g, i, { has: (n) => items.some((x) => x.key === keyOf(n)), onPick: (n) => select(items.findIndex((x) => x.key === keyOf(n))),
      before: () => { max?.exit(); closeSheet(); } });
  };
  // pull this grip down to give the big picture the room (all the way shuts the rows), up for more of them
  const grip = h('div', { class: 'pk-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the rows of pictures', title: 'Drag down for a bigger picture, up for more pictures (double-tap resets)' }, h('span'));
  const rows = h('div', { class: 'pk-rows', role: 'listbox', 'aria-label': 'Pictures', 'aria-multiselectable': multi ? 'true' : null });
  // the ticks on the rows (with their order) and on the button
  function paintTicks() {
    if (!multi) return;
    const order = [...sel.keys()], n = order.length, it = items[cur];
    useBtn.firstChild.textContent = n > 1 ? `Add ${n} pictures` : n ? 'Add 1 picture' : it && !it.get ? (it.video ? 'Choose frames…' : 'Choose…') : 'Add this picture';
    moreBtn.firstChild.textContent = it?.video ? 'Choose frames…' : 'Choose…';
    moreBtn.classList.toggle('hidden', !(n && it && !it.get));
    useBtn.disabled = !it && !n;
    clearBtn.classList.toggle('hidden', !n);
    if (rows.children.length !== items.length) return;
    [...rows.children].forEach((c, k) => {
      const at = order.indexOf(items[k].key);
      c.classList.toggle('picked', at >= 0);
      c.setAttribute('aria-selected', at >= 0);
      c.querySelector('.pk-n')?.remove();
      if (at >= 0) c.append(h('span', { class: 'pk-n' }, `${at + 1}`));
    });
  }
  // a tap ticks or unticks; shift ticks the run from the last one tapped
  let anchor = null;
  const tapTick = (n, e) => {
    const it = items[n];
    if (!it.get) return;
    if (e.shiftKey && anchor != null) { if (!tickRange(sel, items, anchor, n, limit)) full(); }
    else if (!tick(sel, it, !sel.has(it.key), limit)) full();
    anchor = n;
    paintTicks();
  };
  const ROWS = 'deck.picker.rows';
  const setRows = (px) => {
    store.set(ROWS, px);
    rows.style.maxHeight = px == null ? '' : `${px}px`;
    rows.classList.toggle('shut', px === 0);
  };
  heightGrip(grip, { size: () => rows.offsetHeight, set: setRows });
  setRows(store.get(ROWS, null));
  const go = (d) => { if (items.length) select(Math.max(0, Math.min(items.length - 1, cur + d))); };
  const select = (n) => {
    cur = n; const it = items[n]; curKey = it?.key ?? null;
    zoom.reset();
    main.replaceChildren(...(!it ? [] : [it.video && it.full ? h('video', { src: it.full, controls: true, muted: true, loop: true, playsInline: true, autoplay: true })
      : h('img', { src: it.full || it.thumb, alt: it.title, draggable: false, onload: (e) => { if (items[cur] === it && it.cropSrc === it.full && !SOURCES.has(tab)) { shownWH = [e.target.naturalWidth, e.target.naturalHeight]; showMp(); } } })]));
    shownWH = null; showMp();
    prev.disabled = n <= 0; next.disabled = n >= items.length - 1;
    name.textContent = it ? `${it.title}${it.badge ? ` · ${it.badge}` : ''}  (${n + 1} / ${items.length})` : '';
    if (!multi) useBtn.firstChild.textContent = it?.video ? 'Choose a frame…' : 'Use this picture';
    useBtn.disabled = !it; delBtn.classList.toggle('hidden', !it); cropBtn.classList.toggle('hidden', !it?.cropSrc);
    showRun(it);
    [...rows.children].forEach((c, k) => { c.classList.toggle('sel', k === n); c.setAttribute('aria-selected', k === n); });
    rows.children[n]?.scrollIntoView({ block: 'nearest' });
    paintTicks();
  };
  const draw = async () => {
    search.classList.toggle('hidden', tab !== 'all');
    tagRow.classList.toggle('hidden', tab !== 'project');
    rows.replaceChildren(placeholder('Loading…'));
    try {
      if (SOURCES.has(tab)) items = await sourceItems(SOURCES.get(tab));
      else {
        inputs ||= await api(`/api/inputs${S.project != null ? `?project_id=${S.project}` : ''}`);
        items = tab === 'project' ? await projectItems() : allItems();
      }
    } catch (e) { items = []; rows.replaceChildren(note(e.message, 'err')); select(0); return; }
    if (!items.length) { rows.replaceChildren(placeholder(EMPTY[tab] || `Nothing in ${SOURCES.get(tab).label.toLowerCase()} for this project yet.`)); select(0); return; }
    rows.replaceChildren(...items.map((it, n) => {
      const t = h('button', { type: 'button', class: 'pk-thumb', role: 'option', title: it.title, 'aria-label': it.title, onclick: (e) => { select(n); if (multi) tapTick(n, e); },
        ondblclick: () => { if (!multi) return it.use(); if (!it.get) return it.use(); if (tick(sel, it, true, limit)) addTicked(); else full(); } },
        it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy' }) : placeholder('…'), it.badge ? h('span', { class: 'play' }, it.badge) : null);
      return t;
    }));
    select(Math.max(0, items.findIndex((x) => x.key === curKey)));
  };
  const seq = openSheet(h('h3', {}, title), h('div', { class: 'picker-bar' }, [tabs, h('span', { class: 'picker-break' }),
    currentEditReady() ? button('Current edit', useCurrentEdit, { cls: 'small primary', title: 'Export the picture open in the Image tab right now and use it' }) : null,
    fileButton('Upload…', onFiles, { accept: 'image/*', multiple: multi, cls: 'small primary' }),
    desktop() ? webcam : fileButton('📷 Camera', (fs) => onFiles(fs, 'camera'), { accept: 'image/*', capture: 'environment' }),
    button('From a video link…', () => import('./clipimport.js').then((m) => m.openLinkStill({ back: reopen,
      onFrame: async (blob) => { await onFiles([new File([blob], 'link.png', { type: 'image/png' })], 'link'); if (multi) reopen(); } })),
    { cls: 'small', title: 'A frame from a YouTube (or other) video' })]), stage, runRow, bar, grip, tagRow, rows);
  $('#sheet').classList.add('picker-full');   // the whole screen, like the board's gallery
  max = maximizable($('#sheet'), stage, { title: 'Full screen the picture' });   // just the picture
  draw.seq = seq;
  PK = { seq, go, use: useCurrent, tick: () => { if (multi && items[cur]) tapTick(cur, {}); } };
  draw();
  search.addEventListener('input', () => { q = search.value.toLowerCase(); curKey = null; draw(); });
  dropPictures(seq, onFiles);
  const strip = recentStrip('image', (name) => picked(name, { name }));
  strip.after(search);
  search.classList.toggle('hidden', tab !== 'all');
}

// ← → move through the open image picker's pictures, Enter uses the one on show (or adds the ticked ones), Space ticks it
let PK = null;
document.addEventListener('keydown', (e) => {
  if (!PK || !sheetStillOpen(PK.seq) || e.target.closest('input, textarea, select, button, a') || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); PK.go(e.key === 'ArrowLeft' ? -1 : 1); }
  else if (e.key === 'Enter') { e.preventDefault(); PK.use(); }
  else if (e.key === ' ') { e.preventDefault(); PK.tick(); }
});

// a canvas as a PNG Blob (null when the canvas is empty)
export const pngBlob = (cv) => new Promise((res) => cv.toBlob(res, 'image/png'));

// Upload a File/Blob to ComfyUI's input folder, tagged with the open project.
export function uploadImage(blob, { mp = 0, source = 'upload', filename = 'image.png', multiple = 16, origin = null, board = '' } = {}) {
  const fd = new FormData();
  fd.append('file', blob, blob.name || filename); fd.append('mp', mp); fd.append('multiple', multiple);
  fd.append('source', source);
  if (origin) fd.append('origin', JSON.stringify(origin));
  if (board) fd.append('board', board);   // a name: it also shows on the Board (main.saved_run)
  if (S.project != null) fd.append('project_id', S.project);
  return api('/api/upload', { method: 'POST', form: fd });
}

export function mediaEl(o, { controls = true, thumb = false } = {}) {
  if (thumb && (o.kind === 'video' || o.kind === 'image') && o.url?.startsWith('/files/')) {   // a grid card: the light still
    return h('img', { src: previewUrl(o.url, 320), alt: o.filename || '', loading: 'lazy' });
  }
  if (o.kind === 'video') {
    return h('video', { src: thumb ? `${o.url}#t=0.1` : o.url, muted: true, loop: true, playsInline: true, autoplay: !thumb, controls: controls && !thumb, preload: thumb ? 'metadata' : 'auto' });
  }
  if (o.kind === 'audio') return h('audio', { src: o.url, controls: true });
  if (o.kind === 'image') return h('img', { src: o.url, alt: o.filename, loading: 'lazy' });
  return kindTile(o);   // a motion, a 3D model, a file: what it is and its facts (Download has the file)
}
