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
//   frameClip(frame)                      → a video (or sound) frame's first clip, by its place on the timeline:
//       { kind, src, url, label, dur, item, trim: { start, len? } }, or null when it has none
import { api } from './ui.js';
import { CURRENT_EDIT, S } from './core.js';
import { clipUrl, pngBlob, uploadImage } from './media.js';
import { isLive } from './live.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND } from './table-model.js';
import { canvasRect } from './make-rules.js';

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const docUrl = (kind, id) => `/api/store/${DOC_KIND[kind]}/${id}${qs()}`;

// the editor, when it has this frame's edit open (live on the table)
const liveEngine = (frame) => {
  const eng = CURRENT_EDIT.eng;
  return isLive(frame.id) && eng?.E?.tab?.id === frame.doc ? eng : null;
};
const composed = (eng) => {
  const cv = document.createElement('canvas');
  return eng.compose(cv) ? pngBlob(cv) : null;
};
// where the composite sits on the canvas: the editor's frame, a fitted frame's last layer box, else the canvas
const rectOf = async (frame, eng, payload) => {
  const r = eng?.frame?.();
  if (r) return { x: r.x, y: r.y, w: r.w, h: r.h };
  if (frame.fit && frame.fitBox) return { ...frame.fitBox };
  if (payload === undefined) payload = (await api(docUrl('image', frame.doc), { busy: false }).catch(() => null))?.payload;
  return canvasRect(payload, frame);
};

export async function framePicture(frame) {
  if (frame?.kind !== 'image' || !frame.doc) return null;
  let eng = liveEngine(frame);
  if (eng) {
    await eng.paint?.savePaint?.();
    const blob = await composed(eng);
    return blob ? { blob, rect: await rectOf(frame, eng) } : null;
  }
  const d = await api(docUrl('image', frame.doc), { busy: false }).catch(() => null);
  if (!d?.payload?.layers?.length) return null;
  if (!isLive('image')) {   // (full size: the edit opened in the editor off screen, as a drop on a closed frame does)
    try {
      const { drawOffscreen } = await import('./frame-image.js');
      if (await drawOffscreen(frame.doc)) {
        eng = CURRENT_EDIT.eng;
        if (eng?.E?.tab?.id === frame.doc) {
          const blob = await composed(eng);
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

export async function frameSource(frame, { multiple = 1 } = {}) {
  const got = await framePicture(frame);
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
  const it = its[0];
  if (!it) return null;
  const src = it.src.generation != null ? { generation: it.src.generation, index: it.src.index || 0 } : it.src.media ? { media: it.src.media } : { ...it.src };
  const end = it.out ?? it.dur, start = it.in || 0;
  return { kind: want, src, url: clipUrl(it.src) || it.url || null, label: it.label || null, dur: it.dur || 0, item: it,
    trim: { start, ...(end ? { len: +(end - start).toFixed(4) } : {}) } };
}
