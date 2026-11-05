// A video or sound frame's clips as a list of rows, top track first, for the floating panel (float-layers.js): the same rows as the layers'. A tap picks a
// clip on the timeline and brings the playhead to it; Ctrl or Shift adds to the pick. The timeline stays where they are moved and trimmed.
//   floatClips(kind, st, TL, { seek })  the list in the panel, when it's floating for this kind of frame (st: V or N; TL: its timeline(); seek(t))
import { h, iconBtn, layerRowsEl } from './ui.js';
import { icon } from './icons.js';
import { fmtT } from './core.js';
import { floatsFor, layerListPart } from './float-layers.js';

const KIND_ICON = { video: 'film', image: 'image', audio: 'sound', scene: 'cube' };

function clipRows(st, TL, seek) {
  const tracks = [...st.tracks.filter((t) => t.kind === 'video').reverse(), ...st.tracks.filter((t) => t.kind !== 'video')];
  const rows = [];
  for (const tr of tracks) {
    const items = st.items.filter((i) => i.track === tr.id).sort((a, b) => a.at - b.at);
    for (const it of items) {
      const del = iconBtn(`Delete ${it.label || 'this clip'}`, icon('trash'), () => { TL.setPicked([it.id]); TL.removePicked(); });
      del.addEventListener('click', (e) => e.stopPropagation());
      rows.push({ sel: TL.isSel(it), off: !!(tr.hidden || tr.muted),
        thumb: it.thumb ? h('img', { src: it.thumb, alt: '' }) : h('span', { class: 'scene-icon' }, icon(KIND_ICON[it.kind] || 'film')),
        name: it.label || 'Clip', hint: `${tr.name || tr.id} · ${fmtT(it.at)}–${fmtT(TL.end(it))}`,
        onclick: (e) => {
          const add = e.ctrlKey || e.metaKey || e.shiftKey, now = TL.picked().map((x) => x.id);
          TL.setPicked(!add ? [it.id] : now.includes(it.id) ? now.filter((id) => id !== it.id) : [...now, it.id]);
          if (!add && (st.t < it.at || st.t >= TL.end(it))) seek(it.at);
        },
        buttons: [del] });
    }
  }
  return rows;
}

export function floatClips(kind, st, TL, { seek }) {
  if (!floatsFor(kind)) return;
  const rows = clipRows(st, TL, seek);
  layerListPart(kind, rows.length ? layerRowsEl(rows) : h('span', { class: 'hint' }));
}
