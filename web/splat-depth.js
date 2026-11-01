// ---------------------------------------------------------------------------
// Splats in a depth picture. A depth picture can't wait for Spark (it rebuilds and sorts its splats on its own time, so a
// render's frames came out in the wrong colours, then black), so here each splat's centre is drawn as a round dot of its
// own size, opaque and depth-tested, with the depth material's formula (near white, far black, inverse depth, the same
// 0.8 curve): the picture is right the moment it is drawn. The dots are then blurred with their coverage (gaps closed,
// lone floaters gone, the outline about where it was), and combined with the meshes' depth keeping the brighter (nearer)
// at each pixel, so what is in front still hides what is behind. Near and far count sampled splat centres
// (splatDepths), since the measuring pass (rangeMat) can't draw splats.
//
//   setSplatRange([near, far])        what setRange sets on the depth material, for the splats
//   splatBlurOf(sc)                   the scene's Splat blur as the share of the picture's height renderDepth takes
//   renderDepth(renderer, scene, camera, spark, blur)   the meshes (spark hidden), then the splats over them
//   splatDepths(meshes, camera)       view depths of sampled splat centres in view (for measuring near and far)
//   cloudArrays(splats) / blurTaps()  the dots' data and the blur's samples (tested by tests/splat_depth.test.mjs)
// ---------------------------------------------------------------------------
import * as THREE from './vendor/three.module.min.js';

export const SPLAT_LAYER = 7;   // (the second pass draws only this layer: the dots)
export const SPLAT_BLUR = 3;    // px at the scene's size, until the scene says otherwise
const MIN_OPACITY = 0.2;        // fainter than this is haze: it mustn't stand in front as a solid dot
const REACH = 1.5;              // a dot's radius, in its Gaussian's sigmas
const U = { near: { value: 0.5 }, far: { value: 20 }, h: { value: 448 } };   // shared by every cloud

export const setSplatRange = ([near, far]) => { U.near.value = near; U.far.value = far; };
export const splatBlurOf = (sc) => (sc.splatBlur ?? SPLAT_BLUR) / (sc.height || 448);

// a splat's dot size: its middle axis (a flat disc keeps its width, a needle doesn't become a ball)
const middle = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
// the centres and sizes of a splat set's visible splats
export function cloudArrays(splats) {
  const n = splats.numSplats || 0, pos = new Float32Array(n * 3), size = new Float32Array(n);
  let k = 0;
  splats.forEachSplat((i, c, s, q, opacity) => {
    if (opacity < MIN_OPACITY) return;
    pos[k * 3] = c.x; pos[k * 3 + 1] = c.y; pos[k * 3 + 2] = c.z;
    size[k++] = middle(s.x, s.y, s.z);
  });
  return { pos: pos.subarray(0, k * 3), size: size.subarray(0, k) };
}

const DOT_VERT = `attribute float aSize; uniform float h, grow, r, cut; uniform vec3 c; varying float vz;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vz = -mv.z;
  gl_Position = projectionMatrix * mv;
  float across = 2.0 * ${REACH.toFixed(1)} * aSize * grow * length(modelViewMatrix[0].xyz);
  gl_PointSize = clamp(across * projectionMatrix[1][1] * h * 0.5 / max(vz, 1e-3), h / 180.0, h / 8.0);
  if (distance(position, c) > r || length(position) < cut) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // (trimmed: splat-shape.js)
}`;
const DOT_FRAG = `uniform float near; uniform float far; varying float vz;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  if (dot(q, q) > 0.25) discard;
  float d = (1.0 / max(vz, 1e-3) - 1.0 / far) / (1.0 / near - 1.0 / far);
  gl_FragColor = vec4(vec3(pow(clamp(d, 0.0, 1.0), 0.8)), 1.0);
}`;
// a SplatMesh's dots, made the first time a depth picture needs them, kept in its own space and gone with it
function cloudOf(mesh) {
  if (mesh.userData.depthCloud) return mesh.userData.depthCloud;
  const { pos, size } = cloudArrays(mesh.packedSplats), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({ vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, blending: THREE.NoBlending,
    uniforms: { ...U, grow: { value: 1 }, c: { value: new THREE.Vector3() }, r: { value: 1e9 }, cut: { value: 0 } } });
  const cloud = new THREE.Points(g, m);
  cloud.frustumCulled = false; cloud.raycast = () => {}; cloud.layers.set(SPLAT_LAYER);
  mesh.add(cloud);
  const free = mesh.dispose.bind(mesh);
  mesh.dispose = () => { g.dispose(); m.dispose(); free(); };
  return (mesh.userData.depthCloud = cloud);
}
function readyClouds(scene) {
  scene.traverseVisible((o) => {
    if (!o.packedSplats?.numSplats) return;
    const u = cloudOf(o).material.uniforms, s = o.userData.shape?.now?.();
    if (s) { u.grow.value = s.grow; u.c.value.set(...s.c); u.r.value = s.r; u.cut.value = s.near; }
  });
}

