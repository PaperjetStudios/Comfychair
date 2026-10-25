// Shared UI building blocks for app.js and scene.js: the element helper, storage, the API client
// with its busy bar, toasts, overlays and the bottom sheet, and the small widgets every panel is
// made of (buttons, segmented controls, labelled fields, sliders, number boxes, cards, layer rows).

export const $ = (s) => document.querySelector(s);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const uid = () => Math.random().toString(36).slice(2, 10);
export const clone = (x) => JSON.parse(JSON.stringify(x ?? null));
// the next index when stepping d (±1) through n things from i; i < 0 (none yet) starts at an end
export const cycleIndex = (i, d, n) => (i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n);

// Every number box is also a slider: drag left or right on it to change the value (its whole min–max
// range over about 300 px, snapped to its step); a tap still types. While dragging it has
// data-scrubbing set and fires 'input'; letting go fires one 'change', like typing does.
const SCRUB_PX = 300;
document.addEventListener('pointerdown', (e) => {
  const inp = e.target.closest?.('input[type=number]');
  if (!inp || inp.disabled || e.button > 0 || document.activeElement === inp) return;
  const x0 = e.clientX, y0 = e.clientY, v0 = parseFloat(inp.value) || 0;
  const min = parseFloat(inp.min), max = parseFloat(inp.max);
  const step = parseFloat(inp.step) || (Number.isInteger(v0) && inp.inputMode === 'numeric' ? 1 : 0.01);
  const span = Number.isFinite(min) && Number.isFinite(max) ? max - min : NaN;
  // per pixel: the range over SCRUB_PX, or a step every 2 px when the range is huge (seeds) or open
  const perPx = Number.isFinite(span) && span <= 1e5 ? span / SCRUB_PX : step / 2;
  const dec = (String(inp.step).split('.')[1] || '').length;
  let on = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!on) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(ev.clientY - y0)) return;
      on = true; inp.blur(); inp.dataset.scrubbing = '1'; inp.classList.add('scrubbing');
      try { inp.setPointerCapture(ev.pointerId); } catch { /* the pointer is gone */ }
    }
    ev.preventDefault();
    let v = v0 + dx * perPx;
    v = Math.round(v / step) * step;
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    v = Number(v.toFixed(Math.min(6, Math.max(dec, step < 1 ? 2 : 0))));
    if (String(v) !== inp.value) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  const end = () => {
    inp.removeEventListener('pointermove', move); inp.removeEventListener('pointerup', end); inp.removeEventListener('pointercancel', end);
    if (!on) return;
    delete inp.dataset.scrubbing; inp.classList.remove('scrubbing');
    // the tap that ends a drag shouldn't open the keyboard
    inp.addEventListener('click', (c) => { c.preventDefault(); inp.blur(); }, { once: true, capture: true });
    setTimeout(() => inp.blur());
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  inp.addEventListener('pointermove', move);
  inp.addEventListener('pointerup', end);
  inp.addEventListener('pointercancel', end);
}, true);

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
// timeout: give up (and say so) instead of hanging when the server or the Wi-Fi is gone. Uploads and
// slow lookups pass a longer one. An error's .data holds the server's detail when it's an object.
// busy: what the progress bar says while it runs (default: a guess from the path for anything that
// isn't a GET; false for none). Uploads go through XHR so the bar can show how much has been sent.
export async function api(path, { method = 'GET', body, form, timeout = form ? 300000 : 30000, busy: label } = {}) {
  if (label === undefined) label = method === 'GET' ? false : busyLabel(method, path);
  const b = label ? busy(label) : null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const opts = { method, headers: {}, signal: ctl.signal };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let r, text;
  try {
    r = form ? await xhrSend(path, method, form, ctl.signal, b) : await fetch(path, opts);
    text = await r.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'ComfyDeck didn\'t answer in time (is the server running?)' : 'Can\'t reach ComfyDeck (is the server running and on this network?)');
  } finally { clearTimeout(timer); b?.done(); }
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const d = data && data.detail;
    const err = new Error((d && typeof d === 'object' ? d.message : d) || text || r.statusText);
    if (d && typeof d === 'object') err.data = d;
    throw err;
  }
  return data;
}

