// Image tools run on several selected layers one after another: one layer failing must not lose the others.
// Pure logic (node --test tests/tool_batch.test.mjs).

// Runs step(item) for each item in turn. Returns { done: [items that went through], failed: [{ item, error }] }.
export async function eachOne(items, step) {
  const done = [], failed = [];
  for (const item of items) {
    try { await step(item); done.push(item); } catch (e) { failed.push({ item, error: e?.message || String(e) }); }
  }
  return { done, failed };
}

// the line that reports the failures of a batch ('' when none): name(item) says which layer
export function failureText(label, failed, name = (x) => String(x)) {
  if (!failed.length) return '';
  return `${label} failed on ${failed.map((f) => `${name(f.item)} (${f.error})`).join(', ')}`;
}
