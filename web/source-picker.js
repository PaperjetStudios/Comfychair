// The one picker for pictures, clips and sounds (it was media.js openImagePicker, openVideoPicker and openSoundPicker).
//
//   openSourcePicker({ kinds = ['image'], want, multi, limit, title, mp, mpKey, maxMp, frame = null, onPick })
//     kinds: what the caller takes ('image' | 'video' | 'audio'); more than one shows kind chips (Pictures / Clips / Sounds).
//     want:  what onPick gets, by what the caller does with it (source-rules.js convertPlan):
//            'picture'  onPick(name, info): an input's name (a run's output or a table frame's picture becomes an input only when
//                       used; a clip gives frames). Clips are listed for their frames without being in kinds.
//            'clip' | 'sound'  onPick(source): {generation, index} | {media} (+ label, trim for a clip on the table). A clip where
//                       a sound is wanted gives its sound (kinds has 'video').
//            'any'      onPick(item) once per ticked item, in tick order: { kind, key, src, label?, trim? } (source-rules itemOf).
//            Not given: from kinds (one kind: its want; several: 'any').
//     multi, limit: tick several, in order, up to limit. mp(), mpKey, maxMp: the largest size for a picture.
//     frame: a table frame whose items are listed first on the This table tab (and that tab opens first).
// Tabs: This table (its frames' pictures, clips and sounds), This project, Everything, and the registered sources (pictures).
import {
  $, h, store, api, toast, openSheet, closeSheet, sheetStillOpen, button, chip, chips, actions, fileButton, seg, placeholder, note, icon, info,
} from './ui.js';
import { MP_STEPS, capLabel } from './mp-cap.js';
import { runBar } from './run-bar.js';
import { S, CURRENT_EDIT as CURRENT, PICKER_SOURCES as SOURCES, inputUrl, previewUrl, thumbUrl } from './core.js';
import { heightGrip, maximizable, zoomPan } from './layout.js';
import { tick, tickRange } from './pick-slots.js';
import { draggingPicture, dropKind, droppedFiles } from './drop-files.js';
import { accepts, convertPlan, itemOf } from './source-rules.js';
import { DOC_KIND } from './table-model.js';
import {
  MP_INFO, mpKeyOf, bareSource, cardMedia, clipUrl, cropCopy, genLabel, grabFrame, pickFrames, projectOutputs,
  resizeInput, uploadImage, uploadMedia,
} from './media.js';

// ---- the picker's own pieces: pictures dropped on the sheet, the webcam, and the recent strip ----

// Pictures dropped on an open picker sheet (from the desktop or another window) go to give(files). One listener on
// the sheet; DROP is the open picker's, live while its sheet is (sheetStillOpen).
let DROP = null;
function dropPictures(seq, give) {
  DROP = { seq, give };
  const el = $('#sheet');
  if (el.dataset.drop) return;
  el.dataset.drop = '1';
  const live = (e) => DROP && sheetStillOpen(DROP.seq) && draggingPicture(e.dataTransfer);
  el.addEventListener('dragover', (e) => { if (!live(e)) return; e.preventDefault(); el.classList.add('dropping'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', async (e) => {
    el.classList.remove('dropping');
    if (!live(e)) return;
    e.preventDefault();
    const { give } = DROP;
    try {
      const fs = (await droppedFiles(e.dataTransfer)).filter((f) => dropKind(f) === 'image');
      if (fs.length) give(fs); else toast('Drop a picture (PNG, JPG, WebP…)', true);
    } catch (err) { toast(err.message, true); }
  });
}

// The webcam, where the camera button can't ask for it (a desktop browser ignores capture and opens the file
// chooser): a live view and Take picture. onFile(PNG File); Cancel runs back(). The camera goes off when the sheet
// does, however it closes.
const desktop = () => matchMedia('(pointer: fine)').matches;
const hasWebcam = async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return false;   // (HTTPS only)
  try { return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'videoinput'); } catch { return false; }
};
async function takePhoto({ onFile, back }) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'The browser wasn\'t allowed to use the camera' : `Can't open the camera: ${e.message}`, true); return; }
  const v = h('video', { muted: true, playsInline: true, autoplay: true, class: 'frame-video' });
  v.srcObject = stream;
  const stop = () => { clearInterval(watch); stream.getTracks().forEach((t) => t.stop()); };
  const watch = setInterval(() => { if (!v.isConnected || v.closest('.hidden')) stop(); }, 500);
  const take = () => {
    if (!v.videoWidth) return toast('The camera is still starting', true);
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    cv.toBlob((b) => {
      if (!b) return toast('Couldn\'t take the picture', true);
      stop(); closeSheet(); onFile(new File([b], `camera-${Date.now()}.png`, { type: 'image/png' }));
    }, 'image/png');
  };
  openSheet(h('h3', {}, 'Camera'), h('div', { class: 'media-big' }, v),
    actions(button('Take picture', take, { cls: 'primary' }), button('Cancel', () => { stop(); back(); }, { cls: 'ghost' })));
}

