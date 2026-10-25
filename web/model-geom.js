// The geometry of Create object, with no DOM: a polygon mesh ({ v: [[x,y,z]…], f: [[a,b,c,d]…] }, faces
// wound counter-clockwise seen from outside, quads mostly, a few triangles and caps) with extrude, inset
// and delete; a lathe profile ([[radius, height, smooth 0|1]…]) with Catmull-Rom between smooth points;
// and the conversion of either to a BufferGeometry. Node can import it (the tests do).
import * as THREE from './vendor/three.module.min.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a, fb = [0, 1, 0]) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : fb; };

export const cloneMesh = (m) => ({ v: m.v.map((p) => p.slice()), f: m.f.map((f) => f.slice()) });

// ---- faces ----
// Newell's normal: the area-weighted normal of any polygon (its length is twice the area)
function newell(m, f) {
  const n = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = m.v[f[i]], b = m.v[f[(i + 1) % f.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}
export const faceNormal = (m, i) => unit(newell(m, m.f[i]));
export const faceArea = (m, i) => len(newell(m, m.f[i])) / 2;
export function faceCentre(m, i) {
  const c = [0, 0, 0];
  for (const k of m.f[i]) { c[0] += m.v[k][0]; c[1] += m.v[k][1]; c[2] += m.v[k][2]; }
  return c.map((x) => x / m.f[i].length);
}

// ---- starting shapes ----
// merge vertices at the same place (the sides of a box are built apart)
export function weld(m, eps = 1e-6) {
  const at = new Map(), map = [], v = [];
  m.v.forEach((p, i) => {
    const key = p.map((x) => Math.round(x / eps)).join(',');
    if (!at.has(key)) { at.set(key, v.length); v.push(p); }
    map[i] = at.get(key);
  });
  return { v, f: m.f.map((f) => f.map((k) => map[k])) };
}
// a grid of quads from a corner along u and v (normal = u × v)
function grid(m, o, u, w, nu, nv) {
  const base = m.v.length;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) m.v.push([o[0] + u[0] * i / nu + w[0] * j / nv, o[1] + u[1] * i / nu + w[1] * j / nv, o[2] + u[2] * i / nu + w[2] * j / nv]);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * (nu + 1) + i;
    m.f.push([a, a + 1, a + nu + 2, a + nu + 1]);
  }
}
const cl = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n) || lo));
export function box(w = 1, h = 1, d = 1, sx = 1, sy = 1, sz = 1) {
  [sx, sy, sz] = [cl(sx, 1, 12), cl(sy, 1, 12), cl(sz, 1, 12)];
  const m = { v: [], f: [] }, x = w / 2, y = h / 2, z = d / 2;
  grid(m, [-x, -y, z], [w, 0, 0], [0, h, 0], sx, sy);       // +Z
  grid(m, [x, -y, -z], [-w, 0, 0], [0, h, 0], sx, sy);      // -Z
  grid(m, [x, -y, z], [0, 0, -d], [0, h, 0], sz, sy);       // +X
  grid(m, [-x, -y, -z], [0, 0, d], [0, h, 0], sz, sy);      // -X
  grid(m, [-x, y, z], [w, 0, 0], [0, 0, -d], sx, sz);       // +Y
  grid(m, [-x, -y, -z], [w, 0, 0], [0, 0, d], sx, sz);      // -Y
  return weld(m);
}
export function plane(w = 1, d = 1, sx = 1, sz = 1) {
  const m = { v: [], f: [] };
  grid(m, [-w / 2, 0, d / 2], [w, 0, 0], [0, 0, -d], cl(sx, 1, 12), cl(sz, 1, 12));
  return m;
}
export function cylinder(r = 0.5, h = 1, seg = 12, rings = 1) {
  seg = cl(seg, 3, 48); rings = cl(rings, 1, 12);
  const m = { v: [], f: [] };
  for (let k = 0; k <= rings; k++) for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    m.v.push([r * Math.sin(t), -h / 2 + (h * k) / rings, r * Math.cos(t)]);
  }
  const at = (k, i) => k * seg + (i % seg);
  for (let k = 0; k < rings; k++) for (let i = 0; i < seg; i++) m.f.push([at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i)]);
  m.f.push(Array.from({ length: seg }, (_, i) => at(rings, i)));                      // top cap
  m.f.push(Array.from({ length: seg }, (_, i) => at(0, seg - 1 - i)));                // bottom cap
  return m;
}
export function sphere(r = 0.5, seg = 12, rings = 8) {
  seg = cl(seg, 3, 48); rings = cl(rings, 2, 24);
  const m = { v: [[0, r, 0]], f: [] };
  for (let j = 1; j < rings; j++) for (let i = 0; i < seg; i++) {
    const p = (Math.PI * j) / rings, t = (i / seg) * Math.PI * 2;
    m.v.push([r * Math.sin(p) * Math.sin(t), r * Math.cos(p), r * Math.sin(p) * Math.cos(t)]);
  }
  m.v.push([0, -r, 0]);
  const row = (j, i) => 1 + (j - 1) * seg + (i % seg), top = 0, bot = m.v.length - 1;
  for (let i = 0; i < seg; i++) m.f.push([row(1, i), row(1, i + 1), top]);
  for (let j = 1; j < rings - 1; j++) for (let i = 0; i < seg; i++) m.f.push([row(j + 1, i), row(j + 1, i + 1), row(j, i + 1), row(j, i)]);
  for (let i = 0; i < seg; i++) m.f.push([bot, row(rings - 1, i + 1), row(rings - 1, i)]);
  return m;
}

