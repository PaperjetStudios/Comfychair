// ---------------------------------------------------------------------------
// One shot from several clips (the Video tab): Continue makes the next clip from the end of this one, Run again makes a
// clip a new take in its place, and Rerun from here redoes the clips continued from it, in order. The rules (where a
// continued clip sits, which ones are out of date) are continue-rules.js; this file queues the runs and lands them.
//
// A clip keeps:  it.cont  what it continues (continue-rules.js), set when it lands
//                it.shot  { prompt: this clip's prompt for its next take (unset: the one it was made with),
//                           next: { model: 'ltx' | 'h3', prompt, secs, lap (guide frames), end (a picture's name) } }
// Everything goes through /api/generate (make.js queueRun), one run at a time; a run that lands after its edit was
// closed stays in History.
//
// continueRunner(host) -> { fields(it), state(it), busy(id), stale(it), continueFrom(id), runAgain(id), rerunFrom(id, { self }), stopAll() }
// host: { items(), newItem(o, track), changed(), persist(), redraw(), matchSeam(it), docKey(), start(), stop(), status(long) }
// ---------------------------------------------------------------------------
import { api, toast, h, button, section, help, hint, note, field, rangeField, textArea, seg, runBar } from './ui.js';
import { bareSource } from './media.js';
import { queueRun, waitGen, template, roleField } from './make.js';
import { mainPromptKey, stop } from './generate.js';
import { pictureInput } from './picture-input.js';
import { endOf } from './timeline-rules.js';
import * as CR from './continue-rules.js';

const FPS = 24;   // every video template makes and reads 24 frames a second
const MODELS = [['ltx', 'LTX'], ['h3', 'H3']];
const WHY = { gone: 'the clip it continues is gone', changed: 'the clip it continues is a new take', trimmed: 'the clip it continues ends somewhere else now',
  upstream: 'a clip before it is out of date' };

// a run's record, asked for once (its template and the values it ran with)
const GENS = new Map(), KNOWN = new Map();
function genOf(id) {
  if (!GENS.has(id)) GENS.set(id, api(`/api/generations/${id}`, { busy: false }).then((g) => { KNOWN.set(id, g); return g; }, (e) => { GENS.delete(id); throw e; }));
  return GENS.get(id);
}
const plain = (params) => Object.fromEntries(Object.entries(params || {}).filter(([k]) => !k.startsWith('__')));
const promptKey = (t) => mainPromptKey(t) || roleField(t, 'prompt')?.key || null;
const promptOf = (g) => { const k = g && promptKey(template(g.template)); return (k && g.params?.[k]) || ''; };
const outOf = (g) => {
  const i = Math.max(0, g.outputs.findIndex((o) => o.kind === 'video'));
  if (g.outputs[i]?.kind !== 'video') throw new Error(`#${g.id} made no video`);
  return { generation: g.id, index: i, url: g.outputs[i].url, dur: g.outputs[i].duration || 0 };
};

export const canContinue = (it) => it?.kind === 'video' && (typeof it.src?.generation === 'number' || !!it.src?.media);
export const canRerun = (it) => it?.kind === 'video' && typeof it.src?.generation === 'number';

