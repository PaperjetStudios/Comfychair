// The runs an edit is still owed, kept in this browser so they land even if the page reloads while they run. What's kept is only enough to place
// the result: the picture itself stays with the run. And where a variation goes. Pure logic (node --test tests/owed_runs.test.mjs).

const WEEK = 7 * 24 * 3600 * 1000;

// What a run needs to land later. src: what was sent; its layer's place is copied, as a layer can't be stored.
export function owedRecord(tab, opId, src, g, nth = 0, now = Date.now()) {
  const w = src.was;
  return { id: g.id, prompt: g.prompt_id, tab, op: opId, nth, at: now, name: src.name, px: src.px, rect: src.rect,
    was: w ? { name: w.name, ...(w.key ? { key: w.key } : {}), crop: w.crop, x: w.x, y: w.y, scale: w.scale, w: w.img?.naturalWidth || w.w, h: w.img?.naturalHeight || w.h,
      rotation: w.rotation || 0, flipX: !!w.flipX, flipY: !!w.flipY } : null };
}
// The list with this run in it. An edit that is never opened again must not keep its runs for ever, so old ones go.
export const withOwed = (list, rec, now = Date.now()) => [...list.filter((r) => r.id !== rec.id && now - r.at < WEEK), rec];
export const withoutOwed = (list, id) => list.filter((r) => r.id !== id);
export const owedFor = (list, tab) => list.filter((r) => r.tab === tab);
// Run ids are reused after a delete: a run that has another prompt is another run, and this one is gone.
export const sameRun = (rec, g) => !!g && g.prompt_id === rec.prompt;

// The original of a result, in the layers as they are now (a reload or another edit makes new layer objects): by its key, or its picture and crop. null if it has gone.
export function layerOf(layers, was) {
  if (!was) return null;
  const crop = JSON.stringify(was.crop), rows = layers.filter((l) => !l.mask && !l.maskOf);
  return (was.key && rows.find((l) => l.key === was.key)) || rows.find((l) => l.name === was.name && JSON.stringify(l.crop) === crop) || null;
}

// Where variation nth of a picture goes: side by side from the original's place, so each can be seen. A canvas of a fixed size would cut off the
// ones past its edge, so there they stay in one place.
export function besideX(rect, nth = 0, fixedCanvas = false) {
  return fixedCanvas ? rect.x : rect.x + nth * (rect.w + Math.round(rect.w * 0.02));
}
