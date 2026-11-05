// The VFX effects as data, and what a run of one sends: no DOM, so tests/vfx_rules.test.mjs loads it. The VFX tab
// (web/vfx.js, its own state T) and the Edit pane's video ops (web/edit-ops.js, an op's options plus the frame's own
// state, frame.ops[op]) both build their runs here, so the two doors can't drift apart.
//
// A state (st) is BLANK()'s shape: { source, first, matte, matte2, sound, voice, prompt, loras, len, res, size, seed,
//   points: { positive, negative } (fractions of the source frame as cropped), pointsAt (seconds in the source clip),
//   tracks: [[{x, y}]] (fractions of the start image), boxes: [{x, y, w, h}] (fractions of the whole source frame),
//   key, refine, canvas, sam, alpha, face, blend, steps, poser, outsize, talk, … }
//
//   EFFECTS, GROUPS, fx(id)          the effects (fx falls back to the first)
//   tplIdOf(e, st)                   the template a run of e uses (its SDPose, still or masked take when st asks for one)
//   missingInput(e, st)              what's missing before e can run, or null
//   buildRun(e, st, deps)            { t, values, rv } or why it can't (a string). deps: { template(id), roleField(t, role),
//                                    imageSize(name, area), sourceInfo(), imageNat(name), canvas(body), character(id),
//                                    aspect(), loose }
//   keyBody / matteBody / delogoBody / delogoRunBody   the server jobs' bodies (/api/video/key, /matte, /delogo)
//   poseBody(st, project)            /api/pose/find's body (a drive's ready pose video)
//   FRAME_KEYS                       what a frame keeps per op (frame.ops[op]): marks placed on it and its own mattes and key
//   NOT_SETUP                        what a saved setup of an effect leaves out (what it runs on, and the takes)
//   migrateVfxDoc(payload)           an old frame VFX document's marks and key as frame.ops ({ [op]: state })
//   mergeOps(old, now)               those under what the frame has already (its own state wins, op by op and key by key)
//   snapBox(mode, b, opts)           a box being drawn, moved or sized, snapped to a grid and to edges
import { MAPS, mapRoles } from './maps.js';
import { talkPrompt, talkSeconds } from './talk.js';

export const FPS = 24;   // LTX runs at 24 fps; lengths are 8n+1 frames

