// ---------------------------------------------------------------------------
// Line icons for buttons: 24×24, stroked in the text colour (no emoji or font glyphs; the .ico class in app.css
// sets the stroke). icon(name, size?) -> a fresh <svg>. Add a name here when a button needs one; keep each to a few
// plain paths. A path ending in "h.01" is a dot.
// ---------------------------------------------------------------------------
const PATHS = {
  // a dense wavy line thinned to a few dots: Reduce keys
  reduce: ['M3 16c2.5-7 5.5-9 9-4s6.5 3 9-4', 'M4 15.5h.01', 'M12 12h.01', 'M20 8.5h.01'],
  // the paint tools
  move: ['M12 3v18M3 12h18', 'M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3'],
  brush: ['M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-3-3z', 'M9 13c-2.8 0-4.5 1.8-4.5 4.3 0 1.5-.9 2.4-2.5 2.7 2.2 1.4 5 1.3 6.9-.3 1.4-1.2 2.1-2.6 2.1-3.7'],
  eraser: ['M9 20h11', 'M4.6 15.4l9.8-9.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2z', 'M9.5 10.5l4 4'],
  line: ['M5 19L19 5', 'M5 19h.01M19 5h.01'],
  rect: ['M4 6h16v12H4z'],
  ellipse: ['M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z'],
  fill: ['M11 3.5l7.5 7.5-7 7a2 2 0 0 1-2.8 0L4 13.3a2 2 0 0 1 0-2.8z', 'M4.5 12h13.5', 'M20.5 15.5s1.5 1.8 1.5 3a1.5 1.5 0 0 1-3 0c0-1.2 1.5-3 1.5-3z'],
  pick: ['M15 4.5l1.5-1.5a2.1 2.1 0 0 1 3 0l1.5 1.5a2.1 2.1 0 0 1 0 3L19.5 9', 'M13 6.5l4.5 4.5', 'M15 9l-9 9-3 1 1-3 9-9'],
  select: ['M4 7V4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4'],
  lasso: ['M8.5 17.5C5.2 16.7 3 14.6 3 12c0-3.9 4-7 9-7s9 3.1 9 7-4 7-9 7c-.6 0-1.2 0-1.8-.1', 'M8 16a2 2 0 1 0 1 3.7L8 22'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 7.7-1.5'],
  fit: ['M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5'],
  canvas: ['M4 4h16v16H4z', 'M12 8v8M8 12h8'],
  pencil: ['M16 3.5l4.5 4.5L8 20.5H3.5V16z', 'M13.5 6l4.5 4.5'],
  ink: ['M12 3l6 7-3 9H9l-3-9z', 'M12 3v6.5', 'M12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3'],
  airbrush: ['M13 9h5l3 3-3 3h-5z', 'M9 12h.01M6 8.5h.01M6 15.5h.01M3 12h.01M3 6h.01M3 18h.01'],
  marker: ['M14.5 4.5l5 5L11 18H6v-5z', 'M4 21h7'],
  // the app's buttons (they were emoji and font symbols: GLYPHS below maps those to these)
  play: ['M7 4.5l12 7.5-12 7.5z'],
  pause: ['M8 5v14M16 5v14'],
  back: ['M17 4.5L5 12l12 7.5z'],
  first: ['M6 5v14', 'M18 5l-9 7 9 7z'],
  last: ['M18 5v14', 'M6 5l9 7-9 7z'],
  rewind: ['M11 6l-7 6 7 6z', 'M20 6l-7 6 7 6z'],
  forward: ['M13 6l7 6-7 6z', 'M4 6l7 6-7 6z'],
  close: ['M6 6l12 12M18 6L6 18'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  save: ['M5 3h11l3 3v15H5z', 'M8 3v5h7V3', 'M8 21v-7h8v7'],
  left: ['M19 12H5', 'M11 6l-6 6 6 6'],
  right: ['M5 12h14', 'M13 6l6 6-6 6'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  upright: ['M7 17L17 7', 'M8 7h9v9'],
  check: ['M4 12.5l5 5L20 6.5'],
  star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
  video: ['M3 6.5h12v11H3z', 'M15 10.5l6-3v9l-6-3'],
  sound: ['M4 9h4l5-4v14l-5-4H4z', 'M16.5 9.5a3.5 3.5 0 0 1 0 5', 'M19 7a7 7 0 0 1 0 10'],
  mute: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9.5l5 5M22 9.5l-5 5'],
  edit: ['M16 3.5l4.5 4.5L8 20.5H3.5V16z'],
  cut: ['M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M8.2 7.8L20 19.5', 'M8.2 16.2L20 4.5'],
  reset: ['M3.5 12a8.5 8.5 0 1 0 2.7-6.2', 'M3.5 4v5h5'],
  refresh: ['M20.5 12a8.5 8.5 0 1 1-2.7-6.2', 'M20.5 4v5h-5'],
  image: ['M3 5h18v14H3z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9.5h.01'],
  film: ['M4 4h16v16H4z', 'M8 4v16M16 4v16', 'M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4'],
  enter: ['M20 5v7a3 3 0 0 1-3 3H5', 'M9 11l-4 4 4 4'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1'],
  hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V11', 'M11 11V4.5a1.5 1.5 0 0 1 3 0V11', 'M14 11V6.5a1.5 1.5 0 0 1 3 0V14',
    'M8 13V10a1.5 1.5 0 0 0-3 0v4.5A6.5 6.5 0 0 0 11.5 21H13a6 6 0 0 0 6-6v-1'],
  music: ['M9 18V5.5l11-2V16', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  mic: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  record: ['M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z'],
  grid: ['M4 4h16v16H4z', 'M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16'],
  swap: ['M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'],
  swapv: ['M12 3v18', 'M8 7l4-4 4 4', 'M8 17l4 4 4-4'],
  camera: ['M3 8h4l2-3h6l2 3h4v11H3z', 'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  upload: ['M12 16V4', 'M6 10l6-6 6 6', 'M4 20h16'],
  download: ['M12 4v12', 'M6 10l6 6 6-6', 'M4 20h16'],
  totop: ['M4 4h16', 'M12 20V8', 'M6 14l6-6 6 6'],
  sparkle: ['M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z', 'M5 21l4-4'],
  maximize: ['M14 4h6v6', 'M10 20H4v-6', 'M20 4l-7 7', 'M4 20l7-7'],
  minimize: ['M20 10h-6V4', 'M4 14h6v6', 'M14 10l7-7', 'M10 14l-7 7'],
  target: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M12 2v4M12 18v4M2 12h4M18 12h4'],
  circle: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
  loop: ['M17 2.5l3.5 3.5-3.5 3.5', 'M3.5 11V9a3 3 0 0 1 3-3h14', 'M7 21.5L3.5 18 7 14.5', 'M20.5 13v2a3 3 0 0 1-3 3h-14'],
  dice: ['M4 4h16v16H4z', 'M8.5 8.5h.01', 'M12 12h.01', 'M15.5 15.5h.01'],
  cube: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  folder: ['M3 6.5h6l2 2h10v10.5H3z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  warn: ['M12 4l9.5 16h-19z', 'M12 10v4.5', 'M12 17.5h.01'],
  choose: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
  diamond: ['M12 3.5l8.5 8.5-8.5 8.5L3.5 12z'],
  chevron: ['M9.5 6l6 6-6 6'],
};
// what used to be on the buttons -> its icon (filled: drawn solid, the "on" version of a shape)
const GLYPHS = {
  '▶': 'play', '▸': 'chevron', '◀': 'back', '❚': 'pause', '⏸': 'pause', '⏮': 'first', '⏭': 'last', '⇤': 'first', '⏪': 'rewind', '⏩': 'forward',
  '✕': 'close', '⤫': 'close', '🗑': 'trash', '💾': 'save', '←': 'left', '→': 'right', '↑': 'up', '↓': 'down', '↗': 'upright', '⤒': 'totop',
  '✓': 'check', '☆': 'star', '★': 'star', '🎥': 'video', '🔊': 'sound', '🔇': 'mute', '✎': 'edit', '✂': 'cut', '↺': 'reset', '↶': 'undo',
  '↷': 'redo', '↻': 'refresh', '🔄': 'refresh', '🖼': 'image', '🎞': 'film', '↵': 'enter', '⚙': 'settings', '✋': 'hand', '🖐': 'hand', '♪': 'music',
  '🎙': 'mic', '●': 'record', '▦': 'grid', '⇔': 'swap', '↔': 'swap', '⇄': 'swap', '⇆': 'swap', '↕': 'swapv', '📷': 'camera', '👁': 'eye',
  '👀': 'eye', '⬆': 'upload', '⤓': 'download', '✦': 'sparkle', '✨': 'sparkle', '✳': 'sparkle', '⛶': 'fit', '⤢': 'maximize', '⌖': 'target',
  '◉': 'target', '◌': 'circle', '🔁': 'loop', '🎲': 'dice', '🧊': 'cube', '📦': 'cube', '📁': 'folder', '📄': 'file', '⚠': 'warn',
  '☑': 'choose', '◇': 'diamond', '◆': 'diamond', '✥': 'move',
};
const FILLED = new Set(['★', '◆', '●']);


// A label that starts with one of those symbols: [its icon, the rest]. Another emoji there is dropped (the words
// say it); anything else is left as it is. Strings only.
const LEAD = /^(\p{Extended_Pictographic}|[\u2190-\u21ff\u2300-\u23ff\u25a0-\u27bf\u2900-\u297f\u2b00-\u2bff])\ufe0f?\s*/u;
export function iconize(label) {
  if (typeof label !== 'string') return label;
  label = label.replace('❚❚', '❚');   // (two bars were the pause sign)
  const m = label.match(LEAD);
  if (!m) return label;
  const rest = label.slice(m[0].length), name = GLYPHS[m[1]];
  if (!name) return /\p{Extended_Pictographic}/u.test(m[1]) && rest ? rest : label;
  const svg = icon(name);
  if (FILLED.has(m[1])) svg.classList.add('filled');
  return rest ? [svg, rest] : svg;
}

// el shows label (a symbol becomes its icon), in place of what it showed
export const setIcon = (el, label) => { el.replaceChildren(...[iconize(label)].flat()); };

export function icon(name, size = null) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' })) s.setAttribute(k, v);
  if (size) { s.setAttribute('width', size); s.setAttribute('height', size); }
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(s.namespaceURI, 'path');
    p.setAttribute('d', d);
    if (/^(M[\d.]+ [\d.]+h\.01)+$/.test(d)) p.setAttribute('stroke-width', 4);   // (a lone dot)
    s.append(p);
  }
  return s;
}
