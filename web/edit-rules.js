// The Edit pane's ops: what each kind of frame can have done to it from the table, and what can't be done without the
// frame open. Make = make new content; Edit = transform what a frame has. Pure data and rules (node --test
// tests/edit_rules.test.mjs); web/edit-ops.js gives each op its fields and its run, web/edit-run.js runs one on many frames.
//
// An op: { id, kind, group, label, icon, help, needs, quick?, tpl?, lands?, once?, live?(opts) }
//   needs:  'still' (the frame's picture), 'clip' (its first clip or sound), 'doc' (its document, changed in place),
//           'live' (only on the open frame: painting, points, the timeline)
//   live:   for an op that is headless with some options and not with others: (opts) -> why it needs the open frame, or null
//   lands:  what kind of frame a result is ('image' for a frame grabbed from a video); the frame's own kind when not given
//   once:   no batch (a setting changed, not a run made)
//   selfLands: it places its result itself (a grabbed frame: a frame of the picture's own size, or a layer in the selected
//           image frame): no result frame is made for it first
//   why:    for needs 'live', why
//   vfx:    the VFX effect it runs (web/vfx-rules.js EFFECTS); tools: what it places on the open frame (frame-overlay.js)
//
//   OPS                         { image: [...], video: [...], sound: [...], scene: [...] }
//   opById(kind, id)            the op, or null
//   opsFor(frames)              Map kind -> ops, in the order the kinds first appear (notes skipped)
//   whyNot(op, {live, opts})    why it can't run from here ('' / null when it can)
//   canRun(op, {live, opts})    true when it can
//   quickOf(kind)               [{ label, icon, ids }] the icon row over the list
//   groupsOf(kind)              [{ group, ops }] in order, for a select's optgroups
//   planRuns(frames, op, batch) { runs: [{ frame, batch }], skipped: [{ frame, why }] }
//   menuGroupsFor(frames, {live})  [{ kind, title, groups: [[{ id, kind, label, icon, disabled, why }]] }]
//   targetsOf(op)               the landing choices ['frame', 'layer'] (or ['self'] for an op on the document itself)
//   defaultTarget(op, live)     'layer' when the frame is live, else 'frame' ('self' when that's all there is)
//   resultKind(op)              the kind of frame its result goes in

const LIVE_PAINT = 'It is painted on the open frame';
const LIVE_MARKS = 'The marks are placed on the open frame';
const LIVE_TIMELINE = 'It works on the open frame\'s timeline';

