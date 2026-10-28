import { h, api, toast, openSheet, closeSheet, button, section, linkBtn, chip, hint } from './ui.js';
import { S, inputUrl, switchTab } from './core.js';
import { genLabel } from './media.js';
import { renderFields, selectTemplate, setVal } from './generate.js';
import { factsOf, kindDef, kindOf } from './kinds.js';

// ---------------------------------------------------------------------------
// "Use as…" (Board gallery, History details): every place a finished output can go, grouped by tab, only the
// ones that take its kind. Picking one sets it there and opens that tab.
// ---------------------------------------------------------------------------

// The buttons under a picked take, the same in every tab: the tab's own first (first), then Use as…, Details and
// Download, then more. i: the output (default: the first of kind, or the first).
export function resultActions(g, { kind = null, first = [], more = [] } = {}) {
  if (!g || g.status !== 'done') return null;
  const i = kind ? Math.max(0, g.outputs.findIndex((x) => x.kind === kind)) : 0, o = g.outputs[i];
  return h('div', { class: 'row wrap result-actions' }, ...first, ...takeButtons(g, i, { details: true }), ...more);
}

// What every take offers, wherever it shows (History's details, a tab's takes): Use as… (when something takes its kind),
// Pin, Details, Download and Delete. details: include the Details button (not in the details sheet itself).
export function takeButtons(g, i, { details = false, onDeleted = null } = {}) {
  const o = g.outputs[i];
  const pin = button(g.pinned ? '★ Pinned' : '☆ Pin', async () => {
    try {
      const r = await api(`/api/generations/${g.id}/pin`, { method: 'POST', body: { pinned: !g.pinned } });
      g.pinned = r.pinned; S.history.set(r.id, r); pin.textContent = r.pinned ? '★ Pinned' : '☆ Pin';
      (await import('./board.js')).boardChanged(r);
    } catch (e) { toast(e.message, true); }
  }, { title: 'Keep it at hand: the Board\'s ★ Pinned' });
  return [o && hasPlaces(o) ? button('Use as…', () => openUseAs(g, i), { title: 'Every place it can go: Generate, VFX, Video, Sound, the Editor, 3D' }) : null,
    pin,
    details ? button('Details', async () => (await import('./run.js')).openGeneration(g.id)) : null,
    o ? linkBtn('Download', o.url, { download: o.filename }) : null,
    button('Delete', async () => {
      if (!confirm(`Delete generation #${g.id} and its files?`)) return;
      try { await api(`/api/generations/${g.id}`, { method: 'DELETE' }); onDeleted?.(); } catch (e) { toast(e.message, true); }
    }, { cls: 'small danger' })].filter(Boolean);
}

// Every place a finished output can go, by its kind (kinds.js), grouped by tab. Picking one sets it there and
// opens that tab. before: runs first when a place is picked (the gallery closes itself).
export const hasPlaces = (o) => kindOf(o) !== 'file';
export function openUseAs(g, index, { before = null } = {}) {
  const o = g.outputs[index];
  if (!o) return;
  const k = kindOf(o), src = { generation: g.id, index }, label = genLabel(g);
  // an image (or a clip's first / last frame) in ComfyUI's input folder, as Generate's image fields and the Editor take it
  const toInput = (frame = 'first', mp = 0, multiple = 1) => api(`/api/generations/${g.id}/to-input`, { method: 'POST',
    body: { index, frame, mp, multiple }, busy: frame === 'last' ? 'Taking the last frame…' : 'Preparing the picture…' });
  const go = (text, fn, attrs = {}) => button(text, async () => {
    closeSheet(); before?.();
    try { await fn(); } catch (e) { toast(e.message, true); }
  }, { cls: '', ...attrs });
  const run = () => import('./run.js');
  const groups = [
    [`Generate · ${S.tpl?.name || S.tpl?.id || ''}`, generateTargets(k, src, toInput, go)],
    ['VFX', vfxTargets(k, src, label, toInput, go)],
    ['Video', ['image', 'video', 'audio'].includes(k) ? [go('Add to the timeline', async () => {
      const { addToTimeline } = await import('./video.js');
      switchTab('video');
      await addToTimeline({ kind: k, src, url: o.url, label, dur: o.duration || 0 });
      toast('Added to the Video timeline');
    })] : []],
    ['Sound', k === 'audio' ? [go('Add to the timeline', async () => {
      switchTab('sound');
      await (await import('./sound.js')).addToSound(src);
      toast(`${label} is on the Sound tab`);
    })] : k === 'video' ? [go('Its sound onto the timeline', async () =>
      (await import('./media.js')).soundToSoundTab(src, { name: `${g.id}-${g.template}-sound` }), { title: 'Take the clip\'s sound out and put it on the Sound tab\'s timeline' })] : []],
    ['Editor', k === 'image' ? [go('Open in the Editor', async () => (await import('./editor.js')).addToEditor((await toInput()).name))]
      : k === 'video' ? [go('First frame in the Editor', async () => (await import('./editor.js')).addToEditor((await toInput('first')).name)),
        go('Last frame in the Editor', async () => (await import('./editor.js')).addToEditor((await toInput('last')).name))] : []],
    ['3D', sceneTargets(g, o, src, label, toInput, go)],
    ['Other templates that take it', otherTemplates(k, src, toInput, go)],
    ['More', [
      g.template === '3d scene' ? go('Control video for H3', async () => (await run()).useControlVideo(g, g.params.scene || {}), { title: 'Into deck-h3-ctrl2v: its control video, size and length' }) : null,
      k === 'video' && /^deck-h3-/.test(g.template) ? go('Upscale (H3)…', async () => (await run()).openH3Upscale(g, index), { title: 'Sample it again bigger, with this run\'s own prompt, LoRAs and references' }) : null,
      k === 'image' || k === 'video' ? go(k === 'image' ? 'Open in PhotoCraft' : 'Open in EffectCraft',
        async () => (await import('./craft.js')).sendToCraft('generation', src), { title: 'With what it was made from as a hidden layer underneath, to keep editing on the computer' }) : null,
    ].filter(Boolean)],
  ].filter(([, btns]) => btns.length);
  openSheet(h('h3', {}, `Use ${label} as…`), hint(`${kindDef(o).name}${factsOf(o) ? ` · ${factsOf(o)}` : ''}`),
    ...(groups.length ? groups.map(([tab, btns]) => section(tab, null, h('div', { class: 'row wrap use-as' }, btns)))
      : [hint('Nothing takes this kind of file yet: Download has it.')]));
}

