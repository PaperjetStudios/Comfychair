// The Output tab: what a frame comes out at, for every frame with a picture (image, video, 3D). The frame's size on the table is only
// how big its preview is; this size is what runs, renders and exports use (frame.out, table-model.js outputOf). Several frames: one
// size for all. It draws again whenever the size changes, wherever from (Make's Size field, Undo, an image fitting its layers).
import { h, section } from './ui.js';
import { sidebar } from './sidebar.js';
import { sizePicker } from './size-picker.js';
import { HAS_OUTPUT, outputOf } from './table-model.js';
import { frameById, setOutputs } from './table.js';

const el = sidebar.pane('output');
const MODES = new Map();   // frame id -> { mode, key }: the chips picked, while they still describe its size

function draw() {
  const ctx = sidebar.context();
  const list = (ctx.live ? [ctx.live] : ctx.frames || []).map((f) => frameById(f.id) || f).filter((f) => HAS_OUTPUT.has(f.kind));
  if (!list.length) { el.replaceChildren(); return; }
  const first = list[0], o = outputOf(first), ids = list.map((f) => f.id), key = `${o.w}x${o.h}`;
  const was = MODES.get(first.id);
  const picker = sizePicker({ label: 'Output size', w: o.w, h: o.h, mode: was?.key === key ? was.mode : null, lim: (n) => Math.min(8192, Math.max(16, n)),
    onChange: (w, hh, mode) => { MODES.set(first.id, { mode, key: `${w}x${hh}` }); setOutputs(ids, { w, h: hh }); } });
  picker.classList.add('output-size');
  el.replaceChildren(section(list.length > 1 ? `Output · ${list.length} frames` : 'Output', null, picker));
}

const hereNow = () => sidebar.current() === 'output';
sidebar.onShow((name) => { if (name === 'output') draw(); });
for (const ev of ['table:select', 'table:live', 'table:unlive', 'table:output']) addEventListener(ev, () => { if (hereNow()) queueMicrotask(draw); });
addEventListener('table:frame-field', (e) => { if (hereNow() && e.detail?.keys?.includes('out')) draw(); });
if (hereNow()) draw();
