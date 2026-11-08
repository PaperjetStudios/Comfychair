// ---------------------------------------------------------------------------
// A character frame's output pins, with no DOM (tests/char_outs.test.mjs). A character frame (kind 'character', its doc
// the character's id) stands for one of the project's characters; its pins are the pictures that character's active look
// has for a shot: the main picture, each kept view, the sheet(s), each expression, each detail picture. A wire from a pin
// says which (wire.out: the pin's id, as a 3D frame's render pins do in web/frame-outs.js) and carries an 'image', so a
// view made again goes down the wires already plugged in.
// The character document changes elsewhere (the Story tab, the pipeline), so the frame keeps a copy of its pins:
// frame.pins = [{ id, kind: 'image', label, input }], written by mirrorPins when the character changes, read by
// web/wire-rules.js through charPins. Every function returns new data; none changes what it is given.
// Pin ids: 'main' | 'view:<key>' | 'sheet' | 'sheet:<media id>' | 'expr:<key>' | 'detail:<media id>'
// ---------------------------------------------------------------------------
import { viewLabel } from './cast.js';

const KIND = 'image';
// pins in a steady order: the main picture, the views, the sheets, the expressions, the details
const RANK = { main: 0, view: 1, sheet: 2, expr: 3, detail: 4 };
const kindOfPin = (id) => String(id).split(':')[0];
const rank = (p) => RANK[kindOfPin(p.id)] ?? 9;
const str = (v) => (typeof v === 'string' && v ? v : null);

// The pins a character has now, for a look (its active one unless lookId names another): in order, each with the input it
// carries. A character with no pictures has none.
export function pinsOf(c, lookId = null) {
  if (!c) return [];
  const k = lookId && typeof c.withLook === 'function' ? c.withLook(lookId) : c;
  const look = k.lookNow || {};
  const lookIdNow = look.id || null;
  const out = [];
  const main = str(k.main) && Array.isArray(k.pics) && k.pics.includes(k.main) ? k.main : (Array.isArray(k.pics) && str(k.pics[0])) || null;
  if (main) out.push({ id: 'main', kind: KIND, label: 'Main picture', input: main });
  for (const [key, input] of Object.entries(k.views || {})) if (str(input)) out.push({ id: `view:${key}`, kind: KIND, label: viewLabel(key), input });
  if (str(k.sheet)) out.push({ id: 'sheet', kind: KIND, label: 'Sheet', input: k.sheet });
  for (const m of Array.isArray(k.media) ? k.media : []) {
    if (!m || (m.look && m.look !== lookIdNow)) continue;
    const input = str(m.src?.input);
    if (!input) continue;
    if (m.role === 'sheet' && input !== k.sheet) out.push({ id: `sheet:${m.id}`, kind: KIND, label: m.label ? `Sheet · ${m.label}` : 'Sheet', input });
    if (m.role === 'detail') out.push({ id: `detail:${m.id}`, kind: KIND, label: m.label ? `Detail · ${m.label}` : 'Detail', input });
  }
  for (const [key, input] of Object.entries(k.expressions || {})) if (str(input)) out.push({ id: `expr:${key}`, kind: KIND, label: viewLabel(`expr:${key}`), input });
  return out.sort((a, b) => rank(a) - rank(b));
}

// A frame's copy of its pins made whole: a character frame's only, well-formed, no repeats
export function charPins(frame) {
  if (frame?.kind !== 'character' || !Array.isArray(frame.pins)) return [];
  const seen = new Set(), out = [];
  for (const p of frame.pins) {
    if (!p || !str(p.id) || !str(p.input) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, kind: KIND, label: str(p.label) || p.id, input: p.input });
  }
  return out;
}
export const charPin = (frame, id) => (id ? charPins(frame).find((p) => p.id === id) || null : null);

// The frame with the character's pins on it, or the same frame when nothing changed (so a redraw can be skipped)
export function mirrorPins(frame, c, lookId = null) {
  if (frame?.kind !== 'character') return frame;
  const pins = pinsOf(c, lookId);
  const same = charPins(frame);
  if (same.length === pins.length && same.every((p, i) => p.id === pins[i].id && p.input === pins[i].input && p.label === pins[i].label)) return frame;
  return { ...frame, pins };
}
// What a wire from a pin carries, in words
export const charPinLabel = (frame, id) => charPin(frame, id)?.label || 'a picture that is gone';
