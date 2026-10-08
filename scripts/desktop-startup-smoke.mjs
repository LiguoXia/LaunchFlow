/** Isolated real Tauri + Task Scheduler acceptance. Never changes ARSO or locks/reboots Windows. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const binary = resolve(local.targetDir, 'debug/launchflow.exe');
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-prestart-'));
const artifacts = resolve(process.argv[2] || 'test-results/desktop-startup');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
let app,
  browser,
  page,
  registrationId,
  taskName,
  scheduled = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const ps = (code) =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + code],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
const scheduler = (code) => {
  assert(registrationId?.startsWith('app.launchflow.test'));
  assert(/^LaunchFlow-Prestart-[A-F0-9]{24}$/.test(taskName));
  return ps(
    `$lfService=New-Object -ComObject Schedule.Service; $lfService.Connect(); $lfFolder=$lfService.GetFolder('\\'); $lfTask=$lfFolder.GetTask(${quote(taskName)}); ` +
      code,
  );
};
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
  app = spawn(binary, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LAUNCHFLOW_TEST_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  for (let i = 0; i < 120 && !browser; i++) {
    if (app.exitCode !== null) throw Error('Test app exited before connecting');
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
  if (app?.exitCode === null) {
    const exit = new Promise((r) => app.once('exit', r));
    app.kill();
    await exit;
  }
  await sleep(500);
}
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const refresh = async () => {
  await page.getByRole('button', { name: '刷新启动检测', exact: true }).click();
};
async function select(mode) {
  const input = page.getByLabel('LaunchFlow 自动启动方式', { exact: true });
  await expect(input).toBeEnabled();
  await input.selectOption(mode);
  await expect(input).toHaveValue(mode);
  await expect(input).toBeEnabled();
}
const runs = () =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--experimental-sqlite',
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(JSON.stringify(db.prepare('SELECT document FROM runs').all().map(r => JSON.parse(r.document)))); db.close();",
        join(dataDir, 'launchflow.db'),
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ),
  );
try {
  await start();
  await check('Empty isolated profile and real Windows startup diagnostics', async () => {
    const initial = await invoke('bootstrap');
    assert.equal(initial.scenes.length, 0);
    assert.equal(initial.runs.length, 0);
    const status = await invoke('startup_status');
    registrationId = status.registrationId;
    taskName = status.task.taskName;
    assert(registrationId.startsWith('app.launchflow.test'));
    assert.equal(status.task.registered, false);
    assert.equal(status.legacyEnabled, false);
    assert.equal(status.desktopReady, true);
    assert.equal(status.task.error, '');
    await writeFile(join(artifacts, 'initial-status.json'), JSON.stringify(status, null, 2));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('LaunchFlow 自动启动方式', { exact: true })).toBeEnabled();
    await expect(
      page.getByText('不能保证每次冷启动都提前打开应用。', { exact: false }),
    ).toBeVisible();
  });
  await check(
    'UI registers current-user interactive least-privilege task without credentials',
    async () => {
      await select('beforeUnlock');
      const status = await invoke('startup_status');
      assert.equal(status.task.matches, true);
      assert.equal(status.task.enabled, true);
      assert.equal(status.legacyEnabled, false);
      const definition = JSON.parse(
        scheduler(
          `$lfDef=$lfTask.Definition; [pscustomobject]@{logon=$lfDef.Principal.LogonType;runLevel=$lfDef.Principal.RunLevel;user=([Security.Principal.NTAccount]::new($lfDef.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value;currentUser=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;trigger=$lfDef.Triggers.Item(1).Type;path=$lfDef.Actions.Item(1).Path;arguments=$lfDef.Actions.Item(1).Arguments;limit=$lfDef.Settings.ExecutionTimeLimit;instances=$lfDef.Settings.MultipleInstances;lastRun=$lfTask.LastRunTime.ToString('o')} | ConvertTo-Json -Compress`,
        ),
      );
      assert.equal(definition.logon, 3);
      assert.equal(definition.runLevel, 0);
      assert.equal(definition.trigger, 9);
      assert.equal(definition.user.toLowerCase(), definition.currentUser.toLowerCase());
      assert.equal(definition.path.toLowerCase(), binary.toLowerCase());
      assert(definition.arguments.startsWith('--startup --test-data-dir '));
      assert(definition.arguments.includes(dataDir));
      assert.equal(definition.limit, 'PT0S');
      assert.equal(definition.instances, 2);
      assert.equal(runs().length, 0, 'Registering must not run the default scene');
      await writeFile(join(artifacts, 'task-definition.json'), JSON.stringify(definition, null, 2));
      await expect(
        page.getByText('已登记会话建立时启动 · 等待重启验收', { exact: false }),
      ).toBeVisible();
      await page.screenshot({ path: join(artifacts, 'settings.png'), fullPage: true });
    },
  );
  await check(
    'Invalid mode is rejected; switching login and prestart avoids duplicate registrations',
    async () => {
      await assert.rejects(() => invoke('set_startup_mode', { mode: 'system' }));
      assert.equal((await invoke('startup_status')).task.matches, true);
      await select('login');
      let status = await invoke('startup_status');
      assert.equal(status.legacyEnabled, true);
      assert.equal(status.task.registered, false);
      await select('beforeUnlock');
      status = await invoke('startup_status');
      assert.equal(status.legacyEnabled, false);
      assert.equal(status.task.matches, true);
    },
  );
  await check(
    'Moved or outdated registration is detected and repaired through the UI',
    async () => {
      scheduler(
        `$lfDef=$lfTask.Definition; $lfDef.Actions.Item(1).Arguments='--stale-test-registration'; $null=$lfFolder.RegisterTaskDefinition(${quote(taskName)},$lfDef,6,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,$null,3,$null)`,
      );
      assert.equal((await invoke('startup_status')).task.matches, false);
      await refresh();
      await expect(page.getByText('启动任务需要重新配置', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '重新登记当前版本', exact: true }).click();
      await expect.poll(async () => (await invoke('startup_status')).task.matches).toBe(true);
    },
  );
  await check(
    'Policy-blocked and opted-out Windows states remain explicit (UI response fixtures)',
    async () => {
      await page.evaluate(() => {
        window.__prestartOriginal = window.fetch;
        window.__prestartConditions = { disabledByPolicy: 1 };
        window.fetch = async (input, ...args) => {
          const response = await window.__prestartOriginal(input, ...args);
          if (new URL(String(input)).pathname === '/startup_status') {
            const data = await response.clone().json();
            data.conditions = window.__prestartConditions;
            return new Response(JSON.stringify(data), {
              status: response.status,
              headers: response.headers,
            });
          }
          return response;
        };
      });
      await refresh();
      await expect(page.getByText('被系统策略禁用', { exact: false })).toBeVisible();
      await page.evaluate(() => {
        window.__prestartConditions = { userOptOut: 1 };
      });
      await refresh();
      await expect(page.getByText('当前用户已关闭', { exact: false })).toBeVisible();
      await page.evaluate(() => {
        window.fetch = window.__prestartOriginal;
      });
      await refresh();
    },
  );
  await check(
    'Actual Task Scheduler launches the isolated app and runs its default scene once',
    async () => {
      const initial = await invoke('bootstrap');
      await invoke('save_settings', {
        settings: { ...initial.settings, notifications: false, startupDelaySeconds: 0 },
      });
      const scene = await invoke('create_scene', { name: '解锁前准备验收' });
      scene.workflow.nodes = [
        {
          id: 'startup-delay',
          type: 'system.delay',
          name: '独立启动验收',
          description: '',
          position: { x: 0, y: 0 },
          enabled: true,
          config: { durationMs: 80 },
          retryPolicy: { maxRetries: 0, delayMs: 100 },
          timeoutMs: 5000,
          failurePolicy: 'stopWorkflow',
          platformConstraint: [],
          inputs: {},
          outputs: {},
          metadata: {},
        },
      ];
      scene.workflow.edges = [];
      await invoke('save_scene', { scene });
      await invoke('set_default_scene', { sceneId: scene.id });
      await stop();
      // Recheck the explicit isolated path before starting any persisted entry.
      const argumentsText = scheduler('$lfTask.Definition.Actions.Item(1).Arguments');
      assert(argumentsText.includes(dataDir) && argumentsText.includes('--test-data-dir'));
      scheduler('$null=$lfTask.Run($null)');
      scheduled = true;
      await expect
        .poll(
          () => runs().filter((r) => r.source === 'startup' && r.status === 'succeeded').length,
          { timeout: 30000, intervals: [500, 1000] },
        )
        .toBe(1);
      const observation = JSON.parse(
        await readFile(join(dataDir, 'automation/startup-observation.json'), 'utf8'),
      );
      assert.equal(typeof observation.started.desktopReady, 'boolean');
      assert(observation.dispatch.at);
      const second = spawn(binary, ['--startup', '--test-data-dir', dataDir], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((r) => second.once('exit', r));
      await sleep(1500);
      assert.equal(runs().length, 1, 'Repeated startup invocation must not execute twice');
      await writeFile(
        join(artifacts, 'scheduled-startup.json'),
        JSON.stringify({ observation, runs: runs() }, null, 2),
      );
      scheduler('$lfTask.Stop(0)');
      scheduled = false;
      await sleep(1000);
      await start();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(
        page.getByText('当时桌面可交互，不能证明解锁前启动', { exact: false }),
      ).toBeVisible();
    },
  );
  await check('Disabling removes only the isolated task and startup registration', async () => {
    await select('disabled');
    const status = await invoke('startup_status');
    assert.equal(status.task.registered, false);
    assert.equal(status.legacyEnabled, false);
    await page.getByText('启动诊断', { exact: true }).click();
    await expect(page.getByLabel('启动诊断内容')).toHaveValue(/0[.]4[.]9/);
    await page.screenshot({ path: join(artifacts, 'diagnostics.png'), fullPage: true });
  });
  assert.deepEqual(errors, []);
} catch (e) {
  await page?.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  throw e;
} finally {
  if (registrationId?.startsWith('app.launchflow.test')) {
    if (scheduled) scheduler('$lfTask.Stop(0)');
    // Only remove our exact generated registrations, even if the UI assertion failed.
    ps(
      `$lfService=New-Object -ComObject Schedule.Service; $lfService.Connect(); $lfFolder=$lfService.GetFolder('\\'); try {$lfTask=$lfFolder.GetTask(${quote(taskName)})} catch {$lfTask=$null}; if($lfTask){$lfFolder.DeleteTask(${quote(taskName)},0)}; $lfRun=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run',$true); if($lfRun){try{$lfRun.DeleteValue(${quote(registrationId)},$false)}finally{$lfRun.Dispose()}}`,
    );
  }
  await stop();
  await writeFile(
    join(artifacts, 'desktop-startup-smoke.json'),
    JSON.stringify(
      {
        checks,
        errors,
        dataDir,
        registrationId,
        taskName,
        limitation:
          'Task run tested in unlocked session; no real reboot, lock or ARSO setting changes.',
      },
      null,
      2,
    ),
  );
}
console.log(`Verified ${checks.length} desktop startup flows. Artifacts: ${artifacts}`);
