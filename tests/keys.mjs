// Node test for the key ops (web/scene-keyops.js) and sampling/mute (web/scene-data.js). Run by test_keys.py.
import assert from 'node:assert/strict';
globalThis.document = { addEventListener() {}, querySelector() { return null; } };
globalThis.addEventListener = () => {};
const K = await import('../web/scene-keyops.js');
const D = await import('../web/scene-data.js');

const mk = (fs, extra = {}) => ({ base: { x: 0 }, ease: 'smooth', keys: fs.map((f) => ({ f, x: f * 10 })), ...extra });
const lay = (item, id = 'a', kind = 'obj', names = ['x']) => ({ item, id, kind, names });
const fs = (L) => L.item.keys.map((k) => k.f);
const N = 100;

{ // move: block, clamped, collision replaces unselected, no duplicates
  const L = lay(mk([0, 10, 20, 30])), sel = new Set([L.item.keys[1], L.item.keys[2]]);
  assert.equal(K.moveBy([L], sel, 10, N), 10);
  assert.deepEqual(fs(L), [0, 20, 30]);            // key at 30 replaced by the one moved from 20; 10 -> 20 replaced nothing
  assert.equal(L.item.keys[1].x, 100);
  assert.equal(K.moveBy([L], sel, -500, N), -20);  // stops at frame 0 as a block
  assert.deepEqual(fs(L), [0, 10]);  // the unselected key at 0 was replaced
  assert.equal(new Set(fs(L)).size, fs(L).length);
  assert.equal(K.moveBy([L], sel, NaN, N), 0);
}
{ // scale around t0, merge: later wins, no NaN
  const L = lay(mk([10, 20, 30])), sel = new Set(L.item.keys);
  K.scaleAround([L], sel, 10, 2, N);
  assert.deepEqual(fs(L), [10, 30, 50]);
  K.scaleAround([L], sel, 10, 0.5, N);
  assert.deepEqual(fs(L), [10, 20, 30]);
  K.scaleAround([L], sel, 10, 0.05, N);           // squeezed together: one key survives per frame, the later wins
  assert.ok(fs(L).every(Number.isInteger) && new Set(fs(L)).size === fs(L).length);
  assert.ok(sel.size === L.item.keys.length);
  const M = lay(mk([10, 11])), s2 = new Set(M.item.keys);
  K.scaleAround([M], s2, 0, 0.05, N);             // both round to 1 (0.5, 0.55): later wins
  assert.equal(M.item.keys.length, 1); assert.equal(M.item.keys[0].x, 110);
  K.scaleAround([M], s2, NaN, NaN, N); assert.ok(M.item.keys.every((k) => Number.isFinite(k.f)));
}
{ // snapshot / restore brings back keys a drag pushed over
  const L = lay(mk([0, 10, 20])), sel = new Set([L.item.keys[0]]), snap = K.snapshot([L]);
  K.moveBy([L], sel, 10, N); assert.deepEqual(fs(L), [10, 20]);
  K.restore(snap); assert.deepEqual(fs(L), [0, 10, 20]); assert.equal(L.item.keys[1].x, 100);
}
{ // ease + delete
  const L = lay(mk([0, 10, 20])), sel = new Set([L.item.keys[0], L.item.keys[1]]);
  K.setEase(sel, 'const'); assert.equal(L.item.keys[0].ease, 'const');
  K.setEase(sel, ''); assert.ok(!('ease' in L.item.keys[0]));
  assert.equal(K.remove([L], sel), 2); assert.deepEqual(fs(L), [20]); assert.equal(sel.size, 0);
}
{ // copy / paste offsets, merge, past the end, other layer, no aliasing
  const A = lay(mk([10, 15, 30]), 'a'), B = lay(mk([40]), 'b'), sel = new Set([A.item.keys[0], A.item.keys[1]]);
  const clip = K.copy([A, B], sel);
  assert.deepEqual(clip.groups[0].keys.map((k) => k.f), [10, 15]);
  const r = K.paste([A, B], clip, 40, N, { pick: B });   // onto the picked layer, first key at 40: B's own key at 40 is replaced
  assert.deepEqual(fs(B), [40, 45]); assert.equal(B.item.keys[0].x, 100); assert.equal(r.keys.length, 2);
  assert.deepEqual(fs(A), [10, 15, 30]);
  K.paste([A, B], clip, 10, N);                          // back where they came from, same frames: replaced, not doubled
  assert.deepEqual(fs(A), [10, 15, 30]);
  const r2 = K.paste([A], clip, 97, N); assert.equal(r2.dropped, 1); assert.deepEqual(fs(A), [10, 15, 30, 97]);
  A.item.keys[0].x = -1; assert.equal(clip.groups[0].keys[0].x, 100);
  const cam = lay({ base: {}, keys: [] }, null, 'cam');  // a camera key doesn't go onto an object
  assert.equal(K.paste([cam], clip, 0, N).groups, 0);
}
{ // figure pose onto another figure keeps that figure's own placement
  const mkf = (id, x) => lay({ base: { x }, keys: [{ f: 0, x, ry: 0, j: { a: [1, 2, 3] }, m: { lean: 5 }, pn: 'wave' }] }, id, 'figure', ['x', 'ry', 'j', 'm', 'pn']);
  const A = mkf('a', 1), B = mkf('b', 9), sel = new Set(A.item.keys), clip = K.copy([A, B], sel);
  B.item.keys = [];
  K.paste([A, B], clip, 5, N, { pick: B, fill: (it, names) => ({ x: 9, ry: 33, j: {}, m: {}, pn: 'stand' }) });
  const k = B.item.keys[0]; assert.equal(k.f, 5); assert.equal(k.x, 9); assert.equal(k.ry, 33); assert.deepEqual(k.j, { a: [1, 2, 3] }); assert.equal(k.pn, 'wave');
}
{ // graph channel write
  const k = { f: 0, x: 1 }; K.setChan(k, 'x', 5, k); assert.equal(k.x, 5);
  const m = { f: 0 }; K.setChan(m, 'm.lean', 12, { m: { walk: 50 } }); assert.deepEqual(m.m, { walk: 50, lean: 12 });
  K.setChan(m, 'x', NaN, m); assert.ok(!('x' in m));
}
{ // ease changes the sampled mid value; old ease names are unchanged
  D.setSC({ camera: { base: { px: 0 }, keys: [], ease: 'smooth' }, objects: [] });
  const it = { base: { x: 0 }, ease: 'smooth', keys: [{ f: 0, x: 0 }, { f: 10, x: 100 }] };
  const at = (e, f = 2) => { it.keys[0].ease = e; return D.sample(it, ['x'], f).x; };
  const sm = at('smooth'), li = at('linear'), ein = at('in'), eout = at('out'), co = at('const');
  assert.equal(li, 20); assert.ok(Math.abs(sm - 10.4) < 1e-9); assert.equal(co, 0); assert.ok(ein < li && eout > li);
  delete it.keys[0].ease; assert.equal(D.sample(it, ['x'], 2).x, sm);
  it.ease = 'linear'; assert.equal(D.sample(it, ['x'], 2).x, 20);
  it.keys[0].ease = 'bogus'; assert.equal(D.sample(it, ['x'], 2).x, sm);
  assert.equal(D.sample(it, ['x'], 10).x, 100);
}
{ // old scenes round-trip through upgrade() and sample identically; mute defaults off
  const old = { v: 1, width: 768, height: 448, seconds: 6, blur: 2, camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, keys: [{ f: 0, px: 0 }, { f: 20, px: 4, ease: 'linear' }], ease: 'smooth' },
    objects: [{ id: 'o', type: 'box', name: 'Box', ease: 'linear', keys: [{ f: 0, x: 0 }, { f: 12, x: 6 }], base: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } }] };
  const before = [0, 3, 7, 12, 19].map((f) => [D.sample(old.camera, D.CAM, f), D.sample(old.objects[0], D.OBJ, f)]);
  const up = D.upgrade(JSON.parse(JSON.stringify(old)));
  assert.equal(up.camera.mute, false); assert.equal(up.objects[0].mute, false);
  const after = [0, 3, 7, 12, 19].map((f) => [D.sample(up.camera, D.CAM, f), D.sample(up.objects[0], D.OBJ, f)]);
  const strip = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(strip(after).map(([c, o]) => [c, { ...o, rx: undefined, rz: undefined }]), strip(before).map(([c, o]) => [c, { ...o, rx: undefined, rz: undefined }]));
  assert.deepEqual(JSON.parse(JSON.stringify(D.upgrade(up))), JSON.parse(JSON.stringify(up)));  // idempotent
}
{ // mute: keys ignored on screen, held, writes don't make keys, real keys still reachable, unmute snaps back
  const sc = D.upgrade({ v: 1, camera: { base: { px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45 }, keys: [{ f: 0, px: 0 }, { f: 10, px: 10 }], ease: 'linear' },
    objects: [{ id: 'o', type: 'box', name: 'B', ease: 'linear', keys: [{ f: 0, x: 0 }, { f: 10, x: 10 }], base: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } }] });
  D.setSC(sc); D.R.f = 5; D.R.autoKey = true;
  const o = sc.objects[0];
  D.setMute(o, true);
  assert.equal(D.current(o, ['x'], 5).x, 5);
  D.R.f = 8; assert.equal(D.current(o, ['x'], 8).x, 5);          // held where it was when muted
  D.write(o, D.OBJ, { x: 50 }); assert.equal(o.keys.length, 2); assert.equal(D.current(o, ['x'], 9).x, 50);
  D.addKey(o, D.OBJ); assert.equal(o.keys.length, 3); assert.equal(o.keys.find((k) => k.f === 8).x, 50);  // an explicit key still works
  D.R.real = true; assert.equal(D.current(o, ['x'], 0).x, 0); D.R.real = false;
  D.setMute(sc.camera, true); D.write(sc.camera, D.CAM, { px: -3 });
  assert.equal(sc.camera.keys.length, 2); assert.equal(D.current(sc.camera, D.CAM, 0).px, -3);
  D.setMute(sc.camera, false); assert.equal(D.current(sc.camera, D.CAM, 0).px, 0);
  assert.equal(sc.camera.mute, false);
}
console.log('keys ok');
