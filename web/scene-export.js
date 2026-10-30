import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import { C, FPS, R, SC, TEMP, commitHolds, frames, holdEnd, recordFrame, settleTemp, shots } from './scene-data.js';
import {
  RANGE, SPLAT_PASS, camera, draw, fit, floorMat, paint, pose, rangeMat, refresh, renderer, scene, setRange, wallMat
} from './scene-view.js';
import { renderDepth, splatDepths, splatMeshes } from './splat-depth.js';
import { api, busy as busyBar, toast } from './ui.js';
import { modeOf } from './scene-modes.js';
import { renderKeys, renderPanel, renderTime, renderTransport, setStatus } from './scene-ui.js';
import { bound, frameSpan, playFrom, tickT } from './workarea-math.js';
import { AREA } from './scene-keys.js';
import { frameRanges } from './depth-range.js';

// the work area (scene-keys.js AREA, SC.range in frames) while it is on: play loops in it, seeks stay in it
const area = () => bound(SC.range, frames() - 1, 0);
// one shot of an Each-shot render, else the work area (Range only) or the whole clip
let clip = null;
const renderSpan = () => clip || frameSpan(AREA.exportRange(), frames(), 1, true);
// sample indexes where a cut falls, so a depth range never smooths across it
function cutBreaks(first, count) {
  return shots().map((s) => s.f0 - first).filter((i) => i > 0 && i < count);
}

// ---- playback ----------------------------------------------------------------------
// Everything stays live while it plays: an edit is held over the keys while the user holds it
// (scene-data.js HOLD) and lands when they let go. Only renders need it stopped.
let raf = 0, t0 = 0, f0 = 0;
export function play() {
  if (R.playing) return stopPlay();
  R.playing = true; TEMP.clear();
  t0 = performance.now(); f0 = playFrom(R.f, area(), frames() - 1);
  const step = (now) => {
    if (!R.playing) return;
    R.f = Math.floor(f0 + (now - t0) / 1000 * FPS);
    const st = tickT(R.f, area(), frames() - 1, true, true);   // (loops in the work area while it is on)
    if (st.t !== R.f) { R.f = st.t; f0 = st.t; t0 = now; }
    pose(R.f); draw(); renderTime(); recordFrame(R.f);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  renderTransport();
}
export function stopPlay() {
  if (!R.playing) return;
  commitHolds();   // (a hold still going lands now; what the gesture does next is an ordinary edit)
  R.playing = false; cancelAnimationFrame(raf); settleTemp();
  renderTransport(); renderPanel(); pose(R.f); draw();
}
export function seek(f) {
  f = Math.max(0, Math.min(frames() - 1, Math.round(f)));
  const a = area();
  if (a) f = Math.max(a.a, Math.min(a.b, f));
  if (R.playing) {   // it plays on from there (the panel is brought up to date when it stops)
    R.f = f; f0 = f; t0 = performance.now();
    pose(R.f); draw(); renderTime(); renderKeys();
    return;
  }
  if (f !== R.f) TEMP.clear();  // held changes (auto key off) stay on their frame
  R.f = f; pose(R.f); draw(); renderTime(); renderKeys(); renderPanel();
}
// a gesture that edits ends: what it held lands, and (While playing: Jump back) the playhead goes back
// to where the hold began, so the change is seen straight away
export function letGo(src) {
  const at = holdEnd(src);
  if (at != null && R.playing) seek(at);
}

// ---- export ----------------------------------------------------------------------
const decodeDepth = (r, g, b) => r / 255 + g / 65025 + b / 16581375;  // rangeMat's packing, undone

// near / far per frame of the render (depth-range.js): each frame's depths sampled small, then fitted to the shot
// ("Follow the shot", the default) or to the whole clip (SC.depthRange = 'clip')
function measureRanges() {
  const W = 128, H = Math.max(8, Math.round(128 * SC.height / SC.width));
  const rt = new THREE.WebGLRenderTarget(W, H);
  const buf = new Uint8Array(W * H * 4);
  draw('range');
  const bg = scene.background; scene.background = null;
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = rangeMat;
  const { first, count } = renderSpan(), samples = [];
  for (let f = first; f < first + count; f++) {
    pose(f);
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const zs = [];
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] < 128) continue;  // nothing drawn here
      zs.push(decodeDepth(buf[i], buf[i + 1], buf[i + 2]) * RANGE);
    }
    for (const z of splatDepths(splatMeshes(R.meshes.values()), camera)) zs.push(z);   // (rangeMat can't draw splats)
    samples.push(zs);
  }
  renderer.setRenderTarget(null); rt.dispose();
  scene.background = bg;
  if (!samples.some((z) => z.length)) throw new Error('Nothing in view');
  return frameRanges(samples, { mode: SC.depthRange === 'clip' ? 'clip' : 'follow', window: Math.round(FPS / 2), breaks: cutBreaks(first, count) });
}

