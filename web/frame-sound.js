// A sound frame on the table, live: the Sound engine (sound.js mountSound) mounts inside the frame, its Tracks pane
// goes in the sidebar, its timeline in the table's drawer (frame-video.js builds it). Letting go saves the mix and its
// still and gives the engine back to the page's Sound tab. Frames dropped on a sound frame add their sound to it.
import { h, toast } from './ui.js';
import { isLive } from './live.js';
import { sidebar } from './sidebar.js';
import { drawer, dropOnto, putStill } from './frame-video.js';
import { mountSound, renderSound, sndPause, soundStill, soundTabs, wireSound } from './sound.js';

let cur = null;   // { frame, root, dead, pane }
addEventListener('table:live', (e) => {
  const d = e.detail;
  if (d.frame.kind !== 'sound') return;
  d.handled = true;
  goLiveSound(d.frame, d.root).catch((err) => { console.error(err); toast(`Couldn't open the sound: ${err.message}`, true); });
});

async function goLiveSound(frame, root) {
  const my = cur = { frame, root, dead: false, pane: null };
  const tabs = soundTabs();
  if (!tabs) throw new Error('the Sound engine is not ready');
  await tabs.ready();
  if (my.dead) return;
  if (!frame.doc) throw new Error('this frame has no mix yet');
  for (let k = 0; k < 2 && tabs.active?.id !== frame.doc; k++) { await tabs.switchTo(frame.doc); if (my.dead) return; }
  if (tabs.active?.id !== frame.doc) throw new Error('the mix would not open');
  const canvas = h('canvas', { class: 'snd-canvas', 'aria-label': 'The whole mix: tap to move the playhead, drag a clip to move or trim it' });
  const empty = h('div', { class: 'placeholder' }, 'Add sounds, or the sound of clips, to the tracks below');
  const bar = h('div', { class: 'transport' });
  root.append(h('div', { class: 'stage editor-stage' }, h('div', { class: 'viewer snd-viewer' }, canvas, empty), bar));
  const dr = drawer(), pane = my.pane = sidebar.pane('layers', { title: 'Tracks', icon: 'sound', host: false, when: (c) => c.live?.kind === 'sound' });
  dr.show('sound');
  mountSound({ host: root, canvas, empty, transport: bar, tools: dr.panes.sound.tools, timeline: dr.panes.sound.tl, panel: pane,
    active: () => isLive(frame.id), fullscreen: false });
  renderSound();
  sidebar.refresh(); sidebar.show('layers');
}

addEventListener('table:unlive', (e) => {
  const { frame } = e.detail, my = cur;
  if (frame.kind !== 'sound' || !my || my.frame.id !== frame.id) return;
  cur = null; my.dead = true;
  leaveSound(my).catch((err) => console.error(err));
});

async function leaveSound(my) {
  sndPause();
  if (!my.pane) return;
  const tabs = soundTabs(), id = my.frame.doc;
  const still = soundStill();   // (drawn now, while the canvas is still the frame's)
  drawer().hide(); wireSound(); my.pane.replaceChildren();
  const ok = await tabs.flush();
  const blob = await still;
  if (ok || !tabs.conflict) await putStill('sound', id, blob);
}

addEventListener('table:drop-frame', (e) => {
  const d = e.detail;
  if (d.handled || d.onto.kind !== 'sound') return;
  d.handled = true;
  dropOnto(d, 'sound', soundTabs());
});
