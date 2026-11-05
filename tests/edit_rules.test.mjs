// node --test tests/edit_rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPS, canRun, crossOps, defaultTarget, groupsOf, menuOf, menuGroupsFor, opById, opsFor, planRuns, quickOf, resultKind, resultLabel, targetsOf, whyNot } from '../web/edit-rules.js';

const F = (id, kind, extra = {}) => ({ id, kind, label: id.toUpperCase(), doc: `d-${id}`, ...extra });

test('every op has an id, a group, a label, an icon and says what it needs; no id twice in a kind', () => {
  for (const [kind, list] of Object.entries(OPS)) {
    assert.equal(new Set(list.map((o) => o.id)).size, list.length, kind);
    for (const o of list) {
      assert.equal(o.kind, kind);
      assert.ok(o.id && o.group && o.label && o.icon, `${kind}:${o.id}`);
      assert.ok(['still', 'clip', 'doc', 'live'].includes(o.needs), `${kind}:${o.id} needs ${o.needs}`);
      if (o.needs === 'live') assert.ok(o.why, `${kind}:${o.id} says why it needs the open frame`);
    }
  }
});
test('the kinds of a selection, in the order they first appear; notes and unknown kinds left out', () => {
  const m = opsFor([F('n', 'note'), F('v', 'video'), F('a', 'image'), F('b', 'image'), F('s', 'sound'), F('x', 'weird')]);
  assert.deepEqual([...m.keys()], ['video', 'image', 'sound']);
  assert.equal(m.get('image'), OPS.image);
  assert.equal(opsFor([]).size, 0);
});
test('a live-only op is greyed with its reason until the frame is open', () => {
  const remove = opById('image', 'remove');
  assert.equal(canRun(remove), false);
  assert.match(whyNot(remove), /open frame/);
  assert.equal(canRun(remove, { live: true }), true);
  assert.equal(canRun(opById('image', 'up')), true);
  assert.equal(whyNot(null), 'Unknown edit');
});
test('some ops need the open frame only with some settings', () => {
  const edit = opById('image', 'edit'), skin = opById('image', 'skin');
  assert.equal(canRun(edit, { opts: { ewhere: 'all' } }), true);
  assert.equal(canRun(edit, { opts: { ewhere: 'words' } }), true);
  assert.equal(canRun(edit, { opts: { ewhere: 'painted' } }), false);
  assert.equal(canRun(edit, { live: true, opts: { ewhere: 'painted' } }), true);
  assert.equal(canRun(skin, { opts: { skinWhere: 'whole' } }), true);
  assert.equal(canRun(skin, { opts: { skinWhere: 'parts' } }), false);
  assert.equal(canRun(skin), true);
});
test('the quick row: one button per quick label, with the plain ops of its group behind it', () => {
  const q = quickOf('image');
  assert.equal(q[0].label, 'Edit');
  const up = q.find((x) => x.label === 'Upscale');
  assert.deepEqual(up.ids, ['up', 'upfast']);
  assert.ok(!q.some((x) => x.ids.includes('remove')), 'a live-only op is not behind a quick button');
  assert.ok(quickOf('video').some((x) => x.label === 'Grab'));
  assert.deepEqual(quickOf('note'), []);
});
test('groups come in their order, and hold every op once', () => {
  const g = groupsOf('video');
  assert.equal(g[0].group, 'Quick');
  assert.equal(g.reduce((n, x) => n + x.ops.length, 0), OPS.video.length);
  assert.deepEqual(groupsOf('nothing'), []);
});
test('a run per frame of the op\'s kind, with the batch; no document or doubles are skipped or dropped', () => {
  const a = F('a', 'image'), b = F('b', 'image'), v = F('v', 'video'), empty = F('e', 'image', { doc: null });
  const { runs, skipped } = planRuns([a, v, b, a, empty], opById('image', 'up'), 3);
  assert.deepEqual(runs.map((r) => [r.frame.id, r.batch]), [['a', 3], ['b', 3]]);
  assert.deepEqual(skipped.map((s) => s.frame.id), ['e']);
  assert.equal(planRuns([a], opById('image', 'up'), 99).runs[0].batch, 32);
  assert.equal(planRuns([a], opById('image', 'up'), 'x').runs[0].batch, 1);
  assert.equal(planRuns([F('s', 'sound')], opById('sound', 'foley'), 4).runs[0].batch, 4, 'a sound op runs as many times as asked');
  assert.deepEqual(planRuns([a], null).runs, []);
});
test('the menu: one kind gives its groups under Edit; several give Edit image / Edit video', () => {
  const one = menuGroupsFor([F('a', 'image')]);
  assert.equal(one.length, 2, 'Edit, then Make video (an Ingredients sheet from the picture)');
  assert.equal(one[0].title, 'Edit');
  assert.equal(one[1].title, 'Make video');
  const flat = one[0].groups.flat();
  assert.equal(flat.length, OPS.image.length);
  assert.equal(flat.find((x) => x.id === 'remove').disabled, true);
  assert.equal(flat.find((x) => x.id === 'up').disabled, false);
  const live = menuGroupsFor([F('a', 'image')], { live: () => true })[0].groups.flat();
  assert.equal(live.find((x) => x.id === 'remove').disabled, false);
  const two = menuGroupsFor([F('a', 'image'), F('v', 'video'), F('n', 'note')]);
  assert.deepEqual(two.map((x) => x.title), ['Edit image', 'Edit video'], 'a video frame there: no Make video');
  const opts = menuGroupsFor([F('a', 'image')], { opts: (k, id) => (id === 'edit' ? { ewhere: 'painted' } : {}) })[0].groups.flat();
  assert.equal(opts.find((x) => x.id === 'edit').disabled, true);
  assert.equal(menuGroupsFor([F('n', 'note')]).length, 0);
});
test('where results land: a new frame from the table, a layer in an open frame, the document itself for 3D and settings', () => {
  const up = opById('image', 'up');
  assert.deepEqual(targetsOf(up), ['frame', 'layer']);
  assert.equal(defaultTarget(up), 'frame');
  assert.equal(defaultTarget(up, true), 'layer');
  assert.deepEqual(targetsOf(opById('scene', 'cleanup')), ['self']);
  assert.equal(defaultTarget(opById('scene', 'cleanup'), false), 'self');
  assert.deepEqual(targetsOf(null), []);
  assert.equal(resultKind(opById('video', 'grab')), 'image');
  assert.equal(resultKind(opById('video', 'foley')), 'sound');
  assert.equal(resultKind(opById('video', 'restyle')), 'video');
  assert.equal(resultLabel(up, F('a', 'image')), 'Upscale (quality) · A');
  assert.equal(resultLabel(up, { kind: 'image' }), 'Upscale (quality) · image');
});

