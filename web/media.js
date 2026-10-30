import {
  $, h, store, api, toast, openSheet, closeSheet, button, iconBtn, actions, fileButton, seg, placeholder, note, mediaCard, field, pickButtons,
} from './ui.js';
import { fmtTime } from './playback.js';
import { cardPicture, kindTile } from './kinds.js';
import { S, CURRENT_EDIT as CURRENT, PICKER_SOURCES as SOURCES, previewUrl, switchTab, thumbUrl } from './core.js';
import { fmtDur, loadHistory, runTime } from './run.js';

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
export const genLabel = (g) => `#${g.id} ${g.template === 'import' && g.params?.label ? g.params.label : g.template}`;
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
  openSheet(h('h3', {}, title), h('div', { class: 'picker-bar' }, bar), grid);
  draw();
  return draw;
}

export const uploadMedia = (file) => { const form = new FormData(); form.append('file', file); return api('/api/media', { method: 'POST', form }); };

// this project's video outputs, newest first, plus the Video tab's uploaded clips
export function openVideoPicker({ title, onPick }) {
  const picked = (val) => { closeSheet(); onPick(val); };
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
    for (const m of media) items.push({ t: m.created, el: () => mediaCard(cardMedia(m), m.label, () => picked({ media: m.name }), { badge: '▶' }) });
    items.sort((x, y) => y.t - x.t);
    return items.length ? items.slice(0, 300).map((x) => x.el()) : placeholder('No videos in this project yet. Generate one or upload a clip.');
  });
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
    const card = (o, label, src) => ({ t: o.t, el: () => mediaCard(cardMedia(o), label, () => picked(src)) });
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
// Resolves a PNG Blob of the shown frame, or null on Cancel (Back, if given, runs after).
export function pickFrame({ url, title = 'Pick a frame', fps = 24, back = null }) {
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

// ---------------------------------------------------------------------------
// image picker: a gallery of ComfyUI's input images and of history outputs, plus upload.
// Whatever is picked ends up as an image in ComfyUI's input folder, so onPick gets its name.
// multi: keep the sheet open and call onPick for every tap (the editor adds several at once).
// ---------------------------------------------------------------------------
export function openImagePicker(opts) {
  const { title, mp = () => 0, onPick, multi = false } = opts;
  let tab = store.get('deck.pickerTab2', 'project');
  if (tab !== 'project' && tab !== 'all' && !SOURCES.has(tab)) tab = 'project';
  let q = '';
  let inputs = null;
  const search = h('input', { type: 'text', placeholder: 'Filter by name…' });

  const picked = (name, info, card) => {
    if (!multi) { closeSheet(); onPick(name, info); return; }
    onPick(name, info);
    if (card) card.classList.add('picked');
    toast('Added');
  };
  const inputCard = (n, badge) => mediaCard(h('img', { src: thumbUrl(n), alt: n, loading: 'lazy' }), n.split('/').pop(),
    (c) => picked(n, { name: n }, c), { badge });
  const fromHistory = async (g, i, c) => {
    try {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST',
        body: { index: i, frame: 'last', mp: mp(), multiple: 16 } });
      picked(r.name, r, c);
    } catch (e) { toast(e.message, true); }
  };

  // This project: its uploads, editor saves and drawings plus everything it generated, newest first
  const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame', scene: '3d', 'edit-tab': 'edit tab', 'video-tab': 'video edit', story: 'story' };
  const projectCards = async () => {
    const items = inputs.project.filter((r) => r.source !== 'generation')
      .map((r) => ({ t: r.created, el: () => inputCard(r.name, SOURCE[r.source] || null) }));
    for (const { g, o, i, t } of await projectOutputs(['image', 'video'])) {
      items.push({ t, el: () => mediaCard(mediaEl(o, { thumb: true }), genLabel(g), (c) => fromHistory(g, i, c),
        { badge: o.kind === 'video' ? 'last frame' : null }) });
    }
    items.sort((x, y) => y.t - x.t);
    return items.length ? items.slice(0, 300).map((x) => x.el()) : placeholder('Nothing in this project yet. Upload, draw, or pick from All inputs.');
  };
  const allCards = () => {
    const list = inputs.all.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 400);
    return list.length ? list.map((n) => inputCard(n)) : placeholder('No input images match.');
  };

  // a registered source (registerPickerSource): its items for this project; a tap picks the still, a frame, or asks
  const sourceCards = async (src) => {
    const items = await src.list(S.project);
    const take = async (it, frame, c, nested = false) => {
      try { const r = await src.pick(it, { mp: mp(), frame }); picked(r.name, r, c); } catch (e) { toast(e.message, true); }
      if (nested && multi) openImagePicker(opts);   // (the choice / frame sheet replaced the picker)
    };
    const frameOf = async (it, c) => {
      const f = await pickFrame({ url: it.video, title: it.title, back: () => openImagePicker(opts) });
      if (f) take(it, f, c, true);
    };
    const tap = (it, c) => {
      if (it.video && it.still) {
        openSheet(h('h3', {}, it.title), h('div', { class: 'media-big' }, h('img', { src: it.thumb, alt: '' })),
          actions(button('Use the saved still', () => { closeSheet(); take(it, null, c, true); }, { cls: 'primary' }),
            button('Pick a frame…', () => frameOf(it, c)), button('Back', () => openImagePicker(opts), { cls: 'ghost' })));
      } else if (it.video) frameOf(it, c);
      else take(it, null, c);
    };
    return items.length ? items.map((it) => mediaCard(it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy' }) : placeholder('…'), it.title,
      (c) => tap(it, c), { badge: it.badge || null })) : placeholder(`Nothing in ${src.label.toLowerCase()} for this project yet.`);
  };

  const projName = (S.projects.find((p) => p.id === S.project) || {}).name || 'This project';
  const tabs = seg([['project', projName], ['all', 'All inputs'], ...[...SOURCES.values()].map((x) => [x.key, x.label])], tab, (t) => { tab = t; store.set('deck.pickerTab2', t); draw(); });
  const onFiles = async (files) => {
    toast(`Uploading ${files.length}…`);
    for (const fl of files) {
      try {
        const r = await uploadImage(fl, { mp: mp(), source: 'upload' });
        inputs = null;
        picked(r.name, r, null);
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
      picked(r.name, r, null);
    } catch (e) { toast(`Couldn't export the edit: ${e.message}`, true); }
  };
  const draw = pickerSheet(title, [tabs,
    currentEditReady() ? button('Current edit', useCurrentEdit, { cls: 'small primary', title: 'Export the picture open in the Editor right now and use it' }) : null,
    fileButton('Upload…', onFiles, { accept: 'image/*', multiple: multi, cls: 'small primary' }),
    fileButton('📷 Camera', onFiles, { accept: 'image/*', capture: 'environment' }),
    multi ? button('Done', closeSheet) : null], async () => {
    search.classList.toggle('hidden', tab !== 'all');
    if (SOURCES.has(tab)) return sourceCards(SOURCES.get(tab));
    inputs ||= await api(`/api/inputs${S.project != null ? `?project_id=${S.project}` : ''}`);
    return tab === 'project' ? projectCards() : allCards();
  });
  search.addEventListener('input', () => { q = search.value.toLowerCase(); draw(); });
  $('#sheet .picker-bar').after(search);
  search.classList.toggle('hidden', tab !== 'all');
}

// Upload a File/Blob to ComfyUI's input folder, tagged with the open project.
export function uploadImage(blob, { mp = 0, source = 'upload', filename = 'image.png' } = {}) {
  const fd = new FormData();
  fd.append('file', blob, blob.name || filename); fd.append('mp', mp); fd.append('multiple', 16);
  fd.append('source', source);
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
