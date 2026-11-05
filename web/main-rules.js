// A frame's main source (frame.main), its rules with no DOM (node --test tests/main_rules.test.mjs).
//
// One layer (an image frame), one clip (a video frame) or one item (a sound frame) can be pinned as the frame's main source:
// frame.main is that layer's key or that item's id inside the frame's document. While it is set, what asks the frame for its
// content (frame-source.js: Make's "this frame" field, the Edit ops' source, a wire out of the frame) gets the pinned thing
// alone. A pin whose layer or item is gone counts as no pin (mainOf gives null).
//
//   mainOf(frame, doc)          the pinned layer / item in doc (a payload, or { payload }), or null
//   mainName(frame, doc)        the words for it ("Main: <name>"), or null
//   plainLayer(l, layers)       a layer that passes straight through as its own file (input name), else null
//   keepMain(made, frame, doc)  made (what a chain run landed: layer keys / item ids) less the pinned one: never removed
//   withoutMade(doc, made)      the payload less what made names (an image: the layers with those keys and their masks; else the items)
//   pinStamp(frame)             what frame.main adds to the frame's content stamp ('' when unpinned)
import { withoutLayers } from './chain-rules.js';

const payloadOf = (doc) => (doc && typeof doc === 'object' && doc.payload && typeof doc.payload === 'object' ? doc.payload : doc) || null;
const near = (v, to, eps = 1e-6) => v == null || Math.abs(v - to) < eps;

export function mainOf(frame, doc) {
  const id = frame?.main, p = payloadOf(doc);
  if (id == null || id === '' || !p) return null;
  if (frame.kind === 'image' || (frame.kind == null && Array.isArray(p.layers))) {
    return (p.layers || []).find((l) => l && !l.maskOf && !l.mask && !l.draft && l.key === id) || null;
  }
  return (p.items || []).find((it) => it && it.id === id) || null;
}

export function mainName(frame, doc) {
  const m = mainOf(frame, doc);
  if (!m) return null;
  const file = (n) => String(n || '').split('/').pop() || null;
  return m.label || file(m.name) || (m.src?.input ? file(m.src.input) : null) || (m.src?.media ? file(m.src.media) : null)
    || (m.src?.generation != null ? `#${m.src.generation}` : null) || (frame.kind === 'image' ? 'a layer' : 'a clip');
}

// A layer that is its own file as it shows (whole, unturned, unmirrored, fully opaque, no adjust, fill or mask): its input
// name, else null. Its place and size on the canvas don't change its pixels, so they don't count.
export function plainLayer(l, layers = []) {
  if (!l?.name || l.mask || l.maskOf || l.draft || l.canvas || l.fill || l.adjust || l.chans) return null;
  const c = l.crop || { x: 0, y: 0, w: 1, h: 1 };
  if (!(near(c.x, 0) && near(c.y, 0) && near(c.w, 1) && near(c.h, 1))) return null;
  if (!near(l.rotation || 0, 0) || !near(l.opacity, 1) || l.flipX || l.flipY) return null;
  if (l.key && (layers || []).some((m) => m && m.maskOf === l.key && !m.maskOff)) return null;
  return l.name;
}

export function keepMain(made, frame, doc) {
  const list = Array.isArray(made) ? made : [];
  const m = mainOf(frame, doc);
  if (!m) return list;
  const isLayer = frame.kind === 'image' || (frame.kind == null && Array.isArray(payloadOf(doc)?.layers));
  const id = isLayer ? m.key : m.id;
  return list.filter((x) => x !== id);
}

export function withoutMade(doc, made) {
  const p = payloadOf(doc);
  if (!p || !Array.isArray(made) || !made.length) return p;
  if (Array.isArray(p.layers)) return { ...p, layers: withoutLayers(p.layers, made).layers };
  const gone = new Set(made);
  return { ...p, items: (p.items || []).filter((it) => !gone.has(it?.id)) };
}

export const pinStamp = (frame) => (frame?.main != null && frame.main !== '' ? `+m:${frame.main}` : '');
