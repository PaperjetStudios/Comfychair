import { $, h, store, uid, toast, undoToast, clamp, panFmt, pctFmt, rangeField } from './ui.js';

// ---------------------------------------------------------------------------
// The timeline the Video and Sound tabs share: clips on tracks, moved (also to another track) and
// trimmed by dragging with snapping, cross-faded where they overlap on a track, split at the playhead,
// deleted with Undo, scrubbed on the ruler and zoomed. Each tab keeps its own state ({ tracks, items,
// pps, t, sel }) and draws its own clips, track heads and preview; the rules and gestures live here so
// the two tabs can't drift apart. Overlaps mirror app/videoedit._overlaps (the export).
//
//   const TL = timeline(V, { el: '#timeline', headW: 84, minLen: 0.1, zoom: [4, 400], ppsKey: 'deck.video.pps',
//     pause(), seek(t), showTime() (the transport's time: playback.js), changed(), dragged(), selected(it)?, canDrop(it, track)?, tabs: () => tabs });
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
    pan ? r('Pan', () => it.pan || 0, (v) => { it.pan = v; }, { min: -1, max: 1, step: 0.05, fmt: panFmt }) : null,
    r('Fade in', () => it.fadeIn || 0, (v) => { it.fadeIn = v; }, { min: 0, max: fadeMax, step: 0.05, fmt: secs }),
    r('Fade out', () => it.fadeOut || 0, (v) => { it.fadeOut = v; }, { min: 0, max: fadeMax, step: 0.05, fmt: secs }),
  ];
}

