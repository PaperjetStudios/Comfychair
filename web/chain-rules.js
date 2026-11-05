// Rerunning a chain of wired frames (web/chain-run.js), its rules with no DOM (node --test tests/chain_rules.test.mjs):
// which frames need a rerun, and how a rerun's result takes the place of what the last chain run made.
//
// A frame's last run is kept on it as frame.make.ran = { at, sources: { wireId: stamp }, made: [id] }: the content stamp
// (table-frames.js frameStamp) of each source frame plugged in by an ON wire as the run read it, and what a chain run
// landed (an image frame: its layers' keys; a video or sound frame: its items' ids). Only a chain run fills made, and a
// chain run only ever takes out what made names.
import { downstream } from './wire-rules.js';

const hasFlow = (f) => !!f?.make?.template;

// Why each frame needs a rerun: Map(frameId -> { why: 'changed' | 'new' | 'unplugged' | 'upstream', wire?, from }).
//   changed:   a source plugged in by an ON wire has other content than the run read (wire, from: the source frame id)
//   new:       an ON wire plugged in (or turned on) since the run (wire, from)
//   unplugged: a wire the run read from is gone or off (wire: its id, from: null)
//   upstream:  a frame it is downstream of needs a rerun (from: that frame's id)
// Only frames with a workflow (frame.make.template) that have run (frame.make.ran) are judged; a source whose stamp is
// unknown (stampOf gives null: its list isn't loaded) is not held against it. A frame with no workflow downstream takes
// nothing in, so it never needs one.
export function staleInfo(wires, frames, stampOf) {
  const byId = new Map((frames || []).map((f) => [f.id, f])), out = new Map();
  const on = (wires || []).filter((w) => w && w.on !== false);
  for (const f of frames || []) {
    const ran = f?.make?.ran;
    if (!hasFlow(f) || !ran || typeof ran.sources !== 'object' || !ran.sources) continue;
    const ins = on.filter((w) => w.to === f.id);
    let why = null;
    for (const w of ins) {
      const src = byId.get(w.from), s = src ? stampOf(src) : null;
      if (s == null) continue;
      if (!(w.id in ran.sources)) { why = { why: 'new', wire: w.id, from: w.from }; break; }
      if (ran.sources[w.id] !== s) { why = { why: 'changed', wire: w.id, from: w.from }; break; }
    }
    if (!why) {
      const gone = Object.keys(ran.sources).find((id) => !ins.some((w) => w.id === id));
      if (gone) why = { why: 'unplugged', wire: gone, from: null };
    }
    if (why) out.set(f.id, why);
  }
  for (const id of [...out.keys()]) {
    for (const d of downstream(wires, id)) if (!out.has(d) && hasFlow(byId.get(d)) && byId.get(d)?.make?.ran) out.set(d, { why: 'upstream', from: id });
  }
  return out;
}
export const staleFrames = (wires, frames, stampOf) => [...staleInfo(wires, frames, stampOf).keys()];

// The words for a reason (names: frameId -> label; wires: to say "Image 1")
export function staleText(r, { name = () => 'a frame', wireName = () => 'an input' } = {}) {
  if (!r) return '';
  if (r.why === 'changed') return `${wireName(r.wire)} from "${name(r.from)}" changed after the last run.`;
  if (r.why === 'new') return `${wireName(r.wire)} from "${name(r.from)}" was plugged in (or turned on) after the last run.`;
  if (r.why === 'unplugged') return 'An input the last run read from was unplugged or turned off.';
  if (r.why === 'upstream') return `"${name(r.from)}" feeds this frame and needs a rerun first.`;
  return '';
}

// What a run read: the stamp of each source plugged in by an ON wire (an unknown stamp is left out)
export function sourceStamps(wires, frameId, frames, stampOf) {
  const byId = new Map((frames || []).map((f) => [f.id, f])), out = {};
  for (const w of wires || []) {
    if (!w || w.to !== frameId || w.on === false) continue;
    const src = byId.get(w.from), s = src ? stampOf(src) : null;
    if (s != null) out[w.id] = s;
  }
  return out;
}

