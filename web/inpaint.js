import { h, api, store, toast, busy, button, runBar, section, field, seg, hint, help, toggle, textArea, rangeField, propNum, openSheet, closeSheet, actions } from './ui.js';
import { ASPECT_PRESETS, S } from './core.js';
import { pngBlob, uploadImage, openImagePicker } from './media.js';
import { pictureSlot } from './picture-drop.js';
import { queueRun, roleField, valuesByRole, waitGen } from './make.js';
import { maskAsSent, maskForResult, placed } from './layer-result.js';
import { eachOne, failureText } from './tool-batch.js';
import { icon } from './icons.js';
import { MASK_DEFAULT } from './maskpaint.js';
import { SPREAD_MAX, spreadLabel } from './mask-spread.js';
import { alphaAsGrey } from './matte-edge.js';
import * as G from './layer-geom.js';

// ---------------------------------------------------------------------------
// Inpaint and Extend, in the Editor panel. The area to redraw is the mask layer (red, painted with a brush or
// added from a rectangle / lasso selection, see paint.js maskLayer) kept out of the picture. Fill sends the picture
// (every layer but the mask) and the mask to an inpaint template (the masked-edit path of app/maskcomp.py, so the
// rest of the picture comes back pixel for pixel) and the result lands as a new layer on top, the frame's size.
// Extend grows the canvas on any side and marks the new part (and a little of the old edge, to blend) as the mask.
// ---------------------------------------------------------------------------
const KEY = 'deck.inpaint';
// (fit on: the Inpaint panel is for redrawing a small area, best at the model's full size)
const ST = { prompt: '', tpl: null, denoise: 0.9, ...MASK_DEFAULT, fit: true, steps: 0, scope: 'whole', ...store.get(KEY, {}) };
const save = () => store.set(KEY, ST);
const FLIGHT = new Set();   // runs on their way back
const OVERLAP = 0.04;       // Extend: how much of the old edge joins the mask, a share of the canvas's longer side

const PREFER = ['deck-klein3-inpaint', 'deck-klein9b-inpaint', 'deck-krea2-inpaint', 'deck-qwen21-inpaint'];   // (the first one installed is the default; Klein draws the best extensions)
// (one that takes a prompt: LaMa only fills from what is round the mask, whatever is asked for, so it isn't a model to pick here. Image tools, Remove, is its place)
const inpaintTemplates = () => S.templates.filter((t) => !t.error && t.fields.some((f) => f.kind === 'mask' && f.required) && !!roleField(t, 'prompt'))
  .sort((a, b) => (PREFER.indexOf(a.id) + 1 || 99) - (PREFER.indexOf(b.id) + 1 || 99));
const stepsField = (t) => t?.fields.find((f) => f.kind === 'int' && f.input === 'steps') || null;   // (turbo sigma lists have none)

