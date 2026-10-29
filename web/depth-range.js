// The near and far a depth render maps to white and black, from depths sampled on each frame (no DOM, tested in
// tests/depth_range.test.mjs). One range for the whole clip stretched to fit everything the camera ever sees, so a
// shot whose camera travels (10 s instead of 5) squeezed half of it into a few greys and H3's depth control let go.
// 'follow' (the default) gives each frame its own range, smoothed over about half a second either side so it
// doesn't pump; 'clip' keeps one range for the clip. Both ignore the nearest and farthest 1 % of the pixels: a
// sliver of floor at the lens or a far wall in a corner no longer sets the range for everything.

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

// samples: per frame, the depths seen (any array of numbers; empty when nothing was in view).
// Returns [near, far] per frame. breaks: sample indexes a cut falls on. Smoothing never crosses one,
// so a close-up and a wide shot each keep their own range.
export function frameRanges(samples, opts = {}) {
  const breaks = [...new Set((opts.breaks || []).map((b) => Math.round(b)).filter((b) => b > 0 && b < samples.length))].sort((a, b) => a - b);
  if (!breaks.length || opts.mode === 'clip') return rangesOf(samples, opts);
  const out = [];
  let from = 0;
  for (const b of [...breaks, samples.length]) { out.push(...rangesOf(samples.slice(from, b), opts)); from = b; }
  return out;
}
function rangesOf(samples, { mode = 'follow', window = 12, lo = 0.01, hi = 0.99 } = {}) {
  const n = samples.length;
  const per = samples.map((s) => {
    if (!s || !s.length) return null;
    const a = Float64Array.from(s).sort();
    return [pct(a, lo), pct(a, hi)];
  });
  if (!per.some(Boolean)) return Array(n).fill([0.3, 10]);
  // frames with nothing in view borrow the nearest frame that had something
  for (let i = 0; i < n; i++) {
    if (per[i]) continue;
    let d = 1;
    while (!per[i - d] && !per[i + d]) d++;
    per[i] = per[i - d] || per[i + d];
  }
  const pad = ([a, b]) => [Math.max(0.05, a * 0.97), Math.max(a * 1.05, b * 1.03)];
  if (mode === 'clip') {
    const near = Math.min(...per.map((r) => r[0])), far = Math.max(...per.map((r) => r[1]));
    return Array(n).fill(pad([near, far]));
  }
  // the range around each frame covers its neighbours (no frame clips what the next one shows), then it is eased
  // in log space so it glides rather than steps
  const cover = per.map((_, i) => {
    let a = Infinity, b = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(n - 1, i + window); j++) { a = Math.min(a, per[j][0]); b = Math.max(b, per[j][1]); }
    return [Math.log(a), Math.log(b)];
  });
  return cover.map((_, i) => {
    let a = 0, b = 0, w = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(n - 1, i + window); j++) {
      const k = window + 1 - Math.abs(i - j);   // (a triangle: the frame itself counts most)
      a += cover[j][0] * k; b += cover[j][1] * k; w += k;
    }
    return pad([Math.exp(a / w), Math.exp(b / w)]);
  });
}
