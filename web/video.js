import {
  $, h, store, uid, api, toast, undoToast, clamp, openSheet, closeSheet, button, iconBtn, linkBtn, actions, fileButton, seg,
  field, section, hint, help, info, note, placeholder, rangeField, propNum, mediaCard, panelTop, toggle, textArea, pctFmt, colorField, sizeSelect,
} from './ui.js';
import { S, fmtT, inputUrl, thumbUrl } from './core.js';
import { cardMedia, genLabel, openImagePicker, pickerSheet, projectOutputs, registerPickerSource, soundToSoundTab, uploadImage, uploadMedia } from './media.js';
import { openGeneration } from './run.js';
import { useInGenerate } from './editor.js';
import { TabSet } from './tabs.js';
import { clipSoundFields, durationOf, timeline, wavePeaks } from './timeline.js';
import { fmtTime, playKeys, transport } from './playback.js';
import * as COMP from './scene-comp.js';
import { maximizable } from './layout.js';
import { canTrack, openTrack } from './track.js';
import { CLIP_FX, keyRangeFields, loraChoice, restyleLoras, runClipStep, sendToVfx } from './vfx.js';
import { snap, snapOn, snapStep, snapNearest, normDeg, Weight, WEIGHT, DEAD_PX, deadzone, snapBar } from './gizmo.js';
import { openCraftSheet, sendToCraft } from './craft.js';

// ---------------------------------------------------------------------------
// video: a Premiere-style timeline. Video tracks stack (V2 draws over V1), audio tracks mix, and
// clips that overlap on one track cross-fade. The preview composites the clips on a canvas;
// Export sends the same timeline to the server, which renders it with ffmpeg into History.
// ---------------------------------------------------------------------------
const COMP_LOOKS = [['color', 'Color'], ['clay', 'Clay'], ['depth', 'Depth'], ['pose', 'Pose']];   // how a scene clip can be drawn (scene-offscreen.js LOOKS)
const HEAD_W = 84;    // track header column (px)
const LANE_H = 52;
const MIN_LEN = 0.1;
const V = {
  tracks: [], items: [], size: null, fps: 0, pps: store.get('deck.video.pps', 40),   // pps: timeline zoom, pixels per second (this device only)
  t: 0, playing: false, clock: 0, loop: store.get('deck.video.loop', false), sel: null,
  els: new Map(), posters: new Map(), waves: new Map(),
};

// kind 'scene': a 3D tab live-linked as a clip (scene-comp.js); src { scene, look }, nat its natural size, dur the scene's length
function newItem({ kind, src, url = null, label, thumb = null, dur = 0, nat = null }, track) {
  return { id: uid(), track, kind, src, url, label, thumb, dur, ...(nat ? { nat } : {}), at: 0, in: 0, out: kind === 'image' ? 3 : dur || null,
    x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
}

const defaultTracks = () => [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }];
V.tracks = defaultTracks();

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
const migrateEdit = (p) => ({ tracks: p.tracks?.length ? p.tracks : defaultTracks(), items: p.items || [], size: p.size || null, fps: p.fps || 0 });
let tabs = null, tabsReady = null;
let vtp = null;   // the transport bar (playback.js)
const ensureTabs = () => tabsReady || (tabsReady = tabs ? tabs.start() : Promise.resolve());

// the timeline changed: save it (the tab flushes ~1 s later, or at once on Export / leaving)
function persistTimeline() { tabs?.changed(); }

// the timeline itself (timeline.js, shared with the Sound tab): a sound clip only goes on an audio track, a picture on a video track
const TL = timeline(V, { el: '#timeline', headW: HEAD_W, minLen: MIN_LEN, zoom: [4, 400], ppsKey: 'deck.video.pps',
  pause: () => vidPause(), seek: (t) => vidSeek(t), showTime: () => vtp?.update(),
  changed: () => timelineChanged(), dragged: () => { renderTimeline(); syncMedia(); requestDraw(); }, rendered: () => renderTimeline(),
  selected: () => renderVideoPanel(), deselected: () => { renderTimeline(); renderVideoPanel(); },
  canDrop: (it, tr) => (tr.kind === 'audio') === (it.kind === 'audio'), tabs: () => tabs });
