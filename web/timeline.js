import { $, h, store, uid, toast, undoToast, clamp, panFmt, pctFmt, rangeField, icon } from './ui.js';
import { keyTimes, keyedRange, setValue, value } from './keyed.js';
import * as R from './timeline-rules.js';
import { commandFor } from './timeline-keys.js';
import { clipMenu, trackMenu, rulerMenu, pickedFor } from './layer-menu.js';
import { pressMenu, openPressMenu } from './press-menu.js';
import { snap, snapOn, gzChip } from './gizmo.js';

// ---------------------------------------------------------------------------
// The timeline the Video and Sound tabs share: clips on tracks, moved (also to another track) and
// trimmed by dragging with snapping, cross-faded where they overlap on a track, split at the playhead,
// deleted with Undo, scrubbed on the ruler and zoomed. Each tab keeps its own state ({ tracks, items,
// pps, t, sel }) and draws its own clips, track heads and preview; the rules and gestures live here so
// the two tabs can't drift apart. Overlaps mirror app/videoedit._overlaps (the export).
//
//   const TL = timeline(V, { el: '#timeline', headW: 84, minLen: 0.1, zoom: [4, 400], ppsKey: 'deck.video.pps',
//     pause(), seek(t), showTime() (the transport's time: playback.js), changed(), dragged(), selected(it)?, canDrop(it, track)?, tabs: () => tabs,
//     area: () => the tab's work area (workarea.js), drawn along the top of the ruler });
//   TL.areaGeom: the work area's at / pos / points on this ruler (clip edges and the playhead to snap to)
//
// Several clips can be picked (st.sel the primary, st.multi the others; the rules are timeline-rules.js): a click picks
// one, Shift a range, Ctrl / Alt toggles, a drag on an empty lane draws a box (a finger only with TL.box on, so a finger
// still scrolls). A drag moves or trims the whole set, Alt held when it starts drags copies; snapping is the 'tl' snap
// (gizmo.js; Alt while dragging: free). Edits: removePicked, rippleDelete, splitAtPlayhead, duplicatePicked, copy, cut,
// paste (one clipboard for every timeline), nudge, selectFrom; TL.keys() gives playKeys its maps (timeline-keys.js).
// Optional, beside the above: fps (number or getter: nudges and the frame grid), placed(ids) (a drag frame: light redraw
// instead of dragged()), undo(), redo(), zoomBy(f), tc(seconds) (ruler labels), toolChanged(tool), trackKinds (the kinds
// of track Add offers, default ['video', 'audio']), menuAction(id, ctx) (track and ruler menu items the timeline can't do
// itself: ctx { track } or { t, marker }). o.lanes (a clip's keyframe lanes, timeline-rules.js) is reserved, not called yet.
//
// An image clip (Video only) has no source time: trimming its start or splitting it changes its length.
// ---------------------------------------------------------------------------

// Follow a pointer anywhere on the page until it lifts
export function dragWindow(onMove, onUp) {
  const up = (ev) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); onUp && onUp(ev); };
  addEventListener('pointermove', onMove); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

// A sound's or clip's length (s) from its metadata, so a new clip lands at its real size; 0 if it can't tell in time
export function durationOf(url, tag = 'audio') {
  return new Promise((resolve) => {
    const el = Object.assign(document.createElement(tag), { preload: 'metadata', muted: true, src: url });
    const done = (d) => { clearTimeout(timer); el.removeAttribute('src'); resolve(isFinite(d) && d > 0 ? d : 0); };
    const timer = setTimeout(() => done(0), 8000);
    el.addEventListener('loadedmetadata', () => done(el.duration), { once: true });
    el.addEventListener('error', () => done(0), { once: true });
  });
}

// Loudness peaks of a sound (all channels), `rate` per second: { peaks, rate }. normalize scales a quiet
// recording up to full height (for a picture of its shape rather than of its level).
export async function wavePeaks(url, rate, { normalize = false } = {}) {
  const buf = await (await fetch(url)).arrayBuffer();
  const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
  const chans = [...Array(audio.numberOfChannels)].map((_, c) => audio.getChannelData(c));
  const block = Math.floor(audio.sampleRate / rate), n = Math.ceil(chans[0].length / block);
  let peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of chans) for (let j = i * block, e = Math.min(ch.length, j + block); j < e; j += 2) m = Math.max(m, Math.abs(ch[j]));
    peaks[i] = m;
  }
  if (normalize) { const top = peaks.reduce((m, v) => Math.max(m, v), 0) || 1; peaks = peaks.map((v) => v / top); }
  return { peaks, rate };
}

