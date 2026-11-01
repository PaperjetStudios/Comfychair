// Re-skinning: when a skinned model's bones change (one added, one deleted), the mesh's weights and bind
// matrices have to be made again. This is the simple version: every vertex takes the nearest few bones
// (by distance to the bone's own point, 1/d^4 falloff, four at most), enough to keep a crudely edited
// skeleton moving the mesh sensibly. Pure three.js, no DOM — tests/reskin.test.mjs runs it.
import * as THREE from './vendor/three.module.min.js';
import { toCreasedNormals } from './vendor/BufferGeometryUtils.js';

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

// Is this geometry faceted? Auto-riggers write a normal per face (UniRig builds its mesh with no smoothing at all), so a smooth
// model comes back in facets. True when there are no normals, or (nearly) every corner's normal is its face's own.
export function isFaceted(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, idx = geo.index;
  if (!pos) return false;
  if (!nor) return true;
  const n = (idx ? idx.count : pos.count) - ((idx ? idx.count : pos.count) % 3);
  const at = (i) => (idx ? idx.getX(i) : i), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), f = new THREE.Vector3(), v = new THREE.Vector3();
  let same = 0, all = 0;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, at(i)); b.fromBufferAttribute(pos, at(i + 1)); c.fromBufferAttribute(pos, at(i + 2));
    f.subVectors(c, b).cross(v.subVectors(a, b));
    if (f.lengthSq() < 1e-24) continue;
    f.normalize();
    for (let k = 0; k < 3; k++) { all++; if (v.fromBufferAttribute(nor, at(i + k)).normalize().dot(f) > 0.999) same++; }
  }
  return all > 0 && same / all > 0.98;
}

// A loaded model's faceted meshes given smooth normals, kept sharp where faces meet at more than creaseAngle (a real edge).
// Normals a file authored stay as they are. Skin weights and UVs are kept. Returns how many meshes changed.
export function smoothFaceted(root, creaseAngle = Math.PI / 3) {
  let n = 0;
  root?.traverse((c) => {
    if (!c.isMesh || !isFaceted(c.geometry)) return;
    const was = c.geometry, made = toCreasedNormals(was, creaseAngle);
    if (made !== was) was.dispose();
    c.geometry = made;
    for (const m of [].concat(c.material || [])) if (m.flatShading) { m.flatShading = false; m.needsUpdate = true; }
    n++;
  });
  return n;
}

// the bones in parents-before-children order, from the ones that have no bone parent
export function boneOrder(bones) {
  const out = [];
  const walk = (b) => { out.push(b); for (const c of b.children) if (c.isBone) walk(c); };
  for (const b of bones) if (!b.parent || !b.parent.isBone) walk(b);
  return out;
}
