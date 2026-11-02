// node --test tests/editor_engine.test.mjs: createEditor's functions share one scope, where a second function of the same name silently
// replaces the first everywhere. Two called layerPicture sent Image tools the wrong part of a cropped layer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('no function in createEditor is declared twice', () => {
  const names = [...readFileSync(new URL('../web/editor-engine.js', import.meta.url), 'utf8').matchAll(/^  (?:async )?function (\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});