// fetch() can't report upload progress; this answers like a fetch Response (ok, status, text())
function xhrSend(path, method, form, signal, b) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, path);
    x.upload.onprogress = (e) => { if (e.lengthComputable) b?.set(null, e.loaded / e.total); };
    x.upload.onload = () => b?.set('Processing…', null);
    x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, statusText: x.statusText, text: async () => x.responseText });
    x.onerror = () => reject(new TypeError('network'));
    x.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => x.abort());
    x.send(form);
  });
}

// ---------------------------------------------------------------------------
// busy bar: a progress bar along the top saying what's happening while something slow runs, and a
// spinner on the button that was tapped to start it. It shows after 150 ms so quick calls don't flash.
// busy(label) → { set(label, frac), done() }; frac 0–1, or null when there's no telling how long.
// ---------------------------------------------------------------------------
const BUSY = new Set();
let busyTimer = 0, lastTap = { el: null, t: 0 };
document.addEventListener('click', (e) => { lastTap = { el: e.target.closest?.('button, .btn') || null, t: Date.now() }; }, true);
export function busy(label) {
  const t = { label, frac: null, btn: null,
    set(l, f = null) { if (l) t.label = l; t.frac = f; drawBusy(); },
    done() { if (!BUSY.delete(t)) return; if (t.btn && ![...BUSY].some((o) => o.btn === t.btn)) t.btn.classList.remove('working'); drawBusy(); } };
  if (lastTap.el?.isConnected && Date.now() - lastTap.t < 1000) {
    t.btn = lastTap.el;
    setTimeout(() => { if (BUSY.has(t)) t.btn.classList.add('working'); }, 150);
  }
  BUSY.add(t); drawBusy();
  return t;
}
function drawBusy() {
  const el = $('#busy');
  if (!BUSY.size) { clearTimeout(busyTimer); busyTimer = 0; el.classList.add('hidden'); return; }
  if (el.classList.contains('hidden')) {
    if (!busyTimer) busyTimer = setTimeout(() => { busyTimer = 0; if (BUSY.size) { el.classList.remove('hidden'); drawBusy(); } }, 150);
    return;
  }
  const t = [...BUSY].at(-1), pct = t.frac == null ? null : Math.round(t.frac * 100);
  el.classList.toggle('indet', pct == null);
  el.querySelector('.busy-fill').style.width = pct == null ? '' : `${pct}%`;
  el.querySelector('.busy-label').textContent = pct == null ? t.label : `${t.label} ${pct}%`;
}
const BUSY_LABELS = [[/\/to-input$/, 'Preparing image…'], [/\/inputs\/crop$/, 'Cropping…'], [/\/(upload|media)$/, 'Uploading…'],
  [/\/video\/render$/, 'Rendering video…'], [/\/scene\/render$/, 'Sending depth video…'], [/\/generate$/, 'Sending to ComfyUI…']];
function busyLabel(method, path) {
  if (method === 'DELETE') return 'Deleting…';
  const p = path.split('?')[0];
  return (BUSY_LABELS.find(([re]) => re.test(p)) || [null, 'Working…'])[1];
}

// action: { label, fn } adds a button (e.g. Undo) and keeps the toast up a little longer;
// with stay: true it stays until it's tapped or another toast replaces it
let toastTimer;
export function toast(msg, err = false, action = null) {
  const t = $('#toast');
  // replaceChildren() would turn a null into the text "null", so only pass the button when there is one
  t.replaceChildren(h('span', {}, msg), ...(action ? [button(action.label, () => { t.classList.add('hidden'); action.fn(); }, { cls: 'small toast-act' })] : []));
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  if (!action?.stay) toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 7000 : action ? 6000 : 2500);
}
export const undoToast = (msg, fn) => toast(msg, false, { label: '↶ Undo', fn });

// ---------------------------------------------------------------------------
// overlays and the back button: each sheet / full-screen editor adds a history entry, so Android's
// back gesture (and the browser's back) closes the top overlay instead of leaving the app.
// close(true) is called when it was closed by going back.
// ---------------------------------------------------------------------------
const OV = [];
let popSkip = 0;
export function overlayOpened(close) { OV.push(close); history.pushState({ deckOverlay: OV.length }, ''); }
export function overlayClosed(close) {
  const i = OV.lastIndexOf(close);
  if (i < 0) return;
  OV.splice(i, 1);
  popSkip++; history.back();
}
addEventListener('popstate', () => {
  if (popSkip) { popSkip--; return; }
  const close = OV.pop();
  if (close && close(true) === false) { OV.push(close); history.pushState({ deckOverlay: OV.length }, ''); }  // it said no (unsaved work)
});

