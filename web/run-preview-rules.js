// Which frame a run's sampling preview belongs in, and which frame made which run. Pure: run-strip.js does the drawing.
//   rememberRun(runs, gens, frameId, cap?)  → runs { prompt id: frame id } with these runs added, the oldest dropped past cap
//   previewHome({ pid, runs, live, selected }) → the frame id to draw in, or null (the floating strip shows it instead)
//     The run's own frame when it has one and nothing else is open: never another frame's picture over the frame being worked in.
//     A run no frame made (an Image tool, a run from before the map): the open frame, else the one frame selected.
//   windowUp(was, { window, previews, words, live }) → whether the preview window is up. It comes up with a run's first picture and stays
//     until the run's line goes: never for a line with no picture (another device's run, previews off, a run still queued).
//   lineOver(words) → the step line says a run is over (its own end line, or another device's last step), so it goes by itself
const OTHER = /another device/, ENDED = /^(Finished|Stopped|Failed) /;
export function windowUp(was, { window: on = false, previews = true, words = '', live = false } = {}) {
  if (!on || !previews || !words || OTHER.test(words)) return false;
  return !!(was || live);
}
export function lineOver(words = '') {
  if (ENDED.test(words)) return true;
  const m = OTHER.test(words) ? /(\d+)\/(\d+)\s*$/.exec(words) : null;
  return !!m && m[1] === m[2];
}

export function rememberRun(runs, gens, frameId, cap = 40) {
  if (!frameId) return runs;
  const out = { ...runs };
  for (const g of gens || []) if (g?.prompt_id) { delete out[g.prompt_id]; out[g.prompt_id] = frameId; }
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete out[k];
  return out;
}

export function previewHome({ pid = null, runs = {}, live = null, selected = [] } = {}) {
  const owner = (pid && runs[pid]) || null;
  if (live) return !owner || owner === live ? live : null;
  if (owner) return owner;
  return selected.length === 1 ? selected[0] : null;
}
