// The one gate for "is this engine on show": at most one frame on the table is live (zoomed to 1:1 with its engine
// mounted inside it). Engines ask isLive(); the table calls setLive().
//
//   isLive()            any frame live; isLive(id) that frame; isLive(kind) a frame of that kind ('image', 'video'…)
//   liveFrame()         the live frame, or null;  liveRoot(): the element its engine mounts into
//   setLive(frame, root) / setLive(null)
//   onLive(fn)          fn(frame | null, root | null) after every change; returns an unsubscribe
//
// For now, a trick keeps the old per-tab checks working unchanged: the live frame's mount root carries `tab active`
// and every `main > .tab` loses `active` (playback.js playKeys, undo-dock.js, layout.js's f key and docStrip all look
// for `.tab.active`). The table's own section stays on show through `.live-host`. When nothing is live the table's
// section is the `.tab.active` again, if the table is still the screen open. Swapped for isLive() checks at the end.
import { currentTab } from './navigation.js';

const L = { frame: null, root: null, host: null };
const listeners = new Set();

export const liveFrame = () => L.frame;
export const liveRoot = () => L.root;
export const isLive = (key = null) => !!L.frame && (key == null || L.frame.id === key || L.frame.kind === key);
export function onLive(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setLive(frame, root = null) {
  if (frame && L.frame?.id === frame.id && L.root === root) return;
  if (L.frame) release();
  if (frame && root) {
    L.host = root.closest('main > .tab');
    for (const t of document.querySelectorAll('main > .tab')) t.classList.remove('active');
    L.host?.classList.add('live-host');
    root.classList.add('tab', 'active');
    Object.assign(L, { frame, root });
  }
  for (const fn of [...listeners]) { try { fn(L.frame, L.root); } catch (e) { console.error(e); } }
}

// the live frame's root lets go of the tab classes; its host is the open tab again if it is still the one on screen
function release() {
  L.root?.classList.remove('tab', 'active');
  if (L.host) {
    L.host.classList.remove('live-host');
    if (L.host.id === `tab-${currentTab()}`) L.host.classList.add('active');
  }
  Object.assign(L, { frame: null, root: null, host: null });
}
