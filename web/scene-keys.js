import * as FIGURE from './figure.js';
import { fullScreen } from './layout.js';
import { $, button, h, info as infoBtn, numSlider, sheetOpen, store, toast, toggle, canvasFont } from './ui.js';
import {
  CAM, FPS, HOLD, OBJ, R, ROOM, SC, TEMP, TYPES, WP, addKey, bakeBase, dropKeys, frames, keyAt, keyChans, keyTarget, namesFor, sample, sampleChan, selItem, setKey, setMute
} from './scene-data.js';
import {
  CURVES, EASES, allKeys, bounds, copy, handleOf, isScalar, kindOf, moveBy, moveHandle, paste, prune, remove, restore, scaleAround, setBroken, setChan, setEase, snapshot, track
} from './keys.js';
import { changed, draw, pose, select } from './scene-view.js';
import { busy, play, seek } from './scene-export.js';
import { setAutoKey } from './scene-ui.js';
import { modeOf } from './scene-modes.js';

// ---- the key sheet: a Blender-style dope sheet and a simple graph editor over the layers' keys -----
// A row per layer (the camera, then the objects) that opens (▸) into a row per channel, a figure's pose
// grouped by limb. Every channel keeps its own keys: a layer's or group's row only sums up the diamonds
// under it, and moving one moves all the keys at that frame. Tap a key to select it, drag it to move
// the whole selection; drag empty space to box-select (a finger pans unless Box is on); the ruler scrubs;
// two fingers (or Ctrl+wheel) zoom the time axis. Every gesture is ONE undo step: keys move live from a
// snapshot (keys.js), and changed() saves once on letting go.
const PAD = 8, GP = 14;   // px at each end of a row; px above and below the graph's plot
export const SEL = new Set();   // the selected key objects (an undo or a deleted layer drops them)
const UI = { box: false, add: false, tool: 'move', mode: store.get('deck.scene.keymode', 'dope'), unit: store.get('deck.scene.keyunit', 's'),
  snap: store.get('deck.scene.keysnap', false) };
const OPEN = new Set(store.get('deck.scene.keyopen', []));   // the rows that are open: 'i:<layer id>', 'p:<id>' (pose), 'g:<id>:<group>'
const G = { ch: 'py' };  // the graph's channel
const V = { a: 0, b: 1, fit: true };   // the frames on show

const layers = () => [{ item: SC.camera, id: null, kind: 'cam', names: CAM, label: '🎥 Camera' },
  ...SC.objects.map((o) => ({ item: o, id: o.id, kind: kindOf(o), names: namesFor(o), label: `${TYPES[o.type].icon} ${o.name}` }))];
const shown = () => (modeOf().lanes === 'camera' ? layers().slice(0, 1) : layers());
const span = () => Math.max(1, frames() - 1);

// every channel a layer can have: one track each (a channel with no keys has an empty one, for paste and the like)
const JOINTS = Object.keys(FIGURE.RIG_JOINTS);   // (the fingers too)
function chanIds(L) {
  const own = Object.keys(L.item.chans || {});
  const base = L.kind === 'figure' ? [...OBJ, 'pn', ...Object.keys(FIGURE.PARAMS).map((p) => `m.${p}`), ...JOINTS.map((j) => `j.${j}`)] : L.names;
  return [...new Set([...base, ...own])];
}
const tracksOf = (L) => chanIds(L).map((ch) => track(L.item, ch, { id: L.id, kind: L.kind }));
const allTracks = () => shown().flatMap(tracksOf);
const gTrack = () => { const L = gLayer(); return L ? track(L.item, G.ch, { id: L.id, kind: L.kind }) : null; };

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
// the numbers the graph can plot: a figure's parameters once keyed (a joint's turn is not one number)
const channels = (L) => chanIds(L).filter((ch) => isScalar(ch) && !(ch.startsWith('m.') && !L.item.chans?.[ch]));
const LABELS = { x: 'X', y: 'Up', z: 'Z', rx: 'Rot X', ry: 'Rot Y', rz: 'Rot Z', sx: 'Width', sy: 'Height', sz: 'Depth',
  px: 'Cam X', py: 'Cam height', pz: 'Cam Z', tx: 'Aim X', ty: 'Aim Y', tz: 'Aim Z', fov: 'Lens', roll: 'Roll', pn: 'Pose name' };
