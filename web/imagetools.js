import { h, api, store, toast, busy, button, section, field, seg, hint, help, toggle, textArea } from './ui.js';
import { S, inputUrl } from './core.js';
import { pngBlob, uploadImage } from './media.js';
import { queueRun, template, valuesByRole, waitGen } from './make.js';
import { MAPS } from './maps.js';

// ---------------------------------------------------------------------------
// Image tools, in the Editor panel the way the VFX tab has its effects: pick one, set it, Run. It works on the selected
// picture layer, or on the whole picture (every layer together) when none is selected, and the result lands as a layer:
// a map (depth, edges, scribble, pose), an upscaled copy, a cut-out of the subject, or the inpaint mask (auto masking).
// ---------------------------------------------------------------------------
const KEY = 'deck.imagetools';
const GROUPS = ['Maps', 'Cut out and mask', 'Upscale', 'Detail'];
// The detail pass: the picture drawn again with finer detail, the layout kept. Each model is a template that already exists;
// 'strength' is the sampler's denoise (low keeps the picture, high changes it), SeedVR2 has none and no prompt.
const DETAIL = {
  seedvr2: { label: 'SeedVR2 7B', tpl: 'deck-upscale-image', plain: true,
    help: 'Restores and sharpens at the picture\'s own size, with no prompt: the most faithful, nothing invented that isn\'t there. Best for soft or noisy pictures and photos.' },
  klein9b: { label: 'Klein 9B', tpl: 'deck-klein9b-i2i', strength: 0.35, prompt: 'highly detailed, fine texture, sharp focus, crisp edges',
    help: 'FLUX.2 Klein 9B draws it again at low strength: adds believable fine detail (skin, fabric, foliage) from the prompt. A good all-rounder.' },
  klein3: { label: 'Klein 3', tpl: 'deck-klein3-i2i', strength: 0.35, prompt: 'highly detailed, fine texture, sharp focus, crisp edges',
    help: 'The newer Klein: a different look from Klein 9B, so try both on the same picture.' },
  krea2: { label: 'Krea 2', tpl: 'deck-krea2-i2i', strength: 0.3, prompt: 'highly realistic detailed photograph, natural light, rich texture, sharp focus',
    help: 'Krea 2 turbo: strongest on photographic realism (skin, light, materials). Keep strength low for a face or a likeness.' },
  qwen21: { label: 'Qwen 2.1', tpl: 'deck-qwen21-i2i', strength: 0.4, prompt: 'a detailed, polished version of this image with clean lines and fine texture',
    help: 'Qwen Image 2.1 turbo: good at clean lines, text and illustrations or graphics, less so for pores and skin.' },
};