const { len: itLen, end: itEnd, seqEnd, selItem, xfades, updatePlayhead } = TL;
const fadeGain = (it, t, audio) => TL.fadeGain(it, t, audio);   // pictures only fade in over an overlap (videoedit._overlaps)
const trackOf = (it) => V.tracks.find((t) => t.id === it.track);
const tracksOf = (kind) => V.tracks.filter((t) => t.kind === kind);   // video: V1 (bottom) first
const trackName = (t) => `${t.kind === 'video' ? 'V' : 'A'}${tracksOf(t.kind).indexOf(t) + 1}`;
const zOf = (it) => tracksOf('video').findIndex((t) => t.id === it.track);
const isVisual = (it) => it.kind === 'video' || it.kind === 'image' || it.kind === 'scene';
const fpsNow = () => V.fps || 24;
const tc = (t) => fmtTime(t, fpsNow());   // m:ss:ff

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
  const el = $('#vidLoad');
  if (el) el.textContent = done < all.length ? `Loading ${done}/${all.length}…` : '';
}

// a scene clip's picture at the playhead, drawn at the size it shows at (a canvas that stands in for a media element)
function sceneEl(it) {
  const [nw, nh] = COMP.natOf(it), [W, H] = seqSize();
  const s = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh) * (it.scale || 1);
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
  persistTimeline(); renderTimeline();
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

function syncMedia() {
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
  const cv = $('#vidCanvas');
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
      ctx.globalAlpha = (it.opacity ?? 1) * fadeGain(it, V.t, false);
      // the anchor sits at the frame centre + (x, y); the clip turns and scales around it (videoedit._place does the same)
      ctx.save(); ctx.translate(g.px, g.py); ctx.rotate(g.rot);
      ctx.drawImage(el, -g.ax * g.dw, -g.ay * g.dh, g.dw, g.dh);
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
  const base = (it.fit === 'fill' ? Math.max : Math.min)(W / nw, H / nh), s = base * (it.scale || 1);
  return { W, H, nw, nh, base, dw: nw * s, dh: nh * s, ax: it.anchor?.x ?? 0.5, ay: it.anchor?.y ?? 0.5,
    px: W / 2 + (it.x || 0) * W, py: H / 2 + (it.y || 0) * H, rot: ((it.rotation || 0) * Math.PI) / 180 };
}
// frame point at (u, v) pixels from the anchor in the clip's own axes
const world = (g, u, v) => { const c = Math.cos(g.rot), s = Math.sin(g.rot); return [g.px + u * c - v * s, g.py + u * s + v * c]; };
const cornerAt = (g, cx, cy) => world(g, (cx - g.ax) * g.dw, (cy - g.ay) * g.dh);
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function gview() {
  const r = G.cv.getBoundingClientRect(), [W, H] = seqSize(), k = Math.min(r.width / W, r.height / H) || 1;
  return { r, W, H, k, ox: (r.width - W * k) / 2, oy: (r.height - H * k) / 2 };
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
  if (!it || !isVisual(it) || V.playing) return;
  if (!inRange(it)) {
    ctx.fillStyle = '#000a'; ctx.fillRect(v.ox, v.oy + v.H * v.k - 26, 260, 22);
    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText('Move the playhead over the clip for handles', v.ox + 6, v.oy + v.H * v.k - 11);
    return;
  }
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
  const box = $('#vidXform'), it = selItem();
  if (box && it && isVisual(it)) box.replaceChildren(...xformFields(it));
}

