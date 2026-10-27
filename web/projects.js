// Settings → Projects: every project with its size on disk and number of generations; drag the grip (or ↑/↓)
// to change the order the picker shows; rename, duplicate (a background copy, with progress) and delete
// (asks first, naming the project and its size, and wants the name typed). The server tells every device
// about each change (deck_projects), so the list and #projectSel stay in step everywhere.
import { h, api, toast, openSheet, closeSheet, button, iconBtn, section, help, note, actions } from './ui.js';
import { S, loadProjects, onServer, openProject } from './core.js';

const P = { list: null, stats: {}, jobs: new Map(), drag: null, back: null };

export const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i && n / 1024 ** i < 10 ? 1 : 0)} ${u[i]}`;
};

// the section for the settings sheet; back() reopens the settings sheet (after a confirm step)
export function projectsSection(back) {
  P.back = back;
  P.list = h('div', { class: 'proj-list', role: 'list' });
  draw();
  refresh();
  return section('Projects', null,
    help('Drag ⠿ (or use ↑ ↓) to change the order of the project picker. ✎ renames (the folder on disk keeps its name). ⧉ makes a copy with all its files, saved tabs and history; a big project takes a while and you can keep working. 🗑 deletes a project, its history and its files on disk for good.'),
    P.list);
}

async function refresh() {
  try {
    const [stats, jobs] = await Promise.all([api('/api/projects/stats'), api('/api/projects/jobs')]);
    P.stats = stats;
    P.jobs = new Map(jobs.filter((j) => j.state === 'copying').map((j) => [j.dst, j]));
  } catch (e) { toast(e.message, true); }
  draw();
}

const live = () => P.list?.isConnected;
onServer('deck_projects', async () => { if (!live()) return; await loadProjects(); refresh(); });
onServer('deck_project_job', (m) => {
  const j = m.data;
  if (j.state === 'copying') P.jobs.set(j.dst, j); else P.jobs.delete(j.dst);
  if (j.state === 'error' && live()) toast(`Copy of the project failed: ${j.error}`, true);
  if (!live()) return;
  const hint = P.list.querySelector(`[data-pid="${j.dst}"] .hint`);
  if (hint && j.state === 'copying') hint.textContent = copyText(j); else refresh();
});

const copyText = (j) => `Copying… ${j.total ? Math.round(100 * j.done / j.total) : 0}% of ${fmtBytes(j.total)}`;
function info(p) {
  if (P.jobs.has(p.id)) return copyText(P.jobs.get(p.id));
  const s = P.stats[p.id];
  if (!s) return '…';
  return `${fmtBytes(s.bytes)} · ${s.generations} generation${s.generations === 1 ? '' : 's'}`;
}

function draw() {
  if (!P.list || P.drag) return;
  const n = S.projects.length;
  P.list.replaceChildren(...S.projects.map((p, i) => {
    const copying = P.jobs.has(p.id);
    const grip = h('span', { class: 'proj-grip', 'aria-label': `Drag to move ${p.name}`, title: 'Drag to reorder' }, '⠿');
    grip.addEventListener('pointerdown', (e) => dragStart(e, i));
    return h('div', { class: 'proj-row' + (p.id === S.project ? ' sel' : ''), role: 'listitem', 'data-pid': p.id },
      grip,
      h('div', { class: 'layer-name' },
        h('span', { class: 'proj-name' }, p.name, p.id === S.project ? h('span', { class: 'hint' }, ' · open here') : null),
        h('span', { class: 'hint' }, info(p))),
      h('div', { class: 'layer-btns' },
        iconBtn('Move up', '↑', () => move(i, i - 1), { disabled: i === 0 }),
        iconBtn('Move down', '↓', () => move(i, i + 1), { disabled: i === n - 1 }),
        p.id === S.project ? null : iconBtn(`Open ${p.name}`, '↗', () => openProject(p.id).then(draw)),
        iconBtn(`Rename ${p.name}`, '✎', (e) => rename(p, e.currentTarget.closest('.proj-row'))),
        iconBtn(`Duplicate ${p.name}`, '⧉', () => duplicate(p), { disabled: copying }),
        iconBtn(`Delete ${p.name}`, '🗑', () => confirmDelete(p), { disabled: copying || n <= 1, class: 'icon-btn danger' })));
  }));
}

async function saveOrder(ids) {
  const byId = new Map(S.projects.map((p) => [p.id, p]));
  S.projects = ids.map((i) => byId.get(i));
  draw();
  try { await api('/api/projects/order', { method: 'POST', body: { ids }, busy: false }); }
  catch (e) { toast(`Couldn't save the order: ${e.message}`, true); }
  await loadProjects(); draw();
}
function move(from, to) {
  if (to < 0 || to >= S.projects.length || from === to) return;
  const ids = S.projects.map((p) => p.id);
  const [m] = ids.splice(from, 1);
  ids.splice(to, 0, m);
  saveOrder(ids);
}

