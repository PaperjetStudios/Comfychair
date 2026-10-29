// Rigged models: a skinned model (a GLB or FBX from an auto-rigger) whose bones follow the posable
// figure's own joints, so every pose, Pair, Move, IK, Hands, Face and mocap feature drives it, and the
// depth and pose renders draw it. The layer is { type: 'rigged', url, ext, name, map: {bone: joint},
// body, turn }; its values are a figure's (scene-data.js namesFor).
//
// A hidden figure rig (figure.js, its volumes never drawn) is built in the layer's group and posed by
// the view as any figure is. Each mapped bone takes the figure joint's world turn times the rest offset
// (the turn from the figure's rest pose to the model's bind pose), so only directions matter, not lengths.
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import * as FIGURE from './figure.js';
import { R, SC, TYPES, makers, newObject, save } from './scene-data.js';
import { mapBones, restPositions } from './rig-map.js';
import { button, h, help, hint, section, store, toast, toggle } from './ui.js';

const hideMat = new THREE.MeshBasicMaterial({ visible: false });   // the hidden rig's own volumes
const dotMat = new THREE.MeshBasicMaterial({ color: 0x4cc3ff, depthTest: false, transparent: true, opacity: 0.85 });
const gltf = new GLTFLoader();
const Q1 = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), Q3 = new THREE.Quaternion();
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
// the joint and bone being mapped in the panel (per device, not saved)
const RM = { joint: null, bone: '', name: '' };
// saved rig maps (per device): a map that fitted one model reused on another of the same rigger
const RIGS_KEY = 'deck.rigs';
const savedRigs = () => store.get(RIGS_KEY, {});
const cloneMap = (m) => Object.fromEntries(Object.entries(m || {}));
const refreshPanel = () => import('./scene-ui.js').then((m) => m.renderPanel());
function rigLibrary(o) {
  const all = savedRigs(), names = Object.keys(all);
  if (!names.length) return null;
  return h('div', { class: 'row wrap' }, ...names.map((n) => button(n, () => {
    o.map = cloneMap(all[n].map);
    save();
    rebuild(o);
    toast(`"${n}" applied: ${Object.keys(o.map).length} bones`);
    refreshPanel();
  }, { cls: 'small', title: `Use the saved rig map "${n}" (${Object.keys(all[n].map || {}).length} bones)` })));
}

