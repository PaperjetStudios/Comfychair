// What an edit of a frame from the table works on, without the frame being open: an image frame's picture as one of the
// project's pictures, and a video or sound frame's first clip. The Make pane (make-panel.js), the Edit pane and the frame
// menu take their source from here.
//
//   frameSource(frame, { multiple = 1 })  → { name, px: [w, h], rect, copy: true, layer: null, was: null, mask: null }
//       the frame's picture uploaded as a new input (copy: the caller drops it once nothing needs it), and where it sits
//       on the frame's canvas (rect, canvas pixels: what a result placed at it covers). The live editor's composite when
//       the frame is open; else its edit drawn off screen at full size (frame-image.js drawOffscreen) when no image frame
//       is live; else its saved still (at most 1024 px). Throws when the frame is empty.
//   framePicture(frame)                   → the same picture as a Blob (null when empty), with its rect: { blob, rect }
//   frameImage(frame, { multiple })       → { name, fresh }: a wire's picture. A source picture (one plain layer, whole) passes
//       through as its own input at full size (fresh: false: not a copy, the caller never drops it); else frameSource's copy
//   frameStill(frame, pick)               → a video frame's picture at 'first' | 'last' | 'playhead' | seconds, as a new input
//   frameVideo(frame)                     → a video frame as a clip source { generation, index } | { media } (+ trim): one plain
//       clip passes through with its trim; any other edit is rendered (POST /api/video/render) and kept as frame.render
//   frameAudio(frame)                     → a sound (or video) frame's sound as a source + trim; a mix is rendered and kept
//   frameClip(frame)                      → a video (or sound) frame's first clip, by its place on the timeline:
//       { kind, src, url, label, dur, item, trim: { start, len? } }, or null when it has none
//
// A frame's main source (frame.main, main-rules.js): while one layer / clip / item is pinned, all of the above give it alone.
// An image frame's pinned layer that is its own file as it shows (main-rules plainLayer) goes as that file at full size
// (frameImage passes it straight through; frameSource and framePicture copy it); any other layer is drawn alone (the
// editor's composeLayer: live, else off screen; with another image frame live, its file as it is). Its rect is the layer's
// box on the canvas, so a result placed there sits over it. A video or sound frame's pinned clip goes with its trim (never
// the rendered whole edit). A pin whose layer or clip is gone counts as none.
// without (framePicture / frameSource, no pin set): layer keys left out of the picture (make-panel.js leaves out what the
// frame's last chain run made, frame.make.ran.made, so a rerun doesn't read its own last result).
import { api } from './ui.js';
import { CURRENT_EDIT, S, inputUrl } from './core.js';
import { clipUrl, pngBlob, uploadImage } from './media.js';
import { isLive } from './live.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND } from './table-model.js';
import { canvasRect, itemSource, plainFills, plainPicture, plainSound, plainVideo, renderKey } from './make-rules.js';
import { mainOf, plainLayer, withoutMade } from './main-rules.js';
import { bounds as layerBounds } from './layer-geom.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;

// the editor, when it has this frame's edit open (live on the table)
const liveEngine = (frame) => {
  const eng = CURRENT_EDIT.eng;
  return isLive(frame.id) && eng?.E?.tab?.id === frame.doc ? eng : null;
};
// skip: layer keys left out (when that leaves nothing, the whole picture)
const composed = (eng, skip = null) => {
  const cv = document.createElement('canvas');
  return (skip?.length && eng.compose(cv, false, 1, { skip })) || eng.compose(cv) ? pngBlob(cv) : null;
};
// where the composite sits on the canvas: the editor's frame, a fitted frame's last layer box, else the canvas
const rectOf = async (frame, eng, payload) => {
  const r = eng?.frame?.();
  if (r) return { x: r.x, y: r.y, w: r.w, h: r.h };
  if (frame.fit && frame.fitBox) return { ...frame.fitBox };
  if (payload === undefined) payload = (await api(docUrl('image', frame.doc), { busy: false }).catch(() => null))?.payload;
  return canvasRect(payload, frame);
};

