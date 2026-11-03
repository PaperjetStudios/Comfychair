// Which names a search finds, as plain maths (tests/lora_match.test.mjs): every word typed, anywhere in the name, whatever its case. "_", "-" and "." count as
// spaces, so "detail tweak" finds detail_tweaker-v2. A name starting with the first word comes first; otherwise the list's own order stays.
const plain = (s) => String(s).toLowerCase().replace(/[_\-.]+/g, ' ');
export function matchNames(list, q, text = (x) => x) {
  const words = plain(q).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  const hits = list.filter((o) => { const t = plain(text(o)); return words.every((w) => t.includes(w)); });
  const first = (o) => (plain(text(o)).startsWith(words[0]) ? 0 : 1);
  return hits.map((o, i) => [o, i]).sort((a, b) => first(a[0]) - first(b[0]) || a[1] - b[1]).map(([o]) => o);
}