function targetToBlob(rt, W, H, gray) {
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {  // WebGL rows run bottom-up
    const src = (H - 1 - y) * W * 4, dst = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      img.data[dst + x] = buf[src + x];
      img.data[dst + x + 1] = gray ? buf[src + x] : buf[src + x + 1];
      img.data[dst + x + 2] = gray ? buf[src + x] : buf[src + x + 2];
      img.data[dst + x + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}

// the first place in our own code an error came from, for a toast: " (at scene-export.js:292)"
const where = (e) => { const m = String(e?.stack || '').split('\n').slice(1).map((l) => l.match(/\/([\w.-]+\.js)[^:]*:(\d+)/)).find(Boolean); return m ? ` (at ${m[1]}:${m[2]})` : ''; };

export let busy = false;
// A render under way can be stopped (✕ Cancel on the panel or in its toast): the frame loop checks
// between frames. Stopped while encoding, the clip the server made is deleted. Nothing is kept either way.
let stopAsked = false;
class Cancelled extends Error {}
export function cancelRender() { if (busy && !stopAsked) { stopAsked = true; setStatus('Cancelling…'); } }
const checkStop = () => { if (stopAsked) throw new Cancelled(); };
const cancelToast = (what) => toast(what, false, { label: '✕ Cancel', fn: cancelRender, stay: true });
const cancelled = () => { setStatus('Render cancelled'); toast('Render cancelled: nothing was saved'); };
// (Create object's empty stage isn't the shot: only the scene is rendered)
function canRender() {
  if (modeOf().stage !== 'empty') return true;
  toast('This stage is empty: switch to Edit scene or Camera to render the shot', true);
  return false;
}

// true once it is saved (false: cancelled, failed or not started)
export async function renderDepthVideo(part = null, { objectsOnly = false } = {}) {
  if (!objectsOnly && (SC.depthFrom === 'picture' || SC.depthFrom === 'combo')) return depthFromPicture(part);
  if (part == null && SC.renderShots === 'each') return renderEach(renderDepthVideo);
  if (busy || !canRender()) return false;
  clip = part ? { first: part.f0, count: part.f1 - part.f0 + 1 } : null;
  busy = true; stopAsked = false; R.real = true; stopPlay(); TEMP.clear(); renderPanel();  // only what's keyed goes in the render (mute is ignored)
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering depth frames…');
  cancelToast('Rendering the depth video…');
  try {
    if (objectsOnly) for (const m of R.meshes.values()) if (m.userData.splat) { m.userData.hid = m.visible; m.visible = false; }   // (splats come from the picture)
    const ranges = measureRanges();
    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.NoColorSpace });
    draw('depth');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData(), { first, count } = renderSpan();
    for (let k = 0; k < count; k++) {
      pose(first + k);
      setRange(ranges[k]);
      renderer.setRenderTarget(rt); renderDepth(renderer, scene, camera, objectsOnly ? null : SPLAT_PASS.spark); renderer.setRenderTarget(null);
      form.append('frames', await targetToBlob(rt, W, H, true), `f${String(k).padStart(5, '0')}.png`);
      if (k % 12 === 0) setStatus(`Rendering ${k + 1}/${count}…`);
      bar.set(null, (k + 1) / count);
      if (stopAsked) { rt.dispose(); checkStop(); }
    }
    rt.dispose();
    await sendVideo(form, 'depth', SC.blur, { quiet: !!part, label: part ? `Shot ${part.i} · ${part.cam.name}` : '' });
    return true;
  } catch (e) {
    if (e instanceof Cancelled) cancelled(); else { setStatus(''); toast(e.message, true); }
    return false;
  } finally {
    clip = null;
    for (const m of R.meshes.values()) if ('hid' in m.userData) { m.visible = m.userData.hid; delete m.userData.hid; }
    bar.done();
    busy = false; stopAsked = false; R.real = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

// Depth from what the picture shows: the colour video (splats at their full set, models, figures: whatever is in the
// view) goes through Video Depth Anything, which estimates the depth of every frame. "combo" then lays the exact
// depth of the 3D objects over that (their pixels win; the splat and the rest keep the estimate).
async function depthFromPicture(part = null) {
  if (part == null && SC.renderShots === 'each') return renderEach(depthFromPicture);
  const combo = SC.depthFrom === 'combo';
  const { template, queueRun, waitGen } = await import('./make.js');
  const t = template('deck-depth-video');
  if (!t) { toast('Depth from the picture needs the deck-depth-video template (Video Depth Anything in ComfyUI)', true); return false; }
  if (!await renderColorVideo(part)) return false;
  const color = R.lastRender;
  const src = t.fields.find((f) => f.kind === 'video'), secs = t.fields.find((f) => /length|seconds/i.test(f.label) && (f.kind === 'float' || f.kind === 'int'));
  try {
    const n = part ? part.f1 - part.f0 + 1 : renderSpan().count;
    const values = { [src.key]: { generation: color.id, index: 0 }, ...(secs && { [secs.key]: Math.max(0.1, n / FPS) }) };
    setStatus('Estimating depth from the picture…'); toast('Estimating the depth from the picture…');
    const [g] = await queueRun({ template: 'deck-depth-video', values });
    let done = await waitGen(g.id);
    if (combo) {
      setStatus('Drawing the 3D objects’ depth…');
      const prev = R.lastRender;
      if (!await renderDepthVideo(part, { objectsOnly: true })) return false;
      const geo = R.lastRender === prev ? null : R.lastRender;
      if (geo) done = await api('/api/scene/depth-combine', { method: 'POST', body: { picture: done.id, geometry: geo.id } });
    }
    R.lastRender = R.renders.depth = done;
    setStatus(`Depth video #${done.id} is in History`);
    toast(combo ? 'Depth from the picture, with the 3D objects laid in, saved' : 'Depth from the picture saved', false,
      { label: 'Use in H3 control', fn: () => C.useControlVideo(done, SC) });
    return true;
  } catch (e) {
    if (!(e instanceof Cancelled)) { setStatus(''); toast(e.message, true); }
    return false;
  } finally { renderPanel(); }
}

// The shot as it looks (the colour look: models, photos, splats), the camera's move over the scene's length, at the
// scene's size and frame rate. Drawn by a stage of its own (scene-offscreen.js) so splats use their full set at
// full resolution whatever this device previews, and each frame waits for Spark's sort before it is kept.
export async function renderColorVideo(part = null) {
  if (part == null && SC.renderShots === 'each') return renderEach(renderColorVideo);
  if (busy || !canRender()) return false;
  clip = part ? { first: part.f0, count: part.f1 - part.f0 + 1 } : null;
  busy = true; stopAsked = false; stopPlay(); TEMP.clear(); renderPanel();
  const W = SC.width, H = SC.height, bar = busyBar('Rendering colour frames…');
  cancelToast('Rendering the colour video…');
  let stage = null, phase = 'starting';
  try {
    phase = 'loading the scene';
    const { Stage } = await import('./scene-offscreen.js');
    stage = new Stage(JSON.parse(JSON.stringify(SC)), { full: true });
    setStatus('Loading the full splats…');
    await stage.whenReady(120000);
    checkStop();
    phase = 'drawing the frames';
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const form = new FormData(), { first, count } = renderSpan();   // (Range only: the work area's frames)
    for (let i = 0; i < count; i++) {
      const f = first + i;
      stage.draw('color', f, cv);
      if (stage.hasSplat) { await stage.settle(); stage.draw('color', f, cv); }
      form.append('frames', await new Promise((res) => cv.toBlob(res, 'image/png')), `f${String(i).padStart(5, '0')}.png`);
      if (i % 12 === 0) setStatus(`Rendering ${i + 1}/${count}…`);
      bar.set(null, (i + 1) / count);
      checkStop();
    }
    phase = 'encoding';
    await sendVideo(form, 'color', 0, { quiet: !!part, label: part ? `Shot ${part.i} · ${part.cam.name}` : '' });
    return true;
  } catch (e) {
    if (e instanceof Cancelled) cancelled(); else { setStatus(''); console.error(e); toast(`Colour render failed while ${phase}: ${e.message}${where(e)}`, true); }
    return false;
  } finally {
    clip = null;
    stage?.dispose();
    bar.done();
    busy = false; stopAsked = false; refresh(); renderPanel();
  }
}

// Each shot: one video per shot. One take: today's single video, with the cuts in it.
function shotParts() {
  if (SC.renderShots !== 'each') return [null];
  return shots().filter((s) => s.f1 - s.f0 >= 1);
}
async function renderEach(fn) {
  if (busy || !canRender()) return false;
  const list = shotParts();
  if (!list.length) { toast('No shot is long enough to render: a shot needs 2 frames', true); return false; }
  const made = [];
  for (const s of list) {
    const ok = await fn(s);
    if (!ok) return false;
    made.push({ s, g: R.lastRender });
  }
  toast(`${made.length} shot${made.length === 1 ? '' : 's'} saved`, false, { label: 'Shots to Video tab', fn: () => layShotVideos(made) });
  return true;
}
async function layShotVideos(made) {
  const { layOnTimeline } = await import('./video.js');
  const { switchTab } = await import('./core.js');
  switchTab('video');
  const list = [];
  for (const { s, g } of made) {
    const o = g?.outputs?.[0];
    if (!o?.url) continue;
    list.push({ kind: 'video', src: { generation: g.id, index: 0 }, url: o.url, label: `Shot ${s.i} · ${s.cam.name}`, dur: o.duration || 0 });
  }
  await layOnTimeline(list);
  toast(`${list.length} shot${list.length === 1 ? '' : 's'} on the Video timeline`);
}

async function sendVideo(form, kind, blur, { quiet = false, label = '' } = {}) {
  form.append('fps', FPS); form.append('blur', blur); form.append('kind', kind); form.append('scene', JSON.stringify(SC));
  if (C.S.project != null) form.append('project_id', C.S.project);
  checkStop();
  setStatus('Encoding…');
  const g = await api('/api/scene/render', { method: 'POST', form });
  if (stopAsked) {   // too late to stop the encode: the clip goes again
    try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); } catch { /* it stays in History */ }
    checkStop();
  }
  const what = label || (kind === 'pose' ? 'Pose video' : kind === 'color' ? 'Colour video' : 'Depth video');
  setStatus(`${what} #${g.id} is in History`);
  R.lastRender = g;
  if (kind !== 'color') R.renders[kind] = R.lastRender;
  if (!quiet) {
    if (kind === 'color') toast(`${what} saved`);
    else toast(`${what} saved`, false, { label: 'Use in H3 control', fn: () => C.useControlVideo(g, SC) });
  }
  return g;
}

