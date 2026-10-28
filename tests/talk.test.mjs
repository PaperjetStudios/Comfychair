// Run by tests/test_talk.py (node tests/talk.test.mjs): the talking shot's prompt, length and line key.
import assert from 'node:assert/strict';
import * as T from '../web/talk.js';

const p = T.talkPrompt({ who: 'Mara', look: 'a woman in her thirties, dark curly hair.', text: 'We go "now".', delivery: 'quietly' });
assert.equal(p, 'Mara, a woman in her thirties, dark curly hair, looks into the camera and speaks, quietly, saying: "We go \'now\'." ' + T.TALK_HINT);
assert.ok(T.talkPrompt({ text: 'Hi.' }).startsWith('The person looks into the camera and speaks, saying: "Hi."'));
assert.ok(T.talkPrompt({}).startsWith('The person looks into the camera and speaks. '));
assert.ok(T.talkPrompt({ text: 'Hi.', scene: 'A kitchen at night.' }).startsWith('A kitchen at night. The person'));

assert.equal(T.talkSeconds(8.48), 9);      // a little after the last word, on a quarter second
assert.equal(T.talkSeconds(2), 2.5);
assert.equal(T.talkSeconds(0), 1);
assert.equal(T.talkSeconds(30, 20), 20);

const L = { voice: 'v1', engine: 'qwen', delivery: '', text: ' Hello ' };
assert.equal(T.talkKey(L), T.talkKey({ ...L, text: 'Hello' }));
assert.notEqual(T.talkKey(L), T.talkKey({ ...L, engine: 'fish' }));
assert.notEqual(T.talkKey(L), T.talkKey({ ...L, delivery: 'angry' }));
assert.equal(T.TALK_TPL, 'deck-ltx-a2v');
console.log('talk ok');
