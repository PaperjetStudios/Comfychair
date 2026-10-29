// Prompt from the shots: one line per cut, in the same words the Story tab uses.
import * as FIGURE from './figure.js';
import { C, CAM, FPS, R, SC, sample, save, shots } from './scene-data.js';
import { promptItems, promptText } from './scene-pose.js';
import {
  framingOf, guessMove, shotSentence, shotWarnings, smpte,
} from './shot-words.js';
import { actions, button, closeSheet, field, h, help, icon, openSheet, section, seg, store, textArea, toast } from './ui.js';
import { renderPanel } from './scene-ui.js';

const sid = (s) => s.id || 'all';
const off = (s) => R.shotOff.has(sid(s));

function boxAt(o, f) {
  const v = sample(o, ['x', 'y', 'z', 'sx', 'sy', 'sz'], f);
  if (o.type === 'figure' || o.type === 'rigged') {
    const ht = FIGURE.heightOf(o.body, o.shape) * Math.abs(v.sy || 1), w = 0.45 * Math.abs(v.sy || 1);
    return { name: o.name, min: [v.x - w / 2, v.y, v.z - w / 2], max: [v.x + w / 2, v.y + ht, v.z + w / 2] };
  }
  const hx = Math.abs(v.sx) / 2, hz = Math.abs(v.sz) / 2;
  return { name: o.name, min: [v.x - hx, v.y, v.z - hz], max: [v.x + hx, v.y + Math.abs(v.sy), v.z + hz] };
}

function moveOf(cam, f0, f1) {
  for (const list of Object.values(cam.chans || {})) {
    const hit = list.find((k) => k.mv && k.f >= f0 && k.f <= f1);
    if (hit) return hit.mv;
  }
  return null;
}
function noisy(cam, f0, f1) {
  const n = (cam.chans?.px || []).filter((k) => k.f >= f0 && k.f <= f1).length;
  return n > Math.max(8, (f1 - f0) / 3);
}

// what one shot is, from the scene at its middle frame
export function shotFacts(s) {
  const f = Math.round((s.f0 + s.f1) / 2);
  const cam = s.cam;
  const mid = sample(cam, CAM, f), a = sample(cam, CAM, s.f0), b = sample(cam, CAM, s.f1);
  const boxes = SC.objects.filter((o) => !o.hidden).map((o) => boxAt(o, f));
  const frame = framingOf(mid, boxes, SC.width, SC.height);
  const move = guessMove(a, b, { mv: moveOf(cam, s.f0, s.f1), noisy: noisy(cam, s.f0, s.f1) });
  const action = promptText(promptItems([s.f0, s.f1]));
  return { ...frame, move, action, at: s.f0 / FPS };
}

function lineOf(s, n) {
  const id = sid(s);
  if (SC.shotText?.[id]) return SC.shotText[id];
  const f = shotFacts(s);
  return shotSentence({ n, at: f.at, size: f.size, angle: f.angle, subjects: f.subjects, move: f.move, action: f.action, format: R.shotFmt });
}

function lines() {
  const list = shots().filter((s) => !off(s));
  return list.map((s, i) => lineOf(s, i + 1)).join('\n');
}

function editLine(s) {
  const id = sid(s);
  let text = SC.shotText?.[id] || lineOf(s, s.i);
  openSheet(h('h3', {}, `Shot ${s.i}`),
    textArea(() => text, (v) => { text = v; }, { rows: 4, label: 'Line', placeholder: 'The line for this shot' }),
    actions(button('Cancel', closeSheet),
      button('Use this line', () => {
        SC.shotText = { ...(SC.shotText || {}) };
        if (text.trim()) SC.shotText[id] = text.trim(); else delete SC.shotText[id];
        closeSheet(); save(); renderPanel();
      }, { cls: 'small primary' })));
}