// ---- recently used: one strip of the last pictures, clips and sounds picked, at the top of each picker, to hop between them ----
// kept per device; an entry whose file is gone drops out when its thumbnail fails to load.
// entry: {k (what makes it the same one: source-rules recentKey), item ({kind, key, src, label?, trim?}), label, thumb (a url or null), tk ('img' | 'video' | 'audio')}
const RECENT_MAX = 14, RECENT = 'deck.recent.all';
const recentList = () => {
  const l = store.get(RECENT, null);
  if (Array.isArray(l)) return l;
  // once: the two older stores (pictures, clips) become this one
  const out = [];
  for (const e of [...store.get('deck.recent.image', []), ...store.get('deck.recent.video', [])]) {
    if (!e || !e.val) continue;
    const item = typeof e.val === 'string' ? itemOf(e.val) : itemOf({ ...e.val, kind: 'video' });
    if (item) out.push({ k: item.key, item, label: e.label, thumb: e.src, tk: e.kind === 'video' ? 'video' : 'img' });
  }
  const mine = out.slice(0, RECENT_MAX);
  store.set(RECENT, mine);
  store.set('deck.recent.image', []); store.set('deck.recent.video', []);
  return mine;
};
function rememberRecent(e) {
  if (!e?.k || !e.item) return;
  store.set(RECENT, [e, ...recentList().filter((x) => x.k !== e.k)].slice(0, RECENT_MAX));
}
// the strip for the picker open now: it goes after the picker's bar. pick(entry) is what a tap does; shown(item) tells which belong here.
function recentStrip(pick, shown) {
  const strip = h('div', { class: 'recent-strip', role: 'group', 'aria-label': 'Recently used' });
  const draw = () => {
    const l = recentList().filter((e) => shown(e.item));
    strip.classList.toggle('hidden', !l.length);
    strip.replaceChildren(h('span', { class: 'recent-lbl' }, 'Recent'), ...l.map((e) => {
      const pic = e.tk === 'audio' || !e.thumb ? h('span', { class: 'pk-icon' }, icon(e.item.kind === 'audio' ? 'sound' : e.item.kind === 'video' ? 'film' : 'image'))
        : e.tk === 'video' ? h('video', { src: `${e.thumb}#t=0.1`, muted: true, preload: 'metadata', playsInline: true })
        : h('img', { src: e.thumb, alt: '', loading: 'lazy' });
      pic.addEventListener('error', () => { store.set(RECENT, recentList().filter((x) => x.k !== e.k)); draw(); });
      return h('button', { type: 'button', class: 'recent-item', title: e.label, 'aria-label': e.label, onclick: () => pick(e) }, pic);
    }));
  };
  draw();
  $('#sheet .picker-bar').after(strip);
  return strip;
}

// ---- the table's frames, for the This table tab ----
const qs = () => (S.project != null ? `?project_id=${S.project}` : '');
// a sound frame's sounds (a video frame's clips are vfx-fields.js clipsOf)
async function soundsOf(frame) {
  if (!frame?.doc) return [];
  const d = await api(`/api/store/${DOC_KIND.sound}/${frame.doc}${qs()}`, { busy: false }).catch(() => null);
  return (d?.payload?.items || []).filter((it) => it.kind === 'audio' && it.src && (it.src.generation != null || it.src.media)).map((it) => {
    const end = it.out ?? it.dur;
    return { it, src: { ...bareSource(it.src), ...(it.label && { label: it.label }), trim: { start: it.in || 0, ...(end ? { len: +(end - (it.in || 0)).toFixed(4) } : {}) } } };
  });
}

const KIND_LABEL = { image: 'Pictures', video: 'Clips', audio: 'Sounds' };
const wantOf = (kinds) => (kinds.length === 1 ? { image: 'picture', video: 'clip', audio: 'sound' }[kinds[0]] || 'any' : 'any');
const NOUN = { picture: 'picture', clip: 'clip', sound: 'sound', any: 'item' };

