// Run by tests/test_scale_math.py (node tests/scale_math.test.mjs): real-world size maths (web/scale-math.js).
import assert from 'node:assert/strict';
import * as M from '../web/scale-math.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const nearV = (a, b, e = 1e-6) => a.forEach((v, i) => near(v, b[i], e));

// units: glTF is metres, FBX says cm per unit, OBJ and splats don't say
assert.equal(M.unitToMetres('glb'), 1);
assert.equal(M.unitToMetres('fbx', 1), 0.01);
assert.equal(M.unitToMetres('fbx', 100), 1);
assert.equal(M.unitToMetres('fbx'), null);
assert.equal(M.unitToMetres('obj'), null);
assert.deepEqual(M.importFit('glb', [0.5, 1.8, 0.3]), { fit: 1, ask: false });   // true size, even when small
assert.deepEqual(M.importFit('glb', [20, 15, 30]), { fit: 1, ask: false });      // a 30 m building stays 30 m
assert.equal(M.importFit('glb', [200, 10, 10]).ask, true);                        // absurd: ask
assert.equal(M.importFit('glb', [0.01, 0.02, 0.01]).ask, true);
assert.deepEqual(M.importFit('fbx', [50, 180, 30], 1), { fit: 0.01, ask: false }); // a 180 cm character
assert.equal(M.importFit('obj', [0.5, 1.8, 0.3]).ask, true);                       // unknown unit: ask
assert.equal(M.importFit('obj', [50, 180, 30]).fit, +(2 / 180).toPrecision(3));    // (dismissed: the old usable size)
assert.equal(M.fitForHeight(180, 1.8), 0.01);

// bounding sizes with scale (and a turn about the vertical)
nearV(M.boxSize([-0.5, 0, -0.25, 0.5, 2, 0.25], 2), [2, 4, 1]);
nearV(M.boxSize([0, 0, 0, 1, 1, 1], [0.45, 1.75, 0.28]), [0.45, 1.75, 0.28]);
nearV(M.boxSize([0, 0, 0, 2, 1, 1], 1, 90), [1, 1, 2]);
nearV(M.boxSize([0, 0, 0, 1, 1, 1], 1, 45), [Math.SQRT2, 1, Math.SQRT2]);
assert.equal(M.fmtHWD([0.45, 1.75, 0.28]), '1.75 m × 45 cm × 28 cm');
assert.equal(M.fmtLen(12.345), '12.3 m');

// rescale about the base: the base stays, the rest moves away from it by k
nearV(M.rescaleAbout([1, 0, 1], [0, 0, 0], 2), [2, 0, 2]);
nearV(M.rescaleAbout([3, 1, 0], [3, 0, 0], 0.5), [3, 0.5, 0]);
nearV(M.baseOf([-1, 0.2, -2], [3, 4, 2]), [1, 0.2, 0]);
{
  // a model 3 units tall standing at (2, 0, 1), its base the same point: scaled to 1.5 tall, it stays put
  const v = { x: 2, y: 0, z: 1, sx: 1, sy: 1, sz: 1 }, k = M.factorFor(3, 1.5);
  assert.deepEqual(M.scaledVals(v, [2, 0, 1], k), { x: 2, y: 0, z: 1, sx: 0.5, sy: 0.5, sz: 0.5 });
  // an origin off the base (a photo's mesh with its lens at the origin, 1 above the floor point): it moves down
  const w = M.scaledVals({ x: 0, y: 1, z: 0, sx: 2, sy: 2, sz: 2 }, [0, 0, 0], 0.5);
  nearV([w.x, w.y, w.z, w.sy], [0, 0.5, 0, 1]);
}
near(M.factorFor(0.9, 1.8), 2);
assert.equal(M.factorFor(0, 1.8), 1);

// person calibration from two 3D points: head and feet 2 units apart, shown at scale 1.5 (3 m): ×0.5667 to 1.7 m
{
  const k = M.personFactor([0, -1, 4], [0, 1, 4], 1.5, 1.7);
  near(k, 1.7 / 3);
  near(M.dist([0, -1, 4], [0, 1, 4]) * 1.5 * k, 1.7);
}
// from a picture: a camera with a 60° vertical fov, a square picture; a person 1.7 tall standing 5 ahead
{
  const [tx, ty] = M.tanXY(60, 1);
  near(tx, Math.tan(Math.PI / 6));
  const pts = [];
  // the person: a column of points 1.7 tall, centred, from y -0.85 (head, y down) to 0.85 (feet), at z 5
  for (let i = 0; i <= 40; i++) for (const x of [-0.1, 0, 0.1]) pts.push(x, -0.85 + 1.7 * i / 40, 5);
  // the wall behind them, at z 9, filling the picture
  for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) pts.push(i * 0.25, j * 0.25, 9);
  const P = new Float32Array(pts);
  const vOf = (y, z) => 0.5 + y / z / (2 * ty), uOf = (x, z) => 0.5 + x / z / (2 * tx);
  const box = [uOf(-0.2, 5), vOf(-0.85, 5), uOf(0.2, 5), vOf(0.85, 5)];
  const d = M.personDepth(P, box, tx, ty);
  near(d, 5);
  const { head, feet } = M.headFeet(box, d, tx, ty);
  nearV(head, [0, -0.85, 5], 1e-6); nearV(feet, [0, 0.85, 5], 1e-6);
  near(M.personFactor(head, feet, 1), 1);   // already 1.7 m
  near(M.personFactor(head, feet, 2, 1.7), 0.5);   // shown twice too big
  assert.equal(M.personDepth(new Float32Array(0), box, tx, ty), null);
  // the same points as a glTF mesh (y up, -z ahead) give the same once turned back
  const G = M.glToCam(M.glToCam(new Float32Array(P)));
  assert.deepEqual([...G.slice(0, 6)], [...P.slice(0, 6)]);
}
console.log('scale maths ok');