export function continueRunner(host) {
  const R = { running: false, stop: false, busy: new Map() };
  const find = (id) => host.items().find((x) => x.id === id);
  const known = (it) => (canRerun(it) ? KNOWN.get(it.src.generation) : null);
  // (its record, once: the panel is drawn again when it arrives)
  const learn = (it) => { if (canRerun(it) && !known(it)) genOf(it.src.generation).then(() => host.redraw(), () => {}); };
  const modelOf = (it) => it.shot?.next?.model || CR.familyOf(known(it)?.template) || 'ltx';
  const stale = (it) => (it?.cont ? CR.staleOf(host.items(), FPS)[it.id] || null : null);

  // ---- what a run is queued with ----
  // the end of clip a as the guide: its last frames, as many as the model takes
  function tailOf(a, family, want) {
    const got = CR.tailTrim(a, want, FPS).frames, n = CR.lapFrames(family, got);
    if (n > got) throw new Error(`${a.label} is too short to continue from: it needs ${n} frames`);
    const t = CR.tailTrim(a, n, FPS);
    return { source: { ...bareSource(a.src), trim: { start: t.start, len: t.len } }, lap: t.frames / FPS };
  }
  async function continueValues(a) {
    const nx = a.shot?.next || {}, family = modelOf(a), t = template(CR.CONT_TEMPLATES[family]);
    if (!t) throw new Error(`Template ${CR.CONT_TEMPLATES[family]} isn't installed`);
    const g = canRerun(a) ? await genOf(a.src.generation).catch(() => null) : null;
    const values = {};
    if (g && CR.familyOf(g.template) === family) {   // what the clip was made with, where this template has the same setting (LoRAs, steps)
      const own = new Set(t.fields.filter((f) => !['video', 'image', 'audio', 'seed'].includes(f.kind)).map((f) => f.key));
      for (const [k, v] of Object.entries(plain(g.params))) if (own.has(k)) values[k] = v;
    }
    const tail = tailOf(a, family, nx.lap || CR.LAP_DEFAULT[family]);
    const src = roleField(t, 'source'), end = roleField(t, 'first'), len = roleField(t, 'len'), seed = roleField(t, 'seed'), pk = promptKey(t);
    if (!src) throw new Error(`${t.id} has no clip to continue`);
    values[src.key] = tail.source;
    const say = nx.prompt ?? a.shot?.prompt ?? promptOf(g);
    if (pk && say.trim()) values[pk] = say;   // (none: the template's own words for carrying on)
    if (len) values[len.key] = nx.secs || 5;
    if (seed) values[seed.key] = -1;
    if (end && nx.end) values[end.key] = nx.end;
    const o = g?.outputs?.[a.src.index || 0], res = roleField(t, 'res');
    if (res && o?.width && o?.height) values[res.key] = Math.min(o.width, o.height);   // (the size the clip is: the two are laid over each other)
    return { template: t.id, values, lap: tail.lap };
  }
  // a new take of clip it: what it ran with, a new seed, its prompt as it stands now, and (a continued clip) the end of
  // the clip before it as that is today
  async function againValues(it) {
    const g = await genOf(it.src.generation), t = template(g.template);
    if (!t) throw new Error(`#${g.id} was made by "${g.template}": only a clip made from a template can run again`);
    const values = plain(g.params), seed = roleField(t, 'seed'), pk = promptKey(t);
    if (seed) values[seed.key] = -1;
    if (pk && it.shot?.prompt != null) values[pk] = it.shot.prompt;
    let lap = 0, a = null;
    if (it.cont) {
      a = find(it.cont.of);
      const family = CR.familyOf(g.template), src = roleField(t, 'source');
      if (!a) throw new Error('The clip it continues is gone');
      if (!src || !family) throw new Error(`#${g.id} wasn't made by a continue template`);
      const tail = tailOf(a, family, Math.round(it.cont.lap * FPS));
      values[src.key] = tail.source; lap = tail.lap;
    }
    return { template: g.template, values, lap, a, builder: g.params.__builder, face: g.params.__face };
  }
  async function make(q, doc, id) {
    const [g] = await queueRun({ template: q.template, values: q.values, ...(q.builder && { builder: q.builder }), ...(q.face && { face: q.face }) });
    const r = outOf(await waitGen(g.id));
    if (host.docKey() !== doc || !find(id)) throw new Error(`it is done as #${r.generation}, but the edit was closed or the clip removed: find it in History`);
    return r;
  }

  // ---- one step each ----
  async function stepContinue(id, doc) {
    const q = await continueValues(find(id));
    const r = await make(q, doc, id), a = find(id);
    const b = host.newItem({ kind: 'video', src: { generation: r.generation, index: r.index }, url: r.url, label: `${a.label} →`, dur: r.dur }, a.track);
    for (const k of ['x', 'y', 'scale', 'fit', 'rotation', 'anchor', 'opacity']) if (a[k] !== undefined) b[k] = structuredClone(a[k]);   // (framed as the clip it carries on)
    b.cont = CR.contOf(a, q.lap);
    if (a.shot?.next?.prompt != null) b.shot = { prompt: a.shot.next.prompt };
    host.items().push(b);
    CR.placeAfter(host.items(), a, b, q.lap);
    await host.matchSeam(b).catch(() => {});
    return b;
  }
  async function stepAgain(id, doc) {
    const q = await againValues(find(id));
    const r = await make(q, doc, id), it = find(id);
    const whole = it.out == null || Math.abs(it.out - (it.dur || 0)) < 0.05;   // (it played to its end: so does the new take)
    Object.assign(it, { src: { generation: r.generation, index: r.index }, url: r.url, thumb: null, dur: r.dur,
      in: r.dur > 0 && (it.in || 0) >= r.dur ? 0 : it.in || 0 });
    it.out = whole || !(r.dur > 0) ? r.dur || null : Math.min(r.dur, Math.max(it.in + 0.1, it.out));
    if (it.fx) it.fx.orig = null;   // (its effects were rendered from the old take)
    const a = it.cont && find(it.cont.of);
    if (a) { it.cont = CR.contOf(a, q.lap); it.track = a.track; it.at = Math.max(0, endOf(a) - q.lap); }
    CR.settle(host.items(), it.id);
    if (a) await host.matchSeam(it).catch(() => {});
    return it;
  }

  // ---- the line: one run at a time, each waited for ----
  async function line(steps, done) {
    if (R.running) return toast('A shot run is going already: wait for it, or Stop', true);
    R.running = true; R.stop = false;
    const doc = host.docKey();
    let n = 0;
    host.start();
    try {
      for (const [id, label, step] of steps) {
        if (R.stop) break;
        if (!find(id)) continue;   // (removed meanwhile)
        R.busy.set(id, steps.length > 1 ? `${n + 1}/${steps.length} ${label}` : label);
        host.redraw();
        try { await step(id, doc); n++; } finally { R.busy.delete(id); }
        host.changed();
      }
      toast(R.stop ? `Stopped${n ? ` after ${n} of ${steps.length}` : ''}` : done(n));
    } catch (e) {
      toast(R.stop ? 'Stopped' : `It stopped: ${e.message}`, true);
    } finally {
      host.stop(); R.running = false; R.stop = false; R.busy.clear();
      host.redraw();
    }
  }
  const continueFrom = (id) => line([[id, 'Continuing', stepContinue]], () => 'Continued: the new clip overlaps this one and cross-fades over the join');
  function runAgain(id) {
    const kids = CR.chainFrom(host.items(), id).length;
    return line([[id, 'New take', stepAgain]], () => `A new take is in its place${kids ? `. ${kids} ${kids === 1 ? 'clip continues' : 'clips continue'} from the old one: Rerun from here on the next clip` : ''}`);
  }
  function rerunFrom(id, { self = true } = {}) {
    const ids = [...(self ? [id] : []), ...CR.chainFrom(host.items(), id)].filter((i) => canRerun(find(i)));
    if (!ids.length) return toast('Nothing continues from this clip', true);
    return line(ids.map((i) => [i, 'New take', stepAgain]), (n) => `${n} ${n === 1 ? 'clip' : 'clips'} made again, in order`);
  }
  function stopAll() {
    if (!R.running) return;
    R.stop = true;
    stop();
    host.redraw();
  }

  // ---- the clip's Shot section ----
  function fields(it) {
    if (!canContinue(it)) return null;
    learn(it);
    const g = known(it), family = modelOf(it), busy = R.busy.get(it.id), why = stale(it);
    const sh = () => (it.shot ||= {}), nx = () => (sh().next ||= {});
    const a = it.cont && find(it.cont.of), kids = CR.chainFrom(host.items(), it.id).length;
    const laps = CR.LAPS[family], lap = laps.includes(it.shot?.next?.lap) ? it.shot.next.lap : CR.LAP_DEFAULT[family];
    const again = canRerun(it) && g && template(g.template);
    return section('Shot', null,
      help('Continue makes the next clip from the end of this one: its last second guides the movement, the new clip starts on those same frames and is laid over them, so the join cross-fades over one picture, and its colour is matched at the join. Run again makes a new take of this clip in its place, from what it was made with. Clips continued from a clip that changed are marked; Rerun from here makes them again in order. Trim the clip first to continue from an earlier moment.'),
      it.cont ? hint(a ? `Continues ${a.label}` : 'Continued from a clip that is gone', 'section-sub') : null,
      why ? note(`Out of date: ${WHY[why]}.`, 'warn') : null,
      again ? [field('This clip\'s prompt', textArea(() => it.shot?.prompt ?? promptOf(g), (v) => { sh().prompt = v; host.persist(); }, { rows: 2, label: 'This clip\'s prompt' })),
        runBar(button('Run again', () => runAgain(it.id), { cls: 'small', disabled: R.running, title: 'A new take of this clip, in its place' }),
          it.cont ? button('Rerun from here', () => rerunFrom(it.id), { cls: 'small', disabled: R.running, title: 'This clip and every clip continued from it, made again in order' }) : null,
          kids ? button('Rerun what follows', () => rerunFrom(it.id, { self: false }), { cls: 'small', disabled: R.running, title: 'Every clip continued from this one, made again in order' }) : null)] : null,
      field('Continue with', seg(MODELS, family, (m) => { nx().model = m; delete nx().lap; host.persist(); host.redraw(); })),
      field('Next prompt', textArea(() => it.shot?.next?.prompt ?? it.shot?.prompt ?? promptOf(g), (v) => { nx().prompt = v; host.persist(); },
        { rows: 2, placeholder: 'What happens next', label: 'Next prompt' })),
      rangeField('Length', () => it.shot?.next?.secs || 5, (v) => { nx().secs = v; }, { min: 1, max: 10, step: 0.5, fmt: (v) => `${v} s`, onChange: () => host.persist(),
        help: 'Seconds of new footage, after the overlap.' }),
      field('Overlap', help('How much of this clip\'s end the new one starts from. Longer carries the movement better and costs a little more time.'),
        seg(laps.map((n) => [n, `${(n / FPS).toFixed(1)} s`, `${n} frames`]), lap, (n) => { nx().lap = n; host.persist(); })),
      pictureInput({ label: 'End picture', title: 'A picture the new clip ends on (optional)', name: it.shot?.next?.end || '',
        set: (name) => { if (name) nx().end = name; else delete nx().end; host.persist(); host.redraw(); },
        tip: 'Optional. The new clip ends on this picture, which keeps a long shot from drifting.' }),
      busy ? h('div', { class: 'fx-busy', role: 'status' }, h('span', { class: 'spinner' }),
        h('div', { class: 'grow' }, h('b', {}, busy), h('div', { class: 'hint fx-text' }, host.status(true)))) : null,
      runBar(button(busy ? 'Working…' : 'Continue', () => continueFrom(it.id), { cls: 'primary' + (busy ? ' working' : ''), disabled: R.running }),
        R.running ? button('Stop', stopAll) : null));
  }

  // what the clip menu offers (layer-menu.js clipMenu's shot)
  const state = (it) => (canContinue(it) ? { cont: true, rerun: canRerun(it), from: canRerun(it) && (!!it.cont || CR.chainFrom(host.items(), it.id).length > 0), busy: R.running } : null);

  return { fields, state, busy: (id) => R.busy.get(id) || null, stale, continueFrom, runAgain, rerunFrom, stopAll, running: () => R.running };
}
