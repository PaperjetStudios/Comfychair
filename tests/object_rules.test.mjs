// node --test tests/object_rules.test.mjs: the 3D object panel's attached pictures and the Add list (web/object-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { addGroups, addPictures, filterGroups, planRun, usedViews } from '../web/object-rules.js';

test('pictures go into the empty views in order; a repeat or one too many is left out', () => {
  const r = addPictures({ Left: 'a' }, ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(r.picks, { Left: 'a', Front: 'b', Back: 'c', Right: 'd' });
  assert.deepEqual(r.left, ['a', 'e']);
});
test('a model reads what it can take; the other pictures stay attached', () => {
  const picks = { Left: 'a', Back: 'b' };
  assert.deepEqual(usedViews(picks, 'pixal'), ['Left', 'Back']);
  assert.deepEqual(usedViews(picks, 'trellis'), ['Left']);
  assert.deepEqual(usedViews(picks, 'idol'), ['Left']);
  assert.deepEqual(usedViews({}, 'pixal'), []);
});
test('what is attached decides the run', () => {
  assert.equal(planRun({}, 'pixal').kind, null);
  assert.equal(planRun({ Front: 'a' }, 'pixal').kind, 'single');
  assert.equal(planRun({ Front: 'a', Back: 'b' }, 'pixal').kind, 'multi');
  assert.equal(planRun({ Front: 'a', Back: 'b' }, 'trellis').kind, 'single');
  assert.equal(planRun({ Front: 'a', Back: 'b' }, 'idol').kind, 'splat');
});

const TYPES = { person: { label: 'Person', icon: 'p' }, box: { label: 'Box', icon: 'b' }, figure: { label: 'Posable person', icon: 'f' }, photo: { label: 'Photo' },
  splat: { label: 'Splat' }, model: { label: 'Model' }, picture: { label: 'Picture', hide: true }, rigged: { label: 'Rigged model', icon: 'r' }, thing: { label: 'New thing', icon: 'n' } };
const BODIES = [['man', 'Man'], ['woman', 'Woman']];
test('the Add list is grouped, every type has a place, and the hidden ones stay out', () => {
  const g = addGroups(TYPES, { bodies: BODIES });
  assert.deepEqual(g.map((x) => x.title), ['From pictures', 'People', 'Shapes', 'Rigs', 'Other']);
  const labels = g.flatMap((x) => x.items.map((i) => i.label));
  for (const out of ['Photo', 'Splat', 'Model', 'Picture']) assert.ok(!labels.includes(out), out);
  assert.ok(labels.includes('Posable person (woman)'));
  assert.ok(labels.includes('New thing'));   // (a new type shows, under Other)
});
test('a room only when the scene has none; the count of attached pictures shows', () => {
  assert.ok(addGroups(TYPES).flatMap((x) => x.items).some((i) => i.id === 'room'));
  assert.ok(!addGroups(TYPES, { room: true }).flatMap((x) => x.items).some((i) => i.id === 'room'));
  assert.match(addGroups(TYPES, { attached: 2 })[0].items[0].label, /2 attached/);
});
test('typing narrows the list; a group\'s name keeps all of it', () => {
  const g = addGroups(TYPES, { bodies: BODIES });
  assert.deepEqual(filterGroups(g, 'WOMAN').flatMap((x) => x.items.map((i) => i.label)), ['Posable person (woman)']);
  assert.equal(filterGroups(g, 'people').flatMap((x) => x.items).length, 3);
  assert.deepEqual(filterGroups(g, 'zzz'), []);
  assert.equal(filterGroups(g, '  '), g);
});
