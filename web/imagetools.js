import { h, api, store, toast, busy, button, chip, section, field, seg, hint, help, toggle, textArea } from './ui.js';
import { S, inputUrl } from './core.js';
import { pngBlob, uploadImage } from './media.js';
import { queueRun, template, valuesByRole, waitGen } from './make.js';
import { MAPS } from './maps.js';
import { editSizeFor } from './edit-size.js';
import * as G from './layer-geom.js';
import { uploadMask } from './inpaint.js';
import { boundsOf, boxesFor, foundIn, refineEdge, separateAreas, stairOf, termsOf, worthLooking } from './matte-edge.js';

// ---------------------------------------------------------------------------
// Image tools, in the Editor panel the way the VFX tab has its effects: pick one, set it, Run. Run on chooses what it works
// on: the whole picture (every layer together) or each selected layer in turn. The result lands as a layer:
// a map (depth, edges, scribble, pose), an upscaled copy, a cut-out of the subject, or the inpaint mask (auto masking).
// ---------------------------------------------------------------------------
const KEY = 'deck.imagetools';
const GROUPS = ['Maps', 'Cut out and mask', 'Clean up', 'Upscale', 'Detail'];
// The restoration models of Clean up: each works at the picture's own size, and changes nothing else
const CLEAN = {
  noise: { label: 'Noise', model: '1x_ISO_denoise_v1.pth', help: 'Takes out the grain of a photo shot in low light.' },
  jpeg: { label: 'JPEG blocks', model: 'DeJpeg_Fatality_PlusULTRA_200000_G.pth', help: 'Takes out the blocks and halos of heavy JPEG compression.' },
  blur: { label: 'Blur', model: '1x_DeBLR.pth', help: 'Sharpens a slightly soft picture. It can\'t bring back a badly blurred one: the Detail pass redraws those.' },
};
const LOOK_FOR = [['watermark', 'Watermark'], ['letters', 'Letters'], ['logo', 'Logo']];
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

// De-lighting: an edit model told to take the lighting out, so a picture that came out dark or with hard shadows is even and
// flat before it goes to image or 3D generation. Each is an edit template that already exists.
const DELIGHT = {
  krea2: { label: 'Krea 2', tpl: 'deck-krea2-edit', help: 'Keeps people and likenesses best.' },
  klein9b: { label: 'Klein 9B', tpl: 'deck-klein9b-edit', help: 'A good all-rounder; quick.' },
  qwen21: { label: 'Qwen 2.1', tpl: 'deck-qwen21-edit', help: 'Good with objects, graphics and clean surfaces.' },
};
const UNMARK_PROMPT = 'Remove every watermark, stamp, logo and overlaid text from this picture, including faint see-through ones repeated across it. Fill in what is underneath them. Keep everything else exactly as it is: the same people, objects, colours, light, sharpness and framing.';
const DELIGHT_PROMPT = 'Remove all the lighting and shadows from this picture: light it evenly and softly from every side, like an overcast day or a light tent, so dark areas are brightened and nothing is in shadow. Show the true colours and surface of the materials. Keep the shape, pose, details, background and framing exactly the same.';

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
  { id: 'sheet', group: 'Cut out and mask', label: 'Split a sheet: enlarge and cut out each (for 3D)', tpl: 'deck-sheet-cell', kind: 'sheet', prompt: true,
    help: 'For a character or object sheet with rows and columns of views: cuts it into equal cells, makes each one bigger, and SAM3 cuts out what you name in it (the best match). Each view lands as its own layer where its cell was, ready for the 3D object slots (Save as input). Needs one run per cell.' },
  { id: 'remove', group: 'Clean up', label: 'Remove: a watermark, text or what you name', tpl: 'deck-remove-lama', kind: 'remove',
    help: 'Find by name: SAM3 marks what you name in red, for you to check and put right, since it can miss a watermark or mark other things. The red mask: you paint it (Inpaint panel), or check what was found, and Remove takes it out: LaMa fills it in from what is round it, with no prompt. Only that area changes: the rest stays pixel for pixel, at full size. Best on small things on a plain or even background; a very big area comes back softer. Separate words with commas for several things. A big area on a busy background is better redrawn in Inpaint.' },
  { id: 'unmark', group: 'Clean up', label: 'Remove a watermark all over the picture', kind: 'delight', promptKey: 'uprompt', fallback: UNMARK_PROMPT, done: 'Watermark removed',
    help: 'For a faint watermark repeated across the whole picture, which can\'t be marked as an area: an edit model draws the picture again without it. It runs at about 2 MP, and can change small details, so compare the result with the original.' },
  { id: 'clean', group: 'Clean up', label: 'Clean: noise, JPEG blocks or blur', tpl: 'deck-clean-image', kind: 'clean',
    help: 'A restoration model at the picture\'s own size: quick, and it adds nothing that isn\'t there.' },
  { id: 'delight', group: 'Detail', label: 'De-light (even out dark or shadowed pictures)', kind: 'delight',
    help: 'An edit model takes the lighting out: dark pictures are brightened and hard shadows softened, with the shape and colours kept. Run it on a view before it goes to image or 3D generation. The result is a new layer; the prompt can be changed.' },
  { id: 'up', group: 'Upscale', label: 'Upscale (quality)', tpl: 'deck-upscale-image', kind: 'up',
    help: 'SeedVR2 makes the picture bigger and sharper, adding detail. Slow, and the memory it needs grows with the size: 2× of a 1 MP picture is fine, 4× of a big one may not fit. The new layer sits the same size on the canvas; Export size (Export panel) is set to match, so Download and Save as input come out that much bigger.' },
  { id: 'detail', group: 'Detail', label: 'Detail pass', kind: 'detail',
    help: 'Draws the picture again with more fine detail and the same layout. Pick the model: they differ a lot by subject, so try two on the same picture. Low strength keeps it close to the original.' },
  { id: 'upfast', group: 'Upscale', label: 'Upscale (fast)', tpl: 'deck-upscale-image-fast', kind: 'up',
    help: '4x-UltraSharp: a quick, clean enlargement without the invented detail. Export size is set to match, so Download and Save as input come out bigger.' },
];
const ST = { op: 'cutout', scope: 'whole', result: 'cutout', hide: true, fine: true, rfrom: 'words', rprompt: 'watermark', cmodel: 'noise', uprompt: UNMARK_PROMPT, prompt: 'person', rows: 1, cols: 4, sheetFast: false, scale: 2, poser: 'dwpose', depthModel: 'large', edgeAmount: 'normal', dmodel: 'klein9b', lmodel: 'krea2', lprompt: DELIGHT_PROMPT, dprompt: {}, dstrength: {}, ...store.get(KEY, {}) };
const save = () => store.set(KEY, ST);
const FLIGHT = new Set();   // runs on their way back
const op = () => OPS.find((o) => o.id === ST.op) || OPS[0];
const dm = () => DETAIL[ST.dmodel] || DETAIL.klein9b;
const tplId = (o) => (o.kind === 'delight' ? (DELIGHT[ST.lmodel] || DELIGHT.krea2).tpl : o.kind === 'sheet' ? (ST.sheetFast ? 'deck-sheet-cell-fast' : 'deck-sheet-cell') : o.kind === 'detail' ? dm().tpl : o.sd && ST.poser === 'sdpose' ? o.sd : o.tpl);

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not load a picture')); i.src = src; });
const plainCrop = (c) => !c || (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999);