// group: the sideNav-like family; tpl: the template it runs; needs: the inputs it shows
export const EFFECTS = [
  { id: 'delogo', group: 'Quick', label: 'Remove watermark', job: 'delogo', needs: ['source', 'boxes'],
    help: 'Draw a box over each logo, caption or mark (or tap Find). Quality fills the boxes with ProPainter from what the other frames show behind them; the rest of the picture is left exactly as it was. Fast is instant but smears the box.' },
  { id: 'depth', group: 'Quick', label: 'Depth map', tpl: MAPS.depth.video, still: MAPS.depth.still, maxLen: 20, needs: ['source?', 'first?', 'len', 'depthModel'],
    lenHelp: 'Up to 20 s at 24 fps. The depth is worked out over the whole clip, so it stays steady from frame to frame.',
    help: 'A grey depth map (near is white) of a clip, or of a picture when there is no clip: Video Depth Anything. Use it as H3 control, in Layout to render, or for compositing.' },
  { id: 'canny', group: 'Quick', label: 'Canny edges', tpl: MAPS.canny.video, still: MAPS.canny.still, maxLen: 20, needs: ['source?', 'first?', 'len', 'edgeAmount'],
    lenHelp: 'Up to 20 s at 24 fps.',
    help: 'White edges on black, of a clip or (with no clip) of a picture: the Canny map that edge control and edit models follow. Use it as a reference picture or as control, or for compositing.' },
  { id: 'scribble', group: 'Quick', label: 'Scribble', tpl: MAPS.scribble.video, still: MAPS.scribble.still, maxLen: 20, needs: ['source?', 'first?', 'len', 'edgeAmount'],
    lenHelp: 'Up to 20 s at 24 fps.',
    help: 'A loose line drawing of a clip or (with no clip) of a picture: white lines on black, softer and simpler than Canny. Use it as a reference picture or as control, or for compositing.' },
  { id: 'ripple', group: 'Restyle', label: 'Ripple edit', tpl: 'deck-ltx-ripple', needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    help: 'Change the first frame (with an edit, or by painting on it), and the change carries through the whole clip.' },
  { id: 'lora', group: 'Restyle', label: 'LoRA restyle', tpl: 'deck-ltx-v2v-lora', needs: ['source', 'loras', 'prompt', 'len', 'res', 'seed'],
    help: 'Runs the clip through an IC-LoRA: deblur, colourise, restore, day to night, head swap and so on. Pick the LoRA and its strength, and describe the result in the prompt (for colourise, name the colours): with an empty prompt the change is faint.' },
  { id: 'alpha', group: 'Matte', label: 'Cut out (Alpha Gen)', tpl: 'deck-ltx-alpha', masked: 'deck-ltx-alpha-crop', needs: ['source', 'matte?', 'alpha', 'len', 'res', 'seed'],
    help: 'Makes a black-and-white matte of the main subject (white = keep). Then use it with "Apply matte", or as a mask. Give it a mask of one thing (Mask (SAM3), from the same clip) and it works on a crop round that thing: a sharper matte in the same time, of just that thing.' },
  { id: 'colorkey', group: 'Matte', label: 'Colour key', job: 'key', needs: ['source', 'keycolor'],
    help: 'Cuts out a green or blue screen. Quick: runs on the server with ffmpeg, no GPU.' },
  { id: 'mattekey', group: 'Matte', label: 'Apply matte', job: 'key', needs: ['source', 'matte', 'invert'],
    help: 'Uses a matte clip (white = keep) as the clip\'s see-through channel, so lower tracks show through.' },
  { id: 'refine', group: 'Matte', label: 'Clean up matte', job: 'matte', needs: ['source?', 'matte', 'matte2', 'refine'],
    help: 'Cleans up a matte or mask (white = keep), or combines two: SAM3\'s and Alpha Gen\'s, say. Grow or shrink it, fill holes, steady it, harden or soften the edge. Quick: ffmpeg on the server, no GPU. Then pick it as another effect\'s matte / mask.' },
  { id: 'mask', group: 'Remove', label: 'Mask (SAM3)', tpl: 'deck-sam3-video-mask', needs: ['source', 'points', 'prompt', 'sam', 'len'],
    help: 'Tap the thing to cut out on the frame (Exclude marks what to leave out), or describe it. SAM3 follows it through the clip and makes a mask clip.' },
  { id: 'inpaint', group: 'Remove', label: 'Replace', tpl: 'deck-ltx-inpaint', mult: 64, needs: ['source', 'matte', 'prompt', 'len', 'res', 'seed'],
    help: 'Paints something new where a mask clip is white (make one with Mask (SAM3) or Alpha Gen) and keeps the rest of the picture. Describe the whole shot with the new thing in it.' },
  { id: 'extend', group: 'Generate', label: 'Extend frame', tpl: 'deck-ltx-inpaint', mult: 64, needs: ['source', 'canvas', 'first?', 'prompt', 'len', 'res', 'seed'],
    help: 'Puts the clip on a bigger or differently shaped canvas (portrait to landscape, say) and paints the rest (outpainting). Pick the canvas, then drag the clip on the preview or set its size and place. Describe the whole wider shot. For new parts that should look like a reference (a character, a room), make a start frame: the first frame on its canvas, filled in by an image edit with your references; the clip then grows out of it.' },
  { id: 'cleanplate', group: 'Remove', label: 'Clean plate', tpl: 'deck-ltx-cleanplate', needs: ['source', 'prompt', 'len', 'res', 'seed'],
    help: 'Removes people and other moving things from the whole clip and fills in the background. Name what to remove in the prompt.' },
  { id: 't2v', group: 'Generate', label: 'Text / image to video', tpl: 'deck-ltx-t2v', needs: ['first?', 'voice', 'prompt', 'len', 'size', 'loras', 'seed'],
    help: 'A new clip from a prompt, optionally starting from a still. Give it a Voice (a few seconds of someone speaking) and the speech in the clip takes on that voice.' },
  { id: 'a2v', group: 'Generate', label: 'Sound to video', tpl: 'deck-ltx-a2v', needs: ['sound', 'first?', 'prompt', 'len', 'size', 'loras', 'seed'],
    help: 'A clip that moves to a sound: speech (lips follow it), music (movement follows the beat) or effects. Pick the sound (a sound file, or the sound of a clip, cut to the part you want), describe the shot, and optionally a start image. The clip is as long as the sound, up to Length, and keeps the sound as it is.' },
  { id: 'layout', group: 'Generate', label: 'Layout to render', tpl: 'deck-ltx-layout', mult: 64, needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    help: 'Turns a rough layout clip (a 3D scene render in Clay or Colour, or blocked-out footage) into a finished shot that keeps its layout and motion.' },
  { id: 'tracks', group: 'Generate', label: 'Motion paths', tpl: 'deck-ltx-tracks', mult: 64, needs: ['first', 'tracks', 'prompt', 'len', 'res', 'seed'],
    help: 'Draw paths on the start image: things under a path\'s start move along it.' },
  { id: 'ingredients', group: 'Generate', label: 'Ingredients sheet', tpl: 'deck-ltx-ingredients', mult: 64, needs: ['first', 'prompt', 'len', 'res', 'seed'],
    help: 'One image with the people and props cut out on a plain white background (Alpha Gen can cut them out), and the place in the prompt. Two whole photos side by side come back as a split screen.' },
  { id: 'upscale', group: 'Generate', label: 'Upscale', tpl: 'deck-ltx-upscale', needs: ['source', 'prompt', 'len', 'outsize', 'seed'],
    help: 'Adds detail at a larger size. Describe the look (light, film, sharpness), not the things in it.' },
  { id: 'animate', group: 'Performance', label: 'Replace character', tpl: 'deck-h3-animate', needs: ['source', 'first', 'len', 'res', 'steps', 'seed'],
    res: [[384, '384p'], [480, '480p'], [576, '576p']], maxLen: 30,
    help: 'Re-renders the person in the clip as the character in the still: the clip\'s motion, face, camera, light and sound are kept (Viggle-Animate on H3). Long clips run in 5 s windows.' },
  { id: 'faceswap', group: 'Performance', label: 'Face only', tpl: 'deck-h3-faceswap', needs: ['source', 'first', 'len', 'res', 'steps', 'blend', 'seed'],
    res: [[384, '384'], [512, '512'], [640, '640']], maxLen: 30,
    help: 'Swaps only the face: it is followed through the clip, re-rendered as the character\'s face with the same expressions, and blended back. Hair, body and the rest of the shot stay. Works best when the face is large in frame.' },
  { id: 'drive', group: 'Performance', label: 'Drive a still', tpl: 'deck-h3-drive', sd: 'deck-h3-drive-sd', posed: 'deck-h3-drive-posed', needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    res: [[384, '384p'], [448, '448p'], [576, '576p']], maxLen: 15,
    help: 'The character in the still acts out the clip: body, hands and face follow the clip\'s pose (H3 with pose control), in a new shot described by the prompt. Call the character <Subject 1> and the still <Picture 1>, and name their clothes and look: otherwise the outfit can drift.' },
  { id: 'ltxdrive', group: 'Performance', label: 'Drive a still (LTX)', tpl: 'deck-ltx-drive', sd: 'deck-ltx-drive-sd', posed: 'deck-ltx-drive-posed', mult: 64, needs: ['source', 'first', 'prompt', 'len', 'res', 'seed'],
    res: [[448, '448p'], [576, '576p'], [704, '704p']],
    help: 'Like Drive a still, on LTX-2.5: the still is the first frame and the clip\'s pose (body, hands, face) moves it. Keeps the still\'s scene and look closely. Describe the person and what they do; the sound is made from the prompt.' },
  { id: 'talk', group: 'Performance', label: 'Talking shot', tpl: 'deck-ltx-a2v', needs: ['line', 'first', 'prompt', 'size', 'loras', 'seed'],
    help: 'Someone in a picture says a line, with their lips in time: pick a character (their picture and voice) or a picture and a voice, write the line and Speak it (or choose a sound of someone speaking). Works best with the face clear and turned towards the camera; the closer the face, the crisper the lips. The clip is as long as the line and keeps its sound. LTX-2.5 sound to video.' },
  { id: 'pose', group: 'Performance', label: 'Pose preview', tpl: MAPS.pose.video, sd: MAPS.pose.sd, still: MAPS.pose.still, stillSd: MAPS.pose.stillSd, needs: ['source?', 'first?', 'len'],
    help: 'Shows what Drive a still will follow: the clip\'s body, hands and face as a stick figure. With no clip, the picture\'s pose as a picture, to use as a reference.' },
];
export const GROUPS = ['Quick', 'Restyle', 'Matte', 'Remove', 'Generate', 'Performance'];
export const fx = (id) => EFFECTS.find((e) => e.id === id) || EFFECTS[0];
export const effectById = (id) => EFFECTS.find((e) => e.id === id) || null;
export const needsOf = (e) => new Set((e?.needs || []).map((n) => n.replace('?', '')));

