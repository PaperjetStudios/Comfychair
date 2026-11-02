// A splat layer's size and trim, drawn live by a Spark modifier on its SplatMesh (no reload):
//   o.grow: every Gaussian's size × this, all three axes (erode < 1 < dilate); o.growRenders: renders too (default off)
//   o.trim: { on, c: [x, y, z], r, near, renders } in the file's own units: keep Gaussians within r of c and farther
//     than `near` from the file's origin (a photo splat's camera). renders: the full set is trimmed the same way in
//     renders (default on). o.trim.made: the trim the preview levels were made with (the server cut them).
//   o.trim.box: { on, c, h: [half sizes], q: [x, y, z, w] } in the same units: keep what is inside this turned box too. Its own Y
//     is up in the layer, so its bottom face (-Y) can be the floor (scene-view.js setFloor). It has no `on` of the radial trim's.
// Only the uniforms change as the sliders move; the modifier is built once per mesh.
import * as THREE from './vendor/three.module.min.js';

export const GROWS = [0.5, 0.7, 0.85, 1, 1.2, 1.5];
// what a size factor does to the fill cost (each Gaussian's screen area)
export const fillFactor = (g) => +(g * g).toFixed(2);
export const growOf = (o, render) => (render && !o.growRenders ? 1 : +o.grow || 1);
export const trimOn = (o, render) => !!(o.trim?.on && o.trim.c && o.trim.r > 0 && (!render || o.trim.renders !== false));
export const boxOn = (o, render) => !!(o.trim?.box?.on && (!render || o.trim.renders !== false));
const fixed = (a) => a.map((v) => +(+v).toFixed(4));
// the trim as the server takes it (rounded as it rounds), or null
export const trimBody = (t) => {
  const radial = t?.on && t.c && t.r > 0, box = t?.box?.on;
  if (!radial && !box) return null;
  return { ...(radial ? { c: fixed(t.c), r: +(+t.r).toFixed(4), near: +(+(t.near || 0)).toFixed(4) } : {}),
    ...(box ? { box: { c: fixed(t.box.c), h: fixed(t.box.h), q: fixed(t.box.q) } } : {}) };
};
export const sameTrim = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// a box's own X, Y and Z in the file
export function boxAxes([x, y, z, w]) {
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  return [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)], [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]];
}
const inBox = (x, y, z, c, h, a) => {
  const dx = x - c[0], dy = y - c[1], dz = z - c[2];
  return a.every((v, i) => Math.abs(dx * v[0] + dy * v[1] + dz * v[2]) <= h[i]);
};
// what a trim says about one point, as a test made once for many (the radial part only when it is on; t.on absent counts as on)
function keeper(t) {
  const radial = t.c && t.r > 0 && t.on !== false, box = t.box?.on ? { c: t.box.c, h: t.box.h, a: boxAxes(t.box.q) } : null;
  const c = t.c, r2 = radial ? t.r * t.r : 0, n2 = radial ? (t.near || 0) ** 2 : 0;
  return (x, y, z) => (!radial || ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r2 && (n2 === 0 || x * x + y * y + z * z > n2)))
    && (!box || inBox(x, y, z, box.c, box.h, box.a));
}
// the share of points ([x, y, z] triples, flat) a trim keeps
export function keptShare(pts, t) {
  const n = pts.length / 3;
  if (!n) return 1;
  const keep = keeper(t);
  let k = 0;
  for (let i = 0; i < pts.length; i += 3) if (keep(pts[i], pts[i + 1], pts[i + 2])) k++;
  return k / n;
}
// A box round the points, its Y the layer's up (flip: the file is upside down, so turned over): the middle 99% of them with a little room.
export function boxAround(pts, flip = false) {
  const lo = [], hi = [], n = pts.length / 3;
  for (let a = 0; a < 3; a++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = pts[i * 3 + a];
    v.sort();
    const l = n ? v[Math.floor(n * 0.005)] : -1, h = n ? v[Math.min(n - 1, Math.floor(n * 0.995))] : 1, room = Math.max(0.01, (h - l) * 0.05);
    lo.push(l - room); hi.push(h + room);
  }
  return { on: true, c: lo.map((l, i) => +((l + hi[i]) / 2).toFixed(4)), h: lo.map((l, i) => +((hi[i] - l) / 2).toFixed(4)), q: flip ? [1, 0, 0, 0] : [0, 0, 0, 1] };
}
// the box's bottom face through point p (in the file), its top where it was
export function boxBottomTo(box, p) {
  const ay = boxAxes(box.q)[1], at = (p[0] - box.c[0]) * ay[0] + (p[1] - box.c[1]) * ay[1] + (p[2] - box.c[2]) * ay[2];
  const top = box.h[1], bottom = Math.min(at, top - 0.01), mid = (top + bottom) / 2;
  return { ...box, c: box.c.map((v, i) => +(v + ay[i] * mid).toFixed(4)), h: [box.h[0], +((top - bottom) / 2).toFixed(4), box.h[2]] };
}
// the middle of the points: the median per axis (a few floaters don't pull it)
export function medianOf(pts) {
  const out = [];
  for (let a = 0; a < 3; a++) {
    const v = new Float32Array(pts.length / 3);
    for (let i = 0; i < v.length; i++) v[i] = pts[i * 3 + a];
    v.sort();
    out.push(v.length ? +v[v.length >> 1].toFixed(4) : 0);
  }
  return out;
}
// the radius that keeps all but the farthest 1% of the points around c
export function reachOf(pts, c) {
  const n = pts.length / 3, d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.hypot(pts[i * 3] - c[0], pts[i * 3 + 1] - c[1], pts[i * 3 + 2] - c[2]);
  d.sort();
  return n ? +d[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(3) : 1;
}
// The nearest point along a ray (origin o, unit direction d, both in the points' space) that lies within `tol` of it:
// a tap on a splat lands on what is seen there. null if the ray passes nothing.
export function pickAlong(pts, o, d, tol) {
  let best = null, bt = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const px = pts[i] - o[0], py = pts[i + 1] - o[1], pz = pts[i + 2] - o[2];
    const t = px * d[0] + py * d[1] + pz * d[2];
    if (t <= 0 || t >= bt) continue;
    if (px * px + py * py + pz * pz - t * t <= tol * tol) { bt = t; best = [pts[i], pts[i + 1], pts[i + 2]]; }
  }
  return best;
}

