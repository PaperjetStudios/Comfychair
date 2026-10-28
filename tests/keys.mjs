// Node test for the key ops (web/keys.js) and sampling/mute/migration (web/scene-data.js). Run by test_keys.py.
import assert from 'node:assert/strict';
globalThis.document = { addEventListener() {}, querySelector() { return null; } };
globalThis.addEventListener = () => {};
const K = await import('../web/keys.js');
const D = await import('../web/scene-data.js');
const F = await import('../web/figure.js');

// an item with one channel x keyed at the frames given (value f * 10)
const mk = (fs, extra = {}) => ({ base: { x: 0 }, ease: 'smooth', chans: { x: fs.map((f) => ({ f, v: f * 10 })) }, ...extra });
const lay = (item, id = 'a', kind = 'obj', ch = 'x') => K.track(item, ch, { id, kind });
const fs = (L) => L.keys.map((k) => k.f);
const N = 100;
const strip = (v) => JSON.parse(JSON.stringify(v));

{ // move: block, clamped, collision replaces unselected, no duplicates
  const L = lay(mk([0, 10, 20, 30])), sel = new Set([L.keys[1], L.keys[2]]);
  assert.equal(K.moveBy([L], sel, 10, N), 10);
  assert.deepEqual(fs(L), [0, 20, 30]);            // key at 30 replaced by the one moved from 20; 10 -> 20 replaced nothing
  assert.equal(L.keys[1].v, 100);
  assert.equal(K.moveBy([L], sel, -500, N), -20);  // stops at frame 0 as a block
  assert.deepEqual(fs(L), [0, 10]);  // the unselected key at 0 was replaced
  assert.equal(new Set(fs(L)).size, fs(L).length);
  assert.equal(K.moveBy([L], sel, NaN, N), 0);
}
{ // scale around t0, merge: later wins, no NaN
  const L = lay(mk([10, 20, 30])), sel = new Set(L.keys);
  K.scaleAround([L], sel, 10, 2, N);
  assert.deepEqual(fs(L), [10, 30, 50]);
  K.scaleAround([L], sel, 10, 0.5, N);
  assert.deepEqual(fs(L), [10, 20, 30]);
  K.scaleAround([L], sel, 10, 0.05, N);           // squeezed together: one key survives per frame, the later wins
  assert.ok(fs(L).every(Number.isInteger) && new Set(fs(L)).size === fs(L).length);
  assert.ok(sel.size === L.keys.length);
  const M = lay(mk([10, 11])), s2 = new Set(M.keys);
  K.scaleAround([M], s2, 0, 0.05, N);             // both round to 1 (0.5, 0.55): later wins
  assert.equal(M.keys.length, 1); assert.equal(M.keys[0].v, 110);
  K.scaleAround([M], s2, NaN, NaN, N); assert.ok(M.keys.every((k) => Number.isFinite(k.f)));
}
{ // snapshot / restore brings back keys a drag pushed over
  const L = lay(mk([0, 10, 20])), sel = new Set([L.keys[0]]), snap = K.snapshot([L]);
  K.moveBy([L], sel, 10, N); assert.deepEqual(fs(L), [10, 20]);
  K.restore(snap); assert.deepEqual(fs(L), [0, 10, 20]); assert.equal(L.keys[1].v, 100);
}
{ // ease + delete; a channel that loses its last key leaves item.chans
  const it = mk([0, 10, 20]), L = lay(it), sel = new Set([L.keys[0], L.keys[1]]);
  K.setEase(sel, 'const'); assert.equal(L.keys[0].ease, 'const');
  K.setEase(sel, ''); assert.ok(!('ease' in L.keys[0]));
  assert.equal(K.remove([L], sel), 2); assert.deepEqual(fs(L), [20]); assert.equal(sel.size, 0);
  sel.add(L.keys[0]); K.remove([L], sel); assert.ok(!('x' in it.chans));
}
{ // moving one channel's key leaves the others where they are (each channel is its own curve)
  const it = { base: { px: 0, py: 0 }, ease: 'linear', chans: { px: [{ f: 0, v: 0 }, { f: 10, v: 10 }], py: [{ f: 0, v: 0 }, { f: 10, v: 5 }] } };
  const tx = lay(it, null, 'cam', 'px'), ty = lay(it, null, 'cam', 'py'), sel = new Set([tx.keys[1]]);
  assert.equal(K.moveBy([tx, ty], sel, 5, N), 5);
  assert.deepEqual(fs(tx), [0, 15]); assert.deepEqual(fs(ty), [0, 10]);
  assert.equal(D.sample(it, ['px', 'py'], 10).py, 5);
  // a summary diamond is every key at that frame: selecting them all moves them all
  const all = new Set([...tx.keys, ...ty.keys].filter((k) => k.f > 0)); K.moveBy([tx, ty], all, 3, N);
  assert.deepEqual(fs(tx), [0, 18]); assert.deepEqual(fs(ty), [0, 13]);
}
{ // copy / paste offsets, merge, past the end, other item, no aliasing
  const A = lay(mk([10, 15, 30]), 'a'), B = lay(mk([40]), 'b'), sel = new Set([A.keys[0], A.keys[1]]);
  const clip = K.copy([A, B], sel);
  assert.deepEqual(clip.groups[0].keys.map((k) => k.f), [10, 15]); assert.equal(clip.groups[0].ch, 'x');
  const r = K.paste([A, B], clip, 40, N, { pick: B });   // onto the picked item, first key at 40: B's own key at 40 is replaced
  assert.deepEqual(fs(B), [40, 45]); assert.equal(B.keys[0].v, 100); assert.equal(r.keys.length, 2);
  assert.deepEqual(fs(A), [10, 15, 30]);
  K.paste([A, B], clip, 10, N);                          // back where they came from, same frames: replaced, not doubled
  assert.deepEqual(fs(A), [10, 15, 30]);
  const r2 = K.paste([A], clip, 97, N); assert.equal(r2.dropped, 1); assert.deepEqual(fs(A), [10, 15, 30, 97]);
  A.keys[0].v = -1; assert.equal(clip.groups[0].keys[0].v, 100);
  const cam = lay({ base: {}, chans: {} }, null, 'cam');  // a camera key doesn't go onto an object
  assert.equal(K.paste([cam], clip, 0, N).groups, 0);
  const py = lay(B.item, 'b', 'obj', 'y');               // a channel goes onto its own name only
  assert.equal(K.paste([py], clip, 0, N).groups, 0);
}
{ // figure pose onto another figure keeps that figure's own placement
  const mkf = (id, x) => {
    const item = { base: { x }, ease: 'smooth', chans: { x: [{ f: 0, v: x }], ry: [{ f: 0, v: 0 }], 'j.lknee': [{ f: 0, v: [1, 2, 3, 4] }], pn: [{ f: 0, v: 'wave' }] } };
    return ['x', 'ry', 'j.lknee', 'pn'].map((ch) => lay(item, id, 'figure', ch));
  };
  const A = mkf('a', 1), B = mkf('b', 9), sel = new Set(A.flatMap((T) => T.keys)), clip = K.copy([...A, ...B], sel);
  B.forEach((T) => { T.keys = []; });
  K.paste([...A, ...B], clip, 5, N, { pick: B[0] });
  assert.equal(B[0].keys.length, 0); assert.equal(B[1].keys.length, 0);             // no x, ry
  assert.deepEqual(B[2].keys[0].v, [1, 2, 3, 4]); assert.equal(B[3].keys[0].v, 'wave'); assert.equal(B[3].keys[0].f, 5);
}
{ // graph channel write
  const k = { f: 0, v: 1 }; K.setChan(k, 5); assert.equal(k.v, 5);
  K.setChan(k, NaN); assert.equal(k.v, 5);
  assert.ok(K.isScalar('m.lean') && K.isScalar('x') && !K.isScalar('j.lknee') && !K.isScalar('pn'));
}
{ // ease changes the sampled mid value; old ease names are unchanged
  D.setSC({ camera: { base: { px: 0 }, chans: {}, ease: 'smooth' }, objects: [] });
  const it = { base: { x: 0 }, ease: 'smooth', chans: { x: [{ f: 0, v: 0 }, { f: 10, v: 100 }] } };
  const at = (e, f = 2) => { it.chans.x[0].ease = e; return D.sample(it, ['x'], f).x; };
  const sm = at('smooth'), li = at('linear'), ein = at('in'), eout = at('out'), co = at('const');
  assert.equal(li, 20); assert.ok(Math.abs(sm - 10.4) < 1e-9); assert.equal(co, 0); assert.ok(ein < li && eout > li);
  delete it.chans.x[0].ease; assert.equal(D.sample(it, ['x'], 2).x, sm);
  it.ease = 'linear'; assert.equal(D.sample(it, ['x'], 2).x, 20);
  it.chans.x[0].ease = 'bogus'; assert.equal(D.sample(it, ['x'], 2).x, sm);
  assert.equal(D.sample(it, ['x'], 10).x, 100);
}
{ // channels sample on their own keys: each has its own frames and eases; an unkeyed one holds the base
  const it = { base: { x: 1, y: 2, z: 3 }, ease: 'linear', chans: { x: [{ f: 0, v: 0 }, { f: 10, v: 10 }], y: [{ f: 5, v: 0 }, { f: 15, v: 100, ease: 'const' }, { f: 25, v: 0 }] } };
  const s = (f) => D.sample(it, ['x', 'y', 'z'], f);
  assert.deepEqual(s(0), { x: 0, y: 0, z: 3 }); assert.deepEqual(s(5), { x: 5, y: 0, z: 3 });
  assert.equal(s(10).y, 50); assert.equal(s(20).y, 100);       // (the key at 15 is const: it holds 100 until 25)
  assert.equal(s(40).x, 10); assert.equal(s(40).y, 0);
}
{ // poses: one joint keyed on its own slerps while the rest stay at the base pose; parameters per name; the pose name steps
  const q = (deg) => { const r = deg * Math.PI / 360; return [Math.sin(r), 0, 0, Math.cos(r)]; };
  const it = { base: { j: { lknee: q(0), rknee: q(30) }, m: { lean: 10 }, pn: 'stand' }, ease: 'linear',
    chans: { 'j.lknee': [{ f: 0, v: q(0) }, { f: 10, v: q(90) }], 'm.lean': [{ f: 0, v: 0 }, { f: 10, v: 20 }], pn: [{ f: 0, v: 'a' }, { f: 10, v: 'b' }] } };
  const v = D.sample(it, ['j', 'm', 'pn'], 5);
  assert.ok(v.j.lknee.every((x, i) => Math.abs(x - q(45)[i]) < 1e-6)); assert.deepEqual(v.j.rknee, q(30));
  assert.equal(v.m.lean, 10); assert.equal(D.sample(it, ['pn'], 4).pn, 'a'); assert.equal(D.sample(it, ['pn'], 6).pn, 'b');
  assert.deepEqual(D.sample({ base: { j: { a: q(5) }, m: {}, pn: 'p' }, chans: {} }, ['j', 'm', 'pn'], 3), { j: { a: q(5) }, m: {}, pn: 'p' });
}
{ // old scenes (whole-item keys) migrate on upgrade() and sample identically; saved in the new form; idempotent; mute defaults off
  const q = (deg) => { const r = deg * Math.PI / 360; return [Math.sin(r), 0, 0, Math.cos(r)]; };
  const old = { v: 1, width: 768, height: 448, seconds: 6, blur: 2,
    camera: { base: { px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, ease: 'smooth',
      keys: [{ f: 0, px: 0, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45 }, { f: 20, px: 4, py: 1.6, pz: 5, tx: 0, ty: 1, tz: 0, fov: 45, ease: 'linear' }, { f: 30, px: 4, py: 3, pz: 5, tx: 0, ty: 1, tz: 0, fov: 60, roll: 20 }] },
    objects: [{ id: 'o', type: 'box', name: 'Box', ease: 'linear', keys: [{ f: 0, x: 0 }, { f: 12, x: 6 }], base: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } },
      { id: 'p', type: 'figure', name: 'Fig', ease: 'smooth', base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lknee: q(0) }, m: { lean: 5 }, pn: 'stand' },
        keys: [{ f: 0, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lknee: q(0), rknee: q(10) }, m: { lean: 5 }, pn: 'stand' },
          { f: 8, x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lknee: q(80) }, m: {}, pn: 'sit', ease: 'in' },
          { f: 20, x: 1, y: 0, z: 2, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lknee: q(0), rknee: q(10) }, m: { lean: 5, side: 8 }, pn: 'stand' }] }] };
  const fig = old.objects[1];
  // what the old whole-key sampler gave (the one in the commit before this change), written out here as the reference
  const oldSample = (item, names, f) => {
    const k = item.keys, z = names.includes('roll') ? { roll: 0 } : null, pick = (o) => Object.fromEntries(names.map((n) => [n, o[n]]));
    if (f <= k[0].f) return pick({ ...z, ...item.base, ...k[0] });
    const last = k[k.length - 1];
    if (f >= last.f) return pick({ ...z, ...item.base, ...last });
    let i = 0; while (k[i + 1].f <= f) i++;
    const a = { ...z, ...item.base, ...k[i] }, b = { ...z, ...item.base, ...k[i + 1] };
    const e = K.easeAt(k[i].ease || item.ease, (f - a.f) / (b.f - a.f));
    return Object.fromEntries(names.map((n) => [n, n === 'j' ? F.slerpPose(a.j, b.j, e) : n === 'm' ? F.lerpParams(a.m, b.m, e) : n === 'pn' ? (e < 0.5 ? a.pn : b.pn) : a[n] + (b[n] - a[n]) * e]));
  };
  const cases = [[old.camera, D.CAM], [old.objects[0], D.OBJ], [fig, D.FIG]];
  const frames = [0, 1, 3, 7, 8, 9, 12, 15, 19, 20, 25, 29, 30, 40];
  const before = cases.map(([it, names]) => frames.map((f) => strip(oldSample(it, names, f))));
  const up = D.upgrade(strip(old));
  assert.equal(up.camera.mute, false); assert.equal(up.objects[0].mute, false);
  assert.ok(!('keys' in up.camera) && !up.objects.some((o) => 'keys' in o));        // saved in the new form
  const now = [[up.camera, D.CAM], [up.objects[0], D.OBJ], [up.objects[1], D.FIG]].map(([it, names]) => frames.map((f) => strip(D.sample(it, names, f))));
  const near = (a, b, path = '') => {
    if (typeof a === 'number') return assert.ok(Math.abs(a - b) < 1e-9, `${path}: ${a} vs ${b}`);
    if (a && typeof a === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) near(a[k] ?? (typeof b[k] === 'number' ? 0 : undefined), b[k] ?? (typeof a[k] === 'number' ? 0 : undefined), `${path}.${k}`); return; }
    assert.equal(a, b, path);
  };
  cases.forEach((c, i) => frames.forEach((f, j) => { if (i === 2) { delete before[i][j].rx; } near(now[i][j], before[i][j], `case ${i} frame ${f}`); }));
  // the channels that never left the base are not keys
  assert.deepEqual(Object.keys(up.camera.chans).sort(), ['fov', 'px', 'py', 'roll']);   // (tx, ty, tz, pz stay put; roll is new at the last key)
  assert.ok('j.rknee' in up.objects[1].chans && 'j.lknee' in up.objects[1].chans && !('y' in up.objects[1].chans));   // (y never moves)
  assert.deepEqual(up.objects[1].chans['m.side'].map((k) => [k.f, k.v]), [[0, 0], [8, 0], [20, 8]]);
  assert.equal(up.objects[1].chans.x[1].ease, 'in'); assert.equal(up.camera.chans.px[1].ease, 'linear');
  const again = strip(up); D.upgrade(again); assert.deepEqual(again, strip(up));     // idempotent
  // an old animated item whose keys all equal the base stays animated
  const still = D.upgrade({ v: 1, objects: [{ id: 's', type: 'box', name: 'S', ease: 'smooth', base: { x: 1 }, keys: [{ f: 0, x: 1 }, { f: 9, x: 1 }] }] });
  assert.ok(D.hasKeys(still.objects[0]));
}
{ // mute: keys ignored on screen, held, writes don't make keys, real keys still reachable, unmute snaps back
  const sc = D.upgrade({ v: 1, camera: { base: { px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45 }, keys: [{ f: 0, px: 0 }, { f: 10, px: 10 }], ease: 'linear' },
    objects: [{ id: 'o', type: 'box', name: 'B', ease: 'linear', keys: [{ f: 0, x: 0 }, { f: 10, x: 10 }], base: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } }] });
  D.setSC(sc); D.R.f = 5; D.R.autoKey = true;
  const o = sc.objects[0];
  D.setMute(o, true);
  assert.equal(D.current(o, ['x'], 5).x, 5);
  D.R.f = 8; assert.equal(D.current(o, ['x'], 8).x, 5);          // held where it was when muted
  D.write(o, D.OBJ, { x: 50 }); assert.equal(o.chans.x.length, 2); assert.equal(D.current(o, ['x'], 9).x, 50);
  D.addKey(o, D.OBJ); assert.equal(o.chans.x.length, 3); assert.equal(o.chans.x.find((k) => k.f === 8).v, 50);  // an explicit key still works
  D.R.real = true; assert.equal(D.current(o, ['x'], 0).x, 0); D.R.real = false;
  D.setMute(sc.camera, true); D.write(sc.camera, D.CAM, { px: -3 });
  assert.equal(sc.camera.chans.px.length, 2); assert.equal(D.current(sc.camera, D.CAM, 0).px, -3);
  D.setMute(sc.camera, false); assert.equal(D.current(sc.camera, D.CAM, 0).px, 0);
  assert.equal(sc.camera.mute, false);
}
{ // keying only what changed: auto key writes the channels that moved; ◆ Key (nothing held) keys them all; held changes key their own
  const sc = D.upgrade({ v: 1, camera: { base: { px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 }, ease: 'linear', keys: [{ f: 0, px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 }, { f: 10, px: 10, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 }] },
    objects: [] });
  D.setSC(sc); D.R.autoKey = true; D.R.mute = false;
  const cam = sc.camera;
  assert.deepEqual(Object.keys(cam.chans), ['px']);               // (the rest never moved)
  D.R.f = 4; D.write(cam, D.CAM, { px: 4, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 });     // a whole camera written back, only px differs from nothing: no change
  assert.equal(cam.chans.px.length, 2);
  D.write(cam, D.CAM, { px: 7, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 });
  assert.deepEqual(cam.chans.px.map((k) => [k.f, k.v]), [[0, 0], [4, 7], [10, 10]]); assert.deepEqual(Object.keys(cam.chans), ['px']);
  D.write(cam, D.CAM, { fov: 70 });                                // the lens: its own channel, one key at the playhead
  assert.deepEqual(cam.chans.fov, [{ f: 4, v: 70 }]); assert.equal(cam.chans.px.length, 3);
  D.write(cam, D.CAM, { py: 2.5, tz: 1 });
  assert.deepEqual(Object.keys(cam.chans).sort(), ['fov', 'px', 'py', 'tz']);
  D.addKey(cam, D.CAM);                                            // key all
  assert.ok(D.CAM.every((c) => cam.chans[c].some((k) => k.f === 4)));
  // held changes (auto key off): ◆ Key keeps only what was changed
  D.R.autoKey = false; D.R.f = 8;
  D.write(cam, D.CAM, { pz: 9 });
  assert.equal(D.current(cam, D.CAM).pz, 9); assert.ok(D.TEMP.get(cam).ch.has('pz') && D.TEMP.get(cam).ch.size === 1);
  assert.ok(!cam.chans.pz.some((k) => k.f === 8));
  D.addKey(cam, D.CAM);
  assert.ok(cam.chans.pz.some((k) => k.f === 8 && k.v === 9)); assert.ok(!cam.chans.px.some((k) => k.f === 8)); assert.ok(!D.TEMP.has(cam));
  D.R.autoKey = true;
  // an unanimated item writes into its base
  const o = { base: { x: 0 }, chans: {}, ease: 'smooth' }; D.write(o, ['x'], { x: 3 }); assert.equal(o.base.x, 3); assert.ok(!D.hasKeys(o));
  // frames and removal
  assert.deepEqual(D.keyFrames(cam), [0, 4, 8, 10]); assert.ok(D.keyAt(cam, 8)); assert.equal(D.nextKeyFrame(cam, 4), 8); assert.equal(D.nextKeyFrame(cam, 4, -1), 0);
  D.dropKeys(cam, (f) => f === 4); assert.ok(!D.keyAt(cam, 4)); assert.ok(!('fov' in cam.chans) && !('py' in cam.chans));
}
{ // a figure: rotating one joint keys only that joint; a pose preset keys the joints it changes; putKeys (moves, motion) skips what stays put
  const q = (deg) => { const r = deg * Math.PI / 360; return [Math.sin(r), 0, 0, Math.cos(r)]; };
  const fig = D.upgrade({ v: 1, objects: [{ id: 'f', type: 'figure', name: 'F', ease: 'linear', keys: [{ f: 0, x: 0, j: { lknee: q(0), rknee: q(0) }, m: {}, pn: 's' }, { f: 10, x: 5, j: { lknee: q(0), rknee: q(0) }, m: {}, pn: 's' }],
    base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lknee: q(0), rknee: q(0) }, m: {}, pn: 's' } }] }).objects[0];
  D.setSC({ camera: { base: {}, chans: {} }, objects: [fig] }); D.R.autoKey = true; D.R.f = 3;
  assert.deepEqual(Object.keys(fig.chans), ['x']);
  const j = { ...D.current(fig, D.FIG).j, lknee: q(40) };
  D.write(fig, D.FIG, { j });
  assert.deepEqual(Object.keys(fig.chans).sort(), ['j.lknee', 'x']); assert.deepEqual(fig.chans['j.lknee'], [{ f: 3, v: q(40) }]);
  D.write(fig, D.FIG, { j: { lknee: q(40) } });                       // rknee dropped from the pose: it is at rest, which is what it was
  assert.deepEqual(Object.keys(fig.chans).sort(), ['j.lknee', 'x']);
  D.write(fig, D.FIG, { m: { lean: 12 } }); assert.deepEqual(fig.chans['m.lean'], [{ f: 3, v: 12 }]);
  D.R.f = 6; D.putKeys(fig, [{ f: 6, x: 2, y: 0, j: { lknee: q(10), rknee: q(0) }, m: { lean: 12 }, pn: 's', ease: 'linear' }, { f: 9, x: 3, y: 0, j: { lknee: q(20), rknee: q(0) }, m: { lean: 12 }, pn: 's' }], D.FIG);
  assert.ok(!('y' in fig.chans) && !('j.rknee' in fig.chans) && !('pn' in fig.chans));     // unchanged: no rows for them
  assert.deepEqual(fig.chans.x.map((k) => k.f), [0, 6, 9, 10]); assert.equal(fig.chans.x[1].ease, 'linear');
  assert.deepEqual(fig.chans['j.lknee'].map((k) => k.f), [3, 6, 9]);
}
console.log('keys ok');

