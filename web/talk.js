// ---------------------------------------------------------------------------
// talking shots: a picture of someone (a character's main picture, a shot's frame) and a line they say, spoken by
// the Sound tab's voice engines, to a clip of them saying it with their lips in time (deck-ltx-a2v: the sound is
// kept as it is while the picture is made). VFX → Talking shot uses it, and Story's Talking shot.
// No DOM here, so the node tests load it.
// ---------------------------------------------------------------------------
export const TALK_TPL = 'deck-ltx-a2v';
export const TALK_ENGINES = [['qwen', 'Qwen'], ['index', 'IndexTTS-2'], ['fish', 'Fish S2']];
// what keeps the mouth busy and the rest calm (tested 2026-10-28: a quoted line plus this keeps lips with the words)
export const TALK_HINT = 'Their lips move in time with every word; natural small head movements and blinks. The camera holds still.';

const end = (s) => String(s || '').trim().replace(/[.\s]+$/, '');

// the prompt for a talking shot: who (a name, else "The person"), their look, the line in quotes, how it is said
export function talkPrompt({ who = '', look = '', text = '', delivery = '', scene = '' } = {}) {
  const name = end(who) || 'The person', words = String(text || '').trim().replace(/"/g, '\'');
  const how = end(delivery);
  return [scene ? `${end(scene)}.` : '',
    `${name}${end(look) ? `, ${end(look)},` : ''} looks into the camera and speaks${how ? `, ${how}` : ''}${words ? `, saying: "${words}"` : '.'}`,
    TALK_HINT].filter(Boolean).join(' ');
}

// the clip's length for a line of `seconds` (a little after the last word), within the template's Length range
export const talkSeconds = (seconds, max = 20) => Math.min(max, Math.max(1, Math.ceil((+seconds || 0) * 4 + 2) / 4));

// what a spoken line was made from: when it changes the line needs speaking again
export const talkKey = (L) => [L?.voice || '', L?.engine || '', L?.delivery || '', String(L?.text || '').trim()].join('|');
