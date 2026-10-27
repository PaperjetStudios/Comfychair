import {
  $, h, store, uid, api, toast, undoToast, clamp, button, iconBtn, linkBtn, seg, field, section, hint, help, info, note,
  placeholder, numSlider, fileButton,
} from './ui.js';
import { S, onServer } from './core.js';
import { adoptGenerations } from './generate.js';
import { extractSound, openSoundPicker, soundInput, soundSource, uploadMedia } from './media.js';
import { waitJob } from './clipimport.js';
import { TabSet } from './tabs.js';

// ---------------------------------------------------------------------------
// sound: a multi-track sound editor laid out like the Video tab. Tracks mix (mute, solo, level, pan),
// clips are sound files or the sound of clips; drag to move, drag the ends to trim, overlap on a track to
// cross-fade. Playback goes through Web Audio (level above 100 %, pan, a meter); Export sends the same
// timeline to the server (app/audioedit.render), which mixes it with ffmpeg into the media library.
// ---------------------------------------------------------------------------
const HEAD_W = 112;   // track header column (px)
const LANE_H = 60;
const MIN_LEN = 0.05;
const N = {
  tracks: [], items: [], pps: store.get('deck.sound.pps', 30),   // pps: zoom, pixels per second (this device only)
  t: 0, playing: false, clock: 0, loop: store.get('deck.sound.loop', false), sel: null,
  els: new Map(), waves: new Map(), exports: [], gens: [],   // gens: this mix's sound generations (ids), newest last
  out: { name: '', format: store.get('deck.sound.format', 'm4a'), gain: 1, normalize: false },
};
const defaultTracks = () => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
N.tracks = defaultTracks();

function newItem({ kind, src, url, label, dur = 0 }, track) {
  return { id: uid(), track, kind, src, url, label, dur, at: 0, in: 0, out: dur || null, volume: 1, pan: 0, fadeIn: 0, fadeOut: 0 };
}

let tabs = null, tabsReady = null;
const ensureTabs = () => tabsReady || (tabsReady = tabs ? tabs.start() : Promise.resolve());
const persist = () => tabs?.changed();

const itLen = (it) => Math.max(MIN_LEN, (it.out ?? (it.dur || 3)) - it.in);
const itEnd = (it) => it.at + itLen(it);
const trackOf = (it) => N.tracks.find((t) => t.id === it.track);
const trackName = (t) => t.name || `A${N.tracks.indexOf(t) + 1}`;
const seqEnd = () => N.items.reduce((m, it) => Math.max(m, itEnd(it)), 0);
const selItem = () => N.items.find((i) => i.id === N.sel) || null;
const soloed = () => N.tracks.some((t) => t.solo);
const audible = (tr) => tr && !tr.muted && (!soloed() || tr.solo);
const tc = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

// overlap with the clip before (xin) / after (xout) on the same track: both fade over it (audioedit / videoedit._overlaps)
function xfades(it) {
  let xin = 0, xout = 0;
  for (const o of N.items) {
    if (o === it || o.track !== it.track) continue;
    if (o.at < it.at || (o.at === it.at && N.items.indexOf(o) < N.items.indexOf(it))) xin = Math.max(xin, Math.min(itEnd(o) - it.at, itLen(it), itLen(o)));
    else xout = Math.max(xout, Math.min(itEnd(it) - o.at, itLen(it), itLen(o)));
  }
  return { xin, xout };
}
function fadeGain(it, t) {
  const local = t - it.at, len = itLen(it), { xin, xout } = xfades(it);
  const fi = Math.max(it.fadeIn || 0, xin), fo = Math.max(it.fadeOut || 0, xout);
  let g = 1;
  if (fi > 0 && local < fi) g = Math.min(g, local / fi);
  if (fo > 0 && len - local < fo) g = Math.min(g, (len - local) / fo);
  return clamp(g, 0, 1);
}

// ---- playback: one <audio> per clip through Web Audio (gain, pan) into a master gain and a meter ----
const A = { ctx: null, master: null, meter: null, data: null };
function audioCtx() {
  if (A.ctx) return A.ctx;
  A.ctx = new (window.AudioContext || window.webkitAudioContext)();
  A.master = A.ctx.createGain();
  A.meter = A.ctx.createAnalyser(); A.meter.fftSize = 1024;
  A.data = new Float32Array(A.meter.fftSize);
  A.master.connect(A.meter); A.meter.connect(A.ctx.destination);
  return A.ctx;
}

function mediaFor(it) {
  const m = N.els.get(it.id);
  if (m && m.url === it.url) return m;
  if (m) { m.el.pause(); m.el.removeAttribute('src'); }
  const el = Object.assign(document.createElement('audio'), { preload: 'auto', src: it.url, crossOrigin: 'anonymous' });
  el.addEventListener('loadedmetadata', () => gotDuration(it, el.duration));
  const e = { el, url: it.url, gain: null, pan: null };
  N.els.set(it.id, e);
  return e;
}
function wire(e) {   // into the graph on first play (an AudioContext needs a tap to start)
  if (e.gain) return;
  const ctx = audioCtx();
  const srcNode = ctx.createMediaElementSource(e.el);
  e.gain = ctx.createGain();
  e.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  srcNode.connect(e.gain);
  if (e.pan) { e.gain.connect(e.pan); e.pan.connect(A.master); } else e.gain.connect(A.master);
}
function gotDuration(it, d) {
  if (!isFinite(d) || !d || Math.abs(it.dur - d) < 0.01) return;
  it.dur = d;
  if (it.out == null || it.out > d) it.out = d;
  persist(); renderTimeline();
}
function pruneEls() {
  for (const [id, m] of N.els) {
    if (N.items.some((i) => i.id === id)) continue;
    m.el.pause(); m.el.removeAttribute('src');
    N.els.delete(id);
  }
}

function syncMedia() {
  if (A.master) A.master.gain.value = N.out.gain;
  for (const it of N.items) {
    const e = mediaFor(it), el = e.el, tr = trackOf(it);
    if (N.t < it.at || N.t >= itEnd(it)) {
      if (!el.paused) el.pause();
      if (it.at > N.t && it.at - N.t < 3 && !el.seeking && Math.abs(el.currentTime - it.in) > 0.05) el.currentTime = it.in;
      continue;
    }
    const want = it.in + N.t - it.at;
    const level = audible(tr) ? (it.volume ?? 1) * (tr.volume ?? 1) * fadeGain(it, N.t) : 0;
    if (e.gain) { e.gain.gain.value = level; el.volume = 1; } else el.volume = clamp(level, 0, 1);
    if (e.pan) e.pan.pan.value = clamp((it.pan || 0) + (tr?.pan || 0), -1, 1);
    if (N.playing) {
      if (el.paused) { el.currentTime = want; el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.01) el.currentTime = want;
    }
  }
}

