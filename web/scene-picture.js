// A picture as the scene's background: a flat plane with the photo's own shape, far behind the scene and big enough to
// fill the shot camera's frame. It stays where it is in the world when the camera moves (Fit to the camera puts it back).
// Drawn behind everything, in colour only (not in depth renders), and a tap on the view goes through it: pick it in the
// layer list to move it. Unlike the Reference (scene-ref.js, an overlay on screen only), it is in renders.
//   { type: 'picture', image (the input's name), url, aspect (width / height), pw, ph (its pixels) }
// The plane is `aspect` wide and 1 tall, so one even scale keeps its shape; its origin is its centre.
import * as THREE from './vendor/three.module.min.js';
import { CAM, EVEN, R, SC, TYPES, current, liveCam, makers, matchSceneTo, namesFor, newObject, save, write } from './scene-data.js';
import { changed, draw, fit, select } from './scene-view.js';
import { renderPanel, setSceneMode } from './scene-ui.js';
import { modeOf } from './scene-modes.js';
import { pictureAt } from './track-math.js';
import { inputUrl } from './core.js';
import { toast } from './ui.js';

TYPES.picture = { label: 'Background picture', icon: '🖼', size: [1, 1, 1], hide: true };
EVEN.add('picture');

const loader = new THREE.TextureLoader();
makers.picture = (o, x) => {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(o.aspect || 1, 1), mat);
  m.renderOrder = -10; m.frustumCulled = false;   // drawn first, behind everything, wherever the camera looks
  Object.assign(m.userData, { colorOnly: true, photo: true, height: 0, paint: () => {} });   // (height 0: every pivot is its centre, the plane's origin)
  const done = () => (x?.draw || draw)();
  loader.load(o.url, (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; done(); }, undefined, done);
  m.userData.dispose = () => { mat.map?.dispose(); mat.dispose(); m.geometry.dispose(); };
  return m;
};

const fitted = (aspect) => pictureAt(current(liveCam(R.f), CAM), aspect, SC.width / SC.height);

// a picture from the picker into the scene, filling the shot camera's frame
export async function addPicture(name) {
  const url = inputUrl(name), img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return toast('Couldn\'t load that picture', true); }
  const { naturalWidth: pw, naturalHeight: ph } = img;
  if (!pw || !ph) return toast('Couldn\'t load that picture', true);
  if (modeOf().stage === 'empty') setSceneMode('edit');   // (a background belongs to the scene)
  const o = newObject('picture', fitted(pw / ph));
  Object.assign(o, { name: `Background ${name.split('/').pop().replace(/\.\w+$/, '')}`.slice(0, 60), image: name, url, aspect: pw / ph, pw, ph });
  SC.objects.push(o); save(); select(o.id);
}

// back to filling the shot camera's frame, at the playhead
export function fitPicture(o) {
  write(o, namesFor(o), fitted(o.aspect));
  changed();
}

// the scene's picture takes the photo's shape, and the plane fills it exactly
export function sceneToPicture(o) {
  matchSceneTo(o.pw, o.ph);
  write(o, namesFor(o), fitted(o.aspect));
  save(); fit(); changed(); renderPanel();
}
