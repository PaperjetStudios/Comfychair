import { $ } from './ui.js';
import { stepTable } from './table.js';
import { isLive } from './live.js';
import { ownsKey } from './key-focus.js';

// ---------------------------------------------------------------------------
// Moving between tables: the top tabs are the project's tables (table-nav.js). Alt + ← → opens the table before or
// after the open one (from a Classic screen, the Table screen first); so does a sideways swipe along the top bar.
// The page never overscrolls sideways (Chrome's swipe back / forward).
// (This was the map of three spaces, Make / Edit / View, over the old screens; those are under Classic ▾ now.)
// ---------------------------------------------------------------------------

// ---- keys: Alt + ← → ----
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, [role=dialog]')) return;
  if (isLive() || ownsKey(e)) return;   // (a live frame's engine, or a box or panel that owns its keys, has them)
  const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (dir) { e.preventDefault(); stepTable(dir); }
});

// ---- one finger along the top bar (a tap there is still a tap) ----
function wireBarSwipe(topbar) {
  let s = null, swiped = false;
  topbar.addEventListener('pointerdown', (e) => {
    swiped = false;
    if (e.pointerType !== 'touch' || e.target.closest('select, input, #tableTabs')) return;   // (the tabs drag to reorder)
    s = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  topbar.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id || swiped) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(e.clientY - s.y)) { swiped = true; stepTable(dx < 0 ? 1 : -1); }
  });
  const end = () => { s = null; if (swiped) setTimeout(() => { swiped = false; }, 400); };   // (the click a swipe ends in, if any, comes first)
  topbar.addEventListener('pointerup', end); topbar.addEventListener('pointercancel', end);
  topbar.addEventListener('click', (e) => { if (swiped) { swiped = false; e.stopPropagation(); e.preventDefault(); } }, true);
}

// ---- a run going on in Generate shows on Classic ▾ (its own button is in the menu, out of sight) ----
function mirrorRun() {
  const gen = document.querySelector('button[data-tab="generate"]'), classic = $('#classicBtn');
  if (!gen || !classic) return;
  const copy = () => classic.style.setProperty('--run', gen.style.getPropertyValue('--run') || '0%');
  new MutationObserver(copy).observe(gen, { attributes: true, attributeFilter: ['style'] });
  copy();
}

document.documentElement.classList.add('lab');
wireBarSwipe(document.querySelector('.topbar'));
mirrorRun();
