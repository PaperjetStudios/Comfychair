// source-rules: what a picked source is and what it can become, with no DOM (tests/source_rules.test.mjs).
// itemOf() reads every shape used today: an input name, {input}, {generation, index} (+ kind), {media} (+ kind), {frame, kind}.

const KINDS = { image: 'image', img: 'image', picture: 'image', video: 'video', clip: 'video', audio: 'audio', sound: 'audio' };
const kindOf = (v, dflt) => KINDS[String(v || '').toLowerCase()] || dflt;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i, VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const kindOfName = (name, dflt) => (AUDIO_EXT.test(name) ? 'audio' : VIDEO_EXT.test(name) ? 'video' : dflt);

// -> { kind: 'image' | 'video' | 'audio', key, src } or null. key: the same source gives the same key (see recentKey).
export function itemOf(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'string') return { kind: 'image', key: `i${x}`, src: { input: x } };
  if (typeof x !== 'object') return null;
  if (x.input != null) return { kind: 'image', key: `i${x.input}`, src: { input: x.input } };
  if (x.generation != null) {
    const index = x.index || 0;
    return { kind: kindOf(x.kind, 'image'), key: `g${x.generation}.${index}`, src: { generation: x.generation, index } };
  }
  if (x.media != null) return { kind: kindOf(x.kind, kindOfName(String(x.media), 'video')), key: `m${x.media}`, src: { media: x.media } };
  if (x.frame != null) return { kind: kindOf(x.kind, 'image'), key: `f${x.frame}`, src: { frame: x.frame } };
  return null;
}

export const accepts = (item, kinds) => !!item && (!kinds || !kinds.length || kinds.includes(item.kind));

// What it takes to use `item` where `want` ('picture' | 'clip' | 'sound' | 'any') is wanted:
// 'use' | 'frames' (pick frames out of a clip) | 'toInput' (a run's output picture becomes an input) | 'sound-of-clip' | null
export function convertPlan(item, want) {
  if (!item) return null;
  if (want === 'any' || !want) return 'use';
  if (want === 'picture') {
    if (item.kind === 'image') return item.src.generation != null ? 'toInput' : 'use';
    return item.kind === 'video' ? 'frames' : null;
  }
  if (want === 'clip') return item.kind === 'video' ? 'use' : null;
  if (want === 'sound') return item.kind === 'audio' ? 'use' : item.kind === 'video' ? 'sound-of-clip' : null;
  return null;
}

// the one Recent store's key: g12.0 (a run's output), m<name> (a media file), i<name> (an input), f<id> (a table frame)
export const recentKey = (item) => item?.key ?? null;
