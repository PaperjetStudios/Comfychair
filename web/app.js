// ComfyDeck tablet UI. Plain ES modules, no build step. This is the entry point: projects, tab switching and
// wiring. The panels live in generate.js (templates, prompt, saved settings, preview, zoom), run.js (websocket,
// history, the queue), editor.js (+ sketch pad), video.js (timeline), vfx.js (VFX effects), board.js (board + gallery); media.js has
// the pickers and core.js the shared state. The 3D tab (scene.js) loads on demand.

import {
  $, h, store, api, toast, overlayOpened, overlayClosed, openSheet, closeSheet, button, help,
} from './ui.js';
import { S, loadProjects, setSwitchTab, emitProject } from './core.js';
import { generate, loadTemplates, selectTemplate, stop, wireTemplateFilter, wireZoom } from './generate.js';
import './gentabs.js';   // Generate tabs + presets: plugs into generate.js through its hooks
import { RUN, checkUiVersion, connectWS, loadHistory, onResume, openJobs, runChip, sceneMod, sceneModule, setConn } from './run.js';
import { renderEditor } from './editor.js';
import { renderVideo, vidPause, wireVideoTransport } from './video.js';
import { renderVfx, vfxPause, wireVfx } from './vfx.js';
import { renderSound, sndPause, wireSound } from './sound.js';
import { B, closeGallery, pauseBoard, renderBoard } from './board.js';
import { maximizable, sideNav, wireSplitters } from './layout.js';
import { loadPrefs, openPrefs } from './prefs.js';

// ---------------------------------------------------------------------------
// full screen (hides the browser bars on the tablet)
// ---------------------------------------------------------------------------
function wireFullscreen() {
  const btn = $('#fsBtn');
  if (!document.documentElement.requestFullscreen) { btn.classList.add('hidden'); return; }
  btn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) { toast('Full screen not available: ' + e.message, true); }
  });
  document.addEventListener('fullscreenchange', () => btn.classList.toggle('on', document.fullscreenElement === document.documentElement));
}

// ---------------------------------------------------------------------------
// projects, tabs, wiring
// ---------------------------------------------------------------------------
$('#projectSel').addEventListener('change', async (e) => {
  if (e.target.value === '__new') {
    const name = prompt('Project name');
    if (name && name.trim()) {
      try { const p = await api('/api/projects', { method: 'POST', body: { name } }); S.project = p.id; } catch (err) { toast(err.message, true); }
    }
    await loadProjects();
  } else S.project = Number(e.target.value);
  store.set('deck.project', S.project);
  emitProject();
  S.historyDone = false; loadHistory();
  B.sel.clear();
  if ($('#tab-board').classList.contains('active')) renderBoard();
  if (sceneMod) sceneMod.projectChanged();
});

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name);
    if (b.dataset.tab === name) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'generate' && !RUN.pid) runChip(0, 0, $('#progText').textContent);   // lets go of a finished ✓ / !
  if (name === 'history') loadHistory();
  if (name === 'editor') renderEditor();
  if (name === 'video') renderVideo(); else vidPause();
  if (name === 'vfx') renderVfx(); else vfxPause();
  if (name === 'sound') renderSound(); else sndPause();
  if (name === 'board') renderBoard(); else { closeGallery(); pauseBoard(); }
  if (name === 'scene') sceneModule().then((m) => m.show()).catch((e) => { console.error(e); toast(`3D view: ${e.message}${whereFrom(e)}`, true); });
  else if (sceneMod) sceneMod.hide();
  $('.actionbar').classList.toggle('hidden', ['editor', 'video', 'sound', 'vfx', 'board', 'scene'].includes(name));
}
// where an error came from: its first two places in our files (file:line), short enough for a toast on a tablet
function whereFrom(e) {
  const at = String(e?.stack || '').split('\n').map((l) => l.match(/\/([\w-]+\.js)(?:\?[^:]*)?:(\d+):\d+/)).filter(Boolean)
    .slice(0, 2).map((m) => `${m[1]}:${m[2]}`);
  return at.length ? ` (at ${at.join(' < ')})` : '';
}
setSwitchTab(switchTab);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('#tplSel').addEventListener('change', (e) => selectTemplate(e.target.value));
wireTemplateFilter();
$('#reloadTpl').addEventListener('click', async () => { await loadTemplates(true); toast('Templates and model lists reloaded'); });
$('#genBtn').addEventListener('click', () => { const p = S.pendingParent; S.pendingParent = null; generate(p); });
$('#stopBtn').addEventListener('click', () => stop());
$('#jobsBtn').addEventListener('click', openJobs);
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#moreHistory').addEventListener('click', () => loadHistory(true));
const setBatch = (n) => { S.batch = Math.max(1, Math.min(32, n)); $('#batchVal').textContent = S.batch; };
$('#batchMinus').addEventListener('click', () => setBatch(S.batch - 1));
$('#batchPlus').addEventListener('click', () => setBatch(S.batch + 1));
$('#prefsBtn').addEventListener('click', openPrefs);
$('#debugBtn').addEventListener('click', () => {
  const counts = Object.entries(S.debugCounts).map(([k, v]) => `${k}: ${v}`).join('\n');
  openSheet(h('h3', {}, 'Websocket log'),
    help('Message counts, then unhandled messages. Useful for checking what a custom node sends.'),
    h('div', { class: 'log' }, counts + '\n\n' + (S.debug.slice().reverse().join('\n') || '(nothing unhandled yet)')));
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume(); });
addEventListener('pageshow', (e) => { if (e.persisted) onResume(); });   // restored from the back/forward cache
addEventListener('online', onResume);

