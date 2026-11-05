// Choosing frames of a video to plug in as pictures: the clip with a scrubber, a frame's step each way, and Add for more than
// one. Times are seconds into the frame's own output, what wire-rules framePick keeps and frame-source frameStill reads.
//
//   framePicker(src, { multi, at })   { el, picks() (the marked times, else the one on show), stop() }
//   openFramePick(src, { title, multi, at, onPick(times) })   the same in a sheet of its own
import { h, button, closeSheet, icon, openSheet, toast } from './ui.js';

const STEP = 1 / 24;
const stamp = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const round = (t) => +t.toFixed(3);

export function framePicker(src, { multi = true, at = 0 } = {}) {
  const video = h('video', { class: 'fp-video', muted: true, playsinline: true, preload: 'auto' });
  const scrub = h('input', { type: 'range', class: 'scrub fp-scrub', min: 0, max: 1, step: 0.001, value: 0, 'aria-label': 'Frame' });
  const time = h('span', { class: 'timecode' }, '0:00.00');
  const marks = h('div', { class: 'fp-marks' });
  const P = { start: 0, len: 0, t: 0, picks: [] };
  const show = (t) => {
    P.t = Math.max(0, Math.min(P.len || 0, t));
    scrub.value = String(P.t);
    time.textContent = stamp(P.t);
    video.currentTime = P.start + P.t;
  };
  const drawMarks = () => marks.replaceChildren(...P.picks.map((t) => button([stamp(t), ' ×'], () => { P.picks = P.picks.filter((x) => x !== t); drawMarks(); },
    { cls: 'small', title: 'Take this frame out' })));
  scrub.addEventListener('input', () => show(+scrub.value));
  const row = h('div', { class: 'row fp-row' },
    button(icon('first'), () => show(0), { cls: 'small', title: 'First frame' }),
    button(icon('stepback'), () => show(P.t - STEP), { cls: 'small', title: 'One frame back' }),
    scrub,
    button(icon('stepfwd'), () => show(P.t + STEP), { cls: 'small', title: 'One frame on' }),
    button(icon('last'), () => show(P.len), { cls: 'small', title: 'Last frame' }),
    time,
    multi ? button('Add this frame', () => { const t = round(P.t); if (!P.picks.includes(t)) { P.picks = [...P.picks, t].sort((a, b) => a - b); drawMarks(); } }, { cls: 'small' }) : null);
  const el = h('div', { class: 'frame-pick' }, video, row, marks);
  import('./frame-source.js').then((m) => m.frameClipInfo(src)).then((c) => {
    P.start = c.start; P.len = Math.max(0, c.len - 0.05);
    scrub.max = String(P.len);
    video.src = c.url;
    video.addEventListener('loadedmetadata', () => show(at), { once: true });
  }).catch((e) => { row.classList.add('hidden'); video.replaceWith(h('p', { class: 'hint' }, `This frame has no clip yet: ${e.message}`)); });
  return { el, picks: () => (P.picks.length ? [...P.picks] : [round(P.t)]), stop: () => { video.pause(); video.removeAttribute('src'); video.load(); } };
}

export function openFramePick(src, { title = 'Choose a frame', multi = true, at = 0, onPick } = {}) {
  const p = framePicker(src, { multi, at });
  const use = () => { const picks = p.picks(); p.stop(); closeSheet(); Promise.resolve(onPick(picks)).catch((e) => toast(e.message, true)); };
  openSheet(h('h3', {}, title), p.el, h('div', { class: 'actions' }, button('Use it', use, { cls: 'primary' })));
}
