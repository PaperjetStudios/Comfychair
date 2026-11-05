// node --test tests/make_panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotMode, OP_TEMPLATES, canvasRect, carryKept, carryWords, familiesOf, frameImageField, frameOutput, frameSize, makeFrames, makeTarget, noteText, pickTemplate, settingsFor, settingsPayload,
  sizePair, templatesFor, withClip, itemSource, addHeld, settleHeld, plainFills, plainPicture, plainSound, plainVideo, renderKey, repointable, isOwnSlot, selfPicked, stableJson, wireFields } from '../web/make-rules.js';
import { owedFor, owedRecord } from '../web/owed-runs.js';

const T = (id, media, family = 'X', fields = []) => ({ id, media, family, fields });
const img = { key: '1.image', kind: 'image', node: '1', input: 'image' };
const W = { key: '2.width', kind: 'int', node: '2', input: 'width', min: 64, max: 2048 }, H = { key: '2.height', kind: 'int', node: '2', input: 'height', min: 64, max: 2048 };
const ALL = [
  T('deck-krea2-t2i', 'image', 'Krea', [W, H]), T('deck-krea2-edit', 'image', 'Krea', [img]), T('deck-krea2-inpaint', 'image', 'Inpaint', [img]),
  T('deck-qwen21-i2i', 'image', 'Qwen Image', [img, W, H]), T('deck-upscale-image', 'image', 'Upscale', [img]), T('deck-mask-image', 'image', 'Other', [img]),
  T('deck-depth-image', 'image', 'Depth', [img]),
  T('deck-ltx-t2v', 'video', 'LTX-2.5', [W, H]), T('deck-ltx-i2v', 'video', 'LTX-2.5', [img]), T('deck-h3-flf2v', 'video', 'MiniMax H3', [img, img]),
  T('deck-ltx-alpha', 'video', 'LTX-2.5'), T('deck-sam3-video-mask', 'video', 'SAM3'), T('deck-upscale-video', 'video', 'Upscale'), T('deck-depth-video', 'video', 'Depth'),
  T('deck-ltx-t2a', 'audio', 'LTX-2.5'), T('deck-ace-music', 'audio', 'ACE-Step'), T('deck-mmaudio-foley', 'audio', 'Other'),
  T('deck-3d-object', 'other', 'Other', [img]), T('deck-autorig-human', 'other', 'Other'), T('deck-mocap', 'other', 'Motion'),
  T('my-flux', 'image', 'Other', [W, H]),
];
const ids = (kind) => templatesFor(ALL, kind).map((t) => t.id);

