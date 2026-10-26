import * as FIGURE from './figure.js';
import { maximizable } from './layout.js';
import { $, button, h, sheetOpen, store, toast } from './ui.js';
import {
  CAM, FPS, R, ROOM, SC, TEMP, TYPES, addKey, frames, keyTarget, namesFor, sample, selItem, setMute
} from './scene-data.js';
import {
  EASES, allKeys, bounds, chanOf, copy, isScalar, kindOf, moveBy, paste, prune, remove, restore, scaleAround, setChan, setEase, snapshot
} from './scene-keyops.js';
import { changed, draw, pose, select } from './scene-view.js';
import { busy, play, seek, stopPlay } from './scene-export.js';
import { setAutoKey } from './scene-ui.js';
import { modeOf } from './scene-modes.js';

// ---- the key sheet: a Blender-style dope sheet and a simple graph editor over the layers' keys -----
// A row per layer (the camera, then the objects). Tap a key to select it, drag it to move the whole
// selection; drag empty space to box-select (a finger pans unless Box is on); the ruler scrubs; two
// fingers (or Ctrl+wheel) zoom the time axis. Every gesture is ONE undo step: keys move live from a
// snapshot (scene-keyops.js), and changed() saves once on letting go.
const PAD = 8, GP = 14;   // px at each end of a row; px above and below the graph's plot
export const SEL = new Set();   // the selected key objects (an undo or a deleted layer drops them)
const UI = { box: false, add: false, tool: 'move', mode: store.get('deck.scene.keymode', 'dope'), unit: store.get('deck.scene.keyunit', 's'),
  snap: store.get('deck.scene.keysnap', false) };
const G = { ch: 'py' };  // the graph's channel
const V = { a: 0, b: 1, fit: true };   // the frames on show

const layers = () => [{ item: SC.camera, id: null, kind: 'cam', names: CAM, label: '🎥 Camera' },
  ...SC.objects.map((o) => ({ item: o, id: o.id, kind: kindOf(o), names: namesFor(o), label: `${TYPES[o.type].icon} ${o.name}` }))];
const shown = () => (modeOf().lanes === 'camera' ? layers().slice(0, 1) : layers());
const span = () => Math.max(1, frames() - 1);

function clampV() {
  const n = span();
  if (V.fit) { V.a = 0; V.b = n; return; }
  const w = Math.min(n, Math.max(Math.min(8, n), V.b - V.a));
  const a = Math.max(0, Math.min(n - w, V.a));
  V.a = a; V.b = a + w;
  if (w >= n) V.fit = true;
}
const lanePos = (f) => { clampV(); return `calc(${PAD}px + (100% - ${2 * PAD}px) * ${(f - V.a) / (V.b - V.a)})`; };
const lanesEl = () => $('#sceneLanes');
const pxf = () => Math.max(0.01, ((lanesEl()?.clientWidth || 300) - 2 * PAD) / (V.b - V.a));
function frameAtX(x) {
  const r = lanesEl().getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(span(), V.a + (x - r.left - PAD) / pxf())));
}

// ---- graph channels ---------------------------------------------------------------------------
function gLayer() {
  const [it] = keyTarget(), sh = shown();
  return sh.find((L) => L.item === (it || SC.camera)) || sh[0];
}
function channels(L) {
  const out = L.names.filter(isScalar);
  if (L.kind === 'figure') for (const p of Object.keys(FIGURE.PARAMS)) if (L.item.keys.some((k) => k.m && k.m[p] != null)) out.push(`m.${p}`);
  return out;
}
const chLabel = (ch) => (ch.startsWith('m.') ? (FIGURE.PARAMS[ch.slice(2)]?.label || ch.slice(2)) : { x: 'X', y: 'Up', z: 'Z', rx: 'Rot X', ry: 'Rot Y', rz: 'Rot Z', sx: 'Width', sy: 'Height', sz: 'Depth',
  px: 'Cam X', py: 'Cam height', pz: 'Cam Z', tx: 'Aim X', ty: 'Aim Y', tz: 'Aim Z', fov: 'Lens', roll: 'Roll' }[ch] || ch);
const sampleCh = (L, ch, f) => chanOf(sample(L.item, [ch.startsWith('m.') ? 'm' : ch], f), ch);
function graphRange(L, ch) {
  let lo = Infinity, hi = -Infinity;
  for (let f = 0; f <= span(); f++) { const v = sampleCh(L, ch, f); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!(hi - lo > 1e-6)) { const c = Number.isFinite(lo) ? lo : 0; lo = c - 1; hi = c + 1; }
  const pad = (hi - lo) * 0.12;
  return { lo: lo - pad, hi: hi + pad };
}
const yPos = (rg, v) => `calc(${GP}px + (100% - ${2 * GP}px) * ${(rg.hi - v) / (rg.hi - rg.lo)})`;

