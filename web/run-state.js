// Generation progress and timing shared by services and screens. No editor imports.
export const RUN = { pid: null, stages: [], current: null, title: '', step: null, t0: 0, stageT0: 0, done: new Set(), timer: 0 };

export const runTime = (g) => (g.finished ? g.finished - (g.started || g.created) : null);
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
    : `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
}

// The sampler's pace. The clock starts at the first step reported, so the time spent moving the model onto the
// card doesn't count against the steps. A count that falls or a new step total is another pass: it starts afresh.
export function stepClock(clock, value, max, now) {
  if (!clock || max !== clock.max || value < clock.value) return { max, first: value, firstAt: now, value, at: now, per: null };
  if (value === clock.value) return clock;
  return { ...clock, value, at: now, per: (now - clock.firstAt) / (value - clock.first) };
}

// The run's whole length in seconds: the time up to the last step plus the steps left at the average pace.
// It stays still between steps, and never reads less than the time already gone. null until there's a pace.
export function runEstimate(clock, t0, now) {
  if (!clock?.per) return null;
  return (Math.max(clock.at + (clock.max - clock.value) * clock.per, now) - t0) / 1000;
}

export const fmtPerStep = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)}s/step` : `${fmtDur(ms / 1000)}/step`);
