// What a frame on the table is made of, apart from where it sits: its element (a label bar over a still, a placeholder
// or a note's text), the saved document it owns (made, copied, trashed and restored through app/store.py), the stills
// those documents keep, and frames made from things dropped on the table (a picture, a clip, a sound, a file).
// table.js places and drives the frames; table-model.js has their geometry.
import { h, api, store, icon, uid, clone } from './ui.js';
import { S, inputUrl, thumbUrl } from './core.js';
import { BLANK } from './editor-engine.js';
import { uploadImage, uploadMedia } from './media.js';
import { dropKind } from './drop-files.js';
import { DOC_KIND, KIND_LABEL, newFrame } from './table-model.js';
import { owedFor } from './owed-runs.js';
import { emptyPayload } from './empty-docs.js';

export const KIND_ICON = { image: 'image', video: 'film', scene: 'cube', sound: 'sound', note: 'text' };
const SOUND_SIZE = { w: 1024, h: 256 };   // a sound frame is a strip: its waveform, not a picture

// ---- documents ----
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id = '', tail = '') => `/api/store/${DOC_KIND[kind] || kind}${id ? `/${id}` : ''}${tail}${qs()}`;

// A new document's payload for a frame kind: the same empty shape each screen's TabSet adapter makes (empty-docs.js is
// where video.js, sound.js and scene-data.js take theirs from; the image one is editor-engine.js BLANK).
export function blankPayload(kind) {
  if (kind === 'image') return BLANK();
  return emptyPayload(kind);
}

// Make the frame's document (named after the frame) and return its id. The id is made the way tabs.js create1 makes one.
export async function createDoc(frame, payload = blankPayload(frame.kind)) {
  if (!DOC_KIND[frame.kind]) return null;
  const id = uid() + uid();
  await api(docUrl(frame.kind, id), { method: 'PUT', body: { rev: 0, name: String(frame.label || KIND_LABEL[frame.kind]).slice(0, 120), payload }, busy: false });
  return id;
}
// a copy of a frame's document, for a duplicated frame (two frames never share one: deleting one would take the other's)
export async function copyDoc(frame, label) {
  if (!frame.doc) return null;
  const d = await api(docUrl(frame.kind, frame.doc), { busy: false });
  return createDoc({ ...frame, label }, clone(d.payload));
}
// deleting a frame trashes its document (kept 30 days on the server); Undo restores it
export async function trashDoc(f) {
  if (!f.doc) return;
  const t = await TABSET[f.kind]?.().catch(() => null);   // (the kind's TabSet is told first: its list losing the document is our doing, not another device's)
  t?.forget?.(f.doc);
  try { await api(docUrl(f.kind, f.doc), { method: 'DELETE', busy: false }); }
  catch (e) { if (!/not found/i.test(e.message)) { t?.unforget?.(f.doc); throw e; } }
}
export async function restoreDoc(f) {
  if (!f.doc) return;
  (await TABSET[f.kind]?.().catch(() => null))?.unforget?.(f.doc);
  return api(docUrl(f.kind, f.doc, '/restore'), { method: 'POST', busy: false });
}

// The screen's TabSet for a frame kind (each kind has one, and its open document must be renamed through it, or its next
// save meets a newer rev). The modules are loaded already (app.js); import() just hands them over. The 3D one only once
// the 3D engine has loaded (run.js sceneMod): before that it has no document open.
const TABSET = {
  image: () => import('./editor.js').then((m) => m.editTabs()),
  video: () => import('./video.js').then((m) => m.videoTabs()),
  sound: () => import('./sound.js').then((m) => m.soundTabs()),
  scene: () => import('./run.js').then((m) => m.sceneMod?.sceneTabs?.() || null),
};
// A frame's label is its document's name: through its kind's TabSet when that has it open, else a name-only edit at its rev
export async function renameDoc(f, name) {
  if (!f.doc || !DOC_KIND[f.kind]) return;
  name = String(name).slice(0, 120);
  const t = await TABSET[f.kind]?.().catch(() => null);
  if (t?.active?.id === f.doc) {
    if (t.active.name === name) return;
    if (typeof t.rename === 'function' && t.rename.length) { await t.rename(name); return; }
    t.pendingName = name; t.active.name = name;   // (a TabSet without rename(name))
    t.setDirty(true); t.render();
    await t.flush();
    return;
  }
  await editDoc(f.kind, f.doc, (_, doc) => {
    if (doc.name === name) return false;
    doc.name = name;
  });
}

