// node --test tests/meters.test.mjs: the top bar's PC meter words (web/meters.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { METERS, meterWords } from '../web/meters.js';

test('five lines, each its own colour', () => {
  assert.deepEqual(METERS.map((m) => m[0]), ['cpu', 'ram', 'gpu', 'vram', 'temp']);
  assert.equal(new Set(METERS.map((m) => m[2])).size, 5);
});
test('the numbers behind the lines', () => {
  const w = meterWords({ cpu: 12.4, ram: 50, gpu: null, vram: 25, vram_used_mb: 3072, vram_total_mb: 12288, temp_c: 61.6 });
  assert.equal(w, 'CPU 12%\nRAM 50%\nGPU –\nVRAM 25% (3.0 of 12.0 GB)\nTemp 62°C');
});
