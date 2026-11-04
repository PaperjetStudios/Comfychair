// The quick-start sheet's rules (quick-start.js draws it): the sizes it offers, where a new frame goes, the choices it
// remembers on this device, and the template a start uses with what goes into it. No DOM, so
// node --test tests/quick_start.test.mjs can check it.
import { sizeForMp } from './table-model.js';
import { snapStep } from './snap-math.js';

export const KINDS = ['image', 'video', 'scene', 'sound', 'note'];
export const VIDEO_SIZES = [[1920, 1080], [1280, 720], [1080, 1920], [1024, 576]];
export const SCENE_SIZES = [[1280, 720], [1920, 1080], [1024, 1024], [768, 448]];
export const FPS = [24, 25, 30];
export const SOUND_SIZE = { w: 1024, h: 256 };
export const NOTE_SIZE = { w: 480, h: 320 };

// what a start remembers when nothing was chosen yet (1 MP square, 1280×720 at 24 fps)
export const DEFAULTS = { kind: 'image', aspect: '1:1', mp: 1, video: [1280, 720], fps: 24, scene: [1280, 720] };
const KEY = 'deck.quick';

// An image of about mp megapixels at ratio (w / h), each side a multiple of 16
export const sizeFor = (ratio, mp) => sizeForMp(ratio > 0 ? ratio : 1, 1, mp > 0 ? Math.min(16, mp) : 1);

// The new frame's top-left: the tapped table point (or with centre, the point at its middle), on the grid when it is on
export function placeAt(p, size, grid, { centre = false } = {}) {
  let x = p.x - (centre ? size.w / 2 : 0), y = p.y - (centre ? size.h / 2 : 0);
  if (grid?.on && grid.size > 0) { x = snapStep(x, grid.size); y = snapStep(y, grid.size); }
  return { x: Math.round(x), y: Math.round(y), w: size.w, h: size.h };
}

// The choices kept (store: { get(k, d), set(k, v) }, ui.js store's shape): each one checked against what is offered,
// so a stale or hand-edited value falls back to its default
export function lastChoice(store, aspects = [['1:1', 1]]) {
  const got = store.get(KEY, null) || {}, out = { ...DEFAULTS };
  if (KINDS.includes(got.kind)) out.kind = got.kind;
  if (aspects.some(([k]) => k === got.aspect)) out.aspect = got.aspect;
  if (Number.isFinite(+got.mp) && +got.mp > 0 && +got.mp <= 16) out.mp = +got.mp;
  const pick = (list, v) => list.find((s) => Array.isArray(v) && s[0] === v[0] && s[1] === v[1]);
  out.video = pick(VIDEO_SIZES, got.video) || DEFAULTS.video;
  out.scene = pick(SCENE_SIZES, got.scene) || DEFAULTS.scene;
  if (FPS.includes(+got.fps)) out.fps = +got.fps;
  return out;
}
export function rememberChoice(store, change) {
  const now = { ...(store.get(KEY, null) || {}), ...change };
  store.set(KEY, now);
  return now;
}

// ---- templates ----
// (the same tests as make.js ROLES.prompt and ROLES.first, without loading make.js)
// (a template with no Prompt group, such as ACE-Step's music, takes the words in its tags or prompt box)
export function promptField(t) {
  const fs = (t?.fields || []).filter((f) => f.kind === 'text');
  return fs.find((f) => /prompt/i.test(f.group || '') && !/negative/i.test(f.group || '') && f.input !== 'neg_coordinates')
    || fs.find((f) => /^(tags|prompt|text)$/.test(f.input || '')) || null;
}
export const pictureField = (t) => (t?.fields || []).find((f) => f.kind === 'image') || null;

// What each start runs: a test on the template, and the one tried first
const own = (t) => !/^deck-/.test(t.id);
const noPicture = (t) => !pictureField(t);
export const STARTS = {
  'image-text': { fits: (t) => t.media === 'image' && noPicture(t) && (/-t2i$/.test(t.id) || own(t)), first: null },
  'video-text': { fits: (t) => t.media === 'video' && (/-t2v$/.test(t.id) || (own(t) && noPicture(t))), first: 'deck-ltx-t2v' },   // (LTX's t2v takes a start picture if given one)
  'video-picture': { fits: (t) => t.media === 'video' && !!pictureField(t) && (/-i2v$/.test(t.id) || own(t)), first: 'deck-ltx-i2v' },
  'scene-object': { fits: (t) => /3d-object/.test(t.id) && !!pictureField(t), first: 'deck-3d-object' },
  'sound-music': { fits: (t) => /ace-music/.test(t.id) || (own(t) && t.media === 'audio' && noPicture(t)), first: 'deck-ace-music' },
};
// The template for a start: the first of wants (the last used) that fits, else the start's own, else the first that fits
export function startTemplate(templates, start, ...wants) {
  const s = STARTS[start];
  if (!s) return null;
  const ok = (templates || []).filter((t) => t && !t.error && s.fits(t));
  for (const w of [...wants, s.first]) { const t = w && ok.find((x) => x.id === w); if (t) return t; }
  return ok[0] || null;
}

// A frame's Make settings (frame.make: a Generate tab's payload) for template t with the prompt and the picture in
// their fields. base: settings kept before for the same template (its preset and changes stay).
export function makePayload(t, { prompt = null, picture = null } = {}, base = null) {
  const same = base?.template === t.id;
  const { inputs, ...kept } = same ? base : {};   // (pictures another frame copied in stay that frame's)
  const overrides = { ...(same ? base.overrides || {} : {}) };
  const pf = promptField(t), imf = pictureField(t);
  if (prompt != null && pf) overrides[pf.key] = prompt;
  if (picture && imf) overrides[imf.key] = picture;
  return { ...kept, v: 1, template: t.id, presetId: same ? base.presetId ?? null : null, overrides };
}
