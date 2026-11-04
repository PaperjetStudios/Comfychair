// The table's Make panel: a template's fields for what is selected on the table, and Run. It borrows the Generate tab's
// own fields (generate.js renderFields into this panel, gentabs.js borrow), so presets, seed modes, LoRAs, saved setups
// and the prompt builder work the same; each frame keeps its own settings (frame.make, a Generate tab's payload, saved
// with the table), and nothing selected keeps one set for this device.
//
//   nothing (or a note): text-to-image and text-to-video; each result is a new frame beside the last
//   an image frame:      image templates; the frame's picture goes into the template's first picture, its size is the
//                        output size, and results land as layers in it (live or not: imagetools.js landMade, owed runs)
//   a video frame:       video templates; Pick a frame puts an image frame's picture in a slot; results land as clips.
//                        Or VFX (frame-vfx.js): the VFX tab's effects on the frame's own VFX document; results land as clips
//   a 3D or sound frame: their templates; results are in the Shelf (Use as… from the toast)
//
//   renderMake(host, frames)   draw the panel into host for the selection (the sidebar calls it; table:select redraws it)
//   runMake()                  Run (the Generate button and Ctrl+Enter call it while the table is on screen)
import { h, api, store, toast, button, iconBtn, seg, field, hint, help, note, openSheet, closeSheet, runBar, actions } from './ui.js';
import { S, CURRENT_EDIT, inputUrl, thumbUrl } from './core.js';
import { afterQueued, persist, preparePictures, renderFields, runBuilder, runValues, selectTemplate, stop } from './generate.js';
import { borrow, giveBack, lentOut } from './gentabs.js';
import { refused } from './tabs.js';
import { queueRun, waitGen } from './make.js';
import { pngBlob, uploadImage } from './media.js';
import { landMade, owedTo } from './imagetools.js';
import { isLive } from './live.js';
import { onNavigate } from './navigation.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND, nextBeside, toStage } from './table-model.js';
import * as Table from './table.js';
import { LANDS, canvasRect, familiesOf, frameImageField, frameSize, makeTarget, pickTemplate, sizePair, templatesFor, withClip } from './make-rules.js';
import { icon } from './icons.js';
import { frameOfVfx, hideFrameVfx, showFrameVfx } from './frame-vfx.js';
import { runVfx } from './vfx.js';

const P = { fresh: [], ready: Promise.resolve(), host: null, frames: [], table: null, lentFor: null, els: null, prog: null, batch: Math.max(1, store.get('deck.make.batch', 1)) };
const KIND_WORD = { none: 'a new frame', image: 'this picture', video: 'this video', scene: 'this 3D frame', sound: 'this sound frame' };
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;
const lastTpl = (kind) => store.get(`deck.make.tpl.${kind}`, null);

// the selection: from the event, else what the table says now
const selection = () => Table.selectedFrames() || P.frames;
const tableNow = () => {
  const frames = Table.tableFrames() || P.table?.frames;
  return frames ? { frames, view: P.table?.view } : null;
};
// a frame changed (its settings): the table saves it as it is
const frameSaved = () => Table.frameChanged();

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------
export function renderMake(host = P.host, frames = P.frames) {
  if (host) P.host = host;
  P.frames = frames || [];
  draw();
}

function draw() {
  const host = P.host;
  if (!host) return;
  if (!S.templates?.length) { host.replaceChildren(note('The templates are still loading.', 'warn')); P.lentFor = null; return; }
  const { kind, frame } = makeTarget(P.frames);
  const list = templatesFor(S.templates, kind);
  if (!list.length) { hideFrameVfx(); host.replaceChildren(note(`No template here makes anything for ${KIND_WORD[kind]}.`, 'warn')); return; }
  const key = `${kind}:${frame?.id || ''}`;
  if (P.lentFor !== key || !host.contains(P.els?.fields)) {
    P.els = { fields: h('div', { class: 'make-fields' }), notes: h('div', { class: 'make-notes' }), basics: h('div', { class: 'make-basics' }),
      picker: h('div', { class: 'make-picker' }), head: h('div', { class: 'make-head' }), mode: h('div', { class: 'make-mode' }), vfx: h('div', { class: 'make-vfx hidden' }) };
    host.replaceChildren(h('div', { class: 'make-panel' }, P.els.mode, P.els.head, P.els.picker, P.els.notes, P.els.basics, P.els.fields, P.els.vfx));
    P.lentFor = key;
    const settings = frame ? frame.make || null : store.get('deck.make.none', null);
    const fits = settings?.template && list.some((t) => t.id === settings.template);
    const want = pickTemplate(list, fits ? settings.template : null, frame?.make?.template, lastTpl(kind));
    P.ready = borrow(fits ? settings : null, { template: want, target: target(kind, frame), save: (p) => keep(kind, frame, p) })
      .then(() => { if (P.lentFor === key) { fitFrame(kind, frame); drawHead(kind, frame, list); } });
    drawHead(kind, frame, list);
    syncMode(kind, frame);
    return;
  }
  drawHead(kind, frame, list);
  syncMode(kind, frame);
}

