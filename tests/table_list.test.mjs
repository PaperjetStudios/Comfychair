// node --test tests/table_list.test.mjs: the Frame pane's list at scale (web/frame-list.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { LONG_LIST, filtering, frameMatches, foldedGroups, listRows } from '../web/frame-list.js';

const fr = (id, kind, extra = {}) => ({ id, key: id, kind, label: `${kind} ${id}`, ...extra });
const show = (rows) => rows.map((r) => (r.group ? `g:${r.group.id}` : r.scene ? `s:${r.scene.id}${r.scene.folded ? '+' : ''}` : r.layer.id));

test('a search matches every word in the label or the kind\'s words; kinds and selected only narrow it', () => {
  const f = fr('a', 'video', { label: 'Beach walk' });
  assert.ok(frameMatches(f, { q: 'beach' }));
  assert.ok(frameMatches(f, { q: 'walk clip' }));
  assert.ok(!frameMatches(f, { q: 'beach picture' }));
  assert.ok(!frameMatches(f, { kinds: new Set(['image']) }));
  assert.ok(frameMatches(f, { kinds: new Set(['video']) }));
  assert.ok(!frameMatches(f, { selOnly: true, sel: new Set() }));
  assert.ok(frameMatches(f, { selOnly: true, sel: new Set(['a']) }));
  assert.equal(filtering({ q: '  ' }), false);
  assert.equal(filtering({ kinds: new Set(['image']) }), true);
});

test('top first, and a frame row knows its place in the stack rows for reordering', () => {
  const frames = [fr('a', 'image'), fr('b', 'video'), fr('c', 'sound')];
  const rows = listRows(frames, []);
  assert.deepEqual(show(rows), ['c', 'b', 'a']);
  assert.deepEqual(rows.map((r) => r.real), [0, 1, 2]);
});

test('filtering keeps a group with a match open and shows only the matches; reordering is off', () => {
  const frames = [fr('a', 'image', { group: 'g' }), fr('b', 'video', { group: 'g' }), fr('c', 'image')];
  const groups = [{ id: 'g', name: 'G', collapsed: true }];
  assert.deepEqual(show(listRows(frames, groups)), ['c', 'g:g']);
  const rows = listRows(frames, groups, { find: { kinds: new Set(['video']) } });
  assert.deepEqual(show(rows), ['g:g', 'b']);
  assert.equal(rows[1].real, null);
  assert.deepEqual(show(listRows(frames, groups, { find: { q: 'sound' } })), []);
});

test('groups never folded by hand fold once the list is long; one opened by hand stays open', () => {
  const many = Array.from({ length: LONG_LIST + 1 }, (_, i) => fr(`f${i}`, 'image', i < 3 ? { group: 'g' } : {}));
  assert.equal(foldedGroups(many, [{ id: 'g', name: 'G' }])[0].collapsed, true);
  assert.equal(foldedGroups(many, [{ id: 'g', name: 'G', collapsed: false }])[0].collapsed, false);
  assert.equal(foldedGroups(many.slice(0, 5), [{ id: 'g', name: 'G' }])[0].collapsed, false);
  assert.equal(listRows(many, [{ id: 'g', name: 'G' }]).length, LONG_LIST + 1 - 3 + 1);
});

test('a story\'s frames come under a row per scene, named, folded on a long list or by hand', () => {
  const st = (scene) => ({ story: { scene, shot: `${scene}-x` } });
  const frames = [fr('a', 'image', st('s1')), fr('b', 'image', st('s1')), fr('c', 'image', st('s2')), fr('n', 'note')];
  const rows = listRows(frames, [], { sceneName: (id) => (id === 's2' ? 'INT. HOUSE' : null) });
  assert.deepEqual(show(rows), ['n', 's:s2', 'c', 's:s1', 'b', 'a']);
  assert.equal(rows[1].scene.name, 'INT. HOUSE');
  assert.equal(rows[3].scene.name, 'Scene');
  assert.deepEqual(rows[3].members.map((f) => f.id), ['b', 'a']);
  assert.deepEqual(show(listRows(frames, [], { folded: (id) => id === 's1' })), ['n', 's:s2', 'c', 's:s1+']);
  const long = [...frames, ...Array.from({ length: LONG_LIST }, (_, i) => fr(`x${i}`, 'note'))];
  assert.ok(show(listRows(long, [])).includes('s:s1+'));
  assert.ok(show(listRows(long, [], { find: { q: 'image' } })).includes('a'));
});
