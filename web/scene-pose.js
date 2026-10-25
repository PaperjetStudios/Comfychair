import * as THREE from './vendor/three.module.min.js';
import * as FIGURE from './figure.js';
import { C, FIG, FPS, OBJ, R, SC, addKey, current, frames, newObject, sameTab, save, write } from './scene-data.js';
import { button, clone, field, h, hint, iconBtn, nameSheet, section, seg, store, toast, uid, undoToast } from './ui.js';
import { changed, selectJoint } from './scene-view.js';
import { renderPanel, slider } from './scene-ui.js';
import { seek } from './scene-export.js';

// a figure that isn't planted on the floor keeps its feet (or seat) where they were for a new pose
function liftTo(o, v, j, m) {
  if (o.ground) return {};
  return { y: v.y + (FIGURE.liftFor(j, m) - FIGURE.liftFor(v.j, v.m)) * v.sy };
}

// ---- a figure's pose tabs ----------------------------------------------------------------
export const FIG_TABS = [['pose', '🧍 Poses'], ['adjust', '🎚 Adjust'], ['move', '🎬 Moves'], ['joint', '🦴 Joints'], ['place', '📐 Place']];
const SPEEDS = [[1.5, 'Slow'], [1, 'Normal'], [0.7, 'Fast']];
const UPPER = new Set(['spine', 'chest', 'neck', 'head', 'lsho', 'lelb', 'lhand', 'rsho', 'relb', 'rhand']);
const MINE = 'deck.figure.poses';  // poses saved by hand, in every project
let clip = null;  // a copied pose

// a stick-figure picture of a pose (or two people), kept once drawn
const THUMBS = new Map();
function thumb(key, people) {
  if (!THUMBS.has(key)) {
    const c = document.createElement('canvas'); c.width = c.height = 160;
    THUMBS.set(key, FIGURE.drawThumb(c, people).toDataURL());
  }
  return h('img', { src: THUMBS.get(key), alt: '', draggable: false });
}
const tile = (label, img, onclick, extra = null) => h('button', { type: 'button', class: 'pose-tile', title: label, onclick }, img, h('span', {}, label), extra);

// a new pose for the figure, only the upper or lower body when asked; name is what it's called in a prompt
function takePose(o, j, { m = undefined, name = null, mask = R.mask } = {}) {
  const v = current(o, FIG);
  let nj = j;
  if (mask !== 'all') {
    nj = { ...v.j };
    for (const n of Object.keys(FIGURE.JOINTS)) if (UPPER.has(n) === (mask === 'upper')) { if (j[n]) nj[n] = j[n]; else delete nj[n]; }
  }
  const nm = m === undefined ? v.m : m;
  write(o, FIG, { j: nj, m: nm, pn: name, ...liftTo(o, v, nj, nm) });
  changed();
}

// two people: this figure and the nearest other one (a new one when there's none), placed together
function takePair(o, key) {
  const p = FIGURE.pair(key), v = current(o, FIG), s = v.sy, r = THREE.MathUtils.degToRad(v.ry);
  const others = SC.objects.filter((x) => x.type === 'figure' && x !== o && !x.hidden);
  const dist = (x) => { const w = current(x, OBJ); return Math.hypot(w.x - v.x, w.z - v.z); };
  let b = others.sort((x, y) => dist(x) - dist(y))[0];
  if (!b) { b = newObject('figure'); SC.objects.push(b); }
  write(o, FIG, { j: p.a, m: {}, pn: `pair:${key}:${b.id}`, ...liftTo(o, v, p.a, {}) });
  const floor = o.ground ? current(o, FIG).y : current(o, FIG).y - FIGURE.liftFor(p.a) * s;  // where a's floor is
  const bs = current(b, FIG).sy;
  const dx = p.at.x * s, dz = p.at.z * s;
  write(b, FIG, { j: p.b, m: {}, pn: `partner:${key}`, rx: 0, rz: 0, ry: v.ry + p.at.ry,
    x: v.x + dx * Math.cos(r) + dz * Math.sin(r), z: v.z - dx * Math.sin(r) + dz * Math.cos(r),
    y: floor + p.at.y * s + (b.ground ? 0 : FIGURE.liftFor(p.b) * bs) });
  changed();
  toast(`${o.name} and ${b.name} together`);
}