// Where a splat's content goes to stand centred on the floor at its layer's origin: the shift of its holder, from
// its box ([x0, y0, z0, x1, y1, z1] in the file's units) turned over when flip (y and z negated). For a photo's
// splat this is also where the photo's camera ends up (the file's origin), in the layer's own space.
export function standShift(box, flip) {
  const [x0, y0, z0, x1, y1, z1] = box, f = flip ? -1 : 1;
  const lo = [x0, f > 0 ? y0 : -y1, f > 0 ? z0 : -z1], hi = [x1, f > 0 ? y1 : -y0, f > 0 ? z1 : -z0];
  return [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2].map((v) => +v.toFixed(4) || 0);
}

// up to `max` of a SplatMesh's centres, evenly through the file (cached on the mesh)
export function samplePoints(mesh, max = 40000) {
  if (mesh.userData.pts) return mesh.userData.pts;
  const n = mesh.packedSplats?.numSplats || 0, step = Math.max(1, Math.ceil(n / max));
  const pts = new Float32Array(Math.ceil(n / step) * 3);
  let j = 0;
  mesh.forEachSplat((i, c) => { if (i % step === 0 && j < pts.length) { pts[j++] = c.x; pts[j++] = c.y; pts[j++] = c.z; } });
  return (mesh.userData.pts = pts.subarray(0, j));
}
// ...only those the mesh's trim leaves showing, so a tap doesn't land on what was cut away
export function keptPoints(mesh) {
  const pts = samplePoints(mesh), s = mesh.userData.shape?.now?.();
  if (!s || (s.r >= 1e9 && !s.near && !s.box)) return pts;
  const key = JSON.stringify([s.c, s.r, s.near, s.box]);
  if (mesh.userData.keptKey === key) return mesh.userData.kept;
  const keep = keeper({ c: s.c, r: s.r, near: s.near, box: s.box ? { on: true, c: s.box.c, h: s.box.h, q: s.box.q } : null });
  const out = new Float32Array(pts.length);
  let j = 0;
  for (let i = 0; i < pts.length; i += 3) if (keep(pts[i], pts[i + 1], pts[i + 2])) { out[j++] = pts[i]; out[j++] = pts[i + 1]; out[j++] = pts[i + 2]; }
  mesh.userData.keptKey = key;
  return (mesh.userData.kept = out.subarray(0, j));
}

