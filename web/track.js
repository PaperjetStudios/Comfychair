// Motion tracking sheet: follow how a clip's picture moves (app/tracking.py), look at the tracks over the
// video, and turn them into a 3D tab: a camera that makes the same move with the footage behind it
// (track-math.js). Opened from a clip in the Video tab or a video in History. The result is kept as a
// document of kind `tracks` (one per clip), so opening the sheet again doesn't track again.
import {
  $, api, actions, button, field, h, help, hint, note, openSheet, closeSheet, rangeField, seg, toast, toggle, canvasFont, setIcon,
} from './ui.js';
import { fmtTime } from './playback.js';
import { S, fmtT, switchTab } from './core.js';
import { currentTab } from './navigation.js';
import { sceneModule } from './run.js';
import { sceneFromSolve, sceneFromTrack, smooth, worldFromSolve } from './track-math.js';

const KIND = 'tracks';
const LENSES = [[24, '24'], [28, '28'], [35, '35'], [50, '50'], [85, '85']];
const SOLVERS = [['none', 'Camera only'], ['pnp', 'PnP + MoGe'], ['da3', 'Depth Anything 3']];
const DA3 = { small: 'depth_anything_3_small.safetensors', base: 'depth_anything_3_base.safetensors' };
const SOLVE_NAME = { pnp: 'PnP', da3: 'DA3' };
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (id) => `/api/store/${KIND}/${id}${qs()}`;
const hash = (s) => { let x = 5381; for (const c of s) x = ((x * 33) ^ c.charCodeAt(0)) >>> 0; return x.toString(36); };
// one document per clip
export const keyFor = (src) => (src.generation != null ? `g${src.generation}_${src.index || 0}` : `m_${hash(String(src.media || src.clip || ''))}`);
export const canTrack = (src) => !!src && (src.generation != null || !!src.media);

