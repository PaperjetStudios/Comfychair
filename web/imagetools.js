import { h, api, store, toast, busy, button, chip, section, field, rangeField, seedField, seg, hint, help, imageInput, toggle, textArea } from './ui.js';
import { S, inputUrl, switchTab, thumbUrl } from './core.js';
import { openImagePicker, pngBlob, uploadImage } from './media.js';
import { queueRun, template, valuesByRole, waitGen } from './make.js';
import { MAPS } from './maps.js';
import { editSizeFor, editSizeTo } from './edit-size.js';
import * as G from './layer-geom.js';
import * as Stack from './layer-stack.js';
import { layerMask, uploadMask } from './inpaint.js';
import { maskAsSent, maskForResult, placed, shapeOf } from './layer-result.js';
import { isOn } from './adjust.js';
import { boundsOf, boxesFor, foundIn, refineEdge, separateAreas, stairOf, termsOf, worthLooking } from './matte-edge.js';
import { faceBox, keepBrightness, scratchMask, tilesOf } from './photo-restore.js';
import { icon } from './icons.js';
import { eachOne, failureText } from './tool-batch.js';
import { partPrompt, partSize, partsOf } from './skin-parts.js';
import { besideX, layerOf, owedFor, owedRecord, sameRun, withOwed, withoutOwed } from './owed-runs.js';
import { editPrompt, layerWord, seedStep, sigmasFor, usableLoras } from './edit-image.js';
import { loraPicker } from './lora-pick.js';
import { SWAP_MODELS, SWAP_PARTS, biggestArea, changedAround, joined, onlyWithin, scaleFor, softEdge, swapBox, swapLora, swapPrompt, swapRefPixels, without } from './swap-part.js';

// ---------------------------------------------------------------------------
// Image tools, in the Editor panel the way the VFX tab has its effects: pick one, set it, Run. Run on chooses what it works
// on: the whole picture (every layer together) or each selected layer in turn. The result lands as a layer:
// a map (depth, edges, scribble, pose), an upscaled copy, a cut-out of the subject, or the mask (auto masking).
// ---------------------------------------------------------------------------
const KEY = 'deck.imagetools';
const GROUPS = ['Edit', 'Maps', 'Cut out and mask', 'Swap', 'Clean up', 'Colour', 'Upscale', 'Detail'];
// The row of buttons over the list: the main things, each opening its tool (the first of its tools, unless one of them is open)
const QUICK = [
  ['Edit', 'edit', ['edit']], ['Upscale', 'enlarge', ['up', 'upfast']], ['Clean up', 'sparkle', ['clean']], ['Restore', 'photo', ['restore']], ['Colourise', 'palette', ['colorise']],
  ['Remove', 'eraser', ['remove', 'unmark']], ['Cut out', 'cut', ['cutout', 'words', 'sheet']], ['Swap', 'swap', ['swap']], ['Skin', 'person', ['skin']], ['Detail', 'star', ['detail', 'delight']], ['Maps', 'grid', ['depth', 'canny', 'scribble', 'pose']],
];
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
  skin: { label: 'Skin', own: true, tpl: 'deck-klein9b-face-skin', lora: 'klein/Flux2 Klein 9B Realistic Detail LoRA.safetensors', strength: 0.3,
    prompt: 'A candid close-up photograph of the {part}, natural skin with subtle texture and slight imperfections, soft daylight',
    help: '{part} in the prompt becomes each body part in turn. On a face, 0.3 keeps the likeness and expression. 0.4 gives more skin but the expression can shift. At 0.5 pores are strongest, but moles or makeup may appear and the face can change. A pattern already in the skin gets stronger.' },
  skinwhole: { label: 'Skin', own: true, tpl: 'deck-klein9b-skin-whole', lora: 'klein/Flux2 Klein 9B Realistic Detail LoRA.safetensors', strength: 0.3,
    prompt: 'A candid photograph, natural skin with subtle texture and slight imperfections, soft daylight',
    help: 'Klein 9B and a realistic detail LoRA draw the whole picture again at about 2 MP at most. Everything is redrawn, not only skin: faces can change, and clothes, tattoos and the background can too. Lower Strength keeps it closer to the original.' },
  klein9b: { label: 'Klein 9B', tpl: 'deck-klein9b-i2i', strength: 0.35, prompt: 'highly detailed, fine texture, sharp focus, crisp edges',
    help: 'FLUX.2 Klein 9B draws it again at low strength: adds believable fine detail (skin, fabric, foliage) from the prompt. A good all-rounder.' },
  klein3: { label: 'Klein 3', tpl: 'deck-klein3-i2i', strength: 0.35, prompt: 'highly detailed, fine texture, sharp focus, crisp edges',
    help: 'The newer Klein: a different look from Klein 9B, so try both on the same picture.' },
  krea2: { label: 'Krea 2', tpl: 'deck-krea2-i2i', strength: 0.3, prompt: 'highly realistic detailed photograph, natural light, rich texture, sharp focus',
    help: 'Krea 2 turbo: strong on light and materials. On faces it can draw dotted pores and change the likeness, so use Skin for those.' },
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
// (it doesn't open with "Remove" and says to keep everything whole: on a frame of someone on a bicycle, the old wording, kept below, took most of the bicycle away)
const DELIGHT_PROMPT = 'Relight this picture evenly and softly from every side, like an overcast day or a light tent, so dark areas are brightened and nothing is in shadow. Show the true colours and surface of the materials. Keep every person and object whole, with everything they ride, hold, wear or stand on, and keep the shape, pose, details, background and framing exactly the same.';
const OLD_DELIGHT_PROMPT = 'Remove all the lighting and shadows from this picture: light it evenly and softly from every side, like an overcast day or a light tent, so dark areas are brightened and nothing is in shadow. Show the true colours and surface of the materials. Keep the shape, pose, details, background and framing exactly the same.';

// (it asks for colour only: the picture's own brightness goes back on the result, photo-restore.js keepBrightness)
const COLOUR_PROMPT = 'Colorize this black and white photograph with natural, true-to-life colors: real skin tones, clothing, plants, sky and materials. Keep every person and object, the light, the shadows, the details and the framing exactly the same. Do not add or remove anything.';