test('the selection: the first frame that is not a note, else nothing', () => {
  assert.deepEqual(makeTarget([]), { kind: 'none', frame: null });
  assert.equal(makeTarget([{ id: 'n', kind: 'note' }]).kind, 'none');
  const v = { id: 'v', kind: 'video' };
  assert.equal(makeTarget([{ id: 'n', kind: 'note' }, v, { id: 'i', kind: 'image' }]).frame, v);
});
test('nothing selected: text to image and text to video, and a template of your own that takes no picture', () => {
  assert.deepEqual(ids('none'), ['deck-krea2-t2i', 'deck-ltx-t2v', 'my-flux']);
});
test('an image frame: image jobs, not inpaint (it needs a painted area), the maps, or what an Edit op runs (upscale)', () => {
  assert.deepEqual(ids('image'), ['deck-krea2-t2i', 'deck-krea2-edit', 'deck-qwen21-i2i', 'my-flux']);
});
test('a video frame: video templates, not the VFX ones or an Edit op\'s (upscale); text to video stays', () => {
  assert.deepEqual(ids('video'), ['deck-ltx-t2v', 'deck-ltx-i2v', 'deck-h3-flf2v']);
  // the character and object sheets are video Make's too (a clip and its sheet picture); the VFX tab's jobs are not
  const sheets = ['deck-h3-charsheet', 'deck-h3-charsheet-head', 'deck-h3-objectsheet'].map((id) => T(id, 'video', 'MiniMax H3', [img]));
  assert.deepEqual(templatesFor([...sheets, T('deck-sam3-video-mask', 'video', 'SAM3')], 'video').map((t) => t.id), sheets.map((t) => t.id));
});
test('3D and sound frames get their own families, less what their Edit ops run (rigging, foley)', () => {
  assert.deepEqual(ids('scene'), ['deck-3d-object', 'deck-mocap']);
  assert.deepEqual(ids('sound'), ['deck-ltx-t2a', 'deck-ace-music']);
});
test('the Edit ops\' templates are the ones left out, kind by kind', () => {
  for (const id of ['deck-upscale-image', 'deck-clean-image', 'deck-cutout-image', 'deck-qwen21-edit']) assert.ok(OP_TEMPLATES.image.has(id), id);
  assert.ok(!OP_TEMPLATES.image.has('deck-krea2-edit'));
  const up = T('deck-clean-image', 'image', 'Clean', [img]);
  assert.deepEqual(templatesFor([up], 'image'), []);
  assert.deepEqual(templatesFor([up], 'none'), []);
});
test('a run per selected frame of the kind; a note\'s words are the prompt', () => {
  const a = { id: 'a', kind: 'image' }, b = { id: 'b', kind: 'image' }, v = { id: 'v', kind: 'video' }, n = { id: 'n', kind: 'note', text: '  a red fox  ', label: 'Idea' };
  assert.deepEqual(makeFrames([n, a, v, b]).map((f) => f.id), ['a', 'b']);
  assert.deepEqual(makeFrames([n]), []);
  assert.deepEqual(makeFrames([]), []);
  assert.deepEqual(noteText([a, n]), { note: n, text: 'a red fox' });
  assert.equal(noteText([a, { id: 'e', kind: 'note', text: ' ' }]), null);
});
test('the panel\'s own settings: the template defaults with the frame\'s changes, and back to only the changes', () => {
  const P = { key: '3.text', kind: 'text', node: '3', input: 'text', multiline: true, group: 'Prompt', value: '' };
  const C = { key: '4.model', kind: 'choice', node: '4', input: 'model', options: ['a', 'b'], value: 'a' };
  const t = T('deck-x-t2i', 'image', 'X', [P, C, { ...W, value: 1024 }, { ...H, value: 1024 }]);
  const st = settingsFor(t, { template: 'deck-x-t2i', overrides: { '3.text': 'hi', '4.model': 'gone', '2.width': 512 }, seedMode: { s: 'fixed' } });
  assert.deepEqual(st.values, { '3.text': 'hi', '4.model': 'a', '2.width': 512, '2.height': 1024 });
  assert.deepEqual(st.seedMode, { s: 'fixed' });
  assert.equal(st.pb, null);
  const p = settingsPayload(st, { inputs: ['x.png'] });
  assert.deepEqual([p.template, p.overrides, p.inputs], ['deck-x-t2i', { '3.text': 'hi', '2.width': 512 }, ['x.png']]);
  assert.deepEqual(settingsFor(t, { template: 'other', overrides: { '3.text': 'no' } }).values['3.text'], '');
  const t2 = T('deck-y-t2i', 'image', 'Y', [{ ...P, key: '9.text' }]);
  assert.equal(carryWords(st, settingsFor(t2)).values['9.text'], 'hi');
});
test('Keep on, a template change carries the prompt, the picked pictures with their crops, the size and a fixed seed', () => {
  const P = { key: '3.text', kind: 'text', multiline: true, node: '3', input: 'text', value: 'own words' }, S = { key: 's', kind: 'seed', node: '5', input: 'seed', value: 0 };
  const img2 = { ...img, key: '6.image', node: '6' };
  const a = settingsFor(T('deck-a', 'image', 'X', [P, img, img2, { ...W, value: 1024 }, { ...H, value: 1024 }, S]));
  Object.assign(a.values, { '3.text': 'hi', '6.image': 'b.png', '2.width': 512, '2.height': 768, s: 7 });
  a.imageCrop['6.image'] = { x: 1 }; a.from['6.image'] = 'manual'; a.seedMode.s = 'fixed'; a.sizeMode['2.width'] = { mp: 1 };
  const tb = T('deck-b', 'image', 'X', [{ ...P, key: '9.text' }, { ...img, key: '7.image' }, { ...img, key: '8.image' },
    { ...W, key: '4.width', node: '4', value: 640 }, { ...H, key: '4.height', node: '4', value: 640 }, { ...S, key: 'n' }]);
  const b = carryKept(a, settingsFor(tb));
  assert.deepEqual(b.values, { '9.text': 'hi', '7.image': undefined, '8.image': 'b.png', '4.width': 512, '4.height': 768, n: 7 });   // (an empty slot carries nothing)
  assert.deepEqual([b.imageCrop, b.from, b.seedMode, b.sizeMode], [{ '8.image': { x: 1 } }, { '8.image': 'manual' }, { n: 'fixed' }, { '4.width': { mp: 1 } }]);
  a.seedMode = {}; a.values['3.text'] = ' ';
  const c = carryKept(a, settingsFor(tb));
  assert.deepEqual([c.values['9.text'], c.values.n, c.seedMode], ['own words', 0, {}]);   // (no words, a random seed: the template's own stay)
});
test('families and the template shown: the kept one if it still fits, else the first', () => {
  const l = templatesFor(ALL, 'image');
  assert.deepEqual(familiesOf(l), ['Krea', 'Other', 'Qwen Image']);
  assert.equal(pickTemplate(l, 'deck-ltx-i2v', null, 'deck-qwen21-i2i'), 'deck-qwen21-i2i');
  assert.equal(pickTemplate(l, null), 'deck-krea2-t2i');
  assert.equal(pickTemplate([], 'x'), null);
});
test('the frame picture goes in the first picture; the frame size is the output size, to 16 and the limits', () => {
  const t = ALL.find((x) => x.id === 'deck-qwen21-i2i');
  assert.equal(frameImageField(t), img);
  assert.equal(frameImageField(ALL[0]), null);
  assert.deepEqual(sizePair(t), [W, H]);
  assert.deepEqual(frameSize(sizePair(t), { w: 1000, h: 3000 }), { w: 1008, h: 2048 });
  assert.equal(frameSize(null, { w: 10, h: 10 }), null);
  assert.deepEqual(frameSize(sizePair(t), { w: 1920, h: 1080, out: { w: 768, h: 448 } }), { w: 768, h: 448 });
  assert.deepEqual(frameOutput({ w: 1920, h: 1080 }), { w: 1920, h: 1080 });
  assert.deepEqual(frameOutput({ w: 1920, h: 1080, out: { w: 768, h: 448 } }), { w: 768, h: 448 });
  assert.equal(frameOutput({}), null);
});
test('a layer that lands later: owed to the frame\'s document, with its name', () => {
  const rec = owedRecord('doc1', 'make', { name: null, px: [512, 512], rect: { x: 0, y: 0, w: 512, h: 512 }, label: 'Krea 2' }, { id: 7, prompt_id: 'p' }, 1, 1000);
  assert.equal(rec.label, 'Krea 2'); assert.equal(rec.op, 'make'); assert.equal(rec.nth, 1); assert.equal(rec.was, null);
  assert.deepEqual(owedFor([rec, { ...rec, id: 8, tab: 'other' }], 'doc1').map((r) => r.id), [7]);
  assert.deepEqual(canvasRect({ size: { w: 800, h: 600 } }, { w: 10, h: 10 }), { x: 0, y: 0, w: 800, h: 600 });
  assert.deepEqual(canvasRect({ size: null }, { w: 300, h: 200 }), { x: 0, y: 0, w: 300, h: 200 });
});
test('a clip goes at the end of the first video track', () => {
  const p = { tracks: [{ id: 'a1', kind: 'audio' }, { id: 'v1', kind: 'video' }], items: [{ id: 'x', track: 'v1', at: 2, in: 1, out: 4, dur: 5 }], size: null };
  const q = withClip(p, { src: { generation: 3, index: 0 }, url: '/u', label: '#3', dur: 6 }, 'n');
  const it = q.items[1];
  assert.equal(p.items.length, 1);
  assert.deepEqual([it.track, it.at, it.out, it.src.generation, it.id], ['v1', 5, 6, 3, 'n']);
  assert.equal(withClip({}, { src: {}, dur: 0 }, 'm').items[0].track, 'v1');
});
test('a copy sent for owed runs is kept in the record so it can go after the last one', () => {
  const base = { px: [1, 1], rect: {}, name: 'frame_1.png' };
  assert.equal(owedRecord('d', 'make', { ...base, copy: true }, { id: 1 }).copy, 'frame_1.png');
  assert.equal('copy' in owedRecord('d', 'make', base, { id: 1 }), false);
});

