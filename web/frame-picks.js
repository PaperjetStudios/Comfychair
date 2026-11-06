// Frames to layers (edit-ops.js): which frames of a clip are meant, and where their pictures go. No DOM (tests/frame_picks.test.mjs).
//   parseFrames(text)        '4, 54 96, 1.5s, last' → [{ frame: 4 }, { frame: 54 }, { frame: 96 }, { t: 1.5 }, { frame: 'last' }]:
//                            a whole number is a frame of the clip (0 is its first), a number with s is seconds in, `last` its end.
//                            Anything else is left out; a frame named twice is taken once.
//   framesText(list)         the same list as text, for the box
//   addFrames(text, frames)  the box's text with more frame numbers added, in order
//   timeOf(mark, fps)        the seconds into the clip a mark is at (the middle of its frame; the end: far past it, the grab stops at the last frame)
//   gridSpots(sizes, cols, gap)  [{ x, y }] for pictures of [{ w, h }] laid out `cols` to a row, left to right then down: every cell as big
//                            as the biggest picture, each picture centred in its cell
export const LAST = 'last';
const key = (m) => (m.t != null ? `t${m.t}` : `f${m.frame}`);

export function parseFrames(text) {
  const out = [], seen = new Set();
  for (const tok of String(text || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)) {
    let m = null;
    if (tok === LAST || tok === 'end') m = { frame: LAST };
    else if (/^\d+(\.\d+)?s$/.test(tok)) m = { t: parseFloat(tok) };
    else if (/^\d+$/.test(tok)) m = { frame: parseInt(tok, 10) };
    if (!m || seen.has(key(m))) continue;
    seen.add(key(m));
    out.push(m);
  }
  return out;
}

export const framesText = (list) => list.map((m) => (m.t != null ? `${m.t}s` : String(m.frame))).join(', ');

export function addFrames(text, frames) {
  const have = parseFrames(text), more = parseFrames(frames.join(' '));
  const all = [...have, ...more.filter((m) => !have.some((x) => key(x) === key(m)))];
  const nums = all.filter((m) => Number.isInteger(m.frame)).sort((a, b) => a.frame - b.frame);
  return framesText([...nums, ...all.filter((m) => m.t != null), ...all.filter((m) => m.frame === LAST)]);
}

export const timeOf = (m, fps) => (m.t != null ? m.t : m.frame === LAST ? 1e9 : (m.frame + 0.5) / (fps || 24));

export function gridSpots(sizes, cols, gap = 0) {
  const n = Math.max(1, Math.min(Math.round(cols) || 1, sizes.length || 1));
  const cw = Math.max(0, ...sizes.map((s) => s.w || 0)), ch = Math.max(0, ...sizes.map((s) => s.h || 0));
  return sizes.map((s, i) => ({
    x: Math.round((i % n) * (cw + gap) + (cw - (s.w || cw)) / 2),
    y: Math.round(Math.floor(i / n) * (ch + gap) + (ch - (s.h || ch)) / 2),
  }));
}
