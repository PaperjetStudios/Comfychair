import test from 'node:test';
import assert from 'node:assert/strict';
import { resultName, modelOf, runName, templateProcess } from '../web/run-name.js';

test('runName: the process, the model, the LoRAs', () => {
  assert.equal(runName('Blended', { template: 'deck-klein9b-edit', params: { '4.__loras': [{ name: 'klein/fusion2250.safetensors', strength: 1 }] } }), 'Blended · Klein 9B · fusion2250');
  assert.equal(runName('Edited', { template: 'deck-qwen21-edit', params: {} }), 'Edited · Qwen 2.1');
  assert.equal(runName('Edited', { template: 'deck-ph3-edit', params: {} }), 'Edited · P-H3-Image');
  assert.equal(runName('Pika Ref2V', { template: 'deck-h3-pika-ref2v', params: {} }), 'Pika Ref2V · MiniMax H3');
  assert.equal(runName('Removed', { template: 'deck-remove-lama' }), 'Removed · LaMa');
});
test('runName: says nothing twice, leaves out LoRAs switched off', () => {
  assert.equal(runName('Klein 9B detail', { template: 'deck-klein9b-i2i', params: {} }), 'Klein 9B detail');
  assert.equal(runName('Run', { template: 'deck-h3-ref2v', params: { '30.__loras': [{ name: 'h3/turbo.safetensors', enabled: false }, { name: 'h3/style.safetensors' }] } }), 'Run · MiniMax H3 · style');
});
test('runName: no family names the file; another file than the template\'s own is named', () => {
  assert.equal(runName('Upscaled', { template: 'deck-upscale-image-fast', params: { '2.model_name': '4x-UltraSharp.pth' } }), 'Upscaled · 4x-UltraSharp');
  const templates = [{ id: 'deck-h3-ref2v', fields: [{ key: '1.unet_name', value: 'a.safetensors' }] }];
  assert.equal(runName('Run', { template: 'deck-h3-ref2v', params: { '1.unet_name': 'a.safetensors' } }, templates), 'Run · MiniMax H3');
  assert.equal(runName('Run', { template: 'deck-h3-ref2v', params: { '1.unet_name': '10Eros_Max.safetensors' } }, templates), 'Run · MiniMax H3 · 10Eros_Max');
});
test('runName: a run with nothing known is just the process', () => {
  assert.equal(runName('Cut out', { template: 'deck-cutout-image', params: {} }), 'Cut out');
  assert.equal(runName('#12', null), '#12');
});
test('modelOf and templateProcess', () => {
  assert.equal(modelOf('deck-krea2-depth-control'), 'Krea 2');
  assert.equal(modelOf('deck-upscale-image'), 'SeedVR2');
  assert.equal(modelOf('deck-upscale-image-fast'), null);
  assert.equal(templateProcess('deck klein3 control'), 'control');
  assert.equal(templateProcess('deck krea2 depth control'), 'depth control');
  assert.equal(templateProcess('deck h3 ctrl2v hold'), 'ctrl2v hold');
  assert.equal(templateProcess('deck klein3'), 'deck klein3');
  assert.equal(templateProcess('Klein 9B Edit'), 'Edit');
  assert.equal(templateProcess('Qwen 2.1 Edit'), 'Edit');
  assert.equal(templateProcess('P-H3 Edit'), 'Edit');   // (not "P- Edit": the model's whole name goes)
  assert.equal(templateProcess('H3 Pika Ref2V'), 'Pika Ref2V');
  assert.equal(templateProcess('H3 Ctrl2V Hold'), 'Ctrl2V Hold');
  assert.equal(templateProcess('My own'), 'My own');
});

test('a finished run names itself from its own template', () => {
  const templates = [{ id: 'deck-ltx-i2v', name: 'deck ltx i2v', fields: [] }];
  assert.equal(resultName({ id: 7, template: 'deck-ltx-i2v' }, templates), 'i2v · LTX-2.5');
  assert.equal(resultName({ id: 7, template: 'mine' }, []), 'mine');
  assert.equal(resultName({ id: 7 }, templates), '#7');
});
