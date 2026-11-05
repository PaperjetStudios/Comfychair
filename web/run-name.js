// What a run's result is called, so a layer or clip says how it was made: the process, the model, then any LoRAs. "Blended · Klein 9B · fusion2250".
//   runName(process, g, templates?)  g: a run ({ template, params }), or just { template }. templates: the template list, so a model file picked other than
//     the template's own is named too. A word the process already says isn't said twice.
//   templateProcess(name)            a template's name as a process: without "deck" and its model ("deck klein3 control" → "control")
const MODELS = [[/klein9b/, 'Klein 9B'], [/klein3/, 'Klein 3'], [/krea2/, 'Krea 2'], [/qwen21/, 'Qwen 2.1'], [/-h3-/, 'MiniMax H3'], [/-ltx-/, 'LTX-2.5'], [/-moss-/, 'MOSS'],
  [/ace-music/, 'ACE-Step'], [/mmaudio/, 'MMAudio'], [/lama/, 'LaMa'], [/sam3|deck-mask/, 'SAM3'], [/sdpose/, 'SDPose'], [/deck-upscale-(image|video)$/, 'SeedVR2']];
const stem = (p) => String(p).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');
const MODEL_FIELD = /\.(unet_name|ckpt_name|model_name)$/;

export function modelOf(id) {
  const m = MODELS.find(([re]) => re.test(String(id || '')));
  return m ? m[1] : null;
}
export function runName(process, g, templates = null) {
  const params = g?.params || {}, t = templates?.find?.((x) => x.id === g?.template), parts = [process];
  const said = (w) => parts.some((p) => String(p).toLowerCase().includes(String(w).toLowerCase()));
  const add = (w) => { if (w && !said(w)) parts.push(w); };
  const family = modelOf(g?.template);
  add(family);
  for (const [k, v] of Object.entries(params)) {
    if (!MODEL_FIELD.test(k) || typeof v !== 'string' || !v) continue;
    const own = t?.fields?.find((f) => f.key === k)?.value;
    if (!family || (own != null && own !== v)) add(stem(v));   // (no family to say, or a model file other than the template's)
  }
  for (const [k, v] of Object.entries(params)) {
    if (!k.endsWith('__loras') || !Array.isArray(v)) continue;
    for (const l of v) if (l?.name && l.enabled !== false) add(stem(l.name));
  }
  return parts.filter(Boolean).join(' · ');
}
export function templateProcess(name) {
  const out = String(name || '').replace(/^deck\s+/i, '').replace(/\b(klein\s?(9b|3)|krea\s?2|qwen\s?2\.?1|qwen21|h3|ltx|moss)\b/gi, '').replace(/\s+/g, ' ').trim();
  return out || String(name || '');
}