// ---- drawing ----------------------------------------------------------------------------------
const fmtT = (f) => (UI.unit === 's' ? `${+(f / FPS).toFixed(2)}s` : String(f + 1));
function ruler() {
  const cands = UI.unit === 's' ? [1, 2, 3, 6, 12, 24, 48, 96, 192] : [1, 2, 4, 6, 12, 24, 48, 96, 192];
  const step = cands.find((c) => c * pxf() >= 46) || 192, ticks = [];
  for (let f = Math.ceil(V.a / step) * step; f <= V.b; f += step) ticks.push(h('span', { class: 'tick', style: `left:${lanePos(f)}` }, fmtT(f)));
  return h('div', { class: 'sheet-ruler' }, ...ticks);
}

const HINTS = { dope: 'Double-tap a row to add a key there', graph: 'Double-tap the graph to add a point at that height' };
function hintOnce() {  // said once per device, the first time each view is shown
  const seen = store.get('deck.scene.keyhints', {});
  if (seen[UI.mode] || !$('#tab-scene')?.classList.contains('active')) return;
  seen[UI.mode] = true; store.set('deck.scene.keyhints', seen); toast(HINTS[UI.mode]);
}
let gRange = null;   // the graph's value range, held still while a key is dragged
export function renderKeys() {
  const lanes = lanesEl();
  if (!lanes) return;
  const sh = shown();
  prune(sh, SEL);
  clampV();
  const sheet = $('#sceneSheet');
  if (sheet) sheet.classList.toggle('graph', UI.mode === 'graph');
  hintOnce();
  const graph = UI.mode === 'graph' ? gLayer() : null;
  const st = sheet?.scrollTop || 0;   // rebuilding the rows empties the sheet for a moment, which would reset its scroll
  let body;
  if (graph) {
    const chs = channels(graph);
    if (!chs.includes(G.ch)) G.ch = chs[0];
    const rg = gRange || graphRange(graph, G.ch), n = span();
    const L = graph, li = sh.findIndex((x) => x.item === L.item);
    const plot = h('div', { class: 'graph-plot' + (L.item.mute ? ' muted' : '') }, h('canvas', { class: 'graph-cv' }),
      ...L.item.keys.map((k, j) => keyEl(k, li, j, `top:${yPos(rg, sampleCh(L, G.ch, k.f))}`)));
    body = [plot];
    $('#sceneNames').replaceChildren(
      h('div', { class: 'sheet-head' }, layerSel(sh, L), muteBtn(L)),
      ...chs.map((ch) => h('button', { type: 'button', class: 'sheet-name' + (ch === G.ch ? ' sel' : ''), onclick: () => { G.ch = ch; gRange = null; renderKeys(); } }, chLabel(ch))));
    lanes.replaceChildren(ruler(), ...body, h('div', { id: 'scenePlayhead', class: 'playhead', style: `left:${lanePos(R.f)}` }));
    drawGraph(plot, L, rg, n);
  } else {
    $('#sceneNames').replaceChildren(h('div', { class: 'sheet-head' }),
      ...sh.map((L) => h('div', { class: 'sheet-name-row' }, muteBtn(L),
        h('button', { type: 'button', class: 'sheet-name' + (L.id === R.sel ? ' sel' : '') + (L.item.hidden || L.item.mute ? ' off' : ''),
          title: L.label, onclick: () => select(L.id) }, L.label))));
    lanes.replaceChildren(ruler(),
      ...sh.map((L, i) => h('div', { class: 'sheet-lane' + (L.id === R.sel ? ' sel' : '') + (L.item.mute ? ' muted' : ''), 'data-track': i },
        L.item.keys.length > 1 ? h('span', { class: 'span', style: `left:${lanePos(L.item.keys[0].f)};`
          + `width:calc((100% - ${2 * PAD}px) * ${(L.item.keys[L.item.keys.length - 1].f - L.item.keys[0].f) / (V.b - V.a)})` }) : null,
        ...L.item.keys.map((k, j) => keyEl(k, i, j, '')))),
      h('div', { id: 'scenePlayhead', class: 'playhead', style: `left:${lanePos(R.f)}` }));
  }
  if (G0 && G0.type === 'box' && G0.el) lanes.append(G0.el);
  if (sheet && st) sheet.scrollTop = st;
  syncTools();
  const [item] = keyTarget();
  const add = $('#sceneAddKey'), del = $('#sceneDelKey');
  if (add) add.disabled = !item;
  if (del) del.disabled = !item || !item.keys.some((k) => k.f === R.f);
  if (add) add.classList.toggle('pending', !!item && TEMP.has(item));  // a held change to keep
  const lbl = $('#sceneKeyFor');
  if (lbl) lbl.textContent = selItem() ? selItem().name : R.sel === ROOM ? 'Room (not animated)' : 'Camera';
}