const OPS = [
  { id: 'depth', group: 'Maps', label: 'Depth map', tpl: MAPS.depth.still, kind: 'layer', depth: true,
    help: 'A grey depth map (near is white) of the picture: Video Depth Anything. A layer on top; use it as a reference picture or control.' },
  { id: 'canny', group: 'Maps', label: 'Canny edges', tpl: MAPS.canny.still, kind: 'layer', edges: [0.2, 0.4, 0.6],
    help: 'White edges on black: the Canny map that edge control and edit models follow.' },
  { id: 'scribble', group: 'Maps', label: 'Scribble', tpl: MAPS.scribble.still, kind: 'layer', edges: [16, 28, 40],
    help: 'A loose line drawing, white lines on black: softer and simpler than Canny.' },
  { id: 'pose', group: 'Maps', label: 'Pose', tpl: MAPS.pose.still, sd: MAPS.pose.stillSd, kind: 'layer',
    help: 'The body, hands and face landmarks as an OpenPose-style picture. DWPose runs on the CPU; SDPose uses the GPU and holds up better on hard poses (up to 2 people).' },
  { id: 'cutout', group: 'Cut out and mask', label: 'Auto mask: the subject', tpl: 'deck-cutout-image', kind: 'matte',
    help: 'BiRefNet finds the main subject. The result is a cut-out layer (the background see-through) or the inpaint mask, to redraw it or everything else.' },
  { id: 'words', group: 'Cut out and mask', label: 'Auto mask: by words (SAM3)', tpl: 'deck-mask-image', kind: 'matte', prompt: true,
    help: 'SAM3 finds what you name ("the red car", "people", "the sky") and joins everything it finds. The result is a cut-out layer or the inpaint mask.' },
  { id: 'up', group: 'Upscale', label: 'Upscale (quality)', tpl: 'deck-upscale-image', kind: 'up',
    help: 'SeedVR2 makes the picture bigger and sharper, adding detail. Slow, and the memory it needs grows with the size: 2× of a 1 MP picture is fine, 4× of a big one may not fit. The new layer sits the same size on the canvas; Export size (Export panel) is set to match, so Download and Save as input come out that much bigger.' },
  { id: 'detail', group: 'Detail', label: 'Detail pass', kind: 'detail',
    help: 'Draws the picture again with more fine detail and the same layout. Pick the model: they differ a lot by subject, so try two on the same picture. Low strength keeps it close to the original.' },
  { id: 'upfast', group: 'Upscale', label: 'Upscale (fast)', tpl: 'deck-upscale-image-fast', kind: 'up',
    help: '4x-UltraSharp: a quick, clean enlargement without the invented detail. Export size is set to match, so Download and Save as input come out bigger.' },
];
const ST = { op: 'cutout', result: 'cutout', hide: true, prompt: 'person', scale: 2, poser: 'dwpose', depthModel: 'large', edgeAmount: 'normal', dmodel: 'klein9b', dprompt: {}, dstrength: {}, ...store.get(KEY, {}) };
const save = () => store.set(KEY, ST);
const FLIGHT = new Set();   // runs on their way back
const op = () => OPS.find((o) => o.id === ST.op) || OPS[0];
const dm = () => DETAIL[ST.dmodel] || DETAIL.klein9b;
const tplId = (o) => (o.kind === 'detail' ? dm().tpl : o.sd && ST.poser === 'sdpose' ? o.sd : o.tpl);

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not load a picture')); i.src = src; });
const plainCrop = (c) => !c || (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999);
const turned = (l) => !!((l.rotation || 0) % 360) || !!l.flipX || !!l.flipY;

// what the tool works on: the selected picture layer as it is (its own file, no cropping or turning), else every layer
// together. { name (an input), rect (where it sits on the canvas), layer (or null) }
const usable = (l) => l && !l.mask && !l.draft && l.name && !turned(l) && plainCrop(l.crop);
// the layers an Image tool runs on: every selected layer it can use (one run each, in turn), else the one layer or the whole picture
const targets = (eng) => (eng.picked?.() || []).filter(usable);

async function sourceOf(eng, l = eng.E.sel) {
  if (usable(l)) return { name: l.name, rect: eng.layerRect(l), layer: l, px: [l.img.naturalWidth, l.img.naturalHeight] };
  const f = eng.frame(), pic = document.createElement('canvas');
  if (!f || !eng.compose(pic)) throw new Error('Add a picture first');
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'tool.png', multiple: 1 });
  return { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height] };
}

// a matte picture (white = keep) from the run's outputs: several (one per thing SAM3 found) are joined
async function matteOf(done) {
  const outs = (done.outputs || []).filter((o) => o.kind === 'image');
  if (!outs.length) throw new Error('Nothing was found');
  const imgs = await Promise.all(outs.map((o) => loadImg(o.url)));
  const cv = document.createElement('canvas');
  cv.width = imgs[0].naturalWidth; cv.height = imgs[0].naturalHeight;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
  c.globalCompositeOperation = 'lighten';
  for (const i of imgs) c.drawImage(i, 0, 0, cv.width, cv.height);
  return cv;
}

// the source with the matte as its see-through channel, at the source's own size
async function cutOut(name, matte) {
  const img = await loadImg(inputUrl(name));
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const c = cv.getContext('2d');
  c.drawImage(img, 0, 0);
  const m = document.createElement('canvas');
  m.width = cv.width; m.height = cv.height;
  m.getContext('2d').drawImage(matte, 0, 0, cv.width, cv.height);
  const px = c.getImageData(0, 0, cv.width, cv.height), mp = m.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < px.data.length; i += 4) px.data[i + 3] = mp.data[i];
  c.putImageData(px, 0, 0);
  return cv;
}