export async function uploadMask(cv) {
  const r = await fetch('/api/inputs/mask', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await pngBlob(cv) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  return (await r.json()).name;
}

// the template's Size (the edit models' pseudo width / height) for a frame, about mp megapixels at its shape
function sizeValues(t, w, hh, mp) {
  const fw = t.fields.find((f) => f.key === '__deck.width'), fh = t.fields.find((f) => f.key === '__deck.height');
  if (!fw || !fh) return {};
  const step = fw.step || 16, k = Math.sqrt((mp * 1e6) / (w * hh));
  const fit = (f, v) => Math.min(f.max ?? 4096, Math.max(f.min ?? 256, Math.round(v / step) * step));
  // the width a step either side of the plain one that keeps the frame's shape best (the result is laid back over the frame)
  const base = fit(fw, w * k);
  let best = null;
  for (const cw of [base - step, base, base + step]) {
    const ch = fit(fh, (cw * hh) / w), err = Math.abs(cw / ch - w / hh);
    if (cw >= (fw.min ?? 256) && (!best || err < best.err)) best = { cw, ch, err };
  }
  return { [fw.key]: best.cw, [fh.key]: best.ch };
}

// Under the mask the picture is blank (Extend leaves the canvas colour, often white) and the model copies it: mostly white,
// with borders. Redrawing from scratch, replace it with a heavy blur of the nearby picture (blurs at three radii, the
// widest underneath; a blur of a see-through picture averages only what is there) so nothing is there to copy.
function smearUnderMask(pic, mask) {
  const w = pic.width, hh = pic.height, k = 1 / 8, sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(hh * k));
  const keep = document.createElement('canvas');
  keep.width = w; keep.height = hh;
  const kc = keep.getContext('2d');
  kc.drawImage(pic, 0, 0);
  const d = kc.getImageData(0, 0, w, hh), md = mask.getContext('2d').getImageData(0, 0, w, hh).data;
  for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = md[i] > 127 ? 0 : 255;
  kc.putImageData(d, 0, 0);
  const sm = document.createElement('canvas');
  sm.width = sw; sm.height = sh;
  const sc = sm.getContext('2d');
  for (const r of [0.34, 0.12, 0.04]) {
    const t = document.createElement('canvas');
    t.width = sw; t.height = sh;
    const tc = t.getContext('2d');
    tc.filter = `blur(${Math.max(1, Math.round(sw * r))}px)`;
    tc.drawImage(keep, 0, 0, sw, sh);
    sc.drawImage(t, 0, 0);
  }
  const c = pic.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.clearRect(0, 0, w, hh);
  c.drawImage(sm, 0, 0, w, hh);
  // over the blur, the kept picture mirrored about its own edges (the model continues real shapes, not a blur)
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (md[(y * w + x) * 4] <= 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 > x0 && y1 > y0 && (x0 > 0 || y0 > 0 || x1 < w - 1 || y1 < hh - 1)) {
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    for (let ix = -1; ix <= 1; ix++) for (let iy = -1; iy <= 1; iy++) {
      if (!ix && !iy) continue;
      c.save();
      c.translate(x0 + ix * bw + (ix ? bw : 0), y0 + iy * bh + (iy ? bh : 0));   // (a flipped tile is drawn back from its far edge)
      c.scale(ix ? -1 : 1, iy ? -1 : 1);
      c.drawImage(keep, x0, y0, bw, bh, 0, 0, bw, bh);
      c.restore();
    }
  }
  c.drawImage(keep, 0, 0);
}

// the item boxes worth sending (a click that drew nothing is not one)
const usableItems = (eng) => eng.E.items.filter((i) => i.w >= 8 && i.h >= 8);
// the painted mask with the item boxes added (white = change), the frame's size
function maskWithItems(f, m, items) {
  const cv = document.createElement('canvas');
  cv.width = f.w; cv.height = f.h;
  const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, f.w, f.h);
  if (m) c.drawImage(m.canvas, 0, 0);
  c.fillStyle = '#fff';
  for (const it of items) c.fillRect(it.x - f.x, it.y - f.y, it.w, it.h);
  return { canvas: cv, box: { x: 0, y: 0, w: 1, h: 1 } };
}

// The part of a painted mask (eng.composeMask, the frame's size) that falls on a layer, at the pixels the layer is sent at: its kept part, unturned.
// { canvas, box } as composeMask gives them, or null if no ink falls on it.
export function layerMask(m, f, l) {
  const [w, h] = G.sentPixels(l), cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  c.imageSmoothingQuality = 'high';
  c.setTransform(...G.invert(G.sentToFrame(l, f, [w, h])));
  c.drawImage(m.canvas, 0, 0);
  c.setTransform(1, 0, 0, 1, 0, 0);
  const p = c.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (p[(y * w + x) * 4] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { canvas: cv, box: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h } };
}
// what's sent of a layer: its kept part at its own pixels, with its Colour adjustments (what you see)
function layerPic(eng, l) {
  const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, c = l.crop, cv = document.createElement('canvas');
  [cv.width, cv.height] = G.sentPixels(l);
  const pic = eng.layerPicture(l), k = (pic.naturalWidth || pic.width) / W;
  cv.getContext('2d').drawImage(pic, c.x * W * k, c.y * H * k, c.w * W * k, c.h * H * k, 0, 0, cv.width, cv.height);
  return cv;
}

