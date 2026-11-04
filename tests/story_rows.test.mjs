// node --test tests/story_rows.test.mjs: a story laid out as a table (web/shot-rows.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, autoLabelled, carryRows, fromNote, noteText, orderFromRows, planReconcile, rowsOf, rowsOfFrames, shotSize, storyLayout } from '../web/shot-rows.js';

const note = (id, scene, x, y) => ({ id, kind: 'note', story: { scene }, x, y, w: 100, h: 100 });
const shot = (id, scene, s, x, y) => ({ id, kind: 'image', story: { scene, shot: s }, x, y, w: 160, h: 100 });
const story = () => ({ scenes: [
  { id: 'A', slug: 'INT. ONE', summary: '', shots: [{ id: 'a1' }, { id: 'a2' }] },
  { id: 'B', slug: '', summary: '', shots: [{ id: 'b1' }] },
] });
const ids = (P) => P.scenes.map((sc) => `${sc.id}:${sc.shots.map((s) => s.id).join(',')}`).join(' ');

test('rows: frames whose middle is in a row join it, each row left to right', () => {
  const rows = rowsOfFrames([shot('2', 'A', 'a2', 400, 10), note('n', 'A', 0, 0), shot('1', 'A', 'a1', 200, 0), note('m', 'B', 0, 300)]);
  assert.deepEqual(rows.map((r) => r.map((f) => f.id)), [['n', '1', '2'], ['m']]);
  assert.deepEqual(rowsOf([note('m', 'B', 0, 300), note('n', 'A', 0, 0)]).map((r) => r.map((f) => f.id)), [['n'], ['m']]);
});

test('order: a frame dragged into another row moves its shot to that scene, in x order', () => {
  const P = story();
  const rows = [[note('n', 'A', 0, 0), shot('1', 'A', 'a1', 200, 0)], [note('m', 'B', 0, 300), shot('3', 'B', 'b1', 200, 300), shot('2', 'A', 'a2', 300, 300)]];
  const order = orderFromRows(rows);
  assert.deepEqual(order, [{ scene: 'A', shots: ['a1'] }, { scene: 'B', shots: ['b1', 'a2'] }]);
  assert.equal(applyOrder(P, order), true);
  assert.equal(ids(P), 'A:a1 B:b1,a2');
  assert.equal(applyOrder(P, order), false, 'the same order again changes nothing');
});

test('order: a row without a note joins the scene above; shots above every note go to the first scene', () => {
  const rows = [[shot('0', 'B', 'b1', 0, -300)], [note('n', 'A', 0, 0), shot('1', 'A', 'a1', 200, 0)], [shot('2', 'A', 'a2', 0, 200)], [note('m', 'B', 0, 400)]];
  assert.deepEqual(orderFromRows(rows), [{ scene: 'A', shots: ['b1', 'a1', 'a2'] }, { scene: 'B', shots: [] }]);
  assert.equal(orderFromRows([[shot('1', 'A', 'a1', 0, 0)]]), null);
});

test('order: notes moved reorder the scenes; a scene or shot with no frame keeps its place', () => {
  const P = story();
  applyOrder(P, [{ scene: 'B', shots: ['b1'] }, { scene: 'A', shots: ['a2'] }]);
  assert.equal(ids(P), 'B:b1 A:a2,a1');
  const Q = story();
  applyOrder(Q, [{ scene: 'B', shots: ['b1', 'a1'] }]);
  assert.equal(ids(Q), 'A:a2 B:b1,a1');
});

test('reconcile plan: new shots, gone frames, copies, orphans, notes', () => {
  const P = story();
  const frames = [note('n', 'A', 0, 0), note('n2', 'A', 0, 0), note('x', 'Z', 0, 0), shot('1', 'A', 'a1', 0, 0), shot('1c', 'A', 'a1', 0, 0), shot('o', 'A', 'zz', 0, 0)];
  const plan = planReconcile(P, frames, { seen: new Map([['a1', '1'], ['b1', 'old']]) });
  assert.deepEqual(plan.missingShots, [{ scene: 'A', shot: 'a2' }]);
  assert.deepEqual(plan.goneShots, ['b1']);
  assert.deepEqual(plan.copies, [{ frame: '1c', shot: 'a1' }]);
  assert.deepEqual(plan.missingNotes, ['B']);
  assert.deepEqual(plan.remove.sort(), ['n2', 'o', 'x']);
});

