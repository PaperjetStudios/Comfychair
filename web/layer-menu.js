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
