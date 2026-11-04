// A video frame on the table, live: the Video engine (video.js mountVideo) mounts inside the frame, its Clips pane
// goes in the sidebar, and its timeline in the drawer under the table. Letting go saves the edit and its still and
// puts the engine back on the page's Video tab. Also what happens when frames, or things from the Shelf or a picker
// (table:drop-frame sources), are dropped onto a video frame: pictures become picture clips, clips and sounds clips.
// The drawer (and the doc-editing helpers) are shared with frame-sound.js.
import { h, api, store, toast, uid, clone } from './ui.js';
import { S, inputUrl, thumbUrl } from './core.js';
import { isLive } from './live.js';
import { heightGrip } from './layout.js';
import { uploadImage } from './media.js';
import { DOC_KIND } from './table-model.js';
import { editDoc, putStill, sourceClip, sourcePicture, stillOf } from './table-frames.js';
import { sidebar } from './sidebar.js';
import { addToTimeline, mountVideo, newItem, renderVideo, setSequenceSize, videoStill, videoTabs, vidPause, wireVideoTransport } from './video.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;

// ---- the timeline drawer: a .timeline-wrap under the table's stage, one strip (tools + timeline) per engine ----
let DR = null;
export function drawer() {
  if (DR) return DR;
  const outer = document.querySelector('#tab-table .stage'), stage = outer?.querySelector('.table-stage');
  if (!stage) throw new Error('The table is not on the page');
  const pane = (kind) => {
    const tools = h('div', { class: 'tl-tools' }), tl = h('div', { class: `timeline ${kind === 'sound' ? 'snd-timeline' : ''}`.trim(), 'data-drawer': kind });
    return { kind, tools, tl, el: h('div', { class: 'tl-pane hidden' }, tools, tl) };
  };
  const panes = { video: pane('video'), sound: pane('sound') };
  const grip = h('div', { class: 'hsplit', role: 'separator', 'aria-label': 'Drag to resize the timeline', title: 'Drag to resize · double-tap to reset' });
  const el = h('div', { class: 'timeline-wrap tl-drawer hidden' }, grip, panes.video.el, panes.sound.el);
  const KEY = 'deck.split.table-drawer';
  const apply = (px) => { if (px) el.style.setProperty('--tl-h', `${px}px`); else el.style.removeProperty('--tl-h'); };
  apply(store.get(KEY, null));
  heightGrip(grip, {
    size: () => (panes.video.el.classList.contains('hidden') ? panes.sound : panes.video).tl.offsetHeight,
    set: (px) => { const v = px == null ? null : Math.max(60, px); apply(v); store.set(KEY, v); },
    max: () => innerHeight * 0.7 });
  stage.after(el);
  DR = { el, outer, panes,
    show(kind) {
      for (const k of Object.keys(panes)) panes[k].el.classList.toggle('hidden', k !== kind);
      el.classList.remove('hidden'); outer.classList.add('has-drawer');
    },
    hide() { el.classList.add('hidden'); outer.classList.remove('has-drawer'); for (const k of Object.keys(panes)) panes[k].el.classList.add('hidden'); } };
  return DR;
}

const trackEnd = (p, track) => (p.items || []).filter((i) => i.track === track).reduce((m, i) => Math.max(m, i.at + Math.max(0.1, (i.out ?? (i.dur || 3)) - i.in)), 0);

// Another document's clips as new tracks of this payload (src kept). toSound: only sound a sound edit can hold.
function copyClips(from, into, toSound) {
  const map = new Map();
  into.tracks ||= []; into.items ||= [];
  for (const it of from.items || []) {
    if (toSound ? !(it.kind === 'audio' || it.kind === 'video') : false) continue;
    const src = (from.tracks || []).find((t) => t.id === it.track);
    if (!map.has(it.track)) {
      const t = toSound ? { id: uid() } : { id: uid(), kind: src?.kind || (it.kind === 'audio' ? 'audio' : 'video') };
      into.tracks.push(t); map.set(it.track, t.id);
    }
    const c = clone(it);
    c.id = uid(); c.track = map.get(it.track);
    if (!toSound && it.kind === 'audio' && into.tracks.find((t) => t.id === c.track)?.kind !== 'audio') c.kind = 'audio';
    into.items.push(c);
  }
  return map.size;
}