function sndTick() {
  if (!N.playing) return;
  N.t = (performance.now() - N.clock) / 1000;
  const end = seqEnd();
  if (N.t >= end) {
    if (N.loop && end > 0) { N.t = 0; N.clock = performance.now(); }
    else { N.t = end; sndPause(); updatePlayhead(); return; }
  }
  syncMedia(); updatePlayhead(true); drawStage();
  requestAnimationFrame(sndTick);
}
function sndPlay() {
  if (!N.items.length) return;
  if (N.t >= seqEnd() - 0.01) N.t = 0;
  audioCtx().resume?.();
  for (const it of N.items) wire(mediaFor(it));
  N.playing = true; N.clock = performance.now() - N.t * 1000;
  syncMedia(); showPlayState(); requestAnimationFrame(sndTick);
}
export function sndPause() {
  if (!N.playing) return;
  N.playing = false; syncMedia(); showPlayState(); drawStage();
}
function sndSeek(t) {
  N.t = Math.max(0, t);
  if (N.playing) N.clock = performance.now() - N.t * 1000;
  syncMedia(); updatePlayhead(); drawStage();
}
function showPlayState() { $('#sndPlay').textContent = N.playing ? '❚❚ Pause' : '▶ Play'; }
function updatePlayhead(follow = false) {
  const tl = $('#sndTimeline'), ph = tl.querySelector('.tl-playhead');
  const x = HEAD_W + N.t * N.pps;
  if (ph) ph.style.left = `${x}px`;
  $('#sndTime').textContent = `${tc(N.t)} / ${tc(seqEnd())}`;
  if (follow && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft + HEAD_W)) tl.scrollLeft = x - HEAD_W - 30;
}

// ---- waveforms: loudness peaks, 100 per second ----
async function loadWave(url) {
  N.waves.set(url, 'loading');
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
    const chans = [...Array(audio.numberOfChannels)].map((_, c) => audio.getChannelData(c));
    const rate = 100, block = Math.floor(audio.sampleRate / rate), n = Math.ceil(chans[0].length / block);
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of chans) for (let j = i * block, e = Math.min(ch.length, j + block); j < e; j += 2) m = Math.max(m, Math.abs(ch[j]));
      peaks[i] = m;
    }
    N.waves.set(url, { peaks, rate });
  } catch { N.waves.set(url, 'none'); }
  drawWaves(); drawStage();
}
const waveOf = (it) => { const w = N.waves.get(it.url); if (!w) loadWave(it.url); return w && typeof w !== 'string' ? w : null; };

function paintWave(ctx, it, w, x0, W, H, pps, color) {
  ctx.fillStyle = color;
  const gain = Math.min(2, it.volume ?? 1);
  for (let x = 0; x < W; x++) {
    const t = it.in + x / pps;
    const v = (w.peaks[Math.floor(t * w.rate)] || 0) * gain * fadeGain(it, it.at + x / pps);
    const hh = Math.max(1, Math.min(1, v) * H);
    ctx.fillRect(x0 + x, (H - hh) / 2, 1, hh);
  }
}
function drawWaves() {
  document.querySelectorAll('#sndTimeline canvas.wave').forEach((c) => {
    const it = N.items.find((i) => i.id === c.parentElement.dataset.id);
    const w = it && waveOf(it);
    if (!w) return;
    const W = Math.min(16000, Math.max(1, Math.round(itLen(it) * N.pps))), H = LANE_H - 12;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    paintWave(ctx, it, w, 0, W, H, N.pps, '#a7e8bd');
  });
}

// ---- the stage: the whole mix at a glance (tap to jump there) and a level meter ----
function drawStage() {
  const cv = $('#sndCanvas');
  if (!cv || !$('#tab-sound').classList.contains('active')) return;
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const meterW = Math.round(22 * dpr), plotW = W - meterW - 8 * dpr;
  const end = Math.max(seqEnd(), 1), pps = plotW / end;
  const rows = N.tracks.length || 1, rowH = H / rows;
  N.tracks.forEach((tr, ri) => {
    ctx.save(); ctx.translate(0, ri * rowH);
    ctx.fillStyle = ri % 2 ? '#14161c' : '#171a21'; ctx.fillRect(0, 0, plotW, rowH);
    for (const it of N.items.filter((i) => i.track === tr.id)) {
      const w = waveOf(it), x0 = Math.round(it.at * pps), ww = Math.max(1, Math.round(itLen(it) * pps));
      ctx.fillStyle = it.id === N.sel ? '#3b6b4f' : '#24533a'; ctx.fillRect(x0, 2, ww, rowH - 4);
      if (w) { ctx.save(); ctx.translate(0, 4); paintWave(ctx, it, w, x0, ww, rowH - 8, pps, audible(tr) ? '#a7e8bd' : '#55705f'); ctx.restore(); }
    }
    ctx.restore();
  });
  ctx.fillStyle = '#ff4d4d'; ctx.fillRect(Math.round(N.t * pps), 0, Math.max(1, dpr * 2), H);
  // meter: the master's peak (dB, -48..0) while playing
  let peak = 0;
  if (A.meter && N.playing) { A.meter.getFloatTimeDomainData(A.data); for (const v of A.data) peak = Math.max(peak, Math.abs(v)); }
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity, f = clamp((db + 48) / 48, 0, 1);
  const mx = W - meterW;
  ctx.fillStyle = '#1f232c'; ctx.fillRect(mx, 0, meterW, H);
  ctx.fillStyle = db > -1 ? '#ef6a6a' : db > -9 ? '#e9b44c' : '#5fcf8a';
  ctx.fillRect(mx, H * (1 - f), meterW, H * f);
}

