import {
  $, h, store, api, toast, openSheet, closeSheet, button, iconBtn, actions, fileButton, seg, placeholder, note, mediaCard,
} from './ui.js';
import { S, PICKER_SOURCES as SOURCES, thumbUrl } from './core.js';
import { loadHistory } from './run.js';

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
export const genLabel = (g) => `#${g.id} ${g.template}`;
// a card's picture: a thumbnail, or a note for sound
export const cardMedia = (o) => (o.kind === 'audio' ? h('span', { class: 'placeholder' }, '♪') : mediaEl(o, { thumb: true }));

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
      ({ t, el: () => mediaCard(mediaEl(o, { thumb: true }), genLabel(g), () => picked({ generation: g.id, index: i })) }));
    for (const m of media) items.push({ t: m.created, el: () => mediaCard(mediaEl(m, { thumb: true }), m.label, () => picked({ media: m.name })) });
    items.sort((x, y) => y.t - x.t);
    return items.length ? items.slice(0, 300).map((x) => x.el()) : placeholder('No videos in this project yet. Generate one or upload a clip.');
  });
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
// Resolves a PNG Blob of the shown frame, or null on Cancel (Back, if given, runs after).
export function pickFrame({ url, title = 'Pick a frame', fps = 24, back = null }) {
  return new Promise((resolve) => {
    const v = h('video', { src: `${url}#t=0.001`, muted: true, playsInline: true, preload: 'auto', class: 'frame-video' });
    const slider = h('input', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time' });
    const lbl = h('span', { class: 'hint' }, '0.00s');
    const seek = (t) => { v.currentTime = Math.max(0, Math.min(v.duration || 0, t)); };
    const step = (n) => { v.pause(); seek(v.currentTime + n / fps); };
    v.addEventListener('loadedmetadata', () => { slider.max = v.duration; });
    v.addEventListener('timeupdate', () => { slider.value = v.currentTime; lbl.textContent = `${v.currentTime.toFixed(2)}s / ${(v.duration || 0).toFixed(2)}s`; });
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
      h('div', { class: 'row frame-bar' }, iconBtn('Back one frame', '◀', () => step(-1)), lbl, iconBtn('Forward one frame', '▶', () => step(1))),
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
  const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame', scene: '3d', 'edit-tab': 'edit tab', 'video-tab': 'video edit' };
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
  const draw = pickerSheet(title, [tabs,
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
  if (o.kind === 'video') {
    return h('video', { src: thumb ? `${o.url}#t=0.1` : o.url, muted: true, loop: true, playsInline: true, autoplay: !thumb, controls: controls && !thumb, preload: thumb ? 'metadata' : 'auto' });
  }
  if (o.kind === 'audio') return h('audio', { src: o.url, controls: true });
  if (o.kind === 'image') return h('img', { src: o.url, alt: o.filename, loading: 'lazy' });
  return h('a', { href: o.url, target: '_blank' }, o.filename);
}
