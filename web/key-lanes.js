// Keyframe lanes: After Effects style twirl-down rows under a clip, one per keyed channel, showing its keys as
// diamonds that can be selected, dragged in time, copied, pasted, deleted and given an ease. The keys are the
// clip's own (keys.js: item.chans[ch] = [{ f, v, ease? }], f in source time); the rules are in key-lane-rules.js.
//   keyLaneRows(it, { pps, fps, tc, channels: [{ ch, label }], eases: [names], base: { ch: unset value }, seek(t), changed() })
//   -> one div.tl-keylane per channel that has keys, in order. Moving a key calls changed() once at the end of the drag.
import { h } from './ui.js';
import { track, setEase, EASES } from './keys.js';
import { snapOn } from './gizmo.js';
import { pressMenu, openPressMenu } from './press-menu.js';
import { keyMenu } from './layer-menu.js';
import {
  shownKeys, keyTime, keyX, fAtX, selKey, isSel, pickKey, remapSel, moveRange, clampShift, movedF, boxKeys,
  compatible, pastePlan, mergeKeys, keyTitle,
} from './key-lane-rules.js';

let sel = new Set();          // selected keys of the timeline pressed last (selKey strings); a press anywhere else clears them
let clip = null;              // { ch, keys } copied
const rows = new Map();       // `${id}|${ch}` -> the row built last (rows of a dropped render are skipped by isConnected)
let scope = null;             // the timeline (.tl-inner) the last key-lane press was in: only its rows are acted on
const live = () => [...rows.values()].filter((r) => r.lane.isConnected && (!scope || scope.contains(r.lane)));
const pressedIn = (lane) => { scope = lane.closest('.tl-inner') || null; };
const shown = (r) => shownKeys(r.it.chans?.[r.ch], r.it.in, r.len);
const picked = (r) => shown(r).filter((k) => isSel(sel, r.it.id, r.ch, k.f));
const paint = () => { for (const r of live()) for (const [k, d] of r.dots) d.classList.toggle('on', isSel(sel, r.it.id, r.ch, k.f)); };
const dragWindow = (move, up) => {
  const end = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); up?.(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
};
const easeLabel = (e) => (EASES.find(([n]) => n === e) || [e, e || 'Layer default'])[1];
const once = (fns) => { for (const f of new Set(fns)) f?.(); };

// Keys while the last press was on a key lane and keys are picked: Delete / Backspace, Ctrl+C, Ctrl+V (at the key last
// pressed). Caught on the window before anything else (the timeline's own Delete / copy / paste would take the clip), so it
// works after a redraw has taken the focus off the diamond. A press anywhere else hands the keys back.
let last = null;   // { id, ch, f }: the lane (and key) pressed last; null: the last press was elsewhere
addEventListener('pointerdown', (e) => {
  if (e.target.closest?.('.tl-keylane, .press-menu')) return;
  last = null;
  scope = null;
  if (sel.size) { sel = new Set(); paint(); }   // (keys picked in a timeline left behind are never acted on from another)
}, true);
addEventListener('keydown', (e) => {
  if (!last || e.defaultPrevented || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase(), r = rows.get(`${last.id}|${last.ch}`);
  const del = !mod && (e.key === 'Delete' || e.key === 'Backspace');
  if (!(del || (mod && !e.shiftKey && !e.altKey && (key === 'c' || key === 'v')))) return;
  if (key === 'v' ? !(clip && r?.lane.isConnected) : !live().some((x) => picked(x).length)) return;
  e.preventDefault(); e.stopPropagation();
  if (del) removeSelected();
  else if (key === 'c') copySelected(live().find((x) => picked(x).length));
  else pasteInto(r, last.f ?? picked(r)[0]?.f ?? r.it.in);
}, true);

function removeSelected() {
  const fns = [];
  for (const r of live()) {
    const gone = new Set(picked(r));
    if (!gone.size) continue;
    const T = track(r.it, r.ch);
    T.keys = T.keys.filter((k) => !gone.has(k));
    fns.push(r.o.changed);
  }
  sel = new Set();
  once(fns);
}
function copySelected(r) {
  const keys = picked(r);
  if (keys.length) clip = { ch: r.ch, keys: JSON.parse(JSON.stringify(keys)) };
}
function pasteInto(r, t) {
  if (!clip || !compatible(clip.keys, r.it.chans?.[r.ch])) return;
  const { keys } = pastePlan(clip.keys, t, { lo: r.it.in, hi: r.it.in + r.len, fps: r.o.fps });
  if (!keys.length) return;
  const T = track(r.it, r.ch);
  T.keys = mergeKeys(T.keys, keys);
  sel = new Set(keys.map((k) => selKey(r.it.id, r.ch, k.f)));
  r.o.changed?.();
}
function easeSelected(name) {
  const all = live(), keys = new Set(all.flatMap(picked));
  if (!keys.size) return;
  setEase(keys, name, all.map((r) => track(r.it, r.ch)));
  once(all.filter((r) => picked(r).length).map((r) => r.o.changed));
}

// drag every selected key by the same time; only the dots move until the pointer lifts
function dragKeys(e, r, key) {
  const group = live().map((g) => ({ g, keys: picked(g) })).filter((x) => x.keys.length);
  const start = new Map(group.flatMap(({ keys }) => keys.map((k) => [k, k.f])));
  const range = group.map(({ g }) => moveRange(g.it.chans[g.ch], (k) => start.has(k), { lo: g.it.in, hi: g.it.in + g.len, fps: g.o.fps }));
  const mn = Math.max(...range.map((x) => x[0])), mx = Math.min(...range.map((x) => x[1]));
  const x0 = e.clientX, pps = r.o.pps;
  let moved = false, d = 0;
  dragWindow((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    const grid = snapOn('tl', ev);
    d = clampShift((ev.clientX - x0) / pps, [mn, mx], { fps: r.o.fps, grid });
    for (const { g, keys } of group) for (const k of keys) {
      k.f = movedF(start.get(k), d, { lo: g.it.in, hi: g.it.in + g.len, fps: g.o.fps, grid });
      g.dots.get(k).style.left = `${keyX(g.it, k.f, g.o.pps)}px`;
    }
  }, () => {
    if (!moved) { if (!key.toggle) sel = new Set([selKey(r.it.id, r.ch, start.get(key.k))]); paint(); return; }
    for (const { g, keys } of group) {
      sel = remapSel(sel, g.it.id, g.ch, keys.map((k) => [start.get(k), k.f]));
      const T = track(g.it, g.ch);
      T.keys = [...T.keys].sort((a, b) => a.f - b.f);
    }
    once(group.map(({ g }) => g.o.changed));
  });
}

function boxSelect(e, r) {
  const lane = r.lane, rect = lane.getBoundingClientRect(), x0 = e.clientX - rect.left;
  const add = e.shiftKey || e.ctrlKey || e.metaKey, base = add ? new Set(sel) : new Set();
  const box = h('div', { class: 'tl-keybox' });
  let moved = false;
  dragWindow((ev) => {
    const x1 = ev.clientX - rect.left;
    if (!moved && Math.abs(x1 - x0) < 3) return;
    if (!moved) { moved = true; lane.append(box); }
    Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, width: `${Math.abs(x1 - x0)}px` });
    sel = new Set(base);
    for (const k of boxKeys(shown(r), r.it, r.o.pps, x0, x1, 0)) sel.add(selKey(r.it.id, r.ch, k.f));
    paint();
  }, () => { box.remove(); if (!moved) { sel = base; paint(); } });
}

