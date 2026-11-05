// Nodes on the table, with no DOM (node tests them: tests/node_rules.test.mjs). A node is an ordinary frame whose workflow
// (frame.make) has its picture or clip slot pointed at a wire, so a run, a chain rerun, the needs-rerun badge and the Make
// pane all work on it as on any frame. This file says what a wire let go on empty table can start.
//
//   nodeGroups(templates, wireKind)      [{ title, items: [{ id, label, icon, tpl, kind, keepSize }] }]: maps and tools whose template is there
//   otherTemplates(templates, wireKind, q)   every other template that takes that wire, for the panel's search
//   slotFor(t, wireKind)                 the field a wire of that kind fills
//   nodeMake(t, wireId, wireKind, secs)  frame.make for a new node; secs: the source clip's length, for a Length field
//   nodeSize(src)                        the size a node comes out at: its source's, a sound source a plain default
//   emptyFeeders(wires, frames, id, isEmpty)  nodes feeding id that have never run and show nothing, in run order. A frame keeps a
//                                        template just from being selected, so a plain picture or clip never counts: only a frame fed by a wire.
import { MAPS, MAP_MAX_SECS } from './maps.js';
import { OPS } from './edit-rules.js';
import { fieldKind, upstream } from './wire-rules.js';
import { fitsKind, frameOutput } from './make-rules.js';

const MAP_ITEMS = [['depth', 'Depth map', 'grid'], ['canny', 'Canny edges', 'grid'], ['scribble', 'Scribble', 'grid'], ['pose', 'Pose', 'figure']];
// Tools that run from their template alone. The others keep marks or state on the frame they run on, so they aren't nodes.
const IMAGE_TOOLS = ['up', 'upfast', 'clean', 'cutout', 'words'];
const VIDEO_TOOLS = ['upscale', 'upvideo', 'upvideofast', 'cleanplate', 'alpha'];

export const slotFor = (t, wireKind) => (t?.fields || []).find((f) => fieldKind(f) === wireKind) || null;
const usable = (templates, id, wireKind) => {
  const t = (templates || []).find((x) => x.id === id);
  return t && !t.error && slotFor(t, wireKind) ? t : null;
};
const opItems = (templates, kind, ids) => ids.map((id) => OPS[kind].find((o) => o.id === id)).filter(Boolean)
  .filter((o) => usable(templates, o.tpl, kind))
  .map((o) => ({ id: o.id, label: o.label, icon: o.icon, tpl: o.tpl, kind, keepSize: kind === 'image' }));

export function nodeGroups(templates, wireKind) {
  if (wireKind !== 'image' && wireKind !== 'video') return [];
  const key = wireKind === 'image' ? 'still' : 'video';
  const maps = MAP_ITEMS.filter(([id]) => usable(templates, MAPS[id][key], wireKind))
    .map(([id, label, icon]) => ({ id, label, icon, tpl: MAPS[id][key], kind: wireKind, keepSize: wireKind === 'image' }));
  const tools = opItems(templates, wireKind, wireKind === 'image' ? IMAGE_TOOLS : VIDEO_TOOLS);
  return [{ title: 'Maps', items: maps }, { title: 'Tools', items: tools }].filter((g) => g.items.length);
}

const MEDIA_KIND = { image: 'image', video: 'video', audio: 'sound' };
// The frame kind a template's result lands in
export const landsIn = (t) => (fitsKind(t, 'scene') ? 'scene' : MEDIA_KIND[t?.media] || null);
export function otherTemplates(templates, wireKind, q = '') {
  const shown = new Set(nodeGroups(templates, wireKind).flatMap((g) => g.items.map((i) => i.tpl)));
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (templates || []).filter((t) => !t.error && !shown.has(t.id) && slotFor(t, wireKind) && landsIn(t))
    .filter((t) => { const s = `${t.name} ${t.family || ''}`.toLowerCase(); return words.every((w) => s.includes(w)); });
}

const isLength = (f) => (f.kind === 'int' || f.kind === 'float') && /length|seconds|duration/i.test(f.label || '');
export function nodeMake(t, wireId, wireKind, secs = 0) {
  const slot = slotFor(t, wireKind), overrides = {};
  const len = wireKind === 'video' && secs > 0 ? (t.fields || []).find(isLength) : null;
  if (len) overrides[len.key] = len.kind === 'int' ? Math.round(Math.min(MAP_MAX_SECS, secs)) : +Math.min(MAP_MAX_SECS, secs).toFixed(2);
  return { v: 1, template: t.id, presetId: null, overrides, wired: slot ? { [slot.key]: wireId } : {} };
}

export function nodeSize(src, kind = 'image') {
  const o = src?.kind === 'sound' ? null : frameOutput(src);
  if (o) return { w: o.w, h: o.h };
  return kind === 'video' ? { w: 1024, h: 576 } : { w: 1024, h: 1024 };
}

export function emptyFeeders(wires, frames, id, isEmpty) {
  const byId = new Map((frames || []).map((f) => [f.id, f]));
  const fed = new Set((wires || []).filter((w) => w.on !== false).map((w) => w.to));
  return upstream(wires, id).filter((x) => { const f = byId.get(x); return f?.make?.template && !f.make.ran && fed.has(x) && isEmpty(f); });
}
