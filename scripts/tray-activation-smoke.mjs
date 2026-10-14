/** Real Windows WebView2/IPC/SQLite acceptance, with isolated data and owned test windows. */
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import { callNative, worker } from './test-native.mjs';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-tray-activation-'));
const artifacts = resolve('test-results/tray-activation');
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
const resync = () => invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
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
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
}
const framework = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
const fixturePath = join(dataDir, 'TrayWindowFixture.exe');
await copyFile(worker, join(dataDir, 'launchflow-automation.exe'));
execFileSync(
  join(framework, 'csc.exe'),
  [
    '/nologo',
    `/out:${fixturePath}`,
    `/reference:${worker}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/tests/TrayWindowFixture.cs'),
  ],
  { windowsHide: true },
);
const focusFixture = join(dataDir, 'ForegroundFixture.exe');
execFileSync(
  join(framework, 'csc.exe'),
  [
    '/nologo',
    `/out:${focusFixture}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/Common.cs'),
    resolve('native/windows/tests/ForegroundFixture.cs'),
  ],
  { windowsHide: true },
);
const marker = join(dataDir, 'tray');
const fixture = spawn(
  fixturePath,
  [marker, ...(process.argv.includes('--baseline') ? ['baseline'] : [])],
  { windowsHide: true, stdio: 'ignore' },
);
const scope = { pid: fixture.pid, title: 'LaunchFlow Tray Fixture' };
const info = () => callNative({ op: 'window', window: scope, includeHidden: true });
const state = async () => JSON.parse(await readFile(marker + '.json', 'utf8'));
async function command(value) {
  await writeFile(marker + '.command', value);
  await sleep(180);
}
let scene;
async function activate() {
  const window = (await callNative({ op: 'windows' })).find((w) => w.pid === app.pid);
  assert(window);
  execFileSync(focusFixture, [String(window.pid), window.handle, '--caption'], {
    windowsHide: true,
  });
  const started = await invoke('run_scene', { sceneId: scene.id, approved: true });
  let run;
  await expect
    .poll(
      async () => {
        run = (await invoke('bootstrap')).runs.find((r) => r.id === started.id);
        return ['succeeded', 'failed', 'cancelled'].includes(run?.status);
      },
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.nodeRuns));
  return run;
}
try {
  await start();
  await expect
    .poll(async () => {
      try {
        return (await info()).visible;
      } catch {
        return null;
      }
    })
    .toBe(false);
  await check(
    'Hidden tray main windows are opt-in; helper windows and normal input remain excluded',
    async () => {
      assert(!(await invoke('automation_windows')).some((w) => w.pid === fixture.pid));
      const hidden = (await invoke('automation_windows', { includeHidden: true })).filter(
        (w) => w.pid === fixture.pid,
      );
      assert.equal(hidden.length, 1);
      assert.equal(hidden[0].visible, false);
      await assert.rejects(
        callNative({ op: 'window', window: scope }),
        (e) => e.detail?.code === 'notFound',
      );
      await assert.rejects(
        callNative({ op: 'perform', window: scope, action: { kind: 'pressKey', key: 'Enter' } }),
        (e) => e.detail?.code === 'notFound',
      );
    },
  );
  scene = await invoke('create_scene', { name: '托盘窗口激活验收' });
  const definition = (await invoke('bootstrap')).definitions.find(
    (d) => d.nodeType === 'gui.activateWindow',
  );
  scene.workflow.nodes = [
    {
      id: 'activate',
      type: 'gui.activateWindow',
      name: '恢复托盘窗口',
      description: '',
      position: { x: 0, y: 0 },
      enabled: true,
      config: {
        ...definition.defaults,
        locators: [{ kind: 'window', window: { title: scope.title } }],
      },
      retryPolicy: { maxRetries: 0, delayMs: 0 },
      timeoutMs: 10000,
      failurePolicy: 'stopWorkflow',
      platformConstraint: [],
      inputs: {},
      outputs: {},
      metadata: {},
    },
  ];
  scene = await invoke('save_scene', { scene });
  await resync();
  await check(
    'Activation editor lists hidden/tray windows and saves a stable selector',
    async () => {
      await page.getByRole('button', { name: /^我的场景/ }).click();
      await page
        .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      await page.getByRole('button', { name: '编辑步骤 恢复托盘窗口', exact: true }).click();
      const chooser = page.getByLabel('桌面与托盘窗口', { exact: true });
      await expect(chooser).toBeVisible();
      const option = chooser.locator('option').filter({ hasText: 'LaunchFlow Tray Fixture' });
      await expect(option).toContainText('隐藏 / 托盘');
      await chooser.selectOption(await option.getAttribute('value'));
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect
        .poll(async () => {
          scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
          return scene.workflow.nodes[0].config.locators[0].window.application;
        })
        .toBe('TrayWindowFixture.exe');
      assert(!scene.workflow.nodes[0].config.locators[0].window.pid);
      assert(!scene.workflow.nodes[0].config.locators[0].window.handle);
      await chooser.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, 'hidden-window-chooser.png') });
    },
  );
  await check('Workflow restores a tray window and confirms foreground activation', async () => {
    const run = await activate();
    const restored = await info();
    assert(restored.visible);
    assert(restored.focused);
    assert.equal(run.nodeRuns[0].output.automation.focus.hiddenRestoreRequested, true);
    assert.equal(run.nodeRuns[0].output.automation.focus.targetVisible, true);
    await writeFile(join(artifacts, 'activation-run.json'), JSON.stringify(run, null, 2));
  });
  await check(
    'Restored tray window processes actual mouse clicks, not just HWND visibility',
    async () => {
      const before = await state();
      const result = await callNative({
        op: 'perform',
        window: scope,
        point: before.clickPoint,
        action: { kind: 'click' },
      });
      assert.equal(result.pointer.inputEventsSent, 2);
      await expect.poll(async () => (await state()).clicks).toBe(before.clicks + 1);
      assert.equal((await state()).interactionReady, true);
    },
  );
  await check(
    'Saved workflow restores from tray and its following click is handled by the application',
    async () => {
      await command('hide');
      const before = await state();
      const node = structuredClone(scene.workflow.nodes[0]);
      node.id = 'click-after-tray';
      node.type = 'gui.click';
      node.name = 'Click after tray restore';
      node.config = {
        locators: [
          {
            kind: 'relativeCoordinate',
            window: node.config.locators[0].window,
            x: (before.clickPoint.x - before.bounds.x) / before.bounds.width,
            y: (before.clickPoint.y - before.bounds.y) / before.bounds.height,
          },
        ],
        captureOnFailure: false,
      };
      scene.workflow.nodes.push(node);
      scene.workflow.edges = [
        { id: 'tray-to-click', from: scene.workflow.nodes[0].id, to: node.id, outlet: 'success' },
      ];
      scene = await invoke('save_scene', { scene });
      const run = await activate();
      await expect.poll(async () => (await state()).clicks).toBe(before.clicks + 1);
      assert.equal(run.nodeRuns[1].output.automation.pointer.inputEventsSent, 2);
      await writeFile(join(artifacts, 'tray-and-click-run.json'), JSON.stringify(run, null, 2));
      scene.workflow.nodes = [scene.workflow.nodes[0]];
      scene.workflow.edges = [];
      scene = await invoke('save_scene', { scene });
    },
  );
  await check('Restoring a hidden maximized window preserves its maximized placement', async () => {
    await command('maximizeHide');
    assert.equal((await info()).visible, false);
    await activate();
    const restored = await info();
    assert(restored.visible);
    assert.equal(restored.state, 'maximized');
  });
  await check('Ordinary minimized windows still restore and activate', async () => {
    await command('minimize');
    await activate();
    const restored = await info();
    assert(restored.visible);
    assert.notEqual(restored.state, 'minimized');
  });
  await check(
    'Multiple hidden matches and stale handles never reveal an arbitrary window',
    async () => {
      await command('hide');
      await command('duplicate');
      await assert.rejects(
        callNative({ op: 'perform', window: scope, action: { kind: 'activateWindow' } }),
        (e) => e.detail?.code === 'ambiguous',
      );
      await assert.rejects(
        callNative({
          op: 'perform',
          window: { ...scope, handle: '1' },
          action: { kind: 'activateWindow' },
        }),
        (e) => e.detail?.code === 'notFound',
      );
      assert.equal(
        (await callNative({ op: 'windows' })).filter((w) => w.pid === fixture.pid).length,
        0,
      );
      await command('removeDuplicate');
    },
  );
  await check('Saved activation continues working after LaunchFlow restarts', async () => {
    await stop();
    await start();
    await activate();
    assert((await info()).visible);
  });
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  await stop();
  fixture.kill();
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        checks,
        errors,
        scope:
          'Owned NotifyIcon fixture and isolated LaunchFlow; user Codex was not closed or manipulated.',
      },
      null,
      2,
    ),
  );
}
