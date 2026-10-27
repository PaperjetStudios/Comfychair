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
  const snd = audio ? h('audio', { src: audio, preload: 'auto' }) : null;
  if (snd) {
    const sync = () => { if (Math.abs(snd.currentTime - v.currentTime) > 0.2) snd.currentTime = v.currentTime; };
    v.addEventListener('play', () => { sync(); snd.play().catch(() => {}); });
    v.addEventListener('pause', () => snd.pause());
    v.addEventListener('seeked', sync);
    v.addEventListener('waiting', () => snd.pause());
    v.addEventListener('playing', () => { sync(); snd.play().catch(() => {}); });
  }

  // ---- scrubber that also trims: the lit part is kept, the round handles are in/out ----
  const range = h('div', { class: 'vf-range' });
  const head = h('div', { class: 'vf-head' });
  const hin = h('div', { class: 'vf-h in', 'data-h': 'in', role: 'slider', 'aria-label': 'Trim start' });
  const hout = h('div', { class: 'vf-h out', 'data-h': 'out', role: 'slider', 'aria-label': 'Trim end' });
  const track = h('div', { class: 'vf-track' }, h('div', { class: 'vf-rail' }), range, head, hin, hout);
  const pos = (t) => `${(dur ? clamp01(t / dur) : 0) * 100}%`;
  const drawTrack = () => {
    const e = end();
    Object.assign(range.style, { left: pos(t0), width: `${(dur ? clamp01((e - t0) / dur) : 1) * 100}%` });
    hin.style.left = pos(t0); hout.style.left = pos(e); head.style.left = pos(v.currentTime || 0);
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
  v.addEventListener('seeked', drawTrack);
  const seek = (t) => { v.currentTime = clamp(t, 0, dur || t); drawTrack(); };
  let grab = null;
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault(); track.setPointerCapture(e.pointerId);
    const k = e.target.dataset && e.target.dataset.h;
    grab = k || 'seek'; v.pause(); move(e);
  });
  const move = (e) => {
    if (!grab || !dur) return;
    const r = track.getBoundingClientRect(), t = clamp01((e.clientX - r.left) / r.width) * dur, f = 1 / rate();
    if (grab === 'in') { t0 = clamp(t, 0, end() - f); seek(t0); }
    else if (grab === 'out') { t1 = clamp(t, t0 + f, dur); seek(t1 - 0.001); }
    else seek(t);
    nums(); info();
  };
  track.addEventListener('pointermove', move);
  const release = () => { if (grab && grab !== 'seek') commit(); grab = null; };
  track.addEventListener('pointerup', release); track.addEventListener('pointercancel', release);

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

  // ---- marks: frame steps and in/out at the playhead ----
  const markBar = marks ? h('div', { class: 'vf-bar vf-marks' },
    iconBtn('Back one frame', '◀', () => { v.pause(); seek(v.currentTime - f()); }),
    iconBtn('Forward one frame', '▶', () => { v.pause(); seek(v.currentTime + f()); }),
    button('Set in', () => { v.pause(); t0 = clamp(v.currentTime, 0, Math.max(0, dur - f())); if (end() <= t0 + f()) t1 = dur; nums(); drawTrack(); info(); commit(); }),
    button('Set out', () => { v.pause(); t1 = clamp(v.currentTime, t0 + f(), dur); nums(); drawTrack(); info(); commit(); }),
    button('Go to in', () => { v.pause(); seek(t0); }, { cls: 'small ghost' })) : null;

  const el = h('div', { class: 'vf' },
    h('div', { class: 'crop-stage vf-stage' }, wrap),
    h('div', { class: 'vf-bar' }, play, time, mute, loopBtn, cropBtn), markBar, snd,
    cropBar, track,
    h('div', { class: 'vf-nums' }, fields.map((x) => x.el), fitBtn),
    infoEl);
  drawCrop(); nums(); drawTrack(); info();
  el.refresh = () => { nums(); info(); };   // the loader's settings arrived or changed
  el.pause = () => v.pause();
  return el;
}