// Mute: the layer ignores its keys on screen and stays where it is (renders still use the keys); one undo step
export function toggleMute(L) {
  stopPlay(); setMute(L.item, !L.item.mute);
  changed(); pose(R.f); draw();
}
const muteBtn = (L) => h('button', { type: 'button', class: 'mute-btn' + (L.item.mute ? ' on' : ''), 'aria-pressed': !!L.item.mute,
  'aria-label': `Mute ${L.label}`, title: L.item.mute ? 'Muted: ignores its keys and stays where it is (renders still use them). Tap to unmute' : 'Mute: ignore this layer\'s keys on screen so you can move it freely',
  onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toggleMute(L); } }, L.item.mute ? '🔇' : '🔊');

function layerSel(sh, L) {
  const el = h('select', { 'aria-label': 'Layer', onchange: (e) => select(sh[+e.target.value].id) }, ...sh.map((x, i) => h('option', { value: i }, x.label)));
  el.value = String(sh.findIndex((x) => x.item === L.item));
  return el;
}
const keyEl = (k, li, j, style) => h('span', { class: `key e-${k.ease || 'auto'}` + (SEL.has(k) ? ' sel' : '') + (k.f === R.f ? ' on' : ''),
  'data-key': j, 'data-l': li, style: `left:${lanePos(k.f)};${style}`, title: `Key at ${(k.f / FPS).toFixed(2)} s · frame ${k.f + 1}${k.ease ? ` · ${k.ease}` : ''}` });

function drawGraph(plot, L, rg, n) {
  const cv = plot.firstChild, dpr = Math.min(window.devicePixelRatio || 1, 2), w = plot.clientWidth, hh = plot.clientHeight;
  if (!w || !hh) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  const c = cv.getContext('2d'), cs = getComputedStyle(plot);
  c.scale(dpr, dpr);
  const col = (v, d) => cs.getPropertyValue(v).trim() || d;
  const X = (f) => PAD + (w - 2 * PAD) * (f - V.a) / (V.b - V.a), Y = (v) => GP + (hh - 2 * GP) * (rg.hi - v) / (rg.hi - rg.lo);
  c.font = '10px ui-monospace, monospace'; c.textBaseline = 'bottom';
  // horizontal guides at round values
  const raw = (rg.hi - rg.lo) / 4, mag = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  for (let v = Math.ceil(rg.lo / st) * st; v <= rg.hi; v += st) {
    c.strokeStyle = col('--line', '#333'); c.lineWidth = 1; c.beginPath(); c.moveTo(0, Y(v)); c.lineTo(w, Y(v)); c.stroke();
    c.fillStyle = col('--muted', '#888'); c.fillText(+v.toFixed(3), 3, Y(v) - 1);
  }
  c.strokeStyle = col('--accent', '#e9b44c'); c.lineWidth = 2; c.beginPath();
  const f0 = Math.max(0, Math.floor(V.a)), f1 = Math.min(n, Math.ceil(V.b));
  // a constant segment steps; finer sampling than a frame isn't needed (keys sit on frames)
  for (let f = f0; f <= f1; f++) { const v = sampleCh(L, G.ch, f); if (f === f0) c.moveTo(X(f), Y(v)); else c.lineTo(X(f), Y(v)); }
  c.stroke();
}

// ---- selection API (the sheet's buttons and the keyboard go through these) ----------------------
export function selectKeys(keys, add = false) { if (!add) SEL.clear(); keys.forEach((k) => SEL.add(k)); renderKeys(); }
export const selectAll = () => selectKeys(UI.mode === 'graph' ? (gLayer()?.item.keys || []) : allKeys(shown()));
export const selectNone = () => selectKeys([]);
export function selectInvert() {
  const pool = UI.mode === 'graph' ? (gLayer()?.item.keys || []) : allKeys(shown());
  selectKeys(pool.filter((k) => !SEL.has(k)));
}
// every edit below is one undo step
const done = () => changed();
export function moveKeys(dt) { if (!SEL.size) return 0; const d = moveBy(shown(), SEL, dt, frames()); done(); return d; }
export function scaleKeys(s, t0 = R.f) { if (!SEL.size) return; scaleAround(shown(), SEL, t0, s, frames()); done(); }
export function deleteKeys() {
  if (!SEL.size) return;
  for (const L of shown()) {  // a layer that loses its last key stays as it looks now (like Clear keys)
    if (L.item.keys.length && L.item.keys.every((k) => SEL.has(k))) Object.assign(L.item.base, sample(L.item, L.names, R.f));
  }
  const c = remove(shown(), SEL); TEMP.clear(); done(); toast(`${c} key${c > 1 ? 's' : ''} deleted`);
}
export function setKeyEase(ease) { if (!SEL.size) return; setEase(SEL, ease); done(); }