const RULER_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export function timeline(st, o) {
  const minLen = o.minLen ?? 0.1;
  const box = () => $(o.el);
  const len = (it) => Math.max(minLen, (it.out ?? (it.dur || 3)) - it.in);
  const end = (it) => it.at + len(it);
  const seqEnd = () => st.items.reduce((m, it) => Math.max(m, end(it)), 0);
  const selItem = () => st.items.find((i) => i.id === st.sel) || null;
  const trackEnd = (track) => st.items.filter((i) => i.track === track).reduce((m, i) => Math.max(m, end(i)), 0);

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

  // ---- drawing: the ruler, a row per track (head + lane of clips) and the playhead ----
  // rows: [{ track, cls, head }] top to bottom; clipEl(it) draws one clip; corner: the buttons over the heads
  function render({ rows, clipEl, corner }) {
    const tl = box();
    const span = Math.max(seqEnd() + 10, (tl.clientWidth - o.headW) / st.pps);
    const major = RULER_STEPS.find((s) => s * st.pps >= 70) || 600;
    const ruler = h('div', { class: 'tl-ruler', style: `background-size:${(major * st.pps) / 5}px 100%` });
    for (let s = 0; s <= span; s += major) {
      ruler.append(h('span', { style: `left:${s * st.pps}px` }, s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${+s.toFixed(2)}s`));
    }
    const inner = h('div', { class: 'tl-inner', style: `width:${o.headW + span * st.pps}px` },
      h('div', { class: 'tl-row tl-ruler-row' }, h('div', { class: 'tl-head tl-corner' }, ...corner), ruler));
    for (const r of rows) {
      inner.append(h('div', { class: `tl-row ${r.cls}` }, r.head,
        h('div', { class: 'tl-lane', 'data-track': r.track.id }, st.items.filter((i) => i.track === r.track.id).map(clipEl))));
    }
    inner.append(h('div', { class: 'tl-playhead' }));
    const { scrollLeft, scrollTop } = tl;
    tl.replaceChildren(inner);
    tl.scrollLeft = scrollLeft; tl.scrollTop = scrollTop;
  }
  function updatePlayhead(follow = false) {
    const tl = box(), ph = tl.querySelector('.tl-playhead');
    const x = o.headW + st.t * st.pps;
    if (ph) ph.style.left = `${x}px`;
    o.showTime?.();
    if (follow && (x > tl.scrollLeft + tl.clientWidth - 30 || x < tl.scrollLeft + o.headW)) tl.scrollLeft = x - o.headW - 30;
  }

  // ---- gestures ----
  const timeAt = (e) => (e.clientX - box().querySelector('.tl-inner').getBoundingClientRect().left - o.headW) / st.pps;
  function startScrub(e) {
    e.preventDefault();
    o.pause();
    const go = (ev) => {
      let t = Math.max(0, timeAt(ev));
      for (const p of [0, ...st.items.flatMap((i) => [i.at, end(i)])]) if (Math.abs(p - t) < 6 / st.pps) t = p;
      o.seek(t);
    };
    go(e);
    dragWindow(go);
  }
  function select(it) {
    if (st.sel === it.id) return;
    st.sel = it.id;
    box().querySelectorAll('.tl-clip.sel').forEach((c) => c.classList.toggle('sel', c.dataset.id === it.id));
    box().querySelector(`.tl-clip[data-id="${it.id}"]`)?.classList.add('sel');
    o.selected?.(it);
  }
  // Move (mode 'move') or trim ('l' / 'r') a clip by a drag, snapping to the playhead and the other clips' ends.
  // pps: the pixels per second of what is being dragged on; trackAt(ev): the track id under the pointer (or null).
  function dragClip(e, it, mode, { pps = st.pps, trackAt = laneAt, onTap = null } = {}) {
    const x0 = e.clientX, y0 = e.clientY, still = it.kind === 'image';
    const s = { at: it.at, in: it.in, out: it.out ?? (it.dur || 3) };
    const points = [0, st.t, ...st.items.filter((i) => i !== it).flatMap((i) => [i.at, end(i)])];
    const snap = (t) => {
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
        const a1 = snap(at), a2 = snap(at + l) - l;   // snap whichever end is closer to something
        const d1 = a1 !== at ? Math.abs(a1 - at) : Infinity, d2 = a2 !== at ? Math.abs(a2 - at) : Infinity;
        it.at = Math.max(0, d1 <= d2 && d1 < Infinity ? a1 : d2 < Infinity ? a2 : at);
        const tr = st.tracks.find((t) => t.id === trackAt(ev));
        if (tr && (!o.canDrop || o.canDrop(it, tr))) it.track = tr.id;
      } else if (mode === 'l') {
        let d = snap(s.at + dt) - s.at;
        if (!still) d = Math.max(d, -s.in);   // not before the start of the source
        d = Math.max(-s.at, Math.min(d, s.out - s.in - minLen));
        it.at = s.at + d;
        if (still) it.out = s.out - d; else it.in = s.in + d;
      } else {
        const out = s.in + snap(s.at + (s.out - s.in) + dt) - s.at;
        it.out = Math.max(s.in + minLen, still || !it.dur ? out : Math.min(out, it.dur));
      }
      o.dragged();
    }, (ev) => { if (moved) o.changed(); else onTap?.(ev); });
  }
  const laneAt = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`${o.el} .tl-lane`)?.dataset.track;
  function startClipDrag(e, el) {
    const it = st.items.find((i) => i.id === el.dataset.id);
    if (!it) return;
    e.preventDefault();
    const mode = e.target.classList.contains('tl-trim') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    select(it);
    dragClip(e, it, mode);
  }
  function wire() {
    const tl = box();
    tl.addEventListener('pointerdown', (e) => {
      const clip = e.target.closest('.tl-clip');
      if (clip) startClipDrag(e, clip);
      else if (e.target.closest('.tl-ruler')) startScrub(e);
    });
    tl.addEventListener('click', (e) => {   // tap an empty spot: deselect and move the playhead there
      if (!e.target.classList.contains('tl-lane')) return;
      st.sel = null; o.pause(); o.seek(Math.max(0, timeAt(e))); o.deselected?.();
    });
    tl.addEventListener('wheel', (e) => {   // ctrl/pinch + wheel zooms around the pointer
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeAt(e), e.clientX);
    }, { passive: false });
    new ResizeObserver(() => o.rendered()).observe(tl);
  }
  function zoom(pps, aroundT = st.t, clientX = null) {
    const tl = box();
    const screenX = clientX != null ? clientX - tl.getBoundingClientRect().left : o.headW + st.t * st.pps - tl.scrollLeft;
    st.pps = clamp(pps, o.zoom[0], o.zoom[1]);
    store.set(o.ppsKey, st.pps); o.rendered();
    tl.scrollLeft = o.headW + aroundT * st.pps - screenX;
  }
  function fit() {
    const tl = box();
    zoom((tl.clientWidth - o.headW - 30) / Math.max(1, seqEnd()), 0, o.headW);
    tl.scrollLeft = 0;
  }

  // ---- editing ----
  // Split the selected clip at the playhead, or every clip under it when the selected one isn't
  function split() {
    const t = st.t;
    const under = st.items.filter((it) => t > it.at + 0.02 && t < end(it) - 0.02);
    const targets = under.some((it) => it.id === st.sel) ? under.filter((it) => it.id === st.sel) : under;
    if (!targets.length) return toast('Put the playhead over a clip to split it', true);
    for (const a of targets) {
      const e = end(a), b = { ...a, id: uid(), at: t, fadeIn: 0, ...(a.chans && { chans: structuredClone(a.chans) }) };   // (its own keys)
      if (a.kind === 'image') {   // (a still has no source time: its second half's keys start where it does)
        b.out = e - t; a.out = t - a.at;
        for (const l of Object.values(b.chans || {})) for (const k of l) k.f = +(k.f - (t - a.at)).toFixed(3);
      } else { b.in = a.in + (t - a.at); a.out = b.in; }
      a.fadeOut = 0;
      st.items.splice(st.items.indexOf(a) + 1, 0, b);
    }
    o.changed();
  }
  function deleteSelected() {
    const it = selItem();
    if (!it) return;
    const before = st.items, tab = o.tabs()?.active?.id;
    st.items = st.items.filter((i) => i !== it);
    st.sel = null;
    o.changed();
    undoToast('Clip deleted', () => {
      if (o.tabs()?.active?.id !== tab) return toast('Switch back to that tab to undo', true);   // the clips on screen are another edit's
      st.items = before; st.sel = it.id; o.changed();
    });
  }
  // Overlap this clip with the one before it on its track (moving it and everything after it on that track left), so the two cross-fade
  function crossfadePrev(it, d = 0.5) {
    const prev = st.items.filter((i) => i !== it && i.track === it.track && i.at < it.at).sort((a, b) => end(b) - end(a))[0];
    if (!prev) return toast('There is no clip before this one on its track', true);
    d = Math.min(d, len(prev) / 2, len(it) / 2);
    const shift = it.at - (end(prev) - d);
    for (const i of st.items) if (i.track === it.track && i.at >= it.at) i.at = Math.max(0, i.at - shift);
    o.changed();
  }
  function duplicate() {
    const it = selItem();
    if (!it) return;
    const b = { ...it, id: uid(), at: end(it), ...(it.chans && { chans: structuredClone(it.chans) }) };
    st.items.push(b); st.sel = b.id; o.changed();
  }

  return { len, end, seqEnd, selItem, trackEnd, xfades, fadeGain, render, updatePlayhead, timeAt, select, dragClip, wire, zoom, fit,
    split, deleteSelected, crossfadePrev, duplicate };
}
