// What a frame on the table is made of, apart from where it sits: its element (a label bar over a still, a placeholder
// or a note's text), the saved document it owns (made, copied, trashed and restored through app/store.py), the stills
// those documents keep, and frames made from things dropped on the table (a picture, a clip, a sound, a file).
// table.js places and drives the frames; table-model.js has their geometry.
import { h, api, store, icon, uid, clone } from './ui.js';
import { S, inputUrl, previewUrl, thumbUrl } from './core.js';
import { BLANK } from './editor-engine.js';
import { itemUrl, uploadImage, uploadMedia } from './media.js';
import { wavePeaks } from './timeline.js';
import { dropKind } from './drop-files.js';
import { DOC_KIND, KIND_LABEL, newFrame, overlaps } from './table-model.js';
import { owedFor } from './owed-runs.js';
import { emptyPayload } from './empty-docs.js';
import { refused, refusal } from './tabs.js';
import { isLive } from './live.js';

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
// (frame.kind may also be a document kind itself: { kind: 'vfx-tabs', doc } for a video frame's VFX document)
export async function createDoc(frame, payload = blankPayload(frame.kind)) {
  if (!DOC_KIND[frame.kind] && !/-tabs$/.test(frame.kind || '')) return null;
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
  'vfx-tabs': () => import('./vfx.js').then((m) => m.vfxTabs() || null),
};

// A picture uploaded for something that then wasn't made (its save failed, another table opened): nothing owns it, so
// it goes (a name of null is nothing to do)
export function dropInput(name) {
  for (const n of [name].flat()) if (n) api(`/api/inputs?name=${encodeURIComponent(n)}`, { method: 'DELETE', busy: false }).catch(() => {});
}
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
// Read, change, PUT at the rev read; a stale rev (409 with the server's `doc`: another save came between) is read and
// changed once more. A refusal (409 with no `doc`, tabs.js refused) throws its reason at once.
// kind: a frame kind ('image'…) or a store kind ('tables'…). mutate(payload, doc) changes the payload in place (or
// doc.name), and must do nothing else (it can run twice): uploads and fetches go before. It returns false to save nothing.
// Resolves true once saved, false when mutate said not to.
export async function editDoc(kind, id, mutate) {
  for (let again = false; ; again = true) {
    const d = await api(docUrl(kind, id), { busy: false });
    const doc = { name: d.name, payload: clone(d.payload || {}) };
    if (mutate(doc.payload, doc) === false) return false;
    let r;
    try {
      const res = await fetch(docUrl(kind, id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rev: d.rev, name: doc.name, payload: doc.payload }) });
      let data = null; try { data = await res.json(); } catch { /* not JSON */ }
      r = { ok: res.ok, status: res.status, data };
    } catch { throw new Error('Can\'t reach ComfyChair (is the server running and on this network?)'); }
    if (r.ok) return true;
    const err = new Error(refused(r) ? refusal(r) : r.data?.detail || r.data?.error || `Couldn't save (${r.status})`);
    err.status = r.status;
    if (r.status !== 409 || refused(r) || again) throw err;
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

