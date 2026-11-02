// Swapping a character's face, head or body for another picture's: the parts, the edit models that can do it and how each is told,
// and the sums for the area that changes (no DOM: tests/swap_part.test.mjs). The Image tool that runs it is in imagetools.js.

// find: what SAM3 is asked for. keep: what is taken back out of that. room: how much of the picture round the area the model sees, as a share
// of the area's longest side (a face needs its head and shoulders round it to fit in). grow, soft: the pasted edge, as shares of the same side.
export const SWAP_PARTS = {
  face: { label: 'Face', find: ['face'], room: 0.9, grow: 0.02, soft: 0.04, closeUp: true,
    help: 'Only the face changes: the hair, head shape and everything else stay.' },
  head: { label: 'Head', find: ['head'], room: 0.7, grow: 0.03, soft: 0.04, closeUp: true,
    help: 'The face and hair change: the neck down stays.' },
  body: { label: 'Body', find: ['person'], keep: ['head', 'face'], room: 0.2, grow: 0.04, soft: 0.02, pixels: 2e6,
    help: 'The build and clothes change: the head stays.' },
  person: { label: 'Whole person', find: ['person'], room: 0.2, grow: 0.04, soft: 0.02, pixels: 2e6,
    help: 'The whole person changes and takes the same pose and place in the picture.' },
};

// a: the picture being changed; b: the picture to take the part from, as each model calls them (app/templates.py tag_style)
export const SWAP_MODELS = {
  klein9b: { label: 'Klein 9B', tpl: 'deck-klein9b-edit', a: '<ref_image_0>', b: '<ref_image_1>', help: 'Quick; the best face swaps when tested.' },
  krea2: { label: 'Krea 2', tpl: 'deck-krea2-edit', a: 'the first image', b: 'the second image', help: 'Strong on photographic people; can draw a head too big, or turn the person to face the camera.' },
  klein3: { label: 'Klein 3', tpl: 'deck-klein3-edit', a: '<ref_image_0>', b: '<ref_image_1>', short: true, help: 'Good on a head or whole person; weak on a face alone, and it can leave a body unchanged.' },
  qwen21: { label: 'Qwen 2.1', tpl: 'deck-qwen21-edit', a: 'Picture 1', b: 'Picture 2', help: 'Good on illustrations and graphics; weaker likeness on a face alone.' },
  // With the BFS (Best Face Swap) LoRAs, trained for this job on these models, told in their authors' own words (huggingface.co/Alissonerdx/BFS-Best-Face-Swap).
  // A chip shows only when the LoRA for that part is installed. Base picture first, then the reference: the LoRAs need that order.
  'klein9b-bfs': { label: 'Klein 9B + BFS', tpl: 'deck-klein9b-edit', bfs: 'klein', help: 'A LoRA trained for head swaps: head only.',
    loras: { head: ['bfs_head_v1_flux-klein_9b_step3500_rank128.safetensors', 1] } },
  'krea2-bfs': { label: 'Krea 2 + BFS', tpl: 'deck-krea2-edit', bfs: 'krea', help: 'LoRAs trained for head and body swaps; head, body and whole person. It can turn the person to the camera.',
    loras: { head: ['bfs_head_swap_v1.1_krea2.safetensors', 0.5], body: ['bfs_body_swap_v1_krea2.safetensors', 0.5] } },
  'qwen21-bfs': { label: 'Qwen 2.1 + BFS', tpl: 'deck-qwen21-edit', bfs: 'qwen', help: 'LoRAs trained for head and body swaps: the best body swaps when tested, and it keeps the pose best.',
    loras: { head: ['bfs_head_v1.1_qwen_2.1.safetensors', 1], body: ['bfs_body_swap_v1.0_qwen_2.1.safetensors', 1] }, bodyRefPixels: 0.59e6 },
};
const HEAD_PARTS = new Set(['face', 'head']);
const BFS_PROMPTS = {
  klein: { head: 'head_swap: start with Picture 1 as the base image, keeping its lighting, environment, and background. remove the head from Picture 1 completely and replace it with the head from Picture 2, strictly preserving the hair, eye color, and nose structure of Picture 2. copy the direction of the eye, head rotation, and micro-expressions from Picture 1. Keep the body, clothing, pose, framing, and background intact.' },
  krea: { head: 'head_swap: replace the head with the reference head.', body: 'body_swap: replace the person with the reference person.' },
  qwen: { head: 'head_swap: start with <image1> as the base image, keeping its lighting, environment, and background. remove the head from <image1> completely and replace it with the head from <image2>, strictly preserving the hair, eye color, nose structure from <image2>. copy the direction of the eye, head rotation, micro expressions from <image1>, high quality, sharp details, 4k',
    body: 'body_swap: start with <image1> as the base image, keeping its lighting, environment, and background. replace the body from <image1> with the body from <image2>, strictly preserving the clothing, body shape and proportions from <image2>. copy the pose, direction of the eye, head rotation, micro expressions from <image1>' },
};
const partKind = (part) => (HEAD_PARTS.has(part) ? 'head' : 'body');

// the LoRA a model adds for a part: { name, strength } from the installed list, null if it adds none, false if it needs one that isn't there
export function swapLora(model, part, installed = []) {
  const m = SWAP_MODELS[model];
  if (!m?.loras) return null;
  if (part === 'face') return false;   // (these LoRAs redraw the whole head: put back through a face's edge, the two don't meet)
  const want = m.loras[partKind(part)];
  const name = want && installed.find((o) => o.split(/[\\/]/).pop() === want[0]);
  return name ? { name, strength: want[1] } : false;
}
// a reference this model wants smaller, in pixels (0: as it is)
export const swapRefPixels = (model, part) => (partKind(part) === 'body' && SWAP_MODELS[model]?.bodyRefPixels) || 0;

