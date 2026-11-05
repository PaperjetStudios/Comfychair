import { $, iconBtn, h } from './ui.js';
import { isLive, liveFrame, onLive } from './live.js';

// ---------------------------------------------------------------------------
// Undo / Redo for whichever tab is open, in one place: the top bar, and floating at the top of a full-screen view.
// A tab with its own history registers it; the pair hides on a tab without one (its deletes have an Undo toast).
//
//   registerUndo('scene', { undo(), redo(), can: () => [canUndo, canRedo] (default both), sig: () => the state as a string })
//   extendUndo('editor', { can, sig }) adds to a history registered elsewhere (its own module can't say them)
//   syncUndo() after the history changes (taps and keys sync it anyway)
// While a frame is live, the table's steps made meanwhile go in their place among the engine's (table.js liveStep,
// undo-order.js): setLiveSteps({ undo(), redo() → true when a table step went, can }).
// ---------------------------------------------------------------------------
const REG = new Map();
let dock = null, undoB = null, redoB = null;
// (a live frame on the table: its engine's history, by the key that engine registered under)
const LIVE_KEY = { image: 'editor', video: 'video', sound: 'sound', scene: 'scene' };
const activeTab = () => (isLive() ? LIVE_KEY[liveFrame().kind] || liveFrame().kind
  : document.querySelector('main > .tab.active')?.id?.replace(/^tab-/, '') || '');
const EXTRA = new Map();
const entry = (k) => (REG.has(k) ? { ...REG.get(k), ...EXTRA.get(k) } : null);
const now = () => entry(activeTab());
let LIVE_STEPS = null;

export function registerUndo(tab, u) { REG.set(tab, u); syncUndo(); }
export function extendUndo(tab, more) { EXTRA.set(tab, { ...EXTRA.get(tab), ...more }); syncUndo(); }
export function setLiveSteps(s) { LIVE_STEPS = s; }
// the live frame's engine history (null: nothing live, or its engine hasn't registered)
export const liveUndoEntry = () => (isLive() ? entry(LIVE_KEY[liveFrame().kind] || liveFrame().kind) : null);
const act = (dir) => { if (!(isLive() && LIVE_STEPS?.[dir]())) now()?.[dir](); syncUndo(); };

export function syncUndo() {
  if (!dock) return;
  // over a full-screen view the top bar is covered: the pair floats on the page instead
  const home = document.querySelector('.stage.maxed') ? document.body : $('.topbar .status');
  if (dock.parentElement !== home) home.prepend(dock);
  const u = now();
  dock.hidden = !u;
  if (!u) return;
  let [a, b] = u.can?.() ?? [true, true];
  if (isLive() && LIVE_STEPS) { const [la, lb] = LIVE_STEPS.can(); a ||= la; b ||= lb; }
  undoB.disabled = !a; redoB.disabled = !b;
}

export function wireUndoDock() {
  undoB = iconBtn('Undo (Ctrl+Z)', '↶', () => act('undo'));
  redoB = iconBtn('Redo (Ctrl+Shift+Z)', '↷', () => act('redo'));
  dock = h('span', { id: 'undoDock', class: 'undo-dock', role: 'group', 'aria-label': 'Undo' }, undoB, redoB);
  $('.topbar .status').prepend(dock);
  // (cheap: after any tap or key, and on a tab switch, the buttons follow the open tab's history)
  for (const ev of ['pointerup', 'keyup']) addEventListener(ev, () => setTimeout(syncUndo), true);
  const mo = new MutationObserver(syncUndo);
  for (const t of document.querySelectorAll('main > .tab')) mo.observe(t, { attributes: true, attributeFilter: ['class'] });
  onLive(() => syncUndo());
  syncUndo();
}