// ---- an image frame: the layers a chain run landed, and taking out the last run's ----
// Layers are known by their key (l.key): a layer's name is its picture's file name, which a duplicated or pasted copy
// shares, so a name never says which layer a run made. A `made` entry from before keys were recorded (a file name) matches
// no key, so it takes nothing out.
// The keys of the layers that are new since `before` (a Set of the keys and names there were then: a layer counts as
// there if either is in it), with the label a run's results land with. A new layer with no key yet is not counted.
export function freshLayers(before, layers, label = null) {
  return (layers || []).filter((l) => l && !l.maskOf && l.key && !before.has(l.key) && !before.has(l.name)
    && (label == null || l.label === label || String(l.label || '').startsWith(`${label} · `))).map((l) => l.key);
}
// What `before` holds for these layers: each one's key and name
export const layerMarks = (layers) => new Set((layers || []).flatMap((l) => [l?.key, l?.name]).filter(Boolean));
// The layers less those with these keys (and the masks on them). Returns { layers, removed: how many went }
export function withoutLayers(layers, keys) {
  const gone = new Set((keys || []).filter(Boolean)), list = layers || [];
  const out = (l) => !l.maskOf && l.key && gone.has(l.key);
  const kept = list.filter((l) => !out(l) && !(l.maskOf && gone.has(l.maskOf)));
  return { layers: kept, removed: list.length - kept.length };
}

// ---- a video or sound frame: an item replaced in place, or added at the end of its first track ----
const len = (it) => Math.max(0.1, (it.out ?? (it.dur || 3)) - (it.in || 0));
const trackEnd = (items, track) => items.filter((i) => i.track === track).reduce((m, i) => Math.max(m, (i.at || 0) + len(i)), 0);
// A run's output in the place of item id: the same id, track, place, trim start, transform, level and fades; its own
// source, length and name. The trim end stays where it was if the new one is long enough. null: no such item.
export function replaceItem(payload, id, { src, url = null, label, dur = 0, kind }) {
  const items = payload?.items || [], at = items.findIndex((it) => it.id === id);
  if (at < 0) return null;
  const old = items[at], k = kind || old.kind, still = k === 'image';
  const start = !still && dur > 0 && (old.in || 0) >= dur ? 0 : old.in || 0;
  let out = old.out;
  if (!still) out = dur > 0 ? (old.out != null ? Math.min(dur, Math.max(start + 0.1, old.out)) : dur) : old.out ?? null;
  const it = { ...old, kind: k, src, url, label, dur: still ? old.dur ?? 0 : dur, in: start, out, thumb: null };
  return { ...payload, items: items.map((x, i) => (i === at ? it : x)) };
}
// A sound frame's mix with a run's sound at the end of its first track (sound.js newItem's shape)
export function withSoundItem(payload, { src, url = null, label, dur = 0, kind = 'audio' }, id) {
  const p = { ...(payload || {}) };
  const tracks = p.tracks?.length ? p.tracks : [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  const items = [...(p.items || [])], track = tracks[0].id;
  items.push({ id, track, kind: kind === 'video' ? 'video' : 'audio', src, url, label, dur, at: trackEnd(items, track), in: 0, out: dur || null,
    volume: 1, pan: 0, fadeIn: 0, fadeOut: 0 });
  return { ...p, tracks, items };
}
// A chain run's outputs into a document: the first takes the place of the first of the last run's items still there, the
// last run's other items go, the rest are added (append(payload, media, id) -> payload). Nothing but what made names is
// taken out. Returns { payload, made: [the ids now there for this run] }.
export function placeResults(payload, made, medias, { append, newId }) {
  let p = payload || {};
  const there = (made || []).filter((id) => (p.items || []).some((it) => it.id === id));
  if (!medias?.length) return { payload: p, made: there };   // (nothing came out: the last run's stay)
  const ids = [];
  let i = 0;
  if (there.length && medias.length) { p = replaceItem(p, there[0], medias[0]) || p; ids.push(there[0]); i = 1; }
  const drop = new Set(there.slice(ids.length));
  if (drop.size) p = { ...p, items: (p.items || []).filter((it) => !drop.has(it.id)) };
  for (; i < medias.length; i++) { const id = newId(); p = append(p, medias[i], id); ids.push(id); }
  return { payload: p, made: ids };
}
