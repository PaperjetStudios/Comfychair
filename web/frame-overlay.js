// Marks placed on a live video frame's picture for an Edit op (points, boxes, paths, a colour picked from it), and a
// compare of the frame's clip with a result. Mounted over the frame's viewer (frame-video.js mountOverlay). Marks are
// fractions of the frame's picture (0..1), so they hold at any zoom; they are the op's state on that frame
// (frame.ops[op], edit-ops.js keeps them). The handlers are the VFX tab's (vfx.js wireOverlay, boxDown…), lifted.
//
//   overlay.show(frame, { tools, value, onChange, time, tool })
//        tools: what may be placed ('points' | 'boxes' | 'paths' | 'color'); value: { points, pointsAt, boxes, tracks, key };
//        onChange(value) after each change; time(): seconds into the source clip at the playhead (points keep it);
//        tool: the one in use now (null: look only; left out: as it was)
//   overlay.tool(name | null), overlay.neg(on)   the tool in use; points that leave out (Exclude)
//   overlay.compare(a, b, { labels })            two clip urls wiped across (or side by side); compare(null) closes it
//   overlay.hide()                               marks and compare away
//   overlay.state()                              { frame, tool, neg, comparing }
// A painted matte is not one of its tools: no VFX template takes a still matte (a matte is a clip).
import { h, clamp, button, seg, info } from './ui.js';
import { snap, snapOn, snapBar } from './gizmo.js';
import { sideTag, wipeLine } from './compare.js';
import { snapBox } from './vfx-rules.js';
import { mountOverlay } from './frame-video.js';
import { framePixel, frameRect } from './video.js';

const O = { frame: null, tools: [], tool: null, neg: false, value: null, onChange: null, time: null,
  el: null, cv: null, bar: null, raf: 0, key: '', box: null, stroke: null, cmp: null };
const copy = (v) => JSON.parse(JSON.stringify(v ?? {}));
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* pointer gone */ } };
const NAME = { points: 'Points', boxes: 'Boxes', paths: 'Paths', color: 'Key colour' };
const HINT = { points: 'Tap the thing (Exclude: what to leave out)', boxes: 'Drag over the mark; drag a box to move it, its corner to size it, ✕ to remove it',
  paths: 'Drag from a thing to where it should go', color: 'Tap the screen colour' };

function ensureEl() {
  if (O.el) return O.el;
  O.cv = h('canvas', { class: 'fov-cv' });
  O.bar = h('div', { class: 'fov-bar' });
  O.el = h('div', { class: 'frame-ov' }, O.cv, O.bar);
  wire();
  return O.el;
}

function show(frame, { tools = [], value = {}, onChange = null, time = null, tool } = {}) {
  O.frame = frame; O.tools = tools; O.value = copy(value); O.onChange = onChange; O.time = time;
  if (tool !== undefined) O.tool = tools.includes(tool) ? tool : null;
  else if (!tools.includes(O.tool)) O.tool = null;
  ensureEl();
  O.key = '';
  loop();
  drawBar();
}
function setTool(name) { O.tool = O.tools.includes(name) ? name : null; O.key = ''; drawBar(); }
function setNeg(on) { O.neg = !!on; }

function hide() {
  O.frame = null; O.tool = null; O.box = null; O.stroke = null;
  cancelAnimationFrame(O.raf); O.raf = 0;
  O.el?.remove();
  closeCompare();
}

// where the picture is, inside the overlay (css px); kept up to date while shown (zoom, pan, resize)
function geom() {
  const r = frameRect(), e = O.el?.getBoundingClientRect();
  if (!r || !e?.width) return null;
  return { x: r.left - e.left, y: r.top - e.top, w: r.width, h: r.height, ew: e.width, eh: e.height, r };
}
function loop() {
  cancelAnimationFrame(O.raf);
  const tick = () => {
    O.raf = 0;
    if (!O.frame) return;
    if (!O.el.isConnected) mountOverlay(O.frame, O.el);
    if (O.el.isConnected) {
      O.el.classList.toggle('on', !!O.tool);
      const g = geom(), k = g ? [g.x, g.y, g.w, g.h, g.ew, g.eh, O.tool, snap.grid, snap.gridPct].map((v) => (typeof v === 'number' ? v.toFixed(1) : String(v))).join() : '';
      if (k !== O.key) { O.key = k; paint(); }
    }
    O.raf = requestAnimationFrame(tick);
  };
  O.raf = requestAnimationFrame(tick);
}

