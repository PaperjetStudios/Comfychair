import {
  $, h, store, uid, api, busy, toast, clamp, openSheet, closeSheet, nameSheet, button, runBar, iconBtn, linkBtn, actions, seg,
  field, section, hint, help, info, note, placeholder, rangeField, propNum, mediaCard, toggle, textArea, pctFmt, colorField, sizeSelect, icon,
} from './ui.js';
import { S, fmtT, inputUrl, onServer, thumbUrl } from './core.js';
import { cardMedia, genLabel, pickerSheet, projectOutputs, registerPickerSource, soundFrameFrom, soundToSoundTab, uploadImage, uploadMedia } from './media.js';
import { openSourcePicker } from './source-picker.js';
import { itemOf } from './source-rules.js';
import { draggingPicture, dropKind, droppedFiles } from './drop-files.js';
import { openGeneration } from './run.js';
import { TabSet } from './tabs.js';
import { clipKeyTimes, clipKeys, clipSoundFields, durationOf, keyJumps, timeline, wavePeaks } from './timeline.js';
import { fmtTime, playKeys, transport } from './playback.js';
import { workArea } from './workarea.js';
import { cutItems, playFrom, playSeek, setIn, setOut, snapT, tickT } from './workarea-math.js';
import { exportTracks, renameMarker } from './timeline-rules.js';
import { keysHelp as timelineKeys } from './timeline-keys.js';
import { history } from './undo-history.js';
import { registerUndo, syncUndo } from './undo-dock.js';
import { refreshKeyed } from './keyed.js';
import * as COMP from './scene-comp.js';
import { fullScreen } from './layout.js';
import * as A from './adjust.js';
import { gradedFrame, histOfPicture } from './adjust-draw.js';
import { adjustPanel } from './adjust-panel.js';
import { canTrack, openTrack } from './track.js';
import { CLIP_FX, KEY_DEFAULT, keyRangeFields, loraChoice, restyleLoras, runClipStep } from './clip-effects.js';
import { snap, snapOn, snapStep, snapNearest, normDeg, Weight, WEIGHT, DEAD_PX, deadzone, snapBar, gzChip } from './gizmo.js';
import { openCraftSheet, sendToCraft } from './craft.js';
import { laneAbove } from './maps.js';
import { mapsSection } from './video-maps.js';
import { emptyVideo, videoTracks } from './empty-docs.js';
import { isLive, liveFrame } from './live.js';
export { emptyVideo };

// ---------------------------------------------------------------------------
// video: a Premiere-style timeline. Video tracks stack (V2 draws over V1), audio tracks mix, and
// clips that overlap on one track cross-fade. The preview composites the clips on a canvas;
// Export sends the same timeline to the server, which renders it with ffmpeg into History.
// ---------------------------------------------------------------------------
const COMP_LOOKS = [['color', 'Colour'], ['clay', 'Clay'], ['depth', 'Depth'], ['pose', 'Pose']];   // how a scene clip can be drawn (scene-offscreen.js LOOKS)
const HEAD_W = 84;    // track header column (px)
const LANE_H = 52;
const MIN_LEN = 0.1;
const V = {
  tracks: [], items: [], size: null, fps: 0, range: null, pps: store.get('deck.video.pps', 40),   // pps: timeline zoom, pixels per second (this device only)
  t: 0, playing: false, clock: 0, loop: store.get('deck.video.loop', false), sel: null, multi: [], markers: [],   // sel: the primary pick, multi: the others (timeline.js)
  els: new Map(), posters: new Map(), waves: new Map(),
};

// kind 'scene': a 3D tab live-linked as a clip (scene-comp.js); src { scene, look }, nat its natural size, dur the scene's length
export function newItem({ kind, src, url = null, label, thumb = null, dur = 0, nat = null }, track) {
  return { id: uid(), track, kind, src, url, label, thumb, dur, ...(nat ? { nat } : {}), at: 0, in: 0, out: kind === 'image' ? 3 : dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
}

const defaultTracks = videoTracks;
V.tracks = defaultTracks();

// Where the engine shows (mountVideo): the page's Video tab today, any host element later (a frame on a table).
// xform is the inspector's transform group and load the transport's loading note; both are made here, not looked up.
const VD = { host: null, stage: null, viewer: null, canvas: null, xform: null, empty: null, load: null, body: null, panel: null,
  transport: null, tlTools: null, timeline: null, active: () => !!VD.host?.classList.contains('active') };
const inTimeline = (sel) => VD.timeline?.querySelectorAll(sel) || [];   // (in this mount's timeline strip only)

// What this device kept before video edits became tabs (localStorage): moved into the first tab once
function legacyTimeline() {
  if (store.get('deck.video.seeded', false)) return null;
  const saved = store.get('deck.timeline', null);
  let p = null;
  if (saved) p = { tracks: saved.tracks || [], items: saved.items || [], size: saved.size || null, fps: saved.fps || 0 };
  else {   // the old one-track clip list
    const items = [];
    let at = 0;
    for (const c of store.get('deck.video', [])) {
      const it = newItem({ kind: 'video', src: { generation: c.generation, index: c.index }, url: c.url, label: c.label, dur: c.duration || 0 }, 'v1');
      Object.assign(it, { at, in: c.start || 0, out: c.end ?? (c.duration || null) });
      at += (it.out ?? 3) - it.in;
      items.push(it);
    }
    if (items.length) p = { tracks: [], items, size: null, fps: 0 };
  }
  return p && migrateEdit(p);   // (the flag is set once any tab has opened, so later projects start empty)
}

// ---- tabs: each video edit is a document in the project folder ----
const migrateEdit = (p) => ({ tracks: p.tracks?.length ? p.tracks : defaultTracks(), items: p.items || [], size: p.size || null, fps: p.fps || 0,
  range: p.range || null, markers: p.markers || [] });   // range: the work area (workarea.js), seconds; markers [{ t, label }]
let tabs = null;
let vtp = null;   // the transport bar (playback.js)
const ensureTabs = () => tabs.ready();

// the timeline changed: save it (the tab flushes ~1 s later, or at once on Export / leaving) and make it an undo step
function persistTimeline() { tabs?.changed(); HIST.mark(); syncUndo(); }

// ---- undo / redo: snapshots of the edit (undo-history.js), marked at persistTimeline. A step put back writes onto the
// clips that are still there (the handles, effects and inspector hold them), then redraws and saves without a new step.
// System writes (a clip's measured length, a 3D scene that changed, an effect render's progress) go through HIST.hold.
const HIST = history({
  snap: () => ({ tracks: V.tracks, items: V.items, markers: V.markers, size: V.size, fps: V.fps, range: V.range }),
  apply: applySnap });
let histDoc;   // the edit HIST is about (a reload of the same edit keeps its steps)
function applySnap(s) {
  const old = new Map(V.items.map((it) => [it.id, it]));
  V.items = (s.items || []).map((ni) => {
    const it = old.get(ni.id);
    if (!it) { if (ni.fx?.busy && !FXRUN.n) ni.fx.busy = null; return ni; }
    const busy = it.fx?.busy || null;   // (a render going on stays shown, whatever the step had)
    for (const k of Object.keys(it)) if (!(k in ni)) delete it[k];
    Object.assign(it, ni);
    if (it.fx) it.fx.busy = busy;
    return it;
  });
  Object.assign(V, { tracks: s.tracks, markers: s.markers || [], size: s.size || null, fps: s.fps || 0, range: s.range || null });
  const has = (id) => V.items.some((i) => i.id === id);
  if (!has(V.sel)) V.sel = null;
  V.multi = (V.multi || []).filter(has);
  WA.sync(); tabs?.changed();
  renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw();
}
function undoEdit() { G.settling?.w.finish(); if (HIST.undo()) syncUndo(); }
function redoEdit() { G.settling?.w.finish(); if (HIST.redo()) syncUndo(); }

// the timeline itself (timeline.js, shared with the Sound tab): a sound clip only goes on an audio track, a picture on a video track
const TL = timeline(V, { el: () => VD.timeline, headW: HEAD_W, minLen: MIN_LEN, zoom: [4, 400], ppsKey: 'deck.video.pps',
  pause: () => vidPause(), seek: (t) => vidSeek(t), showTime: () => { vtp?.update(); refreshKeyed(VD.panel); },
  changed: () => timelineChanged(), dragged: () => { renderTimeline(); syncMedia(); requestDraw(); }, rendered: () => renderTimeline(),
  placed: () => { syncMedia(); requestDraw(); },   // (a drag frame: timeline.js restyled the dragged clips itself)
  selected: () => { renderVideoPanel(); requestDraw(); }, deselected: () => { renderTimeline(); renderVideoPanel(); requestDraw(); },
  canDrop: (it, tr) => (tr.kind === 'audio') === (it.kind === 'audio'), tabs: () => tabs, area: () => WA,
  fps: () => fpsNow(), tc: (t) => tc(t), undo: () => undoEdit(), redo: () => redoEdit(),
  toolChanged: (t) => VD.timeline?.setAttribute('data-tool', t), menuAction: (id, ctx) => menuAction(id, ctx) });
const { len: itLen, end: itEnd, seqEnd, selItem, xfades, updatePlayhead } = TL;
const fadeGain = (it, t, audio) => TL.fadeGain(it, t, audio);   // pictures only fade in over an overlap (videoedit._overlaps)
const trackOf = (it) => V.tracks.find((t) => t.id === it.track);
const tracksOf = (kind) => V.tracks.filter((t) => t.kind === kind);   // video: V1 (bottom) first
const trackName = (t) => `${t.kind === 'video' ? 'V' : 'A'}${tracksOf(t.kind).indexOf(t) + 1}`;
const zOf = (it) => tracksOf('video').findIndex((t) => t.id === it.track);
const isVisual = (it) => it.kind === 'video' || it.kind === 'image' || it.kind === 'scene';
const fpsNow = () => V.fps || 24;
const tc = (t) => fmtTime(t, fpsNow());   // m:ss:ff
// the work area: a range on the ruler the playhead is bound to (workarea.js), saved with the edit
const WA = workArea({ get: () => V.range, set: (r) => { V.range = r; persistTimeline(); }, len: () => seqEnd(),
  ...TL.areaGeom, t: () => V.t, seek: (t) => vidSeek(t), step: () => 1 / fpsNow(), minLen: () => 1 / fpsNow(),
  changed: () => { renderTimeline(); renderVideoPanel(); vtp?.update(); },
  menuExtra: (close) => {   // Track motion on what the range covers, without picking a clip first
    const it = rangeClip();
    return [it ? button('Track motion on the range', () => { close(); trackClip(it); },
      { cls: 'small', title: `Follow the picture's movement in the range (${it.label})` }) : null];
  } });

// Track motion for a clip: its source span, cut to the work area when there is one (the part of the clip inside it)
// this edit is a frame open on the table (its results go in frames beside it, never to another screen)
const onTable = () => isLive('video') && liveFrame()?.doc === tabs?.active?.id;
function trackClip(it) {
  const s = it.in || 0, e = it.out ?? it.dur, r = WA.stored();
  let from = s, to = it.out ?? undefined;
  if (r) {
    const a = Math.max(it.at, r.a), b = Math.min(it.at + itLen(it), r.b);
    if (b - a > 1e-3) { from = +(s + a - it.at).toFixed(4); to = +(s + b - it.at).toFixed(4); }
  }
  const clip = { src: it.src, url: it.url, label: it.label, from, to: to ?? e };
  if (!onTable()) return openTrack(clip);
  import('./frame-scene.js').then((m) => {   // (on the table: a new 3D frame beside this one)
    if (typeof m.trackToScene !== 'function') throw new Error('Track motion into a 3D frame isn\'t ready yet');
    return m.trackToScene(clip, { frame: liveFrame() });
  }).catch((err) => toast(err.message, true));
}
// the clip a range's Track motion uses: a picked one that touches the range, else the one at the playhead, else the first
function rangeClip() {
  const r = WA.stored();
  if (!r) return null;
  const hit = V.items.filter((it) => it.kind === 'video' && canTrack(it.src) && it.at < r.b - 1e-9 && it.at + itLen(it) > r.a + 1e-9);
  return hit.find((it) => it.id === V.sel) || hit.find((it) => it.at <= V.t && V.t < it.at + itLen(it)) || hit[0] || null;
}

// ---- animated properties (timeline.js clipKeys): a clip's keys are in its own source time, on the sequence's frames ----
const PROPS = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1 };   // what an unset property is
const K = clipKeys(TL, V, { fps: fpsNow, base: PROPS, pause: () => vidPause(), seek: (t) => vidSeek(t), onKeys: () => panelChanged(),
  live: { onInput: () => panelInput(), onChange: () => panelChange() } });   // (its sliders are the inspector's: they edit every picked clip)
const { prop, setProp } = K;

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
  const urls = new Set(V.items.filter((it) => it.kind !== 'image' && it.url).map((it) => it.url));
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
  const el = VD.load;
  if (el) el.textContent = done < all.length ? `Loading ${done}/${all.length}…` : '';
}

