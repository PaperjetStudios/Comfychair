import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../web/', import.meta.url);
const graph = new Map();
for (const name of (await readdir(root)).filter((n) => n.endsWith('.js'))) {
  const source = await readFile(new URL(name, root), 'utf8');
  graph.set(name, [...source.matchAll(/\b(?:from\s*|import\s*)['"]\.\/([\w-]+\.js)['"]/g)].map((m) => m[1]));
}

test('generation, media and image editing have no static import cycles', () => {
  const done = new Set();
  function visit(name, path = []) {
    assert.ok(!path.includes(name), `Import cycle: ${[...path, name].join(' → ')}`);
    if (done.has(name)) return;
    for (const next of graph.get(name) || []) visit(next, [...path, name]);
    done.add(name);
  }
  for (const name of ['generate.js', 'make.js', 'media.js', 'editor-engine.js', 'clip-effects.js']) visit(name);
});

test('shared services do not import screen modules', () => {
  const screens = new Set(['app.js', 'run.js', 'generate.js', 'editor.js', 'editor-engine.js', 'board.js', 'video.js', 'vfx.js', 'sound.js', 'story.js', 'scene.js']);
  for (const name of ['run-state.js', 'notifications.js', 'generation-data.js', 'crop-geometry.js', 'clip-effects.js']) {
    assert.deepEqual(graph.get(name).filter((dep) => screens.has(dep)), [], `${name} must remain below the screens`);
  }
});
