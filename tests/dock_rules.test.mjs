import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockZones, dockSide, dockIndex, dockWidth } from '../web/dock-rules.js';

const main = { left: 0, right: 1000 }, split = { left: 680, right: 696 };
const at = (x, s = split, cols = {}, m = main) => dockSide(x, dockZones(m, s, cols));

test('a drop near the work area\'s sides or the splitter docks there, elsewhere it floats', () => {
  assert.equal(at(10), 'left');
  assert.equal(at(990), 'right');
  assert.equal(at(660), 'mid');
  assert.equal(at(690), 'mid');
  assert.equal(at(500), null);
  assert.equal(at(800), null);   // (over the sidebar)
});

test('no splitter (portrait, or a screen without a sidebar): no place beside the sidebar', () => {
  assert.equal(at(660, null), null);
  assert.equal(at(10, null), 'left');
});

test('a drop on a dock column joins it', () => {
  assert.equal(at(1150, split, { right: { left: 1000, right: 1300 } }), 'right');
  assert.equal(at(150, split, { left: { left: 0, right: 300 } }, { left: 300, right: 1000 }), 'left');
  assert.equal(at(500, { left: 700, right: 716 }, { mid: { left: 400, right: 700 } }), 'mid');
});

test('a dropped panel goes before the first panel whose middle is below the pointer', () => {
  assert.equal(dockIndex(50, [100, 300]), 0);
  assert.equal(dockIndex(200, [100, 300]), 1);
  assert.equal(dockIndex(400, [100, 300]), 2);
  assert.equal(dockIndex(10, []), 0);
});

test('a column\'s width stays between 220 px and half the window', () => {
  assert.equal(dockWidth(100, 1600), 220);
  assert.equal(dockWidth(1200, 1600), 800);
  assert.equal(dockWidth(null, 1600), 300);
  assert.equal(dockWidth(333.4, 1600), 333);
});