// Viggle-Animate's distilled schedules (shift 3): points = Euler updates + 1
export const STEPS = { 3: '1.0, 0.8571428571428571, 0.6, 0.0',
  5: '1.0, 0.9230769230769231, 0.8181818181818182, 0.6666666666666666, 0.42857142857142855, 0.0',
  7: '1.0, 0.9473684210526315, 0.8823529411764706, 0.8, 0.6923076923076923, 0.5454545454545454, 0.3333333333333333, 0.0' };
export const RES = [[544, '544p'], [704, '704p'], [1088, '1088p']];
export const resOf = (e, st) => { const r = e.res || RES; return r.some(([v]) => v === st.res) || (st.resFree && st.res > 0) ? st.res : r[1][0]; };   // (resFree: typed under Custom)
// what a source of nat [w, h] comes out at with its short side at res, both sides multiples of the effect's (null: its size isn't known yet)
export function shortSideSize(nat, res, mult = 32) {
  if (!nat) return null;
  const k = res / Math.min(nat[0], nat[1]);
  return { w: Math.round((nat[0] * k) / mult) * mult, h: Math.round((nat[1] * k) / mult) * mult };
}
export const FACE = { grow: 1.05, feather: 0.25, chin: 0.82 };   // Face only's blend outline (Deck Face Uncrop)
// Clean up matte (POST /api/video/matte): combine two mattes, then grow/shrink, fill holes, steady, edge, feather
export const REFINE = { combine: 'union', grow: 0, close: 0, smooth: 0, feather: 0, low: 0, high: 1, invert: false };
// Extend frame: the canvas's shape (width / height; 0 = the source's own) and where the clip sits on it
export const CANVAS = { aspect: 16 / 9, scale: 1, cx: 0.5, cy: 0.5 };
export const ASPECTS = [[0, 'Source'], [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 5, '4:5'], [21 / 9, '21:9']];
// SAM3 on a clip: as the template has them (dev/make_ltx_templates.py)
export const SAM = { score: 0.3, direction: 'both', which: -1 };
// Alpha Gen: as the templates have them. The crop's only count with a mask clip (deck-ltx-alpha-crop).
export const ALPHA = { strength: 1, hold: 1, margin: 0.2, follow: 'auto', steady: 0.85, onlyMask: true, grow: 0.06 };
export const KEY = { color: '#00ff00', similarity: 0.12, blend: 0.08, spill: 0.5, invert: false };
export const BLANK = () => ({ op: 'ripple', source: null, first: null, matte: null, sound: null, voice: null, prompt: '', loras: [], len: 5, res: 704, size: null, seed: -1,
  points: { positive: [], negative: [] }, pointsAt: 0, tracks: [], key: { ...KEY },
  talk: { char: null, voice: null, engine: 'qwen', text: '', delivery: '', said: null }, steps: 3, blend: 'face', face: { ...FACE }, results: [], showing: null, matte2: null, refine: { ...REFINE }, canvas: { ...CANVAS }, boxes: [], delogo: 'quality' });