// Two tabs (or the PWA and a browser tab) share these settings: when the other one changes them,
// pick the change up here instead of quietly writing the old values back over it.
addEventListener('storage', (e) => {
  if (!S.tpl || !e.key) return;
  // (the settings and prompt builder now live in the Generate tab, which other devices and windows pick up from the server)
  if (e.key === 'deck.myPrompts') S.myPrompts = new Set(store.get('deck.myPrompts', []));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('#genBtn').click();
});

// The other panels' layout lives in layout.js: splitters, icon tabs, maximize
function wireLayout() {
  wireSplitters();
  for (const id of ['generate', 'editor']) {
    const tab = $(`#tab-${id}`);
    maximizable(tab.querySelector('.stage'), tab.querySelector('.viewer'));
  }
  sideNav($('#tab-generate .panel'), 'generate', () => [...document.querySelectorAll('#fields > details.group')]
    .map((el) => ({ el, label: el.querySelector(':scope > summary')?.textContent || '' })));
  sideNav($('#editorPanel'), 'editor', sectionTargets($('#editorPanel')));
  sideNav($('#videoPanel'), 'video', sectionTargets($('#videoPanel')));
  sideNav($('#vfxPanel'), 'vfx', sectionTargets($('#vfxPanel')));
  sideNav($('#soundPanel'), 'sound', sectionTargets($('#soundPanel')));
  sideNav($('#scenePanel'), 'scene', sectionTargets($('#scenePanel')));
}
// the .section blocks that sit directly in a panel's body (not ones nested inside another)
const sectionTargets = (panel) => () => [...panel.querySelectorAll('.section')]
  .filter((el) => !el.parentElement.closest('.section') && el.querySelector(':scope > .section-title > span'))
  .map((el) => ({ el, label: el.querySelector(':scope > .section-title > span').textContent }));

