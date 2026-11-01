// ---------------------------------------------------------------------------
// char-model: what a character is, with no DOM (the node tests load it). A character has several looks (outfits, ages,
// hair: each its own words, pictures, views, sheet, expressions, and its own current 3D model and rig) and one ordered
// list of media. The Character's look, views, main, sheet, expressions and pics read and write the active look, so
// web/cast.js and the other tabs read a character the same whichever look is showing; c.withLook(id) is a read-only
// copy on another look, for a shot that names one.
// A slot says where a run's result goes: view:<key>, expr:<key>, edit, sheet, model, splat, rig, clip.
// ---------------------------------------------------------------------------
export const MEDIA_ROLES = [['face', 'Face'], ['body', 'Body'], ['ref', 'Reference'], ['edit', 'Edit'], ['expression', 'Expression'], ['sheet', 'Sheet'],
  ['model', 'Model'], ['rig', 'Rig'], ['splat', 'Splat'], ['clip', 'Clip']];
const PHOTO_ROLES = new Set(['face', 'body', 'ref', 'edit']);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const strs = (v) => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === 'string'));
const str = (v) => (typeof v === 'string' ? v : '');

export function blankLook(o = {}) {
  return { id: 'main', name: 'Main', text: '', main: null, views: {}, sheet: null, expressions: {}, model: null, rig: null, ...o };
}

export class Character {
  constructor(o = {}) {
    Object.assign(this, { id: '', rev: 0, name: '', role: '', height_cm: null, desc: '', bio: '', notes: '', voice: null, relations: [], arcs: {},
      looks: [blankLook()], active: 'main', media: [], vpending: [], cands: [] }, o);
  }
  get lookNow() { return this.looks.find((l) => l.id === this.active) || this.looks[0]; }
  get look() { return this.lookNow.text; }
  set look(v) { this.lookNow.text = v; }
  get views() { return this.lookNow.views; }
  set views(v) { this.lookNow.views = v; }
  get main() { return this.lookNow.main; }
  set main(v) { this.lookNow.main = v; }
  get sheet() { return this.lookNow.sheet; }
  set sheet(v) { this.lookNow.sheet = v; }
  get expressions() { return this.lookNow.expressions; }
  // the look's pictures of them, in the media's order: its own and the ones for every look
  get pics() {
    return this.media.filter((m) => m.src?.input && PHOTO_ROLES.has(m.role) && (!m.look || m.look === this.lookNow.id)).map((m) => m.src.input);
  }
  withLook(id) {
    if (!id || id === this.lookNow.id || !this.looks.some((l) => l.id === id)) return this;
    const o = Object.create(this);
    o.active = id;
    return o;
  }
}

const cleanLook = (l, i) => blankLook({ id: str(l?.id) || `look${i}`, name: str(l?.name) || `Look ${i + 1}`, text: str(l?.text), main: l?.main || null,
  views: strs(l?.views), sheet: typeof l?.sheet === 'string' ? l.sheet : null, expressions: strs(l?.expressions), model: l?.model || null, rig: l?.rig || null });
const cleanItem = (m, i) => (m && m.src && typeof m.src === 'object' ? { id: str(m.id) || `m${i}`, kind: str(m.kind) || 'image', src: m.src, role: str(m.role) || 'ref',
  look: m.look || null, label: str(m.label), url: str(m.url), ...(m.made ? { made: m.made } : {}) } : null);
const slotOfOld = (x) => (x.slot ? x.slot : x.view ? `view:${x.view}` : null);