const OPS = [
  { id: 'edit', group: 'Edit', label: 'Edit from a prompt (Qwen 2.1)', tpl: 'deck-qwen21-edit', kind: 'edit',
    help: 'Say what to change, and Qwen 2.1 draws each picture again with that change. Select many layers to run the same edit on each. Each result lands as a new layer over its original. The model works at the size set below, bigger or smaller than the picture, and the result lands at the size of its original. With an area the rest stays pixel for pixel.' },
  { id: 'depth', group: 'Maps', label: 'Depth map', tpl: MAPS.depth.still, kind: 'layer', depth: true,
    help: 'A grey depth map (near is white) of the picture: Video Depth Anything. A layer on top; use it as a reference picture or control.' },
  { id: 'canny', group: 'Maps', label: 'Canny edges', tpl: MAPS.canny.still, kind: 'layer', edges: [0.2, 0.4, 0.6],
    help: 'White edges on black: the Canny map that edge control and edit models follow.' },
  { id: 'scribble', group: 'Maps', label: 'Scribble', tpl: MAPS.scribble.still, kind: 'layer', edges: [16, 28, 40],
    help: 'A loose line drawing, white lines on black: softer and simpler than Canny.' },
  { id: 'pose', group: 'Maps', label: 'Pose', tpl: MAPS.pose.still, sd: MAPS.pose.stillSd, kind: 'layer',
    help: 'The body, hands and face landmarks as an OpenPose-style picture. DWPose runs on the CPU; SDPose uses the GPU and holds up better on hard poses (up to 2 people).' },
  { id: 'cutout', group: 'Cut out and mask', label: 'Auto mask: the subject', tpl: 'deck-cutout-image', kind: 'matte',
    help: 'BiRefNet finds the main subject. The result is a cut-out layer (the background see-through) or the mask, to redraw it or everything else.' },
  { id: 'words', group: 'Cut out and mask', label: 'Auto mask: by words (SAM3)', tpl: 'deck-mask-image', kind: 'matte', prompt: true,
    help: 'SAM3 finds what you name ("the red car", "people", "the sky") and joins everything it finds. The result is a cut-out layer or the mask.' },
  { id: 'sheet', group: 'Cut out and mask', label: 'Split a sheet: enlarge and cut out each (for 3D)', tpl: 'deck-sheet-cell', kind: 'sheet', prompt: true,
    help: 'For a character or object sheet with rows and columns of views: cuts it into equal cells, makes each one bigger, and SAM3 cuts out what you name in it (the best match). Each view lands as its own layer where its cell was, ready for the 3D object slots (Save as input). Needs one run per cell.' },
  { id: 'swap', group: 'Swap', label: 'Swap a face or body from another picture', kind: 'swap',
    help: 'Pick the part, the picture to take it from and one or more models, then Swap. The area is found for you (the biggest one if there are several), or use the red mask to choose it. The model sees a close-up, and its result goes back through a soft edge: outside the area the picture stays pixel for pixel. Each ticked model lands as its own layer, to compare.' },
  { id: 'remove', group: 'Clean up', label: 'Remove: a watermark, text or what you name', tpl: 'deck-remove-lama', kind: 'remove',
    help: 'Find by name: SAM3 marks what you name in red, for you to check and put right, since it can miss a watermark or mark other things. The red mask: you paint it (Masks panel), or check what was found, and Remove takes it out: LaMa fills it in from what is round it, with no prompt. Only that area changes: the rest stays pixel for pixel, at full size. Best on small things on a plain or even background; a very big area comes back softer. Separate words with commas for several things. A big area on a busy background is better redrawn in Inpaint.' },
  { id: 'unmark', group: 'Clean up', label: 'Remove a watermark all over the picture', kind: 'delight', promptKey: 'uprompt', fallback: UNMARK_PROMPT, done: 'Watermark removed',
    help: 'For a faint watermark repeated across the whole picture, which can\'t be marked as an area: an edit model draws the picture again without it. It runs at about 2 MP, and can change small details, so compare the result with the original.' },
  { id: 'clean', group: 'Clean up', label: 'Clean: noise, JPEG blocks or blur', tpl: 'deck-clean-image', kind: 'clean',
    help: 'A restoration model at the picture\'s own size: quick, and it adds nothing that isn\'t there.' },
  { id: 'restore', group: 'Clean up', label: 'Restore an old photo', tpl: 'deck-clean-image', kind: 'restore',
    help: 'Runs the steps you tick, one after another, and lands the result as one new layer. Scratches and dust are found from how thin and how different they are (no model), and LaMa fills them in. Clean is a restoration model at the picture\'s own size. Faces: SAM3 finds each face and GFPGAN redraws it. Colour is as Colourise. Compare with the original: a thin line in the picture itself can be taken for a scratch.' },
  { id: 'colorise', group: 'Colour', label: 'Colourise a black and white picture', kind: 'colorise',
    help: 'An edit model adds colour, and only its colour is kept: the picture\'s own brightness goes back on it, so every detail stays at full size and faces can\'t change shape. The model works at about 2 MP. Its colours are a guess: the prompt can say what they should be (a red car, a blue dress). Try another model if they come out flat.' },
  { id: 'delight', group: 'Detail', label: 'De-light (even out dark or shadowed pictures)', kind: 'delight',
    help: 'An edit model takes the lighting out: dark pictures are brightened and hard shadows softened, with the shape and colours kept. Run it on a view before it goes to image or 3D generation. The result is a new layer; the prompt can be changed.' },
  { id: 'up', group: 'Upscale', label: 'Upscale (quality)', tpl: 'deck-upscale-image', kind: 'up',
    help: 'SeedVR2 makes the picture bigger and sharper, adding detail. Slow, and the memory it needs grows with the size: 2× of a 1 MP picture is fine, 4× of a big one may not fit. The new layer sits the same size on the canvas; Export size (Export panel) is set to match, so Download and Save as input come out that much bigger.' },
  { id: 'skin', group: 'Detail', label: 'Skin detail', kind: 'detail', get model() { return ST.skinWhere === 'parts' ? 'skin' : 'skinwhole'; },
    help: 'Whole picture: the model draws all of it again. Body parts: finds each part you name in each picture, redraws it larger with Klein 9B and a realistic detail LoRA, and blends it back: the rest stays as it is. Each name is one pass on the best match, so name both arms separately (left arm, right arm), and a part it can\'t find is left unchanged. With several layers selected, each gets all the parts and one result over it. A tight part gains the most: a part is drawn at 1024 px (1536 on a large picture), so a very big one can come back softer. Tattoos can be redrawn at 0.3 and above, and naming the whole person can change the face.' },
  { id: 'detail', group: 'Detail', label: 'Detail pass', kind: 'detail',
    help: 'Draws the picture again with more fine detail and the same layout. Pick the model: they differ a lot by subject, so try two on the same picture. Low strength keeps it close to the original.' },
  { id: 'upfast', group: 'Upscale', label: 'Upscale (fast)', tpl: 'deck-upscale-image-fast', kind: 'up',
    help: '4x-UltraSharp: a quick, clean enlargement without the invented detail. Export size is set to match, so Download and Save as input come out bigger.' },
];
const ST = { skinWhere: 'whole', skinParts: 'face', samSure: 0.2, samMost: 8, op: 'cutout', scope: 'whole', result: 'cutout', hide: true, fine: true, rfrom: 'words', rprompt: 'watermark', cmodel: 'noise', uprompt: UNMARK_PROMPT, prompt: 'person', rows: 1, cols: 4, sheetFast: false, swapPart: 'face', swapFrom: '', swapModels: ['klein9b'], swapWhere: 'find', swapExtra: '', scale: 2, poser: 'dwpose', depthModel: 'large', edgeAmount: 'normal', stepScratch: true, stepClean: true, stepFaces: true, stepColour: false, scratchAmount: 'normal', faceAmount: 0.8, cprompt: COLOUR_PROMPT, dmodel: 'klein9b', lmodel: 'krea2', lprompt: DELIGHT_PROMPT, dprompt: {}, dstrength: {}, eprompt: '', econtext: '', ekeep: true, erefs: [], ewhere: 'all', efind: '', eclose: true, egrow: 8, esoft: 16, emp: 2, ecount: 1, eseed: 0, eseedMode: 'random', esteps: 8, ecfg: 1, eneg: '', eloras: [], ...store.get(KEY, {}) };
if (ST.lprompt === OLD_DELIGHT_PROMPT) ST.lprompt = DELIGHT_PROMPT;   // (the old default, saved in this browser; a prompt someone wrote stays)
const save = () => store.set(KEY, ST);
const FLIGHT = new Set();   // runs on their way back
const op = () => OPS.find((o) => o.id === ST.op) || OPS[0];
// the models that can do the chosen part here: the template is installed, and its LoRA if it needs one
const loraField = (t) => t?.fields.find((f) => f.kind === 'loras');
// a detail model that needs a LoRA shows only if it is installed
const canDetail = (k) => { const m = DETAIL[k]; return !!m && (!m.own || op().model === k) && (!m.lora || (loraField(template(m.tpl))?.options || []).includes(m.lora)); };
// (the Skin tool is the detail pass with its own model fixed)
const dmKey = () => (op().model && canDetail(op().model) ? op().model : canDetail(ST.dmodel) ? ST.dmodel : 'klein9b');
const dm = () => DETAIL[dmKey()];
const canSwap = (k) => { const t = template(SWAP_MODELS[k]?.tpl); return !!t && swapLora(k, ST.swapPart, loraField(t)?.options || []) !== false; };
const swapModels = () => ST.swapModels.filter(canSwap);
const tplId = (o) => (o.kind === 'swap' ? (SWAP_MODELS[swapModels()[0]] || SWAP_MODELS.klein9b).tpl : o.kind === 'delight' || o.kind === 'colorise' ? (DELIGHT[ST.lmodel] || DELIGHT.krea2).tpl : o.kind === 'sheet' ? (ST.sheetFast ? 'deck-sheet-cell-fast' : 'deck-sheet-cell') : o.kind === 'detail' ? (o.model && !canDetail(o.model) ? `${DETAIL[o.model].tpl} with its LoRA` : dm().tpl) : o.sd && ST.poser === 'sdpose' ? o.sd : o.tpl);

// (a run's file is asked for afresh: runs deleted along the way free their ids, so the next run's file can have the same name, and the browser would show the old one)
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not load a picture')); i.src = src.startsWith('/files/') ? `${src}${src.includes('?') ? '&' : '?'}at=${Date.now()}${Math.random()}` : src; });

// the selected layers an Image tool can run on, one run each: picture layers, not a mask or draft
const usable = (l) => l && !l.mask && !l.draft && !l.maskOf && !l.broken && l.name;
const targets = (eng) => (eng.picked?.() || []).filter(usable);

// a cropped layer's kept part, at the file's own pixels, as a new input
async function keptPart(eng, l) {
  const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, c = l.crop, cv = document.createElement('canvas');   // (a painted layer is a canvas)
  [cv.width, cv.height] = G.sentPixels(l);
  const pic = eng.layerPicture(l), k = (pic.naturalWidth || pic.width) / W;   // (with its Colour adjustments: what's sent is what you see)
  cv.getContext('2d').drawImage(pic, c.x * W * k, c.y * H * k, c.w * W * k, c.h * H * k, 0, 0, cv.width, cv.height);
  const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'layer.png', multiple: 1 });
  return { name: up.name, px: [cv.width, cv.height] };
}

// The tools whose result has its layer's framing, so the layer's mask fits it
const KEEPS_FRAMING = new Set(['up', 'detail', 'delight', 'remove', 'clean', 'swap', 'restore', 'colorise', 'edit']);
// what the tool works on: a layer (null: every layer together). { name (an input), rect (where it sits on the canvas before
// any turn), layer (or null), was (the layer's place when sent: its turn goes on the result), mask (its mask when sent, for a tool in KEEPS_FRAMING), px }. A model sees a layer unturned.
async function sourceOf(eng, l, o) {
  if (l) {
    const part = G.plainCrop(l.crop) && !isOn(l.adjust) ? { name: l.name, px: G.sentPixels(l) } : await keptPart(eng, l);
    return { ...part, rect: eng.layerRect(l), layer: l, was: { ...l }, mask: KEEPS_FRAMING.has(o.kind) ? maskAsSent(eng, l) : null };
  }
  const f = eng.frame(), pic = document.createElement('canvas');
  if (!f || !eng.compose(pic)) throw new Error('Add a picture first');
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'tool.png', multiple: 1 });
  // (every layer together: the empty part of the canvas stays empty)
  const bare = document.createElement('canvas');   // (what is sent has the canvas's background behind it: this has not)
  const empty = KEEPS_FRAMING.has(o.kind) && eng.compose(bare, true) ? shapeOf(bare, 0, 0, bare.width, bare.height, bare.width, bare.height) : null;
  if (empty) { const c = empty.getContext('2d'); c.globalCompositeOperation = 'source-in'; c.fillStyle = '#fff'; c.fillRect(0, 0, empty.width, empty.height); }
  return { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height], mask: empty };
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
          run = await sent({ template: t.id, values: { [imageField.key]: up.name, ...valuesByRole(t, { seed: -1, prompt }), ...samKnobs(t) }, batch: 1 });
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
  return uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'on-black.png', multiple: 1, board: 'Cut out on black' });
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

// A result is in: with Hide the original on, its layer hides and the result takes its place in the selection
function hideOriginal(eng, src, made) {
  if (!src.layer || !ST.hide) return;
  src.layer.hidden = true;
  Stack.handOver(eng.E, src, made);
}

async function land(eng, o, src, done, cell) {
  const { rect, layer } = src;
  const x = besideX(rect, cell?.nth, !!eng.E.size);   // (a variation goes beside the one before it)
  if (o.kind === 'matte') {
    const b = ST.fine ? busy('Cleaning the edges…') : null;
    const matte = await (ST.fine ? finerMatte(template(o.tpl), src.name, done, o.prompt ? ST.prompt.trim() : undefined, b) : matteOf(done)).finally(() => b?.done());
    if (ST.result === 'mask') {
      eng.paint.maskFromMatte(matte, rect, src.was && G.turn(src.was));
      return toast(`${o.label}: added to the mask (Masks panel)`);
    }
    const cut = await cutOut(src.name, matte);
    const up = ST.result === 'black' ? await onBlack(cut) : await uploadImage(await pngBlob(cut), { mp: 0, source: 'editor', filename: 'cutout.png', multiple: 1, board: 'Cut out' });
    hideOriginal(eng, src, eng.addImage(up.name, { label: ST.result === 'black' ? 'Cut out on black' : 'Cut out', ...placed(src, rect.x, rect.y, rect.w, up) }));
  } else if (o.kind === 'sheet') {
    let r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    if (ST.result === 'black') r = await onBlack(await loadImg(inputUrl(r.name)));
    const cw = rect.w / ST.cols, ch = rect.h / ST.rows;
    const view = eng.addImage(r.name, { label: `${ST.result === 'black' ? 'View on black' : 'View'} ${cell.r + 1}-${cell.c + 1}`, ...placed(src, rect.x + cell.c * cw, rect.y + cell.r * ch, cw, r) });
    if (layer && ST.hide) Stack.handOver(eng.E, src, view);   // (it hides when the last view is in)
    return eng.changed(), eng.render();
  } else {
    const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    const made = eng.addImage(r.name, { label: o.kind === 'up' ? `Upscaled ${r.width}×${r.height}` : o.kind === 'edit' ? 'Edited' : o.kind === 'delight' ? (o.done || 'De-lit') : o.kind === 'detail' ? `Detail (${dm().label})` : o.kind === 'clean' ? `Cleaned (${(CLEAN[ST.cmodel] || CLEAN.noise).label})` : o.label, ...placed(src, x, rect.y, rect.w, r), ...(await maskForResult(src, r)) });
    if (KEEPS_FRAMING.has(o.kind)) hideOriginal(eng, src, made);
    if (o.kind === 'up') eng.E.out = Math.max(eng.E.out || 1, ST.scale);   // (the layer keeps its size on the canvas; exporting at this size shows the new detail)
  }
  eng.changed(); eng.render();
  toast(`${o.label}: done, a new layer on top`);
}

