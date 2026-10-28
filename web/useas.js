import { h, api, toast, openSheet, closeSheet, button, section } from './ui.js';
import { S, inputUrl, switchTab } from './core.js';
import { genLabel } from './media.js';
import { renderFields, setVal } from './generate.js';

// ---------------------------------------------------------------------------
// "Use as…" (Board gallery, History details): every place a finished output can go, grouped by tab, only the
// ones that take its kind. Picking one sets it there and opens that tab.
// ---------------------------------------------------------------------------

// before: runs first when a place is picked (the gallery closes itself)
export function openUseAs(g, index, { before = null } = {}) {
  const o = g.outputs[index];
  if (!o) return;
  const src = { generation: g.id, index }, label = genLabel(g);
  // an image (or a clip's first / last frame) in ComfyUI's input folder, as Generate's image fields and the Editor take it
  const toInput = (frame = 'first', mp = 0, multiple = 1) => api(`/api/generations/${g.id}/to-input`, { method: 'POST',
    body: { index, frame, mp, multiple }, busy: frame === 'last' ? 'Taking the last frame…' : 'Preparing the picture…' });
  const go = (text, fn, attrs = {}) => button(text, async () => {
    closeSheet(); before?.();
    try { await fn(); } catch (e) { toast(e.message, true); }
  }, { cls: '', ...attrs });
  const groups = [
    ['Generate', generateTargets(o.kind, src, toInput, go)],
    ['VFX', vfxTargets(o.kind, src, label, toInput, go)],
    ['Video', ['image', 'video', 'audio'].includes(o.kind) ? [go('Add to the timeline', async () => {
      const { addToTimeline } = await import('./video.js');
      switchTab('video');
      await addToTimeline({ kind: o.kind, src, url: o.url, label, dur: o.duration || 0 });
      toast('Added to the Video timeline');
    })] : []],
    ['Sound', o.kind === 'audio' ? [go('Onto the timeline', async () => {
      switchTab('sound');
      await (await import('./sound.js')).addToSound(src);
      toast(`${label} is on the Sound tab`);
    })] : o.kind === 'video' ? [go('Its sound onto the timeline', async () =>
      (await import('./media.js')).soundToSoundTab(src, { name: `${g.id}-${g.template}-sound` }))] : []],
    ['Editor', o.kind === 'image' ? [go('Open in the Editor', async () =>
      (await import('./editor.js')).addToEditor((await toInput()).name))] : []],
    ['3D', sceneTargets(o, src, label, toInput, go)],
  ].filter(([, btns]) => btns.length);
  openSheet(h('h3', {}, `Use ${label} as…`),
    ...groups.map(([tab, btns]) => section(tab === 'Generate' ? `Generate · ${S.tpl.name || S.tpl.id}` : tab, null,
      h('div', { class: 'row wrap use-as' }, btns))));
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

// the 3D tab: a picture or clip as the reference over the view; a picture made into a mesh (MoGe, in ComfyUI)
function sceneTargets(o, src, label, toInput, go) {
  const scene = async () => { switchTab('scene'); return (await import('./run.js')).sceneModule(); };
  if (o.kind === 'image') {
    return [go('Reference picture', async () => {
      const { name } = await toInput();
      (await scene()).useAsRef({ kind: 'image', name, url: inputUrl(name), label });
    }), go('Make a 3D photo', async () => {
      const { name } = await toInput();
      (await scene()).makePhoto(name);
    }, { title: 'Turns the picture into a mesh in the scene (MoGe, runs in ComfyUI)' })];
  }
  if (o.kind === 'video') return [go('Reference clip', async () => (await scene()).useAsRef({ kind: 'video', src, url: o.url, label }))];
  return [];
}
