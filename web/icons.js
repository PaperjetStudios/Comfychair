// ---------------------------------------------------------------------------
// Line icons for buttons: 24×24, stroked in the text colour (the .ico class in app.css sets the stroke).
// icon(name) -> a fresh <svg>. Only what the paint tools use so far; add more as needed.
// ---------------------------------------------------------------------------
const PATHS = {
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
};

export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
  for (const d of PATHS[name] || []) { const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
