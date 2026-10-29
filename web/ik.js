// CCD (cyclic coordinate descent) over a chain of bones: turn them so the last bone's head reaches a world
// target, leaving the chain as close to its pose as it can. Pure: three.js objects, no DOM. scene-skin.js
// uses it for a skinned model's end bones (a hand, a foot); the turns it returns are what gets keyed.
import * as THREE from './vendor/three.module.min.js';

const P = new THREE.Vector3(), E = new THREE.Vector3(), FROM = new THREE.Vector3(), TO = new THREE.Vector3();
const Q = new THREE.Quaternion(), WQ = new THREE.Quaternion(), PQ = new THREE.Quaternion();

// bones: root → end (each one a child of the one before, or at least under it). target: THREE.Vector3 in world
// space. Returns { bones: [{ name, q: [x,y,z,w] }], distance, iterations } — the local turns to key, how far
// the end still is (metres) and how many passes it took.
export function reach(bones, target, { iterations = 12, tolerance = 0.004, min = 1e-8 } = {}) {
  if (!bones || bones.length < 2) return { bones: [], distance: Infinity, iterations: 0 };
  const end = bones[bones.length - 1];
  let done = 0;
  for (let it = 0; it < iterations; it++) {
    done = it + 1;
    for (let i = bones.length - 2; i >= 0; i--) {
      const b = bones[i];
      b.updateWorldMatrix(true, false);
      b.getWorldPosition(P);
      end.getWorldPosition(E);
      FROM.copy(E).sub(P);
      TO.copy(target).sub(P);
      if (FROM.lengthSq() < min || TO.lengthSq() < min) continue;
      Q.setFromUnitVectors(FROM.normalize(), TO.normalize());
      b.getWorldQuaternion(WQ).premultiply(Q);   // the bone's new world turn
      if (b.parent) {
        b.parent.getWorldQuaternion(PQ).invert();
        b.quaternion.copy(PQ.multiply(WQ));      // ...as a local one
      } else b.quaternion.copy(WQ);
      b.updateWorldMatrix(false, true);
    }
    end.getWorldPosition(E);
    if (E.distanceTo(target) <= tolerance) break;
  }
  end.getWorldPosition(E);
  return { bones: bones.map((b) => ({ name: b.name, q: b.quaternion.toArray() })), distance: E.distanceTo(target), iterations: done };
}

// the end's distance from target as a chain stands now (to undo a reach, compare before/after)
export const error = (bones, target) => {
  if (!bones?.length) return Infinity;
  const end = bones[bones.length - 1];
  end.updateWorldMatrix(true, false);
  return end.getWorldPosition(E).distanceTo(target);
};

// a bone's children up to `endName` as a chain (root first), or [] when it isn't below it
export function chainTo(bones, endName) {
  const end = bones.find((b) => b.name === endName);
  if (!end) return [];
  const out = [];
  for (let b = end; b; b = b.parent) {
    if (!b.isBone) break;
    out.unshift(b);
  }
  return out;
}
