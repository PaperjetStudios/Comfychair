import test from 'node:test';
import assert from 'node:assert/strict';
import { dropKind, draggingPicture, pictureLinks, pictureName } from '../web/drop-files.js';

test('the dragged <img> comes before the page it links to', () => {
  assert.deepEqual(pictureLinks({ html: '<a href="https://a.test/p"><img alt="x" src="https://a.test/i.jpg?a=1&amp;b=2"></a>', uris: 'https://a.test/p\r\n' }),
    ['https://a.test/i.jpg?a=1&b=2', 'https://a.test/p']);
});

test('data-src is not src, and an inline picture is the last resort', () => {
  assert.deepEqual(pictureLinks({ html: "<img data-src='https://a.test/lazy.jpg' src='data:image/gif;base64,AAAA'>", uris: 'https://a.test/page' }),
    ['https://a.test/page', 'data:image/gif;base64,AAAA']);
});

test('uri-list comments, Firefox\'s url + title, repeats and other schemes', () => {
  assert.deepEqual(pictureLinks({ uris: '# a comment\nhttps://a.test/i.png\nfile:///etc/passwd\njavascript:x', moz: 'https://a.test/i.png\nA title' }), ['https://a.test/i.png']);
  assert.deepEqual(pictureLinks({ moz: 'https://a.test/m.png\nA title' }), ['https://a.test/m.png']);
  assert.deepEqual(pictureLinks(), []);
});

test('a name from the link, with an extension for its type', () => {
  assert.equal(pictureName('https://a.test/x/cat%20one.webp?s=1', 'image/webp'), 'cat_one.webp');
  assert.equal(pictureName('https://a.test/photo', 'image/jpeg'), 'photo.jpg');
  assert.equal(pictureName('https://a.test/', 'image/png'), 'dropped.png');
  assert.equal(pictureName('data:image/gif;base64,AAAA', 'image/gif'), 'dropped.gif');
});

test('a file with no type is known by its name', () => {
  assert.equal(dropKind({ type: '', name: 'a.WEBP' }), 'image');
  assert.equal(dropKind({ type: 'image/webp', name: 'x' }), 'image');
  assert.equal(dropKind({ type: '', name: 'a.txt' }), null);
});

test('a browser\'s link counts as a picture being dragged, text does not', () => {
  assert.ok(draggingPicture({ types: ['Files'] }));
  assert.ok(draggingPicture({ types: ['text/uri-list', 'text/html'] }));
  assert.ok(draggingPicture({ types: ['text/x-moz-url'] }));
  assert.ok(!draggingPicture({ types: ['text/plain', 'text/html'] }));
  assert.ok(!draggingPicture(null));
});
