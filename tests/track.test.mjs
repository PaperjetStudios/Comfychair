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

// ---- a solved camera (sceneFromSolve): cv axes (x right, y down, z forward), cams camera-to-world 3x4 ----
const K = [500, 500, 320, 180];
const matMul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const cam34 = (R, t) => [R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2]];
// cv projection of world point X by camera row c: Xc = Rᵀ(X − t)
function cvProject(c, X) {
  const d = [X[0] - c[3], X[1] - c[7], X[2] - c[11]];
  const xc = c[0] * d[0] + c[4] * d[1] + c[8] * d[2], yc = c[1] * d[0] + c[5] * d[1] + c[9] * d[2], zc = c[2] * d[0] + c[6] * d[1] + c[10] * d[2];
  return [K[0] * xc / zc + K[2], K[1] * yc / zc + K[3]];
}
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// 30 cameras moving right, yawing right and rolling a little; 50 points in front, 20 of them on the floor (y = 1.5)
const cams = Array.from({ length: 30 }, (_, i) => cam34(matMul(Ry(0.6 * i * D2R), Rz(0.4 * i * D2R)), [0.04 * i, 0.01 * i, 0.02 * i]));
const pts = Array.from({ length: 50 }, (_, i) => (i < 20 ? [rnd() * 4 - 2, 1.5, 3 + rnd() * 6] : [rnd() * 4 - 2, rnd() * 2 - 1, 4 + rnd() * 6]));
const solve = { v: 1, method: 'pnp', fps: 24, n: 30, size: [W, H], start: 0, K, cams, pts, floor: { n: [0, -1, 0], d: 1.5 }, metric: true, quality: { used: 50, err: 0.3, lost: 0 } };
const srows = T.solveRows(solve);
// (a) camera 0: 1.5 above the floor, 6 back, looking down -Z, level, the lens's fov
const c0 = srows[0];
assert.ok(Math.hypot(c0.px, c0.py - 1.5, c0.pz - 6) < 1e-9, `cam0 ${c0.px} ${c0.py} ${c0.pz}`);
assert.ok(Math.abs(c0.tx - c0.px) < 1e-9 && Math.abs(c0.ty - c0.py) < 1e-9 && c0.tz < c0.pz);
assert.ok(Math.abs(c0.roll) < 1e-9);
assert.ok(Math.abs(c0.fov - 2 * Math.atan(180 / 500) / D2R) < 1e-9);
// (b) the three camera sees every point where the cv camera does (pins the axis change and roll's sign)
const world3 = T.worldFromSolve(solve);
for (const i of [0, 7, 15, 29]) {
  assert.ok(Math.abs(srows[i].roll - 0.4 * i) < 1e-6 || i === 0, `roll ${i}: ${srows[i].roll}`);
  for (const X of pts.slice(0, 50).filter((_, j) => j % 5 === 0)) {
    const want = cvProject(cams[i], X), got = project(srows[i], T.toThree(X, world3));
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.5, `frame ${i}: ${got} vs ${want}`);
  }
}
// (c) camera 0 pitched down 10 deg: the floor (in its frame) tilts with it, floor points still land on y = 0
{
  const R0 = Rx(-10 * D2R);   // camera 0 to level: its z axis points down (+y) a little
  const lvl = (X) => [0, 1, 2].map((r) => R0[0][r] * X[0] + R0[1][r] * X[1] + R0[2][r] * X[2]);   // level point to camera 0: R0ᵀX
  const n = lvl([0, -1, 0]);
  const fpts = pts.slice(0, 20).map(lvl);
  const tilted = { ...solve, cams: [cam34([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0]), ...cams.slice(1)], pts: fpts, floor: { n, d: 1.5 } };
  const w = T.worldFromSolve(tilted);
  for (const X of fpts) assert.ok(Math.abs(T.toThree(X, w)[1]) < 1e-9, `floor point y ${T.toThree(X, w)[1]}`);
  const r = T.solveRows(tilted)[0];
  assert.ok(Math.abs(r.py - 1.5) < 1e-9 && Math.abs(r.px) < 1e-9 && Math.abs(r.pz - 6) < 1e-9);
  assert.ok(Math.abs(Math.atan2(r.ty - r.py, Math.hypot(r.tx - r.px, r.tz - r.pz)) / D2R + 10) < 1e-6, 'looks 10 deg down');
  assert.ok(Math.abs(r.roll) < 1e-9);
  for (const X of fpts.slice(0, 5)) {   // and projects back to the same pixels
    const want = cvProject(tilted.cams[0], X), got = project(r, T.toThree(X, w));
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.5);
  }
}
// (d) da3 has no units: the floor 3.7 below camera 0 still puts it 1.5 up (and Scale multiplies)
{
  const k = 3.7 / 1.5, big = { ...solve, method: 'da3', metric: false, floor: { n: [0, -1, 0], d: 3.7 },
    cams: cams.map((c) => c.map((v, j) => (j % 4 === 3 ? v * k : v))), pts: pts.map((p) => p.map((v) => v * k)) };
  assert.ok(Math.abs(T.solveRows(big)[0].py - 1.5) < 1e-9);
  assert.ok(Math.abs(T.solveRows(big, { scale: 2 })[0].py - 3) < 1e-9);
  const sr2 = T.solveRows(big);   // same pixels as the metric solve
  for (const i of [5, 29]) assert.ok(Math.hypot(sr2[i].px - srows[i].px, sr2[i].py - srows[i].py, sr2[i].pz - srows[i].pz) < 1e-6);
  // no floor: the points' median distance becomes `dist`, camera 0 sits at 1.5
  const nf = { ...big, floor: null };
  const wn = T.worldFromSolve(nf, { dist: 6 });
  const med = [...nf.pts.map((p) => Math.hypot(...p))].sort((x, y) => x - y)[25];
  assert.ok(Math.abs(med * wn.s - 6) < 1e-9 && Math.abs(T.solveRows(nf, { dist: 6 })[0].py - 1.5) < 1e-9);
}
// (e) the scene: with a track's atlas a footage card (shifted to the solve's start) and the points; the room's floor shown
{
  const track = { size: [W, H], fps: 24, start: 0.5, atlas: { url: '/x.jpg', cols: 8, rows: 4, count: 30, step: 1 } };
  const s1 = T.sceneFromSolve({ ...solve, start: 1 }, track, {});
  assert.equal(s1.objects.map((o) => o.type).join(), 'backdrop,trackpts');
  assert.equal(s1.objects[0].at, -12);
  assert.equal(s1.objects[1].pts.length, 50);
  assert.equal(s1.room.hidden, false);
  assert.equal(s1.camera.keys[0].f, 0);
  assert.equal(s1.camera.keys.at(-1).f, 29);
  assert.equal(s1.objects[0].keys.length, s1.camera.keys.length);
  assert.ok(Math.abs(s1.camera.base.py - 1.5) < 1e-9);
  const s2 = T.sceneFromSolve({ ...solve, floor: null }, { size: [W, H], fps: 24 }, { points: true });
  assert.equal(s2.objects.map((o) => o.type).join(), 'trackpts');
  assert.equal(s2.room.hidden, true);
  const s3 = T.sceneFromSolve(solve, null, { points: false });
  assert.equal(s3.objects.length, 0);
}
// the coloured cloud goes through the same axes, keeps its colours; a floor point lands on y = 0
{
  const cloud = [[0.5, 1.5, 4, 10, 20, 30], [-1, 1.5, 7, 200, 100, 0], [0.2, -0.3, 5, 255, 255, 255]];
  const sc4 = T.sceneFromSolve({ ...solve, cloud }, null, {});
  assert.equal(sc4.objects.map((o) => o.type).join(), 'trackpts,cloudpts');
  const cl = sc4.objects[1];
  assert.equal(cl.id, 'cl0track');
  assert.equal(cl.pts.length, 3);
  assert.deepEqual(cl.pts[0].slice(3), [10, 20, 30]);
  assert.ok(Math.abs(cl.pts[0][1]) < 1e-9 && Math.abs(cl.pts[1][1]) < 1e-9, 'floor points on y = 0');
  const w = T.worldFromSolve(solve), want = T.toThree(cloud[2], w);
  assert.ok(Math.hypot(...want.map((v, i) => v - cl.pts[2][i])) < 2e-3);
  assert.equal(T.sceneFromSolve({ ...solve, cloud }, null, { cloud: false }).objects.length, 1);
}
console.log('solve math ok');

// a background picture: on the card's spot, one even scale, and it always covers the frame
{
  const c = { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, roll: 0 };
  const card = T.backdropAt(c, 16 / 9);
  for (const [pic, frame] of [[16 / 9, 16 / 9], [3 / 2, 16 / 9], [9 / 16, 16 / 9], [2.4, 16 / 9], [4 / 5, 1]]) {
    const p = T.pictureAt(c, pic, frame);
    assert.equal(p.sx, p.sy); assert.equal(p.sy, p.sz);
    assert.deepEqual([p.x, p.y, p.z, p.rx, p.ry, p.rz], [card.x, card.y, card.z, card.rx, card.ry, card.rz]);
    const fh = card.sy, fw = fh * frame;
    assert.ok(p.sy >= fh - 1e-9 && p.sy * pic >= fw - 1e-9, `covers the frame: ${pic} in ${frame}`);
    assert.ok(Math.abs(p.sy - fh) < 1e-9 || Math.abs(p.sy * pic - fw) < 1e-9, `no bigger than it has to be: ${pic} in ${frame}`);
  }
}