const IMAGE = [
  { id: 'edit', group: 'Edit', label: 'Edit from a prompt', icon: 'edit', quick: 'Edit', tpl: 'deck-qwen21-edit',
    help: 'Qwen 2.1 changes the picture as the prompt says: everywhere, or only where what you name is.',
    live: (o) => (o?.ewhere === 'painted' ? 'The area to change is painted on the open frame' : null) },
  { id: 'swap', group: 'Edit', label: 'Swap a face or body', icon: 'swap', quick: 'Swap',
    help: 'A face, head, body or person from another picture, found in this one and swapped in.',
    live: (o) => (o?.swapWhere && o.swapWhere !== 'find' ? 'The area is painted on the open frame' : null) },
  { id: 'up', group: 'Upscale', label: 'Upscale (quality)', icon: 'enlarge', quick: 'Upscale', tpl: 'deck-upscale-image', help: 'SeedVR2: a bigger picture with finer detail.' },
  { id: 'upfast', group: 'Upscale', label: 'Upscale (fast)', icon: 'enlarge', tpl: 'deck-upscale-image-fast', help: 'A quick upscale model: sharper, not redrawn.' },
  { id: 'clean', group: 'Clean up', label: 'Clean: noise, JPEG blocks or blur', icon: 'sparkle', quick: 'Clean up', tpl: 'deck-clean-image', help: 'A restoration model at the picture\'s own size.' },
  { id: 'restore', group: 'Clean up', label: 'Restore an old photo', icon: 'photo', quick: 'Restore', help: 'Scratches, noise, faces and colour of an old photo.' },
  { id: 'unmark', group: 'Clean up', label: 'Remove a watermark all over', icon: 'eraser', quick: 'Remove', help: 'An edit model takes a watermark off the whole picture.' },
  { id: 'remove', group: 'Clean up', label: 'Remove what you mark', icon: 'eraser', needs: 'live', why: LIVE_MARKS, help: 'LaMa fills in what is marked.' },
  { id: 'colorise', group: 'Colour', label: 'Colourise', icon: 'palette', quick: 'Colourise', help: 'A black and white picture in colour.' },
  { id: 'cutout', group: 'Cut out', label: 'Cut out the subject', icon: 'cut', quick: 'Cut out', tpl: 'deck-cutout-image', help: 'The main subject cut out; the rest goes see-through.' },
  { id: 'words', group: 'Cut out', label: 'Cut out by words (SAM3)', icon: 'cut', tpl: 'deck-mask-image', help: 'What you name, found and cut out.' },
  { id: 'sheet', group: 'Cut out', label: 'Split a sheet', icon: 'grid', needs: 'live', why: 'The cells are checked on the open frame', help: 'Each cell of a sheet enlarged and cut out (for 3D).' },
  { id: 'skin', group: 'Detail', label: 'Skin detail', icon: 'person', quick: 'Skin', help: 'Real skin texture on faces and bodies.',
    live: (o) => (o?.skinWhere === 'parts' ? 'Body parts are found and placed on the open frame' : null) },
  { id: 'detail', group: 'Detail', label: 'Detail pass', icon: 'star', quick: 'Detail', help: 'The picture drawn again with finer detail, its layout kept.' },
  { id: 'delight', group: 'Detail', label: 'De-light', icon: 'star', help: 'Evens out dark or shadowed pictures.' },
  { id: 'depth', group: 'Maps', label: 'Depth map', icon: 'grid', quick: 'Maps', help: 'A grey depth map, near is white.' },
  { id: 'canny', group: 'Maps', label: 'Canny edges', icon: 'grid', help: 'White edges on black.' },
  { id: 'scribble', group: 'Maps', label: 'Scribble', icon: 'grid', help: 'A loose line drawing.' },
  { id: 'pose', group: 'Maps', label: 'Pose', icon: 'figure', help: 'Body, hands and face as a stick figure.' },
  { id: 'inpaint', group: 'Edit', label: 'Inpaint', icon: 'brush', needs: 'live', why: LIVE_PAINT, help: 'Paints something new where you paint.' },
];