// ---- documents edited from outside their engine (a drop on a frame that isn't open, a rename, an Undo into another table) ----
// Read, change, PUT at the rev read; a stale rev (409: another save came between) is read and changed once more.
// kind: a frame kind ('image'…) or a store kind ('tables'…). mutate(payload, doc) changes the payload in place (or
// doc.name), and must do nothing else (it can run twice): uploads and fetches go before. It returns false to save nothing.
// Resolves true once saved, false when mutate said not to.
export async function editDoc(kind, id, mutate) {
  for (let again = false; ; again = true) {
    const d = await api(docUrl(kind, id), { busy: false });
    const doc = { name: d.name, payload: clone(d.payload || {}) };
    if (mutate(doc.payload, doc) === false) return false;
    try { await api(docUrl(kind, id), { method: 'PUT', body: { rev: d.rev, name: doc.name, payload: doc.payload }, busy: false }); return true; }
    catch (e) { if (e.status !== 409 || again) throw e; }
  }
}

// ---- a document's still: its frame's picture on the table ----
async function shrink(blob, max = 1024) {   // (a frame's still is a thumbnail, not the document's full size)
  try {
    const bmp = await createImageBitmap(blob), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1) return blob;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return (await new Promise((res) => cv.toBlob(res, 'image/png'))) || blob;
  } catch { return blob; }
}
// PUT a document's still (null: it has nothing to show, so it keeps none), then the table's stills of that kind again
export async function putStill(kind, id, blob) {
  const url = docUrl(kind, id, '/still');
  try {
    if (!blob) await fetch(url, { method: 'DELETE' });
    else {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: await shrink(blob) });
      if (!r.ok && r.status !== 404) console.warn('still not saved:', r.status);   // 404: the document is gone
    }
  } catch { /* offline: the next time it is open */ }
  (await import('./table.js')).refreshStills([kind]).catch(() => {});   // (the table asked once as the frame let go, before this one was saved)
}

// ---- results waiting: runs imagetools.js still owes an edit (deck.imagetools.owed), counted per document id ----
export function owedCounts() {
  const list = store.get('deck.imagetools.owed', []), out = new Map();
  if (!Array.isArray(list)) return out;
  for (const tab of new Set(list.map((r) => r?.tab).filter(Boolean))) out.set(tab, owedFor(list, tab).length);
  return out;
}

// ---- stills: each document kind's list rows carry their still ({ url }) ----
const STILLS = new Map();   // 'kind:id' -> url
export const stillOf = (f) => (f.doc ? STILLS.get(`${f.kind}:${f.doc}`) || null : null);
export async function loadStills(kinds) {
  await Promise.all([...new Set(kinds)].filter((k) => DOC_KIND[k]).map(async (k) => {
    let rows;
    try { rows = await api(docUrl(k), { busy: false }); } catch { return; }
    for (const key of [...STILLS.keys()]) if (key.startsWith(`${k}:`)) STILLS.delete(key);
    for (const r of rows || []) if (r.still?.url) STILLS.set(`${k}:${r.id}`, r.still.url);
  }));
}
export const kindOfDoc = (docKind) => Object.keys(DOC_KIND).find((k) => DOC_KIND[k] === docKind) || null;

// ---- the element ----
// A frame: a label bar above it (outside its w × h, which is the canvas), then its body. The body shows the still, else
// the kind's icon; a note's body is its text. onText(text): a note was typed in.
export function frameEl(f, { onText }) {
  const name = h('span', { class: 'frame-name' }), size = h('span', { class: 'frame-size' });
  const body = h('div', { class: 'frame-body' });
  if (f.kind === 'note') {
    const ta = h('textarea', { class: 'frame-text', spellcheck: true, 'aria-label': 'Note', placeholder: 'Write here' });
    ta.value = f.text || '';
    ta.addEventListener('input', () => onText(ta.value));
    body.append(ta);
  } else {
    body.append(h('img', { class: 'frame-still hidden', alt: '', draggable: false }),
      h('div', { class: 'frame-ph' }, icon(KIND_ICON[f.kind], 40), h('span', {}, KIND_LABEL[f.kind])));

  }
  const badge = h('span', { class: 'frame-owed hidden', role: 'status' });   // (in the label bar, so a live frame's engine never covers it)
  return h('div', { class: `frame frame-${f.kind}`, 'data-id': f.id, role: 'group' },
    h('div', { class: 'frame-label' }, icon(KIND_ICON[f.kind]), name, size, badge), body);
}

