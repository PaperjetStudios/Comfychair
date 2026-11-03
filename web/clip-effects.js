import { loraPicker } from './lora-pick.js';
import { api, h, field, rangeField } from './ui.js';
import { S } from './core.js';
import { bareSource } from './media.js';
import { roleField, runAndWait, template } from './make.js';

// an IC-LoRA a restyle can use: not the ones that come with their own pipeline (SDR to HDR, Alpha Gen, the other effects')
// A LoRA's name without its folder, the IC-LoRA prefix and the extension
export const loraName = (o) => o.split('/').pop().replace(/^ltx-2\.\d-22b-ic-lora-|\.safetensors$/g, '');
// One LoRA picked from list, and its strength (the VFX tab and the Video tab's restyle step). none: a (none) choice.
export function loraChoice(list, cur, onPick, strength, { none = false, onStrength = () => {} } = {}) {
  const sel = loraPicker({ options: list, value: cur || '', label: loraName, empty: none ? '(none)' : null, onPick: (o) => onPick(o || null) });
  return [field('LoRA', sel), strength ? rangeField('Strength', strength.get, strength.set, { min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), onChange: onStrength }) : null];
}
// The colour key's settings as they start, and its sliders: the same in the VFX tab, the Video tab's Colour key… sheet
// and its Colour key effect step
export const KEY_DEFAULT = { similarity: 0.12, blend: 0.08, spill: 0.5, invert: false };
export const keyRangeFields = (k, onChange) => [
  rangeField('Similarity', () => k.similarity, (v) => { k.similarity = v; }, { min: 0.01, max: 0.6, step: 0.01, onChange,
    help: 'How close to the key colour a pixel must be to go clear. Raise it until the screen is gone.' }),
  rangeField('Edge blend', () => k.blend, (v) => { k.blend = v; }, { min: 0, max: 0.5, step: 0.01, onChange, help: 'Softens the cut-out edge.' }),
  rangeField('Spill removal', () => k.spill, (v) => { k.spill = v; }, { min: 0, max: 1, step: 0.05, onChange,
    help: 'Takes the green (or blue) cast off hair and edges.' }),
];

export const restyleLora = (o) => /ic-lora/i.test(o) && !/sdr-to-hdr|alpha-gen|clean-plate|ingredients|layout|motion-track|in-outpaint|refine|upscaler/i.test(o);

// ---- effects on Video clips (video.js): one step of a clip's effect stack, run and waited for ----
// A step is { op, prompt, lora, strength, res, outsize, target, color, similarity, blend, spill, invert }. source is a clip source
// ({generation, index} | {media}) with an optional trim {start, len} (seconds). Resolves with
// { generation, index, url, dur } of the step's result.
export const CLIP_FX = [
  ['restyle', 'LoRA restyle', 'An IC-LoRA (colourise, restore, deblur, day to night…) with a prompt describing the result.'],
  ['cleanplate', 'Clean plate', 'Removes people and moving things and fills in the background.'],
  ['replace', 'Replace', 'Finds what you name (SAM3) and paints the prompt in its place.'],
  ['cutout', 'Cut out (Alpha Gen)', 'Cuts out the main subject: the rest goes see-through.'],
  ['colorkey', 'Colour key', 'Keys out a green or blue screen (no GPU).'],
  ['upscale', 'Upscale', 'More detail at Full HD or 4K. Slow.'],
];
const MAX_SECS = 10;

const outOf = (g) => {
  const i = Math.max(0, g.outputs.findIndex((o) => o.kind === 'video'));
  return { generation: g.id, index: i, url: g.outputs[i].url, dur: g.outputs[i].duration || 0 };
};

export async function runClipStep(step, source, secs) {
  const src = { ...bareSource(source),
    ...(source.trim && { trim: source.trim }) };
  const len = Math.min(MAX_SECS, secs);
  const res = step.res || 704;
  const key = (body) => api('/api/video/key', { method: 'POST', timeout: 900000, busy: false,
    body: { source: { ...src, trim: undefined }, trim: source.trim, project_id: S.project, ...body } }).then((g) => { S.history.set(g.id, g); return g; });
  switch (step.op) {
    case 'restyle':
      return outOf(await runAndWait('deck-ltx-v2v-lora', { source: src, prompt: step.prompt, lora: step.lora, strength: step.strength ?? 1, len, res }));
    case 'cleanplate':
      return outOf(await runAndWait('deck-ltx-cleanplate', { source: src, prompt: step.prompt, len, res }));
    case 'upscale':
      return outOf(await runAndWait('deck-ltx-upscale', { source: src, prompt: step.prompt, len, outsize: step.outsize || 'FullHD' }));
    case 'replace': {
      if (!step.target?.trim()) throw new Error('Replace: say what to replace');
      const mask = outOf(await runAndWait('deck-sam3-video-mask', { source: src, prompt: step.target, mode: 'text', len }));
      return outOf(await runAndWait('deck-ltx-inpaint', { source: src, matte: { generation: mask.generation, index: mask.index }, prompt: step.prompt, len, res }));
    }
    case 'cutout': {
      const matte = outOf(await runAndWait('deck-ltx-alpha', { source: src, len, res }));
      return outOf(await key({ mode: 'matte', matte: { generation: matte.generation, index: matte.index } }));
    }
    case 'colorkey':
      return outOf(await key({ mode: 'color', color: step.color || '#00ff00', ...KEY_DEFAULT,
        ...Object.fromEntries(Object.keys(KEY_DEFAULT).filter((k) => step[k] != null).map((k) => [k, step[k]])) }));
    default:
      throw new Error(`Unknown effect ${step.op}`);
  }
}

// the IC-LoRAs a restyle step can use (as the LoRA restyle effect lists them)
export function restyleLoras() {
  const f = roleField(template('deck-ltx-v2v-lora'), 'lora');
  return (f?.options || []).filter(restyleLora);
}
