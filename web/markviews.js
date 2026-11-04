// Mark views: scrub a finished H3 clip, mark frames as angles (front, 3/4, top...), and each marked frame becomes its own
// picture, through Upscale, De-light and Cut out as ticked. The pictures are inputs named for their angle. The marks and what
// was made from them are kept with the run (store kind view-marks), so a bad frame can be moved and only that one made again.
// A sheet's clip starts from the frames its picture was cut from.
import { h, api, store, toast, openSheet, closeSheet, button, iconBtn, section, field, hint, help, toggle, actions, undoToast, $ } from './ui.js';
import { inputUrl, thumbUrl } from './core.js';
import { uploadImage } from './media.js';
import { maximizable } from './layout.js';
import { ANGLES, STEPS, frameAt, madeOf, makeAll, packFrom, setMark, slotPicks, stepsOn, toMake, viewFile } from './markview-math.js';

const KEY = 'deck.markviews';   // (per device: which boxes are ticked)
const load = () => ({ steps: { up: true, delight: false, cut: true }, ...store.get(KEY, {}) });
const SESS = new Map();         // run id -> { marks, rev, running, draw, status }, so reopening finds a run still making pictures
const THUMBS = new Map();       // `${run}:${frame}` -> a small picture of the frame, this session only

const frameOf = async (g, index, mark) => (await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index, frame: mark.frame, mp: 0, multiple: 1 }, busy: false })).name;
async function makeView(g, index, mark, first, steps, what) {
  const { applyStep } = await import('./imagetools.js');
  let name = first;
  for (const s of steps) name = await applyStep(s, name, { what });
  const blob = await (await fetch(inputUrl(name))).blob();   // named for its angle, so the picker's filter finds it
  return (await uploadImage(blob, { mp: 0, source: 'editor', filename: viewFile(mark.label), multiple: 1, origin: { generation: g.id, index, frame: mark.frame } })).name;
}

const docUrl = (g) => `/api/store/view-marks/g${g.id}${g.project_id != null ? `?project_id=${g.project_id}` : ''}`;

// the run's saved marks, else (first time) what a sheet's picture was cut from
async function openSession(g) {
  if (SESS.has(g.id)) return SESS.get(g.id);
  const q = docUrl(g);
  const doc = await api(`${q}${q.includes('?') ? '&' : '?'}optional=true`, { busy: false }).catch(() => null);
  const marks = doc?.payload?.marks || await api(`/api/generations/${g.id}/sheet-marks`, { busy: false }).catch(() => []);
  const s = { marks, what: doc?.payload?.what || 'person', rev: doc?.rev ?? 0, running: false, draw: () => {}, status: '', saving: Promise.resolve() };
  SESS.set(g.id, s);
  return s;
}

// saves in order; a save another device got in ahead of takes its rev and goes again
function saveMarks(g, s) {
  const put = async (again) => {
    try {
      s.rev = (await api(docUrl(g), { method: 'PUT', busy: false, body: { name: `Run ${g.id}`, rev: s.rev, payload: { marks: s.marks, what: s.what } } })).rev;
    } catch (e) {
      const cur = e.data?.doc;
      if (again && cur) { s.rev = cur.rev; return put(false); }
      toast(`The marks weren't saved: ${e.message}`, true);
    }
  };
  s.saving = s.saving.then(() => put(true));
  return s.saving;
}

