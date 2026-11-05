// The Output tab: what a frame comes out at. Its size, for every frame with a picture (image, video, 3D): the frame's size on the table
// is only how big its preview is; this size is what runs, renders and exports use (frame.out, table-model.js outputOf). Its length, for a
// video or sound frame whose workflow has one (frame.len, sent at Run). Several frames: one value for all. It draws again whenever the size changes, wherever from (Make's Size field, Undo, an image fitting its layers).
import { h, rangeField, section } from './ui.js';
import { S } from './core.js';
import { frameLength } from './make-rules.js';
import { sidebar } from './sidebar.js';
import { sizePicker } from './size-picker.js';
import { HAS_OUTPUT, outputOf } from './table-model.js';
import { frameById, setLengths, setOutputs } from './table.js';

const el = sidebar.pane('output');
const MODES = new Map();   // frame id -> { mode, key }: the chips picked, while they still describe its size

const MAX_SECS = { video: 60, sound: 300 };
const templateOf = (f) => (S.templates || []).find((t) => t.id === f.make?.template) || null;

function sizeEl(list) {
  const first = list[0], o = outputOf(first), ids = list.map((f) => f.id), key = `${o.w}x${o.h}`;
  const was = MODES.get(first.id);
  const picker = sizePicker({ label: 'Output size', w: o.w, h: o.h, mode: was?.key === key ? was.mode : null, lim: (n) => Math.min(8192, Math.max(16, n)),
    onChange: (w, hh, mode) => { MODES.set(first.id, { mode, key: `${w}x${hh}` }); setOutputs(ids, { w, h: hh }); } });
  picker.classList.add('output-size');
  return picker;
}
function lengthEl(list) {
  let secs = frameLength(list[0], templateOf(list[0]));
  return rangeField('Length', () => secs, (v) => { secs = v; }, { min: 1, max: Math.max(...list.map((f) => MAX_SECS[f.kind])), step: 1, fmt: (v) => `${v} s`,
    onChange: () => setLengths(list.map((f) => f.id), secs) });
}
function draw() {
  const ctx = sidebar.context();
  const list = (ctx.live ? [ctx.live] : ctx.frames || []).map((f) => frameById(f.id) || f);
  const sized = list.filter((f) => HAS_OUTPUT.has(f.kind)), timed = list.filter((f) => MAX_SECS[f.kind] && frameLength(f, templateOf(f)) != null);
  if (!sized.length && !timed.length) { el.replaceChildren(); return; }
  const n = new Set([...sized, ...timed]).size;
  el.replaceChildren(section(n > 1 ? `Output · ${n} frames` : 'Output', null, sized.length ? sizeEl(sized) : null, timed.length ? lengthEl(timed) : null));
}

const hereNow = () => sidebar.current() === 'output';
sidebar.onShow((name) => { if (name === 'output') draw(); });
for (const ev of ['table:select', 'table:live', 'table:unlive', 'table:output']) addEventListener(ev, () => { if (hereNow()) queueMicrotask(draw); });
addEventListener('table:frame-field', (e) => { if (hereNow() && (e.detail?.keys?.includes('out') || e.detail?.keys?.includes('len'))) draw(); });
if (hereNow()) draw();