// ---- an image frame's pinned layer (frame.main) ----
// { l, layers, eng? }: from the open editor when the frame is live, else from its saved edit; null: no pin, or its layer is gone
async function pinnedLayer(frame) {
  if (!frame?.main || frame.kind !== 'image' || !frame.doc) return null;
  const eng = liveEngine(frame);
  if (eng) { const l = mainOf(frame, { layers: eng.E.layers }); return l ? { l, layers: eng.E.layers, eng } : null; }
  const p = (await api(docUrl('image', frame.doc), { busy: false }).catch(() => null))?.payload;
  const l = mainOf(frame, p);
  return l ? { l, layers: p.layers } : null;
}
const sizeOf = (url) => new Promise((done) => {
  const im = new Image();
  im.onload = () => done([im.naturalWidth, im.naturalHeight]);
  im.onerror = () => done(null);
  im.src = url;
});
// A saved image edit that is one plain picture filling its canvas (make-rules plainPicture, plainFills): that picture's input
// name, else null
async function plainFile(payload) {
  const name = plainPicture(payload);
  return name && plainFills(payload, await sizeOf(inputUrl(name))) ? name : null;
}
const drawnAlone = async (eng, l) => {
  const cv = document.createElement('canvas'), rect = eng.composeLayer?.(cv, l);
  return rect ? { blob: await pngBlob(cv), rect } : null;
};
// The pinned layer as a picture: { blob, rect, plain (its input name when it went as its own file) }, or null
async function pinnedPicture(frame, pin) {
  const plain = plainLayer(pin.l, pin.layers);
  if (!plain) {
    if (pin.eng) {
      await pin.eng.paint?.savePaint?.();
      const got = await drawnAlone(pin.eng, pin.l);
      if (got) return got;
    } else if (!isLive('image')) {   // (drawn off screen, as framePicture draws the whole edit)
      try {
        const { drawOffscreen } = await import('./frame-image.js');
        if (await drawOffscreen(frame.doc)) {
          const eng = CURRENT_EDIT.eng, l = eng?.E?.tab?.id === frame.doc ? mainOf(frame, { layers: eng.E.layers }) : null;
          const got = l && eng.ready?.(l) ? await drawnAlone(eng, l) : null;
          if (got) return got;
        }
      } catch (e) { console.warn('drawn off screen:', e); }
    }
  }
  const name = pin.l.name;   // (its own file: plain, or the known limit while another image frame is live)
  if (!name) return null;
  const r = await fetch(inputUrl(name));
  if (!r.ok) return null;
  const blob = await r.blob();
  let rect = null;
  if (pin.eng?.ready?.(pin.l)) rect = layerBounds(pin.l);
  else { const wh = await sizeOf(inputUrl(name)); if (wh) rect = layerBounds({ ...pin.l, img: null, w: wh[0], h: wh[1] }); }
  if (rect) rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  return { blob, rect: rect || await rectOf(frame, pin.eng || null), plain };
}

export async function framePicture(frame, { without = null } = {}) {
  if (frame?.kind !== 'image' || !frame.doc) return null;
  const pin = await pinnedLayer(frame);
  if (pin) {
    const got = await pinnedPicture(frame, pin);
    if (got) return { blob: got.blob, rect: got.rect };
  }
  const skip = !pin && without?.length ? without : null;
  let eng = liveEngine(frame);
  if (eng) {
    await eng.paint?.savePaint?.();
    const blob = await composed(eng, skip);
    return blob ? { blob, rect: await rectOf(frame, eng) } : null;
  }
  const d = await api(docUrl('image', frame.doc), { busy: false }).catch(() => null);
  if (!d?.payload?.layers?.length) return null;
  const left = skip ? await plainFile(withoutMade(d.payload, skip)) : null;   // (what is left once the last run's results are out: one plain picture)
  if (left) {
    const r = await fetch(inputUrl(left));
    if (r.ok) return { blob: await r.blob(), rect: await rectOf(frame, null, d.payload) };
  }
  if (!isLive('image')) {   // (full size: the edit opened in the editor off screen, as a drop on a closed frame does)
    try {
      const { drawOffscreen } = await import('./frame-image.js');
      if (await drawOffscreen(frame.doc)) {
        eng = CURRENT_EDIT.eng;
        if (eng?.E?.tab?.id === frame.doc) {
          const blob = await composed(eng, skip);
          if (blob) return { blob, rect: await rectOf(frame, eng) };
        }
      }
    } catch (e) { console.warn('drawn off screen:', e); }
  }
  const url = stillOf(frame) || d.still?.url;
  if (!url) return null;
  const r = await fetch(url);
  return r.ok ? { blob: await r.blob(), rect: await rectOf(frame, null, d.payload) } : null;
}

export async function frameSource(frame, { multiple = 1, without = null } = {}) {
  const got = await framePicture(frame, { without });
  if (!got) throw new Error(`${frame?.label || 'That frame'} is empty`);
  const up = await uploadImage(got.blob, { source: 'frame', mp: 0, filename: 'frame.png', multiple });
  return { name: up.name, px: [up.width, up.height], rect: got.rect, copy: true, layer: null, was: null, mask: null };
}

