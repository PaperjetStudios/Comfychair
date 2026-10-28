import { h, icon } from './ui.js';
import { previewUrl, thumbUrl } from './core.js';
import { fmtTime } from './playback.js';

// ---------------------------------------------------------------------------
// kinds: what each kind of thing the app makes or holds is called, how it's drawn and what's worth knowing
// about it, in one table, so a picture, a clip, a sound, a motion or a 3D model look and read the same in
// History, the Board, the pickers and the takes. Where a kind can go is useas.js (by the same kinds).
// The server's table of which file is which kind is app/imageprep.py KINDS; app/main.py fill_facts keeps
// each output's facts (size, length, frame rate, frames).
// ---------------------------------------------------------------------------
const size = (o) => (o.width ? `${o.width}×${o.height}` : null);
const len = (o) => (o.duration ? fmtTime(o.duration) : null);
const rate = (o) => (o.fps ? `${+o.fps.toFixed(2)} fps` : null);
const count = (o) => (o.frames ? `${o.frames} frames` : o.fps && o.duration ? `${Math.round(o.fps * o.duration)} frames` : null);

export const KINDS = {
  image: { icon: 'image', name: 'Picture', facts: [size] },
  video: { icon: 'play', name: 'Clip', facts: [len, size, rate, count] },
  audio: { icon: 'music', name: 'Sound', facts: [len] },
  motion: { icon: 'move', name: 'Motion', facts: [len, rate, count] },
  mesh: { icon: 'cube', name: '3D model', facts: [] },
  splat: { icon: 'sparkle', name: 'Splat', facts: [] },
  file: { icon: 'file', name: 'File', facts: [] },
};
// (the same extensions as app/imageprep.py, for outputs saved as a plain "file" before their kind existed)
const EXT = { motion: /\.(npz|bvh)$/i, mesh: /\.(glb|gltf|obj|fbx)$/i, splat: /\.(ply|splat|ksplat|spz)$/i };

export function kindOf(o) {
  if (o?.kind && o.kind !== 'file') return o.kind;
  return Object.entries(EXT).find(([, re]) => re.test(o?.filename || ''))?.[0] || 'file';
}
export const kindDef = (o) => KINDS[kindOf(o)] || KINDS.file;
// what's worth knowing, in one line: 0:05.00 · 1280×704 · 24 fps · 121 frames
export const factsOf = (o) => (o ? kindDef(o).facts.map((f) => f(o)).filter(Boolean).join(' · ') : '');
// a picture, a clip or a sound shows itself; the other kinds show what they are
export const isMedia = (o) => ['image', 'video', 'audio'].includes(kindOf(o));

// a sound's picture: its waveform (app/previews.py) over a note, which shows alone if there is no waveform
export const waveArt = (o, w, cls) => h('div', { class: cls }, h('span', { class: 'wave-note', 'aria-hidden': 'true' }, icon('music')),
  h('img', { src: previewUrl(o.url, w, 'wave'), loading: 'lazy', alt: '', draggable: false,
    onload: (e) => { e.target.previousSibling.hidden = true; }, onerror: (e) => e.target.remove() }));

// a kind that can't show itself: its icon, what it is and its facts (a 3D model made from a picture shows the picture)
export function kindTile(o, g = null) {
  const d = kindDef(o), src = kindOf(o) === 'mesh' && g?.params?.image;
  return h('div', { class: 'kind-tile' },
    src ? h('img', { src: thumbUrl(src, 320), alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,   // (the picture may be gone)
    h('span', { class: 'kind-icon', 'aria-hidden': 'true' }, icon(d.icon)),
    h('span', { class: 'kind-name' }, d.name), h('span', { class: 'kind-facts' }, factsOf(o)));
}

// a card's picture (History, takes, pickers, the Board): the light preview still, a sound's waveform, or the kind's tile
export function cardPicture(o, g = null, w = 320, { live = false } = {}) {
  const k = kindOf(o);
  if ((k === 'image' || k === 'video') && o.url?.startsWith('/files/')) {
    // live: a clip loops a small 8 fps copy while on screen (the Board)
    return k === 'video' && live
      ? h('video', { src: previewUrl(o.url, w, 'clip'), poster: previewUrl(o.url, w), muted: true, loop: true, playsInline: true, preload: 'none' })
      : h('img', { src: previewUrl(o.url, w), loading: 'lazy', alt: o.filename || '', draggable: false });
  }
  if (k === 'image') return h('img', { src: o.url, alt: o.filename || '', loading: 'lazy' });
  if (k === 'video') return h('video', { src: `${o.url}#t=0.1`, muted: true, playsInline: true, preload: 'metadata' });
  if (k === 'audio') return waveArt(o, w, 'card-wave');
  return kindTile(o, g);
}