{ // camera roll: eased like the rest, missing reads 0 (old scenes and keys), written with the camera's values
  const cam = { base: { px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45 }, keys: [{ f: 0, px: 0 }, { f: 10, px: 10, roll: 30, ease: 'linear' }], ease: 'linear' };
  const up = D.upgrade({ v: 1, camera: strip(cam), objects: [] }).camera;
  assert.equal(D.sample(up, D.CAM, 0).roll, 0);         // no roll at the first key: 0, never NaN
  assert.equal(D.sample({ ...up, chans: {} }, D.CAM, 3).roll, 0);
  assert.equal(D.sample(up, D.CAM, 5).roll, 15);        // a missing roll on the first key is 0, so it eases from there
  assert.equal(D.sample(up, D.CAM, 20).roll, 30);
  assert.equal(D.sample({ ...up, base: { ...up.base, roll: 10 }, chans: {} }, D.CAM, 0).roll, 10);
  assert.equal(D.sample(up, D.OBJ.concat(['px']), 5).roll, undefined);   // objects don't gain a roll
  assert.ok(D.CAM.includes('roll') && K.isScalar('roll'));
}

{ // live recording: runs replace keys in their span, thinned to every n frames, the last sample kept
  const list = [{ f: 0, v: 0 }, { f: 10, v: 1 }, { f: 20, v: 2 }, { f: 40, v: 4 }];
  const s = [8, 9, 10, 11, 12, 13, 14, 15, 16].map((f) => ({ f, v: f * 100 }));
  const out = K.recordInto(list, s, 3);
  assert.deepEqual(out.map((k) => k.f), [0, 8, 11, 14, 16, 20, 40]);   // 10 (inside 8..16) replaced
  assert.equal(out.find((k) => k.f === 16).v, 1600);
  assert.equal(list.length, 4);                                           // (a new list: the old one is untouched)
  // skipped frames (a slow tablet): counted in frames, not samples
  assert.deepEqual(K.recordInto([], [0, 2, 4, 6, 8].map((f) => ({ f, v: f })), 3).map((k) => k.f), [0, 4, 8]);
  // the loop wraps: two runs, each replaces its own span; the same frame twice keeps the newer value
  const w = K.recordInto([{ f: 1, v: 'a' }, { f: 50, v: 'b' }, { f: 95, v: 'c' }], [90, 93, 96, 99, 0, 0, 2, 4].map((f, i) => ({ f, v: i })), 3);
  assert.deepEqual(w.map((k) => k.f), [0, 4, 50, 90, 93, 96, 99]);
  assert.equal(w.find((k) => k.f === 0).v, 5);
  // a quaternion is copied, nothing odd gets in
  const q = [0, 0, 0, 1], r = K.recordInto(null, [{ f: 3, v: q }, null, { f: NaN, v: 1 }]);
  assert.deepEqual(r, [{ f: 3, v: q }]); assert.notEqual(r[0].v, q);
}
{ // edits while it plays: held over the keys while a source holds them, then keyed
  const o = { id: 'h', type: 'box', base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, ease: 'linear', chans: { x: [{ f: 0, v: 0 }, { f: 40, v: 40 }] } };
  D.setSC({ seconds: 6, camera: { base: { px: 0, py: 1, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, roll: 0 }, chans: {} }, objects: [o] });
  D.R.autoKey = true; D.R.record = false; D.R.playing = true; D.WP.back = false; D.R.f = 10;
  D.holdStart('gizmo');
  D.write(o, D.OBJ, { ...D.current(o, D.OBJ), x: 7, y: 2 });
  assert.deepEqual(o.chans.x.map((k) => k.f), [0, 40]);                 // nothing keyed yet
  D.R.f = 20;
  assert.equal(D.current(o, D.OBJ).x, 7); assert.equal(D.current(o, D.OBJ).y, 2);   // held, not driven by its keys
  assert.equal(D.current(o, D.OBJ).rx, 0);
  assert.equal(D.holdEnd('other'), null);                                // (a source that wasn't holding changes nothing)
  D.R.f = 22;
  assert.equal(D.holdEnd('gizmo'), null);                                // no jump back: lands at the release frame
  assert.deepEqual(o.chans.x.map((k) => k.f), [0, 22, 40]);
  assert.equal(o.chans.y[0].f, 22); assert.equal(o.chans.y[0].v, 2);
  assert.equal(D.HOLD.items.size, 0); assert.equal(D.current(o, D.OBJ, 30).x, 7 + (40 - 7) * (8 / 18));
  // jump back: the key goes where the hold began, and that frame is handed back
  D.WP.back = true; D.R.f = 5; D.holdStart('panel'); D.write(o, D.OBJ, { x: -3 }); D.R.f = 12;
  assert.equal(D.holdEnd('panel'), 5);
  assert.equal(o.chans.x.find((k) => k.f === 5).v, -3); assert.ok(!o.chans.x.some((k) => k.f === 12));
  // Record: keys every 3 frames over the span held, the keys inside it replaced
  D.R.record = true; D.R.f = 24; D.holdStart('gizmo');
  for (let f = 24; f <= 34; f++) { D.R.f = f; D.write(o, D.OBJ, { x: 100 + f }); D.recordFrame(f); }
  assert.equal(D.holdEnd('gizmo'), 24);
  assert.deepEqual(o.chans.x.map((k) => k.f), [0, 5, 22, 24, 27, 30, 33, 34, 40]);
  assert.equal(o.chans.x.find((k) => k.f === 30).v, 130);
  // Record on a layer with no keys: it becomes animated (from the first frame it moved)
  const b = { id: 'b', type: 'box', base: { x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, ease: 'smooth', chans: {} };
  D.SC.objects.push(b); D.R.f = 0; D.holdStart('gizmo');
  for (let f = 0; f <= 6; f++) { D.R.f = f; D.write(b, D.OBJ, { z: f }); D.recordFrame(f); }
  D.holdEnd('gizmo');
  assert.deepEqual(b.chans.z.map((k) => k.f), [1, 4, 6]); assert.ok(!b.chans.x);
  // Auto key off: an animated layer is only held (TEMP), on every frame while it plays, until ◆ Key
  D.R.record = false; D.R.autoKey = false; D.R.f = 3; D.holdStart('gizmo'); D.write(o, D.OBJ, { y: 9 }); D.holdEnd('gizmo');
  assert.ok(!o.chans.y.some((k) => k.f === 3) && D.TEMP.has(o));
  D.R.f = 17; assert.equal(D.current(o, D.OBJ).y, 9); assert.equal(D.current(o, D.OBJ).x, D.sample(o, D.OBJ, 17).x);   // the rest plays on
  D.addKey(o, D.OBJ); assert.equal(o.chans.y.find((k) => k.f === 17).v, 9); assert.ok(!o.chans.x.some((k) => k.f === 17));
  // not animated, no Record: written straight into the base, never held
  const c = { id: 'c', type: 'box', base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }, ease: 'smooth', chans: {} };
  D.SC.objects.push(c); D.R.autoKey = true; D.holdStart('gizmo'); D.write(c, D.OBJ, { x: 4 });
  assert.equal(c.base.x, 4); assert.equal(D.HOLD.items.size, 0); D.holdEnd('gizmo');
  D.R.playing = false; D.TEMP.clear(); D.dropHolds();
}
console.log('record ok');