// The modifier: lib is Spark's module. Returns { set(o) } and puts it on the mesh.
export function shapeMesh(lib, mesh, o, render = false) {
  const D = lib.dyno;
  const v3 = () => D.dynoVec3(new THREE.Vector3());
  const u = { grow: D.dynoFloat(1), c: D.dynoVec3(new THREE.Vector3()), r: D.dynoFloat(1e9), near: D.dynoFloat(0),
    bc: v3(), bx: v3(), by: v3(), bz: v3(), hx: D.dynoFloat(1e9), hy: D.dynoFloat(1e9), hz: D.dynoFloat(1e9) };
  let shownBox = null;
  mesh.objectModifier = D.dynoBlock({ gsplat: D.Gsplat }, { gsplat: D.Gsplat }, ({ gsplat }) => {
    const { scales, center, opacity } = D.splitGsplat(gsplat).outputs;
    const d = D.sub(center, u.bc), within = (axis, half) => D.step(D.abs(D.dot(d, axis)), half);
    const box = D.mul(D.mul(within(u.bx, u.hx), within(u.by, u.hy)), within(u.bz, u.hz));
    const keep = D.mul(D.mul(D.step(D.distance(center, u.c), u.r), D.step(u.near, D.length(center))), box);
    return { gsplat: D.combineGsplat({ gsplat, scales: D.mul(scales, u.grow), opacity: D.mul(opacity, keep) }) };
  });
  mesh.updateGenerator();
  const shape = {
    now: () => ({ grow: u.grow.value, c: u.c.value.toArray(), r: u.r.value, near: u.near.value, box: shownBox }),   // (a depth picture's dots: splat-depth.js)
    set(x = o) {
      u.grow.value = growOf(x, render);
      const t = trimOn(x, render);
      u.c.value.set(...(t ? x.trim.c : [0, 0, 0]));
      u.r.value = t ? x.trim.r : 1e9;
      u.near.value = t ? x.trim.near || 0 : 0;
      const b = boxOn(x, render) ? x.trim.box : null, a = boxAxes(b?.q || [0, 0, 0, 1]);
      shownBox = b ? { c: [...b.c], h: [...b.h], q: [...b.q], a } : null;
      u.bc.value.set(...(b?.c || [0, 0, 0]));
      u.bx.value.set(...a[0]); u.by.value.set(...a[1]); u.bz.value.set(...a[2]);
      u.hx.value = b ? b.h[0] : 1e9; u.hy.value = b ? b.h[1] : 1e9; u.hz.value = b ? b.h[2] : 1e9;
      mesh.updateVersion();
    },
  };
  shape.set(o);
  mesh.userData.shape = shape;
  return shape;
}

// three great circles: where the trim's sphere is (in the file's units; the caller places it in the splat's holder)
export function trimSphere() {
  const pts = [];
  for (let a = 0; a < 3; a++) {
    for (let i = 0; i < 64; i++) {
      for (const k of [i, i + 1]) {
        const t = (k / 64) * Math.PI * 2, p = [Math.cos(t), Math.sin(t)];
        pts.push(a === 0 ? new THREE.Vector3(p[0], p[1], 0) : a === 1 ? new THREE.Vector3(p[0], 0, p[1]) : new THREE.Vector3(0, p[0], p[1]));
      }
    }
  }
  const s = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffc94d, depthTest: false, transparent: true, opacity: 0.9 }));
  s.renderOrder = 999; s.visible = false; s.raycast = () => {};
  return s;
}
