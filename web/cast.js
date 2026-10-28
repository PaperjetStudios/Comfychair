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
    case 'krea': return kreaTag(n);
    case 'moss': return `image ${n}`;
    default: return null;
  }
}

// Krea 2 edit: Qwen3-VL sees the picture being edited, then the reference; two references share that second image,
// side by side
export const kreaTag = (n) => (n <= 1 ? 'the first image' : n === 2 ? 'the second image' : 'the right half of the second image');

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

// ---- look packs: a character's named views, and which one a shot's camera wants ----
// c.views: { front, three, side, back, face } -> input names (any may be missing); c.sheet: the views composed into
// one picture (POST /api/looks/sheet). A shot's reference picture for a character is picked from its framing: a
// close-up wants the face, a profile the side, from behind the back, else the front or three-quarter; the shot can
// name one instead (s.refs[character id]: 'auto' | 'main' | 'sheet' | a view).
export const VIEWS = [['front', 'Front'], ['three', 'Three-quarter'], ['side', 'Side'], ['back', 'Back'], ['face', 'Face']];
export const VIEW_KEYS = VIEWS.map(([k]) => k);
export const viewLabel = (k) => VIEWS.find(([v]) => v === k)?.[1] || (k === 'sheet' ? 'Sheet' : k === 'main' ? 'Main picture' : k);
// what Make the views asks deck-krea2-identity for, and at what size (portrait for the body, square for the face).
// Tested on the robot character 2026-10-28: at 832×1216 the three-quarter and side views often came back as two
// figures side by side; 704×1280 with "alone in the centre" gave one every time. A back view keeps the jacket's back
// but the identity LoRA may still turn the head (face) to the camera: redo it, or pick a picture.
const STUDIO = 'Plain light grey studio background, soft even light. Same outfit, same colours.';
const ALONE = 'Full body, head to toe, the character alone in the centre of the frame,';
export const VIEW_PROMPTS = {
  front: [`${ALONE} facing the camera, seen straight from the front, arms relaxed at the sides.`, 704, 1280],
  three: [`${ALONE} turned 45 degrees to the left: a three-quarter view.`, 704, 1280],
  side: [`${ALONE} standing in profile, seen exactly from the side, facing left.`, 704, 1280],
  back: [`${ALONE} rear view: turned 180 degrees, facing away from the camera, so we see only the back of the head and the back of the outfit.`, 704, 1280],
  face: ['Close-up portrait of the character\'s face, head and shoulders, looking straight at the camera.', 1024, 1024],
};
export const viewPrompt = (k) => `${VIEW_PROMPTS[k][0]} ${STUDIO}`;

// the view a shot's camera wants: from its size, its angle, then its words
export function wantedView(s = {}) {
  if (s.size === 'close' || s.size === 'ecu') return 'face';
  if (s.angle === 'side') return 'side';
  if (s.angle === 'back') return 'back';
  const t = `${s.what || ''}`.toLowerCase();
  if (/\b(from behind|from the back|back to (the )?camera|back view|walks away)\b/.test(t)) return 'back';
  if (/\b(in profile|profile view|side view|from the side|side-on)\b/.test(t)) return 'side';
  if (/\b(close[- ]?up|portrait)\b/.test(t)) return 'face';
  return s.size === 'medium' ? 'three' : 'front';
}
// the order to look for a view in when the pack lacks the wanted one
const FALLBACK = { face: ['face', 'three', 'front'], side: ['side', 'three', 'front'], back: ['back', 'side', 'front'],
  three: ['three', 'front', 'side'], front: ['front', 'three', 'side'] };
export const packViews = (c) => VIEW_KEYS.filter((k) => c?.views?.[k]);
export const mainOf = (c) => (c?.main && c.pics?.includes(c.main) ? c.main : c?.pics?.[0] || null);

// the picture to show a model for c in shot s: { name, view } (view: a view key, 'sheet' or 'main'), or null
export function refPicture(c, s = {}, choice = s?.refs?.[c?.id] || 'auto') {
  if (!c) return null;
  const v = c.views || {};
  if (choice === 'sheet' && c.sheet) return { name: c.sheet, view: 'sheet' };
  if (choice === 'main' && mainOf(c)) return { name: mainOf(c), view: 'main' };
  if (VIEW_KEYS.includes(choice) && v[choice]) return { name: v[choice], view: choice };
  const k = FALLBACK[wantedView(s)].find((x) => v[x]);
  if (k) return { name: v[k], view: k };
  const m = mainOf(c);
  return m ? { name: m, view: 'main' } : c.sheet ? { name: c.sheet, view: 'sheet' } : null;
}
// every picture a look check compares a result to: the views, else the main picture
export const packPictures = (c) => { const p = packViews(c).map((k) => c.views[k]); return p.length ? p : [mainOf(c)].filter(Boolean); };
