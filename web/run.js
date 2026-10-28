import {
  $, h, store, api, toast, SHEET, sheetOpen, openSheet, closeSheet, button, linkBtn, actions, hint, placeholder, note,
  mediaCard, seg, setIcon,
} from './ui.js';
import { S, fmtT, isMine, loadProjects, switchTab, emitServer } from './core.js';
import { genLabel, mediaEl, openImagePicker, outputCard, uploadImage } from './media.js';
import { factsOf, isMedia, kindDef, kindTile } from './kinds.js';
import { addToPrompt, builderState, keepAwake, loadTemplates, renderFields, saveBuilder, selectTemplate, setVal, stop } from './generate.js';
import { B, GAL, boardChanged, galleryRefresh } from './board.js';
import { queueRun } from './make.js';

// ---------------------------------------------------------------------------
// "it's done": a chime, ✓ in the tab title, and a system notification where allowed (HTTPS)
// ---------------------------------------------------------------------------
let audioCtx = null;
export function notifyPrepare() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  if (window.Notification && isSecureContext && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function chime(ok = true) {
  if (!audioCtx || store.get('deck.chime', true) === false) return;
  const t = audioCtx.currentTime;
  (ok ? [660, 880] : [440, 330]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.32);
  });
}
const BASE_TITLE = document.title;
function notifyDone(g) {
  const ok = g.status === 'done';
  const took = runTime(g);
  if (took == null || took > 15 || document.hidden) chime(ok);  // quick image runs stay quiet while you watch
  try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]); } catch { /* not supported */ }
  if (document.hidden) {
    document.title = `${ok ? '✓ Done' : '✕ Failed'} · ${BASE_TITLE}`;
    if (window.Notification && Notification.permission === 'granted') {
      const title = ok ? `#${g.id} is done` : `#${g.id} failed`;
      const opts = { body: ok ? `${g.template}${took ? ` · ${fmtDur(took)}` : ''}` : (g.error || ''), tag: 'comfydeck', icon: 'icon-192.png' };
      // Android only shows notifications through the service worker
      (navigator.serviceWorker?.controller ? navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts))
        : Promise.resolve().then(() => new Notification(title, opts))).catch(() => { /* not allowed here */ });
    }
  }
}

// ---------------------------------------------------------------------------
// live preview (canvas) + output viewer
// ---------------------------------------------------------------------------
const P = { frames: [], anim: null, idx: 0, last: 0, raf: 0 };
const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d');

function findImageStart(u8) {
  const lim = Math.min(u8.length - 12, 1024);
  for (let i = 0; i < lim; i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) return [i, 'image/jpeg'];
    if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47) return [i, 'image/png'];
    if (u8[i] === 0x52 && u8[i + 1] === 0x49 && u8[i + 2] === 0x46 && u8[i + 3] === 0x46 &&
        u8[i + 8] === 0x57 && u8[i + 9] === 0x45 && u8[i + 10] === 0x42 && u8[i + 11] === 0x50) return [i, 'image/webp'];
  }
  return [-1, null];
}

async function onBinary(buf) {
  if (!isMine(S.activePid)) return;  // another device's run: its previews are its own
  const u8 = new Uint8Array(buf);
  const evType = u8.length >= 4 ? new DataView(buf).getUint32(0) : -1;
  const [off, mime] = findImageStart(u8);
  if (off < 0) { logDebug(`binary type=${evType} ${u8.length}B (no image found)`); return; }
  let bmp;
  try { bmp = await createImageBitmap(new Blob([u8.subarray(off)], { type: mime })); } catch { return; }
  // VHS animated previews: [type][1][1][frame index][16-byte node id][jpeg]. Each frame goes in its
  // slot so the clip plays in order; frames refresh in place as sampling goes on.
  const dv = new DataView(buf);
  if (P.anim && off === 32 && dv.getUint32(4) === 1 && dv.getUint32(8) === 1) {
    const i = dv.getUint32(12) % Math.max(1, P.anim.length);
    if (P.frames[i]) P.frames[i].close();
    P.frames[i] = bmp;
  } else {  // a single still preview
    for (const f of P.frames) f?.close();
    P.frames = [bmp]; P.idx = 0;
  }
  showLive();
}

function showLive() {
  canvas.classList.remove('hidden');
  $('#viewer').classList.add('live');  // hides (and pauses) whatever output was showing
  $('#viewerMedia').querySelectorAll('video').forEach((v) => v.pause());
  $('#viewerBadge').classList.remove('hidden');
  if (!P.raf) P.raf = requestAnimationFrame(tick);
}