// ---- The runs an edit is owed: kept in this browser (web/owed-runs.js), so they land after a reload, or when you go back to their edit ----
const OWED = 'deck.imagetools.owed';
const owedList = () => store.get(OWED, []);
const FOLLOWING = new Set();   // run ids this page is already waiting for
// (a cut-out's landing needs the template and the matte's own steps, so it isn't kept. false: nothing kept, or storage is off in this browser)
function rememberOwed(o, tab, src, g, nth) {
  if (!tab || o.kind === 'matte') return false;
  store.set(OWED, withOwed(owedList(), owedRecord(tab, o.id, src, g, nth)));
  return owedList().some((r) => r.id === g.id);
}
const forgetOwed = (id) => store.set(OWED, withoutOwed(owedList(), id));
// taken off the list before landing, so a second window with this edit open doesn't land it too
function takeOwed(id) {
  if (!owedList().some((r) => r.id === id)) return false;
  forgetOwed(id);
  return true;
}

// a finished run into its edit, if that's the one open
async function settle(eng, o, tab, src, done, nth, kept) {
  if (eng.E.tab?.id !== tab) return toast(kept ? `${o.label} #${done.id} finished on another edit: it lands when you go back to it` : `${o.label} #${done.id} finished on another edit: it is in History`);
  if (kept && !takeOwed(done.id)) return;
  if (src.layer && !eng.E.layers.includes(src.layer)) src.layer = layerOf(eng.E.layers, src.was);   // (the edit was opened again: its layers are new objects)
  await land(eng, o, src, done, { nth });
}

// One queued run, from here until it lands. nth: which variation of its picture
function follow(eng, o, tab, src, g, nth = 0) {
  const kept = rememberOwed(o, tab, src, g, nth);
  FOLLOWING.add(g.id); FLIGHT.add(g.id); eng.render();
  waitGen(g.id).then((done) => settle(eng, o, tab, src, done, nth, kept))
    .catch((e) => { forgetOwed(g.id); toast(`${o.label} failed${src.layer ? ` on ${layerWord(src.layer)}` : ''}: ${e.message}`, true); })
    .finally(() => { FOLLOWING.delete(g.id); FLIGHT.delete(g.id); eng.render(); });
}

// a kept run, picked up again once the edit's pictures have loaded
async function resumeOwed(eng, rec) {
  const o = OPS.find((x) => x.id === rec.op), tab = rec.tab;
  FOLLOWING.add(rec.id); FLIGHT.add(rec.id); eng.render();
  try {
    if (!o) return forgetOwed(rec.id);
    let g;
    try { g = await api(`/api/generations/${rec.id}`, { busy: false }); } catch (e) {
      if (e.status === 404) forgetOwed(rec.id);   // (the run was deleted. Otherwise the server is away: it stays, for next time)
      return;
    }
    if (!sameRun(rec, g)) return forgetOwed(rec.id);
    const done = g.status === 'done' ? g : await waitGen(rec.id);
    while (eng.E.tab?.id === tab && eng.loading()) await new Promise((go) => setTimeout(go, 200));
    if (eng.E.tab?.id !== tab) return;   // (left again: it stays on the list for the next time this edit opens)
    const layer = layerOf(eng.E.layers, rec.was);
    const src = { name: rec.name, px: rec.px, rect: rec.rect, was: rec.was, layer, mask: layer && eng.ready(layer) && KEEPS_FRAMING.has(o.kind) ? maskAsSent(eng, layer) : null };
    await settle(eng, o, tab, src, done, rec.nth, true);
  } catch (e) { forgetOwed(rec.id); toast(`${o?.label || 'A tool'} failed: ${e.message}`, true); } finally { FOLLOWING.delete(rec.id); FLIGHT.delete(rec.id); eng.render(); }
}

// Called when an edit opens: whatever it's still owed that nothing in this page is waiting for
export function landOwed(eng) {
  const tab = eng.E.tab?.id;
  if (!tab) return;
  for (const rec of owedFor(owedList(), tab)) if (!FOLLOWING.has(rec.id)) resumeOwed(eng, rec);
}

async function run(eng) {
  const o = op(), t = template(tplId(o));
  if (o.kind === 'swap' && !ST.swapFrom) return toast('Pick the picture to take it from first', true);
  if (o.kind === 'swap' && !swapModels().length) return toast('Tick an installed model first', true);
  if (o.kind === 'swap' && !template('deck-mask-image')) return toast('deck-mask-image isn\'t installed', true);
  if (!t) return toast(`${tplId(o)} isn't installed`, true);
  if (eng.loading()) return toast('The images are still loading', true);
  if (o.prompt && !ST.prompt.trim()) return toast('Say what to find first', true);
  if (o.model === 'skin' && !partsOf(ST.skinParts).length) return toast('Say which body parts first', true);
  if (!eng.E.layers.some((l) => !l.mask && !l.draft)) return toast('Add a picture first', true);
  if (o.kind === 'remove' && ST.rfrom === 'words' && !termsOf(ST.rprompt).length) return toast('Say what to remove first', true);
  if (o.kind === 'remove' && !template('deck-mask-image')) return toast('deck-mask-image isn\'t installed', true);
  if (o.kind === 'edit' && !ST.eprompt.trim()) return toast('Say what to change first', true);
  if (o.kind === 'edit' && ST.ewhere === 'words' && !termsOf(ST.efind).length) return toast('Say what to find first', true);
  if (o.kind === 'edit' && ST.ewhere === 'words' && !template('deck-mask-image')) return toast('deck-mask-image isn\'t installed', true);
  const tab = eng.E.tab?.id, b = busy('Sending the picture…');
  try {
    await eng.paint.savePaint();
    if (o.kind === 'remove' && ST.rfrom === 'painted') return await removePainted(eng, o, t, tab);
    if (o.kind === 'swap' && ST.swapWhere === 'painted') return await swapPainted(eng, o, tab);
    if (o.kind === 'edit' && ST.ewhere === 'painted') return await editPainted(eng, o, t, tab);
    const list = ST.scope === 'selected' ? targets(eng) : [null];
    if (!list.length) return toast('Select a layer first', true);
    // (each selected layer is its own run, queued one after another; one failing to send doesn't stop the rest)
    const { failed } = await eachOne(list, async (l) => runOne(eng, o, t, tab, await sourceOf(eng, l, o)));
    if (failed.length) toast(failureText(o.label, failed, (l) => l?.label || l?.name?.split('/').pop() || 'the picture'), true);
  } catch (e) { toast(e.message, true); } finally { b.done(); }
}

async function runSheet(eng, o, t, tab, src) {
  const cells = await cutCells(src), set = (input, v) => { const f = t.fields.find((x) => x.input === input); return f ? [f.key, v] : null; };
  const imageField = t.fields.find((f) => f.kind === 'image');
  toast(`${o.label}: ${cells.length} cells queued; each lands as a layer`);
  let left = cells.length;
  const start = async (cell, again) => {
    const sc = set('scale_by', ST.sheetFast ? ST.scale / 4 : ST.scale);
    const values = { [imageField.key]: cell.name, ...valuesByRole(t, { seed: -1, prompt: ST.prompt.trim(), confidence: ST.samSure }), ...(sc && { [sc[0]]: sc[1] }) };
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
    const r = await uploadImage(await pngBlob(result), { mp: 0, source: 'editor', filename: 'removed.png', multiple: 1, board: 'Removed' });
    hideOriginal(eng, src, eng.addImage(r.name, { label: 'Removed', ...placed(src, src.rect.x, src.rect.y, src.rect.w, r), ...(await maskForResult(src, r)) }));
    eng.changed(); eng.render();
    toast(`${o.label}: done, a new layer on top`);
  } finally { FLIGHT.delete(fillIn); b.done(); eng.render(); }
}

// SAM3 on a picture: how sure it must be and how many it takes, as set in the panel (the template's own fields)
const samKnobs = (t) => valuesByRole(t, { confidence: ST.samSure, maxFound: ST.samMost });
const samFields = (eng, most = true) => [
  rangeField('How sure', () => ST.samSure, (v) => { ST.samSure = v; save(); }, { min: 0.05, max: 0.95, step: 0.05,
    help: 'What SAM3 needs to be sure of before it takes something. Lower finds more, and may take the wrong things; higher finds less.' }),
  most ? rangeField('At most', () => ST.samMost, (v) => { ST.samMost = v; save(); }, { min: 1, max: 32, step: 1, fmt: (v) => String(v),
    help: 'How many things it takes for each word. They are joined into one matte.' }) : null];

// what SAM3 finds for these words in a picture, one search each, joined on a W×H canvas (white = found). Its runs are only a means, so they go.
async function searchFor(name, W, H, terms) {
  const find = template('deck-mask-image'), image = find.fields.find((f) => f.kind === 'image');
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'lighten';
  for (const term of terms) {
    const done = await sent({ template: find.id, values: { [image.key]: name, ...valuesByRole(find, { seed: -1, prompt: term }), ...samKnobs(find) }, batch: 1 });
    for (const x of (done.outputs || []).filter((y) => y.kind === 'image')) c.drawImage(await loadImg(x.url), 0, 0, W, H);
    await dropRun(done.id);
  }
  return cv;
}
const dropRun = (id) => api(`/api/generations/${id}`, { method: 'DELETE', busy: false }).catch(() => {});
const dropInput = (name) => api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});

// ...what's named in the Find box, one search each, all of it joined. It only marks: SAM3 often misses a watermark or takes other things for it
// ("text" found nothing on large white letters, "watermark" other things too), so what goes is seen in red and can be put right before Run removes it.
async function markFound(eng, o, src) {
  const [W, H] = src.px, cv = await searchFor(src.name, W, H, termsOf(ST.rprompt));
  if (!boundsOf(redOf(cv, W, H), W, H)) return toast('SAM3 found nothing there: try other words, or paint it (Masks panel)', true);
  eng.paint.maskFromMatte(cv, src.rect, src.was && G.turn(src.was));
  ST.rfrom = 'painted'; save(); eng.render();
  toast('Marked in red: check it (paint more or erase in the Masks panel), then Remove');
}

// ...the mask as painted: on the whole picture, as a painted mask is
async function removePainted(eng, o, t, tab) {
  const f = eng.frame(), m = eng.composeMask();
  if (!f || !m) return toast('Paint what to remove first (Masks panel)', true);
  if (ST.scope === 'selected') return removeOnLayers(eng, o, t, tab, f, m);
  const pic = document.createElement('canvas');
  if (!eng.compose(pic)) return toast('Add a picture first', true);
  if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'remove.png', multiple: 1 });
  return fillIn(eng, o, t, tab, { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height] }, m.canvas);
}

