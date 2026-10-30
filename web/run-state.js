// Generation progress and timing shared by services and screens. No editor imports.
export const RUN = { pid: null, stages: [], current: null, title: '', step: null, t0: 0, stageT0: 0, done: new Set(), timer: 0 };

export const runTime = (g) => (g.finished ? g.finished - (g.started || g.created) : null);
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
    : `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
}
