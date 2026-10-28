import {
  $, h, store, uid, api, toast, undoToast, clamp, button, iconBtn, linkBtn, seg, field, section, hint, help, info, note,
  placeholder, fileButton, rangeField, insertAtCursor, panFmt, pctFmt, toggle, textArea, chip,
} from './ui.js';
import { DELIVERY, INLINE_TAGS, parseScript, withDelivery, withName } from './dialogue.js';
import { S, onServer } from './core.js';
import { ROLES, queueRun, template, valuesByRole } from './make.js';
import { bareSource, clipLabel, extractSound, openSoundPicker, openVideoPicker, outputCard, soundInput, soundSource, uploadMedia } from './media.js';
import { waitJob } from './clipimport.js';
import { TabSet } from './tabs.js';
import { clipKeys, clipSoundFields, dragWindow, durationOf, timeline, wavePeaks } from './timeline.js';
import { refreshKeyed } from './keyed.js';
import { fmtTime, playKeys, transport } from './playback.js';
import { resultActions } from './useas.js';
import { fullScreen } from './layout.js';

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
let stp = null;   // the transport bar (playback.js)
const ensureTabs = () => tabsReady || (tabsReady = tabs ? tabs.start() : Promise.resolve());
const persist = () => tabs?.changed();

const TL = timeline(N, { el: '#sndTimeline', headW: HEAD_W, minLen: MIN_LEN, zoom: [2, 600], ppsKey: 'deck.sound.pps',
  pause: () => sndPause(), seek: (t) => sndSeek(t), showTime: () => { stp?.update(); refreshKeyed($('#soundPanel')); },
  changed: () => changed(), dragged: () => { renderTimeline(); syncMedia(); }, rendered: () => renderTimeline(),
  selected: () => { renderPanel(); drawStage(); }, deselected: () => { renderTimeline(); renderPanel(); }, tabs: () => tabs });
const { len: itLen, end: itEnd, seqEnd, selItem, xfades, fadeGain, updatePlayhead } = TL;
// a clip's level and pan can be keyed (timeline.js clipKeys, as in the Video tab), on 1/100 s steps
const K = clipKeys(TL, N, { fps: () => 100, base: { volume: 1, pan: 0 }, pause: () => sndPause(), seek: (t) => sndSeek(t),
  onKeys: () => changed(), live: { onInput: () => { syncMedia(); drawStage(); }, onChange: () => changed() } });
const trackOf = (it) => N.tracks.find((t) => t.id === it.track);
const trackName = (t) => t.name || `A${N.tracks.indexOf(t) + 1}`;
const soloed = () => N.tracks.some((t) => t.solo);
const audible = (tr) => tr && !tr.muted && (!soloed() || tr.solo);
const tc = (t) => fmtTime(t);   // m:ss.ss

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
    const level = audible(tr) ? K.prop(it, 'volume') * (tr.volume ?? 1) * fadeGain(it, N.t) : 0;
    if (e.gain) { e.gain.gain.value = level; el.volume = 1; } else el.volume = clamp(level, 0, 1);
    if (e.pan) e.pan.pan.value = clamp(K.prop(it, 'pan') + (tr?.pan || 0), -1, 1);
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
function showPlayState() { stp?.update(); }