// ---- wires into the panel ----
const aud = { key: '5.audio', kind: 'audio', node: '5', input: 'audio' }, vid = { key: '6.video', kind: 'video', node: '6', input: 'video' };
const tpl = { id: 'x', media: 'video', fields: [img, { key: '3.image', kind: 'image', node: '3', input: 'image' }, vid, aud] };
const wire = (id, kind, n, extra = {}) => ({ id, kind, n, on: true, from: 'f' + id, to: 'me', ...extra });

test('settings carry wired through settingsFor and settingsPayload', () => {
  const st = settingsFor(tpl);
  assert.deepEqual(st.wired, {});
  st.wired['3.image'] = false; st.wired['6.video'] = 'w9';
  const p = settingsPayload(st);
  assert.deepEqual(p.wired, { '3.image': false, '6.video': 'w9' });
  assert.deepEqual(settingsFor(tpl, p).wired, { '3.image': false, '6.video': 'w9' });
  assert.deepEqual(settingsFor({ ...tpl, id: 'other' }, p).wired, {});   // (another template starts clean)
  p.wired.x = 1;
  assert.equal(st.wired.x, undefined);   // (a copy)
});
test('an image frame\'s own picture field is skipped when mapping its wires', () => {
  const ins = [wire('a', 'image', 1), wire('b', 'sound', 1)];
  assert.deepEqual(Object.keys(wireFields(tpl, 'image', ins).map), ['3.image', '5.audio']);
  assert.deepEqual(Object.keys(wireFields(tpl, 'video', ins).map), ['1.image', '5.audio']);
  assert.deepEqual(wireFields(tpl, 'video', [wire('c', 'video', 1), wire('d', 'video', 2)]).spare.map((w) => w.id), ['d']);
  assert.deepEqual(Object.keys(wireFields(tpl, 'video', ins, { '1.image': false }).map), ['3.image', '5.audio']);
});
test('a field left to itself, and what it could be re-pointed to', () => {
  const ins = [wire('a', 'image', 1), wire('b', 'image', 2)];
  const { map } = wireFields(tpl, 'video', ins);
  assert.deepEqual(repointable(tpl.fields[0], ins, map).map((w) => w.id), ['a']);
  assert.deepEqual(repointable(tpl.fields[1], ins, { '1.image': ins[0] }).map((w) => w.id), ['b']);
  assert.deepEqual(selfPicked(tpl, 'video', ins, { '1.image': false }).map((f) => f.key), ['1.image']);
  assert.deepEqual(selfPicked(tpl, 'video', [], { '1.image': false }), []);
});