// the selected layers an Image tool can run on, one run each: picture layers, not an inpaint mask or draft
const usable = (l) => l && !l.mask && !l.draft && !l.maskOf && !l.broken && l.name;
const targets = (eng) => (eng.picked?.() || []).filter(usable);

// a cropped layer's kept part, at the file's own pixels, as a new input
async function keptPart(l) {
  const W = l.img.naturalWidth, H = l.img.naturalHeight, c = l.crop, cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(c.w * W)); cv.height = Math.max(1, Math.round(c.h * H));
  cv.getContext('2d').drawImage(l.img, c.x * W, c.y * H, c.w * W, c.h * H, 0, 0, cv.width, cv.height);
  const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'layer.png', multiple: 1 });
  return { name: up.name, px: [cv.width, cv.height] };
}

// The tools whose result has its layer's framing, so the layer's mask fits it
const KEEPS_FRAMING = new Set(['up', 'detail', 'delight', 'remove', 'clean']);
// a layer's mask as it is now, its kept part at its own pixels (painting on it during the run doesn't change it); null if it has none
function maskAsSent(eng, l) {
  const m = eng.E.layers.find((x) => x.maskOf === l.key && eng.ready(x));
  if (!m) return null;
  const W = m.img.naturalWidth || m.img.width, H = m.img.naturalHeight || m.img.height, c = l.crop, cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(c.w * W)); cv.height = Math.max(1, Math.round(c.h * H));
  cv.getContext('2d').drawImage(m.img, c.x * W, c.y * H, c.w * W, c.h * H, 0, 0, cv.width, cv.height);
  return cv;
}
// that mask at a result's pixels, as a new input: what a mask shares with its layer is scale and crop, so it must be the result's size
async function maskForResult(src, r) {
  if (!src.mask) return {};
  const cv = document.createElement('canvas');
  cv.width = r.width; cv.height = r.height;
  const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(src.mask, 0, 0, cv.width, cv.height);
  const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'mask.png', multiple: 1 });
  return { mask: up.name, ...(src.was.maskOff && { maskOff: true }) };
}

