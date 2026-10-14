/** Real WebView2, SQLite and Windows tutorial execution in a disposable LaunchFlow profile. */
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-scene-template-'));
const foregroundFixture = join(dataDir, 'ForegroundFixture.exe');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${foregroundFixture}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/Common.cs'),
    resolve('native/windows/tests/ForegroundFixture.cs'),
  ],
  { windowsHide: true },
);
const artifacts = resolve('test-results/scene-template');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [],
  demos = [];
const practiceRuns = new Set();
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
const sceneCard = (name) =>
  page.locator('.scene-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const scenesPage = () => page.getByRole('button', { name: /^我的场景/ }).click();
const resync = () => invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
async function focusApp() {
  const target = (await callNative({ op: 'windows' })).find((w) => w.pid === app.pid);
  assert(target, 'Own test application window exists');
  // Model returning from the demo browser to click Run. IPC alone is not a foreground gesture.
  execFileSync(foregroundFixture, [String(app.pid), target.handle, '--caption'], {
    windowsHide: true,
    timeout: 8000,
  });
}
async function finish(id) {
  practiceRuns.add(id);
  let run;
  await expect
    .poll(
      async () => {
        run = (await invoke('bootstrap')).runs.find((r) => r.id === id);
        return ['succeeded', 'failed', 'cancelled'].includes(run?.status);
      },
      { timeout: 240000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await writeFile(join(artifacts, `run-${id}.json`), JSON.stringify(run, null, 2));
  assert.equal(
    run.status,
    'succeeded',
    JSON.stringify({ error: run.error, nodes: run.nodeRuns.filter((n) => n.status === 'failed') }),
  );
  return run;
}
try {
  await start();
  let scene = await invoke('create_scene', { name: '原始场景' });
  await invoke('set_default_scene', { sceneId: scene.id });
  await resync();
  await scenesPage();
  await sceneCard('原始场景').getByRole('button', { name: '编辑', exact: true }).click();
  await check(
    'Editor dialog rename commits when leaving without Save, preserving an unfinished workflow draft',
    async () => {
      await page.getByRole('button', { name: '重命名场景', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '重命名场景' });
      await dialog.getByLabel('场景名称', { exact: true }).fill('标题同步成功');
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
      await page.getByRole('button', { name: '等待时长', exact: true }).click();
      await scenesPage();
      await expect(sceneCard('标题同步成功')).toBeVisible();
      scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
      assert.equal(scene.workflow.nodes.length, 0);
      assert(scene.isDefault);
      const draft = await invoke('get_draft', { sceneId: scene.id });
      assert.equal(draft.version, scene.version);
      assert.equal(draft.name, scene.name);
      assert.equal(draft.workflow.nodes.length, 1);
    },
  );
  await check(
    'Settings name syncs on immediate navigation; empty name keeps the editor open',
    async () => {
      await sceneCard(scene.name).getByRole('button', { name: '编辑', exact: true }).click();
      await expect(page.getByText('已恢复草稿', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '场景设置', exact: true }).click();
      await page.getByLabel('场景名称', { exact: true }).fill('');
      await scenesPage();
      await expect(page.getByRole('alert')).toContainText('无法同步场景名称');
      await expect(page.locator('.editor-page')).toBeVisible();
      await page.getByLabel('场景名称', { exact: true }).fill('设置同步成功');
      await scenesPage();
      await expect(sceneCard('设置同步成功')).toBeVisible();
      scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
      assert.equal(scene.name, '设置同步成功');
      assert.equal((await invoke('get_draft', { sceneId: scene.id })).workflow.nodes.length, 1);
    },
  );
  await stop();
  await start();
  await scenesPage();
  await check(
    'Committed name and editable draft persist across application restart; Save and Run still navigates',
    async () => {
      await expect(sceneCard('设置同步成功')).toBeVisible();
      await sceneCard('设置同步成功').getByRole('button', { name: '编辑', exact: true }).click();
      await expect(page.getByText('已恢复草稿', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '保存并运行', exact: true }).click();
      await expect(page.locator('.editor-page')).not.toBeVisible();
      await scenesPage();
    },
  );
  await check(
    'Template preview loads two scenes and 33 enabled types without changing the default',
    async () => {
      await page.getByRole('button', { name: '载入体验模板', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '载入 Windows 体验模板' });
      await expect(dialog).toContainText('非真实密码');
      await page.screenshot({ path: join(artifacts, 'template-preview.png') });
      await dialog.getByRole('button', { name: '载入并查看', exact: true }).click();
      await expect(page.locator('.editor-title h1')).toHaveText('Windows 全步骤体验', {
        timeout: 15000,
      });
      const bootstrap = await invoke('bootstrap');
      demos.push(...bootstrap.scenes.filter((s) => s.id !== scene.id));
      assert.equal(demos.length, 2);
      const types = new Set(demos.flatMap((s) => s.workflow.nodes.map((n) => n.type)));
      assert.deepEqual([...types].sort(), bootstrap.definitions.map((d) => d.nodeType).sort());
      assert(
        demos.every(
          (s) =>
            !s.isDefault && s.triggers.length === 0 && s.workflow.nodes.every((n) => n.enabled),
        ),
      );
      assert.equal(bootstrap.scenes.find((s) => s.isDefault).id, scene.id);
      for (const demo of demos)
        assert.deepEqual(await invoke('validate_scene', { scene: demo }), []);
      await scenesPage();
      await page.screenshot({ path: join(artifacts, 'template-scenes.png') });
    },
  );
  const main = demos.find((s) => s.workflow.nodes.length > 1);
  await check(
    'Unmodified 43-step template executes all built-in types on real Windows',
    async () => {
      await focusApp();
      const run = await finish(
        (await invoke('run_scene', { sceneId: main.id, approved: true })).id,
      );
      assert.equal(run.nodeRuns.length, 43);
      assert(run.nodeRuns.every((n) => n.status === 'succeeded'));
      const screenshot = run.nodeRuns.find(
        (r) => r.nodeId === main.workflow.nodes.find((n) => n.type === 'gui.screenshot').id,
      );
      assert(screenshot.output.automation.screenshot);
      const window = {
        application: 'launchflow-harness.exe',
        title: `LaunchFlow 步骤练习 · ${run.id}`,
      };
      const result = await callNative({
        op: 'find',
        window,
        locator: { kind: 'accessibility', window, automationId: 'result-label' },
      });
      assert.equal(result.name, 'Drag received');
      const diagnostic = await invoke('diagnostic_log', { runId: run.id });
      assert(!diagnostic.includes('LaunchFlow-Demo-Only'));
      await writeFile(join(artifacts, 'template-diagnostic.json'), diagnostic);
    },
  );
  await check('Rerunning resets only the owned practice window and completes again', async () => {
    await focusApp();
    await finish((await invoke('run_scene', { sceneId: main.id, approved: true })).id);
  });
  await check('Loaded templates can be deleted through scene cards and loaded again', async () => {
    await resync();
    await scenesPage();
    for (const demo of [main, ...demos.filter((s) => s.id !== main.id)]) {
      await sceneCard(demo.name).getByRole('button', { name: '删除场景', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
      await expect(sceneCard(demo.name)).not.toBeVisible();
    }
    await expect(sceneCard(scene.name)).toBeVisible();
    await page.getByRole('button', { name: '载入体验模板', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '载入并查看', exact: true }).click();
    await expect(page.locator('.editor-title h1')).toHaveText('Windows 全步骤体验');
    const reloaded = (await invoke('bootstrap')).scenes.filter((s) => s.id !== scene.id);
    assert.equal(reloaded.length, 2);
    assert(reloaded.every((s) => !demos.some((d) => d.id === s.id)));
    demos.push(...reloaded);
  });
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (error) {
  errors.push(String(error));
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  // Only our uniquely identified tutorial processes and synthetic demo credentials are removed.
  const windows = await callNative({ op: 'windows' }).catch(() => []);
  for (const runId of practiceRuns) {
    const window = windows.find((w) => w.title === `LaunchFlow 步骤练习 · ${runId}`);
    if (window)
      try {
        process.kill(window.pid);
      } catch {}
  }
  for (const demo of demos) {
    if (demo.workflow.nodes.some((n) => n.type === 'gui.inputSecret'))
      await callNative({ op: 'vault', action: 'delete', id: `demo-${demo.id}` }).catch(() => {});
  }
  await stop();
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify({ checks, errors, dataDir }, null, 2),
  );
}
