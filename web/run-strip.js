// The run strip: the sampler's preview picture and the step line of the run that is going, drawn once for the whole table, whichever
// sidebar pane is open and whatever kind the running frame is. It copies run.js's own progress line (#progBar, #progText) and live
// preview canvas (#previewCanvas), so it is fed by the same events as the Generate tab and shows nothing of its own when idle.
//   mountRunStrip(host) → the strip's element (called once; a second call returns the first)
import { h } from './ui.js';

let strip = null;
export function mountRunStrip(host = document.body) {
  if (strip) return strip;
  const bar = h('div', { class: 'run-strip-bar' }), text = h('span', { class: 'run-strip-text' });
  const view = h('canvas', { class: 'run-strip-view hidden', 'aria-label': 'Sampling preview' });
  strip = h('div', { class: 'run-strip hidden', role: 'status' }, view, h('div', { class: 'run-strip-line' }, bar, text));
  host.append(strip);
  const srcBar = document.getElementById('progBar'), srcText = document.getElementById('progText'), srcView = document.getElementById('previewCanvas');
  if (!srcBar || !srcText) return strip;
  let raf = 0;
  const live = () => !!srcView && !srcView.classList.contains('hidden') && srcView.width > 0 && /step|\d+\/\d+|Starting/.test(srcText.textContent || '');
  const paintView = () => {
    raf = 0;
    if (!live()) { view.classList.add('hidden'); return; }
    if (view.width !== srcView.width || view.height !== srcView.height) { view.width = srcView.width; view.height = srcView.height; }
    view.getContext('2d').drawImage(srcView, 0, 0);
    view.classList.remove('hidden');
    raf = requestAnimationFrame(paintView);
  };
  const copy = () => {
    bar.style.width = srcBar.style.width || '0';
    text.textContent = srcText.textContent || '';
    strip.classList.toggle('hidden', !text.textContent);
    if (!raf && text.textContent) raf = requestAnimationFrame(paintView);
  };
  copy();
  const mo = new MutationObserver(copy);
  mo.observe(srcBar, { attributes: true, attributeFilter: ['style'] });
  mo.observe(srcText, { childList: true, characterData: true, subtree: true });
  if (srcView) mo.observe(srcView, { attributes: true, attributeFilter: ['class'] });
  return strip;
}
