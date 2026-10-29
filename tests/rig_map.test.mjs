// node tests/rig_map.test.mjs
import assert from 'node:assert/strict';
import * as R from '../web/rig-map.js';

assert.equal(R.norm('mixamorig:LeftArm'), 'leftarm');
assert.equal(R.norm('mixamorigLeftArm'), 'leftarm');   // (FBXLoader drops the colon)
assert.equal(R.norm('Left_Arm'), 'leftarm');
assert.equal(R.norm('DEF-spine.001'), 'spine001');
assert.equal(R.norm(null), '');

// Mixamo names, the way an auto-rigged character comes in
const mixamo = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm',
  'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
  'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3'].map((n) => ({ name: `mixamorig:${n}` }));
const m = R.mapBones(mixamo);
assert.equal(m['mixamorig:Hips'], 'hips');
assert.equal(m['mixamorig:Spine'], 'spine');
assert.equal(m['mixamorig:Spine1'], 'chest');
assert.equal(m['mixamorig:LeftArm'], 'lsho');
assert.equal(m['mixamorig:LeftForeArm'], 'lelb');
assert.equal(m['mixamorig:LeftHand'], 'lhand');
assert.equal(m['mixamorig:RightUpLeg'], 'rhip');
assert.equal(m['mixamorig:LeftFoot'], 'lfoot');
assert.equal(m['mixamorig:LeftHandIndex2'], 'lindex2');
assert.equal(m['mixamorig:RightHandThumb3'], 'rthumb3');
assert.equal(m['mixamorig:LeftShoulder'], undefined, 'a clavicle the figure has no joint for is left alone');
assert.equal(m['mixamorig:LeftToeBase'], undefined);
assert.equal(Object.values(m).filter((j) => j === 'chest').length, 1, 'two spine bones do not both take the chest');

// a rig with names we don't know: the bones sit where the figure's joints are, so they are guessed
const pos = R.restPositions('man');
const named = Object.entries(pos).map(([j, p], i) => ({ name: `bone${i}`, pos: [p[0] + 0.01, p[1], p[2] - 0.01], joint: j }));
const guess = R.mapBones(named.map(({ name, pos }) => ({ name, pos })), { positions: pos });
for (const b of named) assert.equal(guess[b.name], b.joint, `${b.name} should be ${b.joint}, got ${guess[b.name]}`);
assert.equal(Object.keys(guess).length, Object.keys(pos).length);

// far away: nothing is guessed
const far = [{ name: 'x', pos: [5, 5, 5] }];
assert.deepEqual(R.mapBones(far, { positions: pos }), {});

// what is missing, for the panel
const miss = R.missing(m);
assert.ok(!miss.includes('hips') && !miss.includes('lindex2'));
assert.ok(miss.includes('lthumb1'), 'a hand the rig has no bones for is reported missing');
// the other side, and a pose mirrored about the middle
assert.equal(R.oppositeBone('mixamorigLeftArm'), 'mixamorigRightArm');
assert.equal(R.oppositeBone('mixamorigRightHandThumb1'), 'mixamorigLeftHandThumb1');
assert.equal(R.oppositeBone('hand.L'), 'hand.R');
assert.equal(R.oppositeBone('l_hand'), 'r_hand');
assert.equal(R.oppositeBone('lhand'), 'rhand');
assert.equal(R.oppositeBone('rfoot'), 'lfoot');
assert.equal(R.oppositeBone('root'), null);
assert.equal(R.oppositeBone('spine'), null);
assert.equal(R.oppositeBone(''), null);

const ql = [0.1, 0.2, 0.3, 0.93], qr = [0.4, 0.5, 0.6, 0.5];
const mir = R.mirrorChans({ 'b.mixamorigLeftArm': [{ f: 0, v: ql }, { f: 10, v: ql, ease: 'linear' }],
  'b.mixamorigRightArm': [{ f: 0, v: qr }], x: [{ f: 0, v: 2 }] },
  { mixamorigLeftArm: ql, mixamorigRightArm: qr, spine: [0.05, 0.1, 0.2, 0.97] });
assert.deepEqual(mir.chans['b.mixamorigRightArm'].map((k) => k.f), [0, 10], 'frames stay');
assert.deepEqual(mir.chans['b.mixamorigRightArm'][0].v, [0.1, -0.2, -0.3, 0.93], 'left goes to the right, mirrored');
assert.deepEqual(mir.chans['b.mixamorigLeftArm'][0].v, [0.4, -0.5, -0.6, 0.5]);
assert.deepEqual(mir.chans.x, [{ f: 0, v: 2 }], 'other channels are untouched');
assert.deepEqual(mir.base.spine, [0.05, -0.1, -0.2, 0.97], 'a centre bone mirrors in place');
assert.deepEqual(mir.base.mixamorigRightArm, [0.1, -0.2, -0.3, 0.93]);
console.log('rig_map ok');
