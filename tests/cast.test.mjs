// Run by tests/test_cast.py (node tests/cast.test.mjs): characters in shot text (web/cast.js).
import assert from 'node:assert/strict';
import * as C from '../web/cast.js';

const mara = { id: 'm', name: 'Mara', look: 'a woman in a red raincoat', desc: 'the keeper' };
const lee = { id: 'l', name: 'Mara Lee', look: 'her sister, grey coat', desc: '' };
const tom = { id: 't', name: 'Tom', look: '', desc: 'a fisherman.' };
const list = [mara, lee, tom];

// mentions: @Name in any case, the longest name that fits, speakers of lines; in the order they come up
assert.deepEqual(C.mentioned('@tom waves at @Mara Lee. @Mara laughs', list), [tom, lee, mara]);
assert.deepEqual(C.mentioned('MARA: He isn\'t coming.\n@Tom (quietly): He is.', list), [mara, tom]);
assert.deepEqual(C.mentioned('@Marathon runners, @nobody', list), []);
assert.deepEqual(C.mentioned('mail@Tom.com', list), [tom]);   // (an @ inside a word still names someone: harmless)

// plainly written
assert.equal(C.plain('@mara and @mara lee meet @Tom.', list), 'Mara and Mara Lee meet Tom.');
assert.equal(C.plain('no one @here', list), 'no one @here');

// the name being typed before the cursor
assert.deepEqual(C.typing('Then @Ma', 8), { from: 5, query: 'Ma' });
assert.deepEqual(C.typing('Then @', 6), { from: 5, query: '' });
assert.deepEqual(C.typing('Then @Mara Lee', 14), { from: 5, query: 'Mara Lee' });
assert.equal(C.typing('a@b', 3), null);
assert.equal(C.typing('@Mara walks to the door', 23), null);
assert.deepEqual(C.suggest(list, 'ma').map((c) => c.id), ['m', 'l']);

// speakers and their lines
assert.deepEqual(C.speakerOf('MARA (whispers): Go.'), { who: 'MARA', paren: '(whispers)', text: 'Go.' });
assert.equal(C.speakerOf('She opens the door.'), null);
assert.deepEqual(C.dialogueLines('MARA: Go, @tom.\nShe turns.\nNARRATOR: Later.\nsomeone: no', list),
  [{ c: mara, who: 'Mara', text: 'Go, Tom.', paren: '' }, { c: null, who: 'NARRATOR', text: 'Later.', paren: '' }]);

// prompt lines in each model's syntax
const pics = new Map([['m', 2]]);
assert.deepEqual(C.castLines([mara, tom], { style: 'qwen', pics }), ['Mara: a woman in a red raincoat (as in Picture 2).', 'Tom: a fisherman.']);
assert.deepEqual(C.castLines([mara], { style: 'klein', pics }), ['Mara: a woman in a red raincoat (as in <ref_image_1>).']);
assert.deepEqual(C.castLines([mara], { style: 'h3', pics }), ['Mara is a woman in a red raincoat, as shown in <Picture 2>.']);
assert.deepEqual(C.castLines([{ id: 'x', name: 'X', look: '', desc: '' }]), []);
console.log('cast ok');
