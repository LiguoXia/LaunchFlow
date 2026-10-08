/** Real Tauri UI/IPC/storage check. Never accepts or bypasses a UAC prompt. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-uac-'));
const artifacts = resolve('test-results/preauthorization/desktop');
await mkdir(artifacts, { recursive: true });
let app, browser, page;
const checks = [],
  errors = [];
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
  assert(browser, 'Desktop started');
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
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
try {
  await start();
  await check('Legacy profile defaults to unelevated through real IPC', async () => {
    await invoke('save_profile', {
      profile: {
        schemaVersion: 1,
        id: 'legacy-uac',
        displayName: '旧配置兼容验收',
        windows: { executable: 'C:\\missing-uac-fixture.exe', processName: '' },
        macos: { appPath: '', bundleId: '', processName: '' },
        launchArguments: [],
        readyDetection: null,
      },
    });
    assert.equal((await invoke('bootstrap')).profiles[0].windows.runAsAdministrator, false);
  });
  await check('Application UI saves explicit administrator launch', async () => {
    await page.reload();
    await page.getByRole('button', { name: '应用库', exact: true }).click();
    await page.getByRole('button', { name: '编辑 旧配置兼容验收', exact: true }).click();
    await expect(page.getByLabel('以管理员身份启动', { exact: true })).not.toBeChecked();
    await page.getByLabel('以管理员身份启动', { exact: true }).check();
    await page.screenshot({ path: join(artifacts, 'administrator-setting.png') });
    await page.getByRole('button', { name: '保存应用', exact: true }).click();
    await expect(page.getByText('应用配置已保存', { exact: true })).toBeVisible();
    assert.equal((await invoke('bootstrap')).profiles[0].windows.runAsAdministrator, true);
  });
  await stop();
  await start();
  await check('Administrator flag survives desktop restart', async () => {
    await page.getByRole('button', { name: '应用库', exact: true }).click();
    await page.getByRole('button', { name: '编辑 旧配置兼容验收', exact: true }).click();
    await expect(page.getByLabel('以管理员身份启动', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '取消', exact: true }).click();
  });
  await check('Native launch rejection reaches history with zero automatic retries', async () => {
    const boot = await invoke('bootstrap');
    await invoke('save_settings', { settings: { ...boot.settings, notifications: false } });
    let scene = await invoke('create_scene', { name: '管理员启动错误验收' });
    scene.workflow.nodes = [
      {
        id: 'uac-launch',
        type: 'application.launch',
        name: '缺失路径',
        description: '',
        position: { x: 0, y: 0 },
        enabled: true,
        config: { applicationId: 'legacy-uac', arguments: [], alreadyRunning: 'newInstance' },
        retryPolicy: { maxRetries: 3, delayMs: 50 },
        timeoutMs: 5000,
        failurePolicy: 'stopWorkflow',
        platformConstraint: [],
        inputs: {},
        outputs: {},
        metadata: {},
      },
    ];
    scene = await invoke('save_scene', { scene });
    const started = await invoke('run_scene', { sceneId: scene.id });
    let run;
    await expect
      .poll(
        async () => {
          run = (await invoke('bootstrap')).runs.find((r) => r.id === started.id);
          return run.status;
        },
        { timeout: 10000 },
      )
      .toBe('failed');
    assert.match(run.error, /有效的 .exe/);
    assert.equal(run.nodeRuns[0].retryCount, 0);
    await writeFile(join(artifacts, 'failed-launch.json'), JSON.stringify(run, null, 2));
  });
  await check(
    'Preauthorization controls show missing grant and persist selected mode',
    async () => {
      await page.getByRole('button', { name: '编辑 旧配置兼容验收', exact: true }).click();
      const mode = page.getByLabel('使用预授权启动（首次确认，后续免确认）', { exact: true });
      await mode.check();
      await expect(
        page.getByRole('button', { name: '保存并授权免确认启动', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('授权状态：尚未授权', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(artifacts, 'preauthorization-setting.png') });
      await page.getByRole('button', { name: '保存应用', exact: true }).click();
      await expect
        .poll(async () => (await invoke('bootstrap')).profiles[0].windows.usePreauthorizedTask)
        .toBe(true);
    },
  );
  await stop();
  await start();
  await check('Missing preauthorization stops workflow without falling back to UAC', async () => {
    const boot = await invoke('bootstrap');
    assert.equal(boot.profiles[0].windows.usePreauthorizedTask, true);
    const started = await invoke('run_scene', { sceneId: boot.scenes[0].id });
    let run;
    await expect
      .poll(
        async () => {
          run = (await invoke('bootstrap')).runs.find((r) => r.id === started.id);
          return run.status;
        },
        { timeout: 10000 },
      )
      .toBe('failed');
    assert.match(run.error, /尚未预授权|已撤销/);
    assert.equal(run.nodeRuns[0].retryCount, 0);
  });
  await check(
    'Persisted launch diagnostics retain native stages and omit paths/arguments',
    async () => {
      const text = await invoke('diagnostic_log', { runId: null });
      const report = JSON.parse(text);
      assert(
        report.events.some(
          (e) =>
            e.outcome === 'failed' &&
            e.native.steps.some((s) => s.stage === 'application.validate'),
        ),
      );
      assert(
        report.events.some(
          (e) => e.operation === 'applicationAuthorizationRun' && e.outcome === 'failed',
        ),
      );
      assert(!text.includes('missing-uac-fixture'));
      assert(!text.includes('旧配置兼容验收'));
      await writeFile(join(artifacts, 'diagnostic-log.json'), text);
      await invoke('export_diagnostics', { path: join(artifacts, 'diagnostics.zip') });
    },
  );
  await check('Settings copies diagnostics and offers a manual fallback', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
    const area = page.getByLabel('诊断日志内容');
    await expect(area).toBeVisible();
    const expected = await area.inputValue();
    await expect
      .poll(
        async () =>
          (await page
            .getByText('诊断日志已复制，可粘贴到问题反馈中', { exact: true })
            .isVisible()) || (await page.getByText(/自动复制不可用/).isVisible()),
      )
      .toBe(true);
    // Test clipboard content only after our own copy action; never collect the user's prior clipboard.
    if (!(await page.getByText(/自动复制不可用/).isVisible())) {
      // Browser clipboard.readText opens a separate WebView2 permission dialog. Inspect only
      // whether the native clipboard matches our own report, without returning its content.
      const hash = createHash('sha256').update(expected.replaceAll('\r\n', '\n')).digest('hex');
      const matches = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; $clip=[System.Windows.Forms.Clipboard]::GetText().Replace([string][char]13+[char]10,[string][char]10); $sha=[Security.Cryptography.SHA256]::Create(); $actual=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($clip)))).Replace('-','').ToLowerInvariant(); $actual -eq '${hash}'`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      ).trim();
      assert.equal(matches, 'True', 'Native clipboard must equal the displayed diagnostic report');
    }
    await page.screenshot({ path: join(artifacts, 'diagnostic-log.png') });
    await page.getByRole('button', { name: '关闭日志', exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new Error('Clipboard denied fixture')),
      });
    });
    await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
    await expect(page.getByText(/自动复制不可用/)).toBeVisible();
    await expect(area).toHaveValue(/applicationAuthorizationRun/);
    await page.getByRole('button', { name: '关闭日志', exact: true }).click();
    await page.evaluate(() => {
      delete navigator.clipboard.writeText;
    });
  });
  await check('Failed run has a copyable report with its run context', async () => {
    await page.getByRole('button', { name: '运行历史', exact: true }).click();
    await page.locator('.run-name').first().click();
    await page.getByRole('button', { name: '复制诊断日志', exact: true }).click();
    const report = JSON.parse(await page.getByLabel('诊断日志内容').inputValue());
    assert.equal(report.run.status, 'failed');
    assert.equal(report.run.nodes[0].retryCount, 0);
    await page.getByRole('button', { name: '关闭日志', exact: true }).click();
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'desktop-report.json'),
    JSON.stringify(
      { checks, errors, dataDir, realUacConsent: 'not exercised; requires human interaction' },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