// a scene clip's picture at the playhead, drawn at the size it shows at (a canvas that stands in for a media element)
function sceneEl(it) {
  const [nw, nh] = COMP.natOf(it), [W, H] = seqSize();
  const s = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh) * (prop(it, 'scale') || 1);
  const el = COMP.frame(it, V.t, nw * s, nh * s);
  V.els.set(it.id, { el, url: null, src: null });
  return el;
}

function mediaFor(it) {
  if (it.kind === 'scene') return sceneEl(it);
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
  if (!isFinite(d) || !d || Math.abs(it.dur - d) < 0.01) return;
  it.dur = d;
  if (it.out == null || it.out > d) it.out = d;
  HIST.hold(() => persistTimeline()); renderTimeline();   // (measured, not an edit: no undo step)
}

function pruneEls() {
  for (const [id, m] of V.els) {
    if (V.items.some((i) => i.id === id)) continue;
    if (m.el.pause) m.el.pause();
    m.el.removeAttribute('src');
    V.els.delete(id);
  }
  COMP.forget(new Set(V.items.map((i) => i.id)));
}

function syncMedia(jump = false) {   // jump: the playhead just jumped (loop, seek), so every clip follows
  for (const it of V.items) {
    if (it.kind === 'scene') { if (!V.els.has(it.id)) V.els.set(it.id, { el: COMP.canvasFor(it), url: null, src: null }); continue; }   // (drawn only when it's on show: drawFrame)
    if (it.kind === 'image') { mediaFor(it); continue; }
    const el = mediaFor(it), tr = trackOf(it);
    if (V.t < it.at || V.t >= itEnd(it)) {
      if (!el.paused) el.pause();
      // cue up a clip that's about to start so it begins cleanly
      if (it.at > V.t && it.at - V.t < 4 && !el.seeking && Math.abs(el.currentTime - it.in) > 0.05) el.currentTime = it.in;
      continue;
    }
    const want = it.in + V.t - it.at;
    const vol = prop(it, 'volume');
    el.muted = !!(tr && tr.muted) || !(vol > 0) || starting.get(el) === 'muted';
    el.volume = clamp(vol * fadeGain(it, V.t, true), 0, 1);
    if (V.playing) {
      if (el.paused) startMedia(el, want);
      else if (playSeek(el.currentTime, want, { master: it.id === V.master, jump })) el.currentTime = want;
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
    if (it.kind === 'image' || it.kind === 'scene') continue;
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
  requestAnimationFrame(() => { drawQueued = false; drawFrame(); drawGizmo(); });
}

function drawFrame() {
  const cv = VD.canvas;
  if (!cv) return;   // (not mounted yet)
  const [W, H] = seqSize();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; renderVideoPanel(); }   // the panel shows the size
  const layers = tracksOf('video').filter((tr) => !tr.hidden).map((tr) =>
    V.items.filter((it) => it.track === tr.id && V.t >= it.at && V.t < itEnd(it)).sort((a, b) => a.at - b.at));
  // A clip that's loading or seeking has no frame to draw: keep the last picture for a moment
  // rather than flashing black (or the track underneath).
  const ready = (it) => {
    const el = mediaFor(it);
    return it.kind === 'scene' ? true : it.kind === 'image' ? el.complete && el.naturalWidth > 0 : el.readyState >= 2 && !el.seeking;
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
      const g = geom(it, [W, H]);
      ctx.globalAlpha = clamp(prop(it, 'opacity'), 0, 1) * fadeGain(it, V.t, false);
      // the anchor sits at the frame centre + (x, y); the clip turns and scales around it (videoedit._place does the same)
      ctx.save(); ctx.translate(g.px, g.py); ctx.rotate(g.rot);
      ctx.drawImage(A.isOn(it.adjust) ? gradedFrame(el, it.adjust, V.playing ? 960 : 1600) : el, -g.ax * g.dw, -g.ay * g.dh, g.dw, g.dh);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- 2D gizmo: After Effects-style handles on the preview for the selected clip ----
// A clip's anchor point lands at the frame centre + (x*W, y*H) and the clip turns and scales around
// it, so rotating or scaling never moves the anchor. The same geometry is drawn by drawFrame and
// rendered by videoedit._place. Handles are drawn in screen pixels so they keep their size at any zoom.
// Tap: select / drag the body = move, corners = scale, round knob = rotate, crosshair = anchor
// (dragging the anchor re-pins it without moving the picture). The pointer drives a weighted
// spring (gizmo.js Weight), snaps first: grid / frame edges / rotate and scale steps.
const G = { cv: null, hover: null, drag: null, settling: null, guides: [] };
const COL = '#4da3ff', HOT = '#ffd24d';
const KNOB = 34;   // rotate knob distance above the box, px

// the clip's geometry in frame pixels: where its anchor lands (px, py), drawn size, turn in radians
function geom(it, [W, H] = seqSize()) {
  const el = V.els.get(it.id)?.el;
  const nw = el && (el.videoWidth || el.naturalWidth), nh = el && (el.videoHeight || el.naturalHeight);
  if (!nw) return null;
  const base = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh), s = base * (prop(it, 'scale') || 1);
  return { W, H, nw, nh, base, dw: nw * s, dh: nh * s, ax: it.anchor?.x ?? 0.5, ay: it.anchor?.y ?? 0.5,
    px: W / 2 + prop(it, 'x') * W, py: H / 2 + prop(it, 'y') * H, rot: (prop(it, 'rotation') * Math.PI) / 180 };
}
// frame point at (u, v) pixels from the anchor in the clip's own axes
const world = (g, u, v) => { const c = Math.cos(g.rot), s = Math.sin(g.rot); return [g.px + u * c - v * s, g.py + u * s + v * c]; };
const cornerAt = (g, cx, cy) => world(g, (cx - g.ax) * g.dw, (cy - g.ay) * g.dh);
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function gview() {
  const r = G.cv.getBoundingClientRect(), [W, H] = seqSize(), k = Math.min(r.width / W, r.height / H) || 1;
  return { r, W, H, k: k * VZ.z, ox: ((r.width - W * k) / 2) * VZ.z + VZ.tx, oy: ((r.height - H * k) / 2) * VZ.z + VZ.ty };
}

// ---- the view: zoom and pan the preview as in the Image tab. The wheel zooms about the pointer, two fingers pan and
// zoom, and the middle button or a mouse drag on the dark area round the picture pans (Space stays play here). Fit
// (shown while zoomed) puts it back. VZ is on top of the fit: screen = fitted * z + t (a CSS transform on the frame's canvas).
const VZ = { z: 1, tx: 0, ty: 0 };
const vzoomed = () => VZ.z !== 1 || VZ.tx !== 0 || VZ.ty !== 0;
function setView(z, tx, ty) {
  Object.assign(VZ, { z, tx, ty });
  const cv = VD.canvas;
  if (cv) cv.style.transformOrigin = '0 0';
  if (cv) cv.style.transform = vzoomed() ? `translate(${tx}px, ${ty}px) scale(${z})` : '';
  G.fit?.classList.toggle('hidden', !vzoomed());
  drawGizmo();
}
const fitView = () => setView(1, 0, 0);
function zoomAt(f, px, py) {   // (px, py: viewer px) stays put
  const z = clamp(VZ.z * f, 0.1, 40);
  setView(z, px - ((px - VZ.tx) * z) / VZ.z, py - ((py - VZ.ty) * z) / VZ.z);
}
const PAN = { pan: null, touches: new Map(), pinch: null };
function panStart(e) {
  PAN.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: VZ.tx, ty: VZ.ty };
  try { G.cv.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
  G.cv.style.cursor = 'grabbing';
}
// a second finger turns a drag into a pinch: what the first finger moved goes back
function dropDrag() {
  const d = G.drag;
  if (!d) return;
  d.w.cancel();
  for (const x of [d, ...(d.others || [])]) {
    for (const k of Object.keys(x.it)) delete x.it[k];
    Object.assign(x.it, x.before);
  }
  G.drag = null; G.guides = [];
  syncInspector(); persistTimeline(); requestDraw();
}
// pointerdown, before the handles: true when the view took it
function viewDown(e) {
  if (e.pointerType === 'touch') {
    PAN.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (PAN.touches.size === 2) {
      dropDrag();
      const [a, b] = [...PAN.touches.values()];
      PAN.pinch = { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), v: { ...VZ } };
      for (const id of PAN.touches.keys()) try { G.cv.setPointerCapture(id); } catch { /* pointer gone */ }
    }
    return PAN.touches.size > 1;
  }
  if (e.button === 1) { e.preventDefault(); panStart(e); return true; }
  return false;
}
function viewMove(e) {
  if (PAN.touches.has(e.pointerId)) PAN.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (PAN.pinch && PAN.touches.size >= 2) {
    const [a, b] = [...PAN.touches.values()], P = PAN.pinch, r = G.cv.getBoundingClientRect();
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z = clamp(P.v.z * Math.hypot(a.x - b.x, a.y - b.y) / P.d, 0.1, 40);
    const bx = (P.m.x - r.left - P.v.tx) / P.v.z, by = (P.m.y - r.top - P.v.ty) / P.v.z;   // the fitted point under the fingers' start
    setView(z, m.x - r.left - bx * z, m.y - r.top - by * z);
    return true;
  }
  if (PAN.pan && e.pointerId === PAN.pan.id) {
    setView(VZ.z, PAN.pan.tx + e.clientX - PAN.pan.x, PAN.pan.ty + e.clientY - PAN.pan.y);
    return true;
  }
  return false;
}
function viewUp(e) {
  const wasTouch = PAN.touches.delete(e.pointerId);
  if (PAN.pinch) {
    if (PAN.touches.size < 2) PAN.pinch = null;
    return true;   // (the finger left over doesn't start a drag)
  }
  if (PAN.pan && e.pointerId === PAN.pan.id) { PAN.pan = null; G.cv.style.cursor = ''; return true; }
  return wasTouch && PAN.touches.size > 0;
}
const scr = (v, [x, y]) => [v.ox + x * v.k, v.oy + y * v.k];
const unscr = (v, sx, sy) => [(sx - v.ox) / v.k, (sy - v.oy) / v.k];
const inRange = (it) => V.t >= it.at && V.t < itEnd(it);
const gizmoClip = () => { const it = selItem(); return it && isVisual(it) && !V.playing && inRange(it) ? it : null; };

// the handle points in screen pixels
function handlePts(g, v) {
  const tc = scr(v, cornerAt(g, 0.5, 0)), up = [Math.sin(g.rot), -Math.cos(g.rot)];
  return { anchor: scr(v, [g.px, g.py]), corners: CORNERS.map(([cx, cy]) => scr(v, cornerAt(g, cx, cy))), tc, rot: [tc[0] + up[0] * KNOB, tc[1] + up[1] * KNOB] };
}
function bodyHit(g, fx, fy) {   // is the frame point inside the clip's box?
  const dx = fx - g.px, dy = fy - g.py, c = Math.cos(g.rot), s = Math.sin(g.rot);
  const u = dx * c + dy * s + g.ax * g.dw, w = -dx * s + dy * c + g.ay * g.dh;
  return u >= 0 && u <= g.dw && w >= 0 && w <= g.dh;
}
// what's under a screen point (sx, sy): 'anchor' | 'rotate' | 'c0'..'c3' | 'move' | null
function gizmoHit(it, sx, sy, type) {
  const g = geom(it), v = gview();
  if (!g) return null;
  const q = handlePts(g, v), r = type === 'touch' ? 26 : type === 'pen' ? 18 : 11;
  const d = (p) => Math.hypot(p[0] - sx, p[1] - sy);
  if (d(q.anchor) <= r * 0.8) return 'anchor';
  if (d(q.rot) <= r) return 'rotate';
  const ds = q.corners.map(d), best = ds.indexOf(Math.min(...ds));
  if (ds[best] <= r) return `c${best}`;
  return bodyHit(g, ...unscr(v, sx, sy)) ? 'move' : null;
}
function pickAt(sx, sy) {   // the topmost visible clip under a point
  const v = gview(), [fx, fy] = unscr(v, sx, sy);
  const live = V.items.filter((it) => isVisual(it) && inRange(it) && !trackOf(it)?.hidden).sort((a, b) => zOf(b) - zOf(a) || b.at - a.at);
  return live.find((it) => { const g = geom(it); return g && bodyHit(g, fx, fy); }) || null;
}

function gizmoCursor(hit, g) {
  if (!hit) return '';
  if (hit === 'move') return 'move';
  if (hit === 'anchor') return 'crosshair';
  if (hit === 'rotate') return G.drag ? 'grabbing' : 'grab';
  const [cx, cy] = CORNERS[+hit[1]], p = [(cx - g.ax) * g.dw, (cy - g.ay) * g.dh];   // which diagonal this corner is on, turned
  const a = (Math.atan2(p[1], p[0]) + g.rot + Math.PI * 4) % Math.PI;
  return a > Math.PI / 8 && a < (Math.PI * 3) / 8 ? 'nwse-resize' : a > (Math.PI * 5) / 8 && a < (Math.PI * 7) / 8 ? 'nesw-resize' : a < Math.PI / 8 || a > (Math.PI * 7) / 8 ? 'ew-resize' : 'ns-resize';
}

function drawGizmo() {
  const cv = G.cv;
  if (!cv) return;
  const v = gview(), dpr = window.devicePixelRatio || 1, w = Math.round(v.r.width * dpr), hh = Math.round(v.r.height * dpr);
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, v.r.width, v.r.height);
  if (!V.items.length) return;
  const line = (a, b, col, wd = 1, dash = null) => {
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.setLineDash(dash || []); ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.stroke();
  };
  if (snap.grid) {   // lines from the frame centre outwards, every grid step
    const gp = (v.W * snap.gridPct) / 100;
    for (let i = -Math.floor(v.W / 2 / gp); i <= Math.floor(v.W / 2 / gp); i++) {
      const x = v.W / 2 + i * gp;
      line(scr(v, [x, 0]), scr(v, [x, v.H]), i ? '#ffffff30' : '#ffffff70');
    }
    for (let i = -Math.floor(v.H / 2 / gp); i <= Math.floor(v.H / 2 / gp); i++) {
      const y = v.H / 2 + i * gp;
      line(scr(v, [0, y]), scr(v, [v.W, y]), i ? '#ffffff30' : '#ffffff70');
    }
  }
  for (const gd of G.guides) line(...(gd.axis === 'x' ? [scr(v, [gd.v, 0]), scr(v, [gd.v, v.H])] : [scr(v, [0, gd.v]), scr(v, [v.W, gd.v])]), '#ff4dd2', 1.5);
  const it = selItem();
  if (!it || V.playing) return;
  for (const o of TL.picked()) {   // the other picks: a dashed outline (a drag on any of them moves them all)
    const og = o !== it && isVisual(o) && inRange(o) && geom(o);
    if (!og) continue;
    const cs = CORNERS.map(([cx, cy]) => scr(v, cornerAt(og, cx, cy)));
    ctx.beginPath(); cs.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
    ctx.setLineDash([6, 4]); ctx.strokeStyle = COL; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
  }
  if (!isVisual(it) || !inRange(it)) return;   // (the handles show while the playhead is over the clip)
  const g = geom(it);
  if (!g) return;
  const q = handlePts(g, v), act = G.drag?.hit || G.settling?.hit, on = (k) => (act || G.hover) === k;
  const poly = () => { ctx.beginPath(); q.corners.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); };
  poly(); ctx.setLineDash([]); ctx.strokeStyle = '#000a'; ctx.lineWidth = 4; ctx.stroke();
  poly(); ctx.strokeStyle = on('move') ? HOT : COL; ctx.lineWidth = 2; ctx.stroke();
  line(q.tc, q.rot, '#000a', 4); line(q.tc, q.rot, COL, 1.5);
  const dot = (p, r, k, round) => {
    ctx.beginPath();
    if (round) ctx.arc(p[0], p[1], r, 0, Math.PI * 2); else ctx.rect(p[0] - r, p[1] - r, r * 2, r * 2);
    ctx.fillStyle = on(k) ? HOT : '#fff'; ctx.fill(); ctx.strokeStyle = on(k) ? '#000' : COL; ctx.lineWidth = 2; ctx.stroke();
  };
  q.corners.forEach((p, i) => dot(p, on(`c${i}`) ? 8 : 6, `c${i}`, false));
  dot(q.rot, on('rotate') ? 9 : 7, 'rotate', true);
  const [ax, ay] = q.anchor, ar = on('anchor') ? 11 : 8;   // anchor: ring with a cross
  ctx.setLineDash([]); ctx.lineWidth = 3; ctx.strokeStyle = '#000a';
  ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.moveTo(ax - ar - 5, ay); ctx.lineTo(ax + ar + 5, ay); ctx.moveTo(ax, ay - ar - 5); ctx.lineTo(ax, ay + ar + 5); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.strokeStyle = on('anchor') ? HOT : '#fff'; ctx.stroke();
}