// The first video track of a payload (one made if it has none)
function videoTrack(payload) {
  let tr = (payload.tracks || []).find((t) => t.kind === 'video');
  if (!tr) (payload.tracks ||= []).push(tr = { id: uid(), kind: 'video' });
  return tr;
}
// an item at the end of its track
function append(payload, it) {
  it.at = trackEnd(payload, it.track);
  (payload.items ||= []).push(it);
}
// A picture frame's still as an input of the project (uploaded now), then a change that adds it as a picture clip at the
// end of the first video track
async function pictureClip(f) {
  const url = stillOf(f) || f.preview;
  if (!url) throw new Error(`"${f.label}" has no picture yet: open it once`);
  const blob = await (await fetch(url)).blob();
  const r = await uploadImage(blob, { mp: 0, source: 'table', filename: 'frame.png' });
  const m = { kind: 'image', src: { input: r.name }, url: inputUrl(r.name), thumb: thumbUrl(r.name, 160), label: f.label || r.name };
  return (payload) => append(payload, newItem(m, videoTrack(payload).id));
}
async function sceneClip(f) {
  const d = await api(docUrl('scene', f.doc), { busy: false }), p = d.payload || {};
  const m = { kind: 'scene', src: { scene: f.doc, look: 'color' }, label: d.name || f.label, dur: p.seconds || 6, nat: [p.width || 768, p.height || 448] };
  return (payload) => append(payload, newItem(m, videoTrack(payload).id));
}

// a dropped thing as the media a timeline takes: a clip or a sound, or (not for a sound frame) a picture
export async function sourceMedia(src, toSound = false) {
  const c = await sourceClip(src);
  if (c) return c;
  const p = toSound ? null : await sourcePicture(src);
  return p ? { kind: 'image', src: { input: p.name }, url: inputUrl(p.name), thumb: thumbUrl(p.name, 160), label: p.label || p.name } : null;
}
// media at the end of the payload's first track that takes it (a sound edit's tracks take anything it can hear)
function pushMedia(payload, m, toSound) {
  const want = m.kind === 'audio' ? 'audio' : 'video';
  let tr = (payload.tracks || []).find((t) => (toSound ? true : t.kind === want));
  if (!tr) (payload.tracks ||= []).push(tr = toSound ? { id: uid() } : { id: uid(), kind: want });
  append(payload, toSound
    ? { id: uid(), track: tr.id, kind: m.kind === 'video' ? 'video' : 'audio', src: m.src, url: m.url, label: m.label, dur: m.dur || 0, at: 0, in: 0, out: m.dur || null,
      volume: 1, pan: 0, fadeIn: 0, fadeOut: 0 }
    : newItem(m, tr.id));
}

// frames dropped on a video or sound frame: their clips join its edit; so do d.sources (things from the Shelf, a picker
// or the computer). `engine` is the open tab set of that kind. Everything is uploaded and read first, then the edit is
// changed in one save (editDoc may run the change twice; the uploads must not).
export async function dropOnto(d, kind, engine) {
  const onto = d.onto, from = (d.from || []).filter((f) => f.id !== onto.id && f.kind !== 'note');
  if (!onto.doc) { toast('That frame has no document yet', true); return; }
  const toSound = kind === 'sound', preps = [];
  for (const src of d.sources || []) {
    preps.push(async () => {
      const m = await sourceMedia(src, toSound);
      if (!m) throw new Error(toSound ? 'only a sound or a clip can go on a sound frame' : 'that can\'t go on a timeline');
      return (p) => pushMedia(p, m, toSound);
    });
  }
  for (const f of from) {
    if (f.kind === 'image' && !toSound) preps.push(() => pictureClip(f));
    else if (f.kind === 'scene' && !toSound) preps.push(() => sceneClip(f));
    else if ((f.kind === 'video' || f.kind === 'sound') && f.doc) {
      preps.push(async () => {
        const src = f.kind === 'video' ? videoTabs() : (await import('./sound.js')).soundTabs();
        if (src?.active?.id === f.doc) await src.flush();   // (an open edit's latest changes first)
        const doc = await api(docUrl(f.kind, f.doc), { busy: false }), from = doc.payload || {};
        if (!copyClips(from, {}, toSound)) throw new Error(`"${f.label}" has nothing ${toSound ? 'to hear' : 'on its timeline'} yet`);
        return (p) => copyClips(from, p, toSound);
      });
    } else toast(`A ${f.kind} frame can't go on a ${kind} frame`, true);
  }
  if (!preps.length) return;
  const changes = [];
  for (const prep of preps) {
    try { changes.push(await prep()); } catch (e) { toast(`Couldn't add to "${onto.label}": ${e.message}`, true); }
  }
  if (!changes.length) return;
  try {
    if (engine?.active?.id === onto.doc) await engine.flush();   // (so the edit's own changes are not lost to a stale rev)
    await editDoc(kind, onto.doc, (p) => { for (const c of changes) c(p); });
    toast(changes.length > 1 ? `Added ${changes.length} things to "${onto.label}"` : `Added to "${onto.label}"`);
  } catch (e) { toast(`Couldn't add to "${onto.label}": ${e.message}`, true); }
}

