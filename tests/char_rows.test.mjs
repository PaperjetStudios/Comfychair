// node --test tests/char_rows.test.mjs: a character laid out as a table (web/char-rows.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../web/char-rows.js';
import * as M from '../web/table-model.js';
import * as CM from '../web/char-model.js';

const doc = () => ({ id: 'c', rev: 1, name: 'Mara', payload: {
  looks: [{ id: 'main', name: 'Main', text: 'red coat', main: 'b.png', views: { front: 'f.png', side: 's.png' }, sheet: 'sheet.png', expressions: { happy: 'h.png' } },
    { id: 'w', name: 'Winter', text: 'blue coat', main: null, views: {}, sheet: null, expressions: {} }],
  active: 'main',
  media: [{ id: 'm0', kind: 'image', src: { input: 'a.png' }, role: 'ref' }, { id: 'm1', kind: 'image', src: { input: 'b.png' }, role: 'face' },
    { id: 'm2', kind: 'image', src: { input: 'scar.png' }, role: 'detail', label: 'scar' },
    { id: 'm3', kind: 'image', src: { input: 'bust.png' }, role: 'sheet', label: 'Bust' },
    { id: 'm4', kind: 'video', src: { gen: 7 }, role: 'clip' },
    { id: 'm5', kind: 'image', src: { input: 'wc.png' }, role: 'ref', look: 'w' }] } });

// a table built from what the look wants, every stage with its note
function build(want, look = 'main') {
  const frames = R.STAGES.map((s) => R.stageNote(s, { x: 0, y: 0, w: R.NOTE_W, h: 200 }, look));
  for (const w of want) frames.push(R.stageFrame(w, { x: 0, y: 0, ...R.tileSize(1024, 1536) }, look));
  return frames;
}

const elements = () => [
  CM.fromDoc({ id: 'bag', rev: 1, name: 'Backpack', payload: { partOf: { character: 'c' } } }),
  CM.fromDoc({ id: 'hat', rev: 1, name: 'Winter hat', payload: { partOf: { character: 'c', look: 'w' } } }),
  CM.fromDoc({ id: 'other', rev: 1, name: 'Someone else\'s', payload: { partOf: { character: 'z' } } })];

test('wanted: the look\'s pictures as references, its elements, its views and its sheets; clips and other looks\' pictures left out', () => {
  const c = CM.fromDoc(doc());
  const w = R.wanted(c, undefined, { elements: elements() });
  assert.deepEqual(w.map((x) => [x.stage, x.slot, x.label]), [
    ['refs', 'm0', 'Reference'], ['refs', 'm1', 'Face'], ['refs', 'm2', 'scar'],
    ['elements', 'bag', 'Backpack'],
    ['views', 'front', 'Front'], ['views', 'side', 'Side'],
    ['sheets', 'sheet', 'Sheet'], ['sheets', 'm3', 'Sheet · Bust']]);
  assert.ok(w.filter((x) => x.stage !== 'elements').every((x) => x.kind === 'image' && x.input));
  assert.equal(w[3].kind, 'character'); assert.equal(w[3].doc, 'bag');
  assert.deepEqual(R.wanted(c, 'w', { elements: elements() }).filter((x) => x.stage === 'elements').map((x) => x.slot), ['bag', 'hat']);
  const bagFrame = R.stageFrame(w[3], { x: 0, y: 0, w: 200, h: 200 }, 'main');
  assert.equal(bagFrame.kind, 'character'); assert.equal(bagFrame.doc, 'bag'); assert.equal(bagFrame.label, 'Backpack');
  assert.ok(CM.isElement(elements()[0])); assert.ok(!CM.isElement(c));
  assert.deepEqual(CM.elementsOf(elements(), c).map((e) => e.id), ['bag', 'hat']);
  assert.deepEqual(CM.elementsOf(elements(), c, 'main').map((e) => e.id), ['bag']);
  assert.deepEqual(CM.topLevel([c, ...elements()]).map((e) => e.id), ['c']);
  const again = CM.fromDoc({ id: 'bag', rev: 2, name: 'Backpack', payload: CM.payloadOf(elements()[0]) });
  assert.deepEqual(again.partOf, { character: 'c', look: null });
  const winter = R.wanted(c, 'w');
  // (media with no look belongs to every look, as char-model's pics says; the winter picture is its own; no views or sheet yet)
  assert.deepEqual(winter.map((x) => [x.stage, x.slot]), [['refs', 'm0'], ['refs', 'm1'], ['refs', 'm2'], ['refs', 'm5'], ['sheets', 'm3']]);
  assert.deepEqual(R.wanted(null), []);
});

