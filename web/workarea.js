import { button, closePopover, h, numSlider, popover, toast, toggle, undoToast } from './ui.js';
import { icon } from './icons.js';
import * as M from './workarea-math.js';

// ---------------------------------------------------------------------------
// The work area: a thin teal bar along the top of a timeline's ruler that marks a range the playhead is bound
// to (After Effects' work area, Blender's preview range). Every timeline has one: the 3D key sheet (and its
// graph), Video, Sound and the Editor's animation bar. The maths is workarea-math.js (node-tested).
//
// On the ruler: the bar and its handles only (the rest of the strip is the ruler's, so scrubbing never catches it):
// drag a handle to move an end, drag the bar to slide it, tap it to put the playhead there. Ends snap to frames, and
// to the timeline's own snap points (clip edges, keys, the playhead; Alt while dragging: frames only). Outside the
// range the ruler is dimmed. The transport's Range button opens its menu (Blender's preview range): on / off, Start
// and End typed, In / Out at the playhead, the whole timeline, Clear.
// While it is on, play loops inside it (or stops at its out point with Loop off), stepping and scrubbing stay
// inside, and ⇤ / ⇥ go to its ends.
// Keys: I / O set the in / out point at the playhead (Alt+I / Alt+O where I and O are taken), Alt+X clears.
// It is saved with the tab's document ({ a, b, on } in the timeline's units). Exports offer "Range only".
//
//   const W = workArea({ get, set, len, at, pos, t, seek, step, points?, minLen?, alt?, changed? });
//   get(): the stored range or null; set(r | null): store it in the document (and save); len(): the timeline's
//   length; at(clientX): the time under a pointer; pos(t): a CSS length from the ruler's left for time t; t(): the
//   playhead; seek(t); step(): the frame size (snap grid); points(): snap points; minLen: the shortest range;
//   alt: Alt+I / Alt+O for the in / out keys; changed(): after a change (a redraw), live while dragging too.
//   unit: { show(t) the number typed for time t, read(n) back, step, label } (default seconds)
//
//   ruler.append(...W.el()); W.bound() the range the playhead is bound to (or null); W.clamp(t);
//   W.toggleBtn() for the transport; W.keyFn(e) the key's action or null; W.onlyToggle() / W.exportRange() for exports
// ---------------------------------------------------------------------------

const NONE = { none: true };   // a draft that is nothing yet (a drag too short to be a range)

