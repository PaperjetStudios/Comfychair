import {
  $, h, store, uid, api, toast, undoToast, openSheet, closeSheet, button, iconBtn, linkBtn, actions, fileButton, seg,
  field, section, hint, placeholder, rangeField, propNum, mediaCard, panelTop,
} from './ui.js';
import { S, fmtT, inputUrl, thumbUrl } from './core.js';
import { cardMedia, genLabel, openImagePicker, pickerSheet, projectOutputs, uploadImage, uploadMedia } from './media.js';
import { openGeneration } from './run.js';
import { useInGenerate } from './editor.js';

// ---------------------------------------------------------------------------
// video: a Premiere-style timeline. Video tracks stack (V2 draws over V1), audio tracks mix, and
// clips that overlap on one track cross-fade. The preview composites the clips on a canvas;
// Export sends the same timeline to the server, which renders it with ffmpeg into History.
// ---------------------------------------------------------------------------
const HEAD_W = 84;    // track header column (px)
const LANE_H = 52;
const MIN_LEN = 0.1;
const V = {
  tracks: [], items: [], size: null, fps: 0, pps: 40,   // pps: timeline zoom, pixels per second
  t: 0, playing: false, clock: 0, loop: store.get('deck.video.loop', false), sel: null,
  els: new Map(), posters: new Map(), waves: new Map(),
};

function newItem({ kind, src, url, label, thumb = null, dur = 0 }, track) {
  return { id: uid(), track, kind, src, url, label, thumb, dur, at: 0, in: 0, out: kind === 'image' ? 3 : dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
}

(function loadTimeline() {
  const saved = store.get('deck.timeline', null);
  if (saved) Object.assign(V, { tracks: saved.tracks || [], items: saved.items || [], size: saved.size || null, fps: saved.fps || 0, pps: saved.pps || 40 });
  else {   // the old one-track clip list
    let at = 0;
    for (const c of store.get('deck.video', [])) {
      const it = newItem({ kind: 'video', src: { generation: c.generation, index: c.index }, url: c.url, label: c.label, dur: c.duration || 0 }, 'v1');
      Object.assign(it, { at, in: c.start || 0, out: c.end ?? (c.duration || null) });
      at += (it.out ?? 3) - it.in;
      V.items.push(it);
    }
  }
  if (!V.tracks.length) V.tracks = [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }];
})();

function persistTimeline() {
  store.set('deck.timeline', { tracks: V.tracks, items: V.items, size: V.size, fps: V.fps, pps: V.pps });
}