export function shotProps() {
  const list = shots();
  if (!list.length) return null;
  const text = lines();
  const gaps = [];
  const cuts = [...(SC.cuts || [])].sort((a, b) => a.f - b.f);
  for (let i = 1; i < cuts.length; i++) gaps.push((cuts[i].f - cuts[i - 1].f) / FPS);
  const warns = shotWarnings({ seconds: SC.seconds, gaps, count: list.length, format: R.shotFmt });
  return section('Prompt from the shots', null,
    h('div', { class: 'chips' }, list.map((s) => {
      const gone = off(s);
      let hold = 0, held = false;
      return h('button', { type: 'button', class: 'chip prompt-chip' + (gone ? ' off' : ''),
        title: `${smpte(s.f0, FPS, SC.tcStart)} · tap to leave it out, hold to edit the line`,
        onpointerdown: () => { held = false; hold = setTimeout(() => { held = true; editLine(s); }, 500); },
        onpointerup: () => clearTimeout(hold), onpointerleave: () => clearTimeout(hold),
        onclick: () => { if (held) return; if (gone) R.shotOff.delete(sid(s)); else R.shotOff.add(sid(s)); renderPanel(); } },
      `Shot ${s.i} · ${s.cam.name}`, h('span', { class: 'x' }, icon(gone ? 'plus' : 'close')));
    })),
    field('Start timecode', h('input', { type: 'text', value: SC.tcStart || '01:00:00:00', 'aria-label': 'Start timecode',
      onchange: (e) => { const v = e.target.value.trim(); if (/^\d+:\d+:\d+:\d+$/.test(v)) { SC.tcStart = v; save(); renderPanel(); } else e.target.value = SC.tcStart; } })),
    field('Format', seg([['h3', 'H3'], ['ltx', 'LTX']], R.shotFmt === 'ltx' ? 'ltx' : 'h3', (v) => { R.shotFmt = v; store.set('deck.scene.shotfmt', v); renderPanel(); })),
    h('p', { class: 'prompt-out' }, text || '—'),
    warns.length ? h('p', { class: 'hint' }, warns.join(' ')) : null,
    h('div', { class: 'row wrap' },
      button('Copy', async () => {
        try { await navigator.clipboard.writeText(text); toast('Prompt copied'); } catch { toast('Copying isn\'t allowed here: select the text instead', true); }
      }, { disabled: !text }),
      C?.addToPrompt ? button('Add to Generate prompt', () => C.addToPrompt(text), { disabled: !text }) : null,
      button('To Story', () => toStory(), { disabled: !text })),
    help('The prompt uses times from the start of the clip (mm:ss.mmm). The chips show the edit timecode. H3 wants timestamps; LTX names the cut and leaves the time out.'));
}

async function toStory() {
  const list = shots().filter((s) => !off(s));
  if (!list.length) return;
  const keep = R.f, was = R.real;
  R.real = true;
  const rows = [];
  try {
    const { pose } = await import('./scene-view.js');
    const { clayBlob } = await import('./scene-export.js');
    for (const s of list) {
      const facts = shotFacts(s);
      const f = Math.round((s.f0 + s.f1) / 2);
      R.f = f; pose(f);
      let frame = null;
      try {
        const blob = await clayBlob();
        if (blob && C?.uploadImage) { const up = await C.uploadImage(blob, { source: 'scene', filename: `shot-${s.i}.png` }); frame = up.name; }
      } catch { /* the shot still goes across, without a frame */ }
      const body = lineOf(s, rows.length + 1);
      rows.push({ size: facts.size, angle: facts.angle, move: facts.move, dur: Math.max(1, Math.round((s.f1 - s.f0 + 1) / FPS)), what: body, frame });
    }
  } finally {
    R.real = was; R.f = keep;
    const { pose } = await import('./scene-view.js');
    pose(keep);
  }
  const { addBoardShots } = await import('./story.js');
  const { switchTab } = await import('./core.js');
  addBoardShots(rows);
  switchTab('story');
  toast(`${rows.length} shot${rows.length === 1 ? '' : 's'} added to the story`);
}