test('no op of any kind opens another screen: what used to be Use as is an op that lands in a frame', () => {
  for (const [kind, id, lands] of [['image', 'photo3d', 'scene'], ['image', 'object3d', 'scene'], ['image', 'splat', 'scene'],
    ['video', 'sound', 'sound'], ['video', 'render', 'video'], ['video', 'track', 'scene'], ['video', 'views', 'image'], ['video', 'h3up', 'video'], ['video', 'finish', 'video']]) {
    const o = opById(kind, id);
    assert.ok(o, `${kind}:${id}`);
    assert.equal(resultKind(o), lands, `${kind}:${id} lands`);
    if (id !== 'finish') assert.deepEqual(targetsOf(o), ['frame'], `${kind}:${id} is always a frame of its own`);
    assert.equal(canRun(o), true, `${kind}:${id} runs from the table`);
  }
});
test('cross-kind ops: pictures and a sound make a video frame; one run, from the first frame they take', () => {
  const a = F('a', 'image'), s = F('s', 'sound'), v = F('v', 'video'), n = F('n', 'note');
  assert.deepEqual(crossOps([a, s]).map((o) => o.id).sort(), ['a2v', 'ingredients', 'talk']);
  assert.deepEqual(crossOps([s]).map((o) => o.id).sort(), ['a2v', 'talk']);
  assert.deepEqual(crossOps([a, v]), [], 'a video frame selected: its own ops run on it');
  assert.deepEqual(crossOps([n]), []);
  const m = menuGroupsFor([s, a]);
  assert.deepEqual(m.map((x) => x.title), ['Edit sound', 'Edit image', 'Make video']);
  assert.equal(m[2].kind, 'video');
  assert.ok(m[2].groups.flat().every((x) => !x.disabled));
  const a2v = opById('video', 'a2v');
  const p = planRuns([n, s, a, F('b', 'image')], a2v, 4);
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].frame, s);
  assert.equal(p.runs[0].frame.kind, 'sound');
  assert.deepEqual(planRuns([v, s], a2v).runs.map((r) => r.frame), [v], 'on a video frame it is an ordinary op');
  assert.deepEqual(planRuns([F('e', 'image', { doc: null })], opById('video', 'ingredients')).skipped.length, 1);
});

test('quickOf: an op lights one button only', () => {
  for (const kind of ['image', 'video', 'sound', 'scene']) {
    const seen = quickOf(kind).flatMap((q) => q.ids);
    assert.equal(new Set(seen).size, seen.length, `${kind}: an op is under two buttons`);
  }
  const owner = (id) => quickOf('image').filter((q) => q.ids.includes(id)).map((q) => q.label);
  assert.deepEqual(owner('blend'), ['Detail']);
  assert.deepEqual(owner('delight'), ['Detail']);
  assert.deepEqual(owner('skin'), ['Skin']);
});

test('menuOf: every op once, under its button or its group', () => {
  for (const kind of ['image', 'video', 'sound', 'scene']) {
    const all = menuOf(kind).flatMap((r) => r.all);
    assert.equal(new Set(all).size, all.length, `${kind}: an op is listed twice`);
    assert.deepEqual([...all].sort(), OPS[kind].map((o) => o.id).sort(), `${kind}: every op is listed`);
    assert.ok(menuOf(kind).every((r) => r.all.length), `${kind}: no empty category`);
  }
  const of = (id) => menuOf('image').find((r) => r.all.includes(id));
  assert.equal(of('blend').label, 'Detail');
  assert.ok(of('remove').all.includes('unmark') || of('remove'), 'a live-only op has a place');
  assert.deepEqual(of('up').all, ['up', 'upfast']);
});