// What a frame keeps per op (frame.ops[op], saved with the table): the marks placed on it, the mattes picked for it and
// its key. The rest of an op's settings are this device's (edit-ops.js optsOf).
export const FRAME_KEYS = ['points', 'pointsAt', 'boxes', 'tracks', 'matte', 'matte2', 'key', 'refine', 'canvas'];
// A setup of an effect keeps its settings, less what it runs on (the clips, pictures, sounds, points, boxes, paths) and the takes
export const NOT_SETUP = ['op', 'source', 'first', 'matte', 'matte2', 'sound', 'voice', 'points', 'pointsAt', 'tracks', 'boxes', 'results', 'showing'];

export const lenFrames = (secs) => Math.max(1, Math.round((secs * FPS) / 8)) * 8 + 1;

// effects that follow a pose can read it with DWPose (CPU) or SDPose (GPU): e.sd is the SDPose take on e.tpl
export const tplIdOf = (e, st) => (e.still && !st.source && st.first ? (e.stillSd && st.poser === 'sdpose' ? e.stillSd : e.still)
  : e.sd && st.poser === 'sdpose' ? e.sd : e.masked && st.matte ? e.masked : e.tpl);

export function missingInput(e, st) {
  if (e.needs.includes('source') && !st.source) return 'Choose a source clip first';
  if (e.needs.includes('matte') && !st.matte) return 'Choose a matte clip first';
  if (e.needs.includes('first') && !st.first) return 'Choose the start image first';
  if (e.needs.includes('sound') && !st.sound) return 'Choose the sound first';
  if (e.needs.includes('line') && !st.sound) return 'Speak the line first, or choose a sound';
  if (e.still && !st.source && !st.first) return 'Choose a clip or a picture first';
  if (e.job === 'delogo' && !st.boxes?.length) return 'Draw a box over the watermark first';
  return null;
}