const chLabel = (ch) => (ch.startsWith('m.') ? (FIGURE.PARAMS[ch.slice(2)]?.label || ch.slice(2)) : ch.startsWith('j.') ? (FIGURE.RIG_JOINTS[ch.slice(2)]?.[2] || ch.slice(2)) : LABELS[ch] || ch);
const sampleCh = (L, ch, f) => sampleChan(L.item, ch, f);
function graphRange(L, ch) {
  let lo = Infinity, hi = -Infinity;
  for (let f = 0; f <= span(); f++) { const v = sampleCh(L, ch, f); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!(hi - lo > 1e-6)) { const c = Number.isFinite(lo) ? lo : 0; lo = c - 1; hi = c + 1; }
  const pad = (hi - lo) * 0.12;
  return { lo: lo - pad, hi: hi + pad };
}
const yPos = (rg, v) => `calc(${GP}px + (100% - ${2 * GP}px) * ${(rg.hi - v) / (rg.hi - rg.lo)})`;

// ---- the dope sheet's rows ---------------------------------------------------------------------
// { t: 'item' | 'group' | 'chan', L, label, depth, key (for OPEN, groups only), tracks, dia }: dia are the diamonds
// [{ f, keys }]: a channel's own keys, or for a group the keys of its channels that share a frame
function diamonds(tracks, own) {
  if (own) return tracks[0].keys.map((k) => ({ f: k.f, keys: [k] }));
  const at = new Map();
  for (const T of tracks) for (const k of T.keys) { if (!at.has(k.f)) at.set(k.f, []); at.get(k.f).push(k); }
  return [...at].sort((a, b) => a[0] - b[0]).map(([f, keys]) => ({ f, keys }));
}
const LIMBS = [...FIGURE.PART_GROUPS, ['fingersL', 'L fingers', FIGURE.handJoints('l')], ['fingersR', 'R fingers', FIGURE.handJoints('r')]];
// the rows of one layer (its channels, nested like Blender's: the pose under a "Pose" row, by limb)
function layerRows(L) {
  const T = new Map(tracksOf(L).map((t) => [t.ch, t])), get = (chs) => chs.map((c) => T.get(c)).filter(Boolean);
  const row = (t, label, depth, tracks, key = null) => ({ t, L, label, depth, key, tracks, dia: diamonds(tracks, t === 'chan') });
  const rows = [row('item', L.label, 0, [...T.values()], `i:${L.id}`)];
  if (!OPEN.has(`i:${L.id}`)) return rows;
  const chan = (ch, depth) => row('chan', chLabel(ch), depth, [T.get(ch)]);
  if (L.kind !== 'figure') { for (const ch of L.names) rows.push(chan(ch, 1)); return rows; }
  for (const ch of OBJ) rows.push(chan(ch, 1));
  const params = [...T.keys()].filter((c) => c.startsWith('m.') && T.get(c).keys.length);
  const pkey = `p:${L.id}`, poseTracks = get(['pn', ...JOINTS.map((j) => `j.${j}`), ...params]);
  rows.push(row('group', 'Pose', 1, poseTracks, pkey));
  if (!OPEN.has(pkey)) return rows;
  rows.push(chan('pn', 2));
  if (params.length) {
    const k = `g:${L.id}:params`;
    rows.push(row('group', 'Parameters', 2, get(params), k));
    if (OPEN.has(k)) for (const c of params) rows.push(chan(c, 3));
  }
  for (const [gid, label, parts] of LIMBS) {
    if (parts.length === 1) { rows.push(chan(`j.${parts[0]}`, 2)); continue; }
    const k = `g:${L.id}:${gid}`;
    rows.push(row('group', label, 2, get(parts.map((j) => `j.${j}`)), k));
    if (OPEN.has(k)) for (const j of parts) rows.push(chan(`j.${j}`, 3));
  }
  return rows;
}
let ROWS = [];   // what is on screen (the dope sheet's rows, or the graph's one)
const rowsNow = () => (UI.mode === 'graph' ? graphRows() : shown().flatMap(layerRows));
function graphRows() {
  const L = gLayer(), T = gTrack();
  return L && T ? [{ t: 'chan', L, label: chLabel(G.ch), depth: 0, tracks: [T], dia: diamonds([T], true) }] : [];
}
function toggleOpen(key) {
  if (OPEN.has(key)) OPEN.delete(key); else OPEN.add(key);
  store.set('deck.scene.keyopen', [...OPEN]);
  renderKeys();
}

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
  prune(allTracks(), SEL);
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
    ROWS = rowsNow();
    const rg = gRange || graphRange(graph, G.ch), n = span();
    const L = graph;
    HS = handlesOn(L, ROWS[0].tracks[0].keys);
    const plot = h('div', { class: 'graph-plot' + (L.item.mute ? ' muted' : '') }, h('canvas', { class: 'graph-cv' }),
      ...HS.map((x, i) => h('span', { class: 'khandle', 'data-h': i, title: `${x.side === 'ti' ? 'In' : 'Out'} handle${x.k.hb ? ' (broken)' : ''}` })),
      ...ROWS[0].dia.map((d, j) => keyEl(d, 0, j, `top:${yPos(rg, d.keys[0].v)}`)));
    body = [plot];
    $('#sceneNames').replaceChildren(
      h('div', { class: 'sheet-head' }, layerSel(sh, L), muteBtn(L)),
      ...chs.map((ch) => h('button', { type: 'button', class: 'sheet-name' + (ch === G.ch ? ' sel' : ''), onclick: () => { G.ch = ch; gRange = null; renderKeys(); } }, chLabel(ch))));
    lanes.replaceChildren(ruler(), ...body, h('div', { id: 'scenePlayhead', class: 'playhead', style: `left:${lanePos(R.f)}` }));
    drawGraph(plot, L, rg, n);
  } else {
    ROWS = rowsNow();
    const nameRow = (r) => {
      const L = r.L, pad = `padding-left:${r.depth * 12}px`, off = L.item.hidden || L.item.mute ? ' off' : '', mine = L.id === R.sel;
      const caret = r.key ? h('button', { type: 'button', class: 'sheet-caret', 'aria-expanded': OPEN.has(r.key), 'aria-label': `${OPEN.has(r.key) ? 'Close' : 'Open'} ${r.label}`,
        onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toggleOpen(r.key); } }, OPEN.has(r.key) ? '▾' : '▸') : h('span', { class: 'sheet-caret' });
      const name = h('button', { type: 'button', class: 'sheet-name' + (mine && (r.t === 'item' || (r.t === 'chan' && r.tracks[0].ch === G.ch)) ? ' sel' : '') + off, title: r.label,
        onclick: () => { if (r.t === 'chan' && isScalar(r.tracks[0].ch)) { G.ch = r.tracks[0].ch; gRange = null; } select(L.id); } }, r.label);
      return h('div', { class: `sheet-name-row ${r.t}`, style: pad }, r.t === 'item' ? muteBtn(L) : null, caret, name);
    };
    $('#sceneNames').replaceChildren(h('div', { class: 'sheet-head' }), ...ROWS.map(nameRow));
    lanes.replaceChildren(ruler(),
      ...ROWS.map((r, i) => h('div', { class: `sheet-lane ${r.t}` + (r.L.id === R.sel ? ' sel' : '') + (r.L.item.mute ? ' muted' : ''), 'data-track': i },
        r.t !== 'chan' && r.dia.length > 1 ? h('span', { class: 'span', style: `left:${lanePos(r.dia[0].f)};`
          + `width:calc((100% - ${2 * PAD}px) * ${(r.dia[r.dia.length - 1].f - r.dia[0].f) / (V.b - V.a)})` }) : null,
        ...r.dia.map((d, j) => keyEl(d, i, j, '')))),
      h('div', { id: 'scenePlayhead', class: 'playhead', style: `left:${lanePos(R.f)}` }));
  }
  if (G0 && G0.type === 'box' && G0.el) lanes.append(G0.el);
  if (sheet && st) sheet.scrollTop = st;
  syncTools();
  const [item] = keyTarget();
  const add = $('#sceneAddKey'), del = $('#sceneDelKey');
  if (add) add.disabled = !item;
  if (del) del.disabled = !item || !keyAt(item, R.f);
  if (add) add.classList.toggle('pending', !!item && TEMP.has(item));  // a held change to keep
  const lbl = $('#sceneKeyFor');
  if (lbl) lbl.textContent = selItem() ? selItem().name : R.sel === ROOM ? 'Room (not animated)' : 'Camera';
}

