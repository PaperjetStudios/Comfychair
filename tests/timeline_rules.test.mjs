// node --test tests/timeline_rules.test.mjs: the timeline's rules (web/timeline-rules.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lenOf, endOf, editable, pickedIds, setPicked, pick, pickOrder, boxItems, boxPick, selectFrom, snapPoints, grab, moveSet, trim, slip,
  splitAt, removeItems, rippleDelete, closeGap, duplicate, copy, paste, nudge,
  trackLock, trackSolo, trackRename, trackReorder, trackHeight, exportTracks, addMarker, moveMarker, removeMarker, renameMarker,
} from '../web/timeline-rules.js';

let n = 0;
const o = { minLen: 0.1, uid: () => `n${++n}`, canDrop: (it, tr) => (tr.kind === 'audio') === (it.kind === 'audio') };
const C = (id, track, at, len, more = {}) => ({ id, track, kind: 'video', at, in: 0, out: len, dur: 20, ...more });
const doc = () => ({
  tracks: [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio' }],
  items: [C('a', 'v1', 0, 2), C('b', 'v1', 2, 3), C('c', 'v1', 6, 1), C('d', 'v2', 1, 2), C('s', 'a1', 0, 4, { kind: 'audio' })],
  markers: [],
});
const at = (d, id) => d.items.find((x) => x.id === id);

test('lengths: a clip with no out takes its duration or 3 s, never under minLen', () => {
  assert.equal(lenOf({ in: 1, out: 4 }, o), 3);
  assert.equal(lenOf({ in: 0, dur: 5 }, o), 5);
  assert.equal(lenOf({ in: 0 }, o), 3);
  assert.equal(lenOf({ in: 2, out: 2 }, o), 0.1);
  assert.equal(endOf({ at: 2, in: 1, out: 4 }, o), 5);
});

test('pick: click alone, Shift range from the primary, Shift adds without an order, toggle in and out', () => {
  const d = doc(), order = pickOrder(d);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 's']);
  let s = pick({ sel: null, multi: [] }, 'b');
  assert.deepEqual(s, { sel: 'b', multi: [] });
  s = pick(s, 'd', { shift: true, order });
  assert.deepEqual(s, { sel: 'b', multi: ['c', 'd'] });
  s = pick(s, 'a', { shift: true, order });   // the range is from the primary, the other way
  assert.deepEqual(s, { sel: 'b', multi: ['a'] });
  assert.deepEqual(pick({ sel: 'a', multi: [] }, 'c', { shift: true }), { sel: 'a', multi: ['c'] });
  s = pick({ sel: 'a', multi: ['c'] }, 'd', { toggle: true });
  assert.deepEqual(s, { sel: 'a', multi: ['c', 'd'] });
  s = pick(s, 'a', { toggle: true });   // the primary toggled out: the last other takes over
  assert.deepEqual(s, { sel: 'd', multi: ['c'] });
  assert.deepEqual(pick({ sel: null, multi: [] }, 'c', { toggle: true }), { sel: 'c', multi: [] });
  assert.deepEqual(pick(s, null), { sel: null, multi: [] });
  assert.deepEqual(pickedIds({ sel: 'd', multi: ['c'] }), ['d', 'c']);
  assert.deepEqual(setPicked(['x', 'y'], 'x'), { sel: 'x', multi: ['y'] });
  assert.deepEqual(setPicked(['x', 'y'], 'q'), { sel: 'y', multi: ['x'] });
});

test('box: what it touches; add and sub keep the primary when they can', () => {
  const d = doc();
  const touched = boxItems(d, { t0: 2.5, t1: 1.5, tracks: ['v1', 'v2'] }, o);
  assert.deepEqual(touched, ['a', 'b', 'd']);
  assert.deepEqual(boxPick({ sel: 'c', multi: [] }, touched, 'new'), { sel: 'd', multi: ['a', 'b'] });
  assert.deepEqual(boxPick({ sel: 'c', multi: [] }, touched, 'add'), { sel: 'c', multi: ['a', 'b', 'd'] });
  assert.deepEqual(boxPick({ sel: 'a', multi: ['b', 'c'] }, ['b'], 'sub'), { sel: 'a', multi: ['c'] });
  assert.deepEqual(boxPick({ sel: 'b', multi: ['c'] }, ['b'], 'sub'), { sel: 'c', multi: [] });
});

test('select from the playhead on, optionally on some tracks', () => {
  const d = doc();
  assert.deepEqual(selectFrom(d.items, 2.5, { o }), ['b', 'c', 'd', 's']);
  assert.deepEqual(selectFrom(d.items, 2.5, { tracks: ['v1'], o }), ['b', 'c']);
});

