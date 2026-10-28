// Prompt helper (app/promptaid.py: a small local model through Ollama). Improve rewrites a rough prompt for a model
// family and offers a few versions to pick from; Expand idea turns one line into a whole scene; Describe writes a
// prompt from a picture (or only its style). Nothing is replaced until a version is tapped, and that can be undone.
//
// A text box hands over io: { get(), set(text), snapshot?(), restore?(snap), target }. target says which model the
// prompt is for: { family, tag_style, media, edit, i2v, label, remember? } (tplTarget for the Generate template;
// remember: a store key that keeps the family picked here, for boxes with no template of their own, as in Story).

import { h, api, toast, openSheet, closeSheet, button, chip, help, store, seg, note } from './ui.js';
import { S, thumbUrl } from './core.js';
import { openImagePicker } from './media.js';

// the families the helper knows (app/promptaid.py GUIDE)
const FAMILIES = [['krea', 'Krea'], ['klein', 'Flux Klein'], ['qwen', 'Qwen Image'], ['moss', 'MOSS'], ['image', 'Other image'],
  ['ltx', 'LTX'], ['h3', 'H3'], ['video', 'Other video']];
const BY_LABEL = { krea: 'krea', 'flux klein': 'klein', 'qwen image': 'qwen', moss: 'moss', 'ltx-2.5': 'ltx', 'minimax h3': 'h3' };
const DEVICES = [['auto', 'Auto', 'The graphics card when ComfyUI is idle, else the processor'],
  ['gpu', 'Graphics card', 'Fast (a few seconds); ComfyUI\'s models are unloaded first if the card is full'],
  ['cpu', 'Processor', 'Slower (about a minute) but leaves the graphics card alone']];

// The Generate template's target; null for a template whose prompt isn't a picture or a shot (music, masks, motion…)
export function tplTarget(t = S.tpl) {
  if (!t || !['image', 'video'].includes(t.media) || /^(SAM3|Motion|ACE-Step|Pose|Depth|Upscale)$/.test(t.family)) return null;
  const pics = (t.fields || []).some((f) => f.kind === 'image');
  return { family: t.family || '', tag_style: t.tag_style || '', media: t.media || 'image', label: t.name,
    edit: t.media === 'image' && pics && !/inpaint/i.test(t.id), i2v: t.media === 'video' && pics };
}

// the family key a target starts on
function familyOf(target) {
  if (target.tag_style === 'h3') return 'h3';
  const k = BY_LABEL[String(target.family || '').toLowerCase()] || (FAMILIES.some(([f]) => f === target.family) ? target.family : null);
  return k || (target.media === 'video' ? 'video' : 'image');
}

const HELP = {
  improve: 'A small model on this computer (Ollama, qwen3.5:4b) rewrites your prompt for the model picked here, adding '
    + 'concrete detail. Reference tags (the first image, <Picture 1>, <ref_image_0>, @Name…), {a|b} wildcards and H3\'s shots, '
    + 'speech and sound lines are kept as written; a version that lost one says so. Tap a version to use it; Undo puts '
    + 'yours back. Expand idea turns a single line into a whole scene. Auto runs on the graphics card when ComfyUI is '
    + 'idle (a few seconds) and on the processor while it\'s busy (about a minute).',
  describe: 'A small model on this computer looks at the picture and writes a prompt that would make one like it: '
    + 'the subject, setting, framing, lens, light, colour and mood. Only the style leaves out what\'s in the picture, to '
    + 'reuse its look on something else. Use replaces your prompt; Add puts it at the end. Undo puts yours back.',
};