// what the tool works on: a layer (null: every layer together). { name (an input), rect (where it sits on the canvas before
// any turn), layer (or null), was (the layer's place when sent: its turn goes on the result), mask (its mask when sent, for a tool in KEEPS_FRAMING), px }. A model sees a layer unturned.
async function sourceOf(eng, l, o) {
  if (l) {
    const part = plainCrop(l.crop) ? { name: l.name, px: [l.img.naturalWidth, l.img.naturalHeight] } : await keptPart(l);
    return { ...part, rect: eng.layerRect(l), layer: l, was: { ...l }, mask: KEEPS_FRAMING.has(o.kind) ? maskAsSent(eng, l) : null };
  }
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

const once = async (run) => waitGen((await queueRun(run))[0].id);
// SAM3's worker now and then fails a run ("Inference tensors do not track version counter") that works when sent again
const sent = (run) => once(run).catch(() => once(run));

// a picture's or canvas's red channel at w×h, row by row
function redOf(pic, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(pic, 0, 0, w, h);
  const d = c.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}
const cropOf = (src, W, b) => {   // (a box of a row-by-row array W wide)
  const out = new src.constructor(b.w * b.h);
  for (let y = 0; y < b.h; y++) out.set(src.subarray((b.y + y) * W + b.x, (b.y + y) * W + b.x + b.w), y * b.w);
  return out;
};

// The matte of a finished run with fine edges, at the picture's own size. The model saw the whole picture at about 1000 px: each thing
// it found gets a second look, on a crop close to it (one run for each, kept out of History), and its edge is then moved onto the picture's.
async function finerMatte(t, name, done, prompt, b) {
  const outs = (done.outputs || []).filter((o) => o.kind === 'image');
  if (!outs.length) throw new Error('Nothing was found');
  const img = await loadImg(inputUrl(name)), W = img.naturalWidth, H = img.naturalHeight;
  const masks = (await Promise.all(outs.map((o) => loadImg(o.url)))).map((i) => redOf(i, W, H));
  const bounds = masks.map((m) => boundsOf(m, W, H)).filter(Boolean);
  if (!bounds.length) throw new Error('Nothing was found');
  const first = new Uint8Array(W * H);
  for (const m of masks) for (let i = 0; i < first.length; i++) if (m[i] > first[i]) first[i] = m[i];
  // the picture's colours: what the edge follows
  const pic = document.createElement('canvas');
  pic.width = W; pic.height = H;
  const pc = pic.getContext('2d', { willReadFrequently: true });
  pc.drawImage(img, 0, 0);
  const px = pc.getImageData(0, 0, W, H).data, rgb = [0, 1, 2].map((c) => {
    const v = new Float32Array(W * H);
    for (let i = 0; i < v.length; i++) v[i] = px[i * 4 + c] / 255;
    return v;
  });
  const out = new Uint8Array(W * H), boxes = boxesFor(bounds, W, H), imageField = t.fields.find((f) => f.kind === 'image');
  for (const [k, box] of boxes.entries()) {
    let mask = cropOf(first, W, box), seen = [W, H];
    if (worthLooking(box, W, H)) {
      b?.set(`Looking closer (${k + 1} of ${boxes.length})…`);
      try {
        const cv = document.createElement('canvas');
        cv.width = box.w; cv.height = box.h;
        cv.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'closer.png', multiple: 1 });
        let run = null;
        try {
          run = await sent({ template: t.id, values: { [imageField.key]: up.name, ...valuesByRole(t, { seed: -1, prompt }) }, batch: 1 });
          const found = await Promise.all(run.outputs.filter((o) => o.kind === 'image').map((o) => loadImg(o.url)));
          const near = foundIn(mask, found.map((i) => redOf(i, box.w, box.h)));
          if (near) { mask = near; seen = [box.w, box.h]; }
        } finally {   // (the crop and its run were only a means: the matte lands on the run that was asked for)
          if (run) await api(`/api/generations/${run.id}`, { method: 'DELETE', busy: false }).catch(() => {});
          await api(`/api/inputs?name=${encodeURIComponent(up.name)}`, { method: 'DELETE', busy: false }).catch(() => {});
        }
      } catch (e) { toast(`A closer look failed, so that edge is the first look's: ${e.message}`, true); }
    }
    b?.set('Cleaning the edges…');
    await new Promise((r) => setTimeout(r));   // (the bar shows before the sums)
    const edge = refineEdge(mask, rgb.map((c) => cropOf(c, W, box)), box.w, box.h, stairOf(...seen));
    for (let y = 0; y < box.h; y++) {
      const to = (box.y + y) * W + box.x;
      for (let x = 0; x < box.w; x++) if (edge[y * box.w + x] > out[to + x]) out[to + x] = edge[y * box.w + x];
    }
  }
  const data = pc.createImageData(W, H);
  for (let i = 0; i < out.length; i++) { const j = i * 4; data.data[j] = data.data[j + 1] = data.data[j + 2] = out[i]; data.data[j + 3] = 255; }
  pc.putImageData(data, 0, 0);
  return pic;
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