function tick(t) {
  // a still preview is drawn once, then the loop sleeps until the next frame arrives (showLive
  // wakes it); only an animated preview keeps it running
  P.raf = P.frames.length > 1 ? requestAnimationFrame(tick) : 0;
  if (!P.frames.length) return;
  const fps = (P.anim && P.anim.rate) || 8;
  if (P.frames.length > 1 && t - P.last < 1000 / fps) return;
  P.last = t;
  // step to the next frame we have, in clip order (slots fill in as the first step arrives)
  let f = null;
  for (let k = 0; k < P.frames.length && !f; k++) {
    P.idx = (P.idx + 1) % P.frames.length;
    f = P.frames[P.idx];
  }
  if (!f) return;
  if (canvas.width !== f.width || canvas.height !== f.height) { canvas.width = f.width; canvas.height = f.height; }
  ctx.drawImage(f, 0, 0);
}

function clearLive() {
  cancelAnimationFrame(P.raf); P.raf = 0;
  for (const f of P.frames) f?.close();
  P.frames = []; P.anim = null; P.idx = 0;
  canvas.classList.add('hidden');
  $('#viewerBadge').classList.add('hidden');
  $('#viewer').classList.remove('live');
}

function showOutput(g, index = 0) {
  clearLive();
  $('#viewer').classList.remove('live');
  S.viewing = g.id;
  const o = g.outputs[index];
  const box = $('#viewerMedia');
  if (!o) { box.replaceChildren(placeholder(g.status === 'error' ? `Error: ${g.error || ''}` : 'No outputs')); return; }
  const el = mediaEl(o);
  if (o.kind === 'image') el.addEventListener('click', () => openGeneration(g.id));
  box.replaceChildren(el);
  outputThumbs($('#outStrip'), g, index, (i) => showOutput(g, i));
}

// A run's outputs as thumbnails to switch between (none when there's only one)
function outputThumbs(strip, g, sel, onPick) {
  strip.replaceChildren(...(g.outputs.length > 1 ? g.outputs.map((o, i) =>
    h('button', { type: 'button', class: 'thumb' + (i === sel ? ' sel' : ''), onclick: () => onPick(i) }, mediaEl(o, { thumb: true }))) : []));
}

function setProgress(value, max, text) {
  $('#progBar').style.width = max ? `${(100 * value) / max}%` : '0';
  $('#progText').textContent = text || '';
  // the Generate button fills up too (stripes before the steps start); it stays tappable to queue more
  const gb = $('#genBtn');
  gb.classList.toggle('running', !!RUN.pid);
  gb.classList.toggle('indet', !!RUN.pid && !max);
  gb.style.setProperty('--gen', max ? `${(100 * value) / max}%` : '0%');
  runChip(value, max, text || '');
}

// The same progress on the Generate tab, for when another tab is open: a chip with the percentage
// (a spinner before the steps start), then ✓ or ! when it ends. CSS hides it on the Generate tab itself.
export function runChip(value, max, text) {
  const chip = $('#runChip'), tab = chip.parentElement;
  const state = !text ? null : /^Finished/.test(text) ? 'done' : /^(Stopped|Failed)/.test(text) ? 'fail'
    : /another device/.test(text) ? 'other' : 'run';
  // a ✓ or ! stays until the Generate tab is opened, so it's still there after a long time away
  if (!state && /\b(done|fail)\b/.test(chip.className) && !tab.classList.contains('active')) return;
  const pct = max ? Math.round((100 * value) / max) : null;
  chip.className = 'tab-chip' + (state ? ` ${state}` : ' hidden') + ((state === 'run' || state === 'other') && pct == null ? ' spin' : '');
  setIcon(chip, state === 'done' ? '✓' : state === 'fail' ? '!' : pct != null ? `${pct}%` : '');
  tab.style.setProperty('--run', state === 'run' && pct != null ? `${pct}%` : '0%');
  tab.title = state ? `Generate · ${text}` : 'Generate';
}

// ---------------------------------------------------------------------------
// run stages: "Loading models → Encoding prompt → Sampling 13/20 → Decoding → Saving" with timings
// ---------------------------------------------------------------------------
export const RUN = { pid: null, stages: [], current: null, title: '', step: null, t0: 0, stageT0: 0, done: new Set(), timer: 0 };