test('snap points: 0, playhead, other clips, markers, work area', () => {
  const d = doc();
  d.markers = [{ t: 9, label: 'm' }];
  assert.deepEqual(snapPoints(d, { exclude: ['a', 'b', 'c', 's'], t: 1.25, area: { a: 0.5, b: 10 } }, o), [0, 0.5, 1, 1.25, 3, 9, 10]);
});

test('group move snaps by the nearest edge, stays after 0, and changes track for all or none', () => {
  const d = doc(), g = grab(d);
  const pts = snapPoints(d, { exclude: ['b', 'c'] }, o);   // 0, 2 (a end), 1, 3 (d), 4 (s)
  let r = moveSet(d, ['b', 'c'], g, 0.93, { points: pts, tol: 0.1 }, o);   // b would start 2.93, snaps to 3
  assert.equal(r.dt, 1);
  assert.deepEqual([at(d, 'b').at, at(d, 'c').at], [3, 7]);
  r = moveSet(d, ['b', 'c'], g, -10, { snap: false }, o);
  assert.equal(r.dt, -2);
  assert.deepEqual([at(d, 'b').at, at(d, 'c').at], [0, 4]);
  r = moveSet(d, ['b', 'c'], g, 0, { dTrack: 1, snap: false }, o);   // both down to v2
  assert.equal(r.dTrack, 1);
  assert.deepEqual([at(d, 'b').track, at(d, 'c').track], ['v2', 'v2']);
  r = moveSet(d, ['b', 'd'], g, 0, { dTrack: 1, snap: false }, o);   // d would land on the audio track: canDrop refuses, so neither moves
  assert.equal(r.dTrack, 0);
  assert.deepEqual([at(d, 'b').track, at(d, 'd').track], ['v1', 'v2']);
  r = moveSet(d, ['a'], g, 0, { dTrack: -1, snap: false }, o);   // off the top
  assert.equal(r.dTrack, 0);
  r = moveSet(d, ['a'], g, 0.02, { step: 0.5, points: [], tol: 0 }, o);   // frame grid
  assert.equal(at(d, 'a').at, 0);
});

test('trim: source limits, minLen, a still trimmed at its start, and ripple moves what follows on its track only', () => {
  let d = doc(), g = grab(d);
  assert.equal(trim(d, ['b'], g, 'l', -1, { snap: false }, o), 0);   // a clip cannot start before its source
  assert.equal(trim(d, ['b'], g, 'r', -5, { snap: false }, o), -2.9);
  assert.equal(at(d, 'b').out, 0.1);
  assert.equal(trim(d, ['b'], g, 'r', 30, { snap: false }, o), 17);   // up to its duration
  d = doc(); g = grab(d);
  trim(d, ['b'], g, 'l', 1, { snap: false }, o);
  assert.deepEqual([at(d, 'b').at, at(d, 'b').in, at(d, 'b').out], [3, 1, 3]);
  d = doc(); d.items.push(C('i', 'v2', 5, 3, { kind: 'image', dur: 0 })); g = grab(d);
  trim(d, ['i'], g, 'l', -1, { snap: false }, o);   // a still has no source start: it grows
  assert.deepEqual([at(d, 'i').at, at(d, 'i').in, at(d, 'i').out], [4, 0, 4]);
  d = doc(); g = grab(d);
  trim(d, ['b'], g, 'r', 1, { ripple: true, snap: false }, o);
  assert.deepEqual([at(d, 'b').out, at(d, 'c').at, at(d, 'd').at], [4, 7, 1]);
  d = doc(); g = grab(d);
  trim(d, ['b'], g, 'l', 1, { ripple: true, snap: false }, o);   // ripple start trim: b stays, c comes back by 1
  assert.deepEqual([at(d, 'b').at, at(d, 'b').in, at(d, 'c').at, at(d, 'a').at], [2, 1, 5, 0]);
  d = doc(); g = grab(d);
  trim(d, ['b'], g, 'r', 0.95, { points: [6], tol: 0.1 }, o);   // b's end 5.95 snaps to c's start
  assert.equal(at(d, 'b').out, 4);
});

test('slip moves the shown part inside the source; a still cannot slip', () => {
  const d = doc();
  d.items.push(C('i', 'v2', 5, 3, { kind: 'image', dur: 0 }));
  const g = grab(d);
  assert.equal(slip(d, 'b', g, 5, o), 5);
  assert.deepEqual([at(d, 'b').at, at(d, 'b').in, at(d, 'b').out], [2, 5, 8]);
  assert.equal(slip(d, 'b', g, -3, o), 0);
  assert.equal(slip(d, 'b', g, 30, o), 17);
  assert.equal(slip(d, 'i', g, 1, o), 0);
});