export async function frameClip(frame) {
  if (!frame?.doc || (frame.kind !== 'video' && frame.kind !== 'sound')) return null;
  if (frame.kind === 'video') {   // (the open edit's latest)
    const t = (await import('./video.js')).videoTabs?.();
    if (t?.active?.id === frame.doc) await t.flush?.();
  }
  const d = await api(docUrl(frame.kind, frame.doc), { busy: false }).catch(() => null);
  const want = frame.kind === 'video' ? 'video' : 'audio';
  const its = (d?.payload?.items || []).filter((it) => it.kind === want && it.src).sort((a, b) => (a.at || 0) - (b.at || 0));
  const pin = mainOf(frame, d?.payload);   // (the frame's main source, when it is a clip of that kind)
  const it = pin && pin.kind === want && pin.src ? pin : its[0];
  if (!it) return null;
  const src = it.src.generation != null ? { generation: it.src.generation, index: it.src.index || 0 } : it.src.media ? { media: it.src.media } : { ...it.src };
  const end = it.out ?? it.dur, start = it.in || 0;
  return { kind: want, src, url: clipUrl(it.src) || it.url || null, label: it.label || null, dur: it.dur || 0, item: it,
    trim: { start, ...(end ? { len: +(end - start).toFixed(4) } : {}) } };
}

// ---------------------------------------------------------------------------
// what a wire carries (make-panel.js resolves its wires with these at Run)
// ---------------------------------------------------------------------------
const savedDoc = (frame) => api(docUrl(frame.kind, frame.doc), { busy: false }).catch(() => null);
// the open edit's latest, when this frame is open on the table
async function flushed(frame) {
  if (!isLive(frame.id)) return;
  const mod = frame.kind === 'sound' ? await import('./sound.js') : frame.kind === 'video' ? await import('./video.js') : null;
  const t = frame.kind === 'sound' ? mod?.soundTabs?.() : mod?.videoTabs?.();
  if (t?.active?.id === frame.doc) await t.flush?.();
}

