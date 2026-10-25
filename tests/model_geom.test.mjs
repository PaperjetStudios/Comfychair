// Run by tests/test_model_geom.py (node tests/model_geom.test.mjs): the pure geometry of Create object.
import assert from 'node:assert/strict';
import * as G from '../web/model-geom.js';

const finite = (m) => m.v.every((p) => p.every(Number.isFinite));
const centre = (m) => m.v.reduce((s, p) => s.map((x, i) => x + p[i] / m.v.length), [0, 0, 0]);
// every face looks away from the middle (for convex shapes)
function outward(m) {
  const c = centre(m);
  return m.f.every((_, i) => {
    const n = G.faceNormal(m, i), f = G.faceCentre(m, i);
    return n[0] * (f[0] - c[0]) + n[1] * (f[1] - c[1]) + n[2] * (f[2] - c[2]) > 0;
  });
}
const topFaces = (m) => m.f.map((_, i) => i).filter((i) => G.faceNormal(m, i)[1] > 0.99);

// starting shapes are closed, outward and finite
const shapes = { box: G.box(1, 1, 1), box3: G.box(2, 1, 1, 3, 2, 1), cyl: G.cylinder(0.5, 1, 12, 2), sph: G.sphere(0.5, 12, 8) };
for (const [name, m] of Object.entries(shapes)) {
  assert.deepEqual(G.edgeStats(m), { open: 0, bad: 0 }, `${name} closed`);
  assert.ok(finite(m), `${name} finite`);
  assert.ok(outward(m), `${name} outward`);
}
assert.equal(G.box().f.length, 6); assert.equal(G.box().v.length, 8);
assert.equal(G.box(1, 1, 1, 2, 2, 2).f.length, 24);
assert.equal(G.cylinder(0.5, 1, 12, 1).f.length, 14);
assert.deepEqual(G.edgeStats(G.plane()), { open: 4, bad: 0 });

// extrude: the top goes up, the box stays closed and outward, counts match
let b = G.box(1, 1, 1);
let e = G.extrude(b, topFaces(b), 0.5);
assert.equal(e.mesh.f.length, 6 + 4); assert.equal(e.mesh.v.length, 12);
assert.deepEqual(G.edgeStats(e.mesh), { open: 0, bad: 0 });
assert.ok(finite(e.mesh));
assert.equal(Math.max(...e.mesh.v.map((p) => p[1])), 1);   // 0.5 + 0.5
assert.deepEqual(e.sel, topFaces(b));
assert.ok(e.sel.every((i) => G.faceNormal(e.mesh, i)[1] > 0.99));
assert.ok(e.mesh.f.every((_, i) => G.faceArea(e.mesh, i) > 0));
// inwards
const ei = G.extrude(b, topFaces(b), -0.25);
assert.deepEqual(G.edgeStats(ei.mesh), { open: 0, bad: 0 });
assert.ok(ei.sel.every((i) => ei.mesh.f[i].every((k) => ei.mesh.v[k][1] === 0.25)));   // a pit: the rim stays at 0.5

// inset then extrude again: a raised, stepped top
let i1 = G.inset(e.mesh, e.sel, 0.1);
assert.equal(i1.mesh.f.length, 10 + 4); assert.equal(i1.mesh.v.length, 16);
assert.deepEqual(G.edgeStats(i1.mesh), { open: 0, bad: 0 });
assert.ok(finite(i1.mesh));
const cap = G.faceArea(i1.mesh, i1.sel[0]);
assert.ok(Math.abs(cap - 0.64) < 1e-9, `inset cap area ${cap}`);   // 1 - 2 * 0.1 = 0.8 wide
let e2 = G.extrude(i1.mesh, i1.sel, 0.3);
assert.equal(e2.mesh.f.length, 14 + 4);
assert.deepEqual(G.edgeStats(e2.mesh), { open: 0, bad: 0 });
assert.ok(Math.abs(Math.max(...e2.mesh.v.map((p) => p[1])) - 1.3) < 1e-9);
assert.ok(e2.sel.every((i) => G.faceNormal(e2.mesh, i)[1] > 0.99));

// inset clamps instead of folding
const big = G.inset(b, topFaces(b), 5);
assert.ok(finite(big.mesh)); assert.ok(G.faceArea(big.mesh, big.sel[0]) > 0);
assert.deepEqual(G.edgeStats(big.mesh), { open: 0, bad: 0 });

// a region of several faces: 2x2 top inset only moves the outline, extrude keeps the inside flat
const seg = G.box(1, 1, 1, 2, 1, 2);
const region = topFaces(seg);
assert.equal(region.length, 4);
const ri = G.inset(seg, region, 0.1);
assert.equal(ri.mesh.f.length, seg.f.length + 8);        // a ring of 8 quads around the outline
assert.deepEqual(G.edgeStats(ri.mesh), { open: 0, bad: 0 });
const re = G.extrude(seg, region, 0.4);
assert.equal(re.mesh.v.length, seg.v.length + 9 - 1);   // 9 new top vertices; the old middle one is dropped, the 8 outline ones stay
assert.equal(re.mesh.f.length, seg.f.length + 8);
assert.deepEqual(G.edgeStats(re.mesh), { open: 0, bad: 0 });
assert.ok(re.sel.every((i) => G.faceNormal(re.mesh, i)[1] > 0.99));