// Mute: the layer ignores its keys on screen and stays where it is (renders still use the keys); one undo step
export function toggleMute(L) {
  setMute(L.item, !L.item.mute);
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
// a diamond: one channel's key, or (on a layer's or group's row) all the keys at that frame
const easeOf = (d) => (d.keys.every((k) => (k.ease || '') === (d.keys[0].ease || '')) ? d.keys[0].ease : '');
const allSel = (d) => d.keys.every((k) => SEL.has(k));
const keyEl = (d, ri, j, style) => h('span', { class: `key e-${easeOf(d) || 'def'}` + (d.keys.length > 1 ? ' sum' : '') + (allSel(d) ? ' sel' : '') + (d.f === R.f ? ' on' : ''),
  'data-key': j, 'data-l': ri, style: `left:${lanePos(d.f)};${style}`,
  title: `Key at ${(d.f / FPS).toFixed(2)} s · frame ${d.f + 1}${d.keys.length > 1 ? ` · ${d.keys.length} channels` : easeOf(d) ? ` · ${easeOf(d)}` : ''}` });

function drawGraph(plot, L, rg, n) {
  const cv = plot.firstChild, dpr = Math.min(window.devicePixelRatio || 1, 2), w = plot.clientWidth, hh = plot.clientHeight;
  if (!w || !hh) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  const c = cv.getContext('2d'), cs = getComputedStyle(plot);
  c.scale(dpr, dpr);
  const col = (v, d) => cs.getPropertyValue(v).trim() || d;
  const X = (f) => PAD + (w - 2 * PAD) * (f - V.a) / (V.b - V.a), Y = (v) => GP + (hh - 2 * GP) * (rg.hi - v) / (rg.hi - rg.lo);
  c.font = canvasFont(10); c.textBaseline = 'bottom';
  // horizontal guides at round values
  const raw = (rg.hi - rg.lo) / 4, mag = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  for (let v = Math.ceil(rg.lo / st) * st; v <= rg.hi; v += st) {
    c.strokeStyle = col('--line', '#333'); c.lineWidth = 1; c.beginPath(); c.moveTo(0, Y(v)); c.lineTo(w, Y(v)); c.stroke();
    c.fillStyle = col('--muted', '#888'); c.fillText(+v.toFixed(3), 3, Y(v) - 1);
  }
  c.strokeStyle = col('--accent', '#e9b44c'); c.lineWidth = 2; c.beginPath();
  const f0 = Math.max(0, Math.floor(V.a)), f1 = Math.min(n, Math.ceil(V.b));
  // a few px a step, so a bezier between keys a frame or two apart still shows its shape
  const step = Math.min(1, Math.max(1 / 16, 3 / pxf()));
  for (let f = f0; f <= f1 + 1e-9; f += step) { const v = sampleCh(L, G.ch, f); if (f === f0) c.moveTo(X(f), Y(v)); else c.lineTo(X(f), Y(v)); }
  c.stroke();
  // the selected keys' handles: a line from the key, the dot at least MINH px out (a short one is drawn longer, same direction)
  const els = plot.querySelectorAll('[data-h]');
  c.strokeStyle = col('--muted', '#888'); c.lineWidth = 1.5;
  HS.forEach((x, i) => {
    const kx = X(x.k.f), ky = Y(x.k.v);
    let hx = X(x.k.f + x.dt) - kx, hy = Y(x.k.v + x.dv) - ky;
    const len = Math.hypot(hx, hy);
    if (len < MINH) { const s = len > 1e-6 ? MINH / len : 0; hx = len > 1e-6 ? hx * s : (x.side === 'to' ? MINH : -MINH); hy *= s; }
    c.beginPath(); c.moveTo(kx, ky); c.lineTo(kx + hx, ky + hy); c.stroke();
    if (els[i]) Object.assign(els[i].style, { left: `${kx + hx}px`, top: `${ky + hy}px` });
  });
}
// the handles on show: the selected keys' of the graph's channel, on the sides that have a curve
const MINH = 30;
let HS = [];
function handlesOn(L, list) {
  const out = [], segOf = (k) => k.ease || L.item.ease || 'smooth';
  list.forEach((k, j) => {
    if (!SEL.has(k) || typeof k.v !== 'number') return;
    const sides = [];
    if (j > 0 && CURVES.has(segOf(list[j - 1]))) sides.push(['ti', segOf(list[j - 1])]);
    if (j < list.length - 1 && CURVES.has(segOf(k))) sides.push(['to', segOf(k)]);
    for (const [side, mode] of sides) { const [dt, dv] = handleOf(list, j, side, mode); out.push({ k, j, side, mode, dt, dv }); }
  });
  return out;
}

// ---- selection API (the sheet's buttons and the keyboard go through these) ----------------------
export function selectKeys(keys, add = false) { if (!add) SEL.clear(); keys.forEach((k) => SEL.add(k)); renderKeys(); }
const poolNow = () => (UI.mode === 'graph' ? (gTrack()?.keys || []) : allKeys(allTracks()));
export const selectAll = () => selectKeys(poolNow());
export const selectNone = () => selectKeys([]);
export function selectInvert() {
  const pool = poolNow();
  selectKeys(pool.filter((k) => !SEL.has(k)));
}
// every edit below is one undo step
const done = () => changed();
export function moveKeys(dt) { if (!SEL.size) return 0; const d = moveBy(allTracks(), SEL, dt, frames()); done(); return d; }
export function scaleKeys(s, t0 = R.f) { if (!SEL.size) return; scaleAround(allTracks(), SEL, t0, s, frames()); done(); }
export function deleteKeys() {
  if (!SEL.size) return;
  const tracks = allTracks();
  for (const T of tracks) {  // a channel that loses its last key stays as it looks now (like Clear keys)
    if (T.keys.length && T.keys.every((k) => SEL.has(k))) bakeBase(T.item, T.ch, sampleChan(T.item, T.ch, R.f));
  }
  const c = remove(tracks, SEL); TEMP.clear(); done(); toast(`${c} key${c > 1 ? 's' : ''} deleted`);
}
// an ease (or 'hb:1' / 'hb:0': break or align the handles) for every selected key
export function setKeyEase(ease) {
  if (!SEL.size) return;
  if (ease === 'hb:1' || ease === 'hb:0') setBroken(SEL, ease === 'hb:1'); else setEase(SEL, ease, allTracks());
  done();
}

// the clipboard is kept in memory and in localStorage, so a tab switch (another scene) still has it
const CLIP = 'deck.scene.keyclip';
let clip = null;
export function copyKeys() {
  const c = copy(allTracks(), SEL);
  if (!c) return false;
  clip = c; store.set(CLIP, c); syncTools();
  toast(`${SEL.size} key${SEL.size > 1 ? 's' : ''} copied`);
  return true;
}
const getClip = () => { clip ||= store.get(CLIP, null); return clip?.v === 2 ? clip : null; };   // (a clipboard from before per-channel keys is no use)
// paste with the first key at t (the playhead): onto the selected layer if it fits, else where they came from
export function pasteKeys(t = R.f, c = getClip()) {
  if (!c || !c.groups?.length) { toast('Nothing copied', true); return null; }
  const [it] = keyTarget();
  const pick = shown().find((L) => L.item === (it || (R.sel === ROOM ? null : SC.camera))) || null;
  const r = paste(allTracks(), c, t, frames(), { pick });
  if (!r.groups) { toast('Those keys don\'t fit here', true); return null; }
  SEL.clear(); r.keys.forEach((k) => SEL.add(k));
  TEMP.clear(); done();
  if (r.dropped) toast(`${r.dropped} key${r.dropped > 1 ? 's' : ''} past the end left out`, true);
  return r;
}
// copy and paste straight after the selection (a lone key goes half a second on)
export function duplicateKeys() {
  const b = bounds(allTracks(), SEL);
  if (!b) return null;
  const c = copy(allTracks(), SEL);
  return pasteKeys(b[0] + (b[1] > b[0] ? b[1] - b[0] + 1 : 12), c);
}

// ---- gestures -----------------------------------------------------------------------------------
let G0 = null, nPtr = 0;
const ptrs = new Map();
const info = (t) => { const el = $('#sceneKeyInfo'); if (el) el.textContent = t ?? (SEL.size ? `${SEL.size} selected` : ''); };

function syncSelClasses() {
  for (const el of lanesEl().querySelectorAll('[data-key]')) { const d = diaOf(el); el.classList.toggle('sel', !!d && allSel(d)); }
  syncTools();
}
const diaOf = (el) => ROWS[+el.dataset.l]?.dia[+el.dataset.key];
const keyOf = (el) => diaOf(el)?.keys || [];   // (a summary diamond is all the keys under it)

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
    G0 = { ...base, type: 'scale', phx, d0: Math.max(24, Math.abs(e.clientX - phx)), snap: snapshot(allTracks()) };
    return;
  }
  const hEl = t.closest('[data-h]');
  if (hEl && HS[+hEl.dataset.h]) {  // a bezier handle: dragged by how far the pointer goes (a short one is drawn longer)
    const x = HS[+hEl.dataset.h], T = gTrack();
    G0 = { ...base, type: 'handle', x, T, dt0: x.dt, dv0: x.dv, snap: snapshot([T]) };
    return;
  }
  const row = keyEl2 ? ROWS[+keyEl2.dataset.l] : laneEl ? ROWS[+laneEl.dataset.track] : null, L = row?.L || null;
  if (keyEl2) {
    const keys = keyOf(keyEl2), was = keys.every((k) => SEL.has(k));
    if (UI.add) { if (!was) keys.forEach((k) => SEL.add(k)); } else if (!was) { SEL.clear(); keys.forEach((k) => SEL.add(k)); }
    G0 = { ...base, type: 'key', keys, was, L, row };
    if (L && L.id !== R.sel && UI.mode !== 'graph') select(L.id); else renderKeys();
    return;
  }
  if (L && L.id !== R.sel && UI.mode !== 'graph') select(L.id);
  // empty space: a finger pans (unless Box is on); a mouse or pen draws a box
  const box = e.pointerType === 'touch' ? UI.box : true;
  const sheet = $('#sceneSheet');
  G0 = box ? { ...base, type: 'box', start: new Set(UI.add ? SEL : []), L, row, el: h('div', { class: 'sel-box' }), fresh: true }
    : { ...base, type: 'pan', a0: V.a, b0: V.b, st0: sheet.scrollTop, L, row };
}