// ...on each selected layer alone: the one painted mask is cut to each, and a layer it doesn't touch is left out
async function removeOnLayers(eng, o, t, tab, f, m) {
  const list = targets(eng);
  if (!list.length) return toast('Select a layer first', true);
  const jobs = list.map((l) => [l, layerMask(m, f, l)]).filter(([, cut]) => cut);
  if (!jobs.length) return toast('The mask doesn\'t touch a selected layer', true);
  if (jobs.length < list.length) toast(`The mask misses ${list.length - jobs.length} of the selected layers: they stay as they are`);
  const { failed } = await eachOne(jobs, async ([l, cut]) => {
    const src = await sourceOf(eng, l, o);
    try { await fillIn(eng, o, t, tab, src, cut.canvas); } finally { if (src.name !== l.name) await dropInput(src.name); }   // (a kept part, sent only for this)
  });
  if (failed.length) toast(failureText(o.label, failed, ([l]) => l.label || l.name.split('/').pop()), true);
}

// ---- Swap: a character's face, head or body from another picture ----
// the part in a W×H picture, as a row-by-row mask of its biggest area; null if it isn't found
async function findPart(name, W, H, part) {
  const p = SWAP_PARTS[part], red = redOf(await searchFor(name, W, H, p.find), W, H);
  if (!boundsOf(red, W, H)) return null;
  const whole = onlyWithin(red, W, biggestArea(separateAreas(red, W, H)));
  if (!p.keep) return { mask: whole, keep: null };
  const keep = redOf(await searchFor(name, W, H, p.keep), W, H), left = without(whole, keep);
  return boundsOf(left, W, H) ? { mask: left, keep } : { mask: whole, keep: null };
}
const canvasOf = (W, H) => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; return cv; };
const maskCanvas = (red, W, H) => {
  const cv = canvasOf(W, H), c = cv.getContext('2d'), d = c.createImageData(W, H);
  for (let i = 0; i < red.length; i++) { const j = i * 4; d.data[j] = d.data[j + 1] = d.data[j + 2] = red[i]; d.data[j + 3] = 255; }
  c.putImageData(d, 0, 0);
  return cv;
};

// the picture to take the part from: for a face or head a close-up of it, so the model has its likeness at full size. Whole if it isn't found.
async function swapReference(part) {
  const p = SWAP_PARTS[part];
  if (!p.closeUp) return { name: ST.swapFrom, made: false };
  const img = await loadImg(inputUrl(ST.swapFrom)).catch(() => { throw new Error('The picture to take it from is gone: pick it again'); });
  const W = img.naturalWidth, H = img.naturalHeight, found = await findPart(ST.swapFrom, W, H, part);
  if (!found) return { name: ST.swapFrom, made: false };
  const box = swapBox(boundsOf(found.mask, W, H), W, H, 0.35), cv = canvasOf(box.w, box.h);
  cv.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const up = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'swap-from.png', multiple: 1 });
  return { name: up.name, made: true };
}

// a copy of a reference at about this many pixels, as a new input; null if it is already no bigger, or none is wanted
async function smallerRef(name, pixels) {
  if (!pixels) return null;
  const img = await loadImg(inputUrl(name)), k = Math.sqrt(pixels / (img.naturalWidth * img.naturalHeight));
  if (k >= 1) return null;
  const cv = canvasOf(Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k)), c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(img, 0, 0, cv.width, cv.height);
  return (await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: 'swap-from-small.png', multiple: 1 })).name;
}

// what one model is told for a swap: the close-up, the reference, its prompt and size, and its LoRA
function swapValues(t, key, part, close, ref, size) {
  const main = t.fields.find((f) => f.kind === 'image' && /image to edit/i.test(f.group));
  const refField = t.fields.find((f) => f.kind === 'image' && /reference/i.test(f.group));
  const prompt = t.fields.find((f) => f.kind === 'text' && /^edit$/i.test(f.group) && !/negative/i.test(f.input));
  if (!main || !refField || !prompt) throw new Error('it has no reference picture');
  const lora = swapLora(key, part, loraField(t)?.options || []);
  return { [main.key]: close, [refField.key]: ref, [prompt.key]: swapPrompt(part, key, ST.swapExtra), ...wholePicture(t, size, SWAP_MODELS[key].maxPixels),
    ...(lora && { [loraField(t).key]: [lora] }) };
}

// The swap on a picture whose area is known: one close-up and one soft edge, then a run per ticked model. Each result goes back on a
// copy of the picture through that edge and lands as a layer. The close-up, the reference and the runs were only a means, so they go.
async function swapArea(eng, o, tab, src, { mask: red, keep }, b) {
  const part = ST.swapPart, p = SWAP_PARTS[part], [W, H] = src.px, area = boundsOf(red, W, H);
  if (!area) throw new Error('There is nothing in the area to swap');
  const box = swapBox(area, W, H, p.room), side = Math.max(area.w, area.h), k = scaleFor(box, p.pixels);
  const cw = Math.max(64, Math.round(box.w * k)), ch = Math.max(64, Math.round(box.h * k));
  const pic = await loadImg(inputUrl(src.name)), close = canvasOf(cw, ch), cc = close.getContext('2d');
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
  const area0 = cropOf(red, W, box), keep0 = keep && cropOf(keep, W, box);
  const was = canvasOf(box.w, box.h), wc = was.getContext('2d', { willReadFrequently: true });
  wc.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const before = wc.getImageData(0, 0, box.w, box.h).data;
  b.set('Finding the part to take…');
  const ref = await swapReference(part), closeUp = await uploadImage(await pngBlob(close), { mp: 0, source: 'editor', filename: 'swap-close.png', multiple: 1 });
  const wanted = swapModels();
  FLIGHT.add(swapArea); eng.render();
  try {
    for (const [n, key] of wanted.entries()) {
      const m = SWAP_MODELS[key], t = template(m.tpl);
      b.set(`${m.label} (${n + 1} of ${wanted.length})…`);
      let run = null, smaller = null;
      try {
        smaller = await smallerRef(ref.name, swapRefPixels(key, part));
        const values = { ...valuesByRole(t, { seed: -1 }), ...swapValues(t, key, part, closeUp.name, smaller || ref.name, [cw, ch]) };
        run = await once({ template: t.id, values, batch: 1 });
        const made = await loadImg(run.outputs.find((x) => x.kind === 'image').url);
        if (eng.E.tab?.id !== tab) { toast(`${o.label} finished on another edit`); continue; }
        const r = await uploadImage(await pngBlob(pasted(pic, W, H, made, box, before, area0, keep0, side, p)), { mp: 0, source: 'editor', filename: 'swapped.png', multiple: 1, board: `${p.label} swap (${m.label})` });
        hideOriginal(eng, src, eng.addImage(r.name, { label: `${p.label} swap (${m.label})`, ...placed(src, src.rect.x, src.rect.y, src.rect.w, r), ...(await maskForResult(src, r)) }));
        eng.changed(); eng.render();
      } catch (e) { toast(`${m.label}: ${e.message}`, true); } finally { if (run) await dropRun(run.id); if (smaller) await dropInput(smaller); }
    }
  } finally {
    FLIGHT.delete(swapArea);
    await dropInput(closeUp.name);
    if (ref.made) await dropInput(ref.name);
    eng.render();
  }
  toast(`${o.label}: done`);
}

// a copy of the picture with what the model made back in its box, through the edge
function pasted(pic, W, H, made, box, before, area, keep, side, p) {
  const piece = canvasOf(box.w, box.h), c = piece.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  c.drawImage(made, 0, 0, box.w, box.h);
  const px = c.getImageData(0, 0, box.w, box.h);
  // the area, and what the model changed right next to it (a new beard, a bigger build), but never what is to be kept
  const near = changedAround(before, px.data, area, box.w, box.h);
  let use = near ? joined(area, near) : area;
  if (keep) use = without(use, keep);
  const e = softEdge(use, box.w, box.h, side * p.grow, side * p.soft);
  // (the kept part wins over the grown edge: a head is small beside a full-length figure, and the growth alone would cover it)
  const held = keep && softEdge(keep, box.w, box.h, 0, Math.max(4, side * 0.008));
  for (let i = 0; i < e.length; i++) px.data[i * 4 + 3] = held ? Math.min(e[i], 255 - held[i]) : e[i];
  c.putImageData(px, 0, 0);
  const out = canvasOf(W, H), oc = out.getContext('2d');
  oc.drawImage(pic, 0, 0, W, H);
  oc.drawImage(piece, box.x, box.y);
  return out;
}

async function swapOnSource(eng, o, tab, src) {
  const b = busy('Finding the area…');
  try {
    const [W, H] = src.px, found = await findPart(src.name, W, H, ST.swapPart);
    if (!found) return toast(`SAM3 found no ${SWAP_PARTS[ST.swapPart].label.toLowerCase()} there: paint the red mask instead`, true);
    await swapArea(eng, o, tab, src, found, b);
  } finally { b.done(); }
}

// ...on the red mask as painted: on the whole picture, as a painted mask is
async function swapPainted(eng, o, tab) {
  const f = eng.frame(), m = eng.composeMask();
  if (!f || !m) return toast('Paint the area first (Masks panel), or have it found', true);
  const pic = document.createElement('canvas');
  if (!eng.compose(pic)) return toast('Add a picture first', true);
  if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'swap.png', multiple: 1 }), b = busy('Swapping…');
  try {
    await swapArea(eng, o, tab, { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height] }, { mask: redOf(m.canvas, pic.width, pic.height), keep: null }, b);
  } finally { b.done(); }
}

// Send to Generate: a tab per ticked model, set up as Swap would run it, to change its settings and run it there. The close-up and
// reference stay (the tabs use them); what the model makes stays as made, not put back on the picture.
async function swapSend(eng) {
  if (!ST.swapFrom) return toast('Pick the picture to take it from first', true);
  const wanted = swapModels(), part = ST.swapPart, o = op();
  if (!wanted.length) return toast('Tick an installed model first', true);
  const { hooks } = await import('./generate.js');
  if (!hooks.openShot) return toast('The Generate tab isn\'t ready yet', true);
  const b = busy('Finding the area…');
  let spare = null;
  try {
    await eng.paint.savePaint();
    let src, red;
    if (ST.swapWhere === 'painted') {
      const m = eng.composeMask(), pic = document.createElement('canvas');
      if (!m) return toast('Paint the area first (Masks panel), or have it found', true);
      if (!eng.compose(pic)) return toast('Add a picture first', true);
      const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'swap.png', multiple: 1 });
      spare = up.name;
      src = { name: up.name, px: [pic.width, pic.height] };
      red = redOf(m.canvas, pic.width, pic.height);
    } else {
      if (!template('deck-mask-image')) return toast('deck-mask-image isn\'t installed', true);
      const l = ST.scope === 'selected' ? targets(eng)[0] : null;
      if (ST.scope === 'selected' && !l) return toast('Select a layer first', true);
      src = await sourceOf(eng, l, o);
      if (src.name !== l?.name) spare = src.name;
      const found = await findPart(src.name, src.px[0], src.px[1], part);
      if (!found) return toast(`SAM3 found no ${SWAP_PARTS[part].label.toLowerCase()} there: paint the red mask instead`, true);
      red = found.mask;
    }
    const p = SWAP_PARTS[part], [W, H] = src.px, area = boundsOf(red, W, H);
    if (!area) return toast('There is nothing in the area to swap', true);
    const box = swapBox(area, W, H, p.room), k = scaleFor(box, p.pixels);
    const cw = Math.max(64, Math.round(box.w * k)), ch = Math.max(64, Math.round(box.h * k));
    const pic = await loadImg(inputUrl(src.name)), close = canvasOf(cw, ch), cc = close.getContext('2d');
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
    b.set('Setting it up in Generate…');
    const ref = await swapReference(part), closeUp = await uploadImage(await pngBlob(close), { mp: 0, source: 'editor', filename: 'swap-close.png', multiple: 1 });
    let sent = 0;
    switchTab('generate');   // (its tabs start on a first visit)
    for (const key of wanted) {
      const m = SWAP_MODELS[key], t = template(m.tpl);
      try {
        const small = await smallerRef(ref.name, swapRefPixels(key, part));
        await hooks.openShot({ workflow: t.id, values: swapValues(t, key, part, closeUp.name, small || ref.name, [cw, ch]) }, `${p.label} swap · ${m.label}`);
        sent++;
      } catch (e) { toast(`${m.label}: ${e.message}`, true); }
    }
    if (sent) toast(sent > 1 ? `${sent} tabs in Generate, one per model` : 'Set up in Generate');
  } catch (e) { toast(e.message, true); } finally { if (spare) await dropInput(spare); b.done(); }
}

