/** Real Windows WebView2/IPC/SQLite: rename with drafts, physical drag sorting and Secret resolution. */
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-scene-editor-'));
const artifacts = resolve('test-results/scene-editor');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
let app, browser, page, fixture;
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
      LAUNCHFLOW_FIXTURE_SECRET: 'ENGINE_SYNTHETIC_SECRET',
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
const nodeCard = (name) => page.getByRole('button', { name: `编辑步骤 ${name}`, exact: true });
const order = () => page.locator('.node-card-copy strong');
const rename = async (name) => {
  const dialog = page.getByRole('dialog', { name: '重命名场景' });
  await dialog.getByLabel('场景名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect(dialog).not.toBeVisible();
};
async function finish(id) {
  let run;
  await expect
    .poll(
      async () => {
        run = (await invoke('bootstrap')).runs.find((r) => r.id === id);
        return ['succeeded', 'failed', 'cancelled'].includes(run?.status);
      },
      { timeout: 20000 },
    )
    .toBe(true);
  return run;
}
try {
  await start();
  let scene = await invoke('create_scene', { name: '排序与改名验证' });
  const definition = (await invoke('bootstrap')).definitions.find(
    (d) => d.nodeType === 'system.delay',
  );
  const make = (name, index) => ({
    id: `step-${name}`,
    type: definition.nodeType,
    name,
    description: '',
    position: { x: 0, y: index * 120 },
    enabled: true,
    config: { ...definition.defaults, durationMs: 1 },
    retryPolicy: { maxRetries: 0, delayMs: 0 },
    timeoutMs: 5000,
    failurePolicy: 'stopWorkflow',
    platformConstraint: [],
    inputs: {},
    outputs: {},
    metadata: {},
  });
  scene.workflow.nodes = ['A', 'B', 'C'].map(make);
  scene.workflow.edges = scene.workflow.nodes.slice(1).map((n, i) => ({
    id: `edge-${i}`,
    from: scene.workflow.nodes[i].id,
    to: n.id,
    outlet: 'success',
  }));
  scene = await invoke('save_scene', { scene });
  const historical = await finish((await invoke('run_scene', { sceneId: scene.id })).id);
  const draft = structuredClone(scene);
  draft.workflow.nodes[0].description = '未完成草稿';
  await invoke('save_draft', { scene: draft });
  await invoke('set_default_scene', { sceneId: scene.id });
  await invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
  await page.getByRole('button', { name: /^我的场景/ }).click();
  // Fixture IPC writes emit asynchronous resyncs; wait for the final revision before editing.
  await expect(sceneCard(scene.name).getByText(`v${scene.version}`, { exact: true })).toBeVisible();
  await expect(sceneCard(scene.name).getByText('默认启动', { exact: true })).toBeVisible();
  await check('Rename validates empty and long names, and cancel keeps the original', async () => {
    await sceneCard(scene.name).getByRole('button', { name: '重命名场景', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名场景' });
    await dialog.getByLabel('场景名称', { exact: true }).fill('   ');
    await expect(dialog.getByRole('button', { name: '确定', exact: true })).toBeDisabled();
    await dialog.getByLabel('场景名称', { exact: true }).fill('中'.repeat(67));
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '确定', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(sceneCard(scene.name)).toBeVisible();
  });
  await check(
    'List rename preserves the default, workflow, unfinished draft and historical run',
    async () => {
      await sceneCard(scene.name).getByRole('button', { name: '重命名场景', exact: true }).click();
      await rename('  工作场景  ');
      await expect(sceneCard('工作场景')).toBeVisible();
      await expect(sceneCard('工作场景').getByText('默认启动', { exact: true })).toBeVisible();
      const bootstrap = await invoke('bootstrap');
      scene = bootstrap.scenes.find((s) => s.id === scene.id);
      assert.equal(scene.name, '工作场景');
      assert.equal(scene.version, draft.version + 1);
      assert.equal(scene.workflow.nodes[0].description, '');
      const savedDraft = await invoke('get_draft', { sceneId: scene.id });
      assert.equal(savedDraft.name, scene.name);
      assert.equal(savedDraft.version, scene.version);
      assert.equal(savedDraft.workflow.nodes[0].description, '未完成草稿');
      assert.equal(
        bootstrap.runs.find((r) => r.id === historical.id).sceneSnapshot.name,
        '排序与改名验证',
      );
      await sceneCard(scene.name).getByRole('button', { name: '编辑', exact: true }).click();
      await expect(page.getByText('已恢复草稿', { exact: false })).toBeVisible();
    },
  );
  await check('Real mouse drag reorders down and up with undo, redo and an end drop', async () => {
    await nodeCard('A')
      .locator('.node-card-header')
      .dragTo(nodeCard('C'), { targetPosition: { x: 100, y: 100 } });
    await expect(order()).toHaveText(['B', 'C', 'A']);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(order()).toHaveText(['A', 'B', 'C']);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(order()).toHaveText(['B', 'C', 'A']);
    await nodeCard('A')
      .locator('.node-card-header')
      .dragTo(nodeCard('B'), { targetPosition: { x: 100, y: 5 } });
    await expect(order()).toHaveText(['A', 'B', 'C']);
    await nodeCard('A').locator('.node-card-header').dragTo(page.locator('.sequence-end'));
    await expect(order()).toHaveText(['B', 'C', 'A']);
    await page.screenshot({ path: join(artifacts, 'reordered.png') });
  });
  await check(
    'Reordered draft survives navigation and saves runnable dependencies in that order',
    async () => {
      await expect
        .poll(async () =>
          (await invoke('get_draft', { sceneId: scene.id }))?.workflow.nodes.map((n) => n.name),
        )
        .toEqual(['B', 'C', 'A']);
      await page.getByRole('button', { name: '返回场景', exact: true }).click();
      await sceneCard(scene.name).getByRole('button', { name: '编辑', exact: true }).click();
      await expect(order()).toHaveText(['B', 'C', 'A']);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
      scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
      assert.deepEqual(
        scene.workflow.edges.map((e) => [e.from, e.to]),
        [
          ['step-B', 'step-C'],
          ['step-C', 'step-A'],
        ],
      );
      assert.equal(scene.workflow.nodes.find((n) => n.name === 'A').description, '未完成草稿');
      const run = await finish((await invoke('run_scene', { sceneId: scene.id })).id);
      assert.equal(run.status, 'succeeded', run.error);
      assert.deepEqual(
        run.nodeRuns.map((n) => n.nodeId),
        ['step-B', 'step-C', 'step-A'],
      );
    },
  );
  await check('Editor title rename participates in draft undo and explicit save', async () => {
    await page.getByRole('button', { name: '重命名场景', exact: true }).click();
    await rename('日常工作');
    await expect(page.locator('.editor-title h1')).toHaveText('日常工作');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.locator('.editor-title h1')).toHaveText('工作场景');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id).name)
      .toBe('日常工作');
  });
  await stop();
  await start();
  await check('Scene name, default and reordered workflow persist after restart', async () => {
    const saved = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
    assert.equal(saved.name, '日常工作');
    assert(saved.isDefault);
    assert.deepEqual(
      saved.workflow.nodes.map((n) => n.name),
      ['B', 'C', 'A'],
    );
    await page.getByRole('button', { name: /^我的场景/ }).click();
    await expect(sceneCard(saved.name)).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'renamed.png') });
  });
  await check(
    'Real Rust workflow resolves a delayed raw-view Secret field before reading and sending its value',
    async () => {
      const framework = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
      const binary = join(dataDir, 'SecretInputFixture.exe');
      const refs = [
        'System.Web.Extensions.dll',
        'System.Xaml.dll',
        ...[
          'WindowsBase.dll',
          'PresentationFramework.dll',
          'PresentationCore.dll',
          'UIAutomationClient.dll',
          'UIAutomationTypes.dll',
          'UIAutomationProvider.dll',
        ].map((p) => join(framework, 'WPF', p)),
      ];
      execFileSync(
        join(framework, 'csc.exe'),
        [
          '/nologo',
          `/out:${binary}`,
          ...refs.map((p) => '/reference:' + p),
          resolve('native/windows/Common.cs'),
          resolve('native/windows/tests/SecretInputFixture.cs'),
        ],
        { windowsHide: true },
      );
      const marker = join(dataDir, 'engine-secret');
      fixture = spawn(binary, [marker], { windowsHide: true, stdio: 'ignore' });
      const window = { pid: fixture.pid, title: 'LaunchFlow Secret Input Fixture' };
      await expect
        .poll(async () => (await callNative({ op: 'windows' })).some((w) => w.pid === fixture.pid))
        .toBe(true);
      let secretScene = await invoke('create_scene', { name: 'Secret 原生回归' });
      secretScene.sensitiveActionPolicy = 'allowForThisScene';
      const prepare = {
        ...make('Prepare', 0),
        id: 'prepare',
        type: 'gui.click',
        config: {
          locators: [{ kind: 'accessibility', window, automationId: 'prepare' }],
          captureOnFailure: false,
        },
      };
      const input = {
        ...make('Secret', 1),
        id: 'secret',
        type: 'gui.inputSecret',
        config: {
          locators: [{ kind: 'accessibility', window, role: 'Edit' }],
          secretRef: 'env:LAUNCHFLOW_FIXTURE_SECRET',
          captureOnFailure: false,
        },
      };
      secretScene.workflow = {
        nodes: [prepare, input],
        edges: [{ id: 'prepare-secret', from: 'prepare', to: 'secret', outlet: 'success' }],
      };
      secretScene = await invoke('save_scene', { scene: secretScene });
      const run = await finish(
        (await invoke('run_scene', { sceneId: secretScene.id, approved: true })).id,
      );
      assert.equal(run.status, 'succeeded', run.error);
      assert.equal(await readFile(marker + '.value', 'utf8'), 'ENGINE_SYNTHETIC_SECRET');
      const diagnostic = await invoke('diagnostic_log', { runId: run.id });
      assert(!diagnostic.includes('ENGINE_SYNTHETIC_SECRET'));
      await writeFile(join(artifacts, 'secret-diagnostic.json'), diagnostic);
    },
  );
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (error) {
  errors.push(String(error));
  throw error;
} finally {
  fixture?.kill();
  await stop();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
}
