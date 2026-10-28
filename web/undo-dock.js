import { $, iconBtn, h } from './ui.js';

// ---------------------------------------------------------------------------
// Undo / Redo for whichever tab is open, in one place: the top bar, and floating at the top of a full-screen view.
// A tab with its own history registers it; the pair hides on a tab without one (its deletes have an Undo toast).
//
//   registerUndo('scene', { undo(), redo(), can: () => [canUndo, canRedo] (default both) })
//   syncUndo() after the history changes (taps and keys sync it anyway)
// ---------------------------------------------------------------------------
const REG = new Map();
let dock = null, undoB = null, redoB = null;
const activeTab = () => document.querySelector('main > .tab.active')?.id?.replace(/^tab-/, '') || '';
const now = () => REG.get(activeTab()) || null;

export function registerUndo(tab, u) { REG.set(tab, u); syncUndo(); }

export function syncUndo() {
  if (!dock) return;
  // over a full-screen view the top bar is covered: the pair floats on the page instead
  const home = document.querySelector('.stage.maxed') ? document.body : $('.topbar .status');
  if (dock.parentElement !== home) home.prepend(dock);
  const u = now();
  dock.hidden = !u;
  if (!u) return;
  const [a, b] = u.can?.() ?? [true, true];
  undoB.disabled = !a; redoB.disabled = !b;
}

export function wireUndoDock() {
  undoB = iconBtn('Undo (Ctrl+Z)', '↶', () => { now()?.undo(); syncUndo(); });
  redoB = iconBtn('Redo (Ctrl+Shift+Z)', '↷', () => { now()?.redo(); syncUndo(); });
  dock = h('span', { id: 'undoDock', class: 'undo-dock', role: 'group', 'aria-label': 'Undo' }, undoB, redoB);
  $('.topbar .status').prepend(dock);
  // (cheap: after any tap or key, and on a tab switch, the buttons follow the open tab's history)
  for (const ev of ['pointerup', 'keyup']) addEventListener(ev, () => setTimeout(syncUndo), true);
  const mo = new MutationObserver(syncUndo);
  for (const t of document.querySelectorAll('main > .tab')) mo.observe(t, { attributes: true, attributeFilter: ['class'] });
  syncUndo();
}