// opts: { src: { generation, index } | { media }, url, label, from, to, frame?, onScene? } (from / to: seconds of the clip to
// start with; frame: the table frame the clip is in, the new 3D frame goes beside it; onScene(sc, name): where Create 3D
// scene's scene goes instead of a new 3D frame on the table, or a 3D tab on the Classic screens)
export async function openTrack(opts) {
  const { src } = opts, id = keyFor(src);
  let doc = null;
  // (the list first: asking for a document that isn't there would log a 404)
  const have = await api(`/api/store/${KIND}${qs()}`, { busy: false }).catch(() => []);
  if (have.some((d) => d.id === id)) doc = await api(docUrl(id), { busy: false }).catch(() => null);
  const saved = doc?.payload || {};
  const T = {
    result: saved.result || null, solves: saved.solves || {}, jobKind: null, stabbing: false, dur: 0, ar: 16 / 9, mode: 'region', t: 0, playing: false, job: null, timer: 0,
    region: saved.result?.region || null, exclude: saved.result?.exclude || null,
    from: opts.from ?? saved.result?.start ?? 0, to: opts.to ?? null,
    set: { sigma: 2, stabSigma: 6, lens: 35, zoomAs: 'fov', dist: 6, points: true, cloud: true, method: 'klt',
      stab: 'smooth', stabRoll: true, stabZoom: 'auto', solve: 'none', views: 32, da3: 'small', scale: 1, ...saved.set },
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
      g.setLineDash([]); g.fillStyle = col; g.font = canvasFont(12); g.fillText(label, b[0] * w + 4, b[1] * hh + 14);
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
    // the solved points put back through the solved camera at this moment (hollow): they should sit on the footage
    const sv = T.solves[T.set.solve];
    if (!sv?.cams?.length) return;
    const c = sv.cams[Math.max(0, Math.min(sv.cams.length - 1, Math.round((T.t - (sv.start || 0)) * (sv.fps || 24))))], [fx, fy, cx, cy] = sv.K, [SW, SH] = sv.size;
    g.strokeStyle = '#5ad1ff'; g.lineWidth = 1;
    for (const X of sv.pts || []) {
      const d = [X[0] - c[3], X[1] - c[7], X[2] - c[11]];
      const zc = c[2] * d[0] + c[6] * d[1] + c[10] * d[2];
      if (zc <= 0.01) continue;
      const u = (fx * (c[0] * d[0] + c[4] * d[1] + c[8] * d[2]) / zc + cx) / SW, v = (fy * (c[1] * d[0] + c[5] * d[1] + c[9] * d[2]) / zc + cy) / SH;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      g.beginPath(); g.arc(u * w, v * hh, 3.5, 0, 7); g.stroke();
    }
  };
  const showTime = () => { scrub.value = T.t; clock.textContent = fmtTime(T.t); setIcon(play, video.paused ? '▶' : '❚❚'); draw(); readout(); };
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
    // (smoothed from where the camera starts, as cameraRows makes it)
    const f = T.result.frames[idx()], sm = (k) => { const a = smooth(T.result.frames.map((x) => x[k]), T.set.sigma); return a[idx()] - a[0]; };
    el.textContent = `Frame ${idx() + 1} / ${T.result.n}: shift ${f.tx.toFixed(0)}, ${f.ty.toFixed(0)} px · turn ${f.rot.toFixed(1)}° · zoom ${f.scale.toFixed(2)}× (smoothed ${sm('tx').toFixed(0)}, ${sm('ty').toFixed(0)} px)`;
  };

  let saveT = 0;
  const persist = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        doc = await api(docUrl(id), { method: 'PUT', busy: false, body: { name: opts.label || id, rev: doc?.rev ?? null, payload: { src, label: opts.label, result: T.result, set: T.set, solves: T.solves } } });
      } catch (e) { toast(`Couldn't keep the track: ${e.message}`, true); }
    }, 600);
  };

  // a server job (tracking or solving) polled until done; done(result) takes the result
  async function startJob(kind, url, payload, done) {
    try {
      const r = await api(url, { method: 'POST', busy: false, body: payload });
      T.job = r.job; T.jobKind = kind; render();
      const poll = async () => {
        let s;
        try { s = await api(`/api/track/${T.job}`, { busy: false }); } catch (e) { T.job = null; render(); return toast(e.message, true); }
        prog.value = s.progress;
        if (s.state === 'running') { T.timer = setTimeout(poll, 400); return; }
        T.job = null;
        if (s.state === 'error') { render(); return toast(`${kind === 'solve' ? 'Solving' : 'Tracking'}: ${s.error}`, true); }
        done(s.result);
      };
      poll();
    } catch (e) { toast(e.message, true); }
  }
  const run = () => startJob('track', '/api/track', { src, project_id: S.project, start: T.from, end: T.to, region: T.region, exclude: T.exclude, method: T.set.method },
    (res) => { T.result = res; persist(); seek(T.from); render(); });
  const solve = () => {
    const method = T.set.solve;
    startJob('solve', '/api/track/solve', { src, project_id: S.project, start: T.from, end: T.to, region: T.region, exclude: T.exclude, method,
      tracker: T.set.method, views: T.set.views, model: DA3[T.set.da3] || DA3.small },
    (res) => { T.solves = { ...T.solves, [method]: res }; persist(); render(); });
  };
  const stop = () => { clearTimeout(T.timer); if (T.job) api(`/api/track/${T.job}/cancel`, { method: 'POST', busy: false }).catch(() => {}); T.job = null; render(); };

  // a steadied copy of the tracked span, made on the server from the track: it lands in History
  async function stabilise() {
    const r = T.result;
    T.stabbing = true; render();
    try {
      await api('/api/video/stabilise', { method: 'POST', busy: 'Stabilising…', timeout: 900000, body: {
        src, project_id: S.project, start: r.start, end: r.start + r.n / r.fps, track: { frames: r.frames, size: r.size, fps: r.fps, start: r.start },
        sigma: T.set.stabSigma, mode: T.set.stab, roll: T.set.stabRoll, zoom: T.set.stabZoom, label: opts.label } });
      toast('Stabilised clip saved to History');
    } catch (e) { toast(`Stabilising: ${e.message}`, true); }
    T.stabbing = false; render();
  }

  // what a solve came to, and a warning when it is shaky
  const solveInfo = (sv) => {
    // camera 0's height over the floor in the scene's metres: what worldFromSolve scales it to (a DA3 solve has no units of its own)
    const q = sv.quality || {}, h = sv.floor ? sv.floor.d / (Math.hypot(...sv.floor.n) || 1) * worldFromSolve(sv, { scale: T.set.scale }).s : null;
    const line = [`Solved ${sv.n} frames`, `used ${q.used ?? '?'} points`, `median error ${(q.err ?? 0).toFixed(1)} px`,
      sv.floor ? 'floor found' : 'no floor', h != null ? `camera height ${h.toFixed(2)} m` : null,
      q.drift != null ? `moves ${(q.drift * 100).toFixed(1)} %/frame` : null, q.anchors != null ? `${q.anchors} anchors` : null,
      sv.cloud?.length ? `${String(sv.cloud.length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} scene points` : null].filter(Boolean).join(' · ');
    const warn = [];
    if (q.err > 4) warn.push(`The points miss by ${q.err.toFixed(1)} px on average: objects may slide against the footage. Track inside a box of steady background, or try the other method.`);
    if (q.lost > sv.n * 0.1) warn.push(`The camera was lost in ${q.lost} of ${sv.n} frames and held still there.`);
    return [hint(line), ...warn.map((w) => note(w))];
  };

  async function make() {
    const r = T.result;
    if (!r?.atlas) return toast('Track the clip again: this one has no footage picture', true);
    const sv = T.set.solve !== 'none' ? T.solves[T.set.solve] : null;
    const tag = `_${Date.now().toString(36)}`;   // (layer ids of their own: see track-math.js sceneOf)
    const sc = sv ? sceneFromSolve(sv, r, { ...T.set, tag }) : sceneFromTrack(r, { ...T.set, tag });
    const name = `Track${sv ? ` (${SOLVE_NAME[T.set.solve]})` : ''}: ${opts.label || 'clip'}`;
    closeSheet();
    // on the table: a new 3D frame (beside opts.frame when given: frame-scene.js trackToScene); the Classic screens: a 3D tab
    if (opts.onScene) return opts.onScene(sc, name);
    if (currentTab() === 'table') return (await import('./frame-scene.js')).sceneFrameFrom(sc, { label: name, beside: opts.frame || null });
    switchTab('scene');
    (await sceneModule()).open(sc, null, name);
  }

  function render() {
    const r = T.result, busy = !!T.job, set = (k, v) => { T.set[k] = v; persist(); };
    prog.classList.toggle('hidden', !busy); prog.value = 0;
    const sv = T.set.solve !== 'none' ? T.solves[T.set.solve] : null, solving = busy && T.jobKind === 'solve';
    const len = Math.max(0, (T.to ?? T.dur) - T.from);
    body.replaceChildren(...[
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
        busy && !solving ? button('Stop', stop, { cls: 'danger' }) : button(r ? 'Track again' : 'Track', run, { cls: 'primary', disabled: busy || !T.dur || len < 0.2 }),
        h('span', { class: 'hint' }, `${fmtT(len)} of the clip${T.region ? ' · inside the box' : ''}${T.exclude ? ' · ignoring a box' : ''}`)),
      solving ? null : prog,
      ...(r ? [
        r.lost > r.n * 0.2 ? note(`The picture was hard to follow in ${r.lost} of ${r.n} frames: draw a box round steady background, or ignore a moving subject.`)
          : hint(`Followed ${r.tracks.length} points over ${r.n} frames${r.lost ? ` (lost it for ${r.lost})` : ''}. Scrub to check they stay on the picture.`),
        h('p', { class: 'hint', id: 'trkRead' }),
        h('div', { class: 'section-title' }, h('span', {}, 'Stabilise')),
        field('Steady', seg([['smooth', 'Smooth'], ['lock', 'Lock']], T.set.stab, (v) => { set('stab', v); render(); }, { disabled: T.stabbing }),
          help('Smooth keeps the camera\'s move but takes out the shake (the Smoothing slider sets how much). Lock holds the first frame\'s framing for the whole span, as if the camera were on a tripod. Auto zoom crops in just enough to hide the moving borders; None keeps the full size and shows them.')),
        T.set.stab === 'smooth' ? rangeField('Smoothing', () => T.set.stabSigma, (v) => set('stabSigma', v), { min: 0, max: 30, step: 0.5, fmt: (v) => (v ? `${v} frames` : 'off') }) : null,
        toggle('Correct roll', T.set.stabRoll, (on) => set('stabRoll', on), { help: 'Also takes out the tilt as the camera rocks side to side. Off keeps the picture\'s own roll and only steadies the shift and zoom.' }),
        field('Zoom', seg([['auto', 'Auto'], ['none', 'None']], T.set.stabZoom, (v) => set('stabZoom', v), { disabled: T.stabbing })),
        actions(button(T.stabbing ? 'Stabilising…' : 'Stabilise', stabilise, { cls: 'primary', disabled: T.stabbing })),
        h('div', { class: 'section-title' }, h('span', {}, 'Solve 3D camera')),
        field('Method', seg(SOLVERS, T.set.solve, (v) => { set('solve', v); render(); draw(); }, { disabled: busy }),
          help('Camera only: the turn-and-zoom camera made from the 2D track, quick, but with no depth. PnP + MoGe: measures depth in metres from one frame and follows the camera from it; good for short shots, it can drift on long ones. Depth Anything 3: solves cameras for frames sampled through the span together, so they stay consistent; its size is relative, so set Scale.')),
        T.set.solve === 'da3' ? h('div', { class: 'grid-2' },
          rangeField('Views', () => T.set.views, (v) => set('views', v), { min: 8, max: 64, step: 8, fmt: (v) => `${v} frames`,
            help: 'How many frames Depth Anything 3 looks at together. More is steadier and slower, and needs more GPU memory.' }),
          field('Model', seg([['small', 'Small'], ['base', 'Base']], T.set.da3, (v) => set('da3', v), { disabled: busy }),
            help('Small is quicker and lighter on GPU memory. Base is more accurate on hard shots.'))) : null,
        T.set.solve !== 'none' ? rangeField('Scale', () => T.set.scale, (v) => set('scale', v), { min: 0.25, max: 4, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, onChange: render,
          help: `Multiplies the size of the solved scene. PnP + MoGe is measured in metres, so 1 is life size. Depth Anything 3 has no units: 1 puts the camera 1.5 m above the floor it found, or, with no floor, the tracked points ${T.set.dist} m away on average.` }) : null,
        T.set.solve !== 'none' ? actions(
          solving ? button('Stop', stop, { cls: 'danger' }) : button(sv ? 'Solve again' : 'Solve', solve, { cls: 'primary', disabled: busy || !T.dur || len < 0.2 })) : null,
        solving ? prog : null,
        ...(sv ? solveInfo(sv) : []),
        h('div', { class: 'section-title' }, h('span', {}, 'Make a camera')),
        ...(sv ? [] : [
          rangeField('Smoothing', () => T.set.sigma, (v) => set('sigma', v), { min: 0, max: 12, step: 0.5, fmt: (v) => (v ? `${v} frames` : 'off'), onInput: readout, onChange: render }),
          field(['Lens (35mm equivalent)', h('span', {}, `${T.set.lens} mm`)],
            help('Wider lens: the same shift in pixels is a bigger turn. If the 3D objects slide against the footage, change this.'),
            seg(LENSES, T.set.lens, (v) => { set('lens', v); render(); })),
          field('Zoom as', help('Roll isn\'t used: the 3D camera stays level. The footage card follows the camera, so objects you place stay on the footage as it moves.'),
            seg([['fov', 'Lens zoom'], ['dolly', 'Move forward']], T.set.zoomAs, (v) => { set('zoomAs', v); render(); })),
          T.set.zoomAs === 'dolly' ? rangeField('Subject distance', () => T.set.dist, (v) => set('dist', v), { min: 1, max: 30, step: 0.5, fmt: (v) => `${v} m` }) : null]),
        toggle('Add the tracked points as dots in the scene', T.set.points, (on) => set('points', on)),
        sv?.cloud?.length ? toggle('Add the scene\'s points as a cloud', T.set.cloud, (on) => set('cloud', on)) : null,
        actions(button(sv ? `Create 3D scene (${SOLVE_NAME[T.set.solve]})` : 'Create 3D scene', make, { cls: 'primary' })),
      ] : [hint('Optionally draw a box round the steady background to track inside, and a box round anything moving that should be ignored. Then Track.')]),
    ].filter((x) => x != null));   // (replaceChildren would show a null as the text "null")
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