// io + a choice -> the helper sheet. kind: improve | describe (image: the picked input's name)
function helperSheet(kind, io, { image = null } = {}) {
  const target = io.target || { media: 'image' };
  let fam = (target.remember && store.get(target.remember, null)) || familyOf(target);
  let mode = kind === 'improve' ? ((io.get() || '').trim().split(/\s+/).length <= 6 ? 'expand' : 'improve') : 'full';
  let device = store.get('deck.promptDevice', 'auto');
  let run = 0;
  const results = h('div', { class: 'pa-results' });
  const modes = kind === 'improve'
    ? [['improve', 'Improve'], ['expand', 'Expand idea']]
    : [['full', 'Whole picture'], ['style', 'Only the style']];
  const modeRow = h('div', { class: 'chips' }, modes.map(([v, l]) => {
    const c = chip(l, () => { mode = v; for (const b of modeRow.children) b.classList.toggle('on', b === c); go(); }, { on: v === mode });
    return c;
  }));
  const famRow = h('div', { class: 'chips pa-fams' }, FAMILIES.map(([v, l]) => {
    const c = chip(l, () => {
      fam = v; if (target.remember) store.set(target.remember, v);
      for (const b of famRow.children) b.classList.toggle('on', b === c); go();
    }, { on: v === fam });
    return c;
  }));
  const devSeg = seg(DEVICES, device, (v) => { device = v; store.set('deck.promptDevice', v); go(); });

  const use = (text, add = false) => {
    const before = io.snapshot ? io.snapshot() : io.get();
    const cur = io.get() || '';
    io.set(add && cur.trim() ? `${cur.replace(/\s+$/, '')}${/[.!?]$/.test(cur.trim()) ? ' ' : '. '}${text}` : text);
    closeSheet();
    toast(add ? 'Added to the prompt' : 'Prompt replaced', false, { label: '↶ Undo', fn: () => (io.restore ? io.restore(before) : io.set(before)) });
  };
  const card = (v) => h('div', { class: 'pa-card' },
    h('div', { class: 'pa-text', onclick: () => use(v.text) }, v.text),
    v.missing?.length ? note(`Lost: ${v.missing.join(', ')}`) : null,
    h('div', { class: 'pa-acts' }, button('Use', () => use(v.text), { cls: 'small primary' }),
      kind === 'describe' ? button('Add to the end', () => use(v.text, true)) : null));

  async function go() {
    const me = ++run, t0 = performance.now();
    const wait = h('div', { class: 'placeholder pa-wait' }, 'Writing…');
    const tick = setInterval(() => { wait.textContent = `Writing… ${Math.round((performance.now() - t0) / 1000)} s`; }, 1000);
    results.replaceChildren(wait);
    const body = { family: fam, tag_style: fam === 'h3' ? 'h3' : target.tag_style, media: ['ltx', 'h3', 'video'].includes(fam) ? 'video' : 'image', device };
    try {
      const r = kind === 'improve'
        ? await api('/api/prompt/improve', { method: 'POST', timeout: 480000, busy: false,
          body: { ...body, text: io.get(), mode, edit: !!target.edit, i2v: !!target.i2v, n: 3 } })
        : await api('/api/prompt/describe', { method: 'POST', timeout: 480000, busy: false, body: { ...body, image, what: mode } });
      if (me !== run) return;
      const where = r.device === 'cpu' ? 'on the processor' : 'on the graphics card';
      results.replaceChildren(h('p', { class: 'hint' }, `${r.variants.length} version${r.variants.length > 1 ? 's' : ''} · ${r.seconds} s ${where}`),
        ...r.variants.map(card));
    } catch (e) {
      if (me === run) results.replaceChildren(note(e.message));
    } finally { clearInterval(tick); }
  }

  openSheet(h('h3', {}, kind === 'improve' ? 'Prompt helper' : 'Describe a picture'), help(HELP[kind]),
    image ? h('img', { class: 'pa-pic', src: thumbUrl(image, 240), alt: '' }) : null,
    modeRow, famRow, devSeg, results,
    h('div', { class: 'actions' }, button('↻ Again', () => go())));
  go();
}

export const openImprove = (io) => {
  if (!(io.get() || '').trim()) return toast('Write a few words first', true);
  helperSheet('improve', io);
};
// (the picker's sheet closes by going back in history: open this one once that has happened)
export const openDescribe = (io) => openImagePicker({ title: 'Describe a picture', onPick: (name) => {
  let done = false;
  const open = () => { if (!done) { done = true; helperSheet('describe', io, { image: name }); } };
  addEventListener('popstate', () => setTimeout(open), { once: true });
  setTimeout(open, 400);
} });
