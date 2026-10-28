// Compositions: 3D scenes (3D tab documents, kind scene-tabs) as clips on the video timeline, live-linked.
// A clip is { kind: 'scene', src: { scene: <3D tab id>, look: 'color'|'clay'|'depth'|'pose' }, nat: [w, h], ... }
// and only names the scene: the scene itself is read from the store, so an edit in the 3D tab reaches every
// video tab using it (and other devices, through the store's websocket events). Drawing is scene-offscreen.js,
// loaded the first time a scene clip needs it. Light on purpose: video.js (loaded with the app) imports this.
import { api, canvasFont } from './ui.js';
import { S, onProject, onServer } from './core.js';

const KIND = 'scene-tabs';
const FPS = 24;   // the 3D tab's frame rate (scene-data.js FPS): scene time is frames / 24
const BATCH = 40;   // frames per upload
const SCENES = new Map();   // scene tab id -> { state: 'loading' | 'ok' | 'missing' | 'error', name, rev, stage, nat, dur }
const CANVAS = new Map();   // clip id -> { cv, key, it }

let used = () => [], changed = () => {}, visible = () => true;
// video.js: which scene ids its timeline uses, what to do when a scene changed, whether the video tab is on show
export function wire(o) { used = o.ids; changed = o.onChange; visible = o.visible; }
const EXTRA = new Set();   // scenes asked for by id before the timeline lists them (the add menu)

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const url = (id = '') => `/api/store/${KIND}${id ? `/${id}` : ''}${qs()}`;
export const sceneOf = (id) => SCENES.get(id) || null;
export const lookName = (look) => ({ color: 'Color', clay: 'Clay', depth: 'Depth', pose: 'Pose' })[look] || look;

// the project's 3D tabs, for the add menu
export async function listScenes() {
  const rows = await api(url(), { busy: false });
  for (const r of rows) { const d = SCENES.get(r.id); if (d && d.name !== r.name) { d.name = r.name; changed(r.id); } }
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

// ---- keeping what's used in step with the store ----
let running = null, again = false, stale = false;
export function refresh(force = false) {
  if (!force && !visible()) { stale = true; return Promise.resolve(); }   // (a 3D tab saves every second while it is edited: the video tab catches up when it is on show)
  stale = false;
  if (running) { again = true; return running; }
  running = sync().catch((e) => console.error(e)).finally(() => { running = null; if (again) { again = false; refresh(); } });
  return running;
}
export const refreshIfStale = () => { if (stale) refresh(); };

async function sync() {
  const ids = [...new Set([...used(), ...EXTRA])];
  if (!ids.length) return;
  let rows;
  try { rows = await api(url(), { busy: false }); } catch { return; }   // offline: keep what's built
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    let d = SCENES.get(id);
    if (!d) SCENES.set(id, d = { state: 'loading', name: '', rev: 0, stage: null });
    if (!row) {
      if (d.state !== 'missing') { d.stage?.dispose(); Object.assign(d, { state: 'missing', stage: null }); changed(id); }
      continue;
    }
    if (d.name !== row.name) { d.name = row.name; changed(id); }
    if (d.rev === row.rev && d.stage) continue;
    try {
      const doc = await api(url(id), { busy: false }), p = doc.payload;
      if (!p || p.v !== 1 || !Array.isArray(p.objects)) throw new Error('not a 3D scene');
      const { Stage } = await import('./scene-offscreen.js');
      const stage = new Stage(p);
      stage.onChange = () => changed(id, true);
      d.stage?.dispose();
      Object.assign(d, { state: 'ok', rev: doc.rev, name: doc.name, stage, nat: [stage.w, stage.h], dur: stage.dur });
    } catch (e) { console.error(`3D scene ${id}:`, e); if (!d.stage) d.state = 'error'; }
    changed(id);
  }
}

// one scene, now (the add menu needs its length and size)
export async function load(id) {
  EXTRA.add(id);
  await refresh(true);
  return SCENES.get(id);
}

onServer('store', (m) => {
  if (m.kind !== KIND || m.scope !== 'project' || (m.project_id ?? null) !== (S.project ?? null)) return;
  clearTimeout(refresh.t); refresh.t = setTimeout(refresh, 300);
});
onServer('ws_open', () => refresh());
onProject(() => {   // another project has other scenes
  for (const d of SCENES.values()) d.stage?.dispose();
  SCENES.clear(); CANVAS.clear();
});

// ---- the preview ----
// clip's natural size (what geom() in video.js reads): the scene's output size, or what it last was
export const natOf = (it) => SCENES.get(it.src.scene)?.nat || it.nat || [1280, 720];