const itLen = (it) => Math.max(MIN_LEN, (it.out ?? (it.dur || 3)) - it.in);
const itEnd = (it) => it.at + itLen(it);
const trackOf = (it) => V.tracks.find((t) => t.id === it.track);
const tracksOf = (kind) => V.tracks.filter((t) => t.kind === kind);   // video: V1 (bottom) first
const trackName = (t) => `${t.kind === 'video' ? 'V' : 'A'}${tracksOf(t.kind).indexOf(t) + 1}`;
const zOf = (it) => tracksOf('video').findIndex((t) => t.id === it.track);
const seqEnd = () => V.items.reduce((m, it) => Math.max(m, itEnd(it)), 0);
const isVisual = (it) => it.kind === 'video' || it.kind === 'image';
const selItem = () => V.items.find((i) => i.id === V.sel) || null;
const fpsNow = () => V.fps || 24;
const tc = (t) => {
  const f = fpsNow(), m = Math.floor(t / 60), s = Math.floor(t % 60), fr = Math.min(f - 1, Math.floor((t % 1) * f + 1e-6));
  return `${m}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
};

// Overlap with the clip before (xin) and after (xout) it on the same track: the later clip fades
// in over the overlap; sound also fades the earlier one out. Mirrors videoedit._overlaps.
function xfades(it) {
  let xin = 0, xout = 0;
  for (const o of V.items) {
    if (o === it || o.track !== it.track) continue;
    if (o.at < it.at || (o.at === it.at && V.items.indexOf(o) < V.items.indexOf(it))) xin = Math.max(xin, Math.min(itEnd(o) - it.at, itLen(it), itLen(o)));
    else xout = Math.max(xout, Math.min(itEnd(it) - o.at, itLen(it), itLen(o)));
  }
  return { xin, xout };
}

function fadeGain(it, t, audio) {
  const local = t - it.at, len = itLen(it), { xin, xout } = xfades(it);
  const fi = Math.max(it.fadeIn || 0, xin), fo = Math.max(it.fadeOut || 0, audio ? xout : 0);
  let g = 1;
  if (fi > 0 && local < fi) g = Math.min(g, local / fi);
  if (fo > 0 && len - local < fo) g = Math.min(g, (len - local) / fo);
  return Math.max(0, Math.min(1, g));
}

// ---- playback: one media element per clip, kept in step with the timeline clock ----
// Preloading: each video/sound on the timeline is downloaded whole into memory (a blob: URL), so
// playback never waits on the network to start or seek. Until then clips stream from the server.
// Past BLOB_CAP in memory the rest stream instead: tablets (iPad Safari above all) kill pages that
// hold too much.
const blobs = new Map();   // url -> { state: 'loading' | 'ready' | 'failed' | 'stream', src, size }
let preloadQueue = [], preloading = 0;
const BLOB_CAP = 400e6;
const srcFor = (it) => (blobs.get(it.url)?.state === 'ready' ? blobs.get(it.url).src : it.url);
const blobBytes = () => [...blobs.values()].reduce((a, b) => a + (b.size || 0), 0);

function preloadMedia() {
  const urls = new Set(V.items.filter((it) => it.kind !== 'image').map((it) => it.url));
  for (const [url, b] of blobs) {   // free what's no longer on the timeline
    if (urls.has(url)) continue;
    if (b.src) URL.revokeObjectURL(b.src);
    blobs.delete(url);
  }
  for (const url of urls) if (!blobs.has(url)) { blobs.set(url, { state: 'loading' }); preloadQueue.push(url); }
  while (preloading < 2 && preloadQueue.length) {
    const url = preloadQueue.shift();
    if (blobBytes() > BLOB_CAP) { blobs.set(url, { state: 'stream' }); continue; }
    preloading++;
    fetch(url).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
      .then((b) => { if (blobs.has(url)) blobs.set(url, { state: 'ready', src: URL.createObjectURL(b), size: b.size }); })
      .catch(() => { if (blobs.has(url)) blobs.set(url, { state: 'failed' }); })
      .finally(() => { preloading--; preloadMedia(); showPreload(); if (!V.playing) { syncMedia(); requestDraw(); } });
  }
  showPreload();
}

function showPreload() {
  const all = [...blobs.values()], done = all.filter((b) => b.state !== 'loading').length;
  const el = $('#vidLoad');
  if (el) el.textContent = done < all.length ? `Loading ${done}/${all.length}…` : '';
}

function mediaFor(it) {
  const m = V.els.get(it.id), src = srcFor(it);
  // switch to the downloaded copy only while stopped, so it can't flicker mid-playback
  if (m && (m.src === src || (V.playing && m.url === it.url))) return m.el;
  if (m && m.el.pause) m.el.pause();
  let el;
  if (it.kind === 'image') { el = new Image(); el.onload = requestDraw; }
  else {
    el = document.createElement(it.kind === 'audio' ? 'audio' : 'video');
    Object.assign(el, { preload: 'auto', playsInline: true, muted: true });
    el.addEventListener('loadeddata', requestDraw);
    el.addEventListener('seeked', requestDraw);
    el.addEventListener('loadedmetadata', () => gotDuration(it, el.duration));
  }
  el.src = src;
  V.els.set(it.id, { el, url: it.url, src });
  return el;
}

function gotDuration(it, d) {
  if (!isFinite(d) || !d || it.dur === d) return;
  it.dur = d;
  if (it.out == null || it.out > d) it.out = d;
  persistTimeline(); renderTimeline();
}

function pruneEls() {
  for (const [id, m] of V.els) {
    if (V.items.some((i) => i.id === id)) continue;
    if (m.el.pause) m.el.pause();
    m.el.removeAttribute('src');
    V.els.delete(id);
  }
}

function syncMedia() {
  for (const it of V.items) {
    if (it.kind === 'image') { mediaFor(it); continue; }
    const el = mediaFor(it), tr = trackOf(it);
    if (V.t < it.at || V.t >= itEnd(it)) {
      if (!el.paused) el.pause();
      // cue up a clip that's about to start so it begins cleanly
      if (it.at > V.t && it.at - V.t < 4 && !el.seeking && Math.abs(el.currentTime - it.in) > 0.05) el.currentTime = it.in;
      continue;
    }
    const want = it.in + V.t - it.at;
    el.muted = !!(tr && tr.muted) || !(it.volume > 0) || starting.get(el) === 'muted';
    el.volume = Math.min(1, (it.volume ?? 1) * fadeGain(it, V.t, true));
    if (V.playing) {
      if (el.paused) startMedia(el, want);
      else if (it.id !== V.master && Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.01) el.currentTime = want;
    }
  }
}

// Start a clip once (no re-seeking every frame while play() is pending, which is what made the
// preview flash black). Tablets can refuse to start sound outside a tap; then it plays muted.
const starting = new WeakMap();   // el -> 'pending' | 'muted' | time of a failed start
function startMedia(el, want) {
  const st = starting.get(el);
  if (st === 'pending' || (typeof st === 'number' && performance.now() - st < 1000)) return;
  if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
  starting.set(el, 'pending');
  el.play().then(() => starting.delete(el), () => {
    el.muted = true;
    return el.play().then(() => starting.set(el, 'muted'));
  }).catch(() => starting.set(el, performance.now()));
}

// Called from the Play tap: touch every clip's media while the tap still counts as a user gesture,
// so the clips that start later are allowed to play with sound.
function unlockMedia() {
  for (const it of V.items) {
    if (it.kind === 'image') continue;
    const el = mediaFor(it);
    if (!el.paused || starting.get(el) === 'pending') continue;
    if (starting.get(el) === 'muted') starting.delete(el);
    const muted = el.muted;
    el.muted = false;
    el.play().catch(() => {});
    el.pause();
    el.muted = muted;
  }
}

// Frame size: the chosen one, else the first visual clip's (like the export)
function seqSize() {
  if (V.size) return V.size;
  const first = V.items.filter(isVisual).sort((a, b) => a.at - b.at || zOf(a) - zOf(b))[0];
  const el = first && V.els.get(first.id)?.el;
  const w = el && (el.videoWidth || el.naturalWidth), hh = el && (el.videoHeight || el.naturalHeight);
  return w ? [w - (w % 2), hh - (hh % 2)] : [1280, 720];
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawFrame(); });
}

function drawFrame() {
  const cv = $('#vidCanvas');
  const [W, H] = seqSize();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; renderVideoPanel(); }   // the panel shows the size
  const layers = tracksOf('video').filter((tr) => !tr.hidden).map((tr) =>
    V.items.filter((it) => it.track === tr.id && V.t >= it.at && V.t < itEnd(it)).sort((a, b) => a.at - b.at));
  // A clip that's loading or seeking has no frame to draw: keep the last picture for a moment
  // rather than flashing black (or the track underneath).
  const ready = (it) => {
    const el = mediaFor(it);
    return it.kind === 'image' ? el.complete && el.naturalWidth > 0 : el.readyState >= 2 && !el.seeking;
  };
  if (!layers.flat().every(ready)) {
    V.holdSince = V.holdSince || performance.now();
    if (performance.now() - V.holdSince < 500) return;
  }
  V.holdSince = 0;
  const ctx = cv.getContext('2d');
  ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  for (const live of layers) {
    for (const it of live) {
      const el = mediaFor(it);
      const nw = el.videoWidth || el.naturalWidth, nh = el.videoHeight || el.naturalHeight;
      if (!nw || (it.kind === 'video' && el.readyState < 2)) continue;
      const s = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh) * (it.scale || 1);
      const dw = nw * s, dh = nh * s;
      ctx.globalAlpha = (it.opacity ?? 1) * fadeGain(it, V.t, false);
      ctx.drawImage(el, (W - dw) / 2 + (it.x || 0) * W, (H - dh) / 2 + (it.y || 0) * H, dw, dh);
    }
  }
  ctx.globalAlpha = 1;
}

function vidPlay() {
  if (!V.items.length) return;
  if (V.t >= seqEnd() - 0.01) V.t = 0;
  unlockMedia();
  V.playing = true; V.clock = performance.now() - V.t * 1000;
  syncMedia();   // start what's under the playhead inside the tap, too
  showPlayState(); requestAnimationFrame(vidTick);
}
export function vidPause() {
  if (!V.playing) return;
  V.playing = false; syncMedia(); showPlayState(); requestDraw();
}
// While a clip is playing smoothly the timeline follows it (the "master"), so it never has to be
// corrected by seeking; the wall clock covers gaps, stills and clips that are still starting.
function masterTime() {
  const ok = (it) => it && it.kind !== 'image' && V.t >= it.at && V.t < itEnd(it) && V.els.has(it.id)
    && (({ el }) => !el.paused && !el.seeking && el.readyState >= 3)(V.els.get(it.id));
  let m = V.items.find((it) => it.id === V.master);
  if (!ok(m)) { m = V.items.find(ok); V.master = m ? m.id : null; }
  return m ? m.at + V.els.get(m.id).el.currentTime - m.in : null;
}

function vidTick() {
  if (!V.playing) return;
  const mt = masterTime();
  if (mt != null && Math.abs(mt - (performance.now() - V.clock) / 1000) < 0.5) V.clock = performance.now() - mt * 1000;
  V.t = (performance.now() - V.clock) / 1000;
  const end = seqEnd();
  if (V.t >= end) {
    if (V.loop && end > 0) { V.t = 0; V.clock = performance.now(); }
    else { V.t = end; vidPause(); updatePlayhead(); return; }
  }
  syncMedia(); drawFrame(); updatePlayhead(true);
  requestAnimationFrame(vidTick);
}
function vidSeek(t) {
  V.t = Math.max(0, t);
  if (V.playing) V.clock = performance.now() - V.t * 1000;
  syncMedia(); requestDraw(); updatePlayhead();
}
function showPlayState() { $('#vidPlay').textContent = V.playing ? '❚❚ Pause' : '▶ Play'; }

function updatePlayhead(follow = false) {
  const tl = $('#timeline'), ph = tl.querySelector('.tl-playhead');
  const x = HEAD_W + V.t * V.pps;
  if (ph) ph.style.left = `${x}px`;
  $('#vidTime').textContent = `${tc(V.t)} / ${tc(seqEnd())}`;
  if (follow && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft + HEAD_W)) tl.scrollLeft = x - HEAD_W - 30;
}

// ---- timeline drawing ----
function posterFor(it) {   // first frame of a video, as a small JPEG for the clip's filmstrip
  const p = V.posters.get(it.url);
  if (p) return p.startsWith('data:') ? p : null;
  V.posters.set(it.url, 'loading');
  const v = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', src: it.url });
  v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.1, (v.duration || 0) / 2); }, { once: true });
  v.addEventListener('seeked', () => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = Math.round((120 * v.videoHeight) / v.videoWidth) || 68;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    V.posters.set(it.url, c.toDataURL('image/jpeg', 0.7));
    v.removeAttribute('src'); v.load();
    renderTimeline();
  }, { once: true });
  v.addEventListener('error', () => V.posters.set(it.url, 'none'), { once: true });
  return null;
}

async function loadWave(url) {   // loudness peaks, 50 per second, for drawing audio clips
  V.waves.set(url, 'loading');
  try {
    const b = blobs.get(url);
    const buf = await (await fetch(b && b.state === 'ready' ? b.src : url)).arrayBuffer();
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
    const ch = audio.getChannelData(0), rate = 50, block = Math.floor(audio.sampleRate / rate);
    const peaks = new Float32Array(Math.ceil(ch.length / block));
    for (let i = 0; i < peaks.length; i++) {
      let m = 0;
      for (let j = i * block, e = Math.min(ch.length, j + block); j < e; j += 4) m = Math.max(m, Math.abs(ch[j]));
      peaks[i] = m;
    }
    const top = peaks.reduce((m, v) => Math.max(m, v), 0) || 1;   // scale quiet recordings up to full height
    V.waves.set(url, { peaks: peaks.map((v) => v / top), rate });
  } catch { V.waves.set(url, 'none'); }
  drawWaves();
}

function drawWaves() {
  document.querySelectorAll('#timeline canvas.wave').forEach((c) => {
    const it = V.items.find((i) => i.id === c.parentElement.dataset.id);
    const w = it && V.waves.get(it.url);
    if (it && !w) { loadWave(it.url); return; }
    if (!w || typeof w === 'string') return;
    const W = Math.min(8000, Math.max(1, Math.round(itLen(it) * V.pps))), H = LANE_H - 10;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#a7e8bd';
    for (let x = 0; x < W; x++) {
      const hh = Math.max(1, (w.peaks[Math.floor((it.in + x / V.pps) * w.rate)] || 0) * H);
      ctx.fillRect(x, (H - hh) / 2, 1, hh);
    }
  });
}

function clipEl(it) {
  const { xin } = xfades(it);
  const fi = Math.max(it.fadeIn || 0, xin);
  const bg = it.kind === 'video' ? posterFor(it) : it.kind === 'image' ? it.thumb || it.url : null;
  return h('div', { class: `tl-clip ${it.kind}` + (V.sel === it.id ? ' sel' : ''), 'data-id': it.id,
    style: `left:${it.at * V.pps}px;width:${Math.max(6, itLen(it) * V.pps)}px` + (bg ? `;background-image:url("${bg}")` : '') },
    it.kind === 'audio' ? h('canvas', { class: 'wave' }) : null,
    h('span', { class: 'tl-label' }, it.label),
    fi ? h('span', { class: 'tl-fade in', style: `width:${fi * V.pps}px` }) : null,
    it.fadeOut ? h('span', { class: 'tl-fade out', style: `width:${it.fadeOut * V.pps}px` }) : null,
    h('span', { class: 'tl-trim l' }), h('span', { class: 'tl-trim r' }));
}

function trackHead(tr) {
  const removable = tracksOf(tr.kind).length > 1 && !V.items.some((i) => i.track === tr.id);
  const tog = (key, on, off, title) => h('button', { type: 'button', class: 'tl-tog' + (tr[key] ? ' off' : ''), title,
    onclick: () => { tr[key] = !tr[key]; timelineChanged(); } }, tr[key] ? off : on);
  return h('div', { class: 'tl-head' },
    h('b', {}, trackName(tr)),
    h('div', { class: 'tl-head-btns' },
      tr.kind === 'video' ? tog('hidden', '👁', '◌', 'Show / hide this track') : null,
      tog('muted', '🔊', '🔇', 'Mute / unmute this track'),
      removable ? h('button', { type: 'button', class: 'tl-tog', title: 'Remove this empty track',
        onclick: () => { V.tracks = V.tracks.filter((t) => t !== tr); timelineChanged(); } }, '✕') : null));
}

function addTrack(kind) {
  const id = `${kind[0]}${uid()}`;
  V.tracks.push({ id, kind });
  return id;
}

function renderTimeline() {
  const tl = $('#timeline');
  const span = Math.max(seqEnd() + 10, (tl.clientWidth - HEAD_W) / V.pps);
  const major = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * V.pps >= 70) || 600;
  const ruler = h('div', { class: 'tl-ruler', style: `background-size:${(major * V.pps) / 5}px 100%` });
  for (let s = 0; s <= span; s += major) {
    ruler.append(h('span', { style: `left:${s * V.pps}px` }, s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s}s`));
  }
  const inner = h('div', { class: 'tl-inner', style: `width:${HEAD_W + span * V.pps}px` },
    h('div', { class: 'tl-row tl-ruler-row' },
      h('div', { class: 'tl-head tl-corner' },
        h('button', { type: 'button', class: 'tl-tog', title: 'Add a video track', onclick: () => { addTrack('video'); timelineChanged(); } }, '+V'),
        h('button', { type: 'button', class: 'tl-tog', title: 'Add an audio track', onclick: () => { addTrack('audio'); timelineChanged(); } }, '+A')),
      ruler));
  for (const tr of [...tracksOf('video')].reverse().concat(tracksOf('audio'))) {
    inner.append(h('div', { class: `tl-row ${tr.kind}` + (tr.hidden || tr.muted && tr.kind === 'audio' ? ' off' : '') },
      trackHead(tr),
      h('div', { class: 'tl-lane', 'data-track': tr.id }, V.items.filter((i) => i.track === tr.id).map(clipEl))));
  }
  inner.append(h('div', { class: 'tl-playhead' }));
  const { scrollLeft, scrollTop } = tl;
  tl.replaceChildren(inner);
  tl.scrollLeft = scrollLeft; tl.scrollTop = scrollTop;
  drawWaves(); pruneEls(); preloadMedia(); updatePlayhead();
  $('#vidEmpty').classList.toggle('hidden', V.items.length > 0);
}

