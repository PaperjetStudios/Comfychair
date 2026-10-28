// ---------------------------------------------------------------------------
// cast: a project's characters in writing (no DOM here, so the node tests load it). Shot text names a character
// with @Name (any case; names may have spaces, the longest name that fits wins) or as the speaker of a line
// ("MARA: words", "@Mara (quietly): words"). A prompt made from that text says the names plainly and adds each
// character's look, pointing at their picture in the template's own reference syntax when it has one.
// A character: { id, name, desc, look, notes, pics: [input names], main (one of pics), voice (a voice id) }.
// ---------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLength = (list) => [...(list || [])].filter((c) => c.name?.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);

// the character an @ at i in text names (the longest name that fits), with how long the mention is
function mentionAt(text, i, list) {
  for (const c of byLength(list)) {
    const n = c.name.trim();
    if (text.substr(i + 1, n.length).toLowerCase() === n.toLowerCase() && !/[\p{L}\p{N}]/u.test(text[i + 1 + n.length] || '')) return { c, len: n.length + 1 };
  }
  return null;
}

// a line of dialogue: { who, paren, text } (who as written, without the @), else null
export function speakerOf(line) {
  const m = String(line).trim().match(/^@?([\p{L}][\p{L}\p{N} .'-]{0,40}?)\s*(\([^)]*\))?\s*:\s*(.*)$/u);
  return m ? { who: m[1].trim(), paren: m[2] || '', text: m[3] } : null;
}
export const findCharacter = (list, name) => (list || []).find((c) => c.name?.trim().toLowerCase() === String(name || '').trim().toLowerCase()) || null;

// the characters a text names, in the order they first come up (mentions and speakers)
export function mentioned(text, list) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  const s = String(text || '');
  for (const line of s.split('\n')) {
    const sp = speakerOf(line);
    if (sp) add(findCharacter(list, sp.who));
    for (let i = line.indexOf('@'); i >= 0; i = line.indexOf('@', i + 1)) add(mentionAt(line, i, list)?.c);
  }
  return out;
}

// the text with each @Name written plainly ("@mara" -> "Mara")
export function plain(text, list) {
  const s = String(text || '');
  let out = '', i = 0;
  while (i < s.length) {
    const m = s[i] === '@' ? mentionAt(s, i, list) : null;
    if (m) { out += m.c.name.trim(); i += m.len; } else out += s[i++];
  }
  return out;
}

// the @Name being typed just before the cursor: { from, query } (query may be empty), else null
export function typing(text, pos) {
  const before = String(text || '').slice(0, pos), at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && /[\p{L}\p{N}]/u.test(before[at - 1]))) return null;
  const q = before.slice(at + 1);
  return q.length <= 30 && /^[\p{L}\p{N}.'-]*( [\p{L}\p{N}.'-]*)?$/u.test(q) ? { from: at, query: q } : null;   // (names of up to two words)
}
export const suggest = (list, query) => {
  const q = String(query || '').toLowerCase();
  return (list || []).filter((c) => c.name?.trim() && c.name.toLowerCase().startsWith(q)).slice(0, 8);
};

// a reference picture's tag in a template's prompt syntax (n counts the template's picture inputs from 1)
export function pictureTag(style, n) {
  switch (style) {
    case 'h3': return `<Picture ${n}>`;
    case 'klein': return `<ref_image_${n - 1}>`;
    case 'qwen': return `Picture ${n}`;
    default: return null;
  }
}

// One line per character for a prompt: who they are and how they look, and their picture when the template has it
// (pics: Map character id -> picture number). "Mara: a woman in a red coat (as in Picture 2)."
export function castLines(chars, { style = null, pics = new Map() } = {}) {
  return chars.map((c) => {
    const look = [c.look, !c.look?.trim() ? c.desc : ''].map((x) => String(x || '').trim().replace(/[.\s]+$/, '')).filter(Boolean).join(', ');
    const n = pics.get(c.id), tag = n ? pictureTag(style, n) : null;
    if (!look && !tag) return '';
    if (style === 'h3') return `${c.name.trim()} is ${look || 'the person'}${tag ? `, as shown in ${tag}` : ''}.`;
    return `${c.name.trim()}: ${look || 'as pictured'}${tag ? ` (as in ${tag})` : ''}.`;
  }).filter(Boolean);
}

// The words of a shot's dialogue for each speaking character, in order: [{ c, who, text, paren }]
export function dialogueLines(text, list) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const sp = speakerOf(line);
    if (!sp || !sp.text.trim()) continue;
    const c = findCharacter(list, sp.who);
    if (c || sp.who === sp.who.toUpperCase()) out.push({ c, who: c ? c.name.trim() : sp.who, text: plain(sp.text.trim(), list), paren: sp.paren });
  }
  return out;
}