// Every effect of the VFX tab is a video op here (vfx: its web/vfx-rules.js effect, run from the op's options and the
// frame's own state, frame.ops[op]); tools: what it places on the open frame (web/frame-overlay.js: 'points', 'boxes',
// 'paths', 'matte', 'color'); a tool's marks are optional unless the op needs the open frame
const VIDEO = [
  { id: 'grab', group: 'Quick', label: 'Grab frame', icon: 'camera', quick: 'Grab', lands: 'image', once: true, selfLands: true,
    help: 'A still of the clip at a time you choose: a new image frame, or a layer in the selected image frame.' },
  { id: 'delogo', group: 'Quick', label: 'Remove watermark', icon: 'eraser', quick: 'Remove', vfx: 'delogo', tools: ['boxes'],
    help: 'Boxes drawn over the mark on the open frame are filled in (ProPainter); with none, Find looks for a mark that stays put while the picture moves.' },
  { id: 'maps', group: 'Quick', label: 'Control map', icon: 'grid', quick: 'Maps', help: 'A depth, edge, scribble or pose map of the clip.' },
  { id: 'restyle', group: 'Restyle', label: 'LoRA restyle', icon: 'sparkle', quick: 'Restyle', tpl: 'deck-ltx-v2v-lora', help: 'The clip through an IC-LoRA, with a prompt for the result.' },
  { id: 'ripple', group: 'Restyle', label: 'Ripple edit', icon: 'edit', vfx: 'ripple', tpl: 'deck-ltx-ripple',
    live: (o) => (o?.first ? null : 'Its first frame is taken from the open frame (or choose an edited one)'),
    help: 'A change to the first frame carried through the clip: take the frame, change it in the Image tab, choose it here.' },
  { id: 'upscale', group: 'Restyle', label: 'Upscale (LTX)', icon: 'enlarge', quick: 'Upscale', tpl: 'deck-ltx-upscale', help: 'More detail at Full HD or 4K. Slow.' },
  { id: 'upvideo', group: 'Restyle', label: 'Upscale (SeedVR2)', icon: 'enlarge', tpl: 'deck-upscale-video', help: 'SeedVR2 on every frame: sharper, the picture kept.' },
  { id: 'upvideofast', group: 'Restyle', label: 'Upscale (fast)', icon: 'enlarge', tpl: 'deck-upscale-video-fast', help: 'A quick upscale model on every frame.' },
  { id: 'finish', group: 'Restyle', label: 'Finish (H3 1080p)', icon: 'star', help: 'An H3 run drawn again at 1080p by its refiner.' },
  { id: 'cleanplate', group: 'Remove', label: 'Clean plate', icon: 'eraser', tpl: 'deck-ltx-cleanplate', help: 'Removes people and moving things and fills in the background.' },
  { id: 'replace', group: 'Remove', label: 'Replace what you name', icon: 'swap', help: 'Finds what you name (SAM3) and paints the prompt in its place.' },
  { id: 'inpaint', group: 'Remove', label: 'Replace with a matte', icon: 'brush', vfx: 'inpaint', tpl: 'deck-ltx-inpaint', help: 'Paints something new where a matte clip is white.' },
  { id: 'mask', group: 'Matte', label: 'Mask (SAM3)', icon: 'select', vfx: 'mask', tpl: 'deck-sam3-video-mask', tools: ['points'],
    live: (o) => (String(o?.prompt || '').trim() || o?.points?.positive?.length ? null : 'Tap the thing on the open frame, or name it'),
    help: 'Tap the thing on the frame (or name it) and SAM3 follows it through the clip: a mask clip.' },
  { id: 'cutout', group: 'Matte', label: 'Cut out (Alpha Gen)', icon: 'cut', quick: 'Cut out', help: 'The main subject cut out: the rest goes see-through.' },
  { id: 'alpha', group: 'Matte', label: 'Matte (Alpha Gen)', icon: 'contrast', vfx: 'alpha', tpl: 'deck-ltx-alpha', help: 'A black and white matte of the main subject (white = keep).' },
  { id: 'colorkey', group: 'Matte', label: 'Colour key', icon: 'contrast', vfx: 'colorkey', tools: ['color'], help: 'Keys out a green or blue screen (no GPU).' },
  { id: 'mattekey', group: 'Matte', label: 'Apply a matte', icon: 'contrast', vfx: 'mattekey', help: 'A matte clip (white = keep) as the clip\'s see-through channel.' },
  { id: 'refine', group: 'Matte', label: 'Clean up a matte', icon: 'contrast', vfx: 'refine', help: 'Grow, shrink, fill holes, steady, soften a matte clip, or combine two (no GPU).' },
  { id: 'animate', group: 'Performance', label: 'Replace character', icon: 'person', vfx: 'animate', tpl: 'deck-h3-animate', help: 'The person in the clip re-rendered as the character in a picture.' },
  { id: 'faceswap', group: 'Performance', label: 'Face only', icon: 'person', vfx: 'faceswap', tpl: 'deck-h3-faceswap', help: 'Only the face swapped for a picture\'s.' },
  { id: 'drive', group: 'Performance', label: 'Drive a still', icon: 'figure', vfx: 'drive', tpl: 'deck-h3-drive', help: 'A picture acts out the clip (H3).' },
  { id: 'ltxdrive', group: 'Performance', label: 'Drive a still (LTX)', icon: 'figure', vfx: 'ltxdrive', tpl: 'deck-ltx-drive', help: 'A picture acts out the clip (LTX-2.5).' },
  { id: 'talk', group: 'Performance', label: 'Talking shot', icon: 'mic', vfx: 'talk', tpl: 'deck-ltx-a2v', help: 'Someone in a picture says a line, lips in time: a new clip.' },
  { id: 'layout', group: 'Generate', label: 'Layout to render', icon: 'cube', vfx: 'layout', tpl: 'deck-ltx-layout', help: 'A rough layout clip as a finished shot, from a first frame.' },
  { id: 'extend', group: 'Generate', label: 'Extend frame', icon: 'maximize', vfx: 'extend', tpl: 'deck-ltx-inpaint', help: 'The clip on a bigger canvas, the rest painted in.' },
  { id: 'tracks', group: 'Generate', label: 'Motion paths', icon: 'line', vfx: 'tracks', tpl: 'deck-ltx-tracks', tools: ['paths'],
    live: (o) => (o?.tracks?.length ? null : 'Paths are drawn on the open frame'), help: 'Paths drawn on the start image: things under a path\'s start move along it.' },
  { id: 't2v', group: 'Generate', label: 'Text / image to video', icon: 'film', vfx: 't2v', tpl: 'deck-ltx-t2v', help: 'A new clip from a prompt, optionally from a still.' },
  { id: 'a2v', group: 'Generate', label: 'Sound to video', icon: 'sound', vfx: 'a2v', tpl: 'deck-ltx-a2v', help: 'A clip that moves to a sound: speech, music or effects.' },
  { id: 'ingredients', group: 'Generate', label: 'Ingredients sheet', icon: 'grid', vfx: 'ingredients', tpl: 'deck-ltx-ingredients', help: 'People and props cut out on white, put in one shot.' },
  { id: 'foley', group: 'Sound', label: 'Sound from the clip', icon: 'sound', tpl: 'deck-mmaudio-foley', lands: 'sound', help: 'Foley timed to the picture (MMAudio): a new sound frame.' },
  { id: 'stabilise', group: 'Quick', label: 'Stabilise', icon: 'target', needs: 'live', why: 'Its track is set on the open frame', help: 'Steadies a shaky clip.' },
  { id: 'trim', group: 'Quick', label: 'Split, trim, cross-fade', icon: 'cut', needs: 'live', why: LIVE_TIMELINE, help: 'Timeline edits.' },
];