// One Fill: a picture and its mask, the same size. Its result lands as a draft where place(the result) says.
async function queueFill(eng, t, tab, { pic, m, denoise, items, f, place }) {
  if (denoise >= 0.95) smearUnderMask(pic, m.canvas);
  const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'inpaint.png', multiple: 1 }   /* (kept the mask's size: a trimmed edge would shift it) */);
  const maskName = await uploadMask(m.canvas);
  const mf = t.fields.find((x) => x.kind === 'mask'), main = t.fields.find((x) => x.key === mf.image_key);
  const dn = t.fields.find((x) => x.kind === 'float' && /denoise/i.test(`${x.input} ${x.label} ${x.group}`));
  const fitOn = ST.fit && !items.length;   // (an item's place is a share of the whole picture the model sees)
  const prompt = ST.prompt.trim() || (items.length ? `Add ${items.map((_, i) => `<obj_${i + 1}>`).join(', ')} to the picture at the boxed places, matching its light, colours and grain` : '');
  const values = { [main.key]: up.name, ...valuesByRole(t, { prompt, seed: -1 }), ...sizeValues(t, pic.width, pic.height, fitOn ? 1 : Math.min(2, pic.width * pic.height / 1e6)) };
  const bf = t.fields.find((x) => x.kind === 'boxes');
  if (items.length && bf) values[bf.key] = items.map((it) => ({ x: (it.x - f.x) / f.w, y: (it.y - f.y) / f.h, w: it.w / f.w, h: it.h / f.h, type: 'obj', desc: it.desc.trim(), ...(it.ref ? { ref: it.ref } : {}) }));
  if (dn) values[dn.key] = denoise;
  const sf = stepsField(t);
  if (sf && ST.steps) values[sf.key] = ST.steps;
  values[mf.key] = { feather: ST.feather, grow: 0, fit: fitOn, name: maskName, box: m.box, src: up.name, crop: null };
  const [g] = await queueRun({ template: t.id, values, batch: 1 });
  toast(`Redrawing (#${g.id}): it lands as a new layer`);
  FLIGHT.add(g.id); eng.render();
  waitGen(g.id).then(async (done) => {
    const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
    if (eng.E.tab?.id !== tab) return toast(`Inpaint #${done.id} finished on another edit: it is in History`);
    eng.addImage(r.name, { label: `Inpaint #${done.id}`, draft: true, ...(await place(r)) });
    eng.render();
    toast('Inpaint done: a draft on top, not sent with the next Fill. Keep it to make it a layer');
  }).catch((e) => toast(`Inpaint failed: ${e.message}`, true)).finally(() => { FLIGHT.delete(g.id); eng.render(); });
}

// Fill on each selected layer alone: the one painted mask is cut to each, and a layer it doesn't touch is left out
async function fillLayers(eng, t, tab, denoise) {
  const list = (eng.picked?.() || []).filter((l) => !l.mask && !l.maskOf && !l.draft && !l.broken && l.name && eng.ready(l));
  if (!list.length) return toast('Select a picture layer first', true);
  const f = eng.frame(), whole = eng.composeMask();
  if (!f || !whole) return toast('Mark the area to redraw first', true);
  const jobs = list.map((l) => [l, layerMask(whole, f, l)]).filter(([, m]) => m);
  if (!jobs.length) return toast('The mask doesn\'t touch a selected layer', true);
  if (jobs.length < list.length) toast(`The mask misses ${list.length - jobs.length} of the selected layers: they stay as they are`);
  const { failed } = await eachOne(jobs, async ([l, m]) => {
    const src = { rect: eng.layerRect(l), was: { ...l }, mask: maskAsSent(eng, l) };   // (as sent: a layer changed during the run doesn't move its result)
    await queueFill(eng, t, tab, { pic: layerPic(eng, l), m, denoise, items: [], f,
      place: async (r) => ({ ...placed(src, src.rect.x, src.rect.y, src.rect.w, r), ...(await maskForResult(src, r)) }) });
  });
  if (failed.length) toast(failureText('Inpaint', failed, ([l]) => l.label || l.name.split('/').pop()), true);
}

// Ctrl+Enter in this panel: as its Fill button
export const runFill = (eng) => fill(eng);