// Drag the grip: the row follows the finger or pen (pointer capture on the grip), the others slide out
// of its way, and the new order is saved on release. Rows stay put in the DOM while dragging (moving
// them would drop the capture).
function dragStart(e, from) {
  if (e.button > 0 || P.drag) return;
  e.preventDefault();
  const grip = e.currentTarget, rows = [...P.list.children];
  const tops = rows.map((r) => r.offsetTop), hts = rows.map((r) => r.offsetHeight);
  const gap = rows.length > 1 ? tops[1] - tops[0] - hts[0] : 0;
  const d = P.drag = { pid: e.pointerId, y0: e.clientY, from, to: from };
  try { grip.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
  rows.forEach((r) => r.classList.add('shifting'));
  rows[from].classList.add('lift');
  const moveFn = (ev) => {
    if (ev.pointerId !== d.pid) return;
    ev.preventDefault();
    const dy = ev.clientY - d.y0, centre = tops[from] + hts[from] / 2 + dy;
    let to = 0;
    tops.forEach((t, i) => { if (i !== from && t + hts[i] / 2 < centre) to++; });
    d.to = to;
    const shift = hts[from] + gap;
    rows.forEach((r, i) => {
      r.style.transform = i === from ? `translateY(${dy}px)`
        : from < to && i > from && i <= to ? `translateY(${-shift}px)`
          : from > to && i >= to && i < from ? `translateY(${shift}px)` : '';
    });
  };
  const up = (ev) => {
    if (ev.pointerId !== d.pid) return;
    grip.removeEventListener('pointermove', moveFn); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    rows.forEach((r) => { r.style.transform = ''; r.classList.remove('shifting', 'lift'); });
    P.drag = null;
    if (ev.type !== 'pointercancel' && d.to !== from) move(from, d.to); else draw();
  };
  grip.addEventListener('pointermove', moveFn);
  grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
}

// rename in place: the name becomes a text box (Enter or leaving it saves, Esc puts it back)
function rename(p, row) {
  const slot = row.querySelector('.proj-name');
  const box = h('input', { type: 'text', value: p.name, maxLength: 120, 'aria-label': 'Project name', class: 'proj-rename' });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = box.value.trim();
    if (save && name && name !== p.name) {
      try { await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name }, busy: false }); await loadProjects(); }
      catch (e) { toast(e.message, true); }
    }
    draw();
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  box.addEventListener('blur', () => finish(true));
  slot.replaceWith(box);
  box.focus(); box.select();
}

async function duplicate(p) {
  try {
    const r = await api(`/api/projects/${p.id}/duplicate`, { method: 'POST', body: {}, busy: 'Starting the copy…' });
    P.jobs.set(r.job.dst, r.job);
    await loadProjects(); draw();
    toast(`Copying "${p.name}" to "${r.project.name}"`);
  } catch (e) { toast(e.message, true); }
}

// The confirm step: names the project, its size and history, says the files go for good, and only
// enables Delete once the name is typed exactly.
function confirmDelete(p) {
  const s = P.stats[p.id] || { bytes: 0, generations: 0 };
  const box = h('input', { type: 'text', placeholder: p.name, autocomplete: 'off', 'aria-label': 'Type the project name to confirm' });
  const go = button('Delete for good', async () => {
    if (box.value.trim() !== p.name.trim()) return;
    const wasOpen = p.id === S.project;
    try {
      await api(`/api/projects/${p.id}?confirm=${encodeURIComponent(p.name)}`, { method: 'DELETE', busy: `Deleting ${p.name}…` });
      toast(`Deleted "${p.name}"`);
      // (the deck_projects message usually got here first and opened another one; this covers a dropped socket)
      const next = S.projects.find((q) => q.id !== p.id);
      if (wasOpen && next) await openProject(next.id); else await loadProjects();
      P.back ? P.back() : closeSheet();
    } catch (e) { toast(e.message, true); }
  }, { cls: 'danger on', disabled: true });
  box.addEventListener('input', () => { go.disabled = box.value.trim() !== p.name.trim(); });
  openSheet(h('h3', {}, `Delete "${p.name}"?`),
    note(`This deletes the project, its ${s.generations} generation${s.generations === 1 ? '' : 's'} and ${fmtBytes(s.bytes)} of files on disk for good: its outputs, saved tabs and scenes. It can't be undone.`, 'err'),
    h('label', { class: 'field' }, h('div', { class: 'lbl' }, h('span', {}, `Type ${p.name} to confirm`)), box),
    actions(button('Cancel', () => (P.back ? P.back() : closeSheet()), { cls: 'ghost' }), go));
  setTimeout(() => box.focus(), 50);
}