const layer = (o = {}) => ({ name: 'a.png', crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0, y: 0, scale: 1, opacity: 1, hidden: false, ...o });
test('a plain picture: one whole layer, nothing done to it', () => {
  assert.equal(plainPicture({ layers: [layer()] }), 'a.png');
  assert.equal(plainPicture({ layers: [{ name: 'b.png' }] }), 'b.png');
  for (const bad of [{ crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }, { scale: 2 }, { rotation: 10 }, { flipX: true }, { hidden: true }, { opacity: 0.5 }, { blend: 'multiply' },
    { adjust: { on: true } }, { mask: true }, { fill: '#fff' }, { group: 'g' }]) assert.equal(plainPicture({ layers: [layer(bad)] }), null, JSON.stringify(bad));
  assert.equal(plainPicture({ layers: [layer(), layer({ name: 'c.png' })] }), null);
  assert.equal(plainPicture({ layers: [layer()], items: [{ x: 1 }] }), null);
  assert.equal(plainPicture({ layers: [] }), null);
  assert.equal(plainPicture(null), null);
});
const vclip = (o = {}) => ({ id: 'i', track: 'v1', kind: 'video', src: { generation: 5, index: 0 }, at: 0, in: 1, out: 4, dur: 6, x: 0, y: 0, scale: 1, fit: 'fit', opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0, ...o });
const tracks = [{ id: 'v1', kind: 'video' }, { id: 'a1', kind: 'audio' }];
test('a plain video: one clip at 0, default transform, no effects; its source and trim', () => {
  const p = { tracks, items: [vclip()] };
  assert.equal(plainVideo(p).id, 'i');
  assert.deepEqual(itemSource(plainVideo(p)), { generation: 5, index: 0, trim: { start: 1, len: 3 } });
  assert.deepEqual(itemSource(vclip({ src: { media: 'm.mp4' }, in: 0, out: undefined, dur: 0 })), { media: 'm.mp4' });
  for (const bad of [{ at: 2 }, { scale: 1.2 }, { x: 10 }, { rotation: 5 }, { opacity: 0.5 }, { fadeIn: 1 }, { adjust: { on: true } }, { volume: 0.5 }, { kind: 'image' }])
    assert.equal(plainVideo({ tracks, items: [vclip(bad)] }), null, JSON.stringify(bad));
  assert.equal(plainVideo({ tracks, items: [vclip(), vclip({ id: 'j', track: 'v2' })] }), null);
  assert.equal(plainVideo({ tracks, items: [vclip()], range: [0, 1] }), null);
  assert.equal(plainVideo({ tracks: [{ id: 'v1', kind: 'video', hidden: true }], items: [vclip()] }), null);
  assert.equal(plainVideo({ tracks: [{ id: 'v1', kind: 'video', muted: true }], items: [vclip()] }), null);
  assert.equal(plainVideo({ tracks, items: [] }), null);
});
const sclip = (o = {}) => ({ id: 's', track: 'a1', kind: 'audio', src: { media: 'v.wav' }, at: 0, in: 0, out: 2, dur: 2, volume: 1, pan: 0, ...o });
test('a plain sound: one clip at 0, level 1, centred, no fades; a mix is not plain', () => {
  const p = { tracks, items: [sclip()], out: { gain: 1 } };
  assert.equal(plainSound(p).id, 's');
  assert.deepEqual(itemSource(plainSound(p)), { media: 'v.wav', trim: { start: 0, len: 2 } });
  for (const bad of [{ at: 1 }, { volume: 0.5 }, { pan: 0.3 }, { fadeOut: 0.5 }, { chans: { v: [] } }, { kind: 'video' }]) assert.equal(plainSound({ tracks, items: [sclip(bad)] }), null, JSON.stringify(bad));
  assert.equal(plainSound({ tracks, items: [sclip(), sclip({ id: 't' })] }), null);
  assert.equal(plainSound({ tracks, items: [sclip()], out: { normalize: true } }), null);
  assert.equal(plainSound({ tracks, items: [sclip()], out: { gain: 2 } }), null);
});

