// The templates that draw a control map (depth, edges, scribble, pose) from a clip or a picture. The VFX tab's Quick
// effects and the Image tab's Image tools both read them here, so the two doors can't drift apart.
export const MAPS = {
  depth: { video: 'deck-depth-video', still: 'deck-depth-image' },
  canny: { video: 'deck-canny-video', still: 'deck-canny-image' },
  scribble: { video: 'deck-scribble-video', still: 'deck-scribble-image' },
  pose: { video: 'deck-pose-video', sd: 'deck-pose-sdpose', still: 'deck-pose-image', stillSd: 'deck-pose-sdpose-image' },
};

// A map's settings as a template's roles (make.js ROLES). Large at 448 px fits a 12 GB card (dev/make_quick_templates.py SIZES).
export function mapRoles(id, { depthModel = 'large', edgeAmount = 'normal' } = {}) {
  if (id === 'depth') {
    const small = depthModel === 'small';
    return { depthModel: small ? 'video_depth_anything_vits.pth' : 'video_depth_anything_vitl.pth', depthSize: small ? 518 : 448 };
  }
  const k = ['more', 'normal', 'less'].indexOf(edgeAmount);
  if (id === 'canny') return { edgeAmount: [0.2, 0.4, 0.6][k < 0 ? 1 : k] };   // Canny's low threshold
  if (id === 'scribble') return { edgeAmount: [16, 28, 40][k < 0 ? 1 : k] };   // XDoG's threshold
  return {};
}

// ---- a map of a clip on the Video tab's timeline ----
export const MAP_MAX_SECS = 20;   // (the longest the map templates are tested at: the VFX tab's limit)

// The part of a clip a map covers: all of it, or the part inside the work area's range. start and len are in the clip's own
// time, at on the timeline. capped: the clip runs on past the limit. null when the range misses the clip.
export function mapSpan(it, length, range = null, max = MAP_MAX_SECS) {
  let at = it.at, len = length;
  if (range) {
    at = Math.max(it.at, range.a);
    len = Math.min(it.at + length, range.b) - at;
    if (len <= 1e-3) return null;
  }
  return { at, start: +((it.in || 0) + at - it.at).toFixed(4), len: +Math.min(len, max).toFixed(4), capped: len > max };
}

// The lowest video track above the clip's with room for [at, at + len): a map lands over its clip. null: none has room.
export function laneAbove(tracks, items, it, at, len, lengthOf) {
  const video = tracks.filter((t) => t.kind === 'video');
  const above = video.slice(video.findIndex((t) => t.id === it.track) + 1);
  const free = (t) => !items.some((x) => x.track === t.id && x.at < at + len - 1e-6 && x.at + lengthOf(x) > at + 1e-6);
  return above.find(free)?.id || null;
}