async function fill(eng, { denoise = ST.denoise } = {}) {
  const items = usableItems(eng);
  // items go to Klein 3: its layout boxes place each one, and a picture can be matched
  const t = items.length ? S.templates.find((x) => x.id === 'deck-klein3-inpaint' && !x.error)
    : S.templates.find((x) => x.id === ST.tpl && !x.error) || inpaintTemplates()[0];
  if (!t) return toast(items.length ? 'Add item needs the Flux 3 Klein inpaint template' : 'No inpaint template is installed', true);
  if (!items.length && !eng.composeMask()) return toast('Mark the area to redraw first: paint the mask, or select and Add to mask', true);
  if (eng.loading()) return toast('The images are still loading', true);
  if (eng.E.grow) return toast('Press Extend or Cancel on the crop first', true);
  if (ST.scope === 'selected' && items.length) return toast('Add item works on the whole picture: set Run on to Whole picture', true);
  const tab = eng.E.tab?.id, b = busy('Sending the picture…');
  try {
    await eng.paint.savePaint();
    if (ST.scope === 'selected') return await fillLayers(eng, t, tab, denoise);
    // (after the save: it can change the frame, and the mask and the picture must be the same size or they do not line up)
    const f = eng.frame(), m = items.length ? maskWithItems(eng.frame(), eng.composeMask(), items) : eng.composeMask();
    if (!f || !m) return toast('Mark the area to redraw first', true);
    const pic = document.createElement('canvas');
    if (!eng.compose(pic)) return toast('Add a picture first', true);
    if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
    await queueFill(eng, t, tab, { pic, m, denoise, items, f, place: (r) => ({ x: f.x, y: f.y, scale: f.w / r.width }) });
  } catch (e) { toast(e.message, true); } finally { b.done(); }
}

