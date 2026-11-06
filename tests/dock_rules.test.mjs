import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockZones, dockSide, dockIndex, dockWidth, dockHeight, isRow } from '../web/dock-rules.js';

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

// ---- rows: above and below the work area ----
const area = { left: 300, right: 1300, top: 100, bottom: 800 };
const at2 = (x, y, cols = {}, s = null) => dockSide(x, dockZones(area, s, cols), y);

test('a drop along the work area\'s top or bottom docks in a row there; its sides still win the corners', () => {
  assert.equal(at2(800, 110), 'top');
  assert.equal(at2(800, 790), 'bottom');
  assert.equal(at2(800, 450), null);
  assert.equal(at2(310, 110), 'left');
  assert.equal(at2(1290, 790), 'right');
});

test('a drop over the bars above or below the work area docks in the row on that side', () => {
  assert.equal(at2(800, 40), 'top');
  assert.equal(at2(800, 860), 'bottom');
});

test('a drop on a row on show joins it, and a row is never matched without a y', () => {
  assert.equal(at2(800, 200, { top: { left: 300, right: 1300, top: 100, bottom: 320 } }), 'top');
  assert.equal(at2(800, 600, { bottom: { left: 300, right: 1300, top: 580, bottom: 800 } }), 'bottom');
  assert.equal(dockSide(800, dockZones(area, null, {})), null);
});

test('a row\'s place among its panels goes by x, and its height stays between 120 px and half the window', () => {
  assert.equal(dockIndex(500, [400, 900]), 1);
  assert.equal(dockHeight(50, 1000), 120);
  assert.equal(dockHeight(900, 1000), 500);
  assert.equal(dockHeight(null, 1000), 220);
  assert.equal(isRow('top') && isRow('bottom') && !isRow('mid'), true);
});