// a saved document as a Character: the older shape (one look's words, pics, views and sheet on the character) becomes the first look
export function fromDoc(d = {}) {
  const p = obj(d.payload);
  const old = !Array.isArray(p.looks);
  const looks = old
    ? [blankLook({ text: str(p.look), main: p.main || null, views: strs(p.views), sheet: typeof p.sheet === 'string' ? p.sheet : null })]
    : (p.looks.map(cleanLook).length ? p.looks.map(cleanLook) : [blankLook()]);
  const media = old
    ? arr(p.pics).filter((x) => typeof x === 'string').map((name, i) => ({ id: `m${i}`, kind: 'image', src: { input: name }, role: 'ref', look: null, label: '', url: '' }))
    : arr(p.media).map(cleanItem).filter(Boolean);
  const first = looks[0].id;
  const pend = (x) => ({ ...x, look: x.look || first, slot: slotOfOld(x) });
  return new Character({ id: d.id, rev: d.rev, name: d.name || '', role: str(p.role), height_cm: Number.isFinite(p.height_cm) ? p.height_cm : null,
    desc: str(p.desc), bio: str(p.bio), notes: str(p.notes), voice: p.voice || null, relations: arr(p.relations).filter((r) => r && r.to), arcs: strs(p.arcs),
    looks, active: looks.some((l) => l.id === p.active) ? p.active : first, media,
    vpending: arr(p.vpending).filter((x) => x && x.gen).map(pend).filter((x) => x.slot),
    cands: arr(p.cands).filter((x) => x && x.id).map(pend).filter((x) => x.slot) });
}
export const payloadOf = (c) => ({ role: c.role, height_cm: c.height_cm, desc: c.desc, bio: c.bio, notes: c.notes, voice: c.voice, relations: c.relations, arcs: c.arcs,
  looks: c.looks, active: c.active, media: c.media, vpending: c.vpending, cands: c.cands });

// ---- media ----
export function addImage(c, name, { role = 'ref', look = null, id = `m${Date.now().toString(36)}${c.media.length}`, made = null } = {}) {
  if (!name || c.media.some((m) => m.src?.input === name)) return null;
  const item = { id, kind: 'image', src: { input: name }, role, look, label: '', url: '', ...(made ? { made } : {}) };
  c.media.push(item);
  const l = c.looks.find((x) => x.id === look) || c.lookNow;
  l.main ||= name;
  return item;
}
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const [x] = list.splice(from, 1);
  list.splice(to, 0, x);
  return list;
}
// out of the character: anything that pointed at it lets go
export function removeItem(c, id) {
  const it = c.media.find((m) => m.id === id);
  if (!it) return;
  c.media = c.media.filter((m) => m !== it);
  for (const l of c.looks) {
    if (l.model === id) l.model = null;
    if (l.rig === id) l.rig = null;
    if (it.src?.input && l.main === it.src.input) l.main = c.media.find((m) => m.src?.input && PHOTO_ROLES.has(m.role))?.src.input || null;
  }
}
// the media of a role, for a look (or for every look)
export const itemsOf = (c, role, look = null) => c.media.filter((m) => m.role === role && (!look || !m.look || m.look === look));

// ---- looks ----
export function addLook(c, o = {}) {
  let n = c.looks.length + 1;
  while (c.looks.some((l) => l.name === `Look ${n}`)) n++;
  const l = blankLook({ id: `look${Date.now().toString(36)}${c.looks.length}`, name: `Look ${n}`, ...o });
  c.looks.push(l);
  c.active = l.id;
  return l;
}
// a copy to change: same words, pictures and views; its own model and rig are chosen again
export const duplicateLook = (c, l) => addLook(c, { name: `${l.name} copy`, text: l.text, main: l.main, views: { ...l.views }, sheet: l.sheet, expressions: { ...l.expressions } });
export function removeLook(c, id) {
  if (c.looks.length < 2) return false;
  c.looks = c.looks.filter((l) => l.id !== id);
  for (const m of c.media) if (m.look === id) m.look = null;
  if (c.active === id) c.active = c.looks[0].id;
  return true;
}

