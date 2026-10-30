// Re-skinning: when a skinned model's bones change (one added, one deleted), the mesh's weights and bind
// matrices have to be made again. This is the simple version: every vertex takes the nearest few bones
// (by distance to the bone's own point, 1/d^4 falloff, four at most), enough to keep a crudely edited
// skeleton moving the mesh sensibly. Pure three.js, no DOM — tests/reskin.test.mjs runs it.
import * as THREE from './vendor/three.module.min.js';

const V = new THREE.Vector3();

// the weights for one geometry: { idx: Uint16Array (4 per vertex), w: Float32Array (4 per vertex) }
export function weightsFor(geometry, matrixWorld, bones, { max = 4, power = 4, eps = 1e-5 } = {}) {
  const pos = geometry.attributes.position;
  const n = pos.count, k = Math.min(max, bones.length);
  const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
  const head = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
  const dist = new Float32Array(bones.length);
  const order = new Array(bones.length).fill(0).map((_, i) => i);
  for (let i = 0; i < n; i++) {
    V.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
    for (let j = 0; j < bones.length; j++) dist[j] = V.distanceToSquared(head[j]);
    order.sort((a, b) => dist[a] - dist[b]);
    let sum = 0;
    const ws = [];
    for (let j = 0; j < k; j++) {
      const b = order[j], wj = 1 / Math.pow(dist[b] + eps, power / 2);
      ws.push([b, wj]);
      sum += wj;
    }
    for (let s = 0; s < 4; s++) {
      if (s < ws.length) { idx[i * 4 + s] = ws[s][0]; w[i * 4 + s] = ws[s][1] / sum; }
      else { idx[i * 4 + s] = 0; w[i * 4 + s] = 0; }
    }
  }
  return { idx, w };
}

// the skeleton as the bones stand now (their bind pose is their current world matrix)
export function skeletonFrom(bones) {
  const inv = bones.map((b) => {
    b.updateWorldMatrix(true, false);
    return new THREE.Matrix4().copy(b.matrixWorld).invert();
  });
  return new THREE.Skeleton(bones, inv);
}

// rewrite one skinned mesh's weights and bind it to the new bones (its geometry is shared with any copy).
// The bones must stand in the pose the geometry was modelled in (the bind/rest pose), not a posed frame.
export function reskinMesh(mesh, bones, opts = {}, skeleton = null) {
  if (!mesh.isSkinnedMesh || !bones?.length) return null;
  mesh.updateWorldMatrix(true, false);
  const { idx, w } = weightsFor(mesh.geometry, mesh.matrixWorld, bones, opts);
  mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  skeleton ||= skeletonFrom(bones);
  mesh.bind(skeleton, mesh.matrixWorld.clone());
  return skeleton;
}

// every skinned mesh in a layer bound to one new skeleton of these bones; the old skeletons are freed
// (their bone textures). Returns how many were re-skinned.
export function reskinAll(skinned, bones, opts = {}) {
  if (!bones?.length) return 0;
  const skeleton = skeletonFrom(bones), old = new Set();
  let n = 0;
  for (const m of skinned || []) {
    const was = m.skeleton;
    if (reskinMesh(m, bones, opts, skeleton)) { n++; if (was) old.add(was); }
  }
  for (const s of old) if (s !== skeleton) s.dispose();
  return n;
}

// a loaded model's GPU side freed: its geometries, materials, their textures and its skeletons
export function disposeTree(root) {
  const seen = new Set();
  const once = (x) => { if (x?.dispose && !seen.has(x)) { seen.add(x); x.dispose(); } };
  root?.traverse((c) => {
    once(c.geometry);
    for (const m of [].concat(c.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) once(v);
      once(m);
    }
    if (c.isSkinnedMesh) once(c.skeleton);
  });
}

// the bones in parents-before-children order, from the ones that have no bone parent
export function boneOrder(bones) {
  const out = [];
  const walk = (b) => { out.push(b); for (const c of b.children) if (c.isBone) walk(c); };
  for (const b of bones) if (!b.parent || !b.parent.isBone) walk(b);
  return out;
}
