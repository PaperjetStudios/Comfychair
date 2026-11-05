// The sampler's picture while a run goes. It sits inside the frame the run belongs to (run-preview-rules.js says which): over the open
// frame's viewer, or over the tile on the table. A run with no frame to show in, or another frame's while one is open, shows it on the
// run strip instead: the small floating box with the step line, drawn once for the whole table, whichever sidebar pane is open. All of it
// copies run.js's own progress line (#progBar, #progText) and live preview canvas (#previewCanvas), so it is fed by the same events as
// the Generate tab and shows nothing of its own when idle.
//   mountRunStrip(host) → the strip's element (called once; a second call returns the first)
//   samplerPreview() → on or off;  setSamplerPreview(on) → saved on the server (app/comfy.py previews_on): off, ComfyUI makes none
//   onSamplerPreview(fn) → fn(on) after each change; returns an unsubscribe
// The preview window: a floating panel (float-panel.js: dragged by its head or its picture, resized, its place kept on this device, always
// whole on the screen) that takes a run's picture and step line instead, so nothing is drawn over a frame, its tile or its layers. It comes
// up with the run's first picture and goes when the run ends (run-preview-rules.js windowUp); a line with no picture (another device's run,
// previews off, a run still queued) stays on the strip. On by choice on this device: the table bar's chip, the window's Close, and a button
// on the strip, which is there while a run goes even when a full-screen frame covers the bar. Off, the above.
//   previewWindow() → on or off;  setPreviewWindow(on);  onPreviewWindow(fn) → fn(on) after each change; returns an unsubscribe
import { h, api, store, toast } from './ui.js';
import { icon } from './icons.js';
import { floatPanel } from './float-panel.js';
import { CURRENT_EDIT, S } from './core.js';
import { outputOf } from './table-model.js';
import { RUN } from './run-state.js';
import { liveFrame, liveRoot } from './live.js';
import { lineOver, previewHome, rememberRun, windowUp } from './run-preview-rules.js';

const RUNS = 'deck.run.frames';   // prompt id → frame id, so a reload mid-run still knows the frame
const PV = { on: true, listeners: new Set(), kick: null };
const WINDOW = 'deck.run.window';
const WIN = { on: store.get(WINDOW, true) !== false, listeners: new Set() };

export const previewWindow = () => WIN.on;
export function onPreviewWindow(fn) { WIN.listeners.add(fn); return () => WIN.listeners.delete(fn); }
export function setPreviewWindow(on) {
  if (WIN.on === !!on) return;
  WIN.on = !!on;
  store.set(WINDOW, WIN.on);
  for (const fn of [...WIN.listeners]) fn(WIN.on);
  PV.kick?.();
}

export const samplerPreview = () => PV.on;
export function onSamplerPreview(fn) { PV.listeners.add(fn); return () => PV.listeners.delete(fn); }
function tell(on) {
  PV.on = on;
  for (const fn of [...PV.listeners]) fn(on);
  PV.kick?.();
}
export async function setSamplerPreview(on) {
  const was = PV.on;
  tell(on);
  try { tell((await api('/api/sampler-preview', { method: 'PUT', body: { on }, busy: false })).on); }
  catch (e) { tell(was); toast(`Couldn't change the sampling preview: ${e.message}`, true); }
}

// the runs a frame queued (edit-run.js says where they land: into)
addEventListener('make:queued', (e) => {
  const { frame, into, gens } = e.detail || {}, id = into?.id ?? frame?.id;
  if (id == null) return;
  store.set(RUNS, rememberRun(store.get(RUNS, {}), gens, String(id)));
});

// the element to draw in, or null for the strip. A tile off the screen or hidden is no use: that goes to the strip too.
function homeEl() {
  const live = liveFrame()?.id ?? null;
  const selected = [...document.querySelectorAll('#tab-table .frame.selected:not(.frame-note)')].map((el) => el.dataset.id);
  const id = previewHome({ pid: RUN.pid || S.activePid, runs: store.get(RUNS, {}), live: live == null ? null : String(live), selected });
  if (id == null) return null;
  if (live != null && id === String(live)) { const root = liveRoot(); return root?.querySelector('.viewer') || root; }
  const body = document.querySelector(`#tab-table .frame[data-id="${CSS.escape(id)}"] .frame-body`);
  if (!body) return null;
  const r = body.getBoundingClientRect(), s = document.querySelector('#tab-table .table-stage')?.getBoundingClientRect();
  if (!r.width || !r.height || !s) return null;
  return r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom ? body : null;
}