// the blur's samples: [how many sigmas out, weight], the weights adding up to 1
export function blurTaps(n = 8, reach = 8 / 3) {
  const taps = [];
  for (let i = -n; i <= n; i++) { const t = (i / n) * reach; taps.push([t, Math.exp(-t * t / 2)]); }
  const sum = taps.reduce((a, [, w]) => a + w, 0);
  return taps.map(([t, w]) => [t, w / sum]);
}
const screen = (uniforms, frag) => {
  const mat = new THREE.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: frag });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); m.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(m);
  return { sc, mat };
};
const CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
let PASSES = null;
const passes = () => PASSES ||= {
  // the dots and their coverage together (alpha 1 where drawn, 0 where not), so an empty pixel adds no depth
  blur: screen({ t: { value: null }, step: { value: new THREE.Vector2() } }, `uniform sampler2D t; uniform vec2 step; varying vec2 vUv;
    void main() { vec4 s = vec4(0.0); ${blurTaps().map(([o, w]) => `s += ${w.toFixed(6)} * texture2D(t, vUv + step * ${o.toFixed(4)});`).join(' ')} gl_FragColor = s; }`),
  // the depth is the blurred depth over the blurred coverage; where little was drawn there is nothing
  join: screen({ a: { value: null }, b: { value: null } }, `uniform sampler2D a; uniform sampler2D b; varying vec2 vUv;
    void main() { vec4 s = texture2D(b, vUv);
      float v = s.a > 0.0 ? smoothstep(0.12, 0.28, s.a) * s.r / s.a : 0.0;
      gl_FragColor = vec4(max(texture2D(a, vUv).rgb, vec3(v)), 1.0); }`),
};
let MESH = null, SPL = null, B1 = null, B2 = null;
const sized = (rt, v, depth) => {
  if (!rt) return new THREE.WebGLRenderTarget(v.x, v.y, { depthBuffer: depth });
  if (rt.width !== v.x || rt.height !== v.y) rt.setSize(v.x, v.y);
  return rt;
};
// spark: whether there are splats. blur: the Gaussian's sigma as a share of the picture's height (0: the bare dots)
export function renderDepth(renderer, scene, camera, spark, blur = 0) {
  if (!spark) { renderer.render(scene, camera); return; }
  const target = renderer.getRenderTarget(), v = new THREE.Vector2();
  if (target) v.set(target.width, target.height); else renderer.getDrawingBufferSize(v);
  MESH = sized(MESH, v, true); SPL = sized(SPL, v, true); B1 = sized(B1, v, false); B2 = sized(B2, v, false);
  const ac = renderer.autoClear, mask = camera.layers.mask, ov = scene.overrideMaterial, bg = scene.background;
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), P = passes();
  try {
    renderer.setRenderTarget(MESH); renderer.render(scene, camera);   // (the meshes, spark hidden by the caller)
    readyClouds(scene); U.h.value = v.y;
    camera.layers.set(SPLAT_LAYER); scene.overrideMaterial = null; scene.background = null;
    renderer.setRenderTarget(SPL); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.autoClear = false;
    renderer.render(scene, camera);
    let dots = SPL.texture;
    const sigma = blur * v.y;
    if (sigma >= 0.25) {
      const b = P.blur.mat.uniforms;
      b.t.value = SPL.texture; b.step.value.set(sigma / v.x, 0);
      renderer.setRenderTarget(B1); renderer.render(P.blur.sc, CAM);
      b.t.value = B1.texture; b.step.value.set(0, sigma / v.y);
      renderer.setRenderTarget(B2); renderer.render(P.blur.sc, CAM);
      dots = B2.texture;
    }
    renderer.setRenderTarget(target);
    P.join.mat.uniforms.a.value = MESH.texture; P.join.mat.uniforms.b.value = dots;
    renderer.render(P.join.sc, CAM);
  } finally {
    renderer.setRenderTarget(target); renderer.setClearColor(cc, ca);
    renderer.autoClear = ac; camera.layers.mask = mask; scene.overrideMaterial = ov; scene.background = bg;
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