export function posesTab(o, cur) {
  const cat = R.poseCat;
  const cats = [...FIGURE.categories(), ['pairs', '👥 Pairs'], ['mine', '★ Mine']];
  let tiles;
  if (cat === 'pairs') {
    tiles = FIGURE.pairList().map(([k, l]) => {
      const p = FIGURE.pair(k);
      return tile(l, thumb(`pair:${k}`, [{ j: p.a }, { j: p.b, at: p.at }]), () => takePair(o, k));
    });
  } else if (cat === 'mine') {
    // saved poses: this project's (kept with its scene) and everyone's (in every project)
    const lists = [['project', 'This project', () => SC.poses || [], (l) => { SC.poses = l; save(); }],
      ['all', 'All projects', () => store.get(MINE, []), (l) => store.set(MINE, l)]];
    const mineTile = ([, , get, put], p) => tile(p.name, thumb(`mine:${p.id}`, [{ j: p.j, m: p.m }]), () => takePose(o, p.j, { m: p.m, name: `mine:${p.name}` }),
      iconBtn(`Delete ${p.name}`, '✕', () => {
        put(get().filter((x) => x.id !== p.id)); renderPanel();
        const ok = sameTab();
        undoToast(`${p.name} deleted`, () => { if (ok()) { put([...get(), p]); renderPanel(); } });
      }, { class: 'icon-btn del' }));
    let where = 'project';
    tiles = [
      tile('Save this pose', h('span', { class: 'pose-add' }, '+'), () => nameSheet({ title: 'Save this pose', placeholder: 'Name',
        extra: field('Keep it in', seg([['project', 'This project'], ['all', 'All projects']], where, (v) => { where = v; })),
        save: (name) => {
          if (!name) throw new Error('Give it a name');
          const v = cur(), [, , get, put] = lists.find(([k]) => k === where);
          put([...get(), { id: uid(), name, j: v.j, m: v.m || {} }]); renderPanel();
        } })),
      ...lists.flatMap((l) => (l[2]().length ? [h('div', { class: 'grid-label' }, l[1]), ...l[2]().map((p) => mineTile(l, p))] : []))];
  } else {
    tiles = FIGURE.presetList(cat).map(([k, l]) => tile(l, thumb(k, [{ j: FIGURE.preset(k).j }]), () => takePose(o, FIGURE.preset(k).j, { name: k })));
  }
  return [
    h('div', { class: 'cat-row' }, cats.map(([k, l]) => h('button', { type: 'button', class: 'chip' + (k === cat ? ' on' : ''),
      onclick: () => { R.poseCat = k; store.set('deck.scene.posecat', k); renderPanel(); } }, l))),
    cat === 'pairs' ? hint('Poses this figure and the nearest other posable person together (adds one if there is none).')
      : field('Apply to', seg([['all', 'Whole body'], ['upper', 'Upper'], ['lower', 'Lower']], R.mask, (v) => { R.mask = v; })),
    h('div', { class: 'pose-grid' }, tiles),
    h('div', { class: 'row wrap' },
      button('⇋ Mirror', () => takePose(o, FIGURE.mirrorPose(cur().j), { m: FIGURE.mirrorParams(cur().m), name: cur().pn, mask: 'all' }), { title: 'Swap left and right' }),
      button('Copy pose', () => { const v = cur(); clip = { j: v.j, m: v.m, pn: v.pn }; toast('Pose copied: paste it on any figure'); renderPanel(); }),
      clip ? button('Paste pose', () => takePose(o, clip.j, { m: clip.m, name: clip.pn })) : null,
      button('Reset', () => takePose(o, FIGURE.preset('stand').j, { m: {}, name: 'stand', mask: 'all' }))),
  ];
}

