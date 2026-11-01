// node --test tests/char_model.test.mjs: a character's looks, media, results and staleness (web/char-model.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../web/char-model.js';
import { refPicture, castLines, packPictures, mainOf } from '../web/cast.js';

const old = () => ({ id: 'c', rev: 3, name: 'Mara', payload: { desc: 'keeper', look: 'red coat', notes: 'n', pics: ['a.png', 'b.png'], main: 'b.png', voice: 'v1',
  views: { front: 'f.png' }, sheet: 's.png', vpending: [{ gen: 5, view: 'side' }], cands: [{ id: 'x', view: 'back', gen: 4, index: 0, url: '/u' }] } });

test('an older document loses nothing', () => {
  const c = M.fromDoc(old());
  assert.equal(c.look, 'red coat'); assert.equal(c.desc, 'keeper'); assert.equal(c.notes, 'n'); assert.equal(c.voice, 'v1');
  assert.deepEqual(c.pics, ['a.png', 'b.png']); assert.equal(c.main, 'b.png'); assert.deepEqual(c.views, { front: 'f.png' }); assert.equal(c.sheet, 's.png');
  assert.deepEqual(c.vpending, [{ gen: 5, view: 'side', look: 'main', slot: 'view:side' }]);
  assert.equal(c.cands[0].slot, 'view:back'); assert.equal(c.cands[0].look, 'main');
});
test('it saves and reads back the same', () => {
  const c = M.fromDoc(old()); M.addLook(c, { text: 'blue coat', name: 'Winter' });
  const again = M.fromDoc({ id: c.id, rev: c.rev, name: c.name, payload: JSON.parse(JSON.stringify(M.payloadOf(c))) });
  assert.deepEqual(M.payloadOf(again), JSON.parse(JSON.stringify(M.payloadOf(c))));
  assert.equal(again.look, 'blue coat');
});
test('cast.js reads the active look, and a shot can read another', () => {
  const c = M.fromDoc(old());
  assert.equal(refPicture(c, { size: 'wide' }).name, 'f.png');
  assert.deepEqual(packPictures(c), ['f.png']); assert.equal(mainOf(c), 'b.png');
  const w = M.addLook(c, { text: 'blue coat', views: { front: 'w.png' } });
  assert.equal(refPicture(c, { size: 'wide' }).name, 'w.png');
  c.active = 'main';
  const shot = c.withLook(w.id);
  assert.equal(shot.id, 'c');
  assert.equal(refPicture(shot, { size: 'wide' }).name, 'w.png');
  assert.match(castLines([shot])[0], /blue coat/);
  assert.equal(c.look, 'red coat', 'the character itself stays on its look');
});
test('media keep their order and a removed item lets go', () => {
  const c = M.fromDoc(old());
  M.moveItem(c.media, 1, 0);
  assert.deepEqual(c.pics, ['b.png', 'a.png']);
  M.removeItem(c, c.media[0].id);
  assert.equal(c.main, 'a.png');
});
test('a result lands once, in its slot, and the kept model and rig become current', () => {
  const c = new M.Character({ id: 'c' }); let n = 0;
  const ctx = { kindOf: (o) => o.kind, uid: () => `u${++n}` };
  c.vpending = [{ gen: 1, look: 'main', slot: 'model', made: { template: 't', views: '' } }, { gen: 2, look: 'main', slot: 'rig', made: { template: 'r', from: 'mX' } }, { gen: 3, look: 'main', slot: 'view:front' }];
  const glb = { id: 1, status: 'done', outputs: [{ kind: 'image', url: '/p' }, { kind: 'mesh', url: '/m.glb', filename: 'm.glb' }] };
  M.settleRun(c, glb, ctx);
  assert.equal(c.cands.length, 1); assert.equal(c.cands[0].index, 1);
  assert.equal(M.settleRun(c, glb, ctx), null, 'once');
  M.settleRun(c, { id: 2, status: 'done', outputs: [{ kind: 'file', url: '/r.fbx', filename: 'r.fbx' }] }, ctx);
  assert.equal(c.cands.length, 2, 'a rig run\'s FBX counts');
  const before = c.lookNow.model;
  assert.equal(before, null, 'not current until kept');
  const m = M.keepCandidate(c, c.cands[0], { id: 'mA' });
  assert.equal(c.lookNow.model, 'mA'); assert.deepEqual(m.src, { generation: 1, index: 1 }); assert.equal(m.made.template, 't');
  const r = M.keepCandidate(c, c.cands[0], { id: 'rA' });
  assert.equal(c.lookNow.rig, 'rA'); assert.equal(r.role, 'rig');
  assert.deepEqual(M.settleRun(c, { id: 3, status: 'error' }, ctx).failed, true);
  M.removeItem(c, 'rA');
  assert.equal(c.lookNow.rig, null, 'removing the current rig clears it');
  M.removeItem(c, 'mA');
  assert.equal(c.lookNow.model, null);
});
test('out of date: views changed since the model, another model since the rig', () => {
  const c = new M.Character({ id: 'c' }); const l = c.lookNow;
  l.views = { front: 'a' };
  c.media = [{ id: 'm1', role: 'model', src: {}, made: { views: M.viewsStamp(l.views) } }, { id: 'm2', role: 'model', src: {}, made: { views: M.viewsStamp(l.views) } }, { id: 'r1', role: 'rig', src: {}, made: { from: 'm1' } }];
  l.model = 'm1'; l.rig = 'r1';
  assert.deepEqual(M.staleness(c), { model: false, rig: false });
  l.views.back = 'b';
  assert.equal(M.staleness(c).model, true);
  l.model = 'm2';
  assert.equal(M.staleness(c).rig, true);
  l.rig = null;
  assert.equal(M.staleness(c).rig, false);
});
test('looks: duplicate keeps the pictures, not the model; the last can\'t go; a removed look\'s media stay', () => {
  const c = M.fromDoc(old()); c.lookNow.model = 'x';
  const d = M.duplicateLook(c, c.lookNow);
  assert.deepEqual(d.views, { front: 'f.png' }); assert.equal(d.model, null);
  c.media[0].look = d.id;
  assert.equal(M.removeLook(c, d.id), true);
  assert.equal(c.media[0].look, null); assert.equal(c.active, 'main');
  assert.equal(M.removeLook(c, 'main'), false);
});
test('line-up: to scale, the tallest fills it', () => {
  const r = M.lineUp([{ height_cm: 200 }, { height_cm: 100 }, { height_cm: null }], 400);
  assert.equal(r.rows[0].px, 400); assert.equal(r.rows[1].px, 200); assert.equal(r.rows[2].guessed, true); assert.equal(r.rows[2].px, 300);
});
test('a cut-out figure is read from the see-through around it; a solid picture isn\'t', () => {
  const w = 4, hh = 10, px = new Uint8ClampedArray(w * hh * 4);
  for (let y = 2; y < 8; y++) for (let x = 0; x < w; x++) px[(y * w + x) * 4 + 3] = 255;
  const b = M.figureBox(px, w, hh);
  assert.equal(b.h, 0.6); assert.equal(b.bottom, 0.2);
  assert.equal(M.figureBox(new Uint8ClampedArray(w * hh * 4).fill(255), w, hh), null);
});
test('appears in: the shots that name them, across stories', () => {
  const c = { id: 'c', name: 'Mara' };
  const found = M.appearsIn(c, [{ id: 's1', name: 'One', payload: { scenes: [{ id: 'a', shots: [{ id: 'x', what: 'empty', action: '' }, { id: 'y', what: '@Mara waves', action: '' }] }] } }],
    (t, all) => (t.includes('@Mara') ? all : []), [c]);
  assert.deepEqual(found.map((f) => f.shot), ['y']);
});
