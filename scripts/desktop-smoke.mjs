/** Windows WebView2 integration test. Uses the real Tauri IPC + SQLite + Rust engine. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
if (process.argv.includes('--phase2')) process.env.LAUNCHFLOW_PHASE2 = '1';

if (process.platform !== 'win32')
  throw new Error('This harness targets the Windows WebView2 desktop build.');
const local = existsSync('.local/build.json')
  ? JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''))
  : {};
const target = process.env.CARGO_TARGET_DIR || local.targetDir || 'target';
const binary = resolve(target, 'debug/launchflow.exe');
if (!existsSync(binary))
  throw new Error('Build first: node scripts/tauri.mjs build --debug --no-bundle');
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-smoke-'));
const artifacts = resolve('test-results');
await mkdir(artifacts, { recursive: true });
let environment = {
  ...process.env,
  LAUNCHFLOW_TEST_DATA_DIR: dataDir,
};
let child;
let browser;
let page;
const errors = [];
const checks = [];
async function start(args = []) {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  environment = {
    ...environment,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  };
  child = spawn(binary, args, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', (data) => {
    const line = String(data);
    if (!line.includes('DevTools listening')) process.stderr.write(line);
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) throw new Error('WebView2 debugging endpoint did not become available');
  const context = browser.contexts()[0];
  page = context.pages()[0] || (await context.waitForEvent('page'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
  await page.waitForFunction(() => !document.body.textContent.includes('正在载入本地工作空间'));
}
async function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function stop() {
  if (browser) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    browser = null;
  }
  if (child?.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  await new Promise((r) => setTimeout(r, 1000));
}
async function check(label, task) {
  await task();
  checks.push(label);
  console.log(`PASS ${label}`);
}
try {
  await start();
  await check('Desktop bootstrap uses isolated empty SQLite', async () => {
    const initial = await invoke('bootstrap');
    assert.equal(initial.scenes.length, 0);
    assert.equal(initial.runs.length, 0);
    await page.screenshot({ path: join(artifacts, 'home-empty.png') });
    await invoke('save_settings', {
      settings: { ...initial.settings, notifications: false, startupDelaySeconds: 0 },
    });
  });
  await check('Create and edit a scene through the rendered UI', async () => {
    await page.getByRole('button', { name: '新建场景', exact: true }).click();
    await page.getByLabel('场景名称', { exact: true }).fill('桌面集成验收');
    await page.getByRole('button', { name: '创建场景', exact: true }).click();
    await page.getByRole('button', { name: '等待时长', exact: true }).click();
    await page.getByLabel('时长（毫秒）').fill('180');
    await page.getByLabel('步骤名称', { exact: true }).fill('初始化准备');
    await page.getByRole('button', { name: '等待时长', exact: true }).click();
    await page.getByLabel('步骤名称', { exact: true }).fill('确认就绪');
    await page.getByLabel('时长（毫秒）').fill('180');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'editor.png') });
  });
  const created = (await invoke('bootstrap')).scenes[0];
  if (process.env.LAUNCHFLOW_PHASE1_AUDIT === '1') {
    await check(
      'Native profile storage, login registration and system file/folder/URL association',
      async () => {
        const profile = {
          schemaVersion: 1,
          id: 'audit-profile',
          displayName: 'Audit profile',
          windows: {
            executable: binary,
            processName: 'launchflow.exe',
            runAsAdministrator: false,
            usePreauthorizedTask: false,
          },
          macos: { appPath: '', bundleId: '', processName: '' },
          launchArguments: [],
          readyDetection: null,
        };
        await invoke('save_profile', { profile });
        assert.deepEqual(
          (await invoke('bootstrap')).profiles.find((p) => p.id === profile.id),
          profile,
        );
        await invoke('delete_profile', { profileId: profile.id });
        assert.equal(await invoke('set_autostart', { enabled: true }), true);
        assert.equal((await invoke('bootstrap')).autostart, true);
        assert.equal(await invoke('set_autostart', { enabled: false }), false);
        const file = join(dataDir, 'LaunchFlow-audit.html');
        await writeFile(
          file,
          '<!doctype html><title>LaunchFlow Phase 1 audit</title><h1>Native file association test</h1>',
        );
        const { createServer: httpServer } = await import('node:http');
        let requested = false;
        const server = httpServer((_req, res) => {
          requested = true;
          res.end('LaunchFlow local URL association audit');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          for (const [kind, target] of [
            ['file', file],
            ['folder', dataDir],
            ['url', `http://127.0.0.1:${server.address().port}/`],
          ]) {
            let scene = await invoke('create_scene', { name: `Audit open ${kind}` });
            scene.workflow.nodes = [
              {
                ...created.workflow.nodes[0],
                id: crypto.randomUUID(),
                type: `application.open.${kind}`,
                name: `Open ${kind}`,
                config: { target },
              },
            ];
            scene.workflow.edges = [];
            scene = await invoke('save_scene', { scene });
            const run = await invoke('run_scene', { sceneId: scene.id });
            await expect
              .poll(
                async () => (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.status,
              )
              .toBe('succeeded');
            await invoke('delete_run', { runId: run.id });
            await invoke('delete_scene', { sceneId: scene.id });
          }
          await expect.poll(() => requested).toBe(true);
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  }
  await check('Real run events reach the UI and persist history', async () => {
    await page.getByRole('button', { name: '保存并运行', exact: true }).click();
    await expect(page.getByText('工作环境已就绪', { exact: true })).toBeVisible({ timeout: 10000 });
    const runs = (await invoke('bootstrap')).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
    assert.equal(runs[0].nodeRuns.length, 2);
    assert(runs[0].nodeRuns.every((n) => n.status === 'succeeded'));
    await page.screenshot({ path: join(artifacts, 'run-completed.png') });
  });
  await check('Draft survives navigation and undo keeps current revision', async () => {
    await page.getByRole('button', { name: '工作流编辑器', exact: true }).click();
    await page.getByRole('button', { name: '编辑步骤 初始化准备', exact: true }).click();
    await page.getByLabel('步骤名称', { exact: true }).fill('已恢复的草稿步骤');
    await page.getByRole('button', { name: '概览', exact: true }).click();
    await page.getByRole('button', { name: '工作流编辑器', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '编辑步骤 已恢复的草稿步骤', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '编辑步骤 已恢复的草稿步骤', exact: true }).click();
    await page.getByLabel('步骤名称', { exact: true }).fill('继续编辑');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    const saved = (await invoke('bootstrap')).scenes[0];
    assert.equal(saved.workflow.nodes[0].name, '已恢复的草稿步骤');
  });
  await check('Default scene is unique and history deletion stays deleted', async () => {
    await invoke('set_default_scene', { sceneId: created.id });
    const second = await invoke('create_scene', { name: '第二场景' });
    await invoke('set_default_scene', { sceneId: second.id });
    assert.equal((await invoke('bootstrap')).scenes.filter((s) => s.isDefault).length, 1);
    await invoke('delete_scene', { sceneId: second.id });
    await invoke('set_default_scene', { sceneId: created.id });
    await page.getByRole('button', { name: '运行历史', exact: true }).click();
    await page.getByRole('button', { name: '删除运行记录', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('这里还没有运行记录', { exact: true })).toBeVisible();
    assert.equal((await invoke('bootstrap')).runs.length, 0);
  });
  await check('Cancellation stops a long-running node', async () => {
    let scene = (await invoke('bootstrap')).scenes[0];
    scene.workflow.nodes[0].config.durationMs = 8000;
    scene = await invoke('save_scene', { scene });
    const run = await invoke('run_scene', { sceneId: scene.id });
    await invoke('stop_run', { runId: run.id });
    await expect
      .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.status)
      .toBe('cancelled');
    scene.workflow.nodes[0].config.durationMs = 80;
    await invoke('save_scene', { scene });
  });
  await check('Window close hides UI while Rust engine keeps running', async () => {
    let scene = (await invoke('bootstrap')).scenes[0];
    scene.workflow.nodes[0].config.durationMs = 1200;
    scene = await invoke('save_scene', { scene });
    const run = await invoke('run_scene', { sceneId: scene.id });
    const closeRequest = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${child.pid}).CloseMainWindow()`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    await new Promise((resolve) => closeRequest.once('exit', resolve));
    assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), false);
    await expect
      .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.status)
      .toBe('succeeded');
    // A second normal launch must show the existing window without starting another run.
    const second = spawn(binary, [], { env: environment, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => second.once('exit', resolve));
    await expect.poll(() => invoke('plugin:window|is_visible', { label: 'main' })).toBe(true);
    await page.getByRole('button', { name: '概览', exact: true }).click();
    await page.screenshot({ path: join(artifacts, 'home.png') });
  });
  await check('Startup invocation is hidden and runs only the default scene', async () => {
    const count = (await invoke('bootstrap')).runs.length;
    await stop();
    await start(['--startup']);
    assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), false);
    await expect
      .poll(
        async () =>
          (await invoke('bootstrap')).runs.filter(
            (r) => r.source === 'startup' && r.status === 'succeeded',
          ).length,
        { timeout: 12000 },
      )
      .toBe(1);
    assert.equal((await invoke('bootstrap')).runs.length, count + 1);
  });
  assert.deepEqual(errors, []);
  if (process.env.LAUNCHFLOW_PHASE2 === '1') {
    const foreground = spawn(binary, [], { env: environment, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => foreground.once('exit', resolve));
    const { phase2 } = await import('./phase2-smoke.mjs');
    await phase2({ invoke, page, binary, target, dataDir, artifacts, check });
    assert.deepEqual(errors, []);
  }
  await writeFile(
    join(artifacts, 'desktop-smoke.json'),
    JSON.stringify({ checks, dataDir, errors }, null, 2),
  );
  console.log(`Verified ${checks.length} real desktop integration flows. Artifacts: ${artifacts}`);
} finally {
  await stop();
}
