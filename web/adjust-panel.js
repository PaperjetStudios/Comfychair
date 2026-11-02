// ---------------------------------------------------------------------------
// adjust-panel: the Colour section of a layer or a clip: curves on a graph, the sliders, Auto and Match. It holds no colour
// math (adjust.js) and is kept between redraws of its panel, so a curve being worked on doesn't lose its place.
//   adjustPanel({ get, set, onInput, onChange, hist: async () => histogram of its own pixels,
//                 others: () => [[id, label]...], otherHist: async (id) => how that one looks, extra: () => more buttons })
//   -> { el, sync }
// ---------------------------------------------------------------------------
import { h, button, field, help, rangeField, section, seg, toast } from './ui.js';
import { maximizable } from './layout.js';
import { CHANNELS, NUMBERS, autoCurves, clean, curveFn, histThrough, matchCurves } from './adjust.js';

const CHANNEL_NAMES = [['m', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']];
const CHANNEL_COLOUR = { m: '#e8e8e8', r: '#ff5a5a', g: '#4fd67a', b: '#5a9bff' };
const STRAIGHT = () => [[0, 0], [1, 1]];

// the graph: drag a point, tap the line to add one, double-tap a point (or drag it off the graph) to take it away
function curveGraph({ points, setPoints, hist, onEnd }) {
  let channel = 'm';
  const cv = h('canvas', { class: 'curve-canvas', 'aria-label': 'Colour curve' });
  const pad = 8;
  const size = () => [cv.clientWidth || 260, cv.clientHeight || 200];
  const toPx = ([x, y]) => { const [w, hh] = size(); return [pad + x * (w - 2 * pad), pad + (1 - y) * (hh - 2 * pad)]; };
  const fromEvent = (e, r = cv.getBoundingClientRect()) => {
    return [(e.clientX - r.left - pad) / (r.width - 2 * pad), 1 - (e.clientY - r.top - pad) / (r.height - 2 * pad)];
  };
  function draw() {
    const [w, hh] = size(), dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hh);
    const [x0, y0] = toPx([0, 1]), [x1, y1] = toPx([1, 0]);
    c.fillStyle = '#0006'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    const counts = hist();
    if (counts) {   // what's in the picture, behind the curve
      const series = channel === 'm' ? counts.r.map((n, i) => n + counts.g[i] + counts.b[i]) : counts[channel];
      const top = Math.max(1, [...series].sort((a, b) => b - a)[3]);   // (not the top few, so one big spike doesn't flatten the rest)
      c.fillStyle = `${CHANNEL_COLOUR[channel]}40`;
      c.beginPath(); c.moveTo(x0, y1);
      series.forEach((n, i) => c.lineTo(x0 + (i / 255) * (x1 - x0), y1 - Math.min(1, n / top) * (y1 - y0)));
      c.lineTo(x1, y1); c.closePath(); c.fill();
    }
    c.strokeStyle = '#ffffff24'; c.lineWidth = 1; c.beginPath();
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (i / 4) * (x1 - x0), y = y0 + (i / 4) * (y1 - y0);
      c.moveTo(x, y0); c.lineTo(x, y1); c.moveTo(x0, y); c.lineTo(x1, y);
    }
    c.moveTo(x0, y1); c.lineTo(x1, y0);
    c.stroke();
    const line = (ch, width, alpha) => {
      const f = curveFn(points(ch));
      c.strokeStyle = CHANNEL_COLOUR[ch]; c.globalAlpha = alpha; c.lineWidth = width; c.beginPath();
      for (let i = 0; i <= 128; i++) {
        const [x, y] = toPx([i / 128, Math.max(0, Math.min(1, f(i / 128)))]);
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke(); c.globalAlpha = 1;
    };
    for (const ch of CHANNELS) if (ch !== channel) line(ch, 1, 0.4);
    line(channel, 2, 1);
    for (const p of points(channel)) {
      const [x, y] = toPx(p);
      c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1;
      c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill(); c.stroke();
    }
  }
  const nearest = (e) => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, reach = e.pointerType === 'mouse' ? 12 : 24;
    let best = -1, d = reach;
    points(channel).forEach((p, i) => { const [x, y] = toPx(p), q = Math.hypot(x - mx, y - my); if (q < d) { d = q; best = i; } });
    return best;
  };
  const removeAt = (i) => { const p = points(channel); if (i > 0 && i < p.length - 1) { setPoints(channel, p.filter((_, k) => k !== i)); draw(); onEnd(); } };
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    e.preventDefault(); e.stopPropagation();
    let i = nearest(e);
    const p = points(channel).map((q) => [...q]);
    if (i < 0) {   // a new point, on the curve where it was tapped
      const [x] = fromEvent(e), cx = Math.max(0, Math.min(1, x));
      i = p.findIndex((q) => q[0] > cx);
      if (i < 0) i = p.length;
      if ((p[i - 1] && cx - p[i - 1][0] < 0.015) || (p[i] && p[i][0] - cx < 0.015)) return;
      p.splice(i, 0, [cx, Math.max(0, Math.min(1, curveFn(p)(cx)))]);
      setPoints(channel, p); draw();
    }
    // (on the window, from where the graph was when it began: a redraw of the panel during the drag doesn't lose it)
    drag = { i, id: e.pointerId, rect: cv.getBoundingClientRect() };
    addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
  });
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.i < 0) return;
    const p = points(channel).map((q) => [...q]), [x, y] = fromEvent(e, drag.rect), { i } = drag;
    const lo = i > 0 ? p[i - 1][0] + 0.01 : 0, hi = i < p.length - 1 ? p[i + 1][0] - 0.01 : 1;
    p[i] = [Math.max(lo, Math.min(hi, x)), Math.max(0, Math.min(1, y))];
    const off = i > 0 && i < p.length - 1 && (y < -0.2 || y > 1.2);
    setPoints(channel, off ? p.filter((_, k) => k !== i) : p);
    if (off) drag.i = -1;   // (it's gone: the rest of the drag does nothing)
    draw();
  }
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
    onEnd();
  }
  cv.addEventListener('dblclick', (e) => removeAt(nearest(e)));
  const channelSeg = seg(CHANNEL_NAMES, channel, (ch) => { channel = ch; draw(); });
  const box = h('div', { class: 'curve-box' }, channelSeg, cv);
  maximizable(box, box, { title: 'Curves full screen', onChange: () => requestAnimationFrame(draw) });
  new ResizeObserver(() => draw()).observe(cv);
  return { box, draw };
}