export function openSourcePicker(opts) {
  opts.kinds ||= ['image'];
  opts.want ||= wantOf(opts.kinds);
  const { title, mp: callerMp = () => 0, onPick, limit = Infinity, kinds, want, frame = null } = opts;
  const isPic = want === 'picture', noun = NOUN[want] || 'item';
  // the largest size: chosen here (opts.maxMp, kept on opts so it survives the sheets that replace the picker; remembered per kind of
  // work with opts.mpKey), else what the caller asks for. A picture already in the inputs is only made smaller when it was chosen here.
  if (opts.maxMp === undefined) opts.maxMp = opts.mpKey ? store.get(mpKeyOf(opts.mpKey), null) : null;
  const mp = () => opts.maxMp ?? callerMp();
  const capped = async (name, info2) => {
    if (!opts.maxMp) return { name, info: info2 };
    const r = await resizeInput(name, opts.maxMp);
    if (r.name === name) return { name, info: info2 };
    // (a copy made for this pick, now resized: the full-size copy is nobody's, so it goes; the smaller one is the caller's)
    if (info2?.copied) api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE', busy: false }).catch(() => {});
    return { name: r.name, info: info2?.copied ? { ...r, copied: true } : r };
  };
  const multi = !!opts.multi && limit > 1;
  const sel = multi ? (opts.sel ||= new Map()) : null;   // key -> item, in the order ticked
  let tab = frame ? 'table' : store.get('deck.pickerTab2', 'project');
  if (tab !== 'table' && tab !== 'project' && tab !== 'all' && !(isPic && SOURCES.has(tab))) tab = 'project';
  // the kind chips: one kind, or all of them (remembered per kind of work)
  const kindKey = `deck.picker.kind.${opts.mpKey || title}`;
  if (!opts.kindSel) { const k = store.get(kindKey, null); opts.kindSel = k === 'all' || kinds.includes(k) ? k : kinds[0]; }
  // is an item of this kind and source listed: the plan says it can become what is wanted, and the caller takes its kind
  // (a clip where a picture is wanted is listed for its frames)
  const listed = (item) => !!item && !!convertPlan(item, want) && (kinds.includes(item.kind) || (isPic && item.kind === 'video'))
    && (kinds.length < 2 || opts.kindSel === 'all' || opts.kindSel === item.kind);
  const wantsImage = kinds.includes('image');
  let q = '';
  let inputs = null, media = null;
  const search = h('input', { type: 'text', placeholder: 'Filter by name…' });
  let max = null;   // the big view's full-screen toggle

  const rememberItem = (it) => {
    if (!it.item || it.item.src.frame != null) return;   // (a table frame changes: its picture is remembered as the input it made)
    rememberRecent({ k: it.item.key, item: { ...it.item, ...(it.extra || {}) }, label: it.title, thumb: it.thumb || null, tk: it.audio ? 'audio' : 'img' });
  };
  const remember = (name) => rememberRecent({ k: `i${name}`, item: itemOf(name), label: name.split('/').pop(), thumb: thumbUrl(name), tk: 'img' });
  const full = () => toast(`There's room for ${limit} here: untick one first`, true);
  const picked = (name, info2) => {
    if (multi) {
      if (tick(sel, { ...inputItem(name), get: async () => ({ name, info: info2 }) }, true, limit)) paintTicks(); else full();
      return;
    }
    max?.exit();
    remember(name);
    closeSheet();
    capped(name, info2).then((r) => onPick(r.name, r.info)).catch((e) => toast(e.message, true));
  };
  // a clip, a sound or an item chosen (want not 'picture'): res is what onPick gets
  const handOver = async (it, res) => {
    rememberItem(it);
    await onPick(res);
  };
  const chosen = async (it) => {
    try { const res = await it.get(); max?.exit(); closeSheet(); await handOver(it, res); } catch (e) { toast(e.message, true); }
  };
  // Add: every ticked one, in order. Each one's copy is made now (a History output becomes an input only if it is used).
  const addTicked = async () => {
    const list = [...sel.values()];
    sel.clear();
    max?.exit();
    closeSheet();
    let n = 0;
    for (const it of list) {
      try {
        const r = await it.get();
        if (isPic) {
          remember(r.name);
          const c = await capped(r.name, r.info);
          await onPick(c.name, c.info);
        } else await handOver(it, r);
        n++;
      } catch (e) { toast(e.message, true); }
    }
    if (n) toast(n === 1 ? 'Added' : `Added ${n} ${noun}s`);
  };
  const removeInput = async (n) => {
    if (!confirm(`Delete ${n.split('/').pop()} for good? Every copy goes (here and in ComfyUI), and its thumbnails.`)) return;
    try {
      await api(`/api/inputs?name=${encodeURIComponent(n)}`, { method: 'DELETE' });
      inputs = null; toast('Deleted'); draw();
    } catch (e) { toast(e.message, true); }
  };
  const removeMedia = async (m) => {
    if (!confirm(`Delete ${m.label || m.name} for good? Its copies and thumbnails go too.`)) return;
    try {
      await api(`/api/media?name=${encodeURIComponent(m.name)}`, { method: 'DELETE' });
      media = null; toast('Deleted'); draw();
    } catch (e) { toast(e.message, true); }
  };
  const historyGet = async (g, i, frame2 = 'last') => {
    const r = await api(`/api/generations/${g.id}/to-input`, { method: 'POST',
      body: { index: i, frame: frame2, mp: mp(), multiple: 16 } });
    return { name: r.name, info: r };
  };
  const fromHistory = async (g, i) => {
    try { const r = await historyGet(g, i); picked(r.name, r.info); } catch (e) { toast(e.message, true); }
  };
  const roomLeft = () => (multi ? limit - sel.size : 1);
  // a clip's frames, by the room this input has: one is used straight away; several are ticked, each made only if it's added.
  // spec: { url, label, fps, frames, key, make(frame, f) -> { name, info } }
  const framesFrom = async (spec) => {
    const room = roomLeft();
    if (room < 1) return full();
    const list = await pickFrames({ url: spec.url, title: spec.label, fps: spec.fps || 24, frames: spec.frames || 0, room });
    if (list && !multi) {
      try { const r = await spec.make(list[0].frame, list[0]); picked(r.name, r.info); } catch (e) { toast(e.message, true); reopen(); }
      return;
    }
    if (list) for (const f of list) {
      tick(sel, { key: `${spec.key}@${f.frame}`, title: `${spec.label} · ${f.frame === 'last' ? 'last frame' : `frame ${f.frame}`}`, thumb: f.thumb || previewUrl(spec.url, 320),
        get: () => spec.make(f.frame, f) }, true, limit);
    }
    reopen();
  };
  const runFrames = (g, i, o) => framesFrom({ url: o.url, label: genLabel(g), fps: o.fps || 24, frames: o.frames || 0, key: `g${g.id}.${i}`, make: (fr) => historyGet(g, i, fr) });
  // a clip that is not a run's (a file, a table frame's clip): the frame is grabbed at its time and uploaded
  const clipFrames = (src, label) => {
    const url = clipUrl(src);
    if (!url) return toast('That clip can\'t be played here', true);
    return framesFrom({ url, label, key: itemOf({ ...src, kind: 'video' }).key, make: async (_fr, f) => {
      const name = await grabFrame(src, { at: f.t, mp: mp() });
      const g = grabFrame.last;
      return { name, info: { name, width: g?.width, height: g?.height, copied: true } };   // (a fresh grab the caller owns)
    } });
  };

  // Each tab lists items for the big view: { key, title, thumb (a url) | thumbEl () (an element), full (what the big view shows), video?, audio?, cropSrc (a picture to crop), badge?, tag?,
  //   item (source-rules item, for Recent), extra ({label, trim}), use(), get? (makes what onPick takes; none: it needs a choice first, so it can't be ticked), del? }
  // This project: its uploads, editor saves and drawings plus everything it generated, newest first
  const SOURCE = { upload: 'upload', editor: 'edit', drawing: 'drawing', crop: 'crop', snapshot: 'frame', scene: '3d', smaller: 'smaller', 'edit-tab': 'edit tab', 'video-tab': 'video edit', story: 'story', link: 'link', camera: 'camera', vfx: 'vfx', sheet: 'sheet' };
  const noThumb = () => h('span', { class: 'pk-icon' }, icon('sound'));
  // what a non-picture pick hands over: the source (+ label, trim) for a clip or a sound, the whole item for 'any'
  const payload = (item, extra = {}) => (want === 'any' ? { ...item, ...extra } : { ...item.src, ...extra });
  const inputItem = (n, badge = null) => {
    const item = itemOf(n);
    return { key: n, title: n.split('/').pop(), thumb: thumbUrl(n), full: inputUrl(n), cropSrc: inputUrl(n), badge, kind: 'image', item,
      use: () => (isPic ? picked(n, { name: n }) : chosen(inputItem(n, badge))),
      get: async () => (isPic ? { name: n, info: { name: n } } : payload(item, { thumb: thumbUrl(n) })), del: () => removeInput(n) };
  };
  // a file in the media library
  const mediaItem = (m) => {
    const kind = m.kind === 'audio' ? 'audio' : 'video', item = itemOf({ media: m.name, kind });
    if (!listed(item)) return null;
    const url = m.url || `/files/media/${encodeURIComponent(m.name)}`, label = m.label || m.name;
    const e = { key: item.key, title: label, full: url, video: kind === 'video', audio: kind === 'audio', kind, item, del: () => removeMedia(m), tag: 'upload',
      thumb: kind === 'video' ? previewUrl(url, 320) : null, thumbEl: kind === 'audio' ? () => cardMedia({ ...m, url }) : null };
    if (isPic) {
      e.badge = 'frames'; e.use = () => clipFrames(item.src, label); e.get = null;
    } else { e.get = async () => payload(item); e.use = () => chosen(e); }
    return e;
  };
  // an output of a run
  const runItem = ({ g, o, i }) => {
    const item = itemOf({ generation: g.id, index: i, kind: o.kind });
    if (!listed(item)) return null;
    const plan = convertPlan(item, want), e = { key: item.key, title: genLabel(g), full: o.url, video: o.kind === 'video', audio: o.kind === 'audio', kind: o.kind, item, tag: 'generated',
      thumb: o.kind === 'audio' ? null : previewUrl(o.url, 320), thumbEl: o.kind === 'audio' ? () => cardMedia(o, g) : null };
    if (isPic) {
      e.run = { g, i }; e.cropSrc = o.kind === 'image' ? o.url : null; e.badge = o.kind === 'video' ? 'frames' : null;
      e.use = () => (o.kind === 'video' ? runFrames(g, i, o) : fromHistory(g, i));
      e.get = o.kind === 'video' ? null : () => historyGet(g, i);
      e.delNote = 'That one is in History: delete it there';
    } else {
      e.get = async () => payload(item); e.use = () => chosen(e); e.delNote = 'That one is in History: delete it there';
    }
    return plan ? e : null;
  };
  const projectItems = async () => {
    const items = [];
    if (listed({ kind: 'image', src: { input: '' } })) {
      for (const r of inputs.project.filter((x) => x.source !== 'generation')) items.push({ t: r.created, it: inputItem(r.name, SOURCE[r.source] || null) });
    }
    const outKinds = ['image', 'video', 'audio'].filter((k) => listed({ kind: k, src: { generation: 0, index: 0 } }));
    if (outKinds.length) for (const x of await projectOutputs(outKinds)) { const it = runItem(x); if (it) items.push({ t: x.t, it }); }
    for (const m of media || []) { const it = mediaItem(m); if (it) items.push({ t: m.created, it }); }
    const every = items.sort((x, y) => y.t - x.t).map((x) => x.it), tags = tagsIn(every);
    if (opts.tag && !tags.includes(opts.tag)) opts.tag = null;   // (the last one with that tag was deleted)
    drawTags(tags);
    return byTag(every, opts.tag).slice(0, 300);   // (filtered first, so an old upload isn't lost behind 300 newer runs)
  };
  const allItems = () => {
    const out = listed({ kind: 'image', src: { input: '' } }) ? inputs.all.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 400).map((n) => inputItem(n)) : [];
    for (const m of media || []) if (!q || (m.label || m.name).toLowerCase().includes(q)) { const it = mediaItem(m); if (it) out.push(it); }
    return out.slice(0, 400);
  };

  // the table's frames (this.frame first): an image frame's picture, a video frame's clips, a sound frame's sounds
  const tableItems = async () => {
    const { tableFrames } = await import('./table.js');   // (it imports this file's callers)
    const all = (tableFrames() || []).filter((f) => f.doc);
    const frames = frame ? [...all.filter((f) => f.id === frame.id), ...all.filter((f) => f.id !== frame.id)] : all;
    const { stillOf } = await import('./table-frames.js');
    const out = [];
    for (const f of frames) {
      const mine = frame && f.id === frame.id ? ' (this frame)' : '';
      if (f.kind === 'image') {
        const item = { ...itemOf({ frame: f.id, kind: 'image' }) };
        if (!listed(item)) continue;
        const still = stillOf(f), label = `${f.label || 'Frame'}${mine}`;
        const make = async () => {
          const { frameSource } = await import('./frame-source.js');
          const s = await frameSource(f, { multiple: 16 });
          return { name: s.name, info: { name: s.name, width: s.px?.[0], height: s.px?.[1], copied: true } };   // (copied: a fresh upload the caller owns)
        };
        const e = { key: item.key, title: label, thumb: still, full: still, cropSrc: isPic ? still : null, kind: 'image', item, tag: 'frame' };
        e.get = isPic ? make : async () => payload(item, { label });
        e.use = () => (isPic ? make().then((r) => picked(r.name, r.info)).catch((er) => toast(er.message, true)) : chosen(e));
        out.push(e);
      } else if (f.kind === 'video' || f.kind === 'sound') {
        let list = [];
        try { list = f.kind === 'video' ? await (await import('./vfx-fields.js')).clipsOf(f) : await soundsOf(f); } catch { /* an empty one */ }
        list.forEach(({ it, src }, n) => {
          const kind = f.kind === 'video' ? 'video' : 'audio', item = itemOf({ ...bareSource(src), kind });
          if (!listed(item)) return;
          const url = clipUrl(src) || it.url, label = `${it.label || (kind === 'video' ? 'Clip' : 'Sound')} · ${f.label || 'Frame'}${mine}`;
          const extra = { label: it.label || undefined, ...(src.trim && { trim: src.trim }) };
          const e = { key: `t${f.id}.${n}`, title: label, full: url, video: kind === 'video', audio: kind === 'audio', kind, item, extra, tag: 'frame',
            thumb: kind === 'video' ? (it.thumb || (src.generation != null && S.history.get(src.generation)?.outputs?.[src.index || 0]?.url ? previewUrl(S.history.get(src.generation).outputs[src.index || 0].url, 320) : (url ? previewUrl(url, 320) : null))) : null,
            thumbEl: kind === 'audio' ? noThumb : null };
          if (isPic) { e.badge = 'frames'; e.get = null; e.use = () => clipFrames(src, label); }
          else { e.get = async () => (want === 'any' ? payload(item, extra) : { ...src }); e.use = () => chosen(e); }
          out.push(e);
        });
      }
    }
    return out;
  };

  // a registered source (registerPickerSource): its items for this project; Use picks the still, a frame, or asks
  const sourceItems = async (src) => {
    const take = async (it, frame2, nested = false) => {
      try { const r = await src.pick(it, { mp: mp(), frame: frame2 }); picked(r.name, r); } catch (e) { toast(e.message, true); }
      if (nested && multi) reopen();   // (the choice / frame sheet replaced the picker)
    };
    const frameOf = async (it) => {
      const room = roomLeft();
      if (room < 1) return full();
      const list = await pickFrames({ url: it.video, title: it.title, room, wantBlob: true });
      if (!list) return reopen();
      if (!multi) return take(it, list[0].blob, true);
      for (const f of list) {
        tick(sel, { key: `${src.key}.${it.id}@${f.frame}`, title: `${it.title} · frame ${f.frame}`, thumb: f.thumb,
          get: async () => { const r = await src.pick(it, { mp: mp(), frame: f.blob }); return { name: r.name, info: r }; } }, true, limit);
      }
      reopen();
    };
    const use = (it) => {
      if (it.video && it.still) {
        openSheet(h('h3', {}, it.title), h('div', { class: 'media-big' }, h('img', { src: it.thumb, alt: '' })),
          actions(button('Use the saved still', () => { closeSheet(); take(it, null, true); }, { cls: 'primary' }),
            button('Pick a frame…', () => frameOf(it)), button('Back', () => reopen(), { cls: 'ghost' })));
      } else if (it.video) frameOf(it);
      else take(it, null);
    };
    return (await src.list(S.project)).map((it) => ({ key: String(it.id), title: it.title, thumb: it.thumb, full: it.thumb || it.video,
      video: !it.thumb, cropSrc: it.thumb && !it.video ? it.thumb : null, badge: it.badge || null, use: () => use(it),
      get: it.video ? null : async () => { const r = await src.pick(it, { mp: mp(), frame: null }); return { name: r.name, info: r }; } }));
  };
  const EMPTY = {
    table: 'No frames on the table have anything to pick yet.',
    project: isPic ? 'Nothing in this project yet. Upload, draw, or pick from All inputs.' : `Nothing in this project yet. Make or upload ${noun === 'item' ? 'something' : `a ${noun}`}.`,
    all: isPic ? 'No input images match.' : 'Nothing matches.',
  };

  // the tag of an item on the project tab's filter, one at a time. It lives on opts, so it survives the sheets that replace the picker.
  const tagOf = (it) => it.badge || it.tag || (it.run ? 'generated' : null);
  const tagsIn = (list) => [...new Set(list.map(tagOf).filter(Boolean))].sort();
  const byTag = (list, tag) => (tag ? list.filter((it) => tagOf(it) === tag) : list);
  const tagRow = h('div', { class: 'chips pk-tags' });
  const setTag = (t) => { opts.tag = t; draw(); };
  const drawTags = (tags) => tagRow.replaceChildren(chip('All', () => setTag(null), { on: !opts.tag }), ...tags.map((t) => chip(t, () => setTag(t), { on: opts.tag === t })));
  const projName = (S.projects.find((p) => p.id === S.project) || {}).name || 'This project';
  const tabs = seg([['table', 'This table'], ['project', projName], ['all', isPic ? 'All inputs' : 'Everything'],
    ...(isPic ? [...SOURCES.values()].map((x) => [x.key, x.label]) : [])], tab, (t) => { tab = t; if (!frame) store.set('deck.pickerTab2', t); curKey = null; draw(); });
  const kindRow = kinds.length > 1 ? chips([...kinds, 'all'].map((k) => [k, k === 'all' ? 'All' : KIND_LABEL[k]]), opts.kindSel, (k) => {
    opts.kindSel = k; store.set(kindKey, k); curKey = null; draw();
  }, { cls: 'pk-kinds' }) : null;

  // a file chosen or dropped: pictures are uploaded as inputs, clips and sounds go to the media library
  const onFiles = async (files, source = 'upload') => {
    toast(`Uploading ${files.length}…`);
    for (const fl of files) {
      if (multi && sel.size >= limit) { full(); break; }
      try {
        const kindOfFile = fl.type.startsWith('audio/') ? 'audio' : fl.type.startsWith('video/') ? 'video' : 'image';
        if (kindOfFile === 'image') {
          const r = await uploadImage(fl, { mp: mp(), source });
          inputs = null;
          if (isPic) picked(r.name, r);
          else { const it = inputItem(r.name); if (multi) { tick(sel, it, true, limit); paintTicks(); } else await chosen(it); }
        } else {
          const m = await uploadMedia(fl);
          media = null;
          await fromMedia({ name: m.name, kind: m.kind || kindOfFile, label: m.label });
        }
        if (!multi) return;
      } catch (e) { toast('Upload failed: ' + e.message, true); return; }
    }
    draw();
  };
  // a file just added to the media library: used at once (a clip for a picture asks for its frames)
  const fromMedia = async (m) => {
    const it = mediaItem(m);
    if (!it) return toast(`That ${m.kind === 'audio' ? 'sound' : 'clip'} can't be used here`, true);
    if (multi && it.get) { tick(sel, it, true, limit); paintTicks(); return; }
    await it.use();
  };
  const useCurrentEdit = async () => {
    const eng = CURRENT.eng;
    if (eng.loading()) return toast('The edit\'s images are still loading', true);
    try {
      const blob = await eng.blob();
      if (!blob) return toast('The edit has no pictures yet', true);
      const r = await uploadImage(blob, { mp: mp(), source: 'editor', filename: 'editor.png' });
      inputs = null;
      picked(r.name, r);
    } catch (e) { toast(`Couldn't export the edit: ${e.message}`, true); }
  };
  const reopen = () => openSourcePicker(opts);
  const webcam = button([icon('camera'), 'Camera'], () => takePhoto({ back: reopen, onFile: async (f) => { await onFiles([f], 'camera'); if (multi) reopen(); } }),
    { cls: 'small hidden', title: 'Take a picture with the webcam' });
  if (isPic && desktop()) hasWebcam().then((y) => webcam.classList.toggle('hidden', !y));
  // a tap on Recent: what that item is now becomes what is wanted
  const fromRecent = async (e) => {
    const item = e.item, plan = convertPlan(item, want);
    if (!plan) return;
    const it = { item, title: e.label, thumb: e.thumb, audio: item.kind === 'audio', extra: { ...(item.label && { label: item.label }), ...(item.trim && { trim: item.trim }) } };
    if (!isPic) { it.get = async () => payload(item, it.extra); return chosen(it); }
    if (plan === 'frames') {
      const g = item.src.generation != null ? S.history.get(item.src.generation) : null, o = g?.outputs?.[item.src.index || 0];
      return g && o ? runFrames(g, item.src.index || 0, o) : clipFrames(item.src, e.label);
    }
    if (plan === 'toInput') return fromHistory({ id: item.src.generation }, item.src.index || 0);
    picked(item.src.input, { name: item.src.input });
  };

  // the big view with ‹ › (swipe, ← →), what the item can do, and the rows of what there is
  let items = [], cur = 0, curKey = null;
  const main = h('div', { class: 'gal-main' });
  const prev = h('button', { type: 'button', class: 'gal-nav prev', 'aria-label': 'Previous', onclick: () => go(-1) }, '‹');
  const next = h('button', { type: 'button', class: 'gal-nav next', 'aria-label': 'Next', onclick: () => go(1) }, '›');
  const stage = h('div', { class: 'gal-stage pk-stage' }, main, prev, next);
  const zoom = zoomPan(main, () => main.firstElementChild, { swipe: (d) => go(d) });
  const name = h('span', { class: 'pk-name' });
  // multi: adds what is ticked, or the one on show when nothing is. One that needs a choice (a clip's frame) asks first, and is ticked after.
  const useCurrent = () => {
    const it = items[cur];
    if (!multi) return it?.use();
    if (sel.size) return addTicked();
    if (it && !it.get) return it.use();
    if (it) { tick(sel, it, true, limit); addTicked(); }
  };
  const useBtn = button(`Use this ${noun}`, useCurrent, { cls: 'primary' });
  // (what's ticked waits on Add; a clip on show can still give more frames)
  const moreBtn = multi ? button('Choose frames…', () => items[cur]?.use(), { cls: 'small' }) : null;
  const clearBtn = multi ? button('Clear', () => { sel.clear(); paintTicks(); }, { cls: 'small ghost', title: `Untick every ${noun}` }) : null;
  const delBtn = button('Delete…', () => { const it = items[cur]; if (it.del) it.del(); else toast(it.delNote || 'That one can\'t be deleted here', true); },
    { cls: 'small danger', title: 'Delete this for good (uploads and saved pictures, not History)' });
  // Crop…: cut the picture on show first (a new copy is the one picked); Cancel comes back here
  const cropBtn = button('Crop…', async () => {
    const it = items[cur];
    max?.exit();
    const img = new Image();
    img.src = it.cropSrc;
    const { openCrop } = await import('./editor.js');   // (it imports media.js)
    openCrop({ img, onCancel: reopen, onApply: async (c) => {
      try {
        const r = await cropCopy(img, c, mp());
        inputs = null;
        picked(r.name, r);
        if (multi) reopen();
      } catch (e) { toast(e.message, true); reopen(); }
    } });
  }, { cls: 'small', title: 'Cut the picture first: the cropped copy is the one picked (the original stays)' });
  // what the picture on show is, and what it will be used at
  const mpLabel = h('span', { class: 'hint' });
  let shownWH = null;
  // (a picture already in the inputs only comes down when it was chosen here; a run's or an upload's follows the caller too)
  const capNow = () => (items[cur]?.del ? opts.maxMp || 0 : mp() || 0);
  const showMp = () => { mpSeg.set(capNow()); mpLabel.textContent = shownWH ? capLabel(shownWH[0], shownWH[1], capNow()) : ''; };
  const mpSeg = seg(MP_STEPS, opts.maxMp ?? 0, (v) => { opts.maxMp = v; if (opts.mpKey) store.set(mpKeyOf(opts.mpKey), v); showMp(); }, { wrap: true });
  const mpRow = h('span', { class: 'pk-mp' }, h('span', { class: 'hint' }, 'Max MP'), mpSeg, mpLabel, info(MP_INFO, 'About the largest size'));
  if (!isPic) mpRow.classList.add('hidden');
  const bar = h('div', { class: 'gal-actions pk-actions' }, name, mpRow, useBtn, moreBtn, clearBtn, cropBtn, delBtn);
  const runRow = h('div', { class: 'strip gal-run' });   // the files its run made, and what to do with its clip (run-bar.js)
  const showRun = (it) => {
    if (!it?.run) return runRow.replaceChildren();
    const { g, i } = it.run, keyOf = (n) => `g${g.id}.${n}`;
    runBar(runRow, g, i, { has: (n) => items.some((x) => x.key === keyOf(n)), onPick: (n) => select(items.findIndex((x) => x.key === keyOf(n))),
      before: () => { max?.exit(); closeSheet(); } });
  };
  // pull this grip down to give the big picture the room (all the way shuts the rows), up for more of them
  const grip = h('div', { class: 'pk-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the rows', title: 'Drag down for a bigger picture, up for more of them (double-tap resets)' }, h('span'));
  const rows = h('div', { class: 'pk-rows', role: 'listbox', 'aria-label': isPic ? 'Pictures' : 'Items', 'aria-multiselectable': multi ? 'true' : null });
  // the ticks on the rows (with their order) and on the button
  function paintTicks() {
    if (!multi) return;
    const order = [...sel.keys()], n = order.length, it = items[cur];
    useBtn.firstChild.textContent = n > 1 ? `Add ${n} ${noun}s` : n ? `Add 1 ${noun}` : it && !it.get ? (it.video ? 'Choose frames…' : 'Choose…') : `Add this ${noun}`;
    moreBtn.firstChild.textContent = it?.video ? 'Choose frames…' : 'Choose…';
    moreBtn.classList.toggle('hidden', !(n && it && !it.get));
    useBtn.disabled = !it && !n;
    clearBtn.classList.toggle('hidden', !n);
    if (rows.children.length !== items.length) return;
    [...rows.children].forEach((c, k) => {
      const at = order.indexOf(items[k].key);
      c.classList.toggle('picked', at >= 0);
      c.setAttribute('aria-selected', at >= 0);
      c.querySelector('.pk-n')?.remove();
      if (at >= 0) c.append(h('span', { class: 'pk-n' }, `${at + 1}`));
    });
  }
  // a tap ticks or unticks; shift ticks the run from the last one tapped
  let anchor = null;
  const tapTick = (n, e) => {
    const it = items[n];
    if (!it.get) return;
    if (e.shiftKey && anchor != null) { if (!tickRange(sel, items, anchor, n, limit)) full(); }
    else if (!tick(sel, it, !sel.has(it.key), limit)) full();
    anchor = n;
    paintTicks();
  };
  const ROWS = 'deck.picker.rows';
  const setRows = (px) => {
    store.set(ROWS, px);
    rows.style.maxHeight = px == null ? '' : `${px}px`;
    rows.classList.toggle('shut', px === 0);
  };
  heightGrip(grip, { size: () => rows.offsetHeight, set: setRows });
  setRows(store.get(ROWS, null));
  const go = (d) => { if (items.length) select(Math.max(0, Math.min(items.length - 1, cur + d))); };
  const bigOf = (it) => {
    if (it.audio) return h('div', { class: 'pk-audio' }, it.thumbEl?.() || null, h('audio', { src: it.full, controls: true, preload: 'metadata' }));
    if (it.video && it.full) return h('video', { src: it.full, controls: true, muted: true, loop: true, playsInline: true, autoplay: true });
    return h('img', { src: it.full || it.thumb, alt: it.title, draggable: false, onload: (e) => { if (items[cur] === it && it.cropSrc === it.full && !SOURCES.has(tab)) { shownWH = [e.target.naturalWidth, e.target.naturalHeight]; showMp(); } } });
  };
  const select = (n) => {
    cur = n; const it = items[n]; curKey = it?.key ?? null;
    zoom.reset();
    main.replaceChildren(...(!it ? [] : [bigOf(it)]));
    shownWH = null; showMp();
    prev.disabled = n <= 0; next.disabled = n >= items.length - 1;
    name.textContent = it ? `${it.title}${it.badge ? ` · ${it.badge}` : ''}  (${n + 1} / ${items.length})` : '';
    if (!multi) useBtn.firstChild.textContent = isPic && it?.video ? 'Choose a frame…' : `Use this ${noun}`;
    useBtn.disabled = !it; delBtn.classList.toggle('hidden', !it); cropBtn.classList.toggle('hidden', !it?.cropSrc);
    showRun(it);
    [...rows.children].forEach((c, k) => { c.classList.toggle('sel', k === n); c.setAttribute('aria-selected', k === n); });
    rows.children[n]?.scrollIntoView({ block: 'nearest' });
    paintTicks();
  };
  const draw = async () => {
    search.classList.toggle('hidden', tab !== 'all');
    tagRow.classList.toggle('hidden', tab !== 'project');
    rows.replaceChildren(placeholder('Loading…'));
    try {
      if (tab === 'table') items = await tableItems();
      else if (isPic && SOURCES.has(tab)) items = await sourceItems(SOURCES.get(tab));
      else {
        if (wantsImage) inputs ||= await api(`/api/inputs${S.project != null ? `?project_id=${S.project}` : ''}`);
        else inputs ||= { project: [], all: [] };
        if (!media && kinds.some((k) => k !== 'image')) { try { media = await api('/api/media'); } catch { media = []; } }   // (the outputs still show)
        items = tab === 'project' ? await projectItems() : allItems();
      }
    } catch (e) { items = []; rows.replaceChildren(note(e.message, 'err')); select(0); return; }
    if (!items.length) { rows.replaceChildren(placeholder(EMPTY[tab] || `Nothing in ${SOURCES.get(tab).label.toLowerCase()} for this project yet.`)); select(0); return; }
    rows.replaceChildren(...items.map((it, n) => {
      const t = h('button', { type: 'button', class: 'pk-thumb', role: 'option', title: it.title, 'aria-label': it.title, onclick: (e) => { select(n); if (multi) tapTick(n, e); },
        ondblclick: () => { if (!multi) return it.use(); if (!it.get) return it.use(); if (tick(sel, it, true, limit)) addTicked(); else full(); } },
        it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy' }) : it.thumbEl ? it.thumbEl() : placeholder('…'), it.badge ? h('span', { class: 'play' }, it.badge) : null);
      return t;
    }));
    select(Math.max(0, items.findIndex((x) => x.key === curKey)));
  };
  const accept = [...new Set(kinds.map((k) => (k === 'audio' ? 'audio/*' : k === 'video' ? 'video/*' : 'image/*')))].join(',');
  const linkClip = () => import('./clipimport.js').then((m) => m.openClipImport({ title: want === 'sound' ? 'Import a sound' : 'Import a clip', sound: want === 'sound',
    onSaved: (e) => { media = null; fromMedia({ name: e.name, kind: e.kind || (want === 'sound' ? 'audio' : 'video'), label: e.label }); } }));
  const seq = openSheet(h('h3', {}, title), h('div', { class: 'picker-bar' }, [tabs, kindRow, h('span', { class: 'picker-break' }),
    isPic && currentEditReady() ? button('Current edit', useCurrentEdit, { cls: 'small primary', title: 'Export the picture open in the Image tab right now and use it' }) : null,
    fileButton('Upload…', onFiles, { accept, multiple: multi, cls: 'small primary' }),
    isPic ? (desktop() ? webcam : fileButton([icon('camera'), 'Camera'], (fs) => onFiles(fs, 'camera'), { accept: 'image/*', capture: 'environment' })) : null,
    isPic ? button('From a video link…', () => import('./clipimport.js').then((m) => m.openLinkStill({ back: reopen,
      onFrame: async (blob) => { await onFiles([new File([blob], 'link.png', { type: 'image/png' })], 'link'); if (multi) reopen(); } })),
    { cls: 'small', title: 'A frame from a YouTube (or other) video' }) : null,
    !isPic && kinds.some((k) => k !== 'image') ? button('From a link or big file…', linkClip, { cls: 'small', title: 'A clip or sound from a link, or a file too big to upload here' }) : null]),
  stage, runRow, bar, grip, tagRow, rows);
  $('#sheet').classList.add('picker-full');   // the whole screen, like the board's gallery
  max = maximizable($('#sheet'), stage, { title: 'Full screen the picture' });   // just the picture
  draw.seq = seq;
  PK = { seq, go, use: useCurrent, tick: () => { if (multi && items[cur]) tapTick(cur, {}); } };
  draw();
  search.addEventListener('input', () => { q = search.value.toLowerCase(); curKey = null; draw(); });
  if (wantsImage) dropPictures(seq, onFiles);
  const strip = recentStrip(fromRecent, listed);
  strip.after(search);
  search.classList.toggle('hidden', tab !== 'all');
}

// The open Editor tab, for the picker's "Current edit" button: the edit as it is now, exported and picked at once
const currentEditReady = () => !!CURRENT.eng?.E.layers.some((l) => !l.hidden && !l.mask);

// ← → move through the open picker's items, Enter uses the one on show (or adds the ticked ones), Space ticks it
let PK = null;
document.addEventListener('keydown', (e) => {
  if (!PK || !sheetStillOpen(PK.seq) || e.target.closest('input, textarea, select, button, a') || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); PK.go(e.key === 'ArrowLeft' ? -1 : 1); }
  else if (e.key === 'Enter') { e.preventDefault(); PK.use(); }
  else if (e.key === ' ') { e.preventDefault(); PK.tick(); }
});
