// The rules of making a 3D object and of the Add list, with no DOM, so tests/object_rules.test.mjs can load them. scene-import.js draws
// the object panel, scene-ui.js the Add sheet.
//   OBJECT_MODELS            model id → { label, many }: many takes up to the four views together, the others one picture
//   usedViews(picks, model, sel)  the views this model reads, in order. sel: what is selected, { off: [views left out], one: the view a
//                            one-picture model reads }. A one-picture model with none chosen, or a gone one: the first filled.
//   tapView(sel, model, view) → sel after a filled picture is tapped: a one-picture model reads that one; else it goes in or out of the run
//   addPictures(picks, names) → { picks, left }: names into the empty views in order; left: those with no room, or already attached
//   planRun(picks, model, sel) → { kind: 'multi' | 'single' | 'splat' | null, views }: which run the attached pictures make
//   addGroups(types, { room, attached })  the Add list: [{ title, items: [{ id, label, icon, tip?, body? }] }]
//   filterGroups(groups, q)  those matching what was typed; a group's name matches all of it
export const VIEWS = ['Front', 'Left', 'Back', 'Right'];
export const OBJECT_MODELS = {
  pixal: { label: 'Pixal3D', many: true },
  trellis: { label: 'TRELLIS.2', many: false },
  idol: { label: 'Idol (splat)', many: false },
};

export function usedViews(picks, model, { off = [], one = null } = {}) {
  const filled = VIEWS.filter((v) => picks?.[v]);
  if (OBJECT_MODELS[model]?.many) return filled.filter((v) => !off.includes(v));
  return one && filled.includes(one) ? [one] : filled.slice(0, 1);
}

export function tapView({ off = [], one = null } = {}, model, view) {
  if (!OBJECT_MODELS[model]?.many) return { off, one: view };
  return { off: off.includes(view) ? off.filter((v) => v !== view) : [...off, view], one };
}

export function addPictures(picks, names) {
  const out = { ...picks }, left = [];
  for (const name of names) {
    const free = VIEWS.find((v) => !out[v]);
    if (!name || Object.values(out).includes(name) || !free) { if (name) left.push(name); continue; }
    out[free] = name;
  }
  return { picks: out, left };
}

export function planRun(picks, model, sel) {
  const views = usedViews(picks, model, sel);
  if (!views.length) return { kind: null, views };
  if (model === 'idol') return { kind: 'splat', views };
  return { kind: views.length > 1 ? 'multi' : 'single', views };
}

const GROUP_OF = { box: 'Shapes', ball: 'Shapes', cylinder: 'Shapes', wall: 'Shapes', person: 'People', child: 'People', figure: 'People',
  rigged: 'Rigs', skinned: 'Rigs' };
const ORDER = ['From pictures', 'People', 'Shapes', 'Rigs', 'Other'];

export function addGroups(types, { room = false, attached = 0, bodies = [] } = {}) {
  const groups = Object.fromEntries(ORDER.map((title) => [title, []]));
  for (const [t, d] of Object.entries(types)) {
    if (d.hide || ['photo', 'model', 'splat'].includes(t)) continue;
    const list = groups[GROUP_OF[t] || 'Other'];
    if (t === 'figure') for (const [body, word] of bodies) list.push({ id: t, body, icon: d.icon, label: `${d.label} (${word.toLowerCase()})` });
    else list.push({ id: t, icon: d.icon, label: d.label });
  }
  if (!room) groups.Shapes.push({ id: 'room', icon: '⌂', label: 'Room' });
  groups['From pictures'].push(
    { id: 'object', icon: '🧊', label: `3D object from pictures…${attached ? ` (${attached} attached)` : ''}`, tip: 'A textured model or a splat, from one picture or up to four views' },
    { id: 'photo3d', icon: '🖼', label: 'Photo in 3D…', tip: 'Turn a picture into a 3D mesh (MoGe in ComfyUI) for camera moves' },
    { id: 'sharp', icon: '☁', label: 'Photo as a splat (SHARP)…', tip: 'Turn a picture into Gaussian splats (Apple SHARP): softer and more lifelike than the mesh, for small camera moves' },
    { id: 'background', icon: '🖼', label: 'Picture as background…', tip: 'A flat plane with the picture\'s own shape, behind everything, filling the shot camera\'s frame' });
  return ORDER.filter((title) => groups[title].length).map((title) => ({ title, items: groups[title] }));
}

export function filterGroups(groups, q) {
  const want = String(q || '').trim().toLowerCase();
  if (!want) return groups;
  return groups.map((g) => (g.title.toLowerCase().includes(want) ? g : { ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(want)) }))
    .filter((g) => g.items.length);
}
