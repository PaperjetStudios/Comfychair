// node --test tests/frame_picks.test.mjs: which frames Frames to layers takes, and where their pictures go (web/frame-picks.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrames, framesText, addFrames, timeOf, gridSpots } from '../web/frame-picks.js';

test('numbers are frames, a number with s is seconds, last is the end; the rest is left out and nothing is taken twice', () => {
  assert.deepEqual(parseFrames('4, 54 96;1.5s, last, 4, x, -3'), [{ frame: 4 }, { frame: 54 }, { frame: 96 }, { t: 1.5 }, { frame: 'last' }, { frame: 3 }].slice(0, 5));
  assert.deepEqual(parseFrames(''), []);
  assert.deepEqual(parseFrames(null), []);
  assert.equal(framesText(parseFrames('4,54 , 2s,last')), '4, 54, 2s, last');
});

test('picked frames are added to the box in order, without repeats', () => {
  assert.equal(addFrames('54, 4', [96, 4, 12]), '4, 12, 54, 96');
  assert.equal(addFrames('2s, last, 10', [5, 'last']), '5, 10, 2s, last');
  assert.equal(addFrames('', [7]), '7');
});

test('a frame is taken at its middle, seconds as they are, last far past the end', () => {
  assert.equal(timeOf({ frame: 0 }, 24), 0.5 / 24);
  assert.equal(timeOf({ frame: 48 }, 24), 48.5 / 24);
  assert.equal(timeOf({ t: 1.5 }, 24), 1.5);
  assert.ok(timeOf({ frame: 'last' }, 24) > 1e6);
});

test('pictures go left to right then down, each centred in a cell as big as the biggest', () => {
  const same = [{ w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }];
  assert.deepEqual(gridSpots(same, 4), [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 50 }]);
  assert.deepEqual(gridSpots(same.slice(0, 2), 2, 8), [{ x: 0, y: 0 }, { x: 108, y: 0 }]);
  assert.deepEqual(gridSpots([{ w: 100, h: 100 }, { w: 50, h: 40 }], 2), [{ x: 0, y: 0 }, { x: 125, y: 30 }]);
  assert.deepEqual(gridSpots(same.slice(0, 2), 9), [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
});
