// Import a clip: cut a piece out of an online video (a link), a video file on the PC running ComfyDeck, or
// a file on this device, and save it to the media library (every video picker offers it). The piece is
// chosen with the same player/trim/crop widget as a template's video field (vfield.js), plus marks for
// long videos. Links and PC files are cut by the server (app/clipimport.py). Device files are cut here
// with ffmpeg.wasm as a stream copy (no re-encode, only the needed bytes are read from the file) and only
// that piece is uploaded; the server then re-encodes it from the exact start.
import { api, button, closeSheet, field, fileButton, h, hint, note, openSheet, placeholder, seg, store, toast } from './ui.js';
import { videoEditor } from './vfield.js';

const SIZES = [[0, 'Original'], [1080, '1080p'], [720, '720p'], [480, '480p']];
const FIRST_LEN = 10;   // a new clip starts with its first 10 s chosen
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Poll a server job ({job}) until it ends: resolves its result, rejects with its error.
function waitJob({ job }, onProgress) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      let s;
      try { s = await api(`/api/clip/job/${job}`, { busy: false }); } catch (e) { return reject(e); }
      onProgress?.(s.progress, s.label);
      if (s.state === 'running') return setTimeout(poll, 500);
      return s.state === 'done' ? resolve(s.result) : reject(new Error(s.error || 'Failed'));
    };
    poll();
  });
}

// ffmpeg.wasm, loaded once (its 31 MB core comes from the server, which fetches it from the CDN the first time)
let ffmpegP = null;
function loadFFmpeg() {
  ffmpegP ||= (async () => {
    const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
    const ff = new FFmpeg();
    await ff.load({ coreURL: new URL('/api/clip/wasm/ffmpeg-core.js', location.href).href,
      wasmURL: new URL('/api/clip/wasm/ffmpeg-core.wasm', location.href).href });
    return ff;
  })().catch((e) => { ffmpegP = null; throw e; });
  return ffmpegP;
}