// ---- health ----
// how many edges have one face (open) and how many are wrong (used by more than two faces, or twice in
// the same direction: a flipped or doubled face). A closed, well-made mesh is { open: 0, bad: 0 }.
export function edgeStats(m) {
  const dir = new Map();
  for (const f of m.f) for (let i = 0; i < f.length; i++) { const k = `${f[i]},${f[(i + 1) % f.length]}`; dir.set(k, (dir.get(k) || 0) + 1); }
  let open = 0, bad = 0;
  const seen = new Set();
  for (const [k, n] of dir) {
    const [a, b] = k.split(',');
    const rev = dir.get(`${b},${a}`) || 0, key = a < b ? k : `${b},${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (n > 1 || rev > 1) bad++; else if (!rev) open++;
  }
  return { open, bad };
}

// drop the vertices no face uses
function compact(m) {
  const map = new Map(), v = [];
  const f = m.f.map((face) => face.map((k) => {
    if (!map.has(k)) { map.set(k, v.length); v.push(m.v[k]); }
    return map.get(k);
  }));
  return { v, f };
}

// ---- editing ----
// the directed edges of the selected faces that no selected face has the other way round: the outline
// of the region the selection covers
function outline(m, S) {
  const have = new Set();
  for (const i of S) { const f = m.f[i]; for (let k = 0; k < f.length; k++) have.add(`${f[k]},${f[(k + 1) % f.length]}`); }
  const out = [];
  for (const i of S) {
    const f = m.f[i];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (!have.has(`${b},${a}`)) out.push({ a, b, face: i });
    }
  }
  return out;
}
// Both extrude and inset do the same thing to the topology: copy some vertices of the region, move the
// selected faces onto the copies, and close the gap along the outline with a ring of quads.
function regionOp(m, sel, copyOf, place) {
  const S = [...new Set(sel)].filter((i) => m.f[i]);
  if (!S.length) return { mesh: cloneMesh(m), sel: [] };
  const out = cloneMesh(m), edges = outline(m, S);
  const copy = new Map();
  for (const k of copyOf(m, S, edges)) copy.set(k, out.v.push(place(k, m, S, edges)) - 1);
  const at = (k) => (copy.has(k) ? copy.get(k) : k);
  for (const i of S) out.f[i] = m.f[i].map(at);
  for (const e of edges) out.f.push([e.a, e.b, at(e.b), at(e.a)]);
  return { mesh: compact(out), sel: S };
}

// Pull the selected faces out by d along their normals (negative d pushes them in). Where selected
// faces meet, a vertex moves along the average of their normals.
export function extrude(m, sel, d) {
  const S = [...new Set(sel)].filter((i) => m.f[i]);
  const nrm = new Map();
  for (const i of S) {
    const n = newell(m, m.f[i]);   // (area-weighted)
    for (const k of m.f[i]) { const c = nrm.get(k) || [0, 0, 0]; nrm.set(k, [c[0] + n[0], c[1] + n[1], c[2] + n[2]]); }
  }
  return regionOp(m, S, () => nrm.keys(), (k) => { const n = unit(nrm.get(k)), p = m.v[k]; return [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d]; });
}

// How far an inset can go before the new outline folds over itself (a little under the narrowest face)
export function maxInset(m, sel) {
  let best = Infinity;
  for (const i of new Set(sel)) {
    const f = m.f[i], c = faceCentre(m, i);
    for (let k = 0; k < f.length; k++) {
      const a = m.v[f[k]], e = sub(m.v[f[(k + 1) % f.length]], a), l = len(e);
      if (l > 1e-9) best = Math.min(best, len(cross(sub(c, a), e)) / l);
    }
  }
  return isFinite(best) ? Math.max(0.001, best * 0.95) : 0.001;
}
// Shrink the selected region's outline inwards by a (in its own plane); faces inside it stay put, and
// the selection becomes the smaller faces so an Extrude can follow.
export function inset(m, sel, a) {
  a = Math.max(0, Math.min(a, maxInset(m, sel)));
  const S = [...new Set(sel)].filter((i) => m.f[i]);
  const dirs = new Map();
  const want = (m2, S2, edges) => {
    for (const e of edges) {
      const n = faceNormal(m2, e.face), d = unit(sub(m2.v[e.b], m2.v[e.a]));
      const inward = unit(cross(n, d));
      for (const k of [e.a, e.b]) dirs.set(k, [...(dirs.get(k) || []), inward]);
    }
    return dirs.keys();
  };
  return regionOp(m, S, want, (k) => {
    const sum = dirs.get(k).reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]).map((x) => x / dirs.get(k).length);
    const q = Math.max(0.25, dot(sum, sum)), p = m.v[k];   // the mitre: the corner moves so both edges move by a
    return [p[0] + (sum[0] / q) * a, p[1] + (sum[1] / q) * a, p[2] + (sum[2] / q) * a];
  });
}

export function deleteFaces(m, sel) {
  const S = new Set(sel);
  return { mesh: compact({ v: m.v, f: m.f.filter((_, i) => !S.has(i)) }), sel: [] };
}

// ---- to three.js ----
// A BufferGeometry (triangles, not indexed) and faceOf: which face each triangle belongs to (for picking).
// Shading is flat, or smooth: each corner's normal averages the faces around it that are within the
// crease angle, so a rounded shape is smooth and a box keeps its edges.
export function toGeometry(m, { smooth = false, crease = 65 } = {}) {
  const pos = [], nor = [], faceOf = [];
  const fn = m.f.map((_, i) => faceNormal(m, i)), fa = m.f.map((_, i) => faceArea(m, i));
  const around = new Map();
  if (smooth) m.f.forEach((f, i) => f.forEach((k) => { if (!around.has(k)) around.set(k, []); around.get(k).push(i); }));
  const cosMax = Math.cos((crease * Math.PI) / 180);
  const cornerNormal = (i, k) => {
    if (!smooth) return fn[i];
    const s = [0, 0, 0];
    for (const j of around.get(k)) if (dot(fn[i], fn[j]) >= cosMax) { s[0] += fn[j][0] * fa[j]; s[1] += fn[j][1] * fa[j]; s[2] += fn[j][2] * fa[j]; }
    return unit(s, fn[i]);
  };
  const tri = (i, pa, na, pb, nb, pc, nc) => { pos.push(...pa, ...pb, ...pc); nor.push(...na, ...nb, ...nc); faceOf.push(i); };
  m.f.forEach((f, i) => {
    const P = f.map((k) => m.v[k]), N = f.map((k) => cornerNormal(i, k));
    if (f.length === 3) tri(i, P[0], N[0], P[1], N[1], P[2], N[2]);
    else if (f.length === 4) {
      tri(i, P[0], N[0], P[1], N[1], P[2], N[2]); tri(i, P[0], N[0], P[2], N[2], P[3], N[3]);
    } else {   // a cap: fan from the middle
      const c = faceCentre(m, i), cn = smooth ? fn[i] : N[0];
      for (let k = 0; k < f.length; k++) tri(i, c, cn, P[k], N[k], P[(k + 1) % f.length], N[(k + 1) % f.length]);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return { geo, faceOf };
}
// the faces' outlines as line segments (to see the quads)
export function edgeLines(m) {
  const seen = new Set(), pos = [];
  for (const f of m.f) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length], k = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(k)) continue;
    seen.add(k); pos.push(...m.v[a], ...m.v[b]);
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
}

// ---- lathe ----
// The outline through the profile points: a cubic Hermite per piece, with the tangent at a smooth point
// taken from its neighbours (Catmull-Rom) and along the piece at a corner, so two corners make a straight line.
export function profileCurve(profile, per = 8) {
  const P = profile.map(([x, y]) => [Math.max(0, x), y]), n = P.length, out = [];
  if (n < 2) return P.map((p, i) => ({ x: p[0], y: p[1], corner: !profile[i][2] }));
  const smooth = profile.map((p) => !!p[2]);
  const tan = (i, j) => {   // the tangent at point i for the piece towards j
    const chord = [P[j][0] - P[i][0], P[j][1] - P[i][1]];
    if (!smooth[i]) return chord;
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    return i === 0 || i === n - 1 ? chord : [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2];
  };
  out.push({ x: P[0][0], y: P[0][1], corner: !smooth[0] });
  for (let i = 0; i < n - 1; i++) {
    const straight = !smooth[i] && !smooth[i + 1], m0 = tan(i, i + 1), m1 = tan(i + 1, i);
    if (!straight) {
      for (let s = 1; s < per; s++) {
        const t = s / per, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        out.push({ x: Math.max(0, h00 * P[i][0] + h10 * m0[0] + h01 * P[i + 1][0] + h11 * m1[0]), y: h00 * P[i][1] + h10 * m0[1] + h01 * P[i + 1][1] + h11 * m1[1], corner: false });
      }
    }
    out.push({ x: P[i + 1][0], y: P[i + 1][1], corner: !smooth[i + 1] });
  }
  return out.filter((p, i) => !i || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 1e-6);
}
// THREE.LatheGeometry, one per run between corners (a corner is a hard edge: the shading breaks there)
export function latheGeometry({ profile, segments = 24, sweep = 360 }) {
  let pts = profileCurve(profile);
  if (pts.length < 2) return null;
  if (pts[0].y > pts[pts.length - 1].y) pts = pts.reverse();   // bottom to top, so the faces look outwards
  const runs = [];
  let run = [];
  pts.forEach((p, i) => {
    run.push(new THREE.Vector2(p.x, p.y));
    if (p.corner && i && i < pts.length - 1) { runs.push(run); run = [new THREE.Vector2(p.x, p.y)]; }
  });
  runs.push(run);
  const seg = cl(segments, 3, 96), phi = (Math.min(360, Math.max(10, sweep)) * Math.PI) / 180;
  return mergeGeometries(runs.filter((r) => r.length > 1).map((r) => new THREE.LatheGeometry(r, seg, 0, phi)));
}

// ---- what is saved ----
export const KINDS = ['lathe', 'mesh'];
export const DEFAULT_COLOR = '#c9c2b4';
export function vase() {
  return { v: 1, kind: 'lathe', profile: [[0, 0, 0], [0.35, 0, 0], [0.5, 0.35, 1], [0.28, 0.85, 1], [0.22, 1.0, 1], [0.34, 1.25, 0]],
    segments: 32, sweep: 360, color: DEFAULT_COLOR };
}
export function fromMesh(mesh, color = DEFAULT_COLOR, smooth = false) { return { v: 1, kind: 'mesh', mesh, smooth, color }; }
// the saved data to a geometry, standing on y = 0 and centred on x and z; size is its width, height and depth
export function buildObject(data) {
  const geo = data.kind === 'lathe' ? latheGeometry(data) : data.kind === 'mesh' ? toGeometry(data.mesh, { smooth: !!data.smooth }).geo : null;
  if (!geo) return null;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeBoundingBox();
  return { geo, size: b.getSize(new THREE.Vector3()).toArray() };
}
const r4 = (x) => Math.round(x * 1e4) / 1e4;
// the data as saved: numbers rounded, nothing else kept
export function pack(data) {
  const base = { v: 1, kind: data.kind, color: data.color || DEFAULT_COLOR };
  if (data.kind === 'lathe') return { ...base, profile: data.profile.map(([x, y, s]) => [r4(x), r4(y), s ? 1 : 0]), segments: data.segments, sweep: data.sweep };
  return { ...base, smooth: !!data.smooth, mesh: { v: data.mesh.v.map((p) => p.map(r4)), f: data.mesh.f } };
}
