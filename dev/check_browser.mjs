// Optional browser regression checks. Uses a mock backend and temporary data only.
// npm install --no-save --package-lock=false playwright && npx playwright install chromium
// node dev/check_browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.DECK_PLAYWRIGHT || 'playwright');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const python =
  process.env.DECK_PYTHON || (existsSync(join(cwd, '.venv/bin/python')) ? join(cwd, '.venv/bin/python') : 'python3');
const scratch = mkdtempSync(join(tmpdir(), 'comfydeck-browser-'));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const mockPort = await freePort(),
  port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const children = [
  spawn(python, ['dev/mock_comfy.py', '--port', String(mockPort)], { cwd, stdio: 'ignore' }),
  spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      DECK_DATA: scratch,
      DECK_COMFY_DIR: '',
      DECK_TOKEN: '',
      COMFY_URL: `http://127.0.0.1:${mockPort}`,
    },
  }),
];
let b;
const errors = [],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickTool(p, name) {
  await p.evaluate((name) => document.querySelector(`.tabs button[data-tab="${name}"]`).click(), name);
  await p.waitForFunction((name) => document.querySelector(`#tab-${name}`).classList.contains('active'), name);
}
async function waitReady(p, name) {
  await p.waitForFunction(
    (name) =>
      document.querySelector(`#tab-${name} .tabchip.on`) &&
      !document.querySelector(`#tab-${name}`).hasAttribute('aria-busy'),
    name,
  );
}
(async () => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/api/status')).ok) break;
    } catch {}
    await sleep(100);
  }
  b = await chromium.launch({
    headless: true,
    ...(process.env.DECK_CHROME ? { executablePath: process.env.DECK_CHROME } : {}),
  });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
  p.on('pageerror', (e) => errors.push(e.message));
  let delay = true;
  await p.route('**/api/store/vfx-tabs**', async (route) => {
    if (delay && route.request().method() === 'GET') await sleep(1200);
    await route.continue();
  });
  await p.goto(origin);
  await p.locator('#fields details.group').first().waitFor();
  await clickTool(p, 'vfx');
  await p.waitForFunction(() => document.querySelector('#tab-vfx').getAttribute('aria-busy') === 'true');
  assert.equal(await p.locator('#vfxBody select[aria-label=Effect]').evaluate((e) => !!e.closest('[inert]')), true);
  await waitReady(p, 'vfx');
  delay = false;
  const effect = p.locator('#vfxBody select[aria-label=Effect]');
  await effect.selectOption('depth');
  await sleep(1300);
  assert.equal(await effect.inputValue(), 'depth');
  await p.reload();
  await waitReady(p, 'vfx');
  assert.equal(await effect.inputValue(), 'depth');
  console.log('PASS delayed loading blocks edits and preserves saved choices');
  await p.locator('#vfxPanel [aria-label="New tab"]').click();
  await p.waitForFunction(() => document.querySelectorAll('#vfxPanel .tab-switch').length === 2);
  await p.locator('#vfxPanel .tab-switch[aria-selected=true]').focus();
  await p.keyboard.press('Home');
  await p.waitForFunction(() =>
    document.querySelector('#vfxPanel .tab-switch[aria-selected=true]').textContent.includes('Shot 1'),
  );
  await p.locator('#vfxPanel .tab-switch').nth(1).focus();
  await p.keyboard.press('Enter');
  await p.waitForFunction(() =>
    document.querySelector('#vfxPanel .tab-switch[aria-selected=true]').textContent.includes('Shot 2'),
  );
  console.log('PASS document tabs use arrow/Home keys and native Enter activation');
  await p.locator('#prefsBtn').click();
  assert.equal(await p.evaluate(() => document.querySelector('#sheet').contains(document.activeElement)), true);
  assert.equal(await p.locator('#sheet').getAttribute('aria-labelledby'), 'sheet-title');
  for (let i = 0; i < 20; i++) {
    await p.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    assert.equal(await p.evaluate(() => document.querySelector('#sheet').contains(document.activeElement)), true);
  }
  assert.equal(await p.locator('.topbar').evaluate((e) => e.inert), true);
  await p.keyboard.press('Escape');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'prefsBtn');
  assert.equal(await p.locator('.topbar').evaluate((e) => e.inert), false);
  console.log('PASS dialog naming, focus trap, background isolation, and focus restoration');
  const v = await p.evaluate(() => new URL(document.querySelector('script[type=module]').src).search);
  await p.evaluate(async (q) => {
    const ui = await import('/ui.js' + q);
    const box = ui.h(
      'div',
      { id: 'test-overlay', style: 'position:fixed;inset:0;z-index:100;background:black' },
      ui.button('Inner', () => {}),
    );
    window.closeTestOverlay = ui.openOverlay(box);
    ui.openSheet(
      ui.h('h3', {}, 'Nested sheet'),
      ui.button('Nested action', () => {}),
    );
  }, v);
  assert.equal(await p.evaluate(() => document.querySelector('#sheet').contains(document.activeElement)), true);
  assert.equal(await p.locator('#sheet').evaluate((e) => e.inert), false);
  await p.keyboard.press('Escape');
  assert.equal(await p.evaluate(() => document.querySelector('#test-overlay').contains(document.activeElement)), true);
  await p.evaluate(() => window.closeTestOverlay());
  await sleep(100);
  assert.equal(await p.locator('.topbar').evaluate((e) => e.inert), false);
  console.log('PASS nested sheet over editor restores the correct focus scope');
  await clickTool(p, 'history');
  assert.equal(await p.locator('.actionbar').isVisible(), false);
  await clickTool(p, 'generate');
  assert.equal(await p.locator('.actionbar').isVisible(), true);
  await clickTool(p, 'editor');
  await waitReady(p, 'editor');
  await p.goBack();
  await p.waitForFunction(() => document.querySelector('#tab-generate').classList.contains('active'));
  await p.locator('#prefsBtn').click();
  await p.goBack();
  await p.waitForFunction(() => document.querySelector('#sheet').classList.contains('hidden'));
  assert.equal(await p.locator('#tab-generate').evaluate((e) => e.classList.contains('active')), true);
  console.log('PASS Back closes dialogs before navigating; History hides Generate controls');
  await p.locator('.spaces button[data-space=edit]').click();
  await p.waitForFunction(() => document.querySelector('#tab-editor').classList.contains('active'));
  assert.equal(
    await p.evaluate(() => document.getAnimations().some((a) => a.effect?.target?.classList?.contains('tab'))),
    false,
  );
  await clickTool(p, 'video');
  await waitReady(p, 'video');
  await clickTool(p, 'sound');
  await waitReady(p, 'sound');
  await clickTool(p, 'story');
  await waitReady(p, 'story');

  await clickTool(p, 'vfx');
  const created = await p.request.post(origin + '/api/projects', { data: { name: 'Loading regression' } });
  const project = await created.json();
  await p.waitForFunction(
    (id) => [...document.querySelector('#projectSel').options].some((o) => o.value === String(id)),
    project.id,
  );
  delay = true;
  await p.locator('#projectSel').selectOption(String(project.id));
  await p.waitForFunction(() => document.querySelector('#tab-vfx').getAttribute('aria-busy') === 'true');
  await waitReady(p, 'vfx');
  delay = false;
  assert.equal(await effect.inputValue(), 'ripple');
  console.log('PASS project switches block old document controls until the new document loads');
  let fail = true;
  await p.unroute('**/api/store/vfx-tabs**');
  await p.route('**/api/store/vfx-tabs**', async (route) => {
    if (fail && route.request().method() === 'GET') {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Test connection failure' }),
      });
    } else await route.continue();
  });
  await p.reload();
  await p.locator('#tab-vfx .document-loading button').waitFor();
  assert.equal(await effect.evaluate((e) => !!e.closest('[inert]')), true);
  await p.locator('#tab-vfx .document-loading button').click();
  await waitReady(p, 'vfx');
  assert.equal(await effect.evaluate((e) => !!e.closest('[inert]')), false);
  console.log('PASS failed document loads remain blocked and Retry restores editing');
  await clickTool(p, 'generate');
  await waitReady(p, 'generate');
  await p.locator('#tplSel').selectOption('example_txt2img');
  await p.locator('#genBtn').click();
  await p.waitForFunction(() => !!document.querySelector('#viewerMedia img'), null, { timeout: 30000 });
  const generated = (await (await p.request.get(origin + '/api/generations')).json()).find((g) => g.status === 'done');
  assert.ok(generated, 'mock generation finishes and enters history');
  await clickTool(p, 'board');
  await p.locator(`#board .tile[data-gen="${generated.id}"]`).first().waitFor();
  await clickTool(p, 'history');
  await p.locator(`#historyGrid .card[data-gen="${generated.id}"]`).waitFor();
  console.log('PASS queue adoption, live result, Board and History round trip');
  assert.deepEqual(errors, []);
  console.log('PASS reduced motion, editor loading, and no browser errors');
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await b?.close();
    children.forEach((c) => c.kill());
  });
