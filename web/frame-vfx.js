// VFX on a video frame: the Make pane's VFX section. The VFX engine (vfx.js mountVfx) draws its panel into the pane and
// edits the frame's own VFX document (frame.vfx, a vfx-tabs doc made on first use, trashed with its table: store.py
// _owned_docs). While the frame is live its stage replaces the frame's viewer, so points, boxes and paths are placed on the
// frame itself; otherwise the panel works without a viewer and Open the frame shows it. Results land as clips on the
// frame's timeline (make-panel.js, vfx:queued) and stay in the document's Output as before.
//
//   showFrameVfx(host, frame)   the section for this frame into host (the Make pane calls it while VFX is chosen)
//   hideFrameVfx()              the engine back on the page's VFX tab
//   frameOfVfx(doc)             the frame a VFX document belongs to (where its results land)
import { h, api, toast, button, hint, openSheet, closeSheet, section, actions, uid } from './ui.js';
import { S, previewUrl } from './core.js';
import { isLive, liveFrame, liveRoot } from './live.js';
import { DOC_KIND } from './table-model.js';
import * as Table from './table.js';
import { sidebar } from './sidebar.js';
import { mountVfx, onSendToVfx, vfxFlush, vfxHome, vfxPause, vfxResize, vfxTabs } from './vfx.js';

const X = { frame: null, key: null, wrap: null, stage: null, panel: null, host: null, seq: 0, docs: new Map() };
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${kind}/${id}${qs()}`;

export const frameOfVfx = (doc) => (Table.tableFrames() || []).find((f) => f.vfx === doc) || X.docs.get(doc) || null;

// the clips on a video document's timeline that VFX can read (a run's clip or an imported one), with their trims
async function clipsOf(frame) {
  if (!frame.doc) return [];
  const vid = await import('./video.js');
  const t = vid.videoTabs?.();
  if (t?.active?.id === frame.doc) await t.flush();   // (the open edit's latest)
  const d = await api(`/api/store/${DOC_KIND.video}/${frame.doc}${qs()}`, { busy: false }).catch(() => null);
  return (d?.payload?.items || []).filter((it) => it.kind === 'video' && it.src && (it.src.generation != null || it.src.media)).map((it) => {
    const end = it.out ?? it.dur;
    return { it, src: { ...(it.src.generation != null ? { generation: it.src.generation, index: it.src.index || 0 } : { media: it.src.media }),
      ...(it.label && { label: it.label }), trim: { start: it.in || 0, ...(end ? { len: +(end - (it.in || 0)).toFixed(4) } : {}) } } };
  });
}

// Pick a clip: this frame's clips first, then the other video frames' on the table
async function pickClip(frame, set, title = 'Pick a clip') {
  const frames = [frame, ...(Table.tableFrames() || []).filter((f) => f.kind === 'video' && f.doc && f.id !== frame.id)];
  const groups = [];
  for (const f of frames) {
    const list = await clipsOf(f).catch(() => []);
    if (list.length) groups.push({ f, list });
  }
  if (!groups.length) return toast('No clips on the table\'s video frames yet: drop one on this frame first', true);
  const card = ({ it, src }) => h('button', { type: 'button', class: 'make-frame-card', onclick: () => { closeSheet(); set(src); } },
    it.thumb ? h('img', { src: it.thumb, alt: '' }) : src.generation != null ? h('img', { src: thumbOfRun(src), alt: '' }) : h('span', { class: 'hint' }, 'Clip'),
    h('span', {}, `${it.label || 'Clip'}${src.trim.len ? ` · ${src.trim.len.toFixed(1)}s` : ''}`));
  openSheet(h('h3', {}, title),
    ...groups.map(({ f, list }) => section(f === frame ? `${f.label || 'This frame'} (this frame)` : f.label || 'Video frame', null,
      h('div', { class: 'make-frame-list' }, list.map(card)))),
    actions(button('Cancel', closeSheet, { cls: 'small ghost' })));
}
const thumbOfRun = (src) => { const o = S.history.get(src.generation)?.outputs?.[src.index || 0]; return o?.url ? previewUrl(o.url, 160) : ''; };

// The frame's VFX document: made on first use with its first clip as the source. A duplicated frame still points at the
// original's: it gets its own copy here, so the two don't edit one document.
async function ensureDoc(frame) {
  const shared = frame.vfx && (Table.tableFrames() || []).some((f) => f !== frame && f.vfx === frame.vfx);
  if (frame.vfx && !shared) {
    const ok = await api(docUrl('vfx-tabs', frame.vfx), { busy: false }).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
    if (ok) return frame.vfx;
  }
  let payload = {};
  if (shared) payload = (await api(docUrl('vfx-tabs', frame.vfx), { busy: false }).catch(() => null))?.payload || {};
  else {
    const first = (await clipsOf(frame).catch(() => []))[0];
    if (first) payload = { source: first.src };
  }
  const id = uid() + uid();
  await api(docUrl('vfx-tabs', id), { method: 'PUT', body: { rev: 0, name: `${frame.label || 'Video'} · VFX`.slice(0, 120), payload: { ...payload, results: payload.results || [] } }, busy: false });
  frame.vfx = id;
  Table.frameChanged();   // (the table saves the frame with it)
  return id;
}

async function openDoc(id) {
  const tabs = vfxTabs();
  if (!tabs) throw new Error('the VFX engine is not ready');
  if (!tabs.started) await tabs.start(); else if (tabs.starting) await tabs.starting;
  for (let k = 0; k < 2 && tabs.active?.id !== id; k++) await tabs.switchTo(id);
  if (tabs.active?.id !== id) throw new Error('its VFX settings would not open');
}

// where the frame shows: its live root's own stage (the video's hidden meanwhile), else nowhere (a detached stage)
const liveHere = (frame) => isLive(frame.id) && !!liveRoot();
const onMake = () => sidebar.current?.() === 'make';

export async function showFrameVfx(host, frame) {
  const live = liveHere(frame) && onMake();
  const key = `${frame.id}:${live ? 'live' : 'flat'}`;
  if (X.key === key && X.frame === frame && X.host === host && host.contains(X.panel)) return;
  const my = ++X.seq;
  X.host = host; X.frame = frame;
  X.panel = h('div', { class: 'make-vfx-body' });
  const open = isLive(frame.id) ? null : h('div', { class: 'row wrap make-vfx-open' },
    button('Open the frame to place points', () => Table.goLive(frame), { cls: 'small', title: 'Points, boxes, paths and the colour pick go on the frame\'s picture' }));
  host.replaceChildren(...[open, X.panel].filter(Boolean));
  X.panel.replaceChildren(hint('Loading the frame\'s VFX…'));
  try {
    const id = await ensureDoc(frame);
    if (my !== X.seq) return;
    await openDoc(id);
    if (my !== X.seq) return;
    X.docs.set(id, frame);
    unstage();
    const tp = h('div', { class: 'transport' }), stage = h('div', { class: 'vfx-stage' });
    const wrap = h('div', { class: 'stage editor-stage vfx-frame-stage' }, h('div', { class: 'viewer' }, stage), tp);
    const placed = live && liveHere(frame);   // (still live after the awaits)
    if (placed) {
      const root = liveRoot();
      for (const el of root.children) if (el !== wrap) el.classList.add('vfx-under');
      root.append(wrap);
    }
    X.wrap = wrap; X.stage = stage; X.key = placed ? key : `${frame.id}:flat`;
    mountVfx({ host: wrap, stage, transport: tp, panel: X.panel, full: false,
      active: () => !!(X.frame && isLive(X.frame.id) && wrap.isConnected),
      pickClip: (set, title) => pickClip(frame, set, title),
      addClip: async (media) => {
        const { landClip } = await import('./make-panel.js');
        await landClip(frame, media);
      } });
    if (placed) requestAnimationFrame(vfxResize);
  } catch (e) {
    if (my !== X.seq) return;
    X.key = null;
    X.panel.replaceChildren(hint(`Couldn't open VFX here: ${e.message}`));
  }
}

