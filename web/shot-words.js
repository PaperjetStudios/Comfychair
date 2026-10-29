// Words a shot is described with, shared by the Story tab and the 3D tab's shot list. No DOM.
// A line for a model is built here too: H3 wants "[Shot N] At mm:ss.mmm, …", LTX a cut with no time.

export const SIZES = [['wide', 'Wide', 'wide shot'], ['medium', 'Medium', 'medium shot'], ['close', 'Close', 'close-up'], ['ecu', 'Extreme close', 'extreme close-up']];
export const ANGLES = [['eye', 'Eye level', 'eye level'], ['low', 'Low', 'low angle'], ['high', 'High', 'high angle'], ['over', 'Overhead', 'overhead shot'],
  ['dutch', 'Dutch', 'dutch angle'], ['pov', 'POV', 'point of view shot'], ['ots', 'Over shoulder', 'over-the-shoulder shot'],
  ['side', 'Profile', 'side view, in profile'], ['back', 'From behind', 'seen from behind']];
export const MOVES = [['static', 'Static'], ['pan', 'Pan'], ['tilt', 'Tilt'], ['push', 'Push in'], ['pull', 'Pull back'], ['track', 'Track'],
  ['orbit', 'Orbit'], ['handheld', 'Handheld'], ['crane', 'Crane'], ['zoom', 'Zoom']];

// what the 3D camera moves (scene-camera.js) are called in this list
export const MOVE_FROM = {
  'dolly-in': 'push', 'push-in': 'push', 'dolly-out': 'pull', 'pull-out': 'pull',
  'truck-left': 'track', 'truck-right': 'track',
  'pedestal-up': 'crane', 'pedestal-down': 'crane',
  'pan-left': 'pan', 'pan-right': 'pan', 'tilt-up': 'tilt', 'tilt-down': 'tilt',
  'orbit-left': 'orbit', 'orbit-right': 'orbit',
  'crane-up': 'crane', 'crane-down': 'crane',
  'zoom-in': 'zoom', 'zoom-out': 'zoom', 'dolly-zoom': 'zoom', 'shake': 'handheld',
};
// the verb in "the camera …"
const MOVE_SAY = {
  pan: 'pans', tilt: 'tilts', push: 'pushes in', pull: 'pulls back', track: 'tracks',
  orbit: 'circles', handheld: 'is handheld', crane: 'cranes', zoom: 'zooms',
};

const phrase = (list, key, fallback) => list.find(([k]) => k === key)?.[2] || fallback;
const article = (s, cap) => { const a = /^[aeiou]/i.test(s) ? 'an' : 'a'; return cap ? a[0].toUpperCase() + a.slice(1) : a; };

// clip-relative mm:ss.mmm (H3's cut time). sec is seconds from the start of the clip.
export function stamp(sec) {
  const t = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`;
}

// SMPTE HH:MM:SS:FF from a start code (default 01:00:00:00) plus a frame at this fps.
export function smpte(frame, fps = 24, start = '01:00:00:00') {
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(String(start).trim());
  const rate = Math.max(1, Math.round(fps) || 24);
  const base = m ? ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * rate + +m[4]) : rate * 3600;
  let t = Math.max(0, Math.round(base + frame));
  const F = t % rate; t = Math.floor(t / rate);
  const s = t % 60; t = Math.floor(t / 60);
  const mi = t % 60; const h = Math.floor(t / 60);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(mi)}:${p(s)}:${p(F)}`;
}

// the main subject's height on screen, as a fraction of the frame height (taller than the frame is past 1)
export function sizeFromHeight(h) {
  if (h == null || !Number.isFinite(h)) return 'wide';
  if (h > 1.6) return 'ecu';
  if (h >= 0.9) return 'close';
  if (h >= 0.4) return 'medium';
  return 'wide';
}

// pitch: degrees the aim sits above the horizontal (+ looks up). |roll| over 8° is Dutch.
export function angleFrom(pitch, roll = 0) {
  if (Math.abs(roll) > 8) return 'dutch';
  if (pitch <= -50) return 'over';
  if (pitch <= -12) return 'high';
  if (pitch >= 12) return 'low';
  return 'eye';
}
export function pitchOf(cam) {
  const dy = cam.ty - cam.py, horiz = Math.hypot(cam.tx - cam.px, cam.tz - cam.pz);
  return Math.atan2(dy, horiz || 1e-6) * 180 / Math.PI;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// where a world box lands on screen. cover: share of its corners inside the frame. height: its
// vertical size ÷ the frame (corners in front count even when they fall outside, so a crop can pass 1).
// overlap: the picture of the box crosses the frame, even when every corner sits outside (a close-up).
export function projectBox(cam, box, aspect) {
  const P = [cam.px, cam.py, cam.pz];
  let fwd = norm(sub([cam.tx, cam.ty, cam.tz], P));
  let right = cross(fwd, [0, 1, 0]);
  if (len(right) < 1e-6) right = [1, 0, 0];
  right = norm(right);
  let up = norm(cross(right, fwd));
  if (cam.roll) {
    const a = -(cam.roll) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const r2 = add(mul(right, c), mul(up, s));
    up = add(mul(right, -s), mul(up, c));
    right = r2;
  }
  const fy = 1 / Math.tan(((cam.fov || 45) * Math.PI / 180) / 2);
  const fx = fy / (aspect || 1);
  const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
  const corners = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push([x, y, z]);
  let inside = 0, front = 0, nx0 = Infinity, nx1 = -Infinity, ny0 = Infinity, ny1 = -Infinity;
  for (const c of corners) {
    const d = sub(c, P), z = dot(d, fwd);
    if (z < 0.05) continue;
    front++;
    const nx = dot(d, right) / z * fx, ny = dot(d, up) / z * fy;
    nx0 = Math.min(nx0, nx); nx1 = Math.max(nx1, nx);
    ny0 = Math.min(ny0, ny); ny1 = Math.max(ny1, ny);
    if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) inside++;
  }
  if (!front) return null;
  return { cover: inside / corners.length, height: (ny1 - ny0) / 2, overlap: nx0 <= 1 && nx1 >= -1 && ny0 <= 1 && ny1 >= -1 };
}