// a clip source as runs send it: the clip, and its trim and crop
const bare = (v) => (v?.generation != null ? { generation: v.generation, index: v.index || 0 } : v ? { media: v.media } : null);
const sourceOf = (s) => s && { ...bare(s), ...(s.trim && { trim: s.trim }), ...(s.crop && { crop: s.crop }) };

export const cropOf = (st) => st.source?.crop || { x: 0, y: 0, w: 1, h: 1 };
// a box drawn on the whole source frame as fractions of the cropped clip
export const clipFracs = (b, c = { x: 0, y: 0, w: 1, h: 1 }) => ({ x: (b.x - c.x) / c.w, y: (b.y - c.y) / c.h, w: b.w / c.w, h: b.h / c.h });
// the source's shape after its crop (aspect: the whole source's width / height)
export const srcAspect = (st, aspect = 16 / 9) => { const c = cropOf(st); return (aspect || 16 / 9) * (c.w / c.h); };
export const canvasAspect = (st, aspect) => (st.canvas?.aspect || srcAspect(st, aspect));
// the clip's box on the canvas, in fractions of the canvas (app/videoedit.canvas_plan does the same in pixels)
export function clipBox(st, aspect) {
  const c = st.canvas || CANVAS, sa = srcAspect(st, aspect), A = canvasAspect(st, aspect);
  const [w, h] = sa > A ? [c.scale, (c.scale * A) / sa] : [(c.scale * sa) / A, c.scale];
  return { left: c.cx - w / 2, top: c.cy - h / 2, w, h };
}