// move the anchor to frame point `to` (or by sliders) without the picture moving: the anchor's spot
// follows, so the clip stays where it was
function pinAnchor(it, g, toX, toY) {
  const c = Math.cos(g.rot), s = Math.sin(g.rot), dx = toX - g.px, dy = toY - g.py;
  const ax = g.ax + (dx * c + dy * s) / g.dw, ay = g.ay + (-dx * s + dy * c) / g.dh;
  if (Math.abs(ax - 0.5) < 1e-3 && Math.abs(ay - 0.5) < 1e-3) delete it.anchor; else it.anchor = { x: +ax.toFixed(4), y: +ay.toFixed(4) };
  it.x = +((toX - g.W / 2) / g.W).toFixed(5); it.y = +((toY - g.H / 2) / g.H).toFixed(5);
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
  if (G.drag || (e.pointerType === 'mouse' && e.button > 0)) return;
  G.settling?.w.finish();
  const r = G.cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  let it = gizmoClip(), hit = it && gizmoHit(it, sx, sy, e.pointerType);
  if (!hit) {
    it = pickAt(sx, sy);
    if (!it) return;
    V.sel = it.id; hit = 'move';
    renderTimeline(); renderVideoPanel();
  }
  e.preventDefault();
  try { G.cv.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
  gizmoStart(it, hit, e, sx, sy);
}

function gizmoStart(it, hit, e, sx, sy) {
  const g = geom(it), v = gview();
  if (!g) return;
  const kind = hit === 'move' ? 'move' : hit === 'rotate' ? 'rotate' : hit === 'anchor' ? 'anchor' : 'scale';
  const o = { scale: it.scale || 1, rot: it.rotation || 0 };
  const P = scr(v, [g.px, g.py]), d = { id: e.pointerId, it, hit, kind, g, o, sx, sy, P, d0: Math.max(Math.hypot(sx - P[0], sy - P[1]), 14), acc: 0, last: Math.atan2(sy - P[1], sx - P[0]) };
  const chans = {
    move: { px: [g.px, WEIGHT.move], py: [g.py, WEIGHT.move] }, anchor: { px: [g.px, WEIGHT.anchor], py: [g.py, WEIGHT.anchor] },
    scale: { r: [1, WEIGHT.scale] }, rotate: { a: [o.rot, WEIGHT.rotate] },
  }[kind];
  d.w = new Weight(chans, (val) => {   // each frame: the springs' values into the clip
    if (kind === 'move') { it.x = +((val.px - g.W / 2) / g.W).toFixed(5); it.y = +((val.py - g.H / 2) / g.H).toFixed(5); }
    else if (kind === 'anchor') pinAnchor(it, g, val.px, val.py);
    else if (kind === 'scale') it.scale = +clamp(o.scale * val.r, 0.02, 20).toFixed(4);
    else { const a = +normDeg(val.a).toFixed(2); if (a) it.rotation = a; else delete it.rotation; }
    syncInspector(); requestDraw();
  }, () => { G.guides = []; if (G.settling === d) G.settling = null; persistTimeline(); requestDraw(); });
  G.drag = d;
  persistTimeline();   // dirty from the first touch, so leaving mid-settle can't lose it
  G.cv.style.cursor = gizmoCursor(hit, g);
  requestDraw();
}

function gizmoMove(e) {
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
  const d = G.drag;
  if (!d || e.pointerId !== d.id) return;
  G.drag = null;
  G.settling = d;   // the weight lets go: it settles into place, then saves
  d.w.release();
  G.cv.style.cursor = '';
  G.hover = null;
}

function wireGizmo() {
  const viewer = $('#vidCanvas').parentElement;
  G.cv = h('canvas', { id: 'vidGizmo', class: 'gizmo' });
  const bar = snapBar(['edges', 'grid', 'rot', 'scale'], () => requestDraw());
  viewer.append(G.cv, bar);
  G.cv.addEventListener('pointerdown', gizmoDown);
  G.cv.addEventListener('pointermove', gizmoMove);
  G.cv.addEventListener('pointerup', gizmoUp);
  G.cv.addEventListener('pointercancel', gizmoUp);
  G.cv.addEventListener('pointerleave', () => { if (!G.drag && G.hover) { G.hover = null; drawGizmo(); } });
  new ResizeObserver(() => drawGizmo()).observe(viewer);
}

function vidPlay() {
  if (!V.items.length) return;
  if (V.t >= seqEnd() - 0.01) V.t = 0;
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
  const gone = it.kind === 'scene' && COMP.sceneOf(it.src.scene)?.state === 'missing';
  return h('div', { class: `tl-clip ${it.kind}` + (V.sel === it.id ? ' sel' : '') + (gone ? ' gone' : ''), 'data-id': it.id,
    title: gone ? 'This 3D scene was deleted from the 3D tab' : null,
    style: `left:${it.at * V.pps}px;width:${Math.max(6, itLen(it) * V.pps)}px` + (bg ? `;background-image:url("${bg}")` : '') },
    it.kind === 'audio' ? h('canvas', { class: 'wave' }) : null,
    h('span', { class: 'tl-label' }, (gone ? '⚠ ' : '') + it.label),
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
  TL.render({
    corner: [h('button', { type: 'button', class: 'tl-tog', title: 'Add a video track', onclick: () => { addTrack('video'); timelineChanged(); } }, '+V'),
      h('button', { type: 'button', class: 'tl-tog', title: 'Add an audio track', onclick: () => { addTrack('audio'); timelineChanged(); } }, '+A')],
    rows: [...tracksOf('video')].reverse().concat(tracksOf('audio'))
      .map((tr) => ({ track: tr, cls: tr.kind + (tr.hidden || tr.muted && tr.kind === 'audio' ? ' off' : ''), head: trackHead(tr) })),
    clipEl });
  drawWaves(); pruneEls(); preloadMedia(); updatePlayhead();
  $('#vidEmpty').classList.toggle('hidden', V.items.length > 0);
}

function timelineChanged() {
  persistTimeline(); renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw();
}

export function renderVideo() { renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); ensureTabs(); COMP.refresh(); }

// ---- editing ----
function targetTrack(kind) {
  const want = kind === 'audio' ? 'audio' : 'video';
  const sel = selItem(), st = sel && trackOf(sel);
  if (st && st.kind === want) return st.id;
  return (tracksOf(want)[0] || {}).id || addTrack(want);
}

// New clips go after the last clip on the selected clip's track (or V1 / A1)
export async function addToTimeline(media) {
  await ensureTabs();   // the tab must be open, or its clips would replace this one
  if (media.kind !== 'image' && !media.dur) media.dur = await durationOf(media.url, media.kind === 'audio' ? 'audio' : 'video');
  const it = newItem(media, targetTrack(media.kind));
  it.at = TL.trackEnd(it.track);
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
    help('Tap to add in order. Videos and images go on the selected video track, sound on the audio track.', 'grow'),
    button('Done', closeSheet)], async () => {
    const items = await projectOutputs(['video', 'image', 'audio']);
    return items.length ? items.map(({ g, o, i }) => addCard(o, genLabel(g),
      { kind: o.kind, src: { generation: g.id, index: i }, url: o.url, label: genLabel(g), dur: o.duration || 0 }))
      : placeholder('Nothing generated in this project yet.');
  });
}

