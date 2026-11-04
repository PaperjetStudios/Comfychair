// A table frame or an off-screen job opens its document quietly (TabSet.openQuiet): the Classic screen's remembered
// tab (deck.tab.<kind>) stays the one it last showed. Checked on the sources: TabSet needs a page to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('frame modules open documents quietly, never with switchTo', () => {
  for (const f of ['frame-image.js', 'frame-video.js', 'frame-sound.js', 'frame-scene.js', 'frame-story.js']) {
    assert.doesNotMatch(src(f), /\.switchTo\(/, f);
  }
});

test('a quiet open does not write the remembered tab; the screen shown takes its own back', () => {
  const t = src('tabs.js');
  assert.match(t, /if \(!quiet\) store\.set\(`deck\.tab\.\$\{this\.kind\}\.\$\{this\.key\}`, doc\.id\)/);
  assert.match(t, /openQuiet\(id\) \{ return this\.switchTo\(id, \{ quiet: true \}\); \}/);
  assert.match(t, /docStrip\(this\.host, this\.mount, \(\) => \{ this\.reclaim\(\);/);
});
