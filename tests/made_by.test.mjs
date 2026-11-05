// node --test tests/made_by.test.mjs: every 3D template says what made it
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { madeBy } from '../web/made-by.js';

test('the names', () => {
  assert.equal(madeBy({ template: 'deck-3d-object' }), 'Pixal3D');
  assert.equal(madeBy({ template: 'deck-3d-object-trellis' }), 'TRELLIS.2');
  assert.equal(madeBy({ template: 'deck-3d-object-hunyuan21' }), 'Hunyuan 3D 2.1');
  assert.equal(madeBy({ template: 'deck-autorig-any' }), 'UniRig');
  assert.equal(madeBy({ template: 'deck-h3-i2v' }), null);
  assert.equal(madeBy(null), null);
});
test('the name fits what the template runs', () => {
  const nodes = (id) => Object.values(JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url)))).map((n) => n.class_type);
  assert.ok(nodes('deck-3d-object').includes('Pixal3DConditioning'));
  assert.ok(nodes('deck-3d-object-multi').includes('Pixal3DMultiViewConditioning'));
  assert.ok(nodes('deck-3d-object-trellis').includes('Trellis2Conditioning'));
  assert.ok(nodes('deck-3d-object-hunyuan21').includes('Hunyuan3Dv2Conditioning'));
  assert.ok(nodes('deck-autorig-human').includes('MIAAutoRig'));
  assert.ok(nodes('deck-autorig-any').includes('UniRigAutoRig'));
});
test('a new 3D object template gets a name', () => {
  for (const f of readdirSync(new URL('../templates/', import.meta.url))) {
    if (/^deck-(3d-object|autorig)/.test(f)) assert.ok(madeBy({ template: f.replace('.json', '') }), f);
  }
});
