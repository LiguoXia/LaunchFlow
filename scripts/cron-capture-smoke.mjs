/** Real Windows WebView2/IPC/SQLite acceptance, with isolated data and owned test windows. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-cron-capture-'));
const artifacts = resolve('test-results/cron-capture');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
let app, browser, page, fixture;
const ownedCalculatorPids = new Set();
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
const library = () => page.getByRole('button', { name: '应用库', exact: true }).click();
const captureDialog = (source) =>
  page.getByRole('dialog', {
    name: source === 'workspace' ? '捕获工作区应用' : '捕获系统默认应用',
    exact: true,
  });
const item = (dialog, name) =>
  dialog.locator('.capture-app').filter({ has: page.getByText(name, { exact: true }) });
try {
  await start();
  assert.equal((await invoke('bootstrap')).scenes.length, 0);
  fixture = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
  });
  await sleep(800);
  await check(
    'Workspace capture adds only checked apps and immediately disables already-added items',
    async () => {
      await library();
      await page.getByRole('button', { name: '捕获工作区应用', exact: true }).click();
      const dialog = captureDialog('workspace');
      const row = dialog
        .locator('.capture-app')
        .filter({ has: page.getByText(/launchflow-harness\.exe$/) });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row.getByRole('checkbox')).not.toBeChecked();
      await row.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '添加所选（1）', exact: true }).click();
      await expect(row.getByRole('checkbox')).toBeDisabled();
      await expect(row.getByRole('checkbox')).toBeChecked();
      assert.equal((await invoke('bootstrap')).profiles.length, 1);
      await dialog.getByRole('button', { name: '重新捕获', exact: true }).click();
      await expect(row.getByRole('checkbox')).toBeDisabled();
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
    },
  );
  let system;
  await check(
    'System capture merges associations, supports Store icons and recognizes existing built-in aliases',
    async () => {
      system = await invoke('application_capture', { source: 'system' });
      assert(system.apps.some((a) => a.categories.some((c) => c.includes('默认浏览器'))));
      const identities = system.apps.map((a) => a.key);
      assert.equal(new Set(identities).size, identities.length);
      const notepad = system.apps.find((a) => a.profile.displayName === '记事本');
      assert(notepad);
      await invoke('save_profile', {
        profile: {
          ...notepad.profile,
          displayName: '已有记事本',
          windows: {
            ...notepad.profile.windows,
            executable: join(process.env.WINDIR, 'System32/notepad.exe'),
            processName: 'notepad.exe',
          },
          launchArguments: [],
        },
      });
      await resync();
      await page.getByRole('button', { name: '捕获系统默认应用', exact: true }).click();
      const dialog = captureDialog('system');
      await expect(item(dialog, '记事本').getByRole('checkbox')).toBeDisabled({ timeout: 15000 });
      await expect(item(dialog, '记事本').getByRole('checkbox')).toBeChecked();
      await dialog.getByRole('textbox', { name: '搜索捕获应用' }).fill('计算器');
      const calculator = item(dialog, '计算器');
      await expect(calculator.locator('img')).toBeVisible({ timeout: 15000 });
      await calculator.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '添加所选（1）', exact: true }).click();
      await expect(calculator.getByRole('checkbox')).toBeDisabled();
      await dialog.getByRole('textbox', { name: '搜索捕获应用' }).fill('');
      await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeEnabled();
      await sleep(250);
      await page.screenshot({ path: join(artifacts, 'system-capture-light.png') });
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal((await invoke('bootstrap')).profiles.length, 3);
    },
  );
  await check(
    'A captured Store application launches through the real application workflow',
    async () => {
      const before = await callNative({ op: 'windows' });
      if (before.some((w) => /calculator/i.test(w.application))) {
        console.log('SKIP launch: Calculator is already open; leave user window unchanged');
        return;
      }
      const calculator = (await invoke('bootstrap')).profiles.find(
        (p) => p.displayName === '计算器',
      );
      let test = await invoke('create_scene', { name: '商店应用启动验收' });
      const definition = (await invoke('bootstrap')).definitions.find(
        (d) => d.nodeType === 'application.launch',
      );
      test.workflow.nodes = [
        {
          id: 'launch',
          type: definition.nodeType,
          name: '启动计算器',
          description: '',
          position: { x: 0, y: 0 },
          enabled: true,
          config: { ...definition.defaults, applicationId: calculator.id },
          retryPolicy: { maxRetries: 0, delayMs: 0 },
          timeoutMs: 15000,
          failurePolicy: 'stopWorkflow',
          platformConstraint: [],
          inputs: {},
          outputs: {},
          metadata: {},
        },
      ];
      test = await invoke('save_scene', { scene: test });
      const run = await invoke('run_scene', { sceneId: test.id });
      await expect
        .poll(
          async () => {
            const windows = await callNative({ op: 'windows' });
            for (const w of windows)
              if (/calculator/i.test(w.application) && !before.some((old) => old.pid === w.pid))
                ownedCalculatorPids.add(w.pid);
            return ownedCalculatorPids.size;
          },
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
      await expect
        .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.status)
        .toBe('succeeded');
      for (const pid of ownedCalculatorPids) {
        try {
          process.kill(pid);
        } catch {}
      }
      ownedCalculatorPids.clear();
      await invoke('delete_scene', { sceneId: test.id });
    },
  );
  let scene = await invoke('create_scene', { name: 'Cron 定时验收' });
  const definition = (await invoke('bootstrap')).definitions.find(
    (d) => d.nodeType === 'system.delay',
  );
  scene.workflow.nodes = [
    {
      id: 'delay',
      type: definition.nodeType,
      name: '短暂等待',
      description: '',
      position: { x: 0, y: 0 },
      enabled: true,
      config: { ...definition.defaults, durationMs: 20 },
      retryPolicy: { maxRetries: 0, delayMs: 0 },
      timeoutMs: 5000,
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
    'Scene settings validate cron, preview next dates and execute on the actual background clock',
    async () => {
      await page.getByRole('button', { name: /^我的场景/ }).click();
      await page
        .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
        .getByRole('button', { name: '编辑', exact: true })
        .click();
      await page.getByRole('button', { name: '场景设置', exact: true }).click();
      await page.getByRole('button', { name: '添加触发器', exact: true }).click();
      await page.getByLabel('触发方式', { exact: true }).selectOption('cron');
      const expression = page.getByLabel('Cron 表达式', { exact: true });
      await expression.fill('61 * * * *');
      await expect(page.locator('.cron-preview').getByRole('alert')).toBeVisible();
      await assert.rejects(invoke('cron_preview', { expression: 'bad expression' }));
      await expression.fill('*/5 * * * * *');
      await expect(page.locator('.cron-preview li')).toHaveCount(3);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect
        .poll(async () => {
          const state = await invoke('bootstrap');
          scene = state.scenes.find((s) => s.id === scene.id);
          return scene.triggers?.[0]?.kind;
        })
        .toBe('cron');
      await page.locator('.cron-settings').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, 'cron-editor-light.png') });
      await expect
        .poll(
          async () =>
            (await invoke('bootstrap')).runs.filter(
              (r) => r.sceneId === scene.id && r.source === 'cron' && r.status === 'succeeded',
            ).length,
          { timeout: 12000 },
        )
        .toBeGreaterThan(0);
    },
  );
  await check(
    'History shows the exact cron expression and distinguishes quick launch and manual runs',
    async () => {
      scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
      const cronId = scene.triggers[0].id;
      scene.triggers[0].enabled = false;
      scene = await invoke('save_scene', { scene });
      await invoke('set_scene_quick_launch', { sceneId: scene.id, enabled: true });
      await resync();
      await page.getByRole('button', { name: '概览', exact: true }).click();
      await page.getByRole('button', { name: `启动「${scene.name}」`, exact: true }).click();
      await expect
        .poll(async () =>
          (await invoke('bootstrap')).runs.some(
            (r) => r.source === 'quickLaunch' && r.status === 'succeeded',
          ),
        )
        .toBe(true);
      await invoke('run_scene', { sceneId: scene.id });
      await page.getByRole('button', { name: '运行历史', exact: true }).first().click();
      await expect(
        page.locator('.table-head').getByText('触发方式', { exact: true }),
      ).toBeVisible();
      for (const label of ['Cron 定时', '快捷启动', '手动运行'])
        await expect(
          page.locator('.run-trigger strong').getByText(label, { exact: true }).first(),
        ).toBeVisible();
      await expect(
        page.locator('.run-trigger small').getByText('*/5 * * * * *', { exact: true }).first(),
      ).toBeVisible();
      const runs = (await invoke('bootstrap')).runs;
      assert(runs.filter((r) => r.source === 'cron').every((r) => r.triggerId === cronId));
      await page.screenshot({ path: join(artifacts, 'history-light.png') });
    },
  );
  await check(
    'Restart retains imported apps, cron configuration and historic trigger identity',
    async () => {
      await stop();
      await start();
      const state = await invoke('bootstrap');
      assert.equal(state.profiles.length, 3);
      assert.equal(
        state.scenes.find((s) => s.id === scene.id).triggers[0].config.expression,
        '*/5 * * * * *',
      );
      assert(!state.scenes.find((s) => s.id === scene.id).triggers[0].enabled);
      await library();
      await page.getByRole('button', { name: '捕获系统默认应用', exact: true }).click();
      const dialog = captureDialog('system');
      await dialog.getByRole('textbox', { name: '搜索捕获应用' }).fill('计算器');
      await expect(item(dialog, '计算器').getByRole('checkbox')).toBeDisabled({ timeout: 15000 });
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
    },
  );
  await check(
    'Capture handles no selection, empty search and failures without adding profiles',
    async () => {
      await page.getByRole('button', { name: '捕获系统默认应用', exact: true }).click();
      const dialog = captureDialog('system');
      await expect(
        dialog.getByRole('button', { name: '添加所选（0）', exact: true }),
      ).toBeDisabled();
      await dialog.getByRole('textbox', { name: '搜索捕获应用' }).fill('NO_MATCH_FIXTURE_123');
      await expect(dialog.getByText('没有匹配的应用', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal((await invoke('bootstrap')).profiles.length, 3);
    },
  );
  await check(
    'Capture failures can retry and a rejected add preserves the checked selection',
    async () => {
      await page.evaluate(() => {
        const original = window.fetch;
        window.__captureFetch = original;
        let reject = true;
        window.fetch = (input, ...args) => {
          if (new URL(String(input)).pathname === '/application_capture' && reject) {
            reject = false;
            return Promise.resolve(
              new Response(JSON.stringify('捕获失败（测试）'), {
                headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'error' },
              }),
            );
          }
          return original(input, ...args);
        };
      });
      await page.getByRole('button', { name: '捕获系统默认应用', exact: true }).click();
      const dialog = captureDialog('system');
      await expect(dialog.getByRole('alert')).toContainText('捕获失败（测试）');
      await dialog.getByRole('button', { name: '重新捕获', exact: true }).click();
      await expect(dialog.locator('.capture-app').first()).toBeVisible({ timeout: 15000 });
      const row = dialog
        .locator('.capture-app')
        .filter({ has: page.getByText('命令提示符', { exact: true }) });
      await row.getByRole('checkbox').check();
      await page.evaluate(() => {
        window.fetch = (input, ...args) =>
          new URL(String(input)).pathname === '/application_capture_add'
            ? Promise.resolve(
                new Response(JSON.stringify('添加失败（测试）'), {
                  headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'error' },
                }),
              )
            : window.__captureFetch(input, ...args);
      });
      await dialog.getByRole('button', { name: '添加所选（1）', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('添加失败（测试）');
      await expect(row.getByRole('checkbox')).toBeChecked();
      await expect(row.getByRole('checkbox')).toBeEnabled();
      await page.evaluate(() => {
        window.fetch = window.__captureFetch;
      });
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal((await invoke('bootstrap')).profiles.length, 3);
    },
  );
  await check('Dark and narrow capture/history layouts remain readable and usable', async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.setViewportSize({ width: 920, height: 640 });
    await page
      .getByRole('button', { name: '捕获系统默认应用', exact: true })
      .dispatchEvent('click');
    await expect(captureDialog('system').locator('.capture-app').first()).toBeVisible({
      timeout: 15000,
    });
    await sleep(300);
    assert.equal(
      await captureDialog('system').evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      false,
    );
    await page.screenshot({ path: join(artifacts, 'system-capture-dark-920.png') });
    await captureDialog('system')
      .getByRole('button', { name: '完成', exact: true })
      .dispatchEvent('click');
    await page.getByRole('button', { name: '运行历史', exact: true }).dispatchEvent('click');
    await expect(page.locator('.history-table')).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'history-dark-920.png') });
  });
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        passed: !process.exitCode,
        checks,
        pageErrors: errors,
        dataDir,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fixture?.kill();
  for (const pid of ownedCalculatorPids) {
    try {
      process.kill(pid);
    } catch {}
  }
  await stop();
}