async function land(eng, o, src, done) {
  const { rect, layer } = src;
  const place = { x: rect.x, y: rect.y };
  if (o.kind === 'matte') {
    const matte = await matteOf(done);
    if (ST.result === 'mask') {
      eng.paint.maskFromMatte(matte, rect);
      return toast(`${o.label}: added to the inpaint mask (Inpaint panel)`);
    }
    const cut = await cutOut(src.name, matte);
    const up = await uploadImage(await pngBlob(cut), { mp: 0, source: 'editor', filename: 'cutout.png', multiple: 1 });
    eng.addImage(up.name, { label: 'Cut out', ...place, scale: rect.w / up.width });
    if (layer && ST.hide) layer.hidden = true;
  } else {
    const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    eng.addImage(r.name, { label: o.kind === 'up' ? `Upscaled ${r.width}×${r.height}` : o.kind === 'detail' ? `Detail (${dm().label})` : o.label, ...place, scale: rect.w / r.width });
    if (layer && (o.kind === 'up' || o.kind === 'detail') && ST.hide) layer.hidden = true;
    if (o.kind === 'up') eng.E.out = Math.max(eng.E.out || 1, ST.scale);   // (the layer keeps its size on the canvas; exporting at this size shows the new detail)
  }
  eng.changed(); eng.render();
  toast(`${o.label}: done, a new layer on top`);
}

async function run(eng) {
  const o = op(), t = template(tplId(o));
  if (!t) return toast(`${tplId(o)} isn't installed`, true);
  if (eng.loading()) return toast('The images are still loading', true);
  if (o.prompt && !ST.prompt.trim()) return toast('Say what to find first', true);
  if (!eng.E.layers.some((l) => !l.mask && !l.draft)) return toast('Add a picture first', true);
  const tab = eng.E.tab?.id, b = busy('Sending the picture…');
  try {
    await eng.paint.savePaint();
    const many = targets(eng);
    if (many.length > 1) {   // each selected layer is its own run, queued one after another
      for (const l of many) await runOne(eng, o, t, tab, await sourceOf(eng, l));
      return;
    }
    await runOne(eng, o, t, tab, await sourceOf(eng, many[0]));
  } catch (e) { toast(e.message, true); } finally { b.done(); }
}

async function runOne(eng, o, t, tab, src) {
  const imageField = t.fields.find((f) => f.kind === 'image');
  const values = { [imageField.key]: src.name, ...valuesByRole(t, { seed: -1, ...(o.prompt && { prompt: ST.prompt.trim() }) }) };
  if (o.kind === 'up') {
    const f = t.fields.find((x) => x.input === 'scale_by');
    if (f) values[f.key] = o.id === 'upfast' ? ST.scale / 4 : ST.scale;
  }
  if (o.depth) {   // the same models and sizes the VFX tab's Depth map sets (vfx.js valuesFor)
    const small = ST.depthModel === 'small';
    Object.assign(values, valuesByRole(t, { depthModel: small ? 'video_depth_anything_vits.pth' : 'video_depth_anything_vitl.pth', depthSize: small ? 518 : 448 }));
  }
  if (o.edges) Object.assign(values, valuesByRole(t, { edgeAmount: o.edges[{ more: 0, less: 2 }[ST.edgeAmount] ?? 1] }));   // Canny's low threshold; XDoG's threshold
  if (o.kind === 'detail') {   // the picture's own size (about 2 MP at most, sides a multiple of 16), the chosen strength and prompt
    const m = dm(), set = (input, v) => { const f = t.fields.find((x) => x.input === input); if (f) values[f.key] = v; };
    if (m.plain) set('scale_by', 1);
    else {
      let [w, hh] = src.px; const k = Math.min(1, Math.sqrt(2.1e6 / (w * hh)));
      set('width', Math.max(256, Math.round((w * k) / 16) * 16)); set('height', Math.max(256, Math.round((hh * k) / 16) * 16));
      set('denoise', ST.dstrength[ST.dmodel] ?? m.strength);
      const pf = t.fields.find((x) => x.kind === 'text' && /prompt/i.test(x.group) && !/negative/i.test(x.group));
      if (pf) values[pf.key] = (ST.dprompt[ST.dmodel] ?? m.prompt).trim() || m.prompt;
    }
  }
  const [g] = await queueRun({ template: t.id, values, batch: 1 });
  toast(`${o.label} (#${g.id}): it lands as a new layer`);
  FLIGHT.add(g.id); eng.render();
  waitGen(g.id).then(async (done) => {
    if (eng.E.tab?.id !== tab) return toast(`${o.label} #${done.id} finished on another edit: it is in History`);
    await land(eng, o, src, done);
  }).catch((e) => toast(`${o.label} failed: ${e.message}`, true)).finally(() => { FLIGHT.delete(g.id); eng.render(); });
}

