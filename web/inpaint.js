import { h, api, store, toast, busy, button, section, field, seg, hint, help, toggle, textArea, rangeField, propNum, openSheet, closeSheet, actions } from './ui.js';
import { ASPECT_PRESETS, S } from './core.js';
import { uploadImage } from './media.js';
import { queueRun, valuesByRole, waitGen } from './make.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Inpaint and Extend, in the Editor panel. The area to redraw is an inpaint mask layer (red, painted with a brush or
// added from a rectangle / lasso selection, see paint.js maskLayer) kept out of the picture. Fill sends the picture
// (every layer but the mask) and the mask to an inpaint template (the masked-edit path of app/maskcomp.py, so the
// rest of the picture comes back pixel for pixel) and the result lands as a new layer on top, the frame's size.
// Extend grows the canvas on any side and marks the new part (and a little of the old edge, to blend) as the mask.
// ---------------------------------------------------------------------------
const KEY = 'deck.inpaint';
const ST = { prompt: '', tpl: null, denoise: 0.9, fit: true, feather: 8, grow: 0, steps: 0, ...store.get(KEY, {}) };
const save = () => store.set(KEY, ST);
const FLIGHT = new Set();   // runs on their way back
const OVERLAP = 0.04;       // Extend: how much of the old edge joins the mask, a share of the canvas's longer side

const inpaintTemplates = () => S.templates.filter((t) => !t.error && t.fields.some((f) => f.kind === 'mask' && f.required));
const stepsField = (t) => t?.fields.find((f) => f.kind === 'int' && f.input === 'steps') || null;   // (turbo sigma lists have none)
const pngBlob = (cv) => new Promise((res) => cv.toBlob(res, 'image/png'));

async function uploadMask(cv) {
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
  return { [fw.key]: fit(fw, w * k), [fh.key]: fit(fh, hh * k) };
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
  c.drawImage(keep, 0, 0);
}

