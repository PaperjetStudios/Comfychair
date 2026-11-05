// The table's frame menu, its extras (table.js fires table:menu; they go before Delete):
//   Edit ▸          the selected frames' edits (edit-rules.js menuGroupsFor; several kinds: "Edit image ▸", "Edit video ▸";
//                   pictures and sounds: "Make video ▸"). A pick opens that edit in the Edit pane (edit-panel.js showOp) for
//                   the frames selected. What used to be Use as (3D, Track motion, Its sound, Render, Finish…) is an op there.
//   Make from this note   a selected note with words: the Make pane on show (its words are the prompt: make-panel.js)
//   Compare with…   one frame with a picture (shelf.js compareSheet)
//   Open in …       an image frame in PhotoCraft (its picture), a video frame's edit in EffectCraft (its clips)
//   Run from here   this frame's workflow, then everything it feeds through wires, in order (chain-run.js); shown when it
//                   or anything downstream has a workflow. Rerun what uses this: the frames it feeds only; shown when
//                   something is plugged out of it
// Nothing here opens another screen: a result is a frame beside it, or a layer or clip in it.
import { api, toast } from './ui.js';
import { S } from './core.js';
import { isLive } from './live.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND, outputOf } from './table-model.js';
import { downstream } from './wire-rules.js';

const R = { rules: null, source: null };
import('./edit-rules.js').then((m) => { R.rules = m; }).catch(() => {});   // (the Edit pane's rules; no Edit ▸ without them)
import('./frame-source.js').then((m) => { R.source = m; }).catch(() => {});
import('./table.js').then((m) => { R.table = m; }).catch(() => {});

const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
const dropInput = (name) => api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});

// Edit ▸: [{ label, sub }] (one entry per kind); an item opens that edit in the Edit pane for these frames
export function editEntries(frames, menuGroupsFor = R.rules?.menuGroupsFor) {
  if (!menuGroupsFor) return [];
  const list = frames.filter((f) => f.kind !== 'note');
  if (!list.length) return [];
  let got;
  try { got = menuGroupsFor(list, { live: (f) => isLive(f.id) }) || []; } catch (e) { console.warn('edit menu', e); return []; }
  return got.filter((k) => k.groups?.some((g) => g.length)).map((k) => ({
    id: `edit:${k.kind}`, label: `${k.title || 'Edit'} ▸`,
    sub: k.groups.map((g) => g.map((op) => ({ label: op.disabled ? `${op.label} (open the frame)` : op.label, title: op.why || null,
      run: () => showOp(k.kind, op.id, k.cross ? list : list.filter((f) => f.kind === k.kind)) }))),
  }));
}
async function showOp(kind, id, frames) {
  try { (await import('./edit-panel.js')).showOp(kind, id, frames); } catch (e) { toast(`The Edit pane isn't there: ${e.message}`, true); }
}

// Open in PhotoCraft (an image frame's picture, one layer) / EffectCraft (a video frame's clips, as its timeline has them)
async function craftImage(f) {
  const r = await R.source.frameSource(f);
  try {
    await (await import('./craft.js')).sendToCraft('photo', { title: f.label || 'Frame', canvas: { w: r.px[0], h: r.px[1], bg: null },
      layers: [{ name: f.label || 'Frame', src: { input: r.name }, crop: null, rect: { x: 0, y: 0, w: r.px[0], h: r.px[1] }, opacity: 1, blend: 'normal' }] }, null, { frame: f });
  } finally { dropInput(r.name); }   // (PhotoCraft's document has its own copy)
}
async function craftVideo(f) {
  const d = await api(`/api/store/${DOC_KIND.video}/${f.doc}${qs()}`, { busy: false });
  const p = d?.payload || {};
  const items = (p.items || []).filter((it) => it.src && it.kind !== 'scene');
  if (!items.length) return toast(`"${f.label}" has no clips to send`, true);
  await (await import('./craft.js')).sendToCraft('video', { title: f.label || 'Video edit', width: outputOf(f).w, height: outputOf(f).h, fps: p.fps || null,
    tracks: (p.tracks || []).map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),
    items: items.map((it) => ({ track: it.track, at: it.at, name: it.label, src: it.src, in: it.in, out: it.out ?? it.dur, x: it.x, y: it.y, scale: it.scale,
      fit: it.fit, rotation: it.rotation || 0, opacity: it.opacity, volume: it.volume, fade_in: it.fadeIn, fade_out: it.fadeOut })) }, null, { frame: f });
}
const tryIt = (fn) => async () => { try { await fn(); } catch (e) { toast(e.message, true); } };

// Run from here / Rerun what uses this, for one frame (wires: the table's; byId: a frame by id)
export function chainEntries(one, wires, byId) {
  if (!one || one.kind === 'note') return [];
  const flow = (f) => !!f?.make?.template, down = downstream(wires || [], one.id), out = [];
  const chain = (fn) => tryIt(async () => (await import('./chain-run.js'))[fn](one));
  if (flow(one) || down.some((id) => flow(byId(id)))) {
    out.push({ label: 'Run from here', title: down.length ? 'This frame\'s workflow, then each frame it feeds, in order' : 'This frame\'s workflow, its result in place of the last chain run\'s', run: chain('runFromHere') });
  }
  if ((wires || []).some((w) => w.from === one.id && w.on !== false)) {
    out.push({ label: 'Rerun what uses this', title: 'Each frame this one feeds, in order', run: chain('rerunUsers') });
  }
  return out;
}

export function frameExtras(frames) {
  const groups = [], one = frames.length === 1 ? frames[0] : null;
  const edit = editEntries(frames);
  if (edit.length) groups.push(edit);
  const words = frames.some((f) => f.kind === 'note' && String(f.text || '').trim());
  if (frames.some((f) => f.kind === 'note')) groups.push([{ label: 'Make from this note', disabled: !words, title: words ? 'Its words are the prompt in the Make pane' : 'This note has no words yet',
    run: tryIt(async () => (await import('./sidebar.js')).sidebar.show('make')) }]);
  if (one && R.table) {
    let chain = [];
    try { chain = chainEntries(one, R.table.tableWires(), R.table.frameById); } catch (e) { console.warn('chain menu', e); }
    if (chain.length) groups.push(chain);
  }
  if (one && one.kind !== 'note' && one.doc) {
    const more = [];
    if (one.kind === 'image' && R.source) more.push({ label: 'Open in PhotoCraft', title: 'Its picture as a PhotoCraft document, on the computer', run: tryIt(() => craftImage(one)) });
    if (one.kind === 'video') more.push({ label: 'Open in EffectCraft', title: 'Its clips as an EffectCraft comp, on the computer', run: tryIt(() => craftVideo(one)) });
    if (more.length) groups.push(more);
    groups.push([{ label: 'Compare with…', disabled: !stillOf(one), title: stillOf(one) ? null : 'It has no picture yet: open it once',
      run: tryIt(async () => (await import('./shelf.js')).compareSheet(one)) }]);
  }
  return groups;
}

addEventListener('table:menu', (e) => {
  const { frames = [], groups } = e.detail || {};
  if (!groups) return;
  groups.push(...frameExtras(frames));
});