test('split: the picked clip only when under the playhead; a still moves its keys, a clip keeps its own copy', () => {
  const d = doc();
  d.items.push(C('i', 'v2', 4, 4, { kind: 'image', dur: 0, chans: { opacity: [{ f: 0, v: 1 }, { f: 3, v: 0 }] } }));
  at(d, 'b').chans = { scale: [{ f: 2.5, v: 2 }] };
  assert.deepEqual(splitAt(d, ['b'], 3, o).length, 1);   // only b, although nothing else is under 3 on v1
  const b2 = d.items[d.items.indexOf(at(d, 'b')) + 1];
  assert.deepEqual([at(d, 'b').out, b2.at, b2.in, b2.out, b2.fadeIn, at(d, 'b').fadeOut], [1, 3, 1, 3, 0, 0]);
  assert.deepEqual(b2.chans, { scale: [{ f: 2.5, v: 2 }] });
  assert.notEqual(b2.chans, at(d, 'b').chans);
  const made = splitAt(d, ['zz'], 5, o);   // nothing picked is under 5: every clip under it
  assert.equal(made.length, 1);
  const i2 = at(d, made[0]);
  assert.deepEqual([at(d, 'i').out, i2.at, i2.in, i2.out], [1, 5, 0, 3]);
  assert.deepEqual(i2.chans.opacity.map((k) => k.f), [-1, 2]);
  assert.deepEqual(at(d, 'i').chans.opacity.map((k) => k.f), [0, 3]);
  assert.deepEqual(splitAt(d, null, 30, o), []);
});

test('delete and ripple delete: the gap closes on each affected track, space still covered stays', () => {
  let d = doc();
  assert.deepEqual(removeItems(d, ['a']), ['a']);
  assert.equal(d.items.length, 4);
  d = doc();
  d.items.push(C('e', 'v2', 5, 1));
  rippleDelete(d, ['b', 'd'], o);
  assert.deepEqual([at(d, 'a').at, at(d, 'c').at, at(d, 'e').at, at(d, 's').at], [0, 3, 3, 0]);
  d = doc();
  d.items.push(C('o', 'v1', 3, 4));   // covers 3..7, over b's end and c
  rippleDelete(d, ['b'], o);
  assert.deepEqual([at(d, 'o').at, at(d, 'c').at], [2, 5]);   // only 2..3 was emptied
});

test('close a gap', () => {
  const d = doc();
  assert.equal(closeGap(d, 'v1', 5.5, o), 1);
  assert.equal(at(d, 'c').at, 5);
  assert.equal(closeGap(d, 'v1', 1, o), 0);   // on a clip
  assert.equal(closeGap(d, 'v1', 9, o), 0);   // after the last
  assert.equal(closeGap(d, 'v2', 0.5, o), 1);   // from 0
  assert.equal(at(d, 'd').at, 0);
});

test('duplicate keeps the group spacing and gives each copy its own keys', () => {
  const d = doc();
  at(d, 'a').chans = { x: [{ f: 0, v: 1 }] };
  const made = duplicate(d, ['a', 'b'], o);
  assert.deepEqual(made.map((id) => at(d, id).at), [5, 7]);
  assert.notEqual(at(d, made[0]).chans, at(d, 'a').chans);
  assert.equal(duplicate(d, ['b'], o).map((id) => at(d, id).at)[0], 5);
});

test('copy and paste at the playhead onto valid tracks', () => {
  const d = doc();
  const clip = copy(d, ['b', 's']);
  assert.deepEqual(clip.items.map((x) => x.at), [2, 0]);
  const made = paste(d, clip, 10, o);
  assert.deepEqual(made.map((id) => [at(d, id).track, at(d, id).at]), [['v1', 12], ['a1', 10]]);
  trackLock(d, 'v1', true);
  const again = paste(d, clip, 20, o);   // v1 locked: b lands on the next video track; the audio stays on a1
  assert.deepEqual(again.map((id) => at(d, id).track), ['v2', 'a1']);
  trackLock(d, 'a1', true);
  assert.equal(paste(d, { items: [clip.items[1]] }, 0, o).length, 0);   // no track takes it
  assert.equal(copy(d, []), null);
});

test('nudge moves the group, not before 0', () => {
  const d = doc();
  assert.equal(nudge(d, ['b', 'c'], 0.5, o), 0.5);
  assert.deepEqual([at(d, 'b').at, at(d, 'c').at], [2.5, 6.5]);
  assert.equal(nudge(d, ['a', 'b'], -1, o), 0);
});