// a 3D tab as a clip: live-linked (scene-comp.js), not baked; its length is the scene's
function addScene() {
  let look = 'color';
  pickerSheet('Add a 3D scene', [
    seg(COMP_LOOKS, look, (k) => { look = k; }),
    help('Tap a scene to add it with this look. It stays linked: edits in the 3D tab show up here.', 'grow'),
    button('Done', closeSheet)], async () => {
    const rows = await COMP.listScenes();
    return rows.length ? rows.map((r) => mediaCard(h('div', { class: 'scene-thumb' }, '3D'), r.name, async (c) => {
      c.classList.add('picked');
      const d = await COMP.load(r.id);
      if (!d || d.state !== 'ok') return toast('Couldn\'t open that 3D scene', true);
      await addToTimeline({ kind: 'scene', src: { scene: r.id, look }, label: d.name, dur: d.dur, nat: d.nat });
      toast('Added');
    })) : placeholder('This project has no 3D tabs yet. Make a scene in the 3D tab first.');
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
  if (saved) persistTimeline();
  renderTimeline(); if (saved) renderVideoPanel();
  requestDraw();
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
    help('Music, voice-overs, or videos and images from elsewhere.', 'grow'),
    button('Done', closeSheet)], async () => {
    const list = await api('/api/media');
    return list.length ? list.map((m) => addCard(m, m.label, media(m))) : placeholder('No files yet. Upload music, a voice-over or a video.');
  });
}

// ---- inspector panel ----
// a clip's time as a number box (an open range: no bar); dragged like a slider it shows on the timeline as it goes
const timeBox = (label, get, set, { step = 0.04, min = 0, max = 600 } = {}) =>
  propNum(label, Number(get()).toFixed(2), set, timelineChanged, { step, min, max, live: () => { renderTimeline(); syncMedia(); requestDraw(); } });

const clipRange = (label, get, set, opts) => rangeField(label, get, set,
  { ...opts, onInput: () => { renderTimeline(); syncMedia(); requestDraw(); }, onChange: persistTimeline });

const SIZES = [['Match first clip', null], ['1280×720', [1280, 720]], ['1920×1080', [1920, 1080]], ['720×1280', [720, 1280]],
  ['1080×1920', [1080, 1920]], ['1024×1024', [1024, 1024]], ['832×480', [832, 480]], ['480×832', [480, 832]]];

