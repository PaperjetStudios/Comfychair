// Generic skinned models: a GLB or FBX with a skeleton whose bones are keyed by hand (b.<bone>
// channels in scene-data.js), bone by bone. This is the layer an auto-rig makes for an animal or a
// prop (UniRig), and any imported rig can be turned into one.
//
// The values are OBJ + b: scene-data namesFor() gives a 'skinned' layer BONE. Each bone's stored turn
// is its own local quaternion, so a bone with no key keeps the model's bind pose; a keyed one slerps
// between its keys like a figure's joint does. Turning a bone in the panel composes the sliders' turn
// onto what the bone has at the playhead and writes it there (a key at the playhead when animated).
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { BONE, R, SC, TYPES, addKey, makers, newObject, sample, save, write } from './scene-data.js';
import { importFit } from './scale-math.js';
import { button, field, h, help, hint, numSlider, section, toast } from './ui.js';
import { chainTo, reach } from './ik.js';
import { mirrorChans } from './rig-map.js';
import { boneOrder, disposeTree, reskinAll } from './reskin.js';

const gltf = new GLTFLoader();
const extOf = (url) => (String(url).split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
const deg = THREE.MathUtils.degToRad;
const dotGeo = new THREE.SphereGeometry(0.035, 10, 8);
const dotMat = new THREE.MeshBasicMaterial({ color: 0x4cc3ff, depthTest: false, transparent: true, opacity: 0.85 });
const V1 = new THREE.Vector3(), M1 = new THREE.Matrix4();
// which bone the panel is turning, and the turn asked for (per device; not saved)
const SK = { bone: null, x: 0, y: 0, z: 0 };
const turned = () => Math.abs(SK.x) + Math.abs(SK.y) + Math.abs(SK.z) > 0;

async function loadFile(o) {
  const ext = (o.ext || extOf(o.url)).toLowerCase();
  if (ext === 'fbx') return new (await import('./vendor/FBXLoader.js')).FBXLoader().loadAsync(o.url);
  return (await gltf.loadAsync(o.url)).scene;
}

// the even scale that makes it a usable size in metres (glTF is metres; an FBX says its unit)
function fitFor(o, size, unit) {
  const r = importFit(o.ext || extOf(o.url), [size.x, size.y, size.z], unit, 2);
  const big = Math.max(size.x, size.y, size.z) || 1;
  return r.ask ? Math.min(4, 2 / big) : r.fit;
}

// The layer's own edits to the file's skeleton, o.skel = { names: {key: name}, adds: [{ key, name, parent, pos }],
// dels: [key] }, kept by each bone's stable key: its name in the file (name#2 for a second of that name) or the
// +key an added bone was given. Put back on load in that order (adds, deletes, names), so it is the same skeleton.
const keyOf = (b) => b.userData.skKey;
const skelOf = (o) => (o.skel ||= { names: {}, adds: [], dels: [] });
function keyFile(order) {
  const seen = {};
  for (const b of order) {
    const n = seen[b.name] = (seen[b.name] || 0) + 1;
    b.userData.skKey = n > 1 ? `${b.name}#${n}` : b.name;
  }
}
// the saved edits onto the file's bones; returns the bones in order and whether the skeleton changed shape
function replay(o, order) {
  const k = o.skel, byKey = new Map(order.map((b) => [keyOf(b), b]));
  let shaped = false;
  for (const a of k.adds || []) {
    const p = byKey.get(a.parent);
    if (!p || byKey.has(a.key)) continue;
    const b = new THREE.Bone();
    b.name = a.name || a.key.slice(1);
    b.userData.skKey = a.key;
    b.position.fromArray(a.pos || [0, 0.05, 0]);
    p.add(b);
    byKey.set(a.key, b);
    shaped = true;
  }
  for (const key of k.dels || []) {
    const b = byKey.get(key);
    if (!b?.parent?.isBone) continue;
    for (const c of [...b.children]) if (c.isBone) b.parent.attach(c);
    b.removeFromParent();
    byKey.delete(key);
    shaped = true;
  }
  for (const [key, name] of Object.entries(k.names || {})) { const b = byKey.get(key); if (b && name) b.name = name; }
  const live = new Set(byKey.values());
  return { order: boneOrder(order.filter((b) => live.has(b))), shaped };
}

// every bone at its resting turn (the pose the mesh is bound in), world matrices current: re-skin from here
function toRest(s) {
  for (const b of s.order) { const q = s.rest.get(b.name); if (q) b.quaternion.copy(q); }
  for (const b of s.order) if (!b.parent?.isBone) b.updateWorldMatrix(true, true);
}

async function attach(o, group) {
  const obj = await loadFile(o);
  if (group.userData.gone) { disposeTree(obj); return null; }   // the layer went while it loaded
  group.userData.file = obj;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const fit = fitFor(o, size, obj.userData?.unitScaleFactor ?? null);
  const wrap = new THREE.Group();
  wrap.add(obj);
  obj.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  wrap.scale.setScalar(fit);
  group.add(wrap);
  wrap.updateMatrixWorld(true);

  const skinned = [];
  obj.traverse((c) => {
    if (c.isSkinnedMesh) { skinned.push(c); c.frustumCulled = false; c.userData.id = o.id; }
    else if (c.isMesh) c.userData.id = o.id;
  });
  if (!skinned.length) throw new Error('that model has no skeleton to key');
  const bones = skinned[0].skeleton.bones;
  // parents before children, as posed in a frame
  let order = boneOrder(bones);
  keyFile(order);
  if (o.skel) {   // the layer's added, deleted and renamed bones (the file keeps its own)
    const r = replay(o, order);
    order = r.order;
    if (r.shaped) { obj.updateMatrixWorld(true); reskinAll(skinned, order); }
  } else if (Array.isArray(o.bones) && o.bones.length === order.length) {
    // an older layer kept its renames by place: put them back, and keep them by key from now on
    const names = {};
    order.forEach((b, i) => { const n = o.bones[i]; if (n && n !== b.name) { names[keyOf(b)] = n; b.name = n; } });
    if (Object.keys(names).length) o.skel = { names, adds: [], dels: [] };
  }
  const rest = new Map(order.map((b) => [b.name, b.quaternion.clone()]));
  group.userData.skin = { order, rest, skinned };
  // a dot per bone, in the layer's own space (layer 1: picked on their own, never rendered out)
  group.userData.dots = order.map((b) => {
    const d = new THREE.Mesh(dotGeo, dotMat);
    d.userData.joint = b.name; d.userData.id = o.id; d.userData.mesh = group;
    d.layers.set(1); d.visible = false;
    group.add(d);
    return d;
  });
  group.userData.pickedBone = SK.bone;
  o.bones = order.map((b) => b.name);
  o.fit = fit;
  group.userData.atFrame = (f) => apply(o, group, f);
  const view = await import('./scene-view.js');
  view.pose(R.f);
  view.draw();
  (await import('./scene-ui.js')).renderPanel();
  return order.length;
}

// a frame: every keyed bone takes its channel's turn; the others keep the bind pose
function apply(o, group, f) {
  const s = group.userData.skin;
  if (!s) return;
  const bag = sample(o, BONE, f).b || {};
  for (const b of s.order) {
    const q = bag[b.name];
    if (q) b.quaternion.fromArray(q);
    b.updateWorldMatrix(false, false);
  }
  const dots = group.userData.dots;
  if (dots) {   // each dot where its bone is, in the layer's space
    group.updateWorldMatrix(true, false);
    M1.copy(group.matrixWorld).invert();
    for (let i = 0; i < dots.length; i++) dots[i].position.copy(s.order[i].getWorldPosition(V1).applyMatrix4(M1));
  }
}

// the view is dragging one of this layer's bone dots: the chain up to that bone reaches for the pointer (CCD),
// and the turns are written for the playhead (keys when the layer has them). Saving happens once, on letting go.
let VIEW = null;
const view = async () => (VIEW ||= import('./scene-view.js'));
export async function onBoneDrag(id, bone, target) {
  const o = SC.objects.find((x) => x.id === id);
  const s = R.meshes.get(id)?.userData.skin;
  if (!o || !s || !bone) return;
  const chain = chainTo(s.order, bone);
  if (chain.length < 2) return;
  // the top bone (it carries the whole model) stays put unless it is all the chain has; every bone turned is written
  const r = reach(chain.length > 2 ? chain.slice(1) : chain, new THREE.Vector3(target.x, target.y, target.z), { iterations: 8, tolerance: 0.006 });
  const bag = {};
  for (const b of r.bones) bag[b.name] = b.q;
  if (!Object.keys(bag).length) return;
  write(o, BONE, { b: bag });
  SK.bone = bone;
  const g = R.meshes.get(id);
  if (g) g.userData.pickedBone = bone;
  const v = await view();
  v.pose(R.f); v.draw();
}

export function onBoneDragEnd() {
  save();
}

// the view picked one of this layer's bone dots (scene.js wires this to scene-view's setBonePick)
export function onBonePick(id, bone) {
  const o = SC.objects.find((x) => x.id === id);
  if (!o || o.type !== 'skinned' || !bone) return;
  SK.bone = bone; SK.x = SK.y = SK.z = 0;
  const g = R.meshes.get(id);
  if (g) g.userData.pickedBone = bone;
  import('./scene-view.js').then((v) => v.draw());
  renderPanel();
}

// the dots remade after a bone was added or removed (apply places them each frame)
function rebuildDots(o, group, s) {
  for (const d of group.userData.dots || []) d.removeFromParent();
  group.userData.dots = s.order.map((b) => {
    const d = new THREE.Mesh(dotGeo, dotMat);
    d.userData.joint = b.name;
    d.userData.id = o.id;
    d.layers.set(1);
    d.visible = false;
    group.add(d);
    return d;
  });
}

export function makeSkinned(o) {
  const group = new THREE.Group();
  group.userData.atFrame = (f) => apply(o, group, f);
  group.userData.dispose = () => { group.userData.gone = true; disposeTree(group.userData.file); };
  attach(o, group)
    .then((n) => {
      if (n == null) return;
      toast(`${o.name}: ${n} bones to key`);
      save();
    })
    .catch((e) => toast(`${o.name}: ${e.message}`, true));
  return group;
}
makers.skinned = makeSkinned;

// a generic skinned model into the scene, standing on the floor at the middle
export async function addSkinned(url, name = 'Skinned', { gen = null, index = 0 } = {}) {
  const o = newObject('skinned', { x: 0, z: 0 });
  Object.assign(o, { url, name: String(name || 'Skinned').slice(0, 60), ext: extOf(url), gen, genIndex: index });
  SC.objects.push(o);
  save();
  (await import('./scene-view.js')).select(o.id);
  return o;
}

// the panel: pick a bone, turn it, key it, put it back
export function boneProps(o) {
  const skin = R.meshes.get(o.id)?.userData.skin;
  const names = skin ? skin.order.map((b) => b.name) : (o.bones || []);
  if (!names.includes(SK.bone)) SK.bone = names[0] || null;
  SK.bone ||= names[0] || null;
  const slider = (ax) => {
    const i = numSlider({ min: -180, max: 180, step: 1, value: SK[ax], digits: 0, label: `${ax.toUpperCase()} turn` });
    i.addEventListener('input', () => { SK[ax] = +i.value || 0; });
    return i;
  };
  return section('Bones', null,
    hint(skin ? `${names.length} bones · keyed here at the playhead` : 'Loading its skeleton…'),
    names.length ? field('Bone', h('select', { 'aria-label': 'Bone',
      onchange: (e) => { SK.bone = e.target.value; SK.x = SK.y = SK.z = 0;
        const m = R.meshes.get(o.id); if (m) m.userData.pickedBone = SK.bone;
        renderPanel(); import('./scene-view.js').then((v) => v.draw()); } },
      ...names.map((n) => h('option', { value: n, selected: n === SK.bone }, n)))) : null,
    h('div', { class: 'row wrap' }, slider('x'), slider('y'), slider('z')),
    names.length ? field('Name', h('div', { class: 'row' },
      h('input', { type: 'text', value: SK.bone || '', 'aria-label': 'Bone name', placeholder: 'Bone name',
        onchange: (e) => renameBone(o, e.target.value) }),
      button('Rename', () => renameBone(o, document.querySelector('#sceneBody input[aria-label="Bone name"]')?.value),
        { cls: 'small', title: 'Rename this bone, and the keys it holds, in the model and in the layer' }))) : null,
    h('div', { class: 'row wrap' },
      button('Turn it', () => turn(o), { cls: 'small primary', disabled: !names.length }),
      button('Put it back', () => reset(o), { cls: 'small', disabled: !names.length }),
      button('Key every bone', () => keyAll(o), { cls: 'small', disabled: !names.length }),
      button('Add a bone', () => addBone(o), { cls: 'small', disabled: !names.length,
        title: 'A new bone under this one (half way to its first child); the mesh is re-skinned to the new skeleton' }),
      button('Delete this bone', () => deleteBone(o), { cls: 'small', disabled: !names.length,
        title: 'Remove this bone and re-skin the mesh to the rest; its keys go too' }),
      button('Forget this bone', () => forgetBone(o), { cls: 'small', disabled: !names.length,
        title: 'Drop this bone\'s keys and resting turn, back to the model\'s bind pose' }),
      button('Mirror the bones', () => mirrorPose(o), { cls: 'small', disabled: !names.length,
        title: 'The pose on the other side: paired bones (Left/Right, .L/.R) swap and their turns mirror; centre bones mirror in place' })),
    help('A bone is turned by the three sliders and kept at the playhead: with keys it makes a key there (Auto key off: ◆ Key keeps it). Put it back returns one bone to the model\'s bind pose; Key every bone keys the whole skeleton where it is now, which is what a mocap or a pose pass wants before moving single bones.'));
}

async function changed() {
  save();
  const v = await import('./scene-view.js');
  v.pose(R.f); v.draw();
  (await import('./scene-ui.js')).renderPanel();
}
function renderPanel() { import('./scene-ui.js').then((m) => m.renderPanel()); }

function turn(o) {
  const s = R.meshes.get(o.id)?.userData.skin;
  if (!s || !SK.bone) return;
  if (!turned()) return toast('Slide a turn first', true);
  const cur = sample(o, BONE, R.f).b?.[SK.bone];
  const q = new THREE.Quaternion().fromArray(cur || s.rest.get(SK.bone)?.toArray() || [0, 0, 0, 1]);
  q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(SK.x), deg(SK.y), deg(SK.z))));
  SK.x = SK.y = SK.z = 0;
  write(o, BONE, { b: { [SK.bone]: q.toArray() } });
  changed();
}

