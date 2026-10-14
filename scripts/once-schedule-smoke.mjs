/** Real Windows WebView2/IPC/SQLite acceptance, with isolated data and owned test windows. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-once-schedule-'));
const artifacts = resolve('test-results/once-schedule');
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
const dateTime = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
let scene;
const runs = async () => (await invoke('bootstrap')).runs.filter((r) => r.sceneId === scene.id);
try {
  await start();
  assert.equal((await invoke('bootstrap')).scenes.length, 0);
  scene = await invoke('create_scene', { name: '指定时间验收' });
  scene.workflow.nodes = [
    {
      id: 'delay',
      type: 'system.delay',
      name: '短暂等待',
      description: '',
      position: { x: 0, y: 0 },
      enabled: true,
      config: { durationMs: 20 },
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
  await page.getByRole('button', { name: /^我的场景/ }).click();
  await page
    .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.getByRole('button', { name: '场景设置', exact: true }).click();
  await page.getByRole('button', { name: '添加触发器', exact: true }).click();
  await page.getByRole('combobox', { name: '触发方式', exact: true }).click();
  await page.getByRole('combobox', { name: '触发方式', exact: true }).fill('once');
  await page.locator('[role="option"][data-option-value="once"]').click();
  const input = page.getByLabel('指定时间', { exact: true });
  await check(
    'Invalid dates and format show inline errors and fail backend/save validation',
    async () => {
      for (const bad of ['2026-02-29 09:00:00', '2026-10-13 24:00:00', '2026/10/13 09:00:00']) {
        await input.fill(bad);
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('.once-schedule-settings [role="alert"]')).toBeVisible();
        await assert.rejects(invoke('once_schedule_preview', { dateTime: bad }));
      }
      await assert.rejects(
        invoke('save_scene', {
          scene: {
            ...scene,
            triggers: [
              {
                id: 'invalid',
                kind: 'once',
                enabled: true,
                config: { dateTime: '2026-02-29 09:00:00' },
                parameters: {},
              },
            ],
          },
        }),
      );
      assert.equal(
        (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id).triggers.length,
        0,
      );
    },
  );
  let appointment;
  await check(
    'Seconds-based appointment saves and executes exactly once on the real clock',
    async () => {
      appointment = dateTime(new Date(Date.now() + 12000));
      await input.fill(appointment);
      await expect(input).toHaveAttribute('aria-invalid', 'false');
      await expect(page.locator('.once-schedule-settings')).toContainText('时间有效');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id).triggers[0]?.config
              .dateTime,
        )
        .toBe(appointment);
      assert.equal((await runs()).length, 0);
      await input.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(artifacts, 'appointment-settings.png') });
      await expect
        .poll(async () => (await runs()).filter((r) => r.status === 'succeeded').length, {
          timeout: 18000,
        })
        .toBe(1);
      await sleep(2100);
      assert.equal((await runs()).length, 1);
      assert.equal((await runs())[0].source, 'once');
    },
  );
  await check('History includes trigger type and its saved appointment', async () => {
    await page.getByRole('button', { name: '运行历史', exact: true }).first().click();
    await expect(
      page.locator('.run-trigger strong').getByText('指定时间', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.run-trigger small').getByText(appointment, { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'appointment-history.png') });
  });
  await check(
    'Closing and reopening LaunchFlow preserves the completed appointment without rerunning',
    async () => {
      await stop();
      await start();
      await sleep(2100);
      assert.equal((await runs()).length, 1);
      scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
      assert.equal(scene.triggers[0].config.dateTime, appointment);
    },
  );
  await check('An appointment missed while closed catches up only once after restart', async () => {
    scene.triggers[0].config.dateTime = dateTime(new Date(Date.now() + 4000));
    scene = await invoke('save_scene', { scene });
    await stop();
    await sleep(4500);
    await start();
    await expect
      .poll(async () => (await runs()).filter((r) => r.status === 'succeeded').length, {
        timeout: 10000,
      })
      .toBe(2);
    await sleep(2100);
    assert.equal((await runs()).length, 2);
  });
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  await stop();
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify({ checks, errors, dataDir }, null, 2),
  );
}