// A picture for a wire. fresh: true is a new input the caller owns (drops after the run, or on a failed run).
export async function frameImage(frame, { multiple = 16 } = {}) {
  if (frame?.kind === 'image') {
    const pin = frame.main ? await pinnedLayer(frame) : null;
    if (pin) {   // (the main source: its own file straight through, else drawn alone, below)
      const name = plainLayer(pin.l, pin.layers);
      if (name) return { name, fresh: false };
    } else if (frame.doc && !isLive(frame.id)) {
      const name = await plainFile((await savedDoc(frame))?.payload);
      if (name) return { name, fresh: false };
    }
    return { name: (await frameSource(frame, { multiple })).name, fresh: true };
  }
  const url = frame ? stillOf(frame) || frame.preview : null;   // (a 3D frame: the still it shows)
  if (!url) throw new Error(`${frame?.label || 'That frame'} has no picture yet`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${frame.label || 'That frame'}'s picture can't be read`);
  return { name: (await uploadImage(await r.blob(), { source: 'frame', mp: 0, filename: 'frame.png', multiple })).name, fresh: true };
}

// ---- the cached render of a whole edit, on the source frame: frame.render = { generation | media, key } ----
const keepRender = async (frame, render) => {
  const T = await import('./table.js').catch(() => null);
  const live = T?.frameById?.(frame.id) || frame;
  live.render = render;
  if (live !== frame) frame.render = render;
  T?.frameChanged?.();
};
const generationThere = async (id) => {
  if (S.history.has(id)) return true;
  const g = await api(`/api/generations/${id}`, { busy: false }).catch(() => null);
  if (!g) return false;
  S.history.set(g.id, g);
  return true;
};
// (a cached mix is left out of the media library's list: asked for by its file)
const mediaThere = async (name) => !!(await fetch(`/files/media/${encodeURIComponent(name)}`, { method: 'HEAD' }).catch(() => null))?.ok;

async function renderedEdit(frame, d) {
  const { renderBody } = await import('./edit-ops.js');
  const body = renderBody(frame, d), key = renderKey(body), have = frame.render;
  if (have?.key === key && have.generation != null && await generationThere(have.generation)) return { generation: have.generation, index: 0 };
  let g = await api('/api/video/render', { method: 'POST', busy: false, timeout: 900000, body: { ...body, cache: true } });   // (cache: never listed in History)
  S.history.set(g.id, g);
  if (g.status !== 'done') {
    const { waitGen } = await import('./make.js');
    g = await waitGen(g.id);
    S.history.set(g.id, g);
  }
  await keepRender(frame, { generation: g.id, key });
  return { generation: g.id, index: 0 };
}

export async function frameVideo(frame) {
  if (frame?.kind !== 'video' || !frame.doc) throw new Error(`${frame?.label || 'That frame'} has no clip yet`);
  await flushed(frame);
  const d = await savedDoc(frame);
  if (!d?.payload) throw new Error(`${frame.label || 'That frame'} can't be read`);
  const pin = mainOf(frame, d.payload);   // (the main source clip, with its trim: never the whole edit)
  if (pin?.src && pin.kind === 'video') return { ...itemSource(pin), ...(pin.label && { label: pin.label }) };
  const it = plainVideo(d.payload);
  if (it) return { ...itemSource(it), ...(it.label && { label: it.label }) };
  if (!(d.payload.items || []).some((x) => x.src || x.kind === 'scene')) throw new Error(`${frame.label || 'That frame'} has nothing on its timeline`);
  return { ...(await renderedEdit(frame, d)), label: frame.label || null };
}

export async function frameAudio(frame) {
  if (frame?.kind === 'video') {   // (the server takes a video file as a sound source)
    if (frame.main && frame.doc) {   // (a pinned sound clip on the edit's audio track goes as it is)
      await flushed(frame);
      const pin = mainOf(frame, (await savedDoc(frame))?.payload);
      if (pin?.src && pin.kind === 'audio') return { ...itemSource(pin), ...(pin.label && { label: pin.label }) };
    }
    return frameVideo(frame);
  }
  if (frame?.kind !== 'sound' || !frame.doc) throw new Error(`${frame?.label || 'That frame'} has no sound yet`);
  await flushed(frame);
  const d = await savedDoc(frame);
  const p = d?.payload;
  if (!p) throw new Error(`${frame.label || 'That frame'} can't be read`);
  const pin = mainOf(frame, p);   // (the main source item, with its trim: never the whole mix)
  if (pin?.src) return { ...itemSource(pin), ...(pin.label && { label: pin.label }) };
  const it = plainSound(p);
  if (it) return { ...itemSource(it), ...(it.label && { label: it.label }) };
  const items = (p.items || []).filter((x) => x.src);
  if (!items.length) throw new Error(`${frame.label || 'That frame'} has nothing in its mix`);
  const key = renderKey({ tracks: p.tracks, out: p.out, items }), have = frame.render;
  if (have?.key === key && have.media && await mediaThere(have.media)) return { media: have.media };
  const { renderMix } = await import('./sound.js');
  const m = await renderMix({ tracks: p.tracks, out: p.out }, { name: frame.label || 'mix', items, cache: true });
  await keepRender(frame, { media: m.name, key });
  return { media: m.name };
}

// A video frame's picture at 'first' | 'last' | 'playhead' | seconds (wire-rules framePick), as a new input. The clip is the
// frame's plain clip or its rendered edit; the picture comes from media.js grabFrame (a <video> seeked to the time, drawn
// to a canvas, uploaded), so it works with the frame closed.
export async function frameStill(frame, pick = 'first') {
  if (frame?.main && frame.kind === 'video' && frame.doc) {   // (a pinned picture on the edit: that picture, as a new input)
    await flushed(frame);
    const pin = mainOf(frame, (await savedDoc(frame))?.payload);
    if (pin?.kind === 'image' && pin.src?.input) {
      const r = await fetch(inputUrl(pin.src.input));
      if (r.ok) return (await uploadImage(await r.blob(), { source: 'frame', mp: 0, filename: 'frame.png', multiple: 16 })).name;
    }
  }
  const src = await frameVideo(frame);
  const start = src.trim?.start || 0;
  let url = clipUrl(src);
  if (!url && src.generation != null) { await generationThere(src.generation); url = clipUrl(src); }
  let len = src.trim?.len;
  if (len == null && (pick === 'last' || typeof pick === 'number')) len = Math.max(0, (await durationOf(url)) - start);
  let t = 0;
  if (pick === 'last') t = Math.max(0, len - 0.05);
  else if (pick === 'playhead') {
    const vid = isLive(frame.id) ? await import('./video.js') : null;
    t = vid?.videoTabs?.()?.active?.id === frame.doc ? vid.videoTime() : 0;
  } else if (typeof pick === 'number') t = pick;
  if (len != null) t = Math.min(t, Math.max(0, len - 0.05));
  const { grabFrame } = await import('./media.js');
  return grabFrame({ ...src, url }, { at: start + Math.max(0, t) });
}
function durationOf(url) {
  return new Promise((done) => {
    if (!url) return done(0);
    const v = document.createElement('video');
    const end = (n) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); done(n); };
    const timer = setTimeout(() => end(0), 8000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => end(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => end(0);
    v.src = url;
  });
}