const extOf = (url) => (String(url).split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';

// the figure's rest (bind) world turns, once: the model's bind pose is measured against these, and the
// view may already have posed the layer's own rig by the time its file loads
const BIND = (() => {
  const r = FIGURE.buildFigure(hideMat, dotMat, 'man');
  r.root.updateMatrixWorld(true);
  const q = {};
  for (const n of Object.keys(r.bones)) q[n] = r.bones[n].getWorldQuaternion(new THREE.Quaternion());
  return q;
})();

// a skinned model file as three.js objects, in its bind pose
async function loadFile(o) {
  const ext = (o.ext || extOf(o.url)).toLowerCase();
  if (ext === 'fbx') return new (await import('./vendor/FBXLoader.js')).FBXLoader().loadAsync(o.url);
  return (await gltf.loadAsync(o.url)).scene;
}

// where each bone sits in the layer's own metres (the wrapper's scale taken out), for guessing a map
function bonePlaces(bones, wrap) {
  return bones.map((b) => {
    b.getWorldPosition(V1);
    wrap.worldToLocal(V1);
    return { name: b.name, pos: [V1.x, V1.y, V1.z] };
  });
}

async function attach(o, group) {
  const obj = await loadFile(o);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const tall = Math.max(1e-4, box.max.y - box.min.y);
  const wrap = new THREE.Group();
  wrap.add(obj);
  // feet on the floor, centred, the height of the hidden figure (the dots and the mesh line up)
  obj.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  wrap.scale.setScalar(FIGURE.heightOf(o.body || 'man') / tall);
  if (o.turn) wrap.rotation.y = Math.PI;
  group.add(wrap);
  wrap.updateMatrixWorld(true);

  const skinned = [];
  obj.traverse((c) => {
    if (c.isSkinnedMesh) { skinned.push(c); c.frustumCulled = false; c.userData.id = o.id; if (c.material) c.material.side = THREE.DoubleSide; }
    else if (c.isMesh) c.userData.id = o.id;
  });
  if (!skinned.length) throw new Error('that model has no skeleton: rig it first');
  const bones = skinned[0].skeleton.bones;
  const rig = group.userData.rig;

  // the map: known names (Mixamo, Rigify…), then the nearest bone for what is left
  const places = bonePlaces(bones, wrap);
  if (!o.map || !Object.keys(o.map).length) o.map = mapBones(places, { positions: restPositions('man'), tolerance: 0.14 });
  const byName = new Map(bones.map((b) => [b.name, b]));

  // the rest offset per bone: figure rest -> model bind (world space)
  const restQ = new Map();
  for (const [name, joint] of Object.entries(o.map)) {
    const b = byName.get(name), qf = BIND[joint];
    if (!b || !qf) continue;
    restQ.set(name, qf.clone().invert().multiply(b.getWorldQuaternion(new THREE.Quaternion())));
  }
  // parents before children, so a bone's parent world turn is this frame's
  const order = [];
  const walk = (b) => { order.push(b); for (const c of b.children) if (c.isBone) walk(c); };
  for (const b of bones) if (!b.parent || !b.parent.isBone) walk(b);

  const hipBone = bones.find((b) => o.map[b.name] === 'hips') || null;
  rig.root.updateMatrixWorld(true);
  group.userData.skin = {
    order, map: o.map, restQ, hipBone,
    hipRest: hipBone ? hipBone.position.clone() : null,
    // the hips at rest, in the scene's space (the rig's root, its scale and the layer's transform)
    figHipRest: new THREE.Vector3(0, rig.at.hips[1], 0).applyMatrix4(rig.root.matrixWorld),
  };
  group.userData.skinned = skinned;
  const view = await import('./scene-view.js');
  view.pose(R.f);   // the view may have posed the hidden rig before the file arrived: put the skin there now
  view.draw();
  (await import('./scene-ui.js')).renderPanel();   // the panel's mapped/missing counts
  return { mapped: restQ.size, missing: Object.keys(o.map).length - restQ.size };
}

// every mapped bone takes its figure joint's world turn; the hips follow the figure's rise and fall
function sync(o, group) {
  const s = group.userData.skin;
  if (!s) return;
  const rig = group.userData.rig;
  rig.root.updateMatrixWorld(true);
  for (const b of s.order) {
    const joint = s.map[b.name];
    if (joint && rig.bones[joint]) {
      const rest = s.restQ.get(b.name);
      if (rest) {
        Q3.copy(rig.bones[joint].getWorldQuaternion(Q1)).multiply(rest);
        if (b.parent) Q3.premultiply(Q2.copy(b.parent.getWorldQuaternion(Q2)).invert());
        b.quaternion.copy(Q3);
      }
    }
    b.updateWorldMatrix(false, false);
  }
  if (s.hipBone && s.hipRest) {
    V2.copy(rig.bones.hips.getWorldPosition(V1)).sub(s.figHipRest);
    const p = s.hipBone.parent;
    if (p) {
      p.updateWorldMatrix(true, false);
      V2.applyQuaternion(p.getWorldQuaternion(Q1).invert()).divide(p.getWorldScale(V3));
    }
    s.hipBone.position.copy(s.hipRest).add(V2);
  }
}

export function makeRigged(o) {
  const group = new THREE.Group();
  const rig = FIGURE.buildFigure(hideMat, dotMat, o.body || 'man');
  for (const m of rig.meshes) m.visible = false;     // the model draws itself; the rig only poses it
  group.add(rig.root);
  group.userData.rig = rig;
  group.userData.atFrame = () => sync(o, group);
  attach(o, group)
    .then((r) => {
      if (!group.parent) return;
      toast(`${o.name}: ${r.mapped} bones follow the figure${r.missing > 0 ? ` (${r.missing} need a map)` : ''}`);
      save();
    })
    .catch((e) => toast(`${o.name}: ${e.message}`, true));
  return group;
}
makers.rigged = makeRigged;

// a skinned model into the scene, standing on the floor at the middle
export async function addRigged(url, name = 'Rigged', { gen = null, index = 0 } = {}) {
  const o = newObject('rigged', { x: 0, z: 0 });
  Object.assign(o, { url, name: String(name || 'Rigged').slice(0, 60), ext: extOf(url), gen, genIndex: index });
  o.base.sx = o.base.sy = o.base.sz = 1;
  SC.objects.push(o);
  save();
  (await import('./scene-view.js')).select(o.id);
  return o;
}

// the layer's panel: how many bones follow, what is missing, and the small fixes
export function rigProps(o) {
  const skin = R.meshes.get(o.id)?.userData.skin;
  const bones = skin ? skin.order.map((b) => b.name) : [];
  const have = new Set(Object.values(o.map || {}));
  const missing = ['hips', 'spine', 'chest', 'neck', 'head', 'lsho', 'lelb', 'lhand', 'rsho', 'relb', 'rhand',
    'lhip', 'lknee', 'lfoot', 'rhip', 'rknee', 'rfoot'].filter((j) => !have.has(j));
  const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'lsho', 'lelb', 'lhand', 'rsho', 'relb', 'rhand',
    'lhip', 'lknee', 'lfoot', 'rhip', 'rknee', 'rfoot'];
  if (!JOINTS.includes(RM.joint)) RM.joint = missing[0] || JOINTS[0];
  if (!bones.includes(RM.bone)) RM.bone = bones[0] || '';
  const mapIt = () => {
    if (!RM.joint || !RM.bone) return;
    o.map = { ...(o.map || {}), [RM.bone]: RM.joint };
    save();
    rebuild(o);   // the model loads again so the rest offsets are measured with the new map
    toast(`${RM.joint} now follows ${RM.bone}`);
  };
  return section('Rigged model', null,
    hint(skin ? `${skin.restQ.size} bones follow the figure` : 'Loading its skeleton…'),
    missing.length ? hint(`No bone for: ${missing.join(', ')}`) : null,
    missing.length && bones.length ? h('div', { class: 'row wrap' },
      h('select', { 'aria-label': 'Figure joint', onchange: (e) => { RM.joint = e.target.value; } },
        ...JOINTS.map((j) => h('option', { value: j, selected: j === RM.joint }, missing.includes(j) ? `${j} (missing)` : j))),
      h('select', { 'aria-label': 'Model bone', onchange: (e) => { RM.bone = e.target.value; } },
        ...bones.map((n) => h('option', { value: n, selected: n === RM.bone }, n))),
      button('Map it', mapIt, { cls: 'small', title: 'The joint follows this bone from now on (the model is fitted again)' })) : null,
    h('div', { class: 'row wrap' },
      h('input', { type: 'text', value: RM.name, placeholder: 'Rig map name', 'aria-label': 'Rig map name',
        onchange: (e) => { RM.name = e.target.value; } }),
      button('Save this map', () => {
        const name = (RM.name || '').trim() || (o.map ? 'Rig' : '');
        if (!name) return toast('Name the map first', true);
        const all = savedRigs();
        if (all[name] && !confirm(`Overwrite the saved map "${name}"?`)) return;
        all[name] = { map: cloneMap(o.map) };
        store.set(RIGS_KEY, all);
        toast(`Saved "${name}": ${Object.keys(o.map || {}).length} bones`);
        refreshPanel();
      }, { cls: 'small', title: 'Keep this map (this device) to put on another model from the same rigger' })),
    rigLibrary(o),
    h('div', { class: 'row wrap' },
      toggle('Turn it 180°', !!o.turn, (on) => { o.turn = on; rebuild(o); }),
      button('Re-map the bones', () => { o.map = {}; rebuild(o); }, { cls: 'small', title: 'Map again from the bone names and their places' })),
    help('A rigged model takes the figure\'s own poses, keys and moves: its bones copy the hidden figure\'s joints. Rig it from a model layer with Rig it as a person.'));
}

async function rebuild(o) {
  save();
  const m = R.meshes.get(o.id);
  if (m) { m.parent?.remove(m); R.meshes.delete(o.id); }
  (await import('./scene-view.js')).refresh();
}