// Mark only: the area goes in the red mask to check and put right, for the next Swap
async function swapMark(eng) {
  const o = op(), b = busy('Finding the area…');
  if (!template('deck-mask-image')) { b.done(); return toast('deck-mask-image isn\'t installed', true); }
  try {
    await eng.paint.savePaint();
    const list = ST.scope === 'selected' ? targets(eng) : [null];
    if (!list.length) return toast('Select a layer first', true);
    for (const l of list) {
      const src = await sourceOf(eng, l, o), [W, H] = src.px, found = await findPart(src.name, W, H, ST.swapPart);
      if (!found) { toast(`SAM3 found no ${SWAP_PARTS[ST.swapPart].label.toLowerCase()} there: paint it (Masks panel)`, true); continue; }
      eng.paint.maskFromMatte(maskCanvas(found.mask, W, H), src.rect, src.was && G.turn(src.was));
      ST.swapWhere = 'painted'; save(); eng.render();
      toast('Marked in red: check it (paint more or erase in the Masks panel), then Swap');
    }
  } catch (e) { toast(e.message, true); } finally { b.done(); }
}

// an edit template's Size for all of a picture of [w, h] (left alone, it crops to a 1024 square)
function wholePicture(t, [w, h], maxPixels) {
  const fw = t.fields.find((f) => f.key === '__deck.width'), fh = t.fields.find((f) => f.key === '__deck.height');
  if (!fw || !fh) return {};
  const [sw, sh] = editSizeFor(w, h, fw.step || 16, maxPixels);
  return { [fw.key]: sw, [fh.key]: sh };
}

// ---- Colourise and Restore: steps on a canvas that ends as one new layer. What each step sends and its run go when it's done ----
const canvasFrom = (pic, W, H) => { const cv = canvasOf(W, H), c = cv.getContext('2d', { willReadFrequently: true }); c.imageSmoothingQuality = 'high'; c.drawImage(pic, 0, 0, W, H); return cv; };
const send = async (cv, filename) => (await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename, multiple: 1 })).name;
const madeBy = async (run) => loadImg(run.outputs.find((x) => x.kind === 'image').url);
// a run on a picture that is only a means: what it made, as a loaded picture
async function throughModel(t, values, name) {
  let run = null;
  try {
    run = await once({ template: t.id, values, batch: 1 });
    return await madeBy(run);
  } finally { if (run) await dropRun(run.id); await dropInput(name); }
}

// the canvas's colour from the edit model, on its own brightness
async function addColour(cv, prompt) {
  const t = template((DELIGHT[ST.lmodel] || DELIGHT.krea2).tpl);
  if (!t) throw new Error('The colour model isn\'t installed');
  const pic = t.fields.find((f) => f.kind === 'image' && /image to edit/i.test(f.group)) || t.fields.find((f) => f.kind === 'image');
  const box = t.fields.find((f) => f.kind === 'text' && /^edit$/i.test(f.group) && !/negative/i.test(f.input));
  const name = await send(cv, 'colourise.png');
  const made = await throughModel(t, { ...valuesByRole(t, { seed: -1 }), [pic.key]: name, ...(box && { [box.key]: prompt }), ...wholePicture(t, [cv.width, cv.height]) }, name);
  const W = cv.width, H = cv.height, c = cv.getContext('2d', { willReadFrequently: true }), d = c.getImageData(0, 0, W, H);
  const over = canvasFrom(made, W, H).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  keepBrightness(d.data, over.data);
  c.putImageData(over, 0, 0);
}

// a finished canvas as the new layer
async function landCanvas(eng, o, tab, src, cv, label, board, nth = 0) {
  if (eng.E.tab?.id !== tab) return toast(`${o.label} finished on another edit: run it again there`, true);
  const r = await uploadImage(await pngBlob(cv), { mp: 0, source: 'editor', filename: `${board.toLowerCase()}.png`, multiple: 1, board });
  hideOriginal(eng, src, eng.addImage(r.name, { label, ...placed(src, besideX(src.rect, nth, !!eng.E.size), src.rect.y, src.rect.w, r), ...(await maskForResult(src, r)) }));
  eng.changed(); eng.render();
  toast(`${o.label}: done, a new layer on top`);
}

async function colourise(eng, o, t, tab, src) {
  const b = busy('Adding colour…');
  FLIGHT.add(colourise); eng.render();
  try {
    const cv = canvasFrom(await loadImg(inputUrl(src.name)), src.px[0], src.px[1]);
    await addColour(cv, ST.cprompt.trim() || COLOUR_PROMPT);
    await landCanvas(eng, o, tab, src, cv, 'Colourised', 'Colourised');
  } finally { FLIGHT.delete(colourise); b.done(); eng.render(); }
}

// LaMa on the marks of a mask (red, row by row), each fill going back through the marks only. Scattered marks would be a run each, so past a few it goes by tiles.
async function fillMarks(cv, marks, b) {
  const t = template('deck-remove-lama'), W = cv.width, H = cv.height;
  const mf = t.fields.find((x) => x.kind === 'mask'), main = t.fields.find((x) => x.key === mf.image_key);
  const maskCv = maskCanvas(marks, W, H), rc = cv.getContext('2d', { willReadFrequently: true });
  let boxes = boxesFor(separateAreas(marks, W, H), W, H, 0.1);
  if (boxes.length > 6) boxes = tilesOf(W, H, LAMA_MOST).filter((q) => { for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) if (marks[y * W + x] > 127) return true; return false; });
  const part = (pic, box, k) => { const out = canvasOf(Math.max(8, Math.round(box.w * k)), Math.max(8, Math.round(box.h * k))), c = out.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height); return out; };
  for (const [n, box] of boxes.entries()) {
    b.set(`Scratches and dust (${n + 1} of ${boxes.length})…`);
    const k = Math.min(1, Math.sqrt(LAMA_MOST / (box.w * box.h)));
    const crop = await send(part(cv, box, k), 'scratches.png'), mask = await uploadMask(part(maskCv, box, k));
    try {
      const fill = await throughModel(t, { [main.key]: crop, [mf.key]: { feather: 2, grow: 4, fit: false, name: mask, src: crop, crop: null, box: { x: 0, y: 0, w: 1, h: 1 } } }, crop);
      // only the marks change, whatever size the fill came back at
      const piece = canvasOf(box.w, box.h), pc = piece.getContext('2d', { willReadFrequently: true });
      pc.filter = 'blur(1.5px)'; pc.drawImage(maskCv, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h); pc.filter = 'none';
      const edge = pc.getImageData(0, 0, box.w, box.h);
      for (let i = 0; i < edge.data.length; i += 4) { edge.data[i + 3] = Math.min(255, edge.data[i] * 2.5); }
      pc.putImageData(edge, 0, 0);
      pc.globalCompositeOperation = 'source-in';
      pc.imageSmoothingQuality = 'high';
      pc.drawImage(fill, 0, 0, box.w, box.h);
      rc.drawImage(piece, box.x, box.y);
    } finally { await dropInput(mask); }
  }
}

// each face (areas: bounds on the canvas) through the face model and back through a soft oval, as strongly as asked
async function redrawFaces(cv, areas, b) {
  const t = template('deck-face-restore'), image = t.fields.find((f) => f.kind === 'image'), rc = cv.getContext('2d', { willReadFrequently: true });
  const boxes = areas.map((a) => faceBox(a, cv.width, cv.height)).filter(Boolean);
  for (const [n, box] of boxes.entries()) {
    b.set(`Faces (${n + 1} of ${boxes.length})…`);
    const close = canvasOf(512, 512), cc = close.getContext('2d');
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, 512, 512);
    const name = await send(close, 'face.png');
    const made = await throughModel(t, { [image.key]: name, ...valuesByRole(t, { seed: -1 }) }, name);
    const piece = canvasOf(box.w, box.h), pc = piece.getContext('2d');
    pc.imageSmoothingQuality = 'high';
    pc.drawImage(made, 0, 0, box.w, box.h);
    pc.globalCompositeOperation = 'destination-in';
    const r = box.w / 2, g = pc.createRadialGradient(r, r, r * 0.68, r, r, r * 0.98);
    g.addColorStop(0, '#000'); g.addColorStop(1, 'transparent');
    pc.fillStyle = g; pc.fillRect(0, 0, box.w, box.h);
    rc.globalAlpha = ST.faceAmount; rc.drawImage(piece, box.x, box.y); rc.globalAlpha = 1;
  }
  return boxes.length;
}