// A video frame's Make pane: Templates (the borrowed fields) or VFX (frame-vfx.js), one at a time
const vfxOn = (kind, frame) => kind === 'video' && !!frame?.doc && store.get('deck.make.mode.video', 'make') === 'vfx';
export function useVfxMode(on) {
  store.set('deck.make.mode.video', on ? 'vfx' : 'make');
  if (P.host) draw();
}
function syncMode(kind, frame) {
  const on = vfxOn(kind, frame);
  P.els.mode.replaceChildren(kind === 'video' && frame?.doc
    ? seg([['make', 'Templates'], ['vfx', 'VFX']], on ? 'vfx' : 'make', (v) => useVfxMode(v === 'vfx')) : null);
  for (const k of ['head', 'picker', 'notes', 'basics', 'fields']) P.els[k].classList.toggle('hidden', on);
  P.els.vfx.classList.toggle('hidden', !on);
  if (on) showFrameVfx(P.els.vfx, frame); else hideFrameVfx();
}

// what the borrowed fields draw into, and what they show differently here
function target(kind, frame) {
  return { host: P.els.fields, notes: P.els.notes, basics: P.els.basics, scope: P.host,
    replace: (f) => (kind === 'image' && frame && f === frameImageField(S.tpl) ? framePictureEl(frame) : null),
    imageButtons: (f, set) => (kind === 'video' ? [button([icon('image'), 'Pick a frame'], () => pickFrame(f, set))] : []) };
}

// the settings of this frame (or of nothing selected) changed: keep them
function keep(kind, frame, p) {
  if (p?.template) store.set(`deck.make.tpl.${kind}`, p.template);
  if (!frame) { store.set('deck.make.none', p); return; }
  frame.make = { ...p, ...settleInputs(frame, p) };
  frameSaved();
}

// The pictures Pick a frame copied in for this frame (frame.make.inputs, saved with it): one stays while a slot still uses it, and goes when
// the slot takes another picture or is cleared. What is left when the frame itself is deleted goes with Settings → Projects → Clean up leftovers
// (the table deletes frames in table.js, which can't reach this list).
function settleInputs(frame, p) {
  const used = JSON.stringify(p.values || {});
  const all = [...new Set([...(frame.make?.inputs || []), ...P.fresh.splice(0)])];
  for (const n of all) if (!used.includes(JSON.stringify(n))) dropInput(n);
  return { inputs: all.filter((n) => used.includes(JSON.stringify(n))) };
}

// the frame's size is the output size (an image or video frame)
function fitFrame(kind, frame) {
  if (!frame || (kind !== 'image' && kind !== 'video')) return;
  const pair = sizePair(S.tpl), s = frameSize(pair, frame);
  if (!s || (S.values[pair[0].key] === s.w && S.values[pair[1].key] === s.h)) return;
  S.values[pair[0].key] = s.w; S.values[pair[1].key] = s.h;
  S.sizeMode[pair[0].key] = { aspect: 'custom', mp: Math.round((s.w * s.h) / 1e4) / 100 };
  renderFields(); persist();   // (saved with the frame's settings)
}

