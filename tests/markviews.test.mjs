// node --test tests/markviews.test.mjs: marking a clip's frames as angles
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAll, frameAt, isSheetRun, madeOf, markClipOf, packFrom, setMark, toMake, slotPicks, stepsOn, viewFile } from '../web/markview-math.js';

test('a time is the frame on show', () => {
  assert.equal(frameAt(0, 24), 0);
  assert.equal(frameAt(96 / 24, 24), 96);
  for (let f = 0; f < 300; f++) assert.equal(frameAt(f / 24, 24), f);
  assert.equal(frameAt(1.03, 24), 24);
});
test('an angle has one frame, Detail many, in clip order', () => {
  let m = setMark([], 'Back', 96);
  m = setMark(m, 'Front', 4);
  assert.deepEqual(m.map((x) => x.label), ['Front', 'Back']);
  m = setMark(m, 'Front', 120);
  assert.deepEqual(m, [{ label: 'Back', frame: 96 }, { label: 'Front', frame: 120 }]);
  m = setMark(setMark(setMark([], 'Detail', 5), 'Detail', 9), 'Detail', 5);
  assert.deepEqual(m.map((x) => x.frame), [5, 9]);
});
test('steps keep their order whatever is ticked', () => {
  assert.deepEqual(stepsOn({ cut: true, up: true }), ['up', 'cut']);
  assert.deepEqual(stepsOn({ cut: true, delight: true, up: true }), ['up', 'delight', 'cut']);
  assert.deepEqual(stepsOn({}), []);
});
test('file names and 3D slots', () => {
  assert.equal(viewFile('Front 3/4 left'), 'view-front-3-4-left.png');
  assert.deepEqual(slotPicks([{ label: 'Front', name: 'a' }, { label: 'Top', name: 'b' }, { label: 'Left', name: 'c' }]), { Front: 'a', Left: 'c' });
});
test('Mark views is offered on any H3 clip, and on a sheet picture for its clip', () => {
  const outputs = [{ kind: 'image' }, { kind: 'video' }, { kind: 'video' }];
  for (const template of ['deck-h3-charsheet', 'h3 sheet upscale', 'h3 upscale', 'h3 regenerate']) {
    assert.equal(markClipOf({ template, outputs }, 2), 2, template);
    assert.equal(markClipOf({ template, outputs }, 0), 1, template);
  }
  assert.equal(markClipOf({ template: 'deck-h3-i2v', outputs: [{ kind: 'image' }] }, 0), -1);
  assert.equal(markClipOf({ template: 'import', outputs }, 1), -1);
  assert.equal(markClipOf({ template: 'deck-upscale-video', outputs }, 1), -1);
});
test('the look pack takes one view of each kind', () => {
  assert.deepEqual(packFrom([{ label: 'Right', name: 'r' }, { label: 'Left', name: 'l' }, { label: 'Front 3/4 right', name: 'q' }, { label: 'Top', name: 't' }, { label: 'Face 3/4', name: 'f' }]),
    { three: 'q', side: 'l' });
  assert.deepEqual(packFrom([{ label: 'Front', name: 'a' }, { label: 'Back', name: 'b' }, { label: 'Face front', name: 'c' }, { label: 'Right', name: 'r' }, { label: 'Front 3/4 left', name: 'q' }]),
    { front: 'a', three: 'q', side: 'r', back: 'b', face: 'c' });
  assert.deepEqual(packFrom([]), {});
});
test('repairing: a moved mark needs making again, the others keep their pictures', () => {
  const marks = [{ label: 'Front', frame: 4, name: 'a' }, { label: 'Left', frame: 54, name: 'b' }];
  assert.equal(setMark(marks, 'Left', 54), marks, 'the same frame again changes nothing');
  const moved = setMark(marks, 'Left', 60);
  assert.deepEqual(toMake(moved), [{ label: 'Left', frame: 60 }]);
  assert.deepEqual(madeOf(moved), [{ label: 'Front', frame: 4, name: 'a' }]);
});
test('the Board\'s Sheets section: sheets and what was made from them', () => {
  for (const template of ['deck-h3-charsheet', 'deck-h3-charsheet-body', 'deck-h3-charsheet-bust', 'deck-h3-charsheet-bust4', 'deck-h3-charsheet-head', 'deck-h3-objectsheet']) assert.ok(isSheetRun({ template, params: {} }), template);
  assert.ok(isSheetRun({ template: 'h3 sheet upscale', params: { sheet: true } }));
  assert.ok(isSheetRun({ template: 'h3 regenerate', params: { sheet: true } }));
  assert.ok(!isSheetRun({ template: 'h3 upscale', params: {} }));
  assert.ok(!isSheetRun({ template: 'deck-sheet-cell', params: {} }));
  assert.ok(!isSheetRun({ template: 'deck-h3-i2v' }));
});

test('all the views are queued before any is waited on, in order, and one failing stops none of the others', async () => {
  const log = [], gate = [];
  const out = [];
  const going = makeAll(['a', 'b', 'c'],
    async (it) => { log.push(`start ${it}`); if (it === 'b') throw new Error('no frame'); return `${it}0`; },
    (it, first) => { log.push(`queue ${first}`); return new Promise((res, rej) => gate.push({ it, res, rej })); },
    (it, r, e) => out.push([it, r, e?.message ?? null]));
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(log, ['start a', 'queue a0', 'start b', 'start c', 'queue c0']);   // (nothing has finished yet)
  gate[1].res('C'); gate[0].rej(new Error('run failed'));
  await going;
  assert.deepEqual(out, [['b', null, 'no frame'], ['c', 'C', null], ['a', null, 'run failed']]);
});
