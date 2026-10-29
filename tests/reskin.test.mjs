// node tests/reskin.test.mjs — weights and re-binding after a skeleton changes
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
import * as R from '../web/reskin.js';

const root = new THREE.Bone(); root.name = 'root';
const b1 = new THREE.Bone(); b1.name = 'b1'; b1.position.set(0, 1, 0);
root.add(b1);
root.updateMatrixWorld(true);

const geo = new THREE.BufferGeometry();
// two vertices: one at the root's point, one at b1's
geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3));
const { idx, w } = R.weightsFor(geo, new THREE.Matrix4(), [root, b1]);
assert.equal(idx.length, 8);
for (let i = 0; i < 2; i++) {
  const sum = w[i * 4] + w[i * 4 + 1] + w[i * 4 + 2] + w[i * 4 + 3];
  assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${i} weights sum to ${sum}`);
}
assert.equal(idx[0], 0, 'the vertex at the root belongs to the root');
assert.ok(w[0] > 0.9, `root weight ${w[0]}`);
assert.equal(idx[4], 1, 'the vertex at b1 belongs to b1');
assert.ok(w[4] > 0.9, `b1 weight ${w[4]}`);

// a mesh re-skinned to a new bone list gets 4-per-vertex attributes and a bind to it
const meshGeo = new THREE.BufferGeometry();
meshGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0.5, 0], 3));
meshGeo.setIndex([0, 1, 2]);
const mesh = new THREE.SkinnedMesh(meshGeo, new THREE.MeshBasicMaterial());
const b2 = new THREE.Bone(); b2.name = 'b2'; b2.position.set(0, 0.5, 0); root.add(b2);
mesh.bind(new THREE.Skeleton([root, b1]), mesh.matrixWorld);
root.updateMatrixWorld(true);
const skel = R.reskinMesh(mesh, [root, b1, b2]);
assert.ok(skel instanceof THREE.Skeleton);
assert.equal(skel.bones.length, 3);
assert.equal(mesh.geometry.attributes.skinIndex.count, 3);
assert.equal(mesh.geometry.attributes.skinWeight.itemSize, 4);
assert.equal(mesh.geometry.attributes.skinIndex.itemSize, 4);
// the new middle bone takes the middle vertex (component per influence on that vertex)
const wMid = mesh.geometry.attributes.skinWeight, iMid = mesh.geometry.attributes.skinIndex;
const comps = [wMid.getX(2), wMid.getY(2), wMid.getZ(2), wMid.getW(2)];
const ids = [iMid.getX(2), iMid.getY(2), iMid.getZ(2), iMid.getW(2)];
const best = ids[comps.indexOf(Math.max(...comps))];
assert.equal(best, 2, `the middle vertex goes to the middle bone (${ids} @ ${comps.map((x) => +x.toFixed(2))})`);

assert.deepEqual(R.boneOrder([b1, b2, root]).map((b) => b.name), ['root', 'b1', 'b2']);
assert.equal(R.boneOrder([]).length, 0);
assert.equal(R.reskinAll([], [root]), 0);
console.log('reskin ok');