async function restorePhoto(eng, o, tab, src) {
  const steps = [ST.stepScratch, ST.stepClean, ST.stepFaces, ST.stepColour];
  if (!steps.some(Boolean)) return toast('Tick at least one step', true);
  const needs = [ST.stepScratch && 'deck-remove-lama', ST.stepClean && 'deck-clean-image', ST.stepFaces && 'deck-face-restore', (ST.stepScratch || ST.stepFaces) && 'deck-mask-image'].filter(Boolean);
  const missing = needs.find((id) => !template(id));
  if (missing) return toast(`${missing} isn't installed`, true);
  const b = busy('Restoring…');
  FLIGHT.add(restorePhoto); eng.render();
  try {
    const [W, H] = src.px, cv = canvasFrom(await loadImg(inputUrl(src.name)), W, H), c = cv.getContext('2d', { willReadFrequently: true });
    b.set('Finding faces…');
    const faces = ST.stepScratch || ST.stepFaces ? redOf(await searchFor(src.name, W, H, ['face']), W, H) : null;
    const areas = faces && boundsOf(faces, W, H) ? separateAreas(faces, W, H) : [];
    if (ST.stepScratch) {
      b.set('Looking for scratches and dust…');
      await new Promise((go) => setTimeout(go, 30));   // (the message shows before the sums)
      const marks = scratchMask(c.getImageData(0, 0, W, H).data, W, H, { amount: ST.scratchAmount, skip: areas.length ? faces : null });
      if (marks.some((v) => v)) await fillMarks(cv, marks, b);
    }
    if (ST.stepClean) {
      b.set('Cleaning…');
      const t = template('deck-clean-image'), image = t.fields.find((f) => f.kind === 'image'), f = t.fields.find((x) => x.input === 'model_name'), name = await send(cv, 'clean.png');
      const made = await throughModel(t, { [image.key]: name, ...(f && { [f.key]: (CLEAN[ST.cmodel] || CLEAN.noise).model }), ...valuesByRole(t, { seed: -1 }) }, name);
      c.drawImage(made, 0, 0, W, H);
    }
    let redrawn = 0;
    if (ST.stepFaces && areas.length) redrawn = await redrawFaces(cv, areas, b);
    if (ST.stepFaces && !redrawn) toast('No face big enough was found: the other steps still ran');
    if (ST.stepColour) { b.set('Adding colour…'); await addColour(cv, ST.cprompt.trim() || COLOUR_PROMPT); }
    await landCanvas(eng, o, tab, src, cv, 'Restored', 'Restored');
  } finally { FLIGHT.delete(restorePhoto); b.done(); eng.render(); }
}

// ---- Edit: a prompt, what else you can tell it, and the model's knobs, on each picture in turn ----
// what the model is told for one picture, at w×h
function editValues(t, name, [w, h], src) {
  const by = (input) => t.fields.find((f) => f.input === input), set = (input, v) => { const f = by(input); return f ? { [f.key]: v } : {}; };
  const main = t.fields.find((f) => f.kind === 'image' && /image to edit/i.test(f.group)), refs = t.fields.filter((f) => f.kind === 'image' && /reference/i.test(f.group));
  const { use, next } = seedStep(ST.eseedMode, ST.eseed, ST.ecount);
  ST.eseed = next; save();
  const lf = loraField(t), loras = lf ? usableLoras(ST.eloras, lf.options || []) : [];
  return { [main.key]: name, ...Object.fromEntries(ST.erefs.slice(0, refs.length).map((r, i) => [refs[i].key, r])),
    ...set('prompt', editPrompt({ prompt: ST.eprompt, context: ST.econtext, keep: ST.ekeep, layer: layerWord(src.layer) })),
    ...valuesByRole(t, { seed: use }), ...set('sigmas', sigmasFor(ST.esteps)), ...set('cfg', ST.ecfg), ...(ST.ecfg > 1 && set('negative_prompt', ST.eneg)),
    ...(lf && { [lf.key]: loras }), ...set('width', w), ...set('height', h) };
}

// ...of an area of the picture (the mask: red, row by row): each result goes back through its soft edge at the picture's own size, so the rest stays pixel for pixel.
// What the model sees is stretched to exactly its size, so nothing is cropped and the result lines up. What was sent and the runs were only a means, so they go.
async function editArea(eng, o, t, tab, src, red, b) {
  const [W, H] = src.px, area = boundsOf(red, W, H);
  if (!area) throw new Error('There is nothing in the area to edit');
  const box = ST.eclose ? swapBox(area, W, H, 0.35) : { x: 0, y: 0, w: W, h: H }, pic = await loadImg(inputUrl(src.name));
  const [sw, sh] = editSizeTo(box.w, box.h, 32, ST.emp * 1e6), seen = canvasOf(sw, sh), sc = seen.getContext('2d');
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(pic, box.x, box.y, box.w, box.h, 0, 0, sw, sh);
  const edge = softEdge(red, W, H, ST.egrow, ST.esoft), name = await send(seen, 'edit-area.png');
  FLIGHT.add(editArea); eng.render();
  try {
    b.set('Editing…');
    const gens = await queueRun({ template: t.id, values: editValues(t, name, [sw, sh], src), batch: ST.ecount });
    await Promise.all(gens.map(async (g, nth) => {
      let run = null;
      try {
        run = await waitGen(g.id);
        const made = await madeBy(run), out = canvasFrom(pic, W, H), piece = canvasOf(W, H), pc = piece.getContext('2d', { willReadFrequently: true });
        pc.imageSmoothingQuality = 'high';
        pc.drawImage(made, box.x, box.y, box.w, box.h);
        const px = pc.getImageData(0, 0, W, H);
        for (let i = 0; i < edge.length; i++) px.data[i * 4 + 3] = Math.min(px.data[i * 4 + 3], edge[i]);
        pc.putImageData(px, 0, 0);
        out.getContext('2d').drawImage(piece, 0, 0);
        await landCanvas(eng, o, tab, src, out, 'Edited', 'Edited', nth);
      } catch (e) { toast(`${o.label} failed${src.layer ? ` on ${layerWord(src.layer)}` : ''}: ${e.message}`, true); } finally { if (run) await dropRun(run.id); }
    }));
  } finally { FLIGHT.delete(editArea); await dropInput(name); eng.render(); }
}

// ...the area as painted: on the whole picture, as a painted mask is
async function editPainted(eng, o, t, tab) {
  const f = eng.frame(), m = eng.composeMask();
  if (!f || !m) return toast('Paint the area first (Masks panel), or have it found', true);
  if (ST.scope === 'selected') return editOnLayers(eng, o, t, tab, f, m);
  const pic = document.createElement('canvas');
  if (!eng.compose(pic)) return toast('Add a picture first', true);
  if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'edit.png', multiple: 1 }), b = busy('Editing…');
  try {
    await editArea(eng, o, t, tab, { name: up.name, rect: { x: f.x, y: f.y, w: f.w, h: f.h }, layer: null, px: [pic.width, pic.height] }, redOf(m.canvas, pic.width, pic.height), b);
  } finally { b.done(); }
}

// ...on each selected layer alone: the one painted mask is cut to each, and a layer it doesn't touch is left out
async function editOnLayers(eng, o, t, tab, f, m) {
  const list = targets(eng);
  if (!list.length) return toast('Select a layer first', true);
  const jobs = list.map((l) => [l, layerMask(m, f, l)]).filter(([, cut]) => cut);
  if (!jobs.length) return toast('The mask doesn\'t touch a selected layer', true);
  if (jobs.length < list.length) toast(`The mask misses ${list.length - jobs.length} of the selected layers: they stay as they are`);
  const b = busy('Editing…');
  try {
    const { failed } = await eachOne(jobs, async ([l, cut]) => {
      const src = await sourceOf(eng, l, o);
      try { await editArea(eng, o, t, tab, src, redOf(cut.canvas, src.px[0], src.px[1]), b); } finally { if (src.name !== l.name) await dropInput(src.name); }   // (a kept part, sent only for this)
    });
    if (failed.length) toast(failureText(o.label, failed, ([l]) => layerWord(l)), true);
  } finally { b.done(); }
}

