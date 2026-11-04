// The Setups row's rules (web/setups.js draws it): which block a setup belongs to, when the shown values differ from
// a setup's, and the order the list shows. No DOM here, so tests/setups_rules.test.mjs can load it.
//
// A setup (store kind `setups`, global scope) is {v:1, key, values, note?}: `key` names the parameter block,
// `values` is that block's own value map. Keys:
//   tpl:<template id>          a template's fields (the Make pane): field key -> value, as gen-presets keep them
//   edit:<kind>.<op>           an Edit pane op (video, sound, 3D); an image op is the Image tool it runs (tool:<id>)
//   tool:<id>                  an Image tool (the Layers pane and the Edit pane share its settings)
//   vfx:<op>                   a VFX effect
//   sound:maker.<id> / sound:voice   the Sound tab's Make a sound (per maker) and Voice sections
//   scene:<op>                 the 3D tab's prompt and render settings (scene:out)

export const tplKey = (id) => (id ? `tpl:${id}` : null);
export const toolKey = (id) => (id ? `tool:${id}` : null);
export const editKey = (kind, op) => (!kind || !op ? null : kind === 'image' ? toolKey(op) : `edit:${kind}.${op}`);
export const vfxKey = (op) => (op ? `vfx:${op}` : null);
export const soundMakerKey = (id) => (id ? `sound:maker.${id}` : null);
export const SOUND_VOICE = 'sound:voice';
export const sceneKey = (op) => (op ? `scene:${op}` : null);
// the template a tpl: key names (its old gen-presets are listed beside it), or null
export const tplOfKey = (key) => (typeof key === 'string' && key.startsWith('tpl:') ? key.slice(4) || null : null);

// JSON with object keys sorted, so {a,b} and {b,a} read the same
export function stable(v) {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
// The shown values differ from a setup's: any key, in either, with another value (a missing key reads as null)
export function differs(cur, saved) {
  const a = cur || {}, b = saved || {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (stable(a[k]) !== stable(b[k])) return true;
  return false;
}
// newest first (last saved or updated), then by name
export const sortSetups = (list) => [...(list || [])].sort((x, y) => (y.updated || 0) - (x.updated || 0) || String(x.name || '').localeCompare(String(y.name || '')));
export const forKey = (list, key) => (list || []).filter((s) => s.key === key);

// a stored document (a full listing's row) as a setup
export const toSetup = (d) => ({ id: d.id, name: d.name || d.id, rev: d.rev, updated: d.updated || 0, key: d.payload?.key || null,
  values: d.payload?.values || {}, note: d.payload?.note || null });
// a project's gen-presets document as a read-only entry under its template's tpl: key
export const fromPreset = (d) => ({ id: `preset:${d.id}`, name: `${d.name || d.id} (project)`, rev: d.rev, updated: d.updated || 0,
  key: tplKey(d.payload?.template), values: d.payload?.values || {}, readOnly: true });

// these keys of obj (a deep copy), and obj without them
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(obj[k]))]));
export const omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k, v]) => !keys.includes(k) && v !== undefined).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