// the clipboard is kept in memory and in localStorage, so a tab switch (another scene) still has it
const CLIP = 'deck.scene.keyclip';
let clip = null;
export function copyKeys() {
  const c = copy(shown(), SEL);
  if (!c) return false;
  clip = c; store.set(CLIP, c); syncTools();
  toast(`${SEL.size} key${SEL.size > 1 ? 's' : ''} copied`);
  return true;
}
const getClip = () => clip || (clip = store.get(CLIP, null));
// paste with the first key at t (the playhead): onto the selected layer if it fits, else where they came from
export function pasteKeys(t = R.f, c = getClip()) {
  if (!c || !c.groups?.length) { toast('Nothing copied', true); return null; }
  const [it] = keyTarget(), sh = shown();
  const pick = sh.find((L) => L.item === (it || (R.sel === ROOM ? null : SC.camera))) || null;
  const r = paste(sh, c, t, frames(), { pick, fill: (item, names, f) => sample(item, names, f) });
  if (!r.groups) { toast('Those keys don\'t fit here', true); return null; }
  SEL.clear(); r.keys.forEach((k) => SEL.add(k));
  TEMP.clear(); done();
  if (r.dropped) toast(`${r.dropped} key${r.dropped > 1 ? 's' : ''} past the end left out`, true);
  return r;
}
// copy and paste straight after the selection (a lone key goes half a second on)
export function duplicateKeys() {
  const b = bounds(shown(), SEL);
  if (!b) return null;
  const c = copy(shown(), SEL);
  return pasteKeys(b[0] + (b[1] > b[0] ? b[1] - b[0] + 1 : 12), c);
}

// ---- gestures -----------------------------------------------------------------------------------
let G0 = null, nPtr = 0;
const ptrs = new Map();
const info = (t) => { const el = $('#sceneKeyInfo'); if (el) el.textContent = t ?? (SEL.size ? `${SEL.size} selected` : ''); };

function syncSelClasses() {
  const sh = shown();
  for (const el of lanesEl().querySelectorAll('[data-key]')) el.classList.toggle('sel', SEL.has(sh[+el.dataset.l]?.item.keys[+el.dataset.key]));
  syncTools();
}
const keyOf = (el) => shown()[+el.dataset.l]?.item.keys[+el.dataset.key];

// keep the held keys' pixel pull in frames; snap onto the playhead and the keys not being moved
function snapDt(dt, g) {
  if (!UI.snap) return dt;
  const thr = Math.max(1, Math.round(8 / pxf()));
  let best = null;
  for (const k of g.mine) for (const c of g.cands) { const d = c - (k.f0 + dt); if (Math.abs(d) <= thr && (best == null || Math.abs(d) < Math.abs(best))) best = d; }
  return best == null ? dt : dt + best;
}

function down(e) {
  if (busy || (e.pointerType === 'mouse' && e.button > 0)) return;
  e.preventDefault();
  if (R.playing) { stopPlay(); return; }
  const lanes = lanesEl();
  lanes.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size > 1) {  // a second finger: zoom and pan, and give up what the first began
    abort();
    const [a, b] = [...ptrs.values()], r = lanes.getBoundingClientRect();
    G0 = { type: 'pinch', d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), a0: V.a, b0: V.b, midf: V.a + ((a.x + b.x) / 2 - r.left - PAD) / pxf(), midx0: (a.x + b.x) / 2, fit0: V.fit };
    return;
  }
  const t = e.target, keyEl2 = t.closest('[data-key]'), laneEl = t.closest('[data-track]');
  const base = { x0: e.clientX, y0: e.clientY, moved: false };
  if (t.closest('.sheet-ruler')) { G0 = { type: 'scrub' }; seek(frameAtX(e.clientX)); return; }
  if (UI.tool === 'scale' && SEL.size) {
    const r = lanes.getBoundingClientRect(), phx = r.left + PAD + (R.f - V.a) * pxf();
    G0 = { ...base, type: 'scale', phx, d0: Math.max(24, Math.abs(e.clientX - phx)), snap: snapshot(shown()) };
    return;
  }
  const L = keyEl2 ? shown()[+keyEl2.dataset.l] : laneEl ? shown()[+laneEl.dataset.track] : null;
  if (keyEl2) {
    const key = keyOf(keyEl2), was = SEL.has(key);
    if (UI.add) { if (!was) SEL.add(key); } else if (!was) { SEL.clear(); SEL.add(key); }
    G0 = { ...base, type: 'key', key, was, L };
    if (L && L.id !== R.sel && UI.mode !== 'graph') select(L.id); else renderKeys();
    return;
  }
  if (L && L.id !== R.sel && UI.mode !== 'graph') select(L.id);
  // empty space: a finger pans (unless Box is on); a mouse or pen draws a box
  const box = e.pointerType === 'touch' ? UI.box : true;
  const sheet = $('#sceneSheet');
  G0 = box ? { ...base, type: 'box', start: new Set(UI.add ? SEL : []), L, el: h('div', { class: 'sel-box' }), fresh: true }
    : { ...base, type: 'pan', a0: V.a, b0: V.b, st0: sheet.scrollTop, L };
}