// A stream copy of [start, start+len) from a local File, read in place (WORKERFS) so a large file isn't
// loaded into memory. A .mov keeps an edit list, so the copy starts on the cut, not the keyframe before it.
async function copyPiece(file, start, len, onLog) {
  const ff = await loadFFmpeg();
  const dir = `/in${Date.now()}`;
  await ff.createDir(dir);
  await ff.mount('WORKERFS', { files: [file] }, dir);
  const log = ({ message }) => onLog?.(message);
  ff.on('log', log);
  try {
    const src = `${dir}/${file.name}`;
    const base = ['-ss', start.toFixed(3), '-i', src, '-t', len.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy'];
    // pcm and other sound .mov can't hold is re-encoded (cheap); the picture never is
    for (const audio of [['-c:a', 'copy'], ['-c:a', 'aac', '-b:a', '192k']]) {
      const rc = await ff.exec([...base, ...audio, '-f', 'mov', '/piece.mov']);
      if (rc === 0) {
        const data = await ff.readFile('/piece.mov');
        await ff.deleteFile('/piece.mov');
        return new File([data], `${file.name.replace(/\.[^.]+$/, '')}.mov`, { type: 'video/quicktime' });
      }
    }
    throw new Error("This browser's cutter couldn't read that file");
  } finally {
    ff.off('log', log);
    await ff.unmount(dir).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}

// opts.onSaved(entry): the saved media entry ({name, url, kind, label}); the sheet is closed first
export function openClipImport({ onSaved = null, title = 'Import a clip' } = {}) {
  let tab = store.get('deck.clipImport.tab', 'link');
  let size = store.get('deck.clipImport.size', 0);
  let cut = null;   // { trim, crop } as the editor reports them
  let busy = false;
  const body = h('div', { class: 'clip-import' });
  const tabs = seg([['link', 'Link'], ['pc', 'This PC'], ['device', 'This device']], tab, (t) => {
    if (busy) { tabs.set(tab); return toast('Wait for the clip to finish', true); }
    tab = t; store.set('deck.clipImport.tab', t); show();
  });
  openSheet(h('h3', {}, title), tabs, body);

  const sizeField = () => field('Size', seg(SIZES.map(([v, l]) => [v, l]), size, (v) => { size = Number(v); store.set('deck.clipImport.size', size); }),
    hint('Largest height kept. Original keeps the full picture.'));
  const nameInput = (v) => h('input', { type: 'text', value: v || '', placeholder: 'Name', 'aria-label': 'Clip name' });
  const bar = h('div', { class: 'clip-progress hidden' }, h('div', { class: 'clip-progress-fill' }), h('span', { class: 'hint' }));
  const progress = (p, label) => {
    bar.classList.remove('hidden');
    bar.firstChild.style.width = `${Math.round((p || 0) * 100)}%`;
    bar.lastChild.textContent = `${label || 'Working'}… ${Math.round((p || 0) * 100)}%`;
  };
  const span = (dur) => {
    const t = cut?.trim, start = t ? t.start : 0;
    return { start, end: t && t.len != null ? start + t.len : dur };
  };
  // the editor for one clip; returns its element and keeps `cut` up to date
  const editor = (opts) => {
    cut = { trim: { start: 0, len: Math.min(FIRST_LEN, opts.duration || FIRST_LEN) }, crop: null };
    return videoEditor({ ...opts, trim: cut.trim, crop: null, marks: true, loader: () => ({ rate: 0, mapped: false }),
      onChange: (trim, crop) => { cut = { trim, crop }; } });
  };
  const saveBtn = (run) => {
    const b = button('Save clip', async () => {
      if (busy) return;
      busy = true; b.disabled = true;
      try {
        const entry = await run();
        toast(`Saved ${entry.label} to the media library`);
        closeSheet();
        onSaved?.(entry);
      } catch (e) { toast(e.message, true); bar.classList.add('hidden'); }
      finally { busy = false; b.disabled = false; }
    }, { cls: 'primary' });
    return b;
  };

  // ---- a link ----
  const showLink = () => {
    const url = h('input', { type: 'url', placeholder: 'https://youtube.com/watch?v=… or a Reddit, X, Vimeo link', 'aria-label': 'Video link',
      value: store.get('deck.clipImport.url', '') });
    const out = h('div', {});
    const load = async () => {
      const u = url.value.trim();
      if (!u) return toast('Paste a link first', true);
      store.set('deck.clipImport.url', u);
      out.replaceChildren(placeholder('Reading the link…'));
      let L;
      try { L = await api('/api/clip/link', { method: 'POST', body: { url: u }, busy: false }); }
      catch (e) { return out.replaceChildren(note(e.message, 'err')); }
      if (!L.preview) {
        out.replaceChildren(placeholder('This site only streams in pieces: making a small preview copy…'), bar);
        try { L = await waitJob(await api(`/api/clip/link/${L.id}/preview`, { method: 'POST', busy: false }), progress); }
        catch (e) { return out.replaceChildren(note(e.message, 'err')); }
        bar.classList.add('hidden');
      }
      drawLink(L);
    };
    const drawLink = (L) => {
      const name = nameInput(L.title);
      const top = L.heights.length ? Math.max(...L.heights) : 0;
      out.replaceChildren(
        h('p', { class: 'hint' }, [L.title, L.uploader, fmtDur(L.duration || 0), top ? `up to ${top}p` : null].filter(Boolean).join(' · ')),
        editor({ url: L.preview.video, audio: L.preview.audio, info: Promise.resolve({ duration: L.duration, fps: L.fps }), duration: L.duration }),
        hint('The preview is small; the saved clip is cut from the full-quality video and only that part is downloaded.'),
        sizeField(), field('Name', name), bar,
        h('div', { class: 'actions' }, saveBtn(async () => {
          const { start, end } = span(L.duration);
          return waitJob(await api(`/api/clip/link/${L.id}/cut`, { method: 'POST', busy: false,
            body: { start, end, height: size || null, crop: cut?.crop, name: name.value.trim() || L.title } }), progress);
        })));
    };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    body.replaceChildren(h('div', { class: 'row clip-url' }, url, button('Load', load, { cls: 'small primary' })), out);
  };

  // ---- a file on the PC ----
  const showPc = (path = store.get('deck.clipImport.dir', '')) => {
    const list = h('div', { class: 'clip-files' }, placeholder('Loading…'));
    body.replaceChildren(list);
    api(`/api/clip/browse?path=${encodeURIComponent(path)}`, { busy: false }).then((d) => {
      store.set('deck.clipImport.dir', d.path);
      const row = (label, meta, onclick, cls = '') => h('button', { type: 'button', class: `clip-file ${cls}`.trim(), onclick },
        h('span', {}, label), meta ? h('span', { class: 'hint' }, meta) : null);
      list.replaceChildren(...[
        h('p', { class: 'hint clip-path' }, d.path || 'Pick a drive or folder'),
        d.path ? row('⬆ Up', null, () => showPc(d.parent || ''), 'dir') : null,
        ...d.dirs.map((x) => row(`📁 ${x.name}`, null, () => showPc(x.path), 'dir')),
        ...d.files.map((x) => row(`🎞 ${x.name}`, `${fmtSize(x.size)} · ${new Date(x.mtime * 1000).toLocaleDateString()}`, () => openPcFile(x))),
        d.path && !d.dirs.length && !d.files.length ? placeholder('No videos or folders here') : null].filter(Boolean));
    }).catch((e) => {
      if (path) { store.set('deck.clipImport.dir', ''); return showPc(''); }
      list.replaceChildren(note(e.message, 'err'));
    });
  };
  const openPcFile = async (x) => {
    const out = h('div', {}, placeholder('Reading the file…'));
    body.replaceChildren(button('← Folder', () => showPc(), { cls: 'small ghost' }), out);
    let info;
    try { info = await api(`/api/clip/probe?path=${encodeURIComponent(x.path)}`, { busy: false }); }
    catch (e) { return out.replaceChildren(note(e.message, 'err')); }
    const name = nameInput(x.name.replace(/\.[^.]+$/, ''));
    const draw = (url) => {
      const proxyBtn = button('Make a preview copy', async () => {
        proxyBtn.disabled = true;
        try { draw((await waitJob(await api('/api/clip/proxy', { method: 'POST', body: { path: x.path }, busy: false }), progress)).url); }
        catch (e) { toast(e.message, true); proxyBtn.disabled = false; }
        bar.classList.add('hidden');
      });
      const cant = h('div', { class: 'hidden' }, note("This browser can't play that file. A small preview copy plays everywhere; the clip is still cut from the original.", 'warn'), proxyBtn);
      out.replaceChildren(
        h('p', { class: 'hint' }, `${x.name} · ${info.width}×${info.height} · ${+info.fps.toFixed(2)} fps · ${fmtDur(info.duration)} · ${fmtSize(x.size)}`),
        editor({ url, info: Promise.resolve(info), duration: info.duration, onError: () => cant.classList.remove('hidden') }),
        cant, sizeField(), field('Name', name), bar,
        h('div', { class: 'actions' }, saveBtn(async () => {
          const { start, end } = span(info.duration);
          return waitJob(await api('/api/clip/file/cut', { method: 'POST', busy: false,
            body: { path: x.path, start, end, height: size || null, crop: cut?.crop, name: name.value.trim() || x.name } }), progress);
        })));
    };
    draw(`/api/clip/file?path=${encodeURIComponent(x.path)}`);
  };

  // ---- a file on this device ----
  let objUrl = null;
  const showDevice = () => {
    const out = h('div', {});
    body.replaceChildren(
      fileButton('Choose a video…', ([fl]) => openDeviceFile(fl, out), { accept: 'video/*', cls: 'small primary' }),
      hint('Only the piece you choose is sent, however big the file is.'), out);
  };
  const openDeviceFile = (fl, out) => {
    if (objUrl) URL.revokeObjectURL(objUrl);
    objUrl = URL.createObjectURL(fl);
    const name = nameInput(fl.name.replace(/\.[^.]+$/, ''));
    let dur = 0;
    const meta = new Promise((resolve) => {   // the browser's own reading of the file: no fps, so 30 for frame steps
      const t = h('video', { src: objUrl, preload: 'metadata', muted: true });
      t.addEventListener('loadedmetadata', () => { dur = t.duration; resolve({ duration: t.duration, fps: 30 }); });
      t.addEventListener('error', () => resolve({ duration: 0, fps: 30 }));
    });
    const cant = h('div', { class: 'hidden' }, note("This browser can't play that file here. Copy it to the PC and use the This PC tab.", 'warn'));
    out.replaceChildren(
      h('p', { class: 'hint' }, `${fl.name} · ${fmtSize(fl.size)}`),
      editor({ url: objUrl, info: meta, duration: 0, onError: () => cant.classList.remove('hidden') }),
      cant, sizeField(), field('Name', name), bar,
      h('div', { class: 'actions' }, saveBtn(async () => {
        await meta;
        const { start, end } = span(dur);
        progress(0, ffmpegP ? 'Cutting' : 'Loading the cutter (31 MB, once)');
        let piece, at = start;
        try {
          piece = await copyPiece(fl, start, end - start);
          at = 0;   // the piece starts on the cut
        } catch (e) {
          if (fl.size > 500e6) throw new Error(`${e.message}. The file is too big to send whole: copy it to the PC and use the This PC tab.`);
          piece = fl;   // small enough: send it all and let the server cut
        }
        progress(0, 'Sending');
        const form = new FormData();
        form.append('file', piece); form.append('start', String(at)); form.append('at', String(start));
        form.append('length', String(end - start)); form.append('height', String(size || 0));
        if (cut?.crop) form.append('crop', JSON.stringify(cut.crop));
        form.append('name', name.value.trim() || fl.name);
        return waitJob(await api('/api/clip/upload', { method: 'POST', form, busy: false }), progress);
      })));
  };

  const show = () => { cut = null; ({ link: showLink, pc: () => showPc(), device: showDevice })[tab](); };
  show();
}
