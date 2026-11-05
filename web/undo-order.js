// One order for Undo while a frame is live on the table. The live engine keeps its own history (paint.js, undo-history.js,
// scene-data.js) and the table keeps its own (table.js H); a table step made while the frame is live (the Output size,
// the main-source pin, a wire or field set from the Make pane, a result frame) must undo in its place among the engine's.
// Each such table step is noted with the engine's state just after it (sig: a string the engine gives, scene JSON or the
// like). Ctrl+Z: when the engine is where it was just after the newest table step, nothing has happened in it since, so
// that table step goes first; otherwise the engine's own step does. Redo the same way round. No DOM (tests/undo_order.test.mjs).
export function undoOrder() {
  let past = [], future = [];   // [{ entry, sig }], oldest first: entry is the table's own undo step
  const pick = (list, sig, engineCan) => {
    const m = list.at(-1);
    if (!m) return 'engine';
    return m.sig === sig || !engineCan ? 'table' : 'engine';
  };
  return {
    // a table step was made while live; sig: the engine's state now (after the step's own effects)
    made(entry, sig) { past.push({ entry, sig }); future = []; },
    // who goes first: 'table' or 'engine'. engineCan: the engine has a step that way (none: the table's goes)
    undoBy: (sig, engineCan = true) => pick(past, sig, engineCan),
    redoBy: (sig, engineCan = true) => pick(future, sig, engineCan),
    // the newest table step, without taking it (null: none)
    top: () => past.at(-1)?.entry ?? null,
    next: () => future.at(-1)?.entry ?? null,
    // the table step was undone / redone: it moves across; set .sig on what comes back once the step has finished
    undone() { const m = past.pop(); if (m) future.push(m); return m || null; },
    redone() { const m = future.pop(); if (m) past.push(m); return m || null; },
    // a step that is no longer the table's to undo (dropped off its list): forgotten
    drop(entry) { past = past.filter((m) => m.entry !== entry); future = future.filter((m) => m.entry !== entry); },
    can: () => [past.length > 0, future.length > 0],
    clear() { past = []; future = []; },
  };
}