// the points are kept as fractions of the (cropped) frame; SAM3 wants pixels of the clip it reads (info: its probe)
export function pointsPx(st, info) {
  const c = cropOf(st), pts = st.points || { positive: [], negative: [] };
  const W = (info?.width || 1) * c.w, H = (info?.height || 1) * c.h;
  const px = (p) => ({ x: ((p.x - c.x) / c.w) * W, y: ((p.y - c.y) / c.h) * H });
  return { positive: (pts.positive || []).map(px), negative: (pts.negative || []).map(px) };
}
// paths are fractions of the start image; the tracks node wants pixels of the image as the template resizes it
// (short side to Resolution, both sides multiples of the effect's), or of an explicit Width / Height. nat: the image's size
export function tracksPx(st, e, w, hgt, nat) {
  if (!(w && hgt) && nat) {
    const k = st.res / Math.min(nat[0], nat[1]), m = e.mult || 32;
    w = Math.round((nat[0] * k) / m) * m; hgt = Math.round((nat[1] * k) / m) * m;
  }
  w ||= 1; hgt ||= 1;
  return (st.tracks || []).map((tr) => tr.map((p) => ({ x: Math.round(p.x * w), y: Math.round(p.y * hgt) })));
}

export const talkPromptOf = (st, c = null) => {
  const L = st.talk || {};
  return talkPrompt({ who: c?.name, look: c?.look, text: L.text, delivery: L.delivery });
};

// What a template effect sends: { t (the template, with its SDPose / still variant), values (by field key), rv (the
// same by role, for the drives' posed and pose templates) }, or a message saying why it can't. deps.loose: for Open in
// Generate, where missing things can be filled in later
export async function buildRun(e, st, deps) {
  const { template, roleField, loose = false } = deps;
  const t = template(tplIdOf(e, st));
  if (!t) return `Template ${tplIdOf(e, st)} isn't installed yet`;
  const values = {}, rv = {};
  const put = (role, v) => { const f = roleField(t, role); if (f && v !== undefined && v !== null) { values[f.key] = v; rv[role] = v; } };
  const prompt = String(st.prompt || '');
  put('source', sourceOf(st.source));
  put('matte', st.matte && bare(st.matte));
  if (e.needs.some((n) => n.startsWith('first'))) put('first', st.first);   // (one picture per tab: only the effects that take one)
  if (e.needs.includes('sound')) put('sound', st.sound);
  if (e.needs.includes('voice')) put('voice', st.voice);
  put('prompt', prompt.trim() ? prompt : undefined);   // empty: keep the template's own prompt
  put('len', e.needs.includes('len') ? st.len : undefined);
  put('seed', e.needs.includes('seed') ? st.seed : undefined);
  if (e.needs.includes('loras')) {
    const loras = st.loras || [];
    if (roleField(t, 'loras')) put('loras', loras);
    else if (loras[0]) { put('lora', loras[0].name); put('strength', loras[0].strength); }
  }
  if (e.needs.includes('res')) put('res', resOf(e, st));
  if (e.needs.includes('steps')) put('steps', STEPS[st.steps] || STEPS[3]);
  if (e.needs.includes('blend')) {
    put('blend', st.blend || 'face');
    for (const k of ['grow', 'feather', 'chin']) put(k, st.face?.[k] ?? FACE[k]);
  }
  if (e.needs.includes('depthModel') || e.needs.includes('edgeAmount')) for (const [k, v] of Object.entries(mapRoles(e.id, st))) put(k, v);
  if (e.needs.includes('outsize')) put('outsize', st.outsize || 'FullHD');
  if (e.needs.includes('sam')) { const s = st.sam || SAM; put('score', s.score); put('direction', s.direction === 'forward' ? 'forward' : 'both'); put('which', s.which); }
  if (e.needs.includes('alpha')) {
    const a = st.alpha || ALPHA;
    put('strength', a.strength); put('hold', a.hold);
    if (st.matte) { put('margin', a.margin); put('follow', a.follow); put('steady', a.steady); put('onlyMask', a.onlyMask); put('grow', a.grow); }
  }
  if (e.needs.includes('line')) {   // the spoken line, the prompt made from it, the clip as long as it, at about 0.9 MP
    put('sound', st.sound);
    put('prompt', prompt.trim() ? prompt : talkPromptOf(st, deps.character?.(st.talk?.char) || null));
    if (st.talk?.said?.seconds) put('len', talkSeconds(st.talk.said.seconds, roleField(t, 'len')?.max || 20));
  }
  const size = st.size || (e.needs.includes('size') && st.first && deps.imageSize ? await deps.imageSize(st.first, e.needs.includes('line') ? 1280 * 704 : 0) : null);
  if (e.needs.includes('size') && size) { put('width', size[0]); put('height', size[1]); }
  if (e.needs.includes('points')) {
    const pts = pointsPx(st, await deps.sourceInfo?.()), clicked = pts.positive.length > 0;
    put('pointsPos', JSON.stringify(pts.positive)); put('pointsNeg', JSON.stringify(pts.negative));
    put('mode', clicked ? 'point' : 'text');
    put('pframe', clicked ? Math.max(0, Math.round(((st.pointsAt || 0) - (st.source?.trim?.start || 0)) * FPS)) : 0);
    if (!clicked && !prompt.trim() && !loose) return 'Tap the thing on the picture, or describe it';
  }
  if (e.needs.includes('tracks') && st.first) {
    const nat = deps.imageNat ? await deps.imageNat(st.first) : null;
    put('tracks', JSON.stringify(tracksPx(st, e, values[roleField(t, 'width')?.key], values[roleField(t, 'height')?.key], nat)));
  }
  if (e.needs.includes('canvas') && st.source) {   // the clip on its canvas, and the mask of what to paint, made on the server first
    try {
      const c = st.canvas || CANVAS, a = canvasAspect(st, deps.aspect ? await deps.aspect() : undefined);
      const r = await deps.canvas({ source: bare(st.source), trim: st.source.trim || null, crop: st.source.crop || null, aspect: a, scale: c.scale, cx: c.cx, cy: c.cy });
      put('source', r.video); put('matte', r.mask);
    } catch (err) { return 'Couldn\'t set up the canvas: ' + err.message; }
  }
  return { t, values, rv };
}