// Common phrases for MiniMax H3 prompts, after ComfyUI's H3 prompt guide (docs.comfy.org): shots
// start with [Shot N] and later ones cut at a timestamp; ambience and sound effects go in
// overall_soundscape, background score in non_diegetic_music (N/A for none); speech goes in <d></d>.
// § marks where the cursor lands; ¶ puts the phrase on a new last line (the audio fields); ↵ on a
// new line before the audio fields (shots). A function gets the prompt and returns the phrase.
const H3_PHRASES = [
  ['Structure', [
    ['Next shot', nextShot],
    ['Soundscape:', '¶overall_soundscape: '],
    ['Score:', '¶non_diegetic_music: '],
    ['Dissolve to', 'the shot dissolves to §'],
    ['Fade to black', 'the shot fades to black'],
  ]],
  ['Shots', [
    ['Establishing', 'a wide establishing shot of §'],
    ['Wide', 'a wide shot of §'],
    ['Full body', 'a full shot of § from head to toe'],
    ['Medium', 'a medium shot of §'],
    ['Close-up', 'a close-up of §'],
    ['Extreme CU', 'an extreme close-up of §'],
    ['Two-shot', 'a two-shot of § and '],
    ['Over shoulder', 'an over-the-shoulder shot from behind §, looking at '],
    ['Reaction', 'a reaction close-up of §'],
    ['Insert', 'an insert shot of § in detail'],
    ['POV', 'a first-person POV shot through the eyes of §'],
    ['Low angle', 'a low-angle shot looking up at §'],
    ['High angle', 'a high-angle shot looking down at §'],
    ['Overhead', 'a top-down overhead shot of §'],
    ['Dutch angle', 'a tilted Dutch-angle shot of §'],
    ['Profile', 'a side profile shot of §'],
    ['From behind', 'a shot from behind § as '],
    ['Silhouette', '§ silhouetted against the light'],
  ]],
  ['Camera', [
    ['Static', 'locked-off static camera'],
    ['Handheld', 'subtle handheld shake'],
    ['Push in', 'the camera slowly pushes in'],
    ['Pull back', 'the camera slowly pulls back'],
    ['Pan left', 'the camera pans left'],
    ['Pan right', 'the camera pans right'],
    ['Tilt up', 'the camera tilts up'],
    ['Tilt down', 'the camera tilts down'],
    ['Truck left', 'the camera trucks left alongside §'],
    ['Truck right', 'the camera trucks right alongside §'],
    ['Crane up', 'the camera cranes up to reveal §'],
    ['Crane down', 'the camera cranes down to §'],
    ['Orbit', 'the camera orbits slowly around §'],
    ['Follow', 'the camera follows § from behind'],
    ['Lead', 'the camera moves backwards ahead of § as they walk toward it'],
    ['Zoom in', 'a slow zoom in on §'],
    ['Zoom out', 'a slow zoom out'],
    ['Whip pan', 'a fast whip pan to §'],
    ['Dolly zoom', 'a dolly zoom: the background stretches while § stays the same size'],
    ['Rack focus', 'rack focus from § to '],
    ['Drone', 'an aerial drone shot sweeping over §'],
    ['Slow motion', 'in slow motion'],
  ]],
  ['Lens', [
    ['Shallow DOF', 'shallow depth of field, soft blurred background'],
    ['Deep focus', 'deep focus, everything sharp'],
    ['Wide lens', 'wide-angle lens with strong perspective'],
    ['Telephoto', 'telephoto lens, compressed background'],
    ['Eye level', 'at eye level'],
  ]],
  ['Sound', [
    ['No score', '¶non_diegetic_music: N/A'],
    ['Silent', '¶overall_soundscape: N/A'],
    ['Says <d>', 'says: <d>§</d>'],
    ['Voice-over', 'says in an off-screen voiceover: <d>§</d>'],
    ['Music in scene', 'music playing from a source within the scene: §'],
    ['Room tone', 'quiet room tone'],
    ['Breath & cloth', 'subtle room air, clothing movement, and controlled breathing'],
    ['Ambience', 'ambient sound of §'],
    ['No voices', 'No voice.'],
  ]],
  ['Clean-up', [
    ['One take', 'One continuous shot, no cuts.'],
    ['No subtitles', 'No subtitles, on-screen text or watermarks.'],
  ]],
];

