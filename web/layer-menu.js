// What the layers' right-click / long-hold menu offers and in what order, with no DOM (tests/layer_menu.test.mjs).
// Groups, in the order you'd reach for them: who's selected, the clipboard, putting layers together, sending them elsewhere, and removing.
// What doesn't apply now isn't listed; a merge that can't happen is, greyed.

// s: { layers, selected, pictures (selected ones with a picture), hidden, clip, pickMode, newEdit, mergeDown, mergeSet,
//      table (an open frame on the table: a new edit is a frame beside it, so "send to the table"),
//      main: null (no pin here: off the table, or not one layer that can be pinned) | { on: the layer is the frame's main source } }
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
    [s.trim ? { id: 'trim', label: s.trim > 1 ? `Trim ${s.trim} to their cut-outs` : 'Trim to the cut-out' } : null],
    [s.main ? { id: 'main', label: s.main.on ? 'Not the main source' : 'Main source', on: !!s.main.on } : null,
      p ? { id: 'saveEach', label: p > 1 ? 'Save each as input' : 'Save layer as input' } : null,
      p > 1 ? { id: 'saveTogether', label: 'Save as one input' } : null,
      n && s.newEdit && s.table ? { id: 'moveNew', label: 'Send to the table' } : null,
      p && s.newEdit && s.table ? { id: 'openNew', label: 'Send a copy to the table' } : null,
      p && s.newEdit && !s.table ? { id: 'openNew', label: 'Open in a new edit' } : null,
      n && s.newEdit && !s.table ? { id: 'moveNew', label: 'Move to new edit' } : null],
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
    [{ id: 'open', label: 'Open', keys: 'Enter', disabled: !s.openable }, { id: 'rename', label: 'Rename', keys: 'F2', disabled: n !== 1 }],
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

// ---- the timeline's menus (Video and Sound; tests/layer_menu.test.mjs). Same shape; what doesn't apply isn't listed. ----
// s: { n (clips picked), canPaste, canSplit (the playhead is inside a picked clip), locked, hasKeys, kind,
//      main: null (no pin here) | { on: the one picked clip is the frame's main source },
//      shot: null | { cont (it can be continued), rerun (it can run again), from (clips continue from it, or it continues one), busy } }
export function clipMenu(s) {
  const n = s.n || 0;
  const groups = [
    [n === 1 && s.main ? { id: 'main', label: s.main.on ? 'Not the main source' : 'Main source', on: !!s.main.on } : null],
    [n === 1 && s.shot?.cont ? { id: 'continue', label: 'Continue this clip', disabled: !!s.locked || !!s.shot.busy } : null,
      n === 1 && s.shot?.rerun ? { id: 'runAgain', label: 'Run again', disabled: !!s.locked || !!s.shot.busy } : null,
      n === 1 && s.shot?.from ? { id: 'rerunFrom', label: 'Rerun from here', disabled: !!s.locked || !!s.shot.busy } : null],
    [n ? { id: 'cut', label: 'Cut', keys: 'Ctrl+X', disabled: !!s.locked } : null,
      n ? { id: 'copy', label: 'Copy', keys: 'Ctrl+C' } : null,
      s.canPaste ? { id: 'paste', label: 'Paste', keys: 'Ctrl+V', disabled: !!s.locked } : null,
      n ? { id: 'duplicate', label: 'Duplicate', keys: 'Ctrl+J', disabled: !!s.locked } : null],
    [n && s.table ? { id: 'toTable', label: 'Send to the table', disabled: !!s.locked || !s.sendable } : null,
      n && s.table ? { id: 'copyToTable', label: 'Send a copy to the table', disabled: !s.sendable } : null],
    [n ? { id: 'split', label: 'Split at playhead', keys: 'S', disabled: !s.canSplit || !!s.locked } : null,
      n === 1 && s.kind !== 'audio' ? { id: 'crossfade', label: 'Cross-fade with the one before', disabled: !!s.locked } : null],
    [n ? { id: 'rippleDelete', label: 'Ripple delete', keys: 'Shift+Delete', disabled: !!s.locked } : null,
      n ? { id: 'delete', label: n > 1 ? `Delete ${n}` : 'Delete', keys: 'Delete', danger: true, disabled: !!s.locked } : null],
    [{ id: 'selectTrack', label: 'Select all on this track' }, { id: 'selectAfter', label: 'Select everything after the playhead' }],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}

// s: { kind ('video' | 'audio'), locked, solo, muted, hidden, empty, only (the only track of its kind) }
export function trackMenu(s) {
  const groups = [
    [{ id: 'rename', label: 'Rename' }, { id: 'lock', label: s.locked ? 'Unlock' : 'Lock' }],
    [{ id: 'solo', label: 'Solo', on: !!s.solo }, { id: 'mute', label: 'Mute', on: !!s.muted },
      s.kind === 'video' ? { id: 'hide', label: 'Hide', on: !!s.hidden } : null],
    [{ id: 'addVideo', label: 'Add video track' }, { id: 'addAudio', label: 'Add audio track' },
      { id: 'remove', label: 'Remove track', danger: true, disabled: !s.empty || !!s.only }],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}

// s: { marker (a marker is under the press), hasRange (a work area is set) }
export function rulerMenu(s) {
  const groups = [
    [{ id: 'addMarker', label: 'Add marker here', keys: 'M' },
      s.marker ? { id: 'renameMarker', label: 'Rename marker' } : null,
      s.marker ? { id: 'removeMarker', label: 'Remove marker', danger: true } : null],
    [{ id: 'areaStart', label: 'Set work area start here' }, { id: 'areaEnd', label: 'Set work area end here' },
      s.hasRange ? { id: 'areaClear', label: 'Clear work area' } : null],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}

// s: { n (keys picked), canPaste, eases: [names] }; an item with `sub` opens that list (`sub: 'ease'`, items in `subItems`)
export function keyMenu(s) {
  const n = s.n || 0, eases = s.eases || [];
  const groups = [
    [n ? { id: 'copy', label: 'Copy', keys: 'Ctrl+C' } : null,
      s.canPaste ? { id: 'paste', label: 'Paste', keys: 'Ctrl+V' } : null,
      n ? { id: 'delete', label: n > 1 ? `Delete ${n}` : 'Delete', keys: 'Delete', danger: true } : null],
    [n && eases.length ? { id: 'ease', label: 'Ease ▸', sub: 'ease', subItems: eases.map((e) => ({ id: `ease:${e}`, label: e })) } : null],
  ];
  return groups.map((g) => g.filter(Boolean)).filter((g) => g.length);
}
