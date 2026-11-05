// history: undo / redo of a document by snapshots, with no DOM (tests/undo_history.test.mjs).
//   snap() gives a plain, serialisable picture of the state; apply(snapshot) puts one back (onto the same objects, by id).
//   mark(tag) after a change records it: an identical snapshot makes no step; marks with the same tag within mergeMs
//   merge into one step (a slider drag). hold(fn) runs fn so its marks re-base the current state and make no step
//   (system writes: a clip's measured length, a scene that changed under it). sig() is the state as last marked, as a string.
export function history({ snap, apply, limit = 100, mergeMs = 500, now = Date.now }) {
  const text = () => JSON.stringify(snap());
  let cur = text(), undos = [], redos = [], tag = null, at = 0, held = 0;
  return {
    mark(t = null) {
      const s = text();
      if (s === cur) return false;
      if (held) { cur = s; return false; }
      const when = now();
      if (t != null && t === tag && undos.length && when - at <= mergeMs) { cur = s; at = when; redos = []; return true; }
      undos.push(cur); if (undos.length > limit) undos.shift();
      redos = []; cur = s; tag = t; at = when;
      return true;
    },
    undo() {
      if (!undos.length) return false;
      redos.push(cur); cur = undos.pop(); tag = null; apply(JSON.parse(cur));
      return true;
    },
    redo() {
      if (!redos.length) return false;
      undos.push(cur); cur = redos.pop(); tag = null; apply(JSON.parse(cur));
      return true;
    },
    can: () => [undos.length > 0, redos.length > 0],
    sig: () => cur,   // (the state as last marked: undo-order.js tells by it whether anything happened since)
    clear() { cur = text(); undos = []; redos = []; tag = null; },
    hold(fn) { held++; try { return fn(); } finally { held--; } },
  };
}
