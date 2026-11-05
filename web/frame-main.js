// The live frame's main source (frame.main, main-rules.js), for the engines on the table: the editor's layer rows and menu
// (editor.js), the Video and Sound timelines' clip menus and clips (video.js, sound.js).
//
//   liveMain(kind, doc)          { frame, id } when the live table frame is of that kind and has that document open (id: its
//                                pinned layer key / item id, or null); null when nothing can be pinned here (the Image, Video
//                                or Sound screen on its own, or another document)
//   setMain(frameId, id, opts)   pin id (null: unpin), saved with the table; opts.record false: no undo step (a pin cleared
//                                because its layer or clip was deleted)
//   dropGoneMain(kind, doc, ids) the pin cleared when the pinned layer / item is no longer among ids (after an edit)
import { liveFrame } from './live.js';

let TB = null;   // table.js, once loaded (it is, whenever a frame is live)
const table = () => {
  if (!TB) import('./table.js').then((m) => { TB = m; }).catch(() => {});
  return TB;
};

export function liveMain(kind, doc) {
  const lf = liveFrame();
  if (!lf || lf.kind !== kind || !doc || lf.doc !== doc) return null;
  const f = table()?.frameById?.(lf.id) || lf;
  return { frame: f, id: f.main ?? null };
}

export async function setMain(frameId, id, { record = true } = {}) {
  const T = TB || await import('./table.js');
  TB = T;
  return T.setFrameField(frameId, { main: id == null || id === '' ? null : String(id) }, { record });
}

export function dropGoneMain(kind, doc, ids) {
  const m = liveMain(kind, doc);
  if (!m?.id) return false;
  for (const id of ids) if (id === m.id) return false;
  setMain(m.frame.id, null, { record: false }).catch(() => {});
  return true;
}