// One picture of the batch. Everything: the runs go in the queue and land as they finish. Found by name: SAM3 first, then the area's edit.
async function editOne(eng, o, t, tab, src) {
  if (ST.ewhere === 'words') {
    const [W, H] = src.px, b = busy('Finding the area…');
    try {
      const red = redOf(await searchFor(src.name, W, H, termsOf(ST.efind)), W, H);
      if (!boundsOf(red, W, H)) throw new Error(`SAM3 found no "${ST.efind.trim()}": try other words, or a lower How sure`);
      return await editArea(eng, o, t, tab, src, red, b);
    } finally { b.done(); }
  }
  const gens = await queueRun({ template: t.id, values: editValues(t, src.name, editSizeTo(src.px[0], src.px[1], 32, ST.emp * 1e6), src), batch: ST.ecount });
  toast(`${o.label}: ${gens.length > 1 ? `${gens.length} runs` : `#${gens[0].id}`} queued; each lands as a new layer`);
  gens.forEach((g, nth) => follow(eng, o, tab, src, g, nth));
}

// the Edit tool's settings
function editFields(eng, t, size) {
  const redo = () => { save(); eng.render(); }, lf = loraField(t), installed = lf?.options || [];
  const refsMost = t?.fields.filter((f) => f.kind === 'image' && /reference/i.test(f.group)).length || 0;
  const [sw, sh] = size ? editSizeTo(size[0], size[1], 32, ST.emp * 1e6) : [];
  const ref = (i) => imageInput({ label: `Picture ${i + 2}`, name: ST.erefs[i] ? ST.erefs[i].split('/').pop() : '', thumb: ST.erefs[i] ? h('img', { src: thumbUrl(ST.erefs[i], 256), alt: '' }) : null,
    pick: () => openImagePicker({ title: `Picture ${i + 2}`, onPick: (name) => { ST.erefs[i] = name; redo(); } }),
    onClear: () => { ST.erefs.splice(i, 1); redo(); } });
  return [
    field('Prompt', textArea(() => ST.eprompt, (v) => { ST.eprompt = v; save(); }, { rows: 4, label: 'What to change', placeholder: 'Make the jacket red leather' }),
      help('Say what to change, plainly. The picture being edited is Picture 1 and your references are Picture 2 onward, so you can write: give the person in Picture 1 the coat from Picture 2. {layer} becomes each layer\'s name, and {red|blue|green} picks one afresh for each run, so one prompt can differ across a batch.')),
    field('Also know', textArea(() => ST.econtext, (v) => { ST.econtext = v; save(); }, { rows: 2, label: 'More context for the model', placeholder: 'A film still, 1970s, shot on 35mm' }),
      help('Anything else the model should know: what the picture is, its style, what must not change. It goes after the prompt, on every run.')),
    toggle('Keep the rest', ST.ekeep, (v) => { ST.ekeep = v; redo(); }, { help: 'Adds a sentence telling the model to change only what you asked and to keep the framing, pose, details and background. Turn it off for a change to the whole picture, like a new style.' }),
    ...ST.erefs.slice(0, refsMost).map((_, i) => ref(i)),
    ST.erefs.length < refsMost ? ref(ST.erefs.length) : null,
    field('Change', seg([['all', 'Anywhere'], ['words', 'What I name'], ['painted', 'The red mask']], ST.ewhere, (v) => { ST.ewhere = v; redo(); }),
      help('Anywhere lands what the model made, as it made it. What I name has SAM3 find the area in each picture. The red mask uses what you painted (Masks panel), cut to each selected layer; a layer it doesn\'t touch is left out. With an area only that area changes, and the rest stays pixel for pixel at full size. SAM3 misses some words: it found no "jacket" on a man in one, but found "man" and "person".')),
    ST.ewhere === 'words' ? field('Find', textArea(() => ST.efind, (v) => { ST.efind = v; save(); }, { rows: 2, label: 'What to find', placeholder: 'The jacket, the sky' })) : null,
    ...(ST.ewhere === 'words' ? samFields(eng) : []),
    ST.ewhere === 'painted' && !eng.paint.maskLayer(false) ? hint('Paint the area first (Masks panel)') : null,
    ST.ewhere !== 'all' ? toggle('Close-up', ST.eclose, (v) => { ST.eclose = v; redo(); }, { help: 'The model sees a box round the area at its full size: more detail in a small area. Off, it sees the whole picture: better when the change must match what is far from it.' }) : null,
    ST.ewhere !== 'all' ? rangeField('Grow the area', () => ST.egrow, (v) => { ST.egrow = v; save(); }, { min: 0, max: 64, step: 1, fmt: (v) => `${v} px` }) : null,
    ST.ewhere !== 'all' ? rangeField('Edge softness', () => ST.esoft, (v) => { ST.esoft = v; save(); }, { min: 0, max: 64, step: 1, fmt: (v) => `${v} px` }) : null,
    field(['Size', sw ? h('span', {}, `${sw}×${sh}`) : null], seg([[1, '1 MP'], [1.5, '1.5 MP'], [2, '2 MP'], [3, '3 MP']], ST.emp, (v) => { ST.emp = v; redo(); }),
      help('What the model works at, whatever the picture\'s size: a smaller picture is scaled up to it, a bigger one down. More keeps more detail, takes longer and needs more memory.')),
    field('Variations', seg([[1, '1'], [2, '2'], [3, '3'], [4, '4']], ST.ecount, (v) => { ST.ecount = v; redo(); }),
      help('How many results for each picture, each with its own seed and its own layer. They land side by side, the first in the original\'s place. On a canvas of a fixed size they land on top of each other, as the rest would be cut off.')),
    seedField('Seed', { get: () => ST.eseed, set: (v) => { ST.eseed = v; save(); }, mode: () => ST.eseedMode, setMode: (m) => { ST.eseedMode = m; redo(); } }),
    rangeField('Steps', () => ST.esteps, (v) => { ST.esteps = Math.round(v); save(); }, { min: 2, max: 20, step: 1, fmt: (v) => String(Math.round(v)),
      help: 'The turbo model is tuned for 8. 4 is quicker and still holds up; more than 8 gives little.' }),
    rangeField('Guidance', () => ST.ecfg, (v) => { ST.ecfg = v; save(); }, { min: 1, max: 5, step: 0.1, fmt: (v) => v.toFixed(1), onChange: () => eng.render(),
      help: 'How hard the model follows the prompt. At 1 it can stop short: asked for red leather, a denim jacket came back red denim, and at 2.5 it came back leather. Above 1 each run takes about twice as long, and the Avoid box is used.' }),
    ST.ecfg > 1 ? field('Avoid', textArea(() => ST.eneg, (v) => { ST.eneg = v; save(); }, { rows: 2, label: 'What to avoid', placeholder: 'Blurry, extra fingers' })) : null,
    lf ? field(['LoRAs', h('span', {}, `${usableLoras(ST.eloras, installed).length} on`)],
      help('LoRAs change what an edit can do and how it looks. They run in the order listed, on every run. Your Qwen folder comes first, and search finds the others, which are for other models and rarely work here. Some need a trigger word: put it in the prompt. Untick one to compare the same seed without it (Seed: Fixed).'),
      ...ST.eloras.map((l, i) => h('div', { class: `lora-row${l.enabled === false ? ' off' : ''}` },
        h('div', { class: 'top' }, h('input', { type: 'checkbox', checked: l.enabled !== false, title: 'Enabled', 'aria-label': 'LoRA on', onchange: (e) => { l.enabled = e.target.checked; redo(); } }), loraPicker({ options: installed.filter((n) => /^qwen\//i.test(n)), others: installed.filter((n) => !/^qwen\//i.test(n)), value: l.name, empty: '— choose LoRA —', label: (n) => n.replace(/^qwen\//i, ''), aria: 'LoRA',
          onPick: (name) => { ST.eloras[i].name = name; redo(); } }),
        button('✕', () => { ST.eloras.splice(i, 1); redo(); }, { cls: 'small', title: 'Remove LoRA' })),
        l.name && !installed.includes(l.name) ? hint('Not installed: left out of the run') : null,
        rangeField('Strength', () => l.strength, (v) => { l.strength = v; save(); }, { min: -1, max: 2, step: 0.05 }))),
      button('+ Add LoRA', () => { ST.eloras.push({ name: '', strength: 1, enabled: true }); redo(); }, { cls: 'small add-btn' })) : null,
  ];
}

// Skin detail on one picture: a pass per named part, each on the last one's result, in the background so the next layer can go in the line.
// One new layer comes of it: the passes before the last are only a means, so their runs and pictures go.
function skinParts(eng, o, t, tab, src, values, imageField) {
  const parts = partsOf(ST.skinParts), what = t.fields.find((f) => f.input === 'text_prompt'), size = t.fields.find((f) => f.input === 'base_resolution');
  const pf = t.fields.find((x) => x.kind === 'text' && /prompt/i.test(x.group) && !/negative/i.test(x.group));
  if (!what || !pf) throw new Error(`${t.id} has no box for the body part`);
  const who = src.layer ? ` on ${src.layer.label || src.layer.name.split('/').pop()}` : '', mark = {};
  const pass = (name, part) => sent({ template: t.id, values: { ...values, [imageField.key]: name, [what.key]: part, [pf.key]: partPrompt(values[pf.key], part), ...(size && { [size.key]: partSize(src.px) }) }, batch: 1 });
  toast(`${o.label}${who}: ${parts.join(', ')}. It lands as a new layer`);
  FLIGHT.add(mark); eng.render();
  (async () => {
    let name = src.name;
    try {
      for (const part of parts.slice(0, -1)) {
        const done = await pass(name, part);
        const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
        await dropRun(done.id);
        if (name !== src.name) await dropInput(name);
        name = r.name;
      }
      const done = await pass(name, parts[parts.length - 1]);
      if (eng.E.tab?.id !== tab) return toast(`${o.label} #${done.id} finished on another edit: it is in History`);
      await land(eng, o, src, done);
    } catch (e) { toast(`${o.label} failed${who}: ${e.message}`, true); } finally {
      if (name !== src.name) await dropInput(name);
      FLIGHT.delete(mark); eng.render();
    }
  })();
}

async function runOne(eng, o, t, tab, src) {
  if (o.kind === 'edit') return editOne(eng, o, t, tab, src);
  if (o.kind === 'sheet') return runSheet(eng, o, t, tab, src);
  if (o.kind === 'remove') return markFound(eng, o, src);
  if (o.kind === 'swap') return swapOnSource(eng, o, tab, src);
  if (o.kind === 'colorise') return colourise(eng, o, t, tab, src);
  if (o.kind === 'restore') return restorePhoto(eng, o, tab, src);
  const imageField = t.fields.find((f) => f.kind === 'image');
  const values = { [imageField.key]: src.name, ...valuesByRole(t, { seed: -1, ...(o.prompt && { prompt: ST.prompt.trim() }) }), ...samKnobs(t) };
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
      set('denoise', ST.dstrength[dmKey()] ?? m.strength);
      const pf = t.fields.find((x) => x.kind === 'text' && /prompt/i.test(x.group) && !/negative/i.test(x.group));
      if (pf) values[pf.key] = (ST.dprompt[dmKey()] ?? m.prompt).trim() || m.prompt;
    }
  }
  if (o.model === 'skin') return skinParts(eng, o, t, tab, src, values, imageField);
  const [g] = await queueRun({ template: t.id, values, batch: 1 });
  toast(`${o.label} (#${g.id}): it lands as a new layer`);
  follow(eng, o, tab, src, g);
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
  if (step === 'cut') Object.assign(values, valuesByRole(t, { confidence: ST.samSure }));
  const once = async () => waitGen((await queueRun({ template: id, values, batch: 1 }))[0].id);
  // SAM3's worker now and then fails a run ("Inference tensors do not track version counter") that works when sent again
  const done = step === 'cut' ? await once().catch(once) : await once();
  if (step === 'cut') {
    // (several can be going at once: fine edges hold a whole picture in memory, so one at a time)
    const fine = ST.fine ? edgeTurn.then(() => finerMatte(t, name, done, what.trim() || 'person')) : null;
    if (fine) edgeTurn = fine.catch(() => {});
    const cut = await cutOut(name, await (fine || matteOf(done)));
    return (await uploadImage(await pngBlob(cut), { mp: 0, source: 'editor', filename: 'cutout.png', multiple: 1, board: 'Sheet view' })).name;
  }
  return (await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } })).name;
}

// Shift+Enter: the tool open in this panel, as its Run button
export const runImageTool = (eng) => (eng.E.layers.some((l) => !l.mask && !l.draft) ? run(eng) : toast('Add a picture first', true));