const SOUND = [
  { id: 'voice', group: 'Voice', label: 'Clean the voice', icon: 'mic', quick: 'Voice', help: 'The voice alone, out of music, noise and echo.' },
  { id: 'foley', group: 'Make', label: 'Sound from a clip', icon: 'film', tpl: 'deck-mmaudio-foley', help: 'Foley for the first clip in the mix (MMAudio).' },
  { id: 'gain', group: 'Mix', label: 'Master level', icon: 'sound', needs: 'doc', once: true, help: 'The mix\'s level on export.' },
  { id: 'normalise', group: 'Mix', label: 'Even out the loudness', icon: 'wave', needs: 'doc', once: true, help: '−16 LUFS on export, for speech and streaming.' },
  { id: 'newvoice', group: 'Voice', label: 'New voice', icon: 'mic', needs: 'live', why: 'It is made in the open frame\'s voice tools', help: 'A voice kept to speak new lines.' },
  { id: 'speak', group: 'Voice', label: 'Speak a line', icon: 'text', needs: 'live', why: 'Lines are placed on the open frame\'s tracks', help: 'New lines in a kept voice.' },
];

const SCENE = [
  { id: 'cleanup', group: 'Model', label: 'Clean up in Blender', icon: 'cube', quick: 'Clean up', needs: 'doc', help: 'Tidy quads, fewer faces or smoother: a new layer in the scene.' },
  { id: 'righuman', group: 'Model', label: 'Rig it as a person', icon: 'figure', quick: 'Rig', needs: 'doc', tpl: 'deck-autorig-human', help: 'The figure\'s skeleton, so poses and moves drive it.' },
  { id: 'rigany', group: 'Model', label: 'Rig anything', icon: 'figure', needs: 'doc', tpl: 'deck-autorig-any', help: 'UniRig: a skeleton for an animal or a prop.' },
  { id: 'splat', group: 'Splat', label: 'Make the splat again', icon: 'cloud', needs: 'doc', help: 'SHARP on the photo again, with other choices.' },
  { id: 'blender', group: 'Model', label: 'Open in Blender', icon: 'cube', needs: 'doc', once: true, help: 'The model or splat in Blender on this PC.' },
];

