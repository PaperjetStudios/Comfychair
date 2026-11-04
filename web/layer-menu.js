// What the layers' right-click / long-hold menu offers and in what order, with no DOM (tests/layer_menu.test.mjs).
// Groups, in the order you'd reach for them: who's selected, the clipboard, putting layers together, sending them elsewhere, and removing.
// What doesn't apply now isn't listed; a merge that can't happen is, greyed.

// s: { layers, selected, pictures (selected ones with a picture), hidden, clip, pickMode, newEdit, mergeDown, mergeSet }
export function layerMenu(s) {
  const n = s.selected, p = s.pictures;
  const groups = [
    [s.layers ? { id: 'all', label: 'Select all' } : null,
      n ? { id: 'none', label: 'Select none' } : null,
      s.layers ? { id: 'several', label: 'Select several', on: !!s.pickMode } : null],
    [n ? { id: 'copy', label: 'Copy', keys: 'Ctrl+C' } : null,
      s.clip ? { id: 'paste', label: 'Paste', keys: 'Ctrl+V' } : null,
      n ? { id: 'duplicate', label: 'Duplicate', keys: 'Ctrl+J' } : null],
    [n > 1 ? { id: 'group', label: 'Group' } : null,
      n === 1 ? { id: 'mergeDown', label: 'Merge down', keys: 'Ctrl+E', disabled: !s.mergeDown } : null,
      n > 1 ? { id: 'mergeSelected', label: 'Merge selected', keys: 'Ctrl+E', disabled: !s.mergeSet } : null],
    [p ? { id: 'saveEach', label: p > 1 ? 'Save each as input' : 'Save layer as input' } : null,
      p > 1 ? { id: 'saveTogether', label: 'Save as one input' } : null,
      p && s.newEdit ? { id: 'openNew', label: 'Open in a new edit' } : null,
      n && s.newEdit ? { id: 'moveNew', label: 'Move to new edit' } : null],
    [n ? { id: 'delete', label: n > 1 ? `Delete ${n} selected` : 'Delete layer', keys: 'Delete', danger: true } : null,
      s.hidden ? { id: 'deleteHidden', label: `Delete ${s.hidden} hidden`, danger: true } : null,
      s.layers ? { id: 'clear', label: 'Clear all', danger: true } : null],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}

// What a right click or a long hold on a layer acts on: the selection if the layer is in it, otherwise that layer alone. Off any layer: as it is.
export const pickedFor = (picked, layer) => (!layer || picked.includes(layer) ? picked : [layer]);

// Where a w×h menu goes for a press at x, y in a W×H window: at the press, moved or flipped to stay on screen
export function menuSpot(x, y, w, h, W, H, edge = 4) {
  const left = x + w + edge > W ? x - w : x, top = y + h + edge > H ? y - h : y;
  return { left: Math.max(edge, Math.min(left, W - w - edge)), top: Math.max(edge, Math.min(top, H - h - edge)) };
}

// Where a w×h submenu goes beside its item (r: the item's { left, right, top }, screen pixels) in a W×H window: to the
// right at the item's top, flipped to the left when it would pass the edge, moved up to stay on screen
export function subSpot(r, w, h, W, H, edge = 4) {
  const right = r.right + w + edge <= W, left = right ? r.right : r.left - w;
  return { left: Math.max(edge, Math.min(left, W - w - edge)), top: Math.max(edge, Math.min(r.top, H - h - edge)), flipped: !right };
}

// The menu of a crop box: its shapes (aspects: [label, width/height or null for free]), with the one in use ticked
export function cropShapeMenu(aspects, current) {
  return [aspects.map(([label, aspect]) => ({ id: label, label, aspect, on: aspect === (current ?? null) }))];
}

// ---- the table's frames: the same kind of menu, for a stack of frames (table.js; tests/table_stack.test.mjs) ----
// What Arrange offers (the table bar's Arrange ▾ shows all of it; the frame menu's Align ▸, Distribute ▸ and Same size ▸
// show a part each). Everything needs two or more frames selected.
export function frameArrangeMenu() {
  return {
    align: [{ id: 'align:left', label: 'Left edges' }, { id: 'align:hcenter', label: 'Centres across' }, { id: 'align:right', label: 'Right edges' },
      { id: 'align:top', label: 'Top edges' }, { id: 'align:vcenter', label: 'Centres down' }, { id: 'align:bottom', label: 'Bottom edges' }],
    distribute: [{ id: 'spread:x', label: 'Even gaps across' }, { id: 'spread:y', label: 'Even gaps down' },
      { id: 'centres:x', label: 'Even centres across' }, { id: 'centres:y', label: 'Even centres down' }],
    tidy: [{ id: 'tidy:row', label: 'Side by side' }, { id: 'tidy:column', label: 'Stacked' }, { id: 'tidy:grid', label: 'Grid' }],
    size: [{ id: 'size:w', label: 'Same width' }, { id: 'size:h', label: 'Same height' }, { id: 'size:both', label: 'Same size' },
      { id: 'size:largest', label: 'Same size as the largest' }],
  };
}

// s: { selected, openable (one frame that opens), grouped (one of them is in a group), hidden (all of them hidden), locked (all locked), extra: [[item]] }
// extra: other modules' groups (table:menu), before Delete. An item with `sub` opens that part of frameArrangeMenu.
export function frameMenu(s) {
  const n = s.selected;
  if (!n) return [];
  const groups = [
    [{ id: 'open', label: 'Open', keys: 'Enter', disabled: !s.openable }, { id: 'rename', label: 'Rename', disabled: n !== 1 }],
    [{ id: 'duplicate', label: 'Duplicate', keys: 'Ctrl+J' },
      n > 1 ? { id: 'group', label: 'Group', keys: 'Ctrl+G' } : null,
      s.grouped ? { id: 'ungroup', label: 'Ungroup', keys: 'Ctrl+Shift+G' } : null],
    [{ id: 'hide', label: s.hidden ? 'Show' : 'Hide', keys: 'H' }, { id: 'lock', label: s.locked ? 'Unlock' : 'Lock', keys: 'L' }],
    [{ id: 'front', label: 'Bring to front', keys: 'Ctrl+Shift+]' }, { id: 'forward', label: 'Bring forward', keys: 'Ctrl+]' },
      { id: 'backward', label: 'Send backward', keys: 'Ctrl+[' }, { id: 'back', label: 'Send to back', keys: 'Ctrl+Shift+[' }],
    [{ id: 'align', label: 'Align ▸', sub: 'align', disabled: n < 2 }, { id: 'distribute', label: 'Distribute ▸', sub: 'distribute', disabled: n < 2 },
      { id: 'sameSize', label: 'Same size ▸', sub: 'size', disabled: n < 2 }, { id: 'size', label: 'Size and MP…', disabled: n !== 1 }],
    ...(s.extra || []),
    [{ id: 'delete', label: n > 1 ? `Delete ${n}` : 'Delete', keys: 'Del', danger: true, disabled: !!s.locked }],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}
