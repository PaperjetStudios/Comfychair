// node --test tests/make_panel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasRect, familiesOf, frameImageField, frameSize, makeTarget, pickTemplate, sizePair, templatesFor, withClip } from '../web/make-rules.js';
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
test('an image frame: image jobs, not inpaint (it needs a painted area) or the maps', () => {
  assert.deepEqual(ids('image'), ['deck-krea2-t2i', 'deck-krea2-edit', 'deck-qwen21-i2i', 'deck-upscale-image', 'my-flux']);
});
test('a video frame: video templates, not the VFX ones', () => {
  assert.deepEqual(ids('video'), ['deck-ltx-t2v', 'deck-ltx-i2v', 'deck-h3-flf2v', 'deck-upscale-video']);
});
test('3D and sound frames get their own families', () => {
  assert.deepEqual(ids('scene'), ['deck-3d-object', 'deck-autorig-human', 'deck-mocap']);
  assert.deepEqual(ids('sound'), ['deck-ltx-t2a', 'deck-ace-music', 'deck-mmaudio-foley']);
});
test('families and the template shown: the kept one if it still fits, else the first', () => {
  const l = templatesFor(ALL, 'image');
  assert.deepEqual(familiesOf(l), ['Krea', 'Other', 'Qwen Image', 'Upscale']);
  assert.equal(pickTemplate(l, 'deck-ltx-i2v', null, 'deck-upscale-image'), 'deck-upscale-image');
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