{ // stretch every key to a new length: from frame 0, rounded, merged (later wins), inside the new end
  const cam = { chans: { px: [{ f: 0, v: 0 }, { f: 10, v: 1 }, { f: 148, v: 2 }], fov: [{ f: 74, v: 40, ease: 'linear' }] } };
  const fig = { chans: { 'j.lknee': [{ f: 20, v: [0, 0, 0, 1] }, { f: 40, v: [0, 0.1, 0, 0.99] }], 'j.lthumb1': [{ f: 3, v: [0, 0, 0, 1] }], 'm.phase': [{ f: 0, v: 0 }, { f: 100, v: 4 }] } };
  const none = { chans: {} };
  const k = K.stretchAll([cam, fig, none, { base: {} }], 149, 221);
  assert.ok(Math.abs(k - 221 / 149) < 1e-12);
  assert.deepEqual(cam.chans.px.map((x) => x.f), [0, 15, 220]);   // (the last frame stays the last)
  assert.equal(cam.chans.fov[0].f, 110); assert.equal(cam.chans.fov[0].ease, 'linear');   // (a key keeps its ease and value)
  assert.deepEqual(fig.chans['j.lknee'].map((x) => x.f), [30, 59]); assert.deepEqual(fig.chans['j.lknee'][1].v, [0, 0.1, 0, 0.99]);
  assert.equal(fig.chans['j.lthumb1'][0].f, 4); assert.deepEqual(fig.chans['m.phase'].map((x) => x.f), [0, 148]);
  // squeezed: keys that meet merge, the later one's value wins; never past the end
  const sq = { chans: { x: [{ f: 0, v: 'a' }, { f: 1, v: 'b' }, { f: 2, v: 'c' }, { f: 200, v: 'd' }] } };
  K.stretchAll([sq], 221, 54);
  assert.deepEqual(sq.chans.x.map((x) => [x.f, x.v]), [[0, 'c'], [49, 'd']]);
  const far = { chans: { x: [{ f: 140, v: 1 }] } }; K.stretchAll([far], 149, 300); assert.equal(far.chans.x[0].f, 282);
  const end = { chans: { x: [{ f: 148, v: 1 }] } }; K.stretchAll([end], 149, 400); assert.equal(end.chans.x[0].f, 397);
  assert.equal(K.keysPast([cam, fig], 100), 3); assert.equal(K.keysPast([cam, fig, none], 300), 0);
}
console.log('stretch ok');

