/** Real Tauri UI/SQLite regression for the default-scene star and overlapping resyncs. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-default-'));
const artifacts = resolve(process.argv[2] || 'test-results/default-scene');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
let app, browser, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function start() {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  app = spawn(resolve(local.targetDir, 'debug/launchflow.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LAUNCHFLOW_TEST_DATA_DIR: dataDir,
      // Pixel assertions compare CSS sRGB; do not inherit the display's HDR/ICC transform.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--force-color-profile=srgb --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(250);
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible({
    timeout: 15000,
  });
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = null;
  app?.kill();
  await sleep(400);
}
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const card = (name) =>
  page.locator('.scene-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function holdResync() {
  await page.evaluate(async () => {
    const original = window.fetch;
    const test = (window.__defaultTest = {
      original,
      held: false,
      saved: false,
      hold: true,
      bootstraps: 0,
    });
    window.fetch = async (input, ...args) => {
      const command = new URL(String(input)).pathname.slice(1);
      const response = await original(input, ...args);
      if (command === 'bootstrap') test.bootstraps++;
      if (command === 'set_default_scene') test.saved = true;
      if (command === 'bootstrap' && test.hold) {
        test.hold = false;
        test.held = true;
        await new Promise((resolve) => {
          test.release = resolve;
        });
      }
      return response;
    };
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
      event: 'launchflow://resync',
      payload: null,
    });
  });
  await page.waitForFunction(() => window.__defaultTest.held);
}
async function releaseResync() {
  await page.waitForFunction(() => window.__defaultTest.saved);
  await page.evaluate(() => window.__defaultTest.release());
  await page.waitForFunction(() => window.__defaultTest.bootstraps >= 2);
}
async function assertStar(name, selected, file) {
  const button = card(name).getByRole('button', {
    name: selected ? '取消默认启动' : '设为默认启动场景',
    exact: true,
  });
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-pressed', String(selected));
  const fill = await button.locator('svg path').evaluate((el) => getComputedStyle(el).fill);
  assert.equal(fill === 'none', !selected, 'SVG path fill must reflect the selection');
  const path = join(artifacts, file);
  await button.locator('svg').screenshot({ path });
  if (selected) {
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const pixel = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.Drawing; $starBitmap=[System.Drawing.Bitmap]::new(${quote(path)}); try { $starPixel=$starBitmap.GetPixel([int][Math]::Floor($starBitmap.Width/2),[int][Math]::Floor($starBitmap.Height/2)); @($starPixel.R,$starPixel.G,$starPixel.B) | ConvertTo-Json -Compress } finally { $starBitmap.Dispose() }`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
    const expected = fill.match(/\d+/g).slice(0, 3).map(Number);
    assert.deepEqual(pixel, expected, 'The rendered center pixel must be the solid star color');
    await writeFile(
      join(artifacts, file + '.json'),
      JSON.stringify({ fill, pixel, expected }, null, 2),
    );
  }
}
async function restoreInvoke() {
  await page.evaluate(() => {
    window.fetch = window.__defaultTest.original;
  });
}
try {
  await start();
  const a = await invoke('create_scene', { name: '默认场景 A' }),
    b = await invoke('create_scene', { name: '默认场景 B' });
  await invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
  await page.getByRole('button', { name: /^我的场景/ }).click();
  await expect(card(a.name)).toBeVisible();
  await check('Clicking a star updates its badge without navigation', async () => {
    await assertStar(a.name, false, 'before-empty.png');
    const before = await card(a.name).boundingBox();
    await card(a.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
    await expect(card(a.name).getByText('默认启动', { exact: true })).toBeVisible();
    const after = await card(a.name).boundingBox();
    await writeFile(
      join(artifacts, 'star-position.json'),
      JSON.stringify({ before, after }, null, 2),
    );
    assert.equal(after.x, before.x, 'The clicked card must stay at the same position');
    assert.equal(after.y, before.y, 'The clicked card must stay at the same position');
    const selected = card(a.name).getByRole('button', { name: '取消默认启动', exact: true });
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    const fill = await selected.locator('svg path').evaluate((el) => getComputedStyle(el).fill);
    assert.notEqual(fill, 'none', 'The actual star path must be filled');
    await expect(
      page.getByText(`已将「${a.name}」设为默认启动场景`, { exact: true }),
    ).toBeVisible();
    await assertStar(a.name, true, 'after-filled.png');
  });
  await check(
    'Star changes before the save response returns and retains its solid color after success',
    async () => {
      await page.evaluate(() => {
        const original = window.fetch;
        const test = (window.__defaultTest = { original, held: false });
        window.fetch = async (input, ...args) => {
          const response = await original(input, ...args);
          if (new URL(String(input)).pathname === '/set_default_scene') {
            test.held = true;
            await new Promise((resolve) => (test.release = resolve));
          }
          return response;
        };
      });
      await card(b.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
      await page.waitForFunction(() => window.__defaultTest.held);
      const pending = card(b.name).getByRole('button', { name: '取消默认启动', exact: true });
      await expect(pending).toHaveAttribute('aria-pressed', 'true');
      assert.notEqual(
        await pending.locator('svg path').evaluate((el) => getComputedStyle(el).fill),
        'none',
      );
      await page.evaluate(() => window.__defaultTest.release());
      await assertStar(b.name, true, 'delayed-save-filled.png');
      await restoreInvoke();
      await card(a.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
      await assertStar(a.name, true, 'restored-filled.png');
    },
  );
  await check(
    'Changing default during a stale background refresh shows the committed scene',
    async () => {
      await holdResync();
      await card(b.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
      // The icon changes while the older bootstrap is still held, not after it finishes.
      await expect(
        card(b.name).getByRole('button', { name: '取消默认启动', exact: true }),
      ).toBeVisible();
      await releaseResync();
      await expect(
        card(b.name).getByRole('button', { name: '取消默认启动', exact: true }),
      ).toBeVisible();
      await expect(
        card(a.name).getByRole('button', { name: '设为默认启动场景', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.default-tag')).toHaveCount(1);
      await assertStar(b.name, true, 'changed-filled.png');
      await assertStar(a.name, false, 'previous-cleared.png');
      await restoreInvoke();
    },
  );
  await check('Home and Settings share the new default immediately', async () => {
    await page.getByRole('button', { name: '概览', exact: true }).click();
    await expect(page.locator('.hero h2')).toHaveText(b.name);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('默认启动场景', { exact: true })).toHaveValue(b.id);
    await page.getByRole('button', { name: /^我的场景/ }).click();
  });
  await check('Cancelling default during a stale background refresh clears all stars', async () => {
    await holdResync();
    await card(b.name).getByRole('button', { name: '取消默认启动', exact: true }).click();
    await expect(page.locator('.default-tag')).toHaveCount(0);
    await releaseResync();
    await expect(page.locator('.default-tag')).toHaveCount(0);
    await restoreInvoke();
    assert.equal((await invoke('bootstrap')).scenes.filter((s) => s.isDefault).length, 0);
    await assertStar(b.name, false, 'cancelled-empty.png');
  });
  await check('Failed saves keep the prior default and report the error', async () => {
    await card(a.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
    await expect(card(a.name).getByText('默认启动', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = window.fetch;
      window.__defaultTest = { original };
      window.fetch = (input, ...args) =>
        new URL(String(input)).pathname === '/set_default_scene'
          ? Promise.resolve(
              new Response(JSON.stringify('默认场景保存失败（测试）'), {
                headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'error' },
              }),
            )
          : original(input, ...args);
    });
    await card(b.name).getByRole('button', { name: '设为默认启动场景', exact: true }).click();
    await expect(page.getByText('默认场景保存失败（测试）', { exact: true })).toBeVisible();
    await expect(card(a.name).getByText('默认启动', { exact: true })).toBeVisible();
    await expect(page.locator('.default-tag')).toHaveCount(1);
    await assertStar(a.name, true, 'failed-save-kept-filled.png');
    await assertStar(b.name, false, 'failed-save-rollback-empty.png');
    await restoreInvoke();
  });
  await stop();
  await start();
  await check('Default persists after restart', async () => {
    await page.getByRole('button', { name: /^我的场景/ }).click();
    await expect(card(a.name).getByText('默认启动', { exact: true })).toBeVisible();
    assert.equal((await invoke('bootstrap')).scenes.find((s) => s.isDefault).id, a.id);
  });
  await page.screenshot({ path: join(artifacts, 'default-star.png') });
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  await stop();
}
console.log(JSON.stringify({ passed: checks.length, artifacts }));