function drawHead(kind, frame, list) {
  const t = S.tpl;
  const fams = familiesOf(list), fam = t ? t.family || 'Other' : fams[0];
  const shown = list.filter((x) => (x.family || 'Other') === fam);
  const sel = h('select', { 'aria-label': 'Template', onchange: () => choose(kind, sel.value) },
    shown.map((x) => h('option', { value: x.id }, x.name + (x.error ? ' (error)' : ''))));
  if (t && shown.some((x) => x.id === t.id)) sel.value = t.id;
  const famSeg = seg(fams.map((f) => [f, f]), fam, (f) => { const first = list.find((x) => (x.family || 'Other') === f); if (first) choose(kind, first.id); }, { wrap: true });
  P.els.picker.replaceChildren(fams.length > 1 ? famSeg : null, sel);
  const batchIn = h('input', { type: 'number', min: 1, max: 16, value: P.batch, inputMode: 'numeric', 'aria-label': 'How many',
    onchange: () => { P.batch = Math.min(16, Math.max(1, Math.round(+batchIn.value) || 1)); batchIn.value = P.batch; store.set('deck.make.batch', P.batch); } });
  const owed = kind === 'image' && frame?.doc ? owedTo(frame.doc).length : 0;
  P.prog ||= { bar: h('div', { class: 'make-prog-bar' }), text: h('span', { class: 'make-prog-text' }) };
  P.els.head.replaceChildren(
    runBar(button([icon('sparkle'), 'Run'], () => runMake(), { cls: 'primary make-run', title: 'Run (Ctrl+Enter)' }),
      h('label', { class: 'make-batch' }, '×', batchIn),
      iconBtn('Stop this device\'s run', icon('close'), () => stop())),
    h('div', { class: 'make-prog' }, P.prog.bar, P.prog.text),
    hint(frame ? `For ${frame.label || 'the frame'} · ${landsWord(kind)}${owed ? ` · ${owed} on the way` : ''}` : `Lands as ${landsWord(kind)}`, 'make-for'));
  mirrorProgress();
}
const landsWord = (kind) => ({ frame: 'a new frame beside the last', layer: 'new layers in it', clip: 'clips on its timeline', shelf: 'lands in the Shelf' })[LANDS[kind]];

function choose(kind, id) {
  store.set(`deck.make.tpl.${kind}`, id);
  selectTemplate(id);   // (gentabs.js pick: Keep prompt carries the prompt and pictures over, with an Undo)
  const { frame } = makeTarget(P.frames);
  fitFrame(kind, frame);
  draw();
}

// the frame's own picture, in place of the template's first picture slot
function framePictureEl(frame) {
  const still = stillOf(frame);
  return field(['Picture', h('span', {}, 'this frame')],
    h('div', { class: 'make-frame-pic' }, still ? h('img', { src: still, alt: '' }) : h('span', { class: 'hint' }, 'Empty frame')),
    help('The frame as it looks when Run is pressed.'));
}

// Pick a frame: an image frame's picture into a video template's slot
function pickFrame(f, set) {
  const frames = (tableNow()?.frames || []).filter((x) => x.kind === 'image' && x.doc);
  if (!frames.length) return toast('No image frames on this table yet', true);
  openSheet(h('h3', {}, `${f.label}: pick a frame`),
    h('div', { class: 'make-frame-list' }, frames.map((x) => {
      const still = stillOf(x);
      return h('button', { type: 'button', class: 'make-frame-card', disabled: !still, onclick: async () => {
        closeSheet();
        try { const up = await frameUpload(x, S.imageMp[f.key] ?? 1); P.fresh.push(up.name); set(up.name); } catch (e) { toast(e.message, true); }
      } }, still ? h('img', { src: still, alt: '' }) : h('span', { class: 'hint' }, 'Empty'), h('span', {}, x.label || 'Frame'));
    })),
    actions(button('Cancel', closeSheet, { cls: 'small ghost' })));
}