test('the render key is stable, ignores project and tab, and changes with an edit', () => {
  const body = () => ({ project_id: 3, tab: { id: 'd', name: 'A' }, width: 1280, height: 720, fps: 24, tracks, items: [{ track: 'v1', at: 0, src: { generation: 5, index: 0 }, in: 0, out: 3, scale: 1, grade: null }] });
  const k = renderKey(body());
  assert.match(k, /^[0-9a-f]{14}$/);
  assert.equal(renderKey(body()), k);
  assert.equal(renderKey({ ...body(), project_id: 9, tab: { id: 'd', name: 'B' } }), k);
  const reordered = body(); reordered.items[0] = Object.fromEntries(Object.entries(reordered.items[0]).reverse());
  assert.equal(renderKey(reordered), k);   // (key order is not part of it)
  const trimmed = body(); trimmed.items[0].out = 2.5;
  assert.notEqual(renderKey(trimmed), k);
  const graded = body(); graded.items[0].grade = { r: [0, 1] };
  assert.notEqual(renderKey(graded), k);
  const longer = body(); longer.items.push({ ...longer.items[0], at: 3 });
  assert.notEqual(renderKey(longer), k);
  assert.equal(stableJson({ b: 1, a: [undefined, { d: 1, c: undefined }] }), '{"a":[null,{"d":1}],"b":1}');
});

