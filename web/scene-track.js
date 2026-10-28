// The two layer types a motion track makes (track-math.js sceneFromTrack):
//   backdrop: the footage, a plane keyed to follow the camera so it always fills the picture. It shows the
//     clip's frame for the moment: the frames sit in one picture (a grid of small frames, from the server).
//     { type: 'backdrop', url, cols, rows, count, step, clipFps, at? (the scene frame the clip starts on) }
//   trackpts: the tracked points as small dots placed in the scene. { type: 'trackpts', pts: [[x, y, z]] }
// Both draw in colour only (not in depth), and are never picked by a tap.
import * as THREE from './vendor/three.module.min.js';
import { R, SC, TYPES, FPS, makers } from './scene-data.js';
import { draw, passHooks } from './scene-view.js';

TYPES.backdrop = { label: 'Footage', icon: '🎞', size: [1, 1, 1], hide: true };
TYPES.trackpts = { label: 'Tracked points', icon: '✚', size: [1, 1, 1], hide: true };

const loader = new THREE.TextureLoader();
makers.backdrop = (o, x) => {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = -10; m.frustumCulled = false;   // drawn first, behind everything, wherever the camera looks
  Object.assign(m.userData, { colorOnly: true, photo: true, paint: () => {} });   // (photo: a tap on it selects nothing; paint: selecting it doesn't recolour it)
  loader.load(o.url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    t.repeat.set(1 / o.cols, 1 / o.rows);
    mat.map = t; mat.needsUpdate = true;
    m.userData.atFrame(m.userData.f ?? 0);
    (x?.draw || draw)();
  }, undefined, () => (x?.draw || draw)());
  // scene frame f: the clip's frame f * clipFps / 24, as the nearest tile
  m.userData.atFrame = (f) => {
    m.userData.f = f;
    const t = mat.map;
    if (!t) return;
    const i = Math.max(0, Math.min(o.count - 1, Math.round((f - (o.at || 0)) * (o.clipFps || FPS) / FPS / (o.step || 1))));   // (at: the scene frame the clip starts on)
    t.offset.set((i % o.cols) / o.cols, 1 - (Math.floor(i / o.cols) + 1) / o.rows);
  };
  m.userData.dispose = () => { mat.map?.dispose(); mat.dispose(); m.geometry.dispose(); };
  return m;
};

makers.trackpts = (o) => {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute((o.pts || []).flat(), 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffb02e, size: 7, sizeAttenuation: false, toneMapped: false }));
  m.frustumCulled = false;
  Object.assign(m.userData, { colorOnly: true, photo: true, paint: () => {} });
  m.userData.dispose = () => { g.dispose(); m.material.dispose(); };
  return m;
};

// not in depth renders or the ◐ Depth view (the override material would turn them into a flat wall)
passHooks.push((pass) => {
  for (const [id, m] of R.meshes) {
    if (!m.userData.colorOnly) continue;
    const o = SC.objects.find((x) => x.id === id);
    m.visible = pass === 'color' && !(o && o.hidden);
  }
});
