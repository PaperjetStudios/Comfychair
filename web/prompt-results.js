// What the prompt helper wrote, kept so opening it again shows it instead of writing it again (no DOM: tests/prompt_results.test.mjs).
// A set is one writing: { kind, root, src, mode, fam, variants: [{ text }], seconds, device, at }. root ties together what came from one
// prompt: a version that was used and is now the prompt still belongs to the prompt it came from.
export const MAX_SETS = 40;
const clean = (s) => String(s ?? '').trim();
export function rootOf(sets, kind, src) {
  const t = clean(src);
  return (sets || []).find((s) => s.kind === kind && (s.root === t || s.src === t || s.variants?.some((v) => clean(v.text) === t)))?.root ?? t;
}
export const setsFor = (sets, kind, root) => (sets || []).filter((s) => s.kind === kind && s.root === root);
export const setFor = (sets, kind, root, mode, fam) => setsFor(sets, kind, root).find((s) => s.mode === mode && s.fam === fam) || null;
// newest first; the oldest fall off
export const withSet = (sets, set) => [set, ...(sets || [])].slice(0, MAX_SETS);
