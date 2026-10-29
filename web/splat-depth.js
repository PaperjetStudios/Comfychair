// ---------------------------------------------------------------------------
// Splats in a depth picture. A splat isn't a mesh, so the depth material (an override material) can't draw it: until
// now its box stood in, and a splat scene's depth video was a grey block. Here each splat is coloured by its own
// depth with the depth material's formula (near white, far black, inverse depth, the same 0.8 curve), as a Spark
// world modifier, drawn into a picture of their own and combined with the meshes' depth picture keeping the brighter
// (nearer) of the two at each pixel, so what is in front still hides what is behind. Near and far count sampled
// splat centres (splatDepths), since the measuring pass (rangeMat) can't draw splats.
//
//   depthLook(lib, mesh, on)          a SplatMesh drawn in depth (on) or in colour again
//   setSplatRange([near, far])        what setRange sets on the depth material, for the splats
//   renderDepth(renderer, scene, camera, spark)   the meshes (spark hidden), then the splats over them
//   splatDepths(meshes, camera)       view depths of sampled splat centres in view (for measuring near and far)
// ---------------------------------------------------------------------------
import * as THREE from './vendor/three.module.min.js';

export const SPLAT_LAYER = 7;   // (the second pass draws only this layer: the SparkRenderer)
// near and far are baked into the modifier (a dynoFloat uniform read 0 in a world modifier here), so a new range
// builds the meshes' modifiers again (only when it moves by more than 1 %: a shader compile each)
let RANGE = [0.5, 20], LIB = null;
const ON = new Set();   // the meshes drawn in depth

function modifier(dy, worldToView, [near, far]) {
  const f = (v) => dy.dynoConst('float', v);
  return dy.dynoBlock({ gsplat: dy.Gsplat }, { gsplat: dy.Gsplat }, ({ gsplat }) => {
    const { center } = dy.splitGsplat(gsplat).outputs;
    const { z } = dy.split(worldToView.apply(center)).outputs;
    const vz = dy.max(dy.neg(z), f(1e-3)), invFar = f(1 / far);
    const d = dy.div(dy.sub(dy.div(f(1), vz), invFar), f(1 / near - 1 / far));
    const g = dy.pow(dy.clamp(d, f(0), f(1)), f(0.8));
    return { gsplat: dy.combineGsplat({ gsplat, r: g, g, b: g }) };
  });
}

// -> true when it changed (Spark rebuilds the splats on its own time: the caller draws again a few times)
export function depthLook(lib, mesh, on) {
  const u = mesh.userData;
  if (!!u.depthOn === !!on) return false;
  mesh.layers.enable(SPLAT_LAYER);   // (Spark gathers the splats the camera's layers see: the second pass sees only this one)
  if (on) {
    LIB = lib;
    u.keep = { mod: mesh.worldModifier, w2v: mesh.enableWorldToView };
    mesh.enableWorldToView = true;
    mesh.worldModifier = modifier(lib.dyno, mesh.context.worldToView, RANGE);
  } else {
    mesh.worldModifier = u.keep?.mod; mesh.enableWorldToView = !!u.keep?.w2v;
  }
  u.depthOn = !!on;
  if (on) ON.add(mesh); else ON.delete(mesh);
  mesh.updateGenerator();
  return true;
}

export function setSplatRange([near, far]) {
  const close = (a, b) => Math.abs(a - b) <= 0.01 * Math.max(a, b);
  if (close(near, RANGE[0]) && close(far, RANGE[1])) return;
  RANGE = [near, far];
  for (const m of ON) {
    if (!m.parent) { ON.delete(m); continue; }   // (a removed layer's mesh is gone)
    m.worldModifier = modifier(LIB.dyno, m.context.worldToView, RANGE);
    m.updateGenerator();
  }
}

// the meshes' and the splats' depth pictures drawn apart, then combined in a shader keeping the brighter (nearer) at
// each pixel. Apart, overlapping splats build up as they do in colour (one by one, a see-through splat's grey is
// scaled by its opacity), and whichever is in front wins in the combining without a depth test between the two.
let MESH = null, SPL = null, QUAD = null;
const quad = () => QUAD ||= (() => {
  const mat = new THREE.ShaderMaterial({ uniforms: { a: { value: null }, b: { value: null } }, depthTest: false, depthWrite: false,
    blending: THREE.NoBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D a; uniform sampler2D b; varying vec2 vUv;'
      + ' void main() { gl_FragColor = vec4(max(texture2D(a, vUv).rgb, texture2D(b, vUv).rgb), 1.0); }' });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); m.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(m);
  return { sc, mat, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
})();
const sized = (rt, v, depth) => {
  if (!rt) return new THREE.WebGLRenderTarget(v.x, v.y, { depthBuffer: depth });
  if (rt.width !== v.x || rt.height !== v.y) rt.setSize(v.x, v.y);
  return rt;
};
export function renderDepth(renderer, scene, camera, spark) {
  if (!spark) { renderer.render(scene, camera); return; }
  const target = renderer.getRenderTarget(), v = new THREE.Vector2();
  if (target) v.set(target.width, target.height); else renderer.getDrawingBufferSize(v);
  MESH = sized(MESH, v, true); SPL = sized(SPL, v, false);
  const ac = renderer.autoClear, mask = camera.layers.mask, ov = scene.overrideMaterial, bg = scene.background;
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(MESH); renderer.render(scene, camera);   // (the meshes, spark hidden by the caller)
    spark.layers.enable(SPLAT_LAYER); spark.visible = true;
    camera.layers.set(SPLAT_LAYER); scene.overrideMaterial = null; scene.background = null;
    renderer.setRenderTarget(SPL); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.setRenderTarget(target);
    const q = quad(); q.mat.uniforms.a.value = MESH.texture; q.mat.uniforms.b.value = SPL.texture;
    renderer.render(q.sc, q.cam);
  } finally {
    renderer.setRenderTarget(target); renderer.setClearColor(cc, ca);
    renderer.autoClear = ac; camera.layers.mask = mask; scene.overrideMaterial = ov; scene.background = bg; spark.visible = false;
  }
}

// near and far need the splats too (rangeMat can't draw them): the view depths of up to 3000 of each mesh's splat
// centres that are in front of the camera and inside its view, per frame (the points are sampled once per mesh)
const _p = new THREE.Vector3();
export const splatMeshes = (groups) => [...groups].map((g) => g.visible && g.userData.splat?.mesh).filter(Boolean);
export function splatDepths(meshes, camera) {
  const out = [];
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse, proj = camera.projectionMatrix;
  for (const m of meshes) {
    if (!m?.packedSplats || !m.visible) continue;
    const u = m.userData;
    if (!u.depthPts) {
      const pts = [], n = m.packedSplats.numSplats || 0, every = Math.max(1, Math.floor(n / 3000));
      let i = 0;
      m.packedSplats.forEachSplat?.((j, c) => { if (i++ % every === 0) pts.push(c.x, c.y, c.z); });
      u.depthPts = pts;
    }
    m.updateMatrixWorld();
    const pts = u.depthPts;
    for (let k = 0; k < pts.length; k += 3) {
      _p.set(pts[k], pts[k + 1], pts[k + 2]).applyMatrix4(m.matrixWorld).applyMatrix4(view);
      const z = -_p.z;
      if (z <= 0.05) continue;
      _p.applyMatrix4(proj);
      if (Math.abs(_p.x) <= 1 && Math.abs(_p.y) <= 1) out.push(z);
    }
  }
  return out;
}