// ---- runs and their results ----
export const slotKind = (slot) => String(slot || '').split(':')[0];
export const slotKey = (slot) => String(slot || '').split(':')[1] || '';
// which outputs of a run are this slot's (kinds as in web/kinds.js)
const WANTED = { view: ['image'], expr: ['image'], edit: ['image'], sheet: ['image', 'video'], model: ['mesh'], splat: ['splat'], rig: ['mesh', 'rig'], clip: ['video'] };
const ROLE_OF = { view: 'ref', expr: 'expression', edit: 'edit', sheet: 'sheet', model: 'model', splat: 'splat', rig: 'rig', clip: 'clip' };
export const roleOfSlot = (slot) => ROLE_OF[slotKind(slot)] || 'ref';
// A run ended. Its results become candidates to review, once each. kindOf: web/kinds.js's. uid: makes an id.
export function settleRun(c, g, { kindOf, uid }) {
  const p = c.vpending.find((x) => x.gen === g.id);
  if (!p) return null;
  c.vpending = c.vpending.filter((x) => x !== p);
  if (g.status !== 'done') return { pending: p, failed: g.status !== 'gone' };
  const want = WANTED[slotKind(p.slot)] || ['image'];
  let n = 0;
  (g.outputs || []).forEach((o, index) => {
    const kind = kindOf(o);
    const isRigFile = slotKind(p.slot) === 'rig' && /\.(fbx|glb)$/i.test(o.filename || '');
    if (!want.includes(kind) && !isRigFile) return;
    if (c.cands.some((x) => x.gen === g.id && x.index === index)) return;
    c.cands.push({ id: uid(), slot: p.slot, look: p.look, gen: g.id, index, url: o.url, kind, ...(p.made ? { made: p.made } : {}) });
    n++;
  });
  return { pending: p, failed: false, added: n };
}
// A candidate kept. name: its picture's input name, for a picture. Its look's current model or rig becomes this one.
export function keepCandidate(c, x, { name = null, id = `m${Date.now().toString(36)}${c.media.length}` } = {}) {
  c.cands = c.cands.filter((y) => y.id !== x.id);
  const l = c.looks.find((y) => y.id === x.look) || c.lookNow, kind = slotKind(x.slot), key = slotKey(x.slot);
  if (kind === 'view') { l.views[key] = name; return null; }
  if (kind === 'expr') { l.expressions[key] = name; return null; }
  const item = { id, kind: x.kind || 'image', src: name ? { input: name } : { generation: x.gen, index: x.index ?? 0 }, role: roleOfSlot(x.slot), look: l.id, label: '', url: name ? '' : x.url || '', ...(x.made ? { made: x.made } : {}) };
  c.media.push(item);
  if (kind === 'sheet' && name) l.sheet = name;
  if (kind === 'model') l.model = item.id;
  if (kind === 'rig') l.rig = item.id;
  if (kind === 'edit' && name) l.main ||= name;
  return item;
}

// ---- out of date: a model made from other views than the look has now, a rig made from another model ----
export const viewsStamp = (views) => Object.keys(views || {}).sort().map((k) => `${k}=${views[k]}`).join('|');
export function staleness(c, l = c.lookNow) {
  const item = (id) => c.media.find((m) => m.id === id);
  const model = item(l.model), rig = item(l.rig);
  return {
    model: !!(model?.made?.views != null && model.made.views !== viewsStamp(l.views)),
    rig: !!(rig?.made?.from && l.model && rig.made.from !== l.model),
  };
}

// ---- the line-up: pixels tall for a height, the tallest filling the space (a figure with no height stands at the average) ----
export function lineUp(cast, px) {
  const known = cast.map((c) => c.height_cm).filter((v) => v > 0);
  const tallest = known.length ? Math.max(...known) : 170, mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 170;
  return { scale: px / tallest, cm: tallest, rows: cast.map((c) => ({ c, cm: c.height_cm > 0 ? c.height_cm : mean, guessed: !(c.height_cm > 0), px: (c.height_cm > 0 ? c.height_cm : mean) * px / tallest })) };
}
// A cut-out figure inside its picture, as fractions: { h (tall), bottom (space under it) }; null when the picture has no see-through edge to read.
// rgba: ImageData.data.
export function figureBox(rgba, w, hh) {
  let top = -1, end = -1, clear = 0;
  for (let y = 0; y < hh; y++) {
    let solid = false;
    for (let x = 0; x < w; x++) {
      const a = rgba[(y * w + x) * 4 + 3];
      if (a > 32) solid = true; else clear++;
    }
    if (solid) { if (top < 0) top = y; end = y; }
  }
  if (top < 0 || clear < w * hh * 0.02) return null;
  return { h: (end - top + 1) / hh, bottom: (hh - 1 - end) / hh };
}
// the shots that name them, across a project's stories: { story, scene, shot }
export function appearsIn(c, stories, mentioned, all) {
  const out = [];
  for (const st of stories) {
    (st.payload?.scenes || []).forEach((sc, si) => (sc.shots || []).forEach((s, i) => {
      if (mentioned(`${s.what || ''}\n${s.action || ''}`, all).some((x) => x.id === c.id)) out.push({ story: st.id, storyName: st.name, scene: sc.id, sceneIndex: si, shot: s.id, shotIndex: i, frame: s.frameRef || null });
    }));
  }
  return out;
}