// ---- live ----
let cur = null;   // { frame, root, dead, pane }
addEventListener('table:live', (e) => {
  const d = e.detail;
  if (d.frame.kind !== 'video') return;
  d.handled = true;
  goLiveVideo(d.frame, d.root).catch((err) => { console.error(err); toast(`Couldn't open the video: ${err.message}`, true); });
});

async function goLiveVideo(frame, root) {
  const my = cur = { frame, root, dead: false, pane: null };
  const tabs = videoTabs();
  if (!tabs) throw new Error('the Video engine is not ready');
  await tabs.ready();
  if (my.dead) return;
  if (!frame.doc) throw new Error('this frame has no edit yet');
  for (let k = 0; k < 2 && tabs.active?.id !== frame.doc; k++) { await tabs.switchTo(frame.doc); if (my.dead) return; }   // (switchTo gives up quietly when it is raced)
  if (tabs.active?.id !== frame.doc) throw new Error('the edit would not open');
  const canvas = h('canvas', { class: 'vid-canvas' }), empty = h('div', { class: 'placeholder' }, 'Add clips, images or sound to the timeline');
  const bar = h('div', { class: 'transport' });
  root.append(h('div', { class: 'stage editor-stage' }, h('div', { class: 'viewer' }, canvas, empty), bar));
  const dr = drawer(), pane = my.pane = sidebar.pane('layers', { title: 'Clips', icon: 'film', host: false });
  dr.show('video');
  mountVideo({ host: root, canvas, empty, transport: bar, panel: pane, tlTools: dr.panes.video.tools, timeline: dr.panes.video.tl,
    active: () => isLive(frame.id) });   // (its full screen is the frame's own: the mount is outside the table's zoom)
  if (frame.w && frame.h) setSequenceSize(frame.w, frame.h);
  renderVideo();
  sidebar.refresh(); sidebar.show('layers');
}

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail, my = cur;
  if (frame.kind !== 'video' || !my || my.frame.id !== frame.id) return;
  cur = null; my.dead = true;
  e.detail.wait?.push(leaveVideo(my).catch((err) => console.error(err)));   // (the table waits for the save before trashing the edit)
});

async function leaveVideo(my) {
  vidPause();
  const mounted = !!my.pane, tabs = videoTabs(), id = my.frame.doc;
  const still = mounted ? videoStill() : null;   // (drawn now, while the canvas is still the frame's)
  if (mounted) { drawer().hide(); wireVideoTransport(); my.pane.replaceChildren(); }   // the page's Video tab has the engine again
  if (!mounted || !id) return;
  const ok = await tabs.flush();
  const blob = await still;
  if (ok || !tabs.conflict) await putStill('video', id, blob);
}

addEventListener('table:drop-frame', (e) => {
  const d = e.detail;
  if (d.handled || d.onto.kind !== 'video') return;
  d.handled = true;
  const from = d.from || [], sources = d.sources || [];
  const imagesOnly = from.every((f) => f.kind === 'image') && (from.length || sources.length);
  if (imagesOnly && videoTabs()?.active?.id === d.onto.doc && isLive(d.onto.id)) {   // live: onto the timeline as the Clips pane does
    (async () => {
      for (const src of sources) {
        try {
          const m = await sourceMedia(src);
          if (m) await addToTimeline(m); else toast('That can\'t go on a timeline', true);
        } catch (err) { toast(`Couldn't add it: ${err.message}`, true); }
      }
      for (const f of from) {
        try {
          const url = stillOf(f) || f.preview;
          if (!url) { toast(`"${f.label}" has no picture yet: open it once`, true); continue; }
          const r = await uploadImage(await (await fetch(url)).blob(), { mp: 0, source: 'table', filename: 'frame.png' });
          await addToTimeline({ kind: 'image', src: { input: r.name }, url: inputUrl(r.name), thumb: thumbUrl(r.name, 160), label: f.label || r.name });
        } catch (err) { toast(`Couldn't add "${f.label}": ${err.message}`, true); }
      }
    })();
    return;
  }
  dropOnto(d, 'video', videoTabs());
});
