import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import { C, FPS, R, SC, TEMP, commitHolds, frames, holdEnd, recordFrame, settleTemp } from './scene-data.js';
import {
  RANGE, camera, draw, fit, floorMat, paint, pose, rangeMat, refresh, renderer, scene, setRange, wallMat
} from './scene-view.js';
import { api, busy as busyBar, toast } from './ui.js';
import { modeOf } from './scene-modes.js';
import { renderKeys, renderPanel, renderTime, renderTransport, setStatus } from './scene-ui.js';
import { bound, frameSpan, playFrom, tickT } from './workarea-math.js';
import { AREA } from './scene-keys.js';

// the work area (scene-keys.js AREA, SC.range in frames) while it is on: play loops in it, seeks stay in it
const area = () => bound(SC.range, frames() - 1, 0);
// the frames a render covers: { first, count } (Range only: the work area's, its last frame included)
const renderSpan = () => frameSpan(AREA.exportRange(), frames(), 1, true);

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

function measureRange() {
  const W = 128, H = Math.max(8, Math.round(128 * SC.height / SC.width));
  const rt = new THREE.WebGLRenderTarget(W, H);
  const buf = new Uint8Array(W * H * 4);
  draw('range');
  const bg = scene.background; scene.background = null;
  renderer.setClearColor(0x000000, 0);
  scene.overrideMaterial = rangeMat;
  let near = Infinity, far = 0;
  const { first, count } = renderSpan();
  for (let f = first; f < first + count; f++) {
    pose(f);
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] < 128) continue;  // nothing drawn here
      const z = decodeDepth(buf[i], buf[i + 1], buf[i + 2]) * RANGE;
      if (z < near) near = z;
      if (z > far) far = z;
    }
  }
  renderer.setRenderTarget(null); rt.dispose();
  scene.background = bg;
  if (!isFinite(near)) throw new Error('Nothing in view');
  return [Math.max(0.05, near * 0.97), far * 1.03];
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
export async function renderDepthVideo() {
  if (busy || !canRender()) return false;
  busy = true; stopAsked = false; R.real = true; stopPlay(); TEMP.clear(); renderPanel();  // only what's keyed goes in the render (mute is ignored)
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering depth frames…');
  cancelToast('Rendering the depth video…');
  try {
    setRange(measureRange());
    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.NoColorSpace });
    draw('depth');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData(), { first, count } = renderSpan();
    for (let k = 0; k < count; k++) {
      pose(first + k);
      renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
      form.append('frames', await targetToBlob(rt, W, H, true), `f${String(k).padStart(5, '0')}.png`);
      if (k % 12 === 0) setStatus(`Rendering ${k + 1}/${count}…`);
      bar.set(null, (k + 1) / count);
      if (stopAsked) { rt.dispose(); checkStop(); }
    }
    rt.dispose();
    await sendVideo(form, 'depth', SC.blur);
    return true;
  } catch (e) {
    if (e instanceof Cancelled) cancelled(); else { setStatus(''); toast(e.message, true); }
    return false;
  } finally {
    bar.done();
    busy = false; stopAsked = false; R.real = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

async function sendVideo(form, kind, blur) {
  form.append('fps', FPS); form.append('blur', blur); form.append('kind', kind); form.append('scene', JSON.stringify(SC));
  if (C.S.project != null) form.append('project_id', C.S.project);
  checkStop();
  setStatus('Encoding…');
  const g = await api('/api/scene/render', { method: 'POST', form });
  if (stopAsked) {   // too late to stop the encode: the clip goes again
    try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); } catch { /* it stays in History */ }
    checkStop();
  }
  R.lastRender = g;
  R.renders[kind] = R.lastRender;
  const what = kind === 'pose' ? 'Pose video' : 'Depth video';
  setStatus(`${what} #${R.lastRender.id} is in History`);
  toast(`${what} saved`, false, { label: 'Use in H3 control', fn: () => C.useControlVideo(R.lastRender, SC) });
}

// the posable people as OpenPose stick figures (COCO 18, the colours ControlNet pose models expect), with
// their hands' 21 points and the face's 68 unless the scene leaves them out (SC.poseHands, SC.poseFace)
export async function renderPoseVideo() {
  const figs = SC.objects.filter((o) => o.type === 'figure' && !o.hidden);
  if (busy || !figs.length || !canRender()) return false;
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
    await sendVideo(form, 'pose', 0);
    return true;
  } catch (e) {
    if (e instanceof Cancelled) cancelled(); else { setStatus(''); toast(e.message, true); }
    return false;
  } finally {
    bar.done();
    busy = false; stopAsked = false; R.real = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

// a lit clay frame at the output size, as an input image (a start frame to restyle, for example)
export async function saveFrame() {
  if (!canRender()) return;
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
  R.depth = wasDepth; fit(); refresh();
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