function abort() {
  const g = G0; G0 = null;
  if (g && (g.type === 'key' || g.type === 'scale') && g.moved) { restore(g.snap); SEL.clear(); g.held.forEach((k) => SEL.add(k)); pose(R.f); draw(); renderKeys(); }
  if (g?.el) g.el.remove();
}

function move(e) {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  const g = G0;
  if (!g) return;
  const lanes = lanesEl(), n = span();
  if (g.type === 'scrub') { const f = frameAtX(e.clientX); if (f !== R.f) seek(f); return; }
  if (g.type === 'pinch') {
    const [a, b] = [...ptrs.values()];
    if (!b) return;
    const k = Math.hypot(a.x - b.x, a.y - b.y) / g.d0, r = lanes.getBoundingClientRect(), mx = (a.x + b.x) / 2;
    const w = Math.max(Math.min(8, n), (g.b0 - g.a0) / k), ppf = (r.width - 2 * PAD) / w;
    V.fit = false; V.a = g.midf - (mx - r.left - PAD) / ppf; V.b = V.a + w; renderKeys();
    return;
  }
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.moved && Math.hypot(dx, dy) < 6) return;
  if (g.type === 'pan') {
    g.moved = true;
    const f = dx / pxf(); V.fit = false; V.a = g.a0 - f; V.b = g.b0 - f; $('#sceneSheet').scrollTop = g.st0 - dy; renderKeys();
    return;
  }
  if (g.type === 'box') {
    g.moved = true;
    const r = lanes.getBoundingClientRect();
    const x1 = Math.min(g.x0, e.clientX), x2 = Math.max(g.x0, e.clientX), y1 = Math.min(g.y0, e.clientY), y2 = Math.max(g.y0, e.clientY);
    Object.assign(g.el.style, { left: `${x1 - r.left}px`, top: `${y1 - r.top}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    if (!g.el.isConnected) lanes.append(g.el);
    SEL.clear(); g.start.forEach((k) => SEL.add(k));
    for (const el of lanes.querySelectorAll('[data-key]')) {
      const b = el.getBoundingClientRect(), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) SEL.add(keyOf(el));
    }
    syncSelClasses(); info();
    return;
  }
  // moving keys: from the snapshot each time, so the drag follows the pointer exactly
  if (!g.moved) {
    g.moved = true; g.snap = g.snap || snapshot(shown()); g.held = new Set(SEL);  // (a collision drops keys from SEL; the snapshot brings them back)
    if (g.type === 'key') {
      g.cands = [R.f, ...shown().flatMap((L) => L.item.keys).filter((k) => !SEL.has(k)).map((k) => k.f)];
      if (UI.mode === 'graph') {
        const L = gLayer(); g.gL = L; gRange = graphRange(L, G.ch);
        g.vals = new Map(L.item.keys.filter((k) => SEL.has(k)).map((k) => [k, sampleCh(L, G.ch, k.f)]));
      }
    }
  }
  restore(g.snap); SEL.clear(); g.held.forEach((k) => SEL.add(k));
  if (g.type === 'scale') {
    const s = scaleAround(shown(), SEL, R.f, Math.abs(e.clientX - g.phx) / g.d0, frames());
    info(`× ${s.toFixed(2)}`);
  } else {
    g.mine = [...SEL].map((k) => ({ f0: k.f }));
    const dt = snapDt(Math.round(dx / pxf()), g), d = moveBy(shown(), SEL, dt, frames());
    let t = `${d >= 0 ? '+' : ''}${d} f`;
    if (g.vals) {
      const rg = gRange, dv = -dy / Math.max(40, $('.graph-plot').clientHeight - 2 * GP) * (rg.hi - rg.lo);
      for (const [k, v0] of g.vals) {
        if (g.gL.item.keys.includes(k)) setChan(k, G.ch, v0 + dv, { ...g.gL.item.base, ...k });
      }
      t += ` · ${dv >= 0 ? '+' : ''}${dv.toFixed(2)}`;
    }
    info(t);
  }
  pose(R.f); draw(); renderKeys();
}

function up(e) {
  ptrs.delete(e.pointerId);
  const g = G0;
  if (!g) return;
  if (g.type === 'pinch') { if (!ptrs.size) G0 = null; return; }
  G0 = null; gRange = null;
  if (g.type === 'scrub') return;
  if (g.type === 'key') {
    if (g.moved) { done(); info(); return; }
    if (UI.add) { if (g.was) SEL.delete(g.key); } else { SEL.clear(); SEL.add(g.key); seek(g.key.f); }
    renderKeys(); info();
    return;
  }
  if (g.type === 'scale') { if (g.moved) done(); info(); return; }
  if (g.el) g.el.remove();
  if (!g.moved) {  // a tap on empty space: deselect (unless adding) and move the playhead
    if (!UI.add) SEL.clear();
    seek(frameAtX(e.clientX)); info();
    doubleTap(e, g.L);
  } else if (g.type === 'box') renderKeys();
}

function cancel(e) { ptrs.delete(e.pointerId); if (!ptrs.size) { abort(); G0 = null; gRange = null; } else if (G0?.type === 'pinch') G0 = null; }

function wheel(e) {
  const r = lanesEl().getBoundingClientRect();
  if (e.ctrlKey || e.altKey) {  // zoom around the pointer
    e.preventDefault();
    const w = Math.max(Math.min(8, span()), (V.b - V.a) * Math.exp(e.deltaY * 0.0025)), at = V.a + (e.clientX - r.left - PAD) / pxf();
    const k = (e.clientX - r.left - PAD) / (r.width - 2 * PAD);
    V.fit = false; V.a = at - k * w; V.b = V.a + w; renderKeys();
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {  // pan
    e.preventDefault();
    const d = (e.shiftKey ? e.deltaY : e.deltaX) / pxf();
    V.fit = false; V.a += d; V.b += d; renderKeys();
  }
}

// ---- the sheet's controls ----------------------------------------------------------------------
// One compact row of icon buttons that scrolls sideways (never wraps); the rarer tools sit in the ⋯ menu.
const tools = [];   // [el, on() | null, needs: 'sel' | 'clip' | null]
function tool(icon, fn, { name, on = null, needs = null, title = '', cls = '' } = {}) {
  const b = button(icon, fn, { cls: `small kt${cls ? ` ${cls}` : ''}`, title: title ? `${name} · ${title}` : name, 'aria-label': name });
  tools.push([b, on, needs]);
  return b;
}
function syncTools() {
  for (const [b, on, needs] of tools) {
    if (!b.isConnected) continue;
    if (on) { const v = on(); b.classList.toggle('on', v); b.setAttribute('aria-pressed', v); }
    if (needs) b.disabled = needs === 'sel' ? !SEL.size : !(clip || store.get(CLIP, null));
  }
  info();
}
const setUI = (k, v) => { UI[k] = v; if (k === 'mode') store.set('deck.scene.keymode', v); if (k === 'unit') store.set('deck.scene.keyunit', v); if (k === 'snap') store.set('deck.scene.keysnap', v); };
const numIn = (label, val, fn, title, w = 64) => h('label', { class: 'keynum', title }, label,
  h('input', { type: 'number', value: val, step: 'any', inputMode: 'decimal', style: `width:${w}px`,
    onchange: (e) => { const v = parseFloat(e.target.value); e.target.value = val; if (Number.isFinite(v)) fn(v); } }));

// the ⋯ menu: fixed to the viewport (the tool row scrolls and would clip it), inside the stage (so full screen keeps it)
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; removeEventListener('pointerdown', menuAway, true); }
function menuAway(e) { if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.kt-more')) closeMenu(); }
function openMenu(anchor) {
  if (menuEl) { closeMenu(); return; }
  const item = (label, fn, keep = false) => h('button', { type: 'button', class: 'btn small ghost', onclick: () => { fn(); if (!keep) closeMenu(); } }, label);
  menuEl = h('div', { class: 'key-menu', role: 'menu' },
    item('Select none', selectNone), item('Invert selection', selectInvert), item('Duplicate (Ctrl+D)', duplicateKeys),
    numIn('Shift (frames)', 0, (v) => { moveKeys(v); closeMenu(); }, 'Move the selected keys by this many frames'),
    numIn('Scale (%)', 100, (v) => { scaleKeys(v / 100); closeMenu(); }, 'Stretch the selected keys around the playhead, in percent'),
    item(`Ruler in ${UI.unit === 's' ? 'frames' : 'seconds'}`, () => { setUI('unit', UI.unit === 's' ? 'f' : 's'); renderKeys(); }),
    item(`Snap ${UI.snap ? 'off' : 'on'} (to playhead and keys)`, () => { setUI('snap', !UI.snap); syncTools(); }));
  (stage() || document.body).append(menuEl);
  const r = anchor.getBoundingClientRect(), mh = menuEl.offsetHeight, mw = menuEl.offsetWidth;
  const top = r.bottom + 4 + mh > innerHeight ? Math.max(4, r.top - 4 - mh) : r.bottom + 4;  // opens up when there's no room below
  Object.assign(menuEl.style, { top: `${top}px`, left: `${Math.max(4, Math.min(innerWidth - mw - 4, r.right - mw))}px` });
  addEventListener('pointerdown', menuAway, true);
}

function toolRow() {
  tools.length = 0; closeMenu();
  const sep = () => h('span', { class: 'sep' });
  return h('div', { class: 'scene-keytools', role: 'toolbar', 'aria-label': 'Key tools' },
    tool('▤', () => { setUI('mode', 'dope'); renderKeys(); }, { name: 'Dope sheet', on: () => UI.mode === 'dope', title: 'a row per layer · double-tap a row to add a key' }),
    tool('∿', () => { setUI('mode', 'graph'); gRange = null; renderKeys(); }, { name: 'Graph', on: () => UI.mode === 'graph', title: 'one value over time · drag a point, double-tap to add one' }),
    sep(),
    tool('⬚', () => { setUI('box', !UI.box); syncTools(); }, { name: 'Box select', on: () => UI.box, title: 'on a touch screen: drag on empty space to box-select instead of panning' }),
    tool('⊕', () => { setUI('add', !UI.add); syncTools(); }, { name: 'Add to selection', on: () => UI.add, title: 'taps and boxes add to the selection (a tap on a selected key takes it out)' }),
    tool('▣', selectAll, { name: 'Select all', title: 'A' }),
    sep(),
    tool('⧉', copyKeys, { name: 'Copy', needs: 'sel', title: 'Ctrl+C' }),
    tool('📋', () => pasteKeys(), { name: 'Paste', needs: 'clip', title: 'at the playhead, onto the selected layer if it fits (Ctrl+V)' }),
    tool('🗑', deleteKeys, { name: 'Delete selected keys', needs: 'sel', cls: 'danger', title: 'Delete' }),
    sep(),
    (() => {
      const s = h('select', { class: 'kt-ease', 'aria-label': 'Ease of the selected keys', title: 'Ease · how the selected keys blend into the next one',
        onchange: (e) => { const v = e.target.value; e.target.value = '~'; if (v !== '~') setKeyEase(v); } },
      h('option', { value: '~' }, 'Ease…'), ...EASES.map(([v, l]) => h('option', { value: v }, l)));
      tools.push([s, null, 'sel']);
      return s;
    })(),
    tool('⇔', () => { setUI('tool', UI.tool === 'scale' ? 'move' : 'scale'); syncTools(); }, { name: 'Stretch in time', on: () => UI.tool === 'scale', needs: 'sel',
      title: 'drag across the sheet to stretch the selected keys around the playhead (Blender\'s S)' }),
    tool('🧲', () => { setUI('snap', !UI.snap); syncTools(); }, { name: 'Snap', on: () => UI.snap, title: 'dragging snaps to the playhead and to other keys' }),
    tool('⤢', () => { V.fit = true; renderKeys(); }, { name: 'Fit', title: 'show the whole clip' }),
    tool('⋯', (e) => openMenu(e.currentTarget), { name: 'More', cls: 'kt-more', title: 'select none, invert, duplicate, shift, scale, ruler' }),
    h('span', { id: 'sceneKeyInfo', class: 'hint keyinfo' }));
}

// the tool row can be hidden to give the sheet room (kept per device)
const TK = 'deck.scene.keytools';
function applyTools(on = store.get(TK, true)) {
  const row = $('.scene-keytools'), b = $('#sceneToolsBtn');
  if (row) row.classList.toggle('hidden', !on);
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  if (!on) closeMenu();
}

// ---- adding keys by hand (double-tap): a full key sampled at that time, so nothing else moves ----
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
function insertKey(L, f, ch = null, v = null) {
  const item = L.item;
  let k = item.keys.find((x) => x.f === f);
  if (!k) {
    if (!item.keys.length) Object.assign(item.base, plain(sample(item, L.names, f)));  // the first key keeps the look it had
    k = { f, ...Object.fromEntries(Object.entries(plain(sample(item, L.names, f))).filter(([, x]) => x != null)) };
    item.keys.push(k); item.keys.sort((a, b) => a.f - b.f);
  }
  if (ch) setChan(k, ch, v, { ...item.base, ...k });
  TEMP.clear(); SEL.clear(); SEL.add(k);
  done(); seek(f);
  return k;
}
// the value under a tap on the graph's plot
function valueAtY(y) {
  const r = $('.graph-plot').getBoundingClientRect(), rg = gRange || graphRange(gLayer(), G.ch);
  const t = Math.max(0, Math.min(1, (y - r.top - GP) / Math.max(1, r.height - 2 * GP)));
  return rg.hi - t * (rg.hi - rg.lo);
}
let lastTap = null;   // the previous tap on empty space, for the double-tap
function doubleTap(e, L) {
  const now = e.timeStamp, prev = lastTap;
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (!prev || now - prev.t > 600 || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 28) return;
  lastTap = null;
  const f = frameAtX(e.clientX);
  if (UI.mode === 'graph') { const G1 = gLayer(); if (G1) insertKey(G1, f, G.ch, valueAtY(e.clientY)); }
  else if (L) insertKey(L, f);
}

export function renderTime() {
  const t = $('#sceneTime');
  if (t) t.textContent = `${(R.f / FPS).toFixed(2)} s · ${R.f + 1}/${frames()}`;
  const ph = $('#scenePlayhead');
  if (ph) ph.style.left = lanePos(R.f);
}

// ---- the sheet's height: drag its top edge (kept per device) ----------------------------------------
const HK = 'deck.scene.sheeth';
function applySheetH(px = store.get(HK, null)) {
  const sh = $('#sceneSheet');
  if (!sh) return;
  const ok = Number.isFinite(px) && px > 0;
  sh.style.height = ok ? `${px}px` : ''; sh.style.maxHeight = ok ? `${px}px` : '';
}
function grip() {
  const g = h('div', { class: 'sheet-grip', role: 'separator', 'aria-label': 'Drag to resize the key sheet', title: 'Drag to resize · double-tap to reset' });
  let d = null;
  const mv = (e) => {
    if (!d) return;
    const max = Math.max(160, ($('#tab-scene .stage')?.clientHeight || 600) * 0.55);
    applySheetH(Math.round(Math.max(72, Math.min(max, d.h - (e.clientY - d.y)))));
    renderKeys();
  };
  const end = () => {
    if (!d) return;
    d = null; g.classList.remove('dragging'); store.set(HK, $('#sceneSheet').offsetHeight);
    removeEventListener('pointermove', mv); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
  };
  g.addEventListener('pointerdown', (e) => {  // (window listeners: the grip moves as the sheet grows)
    e.preventDefault(); d = { y: e.clientY, h: $('#sceneSheet').offsetHeight }; g.classList.add('dragging');
    addEventListener('pointermove', mv); addEventListener('pointerup', end); addEventListener('pointercancel', end);
  });
  g.addEventListener('dblclick', () => { store.set(HK, null); applySheetH(null); renderKeys(); });
  return g;
}

export function renderTransport() {
  const lanes = h('div', { id: 'sceneLanes', class: 'sheet-lanes' });
  lanes.addEventListener('pointerdown', down);
  lanes.addEventListener('pointermove', move);
  lanes.addEventListener('pointerup', up);
  lanes.addEventListener('pointercancel', cancel);
  lanes.addEventListener('wheel', wheel, { passive: false });
  G0 = null; ptrs.clear();
  $('#sceneTransport').replaceChildren(
    h('div', { class: 'key-head' }, h('div', { class: 'row scene-keybar' },
      button('⚙', () => { const on = !store.get(TK, true); store.set(TK, on); applyTools(on); }, { id: 'sceneToolsBtn', cls: 'small kt', title: 'Show or hide the key tools', 'aria-label': 'Key tools' }),
      button(R.playing ? '❚❚ Pause' : '▶ Play', play, { cls: 'small primary', title: 'Play / pause (Space)' }),
      h('span', { id: 'sceneTime', class: 'timecode' }),
      h('span', { class: 'grow' }),
      button('● Auto key', () => setAutoKey(!R.autoKey), { id: 'sceneAutoKey', cls: 'small autokey' + (R.autoKey ? ' on' : ''), 'aria-pressed': R.autoKey,
        title: 'Auto key (K): on, a change to something animated sets a key at the playhead. Off, it shifts the whole animation (or edits the key under the playhead).' }),
      h('span', { class: 'hint' }, 'Key: ', h('b', { id: 'sceneKeyFor' })),
      button('◆ Key', () => {
        const [item, names] = keyTarget(); if (!item) return;
        addKey(item, names); changed();
      }, { id: 'sceneAddKey', title: 'Keyframe at the playhead' }),
      button('✕ Key', () => {
        const [item] = keyTarget(); if (!item) return;
        item.keys = item.keys.filter((k) => k.f !== R.f); changed();
      }, { id: 'sceneDelKey', title: 'Remove the key at the playhead' })),
    toolRow()),
    grip(),
    h('div', { id: 'sceneSheet', class: 'scene-sheet' }, h('div', { id: 'sceneNames', class: 'sheet-names' }), lanes));
  applySheetH(); applyTools();
  $('#sceneTransport').classList.toggle('hidden', modeOf().lanes === 'none');
  renderTime(); renderKeys();
}

// ---- the 3D viewport, full screen: the shared maximize button (layout.js) ---------------------------
const stage = () => $('#tab-scene .stage');
let sceneMax = null;
export const maxBar = () => (sceneMax ||= maximizable($('#tab-scene .stage'), $('#sceneViewer'), { title: 'Full screen the 3D view' })).btn;

// ---- the keyboard (the sheet, when it was the last thing touched) ---------------------------------
let focus = false;
export function wireSheetKeys() {
  document.addEventListener('pointerdown', (e) => { focus = !!e.target.closest('#sceneTransport'); }, true);
  document.addEventListener('keydown', (e) => {
    if (!$('#tab-scene').classList.contains('active') || sheetOpen() || e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase(), eat = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (!focus) return;
    if (e.ctrlKey || e.metaKey) {
      if (k === 'c') { eat(); copyKeys(); } else if (k === 'v') { eat(); pasteKeys(); } else if (k === 'd') { eat(); duplicateKeys(); } else if (k === 'a') { eat(); selectAll(); }
    } else if ((k === 'delete' || k === 'backspace' || k === 'x') && SEL.size) { eat(); deleteKeys(); }
    else if (k === 'a') { eat(); if (e.altKey) selectNone(); else selectAll(); }
    else if (k === 'escape' && SEL.size) { eat(); selectNone(); }
  }, true);
}