// The next "[Shot N] At mm:ss.mmm, the camera cuts to", 3 s after the last cut (or [Shot 1] first)
function nextShot(text) {
  const nums = [...text.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1]));
  if (!nums.length) return '↵[Shot 1] §';
  const times = [...text.matchAll(/\bAt (\d+):(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  const n = Math.max(...nums) + 1;
  const t = (times.length ? times[times.length - 1] : 0) + 3;
  const stamp = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`;
  return `↵[Shot ${n}] At ${stamp}, the camera cuts to §`;
}

// Insert a phrase at the cursor; "§" in it marks where the cursor goes, else after the phrase.
// A leading "¶" adds it as a new last line instead, "↵" as a new line above the audio fields.
function insertPhrase(ta, text) {
  if (typeof text === 'function') text = text(ta.value);
  if (text.startsWith('↵')) {   // a new line, above the audio fields if there are any
    const m = ta.value.search(/\n\s*(overall_soundscape|non_diegetic_music)\s*:/);
    const at = m >= 0 ? m : ta.value.replace(/\s+$/, '').length;
    ta.value = ta.value.slice(0, at).replace(/\s+$/, '') + ta.value.slice(at);
    const pos = ta.value.slice(0, at).replace(/\s+$/, '').length;
    ta.setSelectionRange(pos, pos);
    text = (pos ? '\n' : '') + text.slice(1);
  }
  if (text.startsWith('¶')) {
    ta.value = ta.value.replace(/\s+$/, '');
    ta.setSelectionRange(ta.value.length, ta.value.length);
    text = (ta.value ? '\n' : '') + text.slice(1);
  }
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  let before = ta.value.slice(0, a);
  const after = ta.value.slice(b);
  const at = text.indexOf('§'), clean = text.replace('§', '');
  // continuing a sentence ("…her face" + "the camera pans left") gets a comma; after "of", "the"… a space
  const comma = !clean.startsWith('\n') && /[\w)]\s*$/.test(before) && /^[a-z]/.test(clean)
    && !/\b(says|of|and|to|the|a|an|at|in|on|by|with|from|as)\s*$/i.test(before);
  if (comma) before = before.replace(/\s+$/, '');
  const pad = comma ? ', ' : before && !/\s$/.test(before) && !clean.startsWith('\n') ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  ta.value = before + pad + clean + tail + after;
  const pos = before.length + pad.length + (at >= 0 ? at : clean.length + tail.length);
  ta.focus(); ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
}

// Touch screens: tapping a text box in a settings panel opens it in a popup at the top, sized to
// the space above the on-screen keyboard. Typing goes straight through to the original box (as
// input events), so everything listening to it keeps working.
function wireTextPopup() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  let src = null;
  const ta = h('textarea', { spellcheck: true });
  const title = h('b');
  const tags = h('div', { class: 'text-pop-tags' });   // the prompt's tag chips, beside the text
  const close = (viaBack = false) => {
    if (!src) return;
    const s = src;
    src = null;
    box.classList.add('hidden');
    ta.blur();
    s.dispatchEvent(new Event('change', { bubbles: true }));
    s.dispatchEvent(new Event('grow'));
    if (viaBack !== true) overlayClosed(back);
  };
  const back = () => close(true);
  // Undo: chips change the text from code, which the keyboard's own undo can't reverse, so keep
  // snapshots: one before each chip, one per burst of typing.
  let undo = [], lastTyped = -Infinity, prev = null;
  const state = () => ({ v: ta.value, a: ta.selectionStart, b: ta.selectionEnd });
  const keepFocus = (ev) => ev.preventDefault();   // tapping a button mustn't take the cursor out of the text
  const undoBtn = button('↶ Undo', () => {
    const u = undo.pop();
    if (!u) return;
    ta.value = u.v; ta.focus(); ta.setSelectionRange(u.a, u.b);
    ta.dispatchEvent(new Event('input'));
    undoBtn.disabled = !undo.length;
  }, { disabled: true, onmousedown: keepFocus });
  // wildcard keys, since { | } are a few keyboard pages deep. { } wraps a selection as the first option.
  const typeRaw = (fn) => {
    snap(); lastTyped = -Infinity;
    const a = ta.selectionStart, b = ta.selectionEnd;
    const [text, caret] = fn(ta.value.slice(a, b), ta.value.slice(b));
    ta.focus(); ta.setRangeText(text, a, b, 'end');
    ta.setSelectionRange(a + caret, a + caret);
    ta.dispatchEvent(new Event('input'));
  };
  const key = (label, title, fn) => button(label, () => typeRaw(fn), { cls: 'small key', title, onmousedown: keepFocus });
  const keys = h('div', { class: 'text-pop-keys' },
    key('{ }', 'Wildcard group: one option is picked at random each run', (sel) => sel ? [`{${sel}|}`, sel.length + 2] : ['{}', 1]),
    key('|', 'Next option', () => ['|', 1]),
    key('}→', 'Jump past the end of this group', (sel, after) => { const i = after.indexOf('}'); return [sel, sel.length + (i >= 0 ? i + 1 : 0)]; }));
  const snap = (st = state()) => {
    undo.push(st);
    if (undo.length > 100) undo.shift();
    undoBtn.disabled = false;
  };
  ta.addEventListener('input', (e) => {   // only real typing has an inputType; chips and undo don't
    if (e.inputType) {
      if (prev && performance.now() - lastTyped > 1500) snap(prev);
      lastTyped = performance.now();
    }
    prev = state();
  });
  const box = h('div', { class: 'text-pop hidden', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'text-pop-bar' }, title, keys, undoBtn,
      button('Done', close, { cls: 'small primary' })),
    h('div', { class: 'text-pop-body' }, ta, tags));
  document.body.append(box);
  const vv = window.visualViewport;
  const fit = () => {
    box.style.top = `${vv ? vv.offsetTop : 0}px`;
    box.style.height = `${vv ? vv.height : innerHeight}px`;
  };
  if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  ta.addEventListener('input', () => {
    if (!src) return;
    src.value = ta.value;
    src.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t === ta || t.tagName !== 'TEXTAREA' || t.readOnly || !t.closest('.panel')) return;
    if (!src) overlayOpened(back);
    src = t;
    title.textContent = t.closest('.prompt-part')?.querySelector('.part-head b')?.textContent
      || t.closest('.field')?.querySelector('.lbl')?.firstChild?.textContent || 'Text';
    ta.value = t.value;
    ta.placeholder = t.placeholder || '';
    undo = []; lastTyped = -Infinity; undoBtn.disabled = true; prev = { v: ta.value, a: ta.value.length, b: ta.value.length };
    // the prompt's tag chips (<Picture 1>, <Subject 1>…) move in here; on touch screens the panel hides them
    const list = [...(t.closest('.prompt-field')?.querySelectorAll('.tag-chips .chip') || [])].map((c) => c.textContent);
    // a chip's text is a phrase for insertPhrase, or { run(ta) } that edits the text itself (the Sound tab's script)
    const chip = (label, text = label) => h('button', { type: 'button', class: 'chip',
      title: typeof text === 'string' ? text.replace(/[§¶↵]/g, '') : label,
      onmousedown: keepFocus, onclick: () => { snap(); lastTyped = -Infinity; if (text?.run) text.run(ta); else insertPhrase(ta, text); } }, label);
    // a box can bring its own chip groups: t._chipGroups() → [[name, [[label, text]], open by default]]
    const phrases = t._chipGroups ? t._chipGroups().filter(([, items]) => items.length)
      : S.tpl?.tag_style === 'h3' && t.closest('.prompt-field') ? H3_PHRASES : [];
    // phrase groups fold: tap a heading to open or close it (remembered)
    const open = store.get('deck.phraseGroups', { Structure: true });
    const group = ([name, items, dflt = false]) => {
      open[name] ??= dflt;
      const body = h('div', { class: 'text-pop-group' + (open[name] ? '' : ' hidden') }, items.map(([l, x]) => chip(l, x)));
      const head = h('button', { type: 'button', class: 'text-pop-head', onmousedown: keepFocus, onclick: () => {
        open[name] = !open[name]; store.set('deck.phraseGroups', open);
        body.classList.toggle('hidden', !open[name]); head.classList.toggle('open', !!open[name]);
      } }, name);
      head.classList.toggle('open', !!open[name]);
      return [head, body];
    };
    tags.replaceChildren(...list.map((x) => chip(x)), ...phrases.flatMap(group));
    tags.classList.toggle('hidden', !list.length && !phrases.length);
    tags.classList.toggle('wide', phrases.length > 0);
    t.blur();
    box.classList.remove('hidden');
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

(async function init() {
  wireLayout();
  wireTextPopup();
  wireVideoTransport();
  wireVfx();
  wireSound();
  wireZoom();
  wireFullscreen();
  try { const s = await api('/api/status', { timeout: 8000 }); setConn(s.comfy_connected); checkUiVersion(s.ui_version); } catch { /* server down: the socket keeps retrying */ }
  // an installed app can stay open for days: look for a newer UI every few minutes while it's on screen
  setInterval(() => { if (!document.hidden) api('/api/status').then((s) => checkUiVersion(s.ui_version), () => {}); }, 5 * 60000);
  await Promise.all([loadProjects(), loadPrefs()]);
  await loadTemplates();
  loadHistory();
  connectWS();   // its first open runs syncWithServer: picks up a run that's already going
  // The service worker (HTTPS only) keeps an offline page and lets Android show "done" notifications
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
