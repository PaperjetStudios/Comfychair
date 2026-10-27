// Run by tests/test_dialogue.py (node tests/dialogue.test.mjs): the Sound tab's dialogue scripts.
import assert from 'node:assert/strict';
import * as D from '../web/dialogue.js';

// lines: name, optional (delivery), text with [tags] kept as written
assert.deepEqual(D.parseLine('Anna (whispering): Did you [gasp] hear that?'), { name: 'Anna', delivery: 'whispering', text: 'Did you [gasp] hear that?' });
assert.deepEqual(D.parseLine('  Narrator:Nobody had.'), { name: 'Narrator', delivery: null, text: 'Nobody had.' });
assert.deepEqual(D.parseLine('Anna (): hi'), { name: 'Anna', delivery: null, text: 'hi' });
assert.equal(D.parseLine('no colon here'), null);
assert.equal(D.parseLine('[laugh]: x'), null);

const voices = [{ id: 'a1', name: 'Anna' }, { id: 'n1', name: 'Narrator' }];
const r = D.parseScript('anna (sad, tired): Go.\n\nNarrator: She went. [sigh]', voices, { language: 'English', intensity: 0.5 });
assert.deepEqual(r.lines, [
  { voice: 'a1', text: 'Go.', language: 'English', who: 'Anna', delivery: 'sad, tired', intensity: 0.5 },
  { voice: 'n1', text: 'She went. [sigh]', language: 'English', who: 'Narrator', delivery: null, intensity: 0.5 },
]);
assert.match(D.parseScript('Anna (angry):', voices).error, /nothing to say/);
assert.match(D.parseScript('Anna:   ', voices).error, /nothing to say/);
assert.match(D.parseScript('Bob: hi', voices).error, /No voice called “Bob”/);
assert.match(D.parseScript('hello', voices).error, /Start the line/);
assert.match(D.parseScript('\n \n', voices).error, /Write a line/);

// name chips: at the start of the cursor's line, or swapping the line's name (delivery kept)
assert.deepEqual(D.withName('', 0, 'Anna'), { value: 'Anna: ', pos: 6 });
assert.deepEqual(D.withName('a\nhello', 4, 'Anna'), { value: 'a\nAnna: hello', pos: 10 });
assert.deepEqual(D.withName('Bob (sad): hi', 13, 'Anna'), { value: 'Anna (sad): hi', pos: 14 });
assert.deepEqual(D.withName('Bob: hi', 1, 'Anna'), { value: 'Anna: hi', pos: 6 });

// delivery chips: into the "(…)" after the name; null without a name
assert.deepEqual(D.withDelivery('Anna: hi', 8, 'whispering'), { value: 'Anna (whispering): hi', pos: 21 });
assert.deepEqual(D.withDelivery('Anna (sad): hi', 0, 'tired'), { value: 'Anna (sad, tired): hi', pos: 19 });
assert.equal(D.withDelivery('Anna (sad): hi', 3, 'sad').value, 'Anna (sad): hi');
assert.deepEqual(D.withDelivery('x\nAnna: ', 8, 'calm'), { value: 'x\nAnna (calm): ', pos: 15 });
assert.equal(D.withDelivery('hello', 2, 'calm'), null);

console.log('dialogue ok');
