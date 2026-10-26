// Motion tracking's sums, with no DOM (track.js is the panel; tests/track.test.mjs checks these).
// A track is the server's result (app/tracking.py): frames [{tx, ty, rot, scale}] from the first frame,
// in the clip's own pixels. Here it becomes a camera that moves the way the footage seems to have moved,
// and the backdrop card that keeps the footage on screen behind it.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const SCENE_FPS = 24;     // the 3D tab's frame rate (scene-data.js FPS)
export const BACKDROP_DIST = 30; // how far in front of the camera the footage card sits (it is drawn behind everything, so only its size matters)
export const CAM0 = { px: 0, py: 1.5, pz: 6 };   // where the tracked camera starts: looking down -Z, level, 6 m from the origin

// Gaussian smoothing of a list of numbers; sigma in frames (0 = none). The ends hold their value.
export function smooth(a, sigma) {
  if (!(sigma > 0.05) || a.length < 3) return a.slice();
  const r = Math.ceil(sigma * 3), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = k.reduce((x, y) => x + y, 0);
  return a.map((_, i) => k.reduce((s, w, j) => s + w * a[Math.min(a.length - 1, Math.max(0, i + j - r))], 0) / sum);
}

// vertical field of view (degrees) of a lens given as its 35mm-equivalent focal length, for a picture of this aspect
export const vfovFor = (lens, aspect) => 2 * Math.atan(Math.tan(Math.atan(18 / lens)) / aspect) * R2D;

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// the camera's axes (three.js lookAt, y up): right, up, back; rolled `roll` degrees (the scene camera's roll:
// positive banks the camera clockwise, so right and up turn about the view axis the other way)
export function basis(eye, target, roll = 0) {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  if (!roll) return { x, y, z };
  const c = Math.cos(roll * D2R), s = Math.sin(roll * D2R);
  return { x: x.map((v, i) => v * c - y[i] * s), y: y.map((v, i) => y[i] * c + x[i] * s), z };
}
// Euler XYZ in degrees (what a scene object's rx, ry, rz mean), as three.js Euler.setFromRotationMatrix
export function eulerOf({ x, y, z }) {
  const m13 = z[0], ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-z[1], z[2]) * R2D, ry * R2D, Math.atan2(-y[0], x[0]) * R2D];
  return [Math.atan2(y[2], y[1]) * R2D, ry * R2D, 0];
}

// One camera per frame of the clip, as the camera's values (px py pz tx ty tz fov roll).
//   pan  = -atan(tx / focal) (the picture slid right: the camera turned left), tilt = atan(ty / focal), with the
//   focal length of the zoomed picture,
//   zoom: scale > 1 is zoomed in. zoomAs 'fov': the lens narrows. 'dolly': the camera moves forward
//   along its view by dist * (1 - 1 / scale), as if the subject were dist metres away.
//   roll = -rot: footage that turns clockwise on screen is a camera that rolled anticlockwise (the camera's roll
//   is positive clockwise). Pan and tilt are not rotated by it.
export function cameraRows(track, { sigma = 2, lens = 35, zoomAs = 'fov', dist = 6 } = {}) {
  const [W, H] = track.size, fr = track.frames;
  const sm = (k) => smooth(fr.map((f) => f[k]), sigma);
  // (smoothing pulls the first frame off zero: the camera starts where the footage does)
  const rot = sm('rot').map((v, _, a) => v - a[0]), tx = sm('tx').map((v, _, a) => v - a[0]), ty = sm('ty').map((v, _, a) => v - a[0]), sc = sm('scale').map((v, _, a) => v / a[0]);
  const aspect = W / H, fov0 = vfovFor(lens, aspect);
  const focal = (H / 2) / Math.tan(fov0 * D2R / 2);   // in the clip's pixels (square pixels)
  return fr.map((_, i) => {
    const s = Math.max(0.2, sc[i]);
    // tx, ty are in the picture as it is by now (zoomed s times), so the angle they stand for uses the zoomed focal length
    const yaw = -Math.atan(tx[i] / (focal * s)), pitch = Math.atan(ty[i] / (focal * s));
    const fwd = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.cos(yaw)];
    const move = zoomAs === 'dolly' ? dist * (1 - 1 / s) : 0;
    const fov = zoomAs === 'fov' ? 2 * Math.atan(Math.tan(fov0 * D2R / 2) / s) * R2D : fov0;
    const eye = [CAM0.px + fwd[0] * move, CAM0.py + fwd[1] * move, CAM0.pz + fwd[2] * move];
    return { px: eye[0], py: eye[1], pz: eye[2], tx: eye[0] + fwd[0] * 10, ty: eye[1] + fwd[1] * 10, tz: eye[2] + fwd[2] * 10, fov, roll: -rot[i] };
  });
}

// the backdrop card's values for a camera: centred D ahead, facing back at it, just big enough to fill the picture
export function backdropAt(c, aspect, D = BACKDROP_DIST) {
  const eye = [c.px, c.py, c.pz], b = basis(eye, [c.tx, c.ty, c.tz], c.roll);
  const hh = 2 * D * Math.tan(c.fov * D2R / 2) * 1.002;
  const [rx, ry, rz] = eulerOf(b);
  return { x: eye[0] - b.z[0] * D, y: eye[1] - b.z[1] * D, z: eye[2] - b.z[2] * D, rx, ry, rz, sx: hh * aspect, sy: hh, sz: 1 };
}