// The clip's picture at timeline time t, drawn at w×h into a canvas of its own (same canvas every call; it
// has naturalWidth / naturalHeight like an image so the clip geometry treats it like one)
function entry(it) {
  let c = CANVAS.get(it.id);
  if (!c) {
    const cv = document.createElement('canvas');
    c = { cv, key: '', it };
    Object.defineProperties(cv, { naturalWidth: { get: () => natOf(c.it)[0] }, naturalHeight: { get: () => natOf(c.it)[1] } });
    CANVAS.set(it.id, c);
  }
  c.it = it;
  return c;
}
export const canvasFor = (it) => entry(it).cv;   // (not drawn yet: it has its natural size, so the clip's geometry is known)
export function frame(it, t, w, h) {
  const c = entry(it);
  w = Math.max(16, Math.min(2048, Math.round(w))); h = Math.max(16, Math.min(2048, Math.round(h)));
  const cv = c.cv, d = SCENES.get(it.src.scene);
  if (!d || d.state !== 'ok') return notice(c, w, h, d?.state || 'loading');
  const f = Math.min(Math.max(0, it.in + t - it.at), d.dur) * FPS;
  const key = `${d.stage.id}|${d.stage.version}|${it.src.look}|${f.toFixed(3)}|${w}x${h}`;
  if (c.key === key) return cv;   // (drawn already: a gizmo drag redraws many times)
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  try { d.stage.draw(it.src.look || 'color', f, cv); c.key = key; } catch (e) { console.error(e); return notice(c, w, h, 'error'); }
  return cv;
}
const NOTICE = { loading: 'Loading 3D scene…', missing: '3D scene deleted', error: "Can't show this 3D scene" };
function notice(c, w, h, state) {
  const cv = c.cv, key = `${state}|${w}x${h}`;
  if (c.key === key) return cv;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = state === 'loading' ? '#20242c' : '#3a1f22'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e9d6d6'; ctx.font = canvasFont(Math.round(Math.max(14, w / 22))); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(NOTICE[state] || state, w / 2, h / 2);
  c.key = key;
  return cv;
}
export const forget = (ids) => { for (const id of [...CANVAS.keys()]) if (!ids.has(id)) CANVAS.delete(id); EXTRA.clear(); };

// n frames, drawn by draw(k) → a canvas (the same size each time), as a temporary mp4 on the server
// (POST /api/scene/clip, in batches) that /api/video/render takes as a clip: { clip, frames, duration }.
// The 3D compositions here and the Editor's animations both export this way.
export async function framesToClip(n, fps, draw, progress = () => {}) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  let form = new FormData(), start = 0, res = null;
  const send = async (done) => {
    form.append('token', token); form.append('start', start); form.append('fps', fps); form.append('done', done ? 'true' : 'false');
    res = await api('/api/scene/clip', { method: 'POST', form, busy: false });
    form = new FormData(); start += BATCH;
  };
  for (let k = 0; k < n; k++) {
    const cv = await draw(k);
    form.append('frames', await new Promise((r) => cv.toBlob(r, 'image/png')), `f${String(k).padStart(5, '0')}.png`);
    if ((k + 1) % BATCH === 0 && k + 1 < n) await send(false);
    progress(k + 1, n);
  }
  await send(true);
  return res;
}

// ---- export: the clip's frames at the export size and rate, as a temporary video on the server ----
// W, H: the sequence frame; len: seconds of the clip. Returns { clip, scene } for the render request.
const even = (v) => Math.max(2, 2 * Math.round(v / 2));
export async function exportClip(it, { W, H, fps, len, progress = () => {} }) {
  await refresh();
  let d = SCENES.get(it.src.scene);
  if (!d || d.state === 'loading') d = await load(it.src.scene);
  if (!d || d.state === 'missing') throw new Error(`The 3D scene "${it.label}" was deleted`);
  if (d.state !== 'ok') throw new Error(`Can't show the 3D scene "${it.label}"`);
  const { stage } = d, look = it.src.look || 'color', rev = d.rev;
  await stage.whenReady();
  // rendered as big as the preview draws it (and no bigger than twice the frame), so the picture matches
  const base = (it.fit === 'fill' ? Math.max : Math.min)(W / stage.w, H / stage.h) * Math.min(2, Math.max(1, it.scale || 1));
  const w = even(stage.w * base), h = even(stage.h * base), n = Math.max(1, Math.round(len * fps));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const res = await framesToClip(n, fps, async (k) => {
    const f = Math.min(it.in + k / fps, stage.dur) * FPS;
    stage.draw(look, f, cv);
    if (stage.hasSplat) { await stage.settle(); stage.draw(look, f, cv); }   // (a splat's sort needs a moment after the camera moves)
    return cv;
  }, progress);
  return { clip: res.clip, scene: { id: it.src.scene, name: d.name, look, rev } };
}