// bring an element up to its frame: where it sits, its label, its still, and its state
// owed: how many results are waiting to land in it (they land when it next goes live)
export function syncFrame(el, f, { selected = false, live = false, owed = 0 } = {}) {
  Object.assign(el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
  el.querySelector('.frame-name').textContent = f.label || KIND_LABEL[f.kind];
  el.querySelector('.frame-size').textContent = `${f.w}×${f.h}`;
  el.setAttribute('aria-label', `${KIND_LABEL[f.kind]} frame ${f.label || ''}`.trim());
  el.classList.toggle('selected', selected);
  el.classList.toggle('locked', !!f.locked);
  el.classList.toggle('live', live);
  const badge = el.querySelector('.frame-owed');
  if (badge) {
    badge.classList.toggle('hidden', !owed);
    badge.textContent = owed ? `${owed} waiting` : '';
    badge.title = owed ? `${owed} result${owed > 1 ? 's' : ''} waiting: open the frame to land ${owed > 1 ? 'them' : 'it'}` : '';
  }
  const img = el.querySelector('.frame-still');
  if (img) {
    const url = stillOf(f) || f.preview || null;   // (preview: the picture a frame was made from, until its document has a still)
    if (url && img.getAttribute('src') !== url) img.src = url;
    img.classList.toggle('hidden', !url);
    el.querySelector('.frame-ph').classList.toggle('hidden', !!url);
  }
  const ta = el.querySelector('.frame-text');
  if (ta && document.activeElement !== ta && ta.value !== (f.text || '')) ta.value = f.text || '';
}

// ---- frames from dropped things ----
// how big a picture, clip or sound is, and how long, from its own element
function mediaInfo(url, kind) {
  return new Promise((res) => {
    const el = kind === 'image' ? new Image() : document.createElement(kind === 'audio' ? 'audio' : 'video');
    const done = () => res({ w: el.naturalWidth || el.videoWidth || 0, h: el.naturalHeight || el.videoHeight || 0, dur: Number.isFinite(el.duration) ? el.duration : 0 });
    el.onerror = () => res({ w: 0, h: 0, dur: 0 });
    if (kind === 'image') el.onload = done; else { el.preload = 'metadata'; el.onloadedmetadata = done; }
    el.src = url;
  });
}
const sized = (w, h, d = { w: 1024, h: 1024 }) => (w && h ? { w: Math.round(w), h: Math.round(h) } : d);

// An image frame whose edit holds one picture (an input's name) as its only layer, on a canvas the picture's size
async function pictureFrame(name, at, w, h, label) {
  if (!w || !h) ({ w, h } = await mediaInfo(inputUrl(name), 'image'));
  const s = sized(w, h), frame = newFrame('image', { ...at, ...s }, { label: label || 'Picture', preview: thumbUrl(name, 1024) });
  const layer = { name, crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, scale: 1, opacity: 1, hidden: false, blend: 'normal', locked: false };
  return { frame, payload: { ...BLANK(), size: { w: s.w, h: s.h }, layers: [layer] } };
}
// A video frame with one clip on V1, or a sound frame with one sound on A1 (the items' shapes are video.js and sound.js newItem's)
async function clipFrame(kind, src, url, label, at) {
  const info = await mediaInfo(url, kind === 'audio' ? 'audio' : 'video'), dur = info.dur || 0;
  if (kind === 'audio') {
    const frame = newFrame('sound', { ...at, ...SOUND_SIZE }, { label });
    const it = { id: uid(), track: 'a1', kind: 'audio', src, url, label, dur, at: 0, in: 0, out: dur || null, volume: 1, pan: 0, fadeIn: 0, fadeOut: 0 };
    return { frame, payload: { ...blankPayload('sound'), items: [it] } };
  }
  const frame = newFrame('video', { ...at, ...sized(info.w, info.h, { w: 1280, h: 720 }) }, { label });
  const it = { id: uid(), track: 'v1', kind: 'video', src, url, label, thumb: null, dur, at: 0, in: 0, out: dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
  return { frame, payload: { ...blankPayload('video'), items: [it] } };
}

// A dropped thing as { frame, payload } (the frame's document is made from payload by the caller), its top-left at `at`.
// src: { generation, index } (a run's output), { input } (a picture in the project), { media, kind?, url?, label? } (the
// media library) or a File. Returns null for something no frame can hold.
export async function frameFor(src, at) {
  if (src instanceof File) return fileFrame(src, at);
  if (src.input) return pictureFrame(src.input, at, src.width, src.height, src.label);
  if (src.generation != null) {
    const index = src.index || 0, g = S.history?.get?.(src.generation) || await api(`/api/generations/${src.generation}`, { busy: false });
    const o = g?.outputs?.[index];
    if (!o) return null;
    const label = `#${g.id}`;
    if (o.kind === 'image') {
      const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index, frame: 'first', mp: 0, multiple: 1 } });
      return pictureFrame(r.name, at, r.width, r.height, label);
    }
    if (o.kind === 'video' || o.kind === 'audio') return clipFrame(o.kind, { generation: g.id, index }, o.url, label, at);
    return null;
  }
  if (src.media) {
    const url = src.url || `/files/media/${encodeURIComponent(src.media)}`, label = src.label || src.media.split('_').slice(1).join('_') || src.media;
    if (src.kind === 'image') return fileFrame(new File([await (await fetch(url)).blob()], src.media, { type: 'image/png' }), at);
    return clipFrame(src.kind === 'audio' ? 'audio' : 'video', { media: src.media }, url, label, at);
  }
  return null;
}
// a file from the computer: a picture goes into the project's pictures, a clip or sound into the media library
async function fileFrame(file, at) {
  const kind = dropKind(file);
  if (kind === 'image') {
    const r = await uploadImage(file);
    return pictureFrame(r.name, at, r.width, r.height, file.name.replace(/\.\w+$/, ''));
  }
  const m = await uploadMedia(file);
  if (m.kind !== 'video' && m.kind !== 'audio') return null;
  return clipFrame(m.kind, { media: m.name }, m.url, m.label, at);
}

