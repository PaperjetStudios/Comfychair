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
assert.equal(C.pictureTag('moss', 2), 'image 2');
assert.deepEqual(C.castLines([mara], { style: 'krea', pics }), ['Mara: a woman in a red raincoat (as in the second image).']);
assert.equal(C.pictureTag('krea', 1), 'the first image');
assert.equal(C.pictureTag('krea', 3), 'the right half of the second image');
assert.deepEqual(C.castLines([{ id: 'x', name: 'X', look: '', desc: '' }]), []);

// look packs: the view a shot's camera wants
assert.equal(C.wantedView({ size: 'close' }), 'face');
assert.equal(C.wantedView({ size: 'ecu', angle: 'side' }), 'face');
assert.equal(C.wantedView({ size: 'wide', angle: 'side' }), 'side');
assert.equal(C.wantedView({ angle: 'back' }), 'back');
assert.equal(C.wantedView({ what: '@Mara walks away down the pier' }), 'back');
assert.equal(C.wantedView({ what: 'Mara in profile against the window' }), 'side');
assert.equal(C.wantedView({ what: 'a close-up of Mara' }), 'face');
assert.equal(C.wantedView({ size: 'medium' }), 'three');
assert.equal(C.wantedView({ size: 'wide' }), 'front');
assert.equal(C.wantedView({}), 'front');

// the reference picture: the wanted view, a fallback view, the main picture; the shot's own choice first
const full = { id: 'm', name: 'Mara', pics: ['p1', 'p2'], main: 'p2', sheet: 'sh',
  views: { front: 'vf', three: 'v3', side: 'vs', back: 'vb', face: 'vface' } };
assert.deepEqual(C.refPicture(full, { size: 'close' }), { name: 'vface', view: 'face' });
assert.deepEqual(C.refPicture(full, { angle: 'side' }), { name: 'vs', view: 'side' });
assert.deepEqual(C.refPicture(full, { angle: 'back' }), { name: 'vb', view: 'back' });
assert.deepEqual(C.refPicture(full, { size: 'medium' }), { name: 'v3', view: 'three' });
assert.deepEqual(C.refPicture(full, { size: 'wide' }), { name: 'vf', view: 'front' });
assert.deepEqual(C.refPicture(full, { size: 'close', refs: { m: 'sheet' } }), { name: 'sh', view: 'sheet' });
assert.deepEqual(C.refPicture(full, { size: 'close', refs: { m: 'main' } }), { name: 'p2', view: 'main' });
assert.deepEqual(C.refPicture(full, { size: 'close', refs: { m: 'back' } }), { name: 'vb', view: 'back' });
const some = { id: 's', name: 'S', pics: ['p1'], views: { front: 'vf', side: null } };
assert.deepEqual(C.refPicture(some, { size: 'close' }), { name: 'vf', view: 'front' });     // no face: the front
assert.deepEqual(C.refPicture(some, { angle: 'back' }), { name: 'vf', view: 'front' });
assert.deepEqual(C.refPicture(some, { angle: 'side', refs: { s: 'side' } }), { name: 'vf', view: 'front' });   // asked for a missing view
assert.deepEqual(C.refPicture(some, { refs: { s: 'sheet' } }), { name: 'vf', view: 'front' });   // no sheet yet
assert.deepEqual(C.refPicture({ id: 'n', name: 'N', pics: ['p1'] }, { size: 'close' }), { name: 'p1', view: 'main' });
assert.equal(C.refPicture({ id: 'e', name: 'E', pics: [] }, {}), null);
assert.deepEqual(C.packPictures(some), ['vf']);
assert.deepEqual(C.packPictures({ pics: ['p1'] }), ['p1']);
assert.deepEqual(C.packViews(full), ['front', 'three', 'side', 'back', 'face']);
assert.match(C.viewPrompt('side'), /profile.*grey studio/);
console.log('cast ok');