function reset(o) {
  const s = R.meshes.get(o.id)?.userData.skin;
  const rest = s?.rest.get(SK.bone);
  if (!rest) return toast('That bone isn\'t loaded yet', true);
  write(o, BONE, { b: { [SK.bone]: rest.toArray() } });
  changed();
}

// rename a bone (and the keys it holds) in the model and in the layer's saved bone list and channels
function renameBone(o, to) {
  const s = R.meshes.get(o.id)?.userData.skin;
  const old = SK.bone;
  const name = String(to || '').trim();
  if (!s || !old) return;
  if (!name || name === old) return;
  if (s.order.some((b) => b.name === name)) return toast('There is already a bone called that', true);
  const bone = s.order.find((b) => b.name === old);
  if (!bone) return;
  bone.name = name;
  skelOf(o).names[keyOf(bone)] = name;
  if (s.rest.has(old)) { s.rest.set(name, s.rest.get(old)); s.rest.delete(old); }
  if (Array.isArray(o.bones)) o.bones = o.bones.map((n) => (n === old ? name : n));
  const chans = { ...(o.chans || {}) };
  if (chans[`b.${old}`]) { chans[`b.${name}`] = chans[`b.${old}`]; delete chans[`b.${old}`]; }
  o.chans = chans;
  if (o.base.b?.[old]) {
    const bag = { ...o.base.b, [name]: o.base.b[old] };
    delete bag[old];
    o.base.b = bag;
  }
  for (const d of R.meshes.get(o.id)?.userData.dots || []) if (d.userData.joint === old) d.userData.joint = name;
  const g = R.meshes.get(o.id);
  if (g?.userData.pickedBone === old) g.userData.pickedBone = name;
  SK.bone = name;
  save();
  renderPanel();
}