// A clip's level, pan and fades, the same sliders in the Video and Sound tabs. onInput: while dragging (a live
// preview); onChange: once it's let go or typed. levelNote(v): more after the level's value. keyed(label, ch, opts):
// the tab's animatable slider (keyed.js) for the level, when its clips can be animated.
export function clipSoundFields(it, len, { onInput, onChange, level = true, pan = false, levelNote = () => '', keyed = null }) {
  const r = (label, get, set, o, ch = null) => (keyed && ch ? keyed(label, ch, { digits: 2, ...o })
    : rangeField(label, get, set, { digits: 2, ...o, onInput, onChange }));
  const fadeMax = Math.max(0.1, Math.min(10, len)), secs = (v) => `${v.toFixed(2)} s`;
  return [
    level ? r('Level', () => it.volume ?? 1, (v) => { it.volume = v; }, { min: 0, max: 2, step: 0.01, fmt: (v) => pctFmt(v) + levelNote(v) }, 'volume') : null,
    pan ? r('Pan', () => it.pan || 0, (v) => { it.pan = v; }, { min: -1, max: 1, step: 0.05, fmt: panFmt }, 'pan') : null,
    r('Fade in', () => it.fadeIn || 0, (v) => { it.fadeIn = v; }, { min: 0, max: fadeMax, step: 0.05, fmt: secs }),
    r('Fade out', () => it.fadeOut || 0, (v) => { it.fadeOut = v; }, { min: 0, max: fadeMax, step: 0.05, fmt: secs }),
  ];
}

// A clip's animated properties (keyed.js, After Effects style), the same in Video and Sound. Its keys are in the
// clip's own source time, so moving or trimming the clip keeps the animation on the picture or the sound.
//   const K = clipKeys(TL, st, { fps() (keys land on these steps), base: { ch: unset value }, pause, seek, onKeys, live });
//   K.prop(it, ch, t?) the value at timeline time t (default the playhead); K.setProp(it, ch, v) a change now;
//   K.field(it, label, ch, opts) its slider with ◀ ◆ ▶; K.diamonds(it, pps, tc) its keys on the clip
export function clipKeys(TL, st, { fps, base, pause, seek, onKeys, live = {} }) {
  const clipT = (it, t = st.t) => { const f = fps(); return Math.round((it.in + clamp(t - it.at, 0, TL.len(it))) * f) / f; };
  const baseOf = (it, ch) => it[ch] ?? base[ch];
  return {
    clipT,
    prop: (it, ch, t = st.t) => value(it, ch, clipT(it, t), baseOf(it, ch)),
    setProp: (it, ch, v) => setValue(it, ch, clipT(it), v, (x) => { it[ch] = x; }),
    field: (it, label, ch, opts) => keyedRange(label, { item: it, ch, t: () => clipT(it), base: () => baseOf(it, ch),
      setBase: (v) => { it[ch] = v; }, seek: (ct) => { pause(); seek(it.at + ct - it.in); }, onKeys, def: base[ch], ...live, ...opts }),
    diamonds: (it, pps, tc) => keyTimes(it).filter((f) => f >= it.in - 1e-3 && f <= it.in + TL.len(it) + 1e-3)
      .map((f) => h('span', { class: 'tl-key', style: `left:${(f - it.in) * pps}px`, title: `Key at ${tc(it.at + f - it.in)}` })),
  };
}

// The transport's ⧏ ⧐ (playback.js keys): the key time before / after t in times() (timeline seconds)
export const keyJumps = (times) => ({
  next: (t) => times().filter((x) => x > t + 1e-4).sort((a, b) => a - b)[0] ?? null,
  prev: (t) => times().filter((x) => x < t - 1e-4).sort((a, b) => b - a)[0] ?? null,
});
// every key of these clips, in timeline time (a clip's keys are in its source time; only those it shows)
export const clipKeyTimes = (TL, items) => items.flatMap((it) => keyTimes(it).filter((f) => f >= it.in - 1e-3 && f <= it.in + TL.len(it) + 1e-3)
  .map((f) => it.at + f - it.in));

const RULER_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const MOVE_PX = 5;   // a press moves this far before it counts as a drag
const TOOLS = ['select', 'razor', 'ripple', 'slip', 'hand'];
let clipboard = null;   // copy / cut / paste: one for every timeline, so clips go from one tab's timeline to another's