export function adjustPanel({ get, set, onInput, onChange, hist, others = null, otherHist = null, extra = null }) {
  let counts = null, loaded = false, strength = 0.8, other = null;
  const working = {};   // the points being worked on, also those that come to a straight line (clean drops those)
  const points = (ch) => get()?.curves?.[ch] || working[ch] || STRAIGHT();
  const setPoints = (ch, pts) => {
    working[ch] = pts;
    const a = get() || {};
    set(clean({ ...a, curves: { ...a.curves, [ch]: pts } }));
    onInput();
  };
  const graph = curveGraph({ points, setPoints, hist: () => counts, onEnd: () => onChange() });
  const number = (k, label, min, max) => rangeField(label, () => get()?.[k] || 0, (v) => set(clean({ ...get(), [k]: v })),
    { min, max, step: k === 'hue' ? 1 : k === 'exposure' ? 0.02 : 0.01, fmt: k === 'hue' ? (v) => `${Math.round(v)}°` : (v) => (v > 0 ? '+' : '') + v.toFixed(2), onInput, onChange });
  const sliders = h('div', { class: 'adjust-sliders' });
  const matchBox = h('div', {});
  const ownHist = async () => { if (!loaded) { counts = await hist(); loaded = true; graph.draw(); } return counts; };
  const auto = async () => {
    try {
      const c = histThrough(await ownHist(), { ...get(), curves: null });   // (on top of what the sliders do)
      const curves = c && autoCurves(c);
      if (!curves) return toast('Not enough in the picture to go on', true);
      set(clean({ ...get(), curves })); onChange(); sync();
    } catch (e) { toast(e.message, true); }
  };
  const match = async (btn) => {
    const id = other ?? others?.()[0]?.[0];
    if (id == null) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Matching…';
    try {
      const [mine, theirs] = await Promise.all([ownHist(), otherHist(id)]);
      const curves = matchCurves(histThrough(mine, { ...get(), curves: null }), theirs, { strength });
      if (!curves) return toast('One of them has nothing showing to match', true);
      set(clean({ ...get(), curves })); onChange(); sync();
    } catch (e) { toast(`Match failed: ${e.message}`, true); } finally { btn.disabled = false; btn.textContent = label; }
  };
  function drawMatch() {
    const list = others?.() || [];
    if (!list.length) { matchBox.replaceChildren(...(extra?.(() => strength) || [])); return; }
    if (!list.some(([id]) => id === other)) other = list[0][0];
    const pick = h('select', { 'aria-label': 'Match the look of', onchange: (e) => { other = list.find(([id]) => String(id) === e.target.value)?.[0]; } },
      list.map(([id, label]) => h('option', { value: id, selected: id === other }, label)));
    const go = button('Match', (e) => match(e.currentTarget || go), { cls: 'small primary', title: 'Curves that give this the look of the one picked' });
    matchBox.replaceChildren(
      field('Match the look of', help('Makes curves that give this the brightness and colour spread of the one picked, so two shots look like the same camera. They show on the graph, so you can fine-tune them. It compares what is in the shots, so similar shots match best: lower Strength when the two show very different things.'), pick),
      rangeField('Strength', () => strength, (v) => { strength = v; }, { min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` }),
      h('div', { class: 'row wrap' }, go, extra?.(() => strength)));
  }
  function sync() {
    sliders.replaceChildren(...NUMBERS.map(([k, label, min, max]) => number(k, label, min, max)));
    drawMatch();
    graph.draw();
  }
  const el = section('Colour', null,
    help('Doesn\'t change the picture itself. Curves: drag a point, tap the line to add one, double-tap a point or drag it off the graph to take it away. Auto stretches each colour from black to white, which also takes out a colour cast.'),
    h('div', { class: 'row wrap' },
      button('Auto', auto, { cls: 'small', title: 'Black and white points of each colour, from the picture' }),
      button('Reset', () => { for (const ch of CHANNELS) delete working[ch]; set(null); onChange(); sync(); }, { cls: 'small' })),
    graph.box, sliders, matchBox);
  sync();
  ownHist().catch(() => {});
  return { el, sync };
}