export function swapPrompt(part, model, extra = '') {
  const m = SWAP_MODELS[model] || SWAP_MODELS.klein9b, { a, b } = m;
  const text = m.bfs ? BFS_PROMPTS[m.bfs][partKind(part)] || '' : m.short ? {
    face: `In ${a}, replace the person's face with the face from ${b}.`,
    head: `In ${a}, replace the person's head with the head from ${b}.`,
    body: `In ${a}, replace the person's body and clothes with the body and clothes from ${b}. Keep the head.`,
    person: `In ${a}, replace the person with the person from ${b}, standing in the same place.`,
  }[part] || '' : {
    face: `Replace the face of the person in ${a} with the face of the person in ${b}: the same identity, features, skin tone and age. Keep the head angle, expression, hair, light, colours and everything else from ${a}.`,
    head: `Replace the head of the person in ${a} with the head of the person in ${b}: the same identity, face and hair. Keep the head angle, expression, neck, body, light, colours and everything else from ${a}.`,
    body: `Give the person in ${a} the body and clothes of the person in ${b}: the same build, outfit, materials and colours. Keep the head, face, pose, framing, background and light from ${a}.`,
    person: `Replace the person in ${a} with the person in ${b}: the same identity, face, hair, build and clothes. Keep the pose, place in the picture, framing, background and light from ${a}.`,
  }[part] || '';
  const more = String(extra || '').trim();
  return more ? `${text} ${more}` : text;
}

// the biggest of separate areas, by the box round it
export const biggestArea = (areas) => areas.reduce((best, a) => (!best || a.w * a.h > best.w * best.h ? a : best), null);

// what the model sees of a W×H picture for an area, kept inside the picture
export function swapBox(area, W, H, room) {
  const pad = Math.max(16, Math.round(Math.max(area.w, area.h) * room));
  const x = Math.max(0, area.x - pad), y = Math.max(0, area.y - pad);
  return { x, y, w: Math.min(W, area.x + area.w + pad) - x, h: Math.min(H, area.y + area.h + pad) - y };
}

// the scale that brings a box to about this many pixels: a small face is enlarged for the model, a big body brought down
export const scaleFor = (box, pixels = 1.05e6) => Math.sqrt(pixels / (box.w * box.h));

// only what lies inside a box of a row-by-row mask
export function onlyWithin(mask, W, area) {
  const out = new Uint8Array(mask.length);
  for (let y = area.y; y < area.y + area.h; y++) out.set(mask.subarray(y * W + area.x, y * W + area.x + area.w), y * W + area.x);
  return out;
}

// a mask with another's area taken out
export function without(mask, gone) {
  const out = Uint8Array.from(mask);
  for (let i = 0; i < out.length; i++) if (gone[i] > 127) out[i] = 0;
  return out;
}

// one pass of a sliding window along rows, then columns: f(sum, window size) is the new value
function slide(src, w, h, r, f) {
  const a = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      a[y * w + x] = f(s, n);
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += a[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = f(s, n);
      s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// a row-by-row mask (0..255) made r px bigger, then with a fading edge about soft px wide
export function softEdge(mask, w, h, r, soft) {
  let m = Float32Array.from(mask);
  if (r > 0) m = slide(m, w, h, Math.round(r), (s) => (s > 127 ? 255 : 0));
  const k = Math.max(0, Math.round(soft / 2));
  if (k > 0) for (let i = 0; i < 2; i++) m = slide(m, w, h, k, (s, n) => s / n);
  return Uint8ClampedArray.from(m);
}

// What the model changed beyond the area, so a new beard or a bigger build isn't cut off at the old outline: before and after are RGBA at w×h, and the
// result is a row-by-row mask of the changed cells reached from the area without crossing an unchanged one. Null if that is much more than the area,
// or most of the box (the model redrew the whole picture, so what changed says nothing): then only the area is used.
export function changedAround(before, after, mask, w, h, { most = 0.5, more = 1.5, step = 24 } = {}) {
  const cell = Math.max(4, Math.round(Math.max(w, h) / 96)), gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const sum = new Float32Array(gw * gh), n = new Uint32Array(gw * gh), start = new Uint8Array(gw * gh);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const g = ((y / cell) | 0) * gw + ((x / cell) | 0), j = i * 4;
    sum[g] += (Math.abs(before[j] - after[j]) + Math.abs(before[j + 1] - after[j + 1]) + Math.abs(before[j + 2] - after[j + 2])) / 3;
    n[g]++;
    if (mask[i] > 127) start[g] = 1;
  }
  const reached = new Uint8Array(gw * gh), stack = [];
  for (let g = 0; g < start.length; g++) if (start[g]) { reached[g] = 1; stack.push(g); }
  let count = 0;
  while (stack.length) {
    const g = stack.pop(), x = g % gw, y = (g / gw) | 0;
    if (!start[g]) count++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * gw + nx;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || reached[k] || sum[k] / n[k] < step) continue;
      reached[k] = 1; stack.push(k);
    }
  }
  if (count > most * gw * gh || count > more * start.reduce((a, b) => a + b, 0)) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (reached[((y / cell) | 0) * gw + ((x / cell) | 0)]) out[i] = 255;
  return out;
}

// two row-by-row masks joined
export function joined(a, b) {
  const out = Uint8Array.from(a);
  for (let i = 0; i < out.length; i++) if (b[i] > out[i]) out[i] = b[i];
  return out;
}