test('a locked track: its clips are not moved, trimmed, slipped, split, nudged, duplicated or deleted', () => {
  const d = doc();
  trackLock(d, 'v1', true);
  const before = structuredClone(d.items), g = grab(d);
  moveSet(d, ['a', 'b'], g, 1, { snap: false }, o);
  trim(d, ['b'], g, 'r', 1, { snap: false }, o);
  trim(d, ['d'], g, 'r', 1, { ripple: true, snap: false }, o);   // d is on v2; ripple does not reach v1 anyway
  slip(d, 'b', g, 1, o);
  nudge(d, ['a'], 1, o);
  assert.ok(splitAt(d, ['a'], 1, o).every((id) => at(d, id).track !== 'v1'));   // (a is skipped; what else is under 1 splits)
  assert.deepEqual(duplicate(d, ['a'], o), []);
  assert.deepEqual(removeItems(d, ['a', 'b']), []);
  assert.deepEqual(rippleDelete(d, ['c'], o), []);
  assert.equal(closeGap(d, 'v1', 5.5, o), 0);
  assert.deepEqual(d.items.filter((x) => x.track === 'v1'), before.filter((x) => x.track === 'v1'));
  assert.deepEqual(editable(d, ['a', 'd']).map((x) => x.id), ['d']);
  moveSet(d, ['d'], g, 0, { dTrack: -1, snap: false }, o);   // nor dropped onto
  assert.equal(at(d, 'd').track, 'v2');
});

test('track ops: lock, solo, rename, reorder, height', () => {
  const d = doc();
  assert.equal(trackLock(d, 'v2', true), true);
  assert.equal(d.tracks[1].locked, true);
  assert.equal(trackLock(d, 'zz', true), false);
  trackSolo(d, 'a1', true);
  assert.equal(d.tracks[2].solo, true);
  trackRename(d, 'v1', '  Main ');
  assert.equal(d.tracks[0].name, 'Main');
  trackRename(d, 'v1', ' ');
  assert.equal('name' in d.tracks[0], false);
  assert.equal(trackReorder(d, 'a1', 0), 0);
  assert.deepEqual(d.tracks.map((t) => t.id), ['a1', 'v1', 'v2']);
  assert.equal(trackReorder(d, 'a1', 99), 2);
  assert.equal(trackReorder(d, 'zz', 0), -1);
  assert.equal(trackHeight(d, 'v1', 999), 240);
  assert.equal(trackHeight(d, 'v1', 3, { min: 20 }), 20);
  assert.equal(trackHeight(d, 'zz', 50), null);
});

test('export folds solo into hidden and muted and drops the editor-only fields', () => {
  const tracks = [{ id: 'v1', kind: 'video', solo: true, locked: true, name: 'A', h: 60 }, { id: 'v2', kind: 'video' }, { id: 'a1', kind: 'audio', muted: false }];
  assert.deepEqual(exportTracks(tracks), [{ id: 'v1', kind: 'video' }, { id: 'v2', kind: 'video', muted: true, hidden: true }, { id: 'a1', kind: 'audio', muted: true }]);
  const audioSolo = [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio', solo: true }, { id: 'a2', kind: 'audio' }];
  assert.deepEqual(exportTracks(audioSolo), [{ id: 'v1', kind: 'video', muted: true }, { id: 'a1', kind: 'audio' }, { id: 'a2', kind: 'audio', muted: true }]);
  assert.deepEqual(exportTracks([{ id: 'v1', kind: 'video', hidden: true }]), [{ id: 'v1', kind: 'video', hidden: true }]);
  assert.equal(tracks[0].solo, true);   // (the editor's tracks are left as they are)
});

test('markers: add in time order, no double, move, rename, remove', () => {
  const d = { tracks: [], items: [] };
  assert.equal(addMarker(d, 5, 'b'), 0);
  assert.equal(addMarker(d, 2, 'a'), 0);
  assert.equal(addMarker(d, 2.0004), 0);
  assert.equal(d.markers.length, 2);
  assert.equal(moveMarker(d, 0, 8), 1);
  assert.deepEqual(d.markers.map((m) => [m.t, m.label]), [[5, 'b'], [8, 'a']]);
  assert.equal(moveMarker(d, 9, 1), -1);
  assert.equal(renameMarker(d, 0, 'Intro'), true);
  assert.equal(d.markers[0].label, 'Intro');
  assert.equal(removeMarker(d, 1), true);
  assert.equal(removeMarker(d, 1), false);
  assert.deepEqual(d.markers, [{ t: 5, label: 'Intro' }]);
});

test('trim: a group snaps by the edge of the clip grabbed (first in ids), not the first on the timeline', () => {
  const d = doc(), g = grab(d);
  // a ends at 2, b at 5; grabbing b's end and dragging 0.95 puts it at 5.95, which snaps to c's start (6)
  assert.equal(trim(d, ['b', 'a'], g, 'r', 0.95, { points: [6], tol: 0.1 }, o), 1);
  assert.equal(at(d, 'a').out, 3);
  assert.equal(at(d, 'b').out, 4);
});
