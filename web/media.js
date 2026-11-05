import {
  h, store, api, toast, openSheet, closeSheet, button, chip, iconBtn, actions, seg, placeholder, note, mediaCard, field, pickButtons, info,
} from './ui.js';
import { fmtTime } from './playback.js';
import { MP_STEPS, capLabel } from './mp-cap.js';
import { cardPicture, kindTile, madeBy } from './kinds.js';
import { S, listedRun, PICKER_SOURCES as SOURCES, inputUrl, previewUrl, switchTab, templateName } from './core.js';
import { fmtDur, runTime } from './run-state.js';
import { fetchHistory as loadHistory } from './generation-data.js';
import { tick, addFrame, frameIndex } from './pick-slots.js';

// This project's finished outputs of the given kinds, newest first: [{ g, o, i, t }]
export async function projectOutputs(kinds) {
  if (!S.history.size) await loadHistory();
  const items = [];
  for (const g of S.history.values()) {
    if (g.project_id !== S.project || g.status !== 'done' || !listedRun(g)) continue;
    g.outputs.forEach((o, i) => { if (kinds.includes(o.kind)) items.push({ g, o, i, t: g.finished || g.created }); });
  }
  return items.sort((x, y) => y.t - x.t);
}
// a run by its template, an imported file by its name
export const genLabel = (g) => `#${g.id} ${(g.template === 'import' || g.template === 'saved') && g.params?.label ? g.params.label : madeBy(g) || templateName(g.template)}`;
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
    try { const cards = await load(); grid.replaceChildren(...[cards].flat(Infinity).filter(Boolean)); }
    catch (e) { grid.replaceChildren(note(e.message, 'err')); }
  };
  draw.seq = openSheet(h('h3', {}, title), h('div', { class: 'picker-bar' }, bar), grid);
  draw();
  return draw;
}

export const uploadMedia = (file) => { const form = new FormData(); form.append('file', file); return api('/api/media', { method: 'POST', form }); };

// The pickers are source-picker.js openSourcePicker; these keep their old signatures (it is loaded when one opens: it imports this file).
const viaPicker = (opts) => import('./source-picker.js').then((m) => m.openSourcePicker(opts));
export const openImagePicker = (opts) => viaPicker(Object.assign(opts, { kinds: ['image'], want: 'picture' }));
export const openVideoPicker = ({ title, onPick }) => viaPicker({ title, onPick, kinds: ['video'], want: 'clip' });
// Sounds, and clips (their sound is used) unless clips is false. onPick gets a source: {generation, index} | {media}.
export const openSoundPicker = ({ title = 'Pick a sound', onPick, clips = true }) => viaPicker({ title, onPick, kinds: clips ? ['audio', 'video'] : ['audio'], want: 'sound' });