function abort() {
  const g = G0; G0 = null;
  if (g?.type === 'handle' && g.moved) { restore(g.snap); pose(R.f); draw(); renderKeys(); }
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
      if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) keyOf(el).forEach((k) => SEL.add(k));
    }
    syncSelClasses(); info();
    return;
  }
  if (g.type === 'handle') {
    if (!g.moved) { g.moved = true; gRange = graphRange(gLayer(), G.ch); }
    restore(g.snap);
    const rg = gRange, list = g.T.keys, j = list.indexOf(g.x.k);
    if (j < 0) return;
    let dt = g.dt0 + dx / pxf();
    const dv = g.dv0 - dy / Math.max(40, $('.graph-plot').clientHeight - 2 * GP) * (rg.hi - rg.lo);
    if (UI.snap && !e.altKey) { const r = Math.round(dt); dt = r || Math.sign(dt); }   // (snap: whole frames; Alt frees it)
    moveHandle(list, j, g.x.side, dt, dv, g.x.mode);
    info(`${g.x.side === 'ti' ? 'In' : 'Out'} ${dt.toFixed(1)} f · ${dv >= 0 ? '+' : ''}${dv.toFixed(2)}`);
    pose(R.f); draw(); renderKeys();
    return;
  }
  // moving keys: from the snapshot each time, so the drag follows the pointer exactly
  if (!g.moved) {
    g.tracks = allTracks();
    g.moved = true; g.snap = g.snap || snapshot(g.tracks); g.held = new Set(SEL);  // (a collision drops keys from SEL; the snapshot brings them back)
    if (g.type === 'key') {
      g.cands = [R.f, ...allKeys(g.tracks).filter((k) => !SEL.has(k)).map((k) => k.f)];
      if (UI.mode === 'graph') {
        const L = gLayer(); g.gL = L; g.gT = gTrack(); gRange = graphRange(L, G.ch);
        g.vals = new Map(g.gT.keys.filter((k) => SEL.has(k)).map((k) => [k, k.v]));
      }
    }
  }
  restore(g.snap); SEL.clear(); g.held.forEach((k) => SEL.add(k));
  if (g.type === 'scale') {
    const s = scaleAround(g.tracks, SEL, R.f, Math.abs(e.clientX - g.phx) / g.d0, frames());
    info(`× ${s.toFixed(2)}`);
  } else {
    g.mine = [...SEL].map((k) => ({ f0: k.f }));
    const dt = snapDt(Math.round(dx / pxf()), g), d = moveBy(g.tracks, SEL, dt, frames());
    let t = `${d >= 0 ? '+' : ''}${d} f`;
    if (g.vals) {
      const rg = gRange, dv = -dy / Math.max(40, $('.graph-plot').clientHeight - 2 * GP) * (rg.hi - rg.lo);
      for (const [k, v0] of g.vals) {
        if (g.gT.keys.includes(k)) setChan(k, v0 + dv);
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
    if (UI.add) { if (g.was) g.keys.forEach((k) => SEL.delete(k)); } else { SEL.clear(); g.keys.forEach((k) => SEL.add(k)); seek(g.keys[0].f); }
    renderKeys(); info();
    return;
  }
  if (g.type === 'scale' || g.type === 'handle') { if (g.moved) done(); info(); return; }
  if (g.el) g.el.remove();
  if (!g.moved) {  // a tap on empty space: deselect (unless adding) and move the playhead
    if (!UI.add) SEL.clear();
    seek(frameAtX(e.clientX)); info();
    doubleTap(e, g.row);
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
    if (needs) b.disabled = needs === 'sel' ? !SEL.size : !getClip();
  }
  info();
}
const setUI = (k, v) => { UI[k] = v; if (k === 'mode') store.set('deck.scene.keymode', v); if (k === 'unit') store.set('deck.scene.keyunit', v); if (k === 'snap') store.set('deck.scene.keysnap', v); };
// a number slider in the menu: fn(v) once it is typed or let go (then it reads val again)
const numIn = (label, val, fn, title, { min, max, step = 1 }, w = 84) => {
  const i = numSlider({ min, max, step, value: val, label });
  i.style.width = `${w}px`;
  i.addEventListener('change', () => { const v = parseFloat(i.value); i.set(val); if (Number.isFinite(v) && v !== val) fn(v); });
  return h('label', { class: 'keynum', title }, label, i);
};

// the ⋯ menu: fixed to the viewport (the tool row scrolls and would clip it), inside the stage (so full screen keeps it)
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; removeEventListener('pointerdown', menuAway, true); }
function menuAway(e) { if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.kt-more')) closeMenu(); }
function openMenu(anchor) {
  if (menuEl) { closeMenu(); return; }
  const item = (label, fn, keep = false) => h('button', { type: 'button', class: 'btn small ghost', onclick: () => { fn(); if (!keep) closeMenu(); } }, label);
  menuEl = h('div', { class: 'key-menu', role: 'menu' },
    item('Select none', selectNone), item('Invert selection', selectInvert), item('Duplicate (Ctrl+D)', duplicateKeys),
    numIn('Shift (frames)', 0, (v) => { moveKeys(v); closeMenu(); }, 'Move the selected keys by this many frames', { min: -frames(), max: frames() }),
    numIn('Scale (%)', 100, (v) => { scaleKeys(v / 100); closeMenu(); }, 'Stretch the selected keys around the playhead, in percent', { min: 5, max: 500 }),
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
      h('option', { value: '~' }, 'Ease…'), h('optgroup', { label: 'Between keys' }, ...EASES.map(([v, l]) => h('option', { value: v }, l))),
      h('optgroup', { label: 'Bezier handles' }, h('option', { value: 'hb:0' }, 'Aligned'), h('option', { value: 'hb:1' }, 'Broken')));
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

// ---- adding keys by hand (double-tap): keys on the row's channels with the values they have there, so nothing
// moves. A channel's row keys that channel, a limb's row its joints, a layer's row (and Pose) what ◆ Key would.
function insertKeys(row, f, v = null) {
  const item = row.L.item, names = row.L.names;
  const wide = row.t === 'item' || row.key?.startsWith('p:'), ok = wide ? new Set(keyChans(item, names, sample(item, names, f))) : null;
  const made = row.tracks.filter((T) => !ok || ok.has(T.ch)).map((T) => setKey(item, T.ch, f, v ?? sampleChan(item, T.ch, f)));
  TEMP.clear(); SEL.clear(); made.forEach((k) => SEL.add(k));
  done(); seek(f);
  return made;
}
// the value under a tap on the graph's plot
function valueAtY(y) {
  const r = $('.graph-plot').getBoundingClientRect(), rg = gRange || graphRange(gLayer(), G.ch);
  const t = Math.max(0, Math.min(1, (y - r.top - GP) / Math.max(1, r.height - 2 * GP)));
  return rg.hi - t * (rg.hi - rg.lo);
}
let lastTap = null;   // the previous tap on empty space, for the double-tap
function doubleTap(e, row) {
  const now = e.timeStamp, prev = lastTap;
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (!prev || now - prev.t > 600 || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 28) return;
  lastTap = null;
  const f = frameAtX(e.clientX);
  if (UI.mode === 'graph') { const r = graphRows()[0]; if (r) insertKeys(r, f, valueAtY(e.clientY)); }
  else if (row) insertKeys(row, f);
}

export function renderTime() {
  const t = $('#sceneTime');
  if (t) t.textContent = `${(R.f / FPS).toFixed(2)} s · ${R.f + 1}/${frames()}`;
  const ph = $('#scenePlayhead');
  if (ph) ph.style.left = lanePos(R.f);
  // While playing, Key sheet follows: a zoomed-in sheet turns the page when the playhead leaves it
  if (R.playing && WP.follow && !V.fit && !G0 && (R.f < V.a || R.f > V.b)) {
    const w = V.b - V.a; V.a = R.f < V.a ? Math.max(0, R.f - w * 0.9) : R.f - w * 0.1; V.b = V.a + w; renderKeys();
  }
  syncRec();
}

// ---- while playing: what shows (WP, per device) and Record ---------------------------------------------
const WPK = 'deck.scene.whileplaying';
export function loadPlaySettings() {
  Object.assign(WP, store.get(WPK, {}));
  R.record = store.get('deck.scene.record', false) === true;
}
export function setRecord(on) {
  R.record = !!on; store.set('deck.scene.record', R.record);
  const b = $('#sceneRec');
  if (b) { b.classList.toggle('on', R.record); b.setAttribute('aria-pressed', R.record); }
}
// the REC button glows while something is being recorded
function syncRec() {
  const b = $('#sceneRec');
  if (b) b.classList.toggle('live', R.record && R.playing && HOLD.items.size > 0);
}
const WP_OPTS = [['gizmo', 'Gizmo'], ['dots', 'Joint dots'], ['frustum', 'Camera frustum (director view)'], ['grid', 'Grid'],
  ['follow', 'Key sheet follows playhead'], ['back', 'Jump back on release']];
let wpEl = null;
function closeWP() { wpEl?.remove(); wpEl = null; removeEventListener('pointerdown', wpAway, true); }
function wpAway(e) { if (wpEl && !wpEl.contains(e.target) && !e.target.closest('#sceneWP')) closeWP(); }
function openWP(anchor) {
  if (wpEl) { closeWP(); return; }
  wpEl = h('div', { class: 'key-menu wp-menu', role: 'menu', 'aria-label': 'While playing' },
    h('div', { class: 'wp-head' }, h('b', {}, 'While playing'),
      infoBtn('Show these while it plays (everything can still be dragged, tapped and changed). Jump back on release: after you let go of something you changed while it played, the playhead goes back to where you took hold and plays on, so you see the change at once; without Record the key goes there too.')),
    ...WP_OPTS.map(([k, label]) => toggle(label, WP[k], (on) => { WP[k] = on; store.set(WPK, { ...WP }); draw(); })));
  (stage() || document.body).append(wpEl);
  const r = anchor.getBoundingClientRect(), mh = wpEl.offsetHeight, mw = wpEl.offsetWidth;
  const top = r.bottom + 4 + mh > innerHeight ? Math.max(4, r.top - 4 - mh) : r.bottom + 4;
  Object.assign(wpEl.style, { top: `${top}px`, left: `${Math.max(4, Math.min(innerWidth - mw - 4, r.left))}px` });
  addEventListener('pointerdown', wpAway, true);
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
      button('👁', (e) => openWP(e.currentTarget), { id: 'sceneWP', cls: 'small kt', title: 'While playing: what shows, and jumping back after an edit', 'aria-label': 'While playing' }),
      h('span', { id: 'sceneTime', class: 'timecode' }),
      h('span', { class: 'grow' }),
      button('● Auto key', () => setAutoKey(!R.autoKey), { id: 'sceneAutoKey', cls: 'small autokey' + (R.autoKey ? ' on' : ''), 'aria-pressed': R.autoKey,
        title: 'Auto key (K): on, a change to something animated sets a key at the playhead. Off, it shifts the whole animation (or edits the key under the playhead).' }),
      button('REC', () => setRecord(!R.record), { id: 'sceneRec', cls: 'small rec' + (R.record ? ' on' : ''), 'aria-pressed': R.record,
        title: 'Record: while it plays, what you hold (gizmo, slider, orbit) is keyed every few frames over the time you hold it' }),
      h('span', { class: 'hint' }, 'Key: ', h('b', { id: 'sceneKeyFor' })),
      button('◆ Key', () => {
        const [item, names] = keyTarget(); if (!item) return;
        addKey(item, names); changed();
      }, { id: 'sceneAddKey', title: 'Keyframe at the playhead' }),
      button('✕ Key', () => {
        const [item] = keyTarget(); if (!item) return;
        dropKeys(item, (f) => f === R.f); changed();
      }, { id: 'sceneDelKey', title: 'Remove the key at the playhead' })),
    toolRow()),
    grip(),
    h('div', { id: 'sceneSheet', class: 'scene-sheet' }, h('div', { id: 'sceneNames', class: 'sheet-names' }), lanes));
  applySheetH(); applyTools();
  $('#sceneTransport').classList.toggle('hidden', modeOf().lanes === 'none');
  renderTime(); renderKeys();
}

// ---- the 3D viewport, full screen: the shared full screen (layout.js fullScreen, the panel pulls out) --------
const stage = () => $('#tab-scene .stage');
let sceneMax = null;
export const maxBar = () => (sceneMax ||= fullScreen($('#tab-scene'), { viewer: $('#sceneViewer'), title: 'Full screen the 3D view' })).btn;

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