// the posable people as OpenPose stick figures (COCO 18, the colours ControlNet pose models expect), with
// their hands' 21 points and the face's 68 unless the scene leaves them out (SC.poseHands, SC.poseFace)
export async function renderPoseVideo(part = null) {
  const figs = SC.objects.filter((o) => (o.type === 'figure' || o.type === 'rigged') && !o.hidden);
  if (part == null && SC.renderShots === 'each') return renderEach(renderPoseVideo);
  if (busy || !figs.length || !canRender()) return false;
  clip = part ? { first: part.f0, count: part.f1 - part.f0 + 1 } : null;
  busy = true; stopAsked = false; R.real = true; stopPlay(); TEMP.clear(); renderPanel();
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering pose frames…');
  cancelToast('Rendering the pose video…');
  try {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData(), { first, count } = renderSpan();
    for (let k = 0; k < count; k++) {
      pose(first + k);
      camera.updateMatrixWorld();
      const opts = { hands: SC.poseHands !== false, face: SC.poseFace !== false };
      const people = figs.map((o) => FIGURE.projectPose(R.meshes.get(o.id).userData.rig, o.hide, camera, W, H, opts));
      FIGURE.drawPose(ctx, people, W, H);
      form.append('frames', await new Promise((res) => cv.toBlob(res, 'image/png')), `f${String(k).padStart(5, '0')}.png`);
      if (k % 12 === 0) setStatus(`Rendering ${k + 1}/${count}…`);
      bar.set(null, (k + 1) / count);
      checkStop();
    }
    await sendVideo(form, 'pose', 0, { quiet: !!part, label: part ? `Shot ${part.i} · ${part.cam.name}` : '' });
    return true;
  } catch (e) {
    if (e instanceof Cancelled) cancelled(); else { setStatus(''); toast(e.message, true); }
    return false;
  } finally {
    clip = null;
    bar.done();
    busy = false; stopAsked = false; R.real = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

// a lit clay frame at the output size, as a PNG blob (the view stays where the caller posed it)
export async function clayBlob() {
  if (!renderer) return null;
  const W = SC.width, H = SC.height;
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace });
  const wasDepth = R.depth; R.depth = false;
  draw('clay');
  for (const m of R.meshes.values()) paint(m, false);
  for (const m of R.room) m.material = m === R.room[0] ? floorMat : wallMat;
  camera.aspect = W / H; camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const blob = await targetToBlob(rt, W, H, false);
  rt.dispose();
  R.depth = wasDepth;
  return blob;
}
export async function saveFrame() {
  if (!canRender()) return;
  const blob = await clayBlob();
  fit(); refresh();
  // a moment to take back a tap by mistake before it is kept (an input image can't be deleted after)
  let stop = false;
  toast('Saving the frame…', false, { label: '✕ Cancel', fn: () => { stop = true; toast('Frame not saved'); }, stay: true });
  await new Promise((r) => setTimeout(r, 1500));
  if (stop) return;
  try {
    const r = await C.uploadImage(blob, { source: 'scene', filename: 'scene.png' });
    toast(`Saved frame as ${r.name.split('/').pop()}`);
  } catch (e) { toast(e.message, true); }
}
