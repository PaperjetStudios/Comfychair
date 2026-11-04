import { api, button, field, h, help, hint, runBar, section, seg, store, toast } from './ui.js';
import { inputUrl, thumbUrl } from './core.js';
import { bareSource } from './media.js';
import { icon } from './icons.js';
import { queueRun, template, valuesByRole, waitGen } from './make.js';
import { MAPS, MAP_MAX_SECS, mapRoles, mapSpan } from './maps.js';

// ---------------------------------------------------------------------------
// The Video tab's Control maps: a depth, edge, scribble or pose map of the selected clip, or a picture on the timeline. The
// map lands on a track above its clip, in step with it and framed the same, the way an Image tool's map lands as a layer.
// ---------------------------------------------------------------------------
const KEY = 'deck.video.maps';
const ST = { op: 'depth', scope: 'clip', depthModel: 'large', edgeAmount: 'normal', poser: 'dwpose', ...store.get(KEY, {}) };
const save = () => store.set(KEY, ST);
const RUNS = new Map();   // clip id -> what it's making (this page only: a map that lands after a reload is in History)

const OPS = [
  { id: 'depth', label: 'Depth', ic: 'cube', help: 'A grey depth map, near is white: Video Depth Anything. It is worked out over the whole span, so it stays steady from frame to frame.' },
  { id: 'canny', label: 'Canny', ic: 'select', help: 'White edges on black, for edge control.' },
  { id: 'scribble', label: 'Scribble', ic: 'pencil', help: 'A loose line drawing, white lines on black: softer and simpler than Canny.' },
  { id: 'pose', label: 'Pose', ic: 'figure', help: 'The body, hands and face landmarks as a stick figure. DWPose runs on the CPU. SDPose uses the GPU and holds up better on hard poses (up to 2 people).' },
];
const opOf = () => OPS.find((o) => o.id === ST.op) || OPS[0];
const tplOf = (o, still) => (o.id === 'pose' && ST.poser === 'sdpose' ? (still ? MAPS.pose.stillSd : MAPS.pose.sd) : MAPS[o.id][still ? 'still' : 'video']);

// What a picture's map reads: a name in the inputs. A generated picture is put there first.
async function inputOf(src) {
  if (src.input) return src.input;
  if (src.generation != null) return (await api(`/api/generations/${src.generation}/to-input`, { method: 'POST', body: { index: src.index || 0, frame: 'first', mp: 0, multiple: 1 } })).name;
  throw new Error('This picture can\'t be sent: add it with + Images');
}
const landed = (g, kind) => { const i = Math.max(0, g.outputs.findIndex((o) => o.kind === kind)); return { index: i, out: g.outputs[i] }; };

// A map queued for a clip or a picture with no timeline (the Edit pane on a video frame): src is a clip source
// ({generation, index} | {media}, optional trim {start, len}) or a picture ({input}); opts: op ('depth' | 'canny' | 'scribble'
// | 'pose') and the map's settings (depthModel, edgeAmount, poser), this device's as they are when not given.
// Resolves { gens, still (a picture's map: an image), label }.
export async function queueMap(src, opts = {}) {
  const set = { ...ST, ...opts }, o = OPS.find((x) => x.id === set.op) || OPS[0], still = !!src.input || (src.generation != null && src.kind === 'image');
  const tid = o.id === 'pose' && set.poser === 'sdpose' ? (still ? MAPS.pose.stillSd : MAPS.pose.sd) : MAPS[o.id][still ? 'still' : 'video'];
  const t = template(tid);
  if (!t) throw new Error(`${tid} isn't installed yet`);
  const len = Math.min(MAP_MAX_SECS, src.trim?.len || MAP_MAX_SECS);
  const roles = { ...mapRoles(o.id, set), ...(still ? { first: await inputOf(src) }
    : { source: { ...bareSource(src), ...(src.trim && { trim: { start: src.trim.start || 0, len } }) }, len }) };
  const gens = await queueRun({ template: t.id, values: valuesByRole(t, roles) });
  return { gens, still, label: o.label };
}

