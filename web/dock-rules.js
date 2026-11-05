// Where a floating panel docks (float-panel.js): the rules, without the page, so they can be tested.
// Three places: 'left' of the work area, 'mid' (between the canvas and the sidebar, on the sidebar's left), 'right' of the sidebar.
//   dockZones(main, split, cols, edge)  the spans a drop docks in, first match wins: each column on show, then a strip at the work
//                                       area's left, one about the splitter (split: its { left, right }, or null: no sidebar here, or
//                                       portrait), one at the work area's right. main: { left, right }; cols: { left|mid|right: { left, right } }
//   dockSide(x, zones)                  the place a drop at x docks in, or null (it floats)
//   dockIndex(y, mids)                  where among a column's panels it goes: before the first whose middle is below y
//   dockWidth(w, view)                  a column's width, kept between 220 px and half the window
export const DOCK_EDGE = 40;
export const DOCK_SIDES = ['left', 'mid', 'right'];
export const DOCK_NAMES = { left: 'Left of the work area', mid: 'Left of the sidebar', right: 'Right of the sidebar' };

export function dockZones(main, split = null, cols = {}, edge = DOCK_EDGE) {
  const z = DOCK_SIDES.filter((s) => cols[s]).map((s) => ({ side: s, left: cols[s].left, right: cols[s].right }));
  z.push({ side: 'left', left: -Infinity, right: main.left + edge });
  if (split) z.push({ side: 'mid', left: split.left - edge, right: split.right });
  z.push({ side: 'right', left: main.right - edge, right: Infinity });
  return z;
}

export const dockSide = (x, zones) => zones.find((z) => x >= z.left && x <= z.right)?.side ?? null;

export const dockIndex = (y, mids) => { const i = mids.findIndex((m) => y < m); return i < 0 ? mids.length : i; };

export const dockWidth = (w, view) => Math.round(Math.max(220, Math.min(Number(w) || 300, view * 0.5)));