export function timeline(st, o) {
  const minLen = o.minLen ?? 0.1;
  const box = typeof o.el === 'function' ? o.el : () => $(o.el);   // a selector, or a getter for the element
  const len = (it) => Math.max(minLen, (it.out ?? (it.dur || 3)) - it.in);
  const end = (it) => it.at + len(it);
  const seqEnd = () => st.items.reduce((m, it) => Math.max(m, end(it)), 0);
  const selItem = () => st.items.find((i) => i.id === st.sel) || null;
  const trackEnd = (track) => st.items.filter((i) => i.track === track).reduce((m, i) => Math.max(m, end(i)), 0);
  if (!Array.isArray(st.multi)) st.multi = [];
  const fpsNow = () => (typeof o.fps === 'function' ? o.fps() : o.fps) || 0;
  const ro = () => ({ minLen, fps: fpsNow() || undefined, canDrop: o.canDrop, uid });   // the rules' options
  let tool = 'select', boxOn = false, swallow = false, menuOpened = false;

  // Overlap with the clip before (xin) and after (xout) it on the same track
  function xfades(it) {
    let xin = 0, xout = 0;
    for (const x of st.items) {
      if (x === it || x.track !== it.track) continue;
      if (x.at < it.at || (x.at === it.at && st.items.indexOf(x) < st.items.indexOf(it))) xin = Math.max(xin, Math.min(end(x) - it.at, len(it), len(x)));
      else xout = Math.max(xout, Math.min(end(it) - x.at, len(it), len(x)));
    }
    return { xin, xout };
  }
  // A clip's fade at time t: the later of two overlapping clips fades in over the overlap; with
  // outOverlap (sound) the earlier one also fades out over it, so the two cross-fade.
  function fadeGain(it, t, outOverlap = true) {
    const local = t - it.at, l = len(it), { xin, xout } = xfades(it);
    const fi = Math.max(it.fadeIn || 0, xin), fo = Math.max(it.fadeOut || 0, outOverlap ? xout : 0);
    let g = 1;
    if (fi > 0 && local < fi) g = Math.min(g, local / fi);
    if (fo > 0 && l - local < fo) g = Math.min(g, (l - local) / fo);
    return clamp(g, 0, 1);
  }

  // ---- selection: st.sel (the primary, the inspector's clip) and st.multi (the others) ----
  const exists = (id) => id != null && st.items.some((i) => i.id === id);
  const selState = () => ({ sel: exists(st.sel) ? st.sel : null, multi: (st.multi || []).filter(exists) });
  const pickedIds = () => R.pickedIds(selState());
  const picked = () => pickedIds().map((id) => st.items.find((i) => i.id === id));
  const isSel = (it) => !!it && (st.sel === it.id || (st.multi || []).includes(it.id));
  const lanes = () => [...(box()?.querySelectorAll(':scope > .tl-inner > .tl-row > .tl-lane[data-track]') || [])];
  // the tracks top to bottom as drawn (Video draws its video tracks upside down), for Shift ranges and moving rows
  const rowTracks = () => {
    const ts = lanes().map((l) => st.tracks.find((t) => t.id === l.dataset.track)).filter(Boolean);
    return ts.length === st.tracks.length ? ts : st.tracks;
  };
  const viewDoc = (tracks = rowTracks()) => ({ tracks, items: st.items, markers: st.markers });
  function showSel() {
    const tl = box();
    if (!tl) return;
    const multi = new Set(st.multi || []);
    tl.querySelectorAll('.tl-clip').forEach((c) => {
      const p = c.dataset.id === st.sel, m = !p && multi.has(c.dataset.id);
      c.classList.toggle('sel', p || m); c.classList.toggle('multi', m);
    });
  }
  // the selection becomes s; o.selected / o.deselected when it changed (quiet: not, an edit's o.changed redraws)
  function applySel(s, { quiet = false } = {}) {
    const before = pickedIds().join('\n');
    let sel = s.sel ?? null, multi = (s.multi || []).filter((x) => x !== sel);
    if (sel == null && multi.length) { sel = multi[multi.length - 1]; multi = multi.slice(0, -1); }
    st.sel = sel; st.multi = multi;
    showSel();
    if (quiet || pickedIds().join('\n') === before) return;
    const it = selItem();
    if (it) o.selected?.(it); else o.deselected?.();
  }
  // a click on clip it (null: on nothing): alone; Shift from the primary through it; Ctrl / Meta / Alt in or out
  function pick(it, ev = {}) {
    const toggle = !!(ev.ctrlKey || ev.metaKey || ev.altKey);
    applySel(R.pick(selState(), it?.id ?? null, { shift: !!ev.shiftKey && !toggle, toggle, order: R.pickOrder(viewDoc()) }));
  }
  const setPicked = (ids) => applySel(R.setPicked(ids.filter(exists), st.sel));
  const selectAll = () => setPicked(st.items.map((i) => i.id));
  const clearPick = () => applySel({ sel: null, multi: [] });
  function select(it) {   // (the old single pick: it alone, unless it is already the primary)
    if (st.sel === it.id) return;
    applySel({ sel: it.id, multi: [] });
  }

  // ---- drawing: the ruler, a row per track (head + lane of clips) and the playhead ----
  // rows: [{ track, cls, head }] top to bottom; clipEl(it) draws one clip; corner: the buttons over the heads
  const rulerText = (s) => (o.tc ? o.tc(s) : s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${+s.toFixed(2)}s`);
  function render({ rows, clipEl, corner }) {
    const tl = box();
    const span = Math.max(seqEnd() + 10, (tl.clientWidth - o.headW) / st.pps);
    const major = RULER_STEPS.find((s) => s * st.pps >= 70) || 600;
    const ruler = h('div', { class: 'tl-ruler', style: `background-size:${(major * st.pps) / 5}px 100%` });
    for (let s = 0; s <= span; s += major) ruler.append(h('span', { style: `left:${s * st.pps}px` }, rulerText(s)));
    (st.markers || []).forEach((m, i) => ruler.append(h('i', { class: 'tl-marker', style: `left:${m.t * st.pps}px`, 'data-i': i,
      title: m.label || `Marker ${i + 1}` })));
    const area = o.area?.();
    if (area) ruler.append(...area.el());
    const inner = h('div', { class: 'tl-inner', style: `width:${o.headW + span * st.pps}px` },
      h('div', { class: 'tl-row tl-ruler-row' }, h('div', { class: 'tl-head tl-corner' }, ...corner), ruler));
    for (const r of rows) {
      inner.append(h('div', { class: `tl-row ${r.cls}${r.track.locked ? ' locked' : ''}` }, r.head,
        h('div', { class: 'tl-lane', 'data-track': r.track.id }, st.items.filter((i) => i.track === r.track.id).map(clipEl))));
    }
    inner.append(h('div', { class: 'tl-playhead' }));
    const { scrollLeft, scrollTop } = tl;
    tl.replaceChildren(inner);
    tl.scrollLeft = scrollLeft; tl.scrollTop = scrollTop;
    showSel();
  }
  function updatePlayhead(follow = false) {
    const tl = box(), ph = tl.querySelector('.tl-playhead');
    const x = o.headW + st.t * st.pps;
    if (ph) ph.style.left = `${x}px`;
    o.showTime?.();
    if (follow && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft + o.headW)) tl.scrollLeft = x - o.headW - 30;
  }
  // Restyle only these clips (a drag frame): place and length, and the lane when one changed track
  function place(ids) {
    const tl = box();
    if (!tl) return;
    for (const id of ids) {
      const it = st.items.find((i) => i.id === id), el = tl.querySelector(`.tl-clip[data-id="${CSS.escape(String(id))}"]`);
      if (!it || !el) continue;
      el.style.left = `${it.at * st.pps}px`; el.style.width = `${Math.max(6, len(it) * st.pps)}px`;
      if (el.parentElement?.dataset.track !== it.track) lanes().find((l) => l.dataset.track === it.track)?.append(el);
    }
  }
  const frame = (ids) => { if (o.placed) { place(ids); o.placed(ids); } else o.dragged(); };

  // ---- gestures ----
  const timeAt = (e) => (e.clientX - box().querySelector('.tl-inner').getBoundingClientRect().left - o.headW) / st.pps;
  function startScrub(e) {
    e.preventDefault();
    o.pause();
    const go = (ev) => {
      let t = Math.max(0, timeAt(ev));
      for (const p of [0, ...st.items.flatMap((i) => [i.at, end(i)]), ...(st.markers || []).map((m) => m.t)]) if (Math.abs(p - t) < 6 / st.pps) t = p;
      o.seek(t);
    };
    go(e);
    dragWindow(go);
  }
  // Move (mode 'move') or trim ('l' / 'r') a clip by a drag, snapping to the playhead and the other clips' ends.
  // pps: the pixels per second of what is being dragged on; trackAt(ev): the track id under the pointer (or null).
  function dragClip(e, it, mode, { pps = st.pps, trackAt = laneAt, onTap = null } = {}) {
    const x0 = e.clientX, y0 = e.clientY, still = it.kind === 'image';
    const s = { at: it.at, in: it.in, out: it.out ?? (it.dur || 3) };
    const points = [0, st.t, ...st.items.filter((i) => i !== it).flatMap((i) => [i.at, end(i)])];
    const snapTo = (t) => {
      let best = t, d = 8 / pps;
      for (const p of points) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
      return best;
    };
    let moved = false;
    dragWindow((ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5 && Math.abs(ev.clientY - y0) < 5) return;
      moved = true;
      const dt = (ev.clientX - x0) / pps;
      if (mode === 'move') {
        const l = s.out - s.in, at = Math.max(0, s.at + dt);
        const a1 = snapTo(at), a2 = snapTo(at + l) - l;   // snap whichever end is closer to something
        const d1 = a1 !== at ? Math.abs(a1 - at) : Infinity, d2 = a2 !== at ? Math.abs(a2 - at) : Infinity;
        it.at = Math.max(0, d1 <= d2 && d1 < Infinity ? a1 : d2 < Infinity ? a2 : at);
        const tr = st.tracks.find((t) => t.id === trackAt(ev));
        if (tr && (!o.canDrop || o.canDrop(it, tr))) it.track = tr.id;
      } else if (mode === 'l') {
        let d = snapTo(s.at + dt) - s.at;
        if (!still) d = Math.max(d, -s.in);   // not before the start of the source
        d = Math.max(-s.at, Math.min(d, s.out - s.in - minLen));
        it.at = s.at + d;
        if (still) it.out = s.out - d; else it.in = s.in + d;
      } else {
        const out = s.in + snapTo(s.at + (s.out - s.in) + dt) - s.at;
        it.out = Math.max(s.in + minLen, still || !it.dur ? out : Math.min(out, it.dur));
      }
      o.dragged();
    }, (ev) => { if (moved) o.changed(); else onTap?.(ev); });
  }
  const areaRange = () => { const r = o.area?.()?.stored?.(); return r && Number.isFinite(r.a) && Number.isFinite(r.b) ? { a: r.a, b: r.b } : null; };
  // Move ('move') or trim ('l' / 'r') the picked clips by a drag from clip it, through the rules: the set goes together,
  // a locked track's clips stay, rows change for all or none, and it snaps to clip edges, the playhead, markers, the work
  // area and the frame grid (Alt while dragging: free). it not picked: it alone first. dup: copies of the set are made
  // when the drag starts and dragged instead. pps, trackAt: as dragClip; rows(): the track ids top to bottom there.
  function dragPicked(e, it, mode, { pps = st.pps, trackAt = laneAt, rows = () => rowTracks().map((t) => t.id), dup = false, onTap = null } = {}) {
    const x0 = e.clientX, y0 = e.clientY;
    let ids = null, g = null, vd = null, row0 = -1, dTrack = 0, points = [];
    const begin = () => {
      if (!isSel(it)) applySel({ sel: it.id, multi: [] });
      let set = pickedIds(), lead = it.id;
      if (!R.editable(st, set).length) toast('That track is locked', true);
      else if (dup && mode === 'move') {
        const its = R.editable(st, set);
        const copies = its.map((x) => ({ ...x, id: uid(), ...(x.chans && { chans: structuredClone(x.chans) }) }));
        st.items.push(...copies);
        lead = copies[its.findIndex((x) => x.id === it.id)]?.id ?? copies[0].id;
        set = copies.map((c) => c.id);
        applySel(R.setPicked(set, lead));
        if (o.rendered) o.rendered(); else o.dragged();   // (new clips: a full redraw)
      }
      ids = [lead, ...set.filter((x) => x !== lead)];
      g = R.grab(st);
      const order = rows();
      vd = viewDoc(order.map((id) => st.tracks.find((t) => t.id === id)).filter(Boolean));
      row0 = order.indexOf(g.get(lead)?.track);
      points = R.snapPoints(st, { exclude: ids, t: st.t, area: areaRange() }, ro());
    };
    dragWindow((ev) => {
      if (!ids && Math.abs(ev.clientX - x0) < MOVE_PX && Math.abs(ev.clientY - y0) < MOVE_PX) return;
      if (!ids) { begin(); swallow = true; }
      const dt = (ev.clientX - x0) / pps;
      const sn = snapOn('tl', ev) ? { points, tol: 8 / pps } : { snap: false };
      if (mode === 'move') {
        const tr = trackAt(ev), r = tr != null ? vd.tracks.findIndex((t) => t.id === tr) : -1;
        if (r >= 0 && row0 >= 0) dTrack = r - row0;
        R.moveSet(vd, ids, g, dt, { dTrack, ...sn }, ro());
      } else R.trim(st, ids, g, mode, dt, sn, ro());
      frame(ids);
    }, (ev) => { if (ids) o.changed(); else onTap?.(ev); });
  }
  const laneAt = (ev) => {
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    if (typeof o.el === 'string') return hit?.closest(`${o.el} .tl-lane`)?.dataset.track;
    const lane = hit?.closest('.tl-lane');
    return lane && box()?.contains(lane) ? lane.dataset.track : undefined;
  };
  // A press on a clip: Shift picks a range, Ctrl / Meta toggles (toggled out: no drag), else a clip not picked is
  // picked alone; then a drag moves or trims the picked set (Alt: copies of it). A tap on one of several picks it
  // alone; an Alt tap toggles it.
  function startClipDrag(e, el) {
    const it = st.items.find((i) => i.id === el.dataset.id);
    if (!it) return;
    e.preventDefault();
    if (tool === 'hand') return startPan(e);
    const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey && !ctrl && !shift;
    if (shift || ctrl) { pick(it, e); if (!isSel(it)) return; }
    else if (!alt && !isSel(it)) pick(it);
    const several = pickedIds().length > 1;
    dragPicked(e, it, mode, { dup: alt, onTap: () => {
      if (menuOpened) return;   // (a long hold opened the menu)
      if (alt) pick(it, { altKey: true });
      else if (!shift && !ctrl && several) applySel({ sel: it.id, multi: [] });
    } });
  }
  // the hand: a drag pans the timeline
  function startPan(e) {
    const tl = box(), x0 = e.clientX, y0 = e.clientY, sl = tl.scrollLeft, sk = tl.scrollTop;
    e.preventDefault();
    tl.classList.add('tl-panning');
    dragWindow((ev) => {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > MOVE_PX) swallow = true;
      tl.scrollLeft = sl - (ev.clientX - x0); tl.scrollTop = sk - (ev.clientY - y0);
    }, () => tl.classList.remove('tl-panning'));
  }
  // a box drawn from an empty spot on a lane picks what it touches (Shift: adds, Alt: takes away)
  function startBox(e) {
    const inner = box().querySelector('.tl-inner');
    if (!inner) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, t0 = Math.max(0, timeAt(e)), base = selState();
    const op = e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new', before = R.pickedIds(base).join('\n');
    let el = null;
    dragWindow((ev) => {
      if (!el && Math.abs(ev.clientX - x0) < MOVE_PX && Math.abs(ev.clientY - y0) < MOVE_PX) return;
      if (!el) { el = h('div', { class: 'tl-marquee' }); swallow = true; }
      if (!el.isConnected) inner.append(el);
      const t1 = Math.max(0, timeAt(ev)), ya = Math.min(y0, ev.clientY), yb = Math.max(y0, ev.clientY);
      const tracks = lanes().filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > ya && r.top < yb; }).map((l) => l.dataset.track);
      api.marquee = { t0: Math.min(t0, t1), t1: Math.max(t0, t1), tracks };
      const top = inner.getBoundingClientRect().top;
      Object.assign(el.style, { left: `${o.headW + api.marquee.t0 * st.pps}px`, width: `${(api.marquee.t1 - api.marquee.t0) * st.pps}px`,
        top: `${ya - top}px`, height: `${yb - ya}px` });
      const s = R.boxPick(base, R.boxItems(st, api.marquee, ro()), op);
      st.sel = s.sel; st.multi = s.multi;
      showSel();
    }, () => {
      el?.remove(); api.marquee = null;
      if (!el || pickedIds().join('\n') === before) return;
      const it = selItem();
      if (it) o.selected?.(it); else o.deselected?.();
    });
  }
  const showTool = () => {
    const tl = box();
    tl?.classList.toggle('tl-hand', tool === 'hand');
    tl?.classList.toggle('tl-boxing', boxOn);
  };
  function setTool(t) {
    if (!TOOLS.includes(t) || t === tool) return;
    tool = t; showTool();
    o.toolChanged?.(t);
  }
  const wired = new WeakSet();   // (a mount can come back to an element it already wired)
  function wire() {
    const tl = box();
    if (!tl || wired.has(tl)) return;
    wired.add(tl);
    showTool();
    tl.addEventListener('pointerdown', (e) => {
      swallow = false; menuOpened = false;
      if (e.button > 0) return;   // (a right click is the menu's)
      const clip = e.target.closest('.tl-clip');
      if (clip) return startClipDrag(e, clip);
      if (e.target.closest('.tl-ruler')) return startScrub(e);
      const lane = e.target.closest('.tl-lane');
      if (!lane) return;
      if (tool === 'hand') return startPan(e);
      if (e.target === lane && (e.pointerType !== 'touch' || boxOn)) startBox(e);
    });
    tl.addEventListener('click', (e) => {   // tap an empty spot: deselect and move the playhead there
      if (swallow) { swallow = false; return; }   // (the end of a box, a pan or a drag)
      if (!e.target.classList.contains('tl-lane')) return;
      st.sel = null; st.multi = []; showSel();
      o.pause(); o.seek(Math.max(0, timeAt(e))); o.deselected?.();
    });
    tl.addEventListener('wheel', (e) => {   // ctrl/pinch + wheel zooms around the pointer
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
    }, { passive: false });
    pressMenu(tl, openMenu, { ok: (e) => !e.target.closest?.('.tl-corner') && !!e.target.closest?.('.tl-clip, .tl-lane, .tl-head, .tl-ruler') });
    new ResizeObserver(() => o.rendered()).observe(tl);
  }
  function zoom(pps, aroundT = st.t, clientX = null) {
    const tl = box();
    const screenX = clientX != null ? clientX - tl.getBoundingClientRect().left : o.headW + st.t * st.pps - tl.scrollLeft;
    st.pps = clamp(pps, o.zoom[0], o.zoom[1]);
    store.set(o.ppsKey, st.pps); o.rendered();
    tl.scrollLeft = o.headW + aroundT * st.pps - screenX;
  }
  const zoomBy = (f) => (o.zoomBy ? o.zoomBy(f) : zoom(st.pps * f));
  function fit() {
    const tl = box();
    zoom((tl.clientWidth - o.headW - 30) / Math.max(1, seqEnd()), 0, o.headW);
    tl.scrollLeft = 0;
  }

  // ---- editing (each through the rules, then o.changed()) ----
  const allLocked = (ids) => {
    if (!ids.length || R.editable(st, ids).length) return false;
    toast(ids.length > 1 ? 'Those clips are on a locked track' : 'That clip is on a locked track', true);
    return true;
  };
  // Delete the picked clips (ripple: and close the gaps they leave). Without o.undo a toast offers Undo.
  function removePicked({ ripple = false } = {}) {
    const ids = pickedIds();
    if (!ids.length || allLocked(ids)) return;
    const before = st.items, g = R.grab(st), was = selState(), tab = o.tabs?.()?.active?.id;
    const gone = ripple ? R.rippleDelete(st, ids, ro()) : R.removeItems(st, ids);
    applySel(R.setPicked(ids.filter((id) => !gone.includes(id)), st.sel), { quiet: true });   // (a locked one stays picked)
    o.changed();
    if (o.undo || !gone.length) return;
    undoToast(gone.length > 1 ? `${gone.length} clips deleted` : 'Clip deleted', () => {
      if (o.tabs?.()?.active?.id !== tab) return toast('Switch back to that tab to undo', true);   // the clips on screen are another edit's
      st.items = before;
      for (const it of before) { const b = g.get(it.id); if (b) { it.at = b.at; it.track = b.track; } }
      st.sel = was.sel; st.multi = was.multi; o.changed();
    });
  }
  const rippleDelete = () => removePicked({ ripple: true });
  // Split the picked clips at the playhead, or every clip under it when none of them is
  function splitAtPlayhead() {
    if (!R.splitAt(st, pickedIds(), st.t, ro()).length) return toast('Put the playhead over a clip to split it', true);
    o.changed();
  }
  // Copies of the picked clips right after them; the copies are picked
  function duplicatePicked() {
    const ids = pickedIds();
    if (!ids.length || allLocked(ids)) return;
    const its = R.editable(st, ids), made = R.duplicate(st, ids, ro());
    applySel(R.setPicked(made, made[its.findIndex((x) => x.id === st.sel)] ?? null), { quiet: true });
    o.changed();
  }
  function copy() {
    const c = R.copy(st, pickedIds());
    if (c) clipboard = c;
    return !!c;
  }
  function cut() {
    const ids = pickedIds();
    if (!ids.length || allLocked(ids)) return;
    copy(); removePicked();
  }
  // The clipboard at the playhead: each clip on its own track if this timeline has it and it takes it, else the first that does
  function paste() {
    if (!clipboard?.items?.length) return toast('Copy a clip first', true);
    const made = R.paste(st, clipboard, st.t, ro());
    if (!made.length) return toast('No track here takes those clips', true);
    applySel(R.setPicked(made, made[0]), { quiet: true });
    o.changed();
  }
  // Move the picked clips by this many frames (the timeline's fps, else 30)
  function nudge(frames) {
    const ids = pickedIds();
    if (!ids.length || allLocked(ids)) return;
    if (R.nudge(st, ids, frames / (fpsNow() || 30), ro())) o.changed();
  }
  const selectFrom = (t = st.t) => setPicked(R.selectFrom(st.items, t, { o: ro() }));
  function addMarkerHere(t = st.t) { R.addMarker(st, t); o.changed(); }
  // Overlap this clip with the one before it on its track (moving it and everything after it on that track left), so the two cross-fade
  function crossfadePrev(it, d = 0.5) {
    const prev = st.items.filter((i) => i !== it && i.track === it.track && i.at < it.at).sort((a, b) => end(b) - end(a))[0];
    if (!prev) return toast('There is no clip before this one on its track', true);
    d = Math.min(d, len(prev) / 2, len(it) / 2);
    const shift = it.at - (end(prev) - d);
    for (const i of st.items) if (i.track === it.track && i.at >= it.at) i.at = Math.max(0, i.at - shift);
    o.changed();
  }

  // ---- menus: a right click or a long hold on a clip, an empty lane, a track head or the ruler ----
  // own: what the timeline does itself (then o.changed()); the rest goes to o.menuAction(id, ctx), or isn't listed without one
  const menuOf = (groups, own, ctx = {}, keep = () => true) => groups.map((gr) => gr.filter((it) => keep(it.id) && (own[it.id] || o.menuAction))
    .map((it) => ({ ...it, run: own[it.id] ? () => { if (own[it.id]() !== false) o.changed(); } : () => o.menuAction(it.id, ctx) })))
    .filter((gr) => gr.length);
  function openMenu(e) {
    menuOpened = true;
    const x = e.clientX, y = e.clientY, tgt = e.target;
    const clipEl = tgt.closest?.('.tl-clip'), lane = tgt.closest?.('.tl-lane'), head = tgt.closest?.('.tl-head'), ruler = tgt.closest?.('.tl-ruler');
    if (clipEl || lane) {
      const it = clipEl ? st.items.find((i) => i.id === clipEl.dataset.id) : null;
      if (it) { const now = picked(); if (pickedFor(now, it) !== now) applySel({ sel: it.id, multi: [] }); }
      const track = it?.track ?? lane?.dataset.track, p = picked(), lockedTr = (i) => !!st.tracks.find((t) => t.id === i.track)?.locked;
      const groups = clipMenu({ n: p.length, canPaste: !!clipboard?.items?.length, kind: p[0]?.kind, hasKeys: false,
        canSplit: p.some((i) => st.t > i.at + 0.02 && st.t < end(i) - 0.02), locked: p.length > 0 && p.every(lockedTr) });
      const run = { cut, copy, paste, duplicate: duplicatePicked, split: splitAtPlayhead, rippleDelete, delete: () => removePicked(),
        crossfade: () => { const s = selItem(); if (s) crossfadePrev(s); },
        selectTrack: () => setPicked(st.items.filter((i) => i.track === track).map((i) => i.id)), selectAfter: () => selectFrom(st.t) };
      return openPressMenu(x, y, groups.map((gr) => gr.map((i) => ({ ...i, run: run[i.id] }))), it ? 'Clip' : 'Lane');
    }
    if (head) {
      const id = head.parentElement?.querySelector(':scope > .tl-lane')?.dataset.track, tr = st.tracks.find((t) => t.id === id);
      if (!tr) return;
      const kind = tr.kind || 'audio', kinds = o.trackKinds || ['video', 'audio'];
      const groups = trackMenu({ kind, locked: !!tr.locked, solo: !!tr.solo, muted: !!tr.muted, hidden: !!tr.hidden,
        empty: !st.items.some((i) => i.track === tr.id), only: st.tracks.filter((t) => (t.kind || 'audio') === kind).length < 2 });
      const own = { lock: () => R.trackLock(st, tr.id, !tr.locked), solo: () => R.trackSolo(st, tr.id, !tr.solo),
        mute: () => { tr.muted = !tr.muted; }, hide: () => { tr.hidden = !tr.hidden; } };
      const keep = (iid) => !((iid === 'addVideo' && !kinds.includes('video')) || (iid === 'addAudio' && !kinds.includes('audio')));
      return openPressMenu(x, y, menuOf(groups, own, { track: tr }, keep), 'Track');
    }
    if (ruler) {
      const t = Math.max(0, timeAt(e)), mi = (st.markers || []).findIndex((m) => Math.abs(m.t - t) * st.pps < 6);
      const groups = rulerMenu({ marker: mi >= 0, hasRange: !!areaRange() });
      const own = { addMarker: () => { R.addMarker(st, t); }, removeMarker: () => R.removeMarker(st, mi) };
      return openPressMenu(x, y, menuOf(groups, own, { t, marker: mi >= 0 ? mi : null }), 'Ruler');
    }
  }

  // ---- keys: playKeys(active, tp, more, combos) maps from timeline-keys.js ----
  function keys() {
    const run = {
      undo: o.undo ? () => o.undo() : null, redo: o.redo ? () => o.redo() : null,
      copy, cut, paste, duplicate: duplicatePicked, selectAll, delete: () => removePicked(), rippleDelete,
      nudgeLeft: (e) => nudge(e.shiftKey ? -10 : -1), nudgeRight: (e) => nudge(e.shiftKey ? 10 : 1),
      split: splitAtPlayhead, marker: () => addMarkerHere(),
      deselect: () => (pickedIds().length > 1 ? applySel({ sel: st.sel, multi: [] }) : clearPick()),
      toolSelect: () => setTool('select'), toolRazor: () => setTool('razor'), toolRipple: () => setTool('ripple'),
      toolSlip: () => setTool('slip'), toolHand: () => setTool('hand'),
      zoomIn: () => zoomBy(1.25), zoomOut: () => zoomBy(1 / 1.25),
    };
    const mapFor = (e, ctrl) => {
      const c = commandFor(e), fn = c && run[c];
      if (!fn || !!(e.ctrlKey || e.metaKey) !== ctrl || (c === 'deselect' && !pickedIds().length)) return {};
      return { [ctrl ? e.key.toLowerCase() : e.key]: () => fn(e) };
    };
    return { more: (e) => mapFor(e, false), combos: (e) => mapFor(e, true) };
  }

  // the snapping toggle for the timeline's tool bar (the 'tl' snap, saved with the others on this device)
  function snapChip() {
    const b = gzChip('', () => { snap.tl = !snap.tl; store.set('deck.snap', snap); show(); },
      { title: 'Snap clips to edges, the playhead, markers and frames (Alt while dragging: free)' });
    const show = () => { b.classList.toggle('on', !!snap.tl); b.setAttribute('aria-pressed', String(!!snap.tl)); };
    b.setAttribute('aria-label', 'Snapping'); b.append(icon('magnet')); show();
    return b;
  }

  const areaGeom = { at: (x) => timeAt({ clientX: x }), pos: (t) => `${t * st.pps}px`,
    points: () => [0, st.t, ...st.items.flatMap((i) => [i.at, end(i)]), ...(st.markers || []).map((m) => m.t)] };

  const api = {
    areaGeom, len, end, seqEnd, selItem, trackEnd, xfades, fadeGain, render, updatePlayhead, timeAt, select, dragClip, wire, zoom, fit,
    split: splitAtPlayhead, deleteSelected: () => removePicked(), crossfadePrev, duplicate: duplicatePicked,
    pick, picked, isSel, setPicked, selectAll, clearPick, place, dragPicked, marquee: null,
    removePicked: () => removePicked(), rippleDelete, splitAtPlayhead, duplicatePicked, copy, cut, paste, nudge, selectFrom, addMarker: addMarkerHere,
    keys, snapChip, zoomBy,
    get tool() { return tool; }, set tool(t) { setTool(t); },
    get box() { return boxOn; }, set box(v) { boxOn = !!v; showTool(); },
  };
  return api;
}
