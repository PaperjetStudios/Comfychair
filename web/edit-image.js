// The Edit tool's words and numbers, with no DOM (tests/edit_image.test.mjs): what the model is told for one picture, its seed in a batch,
// and the turbo model's step list.

const KEEP = 'Change only what is asked. Keep everything else exactly as it is: the same framing, pose, details and background.';

// The prompt, what else you said, and the sentence that holds the rest still. {layer} becomes the layer's name, so one prompt can say something different for each
// layer of a batch. (A wildcard, {a|b|c}, is picked afresh for each run by the server.)
export function editPrompt({ prompt = '', context = '', keep = true, layer = '' } = {}) {
  const said = (s) => String(s || '').replaceAll('{layer}', layer || 'the picture').trim();
  return [said(prompt), said(context), keep ? KEEP : ''].filter(Boolean).join(' ');
}

// a layer's name for {layer}: its label, or its file's without the extension
export const layerWord = (l) => (l ? l.label || String(l.name || '').split('/').pop().replace(/\.[^.]+$/, '') : '');

// The seed for the next picture's runs, and the one after it. Random: -1, a new one every run. Fixed: the same for every picture, so a batch comes out alike.
// +1 each run: counts up past the variations (the server adds 0, 1, 2… to a seed for each variation).
export function seedStep(mode, seed, variations = 1) {
  if (mode === 'random') return { use: -1, next: seed };
  return { use: seed, next: mode === 'increment' ? seed + variations : seed };
}

// Qwen 2.1 turbo's own list of sigmas, tuned for 8 steps; other step counts follow the same curve
const TURBO = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0];
export function sigmasFor(steps) {
  const n = Math.max(1, Math.round(steps)), last = TURBO.length - 1, out = [];
  for (let i = 0; i <= n; i++) {
    const at = (i / n) * last, lo = Math.min(last - 1, Math.floor(at)), f = at - lo;
    out.push(Number((TURBO[lo] + (TURBO[lo + 1] - TURBO[lo]) * f).toFixed(6)));
  }
  return out.join(', ');
}

// the LoRAs a run can use: named, on, and still installed
export const usableLoras = (rows, installed) => (rows || []).filter((l) => l.name && l.enabled !== false && installed.includes(l.name));

// Reference pictures as { name, crop }: an older version saved bare names, or left holes
export const asRefs = (list) => (list || []).map((r) => (typeof r === 'string' ? { name: r } : r)).filter((r) => r?.name);

// Which reference slots a pick from slot i fills: its own, then the empty ones after the used ones, up to the template's most
export function refSlots(i, used, most) {
  const out = [i];
  for (let k = used; k < most; k++) if (k !== i) out.push(k);
  return out;
}

// the run's values for the template's lists (its model, its sampler): what was chosen and is still on offer. Anything else stays the template's own.
export const editChoices = (fields, chosen) => Object.fromEntries((fields || [])
  .filter((f) => f.kind === 'choice' && (f.options || []).includes(chosen?.[f.key])).map((f) => [f.key, chosen[f.key]]));
