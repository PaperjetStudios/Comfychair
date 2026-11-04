// node --test tests/vfx_rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLANK, EFFECTS, FPS, buildRun, delogoRunBody, effectById, keyBody, matteBody, mergeOps, migrateVfxDoc, missingInput, snapBox, tplIdOf } from '../web/vfx-rules.js';
import { OPS, canRun, opById, whyNot } from '../web/edit-rules.js';

// a template with one field per role it is asked for (keys "n.<role>")
const tpl = (id, roles) => ({ id, fields: roles.map((r) => ({ key: `n.${r}`, role: r })) });
const deps = (t, extra = {}) => ({ template: (id) => (id === t.id ? t : null), roleField: (x, role) => x?.fields.find((f) => f.role === role) || null, ...extra });
const st = (patch) => ({ ...BLANK(), ...patch });
const SRC = { generation: 7, index: 0, trim: { start: 2, len: 4 } };

test('every Edit video op with vfx names an effect, and only tools the overlay has', () => {
  const vfx = OPS.video.filter((o) => o.vfx);
  assert.ok(vfx.length >= 18);
  for (const o of vfx) {
    assert.ok(effectById(o.vfx), `${o.id} → ${o.vfx}`);
    for (const t of o.tools || []) assert.ok(['points', 'boxes', 'paths', 'matte', 'color'].includes(t), `${o.id}: ${t}`);
  }
  // every effect is reachable from the Edit pane: as its own op, or as the op that runs it (restyle, the maps, the clip effects)
  const covered = new Set([...vfx.map((o) => o.vfx), 'lora', 'depth', 'canny', 'scribble', 'pose', 'cleanplate', 'upscale']);
  for (const id of ['restyle', 'maps', 'cleanplate', 'upscale']) assert.ok(opById('video', id), id);
  for (const e of EFFECTS) assert.ok(covered.has(e.id), e.id);
  assert.equal(opById('video', 'points'), null, 'Mask by tapping is Mask (SAM3) with points');
});

test('Mask (SAM3) is headless with a name, needs the open frame for points only', () => {
  const mask = opById('video', 'mask');
  assert.deepEqual(mask.tools, ['points']);
  assert.equal(canRun(mask, { opts: { prompt: 'the dog' } }), true);
  assert.match(whyNot(mask, { opts: { prompt: '  ' } }), /open frame/);
  assert.equal(canRun(mask, { opts: { points: { positive: [{ x: 0.5, y: 0.5 }], negative: [] } } }), true);
  assert.equal(canRun(mask, { live: true }), true);
  assert.equal(canRun(opById('video', 'tracks'), {}), false);
  assert.equal(canRun(opById('video', 'colorkey'), {}), true);
  assert.equal(canRun(opById('video', 'ripple'), { opts: { first: 'a.png' } }), true);
});

test('missingInput says what a run still needs', () => {
  const e = (id) => effectById(id);
  assert.match(missingInput(e('mask'), st({})), /source clip/);
  assert.equal(missingInput(e('mask'), st({ source: SRC })), null);
  assert.match(missingInput(e('mattekey'), st({ source: SRC })), /matte/);
  assert.match(missingInput(e('animate'), st({ source: SRC })), /start image/);
  assert.match(missingInput(e('talk'), st({ first: 'a.png' })), /Speak the line/);
  assert.match(missingInput(e('delogo'), st({ source: SRC })), /box/);
  assert.equal(missingInput(e('depth'), st({ first: 'a.png' })), null, 'a map of a picture needs no clip');
});