// ---- where an edit of a frame from the table lands: a new frame beside its source ----
// The first free spot right of the source, on its row (a frame in the way: past it)
export function besideSpot(frames, source, { w, h }, gap = 40) {
  const spot = { x: source.x + source.w + gap, y: source.y };
  for (let i = 0; i < 1000; i++) {
    const hit = frames.find((f) => f !== source && overlaps(f, { ...spot, w, h }));
    if (!hit) break;
    spot.x = hit.x + hit.w + gap;
  }
  return spot;
}
// The frame a result made from `source` lands in (an Edit pane run, the frame menu, several selected): a new frame of
// `kind` (default the source's) beside it, its document made at once, so an owed run keyed on that document lands there
// (imagetools.js landMade / runToolOn, make-panel.js landClip). label: the new frame's whole label (default
// "Result · <source label>"). An image frame fits its layers, so a result placed at the source's own canvas spot shows
// whole; a video or sound frame starts empty. The selection is left as it was. Returns the frame (null if not made).
export async function resultFrame(source, { kind = source.kind, label } = {}) {
  const Table = await import('./table.js');
  const frames = Table.tableFrames() || [];
  const size = kind === 'sound' ? { ...SOUND_SIZE } : kind === source.kind ? { w: source.w, h: source.h } : { w: 1024, h: 1024 };
  const at = besideSpot(frames, source, size);
  const box = source.kind === 'image' && source.fit && source.fitBox ? { ...source.fitBox } : { x: 0, y: 0, w: size.w, h: size.h };
  const extra = { label: String(label || `Result · ${source.label || KIND_LABEL[source.kind]}`).slice(0, 120),
    ...(kind === 'image' && { fit: true, fitBox: box }) };   // (never the source's story place: a result for a shot sits beside its row, not as the shot)
  const payload = kind === 'image' ? { ...BLANK(), size: null } : blankPayload(kind);
  const was = (Table.selectedFrames() || []).map((f) => f.id);
  const f = await Table.newFrameAt(kind, { ...at, ...size }, { payload, extra });
  if (f && was.length) Table.selectFrames(was);   // (newFrameAt selects the new one: a run on several frames keeps them)
  return f || null;
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
const PREV_EPOCH = new Map();   // kind -> how many times its stills were loaded
export const stillOf = (f) => (f.doc ? STILLS.get(`${f.kind}:${f.doc}`) || null : null);
export async function loadStills(kinds) {
  await Promise.all([...new Set(kinds)].filter((k) => DOC_KIND[k]).map(async (k) => {
    let rows;
    try { rows = await api(docUrl(k), { busy: false }); } catch { return; }
    PREV_EPOCH.set(k, (PREV_EPOCH.get(k) || 0) + 1);   // (a document may have changed: its tile's clip and waveform are read again)
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
    const still = h('img', { class: 'frame-still hidden', alt: '', draggable: false });
    still.addEventListener('error', () => {   // (a poster the server couldn't make: the icon, and a sound's waveform drawn here instead)
      still.dataset.bad = '1'; still.classList.add('hidden');
      el.querySelector('.frame-ph')?.classList.remove('hidden');
      const url = el._pv?.url;
      if (f.kind === 'sound' && url && still.getAttribute('src') === previewUrl(url, 640, 'wave')) {
        NOWAVE.add(url); el.classList.remove('frame-waved');
        if (el._pv?.lastF) applyPreview(el, el._pv.lastF);
      }
    });
    body.append(still,
      h('div', { class: 'frame-ph' }, icon(KIND_ICON[f.kind], 40), h('span', {}, KIND_LABEL[f.kind])));
  }
  const badge = h('span', { class: 'frame-owed hidden', role: 'status' });   // (in the label bar, so a live frame's engine never covers it)
  const el = h('div', { class: `frame frame-${f.kind}`, 'data-id': f.id, role: 'group' },
    h('div', { class: 'frame-label' }, icon(KIND_ICON[f.kind]), name, size, badge), body);
  if (f.kind === 'video' || f.kind === 'sound') watchTile(el);
  return el;
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
  if (f.kind === 'video' || f.kind === 'sound') syncPreview(el, f);   // (first: it reads the first clip, whose poster is the still's stand-in)
  showStill(el, f);
  const ta = el.querySelector('.frame-text');
  if (ta && document.activeElement !== ta && ta.value !== (f.text || '')) ta.value = f.text || '';
}

// The tile's picture: its document's still, else the picture it was made from (f.preview), else (a video or sound frame)
// its first clip's poster, the server's still or waveform of it (app/previews.py), there at once and after a reload
function showStill(el, f) {
  const img = el.querySelector('.frame-still');
  if (!img) return;
  const url = stillOf(f) || f.preview || posterOf(el, f) || null;
  if (url && img.getAttribute('src') !== url) { img.dataset.bad = ''; img.src = url; }
  const ok = !!url && !img.dataset.bad;
  img.classList.toggle('hidden', !ok);
  el.querySelector('.frame-ph').classList.toggle('hidden', ok);
  el.classList.toggle('frame-waved', f.kind === 'sound' && ok && url === posterOf(el, f));   // (the server's waveform is stretched to the strip)
}
// a first clip's poster: a video's still, a sound's waveform. null until the frame's document has been read
function posterOf(el, f) {
  const st = el._pv, item = st?.key ? PREVS.get(st.key)?.item : null;
  if (!item?.url) return null;
  if (f.kind === 'sound') return NOWAVE.has(item.url) ? null : previewUrl(item.url, 640, 'wave');
  return previewUrl(item.url, 320);
}

// ---- tile previews: a video frame's tile plays its first clip, a sound frame's tile draws its waveform ----
// The first clip (a sequence of several previews its first only) comes from the frame's document: its first video item (video)
// or audio item (sound), read when the tile first shows and again whenever the kind's stills reload (a `store` message).
// A clip plays muted and looped from its `in` point to its `out`; which tiles play is decided in pump(), below.
const PREVS = new Map();   // 'kind:id' -> { epoch, item: { url, in, out } | null }
const WAVES = new Map();   // url -> { peaks, rate } | 'none' (drawn here only when the server's couldn't be made)
const NOWAVE = new Set();   // sound urls whose server waveform (app/previews.py) failed
const TILES = new Set();   // the video and sound tiles made (each el has el._pv)
const MAX_PLAYING = 4;
const PTR = { x: -1e9, y: -1e9 };
let sweepT = 0, pumpQ = 0, ptrWired = false;

// 'hover' (default): a tile plays while the pointer is over it or it is selected; 'always': every tile on screen (4 at a
// time, the nearest to the pointer or the selection); 'off': stills only
export const previewMode = () => { const m = store.get('deck.table.previews', 'hover'); return m === 'always' || m === 'off' ? m : 'hover'; };
export function setPreviewMode(mode) {
  store.set('deck.table.previews', mode === 'always' || mode === 'off' ? mode : 'hover');
  pump();
}
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function watchTile(el) {
  if (el._pv) return;
  const st = el._pv = { hover: false, vis: false, seen: false, video: null, canvas: null, key: null, url: null, cin: 0, cout: 0, loading: false, ro: null, io: null };
  el.addEventListener('pointerenter', () => { st.hover = true; pump(); });
  el.addEventListener('pointerleave', () => { st.hover = false; pump(); });
  if (typeof IntersectionObserver === 'function') {
    st.io = new IntersectionObserver((es) => { st.vis = es[es.length - 1].isIntersecting; if (!el.isConnected && st.seen) releaseTile(el); else pump(); });
    st.io.observe(el);
  } else st.vis = true;
  TILES.add(el);
  if (!ptrWired && typeof addEventListener === 'function') {
    ptrWired = true;
    addEventListener('pointermove', (e) => { PTR.x = e.clientX; PTR.y = e.clientY; }, { passive: true });
  }
  clearInterval(sweepT); sweepT = setInterval(() => { sweep(); pump(); }, 1500);
}
// tiles that left the DOM let go of their video (and stop being looked after)
function sweep() {
  for (const el of TILES) {
    const st = el._pv;
    if (el.isConnected) st.seen = true;
    else if (st.seen) releaseTile(el);
  }
  if (!TILES.size) { clearInterval(sweepT); sweepT = 0; }
}
function dropSource(v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* gone */ } }
function releaseTile(el) {
  const st = el._pv;
  if (!st) return;
  if (st.video) dropSource(st.video);
  st.ro?.disconnect(); st.io?.disconnect();
  TILES.delete(el); el._pv = null;
}
// another screen came on (pauseTable calls this): every preview stops and lets go of its clip; the next pump re-attaches
export function pausePreviews() {
  for (const el of TILES) if (el._pv?.video) dropSource(el._pv.video);
}

async function loadPrev(el, f) {
  const st = el._pv, key = `${f.kind}:${f.doc}`, epoch = PREV_EPOCH.get(f.kind) || 0;
  if (!st || st.loading) return;
  st.loading = true;
  let item = null, ok = true;
  try {
    const d = await api(docUrl(f.kind, f.doc), { busy: false });
    const want = f.kind === 'video' ? 'video' : 'audio';
    const its = (d.payload?.items || []).filter((it) => it.kind === want && itemUrl(it));
    const it = its.sort((a, b) => (a.at || 0) - (b.at || 0))[0];
    if (it) item = { url: itemUrl(it), in: Math.max(0, it.in || 0), out: it.out > (it.in || 0) ? it.out : 0 };
  } catch { ok = false; }
  st.loading = false;
  if (!ok) return;
  PREVS.set(key, { epoch, item });
  if (el._pv && el.isConnected) { applyPreview(el, f); showStill(el, f); }
}

// bring a tile's video or waveform up to its frame
function syncPreview(el, f) {
  const st = el._pv;
  if (!st) return;
  if (!st.seen && el.isConnected) st.seen = true;
  st.lastF = f;
  if (!f.doc) { st.key = null; applyPreview(el, f); return; }
  const key = `${f.kind}:${f.doc}`, e = PREVS.get(key);
  if (!e || e.epoch !== (PREV_EPOCH.get(f.kind) || 0)) loadPrev(el, f);
  st.key = key;
  applyPreview(el, f);
}
function applyPreview(el, f) {
  const st = el._pv, body = el.querySelector('.frame-body');
  if (!st || !body) return;
  const item = st.key ? PREVS.get(st.key)?.item || null : null;
  if (f.kind === 'video') {
    if (!item) { if (st.video) { dropSource(st.video); st.video.remove(); st.video = null; } st.url = null; return; }
    let v = st.video;
    if (!v) {
      v = st.video = h('video', { class: 'frame-clip hidden', muted: true, loop: true, playsinline: true, preload: 'metadata', tabindex: -1, 'aria-hidden': 'true', draggable: false });
      v.muted = true; v.loop = true; v.playsInline = true;
      v.addEventListener('loadedmetadata', () => { if (st.cin > 0 && v.currentTime < st.cin) v.currentTime = st.cin; });
      for (const ev of ['playing', 'pause', 'emptied', 'ended']) v.addEventListener(ev, () => showClip(el));
      v.addEventListener('timeupdate', () => { if (st.cout && v.currentTime >= st.cout) v.currentTime = st.cin; });
      v.addEventListener('error', () => { st.bad = true; v.classList.add('hidden'); });
      body.insertBefore(v, el.querySelector('.frame-ph'));
    }
    if (st.url !== item.url || st.cin !== item.in || st.cout !== item.out) {
      const moved = st.url !== item.url;
      st.url = item.url; st.cin = item.in; st.cout = item.out; st.bad = false;
      if (moved && v.getAttribute('src')) dropSource(v);   // (the pump attaches the new one when it plays)
      else if (v.getAttribute('src') && st.cin > 0) v.currentTime = st.cin;
    }
    showClip(el);
    pump();
  } else {
    if (!st.canvas) {
      st.canvas = h('canvas', { class: 'frame-wave hidden', 'aria-hidden': 'true' });
      body.insertBefore(st.canvas, el.querySelector('.frame-ph'));
      if (typeof ResizeObserver === 'function') { st.ro = new ResizeObserver(() => drawWave(el)); st.ro.observe(body); }
    }
    if (!item) { st.url = null; st.canvas.classList.add('hidden'); return; }
    if (st.url !== item.url || st.cin !== item.in || st.cout !== item.out) { st.url = item.url; st.cin = item.in; st.cout = item.out; }
    if (!NOWAVE.has(item.url)) { st.canvas.classList.add('hidden'); return; }   // (the server's waveform is the tile's still)
    const w = WAVES.get(item.url);
    if (!w) {
      WAVES.set(item.url, 'loading');
      wavePeaks(item.url, 100).then((p) => WAVES.set(item.url, p), () => WAVES.set(item.url, 'none'))
        .then(() => { for (const t of TILES) if (t._pv?.url === item.url) drawWave(t); });
    }
    drawWave(el);
  }
}
// the clip is shown over the still only while it plays; paused, stopped or let go, the still (or poster) shows again
function showClip(el) {
  const st = el._pv, v = st?.video;
  if (!v) return;
  const shown = !st.bad && !v.paused && !v.ended && v.readyState >= 2 && !!v.getAttribute('src');
  v.classList.toggle('hidden', !shown);
  if (shown) el.querySelector('.frame-ph')?.classList.add('hidden');
}
function drawWave(el) {
  const st = el._pv, cv = st?.canvas, body = el.querySelector('.frame-body');
  if (!cv || !body) return;
  const w = WAVES.get(st.url), ok = w && typeof w === 'object' && w.peaks?.length;
  cv.classList.toggle('hidden', !ok);
  if (!ok) return;
  const W = Math.max(1, body.clientWidth), H = Math.max(1, body.clientHeight), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const rate = w.rate, a = Math.min(w.peaks.length - 1, Math.floor(st.cin * rate)), b = st.cout ? Math.min(w.peaks.length, Math.ceil(st.cout * rate)) : w.peaks.length;
  const n = Math.max(1, b - a), top = Math.max(0.05, ...w.peaks.slice(a, b));
  g.fillStyle = getComputedStyle(el).getPropertyValue('--accent').trim() || '#7aa2ff';
  const bars = Math.max(1, Math.min(Math.floor(W / 2), n));   // (a bar a pixel pair at most)
  for (let i = 0; i < bars; i++) {
    let m = 0;
    for (let j = a + Math.floor(i * n / bars), e = a + Math.max(Math.floor((i + 1) * n / bars), Math.floor(i * n / bars) + 1); j < e; j++) m = Math.max(m, w.peaks[j] || 0);
    const hh = Math.max(1, (m / top) * H * 0.9);
    g.fillRect(i * (W / bars), (H - hh) / 2, Math.max(1, W / bars - 1), hh);
  }
}

// Which videos play. Wanted: on screen, not while any frame is live, motion not reduced, and (hover) pointed at or selected,
// or (always) any. At most MAX_PLAYING play: the pointed-at one first, then the selected, then the nearest to the pointer.
export function pump() {
  if (pumpQ) return;
  pumpQ = requestAnimationFrame?.(() => { pumpQ = 0; pumpNow(); }) || setTimeout(() => { pumpQ = 0; pumpNow(); }, 16);
}
export function pumpNow() {
  const mode = previewMode(), idle = mode === 'off' || reduced() || isLive();
  const want = [];
  for (const el of TILES) {
    const st = el._pv, v = st.video;
    if (!v || !el.isConnected) continue;
    if (!st.vis) { if (v.getAttribute('src')) dropSource(v); continue; }   // (off screen, or its screen is not on show)
    const sel = el.classList.contains('selected');
    if (idle || st.bad || !(mode === 'always' || st.hover || sel)) { v.pause(); continue; }
    const r = el.getBoundingClientRect(), d = Math.hypot(r.left + r.width / 2 - PTR.x, r.top + r.height / 2 - PTR.y);
    want.push({ el, st, v, rank: st.hover ? 0 : sel ? 1 : 2, d });
  }
  want.sort((a, b) => a.rank - b.rank || a.d - b.d);
  want.forEach(({ st, v }, i) => {
    if (i >= MAX_PLAYING) { v.pause(); return; }
    if (!v.getAttribute('src')) { v.src = st.url; if (st.cin > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = st.cin; }, { once: true }); }
    if (v.paused) v.play().catch(() => {});
  });
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

// An image frame whose edit holds one picture (an input's name) as its only layer, sized by its layers (frame-image.js:
// fit), so the picture's own size; a picture of unknown size gets a fixed 1024×1024 canvas
async function pictureFrame(name, at, w, h, label) {
  if (!w || !h) ({ w, h } = await mediaInfo(inputUrl(name), 'image'));
  const fit = !!(w && h), s = sized(w, h);
  const frame = newFrame('image', { ...at, ...s }, { label: label || 'Picture', preview: thumbUrl(name, 1024),
    fit, ...(fit ? { fitBox: { x: 0, y: 0, w: s.w, h: s.h } } : {}) });
  const layer = { name, crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, scale: 1, opacity: 1, hidden: false, blend: 'normal', locked: false };
  return { frame, payload: { ...BLANK(), size: fit ? null : { w: s.w, h: s.h }, layers: [layer] } };
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
      return { ...(await pictureFrame(r.name, at, r.width, r.height, label)), fresh: r.name };
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
    return { ...(await pictureFrame(r.name, at, r.width, r.height, file.name.replace(/\.\w+$/, ''))), fresh: r.name };
  }
  const m = await uploadMedia(file);
  if (m.kind !== 'video' && m.kind !== 'audio') return null;
  return clipFrame(m.kind, { media: m.name }, m.url, m.label, at);
}

// ---- things dropped into a frame (table:drop-frame sources): as a picture, or as a clip ----
const genOf = async (id) => S.history?.get?.(id) || api(`/api/generations/${id}`, { busy: false });
// A dropped thing as one of the project's pictures: { name, width, height, label, fresh }, or null for something that isn't
// one (a run's picture is copied into the project's pictures, as a frame made from it is). fresh: uploaded or copied
// here, not one of the project's pictures already (the caller drops it when what it was for isn't saved: dropInput)
export async function sourcePicture(src) {
  if (src instanceof File) {
    if (dropKind(src) !== 'image') return null;
    const r = await uploadImage(src);
    return { name: r.name, width: r.width, height: r.height, label: src.name.replace(/\.\w+$/, ''), fresh: true };
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
    return { name: r.name, width: r.width, height: r.height, label: `#${g.id}`, fresh: true };
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