function paint() {
  const cv = O.cv, g = geom();
  if (!cv || !g) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(g.ew * dpr) || cv.height !== Math.round(g.eh * dpr)) { cv.width = Math.round(g.ew * dpr); cv.height = Math.round(g.eh * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, g.ew, g.eh);
  const X = (fx) => g.x + fx * g.w, Y = (fy) => g.y + fy * g.h, v = O.value || {};
  if (O.tool === 'boxes' && snap.grid) {   // the grid boxes snap to
    const gx = snap.gridPct / 100, gy = gx * (g.w / g.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = gx; x < 1; x += gx) { ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(1)); }
    for (let y = gy; y < 1; y += gy) { ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(1), Y(y)); }
    ctx.stroke();
  }
  if (O.tools.includes('points')) {
    const dot = (p, col) => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); };
    (v.points?.positive || []).forEach((p) => dot(p, '#43a047'));
    (v.points?.negative || []).forEach((p) => dot(p, '#e53935'));
  }
  if (O.tools.includes('boxes')) {
    for (const b of [...(v.boxes || []), ...(O.box ? [O.box.b] : [])]) {
      const [x, y, w, hh] = [X(b.x), Y(b.y), b.w * g.w, b.h * g.h];
      ctx.fillStyle = 'rgba(229, 57, 53, 0.18)'; ctx.fillRect(x, y, w, hh);
      ctx.lineWidth = 2; ctx.strokeStyle = '#e53935'; ctx.strokeRect(x, y, w, hh);
      if (O.tool === 'boxes') {   // the corner to size it, and ✕ to remove it
        ctx.fillStyle = '#e53935'; ctx.fillRect(x + w - 7, y + hh - 7, 14, 14);
        ctx.beginPath(); ctx.arc(x + w, y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(x + w - 4, y - 4); ctx.lineTo(x + w + 4, y + 4); ctx.moveTo(x + w + 4, y - 4); ctx.lineTo(x + w - 4, y + 4); ctx.stroke();
      }
    }
  }
  if (O.tools.includes('paths')) {
    for (const tr of [...(v.tracks || []), ...(O.stroke ? [O.stroke] : [])]) {
      if (!tr.length) continue;
      ctx.strokeStyle = '#fdd835'; ctx.lineWidth = 3; ctx.beginPath();
      tr.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.stroke();
      const a = tr[tr.length - 1], b = tr[Math.max(0, tr.length - 2)];
      const ang = Math.atan2((a.y - b.y) * g.h, (a.x - b.x) * g.w);
      ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(a.x) - 12 * Math.cos(ang - 0.5), Y(a.y) - 12 * Math.sin(ang - 0.5));
      ctx.lineTo(X(a.x) - 12 * Math.cos(ang + 0.5), Y(a.y) - 12 * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fillStyle = '#fdd835'; ctx.fill();
      ctx.beginPath(); ctx.arc(X(tr[0].x), Y(tr[0].y), 5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// the bar over the picture while a tool is in use: what to do, Done, and (boxes) the snapping chips
function drawBar() {
  if (!O.bar) return;
  if (!O.tool) { O.bar.replaceChildren(); O.bar.classList.add('hidden'); return; }
  O.bar.classList.remove('hidden');
  O.bar.replaceChildren(...[h('span', { class: 'fov-tool' }, NAME[O.tool] || ''), info(HINT[O.tool] || '', 'How'),
    O.tool === 'boxes' ? snapBar(['grid', 'edges'], () => { O.key = ''; }) : null,
    button('Done', () => { setTool(null); dispatchEvent(new CustomEvent('overlay:tool', { detail: { tool: null } })); }, { cls: 'small' })].filter(Boolean));
}

function commit() {
  O.key = '';
  paint();
  O.onChange?.(copy(O.value));
}

// a path as at most 8 control points (the tracks node splines through them)
function simplify(pts) {
  if (pts.length <= 8) return pts;
  const out = [];
  for (let i = 0; i < 8; i++) out.push(pts[Math.round((i * (pts.length - 1)) / 7)]);
  return out;
}

function wire() {
  const cv = O.cv;
  const pt = (ev) => { const g = geom(); return g ? { x: clamp((ev.clientX - g.r.left) / g.r.width, 0, 1), y: clamp((ev.clientY - g.r.top) / g.r.height, 0, 1) } : null; };
  cv.addEventListener('pointerdown', (ev) => {
    if (!O.tool) return;
    ev.preventDefault(); ev.stopPropagation();
    const p = pt(ev), v = O.value;
    if (!p) return;
    if (O.tool === 'points') {
      const pts = (v.points ||= { positive: [], negative: [] });
      (pts[O.neg ? 'negative' : 'positive'] ||= []).push(p);
      v.pointsAt = Number(O.time?.()) || 0;
      commit(); return;
    }
    if (O.tool === 'color') {
      const c = framePixel(p.x, p.y);
      if (c) { v.key = { ...(v.key || {}), color: c }; setTool(null); dispatchEvent(new CustomEvent('overlay:tool', { detail: { tool: null } })); commit(); }
      return;
    }
    if (O.tool === 'paths') { capture(cv, ev.pointerId); O.stroke = [p]; paint(); return; }
    if (O.tool === 'boxes') boxDown(p, ev);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!O.box && !O.stroke) return;
    const p = pt(ev);
    if (!p) return;
    if (O.box) boxMove(p, ev);
    else { const l = O.stroke[O.stroke.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) > 0.01) { O.stroke.push(p); paint(); } }
  });
  const up = () => {
    if (O.box) boxUp();
    if (O.stroke) { const s = O.stroke; O.stroke = null; if (s.length > 1) { (O.value.tracks ||= []).push(simplify(s)); commit(); } else paint(); }
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}

// boxes: drag on the picture for a new one; on a box to move it, on its corner to size it; ✕ removes it
function boxDown(p, ev) {
  const g = geom(), near = (ax, ay, px) => Math.hypot((p.x - ax) * g.w, (p.y - ay) * g.h) < px;
  const boxes = (O.value.boxes ||= []);
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (near(b.x + b.w, b.y, 14)) { boxes.splice(i, 1); commit(); return; }
    const corner = near(b.x + b.w, b.y + b.h, 18), inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    if (corner || inside) {
      boxes.splice(i, 1);
      O.box = { mode: corner ? 'size' : 'move', p0: p, b0: { ...b }, b: { ...b } };
      capture(O.cv, ev.pointerId); paint(); return;
    }
  }
  O.box = { mode: 'new', p0: p, b: { x: p.x, y: p.y, w: 0, h: 0 } };
  capture(O.cv, ev.pointerId);
}
function boxMove(p, ev) {
  const B = O.box, { p0, b0 } = B, g = geom();
  let b;
  if (B.mode === 'new') b = { x: Math.min(p.x, p0.x), y: Math.min(p.y, p0.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
  else if (B.mode === 'move') b = { ...b0, x: clamp(b0.x + p.x - p0.x, 0, 1 - b0.w), y: clamp(b0.y + p.y - p0.y, 0, 1 - b0.h) };
  else b = { ...b0, w: clamp(b0.w + p.x - p0.x, 0.01, 1 - b0.x), h: clamp(b0.h + p.y - p0.y, 0.01, 1 - b0.y) };
  B.b = snapBox(B.mode, b, { grid: snapOn('grid', ev), gridPct: snap.gridPct, edges: snapOn('edges', ev), W: g?.w || 1, H: g?.h || 1, others: O.value.boxes || [] });
  paint();
}
function boxUp() {
  const { b } = O.box;
  O.box = null;
  if (b.w > 0.005 && b.h > 0.005) (O.value.boxes ||= []).push(b);
  commit();
}

// ---- compare: the frame's clip (a) and a result (b), wiped across or side by side, over the viewer ----
function compare(a, b, { labels = ['Source', 'Result'] } = {}) {
  closeCompare();
  if (!a || !b || !O.frame) return false;
  const C = O.cmp = { layout: 'wipe', wipe: 0.5, el: null };
  const va = h('video', { src: a, muted: true, playsInline: true, preload: 'auto', loop: true, class: 'vfx-a' });
  const vb = h('video', { src: b, muted: true, playsInline: true, preload: 'auto', loop: true, class: 'vfx-b' });
  const media = h('div', { class: 'vfx-media' }, va, vb, wipeLine(), sideTag(labels[0], 'l'), sideTag(labels[1], 'r'));
  const setWipe = (x) => {   // each side clipped, so a see-through result shows the checkerboard, not the source under it
    C.wipe = x;
    vb.style.clipPath = C.layout === 'wipe' ? `inset(0 0 0 ${x * 100}%)` : '';
    va.style.clipPath = C.layout === 'wipe' ? `inset(0 ${(1 - x) * 100}% 0 0)` : '';
    media.style.setProperty('--w', `${x * 100}%`);
  };
  let wiping = false;
  const at = (ev) => { const r = media.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1); };
  media.addEventListener('pointerdown', (ev) => { if (C.layout !== 'wipe') return; ev.stopPropagation(); wiping = true; capture(media, ev.pointerId); setWipe(at(ev)); });
  media.addEventListener('pointermove', (ev) => { if (wiping) setWipe(at(ev)); });
  const stopWipe = () => { wiping = false; };
  media.addEventListener('pointerup', stopWipe); media.addEventListener('pointercancel', stopWipe);
  vb.addEventListener('timeupdate', () => { if (Math.abs(va.currentTime - vb.currentTime) > 0.15) va.currentTime = vb.currentTime; });
  const play = button('Play', () => {
    if (vb.paused) { va.currentTime = vb.currentTime; vb.play().catch(() => {}); va.play().catch(() => {}); play.textContent = 'Pause'; }
    else { vb.pause(); va.pause(); play.textContent = 'Play'; }
  }, { cls: 'small' });
  const layout = seg([['wipe', 'Wipe'], ['side', 'Side by side']], C.layout, (v) => {
    C.layout = v; media.classList.toggle('side', v === 'side'); setWipe(C.wipe);
  });
  C.el = h('div', { class: 'frame-cmp' }, h('div', { class: 'frame-cmp-stage' }, media),
    h('div', { class: 'fov-bar frame-cmp-bar' }, layout, play, info('Drag across the picture to wipe between the two.', 'Compare'),
      button('Close', () => { closeCompare(); dispatchEvent(new CustomEvent('overlay:compare', { detail: { open: false } })); }, { cls: 'small' })));
  setWipe(0.5);
  if (!mountOverlay(O.frame, C.el)) { O.cmp = null; return false; }
  return true;
}
function closeCompare() {
  const C = O.cmp;
  O.cmp = null;
  if (!C) return;
  for (const v of C.el.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
  C.el.remove();
}

addEventListener('table:unlive', (e) => { if (O.frame && e.detail?.frame?.id === O.frame.id) hide(); });

export const overlay = {
  show, hide, compare: (a, b, o) => (a ? compare(a, b, o) : (closeCompare(), false)), tool: setTool, neg: setNeg,
  state: () => ({ frame: O.frame, tool: O.tool, neg: O.neg, comparing: !!O.cmp }),
};