// A full-screen editor (sketch pad, layout boxes): shown over everything, closed by its own buttons
// or the back gesture. With dirty() true, closing (or leaving the page) asks first.
// Returns close(viaBack, saved); it returns false when the user chose to stay.
export function openOverlay(el, { dirty = () => false, ask = 'Throw away your changes?', onClose = null } = {}) {
  const guard = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', guard);
  document.body.append(el);
  const close = (viaBack = false, saved = false) => {
    if (!saved && dirty() && !confirm(ask)) return false;
    onClose?.();
    removeEventListener('beforeunload', guard);
    el.remove();
    if (!viaBack) overlayClosed(back);
    return true;
  };
  const back = () => close(true);
  overlayOpened(back);
  return close;
}

// ---------------------------------------------------------------------------
// the bottom sheet. SHEET.seq counts sheets opened, so a slow lookup can tell whether its sheet is
// still the one showing; SHEET.gen is the generation a details sheet shows (it redraws on updates).
// ---------------------------------------------------------------------------
export const SHEET = { seq: 0, gen: null };
const sheetEl = () => $('#sheet');
export const sheetOpen = () => !sheetEl().classList.contains('hidden');
export function openSheet(...content) {
  SHEET.gen = null;
  SHEET.seq++;
  const wasOpen = sheetOpen();
  sheetEl().replaceChildren(
    h('button', { type: 'button', class: 'icon-btn close', onclick: () => closeSheet(), 'aria-label': 'Close' }, '✕'),
    ...content.flat().filter((c) => c != null && c !== false));
  sheetEl().classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
  if (!wasOpen) overlayOpened(sheetBack);
  return SHEET.seq;
}
const sheetBack = () => closeSheet(true);
export function closeSheet(viaBack = false) {
  if (!sheetOpen()) return;
  SHEET.gen = null;
  sheetEl().querySelectorAll('video').forEach((v) => v.pause());
  sheetEl().classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden');
  if (viaBack !== true) overlayClosed(sheetBack);  // (used as a click handler too, so viaBack may be an event)
}
export const sheetStillOpen = (seq) => seq === SHEET.seq && sheetOpen();

// A sheet that asks for a name and saves: save(name) may throw (shown as a toast) and closes it on success
export function nameSheet({ title, hint = null, placeholder = '', extra = null, saveLabel = 'Save', save }) {
  const name = h('input', { type: 'text', placeholder });
  openSheet(h('h3', {}, title), hint ? h('p', { class: 'hint sheet-hint' }, hint) : null, name, extra,
    actions(button(saveLabel, async () => {
      try { await save(name.value.trim()); closeSheet(); } catch (e) { toast(e.message, true); }
    }, { cls: 'primary' })));
  setTimeout(() => name.focus(), 50);
}

// ---------------------------------------------------------------------------
// widgets
// ---------------------------------------------------------------------------
// cls: the button's look after "btn" (small, primary, ghost, danger…, combined freely)
export const button = (text, onclick, { cls = 'small', ...attrs } = {}) =>
  h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick, ...attrs }, text);

// A square button with a symbol; the label is read out and shown on hover. Taps don't reach the
// row or card it sits in.
export const iconBtn = (label, text, fn, extra = {}) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label,
  ...extra, onclick: (e) => { e.stopPropagation(); fn(e); } }, text);

// A link that looks like a button (downloads, the workflow JSON)
export const linkBtn = (text, href, attrs = {}) => h('a', { class: 'btn small', href, ...attrs }, text);

// A row of buttons, as at the bottom of a sheet
export const actions = (...kids) => h('div', { class: 'actions' }, kids);

// A button that opens the file chooser (or the camera, with capture) and hands over the files picked
export function fileButton(text, onFiles, { accept, multiple = false, capture = null, cls = 'small' } = {}) {
  const input = h('input', { type: 'file', accept, multiple, capture, class: 'hidden' });
  input.addEventListener('change', () => { const fs = [...input.files]; input.value = ''; if (fs.length) onFiles(fs); });
  return h('span', { class: 'file-btn' }, button(text, () => input.click(), { cls }), input);
}

