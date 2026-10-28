import { button, h, iconBtn, seg, setIcon } from './ui.js';

// ---------------------------------------------------------------------------
// playback: the transport bar and keys every player shares (Video, Sound, VFX): ⇤ to the start, back and
// forward a step, Play / Pause, Loop, a speed, the time and, for a player without a timeline, a scrub bar.
// Keys while its tab is open: Space plays, ← / → step (Shift: a second), Home / End.
//
//   const tp = transport(player, { step, loop, rates, scrub, fps, frames, extra, timeId });
//   player: { playing(), play(), pause(), seek(t), t(), len() }
//   step: { by: seconds | () => seconds (the buttons), key (← / →, default by), back, fwd (icons), label ('one frame'),
//     pause (false: keep playing through a step) }
//   loop: { get, set } | null; rates: [[rate, label]] with rate: { get, set } | null
//   bar.append(tp.el); tp.update() after a play, pause or seek from elsewhere; playKeys(() => tabOpen, tp, more)
// ---------------------------------------------------------------------------

// m:ss.ss, or m:ss:ff (frames) with an fps
export function fmtTime(t, fps = 0) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t % 60;
  if (!fps) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  const fr = Math.min(fps - 1, Math.floor((t % 1) * fps + 1e-6));
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

export function transport(p, { step, loop = null, rates = null, rate = null, scrub = false, fps = 0, frames = false, extra = [], timeId = null,
  disabled = false } = {}) {
  const fpsNow = () => (typeof fps === 'function' ? fps() : fps);
  const val = (x) => (typeof x === 'function' ? x() : x);
  const small = () => val(step.by);
  const tp = {
    small, keyStep: () => val(step.key ?? step.by),
    toggle: () => { if (p.playing()) p.pause(); else p.play(); tp.update(); },
    nudge: (d) => { if (step.pause !== false) p.pause(); p.seek(Math.min(Math.max(0, p.t() + d), p.len() || Infinity)); tp.update(); },
    toStart: () => { p.pause(); p.seek(0); tp.update(); },
    toEnd: () => { p.pause(); p.seek(p.len()); tp.update(); },
  };
  const playBtn = button('▶ Play', tp.toggle, { cls: 'small primary', title: 'Play / pause (Space)', disabled });
  const time = h('span', { class: 'timecode', id: timeId });
  const bar = scrub ? h('input', { type: 'range', class: 'scrub', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time', disabled,
    oninput: (e) => { p.seek(parseFloat(e.target.value)); tp.update(); } }) : null;
  const loopBtn = loop ? button('⟲ Loop', () => { loop.set(!loop.get()); showLoop(); }, { title: 'Play it again from the start at the end' }) : null;
  const showLoop = () => { if (!loopBtn) return; loopBtn.classList.toggle('on', !!loop.get()); loopBtn.setAttribute('aria-pressed', String(!!loop.get())); };
  tp.update = () => {
    setIcon(playBtn, p.playing() ? '❚❚ Pause' : '▶ Play');
    const t = p.t(), len = p.len(), f = fpsNow();
    time.textContent = `${fmtTime(t, f)} / ${fmtTime(len, f)}${frames && f ? ` · frame ${Math.round(t * f) + 1}` : ''}`;
    if (bar) {
      bar.max = len || 0;
      if (document.activeElement !== bar) bar.value = t;
      bar.style.setProperty('--p', len ? `${(t / len) * 100}%` : '0%');
    }
  };
  tp.el = h('div', { class: 'transport' },
    bar ? h('div', { class: 'scrub-row' }, bar, time) : null,
    iconBtn('Go to the start', '⇤', tp.toStart, { title: 'Go to the start (Home)' }),
    iconBtn(`Back ${step.label}`, step.back || '⏮', () => tp.nudge(-small()), { title: `Back ${step.label} (←)` }),
    playBtn,
    iconBtn(`Forward ${step.label}`, step.fwd || '⏭', () => tp.nudge(small()), { title: `Forward ${step.label} (→)` }),
    loopBtn,
    rates && rate ? seg(rates, rate.get(), (v) => rate.set(Number(v))) : null,
    ...extra,
    bar ? null : time);
  showLoop(); tp.update();
  return tp;
}

// The player's keys while active() (its tab is open and nothing is being typed in). more(e): the tab's own keys.
export function playKeys(active, tpOf, more = () => ({})) {
  document.addEventListener('keydown', (e) => {
    const tp = tpOf();
    if (!tp || !active() || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
    const fn = {
      ' ': tp.toggle,
      ArrowLeft: () => tp.nudge(e.shiftKey ? -1 : -tp.keyStep()),
      ArrowRight: () => tp.nudge(e.shiftKey ? 1 : tp.keyStep()),
      Home: tp.toStart, End: tp.toEnd,
      ...more(e),
    }[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });
}
