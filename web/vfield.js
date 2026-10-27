// The player + trim + crop widget of a template's video field (generate.js videoField builds the rest).
// It never redraws the field: edits report through onChange(trim|null, crop|null) when a drag or a
// typed number ends. trim = {start, len} in seconds; crop = {x, y, w, h} fractions of the frame.
import { api, button, clamp, clamp01, h, iconBtn, seg } from './ui.js';
import { ASPECTS, aspectCrop, cropSpan } from './editor.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const EPS = 0.001;
const probes = new Map();   // source JSON -> Promise<info>; ffprobe once per clip
const probe = (source) => {
  const k = JSON.stringify(source);
  if (!probes.has(k)) probes.set(k, api('/api/videos/probe', { method: 'POST', body: { source } }).catch((e) => { probes.delete(k); throw e; }));
  return probes.get(k);
};
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const isFull = (c) => c.w > 1 - EPS && c.h > 1 - EPS;

// opts: url, source ({generation,index} | {media}), trim, crop (as saved), loader() -> { rate (force_rate, 0 = the clip's),
// nth, mapped (the loader's skip/cap inputs are in the template) }, budget() -> { secs } | { frames } | null, onChange.
// For clips that aren't sources yet (the clip importer): info (a Promise of {duration, fps}) instead of source,
// audio (a separate sound stream kept in step with the picture), marks (buttons: frame steps, in/out at the
// playhead, for long videos where the bar is too coarse) and onError (the browser can't play url).
export function videoEditor({ url, source, info: infoP = null, audio = null, trim, crop, loader = () => ({}), budget = () => null,
  onChange, marks = false, onError = null }) {
  let dur = 0, fps = 24, W = 0, H = 0;
  let t0 = trim ? trim.start : 0;
  let t1 = trim && trim.len != null ? trim.start + trim.len : Infinity;   // Infinity: to the end
  let c = crop ? { ...crop } : { ...FULL };
  let editing = false, aspect = null;
  const v = h('video', { src: `${url}#t=0.001`, playsInline: true, preload: 'auto', loop: false, 'aria-label': 'Video input' });
  const end = () => Math.min(t1, dur || t1);
  const rate = () => { const l = loader(); return l.rate > 0 ? l.rate : fps; };

  // ---- stage: the video with the crop box over it ----
  const box = h('div', { class: 'crop-box vf-crop hidden' }, ['nw', 'ne', 'sw', 'se'].map((k) => h('span', { class: `handle ${k}`, 'data-h': k })));
  const wrap = h('div', { class: 'crop-wrap vf-wrap' }, v, box);
  const drawCrop = () => {
    const on = editing || !isFull(c);
    box.classList.toggle('hidden', !on);
    box.classList.toggle('editing', editing);
    Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
  };
  const pt = (e) => { const r = wrap.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    e.preventDefault(); wrap.setPointerCapture(e.pointerId);
    const p = pt(e), hk = e.target.dataset && e.target.dataset.h;
    if (hk) drag = { fx: hk.includes('w') ? c.x + c.w : c.x, fy: hk.includes('n') ? c.y + c.h : c.y };
    else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) drag = { move: true, p0: p, c0: { ...c } };
    else drag = { fx: p.x, fy: p.y };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pt(e);
    if (drag.move) {
      c.x = clamp(drag.c0.x + p.x - drag.p0.x, 0, 1 - c.w);
      c.y = clamp(drag.c0.y + p.y - drag.p0.y, 0, 1 - c.h);
    } else c = cropSpan(W, H, aspect, drag.fx, drag.fy, p.x, p.y);
    drawCrop(); info();
  });
  const dropped = () => { if (drag) { drag = null; commit(); } };
  wrap.addEventListener('pointerup', dropped); wrap.addEventListener('pointercancel', dropped);

  const aspSeg = seg(ASPECTS.map(([label, a]) => [a, label]), null, (a) => {
    aspect = a; aspSeg.set(a);
    if (a && W) { c = aspectCrop(W, H, a); drawCrop(); info(); commit(); }
  }, { wrap: true });
  const cropBar = h('div', { class: 'vf-cropbar hidden' }, aspSeg,
    button('Reset crop', () => { c = { ...FULL }; aspect = null; aspSeg.set(null); drawCrop(); info(); commit(); }));
  const cropBtn = button('Crop', () => {
    editing = !editing; v.pause();
    cropBtn.classList.toggle('primary', editing); cropBar.classList.toggle('hidden', !editing);
    cropBtn.textContent = editing ? 'Done' : 'Crop';
    drawCrop();
  });

  // ---- transport ----
  const play = iconBtn('Play / pause', '▶', () => {
    if (!v.paused) return v.pause();
    if (v.currentTime >= end() - 0.03 || v.currentTime < t0) v.currentTime = t0;
    v.play().catch(() => {});
  });
  const time = h('span', { class: 'vf-time hint' }, '0:00.00');
  const mute = iconBtn('Mute', '🔊', () => { v.muted = !v.muted; if (snd) snd.muted = v.muted; mute.textContent = v.muted ? '🔇' : '🔊'; mute.setAttribute('aria-pressed', v.muted); });
  let looping = true;
  const loopBtn = iconBtn('Loop', '🔁', () => { looping = !looping; loopBtn.classList.toggle('on', looping); loopBtn.setAttribute('aria-pressed', looping); });
  loopBtn.classList.add('on'); loopBtn.setAttribute('aria-pressed', 'true');
  v.addEventListener('play', () => { play.textContent = '⏸'; tick(); });
  v.addEventListener('pause', () => { play.textContent = '▶'; });
  v.addEventListener('error', () => { time.textContent = "Couldn't load this video"; onError?.(); });

  // a separate sound stream (link previews): follows the picture's play, pause and seeks
  let snd = audio ? h('audio', { src: audio, preload: 'auto' }) : null;
  const sync = () => { if (snd && Math.abs(snd.currentTime - v.currentTime) > 0.2) snd.currentTime = v.currentTime; };
  v.addEventListener('play', () => { sync(); snd?.play().catch(() => {}); });
  v.addEventListener('pause', () => snd?.pause());
  v.addEventListener('seeked', sync);
  v.addEventListener('waiting', () => snd?.pause());
  v.addEventListener('playing', () => { sync(); snd?.play().catch(() => {}); });

  // ---- scrubber that also trims: the lit part is kept, the round handles are in/out ----
  const range = h('div', { class: 'vf-range' });
  const head = h('div', { class: 'vf-head' });
  const hin = h('div', { class: 'vf-h in', 'data-h': 'in', role: 'slider', 'aria-label': 'Trim start' });
  const hout = h('div', { class: 'vf-h out', 'data-h': 'out', role: 'slider', 'aria-label': 'Trim end' });
  const track = h('div', { class: 'vf-track' }, h('div', { class: 'vf-rail' }), range, head, hin, hout);
  const pos = (t) => `${(dur ? clamp01(t / dur) : 0) * 100}%`;
  let want = null;   // the newest seek asked for while one is still loading (streamed clips): only that one is made
  const shownT = () => (want ?? v.currentTime) || 0;
  const drawTrack = () => {
    const e = end();
    Object.assign(range.style, { left: pos(t0), width: `${(dur ? clamp01((e - t0) / dur) : 1) * 100}%` });
    hin.style.left = pos(t0); hout.style.left = pos(e); head.style.left = pos(shownT());
    drawFine();
  };
  const tick = () => {   // rAF while playing: stay inside the trim
    drawTrack(); time.textContent = `${fmt(v.currentTime)} / ${fmt(dur)}`;
    if (v.paused) return;
    if (snd && !snd.paused && Math.abs(snd.currentTime - v.currentTime) > 0.3) snd.currentTime = v.currentTime;
    if (v.currentTime >= end() - 0.02) {
      if (looping) v.currentTime = t0;
      else { v.pause(); v.currentTime = end(); }
    }
    requestAnimationFrame(tick);
  };
  v.addEventListener('timeupdate', () => { if (v.paused) tick(); });
  v.addEventListener('seeked', () => { if (want != null) { const t = want; want = null; v.currentTime = t; } drawTrack(); });
  const seek = (t) => {
    t = clamp(t, 0, dur || t);
    if (v.seeking) want = t; else { want = null; v.currentTime = t; }
    drawTrack();
  };
  const frame = (t) => Math.round(t * rate()) / rate();   // handles land on frames
  const setAt = (k, t) => {   // a handle (in/out) or the playhead (seek) moved to t
    const f = 1 / rate();
    if (k === 'in') { t0 = clamp(frame(t), 0, end() - f); seek(t0); }
    else if (k === 'out') { t1 = clamp(frame(t), t0 + f, dur); seek(t1 - 0.001); }
    else seek(t);
    focus = k === 'seek' ? 'head' : k;
    nums(); info();
  };
  let grab = null;
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault(); track.setPointerCapture(e.pointerId);
    const k = e.target.dataset && e.target.dataset.h;
    grab = k || 'seek'; v.pause(); move(e);
  });
  const move = (e) => {
    if (!grab || !dur) return;
    const r = track.getBoundingClientRect();
    setAt(grab, clamp01((e.clientX - r.left) / r.width) * dur);
  };
  track.addEventListener('pointermove', move);
  const release = () => { if (grab && grab !== 'seek') commit(); grab = null; recenter(); drawFine(); };
  track.addEventListener('pointerup', release); track.addEventListener('pointercancel', release);

  // ---- fine bar (marks): a few seconds around the handle last moved, for frame-exact in/out on long clips ----
  let span = 10, focus = 'head', w0 = 0, fgrab = null, ticksAt = '';
  const fRange = h('div', { class: 'vf-range' }), fHead = h('div', { class: 'vf-head' });
  const fIn = h('div', { class: 'vf-h in', 'data-h': 'in', role: 'slider', 'aria-label': 'Trim start, fine' });
  const fOut = h('div', { class: 'vf-h out', 'data-h': 'out', role: 'slider', 'aria-label': 'Trim end, fine' });
  const ticks = h('div', { class: 'vf-ticks' });
  const fine = h('div', { class: 'vf-track vf-fine' }, h('div', { class: 'vf-rail' }), ticks, fRange, fHead, fIn, fOut);
  const fineLbl = h('span', { class: 'hint' });
  const win = () => Math.min(span, dur || span);
  const focusT = () => (focus === 'in' ? t0 : focus === 'out' ? end() : shownT());
  const recenter = () => { w0 = clamp(focusT() - win() / 2, 0, Math.max(0, (dur || 0) - win())); };
  const fx = (t) => (t - w0) / win();
  const drawFine = () => {
    if (!marks || !dur) return;
    const s = win(), ft = focusT();
    if (!fgrab && (ft < w0 || ft > w0 + s)) recenter();   // follows the playhead or handle a page at a time
    const a = Math.max(t0, w0), b = Math.min(end(), w0 + s);
    Object.assign(fRange.style, { left: `${clamp01(fx(a)) * 100}%`, width: `${Math.max(0, (b - a) / s) * 100}%` });
    for (const [el, t] of [[fIn, t0], [fOut, end()], [fHead, shownT()]]) {
      el.style.left = `${fx(t) * 100}%`; el.style.display = t < w0 - 1e-6 || t > w0 + s + 1e-6 ? 'none' : '';
    }
    const key = `${w0.toFixed(3)}/${s}`;
    if (key !== ticksAt) {   // second marks, labelled
      ticksAt = key;
      const gap = [0.5, 1, 2, 5, 10, 15, 30, 60].find((g) => s / g <= 12) || 120;
      const lab = [];
      for (let t = Math.ceil(w0 / gap) * gap; t <= w0 + s + 1e-6; t += gap) lab.push(h('span', { style: `left:${fx(t) * 100}%` }, fmt(t).replace(/\.00$/, '')));
      ticks.replaceChildren(...lab);
      fineLbl.textContent = `${fmt(w0)} – ${fmt(w0 + s)}`;
    }
  };
  fine.addEventListener('pointerdown', (e) => {
    e.preventDefault(); fine.setPointerCapture(e.pointerId);
    fgrab = (e.target.dataset && e.target.dataset.h) || 'seek'; v.pause(); fmove(e);
  });
  const fmove = (e) => {
    if (!fgrab || !dur) return;
    const r = fine.getBoundingClientRect();
    setAt(fgrab, w0 + clamp01((e.clientX - r.left) / r.width) * win());
  };
  fine.addEventListener('pointermove', fmove);
  const frelease = () => { if (fgrab && fgrab !== 'seek') commit(); fgrab = null; drawFine(); };
  fine.addEventListener('pointerup', frelease); fine.addEventListener('pointercancel', frelease);
  const zoom = seg([[2, '2 s'], [10, '10 s'], [60, '60 s']], span, (v2) => { span = Number(v2); recenter(); ticksAt = ''; drawFine(); });
  const fineBox = h('div', { class: 'vf-finebox' }, h('div', { class: 'vf-bar' }, h('b', { class: 'hint' }, 'Zoom'), zoom, fineLbl), fine);

  // ---- numbers: seconds and frames, kept in step ----
  const num = (label, get, set, { step, min = 0 }) => {
    const i = h('input', { type: 'number', inputMode: 'decimal', min, step });
    i.addEventListener('change', () => { const n = parseFloat(i.value); if (Number.isFinite(n)) set(n); nums(); drawTrack(); info(); commit(); });
    return { el: h('label', { class: 'vf-num' }, h('span', {}, label), i), refresh: () => { if (document.activeElement !== i) i.value = get(); } };
  };
  const f = () => 1 / rate();
  const lenS = () => end() - t0;
  const setStart = (s) => { const e = end(); t0 = clamp(s, 0, Math.max(0, (dur || s) - f())); if (e <= t0) t1 = Infinity; if (t1 !== Infinity) t1 = Math.max(t1, t0 + f()); };
  const setLen = (l) => { t1 = clamp(t0 + Math.max(l, f()), t0 + f(), dur || Infinity); };
  const fields = [
    num('Start (s)', () => t0.toFixed(2), setStart, { step: 0.01 }),
    num('Length (s)', () => lenS().toFixed(2), setLen, { step: 0.01, min: 0.01 }),
    num('Start (frame)', () => Math.round(t0 * rate()), (n) => setStart(n / rate()), { step: 1 }),
    num('Length (frames)', () => Math.round(lenS() * rate()), (n) => setLen(n / rate()), { step: 1, min: 1 }),
  ];
  const nums = () => fields.forEach((x) => x.refresh());
  const infoEl = h('p', { class: 'hint vf-info' });
  const fitBtn = button('Fit to template length', () => {
    const b = budget(); if (!b) return;
    setLen(b.secs != null ? b.secs : b.frames / rate()); nums(); drawTrack(); info(); commit();
  }, { cls: 'small hidden' });
  const trimmed = () => t0 > EPS || end() < dur - EPS;
  const info = () => {
    const n = Math.round(lenS() * rate()), l = loader(), b = budget();
    const parts = [];
    if (trimmed()) {
      parts.push(`Keeps ${t0.toFixed(2)}s to ${end().toFixed(2)}s: ${n} frames at ${+rate().toFixed(2)} fps`);
      if (!isFull(c)) parts.push('cropped copy made with ffmpeg');
      else parts.push(l.mapped ? `loader skips ${Math.round(t0 * rate())}, loads ${Math.max(1, Math.ceil(n / (l.nth || 1)))}` : 'trimmed copy made with ffmpeg');
    } else parts.push(`Whole clip: ${Math.round(dur * rate())} frames at ${+rate().toFixed(2)} fps`);
    if (!isFull(c) && W) parts.push(`crop ${Math.round(c.w * W)}×${Math.round(c.h * H)}`);
    infoEl.textContent = parts.join(' · ');
    const bf = b ? (b.secs != null ? b.secs * rate() : b.frames) : 0;
    fitBtn.classList.toggle('hidden', !b);
    if (b) {
      const over = n > Math.round(bf) + 1;
      fitBtn.textContent = `Fit to template (${b.secs != null ? `${b.secs}s` : `${b.frames} frames`})`;
      infoEl.classList.toggle('warn', over);
      if (over) infoEl.textContent += ` · longer than the template's ${Math.round(bf)} frames`;
    }
  };

  const commit = () => {
    onChange(trimmed() ? { start: +t0.toFixed(3), len: t1 === Infinity || end() >= dur - EPS ? null : +(end() - t0).toFixed(3) } : null,
      isFull(c) ? null : { x: +c.x.toFixed(4), y: +c.y.toFixed(4), w: +c.w.toFixed(4), h: +c.h.toFixed(4) });
  };

  v.addEventListener('loadedmetadata', () => {
    dur = dur || v.duration || 0; W = v.videoWidth; H = v.videoHeight;
    if (t1 === Infinity) t1 = dur;
    t0 = Math.min(t0, Math.max(0, dur - 0.04));
    v.currentTime = t0 || 0.001;
    nums(); drawTrack(); info(); drawCrop();
  });
  (infoP || probe(source)).then((p) => { fps = p.fps || 24; if (p.duration) dur = p.duration; if (t1 === Infinity && dur) t1 = dur; nums(); drawTrack(); info(); }).catch(() => { /* the element's own duration does */ });

  // ---- marks: frame steps, in/out at the playhead, play the selection, keys ----
  const setIn = () => { v.pause(); t0 = clamp(frame(shownT()), 0, Math.max(0, dur - f())); if (end() <= t0 + f()) t1 = dur; focus = 'in'; nums(); drawTrack(); info(); commit(); };
  const setOut = () => { v.pause(); t1 = clamp(frame(shownT()), t0 + f(), dur); focus = 'out'; nums(); drawTrack(); info(); commit(); };
  const step = (n) => { v.pause(); focus = 'head'; seek(frame(shownT()) + n); };
  const playSel = () => { want = null; v.currentTime = t0; focus = 'head'; v.play().catch(() => {}); };
  const markBar = marks ? h('div', { class: 'vf-bar vf-marks' },
    iconBtn('Back one frame (←)', '◀', () => step(-f())),
    iconBtn('Forward one frame (→)', '▶', () => step(f())),
    button('Set in (I)', setIn), button('Set out (O)', setOut),
    button('▶ Selection (P)', playSel, { cls: 'small primary', title: 'Play from in to out (loops while 🔁 is on)' })) : null;

  const el = h('div', { class: 'vf', ...(marks && { tabindex: 0 }) },
    h('div', { class: 'crop-stage vf-stage' }, wrap),
    h('div', { class: 'vf-bar' }, play, time, mute, loopBtn, cropBtn), markBar, snd,
    cropBar, track, marks ? fineBox : null,
    h('div', { class: 'vf-nums' }, fields.map((x) => x.el), fitBtn),
    infoEl);
  drawCrop(); nums(); drawTrack(); info();
  el.refresh = () => { nums(); info(); };   // the loader's settings arrived or changed
  el.pause = () => v.pause();
  el.swap = (u) => {   // the same clip from another file (a smoother preview copy with its own sound): keep the place
    const t = shownT(), playing = !v.paused;
    if (snd) { snd.pause(); snd.remove(); snd = null; }
    v.src = u;
    v.addEventListener('loadedmetadata', () => { v.currentTime = t; if (playing) v.play().catch(() => {}); }, { once: true });
  };
  if (marks) {   // keys while the editor has focus: ← → a frame (Shift: a second), I / O set in / out, P plays the selection, Space plays
    el.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'arrowright') step((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : f()));
      else if (k === 'i') setIn();
      else if (k === 'o') setOut();
      else if (k === 'p') playSel();
      else if (k === ' ') play.click();
      else return;
      e.preventDefault();
    });
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('input, button, textarea, select')) el.focus({ preventScroll: true }); });
  }
  return el;
}
