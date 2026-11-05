// node --test tests/action_rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepOf, cleanValues, isTerminal, canAppend, targetsFor, canPlay, replayValues, nextTarget, itemsOfRuns, planPlay, advance, stop, summary, describeStep } from '../web/action-rules.js';

const ev = (kind, op, values = {}, more = {}) => ({ kind, op, values, ...more });
const ok = (e) => { const r = stepOf(e); assert.equal(r.why, ''); return r.step; };

test('an op that needs the open frame is refused, with why', () => {
  const r = stepOf(ev('image', 'remove', {}));
  assert.equal(r.step, null);
  assert.match(r.why, /marks/i);
  assert.ok(stepOf(ev('video', 'trim')).why);
  assert.ok(stepOf(ev('image', 'inpaint')).why);
});
test('a painted red mask is refused, a found one is not', () => {
  assert.ok(stepOf(ev('image', 'edit', { ewhere: 'painted' })).why);
  assert.ok(stepOf(ev('image', 'swap', { swapWhere: 'painted' })).why);
  assert.ok(stepOf(ev('image', 'skin', { skinWhere: 'parts' })).why);
  assert.ok(stepOf(ev('image', 'unmark', { rfrom: 'painted' })).why);
  assert.equal(ok(ev('image', 'edit', { ewhere: 'find', efind: 'jacket' })).op, 'edit');
});
test('an unknown op or kind is refused', () => {
  assert.ok(stepOf(ev('image', 'nope')).why);
  assert.ok(stepOf(ev('weird', 'edit')).why);
  assert.ok(stepOf({}).why);
});
test('a cross-kind op is refused', () => {
  assert.match(stepOf(ev('video', 'talk')).why, /other kinds/);
  assert.ok(stepOf(ev('video', 'ingredients')).why);
});
test('Open in Blender makes nothing, so it is refused', () => {
  assert.match(stepOf(ev('scene', 'blender')).why, /nothing/);
  assert.equal(ok(ev('scene', 'cleanup')).target, 'self');
});
test('a step keeps its label, target, scope and batch; once ops take no batch', () => {
  const s = ok(ev('image', 'edit', { eprompt: 'night' }, { target: 'layer', scope: 'selected', batch: 3 }));
  assert.deepEqual([s.label, s.target, s.scope, s.batch], ['Edit from a prompt', 'layer', 'selected', 3]);
  assert.equal(ok(ev('image', 'edit', {}, { target: 'self' })).target, 'frame');   // not one of its choices: the default
  assert.equal(ok(ev('image', 'photo3d', {}, { batch: 4 })).batch, 1);
  assert.equal(ok(ev('video', 'upscale')).scope, undefined);
});
test('marks and the shot-only keys are stripped, references are kept', () => {
  const s = ok(ev('image', 'edit', { eprompt: 'x', erefs: ['a.png'], points: [1], boxes: [2], tracks: [3], matte: 'm', first: 'f', source: 's', swapFrom: 'face.png' }));
  assert.deepEqual(s.values, { eprompt: 'x', erefs: ['a.png'], swapFrom: 'face.png' });
});
test('a take loses the fields that hold its content (SHOT_KINDS), keeps the settings', () => {
  const fields = [{ key: '1.image', kind: 'image' }, { key: '2.seed', kind: 'seed' }, { key: '3.mask', kind: 'mask' }, { key: '4.steps', kind: 'int' }, { key: '5.text', kind: 'string' }];
  const v = { '1.image': 'p.png', '2.seed': 5, '3.mask': 'm', '4.steps': 20, '5.text': 'hi' };
  assert.deepEqual(cleanValues('make', 'deck-x', v, { fields }), { '4.steps': 20, '5.text': 'hi' });
  const r = stepOf({ kind: 'make', template: 'deck-krea2-edit', on: 'image', values: v, batch: 2, seeds: { '2.seed': { mode: 'increment', value: 7 } } }, { fields });
  assert.equal(r.why, '');
  assert.deepEqual(r.step.values, { '4.steps': 20, '5.text': 'hi' });
  assert.deepEqual(r.step.seeds, { '2.seed': { mode: 'increment', value: 7 } });
  assert.ok(stepOf({ kind: 'make', template: 't', on: 'mystery' }).why);
});
test('a step after a terminal step is refused; grab then image is allowed', () => {
  const obj = ok(ev('image', 'object3d')), photo = ok(ev('image', 'photo3d')), grab = ok(ev('video', 'grab')), edit = ok(ev('image', 'edit', {}));
  assert.equal(isTerminal(obj), true);
  assert.equal(isTerminal(photo), true);
  assert.equal(isTerminal(ok(ev('video', 'track'))), true);
  assert.equal(isTerminal(grab), false);
  assert.equal(isTerminal(edit), false);
  assert.ok(canAppend([obj], ok(ev('scene', 'cleanup'))));
  assert.equal(canAppend([grab], edit), '');
  assert.equal(canAppend([], edit), '');
  assert.equal(canAppend([edit], ok(ev('image', 'up'))), '');
});
test('a step that reads another kind than the last made is refused', () => {
  assert.match(canAppend([ok(ev('image', 'edit'))], ok(ev('video', 'upscale'))), /works on video/);
  assert.equal(canAppend([ok(ev('video', 'foley'))], ok(ev('sound', 'voice'))), '');
});
test('seeds: random is -1, fixed stays, increment steps by index times batch', () => {
  const step = (mode, extra = {}) => ({ kind: 'image', op: 'edit', batch: 2, values: { eprompt: 'x', eseed: 10, eseedMode: mode }, ...extra });
  assert.equal(replayValues(step('random'), 3).eseed, -1);
  assert.equal(replayValues(step('fixed'), 3).eseed, 10);
  assert.equal(replayValues(step('increment'), 0).eseed, 10);
  assert.equal(replayValues(step('increment'), 3).eseed, 16);
  assert.equal(replayValues(step('increment'), 3).eseedMode, 'fixed');
  const mk = { kind: 'make', op: 't', batch: 1, values: { a: 1 }, seeds: { s1: { mode: 'increment', value: 5 }, s2: { mode: 'random', value: 9 }, s3: { mode: 'fixed', value: 4 } } };
  assert.deepEqual(replayValues(mk, 2), { a: 1, s1: 7, s2: -1, s3: 4 });
  const s = step('fixed'); replayValues(s, 1).eprompt = 'changed'; assert.equal(s.values.eprompt, 'x');   // a copy
});
const F = (id, kind, label) => ({ id, kind, label });
test('targets in frames: the selected frames of the first step kind, notes and other kinds left out', () => {
  const r = targetsFor({ kind: 'image', frames: [F('a', 'image', 'A'), F('n', 'note'), F('v', 'video'), F('a', 'image'), F('b', 'image')] });
  assert.equal(r.mode, 'frames');
  assert.deepEqual(r.targets.map((t) => t.id), ['a', 'b']);
  assert.equal(r.targets[0].label, 'A');
});
test('targets in layers: the open image frame picked layers', () => {
  const r = targetsFor({ kind: 'image', scope: 'selected', openFrame: F('f', 'image', 'Frame'), layers: ['l1', 'l2', 'l1'], frames: [F('x', 'image')] });
  assert.equal(r.mode, 'layers');
  assert.deepEqual(r.targets.map((t) => [t.id, t.frame, t.layer]), [['l1', 'f', 'l1'], ['l2', 'f', 'l2']]);
  assert.deepEqual(targetsFor({ kind: 'image', scope: 'selected', openFrame: F('v', 'video'), layers: ['l'] }).targets, []);
});
test('targets in clips: the open video or sound frame picked clips, else its frames', () => {
  const r = targetsFor({ kind: 'video', openFrame: F('v', 'video'), clips: ['c1', 'c2'], frames: [F('v', 'video')] });
  assert.equal(r.mode, 'clips');
  assert.deepEqual(r.targets.map((t) => t.item), ['c1', 'c2']);
  assert.equal(targetsFor({ kind: 'video', openFrame: F('v', 'video'), clips: [], frames: [F('v', 'video'), F('w', 'video')] }).targets.length, 2);
  assert.equal(targetsFor({ kind: 'sound', openFrame: F('v', 'video'), clips: ['c'], frames: [] }).mode, 'frames');
});
test('canPlay: an image set on clips or video frames is refused with a why', () => {
  const img = ok(ev('image', 'edit', {}, { target: 'layer' })), vid = ok(ev('video', 'upscale', {}, { target: 'layer' }));
  assert.equal(canPlay([img], 'frames', 'image'), '');
  assert.match(canPlay([img], 'clips', 'video'), /starts on image/);
  assert.match(canPlay([img], 'frames', 'video'), /starts on image/);
  assert.match(canPlay([], 'frames', 'image'), /Record/);
  assert.equal(canPlay([img], 'layers', 'image'), '');
  assert.equal(canPlay([vid], 'clips', 'video'), '');
  assert.match(canPlay([ok(ev('image', 'edit', {}, { target: 'frame' }))], 'layers', 'image'), /new frame/);
  assert.match(canPlay([{ kind: 'image', op: 'gone', label: 'Old', values: {} }], 'frames', 'image'), /no longer available/);
});
test('nextTarget: frame goes into the new frame, layer stays with a main layer, self stays', () => {
  const t = { id: 'a', mode: 'frames', frame: 'a', main: 'old' };
  assert.deepEqual(nextTarget(t, { target: 'frame' }, { into: 'b' }), { id: 'a', mode: 'frames', frame: 'b' });
  assert.deepEqual(nextTarget(t, { target: 'layer' }, { layer: 'L9' }), { id: 'a', mode: 'frames', frame: 'a', main: 'L9' });
  assert.deepEqual(nextTarget(t, { target: 'self' }, {}), t);
  assert.equal(nextTarget(t, { target: 'frame' }, {}), null);
  assert.equal(nextTarget(t, { target: 'layer' }, {}), null);
});
test('nextTarget: layers follow the result layer, clips the landed item', () => {
  const l = { id: 'l1', mode: 'layers', frame: 'f', layer: 'l1' };
  assert.equal(nextTarget(l, { target: 'layer' }, { layer: 'l7' }).layer, 'l7');
  assert.equal(nextTarget(l, { target: 'layer' }, {}), null);
  const c = { id: 'c1', mode: 'clips', frame: 'v', item: 'c1' };
  const items = [{ id: 'c1', src: { generation: 'g0' } }, { id: 'c2', src: { generation: 'g5' } }];
  assert.equal(nextTarget(c, { target: 'layer' }, { items, gens: ['g5'] }).item, 'c2');
  assert.equal(nextTarget(c, { target: 'layer' }, { items, gens: ['g9'] }), null);
});
test('itemsOfRuns finds items by generation', () => {
  const items = [{ id: 'a', src: { generation: 'g1' } }, { id: 'b', src: { generation: 'g2' } }, { id: 'c' }, { id: 'd', src: { gen: 'g1' } }];
  assert.deepEqual(itemsOfRuns(items, ['g1']).map((i) => i.id), ['a', 'd']);
  assert.deepEqual(itemsOfRuns(items, []), []);
  assert.deepEqual(itemsOfRuns(null, ['g1']), []);
});
test('advance: a failure drops only that target; the step moves on when all answered', () => {
  const T = (id) => ({ id, mode: 'frames', frame: id, label: `Frame ${id}` });
  let st = planPlay([{}, {}], [T('a'), T('b'), T('c')]);
  assert.deepEqual([st.n, st.step, st.pending], [2, 0, ['a', 'b', 'c']]);
  st = advance(st, 'a', { ok: true, next: { ...T('a'), frame: 'a2' } });
  st = advance(st, 'b', { ok: false, why: 'out of memory' });
  assert.equal(st.step, 0);
  st = advance(st, 'c', { ok: true, next: T('c') });
  assert.deepEqual([st.step, st.pending, st.targets.map((t) => t.id), st.done], [1, ['a', 'c'], ['a', 'c'], false]);
  assert.equal(st.targets[0].frame, 'a2');
  assert.deepEqual(st.failed, [{ id: 'b', label: 'Frame b', step: 0, why: 'out of memory' }]);
  st = advance(st, 'a', { ok: true, next: T('a') });
  st = advance(st, 'c', { ok: true, next: T('c') });
  assert.equal(st.done, true);
  assert.equal(advance(st, 'a', { ok: false }), st);
});
test('advance: everything failing ends the play', () => {
  let st = planPlay([{}, {}], [{ id: 'a', label: 'A' }]);
  st = advance(st, 'a', { ok: false, why: 'x' });
  assert.equal(st.done, true);
});
test('summary: counts, the failed target and its step', () => {
  const T = (id, label) => ({ id, label, mode: 'frames', frame: id });
  let st = planPlay([{}, {}], [T('a', 'Frame A'), T('b', 'Frame B'), T('c', 'Frame C'), T('d', 'Frame D'), T('e', 'Frame E')]);
  for (const id of 'abcde') st = advance(st, id, id === 'b' ? { ok: true, next: T(id, 'Frame B') } : { ok: true, next: T(id, `Frame ${id.toUpperCase()}`) });
  st = advance(st, 'a', { ok: true, next: T('a', 'Frame A') });
  st = advance(st, 'b', { ok: false, why: 'no GPU' });
  for (const id of 'cde') st = advance(st, id, { ok: true, next: T(id, 'x') });
  assert.equal(summary(st, 'Night look'), 'Night look: 4 of 5 done; Frame B failed at step 2 (no GPU)');
  assert.equal(summary(planPlay([{}], []), 'N'), 'N: nothing to run on');
  const s2 = stop(planPlay([{}, {}], [T('a', 'A')]));
  assert.equal(summary(s2, 'N'), 'N: 0 of 1 done, stopped');
});
test('describeStep: label, quoted prompt, where it lands, batch', () => {
  assert.equal(describeStep({ label: 'Edit from a prompt', values: { eprompt: 'night' }, target: 'layer' }, 1), "1 Edit from a prompt · 'night' · layer");
  assert.equal(describeStep({ label: 'Upscale (quality)', values: {}, target: 'frame', batch: 3 }), 'Upscale (quality) · frame · × 3');
  assert.match(describeStep({ label: 'X', values: { prompt: 'a very long prompt that goes on and on' }, target: 'frame' }), /'a very long prompt that…'/);
  assert.equal(describeStep({ op: 'gone', values: {}, target: 'self' }), 'gone · self');
});
test('canPlay: a Make step runs on whole frames, so not on layers', () => {
  const img = ok(ev('image', 'edit', {}, { target: 'layer', scope: 'selected' }));
  const make = stepOf({ kind: 'make', template: 'deck-krea2-i2i', on: 'image', values: {}, target: 'layer' }).step;
  assert.equal(canPlay([img, make], 'frames', 'image'), '');
  assert.match(canPlay([img, make], 'layers', 'image'), /whole frame/);
});
test('Extend and Inpaint on the open frame are refused (the canvas and the red mask are that frame\'s)', () => {
  assert.match(stepOf(ev('image', 'extend')).why, /open frame/);
  assert.match(stepOf(ev('image', 'inpaint')).why, /painted/);
});
test('the real PER_SHOT list is honoured when passed in', () => {
  const s = stepOf(ev('video', 'upscale', { prompt: 'film', mine: 1 }), { perShot: ['mine'] }).step;
  assert.deepEqual(s.values, { prompt: 'film' });
});