const fill = (kind, list) => list.map((o) => Object.freeze({ needs: kind === 'image' ? 'still' : kind === 'scene' ? 'doc' : 'clip', ...o, kind }));
export const OPS = Object.freeze({ image: fill('image', IMAGE), video: fill('video', VIDEO), sound: fill('sound', SOUND), scene: fill('scene', SCENE) });
const GROUP_ORDER = {
  image: ['Edit', 'Upscale', 'Clean up', 'Colour', 'Cut out', 'Detail', 'Maps'],
  video: ['Quick', 'Restyle', 'Remove', 'Matte', 'Performance', 'Generate', 'Sound'],
  sound: ['Voice', 'Make', 'Mix'],
  scene: ['Model', 'Splat'],
};
export const KIND_WORD = { image: 'image', video: 'video', sound: 'sound', scene: '3D' };

export const opById = (kind, id) => OPS[kind]?.find((o) => o.id === id) || null;

export function opsFor(frames = []) {
  const m = new Map();
  for (const f of frames) if (f && OPS[f.kind] && !m.has(f.kind)) m.set(f.kind, OPS[f.kind]);
  return m;
}

// why op can't run from where it's asked ('' when it can). live: the frame it runs on is open; opts: the op's settings
export function whyNot(op, { live = false, opts = {} } = {}) {
  if (!op) return 'Unknown edit';
  if (live) return '';
  if (op.needs === 'live') return op.why || 'Open the frame for this';
  return op.live?.(opts) || '';
}
export const canRun = (op, ctx = {}) => !whyNot(op, ctx);

export function quickOf(kind) {
  const rows = new Map();
  for (const o of OPS[kind] || []) {
    if (o.quick && !rows.has(o.quick)) rows.set(o.quick, { label: o.quick, icon: o.icon, ids: [] });
  }
  // every op of a quick button's group goes with it (the first that is not greyed is opened)
  for (const r of rows.values()) {
    const first = OPS[kind].find((o) => o.quick === r.label);
    r.ids = OPS[kind].filter((o) => o === first || (o.group === first.group && !o.quick && o.needs !== 'live')).map((o) => o.id);
  }
  return [...rows.values()];
}

export function groupsOf(kind) {
  const list = OPS[kind] || [], order = GROUP_ORDER[kind] || [];
  const names = [...order.filter((g) => list.some((o) => o.group === g)), ...new Set(list.map((o) => o.group).filter((g) => !order.includes(g)))];
  return names.map((group) => ({ group, ops: list.filter((o) => o.group === group) }));
}

// One entry per frame the op applies to (its kind, with a document); the rest are listed with why.
export function planRuns(frames = [], op, batch = 1) {
  const runs = [], skipped = [], seen = new Set();
  const n = op?.once ? 1 : Math.max(1, Math.min(32, Math.round(Number(batch) || 1)));
  for (const f of frames) {
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    if (!op || f.kind !== op.kind) continue;   // (another kind's frames: their own op runs on them)
    if (!f.doc) { skipped.push({ frame: f, why: 'it has no document yet' }); continue; }
    runs.push({ frame: f, batch: n });
  }
  return { runs, skipped };
}

// The frame menu's Edit entries: one kind → its groups; several kinds → one entry per kind ("Edit image ▸")
// live(frame): is that frame open
export function menuGroupsFor(frames = [], { live = () => false, opts = () => ({}) } = {}) {
  const kinds = opsFor(frames), many = kinds.size > 1;
  return [...kinds.keys()].map((kind) => {
    const of = frames.filter((f) => f.kind === kind), isLive = of.length === 1 && !!live(of[0]);
    return { kind, title: many ? `Edit ${KIND_WORD[kind]}` : 'Edit',
      groups: groupsOf(kind).map(({ ops }) => ops.map((o) => {
        const why = whyNot(o, { live: isLive, opts: opts(kind, o.id) });
        return { id: o.id, kind, label: o.label, icon: o.icon, disabled: !!why, why: why || null };
      })) };
  });
}

export const resultKind = (op) => op?.lands || op?.kind || null;
export function targetsOf(op) {
  if (!op) return [];
  if (op.kind === 'scene' || op.needs === 'doc') return ['self'];
  return ['frame', 'layer'];
}
export function defaultTarget(op, live = false) {
  const t = targetsOf(op);
  if (t.length === 1) return t[0];
  return live ? 'layer' : 'frame';
}
// the result frame's label: "<op> · <frame label>"
export const resultLabel = (op, frame) => `${op?.label || 'Edit'} · ${frame?.label || KIND_WORD[frame?.kind] || 'frame'}`.slice(0, 120);