// ---- waveforms: loudness peaks, 100 per second ----
async function loadWave(url) {
  N.waves.set(url, 'loading');
  try { N.waves.set(url, await wavePeaks(url, 100)); } catch { N.waves.set(url, 'none'); }
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
// Its scale holds still while a clip is dragged on it (N.stageHold), so the clip doesn't run from the finger.
const stageSpan = () => Math.max(seqEnd(), 1, N.stageHold || 0);
function drawStage() {
  const cv = $('#sndCanvas');
  if (!cv || !$('#tab-sound').classList.contains('active')) return;
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const meterW = Math.round(22 * dpr), plotW = W - meterW - 8 * dpr;
  const end = stageSpan(), pps = plotW / end;
  const rows = N.tracks.length || 1, rowH = H / rows;
  N.tracks.forEach((tr, ri) => {
    ctx.save(); ctx.translate(0, ri * rowH);
    ctx.fillStyle = ri % 2 ? '#14161c' : '#171a21'; ctx.fillRect(0, 0, plotW, rowH);
    for (const it of N.items.filter((i) => i.track === tr.id)) {
      const w = waveOf(it), x0 = Math.round(it.at * pps), ww = Math.max(1, Math.round(itLen(it) * pps));
      ctx.fillStyle = it.id === N.sel ? '#3b6b4f' : '#24533a'; ctx.fillRect(x0, 2, ww, rowH - 4);
      if (w) { ctx.save(); ctx.translate(0, 4); paintWave(ctx, it, w, x0, ww, rowH - 8, pps, audible(tr) ? '#a7e8bd' : '#55705f'); ctx.restore(); }
      if (it.id === N.sel) {   // the selected clip: an outline and its two trim ends
        const lw = 2 * dpr, hw = Math.min(6 * dpr, ww / 3);
        ctx.strokeStyle = '#e9b44c'; ctx.lineWidth = lw; ctx.strokeRect(x0 + lw / 2, 2 + lw / 2, ww - lw, rowH - 4 - lw);
        ctx.fillStyle = '#e9b44c'; ctx.fillRect(x0, 2, hw, rowH - 4); ctx.fillRect(x0 + ww - hw, 2, hw, rowH - 4);
      }
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
    K.diamonds(it, N.pps, tc),
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
  TL.render({
    corner: [h('button', { type: 'button', class: 'tl-tog', title: 'Add a track', onclick: () => { addTrack(); changed(); } }, '+ Track')],
    rows: N.tracks.map((tr) => ({ track: tr, cls: 'audio snd-row' + (audible(tr) ? '' : ' off'), head: trackHead(tr) })),
    clipEl });
  drawWaves(); pruneEls(); updatePlayhead(); drawStage();
  $('#sndEmpty').classList.toggle('hidden', N.items.length > 0);
}

function addTrack() { const id = `a${uid()}`; N.tracks.push({ id }); return id; }
function changed() { persist(); renderTimeline(); renderPanel(); syncMedia(); }

export function renderSound() { renderTimeline(); renderPanel(); syncMedia(); ensureTabs(); }

// ---- gestures ----
// The stage, as the timeline: a clip under the pointer and what a drag there does (null: empty space).
// Near a clip's ends trims it; touch gets wider ends than a pen or mouse.
function stageGeom() {
  const r = $('#sndCanvas').getBoundingClientRect(), plotW = r.width - 30;
  return { r, plotW, pps: plotW / stageSpan(), rowH: r.height / (N.tracks.length || 1) };
}
function stageHit(e) {
  const g = stageGeom(), x = e.clientX - g.r.left, y = e.clientY - g.r.top;
  const tr = N.tracks[clamp(Math.floor(y / g.rowH), 0, N.tracks.length - 1)];
  if (!tr || x > g.plotW + 4) return null;
  const pad = 6, edge0 = e.pointerType === 'touch' ? 18 : 10;
  const hits = N.items.filter((i) => i.track === tr.id && x >= i.at * g.pps - pad && x <= itEnd(i) * g.pps + pad);
  const it = hits.find((i) => i.id === N.sel) || hits[hits.length - 1];
  if (!it) return null;
  const x1 = it.at * g.pps, x2 = itEnd(it) * g.pps, edge = Math.min(edge0, (x2 - x1) / 3);
  return { it, mode: x < x1 + edge ? 'l' : x > x2 - edge ? 'r' : 'move', g };
}

function wireTimeline() {
  TL.wire();
  const cv = $('#sndCanvas');
  const seekAt = (ev) => { const g = stageGeom(); sndSeek(clamp((ev.clientX - g.r.left) / g.plotW, 0, 1) * stageSpan()); };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const hit = stageHit(e);
    if (!hit) { sndPause(); seekAt(e); dragWindow(seekAt); return; }   // empty space: tap or drag to move the playhead
    // a clip: select it, then drag it in time and to another track row, or drag its ends to trim; a tap also puts the playhead there
    TL.select(hit.it);
    N.stageHold = stageSpan();
    TL.dragClip(e, hit.it, hit.mode, { pps: hit.g.pps,
      trackAt: (ev) => { const g = stageGeom(), row = Math.floor((ev.clientY - g.r.top) / g.rowH); return N.tracks[clamp(row, 0, N.tracks.length - 1)]?.id; },
      onTap: (ev) => { sndPause(); seekAt(ev); } });
    const release = () => { removeEventListener('pointerup', release); removeEventListener('pointercancel', release); N.stageHold = 0; drawStage(); };
    addEventListener('pointerup', release); addEventListener('pointercancel', release);
  });
  cv.addEventListener('pointermove', (e) => {   // a pen or mouse hovering: show what a press would do
    if (e.buttons) return;
    const hit = stageHit(e);
    cv.style.cursor = !hit ? 'pointer' : hit.mode === 'move' ? 'grab' : 'ew-resize';
  });
  new ResizeObserver(() => drawStage()).observe(cv);
}
// ---- adding ----
// A sound source picked anywhere goes after the last clip on the selected clip's track (or A1), at the playhead when it's past that
// at: a time to put it at instead (on the first track with room there, or a new one)
async function addSource(src, at = null) {
  const s = await soundSource(src);
  if (!s) return toast('That sound is gone', true);
  const dur = await durationOf(s.url), sel = selItem();
  const free = at != null && N.tracks.find((t) => !N.items.some((x) => x.track === t.id && x.at < at + dur && itEnd(x) > at));
  const track = at != null ? free?.id || addTrack() : sel?.track || N.tracks[0]?.id || addTrack();
  const it = newItem({ kind: s.kind === 'video' ? 'video' : 'audio', src: bareSource(src), url: s.url, label: s.label, dur }, track);
  it.at = at != null ? at : Math.max(TL.trackEnd(track), sel ? 0 : N.t);
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
  { id: 'foley', label: 'Sound from clip', tpl: 'deck-mmaudio-foley', len: 8, maxLen: 30, clip: true,
    placeholder: 'Optional: what to hear, e.g. footsteps on wet gravel, wind',
    help: 'Sound for a clip, made from its picture (MMAudio): footsteps, impacts, ambience, timed to what happens. Use the selected clip or pick one; the prompt steers it and the negative prompt keeps things out (music and speech by default). Best up to 8 s; longer clips work but drift. Add to the mix puts it under the clip.' },
  { id: 'music', label: 'Music', tpl: 'deck-ace-music', len: 60, maxLen: 240,
    placeholder: 'Style tags, e.g. lo-fi hip hop, warm piano, vinyl crackle, 80 bpm', lyrics: true,
    help: 'Songs or instrumentals from style tags (ACE-Step 1.5). Add lyrics with [verse] / [chorus] lines, or leave them empty for an instrumental.' },
];
const G = { op: store.get('deck.sound.maker', 'sfx'), prompt: '', lyrics: '', len: null, seed: -1, bpm: 90, key: null, showing: null,
  clip: null, clipAt: {} };   // clip: Sound from clip's source {src, at?}; clipAt: generation id -> where its clip sits   // showing: the take picked
// the makers' fields by role: make.js ROLES, with a music template's tags, lyrics, BPM and key
const ROLE = {
  prompt: (f) => f.kind === 'text' && (/prompt|tags/i.test(f.group) || f.input === 'tags') && !/negative|lyrics/i.test(f.group) && f.input !== 'lyrics',
  lyrics: (f) => f.kind === 'text' && (f.input === 'lyrics' || /lyrics/i.test(f.group)),
  len: (f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(`${f.label} ${f.input}`),
  bpm: (f) => f.kind === 'int' && f.input === 'bpm',
  key: (f) => f.kind === 'choice' && f.input === 'keyscale',
};
async function makeSound() {
  const mk = MAKERS.find((m) => m.id === G.op) || MAKERS[0];
  const t = template(mk.tpl);
  if (!t) return toast(`Template ${mk.tpl} isn't installed yet`, true);
  if (mk.clip && !G.clip) return toast('Choose the clip first', true);
  if (!mk.clip && !G.prompt.trim()) return toast('Describe the sound first', true);
  const values = valuesByRole(t, { prompt: G.prompt, seed: G.seed, ...(mk.lyrics && { lyrics: G.lyrics, bpm: G.bpm, key: G.key }),
    ...(mk.clip && { source: G.clip.src }) }, { ...ROLES, ...ROLE });
  for (const f of t.fields.filter(ROLE.len)) values[f.key] = G.len ?? mk.len;   // (music: the encoder's and the latent's length)
  try {
    const gens = await queueRun({ template: t.id, values });
    if (mk.clip && G.clip.at != null) for (const g of gens) G.clipAt[g.id] = G.clip.at;
    N.gens.push(...gens.map((g) => g.id));
    persist(); renderPanel();
    toast(`Queued ${mk.label.toLowerCase()} as #${gens[0].id}`);
  } catch (e) { toast(e.message, true); }
}
function makerSection() {
  const mk = MAKERS.find((m) => m.id === G.op) || MAKERS[0];
  const t = S.templates.find((x) => x.id === mk.tpl);
  const prompt = textArea(() => G.prompt, (v) => { G.prompt = v; }, { rows: 3, placeholder: mk.placeholder, label: mk.label });
  const lyrics = mk.lyrics ? textArea(() => G.lyrics, (v) => { G.lyrics = v; }, { rows: 5, placeholder: '[verse]\n…\n[chorus]\n…', label: 'Lyrics' }) : null;
  const keyF = t?.fields.find(ROLE.key);
  const key = mk.lyrics && keyF ? h('select', {}, keyF.options.map((o) => h('option', { value: o, selected: o === (G.key || keyF.value) }, o))) : null;
  key?.addEventListener('change', () => { G.key = key.value; });
  // its takes, as the VFX tab shows them: tap one to hear it and act on it
  const gens = N.gens.slice(-6).reverse().map((id) => S.history.get(id)).filter(Boolean);
  const picked = gens.find((g) => g.id === G.showing && g.status === 'done');
  const pi = picked ? Math.max(0, picked.outputs.findIndex((o) => o.kind === 'audio')) : 0;
  const results = gens.length ? [h('div', { class: 'grid gallery' }, gens.map((g) =>
    outputCard(g, { kind: 'audio', picked: g.id === G.showing, onPick: () => { G.showing = G.showing === g.id ? null : g.id; renderPanel(); } }))),
  picked ? h('audio', { src: picked.outputs[pi].url, controls: true, autoplay: true, class: 'take-player' }) : null,
  picked ? resultActions(picked, { kind: 'audio', first: [button('Add to the mix', () => addSource({ generation: picked.id, index: pi }, G.clipAt[picked.id] ?? null), { cls: 'small primary' })] }) : null] : [];
  // Sound from clip: the selected clip on the timeline (its trim and place), or one picked
  const sel = selItem();
  const clipRow = mk.clip ? field('Clip', h('div', { class: 'row wrap' },
    h('span', { class: 'grow' }, G.clip ? clipLabel(G.clip.src) : 'None yet'),
    sel?.kind === 'video' ? button('Use the selected clip', () => { G.clip = { src: srcOf(sel), at: sel.at }; renderPanel(); }) : null,
    button('Pick…', () => openVideoPicker({ title: 'The clip to make sound for', onPick: (v) => { G.clip = { src: v }; renderPanel(); } })))) : null;
  return section('Make a sound', null,
    seg(MAKERS.map((m) => [m.id, m.label]), G.op, (v) => { G.op = v; G.len = null; store.set('deck.sound.maker', v); renderPanel(); }),
    help(mk.help),
    t ? null : note(`Template ${mk.tpl} isn't installed yet${mk.id === 'music' ? ': it needs the ACE-Step 1.5 models (see README, Sound tab)' : ''}.`),
    clipRow, field(mk.lyrics ? 'Style' : mk.clip ? 'Prompt (optional)' : 'Description', prompt), lyrics ? field('Lyrics (optional)', lyrics) : null,
    rangeField('Length', () => G.len ?? mk.len, (v) => { G.len = v; }, { min: 1, max: mk.maxLen, step: 0.5, digits: 1, fmt: (v) => `${v} s` }),
    mk.lyrics ? rangeField('BPM', () => G.bpm, (v) => { G.bpm = Math.round(v); }, { min: 40, max: 220, step: 1, digits: 0, fmt: (v) => `${Math.round(v)}` }) : null,
    key ? field('Key', key) : null,
    h('div', { class: 'row wrap' }, button('✦ Make it', makeSound, { cls: 'primary', disabled: !t })),
    results);
}

// ---- voice tools (app/voice.py): clean a voice out of a mix, keep voices, speak new lines in them ----
const VX = { status: null, voices: null, clean: { steps: ['vocals', 'dereverb', 'denoise'] }, nv: null, script: '', lang: 'Auto', busy: '',
  engine: store.get('deck.sound.engine', 'index'), intensity: store.get('deck.sound.intensity', 0.7) };
const ENGINES = [
  ['qwen', 'Qwen (plain)', 'Qwen3-TTS: plain speech. It ignores delivery words and [tags].'],
  ['index', 'IndexTTS-2 (delivery)', 'IndexTTS-2: speaks each line the way its (delivery words) say. Inline [tags] are dropped.'],
  ['fish', 'Fish S2 (tags)', 'Fish S2: understands (delivery words), as a leading [tag], and inline [tags]. Slower.'],
];
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
    const m = await job('/api/voice/isolate', { source: bareSource(src),
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
    return toggle(label, VX.clean.steps.includes(k), (on) => { VX.clean.steps = on ? [...new Set([...VX.clean.steps, k])] : VX.clean.steps.filter((x) => x !== k); });
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
    const text = textArea(() => nv.ref_text, (v) => { nv.ref_text = v; }, { rows: 3, label: 'What is said', placeholder: 'Exactly what is said in the cut (Listen fills it in)' });
    const lang = h('select', {}, VX.status.languages.map((l) => h('option', { value: l, selected: l === (nv.language || 'Auto') }, l)));
    lang.addEventListener('change', () => { nv.language = lang.value; });
    const len = nv.src?.trim?.len;
    form = h('div', { class: 'vx-block', id: 'vxNewVoice' },
      h('b', {}, 'New voice'),
      hint('5 to 15 seconds of one person speaking clearly, nothing else (clean it up first). Set Start and Length to the best part.'),
      nv.fromClip ? note(`From “${nv.fromClip}”. Music or noise in it? Try “Clean up a voice” above first, then make the voice from the clean clip.`, 'tip') : null,
      len > 15 ? note(`This cut is ${len.toFixed(1)} s: the model wants 5 to 15 s. Split the clip (✂) and use the best part, or shorten Length.`) : null,
      len != null && len < 5 ? note(`This cut is only ${len.toFixed(1)} s: 5 to 15 s of speech clones better.`) : null,
      soundInput(nv.src, (v) => { nv.src = v; }, { title: 'A clean cut of one person speaking', label: 'Speech' }),
      field('Name', name), field('Language', lang), field('What is said', text),
      h('div', { class: 'row wrap' }, button('👂 Listen', async () => {
        if (!nv.src) return toast('Choose the speech first', true);
        try {
          const r = await job('/api/voice/transcribe', { source: bareSource(nv.src),
            trim: nv.src.trim || null }, 'Listening');
          nv.ref_text = r.text; renderPanel();
        } catch (e) { toast(e.message, true); }
      }, { disabled: !!VX.busy, title: 'Write down what is said, with Whisper' })),
      toggle('This is my voice, or the speaker said I may use it. I won\'t use it to pass as them or to mislead.', nv.consent, (on) => { nv.consent = on; }),
      h('div', { class: 'row wrap' },
        button('Save voice', async () => {
          if (!nv.src) return toast('Choose the speech first', true);
          try {
            await api('/api/voice/voices', { method: 'POST', body: { name: nv.name, ref_text: nv.ref_text, language: nv.language, consent: nv.consent,
              source: bareSource(nv.src), trim: nv.src.trim || null } });
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
  const script = textArea(() => VX.script, (v) => { VX.script = v; }, { rows: 6, label: 'Script',
    placeholder: 'One line each, the voice\'s name first:\nAnna (whispering): Did you hear that?\nNarrator: Nobody had, of course. [sigh]' });
  const chips = scriptChips(script);
  script.addEventListener('focus', () => chips.classList.remove('hidden'));
  script.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== script) chips.classList.add('hidden'); }, 150));
  const lang = h('select', {}, VX.status.languages.map((l) => h('option', { value: l, selected: l === VX.lang }, l)));
  lang.addEventListener('change', () => { VX.lang = lang.value; });
  const eng = ENGINES.find((e) => e[0] === VX.engine) || ENGINES[1];
  const dialogue = h('div', { class: 'vx-block' }, h('b', {}, 'Dialogue'),
    hint('Speaks each line in its voice and lays the lines one after another from the playhead, a track per voice.'),
    h('div', { class: 'field vx-script' }, h('div', { class: 'lbl' }, h('span', {}, 'Script'),
      info('One line each: Name (delivery words): what they say, with [tags] anywhere in it. The (delivery) part is optional. Tap into the box for chips.')),
    chips, script),
    field('Engine', seg(ENGINES, eng[0], (v) => { VX.engine = v; store.set('deck.sound.engine', v); renderPanel(); }, { wrap: true }), help(eng[2])),
    VX.status.engines && VX.status.engines[eng[0]] === false ? note(`${eng[1].replace(/ \(.*/, '')} isn't installed on the server yet: see the README (Sound tab, Voice tools).`) : null,
    eng[0] === 'index' ? rangeField('Delivery strength', () => VX.intensity, (v) => { VX.intensity = v; store.set('deck.sound.intensity', v); },
      { min: 0.2, max: 1, step: 0.05, help: 'How strongly the delivery words colour the line: low is a hint, 1 is all the way.' }) : null,
    field('Language', lang),
    h('div', { class: 'row wrap' }, button('🗣 Speak the lines', speakScript, { cls: 'primary', disabled: !!VX.busy || !(VX.voices || []).length })));

  return section('Voice', null, help('AI voice tools: pull a voice out of a clip, keep it, and write new lines in it. They use the GPU, so ComfyUI has to be idle.'),
    busy, clean, voices, dialogue);
}

// The script box's chips: voice names start the line, delivery words go in its "(…)", tags at the cursor.
// They float above the box while it has the cursor; on touch screens the text popup shows them (_chipGroups).
function scriptChips(ta) {
  const edit = (fn) => (t) => {
    const r = fn(t.value, t.selectionStart ?? t.value.length);
    if (!r) return toast('Start the line with a voice\'s name first (tap one)', true);
    t.value = r.value; t.focus(); t.setSelectionRange(r.pos, r.pos);
    t.dispatchEvent(new Event('input'));
  };
  const groups = () => [
    ['Voices', (VX.voices || []).map((v) => [v.name, { run: edit((val, pos) => withName(val, pos, v.name)) }]), true],
    ['Delivery', DELIVERY.map((w) => [`(${w})`, { run: edit((val, pos) => withDelivery(val, pos, w)) }]), true],
    ['Tags', INLINE_TAGS.map((t) => [`[${t}]`, { run: (x) => insertAtCursor(x, `[${t}]`) }]), true],
  ];
  ta._chipGroups = groups;
  return h('div', { class: 'vx-chips hidden' }, groups().filter(([, items]) => items.length).map(([name, items]) =>
    h('div', { class: 'chips tag-chips vx-chip-row', 'aria-label': name }, h('span', { class: 'vx-chip-lbl' }, name),
      items.map(([label, { run }]) => chip(label, () => run(ta), { keepFocus: true })))));
}

// the selected clip's part on the timeline as the source of a new voice, in the Voice section's form
function voiceFromClip(it) {
  if (VX.status && !VX.status.installed) return toast('The AI voice tools aren\'t installed on the server yet (see README, Sound tab)', true);
  VX.nv = { src: srcOf(it), name: '', ref_text: '', language: 'Auto', consent: false, fromClip: it.label };
  renderPanel();
  requestAnimationFrame(() => $('#vxNewVoice')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function speakScript() {
  const { lines, error } = parseScript(VX.script, VX.voices, { language: VX.lang === 'Auto' ? null : VX.lang, intensity: VX.intensity });
  if (error) return toast(error, true);
  try {
    const r = await job('/api/voice/speak', { lines, engine: VX.engine, name: tabs?.active?.name || 'dialogue' }, 'Speaking');
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
  $('#sndDel').disabled = !it;
  const live = { onInput: () => { syncMedia(); drawStage(); }, onChange: () => changed() };
  const num = (label, get, set, opts) => rangeField(label, get, set, { digits: 2, ...opts, ...live });

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
    clipSoundFields(it, itLen(it), { pan: true, ...live, keyed: (label, ch, o) => K.field(it, label, ch, o) }),
    h('p', { class: 'hint' }, `At ${tc(it.at)} · ${itLen(it).toFixed(2)} s, from ${tc(it.in)} of the source`),
    h('div', { class: 'row wrap' },
      button('✂ Split', TL.split), button('⧉ Duplicate', TL.duplicate),
      button('⤫ Cross-fade', () => TL.crossfadePrev(it), { title: 'Overlap with the clip before it on its track' }),
      button('🗑 Delete', TL.deleteSelected, { cls: 'small danger' })),
    h('div', { class: 'row wrap' },
      button('💾 Save its sound', async () => {
        try {
          const m = await extractSound(it.src, { trim: { start: it.in, len: itLen(it) }, name: `${it.label}-cut` });
          toast(`${m.label}: in the media library, ready as a reference`);
        } catch (e) { toast(e.message, true); }
      }, { title: 'This cut as its own sound file in the media library (to use as a reference in Generate / VFX)' })),
    h('div', { class: 'row wrap' }, button('🎙 Make a voice from this clip', () => voiceFromClip(it), { cls: 'primary' }))) : null;

  const track = tr ? section(`Track · ${trackName(tr)}`, null,
    num('Track level', () => tr.volume ?? 1, (v) => { tr.volume = v; }, { min: 0, max: 2, step: 0.01, fmt: pctFmt }),
    num('Track pan', () => tr.pan || 0, (v) => { tr.pan = v; }, { min: -1, max: 1, step: 0.05, fmt: panFmt })) : null;

  const nameIn = h('input', { type: 'text', value: N.out.name || tabs?.active?.name || '', placeholder: tabs?.active?.name || 'Mix', 'aria-label': 'File name' });
  nameIn.addEventListener('change', () => { N.out.name = nameIn.value.trim(); persist(); });
  const out = section('Export', null,
    help('Mixes every track into one sound file in the media library: play it, edit it again, put it on a clip (Board → ♪ Sound), or use it as a Sound / Voice reference in Generate and VFX.'),
    field('Name', nameIn),
    field('Format', seg([['m4a', 'M4A'], ['wav', 'WAV'], ['mp3', 'MP3'], ['flac', 'FLAC']], N.out.format,
      (v) => { N.out.format = v; store.set('deck.sound.format', v); persist(); })),
    num('Master level', () => N.out.gain, (v) => { N.out.gain = v; }, { min: 0, max: 2, step: 0.01, fmt: pctFmt }),
    toggle('Even out the loudness (−16 LUFS, for speech and streaming)', N.out.normalize, (on) => { N.out.normalize = on; persist(); }),
    h('div', { class: 'row wrap' }, button('⤓ Export sound', exportSound, { cls: 'primary' })),
    N.exports.length ? h('div', { class: 'snd-exports' }, N.exports.slice(-3).reverse().map((m) =>
      h('div', { class: 'snd-export' }, h('b', {}, m.label), h('audio', { src: m.url, controls: true, preload: 'none' }),
        h('div', { class: 'row wrap' }, linkBtn('Download', m.url, { download: m.name }),
          button('Add to the mix', () => addSource({ media: m.name })))))) : null);

  body.replaceChildren(...[add, clip, track, makerSection(), voiceSection(), out].filter(Boolean));   // (add, the selected thing, making, then the export)
}

async function exportSound() {
  if (!N.items.length) return toast('Add some sound first', true);
  await tabs?.flush();
  try {
    const m = await api('/api/sound/render', { method: 'POST', timeout: 900000, busy: 'Mixing the sound…', body: {
      tracks: N.tracks, name: N.out.name || tabs?.active?.name || 'mix', format: N.out.format, gain: N.out.gain, normalize: N.out.normalize,
      items: N.items.map((it) => ({ track: it.track, src: it.src, at: it.at, in: it.in, out: it.out ?? it.dur ?? null,
        volume: it.volume ?? 1, pan: it.pan || 0, chans: it.chans || null, fade_in: it.fadeIn || 0, fade_out: it.fadeOut || 0 })) } });
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
  stp = transport({ playing: () => N.playing, play: sndPlay, pause: sndPause, seek: sndSeek, t: () => N.t, len: seqEnd },
    { step: { by: 5, key: 0.1, back: '⏪', fwd: '⏩', label: '5 s', pause: false },
      loop: { get: () => N.loop, set: (on) => { N.loop = on; store.set('deck.sound.loop', on); } },
      extra: [h('button', { type: 'button', id: 'sndSplit', class: 'icon-btn', 'aria-label': 'Split at the playhead', title: 'Split at the playhead (S)', onclick: TL.split }, '✂'),
        h('button', { type: 'button', id: 'sndDel', class: 'icon-btn', 'aria-label': 'Delete the selected clip', title: 'Delete the selected clip (Del)', onclick: TL.deleteSelected }, '🗑')] });
  $('#sndTransport').replaceWith(stp.el);
  const max = fullScreen($('#tab-sound'), { onChange: () => drawStage() });
  $('#sndTools').replaceChildren(
    button('✂ Split', TL.split, { title: 'Split at playhead (S)' }),
    button('🗑 Delete', TL.deleteSelected, { title: 'Delete selected clip (Del)' }),
    h('span', { class: 'tl-tip' }, info('Drag clips to move · drag ends to trim · overlap to cross-fade · S solos a track')),
    iconBtn('Zoom out', '−', () => TL.zoom(N.pps / 1.5)),
    button('Fit', TL.fit),
    iconBtn('Zoom in', '+', () => TL.zoom(N.pps * 1.5)));
  wireTimeline();
  onServer('deck_generation', ({ data }) => { if (N.gens.includes(data?.id) && $('#tab-sound').classList.contains('active')) setTimeout(renderPanel, 0); });
  playKeys(() => $('#tab-sound').classList.contains('active'), () => stp, () => ({
    s: TL.split, c: TL.split, d: TL.duplicate, f: max.toggle,
    Delete: TL.deleteSelected, Backspace: TL.deleteSelected,
    '=': () => TL.zoom(N.pps * 1.5), '+': () => TL.zoom(N.pps * 1.5), '-': () => TL.zoom(N.pps / 1.5),
  }));
}

// for the headless UI checks (dev/): the live state
export const soundDebug = () => ({ N, A, tabs });
