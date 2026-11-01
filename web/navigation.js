import { keyboardFocus } from './key-focus.js';
import { initHistory } from './history.js';

// Screen state and visits live here; app.js renders screens and world.js renders the space controls.
let current = 'generate', render = null;
const visits = ['generate'], listeners = new Set();
export const currentTab = () => current;
export function onNavigate(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setSwitchTab(fn) {
  render = fn;
  initHistory(() => {
    if (visits.length < 2) return;
    visits.pop();
    switchTab(visits.at(-1), { remember: false });
  });
}
export function switchTab(name, { remember = true } = {}) {
  if (!render || !document.getElementById(`tab-${name}`)) return;
  current = name;
  if (remember && visits.at(-1) !== name) { visits.push(name); if (visits.length > 40) visits.shift(); }
  try { sessionStorage.setItem('deck.lastTab', name); } catch { /* storage unavailable */ }
  render(name);
  for (const fn of listeners) fn(name);
}

// Native buttons handle Enter/Space; arrow keys move and activate within a visible tab list.
export function wireTabKeys(list) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role=tab]')].filter((b) => b.getClientRects().length);
    const at = tabs.indexOf(e.target);
    if (at < 0 || !keyboardFocus()) return;   // (a tab only clicked leaves the arrows to the tab's player)
    const to = { ArrowLeft: (at - 1 + tabs.length) % tabs.length, ArrowRight: (at + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault(); tabs[to].focus(); tabs[to].click();
  });
}