// elapsed / stages: picking up a run that was already going (after a reload or a dropped connection)
function runStart(pid, { elapsed = 0, stages = [] } = {}) {
  const t0 = Date.now() - elapsed * 1000;
  Object.assign(RUN, { pid, stages, current: null, title: '', step: null, t0, stageT0: Date.now(), done: new Set(), endedAt: 0 });
  clearInterval(RUN.timer);
  RUN.timer = setInterval(runText, 1000);
  drawStages(); runText();
}
function runStages(d) { if (d.prompt_id === RUN.pid) { RUN.stages = d.stages; drawStages(); } }
function runCached(d) {  // nodes ComfyUI reuses from the last run (models already loaded etc.)
  if (d.prompt_id !== RUN.pid) return;
  d.stages.forEach((s) => RUN.done.add(s)); drawStages();
}
function runStage(d) {
  if (d.prompt_id !== RUN.pid) return;
  if (d.stage && d.stage !== RUN.current) {
    if (RUN.current) RUN.done.add(RUN.current);
    // everything before the current stage in the list is finished
    const i = RUN.stages.indexOf(d.stage);
    RUN.stages.slice(0, Math.max(0, i)).forEach((s) => RUN.done.add(s));
    RUN.current = d.stage; RUN.stageT0 = Date.now(); RUN.step = null;
  }
  RUN.title = d.title;
  drawStages(); runText();
}
// outcome: 'done' (the result follows as a deck_generation), 'stopped' or 'failed' (nothing follows,
// so the live preview goes now)
function runEnd(outcome = 'done') {
  if (!RUN.pid) return;
  clearInterval(RUN.timer);
  if (RUN.current) RUN.done.add(RUN.current);
  RUN.current = null; drawStages();
  const took = fmtDur((Date.now() - RUN.t0) / 1000);
  RUN.pid = null; RUN.endedAt = Date.now();
  setProgress(0, 0, outcome === 'done' ? `Finished in ${took}` : outcome === 'stopped' ? `Stopped after ${took}` : `Failed after ${took}`);
  if (outcome !== 'done') restoreViewer();
  // safety net: if the result never shows up (missed message), don't leave the LIVE frame up
  else setTimeout(() => { if (!RUN.pid && $('#viewer').classList.contains('live')) restoreViewer(); }, 15000);
  setTimeout(() => { if (!RUN.pid) { $('#stageBar').classList.add('hidden'); setProgress(0, 0, ''); } }, 6000);
}

// Drop the live preview and show the last result again
function restoreViewer() {
  clearLive();
  const g = S.viewing != null && S.history.get(S.viewing);
  if (g && g.outputs.length && !$('#viewerMedia').childElementCount) showOutput(g);
}

function runText() {
  if (!RUN.pid) return;
  const total = fmtDur((Date.now() - RUN.t0) / 1000);
  const inStage = fmtDur((Date.now() - RUN.stageT0) / 1000);
  let text, val = 0, max = 0;
  if (!RUN.current) text = `Starting… · ${total}`;
  else if (RUN.step) {
    [val, max] = RUN.step;
    text = `${RUN.current} · ${RUN.title} · step ${val}/${max} · ${inStage}`;
  } else if (RUN.current === 'Sampling') {
    // before the first step ComfyUI is moving the model onto the GPU
    text = `Sampling · loading model onto the GPU… · ${inStage}`;
  } else text = `${RUN.current} · ${RUN.title} · ${inStage}`;
  setProgress(val, max, `${text}  (total ${total})`);
}

function drawStages() {
  const bar = $('#stageBar');
  bar.classList.toggle('hidden', !RUN.stages.length);
  bar.replaceChildren(...RUN.stages.map((s) => h('span', {
    class: 'stg' + (s === RUN.current ? ' on' : RUN.done.has(s) ? ' done' : '') }, RUN.done.has(s) && s !== RUN.current ? `✓ ${s}` : s)));
}

// ---------------------------------------------------------------------------
// websocket
// ---------------------------------------------------------------------------
function nodeName(id) {
  for (const t of [S.tpl, ...S.templates]) if (t?.node_titles?.[id]) return t.node_titles[id].replace(/^@\s*\d*\s*/, '');
  return id;
}

function logDebug(line) {
  S.debug.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (S.debug.length > 300) S.debug.shift();
}

// One socket at a time. When it drops (the tablet slept, Wi-Fi blipped, the server restarted) it
// reconnects with a growing delay, and every (re)connect resyncs with the server, since anything
// sent while it was down is lost.
const WS = { sock: null, ping: 0, retry: 0, timer: 0, everOpen: false };
export function connectWS() {
  clearTimeout(WS.timer);
  if (WS.sock && WS.sock.readyState <= 1) return;   // connecting or open already
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  WS.sock = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    WS.retry = 0; WS.everOpen = true;
    setServer(true);
    emitServer({ type: 'ws_open' });
    syncWithServer();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { onBinary(e.data); return; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
    if (m.type === 'store' || m.type === 'deck_projects' || m.type === 'deck_project_job') emitServer(m);
  };
  ws.onclose = () => {
    if (WS.sock !== ws) return;
    clearInterval(WS.ping);
    WS.sock = null;
    setServer(false);
    WS.timer = setTimeout(connectWS, Math.min(10000, 1000 * 2 ** WS.retry++));
  };
  clearInterval(WS.ping);
  WS.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
}

