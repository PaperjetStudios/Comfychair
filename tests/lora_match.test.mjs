// node --test tests/lora_match.test.mjs: searching a list of LoRAs (web/lora-match.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldersOf, matchNames, withLora } from '../web/lora-match.js';

const list = ['krea/Anime_Style.safetensors', 'krea/detail_tweaker-v2.safetensors', 'qwen/more-detail.safetensors', 'qwen/Detail Slider.safetensors'];

test('nothing typed: the whole list, in its order', () => assert.deepEqual(matchNames(list, '  '), list));
test('case and separators do not matter, every word must be there, in any order', () => {
  assert.deepEqual(matchNames(list, 'ANIME style'), ['krea/Anime_Style.safetensors']);
  assert.deepEqual(matchNames(list, 'tweaker detail'), ['krea/detail_tweaker-v2.safetensors']);
  assert.deepEqual(matchNames(list, 'detail-tweak'), ['krea/detail_tweaker-v2.safetensors']);
  assert.deepEqual(matchNames(list, 'nothing like it'), []);
});
test('a name starting with the first word comes first, the rest stay in order', () => {
  const short = ['more-detail', 'x detail', 'detail one', 'detail two'];
  assert.deepEqual(matchNames(short, 'detail'), ['detail one', 'detail two', 'more-detail', 'x detail']);
});
test('it can search what is shown, not the value', () => {
  const objs = [{ n: 'a', t: 'Blue' }, { n: 'b', t: 'Red' }];
  assert.deepEqual(matchNames(objs, 'red', (o) => o.t), [objs[1]]);
});

test('folders: each once, sorted, a name with no folder adds none', () => assert.deepEqual(foldersOf(['qwen/a', 'krea/b', 'qwen/c', 'd']), ['krea', 'qwen']));
test('a downloaded LoRA takes the empty row, else a new one, and never goes in twice', () => {
  const on = { name: 'a', strength: 0.5, enabled: false };
  assert.deepEqual(withLora([on, { name: '', strength: 0.7, enabled: true }], 'b'), [on, { name: 'b', strength: 0.7, enabled: true }]);
  assert.deepEqual(withLora([on], 'b'), [on, { name: 'b', strength: 1, enabled: true }]);
  assert.equal(withLora([on], 'a'), null);
});