// Keep only the frames that matter: a frame stays if dropping it would leave any channel further from the
// straight line between its neighbours than tol allows (Ramer-Douglas-Peucker, all channels at once).
// rows: [{ f, ...values }], tol: { name: allowed error }.
export function thin(rows, tol) {
  if (rows.length < 3) return rows.slice();
  const names = Object.keys(tol), keep = new Set([0, rows.length - 1]);
  const stack = [[0, rows.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (rows[i].f - rows[a].f) / (rows[b].f - rows[a].f);
      let e = 0;
      for (const n of names) e = Math.max(e, Math.abs(rows[i][n] - (rows[a][n] + (rows[b][n] - rows[a][n]) * t)) / tol[n]);
      if (e > worst) { worst = e; at = i; }
    }
    if (worst > 1) { keep.add(at); stack.push([a, at], [at, b]); }
  }
  return rows.filter((_, i) => keep.has(i));
}
const TOL = { px: 0.004, py: 0.004, pz: 0.004, tx: 0.01, ty: 0.01, tz: 0.01, fov: 0.04, roll: 0.05,
  bx: 0.03, by: 0.03, bz: 0.03, brx: 0.05, bry: 0.05, brz: 0.05, bsx: 0.03, bsy: 0.03 };
const BD = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];

// A new 3D scene's data from a track, as the 3D tab saves it (scene-data.js): the camera keyed from the
// track, linear between keys; a footage card (layer type 'backdrop', scene-track.js) that follows the camera
// so it always fills the picture, showing the clip's frame at each moment; optionally the tracked points
// placed in the scene (type 'trackpts') that stay put as the camera moves. Everything in the scene is
// a pure function of the camera, so keys are thinned together and the card and camera stay in step.
export function sceneFromTrack(track, opts = {}) {
  const { lens = 35, points = true, dist = 6, atlas = track.atlas, name = 'Footage' } = opts;
  const [W, H] = track.size, aspect = W / H, fps = track.fps || 24;
  const rows = cameraRows(track, opts);
  // the scene runs at 24 fps: resample the clip's frames onto it
  const n = Math.max(2, Math.round((rows.length - 1) * SCENE_FPS / fps) + 1);
  const at = (i) => {
    const p = Math.min(rows.length - 1, i * fps / SCENE_FPS), a = Math.floor(p), b = Math.min(rows.length - 1, a + 1), t = p - a;
    const o = {};
    for (const k of Object.keys(rows[a])) o[k] = rows[a][k] + (rows[b][k] - rows[a][k]) * t;
    return o;
  };
  const both = [];
  for (let f = 0; f < n; f++) {
    const c = at(f), b = backdropAt(c, aspect);
    both.push({ f, ...c, ...Object.fromEntries(BD.map((k) => ['b' + k, b[k]])) });
  }
  const kept = thin(both, TOL);
  const camKeys = kept.map((r) => ({ f: r.f, px: r.px, py: r.py, pz: r.pz, tx: r.tx, ty: r.ty, tz: r.tz, fov: r.fov, roll: r.roll }));
  const bdKeys = kept.map((r) => ({ f: r.f, ...Object.fromEntries(BD.map((k) => [k, r['b' + k]])) }));
  const mx = Math.max(W, H), sc = 768 / mx;
  const width = Math.max(64, Math.round(W * sc / 16) * 16), height = Math.max(64, Math.round(H * sc / 16) * 16);
  const seconds = Math.max(0.25, n / SCENE_FPS);
  const objects = [];
  const first = both[0], zero = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  if (atlas) objects.push({ id: 'bd0track', type: 'backdrop', name, ease: 'linear', hidden: false, mute: false,
    keys: bdKeys, base: { ...zero, ...Object.fromEntries(BD.map((k) => [k, first['b' + k]])) },
    url: atlas.url, cols: atlas.cols, rows: atlas.rows, count: atlas.count, step: atlas.step, clipFps: fps });
  if (points && track.tracks?.length) {
    const pts = trackPoints(track, rows, aspect, dist);
    if (pts.length) objects.push({ id: 'pt0track', type: 'trackpts', name: 'Tracked points', ease: 'smooth', hidden: false, mute: false, keys: [], base: zero, pts });
  }
  return {
    v: 1, width, height, seconds, blur: 2, room: { w: 8, d: 8, h: 2.8, walls: false, ceiling: false, hidden: true },
    camera: { base: { ...camKeys[0] }, keys: camKeys, ease: 'linear' }, objects,
  };
}

// each shown track's first point, put on the ray it was seen along at its first frame, `dist` from that camera: a point
// fixed in the scene (any depth looks right for a camera that only turns, so this is the plain choice)
export function trackPoints(track, rows, aspect, dist) {
  const out = [];
  for (const t of track.tracks.slice(0, 40)) {
    const c = rows[Math.min(rows.length - 1, t.f)];
    const b = basis([c.px, c.py, c.pz], [c.tx, c.ty, c.tz], c.roll), tv = Math.tan(c.fov * D2R / 2), th = tv * aspect;
    const [nx, ny] = t.p[0], u = (nx * 2 - 1) * th, v = (1 - ny * 2) * tv;
    const d = norm([-b.z[0] + b.x[0] * u + b.y[0] * v, -b.z[1] + b.x[1] * u + b.y[1] * v, -b.z[2] + b.x[2] * u + b.y[2] * v]);
    // distance along the camera's axis is dist, so scale the ray by dist / cos
    const cos = -(d[0] * b.z[0] + d[1] * b.z[1] + d[2] * b.z[2]);
    out.push([c.px + d[0] * dist / cos, c.py + d[1] * dist / cos, c.pz + d[2] * dist / cos].map((x) => Math.round(x * 1000) / 1000));
  }
  return out;
}
