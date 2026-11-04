// A video frame on the table, live: the Video engine (video.js mountVideo) mounts inside the frame, its Clips pane
// goes in the sidebar, and its timeline in the drawer under the table. Letting go saves the edit and its still and
// puts the engine back on the page's Video tab. Also what happens when frames are dropped onto a video frame.
// The drawer (and the doc-editing helpers) are shared with frame-sound.js.
import { h, api, store, toast, uid, clone } from './ui.js';
import { S, inputUrl, thumbUrl } from './core.js';
import { isLive } from './live.js';
import { heightGrip } from './layout.js';
import { uploadImage } from './media.js';
import { refreshStills } from './table.js';
import { DOC_KIND } from './table-model.js';
import { stillOf } from './table-frames.js';
import { sidebar } from './sidebar.js';
import { addToTimeline, mountVideo, newItem, renderVideo, setSequenceSize, videoStill, videoTabs, vidPause, wireVideoTransport } from './video.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id, tail = '') => `/api/store/${DOC_KIND[kind]}/${id}${tail}${qs()}`;

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

// ---- stills ----
async function shrink(blob, max = 1024) {   // (a frame's still is a thumbnail, not the sequence's full size)
  try {
    const bmp = await createImageBitmap(blob), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1) return blob;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return (await new Promise((res) => cv.toBlob(res, 'image/png'))) || blob;
  } catch { return blob; }
}
// PUT a document's still (null: it has nothing to show, so it keeps none)
export async function putStill(kind, id, blob) {
  const url = docUrl(kind, id, '/still');
  try {
    if (!blob) await fetch(url, { method: 'DELETE' });
    else {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: await shrink(blob) });
      if (!r.ok && r.status !== 404) console.warn('still not saved:', r.status);   // 404: the document is gone
    }
  } catch { /* offline: the next time it is open */ }
  refreshStills([kind]).catch(() => {});   // (the table asked once as the frame let go, before this one was saved)
}

// ---- documents edited from outside (a drop on a frame that isn't open) ----
// Fetch, change, PUT with the rev we read; a stale rev (409) is read again once.
export async function editDoc(kind, id, mutate) {
  for (let again = false; ; again = true) {
    const d = await api(docUrl(kind, id), { busy: false }), payload = clone(d.payload || {});
    await mutate(payload);
    try { await api(docUrl(kind, id), { method: 'PUT', body: { rev: d.rev, name: d.name, payload }, busy: false }); return; }
    catch (e) { if (e.status !== 409 || again) throw e; }
  }
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

// A picture frame's still as an input of the project, then a picture clip at the end of the first video track
async function pictureClip(f, payload) {
  const url = stillOf(f) || f.preview;
  if (!url) throw new Error(`"${f.label}" has no picture yet: open it once`);
  const blob = await (await fetch(url)).blob();
  const r = await uploadImage(blob, { mp: 0, source: 'table', filename: 'frame.png' });
  let tr = (payload.tracks || []).find((t) => t.kind === 'video');
  if (!tr) (payload.tracks ||= []).push(tr = { id: uid(), kind: 'video' });
  const it = newItem({ kind: 'image', src: { input: r.name }, url: inputUrl(r.name), thumb: thumbUrl(r.name, 160), label: f.label || r.name }, tr.id);
  it.at = trackEnd(payload, tr.id);
  (payload.items ||= []).push(it);
}
async function sceneClip(f, payload) {
  const d = await api(docUrl('scene', f.doc), { busy: false }), p = d.payload || {};
  let tr = (payload.tracks || []).find((t) => t.kind === 'video');
  if (!tr) (payload.tracks ||= []).push(tr = { id: uid(), kind: 'video' });
  const it = newItem({ kind: 'scene', src: { scene: f.doc, look: 'color' }, label: d.name || f.label, dur: p.seconds || 6, nat: [p.width || 768, p.height || 448] }, tr.id);
  it.at = trackEnd(payload, tr.id);
  (payload.items ||= []).push(it);
}

// frames dropped on a video or sound frame: their clips join its edit. `engine` is the open tab set of that kind.
export async function dropOnto(d, kind, engine) {
  const onto = d.onto, from = (d.from || []).filter((f) => f.id !== onto.id && f.kind !== 'note');
  if (!onto.doc) { toast('That frame has no document yet', true); return; }
  const toSound = kind === 'sound', jobs = [];
  for (const f of from) {
    if (f.kind === 'image' && !toSound) jobs.push({ f, run: (p) => pictureClip(f, p) });
    else if (f.kind === 'scene' && !toSound) jobs.push({ f, run: (p) => sceneClip(f, p) });
    else if ((f.kind === 'video' || f.kind === 'sound') && f.doc) {
      jobs.push({ f, run: async (p) => {
        const src = f.kind === 'video' ? videoTabs() : (await import('./sound.js')).soundTabs();
        if (src?.active?.id === f.doc) await src.flush();   // (an open edit's latest changes first)
        const doc = await api(docUrl(f.kind, f.doc), { busy: false });
        if (!copyClips(doc.payload || {}, p, toSound)) throw new Error(`"${f.label}" has nothing ${toSound ? 'to hear' : 'on its timeline'} yet`);
      } });
    } else toast(`A ${f.kind} frame can't go on a ${kind} frame`, true);
  }
  if (!jobs.length) return;
  try {
    if (engine?.active?.id === onto.doc) await engine.flush();   // (so the edit's own changes are not lost to a stale rev)
    await editDoc(kind, onto.doc, async (p) => { for (const j of jobs) await j.run(p); });
    toast(jobs.length > 1 ? `Added ${jobs.length} frames to "${onto.label}"` : `Added to "${onto.label}"`);
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
  const dr = drawer(), pane = my.pane = sidebar.pane('layers', { title: 'Clips', icon: 'film', host: false, when: (c) => c.live?.kind === 'video' });
  dr.show('video');
  mountVideo({ host: root, canvas, empty, transport: bar, panel: pane, tlTools: dr.panes.video.tools, timeline: dr.panes.video.tl,
    active: () => isLive(frame.id), fullscreen: false });
  if (frame.w && frame.h) setSequenceSize(frame.w, frame.h);
  renderVideo();
  sidebar.refresh(); sidebar.show('layers');
}

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail, my = cur;
  if (frame.kind !== 'video' || !my || my.frame.id !== frame.id) return;
  cur = null; my.dead = true;
  leaveVideo(my).catch((err) => console.error(err));
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
  const imagesOnly = d.from.length && d.from.every((f) => f.kind === 'image');
  if (imagesOnly && videoTabs()?.active?.id === d.onto.doc && isLive(d.onto.id)) {   // live: onto the timeline as the Clips pane does
    (async () => {
      for (const f of d.from) {
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