test('frames made for the table carry their stage, slot, look and picture, and the layout\'s label', () => {
  const f = R.stageFrame({ stage: 'views', slot: 'front', kind: 'image', label: 'Front', input: 'f.png' }, { x: 0, y: 0, w: 200, h: 300 }, 'main');
  assert.equal(f.kind, 'image'); assert.deepEqual(f.char, { stage: 'views', slot: 'front', look: 'main', input: 'f.png', auto: 'Front' });
  assert.ok(R.isStageFrame(f)); assert.ok(!R.isStageNote(f)); assert.ok(R.autoLabelled(f));
  f.label = 'Hero'; assert.ok(!R.autoLabelled(f));
  const n = R.stageNote('turn', { x: 0, y: 0, w: 100, h: 100 }, 'main');
  assert.ok(R.isStageNote(n)); assert.equal(n.text, 'Turntable'); assert.equal(R.stageOf(n), 'turn');
  const o = R.stageFrame({ stage: 'object', slot: 'model', label: 'Model' }, { x: 0, y: 0, w: 300, h: 300 }, 'main');
  assert.equal(o.kind, 'scene');
  assert.ok(M.migrateTable({ frames: [f, n, o] }).frames.length === 3);   // (the table keeps them)
  assert.deepEqual(R.tileSize(2000, 1000, 320), { w: 320, h: 160 });
  assert.deepEqual(R.tileSize(0, 0), { w: R.TILE, h: R.TILE });
});

test('planReconcile: a complete table needs nothing; pictures added, taken out, remade and frames duplicated are found', () => {
  const c = CM.fromDoc(doc());
  const want = R.wanted(c), frames = build(want);
  let p = R.planReconcile(want, frames);
  assert.deepEqual([p.missing, p.missingNotes, p.remove, p.copies, p.renew], [[], [], [], [], []]);
  // a picture added, a view remade, the sheet taken out
  c.media.push({ id: 'm9', kind: 'image', src: { input: 'z.png' }, role: 'body', look: null, label: '', url: '' });
  c.views.front = 'f2.png';
  c.sheet = null;
  p = R.planReconcile(R.wanted(c), frames);
  assert.deepEqual(p.missing.map((x) => x.slot), ['m9']);
  assert.deepEqual(p.renew.map((x) => x.input), ['f2.png']);
  assert.equal(p.remove.length, 1);
  assert.equal(frames.find((f) => f.id === p.remove[0]).char.slot, 'sheet');
  // a duplicated frame and a second note
  const dup = { ...frames.find((f) => f.char.slot === 'm0'), id: 'dup' }, note2 = { ...frames[0], id: 'n2' };
  p = R.planReconcile(want, [...frames, dup, note2]);
  assert.deepEqual(p.copies, [{ frame: 'dup', of: frames.find((f) => f.char.slot === 'm0').id }]);
  assert.ok(p.remove.includes('n2'));
  // a table with no notes yet
  p = R.planReconcile(want, frames.filter((f) => !R.isStageNote(f)));
  assert.deepEqual(p.missingNotes, R.STAGES);
  // frames of another look's rows are not judged
  const other = R.stageFrame({ stage: 'refs', slot: 'm5', label: 'Reference', input: 'wc.png' }, { x: 0, y: 0, w: 100, h: 100 }, 'w');
  p = R.planReconcile(want, [...frames, other], { look: 'main' });
  assert.deepEqual(p.remove, []);
});

test('charLayout: a row per stage in order, the note first, frames left to right in their own order', () => {
  const c = CM.fromDoc(doc());
  const frames = build(R.wanted(c));
  // the table's own order along a row stands: swap the two views
  const [a, b] = frames.filter((f) => R.isStageFrame(f) && f.char.stage === 'views');
  const swapped = frames.map((f) => (f === a ? b : f === b ? a : f));
  const laid = R.charLayout(swapped, { x0: 0, y0: 0, gap: 40, rowGap: 120 });
  assert.equal(laid.size, frames.length);
  const at = (f) => laid.get(f.id);
  const notes = frames.filter(R.isStageNote);
  for (let i = 1; i < notes.length; i++) assert.ok(at(notes[i]).y > at(notes[i - 1]).y, 'stages go down');
  for (const n of notes) assert.equal(at(n).x, 0, 'a note starts its row');
  assert.ok(at(b).x < at(a).x, 'the row keeps the table\'s order');
  assert.equal(at(b).y, at(notes[R.STAGES.indexOf('views')]).y, 'the views sit on their stage\'s row');
  assert.equal(at(b).x, R.NOTE_W + 40);
  // a frame with no stage is not placed
  assert.equal(R.charLayout([...frames, { id: 'x', kind: 'image', x: 9, y: 9, w: 10, h: 10 }]).has('x'), false);
  assert.equal(R.noteText('turn', 'Running · depth render'), 'Turntable\nRunning · depth render');
});
