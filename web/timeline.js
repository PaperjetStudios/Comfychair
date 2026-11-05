import { $, h, store, uid, toast, undoToast, clamp, panFmt, pctFmt, rangeField, icon } from './ui.js';
import { keyTimes, keyedRange, setValue, value } from './keyed.js';
import { EASES, putKey } from './keys.js';
import * as R from './timeline-rules.js';
import { commandFor } from './timeline-keys.js';
import { clipMenu, trackMenu, rulerMenu, pickedFor } from './layer-menu.js';
import { pressMenu, openPressMenu } from './press-menu.js';
import { liveFrame } from './live.js';
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
// itself: ctx { track } or { t, marker }; and 'main' with ctx { item, on }), main() (on a table frame: { id } of its pinned
// main source clip, or { id: null }; null or absent: no pin here, so the clip menu doesn't offer it).
// Tools (TL.tool, TL.toolStrip(), keys V C B Y H, Esc back to Select): Select; Razor (a click cuts the clip under it at the
// line it shows, Shift+click every unlocked clip there); Ripple (a trim or a move pushes the later clips on that track);
// Slip (a drag shows another part of a clip's source, keeping its place and length); Hand (a drag pans).
// Track heads: TL.trackHead(tr, { label, extra }) (hide, mute, solo, lock, rename in place, drag to reorder, height grip).
// Markers (st.markers): M adds one, a drag on the ruler moves it, a double-click renames it.
// Keyframe lanes: a clip with keys gets a twirl; open (st.open, not saved) it shows o.lanes(it, { pps }) under its track.
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

// the eases a keyframe lane offers: keys.js's that app/keyexpr.py EASES also knows, so the preview and the export agree
export const LANE_EASES = ['smooth', 'linear', 'in', 'out', 'const'].filter((e) => EASES.some(([n]) => n === e));

