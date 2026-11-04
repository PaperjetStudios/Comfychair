import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The Video and VFX engines can be mounted into any host (a frame on a table): only the page's own wiring
// (wireVideoTransport / wireVfx) and the one TabSet per kind may look the page's elements up by id.
const src = (name) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');
const body = (s, head) => {   // the text of a top-level function, up to the next line starting with "}"
  const i = s.indexOf(head);
  assert.ok(i >= 0, `missing ${head}`);
  return s.slice(i, s.indexOf('\n}', i) + 2);
};
const lookups = (s) => [...s.matchAll(/\$\(\s*['"`]#[^'"`]*['"`]\s*\)|getElementById\([^)]*\)|querySelector(?:All)?\(\s*['"`]#[^)]*\)/g)].map((m) => m[0]);

for (const [file, wire, once, exportsWanted] of [
  ['video.js', 'export function wireVideoTransport() {', 'function wireOnce() {', ['mountVideo', 'videoStill', 'videoTabs', 'wireVideoTransport']],
  ['vfx.js', 'export function wireVfx() {', 'function wireOnce() {', ['mountVfx', 'vfxStill', 'vfxTabs', 'wireVfx']],
]) {
  test(`${file}: no fixed element lookups outside the page's wiring`, async () => {
    const s = await src(file);
    const page = body(s, wire), tabsOnce = body(s, once);
    const rest = s.replace(page, '').replace(tabsOnce, '');
    assert.deepEqual(lookups(rest), []);
    assert.deepEqual(lookups(tabsOnce), [`$('#tab-${file === 'video.js' ? 'video' : 'vfx'}')`]);   // (the TabSet host, for now)
  });
  test(`${file}: exports the mount, the still and the tabs`, async () => {
    const s = await src(file);
    for (const name of exportsWanted) assert.match(s, new RegExp(`export (?:async )?(?:function|const) ${name}\\b`));
  });
}

test('video.js: the timeline strip is only searched inside the mounted timeline', async () => {
  const all = await src('video.js'), s = all.replace(body(all, 'export function wireVideoTransport() {'), '');
  const uses = [...s.matchAll(/['"`]#timeline\b[^'"`]*['"`]/g)].map((m) => m[0]);
  assert.deepEqual(uses, ["'#timeline'"]);   // timeline.js's el, until it takes an element
});

test('a mount of the same host does nothing; per-mount listeners go with an AbortController', async () => {
  const v = await src('video.js'), f = await src('vfx.js');
  assert.match(body(v, 'export function mountVideo('), /if \(VD\.host === host\) return;/);
  assert.match(body(f, 'export function mountVfx('), /if \(VF\.host === host\) return;/);
  assert.match(body(v, 'export function mountVideo('), /mounted\?\.abort\(\)/);
  assert.match(body(f, 'export function mountVfx('), /delete stage\.dataset\.want/);
});