function timelineChanged() {
  persistTimeline(); renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw();
}

export function renderVideo() { renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); }

// ---- timeline gestures: drag clips to move (also between tracks), drag their ends to trim ----
const timeAt = (e) => (e.clientX - $('#timeline .tl-inner').getBoundingClientRect().left - HEAD_W) / V.pps;

function dragWindow(onMove, onUp) {
  const up = (ev) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); onUp && onUp(ev); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

function startScrub(e) {
  e.preventDefault();
  vidPause();
  const go = (ev) => {
    let t = Math.max(0, timeAt(ev));
    for (const p of [0, ...V.items.flatMap((i) => [i.at, itEnd(i)])]) if (Math.abs(p - t) < 6 / V.pps) t = p;
    vidSeek(t);
  };
  go(e);
  dragWindow(go);
}

function startClipDrag(e, el) {
  const it = V.items.find((i) => i.id === el.dataset.id);
  if (!it) return;
  e.preventDefault();
  const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
  const x0 = e.clientX, y0 = e.clientY;
  const o = { at: it.at, in: it.in, out: it.out ?? (it.dur || 3) };
  if (V.sel !== it.id) {
    V.sel = it.id;
    $('#timeline').querySelectorAll('.tl-clip.sel').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
    renderVideoPanel();
  }
  const points = [0, V.t, ...V.items.filter((i) => i !== it).flatMap((i) => [i.at, itEnd(i)])];
  const snap = (t) => {
    let best = t, d = 8 / V.pps;
    for (const p of points) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
    return best;
  };
  let moved = false;
  dragWindow((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 5 && Math.abs(ev.clientY - y0) < 5) return;
    moved = true;
    const dt = (ev.clientX - x0) / V.pps;
    if (mode === 'move') {
      const len = o.out - o.in, at = Math.max(0, o.at + dt);
      const a1 = snap(at), a2 = snap(at + len) - len;   // snap whichever end is closer to something
      const d1 = a1 !== at ? Math.abs(a1 - at) : Infinity, d2 = a2 !== at ? Math.abs(a2 - at) : Infinity;
      it.at = Math.max(0, d1 <= d2 && d1 < Infinity ? a1 : d2 < Infinity ? a2 : at);
      const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tl-lane');
      const tr = lane && V.tracks.find((t) => t.id === lane.dataset.track);
      if (tr && (tr.kind === 'audio') === (it.kind === 'audio')) it.track = tr.id;
    } else if (mode === 'l') {
      let d = snap(o.at + dt) - o.at;
      if (it.kind !== 'image') d = Math.max(d, -o.in);   // not before the start of the source
      d = Math.max(-o.at, Math.min(d, o.out - o.in - MIN_LEN));
      it.at = o.at + d;
      if (it.kind === 'image') it.out = o.out - d; else it.in = o.in + d;
    } else {
      let out = o.in + snap(o.at + (o.out - o.in) + dt) - o.at;
      out = Math.max(o.in + MIN_LEN, it.kind === 'image' || !it.dur ? out : Math.min(out, it.dur));
      it.out = out;
    }
    renderTimeline(); syncMedia(); requestDraw();
  }, () => { if (moved) timelineChanged(); });
}