// keep the inspector's numbers in step with the handles (only the transform group is rebuilt)
function syncInspector() {
  const box = VD.xform, it = selItem();
  if (box && it && isVisual(it)) box.replaceChildren(...xformFields(it));
  fanSync();   // (the handles moved it, and the others with it: nothing for the inspector to copy)
}

// move the anchor to frame point `to` (or by sliders) without the picture moving: the anchor's spot
// follows, so the clip stays where it was
function pinAnchor(it, g, toX, toY) {
  const c = Math.cos(g.rot), s = Math.sin(g.rot), dx = toX - g.px, dy = toY - g.py;
  const ax = g.ax + (dx * c + dy * s) / g.dw, ay = g.ay + (-dx * s + dy * c) / g.dh;
  if (Math.abs(ax - 0.5) < 1e-3 && Math.abs(ay - 0.5) < 1e-3) delete it.anchor; else it.anchor = { x: +ax.toFixed(4), y: +ay.toFixed(4) };
  setProp(it, 'x', +((toX - g.W / 2) / g.W).toFixed(5)); setProp(it, 'y', +((toY - g.H / 2) / g.H).toFixed(5));
}
function setAnchor(it, ax, ay) {   // from the inspector: where the anchor sits in the clip, the picture stays put
  const g = geom(it);
  if (!g) { it.anchor = { x: ax, y: ay }; return; }
  const [x, y] = world(g, (ax - g.ax) * g.dw, (ay - g.ay) * g.dh);
  pinAnchor(it, g, x, y);
}

// ---- snapping ----
function snapMove(g, v, [x, y], ev) {
  const gd = [], thr = 8 / v.k;
  let lockX = false, lockY = false;
  if (snapOn('edges', ev)) {
    const cs = CORNERS.map(([cx, cy]) => world({ ...g, px: x, py: y }, (cx - g.ax) * g.dw, (cy - g.ay) * g.dh));
    const near = (vals, targets) => snapNearest(vals, targets, thr);
    const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
    const bx = near([Math.min(...xs), (Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...xs), x], [0, g.W / 2, g.W]);
    const by = near([Math.min(...ys), (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...ys), y], [0, g.H / 2, g.H]);
    if (bx) { x += bx.d; lockX = true; gd.push({ axis: 'x', v: bx.at }); }
    if (by) { y += by.d; lockY = true; gd.push({ axis: 'y', v: by.at }); }
  }
  if (snapOn('grid', ev)) {
    const gp = (g.W * snap.gridPct) / 100;
    if (!lockX) x = g.W / 2 + snapStep(x - g.W / 2, gp);
    if (!lockY) y = g.H / 2 + snapStep(y - g.H / 2, gp);
  }
  G.guides = gd;
  return [x, y];
}
function snapScale(g, s, ev) {
  if (!snapOn('scale', ev)) return s;
  const st = snap.scaleStep / 100;
  s = Math.max(st, snapStep(s, st));
  for (const m of [g.W / (g.nw * g.base), g.H / (g.nh * g.base)]) if (Math.abs(s - m) / m < 0.02) s = m;   // exactly spans the frame
  return s;
}

