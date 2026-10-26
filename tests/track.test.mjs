// Run by tests/test_track_math.py (node tests/track.test.mjs): the camera made from a track.
import assert from 'node:assert/strict';
import * as T from '../web/track-math.js';

const D2R = Math.PI / 180;
const W = 640, H = 360, N = 49;
const mk = (f) => ({ size: [W, H], fps: 24, frames: Array.from({ length: N }, (_, i) => f(i)) });

// smoothing keeps a line a line (ends held) and flattens noise
assert.deepEqual(T.smooth([1, 2, 3], 0), [1, 2, 3]);
const noisy = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : -1));
assert.ok(Math.max(...T.smooth(noisy, 3).slice(10, 50).map(Math.abs)) < 0.1);

// project a world point through a camera row: pixels in the clip, or null
function project(c, p) {
  const b = T.basis([c.px, c.py, c.pz], [c.tx, c.ty, c.tz], c.roll);
  const d = [p[0] - c.px, p[1] - c.py, p[2] - c.pz];
  const zc = -(d[0] * b.z[0] + d[1] * b.z[1] + d[2] * b.z[2]);
  const xc = d[0] * b.x[0] + d[1] * b.x[1] + d[2] * b.x[2], yc = d[0] * b.y[0] + d[1] * b.y[1] + d[2] * b.y[2];
  const tv = Math.tan(c.fov * D2R / 2);
  return [(xc / zc / (tv * W / H) + 1) / 2 * W, (1 - yc / zc / tv) / 2 * H];
}

// a pan right (picture slides 2 px and up 1 px per frame): a fixed world point must slide the same way on screen
const pan = mk((i) => ({ tx: 2 * i, ty: -i, rot: 0, scale: 1 }));
const rows = T.cameraRows(pan, { sigma: 0, lens: 35 });
const world = [0.4, 1.5, 0];   // somewhere in front of the first camera
const p0 = project(rows[0], world);
for (const i of [10, 30, 48]) {
  const p = project(rows[i], world);
  assert.ok(Math.abs(p[0] - p0[0] - 2 * i) < 0.02 * 2 * i + 1, `x at ${i}: ${p[0] - p0[0]}`);   // (a turning camera isn't exactly a slide)
  assert.ok(Math.abs(p[1] - p0[1] + i) < 0.02 * i + 1, `y at ${i}: ${p[1] - p0[1]}`);
}

// zoom in 1.5x: as a lens, a point away from the middle spreads 1.5x; as a dolly, the camera moves forward
const zoom = mk((i) => ({ tx: 0, ty: 0, rot: 0, scale: 1 + 0.5 * i / (N - 1) }));
const zf = T.cameraRows(zoom, { sigma: 0, zoomAs: 'fov' }), zd = T.cameraRows(zoom, { sigma: 0, zoomAs: 'dolly', dist: 6 });
const q = [1, 1.5, 0], a = project(zf[0], q), b = project(zf[N - 1], q);
assert.ok(Math.abs((b[0] - W / 2) / (a[0] - W / 2) - 1.5) < 0.01);
assert.ok(zf[N - 1].fov < zf[0].fov && zd[N - 1].fov === zd[0].fov);
assert.ok(Math.abs(zd[N - 1].pz - (6 - 6 * (1 - 1 / 1.5))) < 1e-9);
const pd = project(zd[N - 1], [1, 1.5, 0]);   // a point at the subject distance spreads 1.5x
assert.ok(Math.abs((pd[0] - W / 2) / (a[0] - W / 2) - 1.5) < 0.01);

// pan and zoom together: whatever sat at the first frame's centre ends up where the track says the centre went
const both = mk((i) => ({ tx: 3 * i * (1 + 0.003 * i), ty: 1.2 * i * (1 + 0.003 * i), rot: 0, scale: 1.003 ** i }));
for (const zoomAs of ['fov', 'dolly']) {
  const rb = T.cameraRows(both, { sigma: 0, zoomAs, dist: 6 });
  for (const i of [20, 48]) {
    const p = project(rb[i], [0, 1.5, 0]), f = both.frames[i];
    assert.ok(Math.abs(p[0] - W / 2 - f.tx) < 0.03 * f.tx + 1 && Math.abs(p[1] - H / 2 - f.ty) < 0.03 * f.ty + 1, `${zoomAs} ${i}: ${p[0] - W / 2} vs ${f.tx}, ${p[1] - H / 2} vs ${f.ty}`);
  }
}