test('buildRun: points in pixels of the cropped clip, their frame counted from the trim', async () => {
  const e = effectById('mask'), t = tpl('deck-sam3-video-mask', ['source', 'prompt', 'len', 'pointsPos', 'pointsNeg', 'mode', 'pframe', 'score', 'direction', 'which']);
  const s = st({ source: { ...SRC, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, points: { positive: [{ x: 0.75, y: 0.5 }, { x: 1, y: 1 }], negative: [{ x: 0.5, y: 0 }] }, pointsAt: 3, len: 4 });
  const r = await buildRun(e, s, deps(t, { sourceInfo: async () => ({ width: 1920, height: 1080 }) }));
  assert.equal(r.t, t);
  assert.deepEqual(r.values['n.source'], { generation: 7, index: 0, trim: { start: 2, len: 4 }, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
  assert.deepEqual(JSON.parse(r.values['n.pointsPos']), [{ x: 480, y: 540 }, { x: 960, y: 1080 }]);
  assert.deepEqual(JSON.parse(r.values['n.pointsNeg']), [{ x: 0, y: 0 }]);
  assert.equal(r.values['n.mode'], 'point');
  assert.equal(r.values['n.pframe'], FPS);   // 3 s into the clip, its trim starting at 2 s
  assert.equal(r.values['n.len'], 4);
  assert.equal(r.values['n.score'], 0.3);
});
test('buildRun: a mask by name, or why it can\'t', async () => {
  const e = effectById('mask'), t = tpl('deck-sam3-video-mask', ['source', 'prompt', 'mode', 'pframe', 'pointsPos', 'pointsNeg']);
  assert.match(await buildRun(e, st({ source: SRC }), deps(t)), /Tap the thing/);
  const r = await buildRun(e, st({ source: SRC, prompt: 'the dog' }), deps(t));
  assert.equal(r.values['n.prompt'], 'the dog');
  assert.equal(r.values['n.mode'], 'text');
  assert.equal(r.values['n.pframe'], 0);
  assert.match(await buildRun(e, st({ source: SRC, prompt: 'x' }), deps(tpl('other', []))), /isn't installed/);
});
test('buildRun: the template variant a state asks for, and an H3 run\'s steps and resolution', async () => {
  assert.equal(tplIdOf(effectById('drive'), st({ poser: 'sdpose' })), 'deck-h3-drive-sd');
  assert.equal(tplIdOf(effectById('alpha'), st({ matte: { generation: 1 } })), 'deck-ltx-alpha-crop');
  assert.equal(tplIdOf(effectById('depth'), st({ first: 'a.png' })), 'deck-depth-image');
  const e = effectById('animate'), t = tpl('deck-h3-animate', ['source', 'first', 'len', 'res', 'steps', 'seed']);
  const r = await buildRun(e, st({ source: SRC, first: 'who.png', res: 704, steps: 5, seed: 9, len: 4 }), deps(t));
  assert.equal(r.values['n.res'], 480, 'a resolution the effect does not have falls back to its middle one');
  assert.match(r.values['n.steps'], /^1\.0, 0\.923/);
  assert.equal(r.values['n.first'], 'who.png');
  assert.equal(r.values['n.seed'], 9);
  assert.equal(r.rv.first, 'who.png');
});
test('buildRun: Extend frame sends the canvas the server made', async () => {
  const e = effectById('extend'), t = tpl('deck-ltx-inpaint', ['source', 'matte', 'prompt', 'len', 'res', 'seed']);
  let asked = null;
  const r = await buildRun(e, st({ source: SRC, canvas: { aspect: 1, scale: 1, cx: 0.5, cy: 0.5 } }),
    deps(t, { aspect: async () => 16 / 9, canvas: async (b) => { asked = b; return { video: { canvas: 'v' }, mask: { canvas: 'm' } }; } }));
  assert.equal(asked.aspect, 1);
  assert.deepEqual(asked.trim, SRC.trim);
  assert.deepEqual(r.values['n.source'], { canvas: 'v' });
  assert.deepEqual(r.values['n.matte'], { canvas: 'm' });
});

test('the server jobs\' bodies: key, matte, watermark', () => {
  const s = st({ source: { ...SRC, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }, key: { color: '#0000ff', similarity: 0.2 }, matte: { generation: 3, index: 1, label: 'm' } });
  const k = keyBody(effectById('colorkey'), s, 5);
  assert.deepEqual(k.source, { generation: 7, index: 0 });
  assert.deepEqual(k.trim, SRC.trim);
  assert.equal(k.mode, 'color'); assert.equal(k.color, '#0000ff'); assert.equal(k.similarity, 0.2); assert.equal(k.blend, 0.08); assert.equal(k.project_id, 5);
  const m = keyBody(effectById('mattekey'), { ...s, key: { invert: true } });
  assert.equal(m.mode, 'matte'); assert.deepEqual(m.matte, { generation: 3, index: 1 }); assert.equal(m.invert, true); assert.equal(m.color, undefined);
  const r = matteBody({ ...s, matte2: { media: 'b.mp4' }, refine: { grow: 3 } }, 5);
  assert.deepEqual(r.a, { generation: 3, index: 1 }); assert.deepEqual(r.b, { media: 'b.mp4' }); assert.equal(r.grow, 3);
  const d = delogoRunBody({ ...s, boxes: [{ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }], delogo: 'fast' }, 5);
  assert.deepEqual(d.boxes, [{ x: 0, y: 0.5, w: 0.5, h: 0.25 }], 'boxes go as fractions of the cropped clip');
  assert.equal(d.mode, 'fast');
  assert.deepEqual(d.crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
});

test('an old frame VFX document becomes the frame\'s op state', () => {
  const ops = migrateVfxDoc({ op: 'mattekey', points: { positive: [{ x: 0.1, y: 0.2 }], negative: [] }, pointsAt: 1.5,
    boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1 }], tracks: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], key: { color: '#112233', invert: true },
    matte: { generation: 4, index: 0 }, prompt: 'not kept', results: [1, 2] });
  assert.deepEqual(ops.mask, { points: { positive: [{ x: 0.1, y: 0.2 }], negative: [] }, pointsAt: 1.5 });
  assert.deepEqual(ops.delogo.boxes, [{ x: 0, y: 0, w: 0.1, h: 0.1 }]);
  assert.equal(ops.tracks.tracks.length, 1);
  assert.equal(ops.colorkey.key.color, '#112233');
  assert.equal(ops.colorkey.key.invert, false);
  assert.deepEqual(ops.mattekey, { key: { invert: true }, matte: { generation: 4, index: 0 } });
  assert.deepEqual(migrateVfxDoc({ points: { positive: [], negative: [] }, boxes: [], tracks: [] }), {}, 'nothing placed: nothing kept');
  assert.deepEqual(migrateVfxDoc(null), {});
  // the frame's own state wins over the old document's, key by key
  assert.deepEqual(mergeOps({ mask: { points: 1, pointsAt: 2 }, delogo: { boxes: [] } }, { mask: { points: 9 }, extend: { canvas: 1 } }),
    { mask: { points: 9, pointsAt: 2 }, delogo: { boxes: [] }, extend: { canvas: 1 } });
});

test('a box snaps to the grid and to edges, and stays on the frame', () => {
  const opts = { W: 1000, H: 500, thr: 8 };
  const g = snapBox('move', { x: 0.123, y: 0.31, w: 0.2, h: 0.2 }, { ...opts, grid: true, gridPct: 5 });   // (5% across; 10% down on a 2:1 frame)
  assert.ok(Math.abs(g.x - 0.1) < 1e-9 && Math.abs(g.y - 0.3) < 1e-9 && g.w === 0.2, JSON.stringify(g));
  // the left edge 5 px from the frame's centre line snaps onto it
  const m = snapBox('move', { x: 0.495, y: 0.2, w: 0.1, h: 0.1 }, { ...opts, edges: true });
  assert.ok(Math.abs(m.x - 0.5) < 1e-9);
  // sizing snaps the far corner to another box's edge
  const s = snapBox('size', { x: 0.1, y: 0.1, w: 0.296, h: 0.2 }, { ...opts, edges: true, others: [{ x: 0.4, y: 0.6, w: 0.1, h: 0.1 }] });
  assert.ok(Math.abs(s.x + s.w - 0.4) < 1e-9);
  const off = snapBox('move', { x: 0.95, y: 0.95, w: 0.2, h: 0.2 }, opts);
  assert.ok(off.x + off.w <= 1 && off.y + off.h <= 1);
  assert.deepEqual(snapBox('new', { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, opts), { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 'snapping off: as drawn');
});
