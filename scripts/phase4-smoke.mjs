/** Real Tauri + WebView2 + Credential Manager + native window product acceptance. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { callNative } from './test-native.mjs';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-phase4-'));
const artifacts = resolve('test-results/phase4');
await mkdir(artifacts, { recursive: true });
let app, browser, page, harnessPid, definitions;
const checks = [],
  errors = [];
const secretId = 'acceptance-' + Date.now();
const secret = 'SYNTHETIC_PHASE4_VALUE_847261';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function start(args = []) {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  app = spawn(resolve(local.targetDir, 'debug/launchflow.exe'), args, {
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
  if (!browser) throw Error('Desktop did not start');
  const c = browser.contexts()[0];
  page = c.pages()[0] || (await c.waitForEvent('page'));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
  definitions = (await invoke('bootstrap')).definitions;
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = null;
  app?.kill();
  await sleep(500);
}
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const node = (type, id, config = {}) => ({
  id,
  type,
  name: id,
  description: '',
  position: { x: 100, y: 100 },
  enabled: true,
  config: { ...structuredClone(definitions.find((d) => d.nodeType === type).defaults), ...config },
  retryPolicy: { maxRetries: 0, delayMs: 100 },
  timeoutMs: 15000,
  failurePolicy: 'stopWorkflow',
  platformConstraint: [],
  inputs: {},
  outputs: {},
  metadata: {},
});
const edge = (from, to) => ({ id: crypto.randomUUID(), from, to, outlet: 'success' });
async function scene(name, nodes, policy = 'blockAtStartup') {
  let s = await invoke('create_scene', { name });
  s.workflow = {
    nodes,
    edges: nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)),
    annotations: [],
  };
  s.sensitiveActionPolicy = policy;
  return invoke('save_scene', { scene: s });
}
async function finish(id) {
  await expect
    .poll(
      async () =>
        ['succeeded', 'failed', 'cancelled'].includes(
          (await invoke('bootstrap')).runs.find((r) => r.id === id)?.status,
        ),
      { timeout: 35000 },
    )
    .toBe(true);
  return (await invoke('bootstrap')).runs.find((r) => r.id === id);
}
const target = {
  application: 'launchflow-harness.exe',
  title: 'LaunchFlow Automation Test Harness',
};
const locator = (id) => ({ kind: 'accessibility', window: target, automationId: id });
try {
  await start();
  const boot = await invoke('bootstrap');
  await invoke('save_settings', {
    settings: { ...boot.settings, notifications: false, startupDelaySeconds: 0 },
  });
  harnessPid = (await invoke('automation_launch_harness')).pid;
  await expect
    .poll(async () => {
      try {
        return (await callNative({ op: 'window', window: target })).pid;
      } catch {
        return 0;
      }
    })
    .toBe(harnessPid);
  let captured, workspaceScene;
  await check(
    'Capture visible windows and create ordered scene with a relative workspace',
    async () => {
      captured = await invoke('workspace_capture');
      assert(captured.displays.length >= 1);
      const window = captured.windows.find((w) => w.identity.title === target.title);
      assert(window);
      assert(window.application.windows.executable);
      assert(window.startedAt);
      workspaceScene = await invoke('workspace_create_scene', {
        name: 'Phase 4 · 工作区',
        windows: [window],
        captureLayout: true,
        profileName: 'Office',
        monitorCount: captured.displays.length,
      });
      assert.deepEqual(
        workspaceScene.workflow.nodes.map((n) => n.type),
        ['application.launch', 'workspace.restore'],
      );
      await page.getByRole('button', { name: '工作区', exact: true }).click();
      await page.getByRole('button', { name: '捕获当前工作区', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: `包含 ${target.title}` })).toBeVisible();
      await page.screenshot({ path: join(artifacts, 'workspace-capture.png') });
    },
  );
  await check(
    'Relative / Exact restore and absent monitor fallback use real native windows',
    async () => {
      const original = await callNative({ op: 'window', window: target });
      await callNative({
        op: 'workspaceRestore',
        window: target,
        bounds: { x: 30, y: 40, width: 650, height: 600 },
        state: 'normal',
      });
      const result = await finish((await invoke('run_scene', { sceneId: workspaceScene.id })).id);
      assert.equal(result.status, 'succeeded', result.error);
      const restored = await callNative({ op: 'window', window: target });
      assert(Math.abs(restored.bounds.width - original.bounds.width) < 10);
      const changed = structuredClone(workspaceScene);
      const config = changed.workflow.nodes[1].config;
      config.mode = 'exact';
      config.profiles[0].windows[0].display.id = 'unplugged';
      config.profiles[0].windows[0].display.primary = false;
      config.profiles[0].windows[0].display.name = 'Missing display';
      config.profiles[0].windows[0].bounds = { x: -6000, y: -3000, width: 500, height: 500 };
      workspaceScene = await invoke('save_scene', { scene: changed });
      const fallback = await finish((await invoke('run_scene', { sceneId: workspaceScene.id })).id);
      assert.equal(fallback.status, 'succeeded', fallback.error);
      assert.equal(fallback.nodeRuns[1].output.windows[0].displayMatch, 'primary');
      const actual = await callNative({ op: 'window', window: target });
      assert(actual.bounds.x >= -10 && actual.bounds.y >= -10);
      const profiles = workspaceScene.workflow.nodes[1].config.profiles;
      profiles[0].condition.count = captured.displays.length + 1;
      const laptop = structuredClone(profiles[0]);
      laptop.name = 'Laptop';
      laptop.condition.count = captured.displays.length;
      laptop.windows[0].bounds = { x: 120, y: 90, width: 650, height: 600 };
      profiles.push(laptop);
      workspaceScene = await invoke('save_scene', { scene: workspaceScene });
      const selected = await finish((await invoke('run_scene', { sceneId: workspaceScene.id })).id);
      assert.equal(selected.status, 'succeeded', selected.error);
      assert.equal(selected.nodeRuns[1].output.profile, 'Laptop');
      const selectedBounds = (await callNative({ op: 'window', window: target })).bounds;
      assert(Math.abs(selectedBounds.x - 120) < 10 && Math.abs(selectedBounds.y - 90) < 10);
      await callNative({
        op: 'workspaceRestore',
        window: target,
        bounds: original.bounds,
        state: 'normal',
      });
    },
  );
  await check('OS vault lifecycle, metadata-only UI, execution and history redaction', async () => {
    await invoke('vault_write', { id: secretId, label: '验收凭据', value: secret, update: false });
    const entries = await invoke('vault_metadata');
    assert(entries.some((e) => e.id === secretId));
    assert(!JSON.stringify(entries).includes(secret));
    assert.equal((await callNative({ op: 'vault', action: 'read', id: secretId })).value, secret);
    await invoke('vault_write', {
      id: secretId,
      label: '验收凭据（已更新）',
      value: secret + '-updated',
      update: true,
    });
    const secretScene = await scene('Phase 4 · Vault', [
      node('gui.inputSecret', 'Secret', {
        locators: [locator('password-input')],
        secretRef: `vault:${secretId}`,
      }),
    ]);
    const run = await finish((await invoke('run_scene', { sceneId: secretScene.id })).id);
    assert.equal(run.status, 'succeeded', run.error);
    assert(!JSON.stringify(run).includes(secret));
    await page.getByRole('button', { name: '权限与凭据', exact: true }).click();
    await expect(page.getByText('验收凭据（已更新）', { exact: true })).toBeVisible();
    assert(!(await page.locator('body').innerText()).includes(secret));
    await page.screenshot({ path: join(artifacts, 'permissions-vault.png') });
  });
  await check(
    'YAML/package export, preview, immutable source, rebind and safe import',
    async () => {
      const yaml = join(dataDir, 'workspace.yaml'),
        pkg = join(dataDir, 'workspace.launchflow');
      await invoke('scene_export', { sceneId: workspaceScene.id, path: yaml, package: false });
      await invoke('scene_export', { sceneId: workspaceScene.id, path: pkg, package: true });
      assert((await readFile(yaml, 'utf8')).includes('schemaVersion: 2'));
      const pending = await invoke('scene_import_preview', { path: pkg });
      assert(pending.analysis.ready);
      assert.equal(pending.analysis.document.scene.name, workspaceScene.name);
      const before = (await invoke('bootstrap')).runs.length;
      await writeFile(pkg, 'changed after preview');
      const imported = await invoke('scene_import_commit', { token: pending.token, mappings: {} });
      assert.notEqual(imported.id, workspaceScene.id);
      assert(!imported.isDefault);
      assert.equal(imported.sensitiveActionPolicy, 'askEveryTime');
      assert(imported.triggers.every((t) => !t.enabled));
      assert.equal((await invoke('bootstrap')).runs.length, before);
      await assert.rejects(() =>
        invoke('scene_import_commit', { token: pending.token, mappings: {} }),
      );
      const doc = pending.analysis.document;
      doc.applications[0].id = 'foreign-app';
      doc.applications[0].displayName = 'Missing device app';
      doc.applications[0].windows.executable = 'Z:/no-application.exe';
      for (const n of doc.scene.workflow.nodes) {
        if (n.type === 'application.launch') n.config.applicationId = 'foreign-app';
        if (n.type === 'workspace.restore')
          for (const p of n.config.profiles)
            for (const w of p.windows) w.applicationId = 'foreign-app';
      }
      doc.scene.parameters = [
        {
          name: 'credential',
          kind: 'secretReference',
          description: '',
          required: true,
          defaultValue: 'vault:missing-on-this-device',
          options: [],
          validation: {},
        },
      ];
      const missingFile = join(dataDir, 'missing.yaml');
      await writeFile(missingFile, JSON.stringify(doc));
      const missing = await invoke('scene_import_preview', { path: missingFile });
      assert(!missing.analysis.ready);
      assert(missing.analysis.bindings.some((b) => b.kind === 'application' && !b.found));
      assert(missing.analysis.bindings.some((b) => b.kind === 'secret' && !b.found));
      const mappings = {
        applications: { 'foreign-app': workspaceScene.workflow.nodes[0].config.applicationId },
        secrets: { 'vault:missing-on-this-device': `vault:${secretId}` },
        paths: {},
      };
      const rebound = await invoke('scene_import_rebind', { token: missing.token, mappings });
      assert(rebound.analysis.ready, JSON.stringify(rebound.analysis.bindings));
      await invoke('scene_import_commit', { token: missing.token, mappings });
      await page.reload();
      await page.getByRole('button', { name: '导入与导出', exact: true }).click();
      await page.getByLabel('导入文件路径', { exact: true }).fill(missingFile);
      await page.getByRole('button', { name: '校验并预览', exact: true }).click();
      await expect(page.getByText('Missing', { exact: true }).first()).toBeVisible();
      await page
        .getByLabel('映射应用 Missing device app', { exact: true })
        .selectOption(workspaceScene.workflow.nodes[0].config.applicationId);
      await page
        .getByLabel('映射凭据 vault:missing-on-this-device', { exact: true })
        .fill(`vault:${secretId}`);
      await page.getByRole('button', { name: '检查映射', exact: true }).click();
      await expect(
        page.getByRole('checkbox', { name: '我已核对预览内容和本机映射' }),
      ).toBeEnabled();
      await page.getByRole('checkbox', { name: '我已核对预览内容和本机映射' }).check();
      await page.screenshot({ path: join(artifacts, 'transfer.png') });
      await page.getByRole('button', { name: '导入场景', exact: true }).click();
      await expect(page.getByText('已导入场景，触发器保持关闭', { exact: true })).toBeVisible();
      assert.equal((await invoke('bootstrap')).runs.length, before);
    },
  );
  await check('Ask Every Time rejects direct execution until explicit UI approval', async () => {
    const s = await scene(
      'Phase 4 · 敏感操作确认',
      [node('gui.click', 'Click', { locators: [locator('start-button')] })],
      'askEveryTime',
    );
    await assert.rejects(() => invoke('run_scene', { sceneId: s.id }), /sensitiveApprovalRequired/);
    await page.reload();
    await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^我的场景/ }).click();
    const card = page
      .locator('.scene-card')
      .filter({ has: page.getByRole('heading', { name: s.name, exact: true }) });
    await card.getByRole('button', { name: '运行', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '确认本次敏感操作', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'sensitive-confirmation.png') });
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect
      .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.sceneId === s.id)?.status)
      .toBe('succeeded');
  });
  await check(
    'Diagnostics export omits secret bytes and production updater is disabled in development',
    async () => {
      const path = join(artifacts, 'diagnostics.zip');
      await invoke('export_diagnostics', { path });
      const status = await invoke('update_status');
      assert.equal(status.enabled, false);
      await assert.rejects(() => invoke('update_check'));
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('历史保留策略').selectOption('0');
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await expect.poll(async () => (await invoke('bootstrap')).settings.retentionDays).toBe(0);
      await page.screenshot({ path: join(artifacts, 'settings-diagnostics.png') });
    },
  );
  await check(
    'Interrupted runs are detected; safe resume reuses completed work without automatic replay',
    async () => {
      const s = await scene('Phase 4 · 意外中断', [
        node('system.delay', 'First', { durationMs: 1 }),
        node('system.delay', 'Wait', { durationMs: 3000 }),
      ]);
      const run = await invoke('run_scene', { sceneId: s.id });
      await expect
        .poll(
          async () =>
            (await invoke('bootstrap')).runs.find((r) => r.id === run.id)?.nodeRuns[1].status,
        )
        .toBe('waiting');
      await stop();
      await start();
      const previous = (await invoke('bootstrap')).runs.find((r) => r.id === run.id);
      assert.equal(previous.status, 'interrupted');
      await sleep(200);
      assert.equal((await invoke('bootstrap')).runs.filter((r) => r.sceneId === s.id).length, 1);
      const resumed = await finish(
        (await invoke('recover_run', { runId: run.id, action: 'safeResume', nodeId: null })).id,
      );
      assert.equal(resumed.status, 'succeeded');
      assert.equal(resumed.nodeRuns[0].reusedFrom, run.id);
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'desktop-acceptance.json'),
    JSON.stringify({ checks, errors, dataDir, displays: captured.displays }, null, 2),
  );
  console.log(`Verified ${checks.length} Phase 4 desktop acceptance flows.`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(artifacts, 'failure-ui.png') }).catch(() => {});
    await writeFile(
      join(artifacts, 'failure-ui.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  await callNative({ op: 'vault', action: 'delete', id: secretId }).catch(() => {});
  if (harnessPid) {
    try {
      process.kill(harnessPid);
    } catch {}
  }
  await stop();
}
