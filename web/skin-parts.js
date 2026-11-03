// The Skin detail tool: the body parts it is told to do, each its own pass, and what the model is told for each.
// Pure logic (node --test tests/skin_parts.test.mjs).
import { termsOf } from './matte-edge.js';

export const partsOf = (text) => termsOf(text, 8);

// what the model draws a part at: more on a large picture, where a part can be far bigger than 1024 px
export const partSize = ([w, h]) => (Math.max(w, h) > 2048 ? 1536 : 1024);

// the prompt for one part: {part} is where its name goes (a prompt without it is sent as written)
export const partPrompt = (prompt, part) => String(prompt).replaceAll('{part}', part.replace(/^(the|a|an)\s+/i, ''));

