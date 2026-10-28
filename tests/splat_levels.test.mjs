// Run by tests/test_splat_levels_js.py (node tests/splat_levels.test.mjs): which splat file the view and renders load.
import assert from 'node:assert/strict';
import * as L from '../web/splat-levels.js';

const o = {
  url: '/a/x_light.ply',
  levels: [{ k: 'full', url: '/a/x_full.ply', n: 1200000 }, { k: 'light', url: '/a/x_light.ply', n: 150000 },
    { k: 'medium', url: '/a/x_medium.ply', n: 300000 }, { k: 'dense', url: '/a/x_dense.ply', n: 600000 }],
};
assert.equal(L.previewUrl(o, 'light'), '/a/x_light.ply');
assert.equal(L.previewUrl(o, 'medium'), '/a/x_medium.ply');
assert.equal(L.previewUrl(o, 'dense'), '/a/x_dense.ply');
assert.equal(L.previewUrl(o, 'full'), '/a/x_full.ply');
assert.equal(L.renderUrl(o), '/a/x_full.ply');

// a small splat: only light and its full set; asking for dense gets light (the densest under it)
const small = { url: '/b/s.ply', levels: [{ k: 'light', url: '/b/s_light.ply', n: 150000 }, { k: 'full', url: '/b/s.ply', n: 200000 }] };
assert.equal(L.previewUrl(small, 'dense'), '/b/s_light.ply');
assert.equal(L.renderUrl(small), '/b/s.ply');
// full set not kept: renders take the densest level
const noFull = { url: '/c/a_light.ply', levels: [{ k: 'light', url: '/c/a_light.ply' }, { k: 'medium', url: '/c/a_medium.ply' }] };
assert.equal(L.renderUrl(noFull), '/c/a_medium.ply');
// nothing light enough: the lightest there is
assert.equal(L.previewUrl({ url: '/d', levels: [{ k: 'dense', url: '/d_dense' }, { k: 'full', url: '/d_full' }] }, 'light'), '/d_dense');
// no levels (an older splat, an .spz): its own url, always
for (const x of [{ url: '/e.spz' }, { url: '/e.spz', levels: [] }, { url: '/e.spz', levels: [{ k: 'bogus', url: '/z' }] }]) {
  assert.equal(L.previewUrl(x, 'light'), '/e.spz'); assert.equal(L.renderUrl(x), '/e.spz');
}
assert.equal(L.levelFor({ url: '/e' }, 'full'), null);
// the input isn't reordered
assert.equal(o.levels[0].k, 'full');

assert.equal(L.fileOf('/files/projects/My%20P/.deck/assets/ab/x%20y_light.ply?v=2'), 'x y_light.ply');
assert.equal(L.countLabel(150000), '150k');
assert.equal(L.countLabel(1234567), '1.2M');
assert.equal(L.countLabel(950), '950');
assert.equal(L.levelName('medium'), 'Medium');

// per-device choices
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
let ls = mem();
assert.equal(L.previewLevel(true, ls), 'light');
assert.equal(L.previewLevel(false, ls), 'dense');
L.setPreviewLevel('medium', ls);
assert.equal(L.previewLevel(true, ls), 'medium');
L.setPreviewLevel('nonsense', ls);
assert.equal(L.previewLevel(true, ls), 'medium');
assert.equal(L.sharpOn(ls), false);
L.setSharp(true, ls);
assert.equal(L.sharpOn(ls), true);
assert.deepEqual(L.makeChoices(true, ls), { preview: 'light', keepFull: true });
L.setMakeChoices({ preview: 'full', keepFull: false }, ls);
assert.deepEqual(L.makeChoices(true, ls), { preview: 'full', keepFull: false });
ls = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
assert.equal(L.previewLevel(false, ls), 'dense');
L.setSharp(true, ls);   // (doesn't throw)
assert.equal(L.previewLevel(true, null), 'light');

console.log('splat levels ok');