// a scene clip: which look it is drawn in, and where it comes from
function sceneFields(it) {
  const d = COMP.sceneOf(it.src.scene);
  return [
    field('Look', seg(COMP_LOOKS, it.src.look || 'color', (k) => { it.src = { ...it.src, look: k }; timelineChanged(); })),
    d?.state === 'missing' ? note('This 3D scene was deleted from the 3D tab. The clip stays; pick another scene or delete it.', 'err')
      : help(`Live from the 3D tab “${d?.name || it.label}”: changes there show here and in every video tab using it. Exports render it at the export size.`),
  ];
}

// framing: the same numbers the handles on the preview change (and that follow them while dragging)
function xformFields(it) {
  const pct = pctFmt, g = geom(it);
  const anchorEnd = () => { syncInspector(); persistTimeline(); };   // moving the anchor re-pins position, so show that too
  return [
    field('Framing', seg([['fit', 'Fit'], ['fill', 'Fill']], it.fit || 'fit', (k) => { it.fit = k; timelineChanged(); })),
    clipRange('Scale', () => it.scale ?? 1, (v) => { it.scale = v; }, { min: 0.1, max: 3, step: 0.01, fmt: pct }),
    clipRange('Rotation', () => it.rotation || 0, (v) => { if (v) it.rotation = v; else delete it.rotation; }, { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` }),
    clipRange('Position X', () => it.x || 0, (v) => { it.x = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
    clipRange('Position Y', () => it.y || 0, (v) => { it.y = v; }, { min: -1, max: 1, step: 0.005, fmt: pct }),
    clipRange('Anchor X', () => it.anchor?.x ?? 0.5, (v) => setAnchor(it, v, it.anchor?.y ?? 0.5), { min: -0.5, max: 1.5, step: 0.01, fmt: pct, onChange: anchorEnd }),
    clipRange('Anchor Y', () => it.anchor?.y ?? 0.5, (v) => setAnchor(it, it.anchor?.x ?? 0.5, v), { min: -0.5, max: 1.5, step: 0.01, fmt: pct, onChange: anchorEnd }),
    g ? null : hint('Handles appear once the clip has loaded.'),
  ];
}

function renderVideoPanel() {
  const it = selItem();
  const pct = pctFmt;
  const clip = it ? (() => {
    const len = itLen(it), tr = trackOf(it);
    const fields = [timeBox('Starts at (s)', () => it.at, (v) => { it.at = Math.max(0, v); })];
    if (it.kind === 'image') fields.push(timeBox('Duration (s)', () => len, (v) => { it.out = Math.max(MIN_LEN, v); }, { min: MIN_LEN, max: 60 }));
    else fields.push(
      timeBox('In (s)', () => it.in, (v) => { it.in = Math.max(0, Math.min(v, (it.out ?? it.dur) - MIN_LEN)); }, { max: it.dur || undefined }),
      timeBox('Out (s)', () => it.out ?? it.dur, (v) => { it.out = Math.max(it.in + MIN_LEN, it.dur ? Math.min(v, it.dur) : v); }, { max: it.dur || undefined }));
    return section(it.label, null,
      hint(`${it.kind} on ${tr ? trackName(tr) : '?'} · ${fmtT(len)}${it.dur ? ` of ${fmtT(it.dur)}` : ''}`, 'section-sub'),
      h('div', { class: 'grid-2' }, fields),
      isVisual(it) ? [h('div', { id: 'vidXform' }, xformFields(it)),
        clipRange('Opacity', () => it.opacity ?? 1, (v) => { it.opacity = v; }, { min: 0, max: 1, step: 0.01, fmt: pct })] : null,
      it.kind === 'scene' ? sceneFields(it) : null,
      it.kind === 'video' && canKey(it.fx?.orig || it) ? fxFields(it) : null,
      clipSoundFields(it, len, { level: it.kind !== 'image' && it.kind !== 'scene', levelNote: (v) => (v > 1 ? ' (preview plays at 100%)' : ''),
        onInput: () => { renderTimeline(); syncMedia(); requestDraw(); }, onChange: persistTimeline }),
      h('div', { class: 'row wrap' },
        button('✂ Split at playhead', TL.split, { title: 'S' }),
        button('⤫ Cross-fade with previous', () => TL.crossfadePrev(it)),
        it.kind === 'video' && canKey(it) ? button('VFX…', () => sendToVfx(it.src, { label: it.label, trim: { start: it.in, len: (it.out ?? it.dur) - it.in } }), { title: 'Open this clip in the VFX tab' }) : null,
        it.kind === 'video' ? button('Sound → Sound tab', () => soundToSoundTab(it.src, { trim: { start: it.in || 0, len: itLen(it) }, name: `${it.label}-sound` }),
          { title: 'This clip\'s sound (the part on the timeline) on the Sound tab\'s timeline' }) : null,
        it.kind === 'video' && canKey(it) ? button('Key…', () => openKey(it), { title: 'Cut out a green screen, or use a matte, so lower tracks show through' }) : null,
        it.kind === 'video' && canTrack(it.src) ? button('Track motion', () => openTrack({ src: it.src, url: it.url, label: it.label, from: it.in, to: it.out ?? undefined }), { title: 'Follow the picture\'s movement and make a 3D camera from it' }) : null,
        isVisual(it) ? button('Reset framing', () => { Object.assign(it, { x: 0, y: 0, scale: 1, opacity: 1, fit: 'fit' }); delete it.rotation; delete it.anchor; timelineChanged(); }) : null,
        button('Delete clip', TL.deleteSelected, { cls: 'small danger', title: 'Delete' })));
  })() : null;

  const sizeSel = sizeSelect(SIZES, V.size, (s) => { V.size = s; timelineChanged(); });
  const fpsSel = h('select', {}, [[0, 'Match first clip'], [16, '16'], [24, '24'], [25, '25'], [30, '30'], [60, '60']].map(([v, label]) =>
    h('option', { value: v, selected: V.fps === v }, label)));
  fpsSel.addEventListener('change', () => { V.fps = Number(fpsSel.value); timelineChanged(); });
  const exportBtn = button('Export video', () => exportVideo(exportBtn), { cls: 'primary' });

  $('#vidBody').replaceChildren(h('div', { class: 'panel-body' },
    h('div', { class: 'row wrap' },
      button('+ Clips', addFromHistory, { cls: 'small primary' }),
      button('+ Images', addImages),
      button('+ Sound / files', addMediaFiles),
      button('+ 3D scene…', addScene, { title: 'A 3D tab as a live clip' })),
    clip || (V.items.length
      ? help('Tap a clip to edit it. Drag clips to move them (also onto other tracks), drag their ends to trim, and overlap two clips on a track to cross-fade. Higher video tracks draw on top.')
      : hint('Add generated clips, images or sound. They line up on V1 / A1; drag them onto V2 to layer them over V1.')),
    section('Sequence', null,
      hint(`${seqSize().join('×')} · ${V.fps || 'auto'} fps · ${fmtT(seqEnd())}`, 'section-sub'),
      h('div', { class: 'grid-2' }, field('Frame size', sizeSel), field('Frame rate', fpsSel)),
      V.items.length ? panelTop(exportBtn, () => {
        if (!confirm('Remove every clip from the timeline?')) return;
        V.items = []; V.sel = null; vidSeek(0); timelineChanged();
      }) : null,
      V.items.length ? help('The export lands in History.') : null,
      V.items.length ? h('div', { class: 'row wrap' },
        button('Open in EffectCraft', (ev) => craftVideo(ev.currentTarget), { cls: 'small', title: 'Each clip as a layer in a comp, to keep editing on the computer' }),
        button('Craft documents…', () => openCraftSheet(), { cls: 'small' })) : null)));
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
    st.op === 'colorkey' ? colorField('Key colour', () => st.color || '#00ff00', (c) => { st.color = c; save(); }) : null,
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
    help('LTX effects run on the GPU, one after another, over this clip\'s range (up to 10 s), and the result takes the clip\'s place. Change them and render again any time: it always starts from the original. Remove puts the original back.'),
    fx.steps.map((st, i) => fxStepFields(it, st, i)),
    add,
    fx.error ? note(fx.error, 'err') : null,
    fx.busy ? hint(`Rendering: ${fx.busy}…`) : fx.orig ? hint('Showing the rendered result.') : null,
    h('div', { class: 'row wrap' },
      button(fx.orig ? 'Render again' : 'Render effects', () => bakeFx(it.id), { cls: 'primary', disabled: !fx.steps.length || !!fx.busy }),
      fx.orig ? button('Remove effects', () => unbakeFx(it)) : null,
      len > 10 ? hint('Only the first 10 s get the effects.') : null));
}

const clipBase = (it) => it.fx?.orig || { src: it.src, url: it.url, label: it.label, in: it.in, out: it.out ?? it.dur, dur: it.dur };
function unbakeFx(it) {
  const o = it.fx.orig;
  if (!o) return;
  const was = { src: it.src, url: it.url, label: it.label, in: it.in, out: it.out, dur: it.dur };
  Object.assign(it, { src: o.src, url: o.url, label: o.label, in: o.in, out: o.out, dur: o.dur });
  it.fx.orig = null;
  timelineChanged();
  undoToast('Back to the original clip', () => { Object.assign(it, was); it.fx.orig = o; timelineChanged(); });
}

async function bakeFx(id) {
  let it = V.items.find((x) => x.id === id);
  const tab = tabs?.active?.id;
  const base = clipBase(it), steps = it.fx.steps.map((st) => ({ ...st }));
  let source = { ...base.src, trim: { start: base.in, len: base.out - base.in } }, secs = base.out - base.in, r = null;
  it.fx.error = null;
  try {
    for (const [i, st] of steps.entries()) {
      it.fx.busy = `${i + 1}/${steps.length} ${FX_LABEL[st.op]}`; renderVideoPanel();
      r = await runClipStep(st, source, secs);
      source = { generation: r.generation, index: r.index };
      secs = r.dur || secs;
      it = V.items.find((x) => x.id === id) || it;
    }
  } catch (e) {
    it.fx.busy = null; it.fx.error = `${it.fx.busy || ''} ${e.message}`.trim();
    renderVideoPanel();
    return toast(`Effects stopped: ${e.message}`, true);
  }
  it.fx.busy = null;
  if (tabs?.active?.id !== tab || !V.items.includes(it)) return toast(`Effects done as #${r.generation} (the clip's edit was closed: find it in History)`);
  it.fx.orig = base;
  Object.assign(it, { src: { generation: r.generation, index: r.index }, url: r.url, label: `${base.label} ✨`, in: 0,
    out: Math.min(r.dur || secs, base.out - base.in), dur: r.dur || secs });
  timelineChanged();
  toast('Effects rendered: the clip now plays the result');
}

// ---- keying: a copy of the clip with alpha (server: /api/video/key), swapped in where the clip is ----
const canKey = (it) => it.src && (it.src.generation != null || it.src.media);

function openKey(it) {
  const k = { mode: 'color', color: '#00ff00', similarity: 0.12, blend: 0.08, spill: 0.5, invert: false, matte: null };
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
  const pickMatte = () => pickerSheet('Pick a matte', [help('White keeps the picture, black lets lower tracks show. Alpha Gen and mask runs make these.', 'grow'), button('Cancel', () => openKey(it))],
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
      const o = g.outputs[0], was = { src: it.src, url: it.url, label: it.label };
      Object.assign(it, { src: { generation: g.id, index: 0 }, url: o.url, label: `${it.label} (keyed)` });
      closeSheet(); timelineChanged();
      undoToast('Keyed: lower tracks show through', () => { Object.assign(it, was); timelineChanged(); });
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
  const scenes = V.items.filter((it) => it.kind === 'scene'), made = new Map();
  const [W, H] = seqSize();
  for (const [i, it] of scenes.entries()) {
    made.set(it, await COMP.exportClip(it, { W, H, fps: V.fps || 24, len: itLen(it),
      progress: (k, n) => { btn.textContent = `3D scene ${i + 1}/${scenes.length} · frame ${k}/${n}`; } }));
  }
  return {
    project_id: S.project, tab: tabs?.active && { id: tabs.active.id, name: tabs.active.name },
    width: scenes.length ? W : V.size && V.size[0], height: scenes.length ? H : V.size && V.size[1], fps: V.fps || null,
    tracks: V.tracks.map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),
    items: V.items.map((it) => ({ track: it.track, at: it.at, name: it.label, ...(made.has(it)   // (a scene's clip is already cut to what's used)
      ? { src: { clip: made.get(it).clip }, scene: made.get(it).scene, in: 0, out: itLen(it) } : { src: it.src, in: it.in, out: it.out ?? it.dur }),
      x: it.x, y: it.y, scale: it.scale, fit: it.fit, rotation: it.rotation || 0, anchor_x: it.anchor?.x, anchor_y: it.anchor?.y,
      opacity: it.opacity, volume: it.volume,
      fade_in: it.fadeIn, fade_out: it.fadeOut })) };
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

// The timeline as an EffectCraft comp: a layer per clip, stacked by track, with its timing, framing and fades
async function craftVideo(btn) {
  vidPause();
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const body = await timelineBody(btn);
    btn.textContent = label;
    await sendToCraft('video', { ...body, title: tabs?.active?.name || 'Video edit' }, btn);
  } catch (e) { toast('Couldn\'t send it: ' + e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// Full screen for the preview and its controls: the shared maximize button (layout.js)
const vidStage = () => $('#tab-video .stage');
let vidMax = null;
const vidFullscreen = () => !!vidMax?.on();
const exitVideoFullscreen = () => vidMax?.exit();
const toggleVideoFullscreen = () => vidMax?.toggle();

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

// What a tab holds: the edit itself. (Zoom and Loop are this device's, not the edit's.)
const editAdapter = {
  empty: () => ({ tracks: defaultTracks(), items: [], size: null, fps: 0 }),
  migrate: migrateEdit,
  dump: () => ({ tracks: V.tracks, items: V.items, size: V.size, fps: V.fps }),
  load(p) {
    vidPause();
    Object.assign(V, { tracks: p.tracks, items: p.items, size: p.size, fps: p.fps, sel: null, t: 0, master: null, holdSince: 0 });
    renderTimeline(); renderVideoPanel(); syncMedia(); requestDraw(); COMP.refresh();
  },
};

export function wireVideoTransport() {
  const mount = h('div', { class: 'vid-tabs' });
  $('#videoPanel').replaceChildren(mount, h('div', { id: 'vidBody' }));
  tabs = new TabSet({ kind: 'video-tabs', mount, scope: 'project', newName: (n) => `Edit ${n}`, adapter: editAdapter, seed: legacyTimeline,
    onSwitch: () => store.set('deck.video.seeded', true) });
  wireGizmo();
  COMP.wire({ ids: () => V.items.filter((i) => i.kind === 'scene').map((i) => i.src.scene), onChange: sceneChanged,
    visible: () => $('#tab-video').classList.contains('active') });
  vtp = transport({ playing: () => V.playing, play: vidPlay, pause: vidPause, seek: vidSeek, t: () => V.t, len: seqEnd },
    { step: { by: () => 1 / fpsNow(), label: 'one frame' }, fps: fpsNow, loop: { get: () => V.loop, set: (on) => { V.loop = on; store.set('deck.video.loop', on); } },
      extra: [button('📷 Frame', snapshotFrame, { title: 'Save this frame as an image' }), h('span', { id: 'vidLoad', class: 'hint' })] });
  $('#vidTransport').replaceWith(vtp.el);
  vidMax = maximizable(vidStage(), $('#tab-video .viewer'), { onChange: () => requestDraw() });
  $('#tlTools').replaceChildren(
    button('✂ Split', TL.split, { title: 'Split at playhead (S)' }),
    button('🗑 Delete', TL.deleteSelected, { title: 'Delete selected clip (Del)' }),
    h('span', { class: 'tl-tip' }, info('Drag clips to move · drag ends to trim · overlap to cross-fade')),
    iconBtn('Zoom out', '−', () => TL.zoom(V.pps / 1.5)),
    button('Fit', TL.fit),
    iconBtn('Zoom in', '+', () => TL.zoom(V.pps * 1.5)));
  TL.wire();
  // Premiere-ish keys while the Video tab is open (playback.js: Space, arrows, Home / End)
  playKeys(() => $('#tab-video').classList.contains('active'), () => vtp, () => ({
    s: TL.split, c: TL.split, f: toggleVideoFullscreen,
    Delete: TL.deleteSelected, Backspace: TL.deleteSelected,
    '=': () => TL.zoom(V.pps * 1.5), '+': () => TL.zoom(V.pps * 1.5), '-': () => TL.zoom(V.pps / 1.5),
  }));
}

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
