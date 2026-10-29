// node tests/shots.test.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';

const el = () => {
  const node = {
    style: {}, dataset: {}, classList: { add() {}, toggle() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, append() {}, appendChild() { return node; }, prepend() {},
    addEventListener() {}, removeEventListener() {}, remove() {}, closest() { return null; },
    querySelector() { return el(); }, querySelectorAll() { return []; },
    getContext() { return { canvas: node, measureText: () => ({ width: 0 }), fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {}, scale() {}, translate() {}, setTransform() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    width: 100, height: 100, childNodes: [], children: [],
    parentElement: { append() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  };
  return node;
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, querySelector() { return el(); }, querySelectorAll() { return []; },
  documentElement: { style: {} }, createElement: el, createElementNS: el,
  body: { append() {}, removeChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  activeElement: null,
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.HTMLElement = class {};
globalThis.Node = class {};
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

await register(new URL('./shot-hooks.mjs', import.meta.url).href, { parentURL: import.meta.url });
const D = await import('../web/scene-data.js');
const W = await import('../web/shot-words.js');
const Cam = await import('../web/scene-camera.js');

const { upgrade, setSC, liveCam, shots, defaultScene, camById } = D;
const { stamp, sizeFromHeight, angleFrom, pitchOf, framingOf, guessMove, shotSentence, MOVE_FROM, smpte } = W;

// ---- live camera and shot ranges ----
function scene(cuts = []) {
  const sc = defaultScene();
  sc.seconds = 6;
  sc.cuts = cuts;
  const b = { ...sc.camera, id: 'b', name: 'B' };
  sc.cams = [b];
  setSC(sc);
  return sc;
}

let sc = scene();
assert.equal(liveCam(0), sc.camera, 'no cuts: the active camera');
assert.equal(shots().length, 1);
assert.equal(shots()[0].cam, sc.camera);
assert.equal(shots()[0].f0, 0);

sc = scene([{ id: 'c2', f: 40, cam: 'b' }, { id: 'c1', f: 10, cam: 'b' }]);
assert.equal(liveCam(0).id, 'b', 'before the first cut, that cut\'s camera');
assert.equal(liveCam(10).id, 'b');
assert.equal(liveCam(39).id, 'b');
assert.equal(shots().length, 1, 'two cuts to the same camera merge');

sc = scene([{ f: 48, cam: 'b', id: 'x' }, { f: 10, cam: sc.camera.id, id: 'y' }]);
assert.equal(liveCam(0).id, sc.camera.id);
assert.equal(liveCam(10).id, sc.camera.id);
assert.equal(liveCam(48).id, 'b');
assert.deepEqual(shots().map((s) => [s.f0, s.cam.id]), [[0, sc.camera.id], [48, 'b']]);

sc = scene([{ f: 9999, cam: 'b', id: 'late' }]);
assert.equal(liveCam(10).id, 'b', 'a cut past the end still names the camera before it');
assert.equal(shots().length, 1);
assert.equal(shots()[0].f1, D.frames() - 1);

sc = scene([{ f: 12, cam: 'gone', id: 'z' }, { f: 30, cam: 'b', id: 'ok' }]);
assert.equal(liveCam(0).id, 'b', 'a deleted camera is skipped');
assert.equal(liveCam(20).id, 'b');
assert.equal(camById('gone'), null);

// an older scene has no cuts and still renders through its one camera
const old = { seconds: 6, width: 768, height: 448, camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, chans: {} }, objects: [] };
upgrade(old);
assert.deepEqual(old.cuts, []);
assert.equal(old.renderShots, 'take');
assert.equal(old.tcStart, '01:00:00:00');
setSC(old);
assert.equal(liveCam(4), old.camera);
assert.equal(shots()[0].cam, old.camera);

// ---- words ----
assert.equal(stamp(3), '00:03.000');
assert.equal(stamp(63.5), '01:03.500');
assert.equal(smpte(0, 24, '01:00:00:00'), '01:00:00:00');
assert.equal(smpte(24, 24, '01:00:00:00'), '01:00:01:00');
assert.equal(sizeFromHeight(2), 'ecu');
assert.equal(sizeFromHeight(1), 'close');
assert.equal(sizeFromHeight(0.5), 'medium');
assert.equal(sizeFromHeight(0.2), 'wide');
assert.equal(sizeFromHeight(null), 'wide');
assert.equal(angleFrom(0, 0), 'eye');
assert.equal(angleFrom(20, 0), 'low');
assert.equal(angleFrom(-20, 0), 'high');
assert.equal(angleFrom(-70, 0), 'over');
assert.equal(angleFrom(0, 10), 'dutch');

const far = { px: 0, py: 1.6, pz: 8, tx: 0, ty: 1, tz: 0, fov: 45, roll: 0 };
const person = { name: 'Ada', min: [-0.25, 0, -0.15], max: [0.25, 1.75, 0.15] };
const wide = framingOf(far, [person], 768, 448);
assert.equal(wide.size, 'wide');
assert.equal(wide.subjects[0], 'Ada');
assert.equal(angleFrom(pitchOf(far), 0), 'eye');
const close = framingOf({ px: 0, py: 0.9, pz: 2.1, tx: 0, ty: 0.9, tz: 0, fov: 45, roll: 0 }, [person], 768, 448);
assert.ok(close.height > 0.9, `close setup height ${close.height}`);
assert.equal(close.size, 'close');
const ecu = framingOf({ px: 0, py: 1.5, pz: 0.7, tx: 0, ty: 1.5, tz: 0, fov: 45, roll: 0 }, [person], 768, 448);
assert.equal(ecu.size, 'ecu', `ecu setup height ${ecu.height}`);
assert.equal(ecu.subjects[0], 'Ada');

const level = { px: 0, py: 1.6, pz: 4, tx: 0, ty: 1.6, tz: 0, fov: 45, roll: 0 };
assert.equal(guessMove(level, level), 'static');
assert.equal(guessMove(level, { ...level, fov: 28 }), 'zoom');
assert.equal(guessMove(level, { ...level, py: 3, ty: 1.6 }), 'crane');
assert.equal(guessMove(level, level, { mv: 'orbit-left' }), 'orbit');

// each camera move, keyed with writeMove, names itself
{
  const sc2 = defaultScene();
  sc2.seconds = 6;
  setSC(sc2);
  const cam = sc2.camera;
  for (const [id, word] of Object.entries(MOVE_FROM)) {
    cam.chans = {};
    assert.equal(Cam.writeMove(cam, id, { a: id.startsWith('zoom') ? 1.6 : 2, lens: 15 }, { f0: 0, f1: 48, ease: 'linear' }), true, id);
    const mv = Object.values(cam.chans).flat().find((k) => k.f === 0 && k.mv)?.mv;
    assert.equal(mv, id, `${id} records its move`);
    const a = D.sample(cam, D.CAM, 0), b = D.sample(cam, D.CAM, 48);
    assert.equal(guessMove(a, b, { mv }), word, id);
  }
}

assert.match(shotSentence({ n: 1, size: 'wide', angle: 'eye', subjects: ['Ada'], move: 'push', action: 'Ada stands.' }), /^\[Shot 1\] A wide shot, eye level, of Ada; the camera pushes in\. Ada stands\.$/);
assert.match(shotSentence({ n: 2, at: 4, size: 'close', angle: 'low', subjects: ['Ada'], move: 'static', format: 'h3' }), /^\[Shot 2\] At 00:04\.000, the camera cuts to a close-up/);
assert.match(shotSentence({ n: 2, size: 'wide', angle: 'eye', subjects: ['Ada'], move: 'static', format: 'ltx' }), /^Hard cut to shot 2:/);

console.log('shots ok');