export function imageToolsSection(eng) {
  const E = eng.E;
  if (!E.layers.some((l) => !l.mask && !l.draft)) return null;
  const o = op(), t = template(tplId(o)), picked = ST.scope === 'selected' ? targets(eng) : [], many = picked.length;
  const onLayers = ST.scope === 'selected' && many > 0;
  const frame = ST.scope === 'whole' ? eng.frame() : null;
  const size = many === 1 ? (eng.ready(picked[0]) ? G.sentPixels(picked[0]) : null) : frame ? [frame.w, frame.h] : null;   // (what's sent: a layer's own pixels, whatever its scale; the whole picture's canvas size)
  const select = h('select', { 'aria-label': 'Image tool', onchange: (ev) => { ST.op = ev.target.value; save(); eng.render(); } },
    ...GROUPS.map((g) => h('optgroup', { label: g }, ...OPS.filter((x) => x.group === g).map((x) => h('option', { value: x.id, selected: x.id === o.id }, x.label)))));
  const out = size && o.kind === 'up' ? `${Math.round(size[0] * ST.scale)}×${Math.round(size[1] * ST.scale)}` : null;
  const on = many > 1 ? `Runs on each of the ${many} selected layers, one after the other.`
    : many ? `Runs on the layer ${picked[0].label || picked[0].name.split('/').pop()}.` : ST.scope === 'whole' ? 'Runs on the whole picture.' : '';
  const quick = h('div', { class: 'tool-quick' }, ...QUICK.filter(([, , ids]) => ids.some((id) => OPS.some((x) => x.id === id))).map(([label, ic, ids]) => {
    const here = ids.includes(o.id);
    return h('button', { type: 'button', class: `icon-btn tool-quick-btn${here ? ' on' : ''}`, title: label, 'aria-pressed': String(here),
      onclick: () => { if (here) return; ST.op = ids[0]; save(); eng.render(); } }, icon(ic), h('span', {}, label));
  }));
  return section('Image tools', null,
    quick, select, help(`${o.help} ${on} Shift+Enter runs this tool.`.trim()),
    !t ? hint(`${tplId(o)} isn't installed yet`) : null,
    field('Run on', seg([['whole', 'Whole picture'], ['selected', 'Selected layers']], ST.scope, (v) => { ST.scope = v; save(); eng.render(); }),
      help('Whole picture sends every visible layer together. Selected layers runs on each selected layer alone, one run each, with the result over that layer. A cropped layer sends its kept part. A turned or mirrored layer is sent unturned, and its result takes the same turn. A masked layer is sent whole: an Upscale, Detail or De-light result gets a copy of its mask, and other tools\' results get none. Remove from the red mask cuts the mask to each selected layer, and leaves out a layer it doesn\'t touch.')),
    ST.scope === 'selected' && !many ? hint('Select a layer first') : null,
    ...(o.kind === 'edit' && t ? editFields(eng, t, size) : []),
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
    o.kind === 'matte' ? field('Result', seg([['cutout', 'Cut-out layer'], ['black', 'On black'], ['mask', 'Mask']], ST.result, (v) => { ST.result = v; save(); eng.render(); }),
      help('On black puts the cut-out on solid black: the picture a one-photo 3D model (Idol, a splat) wants.')) : null,
    ...(o.id === 'words' || (o.kind === 'remove' && ST.rfrom === 'words') || (o.kind === 'swap' && ST.swapWhere === 'find') ? samFields(eng) : []),
    ...(o.kind === 'sheet' ? samFields(eng, false) : []),
    o.kind === 'matte' ? toggle('Fine edges', ST.fine, (v) => { ST.fine = v; save(); eng.render(); },
      { help: 'These models see any picture at about 1000 px, so a big picture\'s edge comes back as a staircase. On: each thing found gets a second look on a crop close to it (a run for each, on a big picture), then the pixels along its edge are decided by their colour: is it more common on the thing, or beside it. Off: quicker, and the edge is as the model gave it.' }) : null,
    o.kind === 'remove' ? field('What goes', seg([['words', 'Find by name'], ['painted', 'The red mask']], ST.rfrom, (v) => { ST.rfrom = v; save(); eng.render(); })) : null,
    o.kind === 'remove' && ST.rfrom === 'words' ? h('div', { class: 'chips' }, ...LOOK_FOR.map(([v, label]) => chip(label, () => { ST.rprompt = v; save(); eng.render(); }, { on: ST.rprompt.trim().toLowerCase() === v }))) : null,
    o.kind === 'remove' && ST.rfrom === 'words' ? field('Find', textArea(() => ST.rprompt, (v) => { ST.rprompt = v; save(); }, { rows: 2, label: 'What to remove', placeholder: 'Watermark, text, the red sign' })) : null,
    o.kind === 'remove' && ST.rfrom === 'painted' && !eng.paint.maskLayer(false) ? hint('Paint what to remove first (Masks panel), or find it by name') : null,
    o.kind === 'swap' ? field('Swap', seg(Object.entries(SWAP_PARTS).map(([k, v]) => [k, v.label]), ST.swapPart, (v) => { ST.swapPart = v; save(); eng.render(); }, { wrap: true }),
      help(SWAP_PARTS[ST.swapPart].help)) : null,
    o.kind === 'swap' ? imageInput({ label: 'Take it from', name: ST.swapFrom ? ST.swapFrom.split('/').pop() : '', thumb: ST.swapFrom ? h('img', { src: thumbUrl(ST.swapFrom, 256), alt: '' }) : null,
      pick: () => openImagePicker({ title: 'The picture to take it from', onPick: (name) => { ST.swapFrom = name; save(); eng.render(); } }),
      onClear: () => { ST.swapFrom = ''; save(); eng.render(); } }) : null,
    o.kind === 'swap' ? field(['Models', h('span', {}, `${swapModels().length} ticked`)], h('div', { class: 'chips' }, ...Object.entries(SWAP_MODELS).filter(([k]) => canSwap(k)).map(([k, v]) =>
      chip(v.label, () => { ST.swapModels = ST.swapModels.includes(k) ? ST.swapModels.filter((x) => x !== k) : [...ST.swapModels, k]; save(); eng.render(); }, { on: ST.swapModels.includes(k) }))),
      help(Object.values(SWAP_MODELS).map((v) => `${v.label}: ${v.help}`).join(' '))) : null,
    o.kind === 'swap' ? field('Where', seg([['find', 'Find it'], ['painted', 'The red mask']], ST.swapWhere, (v) => { ST.swapWhere = v; save(); eng.render(); }),
      help('Find it uses SAM3 and takes the biggest one it finds. With several people, Mark it first, erase what shouldn\'t change in the Masks panel, and Swap from the red mask.')) : null,
    o.kind === 'swap' && ST.swapWhere === 'painted' && !eng.paint.maskLayer(false) ? hint('Paint the area first (Masks panel), or Mark it') : null,
    o.kind === 'swap' ? field('Also say', textArea(() => ST.swapExtra, (v) => { ST.swapExtra = v; save(); }, { rows: 2, label: 'Words added to the prompt', placeholder: 'Keep the glasses' })) : null,
    o.kind === 'clean' ? field('Take out', seg(Object.entries(CLEAN).map(([k, v]) => [k, v.label]), ST.cmodel, (v) => { ST.cmodel = v; save(); eng.render(); }, { wrap: true }),
      help((CLEAN[ST.cmodel] || CLEAN.noise).help)) : null,
    o.kind === 'sheet' ? field('Result', seg([['cutout', 'Cut out'], ['black', 'On black']], ST.result === 'black' ? 'black' : 'cutout', (v) => { ST.result = v; save(); eng.render(); })) : null,
    o.kind === 'restore' ? toggle('Scratches and dust', ST.stepScratch, (v) => { ST.stepScratch = v; save(); eng.render(); }) : null,
    o.kind === 'restore' && ST.stepScratch ? field('Take', seg([['light', 'Only clear ones'], ['normal', 'Normal'], ['strong', 'Faint ones too']], ST.scratchAmount, (v) => { ST.scratchAmount = v; save(); eng.render(); }),
      help('How much a mark must stand out to count. Faint ones too also takes more of what is really in the picture: thin lines, wires, hair. Faces are left out of this step.')) : null,
    o.kind === 'restore' ? toggle('Clean', ST.stepClean, (v) => { ST.stepClean = v; save(); eng.render(); }) : null,
    o.kind === 'restore' && ST.stepClean ? field('Take out', seg(Object.entries(CLEAN).map(([k, v]) => [k, v.label]), ST.cmodel, (v) => { ST.cmodel = v; save(); eng.render(); }, { wrap: true }),
      help((CLEAN[ST.cmodel] || CLEAN.noise).help)) : null,
    o.kind === 'restore' ? toggle('Faces', ST.stepFaces, (v) => { ST.stepFaces = v; save(); eng.render(); },
      { help: 'GFPGAN redraws each face at 512 px, so it helps a small or damaged face most; on a face much bigger than that, lower Face strength to keep its sharpness. It can change a likeness: compare with the original. A strongly tilted face comes out worse. Licence: GFPGAN is Apache 2.0, but its licence file lists NVIDIA StyleGAN2 and DFDNet terms that limit parts of it to non-commercial use.' }) : null,
    o.kind === 'restore' && ST.stepFaces ? rangeField('Face strength', () => ST.faceAmount, (v) => { ST.faceAmount = v; save(); }, { min: 0.1, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` }) : null,
    o.kind === 'restore' ? toggle('Add colour', ST.stepColour, (v) => { ST.stepColour = v; save(); eng.render(); }) : null,
    o.kind === 'colorise' || (o.kind === 'restore' && ST.stepColour) ? field('Model', seg(Object.entries(DELIGHT).map(([k, v]) => [k, v.label]), ST.lmodel, (v) => { ST.lmodel = v; save(); eng.render(); }, { wrap: true }),
      help((DELIGHT[ST.lmodel] || DELIGHT.krea2).help)) : null,
    o.kind === 'colorise' || (o.kind === 'restore' && ST.stepColour) ? field('Prompt', textArea(() => ST.cprompt, (v) => { ST.cprompt = v; save(); }, { rows: 4, label: 'What colours to use' })) : null,
    o.kind === 'delight' ? field('Model', seg(Object.entries(DELIGHT).map(([k, v]) => [k, v.label]), ST.lmodel, (v) => { ST.lmodel = v; save(); eng.render(); }, { wrap: true }),
      help((DELIGHT[ST.lmodel] || DELIGHT.krea2).help)) : null,
    o.kind === 'delight' ? field('Prompt', textArea(() => ST[o.promptKey || 'lprompt'], (v) => { ST[o.promptKey || 'lprompt'] = v; save(); }, { rows: 4, label: o.promptKey ? 'What to remove' : 'How to light it' })) : null,
    o.kind === 'detail' && !o.model ? field('Model', seg(Object.entries(DETAIL).filter(([k]) => canDetail(k)).map(([k, v]) => [k, v.label]), ST.dmodel, (v) => { ST.dmodel = v; save(); eng.render(); }, { wrap: true })) : null,
    o.id === 'skin' ? field('Area', seg([['whole', 'Whole picture'], ['parts', 'Body parts']], ST.skinWhere, (v) => { ST.skinWhere = v; save(); eng.render(); })) : null,
    o.model === 'skin' ? field('Body parts', textArea(() => ST.skinParts, (v) => { ST.skinParts = v; save(); }, { rows: 2, label: 'Body parts, separated by commas' })) : null,
    o.kind === 'detail' ? help(dm().help) : null,
    o.kind === 'detail' && !dm().plain ? field('Strength', h('input', { type: 'range', min: 0.1, max: 0.7, step: 0.05, 'aria-label': 'Strength',
      value: ST.dstrength[dmKey()] ?? dm().strength, oninput: (e) => { ST.dstrength[dmKey()] = +e.target.value; save(); e.target.nextSibling.textContent = e.target.value; } }),
      h('span', {}, String(ST.dstrength[dmKey()] ?? dm().strength))) : null,
    o.kind === 'detail' && !dm().plain ? field('Prompt', textArea(() => ST.dprompt[dmKey()] ?? dm().prompt, (v) => { ST.dprompt[dmKey()] = v; save(); }, { rows: 2, label: 'What to add' })) : null,
    o.kind === 'up' ? field(['Enlarge', out ? h('span', {}, out) : null], seg([[2, '2×'], [3, '3×'], [4, '4×']], ST.scale, (v) => { ST.scale = v; save(); eng.render(); })) : null,
    (KEEPS_FRAMING.has(o.kind) || o.kind === 'sheet' || (o.kind === 'matte' && ST.result !== 'mask')) && onLayers && !(o.kind === 'edit' && ST.ewhere === 'painted' && ST.scope !== 'selected')
      ? toggle('Hide the original', ST.hide, (v) => { ST.hide = v; save(); }) : null,
    h('div', { class: 'row wrap' }, o.kind === 'swap' ? button('Mark it', () => swapMark(eng), { disabled: !t }) : null,
      o.kind === 'swap' ? button('Send to Generate', () => swapSend(eng), { disabled: !t }) : null,
      o.kind === 'swap' ? help('Send to Generate opens a tab per ticked model with the close-up, the reference, the prompt, the size and the LoRA set, to change and run there. What it makes there stays as made: it isn\'t put back on the whole picture.') : null,
      button(o.kind === 'swap' ? 'Swap' : o.kind === 'remove' ? (ST.rfrom === 'words' ? 'Find and mark' : 'Remove') : FLIGHT.size ? 'Run again' : 'Run', () => run(eng), { cls: 'primary', disabled: !t, title: 'Shift+Enter' })));
}
