import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('updating a stylesheet preserves cached JavaScript and other assets', async () => {
  const entries = new Map(), handlers = new Map();
  const cache = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    delete: async (req) => entries.delete(req.url),
    put: async (req, res) => entries.set(req.url, res),
  };
  const context = vm.createContext({
    URL, Response,
    location: { origin: 'https://deck.test' },
    self: { addEventListener: (type, fn) => handlers.set(type, fn) },
    caches: { open: async () => cache },
  });
  vm.runInContext(await readFile(new URL('../web/sw.js', import.meta.url), 'utf8'), context);
  for (const path of ['app.css?v=1', 'core.js?v=1', 'media.js?v=1']) entries.set(`https://deck.test/${path}`, {});
  await context.keep(new Request('https://deck.test/app.css?v=2'), {});
  assert.equal(entries.has('https://deck.test/app.css?v=1'), false);
  assert.equal(entries.has('https://deck.test/core.js?v=1'), true);
  assert.equal(entries.has('https://deck.test/media.js?v=1'), true);
  await context.keep(new Request('https://deck.test/core.js?v=3'), {});
  assert.equal(entries.has('https://deck.test/core.js?v=1'), false);
  assert.equal(entries.has('https://deck.test/app.css?v=2'), true);
  assert.equal(entries.has('https://deck.test/media.js?v=1'), true);
});

test('activating the app worker leaves unrelated caches alone', async () => {
  const handlers = new Map(), deleted = [];
  const context = vm.createContext({
    self: { addEventListener: (type, fn) => handlers.set(type, fn), clients: { claim: async () => {} } },
    caches: {
      keys: async () => ['comfydeck-shell-v13', 'comfydeck-shell-v14', 'another-app'],
      delete: async (name) => deleted.push(name),
    },
  });
  vm.runInContext(await readFile(new URL('../web/sw.js', import.meta.url), 'utf8'), context);
  let done;
  handlers.get('activate')({ waitUntil(pending) { done = pending; } });
  await done;
  assert.deepEqual(deleted, ['comfydeck-shell-v13']);
});
