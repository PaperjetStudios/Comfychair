// node tests/depth_range.test.mjs
import assert from 'node:assert/strict';
import { frameRanges } from '../web/depth-range.js';

const frames = (fn, n) => Array.from({ length: n }, (_, i) => fn(i));
const spread = (a, b, k = 200) => Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));

// a camera that pulls back: the subject goes from 1-2 m to 6-8 m away
const pull = frames((i) => (i < 60 ? spread(1, 2) : spread(6, 8)), 120);
const clip = frameRanges(pull, { mode: 'clip' }), follow = frameRanges(pull);
// one range: the far half is squeezed (6-8 m inside a 1-8 m range); following, each half fills its own
const share = ([n, f], a, b) => (1 / a - 1 / b) / (1 / n - 1 / f);   // (the share of the grey scale, inverse depth)
assert.ok(share(clip[100], 6, 8) < 0.1, 'whole clip squeezes the far half');
assert.ok(share(follow[100], 6, 8) > 0.8, 'following gives the far half most of the greys');
assert.ok(share(follow[10], 1, 2) > 0.8);
// no jumps between frames
for (let i = 1; i < follow.length; i++) assert.ok(follow[i][1] / follow[i - 1][1] < 1.25 && follow[i - 1][1] / follow[i][1] < 1.25, `smooth at ${i}`);
// every frame's own depths fit inside its range
follow.forEach(([n, f], i) => { const s = pull[i]; assert.ok(n <= Math.min(...s) * 1.0001 && f >= Math.max(...s) * 0.99, `covers ${i}`); });

// a stray far wall pixel (1 of 200) doesn't set the range
const stray = frames(() => [...spread(1, 2, 199), 50], 10);
assert.ok(frameRanges(stray, { mode: 'clip' })[0][1] < 3, 'outlier ignored');
// frames with nothing in view borrow a neighbour's
const gap = frames((i) => (i === 3 ? [] : spread(2, 3)), 6);
assert.deepEqual(frameRanges(gap)[3], frameRanges(gap)[2]);
// nothing at all: a sane default
assert.deepEqual(frameRanges([[], []])[0], [0.3, 10]);
console.log('depth_range ok');