// Coming back to the tab (tablet woke up): the socket may be dead without knowing it yet, so open a
// fresh one if it isn't plainly open, and catch up either way.
export function onResume() {
  document.title = BASE_TITLE;
  if (!WS.sock || WS.sock.readyState !== 1) { WS.retry = 0; if (WS.sock) { const s = WS.sock; WS.sock = null; try { s.close(); } catch { /* gone */ } } connectWS(); }
  else syncWithServer();
}

// Two separate things can be down: ComfyChair itself (no socket) or ComfyUI behind it.
function setServer(on) { S.serverUp = on; showConn(); }
export function setConn(on) {
  const back = on && S.connected === false;
  S.connected = on; showConn();
  // ComfyUI came back (a restart): the templates were read without its nodes, so read them again (app.js)
  if (back) document.dispatchEvent(new Event('deck-comfy-back'));
}
function showConn() {
  const server = S.serverUp !== false, comfy = S.connected;
  $('#connDot').classList.toggle('on', server && comfy);
  $('#connDot').title = !server ? 'Can\'t reach ComfyChair' : comfy ? 'ComfyUI connected' : 'ComfyUI not connected';
  const banner = $('#connBanner');
  // a blip while reconnecting isn't worth a banner; only say something once it lasts
  clearTimeout(showConn.t);
  const text = !server ? 'Can\'t reach ComfyChair. Reconnecting… (is the server running and the tablet on the same Wi-Fi?)'
    : !comfy ? 'ComfyChair is up, but ComfyUI isn\'t connected. It reconnects by itself once ComfyUI is running.' : '';
  if (!text) { banner.classList.add('hidden'); return; }
  showConn.t = setTimeout(() => { banner.textContent = text; banner.classList.remove('hidden'); }, WS.everOpen || !server ? 2500 : 0);
}

// The installed app keeps running the code it opened with. When the UI's files on the box are newer
// (/api/status ui_version), offer a reload; it's asked again at the next check if it's dismissed.
let uiVersion = null;
export function checkUiVersion(v) {
  if (v == null) return;
  if (uiVersion == null) { uiVersion = v; return; }
  if (v === uiVersion || $('#toast .update-act')) return;
  toast('ComfyChair has been updated', false, { label: '↻ Reload', fn: () => location.reload(), stay: true });
  $('#toast .toast-act')?.classList.add('update-act');
}

// Catch up after a reload, a dropped socket or the tablet waking: what's running now (pick its
// progress back up if it's ours), and any results that landed while we weren't listening.
let syncing = null;
export function syncWithServer() {
  syncing ||= (async () => {
    try {
      if (!S.projects.length) await loadProjects();
      if (!S.templates.length) await loadTemplates();
      try { const s = await api('/api/status'); setConn(s.comfy_connected); checkUiVersion(s.ui_version); } catch { /* the socket says the rest */ }
      const jobs = await api('/api/jobs');
      const running = jobs.active.find((j) => j.status === 'running');
      S.activePid = running ? running.prompt_id : null;
      S.queueRemaining = jobs.active.length;
      $('#queueInfo').textContent = jobs.active.length ? ` · ${jobs.active.length}` : '';
      const wasRunning = RUN.pid;
      if (running && isMine(running.prompt_id)) {
        if (RUN.pid !== running.prompt_id) {
          runStart(running.prompt_id, { elapsed: running.elapsed || 0, stages: running.stages || [] });
          $('#viewerMedia').replaceChildren(); $('#outStrip').replaceChildren();
        }
        keepAwake(true);
      } else if (RUN.pid) runEnd();   // it ended while we weren't listening; the result is fetched below
      showBusy();
      // results we missed: fetch them, and show ours if it's newer than what's in the viewer
      const fresh = await api(`/api/generations?limit=30${S.project != null ? `&project_id=${S.project}` : ''}`);
      let newest = null;
      for (const g of fresh) {
        const old = S.history.get(g.id);
        S.history.set(g.id, g);
        if (old && old.status === g.status) continue;
        if (isMine(g.prompt_id) && (g.status === 'done' || g.status === 'error') && (!old || old.status === 'queued' || old.status === 'running')) {
          if (!newest || g.id > newest.id) newest = g;
        }
      }
      if (newest && (!S.viewing || newest.id > S.viewing) && !RUN.pid) {
        if (newest.status === 'done') showOutput(newest);
        else { clearLive(); $('#viewerMedia').replaceChildren(placeholder(`Error: ${newest.error || ''}`)); }
        if (wasRunning || document.hidden) notifyDone(newest);
      } else if (!RUN.pid && $('#viewer').classList.contains('live')) restoreViewer();
      if (!jobs.active.length) keepAwake(false);
      if ($('#tab-history').classList.contains('active')) renderHistory();
    } catch (e) {
      logDebug(`sync failed: ${e.message}`);
    } finally { syncing = null; }
  })();
  return syncing;
}