// ---- the server jobs: keying, a matte cleaned up, a watermark removed ----
export function keyBody(e, st, project = null) {
  const body = { source: bare(st.source), trim: st.source?.trim || null, mode: e.id === 'colorkey' ? 'color' : 'matte', project_id: project };
  const k = { ...KEY, ...(st.key || {}) };
  if (e.id === 'colorkey') Object.assign(body, k);
  else Object.assign(body, { matte: bare(st.matte), invert: !!k.invert });
  return body;
}
export const matteBody = (st, project = null) => ({ a: bare(st.matte), ...(st.matte2 && { b: bare(st.matte2) }), ...(st.refine || REFINE), project_id: project });
export const delogoBody = (st) => ({ source: bare(st.source), trim: st.source?.trim || null, crop: st.source?.crop || null });
export const delogoRunBody = (st, project = null) => {
  const quality = st.delogo !== 'fast';
  return { ...delogoBody(st), boxes: (st.boxes || []).map((b) => clipFracs(b, cropOf(st))), mode: quality ? 'quality' : 'fast', project_id: project };
};
// Find's boxes (fractions of the cropped clip) back as fractions of the whole frame
export const boxesFromFind = (st, boxes) => { const c = cropOf(st); return (boxes || []).map((b) => ({ x: c.x + b.x * c.w, y: c.y + b.y * c.h, w: b.w * c.w, h: b.h * c.h })); };
export const poseBody = (st, project = null) => ({ source: bare(st.source), trim: st.source?.trim || null, crop: st.source?.crop || null,
  poser: st.poser || 'dwpose', len: st.len, project_id: project });