{ // curves: auto, clamp, bezier handles solved in time; old eases unchanged
  const S = (l, f, ease = 'smooth') => K.sampleKeys(l, f, { ease });
  const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
  const old = [{ f: 0, v: 0 }, { f: 10, v: 10 }];
  close(S(old, 5), 5); close(S(old, 2), 10 * (0.04 * (3 - 0.4))); close(S([{ f: 0, v: 0, ease: 'linear' }, { f: 10, v: 10 }], 3), 3);
  // auto through a straight line is the line (thirds: no solve), ends flat
  const line = [0, 10, 20, 30].map((f) => ({ f, v: f * 2, ease: 'auto' }));
  close(S(line, 15), 30); close(S(line, 12.5), 25);
  assert.equal(K.handleOf(line, 0, 'to')[1], 0);   // an end key is flat
  // auto overshoots a peak, clamp doesn't
  const peak = (e) => [{ f: 0, v: 0, ease: e }, { f: 10, v: 10, ease: e }, { f: 12, v: 10, ease: e }, { f: 20, v: 0, ease: e }];
  let maxA = -Infinity, maxC = -Infinity;
  for (let f = 0; f <= 20; f += 0.25) { maxA = Math.max(maxA, S(peak('auto'), f)); maxC = Math.max(maxC, S(peak('clamp'), f)); }
  assert.ok(maxA > 10.01); close(maxC, 10, 1e-9);
  // the curve passes its keys exactly
  for (const k of peak('clamp')) close(S(peak('clamp'), k.f), k.v);
  // bezier: setEase keeps the curve where it was, then a dragged handle bends it; x solved in time (monotone in f)
  const L = K.track({ chans: { x: peak('auto') } }, 'x'), before = [...Array(21)].map((_, f) => S(L.keys, f));
  K.setEase(new Set(L.keys), 'bezier', [L]);
  assert.ok(L.keys.every((k) => Array.isArray(k.ti) && Array.isArray(k.to)));
  before.forEach((v, f) => close(S(L.keys, f), v, 1e-6));
  K.moveHandle(L.keys, 1, 'to', 1.8, 6);   // aligned: the in handle turns to the same slope
  close(L.keys[1].ti[1] / L.keys[1].ti[0], 6 / 1.8);
  K.setBroken(new Set([L.keys[1]]), true); K.moveHandle(L.keys, 1, 'ti', -3, 0);
  close(L.keys[1].to[1], 6);   // broken: the other stays
  close(S(L.keys, 10), 10); close(S(L.keys, 12), 10);
  // handles longer than the segment are shortened, the curve still a function of time
  K.moveHandle(L.keys, 1, 'to', 50, 0); K.moveHandle(L.keys, 2, 'ti', -50, 0);
  for (let f = 10; f <= 12; f += 0.1) assert.ok(Number.isFinite(S(L.keys, f)) && Math.abs(S(L.keys, f) - 10) < 1e-6);
  // back to auto drops the handles
  K.setEase(new Set(L.keys), 'auto', [L]); assert.ok(L.keys.every((k) => !k.ti && !k.to && !k.hb));
  // joints (non-numbers) under a curve ease blend smooth
  const q = [{ f: 0, v: 'a', ease: 'bezier' }, { f: 10, v: 'b' }];
  assert.equal(K.sampleKeys(q, 4, { lerp: (a, b, e) => (e < 0.5 ? a : b) }), 'a');
  // speed: 10k samples of a 500-key bezier channel
  const big = [...Array(500)].map((_, i) => ({ f: i * 2, v: Math.sin(i / 7), ease: 'bezier', to: [0.5, 0.1], ti: [-0.9, -0.2] }));
  const t0 = performance.now(); let s = 0; for (let i = 0; i < 10000; i++) s += S(big, (i * 0.0997) % 998);
  assert.ok(Number.isFinite(s) && performance.now() - t0 < 200, `slow: ${performance.now() - t0} ms`);
}
console.log('curves ok');