// ---- a frame's run without its fields on show (chain-run.js runFrame) ----
import { runValuesOf, seedsAfter } from '../web/make-rules.js';

test('runValuesOf / seedsAfter: seeds as Generate sends them, increment moves on', () => {
  const t = { id: 'x', fields: [{ key: 's', kind: 'seed', value: 5 }, { key: 'u', kind: 'seed', value: 9 }, { key: 'p', kind: 'text', value: 'hi' }, { key: 'l', kind: 'loras', value: [] }] };
  const st = settingsFor(t, { template: 'x', overrides: { p: 'a cat', s: 7 }, seedMode: { s: 'increment' } });
  const v = runValuesOf(st);
  assert.deepEqual(v, { s: 7, u: -1, p: 'a cat', l: [] });
  v.l.push(1);
  assert.deepEqual(st.values.l, [], 'a copy');
  const used = seedsAfter(st, [{ params: { s: 7, u: 123 } }, { params: { s: 8, u: 456 } }], 2);
  assert.deepEqual(used, { s: 8, u: 456 });
  assert.equal(st.values.s, 9);
  assert.equal(st.values.u, 9, 'random stays');
});

test('an empty image frame lets a plugged picture take the main slot; one with a picture keeps it and offers Use here', () => {
  const t = { fields: [{ key: '1.image', kind: 'image', input: 'image' }] };
  const ins = [{ id: 'a', kind: 'image', n: 1 }];
  assert.deepEqual(Object.keys(wireFields(t, 'image', ins).map), [], 'with a picture of its own: the slot is the frame\'s');
  assert.equal(wireFields(t, 'image', ins).spare.length, 1);
  assert.deepEqual(Object.keys(wireFields(t, 'image', ins, {}, { ownPicture: false }).map), ['1.image']);
  assert.deepEqual(Object.keys(wireFields(t, 'image', ins, { '1.image': 'a' }).map), ['1.image'], 're-pointed to the wire');
  assert.deepEqual(selfPicked(t, 'image', ins).map((f) => f.key), ['1.image']);
  assert.equal(isOwnSlot(t, 'image', t.fields[0]), true);
  assert.deepEqual(selfPicked(t, 'image', ins, {}, { ownPicture: false }), []);
  assert.deepEqual(selfPicked(t, 'image', ins, { '1.image': 'a' }), []);
});

