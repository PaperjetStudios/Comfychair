// PhotoCraft and EffectCraft: send an Editor edit, a Video timeline, a VFX tab or one output to them with its
// layers and tracks (app/craft.py builds the document and opens it on the computer's screen), and Bring back
// what was saved there into the media library.
import { api, button, closeSheet, h, hint, note, openSheet, placeholder, toast, toggle } from './ui.js';
import { S } from './core.js';
import { waitJob } from './clipimport.js';

const APP = { photocraft: 'PhotoCraft', effectcraft: 'EffectCraft' };
const when = (t) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'not saved');

// kind: photo | video | vfx | generation; body as app/craft.py takes it
export async function sendToCraft(kind, body, btn = null) {
  if (btn) btn.disabled = true;
  try {
    const d = await api(`/api/craft/${kind}`, { method: 'POST', body: { project_id: S.project, ...body }, busy: 'Building…' });
    toast(`Opened in ${APP[d.app]} on the computer. Save there, then Bring back.`, false,
      { label: 'Craft documents', fn: () => openCraftSheet() });
    return d;
  } catch (e) { toast(`Couldn't open it: ${e.message}`, true); return null; }
  finally { if (btn) btn.disabled = false; }
}

// What a brought-back file can go on to: pictures into the Editor or as an input, clips onto the timeline
function nextSteps(entry) {
  if (entry.kind === 'image') {
    return [button('Add to Editor', async () => {
      const { name } = await api('/api/craft/input', { method: 'POST', body: { name: entry.name, project_id: S.project } });
      closeSheet(); (await import('./editor.js')).addToEditor(name);
    }, { cls: 'small primary' }),
    button('Use as input', async () => {
      await api('/api/craft/input', { method: 'POST', body: { name: entry.name, project_id: S.project } });
      toast('Saved as an input image');
    }, { cls: 'small' })];
  }
  return [button('Add to timeline', async () => {
    closeSheet();
    await (await import('./video.js')).addToTimeline({ kind: entry.kind, src: { media: entry.name }, url: entry.url, label: entry.label });
    toast('Added to the Video timeline');
  }, { cls: 'small primary' }),
  button('Open in VFX', async () => { closeSheet(); (await import('./vfx.js')).sendToVfx({ media: entry.name }, { label: entry.label }); }, { cls: 'small' })];
}

function docRow(d, redraw) {
  const status = h('div', { class: 'hint' });
  const alpha = d.app === 'effectcraft' ? toggle('With transparency (WebM)', false) : null;
  const back = button('Bring back', async () => {
    back.disabled = true;
    try {
      const r = await api(`/api/craft/${d.id}/back`, { method: 'POST', body: { alpha: !!alpha?.input.checked } });
      const entry = await waitJob(r, (p) => { status.textContent = `Rendering… ${Math.round(p * 100)}%`; });
      status.replaceChildren(`In the media library: ${entry.label}`, h('div', { class: 'row wrap' }, ...nextSteps(entry)));
    } catch (e) { status.textContent = `Couldn't bring it back: ${e.message}`; }
    finally { back.disabled = false; }
  }, { cls: 'small primary', disabled: !d.saved });
  return h('div', { class: 'craft-doc' },
    h('div', { class: 'row' }, h('b', {}, d.title), h('span', { class: 'badge' }, APP[d.app])),
    hint(`Saved ${when(d.saved)} · brought back ${d.back?.length || 0}×`),
    h('div', { class: 'row wrap' }, back, alpha,
      button('Open again', async () => { await api(`/api/craft/${d.id}/open`, { method: 'POST' }); toast(`Opened in ${APP[d.app]}`); }, { cls: 'small' })),
    status);
}

export async function openCraftSheet() {
  const list = h('div', { class: 'craft-list' }, placeholder('Loading…'));
  openSheet(h('h3', {}, 'PhotoCraft & EffectCraft'),
    note('Documents sent from here open on the computer\'s screen. Edit and save them there, then Bring back renders the saved version into the media library.'),
    list);
  const draw = async () => {
    try {
      const docs = await api(`/api/craft?project_id=${encodeURIComponent(S.project ?? '')}`, { busy: false });
      list.replaceChildren(...(docs.length ? docs.map((d) => docRow(d, draw)) : [placeholder('Nothing sent yet: use Open in PhotoCraft / EffectCraft in the Editor, Video, VFX or a result.')]));
    } catch (e) { list.replaceChildren(placeholder(e.message)); }
  };
  draw();
}