// ---- timeline ----
function clipEl(it) {
  const { xin } = xfades(it), fi = Math.max(it.fadeIn || 0, xin);
  return h('div', { class: 'tl-clip audio' + (N.sel === it.id ? ' sel' : ''), 'data-id': it.id,
    style: `left:${it.at * N.pps}px;width:${Math.max(6, itLen(it) * N.pps)}px` },
    h('canvas', { class: 'wave' }),
    h('span', { class: 'tl-label' }, `${it.kind === 'video' ? '🎞 ' : ''}${it.label}${(it.volume ?? 1) !== 1 ? ` · ${Math.round(it.volume * 100)}%` : ''}`),
    fi ? h('span', { class: 'tl-fade in', style: `width:${fi * N.pps}px` }) : null,
    it.fadeOut ? h('span', { class: 'tl-fade out', style: `width:${it.fadeOut * N.pps}px` }) : null,
    h('span', { class: 'tl-trim l' }), h('span', { class: 'tl-trim r' }));
}

function trackHead(tr) {
  const removable = N.tracks.length > 1 && !N.items.some((i) => i.track === tr.id);
  const tog = (key, on, off, title, cls = '') => h('button', { type: 'button', class: `tl-tog ${cls}` + (tr[key] ? ' off' : ''), title,
    onclick: () => { tr[key] = !tr[key]; changed(); } }, tr[key] ? off : on);
  return h('div', { class: 'tl-head' },
    h('b', { title: 'Tap a clip on this track to set the track level and pan' }, trackName(tr)),
    h('div', { class: 'tl-head-btns' },
      tog('muted', '🔊', '🔇', 'Mute / unmute this track'),
      h('button', { type: 'button', class: 'tl-tog' + (tr.solo ? ' solo' : ''), title: 'Solo: hear only the soloed tracks',
        onclick: () => { tr.solo = !tr.solo; changed(); } }, 'S'),
      removable ? h('button', { type: 'button', class: 'tl-tog', title: 'Remove this empty track',
        onclick: () => { N.tracks = N.tracks.filter((t) => t !== tr); changed(); } }, '✕') : null));
}