// a new bone under the picked one, then the mesh weighted again (nearest bones)
function addBone(o) {
  const group = R.meshes.get(o.id), s = group?.userData.skin;
  if (!s || !SK.bone) return;
  const parent = s.order.find((b) => b.name === SK.bone);
  if (!parent) return;
  let name = `${parent.name}_2`;
  for (let i = 3; s.order.some((b) => b.name === name); i++) name = `${parent.name}_${i}`;
  const k = skelOf(o);
  let key = `+${name}`;
  for (let i = 2; k.adds.some((a) => a.key === key); i++) key = `+${name}~${i}`;
  toRest(s);   // weights are matched in the bind pose, not the frame's
  const b = new THREE.Bone();
  b.name = name;
  b.userData.skKey = key;
  const child = parent.children.find((c) => c.isBone);
  if (child) b.position.copy(child.position).multiplyScalar(0.5);
  else b.position.set(0, 0.05, 0);
  parent.add(b);
  k.adds.push({ key, name, parent: keyOf(parent), pos: b.position.toArray() });
  s.order = boneOrder(s.order);
  s.rest.set(name, b.quaternion.clone());
  o.bones = s.order.map((x) => x.name);
  rebuildDots(o, group, s);
  reskinAll(s.skinned, s.order);
  apply(o, group, R.f);   // back to the frame's pose
  SK.bone = name;
  save();
  import('./scene-view.js').then((v) => { v.pose(R.f); v.draw(); });
  renderPanel();
  toast(`${name} added: the mesh is re-skinned to ${s.order.length} bones`);
}