// the solid part of each selected layer (what its see-through and its own mask leave showing) joins the mask
function addLayerShape(eng) {
  const list = (eng.picked?.() || []).filter((l) => !l.mask && !l.maskOf && !l.draft && eng.ready(l));
  if (!list.length) return toast('Select a picture layer first', true);
  let added = 0;
  for (const l of list) {
    const W = l.img.naturalWidth || l.img.width, H = l.img.naturalHeight || l.img.height, k = l.crop, cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(k.w * W)); cv.height = Math.max(1, Math.round(k.h * H));
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(l.img, k.x * W, k.y * H, k.w * W, k.h * H, 0, 0, cv.width, cv.height);
    const m = l.maskOff || l.maskFor === 'adjust' ? null : eng.E.layers.find((x) => x.maskOf === l.key && eng.ready(x));
    if (m) {
      const mw = m.img.naturalWidth || m.img.width, mh = m.img.naturalHeight || m.img.height;
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(m.img, k.x * mw, k.y * mh, k.w * mw, k.h * mh, 0, 0, cv.width, cv.height);
      c.globalCompositeOperation = 'source-over';
    }
    const d = c.getImageData(0, 0, cv.width, cv.height);
    if (!d.data.some((v, i) => i % 4 === 3 && v > 127)) continue;   // (nothing solid in it)
    alphaAsGrey(d.data);
    c.putImageData(d, 0, 0);
    if (eng.paint.maskFromMatte(cv, eng.layerRect(l), G.turn(l))) added++;
  }
  toast(added ? `Added ${added > 1 ? `${added} layers' shapes` : 'the layer\'s shape'} to the mask` : 'That layer has nothing solid to add', !added);
}

// the selected layers cut out by the mask
function cutOutLayers(eng) {
  const list = (eng.picked?.() || []).filter((l) => !l.mask && !l.maskOf && !l.draft && eng.ready(l));
  if (!list.length) return toast('Select a picture layer first', true);
  const m = eng.composeMask();
  if (!m) return toast('Mark the area to keep first', true);
  const n = eng.paint.cutByMask(list, { canvas: m.canvas, f: eng.frame() });
  toast(n ? `Cut out: a new layer over ${n > 1 ? `each of ${n} layers` : 'the layer'}, which is hidden now` : 'The mask doesn\'t cover that layer', !n);
}

// the canvas outside the selected layer, marked as the mask: a picture placed on a bigger canvas, then Fill to draw the rest
function maskOutside(eng) {
  const l = eng.E.sel;
  if (!l || l.mask) return toast('Select the picture layer first', true);
  if (!eng.E.size) return toast('Set a canvas size first (Canvas): the area outside the layer is the canvas minus the layer', true);
  const r = eng.layerRect(l), o = Math.round(Math.max(r.w, r.h) * OVERLAP);
  if (!eng.paint.maskOutside(l, o)) return;
  ST.denoise = 1; save();
  toast('Outside marked as the mask. Describe the scene, then Fill (Denoise is 1.0)');
}

// ---- Extend: the canvas grown by px on each side, the new part marked ----
function extendSheet(eng) {
  const E = eng.E, f0 = eng.frame();
  if (!f0) return toast('Add a picture first', true);
  if (E.anim) return toast('An animation keeps its canvas', true);
  const d = { l: 0, r: 0, t: 0, b: 0 };
  const out = h('span', {});
  const show = () => { out.textContent = `${f0.w + d.l + d.r}×${f0.h + d.t + d.b}`; };
  const nums = h('div', { class: 'row wrap' });
  const draw = () => {
    nums.replaceChildren(...[['Left', 'l'], ['Right', 'r'], ['Top', 't'], ['Bottom', 'b']].map(([lbl, k]) =>
      propNum(lbl, d[k], (v) => { d[k] = Math.round(v); }, show, { min: 0, max: 4096, step: 8 })));
    show();
  };
  // to a shape: the shorter side grows, split evenly
  const toShape = (a) => {
    const w = f0.w, hh = f0.h;
    Object.assign(d, { l: 0, r: 0, t: 0, b: 0 });
    if (w / hh < a) { const add = Math.round((hh * a - w) / 16) * 8; d.l = d.r = add; } else { const add = Math.round((w / a - hh) / 16) * 8; d.t = d.b = add; }
    draw();
  };
  const grow = (share) => { const add = Math.round(Math.max(w0(), 1) * share / 8) * 8; Object.assign(d, { l: add, r: add, t: add, b: add }); draw(); };
  const w0 = () => Math.max(f0.w, f0.h);
  draw();
  openSheet(h('h3', {}, 'Extend the canvas'),
    help('Grows the canvas and marks the new part, with a little of the old edge so it blends, as the mask. Then describe the whole scene in the Inpaint panel and press Fill. Extending cannot be undone with Undo: Canvas, Fit layers brings the old frame back.'),
    field(['Grow by', out], nums),
    field('Both sides', seg([[0.125, '+12%'], [0.25, '+25%'], [0.5, '+50%']], null, grow, { action: true })),
    field('To a shape', seg(ASPECT_PRESETS.map(([k, a]) => [a, k]), null, toShape, { action: true, wrap: true })),
    actions(button('Extend', () => { closeSheet(); extend(eng, f0, d); }, { cls: 'small primary' }), button('Cancel', closeSheet, { cls: 'small ghost' })));
}
function extend(eng, f0, d) {
  const E = eng.E;
  if (!(d.l || d.r || d.t || d.b)) return;
  const dx = d.l - f0.x, dy = d.t - f0.y;
  for (const l of [...E.layers, ...E.items]) { l.x += dx; l.y += dy; }   // (the old frame moves to where it sits in the bigger one, its item boxes with it)
  const w = f0.w + d.l + d.r, hh = f0.h + d.t + d.b, o = Math.round(Math.max(f0.w, f0.h) * OVERLAP);
  E.size = { w, h: hh };
  // the new parts as rects, each reaching o into the old picture on its side
  const rects = [];
  if (d.l) rects.push({ x: 0, y: 0, w: d.l + o, h: hh });
  if (d.r) rects.push({ x: w - d.r - o, y: 0, w: d.r + o, h: hh });
  if (d.t) rects.push({ x: 0, y: 0, w, h: d.t + o });
  if (d.b) rects.push({ x: 0, y: hh - d.b - o, w, h: d.b + o });
  eng.paint.growMask({ x: 0, y: 0, w, h: hh }, rects);
  ST.denoise = 1; save();
  eng.changed(); eng.render();
  toast(`Canvas ${w}×${hh}. Describe the scene, then Fill (Denoise is 1.0)`);
}

// one item box: what goes there, a picture to match, and the way to drop it
function itemRow(eng, it, i) {
  const E = eng.E, small = it.w < 8 || it.h < 8;
  const desc = textArea(() => it.desc, (v) => { it.desc = v; }, { rows: 2, placeholder: 'What goes in this box: "a brass lantern on the table"', label: `Item ${i + 1}` });
  desc.addEventListener('change', () => eng.changed());
  desc.addEventListener('focus', () => { if (E.itemSel !== i) { E.itemSel = i; eng.draw(); } });
  return pictureSlot(h('div', { class: 'col' },
    h('div', { class: 'row wrap' }, hint(`Item ${i + 1}: ${Math.round(it.w)}×${Math.round(it.h)}${small ? ' (too small)' : ''}`),
      button(it.ref ? 'Change picture' : 'Match a picture', () => openImagePicker({ title: 'A picture to match', multi: false, mp: () => 0,
        onPick: (name) => { it.ref = name; eng.changed(); eng.render(); } }), { cls: 'small', title: 'The item is drawn to look like this picture' }),
      it.ref ? button('No picture', () => { it.ref = ''; eng.changed(); eng.render(); }, { cls: 'small ghost' }) : null,
      button('Delete', () => { E.items.splice(i, 1); E.itemSel = -1; eng.changed(); eng.render(); }, { cls: 'small ghost' })),
    desc), { give: (name) => { it.ref = name; eng.changed(); eng.render(); } });
}

// the mask: what marks it, and Dilate / erode following the slider on the canvas (what Fill, Remove, Swap and Cut out get is what shows)
export function masksSection(eng) {
  const E = eng.E;
  if (!E.layers.length) return null;
  const mask = eng.paint.maskLayer(false), cover = mask ? eng.composeMask() : null;
  let spread = eng.paint.spreadValue();
  return section('Masks', null,
    h('div', { class: 'row wrap' },
      button([icon('brush'), mask ? 'Paint mask' : 'Mark an area'], () => eng.paint.paintMask(), { cls: 'small primary', title: 'A red brush on its own layer: what it covers gets redrawn' }),
      button('Add selection', () => eng.paint.selAction('tomask'), { disabled: !eng.paint.hasSel(), title: 'The rectangle / lasso selection joins the mask' }),
      button('Add layer shape', () => addLayerShape(eng), { disabled: !eng.E.sel || eng.E.sel.mask || eng.E.sel.draft, title: 'The solid part of the selected layer joins the mask: what its see-through leaves showing' }),
      button('Cut out layer', () => cutOutLayers(eng), { disabled: !mask || !eng.E.sel || eng.E.sel.mask || eng.E.sel.draft, title: 'A new layer of what the mask covers on the selected layer. The layer stays, hidden; the mask is used up' }),
      button('Invert', () => eng.paint.maskOp('invert'), { disabled: !mask }),
      button('Clear', () => eng.paint.maskOp('clear'), { disabled: !mask }),
      button('Mask outside', () => maskOutside(eng), { disabled: !eng.E.sel || eng.E.sel.mask || eng.E.sel.draft, title: 'Mark everything of the canvas outside the selected layer as the mask, with a little of its edge to blend' })),
    hint(cover ? `Mask covers ${Math.max(1, Math.round(cover.cover * 100))}% of the picture` : 'Nothing marked yet'),
    mask ? rangeField('Dilate / erode', () => spread, (v) => { spread = Math.round(v); }, { min: -SPREAD_MAX, max: SPREAD_MAX, step: 1, fmt: spreadLabel,
      onInput: () => { eng.paint.spreadLive(spread); eng.draw(); }, onChange: () => { eng.paint.spreadDone(); eng.changed(); eng.render(); },   // (the canvas alone while dragging: a render rebuilds this slider)
      help: 'Right dilates the mask (it grows), left erodes it (it shrinks), and the canvas follows. Back to the middle brings it back, until you paint on it. Whatever uses the mask gets it as it shows.' }) : null,
    mask ? rangeField('Mask visibility', () => mask.opacity, (v) => { mask.opacity = v; }, { min: 0.1, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`,
      onInput: () => eng.draw(), onChange: () => { eng.changed(); eng.render(); },   // (the canvas alone while dragging: a render rebuilds this slider)
      help: 'Only how strongly the red shows while you edit. The area sent to redraw is always the full mask, whatever the brush opacity or this.' }) : null,
    help('Paint the area (red), or mark it with the Select tools (M, A) and Add selection. The Inpaint panel, Remove and Swap use it.'));
}