// the frame's own stage away, the video's back
function unstage() {
  if (!X.wrap) return;
  const root = X.wrap.parentElement;
  X.wrap.remove();
  root?.querySelectorAll(':scope > .vfx-under').forEach((el) => el.classList.remove('vfx-under'));
  X.wrap = null; X.stage = null;
}

export function hideFrameVfx() {
  X.seq++;
  if (!X.frame && !X.wrap) return;
  vfxPause();
  unstage();
  X.frame = null; X.key = null; X.host = null; X.panel = null;
  vfxFlush().finally(() => { if (!X.frame) vfxHome(); });
}

// the Make pane hidden (another sidebar tab) while the frame is live: the video's viewer comes back; shown again: VFX's
sidebar.onShow?.((name) => {
  if (!X.frame || !X.host) return;
  if (name !== 'make' && !(X.wrap?.isConnected && X.wrap.parentElement === liveRoot())) return;
  X.key = null;
  showFrameVfx(X.host, X.frame);
});

// a live frame: once the video engine has put its stage in the root, VFX's goes over it (when VFX is on show)
addEventListener('table:live', (e) => {
  const f = e.detail?.frame;
  if (f?.kind !== 'video' || !X.frame || X.frame.id !== f.id || !X.host) return;
  const root = e.detail.root, t0 = performance.now();
  const wait = () => {
    if (!isLive(f.id) || !X.frame) return;
    if (!root.querySelector(':scope > .editor-stage:not(.vfx-frame-stage)') && performance.now() - t0 < 5000) { setTimeout(wait, 100); return; }
    X.key = null; showFrameVfx(X.host, X.frame);
  };
  setTimeout(wait, 0);
});
addEventListener('table:unlive', (e) => {
  if (!X.frame || e.detail?.frame?.id !== X.frame.id) return;
  vfxPause(); unstage(); X.key = null;
  e.detail.wait?.push(vfxFlush().catch(() => {}));
  setTimeout(() => { if (X.frame && X.host?.isConnected && !X.key) showFrameVfx(X.host, X.frame); }, 0);   // (flat, once it has let go)
});

// Clip tools → VFX on a live video frame: the frame's own VFX, with this clip as its source
onSendToVfx(async (src, { label, trim }) => {
  const f = isLive('video') ? liveFrame() : null;
  if (!f) return false;
  const { useVfxMode } = await import('./make-panel.js');
  useVfxMode(true);
  sidebar.show('make');
  await new Promise((r) => setTimeout(r, 50));
  if (X.frame?.id !== f.id) return false;
  await new Promise((r) => { const t0 = performance.now(); const k = () => (X.key || performance.now() - t0 > 4000 ? r() : setTimeout(k, 50)); k(); });
  if (!X.key) return false;
  const { setVfxSource } = await import('./vfx.js');
  setVfxSource({ ...src, ...(trim && { trim }), ...(label && { label }) });
  toast('Clip set as this frame\'s VFX source: pick an effect');
  return true;
});

