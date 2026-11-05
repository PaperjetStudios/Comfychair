// A sound frame on the table, live: the Sound engine (sound.js mountSound) mounts inside the frame, its Tracks pane
// goes in the sidebar, its timeline in the table's drawer (frame-video.js builds it). Letting go saves the mix and its
// still and gives the engine back to the page's Sound tab. Frames dropped on a sound frame add their sound to it, as do
// sounds and clips from the Shelf or a picker (table:drop-frame sources, frame-video.js dropOnto). Its output (level,
// loudness, format) and Export are a section of the Frame pane; an export, or a clip's sound saved, is a new sound frame.
import { h, api, toast, button, field, rangeField, section, seg, toggle } from './ui.js';
import { S } from './core.js';
import { icon } from './icons.js';
import { isLive, liveFrame } from './live.js';
import { selectedFrames } from './table.js';
import { sidebar } from './sidebar.js';
import { drawer, dropOnto } from './frame-video.js';
import { editDoc, putStill } from './table-frames.js';
import { mountSound, openMixItems, renderMix, renderSound, setOut, sndPause, soundStill, soundTabs, wireSound } from './sound.js';

let cur = null;   // { frame, root, dead, pane }
addEventListener('table:live', (e) => {
  const d = e.detail;
  if (d.frame.kind !== 'sound') return;
  d.handled = true;
  goLiveSound(d.frame, d.root).catch((err) => { console.error(err); toast(`Couldn't open the sound: ${err.message}`, true); });
});

async function goLiveSound(frame, root) {
  const my = cur = { frame, root, dead: false, pane: null };
  const tabs = soundTabs();
  if (!tabs) throw new Error('the Sound engine is not ready');
  await tabs.ready();
  if (my.dead) return;
  if (!frame.doc) throw new Error('this frame has no mix yet');
  for (let k = 0; k < 2 && tabs.active?.id !== frame.doc; k++) { await tabs.openQuiet(frame.doc); if (my.dead) return; }
  if (tabs.active?.id !== frame.doc) throw new Error('the mix would not open');
  const canvas = h('canvas', { class: 'snd-canvas', 'aria-label': 'The whole mix: tap to move the playhead, drag a clip to move or trim it' });
  const empty = h('div', { class: 'placeholder' }, 'Add sounds');
  const bar = h('div', { class: 'transport' });
  root.append(h('div', { class: 'stage editor-stage' }, h('div', { class: 'viewer snd-viewer' }, canvas, empty), bar));
  const dr = drawer(), pane = my.pane = sidebar.pane('layers', { title: 'Tracks', icon: 'sound', host: false });
  dr.show('sound');
  mountSound({ host: root, canvas, empty, transport: bar, tools: dr.panes.sound.tools, timeline: dr.panes.sound.tl, panel: pane,
    active: () => isLive(frame.id) });   // (its full screen is the frame's own: the mount is outside the table's zoom)
  renderSound();
  sidebar.refresh(); sidebar.show('layers');
}

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail, my = cur;
  if (frame.kind !== 'sound' || !my || my.frame.id !== frame.id) return;
  cur = null; my.dead = true;
  e.detail.wait?.push(leaveSound(my).catch((err) => console.error(err)));   // (the table waits for the save before trashing the mix)
});

async function leaveSound(my) {
  sndPause();
  if (!my.pane) return;
  const tabs = soundTabs(), id = my.frame.doc;
  const still = soundStill();   // (drawn now, while the canvas is still the frame's)
  drawer().hide(); wireSound(); my.pane.replaceChildren();
  const ok = await tabs.flush();
  const blob = await still;
  if (ok || !tabs.conflict) await putStill('sound', id, blob);
}

addEventListener('table:drop-frame', (e) => {
  const d = e.detail;
  if (d.handled || d.onto.kind !== 'sound') return;
  d.handled = true;
  dropOnto(d, 'sound', soundTabs());
});

