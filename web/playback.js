import { button, h, iconBtn, numSlider, seg, setIcon } from './ui.js';

// ---------------------------------------------------------------------------
// playback: the transport bar and keys every player shares (Video, Sound, VFX, the Editor), laid out like Blender's
// timeline header: ⇤ to the start, ⧏ the previous key, back a step, Play / Pause, forward a step, ⧐ the next key, ⇥ to
// the end, Loop, a speed, the time and, for a player without a timeline, a scrub bar. Tap the time to type one (a frame
// number with an fps, else seconds; 1.5s and m:ss work in both); with length, the length is typed beside it.
// Keys while its tab is open: Space plays, ← / → step (Shift: a second), ↑ / ↓ the next / previous key, Home / End;
// with a work area I / O, Alt+X.
//
//   const tp = transport(player, { step, loop, rates, scrub, fps, frames, extra, timeId });
//   player: { playing(), play(), pause(), seek(t), t(), len() }
//   step: { by: seconds | () => seconds (the buttons), key (← / →, default by), back, fwd (icons), label ('one frame'),
//     pause (false: keep playing through a step) }
//   loop: { get, set } | null; rates: [[rate, label]] with rate: { get, set } | null
//   area: the timeline's work area (workarea.js) or null: while it is on, stepping stays inside it and ⇤ / End go to
//     its ends; its Range button sits after Loop, and playKeys adds its keys (I / O, Alt+X)
//   keys: { prev(t), next(t) } the time of the key before / after t (null: none) for ⧏ ⧐ and ↑ / ↓, or null
//   length: { get(), set(seconds), min, max } a typed length beside the time, or null
//   bar.append(tp.el); tp.update() after a play, pause or seek from elsewhere; playKeys(() => tabOpen, tp, more)
// ---------------------------------------------------------------------------

// A typed time in seconds, or null: "1:02.5" (m:ss), "2.5s", or a bare number, a frame (from 1) with an fps, else seconds
export function parseTime(text, fps = 0) {
  const s = String(text).trim().toLowerCase().replace(',', '.');
  let m;
  if ((m = s.match(/^(\d+):(\d+(?:\.\d*)?)$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d*\.?\d+)\s*s$/))) return +m[1];
  if ((m = s.match(/^(\d*\.?\d+)\s*f?$/))) return fps ? Math.max(0, Math.round(+m[1]) - 1) / fps : +m[1];
  return null;
}

// m:ss.ss, or m:ss:ff (frames) with an fps
export function fmtTime(t, fps = 0) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t % 60;
  if (!fps) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  const fr = Math.min(fps - 1, Math.floor((t % 1) * fps + 1e-6));
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