// ---- clip and sound sources: {generation, index} for an output, {media} for a file in the media library ----
// (a picked one may also carry trim, crop and a label)
export function bareSource(v) { return v.generation != null ? { generation: v.generation, index: v.index || 0 } : { media: v.media }; }
// where a clip source plays, from the history loaded so far (null: not loaded, or gone)
export function clipUrl(v) {
  if (!v) return null;
  if (v.generation != null) return S.history.get(v.generation)?.outputs[v.index || 0]?.url || null;
  return v.media ? `/files/media/${encodeURIComponent(v.media)}` : null;
}
// where a timeline item (video.js / sound.js items[]) plays: its source's current url, else the one it was saved with
export const itemUrl = (it) => (it ? clipUrl(it.src) || it.url || null : null);
// ---- grab a frame: a still of a clip, into the inputs ----
// what: a video frame on a table (its first clip: frame-source.js frameClip), or a clip source ({generation, index} |
// {media}, optional trim {start, len}, or with its url). at: seconds in the clip's own time; its in point when not given.
// Resolves the input's name (also as grabFrame.last = { name, width, height, at, label } for whoever wants the size).
export async function grabFrame(what, { at = null, mp = 0 } = {}) {
  let src = what, label = what?.label || '';
  if (what?.kind && what.id != null && !('generation' in what) && !('media' in what)) {   // (a table frame)
    const { frameClip } = await import('./frame-source.js');
    const c = await frameClip(what);
    if (!c) throw new Error(`${what.label || 'That frame'} has no clip yet`);
    src = c.src || c; label = what.label || c.label || label;
  }
  let url = src.url || clipUrl(src);
  if (!url && src.generation != null) {
    const g = await api(`/api/generations/${src.generation}`, { busy: false });
    S.history.set(g.id, g);
    url = g.outputs?.[src.index || 0]?.url;
  }
  if (!url) throw new Error('That clip can\'t be played here');
  const t = Math.max(0, at ?? src.trim?.start ?? 0);
  const blob = await stillAt(url, t);
  const r = await uploadImage(blob, { mp, source: 'grab', filename: 'frame.png', multiple: 1 });
  grabFrame.last = { name: r.name, width: r.width, height: r.height, at: t, label };
  return r.name;
}
// the picture of a video at t seconds, as a PNG Blob
function stillAt(url, t) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const end = (err, blob) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); if (err) reject(err); else resolve(blob); };
    const timer = setTimeout(() => end(new Error('The clip took too long to load')), 20000);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.onerror = () => end(new Error('Couldn\'t load that clip'));
    v.onloadedmetadata = () => { v.currentTime = Math.min(t, Math.max(0, (v.duration || t) - 0.04)); };
    v.onseeked = () => {
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      if (!cv.width) return end(new Error('That clip has no picture'));
      cv.getContext('2d').drawImage(v, 0, 0);
      cv.toBlob((b) => (b ? end(null, b) : end(new Error('Couldn\'t grab that frame'))), 'image/png');
    };
    v.src = url;
  });
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
  if (document.querySelector('#tab-table.active, #tab-table.live-host')) return soundFrameFrom(source, { trim, name });   // (never another screen from the table)
  try {
    const m = await api('/api/audio/extract', { method: 'POST', body: { source, trim, name }, busy: 'Taking the sound out…', timeout: 600000 });
    switchTab('sound');
    await (await import('./sound.js')).addToSound({ media: m.name });
    toast(`${m.label} is on the Sound tab (and in the media library)`);
    return m;
  } catch (e) { toast('Couldn\'t take the sound out: ' + e.message, true); return null; }
}

// On the table: a clip's sound taken out as a new sound frame beside near (the frame it came from; else beside the
// selection). Resolves the frame, or null (a toast says why)
export async function soundFrameFrom(source, { trim = null, name = null, near = null } = {}) {
  try {
    const m = await api('/api/audio/extract', { method: 'POST', body: { source, trim, name }, busy: 'Taking the sound out…', timeout: 600000 });
    const f = await (await import('./edit-ops.js')).frameBeside(near, { media: m.name, kind: 'audio', url: m.url, label: m.label }, { label: m.label });
    if (!f) throw new Error('it couldn\'t go on the table (it is in the media library)');
    toast(`${m.label} is a new sound frame`);
    return f;
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
export const MP_INFO = 'The most megapixels the picture may have when it is used. A bigger one is resampled into a new, smaller copy, and the original stays. A smaller one is never made bigger. Full keeps it as it is. Lower sizes use less memory and load quicker, but give less detail: SHARP looks at a picture at 1536 px square, so below about 2.4 MP a splat starts to go softer.';
export const mpKeyOf = (key) => `deck.picker.mp.${key}`;
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

// a cut of a loaded picture as a new picture of its own (the original stays)
export async function cropCopy(img, c, mp = 0) {
  const W = img.naturalWidth, H = img.naturalHeight, cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(c.w * W)); cv.height = Math.max(1, Math.round(c.h * H));
  cv.getContext('2d').drawImage(img, c.x * W, c.y * H, c.w * W, c.h * H, 0, 0, cv.width, cv.height);
  const blob = await pngBlob(cv);
  if (!blob) throw new Error('Couldn\'t cut that picture');
  return uploadImage(blob, { mp, source: 'crop' });
}

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
