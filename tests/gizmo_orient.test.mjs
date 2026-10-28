// Run by tests/test_gizmo_orient.py (node tests/gizmo_orient.test.mjs): the 3D gizmo's World / Local / View axes and
// its pivot (web/gizmo-orient.js), checked against three.js.
import assert from 'node:assert/strict';
import * as G from '../web/gizmo-orient.js';
import * as THREE from '../web/vendor/three.module.min.js';

const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`);
const nearV = (a, b, msg, eps) => a.forEach((v, i) => near(v, b[i], `${msg}[${i}]`, eps));
const Q = (q) => new THREE.Quaternion(...q);
const arr = (q) => [q.x, q.y, q.z, q.w];

// cycling, and unknown values
assert.equal(G.nextOrient('world'), 'local');
assert.equal(G.nextOrient('local'), 'view');
assert.equal(G.nextOrient('view'), 'world');
assert.equal(G.nextOrient('nonsense'), 'local');
assert.equal(G.orientOf(undefined), 'world');
assert.equal(G.spaceOf('world'), 'world');
assert.equal(G.spaceOf('local'), 'local');
assert.equal(G.spaceOf('view'), 'local');

// quaternion helpers agree with three.js
const a = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 0.7)), b = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.2, 2.1));
nearV(G.qMul(arr(a), arr(b)), arr(a.clone().multiply(b)), 'qMul');
nearV(G.qInv(arr(a)), arr(a.clone().invert()), 'qInv');
nearV(G.qRot(arr(a), [1, 2, 3]), new THREE.Vector3(1, 2, 3).applyQuaternion(a).toArray(), 'qRot');

// the handle's turn: the camera's in View for Move and Rotate, the object's own for Scale and in World / Local
const cam = [0.1, 0.2, 0.3, 0.927], obj = [0, 0.6, 0, 0.8];
assert.deepEqual(G.frameQuat('view', 'translate', obj, cam), cam);
assert.deepEqual(G.frameQuat('view', 'rotate', obj, cam), cam);
assert.deepEqual(G.frameQuat('view', 'scale', obj, cam), obj);
assert.deepEqual(G.frameQuat('world', 'translate', obj, cam), obj);
assert.deepEqual(G.frameQuat('local', 'rotate', obj, cam), obj);

// a camera orbited 90° (looking along -X from +X): the View handle's X is the camera's right, here world -Z
const camQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
nearV(G.qRot(arr(camQ), [1, 0, 0]), [0, 0, -1], 'view X = screen right');
nearV(G.qRot(arr(camQ), [0, 0, 1]), [1, 0, 0], 'view Z = toward the viewer');

// the object follows the handle: nothing changes until the handle moves
const objQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.9, -0.3)), objP = [1, 0.5, -2], at = [0, 0.9, 0.1], s = [2, 2, 2];
const pivotW = new THREE.Vector3(...at).multiply(new THREE.Vector3(...s)).applyQuaternion(objQ).add(new THREE.Vector3(...objP)).toArray();
const rel = G.relQuat(arr(camQ), arr(objQ));
let f = G.follow(pivotW, arr(camQ), rel, at, s);
nearV(f.p, objP, 'still: position'); nearV(f.q, arr(objQ), 'still: turn');

// Move along the View X handle: the handle slides along screen right, the object goes the same way
const right = G.qRot(arr(camQ), [0.5, 0, 0]);
f = G.follow(pivotW.map((v, i) => v + right[i]), arr(camQ), rel, at, s);
nearV(f.p, objP.map((v, i) => v + right[i]), 'move: along the camera right'); nearV(f.q, arr(objQ), 'move: no turn');

// Rotate about the View Z handle (local Z, as TransformControls does in local space: q = qStart · turn): the object
// rolls about the camera's toward-viewer axis (world X here), around the pivot, which stays put
const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
const hq = camQ.clone().multiply(turn);
f = G.follow(pivotW, arr(hq), rel, at, s);
const want = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.7).multiply(objQ);
nearV(f.q, arr(want), 'roll: about the view axis');
const pivotAfter = new THREE.Vector3(...at).multiply(new THREE.Vector3(...s)).applyQuaternion(Q(f.q)).add(new THREE.Vector3(...f.p)).toArray();
nearV(pivotAfter, pivotW, 'roll: the pivot stays');

// World / Local keep the old behaviour: the handle is the object's own turn, rel is no turn
nearV(G.relQuat(arr(objQ), arr(objQ)), [0, 0, 0, 1], 'rel identity');

// grid steps along turned axes: from the start, whole steps of 0.25 along the handle's X and Y
const st = [1, 1, 1], q45 = arr(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4));
const raw = G.qRot(q45, [0.6, 0.1, 0]).map((v, i) => v + st[i]);
nearV(G.snapAlong(st, raw, q45, 0.25), G.qRot(q45, [0.5, 0, 0]).map((v, i) => v + st[i]), 'snapAlong');

// the view centre: the hit when there is one, else as far along the ray as the pivot
nearV(G.centrePoint([0, 1, 5], [0, 0, -1], [0, 1, 0.4], [3, 3, 0]), [0, 1, 0.4], 'centre: hit');
nearV(G.centrePoint([0, 1, 5], [0, 0, -1], null, [3, 3, 0]), [0, 1, 0], 'centre: no hit');
nearV(G.centrePoint([0, 1, 5], [0, 0, -1], null, [0, 0, 9]), [0, 1, 4.9], 'centre: behind the camera');

console.log('gizmo_orient ok');
