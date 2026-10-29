// node tests/ik.test.mjs — the CCD solver on a synthetic bone chain
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
import * as IK from '../web/ik.js';

// a straight chain root → a → b → end, each bone 0.4 m above its parent
const root = new THREE.Bone(); root.name = 'root';
const a = new THREE.Bone(); a.name = 'a'; a.position.set(0, 0.4, 0);
const b = new THREE.Bone(); b.name = 'b'; b.position.set(0, 0.4, 0);
const end = new THREE.Bone(); end.name = 'end'; end.position.set(0, 0.4, 0);
root.add(a); a.add(b); b.add(end);
root.updateMatrixWorld(true);
const chain = [root, a, b, end];
const gap = () => {
  const out = [];
  for (let i = 1; i < chain.length; i++) {
    const p = chain[i - 1].getWorldPosition(new THREE.Vector3()), q = chain[i].getWorldPosition(new THREE.Vector3());
    out.push(+p.distanceTo(q).toFixed(6));
  }
  return out;
};
assert.deepEqual(gap(), [0.4, 0.4, 0.4]);
assert.ok(Math.abs(IK.error(chain, new THREE.Vector3(0, 1.2, 0))) < 1e-6);

const target = new THREE.Vector3(0.7, 0.3, 0.2);
const r = IK.reach(chain, target, { iterations: 20 });
assert.ok(r.distance < 0.01, `reached within ${r.distance}`);
assert.ok(r.iterations > 0 && r.iterations <= 20);
assert.deepEqual(gap(), [0.4, 0.4, 0.4], 'turns only: every bone keeps its length');
assert.equal(r.bones.length, 4);
assert.deepEqual(r.bones.find((x) => x.name === 'end').q, end.quaternion.toArray());

// out of reach: it points at the target and says how far it still is
const far = new THREE.Vector3(10, 0, 0);
const r2 = IK.reach(chain, far, { iterations: 10 });
assert.ok(r2.distance > 8 && r2.distance < 9, `far distance ${r2.distance}`);

// chainTo walks up from the end bone to the root
assert.deepEqual(IK.chainTo(chain, 'b').map((x) => x.name), ['root', 'a', 'b']);
assert.deepEqual(IK.chainTo(chain, 'nope'), []);
assert.deepEqual(IK.reach([root], target), { bones: [], distance: Infinity, iterations: 0 });
console.log('ik ok');