function renderTimeline() {
  const tl = $('#sndTimeline');
  const span = Math.max(seqEnd() + 10, (tl.clientWidth - HEAD_W) / N.pps);
  const major = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * N.pps >= 70) || 600;
  const ruler = h('div', { class: 'tl-ruler', style: `background-size:${(major * N.pps) / 5}px 100%` });
  for (let s = 0; s <= span; s += major) {
    ruler.append(h('span', { style: `left:${s * N.pps}px` }, s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${+s.toFixed(2)}s`));
  }
  const inner = h('div', { class: 'tl-inner', style: `width:${HEAD_W + span * N.pps}px` },
    h('div', { class: 'tl-row tl-ruler-row' },
      h('div', { class: 'tl-head tl-corner' },
        h('button', { type: 'button', class: 'tl-tog', title: 'Add a track', onclick: () => { addTrack(); changed(); } }, '+ Track')),
      ruler));
  for (const tr of N.tracks) {
    inner.append(h('div', { class: 'tl-row audio snd-row' + (audible(tr) ? '' : ' off') },
      trackHead(tr),
      h('div', { class: 'tl-lane', 'data-track': tr.id }, N.items.filter((i) => i.track === tr.id).map(clipEl))));
  }
  inner.append(h('div', { class: 'tl-playhead' }));
  const { scrollLeft, scrollTop } = tl;
  tl.replaceChildren(inner);
  tl.scrollLeft = scrollLeft; tl.scrollTop = scrollTop;
  drawWaves(); pruneEls(); updatePlayhead(); drawStage();
  $('#sndEmpty').classList.toggle('hidden', N.items.length > 0);
}

function addTrack() { const id = `a${uid()}`; N.tracks.push({ id }); return id; }
function changed() { persist(); renderTimeline(); renderPanel(); syncMedia(); }

export function renderSound() { renderTimeline(); renderPanel(); syncMedia(); ensureTabs(); }

// ---- gestures ----
const timeAt = (e) => (e.clientX - $('#sndTimeline .tl-inner').getBoundingClientRect().left - HEAD_W) / N.pps;
function dragWindow(onMove, onUp) {
  const up = (ev) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); onUp && onUp(ev); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
function startScrub(e) {
  e.preventDefault();
  sndPause();
  const go = (ev) => {
    let t = Math.max(0, timeAt(ev));
    for (const p of [0, ...N.items.flatMap((i) => [i.at, itEnd(i)])]) if (Math.abs(p - t) < 6 / N.pps) t = p;
    sndSeek(t);
  };
  go(e);
  dragWindow(go);
}
function startClipDrag(e, el) {
  const it = N.items.find((i) => i.id === el.dataset.id);
  if (!it) return;
  e.preventDefault();
  const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
  const x0 = e.clientX, y0 = e.clientY;
  const o = { at: it.at, in: it.in, out: it.out ?? (it.dur || 3) };
  if (N.sel !== it.id) {
    N.sel = it.id;
    $('#sndTimeline').querySelectorAll('.tl-clip.sel').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
    renderPanel(); drawStage();
  }
  const points = [0, N.t, ...N.items.filter((i) => i !== it).flatMap((i) => [i.at, itEnd(i)])];
  const snap = (t) => {
    let best = t, d = 8 / N.pps;
    for (const p of points) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
    return best;
  };
  let moved = false;
  dragWindow((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 5 && Math.abs(ev.clientY - y0) < 5) return;
    moved = true;
    const dt = (ev.clientX - x0) / N.pps;
    if (mode === 'move') {
      const len = o.out - o.in, at = Math.max(0, o.at + dt);
      const a1 = snap(at), a2 = snap(at + len) - len;
      const d1 = a1 !== at ? Math.abs(a1 - at) : Infinity, d2 = a2 !== at ? Math.abs(a2 - at) : Infinity;
      it.at = Math.max(0, d1 <= d2 && d1 < Infinity ? a1 : d2 < Infinity ? a2 : at);
      const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#sndTimeline .tl-lane');
      if (lane && N.tracks.some((t) => t.id === lane.dataset.track)) it.track = lane.dataset.track;
    } else if (mode === 'l') {
      let d = snap(o.at + dt) - o.at;
      d = Math.max(d, -o.in, -o.at);
      d = Math.min(d, o.out - o.in - MIN_LEN);
      it.at = o.at + d; it.in = o.in + d;
    } else {
      let out = o.in + snap(o.at + (o.out - o.in) + dt) - o.at;
      out = Math.max(o.in + MIN_LEN, it.dur ? Math.min(out, it.dur) : out);
      it.out = out;
    }
    renderTimeline(); syncMedia();
  }, () => { if (moved) changed(); });
}
function wireTimeline() {
  const tl = $('#sndTimeline');
  tl.addEventListener('pointerdown', (e) => {
    const clip = e.target.closest('.tl-clip');
    if (clip) startClipDrag(e, clip);
    else if (e.target.closest('.tl-ruler')) startScrub(e);
  });
  tl.addEventListener('click', (e) => {
    if (!e.target.classList.contains('tl-lane')) return;
    N.sel = null; sndPause(); sndSeek(Math.max(0, timeAt(e))); renderTimeline(); renderPanel();
  });
  tl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTimeline(N.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
  }, { passive: false });
  new ResizeObserver(() => renderTimeline()).observe(tl);
  const cv = $('#sndCanvas');
  cv.addEventListener('pointerdown', (e) => {   // the overview: tap or drag to move the playhead
    const go = (ev) => {
      const r = cv.getBoundingClientRect(), plotW = r.width - 30;
      sndSeek(clamp((ev.clientX - r.left) / plotW, 0, 1) * Math.max(seqEnd(), 1));
    };
    sndPause(); go(e); dragWindow(go);
  });
  new ResizeObserver(() => drawStage()).observe(cv);
}
function zoomTimeline(pps, aroundT = N.t, clientX = null) {
  const tl = $('#sndTimeline');
  const screenX = clientX != null ? clientX - tl.getBoundingClientRect().left : HEAD_W + N.t * N.pps - tl.scrollLeft;
  N.pps = clamp(pps, 2, 600);
  store.set('deck.sound.pps', N.pps); renderTimeline();
  tl.scrollLeft = HEAD_W + aroundT * N.pps - screenX;
}
function fitTimeline() {
  const tl = $('#sndTimeline');
  zoomTimeline((tl.clientWidth - HEAD_W - 30) / Math.max(1, seqEnd()), 0, HEAD_W);
  tl.scrollLeft = 0;
}

// ---- editing ----
function splitAtPlayhead() {
  const t = N.t;
  const under = N.items.filter((it) => t > it.at + 0.02 && t < itEnd(it) - 0.02);
  const targets = under.some((it) => it.id === N.sel) ? under.filter((it) => it.id === N.sel) : under;
  if (!targets.length) return toast('Put the playhead over a clip to split it', true);
  for (const a of targets) {
    const b = { ...a, id: uid(), at: t, fadeIn: 0, in: a.in + (t - a.at) };
    a.out = b.in; a.fadeOut = 0;
    N.items.splice(N.items.indexOf(a) + 1, 0, b);
  }
  changed();
}
function deleteSelected() {
  const it = selItem();
  if (!it) return;
  const before = N.items, tab = tabs?.active?.id;
  N.items = N.items.filter((i) => i !== it);
  N.sel = null;
  changed();
  undoToast('Clip deleted', () => {
    if (tabs?.active?.id !== tab) return toast('Switch back to that tab to undo', true);
    N.items = before; N.sel = it.id; changed();
  });
}
function crossfadePrev(it, d = 0.5) {
  const prev = N.items.filter((i) => i !== it && i.track === it.track && i.at < it.at).sort((a, b) => itEnd(b) - itEnd(a))[0];
  if (!prev) return toast('There is no clip before this one on its track', true);
  d = Math.min(d, itLen(prev) / 2, itLen(it) / 2);
  const shift = it.at - (itEnd(prev) - d);
  for (const i of N.items) if (i.track === it.track && i.at >= it.at) i.at = Math.max(0, i.at - shift);
  changed();
}
function duplicateSel() {
  const it = selItem();
  if (!it) return;
  const b = { ...it, id: uid(), at: itEnd(it) };
  N.items.push(b); N.sel = b.id; changed();
}

// a sound's length (s) from its metadata, so a new clip lands at its real size; 0 if it can't tell in time
function durationOf(url) {
  return new Promise((resolve) => {
    const el = Object.assign(document.createElement('audio'), { preload: 'metadata', src: url });
    const done = (d) => { clearTimeout(timer); el.removeAttribute('src'); resolve(isFinite(d) && d > 0 ? d : 0); };
    const timer = setTimeout(() => done(0), 8000);
    el.addEventListener('loadedmetadata', () => done(el.duration), { once: true });
    el.addEventListener('error', () => done(0), { once: true });
  });
}

// A sound source picked anywhere goes after the last clip on the selected clip's track (or A1), at the playhead when it's past that
async function addSource(src) {
  const s = await soundSource(src);
  if (!s) return toast('That sound is gone', true);
  const sel = selItem(), track = sel?.track || N.tracks[0]?.id || addTrack();
  const it = newItem({ kind: s.kind === 'video' ? 'video' : 'audio', src: src.generation != null ? { generation: src.generation, index: src.index } : { media: src.media },
    url: s.url, label: s.label, dur: await durationOf(s.url) }, track);
  const last = N.items.filter((i) => i.track === track).reduce((m, i) => Math.max(m, itEnd(i)), 0);
  it.at = Math.max(last, sel ? 0 : N.t);
  if (src.trim) { it.in = src.trim.start || 0; if (src.trim.len) it.out = it.in + src.trim.len; }
  N.items.push(it); N.sel = it.id;
  changed();
}
export async function addToSound(src) { await ensureTabs(); return addSource(src); }

// ---- making new sound: templates that save sound (sound effects, music), found by their fields like the VFX tab ----
const MAKERS = [
  { id: 'sfx', label: 'Sound effect', tpl: 'deck-ltx-t2a', len: 8, maxLen: 20,
    placeholder: 'e.g. heavy rain on a tin roof, distant thunder, a dog barks twice',
    help: 'Effects, ambience and foley from a description (LTX-2.5, audio only). Name the sounds, the place and how near they are.' },
  { id: 'music', label: 'Music', tpl: 'deck-ace-music', len: 60, maxLen: 240,
    placeholder: 'Style tags, e.g. lo-fi hip hop, warm piano, vinyl crackle, 80 bpm', lyrics: true,
    help: 'Songs or instrumentals from style tags (ACE-Step 1.5). Add lyrics with [verse] / [chorus] lines, or leave them empty for an instrumental.' },
];
const G = { op: store.get('deck.sound.maker', 'sfx'), prompt: '', lyrics: '', len: null, seed: -1, bpm: 90, key: null };
const ROLE = {
  prompt: (f) => f.kind === 'text' && (/prompt|tags/i.test(f.group) || f.input === 'tags') && !/negative|lyrics/i.test(f.group) && f.input !== 'lyrics',
  lyrics: (f) => f.kind === 'text' && (f.input === 'lyrics' || /lyrics/i.test(f.group)),
  len: (f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(`${f.label} ${f.input}`),
  seed: (f) => f.kind === 'seed',
  bpm: (f) => f.kind === 'int' && f.input === 'bpm',
  key: (f) => f.kind === 'choice' && f.input === 'keyscale',
};
async function makeSound() {
  const mk = MAKERS.find((m) => m.id === G.op) || MAKERS[0];
  const t = S.templates.find((x) => x.id === mk.tpl);
  if (!t) return toast(`Template ${mk.tpl} isn't installed yet`, true);
  if (!G.prompt.trim()) return toast('Describe the sound first', true);
  const values = {};
  for (const f of t.fields.filter(ROLE.len)) values[f.key] = G.len ?? mk.len;   // (music: the encoder's and the latent's length)
  const put = (role, v) => { const f = t.fields.find(ROLE[role]); if (f && v != null) values[f.key] = v; };
  put('prompt', G.prompt);
  if (mk.lyrics) { put('lyrics', G.lyrics); put('bpm', G.bpm); put('key', G.key); }
  put('seed', G.seed);
  try {
    const gens = await api('/api/generate', { method: 'POST', body: { template: t.id, values, batch: 1, project_id: S.project } });
    adoptGenerations(gens);
    N.gens.push(...gens.map((g) => g.id));
    persist(); renderPanel();
    toast(`Queued ${mk.label.toLowerCase()} as #${gens[0].id}`);
  } catch (e) { toast(e.message, true); }
}
function makerSection() {
  const mk = MAKERS.find((m) => m.id === G.op) || MAKERS[0];
  const t = S.templates.find((x) => x.id === mk.tpl);
  const prompt = h('textarea', { rows: 3, value: G.prompt, placeholder: mk.placeholder, oninput: (e) => { G.prompt = e.target.value; } });
  const lyrics = mk.lyrics ? h('textarea', { rows: 5, value: G.lyrics, placeholder: '[verse]\n…\n[chorus]\n…', oninput: (e) => { G.lyrics = e.target.value; } }) : null;
  const len = numSlider({ min: 1, max: mk.maxLen, step: 0.5, value: G.len ?? mk.len, digits: 1, label: 'Length (s)' });
  const keyF = t?.fields.find(ROLE.key);
  const bpm = mk.lyrics ? numSlider({ min: 40, max: 220, step: 1, value: G.bpm, digits: 0, label: 'BPM' }) : null;
  bpm?.addEventListener('change', () => { G.bpm = parseInt(bpm.value, 10); });
  const key = mk.lyrics && keyF ? h('select', {}, keyF.options.map((o) => h('option', { value: o, selected: o === (G.key || keyF.value) }, o))) : null;
  key?.addEventListener('change', () => { G.key = key.value; });
  len.addEventListener('change', () => { G.len = parseFloat(len.value); });
  const results = N.gens.slice(-6).reverse().map((id) => S.history.get(id)).filter(Boolean).map((g) => {
    const i = g.outputs.findIndex((o) => o.kind === 'audio'), o = g.outputs[i];
    return h('div', { class: 'snd-export' },
      h('b', {}, `#${g.id} ${g.status === 'done' ? '' : g.status}`), g.status === 'error' ? note(g.error || 'failed', 'err') : null,
      o ? h('audio', { src: o.url, controls: true, preload: 'none' }) : null,
      o ? h('div', { class: 'row wrap' }, button('Add to the mix', () => addSource({ generation: g.id, index: i }), { cls: 'small primary' })) : null);
  });
  return section('Make a sound', null,
    seg(MAKERS.map((m) => [m.id, m.label]), G.op, (v) => { G.op = v; G.len = null; store.set('deck.sound.maker', v); renderPanel(); }),
    help(mk.help),
    t ? null : note(`Template ${mk.tpl} isn't installed yet${mk.id === 'music' ? ': it needs the ACE-Step 1.5 models (see README, Sound tab)' : ''}.`),
    field(mk.lyrics ? 'Style' : 'Description', prompt), lyrics ? field('Lyrics (optional)', lyrics) : null,
    field('Length (s)', len), bpm ? field('BPM', bpm) : null, key ? field('Key', key) : null,
    h('div', { class: 'row wrap' }, button('✦ Make it', makeSound, { cls: 'primary', disabled: !t })),
    results.length ? h('div', { class: 'snd-exports' }, results) : null);
}

// ---- voice tools (app/voice.py): clean a voice out of a mix, keep voices, speak new lines in them ----
const VX = { status: null, voices: null, clean: { steps: ['vocals', 'dereverb', 'denoise'] }, nv: null, script: '', lang: 'Auto', busy: '' };
const voicesLoad = async () => {
  try { VX.status ||= await api('/api/voice/status'); VX.voices = await api('/api/voice/voices'); } catch (e) { VX.voices = []; toast(e.message, true); }
  renderPanel();
};
const job = async (path, body, label) => {
  VX.busy = label; renderPanel();
  try {
    return await waitJob(await api(path, { method: 'POST', body, busy: false }), (p, l) => {
      const el = $('#vxBusy'); if (el) el.textContent = `${l || label}… ${Math.round((p || 0) * 100)}%`;
    });
  } finally { VX.busy = ''; renderPanel(); }
};
const srcOf = (it) => ({ ...it.src, trim: { start: it.in, len: itLen(it) } });

// the voice alone, placed on the track under the clip it came from, at the same time
async function cleanVoice(it, picked) {
  const src = it ? srcOf(it) : picked;
  if (!src) return toast('Select a clip, or choose a sound', true);
  try {
    const m = await job('/api/voice/isolate', { source: src.generation != null ? { generation: src.generation, index: src.index } : { media: src.media },
      trim: src.trim || null, steps: VX.clean.steps, name: `${it?.label || 'sound'}-voice` }, 'Taking the voice out');
    const s = await soundSource({ media: m.name });
    const ti = it ? N.tracks.indexOf(trackOf(it)) : -1;
    const track = N.tracks[ti + 1] && !N.items.some((x) => x.track === N.tracks[ti + 1].id && x.at < (it ? itEnd(it) : 0) && itEnd(x) > (it ? it.at : 0))
      ? N.tracks[ti + 1].id : (() => { const id = addTrack(); const t = N.tracks.pop(); N.tracks.splice(ti + 1, 0, t); return id; })();
    const v = newItem({ kind: 'audio', src: { media: m.name }, url: s.url, label: `${it?.label || m.label} (voice)`, dur: await durationOf(s.url) }, track);
    v.at = it ? it.at : N.t;
    N.items.push(v); N.sel = v.id;
    toast('The voice is on the track below: mute the original to hear it alone');
    changed();
  } catch (e) { toast(e.message, true); }
}

function voiceSection() {
  if (!VX.status) { voicesLoad(); return section('Voice', null, placeholder('Loading…')); }
  if (!VX.status.installed) {
    return section('Voice', null, note('The AI voice tools aren\'t installed on the server yet. See the README (Sound tab → Voice tools): one setup command, about 8 GB.'));
  }
  const it = selItem();
  const busy = VX.busy ? h('p', { class: 'hint', id: 'vxBusy' }, `${VX.busy}…`) : null;
  // 1. clean up
  const stepBox = (k, label) => {
    const c = h('input', { type: 'checkbox', checked: VX.clean.steps.includes(k) });
    c.addEventListener('change', () => { VX.clean.steps = c.checked ? [...new Set([...VX.clean.steps, k])] : VX.clean.steps.filter((x) => x !== k); });
    return h('label', { class: 'check' }, c, label);
  };
  let picked = null;
  const clean = h('div', { class: 'vx-block' },
    h('b', {}, 'Clean up a voice'),
    hint(it ? `Takes the speech out of “${it.label}” (the part on the timeline) and puts it on the track below.` : 'Select a clip on the timeline, or choose a sound here.'),
    it ? null : soundInput(null, (v) => { picked = v; }, { title: 'A sound with someone speaking' }),
    stepBox('vocals', 'Take out music and effects'), stepBox('dereverb', 'Take out echo'), stepBox('denoise', 'Take out noise'),
    h('div', { class: 'row wrap' }, button('✦ Clean up the voice', () => cleanVoice(it, picked), { cls: 'primary', disabled: !!VX.busy })));

  // 2. voices
  const nv = VX.nv;
  const list = (VX.voices || []).map((v) => h('div', { class: 'vx-voice' },
    h('div', { class: 'vx-voice-top' }, h('b', {}, v.name), h('span', { class: 'hint' }, `${v.seconds}s · ${v.language}${v.ref_text ? '' : ' · no transcript'}`),
      iconBtn('Delete this voice', '✕', async () => {
        if (!confirm(`Delete the voice “${v.name}”? This can't be undone.`)) return;
        try { await api(`/api/voice/voices/${v.id}`, { method: 'DELETE' }); } catch (e) { return toast(e.message, true); }
        voicesLoad();
        toast(`Deleted the voice ${v.name}`);
      })),
    h('audio', { src: v.url, controls: true, preload: 'none' })));
  let form = null;
  if (nv) {
    const name = h('input', { type: 'text', value: nv.name || '', placeholder: 'e.g. Narrator, Anna', 'aria-label': 'Voice name' });
    name.addEventListener('input', () => { nv.name = name.value; });
    const text = h('textarea', { rows: 3, value: nv.ref_text || '', placeholder: 'Exactly what is said in the cut (Listen fills it in)' });
    text.addEventListener('input', () => { nv.ref_text = text.value; });
    const lang = h('select', {}, VX.status.languages.map((l) => h('option', { value: l, selected: l === (nv.language || 'Auto') }, l)));
    lang.addEventListener('change', () => { nv.language = lang.value; });
    const ok = h('input', { type: 'checkbox', checked: !!nv.consent });
    ok.addEventListener('change', () => { nv.consent = ok.checked; });
    form = h('div', { class: 'vx-block' },
      h('b', {}, 'New voice'),
      hint('5 to 15 seconds of one person speaking clearly, nothing else (clean it up first). Set Start and Length to the best part.'),
      soundInput(nv.src, (v) => { nv.src = v; }, { title: 'A clean cut of one person speaking', label: 'Speech' }),
      field('Name', name), field('Language', lang), field('What is said', text),
      h('div', { class: 'row wrap' }, button('👂 Listen', async () => {
        if (!nv.src) return toast('Choose the speech first', true);
        try {
          const r = await job('/api/voice/transcribe', { source: nv.src.generation != null ? { generation: nv.src.generation, index: nv.src.index } : { media: nv.src.media },
            trim: nv.src.trim || null }, 'Listening');
          nv.ref_text = r.text; renderPanel();
        } catch (e) { toast(e.message, true); }
      }, { disabled: !!VX.busy, title: 'Write down what is said, with Whisper' })),
      h('label', { class: 'check' }, ok, 'This is my voice, or the speaker said I may use it. I won\'t use it to pass as them or to mislead.'),
      h('div', { class: 'row wrap' },
        button('Save voice', async () => {
          if (!nv.src) return toast('Choose the speech first', true);
          try {
            await api('/api/voice/voices', { method: 'POST', body: { name: nv.name, ref_text: nv.ref_text, language: nv.language, consent: nv.consent,
              source: nv.src.generation != null ? { generation: nv.src.generation, index: nv.src.index } : { media: nv.src.media }, trim: nv.src.trim || null } });
            VX.nv = null; toast('Voice saved'); voicesLoad();
          } catch (e) { toast(e.message, true); }
        }, { cls: 'primary' }),
        button('Cancel', () => { VX.nv = null; renderPanel(); })));
  }
  const voices = h('div', { class: 'vx-block' }, h('b', {}, 'Voices'),
    list.length ? h('div', { class: 'vx-voices' }, list) : hint('No voices yet.'),
    form || h('div', { class: 'row wrap' }, button('+ New voice', () => {
      VX.nv = { src: it ? srcOf(it) : null, name: '', ref_text: '', language: 'Auto', consent: false }; renderPanel();
    }, { title: it ? 'From the selected clip' : null })));

  // 3. dialogue
  const script = h('textarea', { rows: 6, value: VX.script, placeholder: 'One line each, the voice\'s name first:\nAnna: Did you hear that?\nNarrator: Nobody had, of course.' });
  script.addEventListener('input', () => { VX.script = script.value; });
  const lang = h('select', {}, VX.status.languages.map((l) => h('option', { value: l, selected: l === VX.lang }, l)));
  lang.addEventListener('change', () => { VX.lang = lang.value; });
  const dialogue = h('div', { class: 'vx-block' }, h('b', {}, 'Dialogue'),
    hint('Speaks each line in its voice and lays the lines one after another from the playhead, a track per voice.'),
    field('Script', script), field('Language', lang),
    h('div', { class: 'row wrap' }, button('🗣 Speak the lines', speakScript, { cls: 'primary', disabled: !!VX.busy || !(VX.voices || []).length })));

  return section('Voice', null, help('AI voice tools: pull a voice out of a clip, keep it, and write new lines in it. They use the GPU, so ComfyUI has to be idle.'),
    busy, clean, voices, dialogue);
}

async function speakScript() {
  const byName = new Map((VX.voices || []).map((v) => [v.name.toLowerCase(), v]));
  const lines = [];
  for (const raw of VX.script.split('\n')) {
    const m = raw.match(/^\s*([^:]{1,60}):\s*(.+)$/);
    if (!raw.trim()) continue;
    if (!m) return toast(`Start the line with a voice's name and a colon: “${raw.trim().slice(0, 40)}”`, true);
    const v = byName.get(m[1].trim().toLowerCase());
    if (!v) return toast(`No voice called “${m[1].trim()}”: save one first`, true);
    lines.push({ voice: v.id, text: m[2].trim(), language: VX.lang === 'Auto' ? null : VX.lang, who: v.name });
  }
  if (!lines.length) return toast('Write a line first', true);
  try {
    const r = await job('/api/voice/speak', { lines, name: tabs?.active?.name || 'dialogue' }, 'Speaking');
    let at = N.t;
    const trackFor = (who) => {
      let tr = N.tracks.find((t) => t.name === who);
      if (!tr) { tr = N.tracks.find((t) => !t.name && !N.items.some((i) => i.track === t.id)); if (tr) tr.name = who; }
      if (!tr) { addTrack(); tr = N.tracks[N.tracks.length - 1]; tr.name = who; }
      return tr.id;
    };
    r.lines.forEach((m, i) => {
      const it = newItem({ kind: 'audio', src: { media: m.name }, url: m.url, label: `${lines[i].who}: ${lines[i].text.slice(0, 40)}`, dur: m.seconds }, trackFor(lines[i].who));
      it.at = at; at += m.seconds + 0.3;
      N.items.push(it);
    });
    toast(`${r.lines.length} lines on the timeline`);
    changed();
  } catch (e) { toast(e.message, true); }
}

// ---- the side panel ----
function renderPanel() {
  const body = $('#sndBody');
  if (!body) return;
  const it = selItem(), tr = it && trackOf(it);
  const num = (label, get, set, opts, after = () => {}) => {
    const r = numSlider({ ...opts, value: get(), label });
    const val = h('span', {}, opts.fmt ? opts.fmt(get()) : '');
    const take = () => { set(parseFloat(r.value)); if (opts.fmt) val.textContent = opts.fmt(get()); syncMedia(); drawStage(); };
    r.addEventListener('input', () => { if (r.dataset.scrubbing) take(); });
    r.addEventListener('change', () => { take(); after(); changed(); });
    return field([label, val], r);
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const panFmt = (v) => (Math.abs(v) < 0.01 ? 'centre' : v < 0 ? `${Math.round(-v * 100)}% left` : `${Math.round(v * 100)}% right`);

  const add = section('Add sound', null,
    h('div', { class: 'row wrap' },
      button('+ Sounds and clips', () => openSoundPicker({ title: 'Add to the mix', onPick: addSource }), { cls: 'primary' }),
      fileButton('Upload…', async ([fl]) => {
        try { const m = await uploadMedia(fl); await addSource({ media: m.name }); } catch (e) { toast('Upload failed: ' + e.message, true); }
      }, { accept: 'audio/*,video/*' }),
      button('From a link or big file…', () => import('./clipimport.js').then((m) =>
        m.openClipImport({ title: 'Import a sound', sound: true, onSaved: (e) => addSource({ media: e.name }) })))),
    hint('A clip\'s sound plays straight from the clip. To keep it as a file of its own, select it and Save its sound.'));

  const clip = it ? section(`Clip · ${it.label}`, () => { N.sel = null; renderTimeline(); renderPanel(); },
    num('Level', () => it.volume ?? 1, (v) => { it.volume = v; }, { min: 0, max: 2, step: 0.01, digits: 2, fmt: pct }),
    num('Pan', () => it.pan || 0, (v) => { it.pan = v; }, { min: -1, max: 1, step: 0.05, digits: 2, fmt: panFmt }),
    num('Fade in (s)', () => it.fadeIn || 0, (v) => { it.fadeIn = v; }, { min: 0, max: Math.max(0.1, Math.min(10, itLen(it))), step: 0.05, digits: 2 }),
    num('Fade out (s)', () => it.fadeOut || 0, (v) => { it.fadeOut = v; }, { min: 0, max: Math.max(0.1, Math.min(10, itLen(it))), step: 0.05, digits: 2 }),
    h('p', { class: 'hint' }, `At ${tc(it.at)} · ${itLen(it).toFixed(2)} s, from ${tc(it.in)} of the source`),
    h('div', { class: 'row wrap' },
      button('✂ Split', splitAtPlayhead), button('⧉ Duplicate', duplicateSel),
      button('⤫ Cross-fade', () => crossfadePrev(it), { title: 'Overlap with the clip before it on its track' }),
      button('🗑 Delete', deleteSelected, { cls: 'small danger' })),
    h('div', { class: 'row wrap' },
      button('💾 Save its sound', async () => {
        try {
          const m = await extractSound(it.src, { trim: { start: it.in, len: itLen(it) }, name: `${it.label}-cut` });
          toast(`${m.label}: in the media library, ready as a reference`);
        } catch (e) { toast(e.message, true); }
      }, { title: 'This cut as its own sound file in the media library (to use as a reference in Generate / VFX)' }))) : null;

  const track = tr ? section(`Track · ${trackName(tr)}`, null,
    num('Track level', () => tr.volume ?? 1, (v) => { tr.volume = v; }, { min: 0, max: 2, step: 0.01, digits: 2, fmt: pct }),
    num('Track pan', () => tr.pan || 0, (v) => { tr.pan = v; }, { min: -1, max: 1, step: 0.05, digits: 2, fmt: panFmt })) : null;

  const nameIn = h('input', { type: 'text', value: N.out.name || tabs?.active?.name || '', placeholder: tabs?.active?.name || 'Mix', 'aria-label': 'File name' });
  nameIn.addEventListener('change', () => { N.out.name = nameIn.value.trim(); persist(); });
  const norm = h('input', { type: 'checkbox', checked: !!N.out.normalize });
  norm.addEventListener('change', () => { N.out.normalize = norm.checked; persist(); });
  const out = section('Export', null,
    help('Mixes every track into one sound file in the media library: play it, edit it again, put it on a clip (Board → ♪ Sound), or use it as a Sound / Voice reference in Generate and VFX.'),
    field('Name', nameIn),
    field('Format', seg([['m4a', 'M4A'], ['wav', 'WAV'], ['mp3', 'MP3'], ['flac', 'FLAC']], N.out.format,
      (v) => { N.out.format = v; store.set('deck.sound.format', v); persist(); })),
    num('Master level', () => N.out.gain, (v) => { N.out.gain = v; }, { min: 0, max: 2, step: 0.01, digits: 2, fmt: pct }),
    h('label', { class: 'check' }, norm, 'Even out the loudness (−16 LUFS, for speech and streaming)'),
    h('div', { class: 'row wrap' }, button('⤓ Export sound', exportSound, { cls: 'primary' })),
    N.exports.length ? h('div', { class: 'snd-exports' }, N.exports.slice(-3).reverse().map((m) =>
      h('div', { class: 'snd-export' }, h('b', {}, m.label), h('audio', { src: m.url, controls: true, preload: 'none' }),
        h('div', { class: 'row wrap' }, linkBtn('Download', m.url, { download: m.name }),
          button('Add to the mix', () => addSource({ media: m.name })))))) : null);

  body.replaceChildren(...[add, clip, track, voiceSection(), makerSection(), out].filter(Boolean));
}

async function exportSound() {
  if (!N.items.length) return toast('Add some sound first', true);
  await tabs?.flush();
  try {
    const m = await api('/api/sound/render', { method: 'POST', timeout: 900000, busy: 'Mixing the sound…', body: {
      tracks: N.tracks, name: N.out.name || tabs?.active?.name || 'mix', format: N.out.format, gain: N.out.gain, normalize: N.out.normalize,
      items: N.items.map((it) => ({ track: it.track, src: it.src, at: it.at, in: it.in, out: it.out ?? it.dur ?? null,
        volume: it.volume ?? 1, pan: it.pan || 0, fade_in: it.fadeIn || 0, fade_out: it.fadeOut || 0 })) } });
    N.exports.push(m);
    toast(`Saved ${m.label} (${m.duration} s) to the media library`);
    renderPanel();
  } catch (e) { toast(e.message, true); }
}

// ---- tabs: each mix is a document in the project folder ----
const migrate = (p) => ({ tracks: p.tracks?.length ? p.tracks : defaultTracks(), items: p.items || [], out: { ...N.out, ...(p.out || {}) }, gens: p.gens || [] });
const adapter = {
  empty: () => ({ tracks: defaultTracks(), items: [], out: { name: '', format: N.out.format, gain: 1, normalize: false }, gens: [] }),
  migrate,
  dump: () => ({ tracks: N.tracks, items: N.items, out: N.out, gens: N.gens.slice(-30) }),
  load(p) {
    sndPause();
    p = migrate(p);
    Object.assign(N, { tracks: p.tracks, items: p.items, out: p.out, gens: p.gens, sel: null, t: 0, exports: [] });
    renderTimeline(); renderPanel(); syncMedia();
  },
};

export function wireSound() {
  const mount = h('div', { class: 'vid-tabs' });
  $('#soundPanel').replaceChildren(mount, h('div', { id: 'sndBody' }));
  tabs = new TabSet({ kind: 'sound-tabs', mount, scope: 'project', newName: (n) => `Mix ${n}`, adapter });
  $('#sndStart').addEventListener('click', () => { sndPause(); sndSeek(0); });
  $('#sndBack').addEventListener('click', () => sndSeek(N.t - 5));
  $('#sndFwd').addEventListener('click', () => sndSeek(N.t + 5));
  $('#sndPlay').addEventListener('click', () => (N.playing ? sndPause() : sndPlay()));
  const loopBtn = $('#sndLoop');
  const showLoop = () => { loopBtn.classList.toggle('on', N.loop); loopBtn.setAttribute('aria-pressed', String(N.loop)); };
  loopBtn.addEventListener('click', () => { N.loop = !N.loop; store.set('deck.sound.loop', N.loop); showLoop(); });
  showLoop();
  $('#sndTools').replaceChildren(
    button('✂ Split', splitAtPlayhead, { title: 'Split at playhead (S)' }),
    button('🗑 Delete', deleteSelected, { title: 'Delete selected clip (Del)' }),
    h('span', { class: 'tl-tip' }, info('Drag clips to move · drag ends to trim · overlap to cross-fade · S solos a track')),
    iconBtn('Zoom out', '−', () => zoomTimeline(N.pps / 1.5)),
    button('Fit', fitTimeline),
    iconBtn('Zoom in', '+', () => zoomTimeline(N.pps * 1.5)));
  wireTimeline();
  showPlayState();
  onServer('deck_generation', ({ data }) => { if (N.gens.includes(data?.id) && $('#tab-sound').classList.contains('active')) setTimeout(renderPanel, 0); });
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-sound').classList.contains('active') || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const keys = {
      ' ': () => (N.playing ? sndPause() : sndPlay()),
      ArrowLeft: () => sndSeek(N.t - (e.shiftKey ? 1 : 0.1)),
      ArrowRight: () => sndSeek(N.t + (e.shiftKey ? 1 : 0.1)),
      Home: () => { sndPause(); sndSeek(0); },
      End: () => { sndPause(); sndSeek(seqEnd()); },
      s: splitAtPlayhead, c: splitAtPlayhead, d: duplicateSel,
      Delete: deleteSelected, Backspace: deleteSelected,
      '=': () => zoomTimeline(N.pps * 1.5), '+': () => zoomTimeline(N.pps * 1.5), '-': () => zoomTimeline(N.pps / 1.5),
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });
}

// for the headless UI checks (dev/): the live state
export const soundDebug = () => ({ N, A, tabs });
