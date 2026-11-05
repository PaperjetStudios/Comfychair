// The live frame's main source (frame.main, main-rules.js), for the engines on the table: the editor's layer rows and menu
// (editor.js), the Video and Sound timelines' clip menus and clips (video.js, sound.js).
//
//   liveMain(kind, doc)          { frame, id } when the live table frame is of that kind and has that document open (id: its
//                                pinned layer key / item id, or null); null when nothing can be pinned here (the Image, Video
//                                or Sound screen on its own, or another document)
//   setMain(frameId, id, opts)   pin id (null: unpin), saved with the table; opts.record false: no undo step
// A pinned layer or clip that is deleted stays pinned: main-rules mainOf finds nothing while it is gone (the frame gives its
// whole content), and the pin is back when Undo brings the thing back. Only another pin or Unpin changes it.
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