export function imageToolsSection(eng) {
  const E = eng.E;
  if (!E.layers.some((l) => !l.mask && !l.draft)) return null;
  const o = op(), t = template(tplId(o)), l = E.sel, many = targets(eng).length;
  const onLayer = usable(l);
  const f = eng.frame(), size = onLayer ? eng.layerRect(l) : f;
  const select = h('select', { 'aria-label': 'Image tool', onchange: (ev) => { ST.op = ev.target.value; save(); eng.render(); } },
    ...GROUPS.map((g) => h('optgroup', { label: g }, ...OPS.filter((x) => x.group === g).map((x) => h('option', { value: x.id, selected: x.id === o.id }, x.label)))));
  const out = size && o.kind === 'up' ? `${Math.round(size.w * ST.scale)}×${Math.round(size.h * ST.scale)}` : null;
  const on = many > 1 ? `Runs on each of the ${many} selected layers, one after the other.`
    : onLayer ? `Runs on the layer ${l.label || l.name.split('/').pop()}.` : 'Runs on the whole picture: select a layer to use just that one.';
  return section('Image tools', null,
    select, help(`${o.help} ${on}`),
    !t ? hint(`${tplId(o)} isn't installed yet`) : null,
    o.prompt ? field('Find', textArea(() => ST.prompt, (v) => { ST.prompt = v; save(); }, { rows: 2, label: 'What to find', placeholder: 'The red car, people, the sky' })) : null,
    o.depth ? field('Detail', seg([['large', 'Fine'], ['small', 'Fast']], ST.depthModel, (v) => { ST.depthModel = v; save(); eng.render(); }),
      help('Fine uses the Large model: the sharpest edges, steadiest depth. Fast uses Small: about five times quicker, softer.')) : null,
    o.edges ? field('Amount', seg([['more', 'More lines'], ['normal', 'Normal'], ['less', 'Fewer']], ST.edgeAmount, (v) => { ST.edgeAmount = v; save(); eng.render(); }),
      help('How much detail the lines pick up. More lines also take in faint edges and texture; fewer keeps the main outlines.')) : null,
    o.sd ? field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], ST.poser, (v) => { ST.poser = v; save(); eng.render(); })) : null,
    o.kind === 'matte' ? field('Result', seg([['cutout', 'Cut-out layer'], ['mask', 'Inpaint mask']], ST.result, (v) => { ST.result = v; save(); eng.render(); })) : null,
    o.kind === 'detail' ? field('Model', seg(Object.entries(DETAIL).map(([k, v]) => [k, v.label]), ST.dmodel, (v) => { ST.dmodel = v; save(); eng.render(); }, { wrap: true })) : null,
    o.kind === 'detail' ? help(dm().help) : null,
    o.kind === 'detail' && !dm().plain ? field('Strength', h('input', { type: 'range', min: 0.1, max: 0.7, step: 0.05, 'aria-label': 'Strength',
      value: ST.dstrength[ST.dmodel] ?? dm().strength, oninput: (e) => { ST.dstrength[ST.dmodel] = +e.target.value; save(); e.target.nextSibling.textContent = e.target.value; } }),
      h('span', {}, String(ST.dstrength[ST.dmodel] ?? dm().strength))) : null,
    o.kind === 'detail' && !dm().plain ? field('Prompt', textArea(() => ST.dprompt[ST.dmodel] ?? dm().prompt, (v) => { ST.dprompt[ST.dmodel] = v; save(); }, { rows: 2, label: 'What to add' })) : null,
    o.kind === 'up' ? field(['Enlarge', out ? h('span', {}, out) : null], seg([[2, '2×'], [3, '3×'], [4, '4×']], ST.scale, (v) => { ST.scale = v; save(); eng.render(); })) : null,
    (o.kind === 'up' || o.kind === 'detail' || (o.kind === 'matte' && ST.result === 'cutout')) && (onLayer || many > 1)
      ? toggle('Hide the original', ST.hide, (v) => { ST.hide = v; save(); }) : null,
    h('div', { class: 'row wrap' }, button(FLIGHT.size ? 'Run again' : 'Run', () => run(eng), { cls: 'primary', disabled: !t })));
}
