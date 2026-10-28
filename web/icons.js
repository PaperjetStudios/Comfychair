// Line icons for buttons: 24×24, drawn with the text colour (no emoji or font glyphs). icon(name) → <svg>.
// Add a name here when a button needs one; keep each to a few plain paths.
const PATHS = {
  // a dense wavy line thinned to a few dots: Reduce keys
  reduce: ['M3 16c2.5-7 5.5-9 9-4s6.5 3 9-4', 'M4 15.5h.01', 'M12 12h.01', 'M20 8.5h.01'],
};

export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(s.namespaceURI, 'path');
    p.setAttribute('d', d);
    if (d.endsWith('h.01')) p.setAttribute('stroke-width', 4);   // (a dot)
    s.append(p);
  }
  return s;
}
