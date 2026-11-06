// Where a floating panel docks (float-panel.js): the rules, without the page, so they can be tested.
// Five places. Three columns: 'left' of the work area, 'mid' (between the canvas and the sidebar, on the sidebar's left), 'right' of the
// sidebar. Two rows, between the side columns: 'top' (above the work area) and 'bottom' (below it), their panels side by side.
//   dockZones(main, split, cols, edge)  the spans a drop docks in, first match wins: each column or row on show, then a strip at the work
//                                       area's left, one about the splitter (split: its { left, right }, or null: no sidebar here, or
//                                       portrait), one at the work area's right, then (main has top and bottom) one along its top and
//                                       one along its bottom. main: { left, right, top?, bottom? }; cols: { place: { left, right, top?, bottom? } }
//   dockSide(x, zones, y)               the place a drop at x (and y) docks in, or null (it floats). A row needs y.
//   dockIndex(y, mids)                  where among a column's panels it goes: before the first whose middle is below y (a row: x, and to the right of x)
//   dockWidth(w, view)                  a column's width, kept between 220 px and half the window
//   dockHeight(h, view)                 a row's height, kept between 120 px and half the window
export const DOCK_EDGE = 40;
export const DOCK_SIDES = ['left', 'mid', 'right', 'top', 'bottom'];
export const DOCK_NAMES = { left: 'Left of the work area', mid: 'Left of the sidebar', right: 'Right of the sidebar', top: 'Above the work area', bottom: 'Below the work area' };
export const isRow = (side) => side === 'top' || side === 'bottom';

export function dockZones(main, split = null, cols = {}, edge = DOCK_EDGE) {
  const z = DOCK_SIDES.filter((s) => cols[s]).map((s) => ({ side: s, ...cols[s] }));
  z.push({ side: 'left', left: -Infinity, right: main.left + edge });
  if (split) z.push({ side: 'mid', left: split.left - edge, right: split.right });
  z.push({ side: 'right', left: main.right - edge, right: Infinity });
  if (main.top != null && main.bottom != null) {
    z.push({ side: 'top', left: main.left, right: main.right, top: -Infinity, bottom: main.top + edge });
    z.push({ side: 'bottom', left: main.left, right: main.right, top: main.bottom - edge, bottom: Infinity });
  }
  return z;
}

// (a zone with a top and bottom is only matched with a y inside them; one without spans the whole height)
export const dockSide = (x, zones, y = null) => zones.find((z) => x >= z.left && x <= z.right
  && (z.top == null || (y != null && y >= z.top && y <= z.bottom)))?.side ?? null;

export const dockIndex = (y, mids) => { const i = mids.findIndex((m) => y < m); return i < 0 ? mids.length : i; };

export const dockWidth = (w, view) => Math.round(Math.max(220, Math.min(Number(w) || 300, view * 0.5)));

export const dockHeight = (hgt, view) => Math.round(Math.max(120, Math.min(Number(hgt) || 220, view * 0.5)));
