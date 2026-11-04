// The table's frame menu, its extras (table.js fires table:menu; they go before Delete):
//   Edit ▸          the selected frames' edits (edit-rules.js menuGroupsFor; several kinds: "Edit image ▸", "Edit video ▸").
//                   A pick opens that edit in the Edit pane (edit-panel.js showOp) for the frames selected.
//   Use as ▸        one frame: every place its picture or clip can go (useas.js useAsGroups), by tab
//   Compare with…   one frame with a picture (shelf.js compareSheet); Finish (H3 1080p) for a video frame's runs
//   Open in …       an image frame in PhotoCraft (its picture), a video frame's edit in EffectCraft (its clips)
import { api, toast } from './ui.js';
import { S } from './core.js';
import { isLive } from './live.js';
import { stillOf } from './table-frames.js';
import { DOC_KIND } from './table-model.js';
import { uploadImage } from './media.js';

const R = { rules: null, source: null };
import('./edit-rules.js').then((m) => { R.rules = m; }).catch(() => {});   // (the Edit pane's rules; no Edit ▸ without them)
import('./frame-source.js').then((m) => { R.source = m; }).catch(() => {});

const USE_KIND = { image: 'image', video: 'video', sound: 'audio' };
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
      run: () => showOp(k.kind, op.id, list.filter((f) => f.kind === k.kind)) }))),
  }));
}
async function showOp(kind, id, frames) {
  try { (await import('./edit-panel.js')).showOp(kind, id, frames); } catch (e) { toast(`The Edit pane isn't there: ${e.message}`, true); }
}

// Use as ▸ for one frame: its picture (an image frame) or its first clip (video, sound), as useas.js offers a run's
async function useAsFor(f) {
  const kind = USE_KIND[f.kind];
  if (!kind || !f.doc) return null;
  const { useAsGroups } = await import('./useas.js');
  let src = null, url = null, g = null, index = 0;
  if (f.kind !== 'image') {
    const clip = await R.source?.frameClip?.(f);
    if (!clip) return { empty: `"${f.label}" has no ${f.kind === 'video' ? 'clip' : 'sound'} yet` };
    ({ src, url } = clip);
    if (src.generation != null) { g = S.history.get(src.generation) || null; index = src.index || 0; }
  }
  // a picture of it in the input folder: the frame's own (image), the run's frame (a clip that is a run), else its still
  const toInput = async (which = 'first', mp = 0, multiple = 1) => {
    if (f.kind === 'image') {
      const r = await R.source.frameSource(f, { multiple });
      return { name: r.name, width: r.px[0], height: r.px[1] };
    }
    if (src?.generation != null) {
      return api(`/api/generations/${src.generation}/to-input`, { method: 'POST', body: { index, frame: which, mp, multiple }, busy: 'Preparing the picture…' });
    }
    const still = stillOf(f) || (await api(`/api/store/${DOC_KIND[f.kind]}/${f.doc}${qs()}`, { busy: false }).catch(() => null))?.still?.url;
    if (!still) throw new Error(`"${f.label}" has no picture yet: open it once`);
    const b = await (await fetch(still)).blob();
    return uploadImage(b, { source: 'frame', mp, filename: 'frame.png', multiple });
  };
  const groups = useAsGroups({ kind, src, url, label: f.label || 'Frame', toInput, g, index });
  // (a picture's places take toInput; the Video tab's timeline wants a file it can keep, which a frame's picture isn't yet)
  return f.kind === 'image' ? groups.filter((grp) => grp.title !== 'Video') : groups;
}
// the submenu: read when it first opens (a clip's source comes from its document); press-menu.js shows "Reading…" till then
function useAsEntry(f) {
  const sub = async () => {
    const got = await useAsFor(f);
    if (got?.empty) return [[{ label: got.empty, disabled: true }]];
    const all = got || [], short = all.filter((grp) => !/^Other templates/.test(grp.title));
    const groups = short.map((grp) => grp.items.map((it) => ({ ...it, label: `${grp.title.replace(/ · $/, '')}: ${it.label}` })));
    if (all.length) groups.push([{ label: 'All places…', title: 'Every place it can go, other templates too', run: () => useAsSheet(f, all) }]);
    return groups.length ? groups : [[{ label: 'Nothing takes it yet', disabled: true }]];
  };
  return { id: 'useas', label: 'Use as ▸', sub };
}