// ---- things dropped into a frame (table:drop-frame sources): as a picture, or as a clip ----
const genOf = async (id) => S.history?.get?.(id) || api(`/api/generations/${id}`, { busy: false });
// A dropped thing as one of the project's pictures: { name, width, height, label }, or null for something that isn't one
// (a run's picture is copied into the project's pictures, as a frame made from it is)
export async function sourcePicture(src) {
  if (src instanceof File) {
    if (dropKind(src) !== 'image') return null;
    const r = await uploadImage(src);
    return { name: r.name, width: r.width, height: r.height, label: src.name.replace(/\.\w+$/, '') };
  }
  if (src.input) {
    let { width = 0, height = 0 } = src;
    if (!width || !height) ({ w: width, h: height } = await mediaInfo(inputUrl(src.input), 'image'));   // (a layer is centred by its size)
    return { name: src.input, width, height, label: src.label || src.input.split('/').pop() };
  }
  if (src.generation != null) {
    const index = src.index || 0, g = await genOf(src.generation);
    if (g?.outputs?.[index]?.kind !== 'image') return null;
    const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index, frame: 'first', mp: 0, multiple: 1 } });
    return { name: r.name, width: r.width, height: r.height, label: `#${g.id}` };
  }
  if (src.media && src.kind === 'image') {
    const url = src.url || `/files/media/${encodeURIComponent(src.media)}`;
    return sourcePicture(new File([await (await fetch(url)).blob()], src.media, { type: 'image/png' }));
  }
  return null;
}
// A dropped clip or sound as a timeline's media: { kind: 'video' | 'audio', src, url, label, dur }, or null
export async function sourceClip(src) {
  let m = null;
  if (src instanceof File) {
    if (dropKind(src) === 'image') return null;
    const u = await uploadMedia(src);
    if (u.kind === 'video' || u.kind === 'audio') m = { kind: u.kind, src: { media: u.name }, url: u.url, label: u.label };
  } else if (src.generation != null) {
    const index = src.index || 0, g = await genOf(src.generation), o = g?.outputs?.[index];
    if (o?.kind === 'video' || o?.kind === 'audio') m = { kind: o.kind, src: { generation: g.id, index }, url: o.url, label: `#${g.id}` };
  } else if (src.media && src.kind !== 'image') {
    const label = src.label || src.media.split('_').slice(1).join('_') || src.media;
    m = { kind: src.kind === 'audio' ? 'audio' : 'video', src: { media: src.media }, url: src.url || `/files/media/${encodeURIComponent(src.media)}`, label };
  }
  if (!m) return null;
  m.dur = (await mediaInfo(m.url, m.kind)).dur || 0;
  return m;
}
