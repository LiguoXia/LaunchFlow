/** Real shell extraction and Tauri/WebView2 rendering. Only a private fixture is launched. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-icons-'));
const artifacts = resolve('test-results/application-icons');
await mkdir(artifacts, { recursive: true });
const fixture = join(dataDir, 'LFIconFixture.exe');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/target:winexe',
    '/reference:System.Windows.Forms.dll',
    `/out:${fixture}`,
    `/win32icon:${resolve('src-tauri/icons/icon.ico')}`,
    resolve('scripts/fixtures/WorkspaceCloseFixture.cs'),
  ],
  { windowsHide: true },
);
// The test specifically needs a visible window to verify real desktop capture.
const fixtureProcess = spawn(fixture, ['icons', join(dataDir, 'fixture.log')], {
  windowsHide: false,
  stdio: 'ignore',
});
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
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
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
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = null;
  app?.kill();
  await sleep(500);
}
async function check(name, task) {
  await task();
  checks.push(name);
  console.log('PASS ' + name);
}
const renderedIcon = async (selector) => {
  const img = page.locator(selector).first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e) => e.complete && e.naturalWidth >= 16)).toBe(true);
  return img.getAttribute('src');
};
let fixtureIcon, notepadIcon, scene;
try {
  await start();
  await check(
    'Native shell icons for real executable files; missing and remote paths fall back',
    async () => {
      const executables = [fixture, join(process.env.WINDIR, 'System32/notepad.exe')];
      const noSleep = join(process.env.USERPROFILE, 'Desktop/NoSleepHDv2.0.exe');
      if (existsSync(noSleep)) executables.push(noSleep);
      const sources = [
        ...executables,
        'C:\\missing-icon.exe',
        'https://example.invalid/app.exe',
      ].map((path) => ({ path, bundleId: '' }));
      const icons = await invoke('application_icons', { sources });
      [fixtureIcon, notepadIcon] = icons;
      for (let i = 0; i < executables.length; i++) {
        assert(icons[i]?.startsWith('data:image/png;base64,'));
        await writeFile(
          join(artifacts, `native-${i}.png`),
          Buffer.from(icons[i].split(',')[1], 'base64'),
        );
      }
      assert.notEqual(fixtureIcon, notepadIcon);
      assert.deepEqual(icons.slice(executables.length), [null, null]);
      await assert.rejects(
        invoke('application_icons', { sources: Array(25).fill(sources[0]) }),
        /Too many/,
      );
    },
  );
  await check(
    'Add application previews the icon; path changes and unavailable paths never retain the old icon',
    async () => {
      await page.getByRole('button', { name: /^应用库/ }).click();
      await page.getByRole('button', { name: '添加应用', exact: true }).first().click();
      await page.getByLabel('应用名称', { exact: true }).fill('图标验收应用');
      const path = page.getByLabel('可执行文件路径', { exact: true });
      await path.fill(fixture);
      assert.equal(await renderedIcon('.application-preview img'), fixtureIcon);
      await path.fill(join(process.env.WINDIR, 'System32/notepad.exe'));
      await expect
        .poll(() => page.locator('.application-preview img').getAttribute('src'))
        .toBe(notepadIcon);
      const delayed = join(dataDir, 'delayed-icon.exe');
      await copyFile(fixture, delayed);
      await page.evaluate(() => {
        const original = window.fetch;
        window.__iconTest = { original, held: false };
        window.fetch = async (input, ...args) => {
          const response = await original(input, ...args);
          if (new URL(String(input)).pathname === '/application_icons') {
            window.__iconTest.held = true;
            await new Promise((resolve) => {
              window.__iconTest.release = resolve;
            });
          }
          return response;
        };
      });
      await path.fill(delayed);
      await page.waitForFunction(() => window.__iconTest.held);
      await path.fill(join(process.env.WINDIR, 'System32/notepad.exe'));
      await expect
        .poll(() => page.locator('.application-preview img').getAttribute('src'))
        .toBe(notepadIcon);
      await page.evaluate(() => {
        window.fetch = window.__iconTest.original;
        window.__iconTest.release();
      });
      await sleep(200);
      assert.equal(await renderedIcon('.application-preview img'), notepadIcon);
      await path.fill('C:\\missing-icon.exe');
      await expect(page.locator('.application-preview img')).toHaveCount(0);
      await expect(page.locator('.application-preview svg')).toBeVisible();
      await path.fill(fixture);
      assert.equal(await renderedIcon('.application-preview img'), fixtureIcon);
      await page.screenshot({ path: join(artifacts, 'add-preview.png') });
      await page.getByRole('button', { name: '保存应用', exact: true }).click();
      assert.equal(await renderedIcon('.profile-card img'), fixtureIcon);
      await page.screenshot({ path: join(artifacts, 'application-library.png') });
    },
  );
  // Keep real capture/extraction but omit unrelated user windows from test UI and evidence.
  await page.evaluate((fixture) => {
    const original = window.fetch;
    window.fetch = async (input, ...args) => {
      const response = await original(input, ...args);
      const command = new URL(String(input)).pathname.slice(1);
      if (!['workspace_capture', 'workspace_close_capture'].includes(command)) return response;
      const data = await response.clone().json();
      if (command === 'workspace_capture')
        data.windows = data.windows.filter(
          (w) => w.application.windows.executable.toLowerCase() === fixture.toLowerCase(),
        );
      else
        data.apps = data.apps.filter((a) => a.executable.toLowerCase() === fixture.toLowerCase());
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: response.headers,
      });
    };
  }, fixture);
  await check(
    'Real workspace capture displays the executable icon and creates a workflow with the same icon',
    async () => {
      await page.getByRole('button', { name: '工作区', exact: true }).click();
      await page.getByRole('button', { name: '捕获当前工作区', exact: true }).click();
      await expect(page.locator('.workspace-window')).toHaveCount(1);
      assert.equal(await renderedIcon('.workspace-window img'), fixtureIcon);
      await page.screenshot({ path: join(artifacts, 'workspace-capture.png') });
      await page.getByLabel('包含窗口布局', { exact: true }).uncheck();
      await page.getByRole('button', { name: '创建场景', exact: true }).click();
      assert.equal(await renderedIcon('.node-card img'), fixtureIcon);
      scene = (await invoke('bootstrap')).scenes[0];
      await page.locator('.node-card').first().click();
      assert.equal(await renderedIcon('.inspector-node-type img'), fixtureIcon);
      assert.equal(await renderedIcon('.application-select img'), fixtureIcon);
      await page.screenshot({ path: join(artifacts, 'workflow-editor.png') });
    },
  );
  await check('Advanced canvas and execution history keep application icons', async () => {
    await page.getByRole('button', { name: '高级画布', exact: true }).click();
    assert.equal(await renderedIcon('.dag-node img'), fixtureIcon);
    await page.screenshot({ path: join(artifacts, 'advanced-canvas.png') });
    const run = await invoke('run_scene', { sceneId: scene.id });
    await expect
      .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.status, {
        timeout: 20000,
      })
      .toBe('succeeded');
    await page.getByRole('button', { name: /^运行历史/ }).click();
    await page.getByText(scene.name, { exact: true }).first().click();
    assert.equal(await renderedIcon('.node-run .application-icon img'), fixtureIcon);
    await page.screenshot({ path: join(artifacts, 'run-history.png') });
  });
  await check('Close workspace review displays icons without issuing a close request', async () => {
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await page.getByRole('button', { name: '关闭工作区应用', exact: true }).click();
    await expect(page.locator('.close-app')).toHaveCount(1);
    assert.equal(await renderedIcon('.close-app img'), fixtureIcon);
    await page.screenshot({ path: join(artifacts, 'workspace-close.png') });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  });
  const cacheDir = join(dataDir, 'automation/application-icons-v1');
  const before = await Promise.all(
    (await readdir(cacheDir)).map(async (name) => [
      name,
      (await stat(join(cacheDir, name))).mtimeMs,
    ]),
  );
  await stop();
  await start();
  await check(
    'Existing applications reload icons after restart from the persistent cache',
    async () => {
      await page.getByRole('button', { name: /^应用库/ }).click();
      assert.equal(await renderedIcon('.profile-card img'), fixtureIcon);
      const after = await Promise.all(
        (await readdir(cacheDir)).map(async (name) => [
          name,
          (await stat(join(cacheDir, name))).mtimeMs,
        ]),
      );
      assert.deepEqual(after, before);
    },
  );
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  await stop();
  fixtureProcess.kill();
}
console.log(JSON.stringify({ passed: checks.length, artifacts }));