{ // the offset layer: shown on top of the keys, edits under it go back to key space, the gizmo on it, bake
  const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
  const walk = [0, 10, 20].map((f) => ({ f, v: f / 10, ease: 'linear' }));   // walks 2 m along +X
  const o = { id: 'w', type: 'figure', ease: 'smooth', base: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, j: { lsho: [0, 0, 0, 1] } },
    chans: { x: walk, ry: [{ f: 0, v: 0 }, { f: 20, v: 0 }] } };
  D.setSC({ seconds: 6, camera: { base: {}, chans: {} }, objects: [o] }); D.R.autoKey = true; D.R.f = 0; D.R.real = false; D.TEMP.clear();
  o.off = D.newOffset(o, 0);
  assert.deepEqual(o.off.pv, [0, 0, 0]);
  const keysBefore = strip(o.chans);
  // turned 90° on Y around where it started: the walk now goes along -Z
  D.setOffset(o, { ry: 90 });
  let v = D.current(o, D.OBJ, 20);
  close(v.x, 0); close(v.z, -2); close(v.ry, 90);
  assert.deepEqual(strip(o.chans), keysBefore);   // the keys are untouched
  assert.equal(D.sample(o, D.OBJ, 20).x, 2);
  // the gizmo on the offset: put the figure at (5, 0, 5) at frame 10 → the whole path slides
  D.R.offEdit = 'w'; D.R.f = 10;
  D.write(o, D.FIG, { ...D.current(o, D.OBJ, 10), x: 5, z: 5 });
  v = D.current(o, D.OBJ, 10); close(v.x, 5); close(v.z, 5);
  v = D.current(o, D.OBJ, 20); close(v.x, 5); close(v.z, 4);   // one more metre along -Z
  assert.deepEqual(strip(o.chans), keysBefore);
  // scale it: twice the size, the path twice as long (from where it stands now)
  D.write(o, D.FIG, { ...D.current(o, D.OBJ, 10), sx: 2, sy: 2, sz: 2 });
  close(D.current(o, D.OBJ, 10).x, 5); close(D.current(o, D.OBJ, 20).z, 3); close(D.current(o, D.OBJ, 20).sy, 2);
  // without offset editing, a move goes into the keys, in key space (shown 1 m further along -Z = 0.5 m of key X at 2x)
  D.R.offEdit = null;
  D.write(o, D.FIG, { z: D.current(o, D.OBJ, 10).z - 1 });
  close(D.sample(o, D.OBJ, 10).x, 1.5); close(D.current(o, D.OBJ, 10).z, 4);
  // a joint offset turns that joint on every frame, its keys kept
  D.R.offEdit = 'w';
  const q = [Math.sin(0.25), 0, 0, Math.cos(0.25)];
  D.write(o, D.FIG, { j: { ...D.current(o, D.FIG).j, lsho: q } });
  D.current(o, D.FIG, 0).j.lsho.forEach((x, i) => close(x, q[i]));
  assert.deepEqual(o.base.j.lsho, [0, 0, 0, 1]);
  // the offset keyed sparsely: two keys, it slides between them
  D.R.f = 0; D.keyOffset(o); D.R.f = 20; D.setOffset(o, { x: D.offAt(o, 20).x + 1 });
  close(D.offAt(o, 10).x - D.offAt(o, 0).x, 0.5, 1e-9);
  // bake: what shows stays, the offset goes
  const shown = [0, 4, 10, 15, 20].map((f) => strip(D.current(o, D.FIG, f)));
  D.bakeOffset(o);
  assert.ok(!o.off);
  [0, 10, 20].forEach((f, i) => { const now = D.current(o, D.FIG, f), was = shown[[0, 2, 4][i]]; for (const k of D.OBJ) close(now[k], was[k], 1e-6); });
  assert.ok(o.chans['j.lsho'] || o.base.j.lsho[0] > 0.1);
  // a turn that isn't flat comes back as numbers near the keys' own (no 180 / x / 180 flip)
  const b = { id: 'b', type: 'box', ease: 'smooth', base: { x: 0, y: 0, z: 0, rx: 10, ry: 170, rz: 0, sx: 1, sy: 1, sz: 1 }, chans: {} };
  b.off = D.newOffset(b, 0); D.setOffset(b, { rx: 5 });
  v = D.current(b, D.OBJ, 0); assert.ok(Math.abs(v.ry - 170) < 20, JSON.stringify(v));
  D.R.offEdit = null;
}
console.log('offset ok');

