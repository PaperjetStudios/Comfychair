// A run's bar, the same in Generate, Details, the Board and the image picker: every file the run made (a character sheet's
// clip and its sheet picture), to switch between, and what to do next with its clip. Nothing shows for a run with one
// file that isn't a clip.
//   runBar(el, g, sel, { onPick(i), has(i)?, before()? })
//   el: the bar (class strip; empty hides it); sel: the output on show; has: this view can show that output (else its
//   thumbnail is off); before(): close this view (the buttons go to the Generate tab; on the table they make a new video
//   frame of the clip with that Edit op opened on it, table-out.js editAs)
import { button, h, info, toast } from './ui.js';
import { S } from './core.js';
import { cardPicture, kindOf } from './kinds.js';

// the clip these buttons work on: the one on show, else the run's first (a sheet picture's clip)
export function clipOfRun(g, sel) {
  return kindOf(g.outputs[sel] || {}) === 'video' ? sel : g.outputs.findIndex((o) => kindOf(o) === 'video');
}

const CLIP_UPSCALES = [
  ['deck-upscale-video', 'Upscale', 'Into the Generate tab, in the SeedVR2 video upscale: draws the clip again bigger with fine detail added. The sheet picture isn\'t cut again: for that, Use as… → Upscale the sheet (H3).'],
  ['deck-upscale-video-fast', 'Upscale (fast)', 'Into the Generate tab, in the fast video upscale: an upscale model makes the clip bigger. It sharpens what is there and does not add new detail.'],
];
const installed = (id) => S.templates.some((t) => t.id === id && !t.error);

export function runBar(el, g, sel, { onPick, has = () => true, before = null } = {}) {
  const thumbs = g.outputs.length > 1 ? g.outputs.map((o, i) => h('button', { type: 'button', class: `thumb${i === sel ? ' sel' : ''}`,
    title: `${kindOf(o)}: ${o.filename || ''}`, 'aria-label': `Show the ${kindOf(o)} ${o.filename || ''}`, 'aria-pressed': i === sel, disabled: !has(i), onclick: () => onPick(i) },
  cardPicture(o, g, 160))) : [];
  const clip = clipOfRun(g, sel);
  const run = (fn) => async () => {
    before?.();
    try { await fn(await import('./run.js')); } catch (e) { toast(e.message, true); }
  };
  const table = !!document.querySelector('#tab-table.active, #tab-table.live-host');
  const op = (label, id, tip) => [button(label, async () => {
    before?.();
    try { await (await import('./table-out.js')).editAs(g, clip, id); } catch (e) { toast(e.message, true); }
  }, { cls: 'small' }), info(tip)];
  const acts = clip < 0 ? [] : table ? [
    ...op('Upscale', 'upvideo', 'A new video frame of the clip, with SeedVR2\'s upscale opened on it in the Edit pane.'),
    ...op('Upscale (fast)', 'upvideofast', 'A new video frame of the clip, with the fast upscale opened on it in the Edit pane.'),
    ...op('Finish', 'finish', 'A new video frame of the clip, with Finish (H3 1080p) opened on it in the Edit pane.'),
  ] : [
    ...CLIP_UPSCALES.filter(([id]) => installed(id)).flatMap(([id, label, tip]) => [button(label, run((m) => m.useClipIn(id, g, clip)), { cls: 'small' }), info(tip)]),
    installed('deck-h3-refine') ? button('Refine', run((m) => m.useRefineClip(g, clip)), { cls: 'small' }) : null,
    installed('deck-h3-refine') ? info('Into the Generate tab, in deck-h3-refine: H3 draws the clip again from part-way, sharper, with your references.') : null,
  ].filter(Boolean);
  el.replaceChildren(...thumbs, ...(acts.length ? [h('span', { class: 'run-acts' }, ...acts)] : []));
}
