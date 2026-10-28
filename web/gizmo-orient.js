// The 3D gizmo's axes (World / Local / View) and its pivot, as plain maths: no three.js, no DOM, so node can test it
// (tests/gizmo_orient.test.mjs). Quaternions are [x, y, z, w], vectors [x, y, z].
//
// How the View axes work: TransformControls only knows world and local axes, so the gizmo holds a stand-in (the
// "handle") at the pivot whose own turn is the camera's, in local space. The real thing (an object, or the shot camera)
// keeps its turn relative to the handle (rel = handle⁻¹ · thing, taken when the handle is placed), and each change it
// is put back as thing = handle · rel, with its pivot (a point in its own space) staying under the handle. Turning
// the handle about its local X / Y / Z is then turning the thing about the screen's right / up / toward-you axes.

// [key, label, icon name] in the order the toolbar button (and Q) cycles them
export const ORIENTS = [['world', 'World', 'axes-world'], ['local', 'Local', 'axes-local'], ['view', 'View', 'axes-view']];
export const orientOf = (k) => (ORIENTS.some(([x]) => x === k) ? k : 'world');
export const nextOrient = (k) => ORIENTS[(ORIENTS.findIndex(([x]) => x === orientOf(k)) + 1) % ORIENTS.length][0];

// TransformControls' space for an orientation: View is the handle's own (local) axes, turned like the camera
export const spaceOf = (orient) => (orientOf(orient) === 'world' ? 'world' : 'local');

// the handle's turn: the camera's in View (Move, Rotate), else the thing's own. Scale stays on the thing's own axes in
// every orientation: stretching a turned box along a screen axis would shear it, which a box (or a figure) can't keep.
export const frameQuat = (orient, mode, thingQ, camQ) => (orientOf(orient) === 'view' && mode !== 'scale' ? [...camQ] : [...thingQ]);

// ---- quaternion helpers ----
export const qMul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz];
export const qInv = ([x, y, z, w]) => { const n = x * x + y * y + z * z + w * w || 1; return [-x / n, -y / n, -z / n, w / n]; };
export function qRot([x, y, z, w], [vx, vy, vz]) {   // v turned by q
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}

// the thing's turn relative to the handle's
export const relQuat = (handleQ, thingQ) => qMul(qInv(handleQ), thingQ);

// where the thing goes when the handle is at (hp, hq): turned by hq · rel, scaled by s, with its pivot (at, in its own
// unscaled space) on the handle
export function follow(hp, hq, rel, at, s = [1, 1, 1]) {
  const q = qMul(hq, rel), off = qRot(q, [at[0] * s[0], at[1] * s[1], at[2] * s[2]]);
  return { p: [hp[0] - off[0], hp[1] - off[1], hp[2] - off[2]], q };
}

// grid snapping in Local and View: the move from where the drag started, in whole grid steps along the handle's axes
// (the axes it was turned to when the drag started). World keeps TransformControls' own snap onto the floor grid.
export function snapAlong(start, pos, q, step) {
  const d = qRot(qInv(q), [pos[0] - start[0], pos[1] - start[1], pos[2] - start[2]]).map((v) => Math.round(v / step) * step);
  const w = qRot(q, d);
  return [start[0] + w[0], start[1] + w[1], start[2] + w[2]];
}

// "Pivot at the view centre": where the ray through the middle of the view (origin o, unit direction d) hits the thing
// (hit, a point or null); with no hit, the point on the ray as far along it as the thing's current pivot (ref), at
// least a little in front of the camera
export function centrePoint(o, d, hit, ref) {
  if (hit) return [...hit];
  const t = Math.max(0.1, (ref[0] - o[0]) * d[0] + (ref[1] - o[1]) * d[1] + (ref[2] - o[2]) * d[2]);
  return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
}
