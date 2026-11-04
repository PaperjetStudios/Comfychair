// The Frame pane's list at scale, with no DOM (table.js draws it; tests/table_list.test.mjs): what rows show for a
// search, kind filters and "selected only", groups folded by default on a long list, and a story table's scenes as
// groups of their own.
import * as ST from './layer-stack.js';
import { KIND_LABEL } from './table-model.js';

export const LONG_LIST = 30;   // more rows than this: groups and scenes start folded

// what a search matches: every word in the frame's label or its kind's name (image, video, sound, 3d, note)
const WORDS = { image: 'image picture', video: 'video clip', sound: 'sound audio', scene: '3d scene', note: 'note text' };
export function frameMatches(f, { q = '', kinds = null, selOnly = false, sel = null } = {}) {
  if (kinds?.size && !kinds.has(f.kind)) return false;
  if (selOnly && !sel?.has(f.id)) return false;
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${f.label || ''} ${KIND_LABEL[f.kind] || ''} ${WORDS[f.kind] || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
export const filtering = (find = {}) => !!(String(find.q || '').trim() || find.kinds?.size || find.selOnly);

// The groups as the list folds them: a group never folded or opened by hand is folded once the list is long
export function foldedGroups(frames, groups) {
  const long = ST.rowsOf(frames, groups.map((g) => ({ ...g, collapsed: false }))).length > LONG_LIST;
  return groups.map((g) => ({ ...g, collapsed: g.collapsed ?? long }));
}

// The rows on show, top first:
//   { group, members, real }               a group's row (members: its frames)
//   { scene: { id, name }, members }       a story scene's row (its frames not in a group, in a run)
//   { layer, in: group | null, real }      a frame; real: its place in layer-stack.js rowsOf(frames, folded groups), which
//                                          moveRow takes (null while filtering: the list can't be reordered then)
// find: { q, kinds: Set, selOnly, sel: Set }; sceneName(id) -> its name; folded(sceneId) -> true / false / undefined
export function listRows(frames, groups, { find = {}, sceneName = () => null, folded = () => undefined } = {}) {
  const on = filtering(find), eff = on ? groups.map((g) => ({ ...g, collapsed: false })) : foldedGroups(frames, groups);
  const base = ST.rowsOf(frames, eff), long = ST.rowsOf(frames, groups.map((g) => ({ ...g, collapsed: false }))).length > LONG_LIST;
  const match = (f) => frameMatches(f, find);
  const out = [];
  let scene = null;   // the scene row open now: { row, shown }
  base.forEach((r, i) => {
    if (r.group) {
      scene = null;
      const members = frames.filter((f) => f.group === r.group.id);
      if (on && !members.some(match)) return;
      out.push({ group: r.group, members, real: on ? null : i });
      return;
    }
    const f = r.layer, sid = !r.in && f.story?.scene ? f.story.scene : null;
    if (on && !match(f)) { if (!sid) scene = null; return; }
    if (!sid) scene = null;
    else if (scene?.row.scene.id !== sid) {
      const run = [];
      for (let k = i; k < base.length && base[k].layer && !base[k].in && base[k].layer.story?.scene === sid; k++) run.push(base[k].layer);
      const row = { scene: { id: sid, name: sceneName(sid) || 'Scene', folded: !on && (folded(sid) ?? long) }, members: run };
      out.push(row);
      scene = { row };
    }
    if (scene?.row.scene.folded) return;
    out.push({ layer: f, in: r.in || null, real: on ? null : i });
  });
  return out;
}