export function inpaintSection(eng) {
  const E = eng.E, ts = inpaintTemplates();
  if (!E.layers.length) return null;
  const t = ts.find((x) => x.id === ST.tpl) || ts[0];
  const drafts = E.layers.filter((l) => l.draft);
  const cover = eng.paint.maskLayer(false) ? eng.composeMask() : null;
  return section('Inpaint and extend', null,
    h('div', { class: 'row wrap' },
      button(E.itemDraw ? 'Drag on the canvas…' : 'Add item', () => { E.itemDraw = !E.itemDraw; if (E.itemDraw) toast('Drag a box where the item goes'); eng.render(); }, { cls: E.itemDraw ? 'small primary' : '', title: 'Draw a box for something new: describe it, and optionally give a picture to match (Flux 3 Klein)' }),
      button('Extend…', () => extendSheet(eng), { title: 'Grow the canvas and mark the new part' })),
    ...E.items.map((it, i) => itemRow(eng, it, i)),
    ts.length ? field('Run on', seg([['whole', 'Whole picture'], ['selected', 'Selected layers']], ST.scope, (v) => { ST.scope = v; save(); eng.render(); }),
      help('Whole picture sends every visible layer together and gives one result. Selected layers cuts the mask to each selected layer and runs that layer alone, one run each, with its own draft over it. A layer the mask doesn\'t touch is left out. Add item works on the whole picture only.')) : null,
    ts.length ? field('Prompt', textArea(() => ST.prompt, (v) => { ST.prompt = v; save(); }, { rows: 2, placeholder: 'What should be there: "a red leather jacket", not "make it red"' })) : null,
    ts.length > 1 ? field('Model', seg(ts.map((x) => [x.id, x.name || x.id]), t.id, (v) => { ST.tpl = v; save(); }, { wrap: true })) : null,
    ts.length ? rangeField('Denoise', () => ST.denoise, (v) => { ST.denoise = v; save(); }, { min: 0.3, max: 1, step: 0.05, fmt: (v) => v.toFixed(2),
      help: '1.0 redraws the area from scratch (use it to extend or remove things). 0.6 to 0.8 keeps shapes and colours.' }) : null,
    stepsField(t) ? rangeField('Steps', () => ST.steps || stepsField(t).value, (v) => { ST.steps = Math.round(v); save(); }, { min: 2, max: 40, step: 1, fmt: (v) => String(Math.round(v)),
      help: 'Sampling steps. Turbo models are made for about 8; more can add detail, or change nothing.' }) : null,
    ts.length ? h('div', { class: 'row wrap' },
      toggle('Crop to mask', ST.fit, (on) => { ST.fit = on; save(); }, { help: 'The model sees only a box round the mask, at its full resolution: better detail for a small area.' }),
      propNum('Edge softness (px)', ST.feather, (v) => { ST.feather = v; save(); }, () => {}, { min: 0, max: 64, step: 2 })) : null,
    ...drafts.map((l) => h('div', { class: 'row wrap' }, hint(`${l.label}: a draft`),
      button('Keep as layer', () => { delete l.draft; eng.changed(); eng.render(); }, { cls: 'small primary', title: 'It joins the picture, and is sent with the next Fill' }),
      button('Discard', () => { E.layers.splice(E.layers.indexOf(l), 1); if (E.sel === l) E.sel = null; eng.changed(); eng.render(); }, { cls: 'small ghost' }))),
    runBar(
      button(FLIGHT.size ? 'Fill again' : 'Fill', () => fill(eng), { cls: 'small primary', title: 'Ctrl+Enter', disabled: !ts.length || (!cover && !usableItems(eng).length) }),
      FLIGHT.size ? hint(`${FLIGHT.size} on its way…`) : null),
    ts.length ? null : hint('No inpaint template is installed (deck-krea2-inpaint).'),
    help('Add item draws a box for something new: describe it, optionally give a picture to match, and Fill (Flux 3 Klein places each box). Mark the area to redraw in the Masks panel; describe what should be there, and Fill: the rest of the picture comes back untouched and the result is a draft on top. Fill as often as you like: drafts are not sent. Keep the one you want as a layer. Extend grows the canvas and marks the new part for you.'));
}