// Segmented control. options: [[value, label, title?]]. The tapped one lights up (el.set(v) does
// the same from code); with action: true they're plain buttons in a row and nothing stays lit.
export function seg(options, cur, onPick, { wrap = false, action = false, disabled = false } = {}) {
  const el = h('div', { class: 'seg' + (wrap ? ' wrap' : '') });
  el.set = (v) => { for (const b of el.children) b.classList.toggle('on', !action && b.dataset.v === String(v)); };
  el.append(...options.map(([v, label, title]) => h('button', { type: 'button', 'data-v': String(v), title, disabled,
    onclick: () => { el.set(v); onPick(v); } }, label)));
  el.set(cur);
  return el;
}

// A labelled setting: the label on the left, an optional note on the right (label: [text, note])
export function field(label, ...kids) {
  const [text, note] = Array.isArray(label) ? label : [label, null];
  return h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('span', {}, text), note), kids);
}

// A titled group of settings, the same look in every panel. onDone adds a Done button to the title.
export const section = (title, onDone, ...kids) => h('section', { class: 'section' },
  title != null ? h('div', { class: 'section-title' }, h('span', {}, title), onDone ? button('Done', onDone, { cls: 'small ghost' }) : null) : null, kids);

export const hint = (text, cls = '') => h('p', { class: `hint ${cls}`.trim() }, text);
export const placeholder = (text) => h('div', { class: 'placeholder' }, text);
export const note = (text, kind = 'warn') => h('div', { class: `note ${kind}` }, text);

// A slider with its value shown beside the label. onInput runs while dragging, onChange on letting go.
export function rangeField(label, get, set, { min, max, step, fmt = (v) => v.toFixed(2), onInput = null, onChange = null }) {
  const val = h('span', {}, fmt(get()));
  const r = h('input', { type: 'range', min, max, step, value: get() });
  r.addEventListener('input', () => { set(parseFloat(r.value)); val.textContent = fmt(get()); onInput?.(); });
  if (onChange) r.addEventListener('change', onChange);
  return field([label, val], r);
}

// A number box (drag it sideways like a slider). after() runs once the value is set (save and
// redraw); live is called while the box is dragged (after set), for a preview that doesn't rebuild the panel
export function propNum(label, value, set, after, { min = -1e6, max = 1e6, step = 1, live = null } = {}) {
  const input = h('input', { type: 'number', inputMode: 'decimal', min, max, step, value });
  const read = () => clamp(parseFloat(input.value) || 0, min, max);
  input.addEventListener('change', () => { set(read()); after(); });
  if (live) input.addEventListener('input', () => { if (input.dataset.scrubbing) { set(read()); live(); } });
  return field(label, input);
}

// A gallery card: a picture or clip, a badge over it, a caption (or meta: nodes for the caption row)
export function mediaCard(media, label, onclick, { badge = null, meta = null, attrs = {} } = {}) {
  const c = h('button', { type: 'button', class: 'card', ...attrs },
    h('div', { class: 'media' }, media, badge ? h('span', { class: 'play' }, badge) : null),
    h('div', { class: 'meta' }, meta || h('span', { class: 'name' }, label)));
  c.addEventListener('click', () => onclick(c));
  return c;
}

// The header of a saved-item library (shots, presets, snippets): a title, ◀ ▶ to step through,
// whatever buttons the caller adds, and where we are (pos, a span the caller keeps up to date).
export const cycleBar = ({ title, what, prev, next, buttons = [], pos, cls = '' }) =>
  h('div', { class: `part-head ${cls}`.trim() }, h('b', {}, title),
    iconBtn(`Previous ${what}`, '◀', prev), iconBtn(`Next ${what}`, '▶', next), buttons, pos);

// rows: [{ thumb (element), name, hint, sel, off, onclick, buttons: [elements] }]
export const layerRowsEl = (rows) => h('div', { class: 'layers' }, rows.map((r) =>
  h('div', { class: 'layer-row' + (r.sel ? ' sel' : '') + (r.off ? ' off' : ''), onclick: r.onclick },
    h('span', { class: 'thumb' }, r.thumb),
    h('div', { class: 'layer-name' }, h('span', {}, r.name), h('span', { class: 'hint' }, r.hint || '')),
    h('div', { class: 'layer-btns' }, r.buttons || []))));

// The panel's top row: the main action and, when there's something to clear, Clear all
export const panelTop = (main, clear = null) => h('div', { class: 'row panel-top' }, main,
  clear ? button('Clear all', clear, { cls: 'ghost' }) : null);