let strip = null;
export function mountRunStrip(host = document.body) {
  if (strip) return strip;
  const bar = h('div', { class: 'run-strip-bar' }), text = h('span', { class: 'run-strip-text' });
  const view = h('canvas', { class: 'run-strip-view hidden', 'aria-label': 'Sampling preview' });
  const inFrame = h('canvas', { class: 'run-preview', 'aria-label': 'Sampling preview' });
  const toWindow = h('button', { type: 'button', class: 'icon-btn run-strip-win hidden', 'aria-label': 'Show the preview in a window', title: 'Preview window',
    onclick: () => setPreviewWindow(true) }, icon('enlarge'));
  strip = h('div', { class: 'run-strip hidden', role: 'status' }, view, h('div', { class: 'run-strip-line' }, bar, h('div', { class: 'run-strip-row' }, text, toWindow)));
  host.append(strip);
  // the window, made when first wanted
  const win = { panel: null, view: null, up: false, bar: h('div', { class: 'run-strip-bar' }), text: h('span', { class: 'run-strip-text' }) };
  const winPanel = () => {
    if (win.panel) return win.panel;
    const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the preview window', title: 'Close: the preview shows in its frame again',
      onclick: () => setPreviewWindow(false) }, icon('close'));
    win.panel = floatPanel({ key: WINDOW, title: 'Preview', cls: 'float-preview', buttons: [close], inside: true });
    win.view = h('canvas', { class: 'float-preview-view', 'aria-label': 'Sampling preview' });
    win.panel.body.append(win.view, h('div', { class: 'run-strip-line' }, win.bar, win.text));
    win.panel.dragBy(win.view);   // (the picture is most of the window: it moves by that too)
    return win.panel;
  };
  api('/api/sampler-preview', { busy: false }).then((r) => tell(r.on !== false), () => {});   // (a server from before the switch: on)
  const srcBar = document.getElementById('progBar'), srcText = document.getElementById('progText'), srcView = document.getElementById('previewCanvas');
  if (!srcBar || !srcText) return strip;
  let raf = 0;
  const ENDED = /^(Finished|Stopped|Failed) /;
  const live = () => PV.on && !!srcView && !srcView.classList.contains('hidden') && srcView.width > 0 && /step|\d+\/\d+|Starting/.test(srcText.textContent || '');
  const draw = (to) => {
    if (to.width !== srcView.width || to.height !== srcView.height) { to.width = srcView.width; to.height = srcView.height; }
    to.getContext('2d').drawImage(srcView, 0, 0);
  };
  // Over an open frame it lies on the canvas and rides its pan and zoom; pointers go through, so editing carries on, and it fades while you
  // work so you can see what you're doing. On a tile it fills the tile.
  const place = (home) => {
    const cv = home.classList.contains('viewer') ? [...home.querySelectorAll('canvas')].find((c) => c !== inFrame && c.offsetWidth > 0) : null;
    inFrame.classList.toggle('on-canvas', !!cv);
    if (!cv) { Object.assign(inFrame.style, { left: '', top: '', width: '', height: '' }); return; }
    const r = cv.getBoundingClientRect(), o = home.getBoundingClientRect(), k = home.clientWidth ? o.width / home.clientWidth : 1;
    Object.assign(inFrame.style, { left: `${(r.left - o.left) / k}px`, top: `${(r.top - o.top) / k}px`, width: `${r.width / k}px`, height: `${r.height / k}px` });
  };
  // An open image frame shows it as a layer on top of its stack (editor-engine.js runPreview), not over the view. When the run ends the layer stays
  // until the result has landed as its own new layer, so there's no gap; a run that stopped or failed takes it away at once.
  let layerEng = null, fading = false;
  const openEditor = () => {
    const f = liveFrame(), eng = CURRENT_EDIT.eng;
    return f?.kind === 'image' && eng?.E?.tab?.id === f.doc && !eng.docOnly ? eng : null;
  };
  const showLayer = (eng) => { eng.runPreview(srcView, { opacity: fading ? 0.2 : 1, size: outputOf(liveFrame()) }); layerEng = eng; };
  const files = (eng) => eng.E.layers.filter((l) => l.name && !l.runPreview).length;
  let holdUntil = 0, holdFiles = 0;
  const dropLayer = (wait = false) => {
    const eng = layerEng;
    if (!eng) return;
    layerEng = null;
    if (wait) { holdUntil = Date.now() + 6000; holdFiles = files(eng); } else { holdUntil = 0; eng.runPreview(null); }
  };
  // The one thing that clears it up: whatever way a run ended, a preview layer no run is drawing goes (at once, or when the result has landed, or
  // after 6 s). A batch's runs can start and stop between two paints, so this doesn't rely on seeing each one end.
  setInterval(() => {
    const eng = CURRENT_EDIT.eng;
    if (!eng?.E?.layers?.some((l) => l.runPreview)) return;
    if (live() && layerEng === eng) return;
    if (Date.now() < holdUntil && files(eng) <= holdFiles) return;
    if (live() && openEditor() === eng && homeEl()?.classList.contains('viewer')) return;   // (about to be drawn again: the next run of a batch)
    if (layerEng === eng) layerEng = null;
    holdUntil = 0;
    eng.runPreview(null);
  }, 300);
  let lastPaint = 0;
  const paintView = (t = performance.now()) => {
    raf = 0;
    if (!live()) {
      view.classList.add('hidden'); inFrame.remove();   // (the window keeps its last picture until it goes)
      dropLayer(PV.on && !ENDED.test(srcText.textContent || '') ? true : false);
      return;
    }
    raf = requestAnimationFrame(paintView);
    const home = WIN.on ? null : homeEl(), eng = home?.classList.contains('viewer') ? openEditor() : null;
    if (t - lastPaint < (eng ? 200 : 66)) return;   // (it must not slow down editing beside it: a layer redraws the whole stack)
    lastPaint = t;
    if (layerEng && layerEng !== eng) dropLayer();
    if (eng) {
      inFrame.remove();
      showLayer(eng);
      view.classList.add('hidden');
    } else if (home) {
      if (inFrame.parentNode !== home) home.append(inFrame);   // (also after an engine emptied its viewer)
      place(home);
      draw(inFrame);
      view.classList.add('hidden');
    } else if (WIN.on) {   // (the window: nothing over a frame or among its layers)
      inFrame.remove();
      view.classList.add('hidden');
      winPanel(); draw(win.view);
      if (!win.up && windowUp(false, { window: true, previews: PV.on, words: srcText.textContent || '', live: true })) copy();   // (the first picture: the window comes up)
    } else {
      inFrame.remove();
      draw(view);
      view.classList.remove('hidden');
    }
  };
  // (while the pointer is down on the open frame's canvas, and a moment after)
  let fadeT = 0;
  const fade = (on) => {
    fading = on;
    inFrame.classList.toggle('editing', on);
    if (layerEng && openEditor() === layerEng && live()) showLayer(layerEng);
  };
  addEventListener('pointerdown', (e) => { if ((inFrame.isConnected || layerEng) && e.target.closest?.('.frame-mount .viewer')) { clearTimeout(fadeT); fade(true); } }, true);
  addEventListener('pointerup', () => { if (!fading) return; clearTimeout(fadeT); fadeT = setTimeout(() => fade(false), 500); }, true);
  // a run's end line ("Finished in 4s", "Stopped after…", "Failed after…") stays a few seconds, as run.js keeps it, then the
  // strip goes by itself (run.js clears its own line only on the next queue status, which may not come); no text: gone at once
  let endT = 0;
  const END_MS = 6000;
  const copy = () => {
    clearTimeout(endT); endT = 0;
    bar.style.width = srcBar.style.width || '0';
    text.textContent = srcText.textContent || '';
    const words = text.textContent, going = !!words;
    win.up = windowUp(win.up, { window: WIN.on, previews: PV.on, words, live: live() });
    strip.classList.toggle('hidden', !going || win.up);
    toWindow.classList.toggle('hidden', WIN.on || !PV.on);
    if (win.up) {   // (where it was left)
      const p = winPanel();
      win.bar.style.width = bar.style.width; win.text.textContent = words;
      if (!p.shown()) p.show();
    } else win.panel?.hide();
    if (lineOver(words)) endT = setTimeout(() => { if (text.textContent === words) { strip.classList.add('hidden'); win.panel?.hide(); win.up = false; } }, END_MS);
    if (!raf && text.textContent) raf = requestAnimationFrame(paintView);
  };
  PV.kick = copy;
  copy();
  const mo = new MutationObserver(copy);
  mo.observe(srcBar, { attributes: true, attributeFilter: ['style'] });
  mo.observe(srcText, { childList: true, characterData: true, subtree: true });
  if (srcView) mo.observe(srcView, { attributes: true, attributeFilter: ['class'] });
  return strip;
}