// a cylinder cap (an n-gon) extrudes too
const cyl = G.cylinder(0.5, 1, 12, 1), capIdx = topFaces(cyl);
assert.equal(capIdx.length, 1);
const ce = G.extrude(cyl, capIdx, 0.5);
assert.deepEqual(G.edgeStats(ce.mesh), { open: 0, bad: 0 }); assert.equal(ce.mesh.f.length, 14 + 12);

// a plane extrudes into a tray (open), and delete opens a box
const pe = G.extrude(G.plane(), [0], 0.3);
assert.ok(finite(pe.mesh)); assert.equal(pe.mesh.f.length, 5);
const del = G.deleteFaces(b, topFaces(b));
assert.equal(del.mesh.f.length, 5); assert.deepEqual(G.edgeStats(del.mesh), { open: 4, bad: 0 });
// inputs are never changed
assert.equal(b.f.length, 6); assert.equal(Math.max(...b.v.map((p) => p[1])), 0.5);
// an empty selection does nothing
assert.equal(G.extrude(b, [], 1).mesh.f.length, 6);

// to BufferGeometry: triangle counts, unit normals, faceOf, no NaN
for (const smooth of [false, true]) {
  const { geo, faceOf } = G.toGeometry(e2.mesh, { smooth });
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
  assert.equal(pos.length / 9, faceOf.length);
  assert.equal(faceOf.length, e2.mesh.f.length * 2);   // all quads
  assert.ok([...pos, ...nor].every(Number.isFinite));
  for (let i = 0; i < nor.length; i += 3) assert.ok(Math.abs(Math.hypot(nor[i], nor[i + 1], nor[i + 2]) - 1) < 1e-5);
}
const sg = G.toGeometry(G.sphere(0.5, 12, 8), { smooth: true }).geo.attributes;
assert.ok([...sg.normal.array].every(Number.isFinite));
const sp = sg.position.array, sn = sg.normal.array;   // smooth sphere: normals point away from the middle
for (let i = 0; i < sp.length; i += 3) assert.ok(sp[i] * sn[i] + sp[i + 1] * sn[i + 1] + sp[i + 2] * sn[i + 2] > 0);
// a box keeps its edges when smooth (crease), a cylinder rounds off
const bn = G.toGeometry(G.box(), { smooth: true }).geo.attributes.normal.array;
assert.ok([...bn].every((x) => Math.abs(x) < 1e-6 || Math.abs(Math.abs(x) - 1) < 1e-6));
assert.ok(G.edgeLines(b).attributes.position.count === 24);

// lathe: a straight cylinder profile stands on y 0, normals point outwards, corners stay corners
const flat = { profile: [[0.5, 0, 0], [0.5, 1, 0]], segments: 16, sweep: 360 };
const lg = G.latheGeometry(flat);
const lp = lg.attributes.position.array, ln = lg.attributes.normal.array;
for (let i = 0; i < lp.length; i += 3) assert.ok(lp[i] * ln[i] + lp[i + 2] * ln[i + 2] > 0.4, 'lathe normal outwards');
// the same profile drawn top to bottom still faces outwards
const lg2 = G.latheGeometry({ ...flat, profile: [[0.5, 1, 0], [0.5, 0, 0]] });
for (let i = 0; i < lg2.attributes.position.array.length; i += 3) assert.ok(lg2.attributes.position.array[i] * lg2.attributes.normal.array[i] + lg2.attributes.position.array[i + 2] * lg2.attributes.normal.array[i + 2] > 0.4);
assert.equal(G.profileCurve([[0, 0, 0], [1, 0, 0], [1, 1, 0]]).length, 3);                  // corners: no extra points
assert.ok(G.profileCurve([[0, 0, 0], [1, 0, 1], [1, 1, 0]]).length > 3);                    // a smooth point rounds both sides
const v = G.vase();
const vg = G.latheGeometry(v);
assert.ok([...vg.attributes.position.array, ...vg.attributes.normal.array].every(Number.isFinite));
assert.ok(G.profileCurve(v.profile).every((p) => p.x >= 0 && Number.isFinite(p.y)));
// a half sweep only reaches one side (x >= 0)
const half = G.latheGeometry({ ...v, sweep: 180 });
half.computeBoundingBox(); vg.computeBoundingBox();
assert.ok(half.boundingBox.min.x > -1e-6 && vg.boundingBox.min.x < -0.3);
assert.equal(G.latheGeometry({ profile: [[0.5, 0, 0]] }), null);
// a profile with every x at 0 still doesn't blow up
const z = G.latheGeometry({ profile: [[0, 0, 1], [0, 1, 1], [0, 2, 1]] });
assert.ok(z === null || [...z.attributes.position.array].every(Number.isFinite));

// buildObject: stands on the floor, centred, and says its size
const o = G.buildObject(G.fromMesh(G.box(2, 1, 1)));
assert.deepEqual(o.size.map((x) => +x.toFixed(6)), [2, 1, 1]);
assert.ok(Math.abs(o.geo.boundingBox.min.y) < 1e-9);
const ov = G.buildObject(v);
assert.ok(ov.size.every((x) => x > 0 && Number.isFinite(x)));
// pack: rounded and round-trips through JSON
const packed = JSON.parse(JSON.stringify(G.pack(G.fromMesh(G.sphere(0.5, 8, 6), '#ff0000', true))));
assert.equal(packed.kind, 'mesh'); assert.equal(packed.smooth, true);
assert.ok(G.buildObject(packed).geo.attributes.position.count > 0);
console.log('model geometry ok');
