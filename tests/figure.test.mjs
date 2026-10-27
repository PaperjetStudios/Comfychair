// Run by tests/test_figure.py (node tests/figure.test.mjs): the posable figure's bodies, fingers, face
// and OpenPose points (web/figure.js), and finger channels keyed like any joint (web/scene-data.js).
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
globalThis.document = { addEventListener() {}, querySelector() { return null; } };
globalThis.addEventListener = () => {};
const F = await import('../web/figure.js');
const D = await import('../web/scene-data.js');

const mat = new THREE.MeshBasicMaterial();
const near = (a, b, eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
const sameTurn = (a, b, eps = 1e-4) => near(a, b, eps) || near(a, b.map((x) => -x), eps);   // (q and -q are one turn)
const wpos = (r, o) => { r.root.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()); };
const deg = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180)).toArray();

{ // the man keeps the old skeleton (old scenes pose the same); unknown or missing bodies are the man
  const r = F.buildFigure(mat, mat);
  assert.equal(r.body, 'man');
  for (const [n, [, at]] of Object.entries(F.JOINTS)) assert.ok(near(r.bones[n].position.toArray(), at), `${n} moved`);
  assert.equal(F.buildFigure(mat, mat, 'robot').body, 'man');
  assert.equal(F.bodyOf(undefined), 'man');
  // the body joints are still the motion import's 17; the fingers are extra
  assert.equal(Object.keys(F.JOINTS).length, 17);
  assert.equal(Object.keys(F.HAND).length, 30);
  assert.equal(Object.keys(r.bones).length, 47);
  // an old pose (no fingers) leaves the fingers straight, and the man stands on the floor at 1.75 m
  F.applyPose(r, F.preset('stand').j, {});
  for (const n of Object.keys(F.HAND)) assert.ok(near(r.bones[n].quaternion.toArray(), [0, 0, 0, 1]), `${n} not straight`);
  assert.ok(Math.abs(F.lowest(r)) < 0.005, `man floats ${F.lowest(r)}`);
  const top = new THREE.Box3().setFromObject(r.root).max.y;
  assert.ok(Math.abs(top - F.HEIGHT) < 0.02, `man is ${top} m`);
}
{ // the woman: smaller, narrower shoulders, wider hips, on the floor too
  const r = F.buildFigure(mat, mat, 'woman'), m = F.buildFigure(mat, mat, 'man');
  F.applyPose(r, {}, {}); F.applyPose(m, {}, {});
  assert.ok(Math.abs(F.heightOf('woman') - F.HEIGHT * 0.935) < 1e-9);
  const top = new THREE.Box3().setFromObject(r.root).max.y;
  assert.ok(Math.abs(top - F.heightOf('woman')) < 0.02, `woman is ${top} m`);
  assert.ok(Math.abs(F.lowest(r)) < 0.01);
  assert.ok(wpos(r, r.bones.lsho).x < wpos(m, m.bones.lsho).x * 0.9);
  assert.ok(wpos(r, r.bones.lhip).x > wpos(m, m.bones.lhip).x * 0.95);
  assert.ok(Math.abs(F.liftFor({}, {}, 'woman')) < 0.01);
}
{ // hand poses: each finger's turns, the right hand the left one mirrored
  const L = F.handPose('fist', 'l'), Rh = F.handPose('fist', 'r');
  assert.equal(Object.keys(L).length, 15);
  assert.ok(Object.keys(L).every((n) => n[0] === 'l') && Object.keys(Rh).every((n) => n[0] === 'r'));
  assert.ok(near(L.lindex1, deg(88, 0, 0)));
  assert.ok(near(L.lindex2, deg(100, 0, 0)));
  for (const [k] of F.handList()) {
    const l = F.handPose(k, 'l'), r = F.handPose(k, 'r');
    for (const n of Object.keys(l)) assert.ok(near(F.mirrorQ(l[n]), r[F.opposite(n)]), `${k} ${n} isn't mirrored`);
    assert.deepEqual(F.mirrorPose(l), r);   // mirroring a pose swaps the hands
  }
  assert.deepEqual(F.handList().map(([k]) => k), ['relaxed', 'open', 'fist', 'grip', 'point', 'pinch']);
  assert.equal(F.opposite('lindex2'), 'rindex2');
  assert.equal(F.opposite('rthumb1'), 'lthumb1');
  assert.equal(F.opposite('head'), null);
  // a fist curls the fingers in: the tips come close to the palm
  const r = F.buildFigure(mat, mat);
  const tipToWrist = (j) => { F.applyPose(r, j, {}); return wpos(r, r.marks.lmiddletip).distanceTo(wpos(r, r.bones.lhand)); };
  assert.ok(tipToWrist(F.handPose('fist', 'l')) < tipToWrist(F.handPose('open', 'l')) * 0.6);
  // pinch: the thumb and index tips meet
  F.applyPose(r, F.handPose('pinch', 'l'), {});
  assert.ok(wpos(r, r.marks.lthumbtip).distanceTo(wpos(r, r.marks.lindextip)) < 0.02, 'pinch tips apart');
  // fingersOf keeps only the fingers
  assert.deepEqual(Object.keys(F.fingersOf({ lsho: [0, 0, 0, 1], ...L })).sort(), Object.keys(L).sort());
}
{ // curl: 0 leaves the hand's pose, 100 is a fist whatever the pose; one hand only
  const r = F.buildFigure(mat, mat), open = { ...F.handPose('open', 'l'), ...F.handPose('open', 'r') }, fist = F.handPose('fist', 'l');
  F.applyPose(r, open, { curlL: 100 });
  for (const n of F.handJoints('l')) assert.ok(sameTurn(r.bones[n].quaternion.toArray(), fist[n]), `${n} not a fist`);
  for (const n of F.handJoints('r')) assert.ok(sameTurn(r.bones[n].quaternion.toArray(), open[n]), `${n} curled`);
  F.applyPose(r, open, { curlL: 50 });
  const half = new THREE.Quaternion().fromArray(open.lindex2).slerp(new THREE.Quaternion().fromArray(fist.lindex2), 0.5).toArray();
  assert.ok(sameTurn(r.bones.lindex2.quaternion.toArray(), half));
  assert.equal(F.readJoint(r, 'lsho').length, 4);
}
{ // Hand mode's per-finger curl and back
  for (const c of [0, 0.25, 0.6, 1]) {
    const j = F.fingerCurl('r', 'index', c);
    assert.deepEqual(Object.keys(j), ['rindex1', 'rindex2', 'rindex3']);
    assert.ok(Math.abs(F.curlOf(j, 'r', 'index') - c) < 1e-3, `curl ${c} read back as ${F.curlOf(j, 'r', 'index')}`);
  }
  assert.ok(near(F.fingerCurl('l', 'ring', 1).lring1, F.handPose('fist', 'l').lring1));
  assert.equal(F.curlOf({}, 'l', 'thumb'), 0);
}
{ // mirrored parameters: the hands' curls swap, the eyes look the other way, the rest stays
  assert.deepEqual(F.mirrorParams({ curlL: 30, lookX: 40, jaw: 20, turn: 10 }), { curlR: 30, lookX: -40, jaw: 20, turn: -10 });
  // the face and hand parameters key and blend like the others
  assert.deepEqual(F.lerpParams({ jaw: 0, smile: 50 }, { jaw: 100, smile: -50 }, 0.5), { jaw: 50 });
  for (const k of ['curlL', 'curlR']) assert.equal(F.PARAMS[k].tab, 'hands');
  for (const k of ['jaw', 'smile', 'brows', 'lookX', 'lookY', 'blink']) assert.equal(F.PARAMS[k].tab, 'face');
}
{ // OpenPose points: the body's 18, each hand's 21 (wrist, then each finger root to tip), the face's 68
  const r = F.buildFigure(mat, mat);
  F.applyPose(r, F.preset('stand').j, {});
  const k = F.keypoints(r);
  assert.equal(k.length, 18);
  assert.equal(k.hands.length, 2);
  assert.ok(k.hands.every((h) => h.length === 21 && h.every((p) => p instanceof THREE.Vector3)));
  assert.ok(k.hands[0][0].distanceTo(k[7]) < 1e-9, 'left wrist is the body\'s left wrist');   // (COCO 7 is the left wrist)
  assert.ok(k.hands[1][0].distanceTo(k[4]) < 1e-9);
  assert.ok(k.hands[0][8].distanceTo(wpos(r, r.marks.lindextip)) < 1e-9);
  assert.ok(k.hands[0][4].distanceTo(wpos(r, r.marks.lthumbtip)) < 1e-9);
  assert.equal(k.face.length, 68);
  // the face faces front (+z, ahead of the ears), its right (point 0) on the figure's right (-x), the chin lowest
  assert.ok(k.face[0].x < 0 && k.face[16].x > 0);
  assert.ok(k.face.every((p) => p.z > k[16].z), 'face points behind the ears');
  assert.ok(k.face[8].y === Math.min(...k.face.map((p) => p.y)));
  assert.ok(k.face[36].x < k.face[45].x);   // the right eye's outer corner is on the right
  // the face moves with its parameters: the jaw drops the chin, a smile lifts the corners, closing the eyes the lids
  const chin = k.face[8].y, corner = k.face[48].y, lid = k.face[37].y;
  F.applyPose(r, F.preset('stand').j, { jaw: 100, smile: 100, blink: 100 });
  const k2 = F.keypoints(r);
  assert.ok(k2.face[8].y < chin - 0.01, 'jaw didn\'t open');
  assert.ok(k2.face[57].y < k.face[57].y - 0.01);
  assert.ok(k2.face[54].y > corner - 0.02 && k2.face[48].x < k.face[48].x, 'smile didn\'t widen');
  assert.ok(k2.face[37].y < lid - 0.003, 'eyes didn\'t close');
  // hidden parts leave their points out
  const k3 = F.keypoints(r, ['lhand', 'head']);
  assert.equal(k3.hands[0], null);
  assert.equal(k3.hands[1].length, 21);
  assert.equal(k3.face, null);
}
{ // seen by a camera: pixels, hands and face optional; drawPose draws them
  const r = F.buildFigure(mat, mat);
  F.applyPose(r, F.preset('point').j, {});
  const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  cam.position.set(0, 1.2, 4); cam.lookAt(0, 1, 0); cam.updateMatrixWorld();
  const p = F.projectPose(r, [], cam, 512, 512);
  assert.equal(p.length, 18);
  assert.ok(p.hands.length === 2 && p.hands[1].every((q) => q && q.length === 2 && q[0] > 0 && q[0] < 512));
  assert.equal(p.face.length, 68);
  const none = F.projectPose(r, [], cam, 512, 512, { hands: false, face: false });
  assert.deepEqual(none.hands, []); assert.equal(none.face, null);
  assert.ok(none.cut instanceof Set);
  const calls = { arc: 0, line: 0 };
  const ctx = new Proxy({}, { get: (_, k) => (k === 'arc' ? () => calls.arc++ : k === 'lineTo' ? () => calls.line++ : () => {}), set: () => true });
  F.drawPose(ctx, [p], 512, 512);
  assert.ok(calls.arc >= 18 + 42 + 68, `drew ${calls.arc} points`);
  assert.ok(calls.line >= 40, `drew ${calls.line} hand bones`);
  // the right hand points: its index is straight, the others curled
  assert.ok(near(F.preset('point').j.rindex1, F.handPose('point', 'r').rindex1));
}
{ // finger channels key and blend per channel like the body's (old scenes without them: straight)
  const it = { base: { j: { lsho: deg(0, 0, 10) } }, ease: 'linear', chans: {} };
  D.setKey(it, 'j.lindex1', 0, [0, 0, 0, 1]);
  D.setKey(it, 'j.lindex1', 10, F.handPose('fist', 'l').lindex1);
  const mid = D.sample(it, ['j'], 5).j;
  assert.ok(sameTurn(mid.lindex1, deg(44, 0, 0)), `halfway ${mid.lindex1}`);
  assert.ok(near(mid.lsho, deg(0, 0, 10)));
  assert.ok(near(D.sampleChan(it, 'j.rindex1', 5), [0, 0, 0, 1]));
  const k = D.keyChans(it, ['j', 'm'], { j: { lindex1: [0, 0, 0, 1] }, m: { curlL: 20 } });
  assert.ok(k.includes('j.lindex1') && k.includes('m.curlL'));
}
console.log('figure ok');
