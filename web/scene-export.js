import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import { C, FPS, R, SC, TEMP, frames } from './scene-data.js';
import {
  RANGE, camera, draw, fit, floorMat, paint, pose, rangeMat, refresh, renderer, scene, setRange, wallMat
} from './scene-view.js';
import { api, busy as busyBar, toast } from './ui.js';
import { modeOf } from './scene-modes.js';
import { renderKeys, renderPanel, renderTime, renderTransport, setStatus } from './scene-ui.js';

// ---- playback ----------------------------------------------------------------------
let raf = 0;
export function play() {
  if (R.playing) return stopPlay();
  R.playing = true; TEMP.clear();
  let t0 = performance.now(), f0 = R.f >= frames() - 1 ? 0 : R.f;
  const step = (now) => {
    if (!R.playing) return;
    R.f = Math.floor(f0 + (now - t0) / 1000 * FPS);
    if (R.f >= frames()) { R.f = 0; f0 = 0; t0 = now; }
    pose(R.f); draw(); renderTime();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  renderTransport();
}
export function stopPlay() { if (!R.playing) return; R.playing = false; cancelAnimationFrame(raf); renderTransport(); renderPanel(); draw(); }
export function seek(f) {
  f = Math.max(0, Math.min(frames() - 1, Math.round(f)));
  if (f !== R.f) TEMP.clear();  // held changes (auto key off) stay on their frame
  R.f = f; pose(R.f); draw(); renderTime(); renderKeys(); renderPanel();
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
  for (let f = 0; f < frames(); f++) {
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
// (Create object's empty stage isn't the shot: only the scene is rendered)
function canRender() {
  if (modeOf().stage !== 'empty') return true;
  toast('This stage is empty: switch to Edit scene or Camera to render the shot', true);
  return false;
}

export async function renderDepthVideo() {
  if (busy || !canRender()) return;
  busy = true; stopPlay(); TEMP.clear(); renderPanel();  // only what's keyed goes in the render
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering depth frames…');
  try {
    setRange(measureRange());
    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.NoColorSpace });
    draw('depth');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData();
    for (let f = 0; f < frames(); f++) {
      pose(f);
      renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
      form.append('frames', await targetToBlob(rt, W, H, true), `f${String(f).padStart(5, '0')}.png`);
      if (f % 12 === 0) setStatus(`Rendering ${f + 1}/${frames()}…`);
      bar.set(null, (f + 1) / frames());
    }
    rt.dispose();
    await sendVideo(form, 'depth', SC.blur);
  } catch (e) {
    setStatus(''); toast(e.message, true);
  } finally {
    bar.done();
    busy = false; R.f = keep; fit(); refresh(); renderPanel();
  }
}

async function sendVideo(form, kind, blur) {
  form.append('fps', FPS); form.append('blur', blur); form.append('kind', kind); form.append('scene', JSON.stringify(SC));
  if (C.S.project != null) form.append('project_id', C.S.project);
  setStatus('Encoding…');
  R.lastRender = await api('/api/scene/render', { method: 'POST', form });
  R.renders[kind] = R.lastRender;
  const what = kind === 'pose' ? 'Pose video' : 'Depth video';
  setStatus(`${what} #${R.lastRender.id} is in History`);
  toast(`${what} saved`, false, { label: 'Use in H3 control', fn: () => C.useControlVideo(R.lastRender, SC) });
}

// the posable people as OpenPose stick figures (COCO 18, the colours ControlNet pose models expect)
export async function renderPoseVideo() {
  const figs = SC.objects.filter((o) => o.type === 'figure' && !o.hidden);
  if (busy || !figs.length || !canRender()) return;
  busy = true; stopPlay(); TEMP.clear(); renderPanel();
  const keep = R.f, W = SC.width, H = SC.height, bar = busyBar('Rendering pose frames…');
  try {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const form = new FormData();
    for (let f = 0; f < frames(); f++) {
      pose(f);
      camera.updateMatrixWorld();
      const people = figs.map((o) => {
        const k = FIGURE.keypoints(R.meshes.get(o.id).userData.rig, o.hide);
        const pts = k.map((p) => {
          if (!p) return null;
          const v = p.project(camera);
          return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
        });
        pts.cut = k.cut;
        return pts;
      });
      FIGURE.drawPose(ctx, people, W, H);
      form.append('frames', await new Promise((res) => cv.toBlob(res, 'image/png')), `f${String(f).padStart(5, '0')}.png`);
      if (f % 12 === 0) setStatus(`Rendering ${f + 1}/${frames()}…`);
      bar.set(null, (f + 1) / frames());
    }
    await sendVideo(form, 'pose', 0);
  } catch (e) {
    setStatus(''); toast(e.message, true);
  } finally {
    bar.done();
    busy = false; R.f = keep; fit(); refresh(); renderPanel();
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
  try {
    const r = await C.uploadImage(blob, { source: 'scene', filename: 'scene.png' });
    toast(`Saved frame as ${r.name.split('/').pop()}`);
  } catch (e) { toast(e.message, true); }
}
