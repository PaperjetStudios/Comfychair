import { h, button, iconBtn, seg, store, clamp01, openOverlay } from './ui.js';

// ---------------------------------------------------------------------------
// compare two board items full screen: a wipe (drag the line across to show more of one or the
// other) or side by side. Two clips play together, the right one kept on the left one's clock.
// items: [{ o: {url, kind}, label }, …] (the first two are used)
// ---------------------------------------------------------------------------
// the wipe's line with its grip, and a side's name over the picture: Compare and the VFX tab's wipe draw these the
// same (the line sits at the --w of the box it's in)
export const wipeLine = () => h('div', { class: 'cmp-line' }, h('span', { class: 'cmp-grip' }, '⇆'));
export const sideTag = (label, side) => h('span', { class: `cmp-tag ${side}` }, label);

const C = { layout: store.get('deck.compare.layout', 'wipe'), wipe: 0.5, sound: 'off' };   // sound: off | l | r

export function openCompare(items) {
  let [a, b] = items;
  const stage = h('div', { class: 'cmp-stage' });
  const pct = h('span', { class: 'cmp-pct hint' });
  const time = h('input', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time', class: 'cmp-time hidden' });
  const playBtn = button('❚❚ Pause', () => togglePlay(), { cls: 'small primary hidden', title: 'Play / pause (Space)' });
  const soundSeg = seg([['off', '🔇'], ['l', '🔊 Left'], ['r', '🔊 Right']], C.sound, (v) => { C.sound = v; hear(); });
  const layoutSeg = seg([['wipe', 'Wipe'], ['side', 'Side by side']], C.layout, (v) => { C.layout = v; store.set('deck.compare.layout', v); build(); });
  const el = h('div', { class: 'cmp-view', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'cmp-top' }, h('b', { class: 'cmp-title' }, 'Compare'), layoutSeg,
      button('⇄ Swap', () => { [a, b] = [b, a]; build(); }, { cls: 'small', title: 'Swap the two sides (S)' }), pct,
      iconBtn('Close', '✕', () => close())),
    stage,
    h('div', { class: 'cmp-bottom' }, playBtn, time, soundSeg));
  let A = null, B = null, raf = 0;   // the two media elements

  const media = (x) => x.o.kind === 'video'
    ? h('video', { src: x.o.url, muted: true, loop: true, playsInline: true, autoplay: true, preload: 'auto' })
    : h('img', { src: x.o.url, alt: '', draggable: false });
  const natural = (m) => (m?.tagName === 'VIDEO' ? [m.videoWidth, m.videoHeight] : [m?.naturalWidth, m?.naturalHeight]);
  // one side's sound at a time (both at once is a muddle)
  const hear = () => {
    for (const [m, side] of [[A, 'l'], [B, 'r']]) if (m?.tagName === 'VIDEO') m.muted = C.sound !== side;
    clock().play?.().catch(() => {});
  };
  const tag = (x, side) => sideTag(x.label, side);

  function build() {
    A?.pause?.(); B?.pause?.();
    A = media(a); B = media(b);
    const wipe = C.layout === 'wipe';
    stage.classList.toggle('side', !wipe);
    if (wipe) {
      const box = h('div', { class: 'cmp-box' }, h('div', { class: 'cmp-a' }, A), h('div', { class: 'cmp-b' }, B), wipeLine(), tag(a, 'l'), tag(b, 'r'));
      stage.replaceChildren(box);
    } else {
      stage.replaceChildren(h('div', { class: 'cmp-cell' }, A, tag(a, 'l')), h('div', { class: 'cmp-cell' }, B, tag(b, 'r')));
    }
    for (const m of [A, B]) m.addEventListener(m.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', fit);
    const vids = [A, B].some((m) => m.tagName === 'VIDEO');
    time.classList.toggle('hidden', !vids); playBtn.classList.toggle('hidden', !vids);
    playBtn.textContent = '❚❚ Pause';
    cancelAnimationFrame(raf); if (vids) raf = requestAnimationFrame(tick);
    soundSeg.classList.toggle('hidden', !vids);
    fit(); setWipe(C.wipe); hear();
  }

  // the wipe box takes the left picture's shape, as big as fits; side by side picks rows or columns,
  // whichever shows the pictures bigger
  function fit() {
    const [w, ht] = natural(A), W = stage.clientWidth, H = stage.clientHeight;
    if (!w || !ht || !W || !H) return;
    if (C.layout === 'wipe') {
      const s = Math.min(W / w, H / ht), box = stage.querySelector('.cmp-box');
      Object.assign(box.style, { width: `${Math.floor(w * s)}px`, height: `${Math.floor(ht * s)}px` });
    } else {
      stage.classList.toggle('cols', Math.min(W / w, H / 2 / ht) > Math.min(W / 2 / w, H / ht));
    }
  }

  function setWipe(x) {
    C.wipe = clamp01(x);
    const box = stage.querySelector('.cmp-box');
    pct.textContent = C.layout === 'wipe' ? `${Math.round(C.wipe * 100)}% left · ${100 - Math.round(C.wipe * 100)}% right` : '';
    if (!box) return;
    box.style.setProperty('--w', `${C.wipe * 100}%`);
  }

  // drag anywhere on the picture to move the line; a tap jumps it there
  stage.addEventListener('pointerdown', (e) => {
    const box = stage.querySelector('.cmp-box');
    if (!box || e.button > 0) return;
    const at = (ev) => { const r = box.getBoundingClientRect(); setWipe((ev.clientX - r.left) / r.width); };
    at(e);
    try { stage.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
    const up = () => { stage.removeEventListener('pointermove', at); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up); };
    stage.addEventListener('pointermove', at); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  });

  // two clips: the left one is the clock; the right one is pulled back onto it when it drifts
  const clock = () => (A.tagName === 'VIDEO' ? A : B);
  function tick() {
    const c = clock(), o = c === A ? B : null;
    if (o?.tagName === 'VIDEO' && o.readyState >= 2 && o.duration) {
      const want = c.currentTime % o.duration;
      if (Math.abs(o.currentTime - want) > 0.08) o.currentTime = want;
      if (c.paused !== o.paused) c.paused ? o.pause() : o.play().catch(() => {});
    }
    if (c.duration) { time.max = c.duration; if (document.activeElement !== time) time.value = c.currentTime; }
    raf = requestAnimationFrame(tick);
  }
  function togglePlay() {
    const c = clock();
    if (c.paused) c.play().catch(() => {}); else c.pause();
    playBtn.textContent = c.paused ? '▶ Play' : '❚❚ Pause';
  }
  time.addEventListener('input', () => {
    const t = parseFloat(time.value);
    for (const m of [A, B]) if (m.tagName === 'VIDEO' && m.duration) m.currentTime = t % m.duration;
  });

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const keys = {
      Escape: () => close(), s: () => { [a, b] = [b, a]; build(); }, ' ': () => togglePlay(),
      ArrowLeft: () => setWipe(C.wipe - 0.05), ArrowRight: () => setWipe(C.wipe + 0.05),
    };
    if (keys[e.key]) { e.preventDefault(); e.stopPropagation(); keys[e.key](); }
  };
  const ro = new ResizeObserver(fit);
  const close = openOverlay(el, { onClose: () => {
    cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('keydown', onKey, true);
    A?.pause?.(); B?.pause?.();
  } });
  addEventListener('keydown', onKey, true);
  ro.observe(stage);
  build();
}