// ---------------------------------------------------------------------------
// a frame's picture: the live editor's composite, else its document's still
// ---------------------------------------------------------------------------
const liveEngine = (frame) => {
  const eng = CURRENT_EDIT.eng;
  return isLive(frame.id) && eng?.E?.tab?.id === frame.doc ? eng : null;
};
async function framePicture(frame) {
  const eng = liveEngine(frame);
  if (eng) {
    await eng.paint?.savePaint?.();
    const cv = document.createElement('canvas');
    if (!eng.compose(cv)) return null;
    return pngBlob(cv);
  }
  let url = stillOf(frame);
  if (!url) url = (await api(docUrl(frame.kind, frame.doc), { busy: false }).catch(() => null))?.still?.url;
  if (!url) return null;
  const r = await fetch(url);
  return r.ok ? r.blob() : null;
}
async function frameUpload(frame, mp = 0) {
  const blob = await framePicture(frame);
  if (!blob) throw new Error(`${frame.label || 'That frame'} is empty`);
  return uploadImage(blob, { source: 'frame', mp, filename: 'frame.png', multiple: 16 });
}
const dropInput = (name) => api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let running = false;
export async function runMake() {
  if (running) return;
  const sel = selection();
  if (sel !== P.frames) P.frames = sel || [];
  const { kind, frame } = makeTarget(P.frames);
  if (vfxOn(kind, frame)) return runVfx();
  if (!P.host || !lentOut() || P.lentFor !== `${kind}:${frame?.id || ''}`) draw();
  await P.ready;   // (a fresh borrow loads first)
  const t = S.tpl;
  if (!t || t.error) return toast('Pick a working template first', true);
  if (!templatesFor([t], kind).length) return toast(`${t.name} doesn't make anything for ${KIND_WORD[kind]}`, true);
  if (frame && DOC_KIND[kind] && !frame.doc) return toast(`${frame.label || 'This frame'} has no document yet`, true);
  const values = runValues();
  if (!values) return;
  running = true;
  let sent = null;
  try {
    const imgF = kind === 'image' ? frameImageField(t) : null;
    if (imgF) {
      sent = await frameUpload(frame, 0);
      values[imgF.key] = sent.name;
    }
    if (frame && (kind === 'image' || kind === 'video')) {   // (the frame's size, even if the fields were drawn for another)
      const pair = sizePair(t), s = frameSize(pair, frame);
      if (s) { values[pair[0].key] = s.w; values[pair[1].key] = s.h; }
    }
    await preparePictures(values, new Set(imgF ? [imgF.key] : []));
    const batch = P.batch;
    const gens = await queueRun({ template: t.id, values, batch, builder: runBuilder(), timeout: 120000 });
    afterQueued(gens, batch);
    await land(kind, frame, t, gens, sent, values);
    dispatchEvent(new CustomEvent('make:queued', { detail: { frame, kind, gens } }));
    toast(`${gens.length > 1 ? `Queued ${gens.length}` : 'Queued'}: ${landsWord(kind)}`);
    drawHead(kind, frame, templatesFor(S.templates, kind));
  } catch (e) {
    if (sent) dropInput(sent.name);
    toast(e.message, true);
  } finally { running = false; }
}

function land(kind, frame, t, gens, sent, values) {
  if (kind === 'image') return landLayers(frame, t, gens, sent);
  for (const g of gens) {
    waitGen(g.id).then((done) => (kind === 'none' ? landFrames(done, values, t) : kind === 'video' ? landClips(frame, done)
      : inShelf(done))).catch((e) => toast(`${t.name} failed: ${e.message}`, true));
  }
}

// image frame: each run a new layer in it, now if it is open, else when it next opens (owed runs, by its document's id)
async function landLayers(frame, t, gens, sent) {
  const eng = liveEngine(frame);
  let rect = eng?.frame?.();
  if (!rect) {
    const d = await api(docUrl('image', frame.doc), { busy: false }).catch(() => null);
    rect = canvasRect(d?.payload, frame);
  }
  const src = { name: sent?.name || null, px: sent ? [sent.width, sent.height] : [rect.w, rect.h], rect, copy: !!sent };
  gens.forEach((g, i) => {
    landMade(frame.doc, src, g, { label: t.name, nth: i });
    waitGen(g.id).catch(() => {}).finally(() => setTimeout(() => { if (P.host) draw(); }, 1500));   // (the count of runs on the way)
  });
}

// nothing selected: each output a new frame beside the last one
async function landFrames(done, values, t) {
  const pair = sizePair(t), size = pair ? { w: Number(values[pair[0].key]) || 1024, h: Number(values[pair[1].key]) || 1024 } : { w: 1024, h: 1024 };
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'image' || o.kind === 'video');
  if (!outs.length) return inShelf(done);
  for (const { o, index } of outs) {
    const T = tableNow(), stage = document.querySelector('#tab-table .table-stage');
    const r = stage?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 };
    let at;
    if (T?.frames && T.view) {
      const spot = nextBeside(T.frames, o.kind === 'video' ? 'video' : 'image', size);
      const p = toStage(T.view, spot.x, spot.y);
      at = { x: r.left + p.x, y: r.top + p.y };
    } else at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    await Table.dropOnTable([{ generation: done.id, index }], at.x, at.y);
  }
}

// video frame: each output a clip at the end of its first video track, in the open timeline if this frame is live
async function landClips(frame, done) {
  const outs = (done.outputs || []).map((o, index) => ({ o, index })).filter(({ o }) => o.kind === 'video' || o.kind === 'image');
  let n = 0;
  for (const { o, index } of outs) {
    if (await landClip(frame, { kind: o.kind, src: { generation: done.id, index }, url: o.url, label: `#${done.id}`, dur: o.duration || 0 }, false)) n++;
    else toast(`#${done.id} is done but couldn't go on ${frame.label}'s timeline: it is in the Shelf`, true);
  }
  if (n) toast(`#${done.id}: on ${frame.label || 'the video'}'s timeline`);
}
// one clip onto a video frame's timeline (the open one when it is live); true once it is there
export async function landClip(frame, media, tell = true) {
  const vid = isLive(frame.id) ? await import('./video.js') : null;
  let ok = true;
  if (vid && vid.videoTabs?.()?.active?.id === frame.doc) await vid.addToTimeline(media);
  else {
    if (!media.dur && media.kind === 'video') media.dur = await durationOf(media.url);
    ok = await appendClip(frame, media);
  }
  if (tell) toast(ok ? `On ${frame.label || 'the video'}'s timeline` : `Couldn't put it on ${frame.label}'s timeline`, !ok);
  return ok;
}