{ // reduce: far fewer keys, every frame within tolerance, ends and unpicked keys kept, the same key objects
  const dense = [...Array(61)].map((_, i) => ({ f: i * 2, v: Math.sin(i / 6) * 2 + i * 0.01, ease: 'linear' }));
  const want = (l, f) => K.sampleKeys(l, f, { ease: 'smooth' });
  for (const as of ['clamp', 'linear']) {
    const copy = strip(dense), out = K.reduceKeys(copy, 0.05, { as });
    assert.ok(out.length < copy.length / 2.5, `${as}: ${out.length}`);
    for (const k of dense) assert.ok(Math.abs(want(out, k.f) - k.v) <= 0.05 + 1e-9, `${as} f${k.f}`);
    assert.equal(out[0], copy[0]); assert.equal(out[out.length - 1], copy[copy.length - 1]);
    assert.ok(out.every((k) => k.ease === as));
  }
  // a looser tolerance keeps fewer; zero keeps what is needed for an exact curve (a straight run thins to its ends)
  const line = [...Array(20)].map((_, i) => ({ f: i, v: i * 3, ease: 'linear' }));
  assert.equal(K.reduceKeys(line, 0, { as: 'linear' }).length, 2);
  assert.ok(K.reduceKeys(strip(dense), 0.2).length < K.reduceKeys(strip(dense), 0.01).length);
  // only the picked keys can go; dry leaves eases alone
  const c2 = strip(dense), pick = new Set(c2.slice(10, 30)), out2 = K.reduceKeys(c2, 0.05, { pick, dry: true });
  assert.ok(c2.filter((k) => !pick.has(k)).every((k) => out2.includes(k)));
  assert.ok(c2.every((k) => k.ease === 'linear'));
  // joints: the error in degrees between turns
  const q = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
  const jl = [...Array(30)].map((_, i) => ({ f: i, v: q(i < 15 ? i * 0.05 : 0.75), ease: 'linear' }));
  const slerp = F.slerpQ, jo = K.reduceKeys(jl, 0.5, { as: 'linear', lerp: slerp, dist: K.quatDeg });
  assert.ok(jo.length <= 4, `${jo.length}`);
  for (let f = 0; f < 30; f++) assert.ok(K.quatDeg(K.sampleKeys(jo, f, { lerp: slerp }), K.sampleKeys(jl, f, { lerp: slerp })) <= 0.5 + 1e-6);
  assert.ok(Math.abs(K.quatDeg(q(0), q(Math.PI / 2)) - 90) < 1e-6);
  // short lists come back as they are
  assert.equal(K.reduceKeys([{ f: 0, v: 1 }, { f: 3, v: 9 }], 1).length, 2);
}
console.log('reduce ok');

{ // cameras: an old scene's one camera is the active one; another made active swaps places
  const sc = D.upgrade({ camera: { base: { px: 1, py: 1, pz: 1, tx: 0, ty: 0, tz: 0, fov: 40 }, keys: [{ f: 0, px: 1 }, { f: 9, px: 4 }] }, objects: [] });
  assert.deepEqual(sc.cams, []); assert.equal(sc.camera.name, 'Camera'); assert.equal(sc.camera.chans.px.length, 2);
  D.setSC(sc); D.R.f = 0;
  const b = D.newCamera('B'); sc.cams.push(b);
  assert.equal(b.base.px, 1); assert.deepEqual(b.chans, {});
  const a = sc.camera;
  assert.ok(D.setActiveCam(b)); assert.equal(sc.camera, b); assert.deepEqual(sc.cams, [a]);
  assert.ok(!D.setActiveCam(b)); assert.deepEqual(D.camsOf(), [b, a]);
}
console.log('cameras ok');