// a bone taken out (children keep their place), the mesh weighted to what is left
function deleteBone(o) {
  const group = R.meshes.get(o.id), s = group?.userData.skin;
  const b = s?.order.find((x) => x.name === SK.bone);
  if (!b) return;
  if (!b.parent || !b.parent.isBone) return toast('A root bone can\'t be deleted', true);
  if (!confirm(`Delete the bone ${b.name}? The mesh is re-skinned to the bones that are left.`)) return;
  const name = b.name;
  toRest(s);   // weights are matched in the bind pose, not the frame's
  const kids = b.children.filter((c) => c.isBone);
  for (const c of kids) b.parent.attach(c);
  b.removeFromParent();
  skelOf(o).dels.push(keyOf(b));
  s.order = boneOrder(s.order.filter((x) => x !== b));
  s.rest.delete(name);
  for (const c of kids) s.rest.set(c.name, c.quaternion.clone());   // their rest is now under the new parent
  const chans = { ...(o.chans || {}) };
  delete chans[`b.${name}`];
  o.chans = chans;
  if (o.base.b?.[name]) {
    const bag = { ...o.base.b };
    delete bag[name];
    o.base.b = bag;
  }
  o.bones = s.order.map((x) => x.name);
  reskinAll(s.skinned, s.order);
  rebuildDots(o, group, s);
  apply(o, group, R.f);   // back to the frame's pose
  SK.bone = s.order[0]?.name || null;
  save();
  import('./scene-view.js').then((v) => { v.pose(R.f); v.draw(); });
  renderPanel();
  toast(`${name} deleted: the mesh is re-skinned to ${s.order.length} bones`);
}