// size, angle and the names mostly in frame, from the camera and world boxes [{ name, min, max }] at one frame.
export function framingOf(cam, boxes, width, height) {
  const aspect = (width || 1) / (height || 1);
  let best = null;
  const names = [];
  for (const b of boxes || []) {
    const hit = projectBox(cam, b, aspect);
    if (!hit?.overlap) continue;
    names.push(b.name);
    if (!best || hit.height > best.height) best = { height: hit.height, name: b.name };
  }
  const subjects = best ? [best.name, ...names.filter((n) => n !== best.name)] : [];
  return { size: sizeFromHeight(best ? best.height : null), angle: angleFrom(pitchOf(cam), cam.roll || 0), subjects, height: best?.height || 0 };
}

const dist = (c) => Math.hypot(c.tx - c.px, c.ty - c.py, c.tz - c.pz);
// a, b: the camera at the start and end of the shot. mv: a move id written on the start key. noisy: dense jitter.
export function guessMove(a, b, { mv = null, noisy = false } = {}) {
  if (mv && MOVE_FROM[mv]) return MOVE_FROM[mv];
  if (!a || !b) return 'static';
  if (noisy) return 'handheld';
  const move = Math.hypot(b.px - a.px, b.py - a.py, b.pz - a.pz);
  const aim = Math.hypot(b.tx - a.tx, b.ty - a.ty, b.tz - a.tz);
  const fov = Math.abs((b.fov || 0) - (a.fov || 0));
  const dd = Math.abs(dist(b) - dist(a));
  const dy = Math.abs(b.py - a.py);
  const horiz = Math.hypot(b.px - a.px, b.pz - a.pz);
  if (fov > 2 && move < 0.25) return 'zoom';
  if (dy > 0.25 && dy >= horiz) return 'crane';
  if (dd > 0.25) return dist(b) < dist(a) ? 'push' : 'pull';
  if (move > 0.3 && dd < 0.2 && aim < 0.25) return 'orbit';
  if (horiz > 0.25 && aim > 0.2) return 'track';
  if (move < 0.2 && aim > 0.15) return Math.abs(b.ty - a.ty) > Math.hypot(b.tx - a.tx, b.tz - a.tz) ? 'tilt' : 'pan';
  return 'static';
}

// one shot's sentence. n is 1-based. at is seconds from the clip start (later shots only). format 'ltx' drops the time.
export function shotSentence({ n, at = 0, size, angle, subjects, move, action, format = 'h3' }) {
  const sz = phrase(SIZES, size, 'wide shot'), ang = phrase(ANGLES, angle, 'eye level');
  const who = subjects?.length ? subjects.join(' and ') : 'the scene';
  const mv = move && move !== 'static' ? `; the camera ${MOVE_SAY[move] || move}` : '';
  const body = `${sz}, ${ang}, of ${who}${mv}`;
  const act = action ? ` ${String(action).trim()}` : '';
  if (format === 'ltx') return n <= 1 ? `Shot 1: ${body}.${act}` : `Hard cut to shot ${n}: ${body}.${act}`;
  if (n <= 1) return `[Shot 1] ${article(sz, true)} ${body}.${act}`;
  return `[Shot ${n}] At ${stamp(at)}, the camera cuts to ${article(sz, false)} ${body}.${act}`;
}

// seconds outside 4–15, cuts under a second apart, more than 10 cuts, LTX outside 2–4 shots.
export function shotWarnings({ seconds = 0, gaps = [], count = 0, format = 'h3' } = {}) {
  const w = [];
  if (seconds < 4 || seconds > 15) w.push(`The clip is ${+Number(seconds).toFixed(2)} s. H3 wants 4–15 s.`);
  if (gaps.some((g) => g < 1)) w.push('Two cuts are under a second apart.');
  if (count > 10) w.push('More than 10 cuts. H3 copes with about 10.');
  if (format === 'ltx' && (count < 2 || count > 4)) w.push('LTX wants 2–4 shots, with no timestamps.');
  return w;
}
