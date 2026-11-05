// The PC's load at a glance, beside the project picker: a square of five lines, one fifth of its height each, as long as
// CPU, RAM, GPU, VRAM and the GPU's temperature are full (GET /api/meters, app/meters.py). Hover or long-press for the numbers.
// (ui.js is loaded when the meter is wired, so the words below can be tested outside a browser)

export const METERS = [
  ['cpu', 'CPU', '#4f8cff'], ['ram', 'RAM', '#3fbf7f'], ['gpu', 'GPU', '#ff9f3f'], ['vram', 'VRAM', '#b06cff'], ['temp', 'Temp', '#ff5a5a'],
];

// the tooltip's words for one reading
export function meterWords(r) {
  const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
  return METERS.map(([k, label]) => {
    if (k === 'temp') return `${label} ${r?.temp_c == null ? '–' : `${Math.round(r.temp_c)}°C`}`;
    if (k === 'vram' && r?.vram_used_mb != null) return `${label} ${pct(r.vram)} (${(r.vram_used_mb / 1024).toFixed(1)} of ${(r.vram_total_mb / 1024).toFixed(1)} GB)`;
    return `${label} ${pct(r?.[k])}`;
  }).join('\n');
}

export async function wireMeters(after = document.getElementById('projectSel')) {
  if (!after || document.querySelector('.pc-meter')) return;
  const { api, h } = await import('./ui.js');
  const bars = METERS.map(([k, label, colour]) => h('span', { class: 'pc-meter-bar', 'data-k': k, style: `background:${colour}`, 'aria-hidden': 'true' }));
  const box = h('div', { class: 'pc-meter', role: 'img', 'aria-label': 'PC load', title: 'PC load' }, bars);
  after.after(box);
  let busy = false;
  const tick = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const r = await api('/api/meters', { busy: false, timeout: 5000 });
      METERS.forEach(([k], i) => { bars[i].style.width = `${Math.max(0, Math.min(100, r?.[k] ?? 0))}%`; });
      box.title = meterWords(r);
      box.setAttribute('aria-label', `PC load: ${meterWords(r).replace(/\n/g, ', ')}`);
    } catch { /* (the server is away: the lines stay as they were) */ } finally { busy = false; }
  };
  tick();
  setInterval(tick, 2000);
  document.addEventListener('visibilitychange', tick);
}