// one bone back to the model's bind pose: its channel and resting turn go (the mesh keeps whatever weights it had)
function forgetBone(o) {
  const s = R.meshes.get(o.id)?.userData.skin;
  const name = SK.bone;
  if (!s || !name) return;
  const chans = { ...(o.chans || {}) };
  delete chans[`b.${name}`];
  o.chans = chans;
  if (o.base.b?.[name]) {
    const bag = { ...o.base.b };
    delete bag[name];
    o.base.b = bag;
  }
  const bone = s.order.find((b) => b.name === name), rest = s.rest.get(name);
  if (bone && rest) { bone.quaternion.copy(rest); bone.updateWorldMatrix(false, true); }
  save();
  import('./scene-view.js').then((v) => { v.pose(R.f); v.draw(); });
  renderPanel();
}

// every bone channel mirrored about the model's middle (keys and base alike); one undo step
function mirrorPose(o) {
  const { chans, base } = mirrorChans(o.chans || {}, o.base.b || {});
  o.chans = chans;
  o.base.b = base;
  save();
  import('./scene-view.js').then((v) => { v.pose(R.f); v.draw(); });
  renderPanel();
}

// the whole skeleton as it is now, keyed at the playhead (so single bones can move from here)
function keyAll(o) {
  const s = R.meshes.get(o.id)?.userData.skin;
  if (!s) return;
  const b = {};
  for (const bone of s.order) b[bone.name] = bone.quaternion.toArray();
  write(o, BONE, { b });
  addKey(o, BONE, { b }, new Set(Object.keys(b).map((n) => `b.${n}`)));   // the bones only
  changed();
}