async function fill(eng, { denoise = ST.denoise } = {}) {
  const t = S.templates.find((x) => x.id === ST.tpl && !x.error) || inpaintTemplates()[0];
  if (!t) return toast('No inpaint template is installed', true);
  if (!eng.composeMask()) return toast('Mark the area to redraw first: paint the mask, or select and Add to inpaint mask', true);
  if (eng.loading()) return toast('The images are still loading', true);
  const tab = eng.E.tab?.id, b = busy('Sending the picture…');
  try {
    await eng.paint.savePaint();
    // (after the save: it can change the frame, and the mask and the picture must be the same size or they do not line up)
    const f = eng.frame(), m = eng.composeMask();
    if (!f || !m) return toast('Mark the area to redraw first', true);
    const pic = document.createElement('canvas');
    if (!eng.compose(pic)) return toast('Add a picture first', true);
    if (pic.width !== m.canvas.width || pic.height !== m.canvas.height) return toast(`The picture (${pic.width}×${pic.height}) and mask (${m.canvas.width}×${m.canvas.height}) differ in size: try again`, true);
    if (denoise >= 0.95) smearUnderMask(pic, m.canvas);
    const up = await uploadImage(await pngBlob(pic), { mp: 0, source: 'editor', filename: 'inpaint.png' });
    const maskName = await uploadMask(m.canvas);
    const mf = t.fields.find((x) => x.kind === 'mask'), main = t.fields.find((x) => x.key === mf.image_key);
    const dn = t.fields.find((x) => x.kind === 'float' && /denoise/i.test(`${x.input} ${x.label} ${x.group}`));
    const values = { [main.key]: up.name, ...valuesByRole(t, { prompt: ST.prompt.trim(), seed: -1 }), ...sizeValues(t, f.w, f.h, ST.fit ? 1 : Math.min(2, f.w * f.h / 1e6)) };
    if (dn) values[dn.key] = denoise;
    const sf = stepsField(t);
    if (sf && ST.steps) values[sf.key] = ST.steps;
    values[mf.key] = { feather: ST.feather, grow: ST.grow, fit: ST.fit, name: maskName, box: m.box, src: up.name, crop: null };
    const [g] = await queueRun({ template: t.id, values, batch: 1 });
    toast(`Redrawing (#${g.id}): it lands as a new layer`);
    FLIGHT.add(g.id); eng.render();
    waitGen(g.id).then(async (done) => {
      const r = await api(`/api/generations/${done.id}/to-input`, { method: 'POST', body: { index: 0, frame: 'first', mp: 0, multiple: 1 } });
      if (eng.E.tab?.id !== tab) return toast(`Inpaint #${done.id} finished on another edit: it is in History`);
      eng.addImage(r.name, { label: `Inpaint #${done.id}`, draft: true, x: f.x, y: f.y, scale: f.w / r.width });
      eng.render();
      toast('Inpaint done: a draft on top, not sent with the next Fill. Keep it to make it a layer');
    }).catch((e) => toast(`Inpaint failed: ${e.message}`, true)).finally(() => { FLIGHT.delete(g.id); eng.render(); });
  } catch (e) { toast(e.message, true); } finally { b.done(); }
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
    help('Grows the canvas and marks the new part, with a little of the old edge so it blends, as the inpaint mask. Then describe the whole scene in the Inpaint panel and press Fill. Extending cannot be undone with Undo: Canvas, Fit layers brings the old frame back.'),
    field(['Grow by', out], nums),
    field('Both sides', seg([[0.125, '+12%'], [0.25, '+25%'], [0.5, '+50%']], null, grow, { action: true })),
    field('To a shape', seg(ASPECT_PRESETS.map(([k, a]) => [a, k]), null, toShape, { action: true, wrap: true })),
    actions(button('Extend', () => { closeSheet(); extend(eng, f0, d); }, { cls: 'small primary' }), button('Cancel', closeSheet, { cls: 'small ghost' })));
}
function extend(eng, f0, d) {
  const E = eng.E;
  if (!(d.l || d.r || d.t || d.b)) return;
  const dx = d.l - f0.x, dy = d.t - f0.y;
  for (const l of E.layers) { l.x += dx; l.y += dy; }   // (the old frame moves to where it sits in the bigger one)
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

export function inpaintSection(eng) {
  const E = eng.E, ts = inpaintTemplates();
  if (!E.layers.length) return null;
  const mask = eng.paint.maskLayer(false);
  const t = ts.find((x) => x.id === ST.tpl) || ts[0];
  const drafts = E.layers.filter((l) => l.draft);
  const cover = mask ? eng.composeMask() : null;
  return section('Inpaint and extend', null,
    h('div', { class: 'row wrap' },
      button([icon('brush'), mask ? 'Paint mask' : 'Mark an area'], () => eng.paint.paintMask(), { cls: 'small primary', title: 'A red brush on its own layer: what it covers gets redrawn' }),
      button('Add selection', () => eng.paint.selAction('tomask'), { disabled: !eng.paint.hasSel(), title: 'The rectangle / lasso selection joins the mask' }),
      button('Invert', () => eng.paint.maskOp('invert'), { disabled: !mask }),
      button('Clear', () => eng.paint.maskOp('clear'), { disabled: !mask }),
      button('Extend…', () => extendSheet(eng), { title: 'Grow the canvas and mark the new part' })),
    hint(cover ? `Mask covers ${Math.max(1, Math.round(cover.cover * 100))}% of the picture` : 'Nothing marked yet'),
    ts.length ? field('Prompt', textArea(() => ST.prompt, (v) => { ST.prompt = v; save(); }, { rows: 2, placeholder: 'What should be there: "a red leather jacket", not "make it red"' })) : null,
    ts.length > 1 ? field('Model', seg(ts.map((x) => [x.id, x.name || x.id]), t.id, (v) => { ST.tpl = v; save(); }, { wrap: true })) : null,
    ts.length ? rangeField('Denoise', () => ST.denoise, (v) => { ST.denoise = v; save(); }, { min: 0.3, max: 1, step: 0.05, fmt: (v) => v.toFixed(2),
      help: '1.0 redraws the area from scratch (use it to extend or remove things). 0.6 to 0.8 keeps shapes and colours.' }) : null,
    mask ? rangeField('Mask visibility', () => mask.opacity, (v) => { mask.opacity = v; }, { min: 0.1, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`,
      onInput: () => eng.draw(), onChange: () => { eng.changed(); eng.render(); },   // (the canvas alone while dragging: a render rebuilds this slider)
      help: 'Only how strongly the red shows while you edit. The area sent to redraw is always the full mask, whatever the brush opacity or this.' }) : null,
    stepsField(t) ? rangeField('Steps', () => ST.steps || stepsField(t).value, (v) => { ST.steps = Math.round(v); save(); }, { min: 2, max: 40, step: 1, fmt: (v) => String(Math.round(v)),
      help: 'Sampling steps. Turbo models are made for about 8; more can add detail, or change nothing.' }) : null,
    ts.length ? h('div', { class: 'row wrap' },
      toggle('Crop to mask', ST.fit, (on) => { ST.fit = on; save(); }, { help: 'The model sees only a box round the mask, at its full resolution: better detail for a small area.' }),
      propNum('Edge softness (px)', ST.feather, (v) => { ST.feather = v; save(); }, () => {}, { min: 0, max: 64, step: 2 }),
      propNum('Grow (px)', ST.grow, (v) => { ST.grow = v; save(); }, () => {}, { min: 0, max: 32, step: 2 })) : null,
    ...drafts.map((l) => h('div', { class: 'row wrap' }, hint(`${l.label}: a draft`),
      button('Keep as layer', () => { delete l.draft; eng.changed(); eng.render(); }, { cls: 'small primary', title: 'It joins the picture, and is sent with the next Fill' }),
      button('Discard', () => { E.layers.splice(E.layers.indexOf(l), 1); if (E.sel === l) E.sel = null; eng.changed(); eng.render(); }, { cls: 'small ghost' }))),
    h('div', { class: 'row wrap' },
      button(FLIGHT.size ? 'Fill again' : 'Fill', () => fill(eng), { cls: 'small primary', disabled: !ts.length || !cover }),
      FLIGHT.size ? hint(`${FLIGHT.size} on its way…`) : null),
    ts.length ? null : hint('No inpaint template is installed (deck-krea2-inpaint).'),
    help('Paint the area to redraw (red), or mark it with the Select tools (M, A) and Add selection; describe what should be there, and Fill: the rest of the picture comes back untouched and the result is a draft on top. Fill as often as you like: drafts are not sent. Keep the one you want as a layer. Extend grows the canvas and marks the new part for you.'));
}