// a picture with see-through parts put on solid black (what Idol and other one-photo models want), uploaded as a new input
async function onBlack(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth || img.width; cv.height = img.naturalHeight || img.height;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(img, 0, 0);
  return uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'on-black.png', multiple: 1 });
}

// the sheet's cells, cut in the browser and uploaded: [{ name, r, c }]
async function cutCells(src) {
  const img = await loadImg(inputUrl(src.name)), W = img.naturalWidth, H = img.naturalHeight, out = [];
  for (let r = 0; r < ST.rows; r++) for (let c = 0; c < ST.cols; c++) {
    const x0 = Math.round((c * W) / ST.cols), x1 = Math.round(((c + 1) * W) / ST.cols), y0 = Math.round((r * H) / ST.rows), y1 = Math.round(((r + 1) * H) / ST.rows);
    const cv = document.createElement('canvas');
    cv.width = x1 - x0; cv.height = y1 - y0;
    cv.getContext('2d').drawImage(img, x0, y0, cv.width, cv.height, 0, 0, cv.width, cv.height);
    const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: `cell-${r + 1}-${c + 1}.png`, multiple: 1 });
    out.push({ name: up.name, r, c });
  }
  return out;
}

// a result pic's place at x, y and w wide: over its layer, with that layer's turn
function placed(src, x, y, w, pic) {
  const scale = w / pic.width;
  return { ...(src.was ? G.placeOn(src.was, { x, y, w, h: pic.height * scale }) : { x, y }), scale };
}