test('layout: a row per scene, note first, from the origin', () => {
  const P = story();
  const frames = [shot('2', 'A', 'a2', 9, 9), note('n', 'A', 5, 5), shot('1', 'A', 'a1', 1, 1), note('m', 'B', 0, 0), shot('3', 'B', 'b1', 0, 0)];
  const pos = storyLayout(P, frames, { x0: 10, y0: 20, gap: 40, rowGap: 100 });
  assert.deepEqual(pos.get('n'), { x: 10, y: 20 });
  assert.deepEqual(pos.get('1'), { x: 150, y: 20 });
  assert.deepEqual(pos.get('2'), { x: 350, y: 20 });
  assert.deepEqual(pos.get('m'), { x: 10, y: 220 });
  assert.deepEqual(pos.get('3'), { x: 150, y: 220 });
});

test('a note is the heading then the summary; a shot frame is its canvas, else about a megapixel', () => {
  assert.equal(noteText({ slug: 'INT. ONE', summary: 'Rain.' }), 'INT. ONE\nRain.');
  assert.equal(noteText({ slug: '', summary: '' }), '');
  assert.deepEqual(fromNote('  EXT. TWO \nShe runs.\nFast.'), { slug: 'EXT. TWO', summary: 'She runs.\nFast.' });
  assert.deepEqual(shotSize({ comp: { size: { w: 1368, h: 768 } } }, 16 / 9), { w: 1368, h: 768 });
  const s = shotSize({}, 16 / 9);
  assert.ok(Math.abs(s.w * s.h - 1e6) < 0.05e6 && s.w % 16 === 0 && s.h % 16 === 0);
});

test('a note moved on its own carries its row: the scene\'s shots that stayed go with it', () => {
  const P = story();
  const frames = [note('n', 'A', 0, 900), shot('1', 'A', 'a1', 200, 0), shot('2', 'A', 'a2', 500, 400), note('m', 'B', 0, 300), shot('3', 'B', 'b1', 200, 300)];
  const laid = new Map([['n', { x: 0, y: 0 }], ['1', { x: 200, y: 0 }], ['2', { x: 400, y: 0 }], ['m', { x: 0, y: 300 }], ['3', { x: 200, y: 300 }]]);
  assert.equal(carryRows(frames, laid), true);
  assert.deepEqual([frames[1].x, frames[1].y], [200, 900], 'a1 stayed put: carried');
  assert.deepEqual([frames[2].x, frames[2].y], [500, 400], 'a2 was moved by hand: left where it was dropped');
  assert.deepEqual([frames[4].x, frames[4].y], [200, 300], 'another scene\'s shot: not carried');
  applyOrder(P, orderFromRows(rowsOf(frames)));
  assert.equal(ids(P), 'B:b1,a2 A:a1');
  assert.equal(carryRows([note('k', 'A', 0, 0)], new Map([['k', { x: 0, y: 0 }]])), false);
});

test('a shot frame keeps the story\'s label until it is renamed on the table', () => {
  assert.equal(autoLabelled({ label: '1.2 Rain', story: { shot: 'a', auto: '1.2 Rain' } }), true);
  assert.equal(autoLabelled({ label: 'My best shot', story: { shot: 'a', auto: '1.2 Rain' } }), false);
  assert.equal(autoLabelled({ label: '2.1', story: { shot: 'a' } }), true, 'from before story.auto: a number first');
  assert.equal(autoLabelled({ label: 'Hero', story: { shot: 'a' } }), false);
});

test('rows: a note snapped edge to edge against the next scene\'s starts its own row', () => {
  const rows = rowsOf([note('n', 'A', 0, 0), shot('1', 'A', 'a1', 200, 0), note('m', 'B', 0, 100), shot('2', 'B', 'b1', 200, 100)]);
  assert.deepEqual(rows.map((r) => r.map((f) => f.id)), [['n', '1'], ['m', '2']]);
});