test('plainFills: the one plain layer fills the canvas exactly, else it is not what the frame shows', () => {
  const p = (l, size = { w: 100, h: 50 }) => ({ size, layers: [{ name: 'a.png', x: 0, y: 0, scale: 1, ...l }] });
  assert.equal(plainFills(p({}), [100, 50]), true);
  assert.equal(plainFills(p({}), [200, 50]), false, 'the canvas cuts the picture');
  assert.equal(plainFills(p({ x: 10 }), [100, 50]), false, 'moved: a margin, and a cut');
  assert.equal(plainFills(p({}, null), [100, 50]), false, 'no canvas size known');
  assert.equal(plainFills(p({}), null), false, 'no picture size known');
  assert.equal(plainFills(p({ x: 0.3 }), [100.4, 50]), true, 'within a pixel');
});

test('held wire pictures: added per run, settled by the runs\' status only', () => {
  let held = addHeld([], ['w1.png', 'w2.png'], [{ id: 7 }, { id: 8 }]);
  assert.equal(held.length, 4);
  assert.deepEqual(addHeld(held, ['w1.png'], [{ id: 7 }]), held, 'no repeats');
  const st = { 7: 'done', 8: 'running' };
  let r = settleHeld(held, (g) => st[g]);
  assert.deepEqual(r.drop, [], 'run 8 still reads both');
  assert.equal(r.held.length, 2);
  st[8] = 'error';
  r = settleHeld(held, (g) => st[g]);
  assert.deepEqual(r.drop, ['w1.png', 'w2.png']);
  assert.deepEqual(r.held, []);
  held = addHeld([], ['a.png'], [{ id: 1 }]);
  assert.deepEqual(settleHeld(held, () => null).drop, [], 'a status not known yet (after a reload) keeps it');
  assert.deepEqual(settleHeld(held, () => 'gone').drop, ['a.png'], 'a run that no longer exists lets it go');
  assert.deepEqual(settleHeld(held, () => 'interrupted').drop, ['a.png'], 'a stopped run lets it go');
  assert.deepEqual(settleHeld(undefined, () => 'done'), { held: [], drop: [] });
});

test('slotMode: every picture or clip slot can come from layers, a plugged input or by hand', () => {
  const a = { key: 'a', kind: 'image' }, b = { key: 'b', kind: 'image' }, v = { key: 'v', kind: 'video' }, t = { fields: [a, b, v] };
  const img = { id: 'w1', kind: 'image', n: 1, on: true }, vid = { id: 'w2', kind: 'video', n: 1, on: true };
  // nothing chosen: the first picture is the frame's layers, a plugged input takes the next slot of its kind
  assert.equal(slotMode(t, 'image', a, {}, [img, vid]), 'layers');
  assert.equal(slotMode(t, 'image', b, {}, [img, vid]), 'wire');
  assert.equal(slotMode(t, 'image', v, {}, [img, vid]), 'wire');
  assert.equal(slotMode(t, 'image', b, {}, []), 'manual');
  // the first picture can be set by hand or plugged (the control picture of a control template)
  assert.equal(slotMode(t, 'image', a, { from: { a: 'manual' }, wired: { a: false } }, [img]), 'manual');
  assert.equal(slotMode(t, 'image', a, { wired: { a: 'w1' } }, [img]), 'wire');
  // any picture slot can come from layers; a clip slot and other kinds of frame can't
  assert.equal(slotMode(t, 'image', b, { from: { b: 'layers' }, wired: { b: false } }, [img]), 'layers');
  assert.equal(slotMode(t, 'image', v, { from: { v: 'layers' }, wired: { v: false } }, []), 'manual');
  assert.equal(slotMode(t, 'video', a, {}, []), 'manual');
  // an input switched off leaves the slot to itself; the choice is kept with the frame
  assert.equal(slotMode(t, 'image', b, {}, [{ ...img, on: false }]), 'manual');
  const st = settingsFor(t, settingsPayload({ tpl: t, values: {}, seedMode: {}, imageMp: {}, imageCrop: {}, sizeMode: {}, loraFolder: {}, from: { a: 'manual' }, layerSrc: { b: { layer: 'k', mp: 2 } } }));
  assert.deepEqual([st.from, st.layerSrc], [{ a: 'manual' }, { b: { layer: 'k', mp: 2 } }]);
});