// While another device's run is going, say so (its previews aren't shown here)
function showBusy() {
  if (RUN.pid || !S.activePid || isMine(S.activePid)) return;
  if (Date.now() - (RUN.endedAt || 0) < 6000) return;
  setProgress(0, 0, 'ComfyUI is busy with a run from another device');
}

function onMessage(m) {
  const d = m.data || {};
  S.debugCounts[m.type] = (S.debugCounts[m.type] || 0) + 1;
  // most run messages only matter here if the run is ours; other devices' runs show as "busy"
  const mine = d.prompt_id ? isMine(d.prompt_id) : isMine(S.activePid);
  switch (m.type) {
    case 'deck_comfy_status': setConn(d.connected); break;
    case 'status': {
      const q = d.status?.exec_info?.queue_remaining ?? 0;
      S.queueRemaining = q;
      $('#queueInfo').textContent = q ? ` · ${q}` : '';
      if (!q) {
        S.activePid = null;
        keepAwake(false);
        if (!RUN.pid && Date.now() - (RUN.endedAt || 0) > 6000) setProgress(0, 0, '');  // keep "Finished in …" up a while
      }
      break;
    }
    case 'execution_start':
      S.activePid = d.prompt_id;
      if (!mine) { showBusy(); break; }
      clearLive(); showLive(); setProgress(0, 0, 'Starting…');
      runStart(d.prompt_id);
      $('#viewerMedia').replaceChildren();
      $('#outStrip').replaceChildren();
      break;
    case 'execution_cached': break;
    case 'executing':
      S.executingNode = d.node;
      if (!d.node) { if (mine) runEnd(); S.activePid = null; }
      else if (!RUN.pid && mine) setProgress(0, 0, nodeName(d.node));  // no stage info (e.g. an older server)
      break;
    case 'deck_stages': runStages(d); break;
    case 'deck_stage': runStage(d); break;
    case 'deck_cached': runCached(d); break;
    case 'progress':
      if (!mine) {
        if (!RUN.pid) setProgress(d.value, d.max, `ComfyUI is busy with another device's run · ${d.value}/${d.max}`);
        break;
      }
      RUN.step = [d.value, d.max];
      if (RUN.pid) runText(); else setProgress(d.value, d.max, `${nodeName(d.node || S.executingNode)} · ${d.value}/${d.max}`);
      break;
    case 'VHS_latentpreview': // VideoHelperSuite animated sampler preview metadata
      if (mine) P.anim = { length: d.length || 1, rate: d.rate || 8 };
      logDebug(`VHS_latentpreview ${JSON.stringify(d)}`);
      break;
    case 'execution_interrupted':
      if (mine) runEnd('stopped');
      S.activePid = null;
      break;
    case 'execution_error':
      S.activePid = null;
      if (!mine) break;
      runEnd('failed');
      toast(`Error in ${d.node_type || 'node'}: ${d.exception_message || ''}`, true);
      break;
    case 'deck_generation': onGeneration(d); emitServer({ type: 'deck_generation', data: d }); break;   // (the VFX tab follows its runs)
    case 'deck_generation_deleted':
      S.history.delete(d.id); removeCard(d.id);
      document.querySelectorAll(`#board .tile[data-gen="${d.id}"]`).forEach((t) => { B.sel.delete(t.dataset.key); t.remove(); });
      if (GAL.el) galleryRefresh();
      break;
    case 'progress_state': case 'executed': case 'execution_success': case 'deck_projects': case 'deck_project_job': break;
    default: logDebug(`${m.type} ${JSON.stringify(d).slice(0, 300)}`);
  }
}

