// Real-world size in the 3D tab (scene units are metres): the maths behind the size readout, the measure tool, the
// person calibration of a photo's mesh or splat and the import's units. No three.js and no DOM, so node tests it
// (tests/scale_math.test.mjs).

// what a model file's unit says about metres: glTF is in metres; FBX says its unit in centimetres (UnitScaleFactor,
// 1 = cm, 100 = m); OBJ and splats don't say. null: unknown.
export function unitToMetres(ext, fbxUnit = null) {
  if (ext === 'glb' || ext === 'gltf') return 1;
  if (ext === 'fbx') return Number.isFinite(+fbxUnit) && +fbxUnit > 0 ? +fbxUnit / 100 : null;
  return null;
}
// sizes outside this (metres, the largest side) are taken as a unit mistake
export const SANE = [0.05, 50];
// How an import comes in: { fit, ask }. A known unit at a sane size comes in at true size (fit: the unit's factor);
// an unknown unit or an absurd size asks how tall it is (fit: the old "usable size", used if that is dismissed).
export function importFit(ext, size, fbxUnit = null, usable = 2) {
  const m = unitToMetres(ext, fbxUnit), big = Math.max(size[0], size[1], size[2]) || 1;
  const old = big > 12 || big < 0.3 ? +(usable / big).toPrecision(3) || 1 : 1;
  if (m == null) return { fit: old, ask: true };
  const s = big * m;
  if (s < SANE[0] || s > SANE[1]) return { fit: old, ask: true };
  return { fit: +m.toPrecision(6), ask: false };
}
// the even scale that makes a thing `height` metres tall, from its height in its file's units
export const fitForHeight = (fileHeight, height) => +(height / Math.max(1e-9, fileHeight)).toPrecision(4);

// the size of a box [x0, y0, z0, x1, y1, z1] once scaled (s: a number or [sx, sy, sz]) and turned ry degrees about
// the vertical: the world box's [width (x), height (y), depth (z)]
export function boxSize(box, s = 1, ry = 0) {
  const [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
  const w = Math.abs(box[3] - box[0]) * sx, h = Math.abs(box[4] - box[1]) * sy, d = Math.abs(box[5] - box[2]) * sz;
  const a = ry * Math.PI / 180, c = Math.abs(Math.cos(a)), n = Math.abs(Math.sin(a));
  return [w * c + d * n, h, w * n + d * c];
}
// "1.75 × 0.45 × 0.28 m" (height × width × depth); cm under a metre
export function fmtLen(m) {
  if (!Number.isFinite(m)) return '–';
  const a = Math.abs(m);
  if (a < 1) return `${+(m * 100).toPrecision(a < 0.1 ? 2 : 3)} cm`;
  return `${+m.toFixed(a < 10 ? 2 : a < 100 ? 1 : 0)} m`;
}
export const fmtHWD = ([w, h, d]) => `${fmtLen(h)} × ${fmtLen(w)} × ${fmtLen(d)}`;

// ---- rescaling about a point ----
// A thing at pos scaled by k about a world point (its base, kept still): where it goes
export const rescaleAbout = (pos, base, k) => pos.map((v, i) => base[i] + (v - base[i]) * k);
// the base of a world box { min: [x, y, z], max }: the middle of its floor
export const baseOf = (min, max) => [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
// the factor that makes a measured distance the real one
export const factorFor = (measured, real) => (measured > 1e-9 && real > 0 ? real / measured : 1);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// New values for an object scaled by k about its base: { x, y, z, sx, sy, sz } (the turn stays)
export function scaledVals(v, base, k) {
  const [x, y, z] = rescaleAbout([v.x, v.y, v.z], base, k);
  return { x, y, z, sx: v.sx * k, sy: v.sy * k, sz: v.sz * k };
}

// ---- calibrating from a person in the photo ----
// Points are in the photo camera's space: x right, y down, z forward (the camera at 0). box: the person in the
// picture [x0, y0, x1, y1] as fractions; tanX, tanY: tan of half the field of view across and up.
// How far the person is: of the points that land in the middle strip of their box (most of it is them, not what is
// behind), a low quantile of the depths (they are in front of what shows around them). null: too few points.
export function personDepth(pts, box, tanX, tanY, q = 0.3) {
  const [x0, y0, x1, y1] = box, w = x1 - x0;
  const u0 = x0 + w * 0.3, u1 = x1 - w * 0.3, v0 = y0 + (y1 - y0) * 0.1, v1 = y1 - (y1 - y0) * 0.1;
  const zs = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const z = pts[i + 2];
    if (!(z > 1e-6)) continue;
    const u = 0.5 + pts[i] / z / (2 * tanX), v = 0.5 + pts[i + 1] / z / (2 * tanY);
    if (u >= u0 && u <= u1 && v >= v0 && v <= v1) zs.push(z);
  }
  if (zs.length < 8) return null;
  zs.sort((a, b) => a - b);
  return zs[Math.min(zs.length - 1, Math.floor(zs.length * q))];
}
// the top and bottom of the box's middle, at that depth: the head and the feet (camera space)
export function headFeet(box, depth, tanX, tanY) {
  const u = (box[0] + box[2]) / 2, at = (v) => [(u - 0.5) * 2 * tanX * depth, (v - 0.5) * 2 * tanY * depth, depth];
  return { head: at(box[1]), feet: at(box[3]) };
}
// the factor that makes the person (head and feet in the layer's own units, shown at scale s) `height` metres tall
export const personFactor = (head, feet, s, height = 1.7) => factorFor(dist(head, feet) * s, height);
// glTF camera space (y up, looking down -z) to the photo camera's (y down, z forward), in place
export function glToCam(pts) {
  for (let i = 0; i + 2 < pts.length; i += 3) { pts[i + 1] = -pts[i + 1]; pts[i + 2] = -pts[i + 2]; }
  return pts;
}
// tan of half the field of view across, from the vertical fov (degrees) and the picture's width / height
export const tanXY = (fovY, aspect) => { const t = Math.tan(fovY * Math.PI / 360); return [t * aspect, t]; };

// presets for "what is it really": [label, metres]
export const LENGTHS = [['Person', 1.7], ['Door', 2.0], ['Table', 0.75], ['Car', 4.5]];
export const HEIGHTS = [['Mug', 0.1], ['Chair', 0.9], ['Table', 0.75], ['Person', 1.7], ['Door', 2.0], ['Car', 1.5], ['Tree', 6], ['House', 8]];