export function workArea(o) {
  const minLen = () => (typeof o.minLen === 'function' ? o.minLen() : o.minLen) || 0;
  const len = () => o.len() || 0;
  const step = () => o.step?.() || 0;
  const stored = () => M.norm(o.get(), len());
  let draft = null, view = null;
  const btns = new Set();
  const cur = () => (draft ? (draft.none ? null : draft) : stored());
  const keysLabel = o.alt ? 'Alt+I / Alt+O' : 'I / O';
  const unit = { show: (t) => +t.toFixed(2), read: (n) => n, step: 0.05, label: 's', ...o.unit };

  const W = {
    only: true,   // exports: only the range (while there is one)
    stored,
    bound: () => M.bound(o.get(), len(), 0),
    clamp: (t) => M.clampT(t, W.bound()),
  };

  function commit(r) {
    const n = r && M.norm(r, len(), 0);
    o.set(n ? { a: +n.a.toFixed(4), b: +n.b.toFixed(4), on: n.on } : null);
    draft = null;
    sync();
    const b = W.bound(), t = o.t();
    if (b && (t < b.a || t > b.b)) o.seek(b.a);   // bound: the playhead goes inside
    o.changed?.();
  }
  W.set = commit;
  const here = () => M.snapT(o.t(), { step: step() });
  W.setIn = () => { if (len() > 0) commit(M.setIn(o.get(), here(), len(), minLen())); };
  W.setOut = () => { if (len() > 0) commit(M.setOut(o.get(), here(), len(), minLen())); };
  W.clear = () => {
    const before = o.get();
    if (!before) return;
    commit(null);
    undoToast('Work area cleared', () => commit(before));
  };
  W.toggle = () => {
    const r = stored();
    if (!r) return toast(`No range yet: Range, or ${keysLabel} at the playhead`, true);
    commit({ ...r, on: !r.on });
  };

  // ---- on the ruler ----
  W.el = () => {
    const hIn = h('div', { class: 'wa-h in', title: 'Drag: the in point' });
    const hOut = h('div', { class: 'wa-h out', title: 'Drag: the out point' });
    const bar = h('div', { class: 'wa-bar', title: `Work area: drag to slide · Range to type or clear it (Alt+X) · ${keysLabel} set in / out at the playhead` }, hIn, hOut);
    const band = h('div', { class: 'wa-band' }, bar);
    const dimL = h('div', { class: 'wa-dim' }), dimR = h('div', { class: 'wa-dim' });
    // a pen hovering over a handle lights it before it touches
    for (const x of [hIn, hOut, bar]) {
      x.addEventListener('pointerover', () => x.classList.add('hot'));
      x.addEventListener('pointerout', () => x.classList.remove('hot'));
    }
    bar.addEventListener('pointerdown', down);
    view = { band, bar, dimL, dimR };
    paint();
    return [dimL, dimR, band];
  };
  function paint() {
    if (!view) return;
    const r = cur(), { bar, dimL, dimR } = view;
    bar.hidden = !r;
    const dim = !!r && r.on;
    dimL.hidden = !dim; dimR.hidden = !dim;
    if (!r) return;
    const pa = o.pos(r.a), pb = o.pos(r.b);
    bar.style.left = pa; bar.style.width = `calc(${pb} - ${pa})`;
    bar.classList.toggle('off', !r.on);
    dimL.style.left = '0'; dimL.style.width = pa;
    dimR.style.left = pb; dimR.style.right = '0';
  }
  W.paint = paint;

  function down(e) {
    if (e.button > 0) return;
    const r = stored();
    if (!r) return;
    e.preventDefault(); e.stopPropagation();
    const tg = e.target;
    const mode = tg.closest('.wa-h.in') ? 'a' : tg.closest('.wa-h.out') ? 'b' : 'move';
    const x0 = e.clientX, t0 = o.at(x0);
    let moved = false;
    const snapAt = (t, ev) => M.snapT(t, { step: step(), points: ev.altKey ? [] : (o.points?.() || []),
      tol: Math.abs(o.at(ev.clientX + 8) - o.at(ev.clientX)) });
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 6) return;
      moved = true;
      const t = o.at(ev.clientX), L = len();
      if (mode === 'a' || mode === 'b') draft = M.dragEnd(r, mode, snapAt(t, ev), L, minLen());
      else {
        const w = r.b - r.a, a = r.a + (t - t0);
        const a1 = snapAt(a, ev), a2 = snapAt(a + w, ev) - w;   // whichever end lands nearer something
        draft = M.slide(r, Math.abs(a1 - a) <= Math.abs(a2 - a) ? a1 : a2, L);
      }
      paint(); o.live?.();
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (moved) { commit(draft && !draft.none ? draft : r); return; }
      draft = null;
      o.seek(W.clamp(Math.max(0, Math.min(len(), M.snapT(t0, { step: step() })))));   // a tap: the playhead goes there
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  // ---- the transport's Range button (lit while the playhead is bound to it): its menu ----
  W.toggleBtn = () => {
    const b = h('button', { type: 'button', class: 'btn small wa-tog', onclick: (e) => W.menu(e.currentTarget),
      title: `Range: a part of the timeline the playhead stays in (${keysLabel} at the playhead, Alt+X clears)` }, icon('range'), 'Range');
    btns.add(b); syncBtn(b);
    return b;
  };
  W.menu = (anchor) => {
    const L = len();
    if (!(L > 0)) return toast('Nothing on the timeline yet', true);
    const r = stored(), again = () => { closePopover(); W.menu(anchor); };
    const num = (label, v, fn) => {
      const i = numSlider({ min: unit.show(0), max: unit.show(L), step: unit.step, value: unit.show(v), label: `${label} (${unit.label})` });
      i.style.width = '92px';
      i.addEventListener('change', () => { const n = parseFloat(i.value); if (Number.isFinite(n)) { fn(unit.read(n)); again(); } });
      return h('label', { class: 'keynum' }, `${label}`, i);
    };
    const cur = r || { a: 0, b: L, on: true };
    const act = (label, fn, cls = 'small ghost') => button(label, () => { fn(); again(); }, { cls });
    popover(anchor,
      h('b', {}, 'Range'),
      r ? toggle('Keep the playhead in it', r.on, (on) => { commit({ ...r, on }); again(); }) : h('span', { class: 'hint' }, 'No range yet: set one below'),
      h('div', { class: 'row' },
        num('Start', cur.a, (t) => commit(M.dragEnd(cur, 'a', t, L, minLen()))),
        num('End', cur.b, (t) => commit(M.dragEnd(cur, 'b', t, L, minLen())))),
      h('div', { class: 'row wrap' }, act(`In here (${o.alt ? 'Alt+I' : 'I'})`, W.setIn), act(`Out here (${o.alt ? 'Alt+O' : 'O'})`, W.setOut),
        act('Whole timeline', () => commit({ a: 0, b: L, on: true }))),
      r ? button('Clear (Alt+X)', () => { closePopover(); W.clear(); }, { cls: 'small ghost danger' }) : null);
  };
  function syncBtn(b) {
    const r = stored();
    b.hidden = false;
    b.classList.toggle('on', !!r?.on);
    b.setAttribute('aria-pressed', String(!!r?.on));
  }
  function sync() {
    for (const b of btns) {
      if (b.isConnected) b.seen = true; else if (b.seen) { btns.delete(b); continue; }
      syncBtn(b);
    }
    paint();
  }
  W.sync = sync;

  // ---- keys: I / O (Alt+I / Alt+O with alt) set in / out at the playhead, Alt+X clears ----
  W.keyFn = (e) => {
    if (e.ctrlKey || e.metaKey) return null;
    if (e.altKey && e.code === 'KeyX') return W.clear;
    if (e.altKey !== !!o.alt) return null;
    return e.code === 'KeyI' ? W.setIn : e.code === 'KeyO' ? W.setOut : null;
  };

  // ---- exports: "Range only" (on by default while there is a range) ----
  W.onlyToggle = (onChange = null) => (stored() ? toggle('Range only', W.only, (on) => { W.only = on; onChange?.(on); },
    { title: 'Export only the work area (the teal range on the ruler)' }) : null);
  W.exportRange = () => (W.only ? stored() : null);
  return W;
}