// every place, as a sheet by tab (the menu leaves the other templates out: there are many)
async function useAsSheet(f, groups) {
  const { h, openSheet, closeSheet, section, button } = await import('./ui.js');
  openSheet(h('h3', {}, `Use ${f.label || 'the frame'} as…`),
    ...groups.map((grp) => section(grp.title, null, h('div', { class: 'row wrap use-as' },
      grp.items.map((it) => button(it.label, () => { closeSheet(); it.run(); }, { cls: '', title: it.title || undefined }))))));
}

// Open in PhotoCraft (an image frame's picture, one layer) / EffectCraft (a video frame's clips, as its timeline has them)
async function craftImage(f) {
  const r = await R.source.frameSource(f);
  try {
    await (await import('./craft.js')).sendToCraft('photo', { title: f.label || 'Frame', canvas: { w: r.px[0], h: r.px[1], bg: null },
      layers: [{ name: f.label || 'Frame', src: { input: r.name }, crop: null, rect: { x: 0, y: 0, w: r.px[0], h: r.px[1] }, opacity: 1, blend: 'normal' }] });
  } finally { dropInput(r.name); }   // (PhotoCraft's document has its own copy)
}
async function craftVideo(f) {
  const d = await api(`/api/store/${DOC_KIND.video}/${f.doc}${qs()}`, { busy: false });
  const p = d?.payload || {};
  const items = (p.items || []).filter((it) => it.src && it.kind !== 'scene');
  if (!items.length) return toast(`"${f.label}" has no clips to send`, true);
  await (await import('./craft.js')).sendToCraft('video', { title: f.label || 'Video edit', width: f.w, height: f.h, fps: p.fps || null,
    tracks: (p.tracks || []).map(({ id, kind, hidden, muted }) => ({ id, kind, hidden, muted })),
    items: items.map((it) => ({ track: it.track, at: it.at, name: it.label, src: it.src, in: it.in, out: it.out ?? it.dur, x: it.x, y: it.y, scale: it.scale,
      fit: it.fit, rotation: it.rotation || 0, opacity: it.opacity, volume: it.volume, fade_in: it.fadeIn, fade_out: it.fadeOut })) });
}
const tryIt = (fn) => async () => { try { await fn(); } catch (e) { toast(e.message, true); } };

export function frameExtras(frames) {
  const groups = [], one = frames.length === 1 ? frames[0] : null;
  const edit = editEntries(frames);
  if (edit.length) groups.push(edit);
  if (one && one.kind !== 'note' && one.doc) {
    const more = [useAsEntry(one)];
    if (one.kind === 'image' && R.source) more.push({ label: 'Open in PhotoCraft', title: 'Its picture as a PhotoCraft document, on the computer', run: tryIt(() => craftImage(one)) });
    if (one.kind === 'video') more.push({ label: 'Open in EffectCraft', title: 'Its clips as an EffectCraft comp, on the computer', run: tryIt(() => craftVideo(one)) });
    groups.push(more);
    const look = [{ label: 'Compare with…', disabled: !stillOf(one), title: stillOf(one) ? null : 'It has no picture yet: open it once',
      run: tryIt(async () => (await import('./shelf.js')).compareSheet(one)) }];
    if (one.kind === 'video') look.push({ label: 'Finish (H3 1080p)', run: tryIt(async () => (await import('./shelf.js')).finishFrame(one)) });
    groups.push(look);
  }
  return groups;
}

addEventListener('table:menu', (e) => {
  const { frames = [], groups } = e.detail || {};
  if (!groups) return;
  groups.push(...frameExtras(frames));
});