// onMade(mark, name): each picture made goes there too (the table's Mark views op: an image frame beside the clip's)
export async function openMarkViews(g, index, { onMade = null } = {}) {
  const out = g.outputs[index], fps = out.fps || 24, st = load();
  const s = await openSession(g);
  const keepBoxes = () => store.set(KEY, { steps: st.steps });

  const v = h('video', { src: `${out.url}#t=0.001`, muted: true, playsInline: true, preload: 'auto', class: 'frame-video', crossOrigin: 'anonymous' });
  const stage = h('div', { class: 'media-big' }, v);
  const slider = h('input', { type: 'range', min: 0, max: 0, step: 'any', value: 0, 'aria-label': 'Time' });
  const lbl = h('span', { class: 'timecode' }, 'Frame 0');
  const seek = (t) => { v.pause(); v.currentTime = Math.max(0, Math.min(v.duration || 0, t)); };
  const seekFrame = (f) => seek(f / fps + 0.001);
  const step = (n) => seekFrame(frameAt(v.currentTime, fps) + n);
  v.addEventListener('loadedmetadata', () => { slider.max = v.duration; });
  v.addEventListener('timeupdate', () => { slider.value = v.currentTime; lbl.textContent = `Frame ${frameAt(v.currentTime, fps)}`; });
  v.addEventListener('error', () => toast("Couldn't load that video", true));
  slider.addEventListener('input', () => seek(+slider.value));

  const snap = (src, frame) => {
    try {
      const k = Math.min(1, 160 / src.videoHeight), c = document.createElement('canvas');
      c.width = Math.round(src.videoWidth * k); c.height = Math.round(src.videoHeight * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      THUMBS.set(`${g.id}:${frame}`, c.toDataURL('image/jpeg', 0.7));
    } catch { /* (no thumbnail: the mark shows its frame number) */ }
  };
  // pictures of the marks this session hasn't seen, from a second player so the one on show stays where it is
  const fillThumbs = async () => {
    const want = s.marks.filter((m) => !THUMBS.has(`${g.id}:${m.frame}`));
    if (!want.length) return;
    const p = h('video', { src: out.url, muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
    await new Promise((res, rej) => { p.addEventListener('loadeddata', res, { once: true }); p.addEventListener('error', rej, { once: true }); });
    for (const m of want) {
      if (!list.isConnected) break;
      await new Promise((res) => { p.addEventListener('seeked', res, { once: true }); p.currentTime = m.frame / fps + 0.001; });
      snap(p, m.frame);
      draw();
    }
    p.removeAttribute('src'); p.load();
  };

  const list = h('div', { class: 'mv-marks' }), done = h('div', { class: 'mv-marks' }), status = hint(s.status), use = h('div', { class: 'row wrap' });
  const angles = h('div', { class: 'chips' });
  const go = button('Make the pictures', () => run(toMake(s.marks)), { cls: 'primary' });
  const again = (m) => { delete m.name; saveMarks(g, s); run([m]); };
  const draw = () => {
    if (!list.isConnected) return;
    angles.replaceChildren(...ANGLES.map((a) => button(a, () => mark(a), { cls: s.marks.some((m) => m.label === a) ? 'small primary' : 'small', title: `Mark this frame as ${a}` })));
    list.replaceChildren(...(s.marks.length ? s.marks.map((m) => h('div', { class: `mv-mark${m.name ? '' : ' todo'}` },
      h('button', { type: 'button', class: 'mv-thumb', 'aria-label': `Go to ${m.label}`, title: `Go to frame ${m.frame}`, onclick: () => seekFrame(m.frame) },
        THUMBS.has(`${g.id}:${m.frame}`) ? h('img', { src: THUMBS.get(`${g.id}:${m.frame}`), alt: '' }) : h('span', {}, `#${m.frame}`)),
      h('span', { class: 'ch-view-lbl' }, m.name ? `✓ ${m.label}` : m.label),
      iconBtn(`Remove ${m.label}`, '✕', () => { s.marks = s.marks.filter((x) => x !== m); saveMarks(g, s); draw(); }, { class: 'icon-btn st-frame-x' }),
      m.name && !s.running ? iconBtn(`Make ${m.label} again`, '↻', () => again(m), { class: 'icon-btn mv-again' }) : null))
      : [hint('No marks yet: find a frame, then tap its angle.')]));
    const n = toMake(s.marks).length, made = madeOf(s.marks), picks = slotPicks(made);
    go.disabled = s.running || !n;
    go.textContent = s.running ? 'Making…' : n ? `Make ${n} picture${n > 1 ? 's' : ''}` : 'All made';
    status.textContent = s.status;
    done.replaceChildren(...made.map((r) => h('div', { class: 'mv-mark' },
      h('span', { class: 'mv-thumb' }, h('img', { src: thumbUrl(r.name, 240), alt: '', loading: 'lazy' })), h('span', { class: 'ch-view-lbl' }, r.label))));
    use.replaceChildren(...(Object.keys(picks).length ? [button('Make a 3D object from these…', async () => {
      await (await import('./run.js')).sceneModule();   // (the 3D tab may not have been opened yet)
      const table = onMade && document.querySelector('#tab-table.active, #tab-table.live-host');
      const queued = table ? { queued: async (r) => {   // (on the table: the model lands in a new 3D frame)
        const T = await import('./table.js'), near = T.selectedFrames?.()?.[0];
        (await import('./edit-ops.js')).runBeside(near || { x: 0, y: 0, w: 0, h: 0, label: `#${g.id}` }, r, 'scene', '3D object').catch(() => {});
      } } : null;
      (await import('./scene-import.js')).openObjectSheet(Object.values(picks)[0], '', picks, queued ? { character: queued } : {});
    }, { cls: 'small', title: 'Front, Left, Back and Right go into the 3D object\'s slots' })] : []),
    ...(made.length ? [button('Send to the look pack', sendToPack, { cls: 'small', title: 'Into the character picked above' })] : []));
  };
  s.draw = draw;

  // the look pack these go to: a character, a new one, or none
  let packTo = '';
  const packPick = h('select', { 'aria-label': 'Character', onchange: (e) => { packTo = e.target.value; } });
  const fillPick = async () => {
    const { characters, loadCharacters } = await import('./characters.js');
    await loadCharacters();
    packPick.replaceChildren(h('option', { value: '' }, 'None'), ...characters().map((c) => h('option', { value: c.id }, c.name)), h('option', { value: 'new' }, 'New character'));
    packPick.value = packTo;
  };
  async function sendToPack() {
    if (!packTo) return toast('Pick a character for the look pack first', true);
    const views = packFrom(madeOf(s.marks)), n = Object.keys(views).length;
    if (!n) return toast('A look pack takes Front, Front 3/4, Left or Right, Back and Face front: none of those are made yet', true);
    const { addPicture, characterById, newCharacter, setViews } = await import('./characters.js');
    let c = characterById(packTo);
    if (packTo === 'new') {
      c = await newCharacter();
      addPicture(c, views.front || Object.values(views)[0]);
      packTo = c.id;
      await fillPick();
    }
    if (!c) return toast('That character is gone', true);
    const was = setViews(c, views);
    undoToast(`${c.name}: ${n} view${n > 1 ? 's' : ''} in the look pack`, () => setViews(c, was));
  }

  const mark = (label) => {
    if (!v.videoWidth) return toast('The video is still loading', true);
    const frame = frameAt(v.currentTime, fps);
    snap(v, frame);
    const next = setMark(s.marks, label, frame);
    if (next !== s.marks) { s.marks = next; saveMarks(g, s); }
    draw();
  };

  async function run(todo) {
    if (s.running || !todo.length) return;
    const steps = stepsOn(st.steps);
    s.running = true; s.draw();
    const say = (t) => { s.status = t; s.draw(); };
    let ok = 0, landed = 0;
    say(`Queueing ${todo.length}…`);
    await makeAll(todo, (m) => frameOf(g, index, m), (m, first) => makeView(g, index, m, first, steps, s.what), (m, name, e) => {
      landed++;
      if (e) toast(`${m.label}: ${e.message}`, true);
      else {
        if (s.marks.includes(m)) { m.name = name; saveMarks(g, s); }   // (moved while it ran: the new frame still needs making)
        ok++;
        onMade?.(m, name);
      }
      say(`${ok} of ${todo.length} made${landed < todo.length ? ': the rest are in the queue' : ''}`);
    });
    s.running = false;
    say(`${ok} of ${todo.length} made. They are in the picture picker under view-…`);
    toast(`Mark views: ${ok} of ${todo.length} pictures made`, ok < todo.length);
    if (packTo) await sendToPack().catch((e) => toast(e.message, true));
    s.draw();
  }

  openSheet(h('h3', {}, 'Mark views'),
    help('Marks are kept with the run; a sheet starts from the frames its picture was cut from. A marked angle is highlighted, and a mark with ✓ has its picture. To repair one: tap the mark to go to its frame, scrub to a better one and tap the angle again; only marks without a picture are made, and ↻ makes one again as it is. Tap an angle again on another frame to move it; Detail can be used many times. Left and right are the character\'s own. The steps run in the order shown, with the model and scale last set in the Image tab\'s tools. A replaced picture stays in the picture picker until you delete it.'),
    stage, slider,
    h('div', { class: 'row frame-bar' }, iconBtn('Back one frame', '⏮', () => step(-1)), lbl, iconBtn('Forward one frame', '⏭', () => step(1))),
    section('Mark this frame as', null, angles),
    section('Marks', null, list),
    section('For each picture', null, h('div', { class: 'row wrap' }, STEPS.map(([k, l]) => toggle(l, st.steps[k], (on) => { st.steps[k] = on; keepBoxes(); }))),
      field('Cut out what', h('input', { type: 'text', value: s.what, placeholder: 'person', 'aria-label': 'What to cut out',
        onchange: (e) => { s.what = e.target.value.trim() || 'person'; e.target.value = s.what; saveMarks(g, s); } }),
      help('What SAM3 looks for when cutting out: "person", or the thing you want, such as "red car". It is kept with this run. Marks already made keep their cut-out until ↻ makes them again.'))),
    field('Look pack', packPick, help('The finished pictures go into this character\'s look pack: Front, Front 3/4 (left before right), Left or Right as its side view, Back and Face front. They replace the views it has, with an Undo. New character starts one with these pictures. The other angles stay in the picture picker.')),
    status, section('Made', null, done, use),
    actions(go, button('Close', closeSheet, { cls: 'ghost' })));
  maximizable($('#sheet'), stage, { title: 'Full screen the clip' });
  draw();
  fillPick().catch((e) => toast(e.message, true));
  fillThumbs().catch(() => {});
}