// parameters: tap one on, slide it; tap it again for off
export function adjustTab(o, cur) {
  const groups = [...new Set(Object.values(FIGURE.PARAMS).map((p) => p.group))].filter(Boolean);
  const setM = (m) => write(o, FIG, { m });
  return [
    ...groups.map((g) => {
      const keys = Object.entries(FIGURE.PARAMS).filter(([, p]) => p.group === g);  // (the step phase has no chip)
      const on = keys.filter(([k]) => cur().m?.[k]);
      return field(g,
        g === 'Cycle' ? hint('A walk or run in place: move the figure with keys and its steps follow, or set the step by hand.') : null,
        h('div', { class: 'chips' }, keys.map(([k, p]) => h('button', { type: 'button', class: 'chip' + (cur().m?.[k] ? ' on' : ''), 'aria-pressed': !!cur().m?.[k],
          onclick: () => {
            const m = { ...cur().m };
            if (m[k]) delete m[k]; else m[k] = p.on;
            setM(m); changed();
          } }, p.label))),
        on.map(([k, p]) => slider(p.label, () => cur().m?.[k] || 0, (v) => setM({ ...cur().m, [k]: v || 0.001 }),
          { min: p.min, max: p.max, step: 1, fmt: (v) => `${Math.round(v)}${p.unit || '°'}` })),
        g === 'Cycle' && on.length ? [
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: o.stepsFollow !== false,
            onchange: (e) => { o.stepsFollow = e.target.checked; changed(); } }), 'Steps follow movement (feet don\'t slide)'),
          o.stepsFollow === false ? slider('Step', () => cur().m?.phase || 0, (v) => setM({ ...cur().m, phase: v }),
            { min: 0, max: 8, step: 0.01, fmt: (v) => `${v.toFixed(2)} strides` }) : null,
          o.stepsFollow === false ? hint('Key Step 0 here and 6 later for six strides on the spot.') : null] : null);
    }),
    h('div', { class: 'row wrap' }, Object.keys(cur().m || {}).length ? button('All off', () => { setM({}); changed(); }) : null),
    hint('These sit on top of the pose, so a new pose keeps them. With keys they are keyed with the pose and blend between keys.'),
  ];
}

// a move: keys from the playhead on, starting from the pose it's in now (one undo)
function runMove(o, key) {
  const v = current(o, FIG), f0 = R.f, n = frames(), k = R.speed;
  const avail = (n - 1 - f0) / FPS / k;
  if (avail < 0.3) return toast('Move the playhead back: there\'s no time left for a move', true);
  const steps = FIGURE.moveSteps(key, avail, R.inPlace);
  if (!steps.length) return toast('Not enough time left for that move: move the playhead back', true);
  const before = clone(o), ok = sameTab();
  const at = (st) => Math.min(n - 1, f0 + Math.max(1, Math.round(st.t * k * FPS)));
  const last = at(steps[steps.length - 1]), r = THREE.MathUtils.degToRad(v.ry);
  if (FIGURE.moveKind(key) === 'spot' || (R.inPlace && FIGURE.moveKind(key) === 'travel')) o.stepsFollow = false;
  else if (FIGURE.moveKind(key) === 'travel') o.stepsFollow = true;
  addKey(o, FIG, { ...v, m: { ...v.m } });
  o.keys = o.keys.filter((x) => x.f <= f0 || x.f > last);
  for (const st of steps) {
    const f = at(st), j = st.j || v.j, m = { ...v.m, ...st.m }, d = (st.d || 0) * v.sy;
    if (st.phase != null) m.phase = (v.m?.phase || 0) + st.phase;
    const y = v.y + (o.ground ? 0 : (FIGURE.liftFor(j, m) - FIGURE.liftFor(v.j, v.m)) * v.sy) + (st.y || 0) * v.sy;
    const key = { ...v, f, j, m, pn: st.pn || v.pn, y, ry: v.ry + (st.ry || 0), x: v.x + d * Math.sin(r), z: v.z + d * Math.cos(r) };
    if (st.ease) key.ease = st.ease;
    o.keys = o.keys.filter((x) => x.f !== f);
    o.keys.push(key);
  }
  o.keys.sort((a, b) => a.f - b.f);
  changed();
  undoToast(`${FIGURE.moveList().find(([x]) => x === key)[1]}: keys to ${(last / FPS).toFixed(1)} s`, () => {
    if (!ok()) return;
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, before); changed();
  });
}

// keys a step later: a key here and the same pose further on, to change into the next pose
function nextKey(o, secs) {
  const f = Math.min(frames() - 1, R.f + Math.round(secs * FPS));
  if (f === R.f) return toast('At the end of the clip', true);
  addKey(o, FIG); seek(f); addKey(o, FIG); changed();
}