async function land(eng, o, src, done, cell) {
  const { rect, layer } = src;
  if (o.kind === 'matte') {
    const b = ST.fine ? busy('Cleaning the edges…') : null;
    const matte = await (ST.fine ? finerMatte(template(o.tpl), src.name, done, o.prompt ? ST.prompt.trim() : undefined, b) : matteOf(done)).finally(() => b?.done());
    if (ST.result === 'mask') {
      eng.paint.maskFromMatte(matte, rect, src.was && G.turn(src.was));
      return toast(`${o.label}: added to the inpaint mask (Inpaint panel)`);
    }
    const cut = await cutOut(src.name, matte);
    const up = ST.result === 'black' ? await onBlack(cut) : await uploadImage(await pngBlob(cut), { mp: 0, source: 'editor', filename: 'cutout.png', multiple: 1 });
    eng.addImage(up.name, { label: ST.result === 'black' ? 'Cut out on black' : 'Cut out', ...placed(src, rect.x, rect.y, rect.w, up) });
    if (layer && ST.hide) layer.hidden = true;
  } else if (o.kind === 'sheet') {
    let r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    if (ST.result === 'black') r = await onBlack(await loadImg(inputUrl(r.name)));
    const cw = rect.w / ST.cols, ch = rect.h / ST.rows;
    eng.addImage(r.name, { label: `${ST.result === 'black' ? 'View on black' : 'View'} ${cell.r + 1}-${cell.c + 1}`, ...placed(src, rect.x + cell.c * cw, rect.y + cell.r * ch, cw, r) });
    return eng.changed(), eng.render();
  } else {
    const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    const made = eng.addImage(r.name, { label: o.kind === 'up' ? `Upscaled ${r.width}×${r.height}` : o.kind === 'delight' ? (o.done || 'De-lit') : o.kind === 'detail' ? `Detail (${dm().label})` : o.kind === 'clean' ? `Cleaned (${(CLEAN[ST.cmodel] || CLEAN.noise).label})` : o.label, ...placed(src, rect.x, rect.y, rect.w, r), ...(await maskForResult(src, r)) });
    if (layer && KEEPS_FRAMING.has(o.kind) && ST.hide) layer.hidden = true;
    if (layer && o.kind === 'up' && ST.hide) {   // the selection moves from the hidden original to its upscale (a layer picked since the run began stays picked)
      const E = eng.E;
      if (E.sel === layer) { E.sel = made; E.cropping = false; }
      E.multi = E.multi.map((m) => (m === layer ? made : m));
    }
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
  if (o.kind === 'remove' && ST.rfrom === 'words' && !termsOf(ST.rprompt).length) return toast('Say what to remove first', true);
  if (o.kind === 'remove' && !template('deck-mask-image')) return toast('deck-mask-image isn\'t installed', true);
  const tab = eng.E.tab?.id, b = busy('Sending the picture…');
  try {
    await eng.paint.savePaint();
    if (o.kind === 'remove' && ST.rfrom === 'painted') return await removePainted(eng, o, t, tab);
    const list = ST.scope === 'selected' ? targets(eng) : [null];
    if (!list.length) return toast('Select a layer first', true);
    for (const l of list) await runOne(eng, o, t, tab, await sourceOf(eng, l, o));   // (each selected layer is its own run, queued one after another)
  } catch (e) { toast(e.message, true); } finally { b.done(); }
}

async function runSheet(eng, o, t, tab, src) {
  const cells = await cutCells(src), set = (input, v) => { const f = t.fields.find((x) => x.input === input); return f ? [f.key, v] : null; };
  const imageField = t.fields.find((f) => f.kind === 'image');
  toast(`${o.label}: ${cells.length} cells queued; each lands as a layer`);
  let left = cells.length;
  const start = async (cell, again) => {
    const sc = set('scale_by', ST.sheetFast ? ST.scale / 4 : ST.scale);
    const values = { [imageField.key]: cell.name, ...valuesByRole(t, { seed: -1, prompt: ST.prompt.trim() }), ...(sc && { [sc[0]]: sc[1] }) };
    const [g] = await queueRun({ template: t.id, values, batch: 1 });
    FLIGHT.add(g.id); eng.render();
    waitGen(g.id).then(async (done) => {
      if (eng.E.tab?.id !== tab) return toast(`${o.label} #${done.id} finished on another edit: it is in History`);
      await land(eng, o, src, done, cell);
      if (--left === 0) { if (src.layer && ST.hide) src.layer.hidden = true; eng.changed(); eng.render(); toast(`${o.label}: all ${cells.length} views are layers`); }
    }).catch((e) => {
      // SAM3's worker now and then fails a run ("Inference tensors do not track version counter") that works when sent again
      if (again) return start(cell, false).catch((e2) => toast(`${o.label} cell ${cell.r + 1}-${cell.c + 1} failed: ${e2.message}`, true));
      toast(`${o.label} cell ${cell.r + 1}-${cell.c + 1} failed: ${e.message}`, true);
    }).finally(() => { FLIGHT.delete(g.id); eng.render(); });
  };
  for (const cell of cells) await start(cell, true);
}

// Remove: the picture and its mask (white = what goes) to LaMa. LaMa's memory grows with the picture (a 4K one doesn't fit 12 GB) and it only needs
// what is round the mask, so it runs on a crop round each marked area, made smaller if it is big; each fill goes back on a copy of the picture.
const LAMA_MOST = 2e6;   // pixels
async function fillIn(eng, o, t, tab, src, maskCv) {
  const W = maskCv.width, H = maskCv.height, red = redOf(maskCv, W, H);
  const areas = boundsOf(red, W, H);
  if (!areas) throw new Error('Nothing to remove there: paint it instead');
  const mf = t.fields.find((x) => x.kind === 'mask'), main = t.fields.find((x) => x.key === mf.image_key);
  const img = await loadImg(inputUrl(src.name));
  const result = document.createElement('canvas');
  result.width = W; result.height = H;
  const rc = result.getContext('2d');
  rc.drawImage(img, 0, 0, W, H);
  const crop = (pic, box, k) => {
    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(box.w * k)); cv.height = Math.max(8, Math.round(box.h * k));
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, cv.width, cv.height);
    return cv;
  };
  const b = busy(`${o.label}…`);
  FLIGHT.add(fillIn); eng.render();
  try {
    const boxes = boxesFor(separateAreas(red, W, H), W, H, 0.5);
    for (const [n, box] of boxes.entries()) {
      b.set(`Filling in (${n + 1} of ${boxes.length})…`);
      const k = Math.min(1, Math.sqrt(LAMA_MOST / (box.w * box.h)));
      const up = await uploadImage(await pngBlob(crop(result, box, k)), { mp: 0, source: 'editor', filename: 'remove-area.png', multiple: 1 });
      const name = await uploadMask(crop(maskCv, box, k));
      let run = null;
      try {
        const values = { [main.key]: up.name, [mf.key]: { feather: 8, grow: 24, fit: false, name, src: up.name, crop: null, box: { x: 0, y: 0, w: 1, h: 1 } } };
        run = await once({ template: t.id, values, batch: 1 });
        const fill = await loadImg(run.outputs.find((x) => x.kind === 'image').url);
        rc.drawImage(fill, box.x, box.y, box.w, box.h);
      } finally {   // (a means to the layer: the crop, its mask and its run go)
        if (run) await api(`/api/generations/${run.id}`, { method: 'DELETE', busy: false }).catch(() => {});
        await api(`/api/inputs?name=${encodeURIComponent(up.name)}`, { method: 'DELETE', busy: false }).catch(() => {});
        await api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});
      }
    }
    if (eng.E.tab?.id !== tab) return toast(`${o.label} finished on another edit`);
    const r = await uploadImage(await pngBlob(result), { mp: 0, source: 'editor', filename: 'removed.png', multiple: 1 });
    eng.addImage(r.name, { label: 'Removed', ...placed(src, src.rect.x, src.rect.y, src.rect.w, r), ...(await maskForResult(src, r)) });
    if (src.layer && ST.hide) src.layer.hidden = true;
    eng.changed(); eng.render();
    toast(`${o.label}: done, a new layer on top`);
  } finally { FLIGHT.delete(fillIn); b.done(); eng.render(); }
}