// The templates (other than Generate's) with a field of this kind: picking one opens it with the output in that field
function otherTemplates(kind, src, toInput, go) {
  const want = kind === 'video' ? 'video' : kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : null;
  if (!want) return [];
  return S.templates.filter((t) => !t.error && t.id !== S.tpl?.id && t.fields.some((f) => f.kind === want)).map((t) => chip(t.name || t.id, async () => {
    closeSheet();
    try {
      selectTemplate(t.id);
      const f = S.tpl.fields.find((x) => x.kind === want);
      setVal(f.key, want === 'image' ? (await toInput('first', S.imageMp[f.key] ?? 1, 16)).name : { ...src });
      renderFields(); switchTab('generate');
      toast(`${t.name || t.id}: set ${f.group} · ${f.label}`);
    } catch (e) { toast(e.message, true); }
  }));
}

// Generate's current template: the fields of the output's kind; a clip also gives its first / last frame to
// image fields and its sound to sound fields
function generateTargets(kind, src, toInput, go) {
  const fs = S.tpl?.fields || [];
  const name = (f) => `${f.group} · ${f.label}`;
  const set = (f, v, size) => {   // (the run is recorded as made from it: app/main.py lineage)
    setVal(f.key, v); renderFields();
    switchTab('generate');
    toast(`Set ${name(f)}${size ? ` (${size})` : ''}`);
  };
  const image = (f, frame, text) => go(text, async () => {
    const r = await toInput(frame, S.imageMp[f.key] ?? 1, 16);
    set(f, r.name, `${r.width}×${r.height}`);
  });
  const clip = (f, text) => go(text, async () => set(f, { ...src }));
  const of = (k) => fs.filter((f) => f.kind === k);
  if (kind === 'image') return of('image').map((f) => image(f, 'first', name(f)));
  if (kind === 'video') {
    return [...of('video').map((f) => clip(f, name(f))),
      ...of('image').flatMap((f) => [image(f, 'first', `${name(f)}: first frame`), image(f, 'last', `${name(f)}: last frame`)]),
      ...of('audio').map((f) => clip(f, `${name(f)}: its sound`))];
  }
  if (kind === 'audio') return of('audio').map((f) => clip(f, name(f)));
  return [];
}

function vfxTargets(kind, src, label, toInput, go) {
  const use = (role, value) => import('./vfx.js').then((m) => m.useInVfx(role, value, { label }));
  if (kind === 'video') {
    return [go('Source clip', () => use('source', src)), go('Matte clip', () => use('matte', src)),
      go('Sound (its sound)', () => use('sound', src)), go('Voice (its sound)', () => use('voice', src))];
  }
  if (kind === 'image') return [go('Start image / character', async () => use('first', (await toInput()).name))];
  if (kind === 'audio') return [go('Sound', () => use('sound', src)), go('Voice', () => use('voice', src))];
  return [];
}

// the 3D tab: a picture or clip as the reference over the view, a picture made into a mesh (MoGe, in ComfyUI),
// a clip's camera move (Track motion), a motion onto a figure, a 3D model into the scene, a scene render opened again
function sceneTargets(g, o, src, label, toInput, go) {
  const scene = async () => { switchTab('scene'); return (await import('./run.js')).sceneModule(); };
  const k = kindOf(o);
  if (k === 'image') {
    return [go('Reference picture', async () => {
      const { name } = await toInput();
      (await scene()).useAsRef({ kind: 'image', name, url: inputUrl(name), label });
    }), go('Make a 3D photo', async () => {
      const { name } = await toInput();
      (await scene()).makePhoto(name);
    }, { title: 'Turns the picture into a mesh in the scene (MoGe, runs in ComfyUI)' })];
  }
  if (k === 'video') {
    return [g.template === '3d scene' ? go('Open its scene in 3D', async () => (await scene()).open(g.params.scene, g.id)) : null,
      go('Reference clip', async () => (await scene()).useAsRef({ kind: 'video', src, url: o.url, label })),
      go('Track motion (a 3D camera)', async () => (await import('./track.js')).openTrack({ src, url: o.url, label }),
        { title: 'Follow the picture\'s movement and make a 3D camera from it' })].filter(Boolean);
  }
  if (k === 'motion') return [go('Put on a figure', async () => (await scene()).motionOnto(src, label), { title: 'Onto the selected person (or the first) in the 3D scene, from the playhead' })];
  if (k === 'mesh' && /\.glb$/i.test(o.filename)) return [go('Add to the 3D scene', async () => (await scene()).addPhoto(g))];
  return [];
}
