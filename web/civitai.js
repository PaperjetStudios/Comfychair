// Civitai LoRA browser: search civitai.com for LoRAs made for one model family, look at a model's versions and
// pictures, and download one into ComfyUI's LoRA folder for that family (app/civitai.py). Opens as a wide sheet.
// openCivitai({ family, folders, onAdd, onWord, onDownloaded }):
//   family: the LoRA folder to start on (h3, krea, ltx2.5…); folders: the folders to offer as chips
//   onAdd({ name, trainedWords }): "Add to the stack" (name is the ComfyUI LoRA name, "<folder>/<file>")
//   onWord(word): a trigger word tapped; onDownloaded(result): after a download, before the sheet shows Add
// The Generate LoRA stack uses it; VFX's restyle and Story's refine LoRAs can call it the same way.
import { api, button, chip, chips, closeSheet, field, h, help, icon, iconBtn, linkBtn, note, openSheet, placeholder, seg,
  store, toast } from './ui.js';
import { waitJob } from './clipimport.js';
import { PREFS } from './prefs.js';

const SORTS = [['rated', 'Highest rated'], ['downloads', 'Most downloaded'], ['newest', 'Newest']];
// the NSFW setting -> the highest image level shown clearly (Civitai: 1 PG, 2 PG-13, 4 R, 8 X, 16 XXX)
const CLEAR = { off: 1, soft: 2, all: Infinity };
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n || 0));
const fmtKB = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`);

// replaceChildren() would write a null out as the word "null"
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

let FAMILIES = null;   // {folder: {bases, more}} from the server, once
const families = async () => (FAMILIES ||= await api('/api/civitai/families').catch(() => ({})));

export async function openCivitai({ family = null, folders = [], onAdd = null, onWord = null, onDownloaded = null } = {}) {
  const fams = await families();
  const nsfw = PREFS.civitaiNsfw || 'soft';
  const clear = CLEAR[nsfw] ?? 2;
  const st = {
    family: family || store.get('deck.civitai.family', '') || folders[0] || 'krea',
    q: '', sort: store.get('deck.civitai.sort', 'rated'), bases: null, cursor: null, done: false, loading: false, seq: 0,
  };
  const famList = [...new Set([...folders, ...Object.keys(fams)])].filter((f) => folders.includes(f) || !['flux', 'wan', 'ltx'].includes(f));
  const root = h('div', { class: 'civitai' });
  const listView = h('div', { class: 'civ-list' });
  const detailView = h('div', { class: 'civ-detail hidden' });
  const grid = h('div', { class: 'grid civ-grid' });
  const more = h('div', { class: 'civ-more' });
  const baseRow = h('div', { class: 'chips civ-bases' });

  const search = h('input', { type: 'search', placeholder: 'Search Civitai', 'aria-label': 'Search Civitai', enterkeyhint: 'search' });
  let typing = 0;
  search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { st.q = search.value.trim(); reset(); }, 450); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(typing); st.q = search.value.trim(); reset(); search.blur(); } });

  const famChips = chips(famList.map((f) => [f, f]), st.family, (f) => {
    st.family = f; st.bases = null; store.set('deck.civitai.family', f); drawBases(); reset();
  }, { cls: 'folder-chips' });
  const sortSeg = seg(SORTS, st.sort, (v) => { st.sort = v; store.set('deck.civitai.sort', v); reset(); }, { wrap: true });

  // the family's Civitai base models: its usual ones on, related ones off (tap to switch)
  function drawBases() {
    const fb = fams[st.family] || { bases: [], more: [] };
    st.bases ??= [...fb.bases];
    const all = [...fb.bases, ...fb.more];
    baseRow.replaceChildren(...all.map((b) => chip(b, () => {
      st.bases = st.bases.includes(b) ? st.bases.filter((x) => x !== b) : [...st.bases, b];
      if (!st.bases.length) st.bases = [b];
      drawBases(); reset();
    }, { on: st.bases.includes(b), title: 'Civitai base model' })));
    baseRow.classList.toggle('hidden', !all.length);
  }

  function reset() {
    st.cursor = null; st.done = false; st.seq++; st.loading = false;
    grid.replaceChildren();
    more.replaceChildren();
    load();
  }

  async function load() {
    if (st.loading || st.done) return;
    st.loading = true;
    const seq = st.seq;
    more.replaceChildren(placeholder('Loading…'));
    const p = new URLSearchParams({ family: st.family, sort: st.sort, nsfw, q: st.q });
    if (st.bases?.length) p.set('base', st.bases.join('|'));
    if (st.cursor) p.set('cursor', st.cursor);
    let r;
    try { r = await api(`/api/civitai/search?${p}`, { timeout: 45000 }); } catch (e) {
      if (seq !== st.seq) return;
      st.loading = false;
      more.replaceChildren(note(e.message, 'err'), button('Try again', load));
      return;
    }
    if (seq !== st.seq) return;
    st.loading = false;
    st.cursor = r.next || null;
    st.done = !r.next || !r.items.length;
    grid.append(...r.items.map(card));
    put(more, st.done && !grid.children.length ? placeholder('Nothing found') : null);
    if (!st.done) requestAnimationFrame(() => { if (inView(sentinel)) load(); });   // the page doesn't fill the sheet yet
  }

  // a picture, blurred when its level is above the NSFW setting (a tap in the detail view shows it)
  const thumb = (img, cls = '') => {
    if (!img) return h('div', { class: 'civ-noimg' }, icon('image'));
    const el = h('img', { src: img.thumb, loading: 'lazy', alt: '', class: cls, draggable: false });
    if (img.nsfwLevel > clear) el.classList.add('civ-blur');
    return el;
  };
  const firstImage = (m) => {
    const imgs = m.versions.flatMap((v) => v.images);
    return imgs.find((i) => i.nsfwLevel <= clear) || imgs[0];
  };

  function card(m) {
    const v = m.versions[0];
    const got = m.versions.some((x) => x.downloaded);
    return h('button', { type: 'button', class: 'card civ-card', onclick: () => openDetail(m) },
      h('div', { class: 'media' }, thumb(firstImage(m)), got ? h('span', { class: 'civ-got' }, icon('check'), 'Downloaded') : null,
        v.earlyAccess ? h('span', { class: 'civ-early' }, 'Early access') : null),
      h('div', { class: 'civ-meta' },
        h('div', { class: 'name' }, m.name),
        h('div', { class: 'hint' }, m.creator || ''),
        h('div', { class: 'civ-row' }, h('span', { class: 'badge' }, v.baseModel || ''),
          h('span', { class: 'hint', title: 'Downloads' }, icon('download'), fmtCount(m.stats.downloads)))));
  }

  // ---- one model ----
  async function openDetail(m0) {
    listView.classList.add('hidden');
    detailView.classList.remove('hidden');
    const top = sheet().scrollTop;
    const back = () => { detailView.classList.add('hidden'); detailView.replaceChildren(); listView.classList.remove('hidden'); sheet().scrollTop = top; };
    detailView.replaceChildren(h('div', { class: 'row civ-head' }, iconBtn('Back to the list', '◀', back, { class: 'icon-btn fixed' }), h('strong', {}, m0.name)), placeholder('Loading…'));
    sheet().scrollTop = 0;
    let m = m0;
    try {
      const p = new URLSearchParams({ family: st.family });
      if (st.bases?.length) p.set('base', st.bases.join('|'));
      m = { ...m0, ...(await api(`/api/civitai/model/${m0.id}?${p}`, { timeout: 45000 })) };
    } catch { /* the card's own data will do */ }
    if (detailView.classList.contains('hidden')) return;
    if (!m.versions?.length) m.versions = m0.versions;
    let vi = 0, fileId = null, busy = false;
    const body = h('div', { class: 'civ-body' });
    const draw = () => {
      const v = m.versions[vi];
      const files = v.files.filter((f) => f.safetensors);
      fileId = files.find((f) => f.id === fileId) ? fileId : (files.find((f) => f.primary) || files[0])?.id ?? null;
      const f = files.find((x) => x.id === fileId);
      const words = (v.trainedWords || []).filter(Boolean);
      const wordChips = (cls = '') => words.length ? field(['Trigger words', h('span', {}, onWord ? 'tap to add to the prompt' : '')],
        h('div', { class: `chips ${cls}`.trim() }, words.map((w) => chip(w, (e) => { onWord?.(w); e.currentTarget.classList.add('added'); },
          { title: onWord ? 'Add to the prompt' : w })))) : null;
      const bar = h('div', { class: 'clip-progress hidden' }, h('div', { class: 'clip-progress-fill' }), h('span', { class: 'hint' }));
      const after = h('div', { class: 'civ-after' });
      const showAdd = (name, ws) => put(after,
        onAdd ? button('＋ Add to the stack', () => {
          const added = onAdd({ name, trainedWords: ws }) !== false;
          toast(added ? `Added ${name.split('/').pop()} to the LoRA stack` : 'It is already in the LoRA stack');
        }, { cls: 'primary' }) : null,
        h('span', { class: 'hint' }, name));
      const dl = button('⤓ Download', () => start(false), { cls: 'primary' });
      const start = async (confirmBig) => {
        if (busy || !f) return;
        busy = true; dl.disabled = true;
        const prog = (p, label) => {
          bar.classList.remove('hidden');
          bar.firstChild.style.width = `${Math.round((p || 0) * 100)}%`;
          bar.lastChild.textContent = `${label || 'Downloading'}… ${Math.round((p || 0) * 100)}%`;
        };
        prog(0);
        try {
          const job = await api('/api/civitai/download', { method: 'POST', body: { versionId: v.id, fileId: f.id, family: st.family, confirm: confirmBig }, busy: false });
          const r = await waitJob(job, prog);   // (it carries on if the sheet is closed)
          v.downloaded = r.name;
          bar.classList.add('hidden');
          toast(r.skipped ? `${r.file} was already in ${r.family}/` : `Downloaded ${r.file} to ${r.family}/`);
          await onDownloaded?.(r);
          draw();
        } catch (e) {
          bar.classList.add('hidden');
          if (e.data?.needsConfirm && confirm(e.data.message)) { busy = false; return start(true); }
          toast(e.message, true);
        } finally { busy = false; dl.disabled = false; }
      };
      if (v.downloaded) showAdd(v.downloaded, words);
      const imgs = v.images || [];
      put(body,
        m.versions.length > 1 ? field('Version', chips(m.versions.map((x, i) => [i, `${x.name}${x.downloaded ? ' · downloaded' : ''}`]), vi, (i) => { vi = Number(i); draw(); }, { cls: 'civ-versions' })) : null,
        imgs.length ? h('div', { class: 'civ-carousel' }, imgs.map((img) => {
          const el = img.type === 'video'
            ? h('video', { src: img.url, poster: img.thumb, muted: true, loop: true, playsInline: true, autoplay: img.nsfwLevel <= clear, preload: 'none' })
            : h('img', { src: img.url, loading: 'lazy', alt: '', draggable: false });
          const hidden = img.nsfwLevel > clear;
          const wrap = h('div', { class: 'civ-shot' + (hidden ? ' civ-blur' : ''), style: img.w && img.h ? `aspect-ratio:${img.w}/${img.h}` : '' }, el);
          if (hidden) wrap.addEventListener('click', () => { wrap.classList.remove('civ-blur'); if (el.tagName === 'VIDEO') el.play().catch(() => {}); }, { once: true });
          return wrap;
        })) : null,
        h('table', { class: 'params' },
          h('tr', {}, h('td', {}, 'Base model'), h('td', {}, v.baseModel || '')),
          m.creator ? h('tr', {}, h('td', {}, 'Creator'), h('td', {}, m.creator)) : null,
          h('tr', {}, h('td', {}, 'Downloads'), h('td', {}, fmtCount(m.stats?.downloads))),
          f ? h('tr', {}, h('td', {}, 'File'), h('td', {}, `${f.name} · ${fmtKB(f.sizeKB)}`)) : null,
          h('tr', {}, h('td', {}, 'Saved to'), h('td', {}, `loras/${st.family}/`))),
        files.length > 1 ? field('File', seg(files.map((x) => [x.id, `${x.name.replace(/\.safetensors$/i, '')} · ${fmtKB(x.sizeKB)}`]), fileId,
          (id) => { fileId = Number(id); draw(); }, { wrap: true })) : null,
        wordChips(),
        !files.length ? note('This version has no .safetensors file, so it can\'t be downloaded here.') : null,
        v.earlyAccess ? note('Early access: Civitai only lets buyers download this version for now.') : null,
        h('div', { class: 'actions civ-actions' }, v.downloaded ? null : dl, linkBtn('↗ Civitai', `${m.link}?modelVersionId=${v.id}`, { target: '_blank', rel: 'noopener' })),
        bar, after,
        m.description ? h('details', { class: 'desc' }, h('summary', {}, 'Description'),
          h('div', { class: 'hint pre' }, new DOMParser().parseFromString(m.description, 'text/html').body.textContent.trim())) : null);
    };
    detailView.replaceChildren(h('div', { class: 'row civ-head' }, iconBtn('Back to the list', '◀', back, { class: 'icon-btn fixed' }), h('strong', {}, m.name)), body);
    draw();
  }

  const sheet = () => root.closest('.sheet') || document.scrollingElement;
  const sentinel = h('div', { class: 'civ-sentinel' });
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight + 400 && r.bottom > 0 && el.isConnected && !listView.classList.contains('hidden'); };
  const io = new IntersectionObserver((es) => {
    if (!root.isConnected) return io.disconnect();   // another sheet took its place
    if (es.some((e) => e.isIntersecting) && !listView.classList.contains('hidden')) load();
  }, { rootMargin: '400px' });

  listView.append(h('div', { class: 'civ-controls' }, search, sortSeg), famChips, baseRow, grid, more, sentinel);
  root.append(listView, detailView);
  openSheet(h('h3', {}, icon('download'), 'LoRAs from Civitai'),
    help('LoRAs made for the chosen model family on civitai.com. Tap one for its versions, pictures and trigger words, then Download: it goes into ComfyUI\'s LoRA folder for that family (models/loras/<family>/) and then shows in the LoRA lists. Most LoRAs download without an account; some need a Civitai API key (Settings). Pictures above the NSFW level chosen in Settings are blurred.'),
    root);
  io.observe(sentinel);
  drawBases();
  load();
  return { close: closeSheet };
}