// A clip's animated properties (keyed.js, After Effects style), the same in Video and Sound. Its keys are in the
// clip's own source time, so moving or trimming the clip keeps the animation on the picture or the sound.
//   const K = clipKeys(TL, st, { fps() (keys land on these steps), base: { ch: unset value }, pause, seek, onKeys, live });
//   K.prop(it, ch, t?) the value at timeline time t (default the playhead); K.setProp(it, ch, v) a change now;
//   K.field(it, label, ch, opts) its slider with ◀ ◆ ▶; K.diamonds(it, pps, tc) its keys on the clip
// A field's edit (a value, a key put or taken away, Reset) reaches every picked clip that suits(clip, ch): each gets the
// primary's value at the playhead, keyed where the primary is keyed there, its keys on ch gone where the primary has none.
export function clipKeys(TL, st, { fps, base, pause, seek, onKeys, live = {}, suits = () => true }) {
  const clipT = (it, t = st.t) => { const f = fps(); return Math.round((it.in + clamp(t - it.at, 0, TL.len(it))) * f) / f; };
  const baseOf = (it, ch) => it[ch] ?? base[ch];
  const keyedAt = (it, ch, f) => (it.chans?.[ch] || []).some((k) => Math.abs(k.f - f) < 1e-3);
  function spread(it, ch) {
    const v = value(it, ch, clipT(it), baseOf(it, ch)), anim = !!it.chans?.[ch]?.length, here = anim && keyedAt(it, ch, clipT(it));
    for (const o of TL.picked()) {
      if (!o || o === it || !suits(o, ch)) continue;
      const f = clipT(o);
      if (!anim) {
        if (o.chans?.[ch]) { delete o.chans[ch]; if (!Object.keys(o.chans).length) delete o.chans; }
        if (it[ch] === undefined) delete o[ch]; else o[ch] = it[ch];
        continue;
      }
      if (here) { o.chans ||= {}; putKey(o.chans, ch, f, v); }
      else if (o.chans?.[ch]) {
        o.chans[ch] = o.chans[ch].filter((k) => Math.abs(k.f - f) >= 1e-3);
        if (!o.chans[ch].length) delete o.chans[ch];
        if (!Object.keys(o.chans).length) delete o.chans;
      }
    }
  }
  return {
    spread,
    clipT,
    prop: (it, ch, t = st.t) => value(it, ch, clipT(it, t), baseOf(it, ch)),
    setProp: (it, ch, v) => setValue(it, ch, clipT(it), v, (x) => { it[ch] = x; }),
    field: (it, label, ch, opts) => keyedRange(label, { item: it, ch, t: () => clipT(it), base: () => baseOf(it, ch),
      setBase: (v) => { it[ch] = v; }, seek: (ct) => { pause(); seek(it.at + ct - it.in); }, def: base[ch], ...live, ...opts,
      onKeys: () => { spread(it, ch); onKeys?.(); },
      onInput: () => { spread(it, ch); (opts?.onInput || live.onInput)?.(); },
      onChange: () => { spread(it, ch); (opts?.onChange || live.onChange)?.(); } }),
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
const TOOL_BTNS = [['select', 'select', 'Select (V)'], ['razor', 'cut', 'Razor (C)'], ['ripple', 'range', 'Ripple (B)'],
  ['slip', 'swap', 'Slip (Y)'], ['hand', 'hand', 'Hand (H)']];
// the tools, for the tab's ⓘ
export const TOOLS_HELP = 'Tools: Select (V); Razor (C): click a clip to cut it at the line, Shift+click cuts every unlocked track there; '
  + 'Ripple (B): trimming or moving a clip pushes the later clips on its track along; Slip (Y): drag a clip to show another part of its '
  + 'source, its place and length stay; Hand (H): drag to pan. Esc goes back to Select.';
const MIN_H = 40, MAX_H = 240;   // a track's height (px)
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
  if (!Array.isArray(st.open)) st.open = [];   // clips whose keyframe lanes are open (not saved with the doc)
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
      title: m.label || `Marker ${i + 1}` }, m.label ? h('b', { class: 'tl-marker-label' }, m.label) : null)));
    const area = o.area?.();
    if (area) ruler.append(...area.el());
    const inner = h('div', { class: 'tl-inner', style: `width:${o.headW + span * st.pps}px` },
      h('div', { class: 'tl-row tl-ruler-row' }, h('div', { class: 'tl-head tl-corner' }, ...corner), ruler));
    st.open = st.open.filter((id) => st.items.some((i) => i.id === id && keyTimes(i).length));
    const withTwirl = (it) => {
      const el = clipEl(it);
      if (o.lanes && keyTimes(it).length) {
        const on = st.open.includes(it.id), what = on ? 'Hide its keyframes' : 'Show its keyframes';
        el.append(h('button', { type: 'button', class: 'tl-twirl' + (on ? ' on' : ''), title: what, 'aria-label': what,
          'aria-expanded': String(on) }, icon(on ? 'chevdown' : 'chevron')));
      }
      return el;
    };
    for (const r of rows) {
      const on = st.items.filter((i) => i.track === r.track.id);
      inner.append(h('div', { class: `tl-row ${r.cls}${r.track.locked ? ' locked' : ''}`, 'data-track': r.track.id,
        style: r.track.h ? `height:${r.track.h}px` : null }, r.head,
        h('div', { class: 'tl-lane', 'data-track': r.track.id }, on.map(withTwirl))));
      if (!o.lanes) continue;
      for (const it of on.filter((i) => st.open.includes(i.id)).sort((a, b) => a.at - b.at)) {
        for (const row of o.lanes(it, { pps: st.pps }) || []) {   // (a row with no head of its own starts its lane after the heads)
          if (!row.querySelector(':scope > .tl-head')) row.style.paddingLeft = `${o.headW}px`;
          inner.append(row);
        }
      }
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
  // ripple: a trim pushes the later clips on the track; a move takes every clip after the moved ones on their tracks along.
  function dragPicked(e, it, mode, { pps = st.pps, trackAt = laneAt, rows = () => rowTracks().map((t) => t.id), dup = false, ripple = false, onTap = null } = {}) {
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
      if (ripple && mode === 'move') {   // and everything after them on their tracks
        const from = new Map();
        for (const x of R.editable(st, ids)) from.set(x.track, Math.min(from.get(x.track) ?? Infinity, x.at));
        const after = st.items.filter((x) => from.has(x.track) && x.at >= from.get(x.track) - 1e-6 && !ids.includes(x.id)).map((x) => x.id);
        ids = [...ids, ...after];
      }
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
        if (r >= 0 && row0 >= 0 && !ripple) dTrack = r - row0;
        R.moveSet(vd, ids, g, dt, { dTrack, ...sn }, ro());
      } else R.trim(st, ids, g, mode, dt, { ...sn, ripple }, ro());
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
    if (tool === 'razor') return razorCut(e, it);
    const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    if (tool === 'slip' && mode === 'move') return startSlip(e, it);
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey && !ctrl && !shift;
    if (shift || ctrl) { pick(it, e); if (!isSel(it)) return; }
    else if (!alt && !isSel(it)) pick(it);
    const several = pickedIds().length > 1;
    dragPicked(e, it, mode, { dup: alt && tool !== 'ripple', ripple: tool === 'ripple', onTap: () => {
      if (menuOpened) return;   // (a long hold opened the menu)
      if (alt) pick(it, { altKey: true });
      else if (!shift && !ctrl && several) applySel({ sel: it.id, multi: [] });
    } });
  }
  // ---- the tools' own gestures ----
  const isLocked = (it) => !!st.tracks.find((t) => t.id === it.track)?.locked;
  // a time under the pointer, snapped as a drag snaps (clip edges, the playhead, markers, the work area, else the frame grid;
  // Alt: free). exclude: clip ids whose edges don't count; markers: the markers that do (default all)
  function snapTime(ev, { exclude = [], markers = st.markers } = {}) {
    const t = Math.max(0, timeAt(ev));
    if (!snapOn('tl', ev)) return t;
    const pts = R.snapPoints({ tracks: st.tracks, items: st.items, markers }, { exclude, t: st.t, area: areaRange() }, ro());
    let best = null;
    for (const p of pts) if (Math.abs(p - t) <= 8 / st.pps && (best == null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    if (best != null) return best;
    const f = fpsNow();
    return f ? Math.round(t * f) / f : t;
  }
  // the razor: the line it would cut at, over the clip under the pointer (Shift: over every track)
  let cutLine = null;
  const hideCut = () => { cutLine?.remove(); };
  function showCut(e) {
    const clip = tool === 'razor' && e.target.closest?.('.tl-clip'), it = clip && st.items.find((i) => i.id === clip.dataset.id);
    const inner = box()?.querySelector('.tl-inner');
    if (!it || !inner) return hideCut();
    const t = snapTime(e), ok = t > it.at + 0.02 && t < end(it) - 0.02 && (e.shiftKey || !isLocked(it));
    cutLine ||= h('div', { class: 'tl-cutline' });
    const ir = inner.getBoundingClientRect(), lr = clip.parentElement.getBoundingClientRect();
    Object.assign(cutLine.style, { left: `${o.headW + t * st.pps}px`, top: e.shiftKey ? '0px' : `${lr.top - ir.top}px`,
      height: e.shiftKey ? `${inner.scrollHeight}px` : `${lr.height}px` });
    cutLine.classList.toggle('no', !ok);
    if (cutLine.parentElement !== inner) inner.append(cutLine);
  }
  // a razor click: cut this clip at the line (Shift: every unlocked clip under it)
  function razorCut(e, it) {
    swallow = true;
    const t = snapTime(e);
    if (!e.shiftKey) {
      if (isLocked(it)) return toast('That clip is on a locked track', true);
      if (!(t > it.at + 0.02 && t < end(it) - 0.02)) return;
    }
    const made = R.splitAt(st, e.shiftKey ? [] : [it.id], t, ro());
    if (!made.length) return toast('Nothing to cut there', true);
    hideCut();
    o.changed();
  }
  // a slip drag: the clip keeps its place and length and shows another part of its source (the picture follows the pointer)
  function startSlip(e, it) {
    if (!isSel(it)) pick(it, e.shiftKey || e.ctrlKey || e.metaKey ? e : {});
    if (isLocked(it)) return toast('That clip is on a locked track', true);
    const still = o.still ? o.still(it) : it.kind === 'image';
    if (still) return toast('A still has no source time to slip', true);
    const x0 = e.clientX, g = R.grab(st);
    let moved = false;
    dragWindow((ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < MOVE_PX) return;
      if (!moved) { moved = true; swallow = true; }
      R.slip(st, it.id, g, -(ev.clientX - x0) / st.pps, ro());
      frame([it.id]);
    }, () => { if (moved) o.changed(); });
  }
  // a marker dragged along the ruler (snapping as a clip does); a tap on it puts the playhead there
  const markerAt = (e) => (st.markers || []).findIndex((m) => Math.abs(m.t - timeAt(e)) * st.pps < 6);
  function startMarkerDrag(e, i) {
    e.preventDefault();
    o.pause();
    const x0 = e.clientX, m = st.markers[i], el = box().querySelector(`.tl-marker[data-i="${i}"]`);
    let moved = false;
    dragWindow((ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < MOVE_PX) return;
      moved = true;
      R.moveMarker(st, st.markers.indexOf(m), snapTime(ev, { markers: st.markers.filter((x) => x !== m) }));
      if (el) el.style.left = `${m.t * st.pps}px`;
    }, () => { if (moved) o.changed(); else o.seek(m.t); });
  }
  // a name edited in place: an input over el (replace: in its place) until Enter / leaving it; Esc keeps the old name
  function inlineEdit(el, value, done, { replace = true, cls = '' } = {}) {
    const input = h('input', { type: 'text', class: `tl-rename ${cls}`, value, maxLength: 80, 'aria-label': 'Name' });
    let over = false;
    const finish = (keep) => {
      if (over) return;
      over = true;
      if (replace) input.replaceWith(el); else input.remove();
      const v = input.value.trim();
      if (keep && v !== value) done(v);
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    for (const k of ['pointerdown', 'dblclick', 'click']) input.addEventListener(k, (ev) => ev.stopPropagation());
    if (replace) el.replaceWith(input); else el.append(input);
    input.focus(); input.select();
  }
  function renameTrack(tr) {
    const b = box()?.querySelector(`.tl-head[data-track="${CSS.escape(String(tr.id))}"] .tl-name`);
    if (!b) return;
    inlineEdit(b, tr.name || b.textContent, (v) => { R.trackRename(st, tr.id, v); o.changed(); });
  }
  function renameMarker(i) {
    const el = box()?.querySelector(`.tl-marker[data-i="${i}"]`), m = st.markers?.[i];
    if (!el || !m) return;
    inlineEdit(el, m.label || '', (v) => { R.renameMarker(st, st.markers.indexOf(m), v); o.changed(); }, { replace: false, cls: 'tl-marker-rename' });
  }
  // a track head dragged up or down: the track takes the place of the one of its kind it is let go over
  function startTrackDrag(e, head) {
    const tr = st.tracks.find((t) => t.id === head.dataset.track);
    if (!tr) return;
    const y0 = e.clientY, row = head.closest('.tl-row'), kind = tr.kind || 'audio';
    let moved = false, over = null;
    const mark = (r) => { box()?.querySelectorAll('.tl-row.tl-drop').forEach((x) => x.classList.remove('tl-drop')); r?.classList.add('tl-drop'); };
    dragWindow((ev) => {
      if (!moved && Math.abs(ev.clientY - y0) < MOVE_PX) return;
      if (!moved) { moved = true; swallow = true; row?.classList.add('tl-dragging'); }
      const r = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.tl-row[data-track]');
      const t = r && box()?.contains(r) ? st.tracks.find((x) => x.id === r.dataset.track) : null;
      over = t && (t.kind || 'audio') === kind ? t : null;
      mark(over && over !== tr ? r : null);
    }, () => {
      row?.classList.remove('tl-dragging'); mark(null);
      if (!moved || !over || over === tr) return;
      R.trackReorder(st, tr.id, st.tracks.indexOf(over));
      o.changed();
    });
  }
  // A track's head, the same in every tab: its name (double-click renames it in place), hide (video), mute, solo and lock,
  // the tab's own buttons (extra), a drag to reorder it and a grip on its bottom edge for its height (saved as tr.h).
  function trackHead(tr, { label = tr.name || '', extra = [] } = {}) {
    const flip = (key, set) => () => { set ? set() : (tr[key] = !tr[key]); o.changed(); };
    const tog = (key, onIco, offIco, title, cls, set) => h('button', { type: 'button', class: `tl-tog${tr[key] ? ` ${cls}` : ''}`, title,
      'aria-label': title, 'aria-pressed': String(!!tr[key]), onclick: flip(key, set) }, icon(tr[key] ? offIco : onIco));
    const name = h('b', { class: 'tl-name' }, label);
    name.addEventListener('dblclick', (ev) => { ev.stopPropagation(); renameTrack(tr); });
    const grip = h('div', { class: 'tl-hgrip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Track height' });
    // the grip: a drag sets the height 1:1 (down: taller), a double-click puts it back, arrow keys step it; one undo step each
    // (its own drag rather than layout.js heightGrip, which grows a pane above it and shuts it near the bottom)
    grip.tabIndex = 0;
    const rowOf = () => grip.closest('.tl-row');
    const setH = (px) => { R.trackHeight(st, tr.id, px, { min: MIN_H, max: MAX_H }); const r = rowOf(); if (r) r.style.height = `${tr.h}px`; };
    grip.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      const y0 = e.clientY, h0 = tr.h || rowOf()?.offsetHeight || 52, was = tr.h;
      let moved = false;
      grip.classList.add('dragging');
      dragWindow((ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 2) return;
        moved = true;
        setH(h0 + ev.clientY - y0);
      }, () => { grip.classList.remove('dragging'); if (moved && tr.h !== was) o.changed(); });
    });
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); if (tr.h != null) { delete tr.h; o.changed(); } });
    grip.addEventListener('keydown', (e) => {
      const d = { ArrowDown: 8, ArrowUp: -8 }[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      setH((tr.h || rowOf()?.offsetHeight || 52) + d); o.changed();
      requestAnimationFrame(() => box()?.querySelector(`.tl-head[data-track="${CSS.escape(String(tr.id))}"] .tl-hgrip`)?.focus());
    });
    return h('div', { class: `tl-head${tr.locked ? ' locked' : ''}`, 'data-track': tr.id },
      name,
      h('div', { class: 'tl-head-btns' },
        (tr.kind || 'audio') === 'video' ? tog('hidden', 'eye', 'eyeoff', 'Show / hide this track', 'off') : null,
        tog('muted', 'sound', 'mute', 'Mute / unmute this track', 'off'),
        tog('solo', 'target', 'target', 'Solo: only the soloed tracks play', 'solo', () => R.trackSolo(st, tr.id, !tr.solo)),
        tog('locked', 'unlock', 'lock', 'Lock / unlock this track', 'lockd', () => R.trackLock(st, tr.id, !tr.locked)),
        ...extra),
      grip);
  }
  // the tool strip (one per timeline; the tab puts it in its tool bar)
  let strip = null;
  function toolStrip() {
    if (strip) return strip;
    strip = h('div', { class: 'tl-toolstrip', role: 'toolbar', 'aria-label': 'Timeline tools' },
      TOOL_BTNS.map(([t, ico, label]) => h('button', { type: 'button', 'data-tool': t, title: label, 'aria-label': label,
        onclick: (e) => { e.stopPropagation(); setTool(t); } }, icon(ico))));
    showTool();
    return strip;
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
    tl?.setAttribute('data-tool', tool);
    if (tool !== 'razor') hideCut();
    strip?.querySelectorAll('button[data-tool]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === tool); b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
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
      if (e.target.closest('input, .tl-hgrip, .tl-corner')) return;
      const twirl = e.target.closest('.tl-twirl');
      if (twirl) {   // a clip's keyframe lanes, open or shut
        e.preventDefault(); swallow = true;
        const id = twirl.closest('.tl-clip')?.dataset.id;
        st.open = st.open.includes(id) ? st.open.filter((x) => x !== id) : [...st.open, id];
        return o.rendered ? o.rendered() : o.dragged();
      }
      const head = e.target.closest('.tl-head');
      if (head) { if (!e.target.closest('button')) startTrackDrag(e, head); return; }
      const clip = e.target.closest('.tl-clip');
      if (clip) return startClipDrag(e, clip);
      if (e.target.closest('.tl-ruler')) { const mi = markerAt(e); return mi >= 0 ? startMarkerDrag(e, mi) : startScrub(e); }
      const lane = e.target.closest('.tl-lane');
      if (!lane) return;
      if (tool === 'hand') return startPan(e);
      if (e.target === lane && (e.pointerType !== 'touch' || boxOn)) startBox(e);
    });
    tl.addEventListener('click', (e) => {   // tap an empty spot: deselect and move the playhead there
      if (swallow) { swallow = false; return; }   // (the end of a box, a pan or a drag)
      if (!e.target.classList.contains('tl-lane') || !e.target.dataset.track) return;   // (a keyframe lane's clicks are its own)
      st.sel = null; st.multi = []; showSel();
      o.pause(); o.seek(Math.max(0, timeAt(e))); o.deselected?.();
    });
    tl.addEventListener('dblclick', (e) => {   // a double-click on a marker renames it; on the empty part of a track, the picker
      if (e.target.classList.contains('tl-lane') && e.target.dataset.track) { o.blankPick?.(); return; }
      if (!e.target.closest('.tl-ruler') || e.target.closest('input')) return;
      const mi = markerAt(e);
      if (mi >= 0) renameMarker(mi);
    });
    tl.addEventListener('pointermove', (e) => { if (tool === 'razor' && e.pointerType !== 'touch') showCut(e); else if (cutLine?.isConnected) hideCut(); });
    tl.addEventListener('pointerleave', hideCut);
    tl.addEventListener('wheel', (e) => {   // ctrl/pinch + wheel zooms around the pointer
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
    }, { passive: false });
    pressMenu(tl, openMenu, { ok: (e) => !e.target.closest?.('.tl-corner, .tl-keylane, .tl-hgrip') && !!e.target.closest?.('.tl-clip, .tl-lane, .tl-head, .tl-ruler') });
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
      const pin = o.main?.() || null;   // (a table frame's main source: { id } | null)
      const groups = clipMenu({ n: p.length, canPaste: !!clipboard?.items?.length, kind: p[0]?.kind, hasKeys: false,
        canSplit: p.some((i) => st.t > i.at + 0.02 && st.t < end(i) - 0.02), locked: p.length > 0 && p.every(lockedTr),
        main: pin && o.menuAction && p.length === 1 ? { on: p[0].id === pin.id } : null,
        table: ['video', 'sound'].includes(liveFrame()?.kind), sendable: p.length > 0 && p.every((i) => i.src) });
      const sendClips = async () => (await import('./send-to-table.js')).sendClips(p);
      const run = { toTable: async () => { const ids = p.map((i) => i.id); if (await sendClips()) { setPicked(ids); removePicked(); } }, copyToTable: () => { sendClips(); },
        cut, copy, paste, duplicate: duplicatePicked, split: splitAtPlayhead, rippleDelete, delete: () => removePicked(),
        main: () => o.menuAction('main', { item: p[0], on: p[0]?.id === pin?.id }),
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
        mute: () => { tr.muted = !tr.muted; }, hide: () => { tr.hidden = !tr.hidden; }, rename: () => { setTimeout(() => renameTrack(tr)); return false; } };   // (once the menu has gone, so it keeps the focus)
      const keep = (iid) => !((iid === 'addVideo' && !kinds.includes('video')) || (iid === 'addAudio' && !kinds.includes('audio')));
      return openPressMenu(x, y, menuOf(groups, own, { track: tr }, keep), 'Track');
    }
    if (ruler) {
      const t = Math.max(0, timeAt(e)), mi = (st.markers || []).findIndex((m) => Math.abs(m.t - t) * st.pps < 6);
      const groups = rulerMenu({ marker: mi >= 0, hasRange: !!areaRange() });
      const own = { addMarker: () => { R.addMarker(st, t); }, removeMarker: () => R.removeMarker(st, mi),
        renameMarker: () => { setTimeout(() => renameMarker(mi)); return false; } };
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
      deselect: () => (tool !== 'select' ? setTool('select') : pickedIds().length > 1 ? applySel({ sel: st.sel, multi: [] }) : clearPick()),
      toolSelect: () => setTool('select'), toolRazor: () => setTool('razor'), toolRipple: () => setTool('ripple'),
      toolSlip: () => setTool('slip'), toolHand: () => setTool('hand'),
      zoomIn: () => zoomBy(1.25), zoomOut: () => zoomBy(1 / 1.25),
    };
    const mapFor = (e, ctrl) => {
      const c = commandFor(e), fn = c && run[c];
      if (!fn || !!(e.ctrlKey || e.metaKey) !== ctrl || (c === 'deselect' && !pickedIds().length && tool === 'select')) return {};
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
    keys, snapChip, zoomBy, toolStrip, trackHead, renameTrack, renameMarker,
    get tool() { return tool; }, set tool(t) { setTool(t); },
    get box() { return boxOn; }, set box(v) { boxOn = !!v; showTool(); },
  };
  return api;
}