async function make(it, o, span, { render, land }) {
  const still = it.kind === 'image';
  RUNS.set(it.id, o.label); render();
  try {
    const src = still ? it.src : { ...it.src, trim: { start: span.start, len: span.len } };
    const { gens: [run] } = await queueMap(still && !it.src.input && it.src.generation != null ? { ...it.src, kind: 'image' } : src, { op: o.id });
    toast(`${o.label} map queued: it lands over the clip`);
    const g = await waitGen(run.id), { index, out } = landed(g, still ? 'image' : 'video'), label = `${it.label} · ${o.label}`;
    if (still) {
      const { name } = await api(`/api/generations/${g.id}/to-input`, { method: 'POST', body: { index, frame: 'first', mp: 0, multiple: 1 } });
      await land(it, span, g.id, { kind: 'image', src: { input: name }, url: inputUrl(name), thumb: thumbUrl(name, 160), label, len: span.len });
    } else await land(it, span, g.id, { kind: 'video', src: { generation: g.id, index }, url: out.url, label, dur: out.duration || span.len });
  } catch (e) { toast(`${o.label} map stopped: ${e.message}`, true); }
  RUNS.delete(it.id); render();
}

// ctx: lengthOf(it), range() the work area's range or null, render(), land(it, span, generation, media)
export function mapsSection(it, ctx) {
  const o = opOf(), still = it.kind === 'image', len = ctx.lengthOf(it), t = template(tplOf(o, still)), running = RUNS.get(it.id);
  const pick = (patch) => { Object.assign(ST, patch); save(); ctx.render(); };
  const r = still ? null : ctx.range(), inRange = r ? mapSpan(it, len, r) : null;
  const useRange = !!inRange && ST.scope === 'range';
  const span = useRange ? inRange : mapSpan(it, len);
  const quick = h('div', { class: 'tool-quick' }, ...OPS.map((x) => h('button', { type: 'button', class: `icon-btn tool-quick-btn${x.id === o.id ? ' on' : ''}`, title: x.label,
    'aria-pressed': String(x.id === o.id), onclick: () => pick({ op: x.id }) }, icon(x.ic), h('span', {}, x.label))));
  return section('Control maps', null,
    quick, help(`${o.help} The map lands on a track above the clip, lined up with it. Pick it as a control video in a video edit, or composite with it.`),
    !t ? hint(`${tplOf(o, still)} isn't installed yet`) : null,
    inRange ? field('Run on', seg([['clip', 'Whole clip'], ['range', 'The range']], ST.scope, (v) => pick({ scope: v }))) : null,
    o.id === 'depth' ? field('Detail', seg([['large', 'Fine'], ['small', 'Fast']], ST.depthModel, (v) => pick({ depthModel: v })),
      help('Fine uses the Large model: the sharpest edges, steadiest depth. Fast uses Small: about five times quicker, softer.')) : null,
    o.id === 'canny' || o.id === 'scribble' ? field('Amount', seg([['more', 'More lines'], ['normal', 'Normal'], ['less', 'Fewer']], ST.edgeAmount, (v) => pick({ edgeAmount: v })),
      help('How much detail the lines pick up. More lines also take in faint edges and texture; fewer keeps the main outlines.')) : null,
    o.id === 'pose' ? field('Pose from', seg([['dwpose', 'DWPose'], ['sdpose', 'SDPose']], ST.poser, (v) => pick({ poser: v }))) : null,
    span.capped ? hint(`Only the first ${MAP_MAX_SECS} s get a map.`) : null,
    runBar(button(running ? `Making ${running}…` : `Make ${o.label} map`, () => make(it, o, span, ctx), { cls: `primary${running ? ' working' : ''}`, disabled: !t || !!running })));
}