export function onGeneration(g) {
  const old = S.history.get(g.id);
  S.history.set(g.id, g);
  const finished = (g.status === 'done' || g.status === 'error') && (!old || old.status !== g.status);
  if (finished && isMine(g.prompt_id)) {
    // a result that lands while another of our runs is already previewing mustn't take over the viewer
    const busy = RUN.pid && RUN.pid !== g.prompt_id;
    if (g.status === 'done') {
      if (busy) toast(`#${g.id} finished (see History)`);
      else { showOutput(g); if (!RUN.pid && Date.now() - (RUN.endedAt || 0) > 6000) setProgress(0, 0, ''); }
    } else if (busy) toast(`#${g.id} failed: ${g.error || ''}`, true);
    else {
      clearLive();
      $('#viewerMedia').replaceChildren(placeholder(`Error: ${g.error || ''}`));
    }
    notifyDone(g);
  }
  if ($('#tab-history').classList.contains('active')) updateCard(g);
  if ($('#tab-board').classList.contains('active') && (g.status === 'done' || 'pinned' in g)) boardChanged(g);
  if (SHEET.gen === g.id && sheetOpen()) openGeneration(g.id);
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------
export async function loadHistory(more = false) {
  const items = [...S.history.values()].filter((g) => g.project_id === S.project);
  const before = more && items.length ? Math.min(...items.map((g) => g.id)) : null;
  try {
    const rows = await api(`/api/generations?limit=60${S.project != null ? `&project_id=${S.project}` : ''}${before ? `&before=${before}` : ''}`);
    for (const g of rows) S.history.set(g.id, g);
    S.historyDone = rows.length < 60;
  } catch (e) { toast(e.message, true); }
  renderHistory();
}

function renderHistory() {
  const items = [...S.history.values()].filter((g) => g.project_id === S.project).sort((a, b) => b.id - a.id);
  $('#historyGrid').replaceChildren(...(items.length ? items.map(cardEl) : [placeholder('Nothing generated in this project yet.')]));
  $('#moreHistory').classList.toggle('hidden', S.historyDone || !items.length);
}

// One generation changed: swap just its card (redrawing the grid reloads every video thumbnail)
function updateCard(g) {
  const grid = $('#historyGrid');
  const el = grid.querySelector(`.card[data-gen="${g.id}"]`);
  if (g.project_id !== S.project) { if (el) el.remove(); return; }
  if (el) { el.replaceWith(cardEl(g)); return; }
  const cards = [...grid.querySelectorAll('.card[data-gen]')];
  if (!cards.length) return renderHistory();
  const after = cards.find((c) => Number(c.dataset.gen) < g.id);
  if (after) after.before(cardEl(g));
  else if (S.historyDone) grid.append(cardEl(g));  // older than everything shown: only add if the list is complete
}
function removeCard(id) {
  const el = $('#historyGrid').querySelector(`.card[data-gen="${id}"]`);
  if (el) el.remove();
}

const cardEl = (g) => outputCard(g, { onPick: () => openGeneration(g.id) });

export async function openGeneration(id) {
  const g = S.history.get(id);
  if (!g) return;
  let idx = 0;
  const big = h('div', { class: 'media-big' });
  const strip = h('div', { class: 'strip' });
  const facts = h('p', { class: 'hint gen-facts' });   // what it is and what's worth knowing (kinds.js)
  const bar = h('div');   // the buttons, for the output on show
  const { takeButtons } = await import('./useas.js');
  const draw = () => {
    const o = g.outputs[idx];
    big.replaceChildren(!o ? placeholder(g.error || g.status) : isMedia(o) ? mediaEl(o) : kindTile(o, g));
    facts.textContent = o ? [kindDef(o).name, factsOf(o)].filter(Boolean).join(' · ') : '';
    outputThumbs(strip, g, idx, (i) => { idx = i; draw(); });
    bar.replaceChildren(actions(buttons()));
  };
  const t = S.templates.find((x) => x.id === g.template);
  const labelFor = (k) => {
    const f = t && t.fields.find((x) => x.key === k);
    return f ? `${f.group} · ${f.label}` : k;
  };
  const fmt = (v) => Array.isArray(v) && v.length && v[0].generation != null
    ? v.map((c) => `#${c.generation}  ${fmtT(c.start)} → ${c.end != null ? fmtT(c.end) : 'end'}`).join('\n')
    : Array.isArray(v) ? v.filter((l) => l.name && l.enabled !== false).map((l) => `${l.name} @ ${l.strength}`).join('\n') || '—'
    : typeof v === 'string' ? v : JSON.stringify(v);
  const cur = () => g.outputs[idx];
  const isScene = g.template === '3d scene';  // a depth video from the 3D tab, with its scene in the params
  const isPhoto = g.template === '3d photo';  // a picture as a mesh (MoGe), for the 3D tab
  const isEdit = g.template === 'video edit' || g.template === 'h3 upscale' || isScene || isPhoto;  // made in the Video or 3D tab, or upscaled: no template to replay
  // the same buttons as every take (useas.js takeButtons: Use as…, Pin, Download, Delete), after running it again
  // when its template is there; where each kind can go (3D, the Editor, Craft, Upscale, Track motion…) is Use as…
  const primary = { cls: 'small primary' };
  const buttons = () => [...(isEdit || !S.templates.some((t) => t.id === g.template) ? [] : [   // key, matte, imports…: no template to run again
    button('Replay & edit', () => { reuse(g); closeSheet(); }, primary),
    button('Run again', () => runAgain(g)),
  ]), ...takeButtons(g, idx, { onDeleted: () => closeSheet() }),
  !isEdit ? linkBtn('Workflow JSON', `/api/generations/${g.id}/workflow`) : null].filter(Boolean);
  draw();

  openSheet(
    h('h3', {}, genLabel(g), ' ', h('span', { class: `badge ${g.status}` }, g.status),
      runTime(g) != null ? h('span', { class: 'hint' }, `took ${fmtDur(runTime(g))}`) : null),
    big, strip, facts,
    bar,
    g.error ? note(g.error, 'err') : null,
    g.parent ? hint(`Made from #${g.parent.generation}${g.parent.frame ? ` (${g.parent.frame} frame)` : ''}`) : null,
    h('table', { class: 'params' }, Object.entries(g.params).filter(([k]) => !k.startsWith('__') && !(isScene && k === 'scene')).map(([k, v]) =>
      h('tr', {}, h('td', {}, labelFor(k)), h('td', {}, fmt(v))))));
  SHEET.gen = g.id;
}

// The 3D tab (web/scene.js, with three.js) loads the first time it's needed.
export let sceneMod = null;
let sceneLoad = null;   // (two callers at once must share one init: it builds the tabs)
export async function sceneModule() {
  if (!sceneLoad) {
    sceneLoad = import('./scene.js').then((m) => {
      m.init({ S, uploadImage, useControlVideo, openImagePicker, addToPrompt });
      return (sceneMod = m);
    });
    sceneLoad.catch(() => { sceneLoad = null; });
  }
  return sceneLoad;
}

// A depth video from the 3D tab into deck-h3-ctrl2v: its control video, size and length.
export async function useControlVideo(g, sc) {
  if (!S.templates.find((t) => t.id === 'deck-h3-ctrl2v')) return toast('Template deck-h3-ctrl2v is missing', true);
  S.history.set(g.id, S.history.get(g.id) || g);
  switchTab('generate');
  if (S.tpl?.id !== 'deck-h3-ctrl2v') selectTemplate('deck-h3-ctrl2v');
  const fs = S.tpl.fields;
  const video = fs.find((f) => f.kind === 'video');
  if (video) setVal(video.key, { generation: g.id, index: 0 });
  const int = (re) => fs.find((f) => f.kind === 'int' && re.test(f.input === 'value' ? f.label : f.input));
  if (sc.width && int(/^width$/)) setVal(int(/^width$/).key, sc.width);
  if (sc.height && int(/^height$/)) setVal(int(/^height$/).key, sc.height);
  if (sc.seconds && int(/length/i)) setVal(int(/length/i).key, Math.round(sc.seconds));   // (a whole number of seconds there; the scene may have a half)
  renderFields();
  toast(`Control video #${g.id} set: add references and a prompt`);
}

// Load a past generation's settings into Generate to edit: prompt (and its builder parts), seed,
// images, LoRAs, sizes. The seed is set to Fixed so you get the same result until you change it.
// A run made in the VFX tab opens there instead, as a new tab with that run's effect, inputs and settings.
async function reuse(g) {
  if (!S.templates.find((t) => t.id === g.template)) return toast(`Template "${g.template}" no longer exists`, true);
  if (g.params.__face?.kind === 'vfx' && g.params.__face.state) {
    await (await import('./vfx.js')).openVfxState(g.params.__face.state, `#${g.id} again`);
    return toast(`Loaded #${g.id}'s effect and settings in a new VFX tab. Change them and Run.`);
  }
  const b = g.params.__builder;
  if (b) {
    builderState();
    S.pb = { on: true, parts: { ...(b.parts || {}) }, subjects: (b.subjects || []).map((x) => ({ ...x })) };
    if (!S.pb.subjects.length) S.pb.subjects = [{ text: '', pic: null }];
    saveBuilder();
  } else if (S.pb) { S.pb.on = false; saveBuilder(); }  // written as plain text: show it that way
  selectTemplate(g.template, { ...g.params, ...g.params.__wildcards });  // prompts with their {a|b} wildcards, not this run's picks
  switchTab('generate');
  if (g.outputs.length) showOutput(g);
  toast(`Loaded #${g.id}'s settings (seed fixed${g.params.__wildcards ? ', wildcards re-roll' : ''}). Edit and Generate.`);
}

// Queue the exact same settings again (same seed), without leaving where you are.
async function runAgain(g) {
  try {
    const values = Object.fromEntries(Object.entries(g.params).filter(([k]) => !k.startsWith('__')));
    const gens = await queueRun({ template: g.template, values, project: g.project_id, parent: g.parent,
      builder: g.params.__builder, face: g.params.__face });
    notifyPrepare(); keepAwake(true);
    const other = g.project_id !== S.project ? ` in ${(S.projects.find((p) => p.id === g.project_id) || {}).name || 'its own project'}` : '';
    toast(`Queued again as #${gens[0].id}${other}`);
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------------------
// queue: what's running and waiting, how long things take, ETA from recent runs of the same template
// ---------------------------------------------------------------------------
export const runTime = (g) => (g.finished ? g.finished - (g.started || g.created) : null);
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
    : `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
}

let jobsTimer = null;
export async function openJobs() {
  const box = h('div', { class: 'jobs' });
  openSheet(h('h3', {}, 'Queue'), box);
  const refresh = async () => {
    if (!sheetOpen() || !box.isConnected) { clearInterval(jobsTimer); jobsTimer = null; return; }
    let d;
    try { d = await api('/api/jobs'); } catch (e) { box.replaceChildren(note(e.message, 'err')); return; }
    const row = (j, right, btn) => h('div', { class: `job ${j.status}`, onclick: () => j.id && openGeneration(j.id) },
      h('div', { class: 'job-main' }, h('b', {}, j.id ? `#${j.id} ` : ''), j.template,
        h('div', { class: 'hint' }, right)), btn);
    const active = d.active.map((j) => row(j,
      j.status === 'running'
        ? `running ${fmtDur(j.elapsed)}${j.typical ? ` of ~${fmtDur(j.typical)}` : ''}`
        : `waiting ${fmtDur(j.waiting)} · ${j.eta != null ? `starts in ~${fmtDur(j.eta - (j.typical || 0))}, done in ~${fmtDur(j.eta)}` : 'no timing yet for this template'}`,
      j.status === 'running'
        ? button('Stop', async (e) => {
            e.stopPropagation();
            const who = isMine(j.prompt_id) ? '' : ' It was started from another device.';
            if (!confirm(`Stop ${j.id ? `#${j.id}` : 'this run'}?${who}`)) return;
            await stop(j.prompt_id, { ask: false }); refresh();
          })
        : button('Cancel', async (e) => {
            e.stopPropagation();
            try { await api('/api/queue/cancel', { method: 'POST', body: { prompt_id: j.prompt_id } }); refresh(); } catch (err) { toast(err.message, true); }
          })));
    const recent = d.recent.map((g) => row(g,
      `${g.status === 'done' ? `took ${fmtDur(g.duration)}` : g.status} · finished ${new Date(g.finished * 1000).toLocaleTimeString()}`, null));
    box.replaceChildren(
      h('div', { class: 'lbl jobs-head' }, d.active.length ? `Running and waiting (${d.active.length})` : 'Nothing running'),
      ...active,
      h('div', { class: 'lbl jobs-head' }, 'Recent runs'),
      ...(recent.length ? recent : [hint('None yet')]));
  };
  clearInterval(jobsTimer);
  jobsTimer = setInterval(refresh, 1000);
  refresh();
}

// A finished H3 clip sampled again bigger (app/h3upscale.py): the run's own prompt, LoRAs, references and seed
export function openH3Upscale(g, idx) {
  const o = g.outputs[idx], w = o.width || 0, hgt = o.height || 0;
  let scale = 1.5, strength = 'medium';
  const size = (s) => (w ? `${Math.round((w * s) / 32) * 32}×${Math.round((hgt * s) / 32) * 32}` : `${s}×`);
  const info = h('div', { class: 'hint' });
  const show = () => { info.textContent = `${w ? `${w}×${hgt} → ` : ''}${size(scale)}. Bigger takes longer and needs more memory: 1.5× is the safe choice on 12 GB.`; };
  const go = button('Upscale', async () => {
    go.disabled = true;
    try {
      const n = await api('/api/h3/upscale', { method: 'POST', body: { generation: g.id, index: idx, scale, strength } });
      S.history.set(n.id, n); closeSheet(); openGeneration(n.id);
    } catch (e) { toast(e.message, true); go.disabled = false; }
  }, { cls: 'primary' });
  show();
  openSheet(h('h3', {}, `Upscale #${g.id}`),
    hint('Encodes the clip, makes its latent bigger with the MiniMax H3 latent upscaler, and samples it again with this run\'s own prompt, LoRAs, references and seed. The sound is the clip\'s own.'),
    seg([[1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']], scale, (v) => { scale = v; show(); }), info,
    h('div', { class: 'lbl' }, 'Strength'),
    seg([['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']], strength, (v) => { strength = v; }),
    hint('Light keeps faces and poses closest to the clip and sharpens least (2 steps). Strong sharpens most but can change faces and hands (3 steps from 0.90).'),
    h('div', { class: 'row' }, go));
}