export function movesTab(o, cur) {
  if (THUMBS.size > 400) THUMBS.clear();
  const strip = o.keys.map((k) => h('button', { type: 'button', class: 'key-card' + (k.f === R.f ? ' on' : ''), onclick: () => seek(k.f) },
    thumb(`k:${JSON.stringify([k.j, k.m])}`, [{ j: k.j, m: k.m }]), h('span', {}, `${(k.f / FPS).toFixed(1)} s`)));
  return [
    field('Keys', strip.length ? h('div', { class: 'key-strip' }, strip) : hint('No keys yet: a move adds them, or ◆ Key.')),
    field('Next key in', h('div', { class: 'row' }, [0.5, 1, 2].map((t) => button(`+${t} s`, () => nextKey(o, t), { title: `A key here and one ${t} s on, ready for the next pose` })))),
    h('div', { class: 'row' },
      field('Speed', seg(SPEEDS, R.speed, (v) => { R.speed = v; })),
      field('Walk and run', seg([[false, 'Go forward'], [true, 'On the spot']], R.inPlace, (v) => { R.inPlace = v; }))),
    h('div', { class: 'pose-grid moves' }, FIGURE.moveList().map(([k, l, icon]) => tile(l, h('span', { class: 'move-icon' }, icon), () => runMove(o, k)))),
    hint('A move starts at the playhead from the pose the figure is in, and replaces the keys it covers. Undo takes it back.'),
  ];
}

// the joints as a body map (seen from the front), and the picked joint's turns as sliders
const BODY = [['head', 1, 3, 'Head'], ['neck', 2, 3, 'Neck'], ['chest', 3, 3, 'Chest'], ['spine', 4, 3, 'Waist'], ['hips', 5, 3, 'Hips'],
  ['rsho', 2, 1, 'Shoulder'], ['relb', 3, 1, 'Elbow'], ['rhand', 4, 1, 'Hand'], ['lsho', 2, 5, 'Shoulder'], ['lelb', 3, 5, 'Elbow'], ['lhand', 4, 5, 'Hand'],
  ['rhip', 5, 2, 'Hip'], ['rknee', 6, 2, 'Knee'], ['rfoot', 7, 2, 'Foot'], ['lhip', 5, 4, 'Hip'], ['lknee', 6, 4, 'Knee'], ['lfoot', 7, 4, 'Foot']];
