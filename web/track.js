// Motion tracking sheet: follow how a clip's picture moves (app/tracking.py), look at the tracks over the
// video, and turn them into a 3D tab: a camera that makes the same move with the footage behind it
// (track-math.js). Opened from a clip in the Video tab or a video in History. The result is kept as a
// document of kind `tracks` (one per clip), so opening the sheet again doesn't track again.
import {
  $, api, actions, button, field, h, help, hint, note, openSheet, closeSheet, rangeField, seg, toast,
} from './ui.js';
import { S, fmtT, switchTab } from './core.js';
import { sceneModule } from './run.js';
import { sceneFromTrack, smooth } from './track-math.js';

const KIND = 'tracks';
const LENSES = [[24, '24'], [28, '28'], [35, '35'], [50, '50'], [85, '85']];
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (id) => `/api/store/${KIND}/${id}${qs()}`;
const hash = (s) => { let x = 5381; for (const c of s) x = ((x * 33) ^ c.charCodeAt(0)) >>> 0; return x.toString(36); };
// one document per clip
export const keyFor = (src) => (src.generation != null ? `g${src.generation}_${src.index || 0}` : `m_${hash(String(src.media || src.clip || ''))}`);
export const canTrack = (src) => !!src && (src.generation != null || !!src.media);

// opts: { src: { generation, index } | { media }, url, label, from, to } (from / to: seconds of the clip to start with)
export async function openTrack(opts) {
  const { src } = opts, id = keyFor(src);
  let doc = null;
  // (the list first: asking for a document that isn't there would log a 404)
  const have = await api(`/api/store/${KIND}${qs()}`, { busy: false }).catch(() => []);
  if (have.some((d) => d.id === id)) doc = await api(docUrl(id), { busy: false }).catch(() => null);
  const saved = doc?.payload || {};
  const T = {
    result: saved.result || null, dur: 0, ar: 16 / 9, mode: 'region', t: 0, playing: false, job: null, timer: 0,
    region: saved.result?.region || null, exclude: saved.result?.exclude || null,
    from: opts.from ?? saved.result?.start ?? 0, to: opts.to ?? null,
    set: { sigma: 2, lens: 35, zoomAs: 'fov', dist: 6, points: true, method: 'klt', ...saved.set },
  };
  const video = h('video', { src: opts.url, muted: true, playsinline: true, preload: 'auto', class: 'trk-video' });
  const cv = h('canvas', { class: 'trk-over' });
  const stage = h('div', { class: 'trk-stage' }, video, cv);
  const scrub = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Time' });
  const play = button('▶', () => (video.paused ? video.play() : video.pause()), { cls: 'small' });
  const clock = h('span', { class: 'hint trk-clock' }, '0:00');
  const body = h('div', { class: 'trk-body' });
  const prog = h('progress', { max: 1, value: 0, class: 'trk-prog hidden' });

  // the frame of the track the playhead is on
  const idx = () => (T.result ? Math.max(0, Math.min(T.result.n - 1, Math.round((T.t - T.result.start) * T.result.fps))) : 0);
  const draw = () => {
    const w = cv.clientWidth, hh = cv.clientHeight, dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    const box = (b, col, label) => {
      if (!b) return;
      g.strokeStyle = col; g.fillStyle = col + '33'; g.lineWidth = 2; g.setLineDash([6, 4]);
      g.fillRect(b[0] * w, b[1] * hh, (b[2] - b[0]) * w, (b[3] - b[1]) * hh); g.strokeRect(b[0] * w, b[1] * hh, (b[2] - b[0]) * w, (b[3] - b[1]) * hh);
      g.setLineDash([]); g.fillStyle = col; g.font = '12px sans-serif'; g.fillText(label, b[0] * w + 4, b[1] * hh + 14);
    };
    box(T.region, '#4cc38a', 'track here'); box(T.exclude, '#ff6b6b', 'ignore');
    if (T.drag) box(T.drag, T.mode === 'region' ? '#4cc38a' : '#ff6b6b', '');
    const r = T.result;
    if (!r) return;
    const f = idx();
    g.lineWidth = 1.5;
    for (const t of r.tracks) {
      const k = f - t.f;
      if (k < 0 || k >= t.p.length) continue;
      g.strokeStyle = '#ffd24a'; g.beginPath();
      for (let i = Math.max(0, k - 14); i <= k; i++) { const [x, y] = t.p[i]; i === Math.max(0, k - 14) ? g.moveTo(x * w, y * hh) : g.lineTo(x * w, y * hh); }
      g.stroke();
      const [x, y] = t.p[k];
      g.fillStyle = '#ffd24a'; g.beginPath(); g.arc(x * w, y * hh, 3, 0, 7); g.fill();
    }
  };
  const showTime = () => { scrub.value = T.t; clock.textContent = fmtT(T.t); play.textContent = video.paused ? '▶' : '❚❚'; draw(); readout(); };
  const seek = (t) => { T.t = Math.max(0, Math.min(T.dur || 0, t)); video.currentTime = T.t; showTime(); };
  scrub.addEventListener('input', () => { video.pause(); seek(parseFloat(scrub.value)); });
  let raf = 0;
  const tick = () => { T.t = video.currentTime; showTime(); if (!video.paused) raf = requestAnimationFrame(tick); };
  video.addEventListener('play', () => { cancelAnimationFrame(raf); tick(); });
  video.addEventListener('pause', showTime);
  video.addEventListener('seeked', () => { T.t = video.currentTime; showTime(); });
  video.addEventListener('loadedmetadata', () => {
    T.dur = video.duration || 0; T.ar = (video.videoWidth || 16) / (video.videoHeight || 9);
    stage.style.setProperty('--ar', T.ar);
    scrub.max = T.dur;
    const r = saved.result;
    T.to = Math.min(T.dur, T.to ?? (r ? r.start + r.n / r.fps : T.dur));
    if (!(T.to > T.from)) T.to = T.dur;
    seek(T.from); render();
  });

  // drawing a box on the picture: the mode says which one
  const pt = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))]; };
  let a = null;
  cv.addEventListener('pointerdown', (e) => { if (T.mode === 'none') return; a = pt(e); cv.setPointerCapture(e.pointerId); T.drag = [...a, ...a]; draw(); });
  cv.addEventListener('pointermove', (e) => { if (!a) return; const b = pt(e); T.drag = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; draw(); });
  const up = () => {
    if (!a) return;
    const b = T.drag; a = null; T.drag = null;
    if (b && b[2] - b[0] > 0.03 && b[3] - b[1] > 0.03) T[T.mode] = b;
    render(); draw();
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

  // the camera as it will be made, at the playhead
  const readout = () => {
    const el = $('#trkRead');
    if (!el || !T.result) return;
    const f = T.result.frames[idx()], sm = (k) => smooth(T.result.frames.map((x) => x[k]), T.set.sigma)[idx()];
    el.textContent = `Frame ${idx() + 1} / ${T.result.n}: shift ${f.tx.toFixed(0)}, ${f.ty.toFixed(0)} px · turn ${f.rot.toFixed(1)}° · zoom ${f.scale.toFixed(2)}× (smoothed ${sm('tx').toFixed(0)}, ${sm('ty').toFixed(0)} px)`;
  };

  let saveT = 0;
  const persist = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        doc = await api(docUrl(id), { method: 'PUT', busy: false, body: { name: opts.label || id, rev: doc?.rev ?? null, payload: { src, label: opts.label, result: T.result, set: T.set } } });
      } catch (e) { toast(`Couldn't keep the track: ${e.message}`, true); }
    }, 600);
  };

  async function run() {
    try {
      const r = await api('/api/track', { method: 'POST', busy: false, body: { src, project_id: S.project, start: T.from, end: T.to, region: T.region, exclude: T.exclude, method: T.set.method } });
      T.job = r.job; render();
      const poll = async () => {
        let s;
        try { s = await api(`/api/track/${T.job}`, { busy: false }); } catch (e) { T.job = null; render(); return toast(e.message, true); }
        prog.value = s.progress;
        if (s.state === 'running') { T.timer = setTimeout(poll, 400); return; }
        T.job = null;
        if (s.state === 'error') { render(); return toast(`Tracking: ${s.error}`, true); }
        T.result = s.result; persist(); seek(T.from); render();
      };
      poll();
    } catch (e) { toast(e.message, true); }
  }
  const stop = () => { clearTimeout(T.timer); if (T.job) api(`/api/track/${T.job}/cancel`, { method: 'POST', busy: false }).catch(() => {}); T.job = null; render(); };

  async function make() {
    const r = T.result;
    if (!r?.atlas) return toast('Track the clip again: this one has no footage picture', true);
    const sc = sceneFromTrack(r, T.set);
    closeSheet(); switchTab('scene');
    (await sceneModule()).open(sc, null, `Track: ${opts.label || 'clip'}`);
  }

  function render() {
    const r = T.result, busy = !!T.job, set = (k, v) => { T.set[k] = v; persist(); };
    prog.classList.toggle('hidden', !busy); prog.value = 0;
    const len = Math.max(0, (T.to ?? T.dur) - T.from);
    body.replaceChildren(
      field('Tracker', seg([['klt', 'Simple'], ['tapnext', 'TAPNext++']], T.set.method, (v) => set('method', v), { disabled: busy }),
        help('Simple follows corners on the server in seconds. TAPNext++ runs on the GPU through ComfyUI\'s queue: slower to start, but it keeps hold of points through blur, fast moves and things passing in front.')),
      field('Draw on the picture', seg([['region', 'Track inside'], ['exclude', 'Ignore (moving subject)']], T.mode, (m) => { T.mode = m; })),
      h('div', { class: 'row wrap' },
        button('Clear box', () => { T[T.mode] = null; render(); draw(); }, { cls: 'small ghost' }),
        button('Clear both', () => { T.region = T.exclude = null; render(); draw(); }, { cls: 'small ghost' })),
      h('div', { class: 'grid-2' },
        rangeField('Start', () => T.from, (v) => { T.from = Math.min(v, (T.to ?? T.dur) - 0.2); }, { min: 0, max: T.dur || 1, step: 0.04, fmt: fmtT, onChange: () => { seek(T.from); render(); } }),
        rangeField('End', () => T.to ?? T.dur, (v) => { T.to = Math.max(v, T.from + 0.2); }, { min: 0, max: T.dur || 1, step: 0.04, fmt: fmtT, onChange: () => { seek(T.to); render(); } })),
      h('div', { class: 'row' },
        busy ? button('Stop', stop, { cls: 'danger' }) : button(r ? 'Track again' : 'Track', run, { cls: 'primary', disabled: !T.dur || len < 0.2 }),
        h('span', { class: 'hint' }, `${fmtT(len)} of the clip${T.region ? ' · inside the box' : ''}${T.exclude ? ' · ignoring a box' : ''}`)),
      prog,
      ...(r ? [
        r.lost > r.n * 0.2 ? note(`The picture was hard to follow in ${r.lost} of ${r.n} frames: draw a box round steady background, or ignore a moving subject.`)
          : hint(`Followed ${r.tracks.length} points over ${r.n} frames${r.lost ? ` (lost it for ${r.lost})` : ''}. Scrub to check they stay on the picture.`),
        h('p', { class: 'hint', id: 'trkRead' }),
        h('div', { class: 'section-title' }, h('span', {}, 'Make a camera')),
        rangeField('Smoothing', () => T.set.sigma, (v) => set('sigma', v), { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} frames` : 'off'), onInput: readout }),
        field(['Lens (35mm equivalent)', h('span', {}, `${T.set.lens} mm`)],
          seg(LENSES, T.set.lens, (v) => { set('lens', v); render(); }),
          hint('Wider lens: the same shift in pixels is a bigger turn. If the 3D objects slide against the footage, change this.')),
        field('Zoom as', seg([['fov', 'Lens zoom'], ['dolly', 'Move forward']], T.set.zoomAs, (v) => { set('zoomAs', v); render(); })),
        T.set.zoomAs === 'dolly' ? rangeField('Subject distance', () => T.set.dist, (v) => set('dist', v), { min: 1, max: 30, step: 0.5, fmt: (v) => `${v} m` }) : null,
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: T.set.points, onchange: (e) => set('points', e.target.checked) }), 'Add the tracked points as dots in the scene'),
        hint('Roll isn\'t used: the 3D camera stays level. The footage card follows the camera, so objects you place stay on the footage as it moves.'),
        actions(button('Create 3D scene', make, { cls: 'primary' })),
      ] : [hint('Optionally draw a box round the steady background to track inside, and a box round anything moving that should be ignored. Then Track.')]));
    draw(); readout();
  }

  openSheet(
    h('h3', {}, 'Track motion', ' ', h('span', { class: 'hint' }, opts.label || '')),
    stage,
    h('div', { class: 'trk-bar' }, play, scrub, clock),
    body);
  render();
  const closing = new MutationObserver(() => { if (!stage.isConnected) { closing.disconnect(); clearTimeout(T.timer); cancelAnimationFrame(raf); video.pause(); } });
  closing.observe($('#sheet'), { childList: true });
}