// the scene: camera linear, keys thinned to the ends for a straight pan, the card fills the picture every frame
const sc = T.sceneFromTrack({ ...pan, atlas: { url: '/x.jpg', cols: 8, rows: 7, count: 49, step: 1 }, tracks: [{ f: 0, p: [[0.5, 0.5], [0.51, 0.49]] }] }, { sigma: 0 });
assert.equal(sc.v, 1);
assert.equal(sc.camera.ease, 'linear');
assert.ok(sc.camera.keys.length >= 2 && sc.camera.keys.length < 14, `keys ${sc.camera.keys.length}`);
assert.equal(sc.camera.keys[0].f, 0);
assert.equal(sc.camera.keys.at(-1).f, N - 1);
assert.equal(sc.objects.map((o) => o.type).join(), 'backdrop,trackpts');
const bd = sc.objects[0];
assert.equal(bd.keys.length, sc.camera.keys.length);
assert.ok(sc.width / sc.height > 1.7 && sc.width / sc.height < 1.8);
// sample the card and camera midway between two keys (linear): the card's corners still reach the frame's edge
const lerp = (x, y, t) => x + (y - x) * t;
for (let k = 0; k + 1 < bd.keys.length; k++) {
  const ca = sc.camera.keys[k], cb = sc.camera.keys[k + 1], ba = bd.keys[k], bb = bd.keys[k + 1];
  const t = 0.5, c = Object.fromEntries(Object.keys(ca).map((n) => [n, lerp(ca[n], cb[n], t)]));
  const wantH = 2 * 30 * Math.tan(c.fov * D2R / 2), h = lerp(ba.sy, bb.sy, t);
  assert.ok(Math.abs(h / wantH - 1) < 0.01, `card height ${h} vs ${wantH}`);
  const eye = [c.px, c.py, c.pz], bs = T.basis(eye, [c.tx, c.ty, c.tz], c.roll);
  const centre = [eye[0] - bs.z[0] * 30, eye[1] - bs.z[1] * 30, eye[2] - bs.z[2] * 30];
  const got = [lerp(ba.x, bb.x, t), lerp(ba.y, bb.y, t), lerp(ba.z, bb.z, t)];
  assert.ok(Math.hypot(...got.map((g, i) => g - centre[i])) < 0.2, 'card centre');
}

// roll: footage turning clockwise on screen (rot 20 deg) is a camera rolled anticlockwise (roll -20, positive is clockwise).
// A point right of centre moves down the picture (y grows) by about its distance from centre * sin(20 deg), and no roll: none of that
const spin = mk((i) => ({ tx: 0, ty: 0, rot: 20 * i / (N - 1), scale: 1 }));
const sr = T.cameraRows(spin, { sigma: 0 });
assert.equal(sr[0].roll, -0);
assert.ok(Math.abs(sr[N - 1].roll + 20) < 1e-9, `roll ${sr[N - 1].roll}`);
assert.ok(rows.every((r) => r.roll === 0 || r.roll === -0));
const right = [1, 1.5, 0], r0 = project(sr[0], right), r1 = project(sr[N - 1], right);
const dx = r0[0] - W / 2, wantY = dx * Math.sin(20 * D2R);
assert.ok(r1[1] - r0[1] > 0.8 * wantY && r1[1] - r0[1] < 1.2 * wantY, `y moved ${r1[1] - r0[1]}, want about ${wantY}`);
assert.ok(Math.abs((r1[0] - W / 2) - dx * Math.cos(20 * D2R)) < 0.05 * dx);
// the scene keeps it, and the card is turned with the camera
const ss = T.sceneFromTrack({ ...spin, atlas: { url: '/x.jpg', cols: 8, rows: 7, count: 49, step: 1 } }, { sigma: 0, points: false });
assert.ok(Math.abs(ss.camera.keys.at(-1).roll + 20) < 1e-9 && ss.camera.keys.length >= 2);
assert.ok(Math.abs(ss.objects[0].keys.at(-1).rz) > 5, 'card rolled');

// thin: a bend keeps its corner
const bent = Array.from({ length: 21 }, (_, i) => ({ f: i, v: i < 10 ? i : 10 - (i - 10) }));
assert.deepEqual(T.thin(bent, { v: 0.1 }).map((r) => r.f), [0, 10, 20]);
console.log('track math ok');
