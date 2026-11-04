// What a finished output does on the table (the Shelf's tiles, the gallery, a run's details and bar, a toast): it goes
// into the selected frame, becomes a new frame, or becomes a new frame with an Edit op opened on it. Nothing here opens
// another screen. Classic screens (no table on show) keep useas.js's Use as… instead.
//
//   onTable()                     the table (or a frame open on it) is the screen on show
//   frameKindOf(o)                the frame kind an output makes: image, video, sound (audio), scene (a model, a splat,
//                                 a motion), or null
//   outputGroups(g, i, { before })   press-menu.js groups: Into "<frame>" · New frame · Edit ▸ (the frame kind's ops)
//   openOutputSheet(g, i, { before })  the same as a sheet (the gallery's and Details' button)
//   intoSelected(g, i) / newFrameOf(g, i) / editAs(g, i, opId)   each one alone
//   revealOwner(owner)            a run's owner (storage.attachments: { kind, id, name }) that is a frame's document:
//                                 its table opened and the frame selected and shown; false when no table holds it
import { api, button, closeSheet, h, hint, openSheet, section, toast } from './ui.js';
import { S } from './core.js';
import { kindOf } from './kinds.js';
import { DOC_KIND } from './table-model.js';

export const onTable = () => !!document.querySelector('#tab-table.active, #tab-table.live-host');

const FRAME_OF = { image: 'image', video: 'video', audio: 'sound', mesh: 'scene', splat: 'scene', motion: 'scene' };
export const frameKindOf = (o) => (o ? FRAME_OF[kindOf(o)] || null : null);
const KIND_WORD = { image: 'picture', video: 'clip', sound: 'sound', scene: '3D' };

const Table = () => import('./table.js');
const label = (g) => `#${g.id}`;
const sel = async () => ((await Table()).selectedFrames?.() || []).filter((f) => f.kind !== 'note' && f.doc);

// Into the selected frame: an image frame takes a picture as a layer, a video frame a clip, a sound frame a sound, a 3D frame
// pictures (frame modules' table:drop-frame)
export async function intoSelected(g, i) {
  const T = await Table(), [f] = await sel();
  if (!f) return toast('Select a frame first', true);
  if (T.dropOntoFrame(T.frameById(f.id) || f, [{ generation: g.id, index: i }])) return toast(`${label(g)} went into "${f.label}"`);
  return toast(`"${f.label}" doesn't take a ${KIND_WORD[frameKindOf(g.outputs[i])] || 'file'} like that: New frame makes one of its own`, true);
}
// A new frame of its own, beside the selection (edit-ops.js frameBeside), selected and brought into view
export async function newFrameOf(g, i) {
  const [{ frameBeside }, T] = await Promise.all([import('./edit-ops.js'), Table()]);
  const [near] = await sel(), o = g.outputs[i];
  const f = await frameBeside(near || null, { generation: g.id, index: i, ...(o?.width && { width: o.width, height: o.height }) });
  if (f) T.selectFrames?.([f.id], { scroll: true });
  return f;
}
// A new frame, then one of its kind's Edit ops opened on it in the Edit pane
export async function editAs(g, i, id) {
  const f = await newFrameOf(g, i);
  if (!f) return;
  try { (await import('./edit-panel.js')).showOp(f.kind, id, [f]); } catch (e) { toast(`The Edit pane isn't there: ${e.message}`, true); }
}

// The Edit ▸ submenu for an output: its frame kind's ops (those that run from the table), by group
async function editSub(g, i, before) {
  const kind = frameKindOf(g.outputs[i]);
  const { groupsOf, whyNot } = await import('./edit-rules.js');
  return groupsOf(kind).map(({ ops }) => ops.filter((op) => !whyNot(op)).map((op) => ({ label: op.label,
    run: () => { before?.(); editAs(g, i, op.id).catch((e) => toast(e.message, true)); } }))).filter((grp) => grp.length);
}

export function outputGroups(g, i, { before = null } = {}) {
  const o = g?.outputs?.[i], kind = frameKindOf(o);
  if (!kind) return [];
  const go = (fn) => () => { before?.(); fn().catch((e) => toast(e.message, true)); };
  const items = [{ label: 'Into the selected frame', title: 'An image frame takes it as a layer, a video frame on its timeline, a sound frame in its mix', run: go(() => intoSelected(g, i)) },
    { label: 'New frame', title: `A ${KIND_WORD[kind]} frame of its own, beside the selected one`, run: go(() => newFrameOf(g, i)) }];
  const edit = kind !== 'scene' ? [{ label: 'Edit ▸', sub: () => editSub(g, i, before) }] : [];
  return [items, ...(edit.length ? [edit] : [])];
}

// The same as a sheet: a button per action, the Edit ops as buttons by group
export async function openOutputSheet(g, i, { before = null } = {}) {
  const o = g?.outputs?.[i], kind = frameKindOf(o);
  if (!kind) return toast('Nothing on the table takes this kind of file: Download has it', true);
  const act = (text, fn, cls = '') => button(text, () => { closeSheet(); before?.(); fn().catch((e) => toast(e.message, true)); }, { cls });
  const [f] = await sel();
  const groups = kind !== 'scene' ? await editSub(g, i, () => { closeSheet(); before?.(); }) : [];
  openSheet(h('h3', {}, `${label(g)} on the table`),
    h('div', { class: 'row wrap' },
      f ? act(`Into "${f.label}"`, () => intoSelected(g, i), 'primary') : null,
      act('New frame', () => newFrameOf(g, i), f ? '' : 'primary')),
    f ? null : hint('Select a frame first to put it in that frame.'),
    groups.length ? section('Edit', null, ...groups.map((grp) => h('div', { class: 'row wrap use-as' }, grp.map((it) => button(it.label, it.run, { cls: '' }))))) : null);
}

// ---- "in use by": the frame whose document holds a run ----
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
export async function revealOwner(o) {
  if (!Object.values(DOC_KIND).includes(o?.kind)) return false;   // (a character, a story…: not a frame's)
  const T = await Table();
  const here = (T.tableFrames?.() || []).find((f) => f.doc === o.id);
  if (here) {
    if (!T.selectFrames([here.id], { scroll: true })) return false;
    return true;
  }
  let tables = [];
  try { tables = await api(`/api/store/tables${qs()}`, { busy: false }); } catch { return false; }
  for (const t of Array.isArray(tables) ? tables : []) {
    let d;
    try { d = await api(`/api/store/tables/${t.id}${qs()}`, { busy: false }); } catch { continue; }
    const f = (d?.payload?.frames || []).find((x) => x.doc === o.id);
    if (!f) continue;
    await T.openTable(t.id);
    await new Promise((r) => setTimeout(r, 300));   // (the table draws its frames)
    T.selectFrames([f.id], { scroll: true });
    return true;
  }
  return false;
}
