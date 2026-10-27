// ---------------------------------------------------------------------------
// dialogue scripts for the Sound tab's voice tools: one line each,
//   Name (delivery words): text with optional [inline tags]
// The delivery part is optional. No DOM here, so the node tests can load it.
// ---------------------------------------------------------------------------
export const DELIVERY = ['whispering', 'shouting', 'angry', 'sad', 'happy', 'excited', 'scared', 'nervous', 'calm',
  'sarcastic', 'crying', 'laughing', 'tired', 'seductive', 'serious', 'surprised'];
export const INLINE_TAGS = ['laugh', 'sigh', 'pause', 'breath', 'gasp', 'cough', 'whisper', 'emphasis', 'clears throat', 'sniff'];

// the start of a line: indent, name, optional (delivery), colon and the spaces after it
const HEAD = /^(\s*)([^:()[\]\n]{1,60}?)\s*(?:\(([^)\n]*)\))?\s*:[ \t]*/;

// {name, delivery (string or null), text} for a line that starts with a name, else null
export function parseLine(raw) {
  const m = String(raw).match(HEAD);
  if (!m || !m[2].trim()) return null;
  const d = (m[3] || '').trim();
  return { name: m[2].trim(), delivery: d || null, text: raw.slice(m[0].length).trim() };
}

// The script as lines for POST /api/voice/speak, or {error} for the first line that can't be spoken.
// voices: [{id, name}]; matched by name, any case.
export function parseScript(script, voices, { language = null, intensity = 0.7 } = {}) {
  const byName = new Map((voices || []).map((v) => [v.name.toLowerCase(), v]));
  const lines = [];
  for (const raw of String(script || '').split('\n')) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) return { error: `Start the line with a voice's name and a colon: “${raw.trim().slice(0, 40)}”` };
    const v = byName.get(p.name.toLowerCase());
    if (!v) return { error: `No voice called “${p.name}”: save one first` };
    if (!p.text) return { error: `${v.name}'s line has nothing to say: write the words after the colon` };
    lines.push({ voice: v.id, text: p.text, language, who: v.name, delivery: p.delivery, intensity });
  }
  return lines.length ? { lines } : { error: 'Write a line first' };
}

const lineAt = (value, pos) => {
  const start = value.lastIndexOf('\n', pos - 1) + 1, nl = value.indexOf('\n', pos);
  return { start, end: nl < 0 ? value.length : nl };
};
// put a new start on the line at pos (replacing `old` chars of it); the cursor keeps its place in the text
function reHead(value, pos, start, old, head) {
  const next = value.slice(0, start) + head + value.slice(start + old);
  const at = pos >= start + old ? pos + head.length - old : start + head.length;
  return { value: next, pos: at };
}

// "Name: " at the start of the cursor's line (or the line's name swapped, keeping its delivery)
export function withName(value, pos, name) {
  const { start, end } = lineAt(value, pos);
  const m = value.slice(start, end).match(HEAD);
  if (m && m[2].trim()) return reHead(value, pos, start, m[0].length, `${m[1]}${name}${m[3] != null ? ` (${m[3].trim()})` : ''}: `);
  const lead = value.slice(start, end).match(/^\s*/)[0].length;
  return reHead(value, pos, start + lead, 0, `${name}: `);
}

// a delivery word in the line's "(…)" after its name; null when the line has no name yet
export function withDelivery(value, pos, word) {
  const { start, end } = lineAt(value, pos);
  const m = value.slice(start, end).match(HEAD);
  if (!m || !m[2].trim()) return null;
  const words = (m[3] || '').split(',').map((w) => w.trim()).filter(Boolean);
  if (!words.includes(word)) words.push(word);
  return reHead(value, pos, start, m[0].length, `${m[1]}${m[2].trim()} (${words.join(', ')}): `);
}
