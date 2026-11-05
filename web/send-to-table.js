// Clips of an open frame's timeline as frames of their own on the table, beside it, each one kept as it is on the timeline (its trim, level, fades,
// framing and effects). Pictures go as image frames. A move takes them off the timeline only once every frame is there.
//   sendClips(items) → true when all of them made it
import { toast } from './ui.js';
import { clipUrl } from './media.js';
import { liveFrame } from './live.js';
import { besideSpot, editDoc } from './table-frames.js';
import * as Table from './table.js';

const sourceOf = (it) => ({ ...it.src, kind: it.kind, label: it.label || null, ...(it.src.media ? { url: clipUrl(it.src) || it.url || null } : {}) });

export async function sendClips(items) {
  const beside = liveFrame();
  if (!beside) return false;
  let made = 0;
  for (const it of items) {
    const at = besideSpot(Table.tableFrames() || [], beside, { w: beside.w, h: beside.h });
    const f = await Table.sourceFrameAt(sourceOf(it), { x: at.x, y: at.y });
    if (!f) continue;
    made++;
    if (f.kind === 'video' || f.kind === 'sound') {
      await editDoc(f.kind, f.doc, (p) => {
        const first = p.items?.[0];
        if (first) p.items[0] = { ...JSON.parse(JSON.stringify(it)), id: first.id, track: first.track, at: 0 };
      });
    }
  }
  if (made < items.length) toast(made ? `${items.length - made} of them couldn't go on the table` : 'That can\'t go on the table', true);
  return made === items.length;
}