export function jointsTab(o, cur) {
  const n = R.joint, label = n && FIGURE.JOINTS[n][2];
  const order = Object.keys(FIGURE.JOINTS);
  const map = h('div', { class: 'body-map' },
    h('span', { class: 'side', style: 'grid-area:1/1' }, 'Right'), h('span', { class: 'side', style: 'grid-area:1/5' }, 'Left'),
    BODY.map(([k, r, c, l]) => h('button', { type: 'button', class: k === n ? 'on' : '', style: `grid-area:${r}/${c}`, title: FIGURE.JOINTS[k][2],
      onclick: () => selectJoint(k === n ? null : k) }, l)));
  if (!n) return [map, hint('Pick a joint here or tap a blue dot on the figure. Drag a hand or foot and the arm or leg follows.')];
  const e = () => new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(cur().j[n] || [0, 0, 0, 1]));
  const opp = FIGURE.opposite(n);
  const setTurn = (i) => (deg) => {
    const a = e().toArray().slice(0, 3);
    a[i] = THREE.MathUtils.degToRad(deg);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...a)).toArray(), j = { ...cur().j, [n]: q };
    if (R.sym && opp) j[opp] = FIGURE.mirrorQ(q);
    write(o, FIG, { j });
  };
  const turn = (l, i) => slider(l, () => THREE.MathUtils.radToDeg(e().toArray()[i]), setTurn(i), { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` });
  const step = (d) => selectJoint(order[(order.indexOf(n) + d + order.length) % order.length]);
  return [
    map,
    h('div', { class: 'row joint-head' }, iconBtn('Previous joint', '◀', () => step(-1)), h('b', { class: 'grow' }, label), iconBtn('Next joint', '▶', () => step(1))),
    turn('Bend', 0), turn('Twist', 1), turn('Side', 2),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: R.sym, onchange: (ev) => { R.sym = ev.target.checked; } }), 'Mirror edits to the other side'),
    h('div', { class: 'row wrap' },
      button('Reset joint', () => { const j = { ...cur().j }; delete j[n]; if (R.sym && opp) delete j[opp]; write(o, FIG, { j }); changed(); }),
      opp ? button('Copy to other side', () => { const j = { ...cur().j }; if (j[n]) j[opp] = FIGURE.mirrorQ(j[n]); else delete j[opp]; write(o, FIG, { j }); changed(); }) : null,
      button('Pivot here', () => { o.pivot = n; changed(); }, { title: 'The gizmo turns the whole figure around this joint' }),
      button('Done', () => selectJoint(null))),
    hint(`${FIGURE.IK[n] ? 'Move drags the limb (the elbow or knee follows), Rotate turns it.' : 'Rotate turns it.'} Tap the body (or Esc) for the whole figure.`),
  ];
}

// ---- a prompt from the poses: who does what, in order, as H3's <Subject N> (or the figures' names)
function promptItems() {
  const figs = SC.objects.filter((o) => o.type === 'figure' && !o.hidden);
  const tag = (o) => (R.promptNames ? o.name : `<Subject ${figs.indexOf(o) + 1}>`);
  const items = [];
  for (const o of figs) {
    const states = o.keys.length ? o.keys : [o.base];
    let last = null, said = new Set();  // params already said for this figure: only changes are worth a word
    for (const k of states) {
      const words = [];
      const pn = k.pn || '';
      let text;
      if (pn.startsWith('partner:')) continue;  // said with the one it's paired with
      if (pn.startsWith('pair:')) {
        const [, key, bid] = pn.split(':'), b = figs.find((x) => x.id === bid);
        text = b ? FIGURE.pairSay(key, tag(o), tag(b)) : '';
      } else {
        words.push(pn.startsWith('mine:') ? `in the pose "${pn.slice(5)}"` : FIGURE.say(pn));
        const ps = FIGURE.sayParams(k.m);
        words.push(...ps.filter((w) => !said.has(w)));
        said = new Set(ps);
        text = [...new Set(words.filter(Boolean))].join(', ');
      }
      if (!text || text === last) continue;
      last = text;
      items.push({ id: `${o.id}:${text}`, o, pair: pn.startsWith('pair:'), text, tag: tag(o) });
    }
  }
  return items;
}
function promptText(items) {
  const out = [];
  let cur = null;
  for (const it of items.filter((x) => !R.promptOff.has(x.id))) {
    if (it.pair) { cur = null; out.push(`${it.text[0].toUpperCase()}${it.text.slice(1)}.`); continue; }
    if (cur && cur.o === it.o) cur.parts.push(it.text);
    else { cur = { o: it.o, tag: it.tag, parts: [it.text] }; out.push(cur); }
  }
  return out.map((c) => (typeof c === 'string' ? c : `${c.tag} is ${c.parts.join(', then ')}.`)).join(' ');
}
export function promptProps() {
  const items = promptItems();
  if (!items.length) return null;
  const text = promptText(items);
  return section('Prompt from the poses', null,
    h('div', { class: 'chips' }, items.map((it) => {
      const off = R.promptOff.has(it.id);
      return h('button', { type: 'button', class: 'chip prompt-chip' + (off ? ' off' : ''), title: off ? 'Put it back' : 'Leave it out',
        onclick: () => { if (off) R.promptOff.delete(it.id); else R.promptOff.add(it.id); renderPanel(); } },
      `${it.pair ? '' : `${it.tag}: `}${it.text}`, h('span', { class: 'x' }, off ? '＋' : '✕'));
    })),
    h('p', { class: 'prompt-out' }, text || '—'),
    field('Call them', seg([[false, '<Subject 1>, <Subject 2>'], [true, 'Their names']], R.promptNames, (v) => { R.promptNames = v; renderPanel(); })),
    h('div', { class: 'row wrap' },
      button('Copy', async () => {
        try { await navigator.clipboard.writeText(text); toast('Prompt copied'); } catch { toast('Copying isn\'t allowed here: select the text instead', true); }
      }, { disabled: !text }),
      C.addToPrompt ? button('Add to Generate prompt', () => C.addToPrompt(text), { disabled: !text }) : null),
    hint('Tap a pose to leave it out. Keys remember the pose picked from the library or a move, so the order follows the clip.'));
}