// ...what's named in the Find box, one search each, all of it joined. It only marks: SAM3 often misses a watermark or takes other things for it
// ("text" found nothing on large white letters, "watermark" other things too), so what goes is seen in red and can be put right before Run removes it.
async function markFound(eng, o, src) {
  const find = template('deck-mask-image'), image = find.fields.find((f) => f.kind === 'image'), [W, H] = src.px;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'lighten';
  for (const term of termsOf(ST.rprompt)) {
    const done = await sent({ template: find.id, values: { [image.key]: src.name, ...valuesByRole(find, { seed: -1, prompt: term }) }, batch: 1 });
    const outs = (done.outputs || []).filter((x) => x.kind === 'image');
    for (const x of outs) c.drawImage(await loadImg(x.url), 0, 0, W, H);
  }
  if (!boundsOf(redOf(cv, W, H), W, H)) return toast('SAM3 found nothing there: try other words, or paint it (Inpaint panel)', true);
  eng.paint.maskFromMatte(cv, src.rect, src.was && G.turn(src.was));
  ST.rfrom = 'painted'; save(); eng.render();
  toast('Marked in red: check it (paint more or erase in the Inpaint panel), then Remove');
}

// ...the inpaint mask as painted: on the whole picture, as a painted mask is
async function removePainted(eng, o, t, tab) {
  const f = eng.frame(), m = eng.composeMask();
  if (!f || !m) return toast('Paint what to remove first (Inpaint panel)', true);
  const pic = document.createElement('canvas');
  if (!eng.compose(pic)) return toast('Add a picture first', true);
  if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'remove.png', multiple: 1 });
  return fillIn(eng, o, t, tab, { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height] }, m.canvas);
}

// an edit template's Size for all of a picture of [w, h] (left alone, it crops to a 1024 square)
function wholePicture(t, [w, h]) {
  const fw = t.fields.find((f) => f.key === '__deck.width'), fh = t.fields.find((f) => f.key === '__deck.height');
  if (!fw || !fh) return {};
  const [sw, sh] = editSizeFor(w, h, fw.step || 16);
  return { [fw.key]: sw, [fh.key]: sh };
}

async function runOne(eng, o, t, tab, src) {
  if (o.kind === 'sheet') return runSheet(eng, o, t, tab, src);
  if (o.kind === 'remove') return markFound(eng, o, src);
  const imageField = t.fields.find((f) => f.kind === 'image');
  const values = { [imageField.key]: src.name, ...valuesByRole(t, { seed: -1, ...(o.prompt && { prompt: ST.prompt.trim() }) }) };
  if (o.kind === 'delight') {   // the edit template's own picture and edit boxes (not its reference pictures)
    const pic = t.fields.find((f) => f.kind === 'image' && /image to edit/i.test(f.group)), box = t.fields.find((f) => f.kind === 'text' && /^edit$/i.test(f.group) && !/negative/i.test(f.input));
    if (pic) delete values[imageField.key];
    if (pic) values[pic.key] = src.name;
    if (box) values[box.key] = (ST[o.promptKey || 'lprompt'] || '').trim() || o.fallback || DELIGHT_PROMPT;
    Object.assign(values, wholePicture(t, src.px));
  }
  if (o.kind === 'clean') {
    const f = t.fields.find((x) => x.input === 'model_name');
    if (f) values[f.key] = (CLEAN[ST.cmodel] || CLEAN.noise).model;
  }
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

let edgeTurn = Promise.resolve();

// The Image tab's upscale, de-light and cut-out as one step on one picture, with this tab's chosen model and scale, for work
// outside the tab (markviews.js). The result's input name comes back.
export async function applyStep(step, name, { what = 'person' } = {}) {
  const id = step === 'up' ? 'deck-upscale-image' : step === 'cut' ? 'deck-mask-image' : (DELIGHT[ST.lmodel] || DELIGHT.krea2).tpl;
  const t = template(id);
  if (!t) throw new Error(`${id} isn't installed`);
  const set = (f, v) => { if (f) values[f.key] = v; };
  const values = valuesByRole(t, { seed: -1, ...(step === 'cut' && { prompt: what.trim() || 'person' }) });
  if (step === 'delight') {
    set(t.fields.find((f) => f.kind === 'image' && /image to edit/i.test(f.group)) || t.fields.find((f) => f.kind === 'image'), name);
    set(t.fields.find((f) => f.kind === 'text' && /^edit$/i.test(f.group) && !/negative/i.test(f.input)), (ST.lprompt || '').trim() || DELIGHT_PROMPT);
    const img = await loadImg(inputUrl(name));
    Object.assign(values, wholePicture(t, [img.naturalWidth, img.naturalHeight]));
  } else set(t.fields.find((f) => f.kind === 'image'), name);
  if (step === 'up') set(t.fields.find((f) => f.input === 'scale_by'), ST.scale);
  const once = async () => waitGen((await queueRun({ template: id, values, batch: 1 }))[0].id);
  // SAM3's worker now and then fails a run ("Inference tensors do not track version counter") that works when sent again
  const done = step === 'cut' ? await once().catch(once) : await once();
  if (step === 'cut') {
    // (several can be going at once: fine edges hold a whole picture in memory, so one at a time)
    const fine = ST.fine ? edgeTurn.then(() => finerMatte(t, name, done, what.trim() || 'person')) : null;
    if (fine) edgeTurn = fine.catch(() => {});
    const cut = await cutOut(name, await (fine || matteOf(done)));
    return (await uploadImage(await pngBlob(cut), { mp: 0, source: 'editor', filename: 'cutout.png', multiple: 1 })).name;
  }
  return (await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } })).name;
}