export function transport(p, { step, loop = null, rates = null, rate = null, scrub = false, fps = 0, frames = false, extra = [], timeId = null,
  disabled = false, area = null, keys = null, length = null } = {}) {
  const fpsNow = () => (typeof fps === 'function' ? fps() : fps);
  const val = (x) => (typeof x === 'function' ? x() : x);
  const small = () => val(step.by);
  const inside = (t) => (area ? area.clamp(t) : t);
  const tp = {
    small, keyStep: () => val(step.key ?? step.by), area, hasKeys: !!keys,
    toggle: () => { if (p.playing()) p.pause(); else p.play(); tp.update(); },
    nudge: (d) => { if (step.pause !== false) p.pause(); p.seek(inside(Math.min(Math.max(0, p.t() + d), p.len() || Infinity))); tp.update(); },
    toStart: () => { p.pause(); p.seek(area?.bound()?.a ?? 0); tp.update(); },
    toEnd: () => { p.pause(); p.seek(area?.bound()?.b ?? p.len()); tp.update(); },
    // the next (dir 1) or previous (-1) key, from the playhead (nothing past the end of the clip)
    toKey: (dir) => {
      const t = keys && (dir > 0 ? keys.next(p.t()) : keys.prev(p.t()));
      if (t == null || t > (p.len() || Infinity) + 1e-6) return;
      p.pause(); p.seek(Math.max(0, t)); tp.update();
    },
    goTo: (t) => { p.pause(); p.seek(inside(Math.min(Math.max(0, t), p.len() || Infinity))); tp.update(); },
  };
  const playBtn = button('▶ Play', tp.toggle, { cls: 'small primary play-btn', title: 'Play / pause (Space)', disabled });
  // the time: tap it to type one (Enter or leaving the box goes there, Escape doesn't)
  const time = h('button', { type: 'button', class: 'timecode', id: timeId, title: `Tap to type a time${fpsNow() ? ' or a frame' : ''}`,
    onclick: () => typeTime() });
  function typeTime() {
    if (disabled) return;
    const f = fpsNow();
    const box = h('input', { type: 'text', class: 'time-in', inputMode: 'decimal', 'aria-label': f ? 'Go to frame' : 'Go to time (s)',
      value: f ? String(Math.round(p.t() * f) + 1) : String(+p.t().toFixed(2)), placeholder: f ? 'frame' : 's' });
    let gone = false;
    const end = (go) => {
      if (gone) return;
      gone = true;
      const t = go ? parseTime(box.value, f) : null;
      box.replaceWith(time);
      if (t != null) tp.goTo(t); else tp.update();
    };
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); });
    box.addEventListener('blur', () => end(true));
    time.replaceWith(box);
    box.focus(); box.select();
  }
  // the length, typed (seconds)
  const lenIn = length ? numSlider({ min: length.min ?? 0.5, max: length.max ?? 60, step: 0.5, value: length.get(), label: 'Length (s)' }) : null;
  lenIn?.addEventListener('change', () => { const v = parseFloat(lenIn.value); if (Number.isFinite(v) && Math.abs(v - length.get()) > 1e-6) length.set(v); tp.update(); });
  const bar = scrub ? h('input', { type: 'range', class: 'scrub', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time', disabled,
    oninput: (e) => { p.seek(parseFloat(e.target.value)); tp.update(); } }) : null;
  const loopBtn = loop ? button('⟲ Loop', () => { loop.set(!loop.get()); showLoop(); }, { title: 'Play it again from the start at the end' }) : null;
  const showLoop = () => { if (!loopBtn) return; loopBtn.classList.toggle('on', !!loop.get()); loopBtn.setAttribute('aria-pressed', String(!!loop.get())); };
  tp.update = () => {
    setIcon(playBtn, p.playing() ? '❚❚ Pause' : '▶ Play');
    const t = p.t(), len = p.len(), f = fpsNow();
    time.textContent = `${fmtTime(t, f)}${length ? '' : ` / ${fmtTime(len, f)}`}${frames && f ? ` · frame ${Math.round(t * f) + 1}` : ''}`;
    if (lenIn && document.activeElement !== lenIn) lenIn.set(length.get());
    if (bar) {
      bar.max = len || 0;
      if (document.activeElement !== bar) bar.value = t;
      bar.style.setProperty('--p', len ? `${(t / len) * 100}%` : '0%');
    }
  };
  tp.el = h('div', { class: 'transport' },
    bar ? h('div', { class: 'scrub-row' }, bar, time) : null,
    h('span', { class: 'tp-btns' },
      iconBtn('Go to the start', '⇤', tp.toStart, { title: `Go to the start${area ? ' (of the range, while it is on)' : ''} (Home)` }),
      keys ? iconBtn('Previous key', '⧏', () => tp.toKey(-1), { title: 'Jump to the previous key (↓)' }) : null,
      iconBtn(`Back ${step.label}`, step.back || '⏴', () => tp.nudge(-small()), { title: `Back ${step.label} (←)` }),
      playBtn,
      iconBtn(`Forward ${step.label}`, step.fwd || '⏵', () => tp.nudge(small()), { title: `Forward ${step.label} (→)` }),
      keys ? iconBtn('Next key', '⧐', () => tp.toKey(1), { title: 'Jump to the next key (↑)' }) : null,
      iconBtn('Go to the end', '⇥', tp.toEnd, { title: `Go to the end${area ? ' (of the range, while it is on)' : ''} (End)` })),
    loopBtn,
    area ? area.toggleBtn() : null,
    rates && rate ? seg(rates, rate.get(), (v) => rate.set(Number(v))) : null,
    ...extra,
    bar ? null : time,
    lenIn ? h('label', { class: 'keynum tp-len', title: 'The length, in seconds' }, 'Length', lenIn) : null);
  showLoop(); tp.update();
  return tp;
}

// The player's keys while active() (its tab is open and nothing is being typed in). more(e): the tab's own keys.
export function playKeys(active, tpOf, more = () => ({})) {
  document.addEventListener('keydown', (e) => {
    const tp = tpOf();
    if (!tp || !active() || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const range = tp.area?.keyFn(e);   // the work area: I / O, Alt+X
    if (range) { e.preventDefault(); range(); return; }
    const fn = {
      ' ': tp.toggle,
      ArrowLeft: () => tp.nudge(e.shiftKey ? -1 : -tp.keyStep()),
      ArrowRight: () => tp.nudge(e.shiftKey ? 1 : tp.keyStep()),
      ArrowUp: tp.hasKeys ? () => tp.toKey(1) : null, ArrowDown: tp.hasKeys ? () => tp.toKey(-1) : null,
      Home: tp.toStart, End: tp.toEnd,
      ...more(e),
    }[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });
}