// ---- a sound file made from a frame (Export, Save its sound): a new sound frame beside it holds it ----
// source: the frame it was made from (default the live one). Returns the new frame, or null.
export async function soundFrameFor(m, label, source = liveFrame()) {
  if (!source) { toast(`${m.label}: in the media library`); return null; }
  const { resultFrame } = await import('./table-frames.js');
  const Table = await import('./table.js');
  const f = await resultFrame(Table.frameById(source.id) || source, { kind: 'sound', label });
  if (!f) { toast(`${m.label}: in the media library (no new frame for it)`, true); return null; }
  if (!Table.dropOntoFrame(f, [{ media: m.name, kind: 'audio', label: m.label, url: m.url }])) toast('The sound couldn\'t go in the new frame', true);
  else toast(`${m.label}: in ${f.label}`);
  return f;
}

// ---- the Frame pane's Output section for one sound frame: its mix's level, loudness and format, and Export ----
// The settings are the mix's own (payload.out): the open mix's when the frame is live (sound.js setOut), else saved
// into its document. Export mixes it (the work area of the open mix; all of it otherwise) into a new sound frame.
const OUT_FORMATS = [['m4a', 'M4A'], ['wav', 'WAV'], ['mp3', 'MP3'], ['flac', 'FLAC']];
const openHere = (f) => isLive(f.id) && soundTabs()?.active?.id === f.doc;
async function outOf(f) {
  if (openHere(f)) return setOut({});
  const d = await api(`/api/store/sound-tabs/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false });
  return { gain: 1, normalize: false, format: 'm4a', ...(d.payload?.out || {}) };
}
async function setOutOf(f, patch) {
  if (openHere(f)) return setOut(patch);
  await editDoc('sound', f.doc, (p) => { p.out = { ...(p.out || {}), ...patch }; });
  return null;
}
async function exportFrame(f, btn) {
  btn.disabled = true;
  try {
    let got;
    if (openHere(f)) {
      got = openMixItems();
      if (got.why) throw new Error(got.why);
      await soundTabs().flush();
    } else {
      const d = await api(`/api/store/sound-tabs/${f.doc}${S.project != null ? `?project_id=${S.project}` : ''}`, { busy: false });
      const p = d.payload || {};
      if (!p.items?.length) throw new Error('Add some sound first');
      got = { payload: p, items: p.items };
    }
    const m = await renderMix(got.payload, { name: f.label || 'mix', items: got.items });
    await soundFrameFor(m, `${f.label || 'Mix'} · export`, f);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
}
sidebar.addTo('frame', (el) => {
  const sel = selectedFrames() || [], f = sel.length === 1 ? sel[0] : null;
  const had = el.querySelector(':scope > .frame-out');
  if (had && had.dataset.frame === (f?.kind === 'sound' && f.doc ? f.id : '')) return;   // (already there: its own insert calls this again)
  had?.remove();
  if (!f || f.kind !== 'sound' || !f.doc) return;
  const body = h('div', { class: 'frame-out-body' }, h('span', { class: 'hint' }, 'Loading…'));
  const sec = section('Output', null, body);
  sec.classList.add('frame-out'); sec.dataset.frame = f.id;
  el.append(sec);
  outOf(f).then((o) => {
    const save = (patch) => { Object.assign(o, patch); setOutOf(f, patch).catch((e) => toast(e.message, true)); };
    const btn = button([icon('download'), 'Export'], () => exportFrame(f, btn), { cls: 'primary', title: 'Mix it into one sound file, in a new sound frame beside this one' });
    body.replaceChildren(
      rangeField('Output level', () => o.gain ?? 1, (v) => { o.gain = v; }, { min: 0, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, onChange: () => save({ gain: o.gain }) }),
      toggle('Even out the loudness (−16 LUFS)', !!o.normalize, (on) => save({ normalize: on })),
      field('Format', seg(OUT_FORMATS, o.format || 'm4a', (v) => save({ format: v }))),
      btn);
  }).catch((e) => body.replaceChildren(h('span', { class: 'hint' }, `Couldn't read the mix: ${e.message}`)));
});