export function imageToolsSection(eng) {
  const E = eng.E;
  if (!E.layers.some((l) => !l.mask && !l.draft)) return null;
  const o = op(), t = template(tplId(o)), picked = ST.scope === 'selected' ? targets(eng) : [], many = picked.length;
  const onLayers = ST.scope === 'selected' && many > 0;
  const size = many === 1 ? eng.layerRect(picked[0]) : ST.scope === 'whole' ? eng.frame() : null;
  const select = h('select', { 'aria-label': 'Image tool', onchange: (ev) => { ST.op = ev.target.value; save(); eng.render(); } },
    ...GROUPS.map((g) => h('optgroup', { label: g }, ...OPS.filter((x) => x.group === g).map((x) => h('option', { value: x.id, selected: x.id === o.id }, x.label)))));
  const out = size && o.kind === 'up' ? `${Math.round(size.w * ST.scale)}×${Math.round(size.h * ST.scale)}` : null;
  const on = many > 1 ? `Runs on each of the ${many} selected layers, one after the other.`
    : many ? `Runs on the layer ${picked[0].label || picked[0].name.split('/').pop()}.` : ST.scope === 'whole' ? 'Runs on the whole picture.' : '';
  return section('Image tools', null,
    select, help(`${o.help} ${on}`.trim()),
    !t ? hint(`${tplId(o)} isn't installed yet`) : null,
    field('Run on', seg([['whole', 'Whole picture'], ['selected', 'Selected layers']], ST.scope, (v) => { ST.scope = v; save(); eng.render(); }),
      help('Whole picture sends every visible layer together. Selected layers runs on each selected layer alone, one run each, with the result over that layer. A cropped layer sends its kept part. A turned or mirrored layer is sent unturned, and its result takes the same turn. A masked layer is sent whole: an Upscale, Detail or De-light result gets a copy of its mask, and other tools\' results get none.')),
    ST.scope === 'selected' && !many ? hint('Select a layer first') : null,
    o.prompt ? field('Find', textArea(() => ST.prompt, (v) => { ST.prompt = v; save(); }, { rows: 2, label: 'What to find', placeholder: 'The red car, people, the sky' })) : null,
    o.depth ? field('Detail', seg([['large', 'Fine'], ['small', 'Fast']], ST.depthModel, (v) => { ST.depthModel = v; save(); eng.render(); }),
      help('Fine uses the Large model: the sharpest edges, steadiest depth. Fast uses Small: about five times quicker, softer.')) : null,
    o.edges ? field('Amount', seg([['more', 'More lines'], ['normal', 'Normal'], ['less', 'Fewer']], ST.edgeAmount, (v) => { ST.edgeAmount = v; save(); eng.render(); }),
      help('How much detail the lines pick up. More lines also take in faint edges and texture; fewer keeps the main outlines.')) : null,
    o.sd ? field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], ST.poser, (v) => { ST.poser = v; save(); eng.render(); })) : null,
    o.kind === 'sheet' ? field('Rows × columns', h('span', { class: 'row' },
      ...['rows', 'cols'].map((k) => h('input', { type: 'number', min: 1, max: 8, value: ST[k], 'aria-label': k === 'rows' ? 'Rows' : 'Columns',
        onchange: (e) => { ST[k] = Math.max(1, Math.min(8, Math.round(+e.target.value || 1))); e.target.value = ST[k]; save(); } }))),
      help('How the sheet is laid out: equal cells, left to right, top to bottom. Spacing between cells is fine: the cut-out ignores it.')) : null,
    o.kind === 'sheet' ? field('Enlarge with', seg([[false, 'SeedVR2'], [true, 'Fast']], ST.sheetFast, (v) => { ST.sheetFast = v; save(); eng.render(); }),
      help('SeedVR2 adds detail (slow, once per cell). Fast is 4x-UltraSharp: quick and clean.')) : null,
    o.kind === 'sheet' ? field(['Enlarge', h('span', {}, `${ST.scale}×`)], seg([[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], ST.scale, (v) => { ST.scale = v; save(); eng.render(); })) : null,
    o.kind === 'matte' ? field('Result', seg([['cutout', 'Cut-out layer'], ['black', 'On black'], ['mask', 'Inpaint mask']], ST.result, (v) => { ST.result = v; save(); eng.render(); }),
      help('On black puts the cut-out on solid black: the picture a one-photo 3D model (Idol, a splat) wants.')) : null,
    o.kind === 'matte' ? toggle('Fine edges', ST.fine, (v) => { ST.fine = v; save(); eng.render(); },
      { help: 'These models see any picture at about 1000 px, so a big picture\'s edge comes back as a staircase. On: each thing found gets a second look on a crop close to it (a run for each, on a big picture), then the pixels along its edge are decided by their colour: is it more common on the thing, or beside it. Off: quicker, and the edge is as the model gave it.' }) : null,
    o.kind === 'remove' ? field('What goes', seg([['words', 'Find by name'], ['painted', 'The red mask']], ST.rfrom, (v) => { ST.rfrom = v; save(); eng.render(); })) : null,
    o.kind === 'remove' && ST.rfrom === 'words' ? h('div', { class: 'chips' }, ...LOOK_FOR.map(([v, label]) => chip(label, () => { ST.rprompt = v; save(); eng.render(); }, { on: ST.rprompt.trim().toLowerCase() === v }))) : null,
    o.kind === 'remove' && ST.rfrom === 'words' ? field('Find', textArea(() => ST.rprompt, (v) => { ST.rprompt = v; save(); }, { rows: 2, label: 'What to remove', placeholder: 'Watermark, text, the red sign' })) : null,
    o.kind === 'remove' && ST.rfrom === 'painted' && !eng.paint.maskLayer(false) ? hint('Paint what to remove first (Inpaint panel), or find it by name') : null,
    o.kind === 'clean' ? field('Take out', seg(Object.entries(CLEAN).map(([k, v]) => [k, v.label]), ST.cmodel, (v) => { ST.cmodel = v; save(); eng.render(); }, { wrap: true }),
      help((CLEAN[ST.cmodel] || CLEAN.noise).help)) : null,
    o.kind === 'sheet' ? field('Result', seg([['cutout', 'Cut out'], ['black', 'On black']], ST.result === 'black' ? 'black' : 'cutout', (v) => { ST.result = v; save(); eng.render(); })) : null,
    o.kind === 'delight' ? field('Model', seg(Object.entries(DELIGHT).map(([k, v]) => [k, v.label]), ST.lmodel, (v) => { ST.lmodel = v; save(); eng.render(); }, { wrap: true }),
      help((DELIGHT[ST.lmodel] || DELIGHT.krea2).help)) : null,
    o.kind === 'delight' ? field('Prompt', textArea(() => ST[o.promptKey || 'lprompt'], (v) => { ST[o.promptKey || 'lprompt'] = v; save(); }, { rows: 4, label: o.promptKey ? 'What to remove' : 'How to light it' })) : null,
    o.kind === 'detail' ? field('Model', seg(Object.entries(DETAIL).map(([k, v]) => [k, v.label]), ST.dmodel, (v) => { ST.dmodel = v; save(); eng.render(); }, { wrap: true })) : null,
    o.kind === 'detail' ? help(dm().help) : null,
    o.kind === 'detail' && !dm().plain ? field('Strength', h('input', { type: 'range', min: 0.1, max: 0.7, step: 0.05, 'aria-label': 'Strength',
      value: ST.dstrength[ST.dmodel] ?? dm().strength, oninput: (e) => { ST.dstrength[ST.dmodel] = +e.target.value; save(); e.target.nextSibling.textContent = e.target.value; } }),
      h('span', {}, String(ST.dstrength[ST.dmodel] ?? dm().strength))) : null,
    o.kind === 'detail' && !dm().plain ? field('Prompt', textArea(() => ST.dprompt[ST.dmodel] ?? dm().prompt, (v) => { ST.dprompt[ST.dmodel] = v; save(); }, { rows: 2, label: 'What to add' })) : null,
    o.kind === 'up' ? field(['Enlarge', out ? h('span', {}, out) : null], seg([[2, '2×'], [3, '3×'], [4, '4×']], ST.scale, (v) => { ST.scale = v; save(); eng.render(); })) : null,
    (KEEPS_FRAMING.has(o.kind) || o.kind === 'sheet' || (o.kind === 'matte' && ST.result !== 'mask')) && onLayers && !(o.kind === 'remove' && ST.rfrom === 'painted')
      ? toggle('Hide the original', ST.hide, (v) => { ST.hide = v; save(); }) : null,
    h('div', { class: 'row wrap' }, button(o.kind === 'remove' ? (ST.rfrom === 'words' ? 'Find and mark' : 'Remove') : FLIGHT.size ? 'Run again' : 'Run', () => run(eng), { cls: 'primary', disabled: !t })));
}
