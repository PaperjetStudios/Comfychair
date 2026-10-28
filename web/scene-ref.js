// A reference picture or clip shown over the 3D view, fitted to the shot frame (the canvas is the
// frame, letterboxed in the viewer), to line the shot up with. It is an HTML layer, so it is never in a
// render, a saved frame or an export. A clip follows the playhead (frame ÷ fps) and plays with the
// transport, muted. Saved with the scene: SC.ref = { kind: 'image' | 'video', name | src, url, label, opacity, on }.
import { C, FPS, R, SC, hooks, save } from './scene-data.js';
import { canvas, viewer } from './scene-view.js';
import { renderPanel, renderToolbar, setSceneMode } from './scene-ui.js';
import { addModeSection, modeOf } from './scene-modes.js';
import { button, clamp, h, help, rangeField, section, toast, toggle, pctFmt } from './ui.js';
import { inputUrl } from './core.js';
import { openVideoPicker, soundSource } from './media.js';

let layer = null, media = null, shown = null, raf = 0;

// the layer follows the frame, the playhead and the mode on every frame while there is a reference
function tick() {
  raf = 0;
  const ref = SC?.ref;
  if (!ref || !layer) return;
  raf = requestAnimationFrame(tick);
  const on = ref.on !== false && !R.free && modeOf().stage !== 'empty' && $tabOn();
  layer.hidden = !on;
  if (!on) { if (media?.tagName === 'VIDEO' && !media.paused) media.pause(); return; }
  for (const k of ['left', 'top', 'width', 'height']) if (layer.style[k] !== canvas.style[k]) layer.style[k] = canvas.style[k];
  layer.style.opacity = clamp(ref.opacity ?? 0.5, 0.05, 1);
  if (media?.tagName !== 'VIDEO' || !(media.readyState >= 1)) return;
  const t = Math.min(R.f / FPS, Math.max(0, (media.duration || 0) - 0.001));
  if (R.playing) {
    if (media.paused && R.f / FPS < (media.duration || 0)) media.play().catch(() => {});
    if (Math.abs(media.currentTime - t) > 0.15) media.currentTime = t;   // (drifted, or the transport looped)
  } else {
    if (!media.paused) media.pause();
    if (Math.abs(media.currentTime - t) > 0.5 / FPS) media.currentTime = t;
  }
}
const $tabOn = () => !!viewer?.closest('.tab')?.classList.contains('active');

// (re)build the layer for the scene's reference; called whenever the toolbar redraws
export function syncRef() {
  if (!viewer) return;
  const ref = SC?.ref, key = ref ? `${ref.kind}:${ref.url}` : null;
  if (key !== shown) {
    shown = key;
    layer?.remove(); layer = media = null;
    if (ref) {
      media = ref.kind === 'video'
        ? h('video', { src: ref.url, muted: true, playsInline: true, preload: 'auto', loop: false })
        : h('img', { src: ref.url, alt: '' });
      media.muted = true;
      if (ref.kind === 'video') media.addEventListener('error', relink, { once: true });
      layer = h('div', { class: 'scene-ref', 'aria-hidden': 'true' }, media);
      canvas.after(layer);
    }
  }
  if (ref && layer && !raf) raf = requestAnimationFrame(tick);
}
// a clip whose address went stale: look its source up again
async function relink() {
  const ref = SC?.ref;
  if (ref?.kind !== 'video' || !ref.src) return;
  const s = await soundSource(ref.src).catch(() => null);
  if (s?.url && s.url !== ref.url) { ref.url = s.url; syncRef(); }
}

function setRef(ref) {
  SC.ref = { opacity: SC.ref?.opacity ?? 0.5, on: true, ...ref };
  save(); syncRef(); renderToolbar(); renderPanel();
}
// From the Board or History ("Use as…"): a picture ({kind: 'image', name, url, label}) or a clip ({kind: 'video', src,
// url, label}) as the open scene's reference (it shows in the edit and camera modes)
export async function useAsRef(ref) {
  await hooks.ready();
  if (modeOf().stage === 'empty') setSceneMode('edit');
  setRef(ref);
  toast(`${ref.kind === 'video' ? 'Clip' : 'Picture'} set as the reference over the view`);
}
const pickImage = () => C.openImagePicker({ title: 'Reference picture', onPick: (name) => setRef({ kind: 'image', name, url: inputUrl(name), label: name.split('/').pop() }) });
const pickVideo = () => openVideoPicker({ title: 'Reference clip', onPick: async (src) => {
  const s = await soundSource(src).catch(() => null);
  if (!s?.url) return toast('Couldn\'t find that clip', true);
  setRef({ kind: 'video', src, url: s.url, label: s.label });
} });
export function toggleRef() {
  if (!SC.ref) return pickImage();
  SC.ref.on = SC.ref.on === false; save(); syncRef(); renderToolbar(); renderPanel();
}

// Edit scene and Camera: a small Reference section
function build() {
  const ref = SC.ref;
  const pick = h('div', { class: 'row wrap' }, button(ref ? '🖼 Other picture…' : '🖼 Picture…', pickImage), button(ref ? '🎞 Other clip…' : '🎞 Clip…', pickVideo),
    ref ? button('Remove', () => { delete SC.ref; save(); syncRef(); renderToolbar(); renderPanel(); }, { cls: 'small danger' }) : null);
  return section('Reference', null,
    ref ? h('p', { class: 'hint' }, `${ref.kind === 'video' ? '🎞' : '🖼'} ${ref.label || ''}`) : null,
    ref ? toggle('Show over the view', ref.on !== false, (on) => { ref.on = on; save(); syncRef(); renderToolbar(); }) : null,
    ref ? rangeField('Opacity', () => ref.opacity ?? 0.5, (v) => { ref.opacity = v; }, { min: 0.05, max: 1, step: 0.05, fmt: pctFmt,
      onChange: () => save() }) : null,
    pick,
    help('A picture or clip over the shot frame, to line the camera and the people up with. A clip follows the playhead. It is only on screen: renders, saved frames and exports leave it out. ◫ on the view shows or hides it.'));
}
export function registerRef() { addModeSection('edit', build); addModeSection('camera', build); }
