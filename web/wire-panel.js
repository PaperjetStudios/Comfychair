// The quick panel a wire opens when it is let go on empty table: what to start from this output. Each card makes a frame at
// that point with the wire plugged in. A card with a template makes a node: its slot is pointed at the wire and its little
// run button (table.js) runs it. Nothing runs until that is pressed, because a run takes the card.
//
//   openWirePanel(src, at)   src: the frame the wire came from. at: the table point it was let go at.
import { h, closeSheet, help, icon, openSheet, seg, toast, uid } from './ui.js';
import { S } from './core.js';
import * as Table from './table.js';
import * as W from './wire-rules.js';
import { emptyScene, emptyVideo } from './empty-docs.js';
import { placeAt, startTemplate } from './quick-start-rules.js';
import { landsIn, nodeGroups, nodeMake, nodeSize, otherTemplates } from './node-rules.js';
import { framePicker } from './frame-pick.js';

const GAP = 96;
const card = (ic, title, run) => h('button', { type: 'button', class: 'qs-card', 'aria-label': title, onclick: run }, icon(ic, 28), h('span', { class: 'qs-card-title' }, title));
const cards = (list) => h('div', { class: 'qs-cards' }, list);

const payloadFor = (kind, size) => (kind === 'video' ? { ...emptyVideo(), size: [size.w, size.h] }
  : kind === 'scene' ? { ...emptyScene(), width: size.w, height: size.h } : undefined);

// A frame at the point with src plugged in. t: its workflow (null: an empty frame, its template picked later). times: times of a
// video for picture wires, one frame per time, stacked down from the point.
async function start(src, at, { kind, t = null, label = null, wireKind, keepSize = false, times = [null] }) {
  closeSheet();
  let secs = 0;
  if (t && wireKind === 'video') secs = await import('./frame-source.js').then((m) => m.frameClipInfo(src)).then((c) => c.len, () => 0);
  const size = nodeSize(src, kind);
  const tile = src.kind === 'sound' ? { w: 512, h: Math.round((512 * size.h) / size.w) } : { w: src.w, h: src.h };
  let y = at.y - tile.h / 2, last = null;
  for (const time of times) {
    const id = uid();
    const make = t ? { make: nodeMake(t, id, wireKind, secs) } : {};
    const f = await Table.newFrameAt(kind, placeAt({ x: at.x, y }, tile, Table.tableGrid()),
      { payload: payloadFor(kind, size), extra: { out: { w: size.w, h: size.h }, ...(label && { label }), ...make } });
    if (!f) return;
    Table.plugWire(src, f, { id, kind: wireKind, frame: time, mp: keepSize ? 0 : null });
    last = f; y += tile.h + GAP;
  }
  if (last) Table.selectFrames([last.id]);
}

export function openWirePanel(src, at) {
  const kinds = W.outKinds(src);
  if (!kinds.length) return;
  const Q = { kind: kinds[0], q: '', picker: null };
  const body = h('div', { class: 'qs-body' });
  const times = () => (Q.picker ? Q.picker.picks() : [null]);
  const go = (o) => start(src, at, { wireKind: Q.kind, ...o, times: times() }).catch((e) => toast(e.message, true));
  const node = (it) => card(it.icon, it.label, () => go({ kind: it.kind, t: S.templates.find((x) => x.id === it.tpl), label: it.label, keepSize: it.keepSize }));
  const startCards = () => {
    const out = [];
    const tplCard = (start, ic, label, kind) => { const t = startTemplate(S.templates, start); if (t) out.push(card(ic, label, () => go({ kind, t }))); };
    if (Q.kind === 'image') {
      out.push(card('image', 'Image frame', () => go({ kind: 'image' })));
      tplCard('video-picture', 'film', 'Video from it', 'video');
      tplCard('scene-object', 'cube', '3D object from it', 'scene');
    } else if (Q.kind === 'video') out.push(card('film', 'Video frame', () => go({ kind: 'video' })), card('image', 'Image frame', () => go({ kind: 'image' })));
    else out.push(card('film', 'Video frame', () => go({ kind: 'video' })), card('sound', 'Sound frame', () => go({ kind: 'sound' })));
    return out;
  };
  const draw = () => {
    Q.picker?.stop();
    Q.picker = Q.kind === 'image' && src.kind === 'video' ? framePicker(src) : null;
    const search = h('input', { type: 'search', class: 'wp-find', placeholder: 'Find a template', value: Q.q, 'aria-label': 'Find a template that takes this' });
    const found = h('div', { class: 'wp-found' });
    const drawFound = () => {
      const list = Q.q.trim() ? otherTemplates(S.templates, Q.kind, Q.q).slice(0, 24) : [];
      found.replaceChildren(...(list.length ? [cards(list.map((t) => card(t.media === 'video' ? 'film' : t.media === 'audio' ? 'sound' : 'sparkle', t.name, () => go({ kind: landsIn(t), t, label: t.name }))))] : []));
    };
    search.addEventListener('input', () => { Q.q = search.value; drawFound(); });
    body.replaceChildren(
      search, found,
      ...(Q.picker ? [Q.picker.el] : []),
      ...nodeGroups(S.templates, Q.kind).flatMap((g) => [h('h4', { class: 'wp-head' }, g.title), cards(g.items.map(node))]),
      h('h4', { class: 'wp-head' }, 'New frame'), cards(startCards()));
    drawFound();
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => search.focus(), 30);   // (type to find one; a tablet would pop up its keyboard)
  };
  const tabs = kinds.length > 1 ? seg(kinds.map((k) => [k, k === 'image' ? 'A frame of it' : 'The whole clip']), Q.kind, (k) => { Q.kind = k; draw(); }) : null;
  openSheet(h('h3', {}, `From "${src.label || 'this frame'}"`),
    help('Each card makes a frame here with this output plugged in. Maps and tools are ready to run: press the little run button on the frame. Choose A frame of it to plug in pictures from a video; Add this frame several times makes one frame for each.'),
    h('div', { class: 'quick-start wire-panel' }, tabs, body));
  draw();
}