// ---- an old frame VFX document (a vfx-tabs doc a video frame pointed at, frame.vfx) as the frame's op state ----
const hasPts = (p) => !!(p && ((p.positive || []).length || (p.negative || []).length));
const MATTE_OPS = { mattekey: 'mattekey', refine: 'refine', inpaint: 'inpaint', alpha: 'alpha' };
export function migrateVfxDoc(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  const at = (op) => (out[op] ||= {});
  if (hasPts(p.points)) Object.assign(at('mask'), { points: { positive: [...(p.points.positive || [])], negative: [...(p.points.negative || [])] }, pointsAt: Number(p.pointsAt) || 0 });
  if (Array.isArray(p.boxes) && p.boxes.length) at('delogo').boxes = p.boxes.map((b) => ({ ...b }));
  if (Array.isArray(p.tracks) && p.tracks.length) at('tracks').tracks = p.tracks.map((tr) => tr.map((q) => ({ ...q })));
  if (p.key && typeof p.key === 'object') {
    const { invert, ...rest } = { ...KEY, ...p.key };
    at('colorkey').key = { ...rest, invert: false };
    if (invert) at('mattekey').key = { invert: true };
  }
  if (p.matte && MATTE_OPS[p.op]) Object.assign(at(MATTE_OPS[p.op]), { matte: p.matte, ...(p.op === 'refine' && p.matte2 && { matte2: p.matte2 }) });
  if (p.op === 'refine' && p.refine) at('refine').refine = { ...REFINE, ...p.refine };
  if (p.op === 'extend' && p.canvas) at('extend').canvas = { ...CANVAS, ...p.canvas };
  return out;
}

export function mergeOps(old, now) {
  const out = {};
  for (const op of new Set([...Object.keys(old || {}), ...Object.keys(now || {})])) out[op] = { ...(old?.[op] || {}), ...(now?.[op] || {}) };
  return out;
}

// ---- boxes on the frame: drawn, moved or sized, snapped (gizmo.js snap: a grid of gridPct % of the width, the frame's
// edges and centre and the other boxes' edges, within thr px) ----
// mode: 'new' | 'move' | 'size'; b: the box as the pointer has it (fractions); opts: { grid, gridPct, edges, W, H, thr, others }
const near = (vals, targets, thr) => {
  let best = null;
  for (const v of vals) for (const t of targets) { const d = t - v; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best))) best = d; }
  return best;
};
export function snapBox(mode, b, { grid = false, gridPct = 5, edges = false, W = 1, H = 1, thr = 8, others = [] } = {}) {
  const out = { ...b };
  const gx = gridPct / 100, gy = (gridPct / 100) * (W / H);
  const tx = [0, 0.5, 1, ...others.flatMap((o) => [o.x, o.x + o.w])], ty = [0, 0.5, 1, ...others.flatMap((o) => [o.y, o.y + o.h])];
  const fit = (v, step) => Math.round(v / step) * step;
  if (mode === 'move') {
    if (grid) { out.x = fit(out.x, gx); out.y = fit(out.y, gy); }
    if (edges) {
      const dx = near([out.x, out.x + out.w / 2, out.x + out.w], tx, thr / W), dy = near([out.y, out.y + out.h / 2, out.y + out.h], ty, thr / H);
      if (dx != null) out.x += dx;
      if (dy != null) out.y += dy;
    }
  } else {   // a corner: 'new' moves the far corner; 'size' the bottom right one
    let x1 = out.x + out.w, y1 = out.y + out.h;
    if (grid) { x1 = fit(x1, gx); y1 = fit(y1, gy); if (mode === 'new') { out.x = fit(out.x, gx); out.y = fit(out.y, gy); } }
    if (edges) {
      const dx = near([x1], tx, thr / W), dy = near([y1], ty, thr / H);
      if (dx != null) x1 += dx;
      if (dy != null) y1 += dy;
    }
    if (grid || edges) { out.w = Math.max(0, x1 - out.x); out.h = Math.max(0, y1 - out.y); }
  }
  const cl = (v) => Math.min(1, Math.max(0, v));
  out.x = cl(out.x); out.y = cl(out.y);
  out.w = Math.min(out.w, 1 - out.x); out.h = Math.min(out.h, 1 - out.y);
  return out;
}