// a VFX run made for a frame's VFX document: its result lands as a clip on that frame (a server job may be done already)
addEventListener('vfx:queued', (e) => {
  const frame = e.detail?.doc ? frameOfVfx(e.detail.doc) : null;
  if (!frame?.doc) return;
  for (const g of e.detail.gens || []) {
    (g.status === 'done' ? Promise.resolve(g) : waitGen(g.id)).then((done) => landClips(frame, done))
      .catch((err) => toast(`#${g.id} failed: ${err.message}`, true));
  }
});
// the clip into the frame's saved document (its rev, so an edit elsewhere isn't overwritten: read again and retry)
async function appendClip(frame, media) {
  for (let tries = 0; tries < 3; tries++) {
    const d = await api(docUrl('video', frame.doc), { busy: false }).catch(() => null);
    if (!d) return false;
    const payload = withClip(d.payload, media, Math.random().toString(36).slice(2, 10));
    const r = await fetch(docUrl('video', frame.doc), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: d.rev, name: d.name, payload }) }).catch(() => null);
    if (r?.ok) return true;
    if (r?.status !== 409) return false;
    if (refused({ status: 409, data: await r.json().catch(() => null) })) return false;   // (a refusal, not a newer rev: no retry)
  }
  return false;
}
function durationOf(url) {
  return new Promise((done) => {
    const v = document.createElement('video');
    const end = (d) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); done(d); };
    const timer = setTimeout(() => end(0), 8000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => end(0);
    v.src = url;
  });
}

// 3D and sound frames, and anything with nowhere to go: the result is in the Shelf (History) already
function inShelf(done) {
  toast(`#${done.id} is done: it is in the Shelf`, false, { label: 'Use as…', fn: async () => (await import('./useas.js')).openUseAs(done, 0) });
}

// ---------------------------------------------------------------------------
// progress: the run line of the Generate tab (run.js setProgress), mirrored here
// ---------------------------------------------------------------------------
let mirrored = false;
function mirrorProgress() {
  const bar = document.getElementById('progBar'), text = document.getElementById('progText');
  if (!P.prog || !bar || !text) return;
  const copy = () => { P.prog.bar.style.width = bar.style.width || '0'; P.prog.text.textContent = text.textContent || ''; };
  copy();
  if (mirrored) return;
  mirrored = true;
  const mo = new MutationObserver(copy);
  mo.observe(bar, { attributes: true, attributeFilter: ['style'] });
  mo.observe(text, { childList: true, characterData: true, subtree: true });
}

// ---------------------------------------------------------------------------
// wiring: the selection on the table, a frame going live, leaving the table
// ---------------------------------------------------------------------------
addEventListener('table:select', (e) => { P.table = e.detail?.table || P.table; renderMake(P.host, e.detail?.frames || []); });
addEventListener('table:live', (e) => { P.table = e.detail?.table || P.table; if (e.detail?.frame) renderMake(P.host, [e.detail.frame]); });
addEventListener('table:unlive', () => { if (P.host) draw(); });
onNavigate((name) => {
  if (name === 'table') { if (P.host) draw(); return; }
  hideFrameVfx();   // (and the VFX tab its engine)
  if (lentOut()) giveBack();   // (another screen: the Generate tab's own fields come back)
  P.lentFor = null;
});
// the template list came in (or changed): draw again
let tplSeen = null;
addEventListener('deck:generate', () => {
  if (S.templates !== tplSeen) { tplSeen = S.templates; if (P.host && !lentOut()) draw(); }
});
// the sidebar's Make pane, once it exists
import('./sidebar.js').then(({ sidebar }) => {
  const el = sidebar?.pane?.('make', { title: 'Make', icon: 'sparkle' });
  if (el && !P.host) renderMake(el, P.frames);
}).catch(() => { /* no sidebar yet: whoever has a place for the panel calls renderMake */ });