export function keyLaneRows(it, o) {
  const len = Math.max(0, (it.out ?? (it.dur || 3)) - (it.in || 0));
  return (o.channels || []).filter(({ ch }) => it.chans?.[ch]?.length).map(({ ch, label }) => {
    const lane = h('div', { class: 'tl-lane tl-keys' });
    const r = { it, ch, o, len, lane, dots: new Map() };
    rows.set(`${it.id}|${ch}`, r);
    const menuAt = (k) => (ev) => {
      if (!isSel(sel, it.id, ch, k.f)) { sel = new Set([selKey(it.id, ch, k.f)]); paint(); }
      const eases = (o.eases || []).map((n) => ({ id: `ease:${n}`, label: easeLabel(n), run: () => easeSelected(n) }));
      const ok = clip && compatible(clip.keys, it.chans[ch]);
      const act = { copy: () => copySelected(r), paste: () => pasteInto(r, k.f), delete: removeSelected };
      const groups = keyMenu({ n: picked(r).length, canPaste: !!ok, eases: o.eases || [] }).map((g) => g.map((m) => (m.sub
        ? { ...m, subItems: undefined, sub: [eases] } : { ...m, run: act[m.id] })));
      openPressMenu(ev.clientX, ev.clientY, groups, 'Keys');
    };
    for (const k of shownKeys(it.chans[ch], it.in, len)) {
      const dot = h('button', { type: 'button', class: 'tl-keydot' + (isSel(sel, it.id, ch, k.f) ? ' on' : ''),
        style: `left:${keyX(it, k.f, o.pps)}px`, title: keyTitle(label, k, keyTime(it, k.f), o.tc) });
      dot.addEventListener('pointerdown', (e) => {
        last = { id: it.id, ch, f: k.f };
        pressedIn(lane);
        e.stopPropagation();   // (the timeline under it never sees a press on a key, nor its right click)
        if (e.button) {   // a right click on a key not picked picks it alone, so its menu is about it (layer-menu pickedFor)
          if (!isSel(sel, it.id, ch, k.f)) { sel = new Set([selKey(it.id, ch, k.f)]); paint(); }
          return;
        }
        const toggle = e.shiftKey || e.ctrlKey || e.metaKey, was = isSel(sel, it.id, ch, k.f);
        if (toggle) { sel = pickKey(sel, it.id, ch, k.f, true); paint(); if (was) return; }
        else if (!was) { sel = pickKey(sel, it.id, ch, k.f, false); paint(); }
        dot.focus();
        dragKeys(e, r, { k, toggle });
      });
      dot.addEventListener('dblclick', (e) => { e.stopPropagation(); o.seek?.(keyTime(it, k.f)); });
      let heldAt = 0;
      dot.addEventListener('contextmenu', (e) => {   // the key's menu, never the clip's or the lane's under it
        e.preventDefault(); e.stopPropagation();
        if (Date.now() - heldAt < 1000) return;   // (Android sends this after a long hold, which opened it already)
        last = { id: it.id, ch, f: k.f }; pressedIn(lane);
        menuAt(k)(e);
      });
      pressMenu(dot, (e) => { if (e.type !== 'contextmenu') { heldAt = Date.now(); menuAt(k)(e); } });   // (a long hold on a tablet; the right click is above)
      r.dots.set(k, dot);
      lane.append(dot);
    }
    lane.addEventListener('pointerdown', (e) => { last = { id: it.id, ch, f: null }; pressedIn(lane); if (e.target === lane && !e.button) { e.stopPropagation(); boxSelect(e, r); } });
    lane.addEventListener('contextmenu', (e) => { if (e.target === lane) { e.preventDefault(); e.stopPropagation(); } });
    return h('div', { class: 'tl-keylane' }, h('div', { class: 'tl-head tl-keyhead' }, label), lane);
  });
}