// ---- pointer ----
function gizmoDown(e) {
  if (viewDown(e)) return;
  if (G.drag || (e.pointerType === 'mouse' && e.button > 0)) return;
  G.settling?.w.finish();
  const r = G.cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  let it = gizmoClip(), hit = it && gizmoHit(it, sx, sy, e.pointerType);
  if (!hit) {
    it = pickAt(sx, sy);
    if (!it) {   // the dark area round the picture: a mouse or pen drag pans the view
      if (e.pointerType !== 'touch' && e.button === 0) panStart(e);
      return;
    }
    // as on the timeline (timeline.js pick): alone, Shift a range, Ctrl / Meta in or out; a picked clip drags the set
    if (e.shiftKey || e.ctrlKey || e.metaKey) TL.pick(it, e);
    else if (!TL.isSel(it)) TL.pick(it);
    requestDraw();
    if (!TL.isSel(it)) return;
    hit = 'move';
  }
  e.preventDefault();
  try { G.cv.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
  gizmoStart(it, hit, e, sx, sy);
}

function gizmoStart(it, hit, e, sx, sy) {
  const g = geom(it), v = gview();
  if (!g) return;
  const kind = hit === 'move' ? 'move' : hit === 'rotate' ? 'rotate' : hit === 'anchor' ? 'anchor' : 'scale';
  const o = { scale: prop(it, 'scale') || 1, rot: prop(it, 'rotation') };
  const P = scr(v, [g.px, g.py]), d = { id: e.pointerId, it, before: structuredClone(it), hit, kind, g, o, sx, sy, P, d0: Math.max(Math.hypot(sx - P[0], sy - P[1]), 14), acc: 0, last: Math.atan2(sy - P[1], sx - P[0]) };
  // a move takes the other picked pictures along by the same amount
  d.others = kind === 'move' ? TL.picked().filter((x) => x !== it && isVisual(x)).map((x) => ({ it: x, before: structuredClone(x), x0: prop(x, 'x'), y0: prop(x, 'y') })) : [];
  const chans = {
    move: { px: [g.px, WEIGHT.move], py: [g.py, WEIGHT.move] }, anchor: { px: [g.px, WEIGHT.anchor], py: [g.py, WEIGHT.anchor] },
    scale: { r: [1, WEIGHT.scale] }, rotate: { a: [o.rot, WEIGHT.rotate] },
  }[kind];
  d.w = new Weight(chans, (val) => {   // each frame: the springs' values into the clip
    if (kind === 'move') {
      setProp(it, 'x', +((val.px - g.W / 2) / g.W).toFixed(5)); setProp(it, 'y', +((val.py - g.H / 2) / g.H).toFixed(5));
      const dx = (val.px - g.px) / g.W, dy = (val.py - g.py) / g.H;
      for (const x of d.others) { setProp(x.it, 'x', +(x.x0 + dx).toFixed(5)); setProp(x.it, 'y', +(x.y0 + dy).toFixed(5)); }
    }
    else if (kind === 'anchor') pinAnchor(it, g, val.px, val.py);
    else if (kind === 'scale') setProp(it, 'scale', +clamp(o.scale * val.r, 0.02, 20).toFixed(4));
    else setProp(it, 'rotation', +normDeg(val.a).toFixed(2));   // (a key holds every value; the plain one is just a number)
    syncInspector(); requestDraw();
  }, () => { G.guides = []; if (G.settling === d) G.settling = null; persistTimeline(); requestDraw(); });
  G.drag = d;
  persistTimeline();   // dirty from the first touch, so leaving mid-settle can't lose it
  G.cv.style.cursor = gizmoCursor(hit, g);
  requestDraw();
}

function gizmoMove(e) {
  if (viewMove(e)) return;
  const d = G.drag;
  if (!d) {   // hovering (a pen above the glass, or a mouse): light up the handle under it before it's touched
    if (e.pointerType === 'touch') return;
    const r = G.cv.getBoundingClientRect(), it = gizmoClip(), hit = it ? gizmoHit(it, e.clientX - r.left, e.clientY - r.top, e.pointerType) : null;
    if (hit !== G.hover) {
      G.hover = hit;
      const g = it && geom(it);
      G.cv.style.cursor = g ? gizmoCursor(hit, g) : '';
      drawGizmo();
    }
    return;
  }
  if (e.pointerId !== d.id) return;
  const v = gview(), r = v.r, sx = e.clientX - r.left, sy = e.clientY - r.top, { g, o } = d;
  if (d.kind === 'move' || d.kind === 'anchor') {
    const [dx, dy] = deadzone(sx - d.sx, sy - d.sy, DEAD_PX[d.kind]);
    let t = [g.px + dx / v.k, g.py + dy / v.k];
    if (d.kind === 'move') t = snapMove(g, v, t, e);
    else t = snapAnchor(g, v, t, e);
    d.w.aim('px', t[0]); d.w.aim('py', t[1]);
  } else if (d.kind === 'scale') {
    const dist = Math.hypot(sx - d.P[0], sy - d.P[1]), [dd] = deadzone(dist - d.d0, 0, DEAD_PX.scale);
    const s = snapScale(g, Math.max(0.02, (o.scale * (d.d0 + dd)) / d.d0), e);
    d.w.aim('r', s / o.scale);
  } else {
    const a = Math.atan2(sy - d.P[1], sx - d.P[0]);
    let da = a - d.last;
    if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
    d.acc += da; d.last = a;
    let t = o.rot + (Math.hypot(sx - d.sx, sy - d.sy) <= DEAD_PX.rotate ? 0 : (d.acc * 180) / Math.PI);
    if (snapOn('rot', e)) t = snapStep(t, snap.rotStep);
    d.w.aim('a', t);
  }
}
// the anchor sticks to the clip's own corners / edge middles / centre, and to the grid
function snapAnchor(g, v, [x, y], ev) {
  G.guides = [];
  if (snapOn('edges', ev)) {
    let best = null;
    for (const cx of [0, 0.5, 1]) for (const cy of [0, 0.5, 1]) {
      const p = cornerAt(g, cx, cy), dd = Math.hypot(p[0] - x, p[1] - y) * v.k;
      if (dd < 12 && (!best || dd < best.dd)) best = { dd, p };
    }
    if (best) return best.p;
  }
  if (snapOn('grid', ev)) { const gp = (g.W * snap.gridPct) / 100; return [g.W / 2 + snapStep(x - g.W / 2, gp), g.H / 2 + snapStep(y - g.H / 2, gp)]; }
  return [x, y];
}

function gizmoUp(e) {
  if (viewUp(e)) return;
  const d = G.drag;
  if (!d || e.pointerId !== d.id) return;
  G.drag = null;
  G.settling = d;   // the weight lets go: it settles into place, then saves
  d.w.release();
  G.cv.style.cursor = '';
  G.hover = null;
}

// the handles' canvas and snap bar, made once; each mount puts them on its viewer (placeGizmo)
function makeGizmo() {
  G.cv = h('canvas', { id: 'vidGizmo', class: 'gizmo' });
  G.bar = snapBar(['edges', 'grid', 'rot', 'scale'], () => requestDraw());
  G.fit = gzChip('Fit', fitView, { title: 'Fit the frame in view' });
  G.fit.classList.add('hidden');
  G.bar.append(G.fit);
  G.cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = G.cv.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  G.cv.addEventListener('pointerdown', gizmoDown);
  G.cv.addEventListener('pointermove', gizmoMove);
  G.cv.addEventListener('pointerup', gizmoUp);
  G.cv.addEventListener('pointercancel', gizmoUp);
  G.cv.addEventListener('pointerleave', () => { if (!G.drag && G.hover) { G.hover = null; drawGizmo(); } });
  G.ro = new ResizeObserver(() => drawGizmo());
}
function placeGizmo(viewer) {
  viewer.append(G.cv, G.bar);
  G.ro.disconnect(); G.ro.observe(viewer);
}

function vidPlay() {
  if (!V.items.length) return;
  V.t = playFrom(V.t, WA.bound(), seqEnd(), 0.01);
  unlockMedia();
  V.playing = true; V.clock = performance.now() - V.t * 1000;
  drawGizmo();   // the handles step aside while it plays
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
  const ok = (it) => it && it.kind !== 'image' && it.kind !== 'scene' && V.t >= it.at && V.t < itEnd(it) && V.els.has(it.id)
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
  const step = tickT(V.t, WA.bound(), seqEnd(), V.loop);   // (inside the work area while it is on)
  const jump = step.t !== V.t;
  if (jump) {
    V.t = step.t; V.clock = performance.now() - V.t * 1000;
    if (step.stop) { vidPause(); updatePlayhead(); return; }
  }
  syncMedia(jump); drawFrame(); updatePlayhead(true);
  requestAnimationFrame(vidTick);
}
function vidSeek(t) {
  V.t = WA.clamp(Math.max(0, t));
  if (V.playing) V.clock = performance.now() - V.t * 1000;
  syncMedia(V.playing); requestDraw(); updatePlayhead();
}
function showPlayState() { vtp?.update(); }

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

async function loadWave(url) {   // loudness peaks, 50 per second, for drawing audio clips (scaled up to full height)
  V.waves.set(url, 'loading');
  const b = blobs.get(url);
  try { V.waves.set(url, await wavePeaks(b && b.state === 'ready' ? b.src : url, 50, { normalize: true })); } catch { V.waves.set(url, 'none'); }
  drawWaves();
}

function drawWaves() {
  inTimeline('canvas.wave').forEach((c) => {
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
  const gone = it.kind === 'scene' && COMP.sceneOf(it.src.scene)?.state === 'missing';
  return h('div', { class: `tl-clip ${it.kind}` + (TL.isSel(it) ? ' sel' : '') + (gone ? ' gone' : '') + (it.fx?.busy ? ' fx-busy-clip' : ''), 'data-id': it.id,
    title: gone ? 'This 3D scene was deleted' : null,
    style: `left:${it.at * V.pps}px;width:${Math.max(6, itLen(it) * V.pps)}px` + (bg ? `;background-image:url("${bg}")` : '') },
    it.kind === 'audio' ? h('canvas', { class: 'wave' }) : null,
    h('span', { class: 'tl-label' }, gone ? icon('warn') : null, it.label),
    it.fx?.busy ? h('span', { class: 'tl-fxtag' }, h('span', { class: 'spinner' }), h('span', { class: 'fx-text' }, fxStatus(it))) : null,
    fi ? h('span', { class: 'tl-fade in', style: `width:${fi * V.pps}px` }) : null,
    it.fadeOut ? h('span', { class: 'tl-fade out', style: `width:${it.fadeOut * V.pps}px` }) : null,
    K.diamonds(it, V.pps, tc),   // its keys, After Effects style
    h('span', { class: 'tl-trim l' }), h('span', { class: 'tl-trim r' }));
}

function trackHead(tr) {
  const removable = tracksOf(tr.kind).length > 1 && !V.items.some((i) => i.track === tr.id);
  const tog = (key, on, off, title) => h('button', { type: 'button', class: 'tl-tog' + (tr[key] ? ' off' : ''), title, 'aria-label': title,
    'aria-pressed': String(!!tr[key]), onclick: () => { tr[key] = !tr[key]; timelineChanged(); } }, icon(tr[key] ? off : on));
  return h('div', { class: 'tl-head' },
    h('b', {}, trackName(tr)),
    h('div', { class: 'tl-head-btns' },
      tr.kind === 'video' ? tog('hidden', 'eye', 'eyeoff', 'Show / hide this track') : null,
      tog('muted', 'sound', 'mute', 'Mute / unmute this track'),
      removable ? h('button', { type: 'button', class: 'tl-tog', title: 'Remove this empty track', 'aria-label': 'Remove this empty track',
        onclick: () => { V.tracks = V.tracks.filter((t) => t !== tr); timelineChanged(); } }, icon('close')) : null));
}

function addTrack(kind) {
  const id = `${kind[0]}${uid()}`;
  V.tracks.push({ id, kind });
  return id;
}

function renderTimeline() {
  TL.render({
    corner: [h('button', { type: 'button', class: 'tl-tog', title: 'Add a video track', onclick: () => { addTrack('video'); timelineChanged(); } }, '+V'),
      h('button', { type: 'button', class: 'tl-tog', title: 'Add an audio track', onclick: () => { addTrack('audio'); timelineChanged(); } }, '+A')],
    rows: [...tracksOf('video')].reverse().concat(tracksOf('audio'))
      .map((tr) => ({ track: tr, cls: tr.kind + (tr.hidden || tr.muted && tr.kind === 'audio' ? ' off' : ''), head: trackHead(tr) })),
    clipEl });
  drawWaves(); pruneEls(); preloadMedia(); updatePlayhead();
  VD.empty?.classList.toggle('hidden', V.items.length > 0);
}

function timelineChanged() {
  persistTimeline(); renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw();
}

export function renderVideo() { renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); ensureTabs().catch(() => {}); COMP.refresh(); }

// ---- editing ----
function targetTrack(kind) {
  const want = kind === 'audio' ? 'audio' : 'video';
  const sel = selItem(), st = sel && trackOf(sel);
  if (st && st.kind === want) return st.id;
  return (tracksOf(want)[0] || {}).id || addTrack(want);
}

// New clips go after the last clip on the selected clip's track (or V1 / A1)
// place: { track, at } puts it there (a drop on a lane); a track of the wrong kind (sound on a picture lane) is ignored
export async function addToTimeline(media, place = null) {
  await ensureTabs();   // the tab must be open, or its clips would replace this one
  if (media.kind !== 'image' && !media.dur) media.dur = await durationOf(media.url, media.kind === 'audio' ? 'audio' : 'video');
  const want = media.kind === 'audio' ? 'audio' : 'video';
  const lane = place?.track && V.tracks.find((t) => t.id === place.track && t.kind === want);
  const it = newItem(media, lane ? lane.id : targetTrack(media.kind));
  if (media.kind === 'image' && media.len > 0) it.out = Math.max(MIN_LEN, media.len);   // (a storyboard shot's length)
  if (media.trim && media.kind !== 'image') {   // (a table frame's clip: the part its timeline used)
    it.in = Math.max(0, media.trim.start || 0);
    if (media.trim.len > 0) it.out = it.dur ? Math.min(it.dur, it.in + media.trim.len) : it.in + media.trim.len;
  }
  it.at = lane && place.at != null ? Math.max(0, place.at) : TL.trackEnd(it.track);
  V.items.push(it); V.sel = it.id; V.multi = [];
  timelineChanged();
  return it;
}
// several clips, in order, on the timeline (Story's Shots to video, and the 3D tab's Each shot)
export async function layOnTimeline(list, { land = addToTimeline } = {}) {
  const made = [];
  for (const media of list) made.push(await land(media));
  return made;
}

// A source (source-picker.js item src, or a Shelf drag's payload) as the media addToTimeline takes: { input } | { generation,
// index } | { media } | { frame } (a table image frame: its picture is made an input first, `fresh`, deleted if it doesn't land).
// kind / label / trim: what the picker knows of it. null: nothing a timeline can hold.
async function mediaOfSource(src, { kind = null, label = null, trim = null } = {}) {
  let m = null;
  if (!src || typeof src !== 'object') return null;
  if (src.frame != null) {
    const f = ((await import('./table.js')).tableFrames() || []).find((x) => x.id === src.frame);
    if (!f) throw new Error('That frame is no longer on the table');
    const s = await (await import('./frame-source.js')).frameSource(f);
    m = { kind: 'image', src: { input: s.name }, url: inputUrl(s.name), thumb: thumbUrl(s.name, 160), label: label || f.label || s.name.split('/').pop(), fresh: s.name };
  } else if (src.input) {
    m = { kind: 'image', src: { input: src.input }, url: inputUrl(src.input), thumb: thumbUrl(src.input, 160), label: label || src.input.split('/').pop() };
  } else if (src.generation != null) {
    const index = src.index || 0, g = S.history.get(src.generation) || await api(`/api/generations/${src.generation}`, { busy: false });
    const o = g?.outputs?.[index];
    if (!o) throw new Error(`Run #${src.generation} has nothing to add`);
    const k = o.kind === 'audio' || o.kind === 'video' ? o.kind : 'image';
    m = { kind: k, src: { generation: g.id, index }, url: o.url, label: label || genLabel(g), dur: o.duration || 0, thumb: k === 'image' ? o.url : null };
  } else if (src.media) {
    const k = kind || src.kind || itemOf({ media: src.media })?.kind || 'video', url = src.url || `/files/media/${encodeURIComponent(src.media)}`;
    m = { kind: k === 'audio' || k === 'image' ? k : 'video', src: { media: src.media }, url, thumb: k === 'image' ? url : null,
      label: label || src.label || src.media.split('_').slice(1).join('_') || src.media };
  }
  if (m && trim && m.kind !== 'image') m.trim = trim;
  return m;
}
// media on the timeline (place: addToTimeline's); a picture made for it goes again when it can't land
async function landSource(m, place = null) {
  try { return await addToTimeline(m, place); } catch (e) {
    if (m.fresh) (await import('./table-frames.js')).dropInput(m.fresh);
    throw e;
  }
}
// + Add: pictures, clips and sounds from anywhere (source-picker.js), ticked in order, each on the track it goes on
function addSources() {
  openSourcePicker({ kinds: ['video', 'image', 'audio'], want: 'any', multi: true, title: 'Add to the timeline', mpKey: 'video-add',
    onPick: async (item) => {
      const m = await mediaOfSource(item.src, { kind: item.kind, label: item.label, trim: item.trim });
      if (!m) throw new Error('That can\'t go on a timeline');
      await layOnTimeline([m], { land: landSource });
    } });
}

// a 3D tab as a clip: live-linked (scene-comp.js), not baked; its length is the scene's
function addScene() {
  let look = 'color';
  pickerSheet('Add a 3D scene', [
    seg(COMP_LOOKS, look, (k) => { look = k; }),
    help('Tap a scene to add it with this look. It stays linked: edits to the scene show up here.', 'grow'),
    button('Done', closeSheet)], async () => {
    const rows = await COMP.listScenes();
    return rows.length ? rows.map((r) => mediaCard(h('div', { class: 'scene-thumb' }, '3D'), r.name, async (c) => {
      c.classList.add('picked');
      const d = await COMP.load(r.id);
      if (!d || d.state !== 'ok') return toast('Couldn\'t open that 3D scene', true);
      await addToTimeline({ kind: 'scene', src: { scene: r.id, look }, label: d.name, dur: d.dur, nat: d.nat });
      toast('Added');
    })) : placeholder('This project has no 3D scenes yet. Make one first.');
  });
}

// a store event, or a first load, changed a scene: what the clips remember of it follows, and the preview redraws
function sceneChanged(id) {
  const d = COMP.sceneOf(id);
  let saved = false;
  for (const it of V.items) {
    if (it.kind !== 'scene' || it.src.scene !== id || !d || d.state !== 'ok') continue;
    const was = it.dur;
    if (Math.abs(was - d.dur) > 0.001) {   // a clip that played the whole scene keeps doing so; a trimmed one stays inside it
      it.dur = d.dur;
      if (it.out == null || Math.abs(it.out - was) < 0.001) it.out = d.dur; else it.out = Math.min(it.out, d.dur);
      it.in = Math.max(0, Math.min(it.in, d.dur - MIN_LEN));
      saved = true;
    }
    if (d.name && d.name !== it.label) { it.label = d.name; saved = true; }
    if (!it.nat || it.nat[0] !== d.nat[0] || it.nat[1] !== d.nat[1]) { it.nat = d.nat; saved = true; }
  }
  if (saved) HIST.hold(() => persistTimeline());   // (the scene's own change: no undo step here)
  renderTimeline(); if (saved) renderVideoPanel();
  requestDraw();
}

// ---- inspector panel ----
// It shows the primary pick (V.sel); an edit made in it goes to every picked clip it suits. Its fields change the primary,
// then fanOut copies what changed (a property, as its value at the playhead) onto the others. Fields that edit each clip
// themselves (times, anchor, Reset) call fanSync after, so nothing is copied twice.
const FAN_KEYS = ['fit', 'adjust', 'fadeIn', 'fadeOut', 'pan'];
const VISUAL_KEYS = new Set([...Object.keys(PROPS).filter((k) => k !== 'volume'), 'fit', 'adjust']);
const suits = (o, k) => (VISUAL_KEYS.has(k) ? isVisual(o) : k === 'volume' ? o.kind !== 'image' && o.kind !== 'scene' : true);
const fanState = (it) => Object.fromEntries([...FAN_KEYS.map((k) => [k, JSON.stringify(it[k] ?? null)]),
  ...Object.keys(PROPS).map((ch) => [`#${ch}`, JSON.stringify([it[ch] ?? null, it.chans?.[ch] ?? null])])]);
let fanBase = null;   // { id, s }: the primary as the inspector last saw it
function fanSync() { const it = selItem(); fanBase = it ? { id: it.id, s: fanState(it) } : null; }
function fanOut() {
  const it = selItem(), others = it ? TL.picked().filter((o) => o && o !== it) : [];
  if (!it || !others.length || fanBase?.id !== it.id) return fanSync();
  const now = fanState(it);
  for (const k of Object.keys(now)) {
    if (now[k] === fanBase.s[k]) continue;
    const ch = k[0] === '#' ? k.slice(1) : null;
    for (const o of others) {
      if (!suits(o, ch || k)) continue;
      if (ch) setProp(o, ch, prop(it, ch));
      else if (it[k] === undefined) delete o[k]; else o[k] = structuredClone(it[k]);
    }
  }
  fanBase = { id: it.id, s: now };
}
function panelInput() { fanOut(); renderTimeline(); syncMedia(); requestDraw(); }   // (while a slider is dragged)
function panelChange() { fanOut(); persistTimeline(); }   // (let go: saved, one undo step)
function panelChanged() { fanOut(); timelineChanged(); }   // (a change that redraws the panel too)
// the picked clips that suit `ok` (the primary first)
const pickedWhere = (ok = () => true) => TL.picked().filter((o) => o && ok(o));

// a clip's time as a number box (an open range: no bar); dragged like a slider it shows on the timeline as it goes
const timeBox = (label, get, set, { step = 0.04, min = 0, max = 600 } = {}) =>
  propNum(label, Number(get()).toFixed(2), (v) => { set(v); fanSync(); }, timelineChanged, { step, min, max, live: () => { renderTimeline(); syncMedia(); requestDraw(); } });

const clipLive = { onInput: () => panelInput(), onChange: () => panelChange() };
const clipRange = (label, get, set, opts) => rangeField(label, get, set, { ...opts, ...clipLive });
// an animatable clip property: ◀ ◆ ▶ beside its slider; the playhead moves to a key in the clip's time
const clipKeyed = (it, label, ch, opts) => K.field(it, label, ch, opts);

const SIZES = [['Match first clip', null], ['1280×720', [1280, 720]], ['1920×1080', [1920, 1080]], ['720×1280', [720, 1280]],
  ['1080×1920', [1080, 1920]], ['1024×1024', [1024, 1024]], ['832×480', [832, 480]], ['480×832', [480, 832]]];

// ---- a clip's Colour section: the same curves and sliders as an Image layer; Match works from its frames, sampled by the server ----
const CLIP_HIST = new Map();   // (a clip's part, sampled once)
async function clipHist(it) {
  if (it.kind === 'scene') return histOfPicture(mediaFor(it));   // (live from the 3D tab: there's no file; what shows now)
  const body = { source: it.src, start: it.kind === 'video' ? it.in || 0 : 0, len: it.kind === 'video' ? itLen(it) : 0 }, key = JSON.stringify(body);
  if (!CLIP_HIST.has(key)) CLIP_HIST.set(key, api('/api/video/histogram', { method: 'POST', body }).catch((e) => { CLIP_HIST.delete(key); throw e; }));
  return CLIP_HIST.get(key);
}
const clipLook = async (it) => A.histThrough(await clipHist(it), it.adjust);
const matchable = (it) => it.kind === 'video' || it.kind === 'image';
let colourOf = null;
function colourSection(it) {
  if (colourOf?.id === it.id) { colourOf.sync(); return colourOf.el; }
  const rest = () => V.items.filter((o) => o !== it && matchable(o));
  const matchAll = (strength) => async () => {
    const list = rest().filter((o) => o.src), b = busy('Matching the clips…');
    try {
      const want = await clipLook(it);
      for (const o of list) {
        const curves = A.matchCurves(A.histThrough(await clipHist(o), { ...o.adjust, curves: null }), want, { strength: strength() });
        if (curves) o.adjust = A.clean({ ...o.adjust, curves });
      }
      timelineChanged();
      toast(`${list.length} ${list.length === 1 ? 'clip' : 'clips'} matched to ${it.label}`);
    } catch (e) { toast(`Match failed: ${e.message}`, true); } finally { b.done(); }
  };
  colourOf = { id: it.id, ...adjustPanel({
    get: () => it.adjust || null, set: (a) => { if (a) it.adjust = a; else delete it.adjust; },
    onInput: () => { fanOut(); requestDraw(); }, onChange: () => { requestDraw(); panelChange(); }, hist: () => clipHist(it),
    others: () => rest().map((o) => [o.id, `${o.label} (${fmtT(o.at)})`]),
    otherHist: (id) => clipLook(V.items.find((o) => o.id === id)),
    extra: (strength) => (it.kind !== 'scene' && rest().length > 1 ? button('Match every clip to this one', matchAll(strength), { cls: 'small', title: 'This clip stays as it is; each other video and picture gets curves to look like it' }) : null) }) };
  return colourOf.el;
}

// a scene clip: which look it is drawn in, and where it comes from
function sceneFields(it) {
  const d = COMP.sceneOf(it.src.scene);
  return [
    field('Look', seg(COMP_LOOKS, it.src.look || 'color', (k) => {
      for (const o of pickedWhere((x) => x.kind === 'scene')) o.src = { ...o.src, look: k };
      timelineChanged();
    })),
    d?.state === 'missing' ? note('This 3D scene was deleted. The clip stays; pick another scene or delete it.', 'err')
      : help(`Live from the 3D scene “${d?.name || it.label}”: changes there show here and in every video edit using it. Exports render it at the export size.`),
  ];
}

// framing: the same numbers the handles on the preview change (and that follow them while dragging)
function xformFields(it) {
  const pct = pctFmt;
  const anchorEnd = () => { syncInspector(); persistTimeline(); };   // moving the anchor re-pins position, so show that too
  // the anchor of each picked picture (its own picture stays put); then nothing is left for fanOut to copy
  const anchorAll = (ax, ay) => { for (const o of pickedWhere(isVisual)) setAnchor(o, ax ?? o.anchor?.x ?? 0.5, ay ?? o.anchor?.y ?? 0.5); fanSync(); };
  return [
    field('Framing', seg([['fit', 'Fit'], ['fill', 'Fill']], it.fit || 'fit', (k) => { it.fit = k; panelChanged(); })),
    clipKeyed(it, 'Scale', 'scale', { min: 0.1, max: 3, step: 0.01, fmt: pct }),
    clipKeyed(it, 'Rotation', 'rotation', { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` }),
    clipKeyed(it, 'Position X', 'x', { min: -1, max: 1, step: 0.005, fmt: pct }),
    clipKeyed(it, 'Position Y', 'y', { min: -1, max: 1, step: 0.005, fmt: pct }),
    clipRange('Anchor X', () => it.anchor?.x ?? 0.5, (v) => anchorAll(v, null), { min: -0.5, max: 1.5, step: 0.01, fmt: pct, onChange: anchorEnd }),
    clipRange('Anchor Y', () => it.anchor?.y ?? 0.5, (v) => anchorAll(null, v), { min: -0.5, max: 1.5, step: 0.01, fmt: pct, onChange: anchorEnd }),
  ];
}

function renderVideoPanel() {
  if (!VD.body) return;   // (not mounted yet)
  const it = selItem(), n = TL.picked().length;
  const pct = pctFmt;
  fanSync();
  const clip = it ? (() => {
    const len = itLen(it), tr = trackOf(it);
    // several picked: Starts at moves them all by the same amount; a length, In or Out goes to each that has one
    const fields = [timeBox('Starts at (s)', () => it.at, (v) => { const d = Math.max(0, v) - it.at; for (const o of pickedWhere()) o.at = Math.max(0, o.at + d); })];
    const still = (o) => o.kind === 'image', moving = (o) => !still(o);
    if (it.kind === 'image') fields.push(timeBox('Duration (s)', () => len, (v) => { for (const o of pickedWhere(still)) o.out = Math.max(MIN_LEN, v); }, { min: MIN_LEN, max: 60 }));
    else fields.push(
      timeBox('In (s)', () => it.in, (v) => { for (const o of pickedWhere(moving)) o.in = Math.max(0, Math.min(v, (o.out ?? o.dur) - MIN_LEN)); }, { max: it.dur || undefined }),
      timeBox('Out (s)', () => it.out ?? it.dur, (v) => { for (const o of pickedWhere(moving)) o.out = Math.max(o.in + MIN_LEN, o.dur ? Math.min(v, o.dur) : v); }, { max: it.dur || undefined }));
    return section(n > 1 ? `${n} clips` : it.label, null,
      hint(`${n > 1 ? `${it.label}: ` : ''}${it.kind} on ${tr ? trackName(tr) : '?'} · ${fmtT(len)}${it.dur ? ` of ${fmtT(it.dur)}` : ''}`, 'section-sub'),
      h('div', { class: 'grid-2' }, fields),
      isVisual(it) ? [VD.xform = h('div', { class: 'vid-xform' }, xformFields(it)),
        clipKeyed(it, 'Opacity', 'opacity', { min: 0, max: 1, step: 0.01, fmt: pct })] : null,
      it.kind === 'scene' ? sceneFields(it) : null,
      it.kind === 'video' && canKey(it.fx?.orig || it) ? fxFields(it) : null,
      clipSoundFields(it, len, { level: it.kind !== 'image' && it.kind !== 'scene', levelNote: (v) => (v > 1 ? ' (preview plays at 100%)' : ''),
        keyed: (label, ch, o) => clipKeyed(it, label, ch, o), ...clipLive }));
  })() : null;
  // the clip's actions, as the Image tab's icon row
  const clipTools = it ? (() => {
    const tool = (label, ic, onclick, title = label) => h('button', { type: 'button', class: 'icon-btn tool-quick-btn', title, onclick }, icon(ic), h('span', {}, label));
    const can = it.kind === 'video' && canKey(it);
    return section('Clip tools', null, h('div', { class: 'tool-quick' },
      tool('Cross-fade', 'wave', () => TL.crossfadePrev(it), 'Cross-fade with the previous clip'),
      can && !onTable() ? tool('VFX', 'sparkle', async () => (await import('./vfx.js')).sendToVfx(it.src, { label: it.label, trim: { start: it.in, len: (it.out ?? it.dur) - it.in } }), 'Open this clip in the VFX tab') : null,
      it.kind === 'video' ? tool('Sound', 'sound', () => (onTable()
        ? soundFrameFrom(it.src, { trim: { start: it.in || 0, len: itLen(it) }, name: `${it.label}-sound`, near: liveFrame() })
        : soundToSoundTab(it.src, { trim: { start: it.in || 0, len: itLen(it) }, name: `${it.label}-sound` })),
      onTable() ? 'This clip\'s sound (the part on the timeline) as a new sound frame' : 'This clip\'s sound (the part on the timeline) on the Sound tab\'s timeline') : null,
      can ? tool('Key', 'contrast', () => openKey(it), 'Colour key: cut out a green screen, or use a matte, so lower tracks show through') : null,
      it.kind === 'video' && canTrack(it.src) ? tool('Track', 'target', () => trackClip(it), 'Follow the picture\'s movement and make a 3D camera from it. With a range set, only the part of this clip inside it') : null,
      isVisual(it) ? tool('Reset', 'reset', () => {
        for (const o of pickedWhere(isVisual)) {
          Object.assign(o, { x: 0, y: 0, scale: 1, opacity: 1, fit: 'fit' }); delete o.rotation; delete o.anchor;
          for (const ch of ['x', 'y', 'scale', 'rotation', 'opacity']) delete o.chans?.[ch];
        }
        timelineChanged();
      }, n > 1 ? 'Reset the framing of every picked picture' : 'Reset the framing') : null));
  })() : null;
  const maps = it && (it.kind === 'video' ? canKey(it) : it.kind === 'image' && (it.src?.input || it.src?.generation != null))
    ? mapsSection(it, { lengthOf: itLen, range: () => WA.stored(), render: renderVideoPanel, land: landMap }) : null;
  const colour = it && isVisual(it) ? colourSection(it) : null;

  const sizeSel = sizeSelect(SIZES, V.size, (s) => { V.size = s; timelineChanged(); });
  const fpsSel = h('select', {}, [[0, 'Match first clip'], [16, '16'], [24, '24'], [25, '25'], [30, '30'], [60, '60']].map(([v, label]) =>
    h('option', { value: v, selected: V.fps === v }, label)));
  fpsSel.addEventListener('change', () => { V.fps = Number(fpsSel.value); timelineChanged(); });
  const exportBtn = onTable()
    ? button('Render', () => renderOp(exportBtn), { cls: 'primary', title: 'The timeline as one clip, in a new video frame beside this one' })
    : button('Export video', () => exportVideo(exportBtn), { cls: 'primary' });

  const clearAll = () => {
    if (!confirm('Remove every clip from the timeline?')) return;
    V.items = []; V.sel = null; V.multi = []; vidSeek(0); timelineChanged();
  };
  // the panel order, app-wide: add (and Clear all), the selected thing, how it's made, then what it makes
  VD.body.replaceChildren(h('div', { class: 'panel-body' },
    h('div', { class: 'row wrap panel-top' },
      button('+ Add', addSources, { cls: 'small primary', title: 'Pictures, clips and sounds: from this table, the project or anywhere; tick several to lay them in order' }),
      button('+ 3D scene…', addScene, { title: 'A 3D scene as a live clip' }),
      V.items.length ? button('Clear all', clearAll, { cls: 'small ghost' }) : null),
    clipTools, maps, clip, colour, !clip && (V.items.length
      ? help('Tap a clip to edit it; Shift or Ctrl picks several, and an edit here goes to all of them. Drag clips to move them (also onto other tracks), drag their ends to trim, and overlap two clips on a track to cross-fade. Higher video tracks draw on top. The handles show on the preview while the playhead is over the clip.')
      : help('Add pictures, clips or sound. They line up on V1 / A1; drag them onto V2 to layer them over V1.')),
    section('Sequence', null,
      hint(`${seqSize().join('×')} · ${V.fps || 'auto'} fps · ${fmtT(seqEnd())}`, 'section-sub'),
      h('div', { class: 'grid-2' }, field('Frame size', sizeSel), field('Frame rate', fpsSel))),
    V.items.length ? section('Export', null, help(onTable() ? 'Render makes the timeline one clip, in a new video frame beside this one.' : 'The export lands in History.'),
      h('div', { class: 'row wrap' }, exportBtn, WA.onlyToggle(),
        button('Open in EffectCraft', (ev) => craftVideo(ev.currentTarget), { cls: 'small', title: 'Each clip as a layer in a comp, to keep editing on the computer' }),
        button('Craft documents…', () => openCraftSheet(), { cls: 'small' }))) : null));
}

// ---- effects: a stack of LTX / keying steps run on the clip's range and baked into a new clip ----
// it.fx = { steps: [{ op, ... }], orig: the clip's own source while a baked result stands in, busy, error }.
// Rendering always starts from the original, so steps can be changed and rendered again; Remove puts it back.
const FX_LABEL = Object.fromEntries(CLIP_FX.map(([k, l]) => [k, l]));
const LTX_OPS = new Set(['restyle', 'cleanplate', 'replace', 'cutout']);
function fxStepFields(it, st, i) {
  const save = () => persistTimeline();
  const ta = (key, ph) => textArea(() => st[key], (v) => { st[key] = v; save(); }, { rows: 2, placeholder: ph, label: ph });
  const move = (d) => { const a = it.fx.steps, j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; timelineChanged(); };
  const loras = restyleLoras();
  return h('div', { class: 'fx-step' },
    h('div', { class: 'row' }, h('b', { class: 'grow' }, `${i + 1}. ${FX_LABEL[st.op] || st.op}`),
      iconBtn('Earlier', '↑', () => move(-1)), iconBtn('Later', '↓', () => move(1)),
      iconBtn('Remove effect', '✕', () => { it.fx.steps.splice(i, 1); timelineChanged(); })),
    st.op === 'restyle' ? [
      loraChoice(loras, st.lora || loras[0], (name) => { st.lora = name; save(); },
        { get: () => st.strength ?? 1, set: (v) => { st.strength = v; } }, { onStrength: save }),
      ta('prompt', 'Describe the result (for colourise, name the colours)')] : null,
    st.op === 'cleanplate' ? ta('prompt', 'Optional: what the empty scene looks like') : null,
    st.op === 'replace' ? [h('input', { type: 'text', value: st.target || '', placeholder: 'What to replace, e.g. "the woman"',
      oninput: (e) => { st.target = e.target.value; save(); } }), ta('prompt', 'Describe the shot with the new thing in it')] : null,
    st.op === 'colorkey' ? [colorField('Key colour', () => st.color || '#00ff00', (c) => { st.color = c; save(); }),
      ...keyRangeFields(Object.assign(st, { ...KEY_DEFAULT, ...st }), save),   // (a step saved before these keeps the defaults)
      toggle('Invert (keep what\'s black)', !!st.invert, (on) => { st.invert = on; save(); })] : null,
    st.op === 'upscale' ? field('Size', seg([['FullHD', 'Full HD'], ['4K', '4K']], st.outsize || 'FullHD', (v) => { st.outsize = v; save(); })) : null,
    LTX_OPS.has(st.op) ? field('Resolution', seg([[544, '544p'], [704, '704p'], [1088, '1088p']], st.res || 704, (v) => { st.res = Number(v); save(); })) : null);
}

function fxFields(it) {
  it.fx ||= { steps: [] };
  const fx = it.fx;
  const add = h('select', { onchange: (e) => {
    if (!e.target.value) return;
    fx.steps.push({ op: e.target.value, ...(e.target.value === 'restyle' && { lora: restyleLoras()[0], strength: 1 }) });
    timelineChanged();
  } }, h('option', { value: '' }, '+ Add effect…'), CLIP_FX.map(([k, l, tip]) => h('option', { value: k, title: tip }, l)));
  const len = fx.orig ? fx.orig.out - fx.orig.in : itLen(it);
  return section('Effects', null,
    help('LTX effects run on the GPU, one after another, over this clip\'s range (up to 10 s), and the result takes the clip\'s place. While one runs, the clip on the timeline and this panel show a spinner, the step and the time so far; you can keep editing, and the clip swaps when it is done. Change them and render again any time: it always starts from the original. Remove puts the original back.'),
    fx.steps.map((st, i) => fxStepFields(it, st, i)),
    add,
    fx.error ? note(fx.error, 'err') : null,
    fx.busy ? h('div', { class: 'fx-busy', role: 'status' }, h('span', { class: 'spinner' }),
      h('div', { class: 'grow' }, h('b', {}, `Rendering ${fx.busy}`), h('div', { class: 'hint fx-text' }, fxStatus(it, true))),
      h('div', { class: 'fx-bar' })) : fx.orig ? hint('Showing the rendered result.') : null,
    runBar(
      button(fx.busy ? 'Rendering…' : fx.orig ? 'Render again' : 'Render effects', () => bakeFx(it.id), { cls: 'primary' + (fx.busy ? ' working' : ''), disabled: !fx.steps.length || !!fx.busy }),
      fx.orig ? button('Remove effects', () => unbakeFx(it)) : null,
      len > 10 ? hint('Only the first 10 s get the effects.') : null));
}

const clipBase = (it) => it.fx?.orig || { src: it.src, url: it.url, label: it.label, in: it.in, out: it.out ?? it.dur, dur: it.dur };
function unbakeFx(it) {
  const o = it.fx.orig;
  if (!o) return;
  Object.assign(it, { src: o.src, url: o.url, label: o.label, in: o.in, out: o.out, dur: o.dur });
  it.fx.orig = null;
  timelineChanged();
  toast('Back to the original clip');
}

// What an effect render shows while it runs: the step, the time so far and ComfyUI's step count (all clips share one: a run is one at a time)
const FXRUN = { t0: 0, prog: '', timer: null, n: 0 };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function fxStatus(it, long = false) {
  const t = FXRUN.t0 ? mmss((Date.now() - FXRUN.t0) / 1000) : '';
  return [t && `${t} so far`, FXRUN.prog && `sampling ${FXRUN.prog}`, long && 'on the GPU in ComfyUI'].filter(Boolean).join(' · ') || 'queued…';
}
function fxTick() {
  for (const it of V.items) {
    if (!it.fx?.busy) continue;
    inTimeline(`.tl-clip[data-id="${it.id}"] .fx-text`).forEach((n) => { n.textContent = fxStatus(it); });
  }
  (VD.panel?.querySelectorAll('.fx-busy .fx-text') || []).forEach((n) => { n.textContent = fxStatus(null, true); });
}
function fxStart() {
  if (!FXRUN.n++) { FXRUN.t0 = Date.now(); FXRUN.prog = ''; FXRUN.timer = setInterval(fxTick, 1000); }
}
function fxStop() {
  if (!--FXRUN.n) { clearInterval(FXRUN.timer); FXRUN.timer = null; FXRUN.t0 = 0; FXRUN.prog = ''; }
}
onServer('deck_progress', ({ data }) => { if (FXRUN.n) { FXRUN.prog = `${data.value}/${data.max}`; fxTick(); } });

async function bakeFx(id) {
  let it = V.items.find((x) => x.id === id);
  const tab = tabs?.active?.id;
  const base = clipBase(it), steps = it.fx.steps.map((st) => ({ ...st }));
  let source = { ...base.src, trim: { start: base.in, len: base.out - base.in } }, secs = base.out - base.in, r = null;
  it.fx.error = null;
  HIST.hold(() => HIST.mark());
  fxStart();
  toast(`Rendering ${steps.map((st) => FX_LABEL[st.op]).join(' + ')}: the clip shows a spinner until it is done`);
  try {
    for (const [i, st] of steps.entries()) {
      it.fx.busy = `${i + 1}/${steps.length} ${FX_LABEL[st.op]}`; FXRUN.prog = ''; HIST.hold(() => HIST.mark()); renderVideoPanel(); renderTimeline();
      r = await runClipStep(st, source, secs);
      source = { generation: r.generation, index: r.index };
      secs = r.dur || secs;
      it = V.items.find((x) => x.id === id) || it;
    }
  } catch (e) {
    const at = it.fx.busy;
    fxStop(); it.fx.busy = null; it.fx.error = `${at || ''} ${e.message}`.trim();
    HIST.hold(() => persistTimeline()); renderVideoPanel(); renderTimeline();
    return toast(`Effects stopped: ${e.message}`, true);
  }
  fxStop(); it.fx.busy = null;
  if (tabs?.active?.id !== tab || !V.items.includes(it)) return toast(`Effects done as #${r.generation} (the clip's edit was closed: find it in History)`);
  it.fx.orig = base;
  Object.assign(it, { src: { generation: r.generation, index: r.index }, url: r.url, label: `${base.label} ✨`, in: 0,
    out: Math.min(r.dur || secs, base.out - base.in), dur: r.dur || secs });
  timelineChanged();
  toast('Effects rendered: the clip now plays the result');
}

// A control map (video-maps.js) lands over its clip: the next track up with room, or a new one, in step and framed the same
async function landMap(it, span, generation, media) {
  if (!V.items.includes(it)) return toast(`Map done as #${generation} (its clip is gone: find it in History)`);
  const lane = laneAbove(V.tracks, V.items, it, span.at, span.len, itLen) || addTrack('video');
  const made = await addToTimeline(media, { track: lane, at: span.at });
  if (media.kind === 'video') made.out = Math.min(media.dur, span.len);
  for (const k of ['x', 'y', 'scale', 'fit', 'rotation', 'anchor']) if (it[k] !== undefined) made[k] = it[k];
  made.volume = 0;
  timelineChanged();
  toast('Map added over the clip');
}

// ---- keying: a copy of the clip with alpha (server: /api/video/key), swapped in where the clip is ----
const canKey = (it) => it.src && (it.src.generation != null || it.src.media);

function openKey(it) {
  const k = { mode: 'color', color: '#00ff00', ...KEY_DEFAULT, matte: null };
  const frame = h('canvas', { class: 'key-frame' });
  const swatch = colorField('Key colour', () => k.color, (c) => { k.color = c; });
  const m = V.els.get(it.id)?.el;
  if (m?.videoWidth) {   // the clip as it is under the playhead: tap it to take the screen colour
    frame.width = 320; frame.height = Math.round((320 * m.videoHeight) / m.videoWidth);
    frame.getContext('2d').drawImage(m, 0, 0, frame.width, frame.height);
    frame.addEventListener('pointerdown', (e) => {
      const r = frame.getBoundingClientRect();
      const [R, G, B] = frame.getContext('2d').getImageData(Math.floor(((e.clientX - r.left) / r.width) * frame.width),
        Math.floor(((e.clientY - r.top) / r.height) * frame.height), 1, 1).data;
      k.color = swatch.input.value = '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('');
    });
  }
  const matteLabel = h('span', { class: 'muted' }, 'none');
  const pickMatte = () => pickerSheet('Pick a matte', [help('White keeps the picture, black lets lower tracks show. Cut out (Alpha Gen) and Mask (SAM3) runs make these.', 'grow'), button('Cancel', () => openKey(it))],
    async () => (await projectOutputs(['video'])).map(({ g, o, i }) => mediaCard(cardMedia(o), genLabel(g), () => {
      k.matte = { generation: g.id, index: i }; k.matteLabel = genLabel(g); body(); openSheet(...sheet());
    }, { badge: '▶' })));
  const colorFields = () => [
    frame.width ? field('Tap the screen colour', frame) : null,
    swatch,
    ...keyRangeFields(k),
  ];
  const matteFields = () => [field('Matte clip', h('div', { class: 'row' }, matteLabel, button('Pick…', pickMatte, { cls: 'small' })))];
  const fieldsBox = h('div');
  const body = () => {
    matteLabel.textContent = k.matteLabel || 'none';
    fieldsBox.replaceChildren(...(k.mode === 'color' ? colorFields() : matteFields()).filter(Boolean));
  };
  const go = button('Key clip', async () => {
    if (k.mode === 'matte' && !k.matte) return toast('Pick a matte clip first', true);
    go.disabled = true;
    try {
      const g = await api('/api/video/key', { method: 'POST', busy: 'Keying…', body: { source: it.src, mode: k.mode, matte: k.matte, color: k.color,
        similarity: k.similarity, blend: k.blend, spill: k.spill, invert: k.invert, project_id: S.project }, timeout: 900000 });
      const o = g.outputs[0];
      Object.assign(it, { src: { generation: g.id, index: 0 }, url: o.url, label: `${it.label} (keyed)` });
      closeSheet(); timelineChanged();
      toast('Keyed: lower tracks show through');
    } catch (e) { toast('Keying failed: ' + e.message, true); go.disabled = false; }
  }, { cls: 'primary' });
  const sheet = () => [h('h3', {}, 'Key ' + it.label),
    help('Makes a copy of the clip with see-through parts and puts it in this clip\'s place (sound kept). Put the clip on a track above the background.'),
    seg([['color', 'Colour key'], ['matte', 'Matte']], k.mode, (v) => { k.mode = v; body(); }),
    fieldsBox,
    toggle('Invert (keep what\'s black)', k.invert, (on) => { k.invert = on; }),
    actions(go, button('Cancel', closeSheet))];
  body();
  openSheet(...sheet());
}

// The timeline as /api/video/render (and /api/craft/video) take it. 3D scene clips are drawn here first, at the
// export size and rate, and go to the server as ordinary clips.
async function timelineBody(btn) {
  G.settling?.w.finish();
  await tabs?.flush();   // the saved edit is what this render came from
  const range = WA.exportRange();   // Range only: the clips cut to the work area, starting at 0
  const items = cutItems(V.items, range, { len: itLen, still: (it) => it.kind === 'image' });
  if (!items.length) throw new Error('Nothing is in the work area');
  const scenes = items.filter((it) => it.kind === 'scene'), made = new Map();
  const [W, H] = seqSize();
  for (const [i, it] of scenes.entries()) {
    made.set(it, await COMP.exportClip(it, { W, H, fps: V.fps || 24, len: itLen(it),
      progress: (k, n) => { btn.textContent = `3D scene ${i + 1}/${scenes.length} · frame ${k}/${n}`; } }));
  }
  return {
    project_id: S.project, tab: tabs?.active && { id: tabs.active.id, name: tabs.active.name },
    width: scenes.length ? W : V.size && V.size[0], height: scenes.length ? H : V.size && V.size[1], fps: V.fps || null,
    tracks: exportTracks(V.tracks).map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),   // (solo as hidden / muted)
    items: items.map((it) => ({ track: it.track, at: it.at, name: it.label, ...(made.has(it)   // (a scene's clip is already cut to what's used)
      ? { src: { clip: made.get(it).clip }, scene: made.get(it).scene, in: 0, out: itLen(it) } : { src: it.src, in: it.in, out: it.out ?? it.dur }),
      x: it.x, y: it.y, scale: it.scale, fit: it.fit, rotation: it.rotation || 0, anchor_x: it.anchor?.x, anchor_y: it.anchor?.y,
      opacity: it.opacity, volume: it.volume, chans: it.chans || null,
      grade: A.exportGrade(it.adjust), fade_in: it.fadeIn, fade_out: it.fadeOut })) };
}

async function exportVideo(btn) {
  vidPause();
  const label = btn.textContent;   // (3D scene clips show their render progress on it)
  btn.disabled = true;
  try {
    const body = await timelineBody(btn);
    btn.textContent = label;
    const g = await api('/api/video/render', { method: 'POST', body, busy: 'Rendering…' });
    S.history.set(g.id, g);
    openGeneration(g.id);
  } catch (e) { toast('Export failed: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// On the table: Render is the frame's Render op (edit-run.js: a new video frame beside it); renderLive is its run
async function renderOp(btn) {
  vidPause();
  btn.disabled = true;
  try {
    const [{ runOnFrames }, { opById }] = await Promise.all([import('./edit-run.js'), import('./edit-rules.js')]);
    await runOnFrames(opById('video', 'render'), [liveFrame()], {}, { target: 'frame' });
  } catch (e) { toast('Render failed: ' + e.message, true); }
  finally { btn.disabled = false; }
}
export async function renderLive() {
  vidPause();
  const btn = { textContent: '' };   // (3D scene clips report their progress on it)
  return api('/api/video/render', { method: 'POST', body: await timelineBody(btn), busy: 'Rendering…' });
}

// The timeline as an EffectCraft comp: a layer per clip, stacked by track, with its timing, framing and fades
async function craftVideo(btn) {
  vidPause();
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const body = await timelineBody(btn);
    btn.textContent = label;
    await sendToCraft('video', { ...body, title: tabs?.active?.name || 'Video edit' }, btn, { frame: onTable() ? liveFrame() : null });
  } catch (e) { toast('Couldn\'t send it: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// Full screen for the preview and its controls: the shared full screen (layout.js fullScreen: the panel pulls out)
const vidStage = () => VD.stage;
let vidMax = null;
const vidFullscreen = () => !!vidMax?.on();
const exitVideoFullscreen = () => vidMax?.exit();
const toggleVideoFullscreen = () => vidMax?.toggle();

// The frame under the playhead at the sequence's full size: save it as an input or download it
async function snapshotFrame() {
  if (!V.items.length) return toast('Add something to the timeline first', true);
  vidPause();
  if (vidFullscreen()) exitVideoFullscreen();   // the popup lives outside the full-screen stage
  const cv = VD.canvas, blob = await videoStill();
  if (!blob) return toast('Could not grab the frame', true);
  if (snapshotFrame.url) URL.revokeObjectURL(snapshotFrame.url);   // the previous frame's
  const url = snapshotFrame.url = URL.createObjectURL(blob), name = `frame_${tc(V.t).replace(/:/g, '-')}.png`;
  openSheet(h('h3', {}, `Frame at ${tc(V.t)}`),
    h('div', { class: 'media-big' }, h('img', { src: url, alt: '' })),
    hint(`${cv.width}×${cv.height}`, 'sheet-hint'),
    actions(
      onTable() ? button('New image frame', async () => {   // (the Grab frame op's landing: a frame of the picture's size beside this one)
        try {
          const r = await uploadImage(blob, { mp: 0, source: 'snapshot', filename: name });
          const at = liveFrame(), f = await (await import('./edit-ops.js')).frameBeside(at, { input: r.name, width: r.width, height: r.height }, { label: `Frame ${tc(V.t)} · ${at?.label || 'video'}` });
          if (!f) throw new Error('It couldn\'t go on the table: it is in your pictures');
          dispatchEvent(new CustomEvent('edit:grabbed', { detail: { frame: at, input: r.name, into: f } }));
          closeSheet(); toast(`${f.label} is beside this frame`);
        } catch (e) { toast('Save failed: ' + e.message, true); }
      }, { cls: 'small primary' }) : button('Save as input', async () => {
        try {
          const r = await uploadImage(blob, { mp: 0, source: 'snapshot', filename: name, board: 'Saved frame' });
          (await import('./generate.js')).useInGenerate(r.name, `Saved ${r.width}×${r.height}`);
        } catch (e) { toast('Save failed: ' + e.message, true); }
      }, { cls: 'small primary' }),
      linkBtn('Download', url, { download: name }),
      button('Close', closeSheet, { cls: 'small ghost' })));
}

// Where the sequence's picture is on screen (the viewer's canvas, fitted, zoomed and panned): { left, top, width,
// height } in client pixels, or null when not mounted. frame-overlay.js draws marks over it.
export function frameRect() {
  const cv = VD.canvas;
  if (!cv?.isConnected) return null;
  const r = cv.getBoundingClientRect(), [W, H] = seqSize(), k = Math.min(r.width / W, r.height / H);
  if (!(k > 0)) return null;
  return { left: r.left + (r.width - W * k) / 2, top: r.top + (r.height - H * k) / 2, width: W * k, height: H * k };
}
// the colour of the picture under the playhead at (fx, fy), fractions of the frame: '#rrggbb', or null
export function framePixel(fx, fy) {
  const cv = VD.canvas;
  if (!cv?.width) return null;
  try {
    const d = cv.getContext('2d').getImageData(clamp(Math.floor(fx * cv.width), 0, cv.width - 1), clamp(Math.floor(fy * cv.height), 0, cv.height - 1), 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
// the playhead (seconds on the timeline)
export const videoTime = () => V.t;

// The frame under the playhead at the sequence size, as a PNG Blob (a frame's still on a table); null with no clips
export async function videoStill() {
  if (!V.items.length || !VD.canvas) return null;
  drawFrame();
  return new Promise((res) => VD.canvas.toBlob(res, 'image/png'));
}

// What a tab holds: the edit itself. (Zoom and Loop are this device's, not the edit's.)
const editAdapter = {
  empty: emptyVideo,   // (markers: none until one is added; migrate and load give [])
  migrate: migrateEdit,
  dump: () => ({ tracks: V.tracks, items: V.items, size: V.size, fps: V.fps, ...(V.range && { range: V.range }), ...(V.markers?.length && { markers: V.markers }) }),
  load(p, doc) {
    HIST.hold(() => {   // (what loading writes is no edit)
      vidPause();
      for (const it of p.items || []) if (it.fx?.busy && !FXRUN.n) it.fx.busy = null;   // (a render the page was closed on)
      Object.assign(V, { tracks: p.tracks, items: p.items, size: p.size, fps: p.fps, range: p.range || null, markers: p.markers || [],
        sel: null, multi: [], t: 0, master: null, holdSince: 0 });
      WA.only = true; WA.sync();
      renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); COMP.refresh();
    });
    // another edit: its own history; the same one saved elsewhere: the steps stay (they find clips by id)
    const id = doc?.id ?? null;
    if (id !== histDoc) { histDoc = id; HIST.clear(); } else HIST.hold(() => HIST.mark());
    syncUndo();
  },
};

// ---- drag and drop (desktop): pictures, videos and sound dragged from a file window onto the Video tab, and things
// dragged from the Shelf (SOURCE_TYPE, shelf.js) ----
// Over a lane the clip goes where it is dropped (snapped to the frame and to the clips' and the playhead's edges);
// anywhere else on the tab it goes after the last clip, as + Add does.
const SOURCE_TYPE = 'application/x-deck-source';   // (shelf.js's and table.js's payload: { generation, index } | { input } | { media })
const dropOnFiles = (e) => draggingPicture(e.dataTransfer);
const dragSource = (e) => [...(e.dataTransfer?.types || [])].includes(SOURCE_TYPE);
// kind null: any lane (a Shelf drag doesn't say what it is until it lands). lane: the one under the drop (read before the mark goes)
function dropSpot(e, kind, lane = e.target.closest?.('.tl-lane')) {
  const tr = lane && VD.timeline?.contains(lane) && V.tracks.find((t) => t.id === lane.dataset.track);
  if (!tr || (kind && tr.kind !== (kind === 'audio' ? 'audio' : 'video'))) return null;
  const raw = Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / V.pps);
  const edges = [0, V.t, ...V.items.flatMap((it) => [it.at, it.at + itLen(it)])];
  const near = edges.find((x) => Math.abs(x - raw) * V.pps < 8);
  return { lane, track: tr.id, at: near ?? Math.round(raw * fpsNow()) / fpsNow() };
}
// sources: take Shelf drags here too (not on a table frame's own mount: the table hands those to frame-video.js)
function wireDrop(tab, signal, { sources = true } = {}) {   // (the listeners go when the mount's signal aborts)
  let mark = null, depth = 0;
  const wants = (e) => dropOnFiles(e) || (sources && dragSource(e));
  const clear = () => { depth = 0; tab.classList.remove('file-drop'); mark?.remove(); mark = null; };
  const kindOf = (e) => {   // what is being dragged (the browser only says Files until the drop: a lane takes any kind here)
    if (dragSource(e)) return null;
    const it = [...(e.dataTransfer?.items || [])].find((i) => i.kind === 'file');
    return it?.type.startsWith('audio/') ? 'audio' : 'video';
  };
  tab.addEventListener('dragenter', (e) => { if (wants(e)) { depth++; tab.classList.add('file-drop'); } }, { signal });
  tab.addEventListener('dragleave', (e) => { if (wants(e) && --depth <= 0) clear(); }, { signal });
  tab.addEventListener('dragover', (e) => {
    if (!wants(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const spot = dropSpot(e, kindOf(e));
    if (!spot) { mark?.remove(); mark = null; return; }
    mark ||= h('div', { class: 'tl-dropmark' });
    if (mark.parentElement !== spot.lane) spot.lane.append(mark);
    mark.style.left = `${spot.at * V.pps}px`;
  }, { signal });
  tab.addEventListener('drop', async (e) => {
    if (!wants(e)) return;
    e.preventDefault();
    if (dragSource(e)) {   // from the Shelf: each thing at the spot, one after another
      const lane = e.target.closest?.('.tl-lane');
      let list;
      try { list = [JSON.parse(e.dataTransfer.getData(SOURCE_TYPE))].flat(); } catch { clear(); return; }
      clear();
      let at = null, n = 0;
      for (const src of list) {
        try {
          const m = await mediaOfSource(src, { kind: src?.kind, label: src?.label, trim: src?.trim });
          if (!m) { toast('That can\'t go on a timeline', true); continue; }
          const spot = dropSpot(e, m.kind, lane);
          const it = await landSource(m, spot && { track: spot.track, at: at ?? spot.at });
          if (spot && it.track === spot.track) at = it.at + itLen(it);
          n++;
        } catch (err) { toast(`Couldn't add it: ${err.message}`, true); }
      }
      if (n) toast(n > 1 ? `Added ${n} things` : 'Added');
      return;
    }
    const got = droppedFiles(e.dataTransfer);
    let dropped;
    try { dropped = await got; } catch (err) { clear(); return toast(err.message, true); }
    const files = dropped.map((f) => [f, dropKind(f)]);
    const bad = files.filter(([, k]) => !k).map(([f]) => f.name);
    const spot0 = files.find(([, k]) => k) && dropSpot(e, files.find(([, k]) => k)[1]);
    clear();
    if (bad.length) toast(`Not a picture, video or sound: ${bad.join(', ')}`, true);
    let at = spot0?.at;
    for (const [f, kind] of files) {
      if (!kind) continue;
      toast(`Uploading ${f.name}…`);
      try {
        const m = await uploadMedia(f);
        const it = await addToTimeline({ kind: m.kind, src: { media: m.name }, url: m.url, label: m.label, thumb: m.kind === 'image' ? m.url : null },
          spot0 && { track: spot0.track, at });
        if (at != null && it.track === spot0.track) at = it.at + itLen(it);   // (several files go one after another)
      } catch (err) { return toast(`Upload failed: ${err.message}`, true); }
    }
    if (files.some(([, k]) => k)) toast(files.length > 1 ? `Added ${files.length} files` : 'Added');
  }, { signal });
}

// The page's Video tab: mounts the engine into its own section (app.js calls this once at start)
export function wireVideoTransport() {
  mountVideo({ host: $('#tab-video'), canvas: $('#vidCanvas'), empty: $('#vidEmpty'), transport: $('#tab-video .stage > .transport'),
    panel: $('#videoPanel'), body: h('div', { id: 'vidBody' }), tlTools: $('#tlTools'), timeline: $('#timeline') });
  $('#vidCanvas').classList.add('vid-canvas');
}

// Mount the engine into a host: { host, canvas, empty, transport (a slot the bar takes), panel, tlTools, timeline } and optionally stage
// (host's .stage), viewer (the canvas's parent), body (the pane's content box) and active (is it on show). The tabs,
// the transport and the keys are made on the first mount; mounting the same host again does nothing.
let mounted = null;   // the current mount's AbortController: its listeners go when another host mounts
const FULLS = new WeakMap();   // host -> its full screen (layout.js adds the pull tab to the stage once per host)
export function mountVideo({ host, stage = host.querySelector('.stage'), canvas, viewer = canvas.parentElement, empty, transport: bar,
  panel, tlTools, timeline: tl, body = h('div'), active = () => host.classList.contains('active'), fullscreen = true }) {
  if (VD.host === host) return;
  mounted?.abort();
  mounted = new AbortController();
  Object.assign(VD, { host, stage, viewer, canvas, empty, panel, body, tlTools, timeline: tl, xform: null, active });
  panel.replaceChildren(body);
  const again = !!tabs;
  if (!again) wireOnce();
  if (bar !== vtp.el) {
    if (vtp.el.isConnected) vtp.el.replaceWith(h('div', { class: 'transport' }));   // (a slot for the bar, should that host mount again)
    bar.replaceWith(vtp.el);
  }
  VD.transport = vtp.el;
  placeGizmo(viewer);
  if (vzoomed()) setView(VZ.z, VZ.tx, VZ.ty);   // (the zoom moves to the new canvas)
  wireDrop(host, mounted.signal, { sources: host.contains(tl) });
  if (!host.contains(tl)) wireDrop(tl, mounted.signal);   // (a table frame's timeline is in the drawer under the table)
  if (fullscreen && !FULLS.has(host)) FULLS.set(host, fullScreen(host, { onChange: () => requestDraw() }));
  vidMax = FULLS.get(host) || null;
  tlTools.replaceChildren(...timelineTools());
  TL.wire();   // (this host's timeline element; once per element)
  if (again) renderVideo();   // (the first mount draws once the tab loads)
}

// What every mount shares, made once: the tabs (on the page's Video section for now: tabs.js keeps one per kind),
// the transport bar, the handles, the timeline's own listeners and the keys
function wireOnce() {
  tabs = new TabSet({ kind: 'video-tabs', host: $('#tab-video'), scope: 'project', newName: (n) => `Edit ${n}`, adapter: editAdapter, seed: legacyTimeline,
    onSwitch: () => store.set('deck.video.seeded', true) });
  makeGizmo();
  COMP.wire({ ids: () => V.items.filter((i) => i.kind === 'scene').map((i) => i.src.scene), onChange: sceneChanged, visible: () => VD.active() });
  VD.load = h('span', { class: 'hint' });
  vtp = transport({ playing: () => V.playing, play: vidPlay, pause: vidPause, seek: vidSeek, t: () => V.t, len: seqEnd },
    { step: { by: () => 1 / fpsNow(), label: 'one frame' }, fps: fpsNow, loop: { get: () => V.loop, set: (on) => { V.loop = on; store.set('deck.video.loop', on); } },
      area: WA, keys: keyJumps(() => clipKeyTimes(TL, TL.selItem() ? [TL.selItem()] : V.items)), extra: [button('📷 Save frame', snapshotFrame, { title: 'Save this frame as an image' }), VD.load] });
  // Premiere-ish keys while the Video engine is on show (playback.js: Space, arrows, Home / End; the timeline's own:
  // timeline-keys.js through TL.keys, Ctrl+Z / Ctrl+Shift+Z among them)
  const tk = TL.keys();
  playKeys(() => VD.active(), () => vtp, (e) => ({ f: toggleVideoFullscreen, ...tk.more(e) }), (e) => tk.combos(e));
  registerUndo('video', { undo: undoEdit, redo: redoEdit, can: () => HIST.can() });
}

// Track and ruler menu items the timeline leaves to the tab (timeline.js menuAction). Rename track, lock and solo are not
// handled here yet.
function menuAction(id, ctx = {}) {
  const step = 1 / fpsNow();
  if (id === 'addVideo' || id === 'addAudio') { addTrack(id === 'addVideo' ? 'video' : 'audio'); return timelineChanged(); }
  if (id === 'remove' && ctx.track) {
    const tr = ctx.track;
    if (V.items.some((i) => i.track === tr.id) || tracksOf(tr.kind).length < 2) return toast('Only an empty track can go, and one of each kind stays', true);
    V.tracks = V.tracks.filter((t) => t !== tr);
    return timelineChanged();
  }
  if (id === 'areaStart' || id === 'areaEnd') {
    const len = seqEnd();
    if (!(len > 0)) return toast('Add something to the timeline first', true);
    const t = snapT(Math.min(len, Math.max(0, ctx.t || 0)), { step });
    return WA.set((id === 'areaStart' ? setIn : setOut)(V.range, t, len, step));
  }
  if (id === 'areaClear') return WA.set(null);
  if (id === 'renameMarker' && ctx.marker != null) {
    const i = ctx.marker, was = V.markers[i]?.label || '';
    nameSheet({ title: 'Rename marker', placeholder: was || `Marker ${i + 1}`, save: (name) => { renameMarker(V, i, name || was); timelineChanged(); } });
  }
}

// the one bar over the timeline: edits on the picked clips, snapping, zoom, and the keys behind ⓘ
const TL_HELP = ['Drag clips to move them (onto other tracks too), drag their ends to trim, overlap two on a track to cross-fade.',
  'Shift or Ctrl / Alt picks several, a drag on an empty lane picks with a box, Alt-drag copies. Right-click or hold for more.',
  'Keys: ' + timelineKeys().map((k) => `${k.keys} ${k.label}`).join(' · ')].join(' ');
const timelineTools = () => [
  iconBtn('Split at the playhead (S)', icon('cut'), () => TL.splitAtPlayhead()),
  iconBtn('Duplicate (Ctrl+J)', icon('copy'), () => TL.duplicatePicked()),
  iconBtn('Delete (Del)', icon('trash'), () => TL.removePicked()),
  iconBtn('Ripple delete: delete and close the gap (Shift+Del)', icon('left'), () => TL.rippleDelete()),
  TL.snapChip(),
  h('span', { class: 'grow' }),
  iconBtn('Zoom out', '−', () => TL.zoomBy(1 / 1.5)),
  button('Fit', TL.fit, { cls: 'small' }),
  iconBtn('Zoom in', '+', () => TL.zoomBy(1.5)),
  info(TL_HELP, 'Timeline keys')];

// The sequence size, as the Sequence section sets it (a frame on the table brings its own width and height)
export function setSequenceSize(w, h) {
  if (V.size && V.size[0] === w && V.size[1] === h) return;
  V.size = [w, h]; timelineChanged();
}

// The sequence frame rate (0: match the first clip), as the Frame pane's Sequence section sets it
export function setFps(n) {
  const fps = Math.max(0, Number(n) || 0);
  if (V.fps === fps) return;
  V.fps = fps; timelineChanged();
}
export const fpsOf = () => V.fps || 0;

// the open video edits (tabs.js), for a frame to switch to its own
export const videoTabs = () => tabs;

// Saved video edits as a source in every image picker (media.js registerPickerSource): a tab's video is its
// newest finished render in History (params.edit_tab.id); one never exported has nothing to take a frame from yet.
registerPickerSource({ key: 'video-tabs', label: 'Saved video edits',
  async list(pid) {
    const q = pid != null ? `project_id=${pid}&` : '';
    const rows = await api(`/api/store/video-tabs${pid != null ? `?project_id=${pid}` : ''}`);
    return Promise.all(rows.map(async (d) => {
      const [g] = await api(`/api/generations?${q}edit_tab=${encodeURIComponent(d.id)}&status=done&limit=1`).catch(() => []);
      const o = g?.outputs.find((x) => x.kind === 'video');
      return { id: d.id, title: d.name, thumb: d.still?.url, still: !!d.still, video: o?.url, badge: o ? null : 'export first', gen: g?.id };
    }));
  },
  async pick(it, { mp, frame }) {
    if (!frame && !it.still) throw new Error('Export it first: this edit has no video yet');
    const blob = frame || await (await fetch(it.thumb)).blob();
    const r = await uploadImage(blob, { mp, source: 'video-tab', filename: 'video-edit.png' });
    return { ...r, from: { source: 'video-tab', id: it.id, generation: it.gen } };
  } });

// for the headless UI checks (dev/): the live state
export const videoDebug = () => ({ V, G, tabs, geom, gview, gizmoClip, snap, drawFrame, selItem });