function wireTimeline() {
  const tl = $('#timeline');
  tl.addEventListener('pointerdown', (e) => {
    const clip = e.target.closest('.tl-clip');
    if (clip) startClipDrag(e, clip);
    else if (e.target.closest('.tl-ruler')) startScrub(e);
  });
  tl.addEventListener('click', (e) => {   // tap an empty spot: deselect and move the playhead there
    if (!e.target.classList.contains('tl-lane')) return;
    V.sel = null; vidPause(); vidSeek(Math.max(0, timeAt(e))); renderTimeline(); renderVideoPanel();
  });
  tl.addEventListener('wheel', (e) => {   // ctrl/pinch + wheel zooms around the pointer
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTimeline(V.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
  }, { passive: false });
  new ResizeObserver(() => renderTimeline()).observe(tl);
}

function zoomTimeline(pps, aroundT = V.t, clientX = null) {
  const tl = $('#timeline');
  const screenX = clientX != null ? clientX - tl.getBoundingClientRect().left : HEAD_W + V.t * V.pps - tl.scrollLeft;
  V.pps = Math.max(4, Math.min(400, pps));
  persistTimeline(); renderTimeline();
  tl.scrollLeft = HEAD_W + aroundT * V.pps - screenX;
}

function fitTimeline() {
  const tl = $('#timeline');
  zoomTimeline((tl.clientWidth - HEAD_W - 30) / Math.max(1, seqEnd()), 0, HEAD_W);
  tl.scrollLeft = 0;
}

// ---- editing ----
function splitAtPlayhead() {
  const t = V.t;
  const under = V.items.filter((it) => t > it.at + 0.02 && t < itEnd(it) - 0.02);
  const targets = under.some((it) => it.id === V.sel) ? under.filter((it) => it.id === V.sel) : under;
  if (!targets.length) return toast('Put the playhead over a clip to split it', true);
  for (const a of targets) {
    const end = itEnd(a), b = { ...a, id: uid(), at: t, fadeIn: 0 };
    if (a.kind === 'image') { b.out = end - t; a.out = t - a.at; } else { b.in = a.in + (t - a.at); a.out = b.in; }
    a.fadeOut = 0;
    V.items.splice(V.items.indexOf(a) + 1, 0, b);
  }
  timelineChanged();
}

function deleteSelected() {
  const it = selItem();
  if (!it) return;
  const before = V.items;
  V.items = V.items.filter((i) => i !== it);
  V.sel = null;
  timelineChanged();
  undoToast('Clip deleted', () => { V.items = before; V.sel = it.id; timelineChanged(); });
}

// Overlap this clip with the one before it on its track (moving it and everything after it on
// that track to the left), so the two cross-fade.
function crossfadePrev(it, d = 0.5) {
  const prev = V.items.filter((i) => i !== it && i.track === it.track && i.at < it.at)
    .sort((a, b) => itEnd(b) - itEnd(a))[0];
  if (!prev) return toast('There is no clip before this one on its track', true);
  d = Math.min(d, itLen(prev) / 2, itLen(it) / 2);
  const shift = it.at - (itEnd(prev) - d);
  for (const i of V.items) if (i.track === it.track && i.at >= it.at) i.at = Math.max(0, i.at - shift);
  timelineChanged();
}

function targetTrack(kind) {
  const want = kind === 'audio' ? 'audio' : 'video';
  const sel = selItem(), st = sel && trackOf(sel);
  if (st && st.kind === want) return st.id;
  return (tracksOf(want)[0] || {}).id || addTrack(want);
}

function probeDuration(url, tag) {
  return new Promise((res) => {
    const m = Object.assign(document.createElement(tag), { preload: 'metadata', muted: true });
    m.onloadedmetadata = () => { res(isFinite(m.duration) ? m.duration : 0); m.removeAttribute('src'); };
    m.onerror = () => res(0);
    m.src = url;
  });
}

// New clips go after the last clip on the selected clip's track (or V1 / A1)
export async function addToTimeline(media) {
  if (media.kind !== 'image' && !media.dur) media.dur = await probeDuration(media.url, media.kind === 'audio' ? 'audio' : 'video');
  const it = newItem(media, targetTrack(media.kind));
  it.at = V.items.filter((i) => i.track === it.track).reduce((m, i) => Math.max(m, itEnd(i)), 0);
  V.items.push(it); V.sel = it.id;
  timelineChanged();
  return it;
}

// A card that adds its clip to the timeline on every tap (the sheet stays open)
const addCard = (o, label, media) => mediaCard(cardMedia(o), label, async (c) => {
  c.classList.add('picked');
  await addToTimeline(media);
  toast('Added');
}, { badge: o.kind === 'video' ? '▶' : null });

function addFromHistory() {
  pickerSheet('Add from this project', [
    hint('Tap to add in order. Videos and images go on the selected video track, sound on the audio track.', 'grow'),
    button('Done', closeSheet)], async () => {
    const items = await projectOutputs(['video', 'image', 'audio']);
    return items.length ? items.map(({ g, o, i }) => addCard(o, genLabel(g),
      { kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: genLabel(g), dur: o.duration || 0 }))
      : placeholder('Nothing generated in this project yet.');
  });
}

function addImages() {
  openImagePicker({ title: 'Add images', multi: true, mp: () => 0, onPick: (name) => addToTimeline({
    kind: 'image', src: { input: name }, url: inputUrl(name),
    thumb: thumbUrl(name, 160), label: name.split('/').pop() }) });
}

function addMediaFiles() {
  const media = (m) => ({ kind: m.kind, src: { media: m.name }, url: m.url, label: m.label, thumb: m.kind === 'image' ? m.url : null });
  const reload = pickerSheet('Sound and files', [
    fileButton('Upload…', async (files) => {
      for (const f of files) {
        toast(`Uploading ${f.name}…`);
        try { await addToTimeline(media(await uploadMedia(f))); }
        catch (e) { toast('Upload failed: ' + e.message, true); return; }
      }
      toast(files.length > 1 ? `Added ${files.length} files` : 'Added');
      reload();
    }, { accept: 'audio/*,video/*,image/*', multiple: true, cls: 'small primary' }),
    hint('Music, voice-overs, or videos and images from elsewhere.', 'grow'),
    button('Done', closeSheet)], async () => {
    const list = await api('/api/media');
    return list.length ? list.map((m) => addCard(m, m.label, media(m))) : placeholder('No files yet. Upload music, a voice-over or a video.');
  });
}

// ---- inspector panel ----
// a number box for a clip setting: dragged like a slider it shows on the timeline as it goes
const numField = (label, get, set, { step = 0.04, min = 0, max = 600 } = {}) =>
  propNum(label, Number(get()).toFixed(2), set, timelineChanged, { step, min, max, live: () => { renderTimeline(); syncMedia(); requestDraw(); } });

const clipRange = (label, get, set, opts) => rangeField(label, get, set,
  { ...opts, onInput: () => { renderTimeline(); syncMedia(); requestDraw(); }, onChange: persistTimeline });

const SIZES = [['Match first clip', null], ['1280×720', [1280, 720]], ['1920×1080', [1920, 1080]], ['720×1280', [720, 1280]],
  ['1080×1920', [1080, 1920]], ['1024×1024', [1024, 1024]], ['832×480', [832, 480]], ['480×832', [480, 832]]];

function renderVideoPanel() {
  const it = selItem();
  const pct = (v) => `${Math.round(v * 100)}%`;
  const clip = it ? (() => {
    const len = itLen(it), tr = trackOf(it);
    const fields = [numField('Starts at (s)', () => it.at, (v) => { it.at = Math.max(0, v); })];
    if (it.kind === 'image') fields.push(numField('Duration (s)', () => len, (v) => { it.out = Math.max(MIN_LEN, v); }, { min: MIN_LEN, max: 60 }));
    else fields.push(
      numField('In (s)', () => it.in, (v) => { it.in = Math.max(0, Math.min(v, (it.out ?? it.dur) - MIN_LEN)); }, { max: it.dur || undefined }),
      numField('Out (s)', () => it.out ?? it.dur, (v) => { it.out = Math.max(it.in + MIN_LEN, it.dur ? Math.min(v, it.dur) : v); }, { max: it.dur || undefined }));
    fields.push(
      numField('Fade in (s)', () => it.fadeIn || 0, (v) => { it.fadeIn = Math.max(0, Math.min(v, len)); }, { step: 0.1, max: Math.max(0.1, len) }),
      numField('Fade out (s)', () => it.fadeOut || 0, (v) => { it.fadeOut = Math.max(0, Math.min(v, len)); }, { step: 0.1, max: Math.max(0.1, len) }));
    return section(it.label, null,
      hint(`${it.kind} on ${tr ? trackName(tr) : '?'} · ${fmtT(len)}${it.dur ? ` of ${fmtT(it.dur)}` : ''}`, 'section-sub'),
      h('div', { class: 'grid-2' }, fields),
      isVisual(it) ? [
        field('Framing', seg([['fit', 'Fit'], ['fill', 'Fill']], it.fit || 'fit', (k) => { it.fit = k; timelineChanged(); })),
        clipRange('Scale', () => it.scale ?? 1, (v) => { it.scale = v; }, { min: 0.1, max: 3, step: 0.01, fmt: pct }),
        clipRange('Position X', () => it.x || 0, (v) => { it.x = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
        clipRange('Position Y', () => it.y || 0, (v) => { it.y = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
        clipRange('Opacity', () => it.opacity ?? 1, (v) => { it.opacity = v; }, { min: 0, max: 1, step: 0.01, fmt: pct }),
      ] : null,
      it.kind !== 'image' ? clipRange('Volume', () => it.volume ?? 1, (v) => { it.volume = v; }, { min: 0, max: 2, step: 0.01,
        fmt: (v) => pct(v) + (v > 1 ? ' (preview plays at 100%)' : '') }) : null,
      h('div', { class: 'row wrap' },
        button('✂ Split at playhead', splitAtPlayhead, { title: 'S' }),
        button('⤫ Cross-fade with previous', () => crossfadePrev(it)),
        isVisual(it) ? button('Reset framing', () => { Object.assign(it, { x: 0, y: 0, scale: 1, opacity: 1, fit: 'fit' }); timelineChanged(); }) : null,
        button('Delete clip', deleteSelected, { cls: 'small danger', title: 'Delete' })));
  })() : null;

  const sizeSel = h('select', {}, SIZES.map(([label, s], i) => h('option', { value: i, selected: JSON.stringify(s) === JSON.stringify(V.size) }, label)));
  if (V.size && !SIZES.some(([, s]) => JSON.stringify(s) === JSON.stringify(V.size))) sizeSel.append(h('option', { value: 'custom', selected: true }, V.size.join('×')));
  sizeSel.addEventListener('change', () => { V.size = SIZES[sizeSel.value]?.[1] || V.size; timelineChanged(); });
  const fpsSel = h('select', {}, [[0, 'Match first clip'], [16, '16'], [24, '24'], [25, '25'], [30, '30'], [60, '60']].map(([v, label]) =>
    h('option', { value: v, selected: V.fps === v }, label)));
  fpsSel.addEventListener('change', () => { V.fps = Number(fpsSel.value); timelineChanged(); });
  const exportBtn = button('Export video', () => exportVideo(exportBtn), { cls: 'primary' });

  $('#videoPanel').replaceChildren(h('div', { class: 'panel-body' },
    h('div', { class: 'row wrap' },
      button('+ Clips', addFromHistory, { cls: 'small primary' }),
      button('+ Images', addImages),
      button('+ Sound / files', addMediaFiles)),
    clip || hint(V.items.length
      ? 'Tap a clip to edit it. Drag clips to move them (also onto other tracks), drag their ends to trim, and overlap two clips on a track to cross-fade. Higher video tracks draw on top.'
      : 'Add generated clips, images or sound. They line up on V1 / A1; drag them onto V2 to layer them over V1.'),
    section('Sequence', null,
      hint(`${seqSize().join('×')} · ${V.fps || 'auto'} fps · ${fmtT(seqEnd())}`, 'section-sub'),
      h('div', { class: 'grid-2' }, field('Frame size', sizeSel), field('Frame rate', fpsSel)),
      V.items.length ? panelTop(exportBtn, () => {
        if (!confirm('Remove every clip from the timeline?')) return;
        V.items = []; V.sel = null; vidSeek(0); timelineChanged();
      }) : null,
      V.items.length ? hint('The export lands in History.') : null)));
}

async function exportVideo(btn) {
  vidPause();
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const g = await api('/api/video/render', { method: 'POST', body: {
      project_id: S.project, width: V.size && V.size[0], height: V.size && V.size[1], fps: V.fps || null,
      tracks: V.tracks.map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),
      items: V.items.map((it) => ({ track: it.track, src: it.src, at: it.at, in: it.in, out: it.out ?? it.dur,
        x: it.x, y: it.y, scale: it.scale, fit: it.fit, opacity: it.opacity, volume: it.volume,
        fade_in: it.fadeIn, fade_out: it.fadeOut })) } });
    S.history.set(g.id, g);
    openGeneration(g.id);
  } catch (e) { toast('Export failed: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Export video'; }
}

// Full screen for the preview and its controls. Browsers without element full screen (older
// iPads) get the same look by pinning the stage over the page.
const vidStage = () => $('#tab-video .stage');
const vidFullscreen = () => (document.fullscreenElement || document.webkitFullscreenElement) === vidStage()
  || vidStage().classList.contains('pseudo-fs');

function exitVideoFullscreen() {
  const stage = vidStage();
  stage.classList.remove('pseudo-fs');
  if ((document.fullscreenElement || document.webkitFullscreenElement) === stage) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function toggleVideoFullscreen() {
  if (vidFullscreen()) return exitVideoFullscreen();
  const stage = vidStage(), req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  const fallback = () => { stage.classList.add('pseudo-fs'); showFullscreenState(); };
  if (!req) return fallback();
  try { Promise.resolve(req.call(stage)).catch(fallback); } catch { fallback(); }
}

function showFullscreenState() {
  const on = vidFullscreen();
  $('#vidFull').textContent = on ? '✕' : '⛶';
  $('#vidFull').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  requestDraw();
}

// The frame under the playhead at the sequence's full size: save it as an input or download it
async function snapshotFrame() {
  if (!V.items.length) return toast('Add something to the timeline first', true);
  vidPause();
  if (vidFullscreen()) exitVideoFullscreen();   // the popup lives outside the full-screen stage
  const cv = $('#vidCanvas');
  drawFrame();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) return toast('Could not grab the frame', true);
  if (snapshotFrame.url) URL.revokeObjectURL(snapshotFrame.url);   // the previous frame's
  const url = snapshotFrame.url = URL.createObjectURL(blob), name = `frame_${tc(V.t).replace(/:/g, '-')}.png`;
  openSheet(h('h3', {}, `Frame at ${tc(V.t)}`),
    h('div', { class: 'media-big' }, h('img', { src: url, alt: '' })),
    hint(`${cv.width}×${cv.height}`, 'sheet-hint'),
    actions(
      button('Save as input', async () => {
        try {
          const r = await uploadImage(blob, { mp: 0, source: 'snapshot', filename: name });
          useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
        } catch (e) { toast('Save failed: ' + e.message, true); }
      }, { cls: 'small primary' }),
      linkBtn('Download', url, { download: name }),
      button('Close', closeSheet, { cls: 'small ghost' })));
}

export function wireVideoTransport() {
  const step = (d) => { vidPause(); vidSeek(V.t + d); };
  $('#vidStart').addEventListener('click', () => { vidPause(); vidSeek(0); });
  $('#vidPrev').addEventListener('click', () => step(-1 / fpsNow()));
  $('#vidNext').addEventListener('click', () => step(1 / fpsNow()));
  $('#vidPlay').addEventListener('click', () => (V.playing ? vidPause() : vidPlay()));
  $('#vidSnap').addEventListener('click', snapshotFrame);
  $('#vidFull').addEventListener('click', toggleVideoFullscreen);
  document.addEventListener('fullscreenchange', showFullscreenState);
  document.addEventListener('webkitfullscreenchange', showFullscreenState);
  const loopBtn = $('#vidLoop');
  const showLoop = () => { loopBtn.classList.toggle('on', V.loop); loopBtn.setAttribute('aria-pressed', String(V.loop)); };
  loopBtn.addEventListener('click', () => { V.loop = !V.loop; store.set('deck.video.loop', V.loop); showLoop(); });
  showLoop();
  $('#tlTools').replaceChildren(
    button('✂ Split', splitAtPlayhead, { title: 'Split at playhead (S)' }),
    button('🗑 Delete', deleteSelected, { title: 'Delete selected clip (Del)' }),
    h('span', { class: 'hint tl-tip' }, 'Drag clips to move · drag ends to trim · overlap to cross-fade'),
    iconBtn('Zoom out', '−', () => zoomTimeline(V.pps / 1.5)),
    button('Fit', fitTimeline),
    iconBtn('Zoom in', '+', () => zoomTimeline(V.pps * 1.5)));
  wireTimeline();
  showPlayState();
  // Premiere-ish keys while the Video tab is open
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-video').classList.contains('active') || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const keys = {
      ' ': () => (V.playing ? vidPause() : vidPlay()),
      ArrowLeft: () => step(e.shiftKey ? -1 : -1 / fpsNow()),
      ArrowRight: () => step(e.shiftKey ? 1 : 1 / fpsNow()),
      Home: () => { vidPause(); vidSeek(0); },
      End: () => { vidPause(); vidSeek(seqEnd()); },
      s: splitAtPlayhead, c: splitAtPlayhead, f: toggleVideoFullscreen,
      Escape: () => { if (vidStage().classList.contains('pseudo-fs')) { exitVideoFullscreen(); showFullscreenState(); } },
      Delete: deleteSelected, Backspace: deleteSelected,
      '=': () => zoomTimeline(V.pps * 1.5), '+': () => zoomTimeline(V.pps * 1.5), '-': () => zoomTimeline(V.pps / 1.5),
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });
}
