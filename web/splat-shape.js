// A splat layer's size and trim, drawn live by a Spark modifier on its SplatMesh (no reload):
//   o.grow: every Gaussian's size × this, all three axes (erode < 1 < dilate); o.growRenders: renders too (default off)
//   o.trim: { on, c: [x, y, z], r, near, renders } in the file's own units: keep Gaussians within r of c and farther
//     than `near` from the file's origin (a photo splat's camera). renders: the full set is trimmed the same way in
//     renders (default on). o.trim.made: the trim the preview levels were made with (the server cut them).
// Only the uniforms change as the sliders move; the modifier is built once per mesh.
import * as THREE from './vendor/three.module.min.js';

export const GROWS = [0.5, 0.7, 0.85, 1, 1.2, 1.5];
// what a size factor does to the fill cost (each Gaussian's screen area)
export const fillFactor = (g) => +(g * g).toFixed(2);
export const growOf = (o, render) => (render && !o.growRenders ? 1 : +o.grow || 1);
export const trimOn = (o, render) => !!(o.trim?.on && o.trim.c && o.trim.r > 0 && (!render || o.trim.renders !== false));
// the trim as the server takes it (rounded as it rounds), or null
export const trimBody = (t) => (t?.on && t.c && t.r > 0
  ? { c: t.c.map((v) => +(+v).toFixed(4)), r: +(+t.r).toFixed(4), near: +(+(t.near || 0)).toFixed(4) } : null);
export const sameTrim = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// the share of points ([x, y, z] triples, flat) a trim keeps
export function keptShare(pts, t) {
  const n = pts.length / 3;
  if (!n) return 1;
  const [cx, cy, cz] = t.c, r2 = t.r * t.r, n2 = (t.near || 0) ** 2;
  let k = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r2 && (n2 === 0 || x * x + y * y + z * z > n2)) k++;
  }
  return k / n;
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

// The modifier: lib is Spark's module. Returns { set(o) } and puts it on the mesh.
export function shapeMesh(lib, mesh, o, render = false) {
  const D = lib.dyno;
  const u = { grow: D.dynoFloat(1), c: D.dynoVec3(new THREE.Vector3()), r: D.dynoFloat(1e9), near: D.dynoFloat(0) };
  mesh.objectModifier = D.dynoBlock({ gsplat: D.Gsplat }, { gsplat: D.Gsplat }, ({ gsplat }) => {
    const { scales, center, opacity } = D.splitGsplat(gsplat).outputs;
    const keep = D.mul(D.step(D.distance(center, u.c), u.r), D.step(u.near, D.length(center)));
    return { gsplat: D.combineGsplat({ gsplat, scales: D.mul(scales, u.grow), opacity: D.mul(opacity, keep) }) };
  });
  mesh.updateGenerator();
  const shape = {
    set(x = o) {
      u.grow.value = growOf(x, render);
      const t = trimOn(x, render);
      u.c.value.set(...(t ? x.trim.c : [0, 0, 0]));
      u.r.value = t ? x.trim.r : 1e9;
      u.near.value = t ? x.trim.near || 0 : 0;
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
