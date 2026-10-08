/** Real Windows windows/processes + Tauri IPC/UI. Only private fixture executables are closed. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const root = await mkdtemp(join(tmpdir(), 'lf-close-'));
const artifacts = resolve('test-results/workspace-close');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [],
  fixtures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const csc = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const good = join(root, 'LFGood.exe'),
  hold = join(root, 'LFHold.exe'),
  other = join(root, 'LFOther.exe');
execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/reference:System.Windows.Forms.dll',
    `/out:${good}`,
    resolve('scripts/fixtures/WorkspaceCloseFixture.cs'),
  ],
  { windowsHide: true },
);
await copyFile(good, hold);
await copyFile(good, other);
// These visible windows are the objects under test, and contain no user documents.
const launch = (exe, mode, marker) => {
  const p = spawn(exe, [mode, join(root, marker)], { windowsHide: false, stdio: 'ignore' });
  fixtures.push(p);
  return p;
};
const alive = (p) => {
  try {
    process.kill(p.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const native = (request) =>
  JSON.parse(
    execFileSync('native/bin/launchflow-automation.exe', [], {
      input: JSON.stringify(request) + '\n',
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
let app, browser, page;
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
      LAUNCHFLOW_TEST_DATA_DIR: join(root, 'data'),
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
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const fixtureApp = (capture, name) => {
  const a = capture.apps.find((a) => a.name === name);
  assert(a, `${name} captured`);
  return a;
};
const only = async (capture, names) => {
  for (const a of capture.apps.filter((a) => !a.blocked)) {
    await invoke('workspace_close_select', {
      token: capture.token,
      id: a.id,
      selected: names.includes(a.name),
    });
  }
};
const execute = (capture, ids, action, confirmed = false) =>
  invoke('workspace_close_execute', { token: capture.token, ids, action, confirmed });
const open = async () => {
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await page.getByRole('button', { name: '关闭工作区应用', exact: true }).click();
  await expect(page.getByLabel('关闭 LFGood', { exact: true })).toBeVisible();
};
try {
  const ok1 = launch(good, 'good', 'ok1'),
    ok2 = launch(good, 'good', 'ok2'),
    stubborn = launch(hold, 'hold', 'hold'),
    untouched = launch(other, 'good', 'other');
  await sleep(600);
  await start();
  await check(
    'Auto capture groups instances, protects LaunchFlow and persists deselection',
    async () => {
      await open();
      const row = page
        .locator('.close-app')
        .filter({ has: page.getByLabel('关闭 LFGood', { exact: true }) });
      await expect(row).toContainText('2 个窗口');
      await page.getByRole('button', { name: '全不选', exact: true }).click();
      await expect(page.getByRole('button', { name: '重新捕获', exact: true })).toBeEnabled();
      await page.getByLabel('关闭 LFGood', { exact: true }).check();
      await expect(page.getByRole('button', { name: '重新捕获', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '重新捕获', exact: true }).click();
      await expect(page.getByLabel('关闭 LFGood', { exact: true })).toBeChecked();
      await expect(page.getByLabel('关闭 LFOther', { exact: true })).not.toBeChecked();
      await expect(page.getByLabel('关闭 launchflow', { exact: true })).toBeDisabled();
      await page.screenshot({ path: join(artifacts, 'capture.png') });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    },
  );
  await stop();
  await start();
  await check('Selection survives desktop restart and app recapture', async () => {
    await open();
    await expect(page.getByLabel('关闭 LFGood', { exact: true })).toBeChecked();
    await expect(page.getByLabel('关闭 LFOther', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  });
  await check(
    'Backend rejects stale capture, protected targets and force before graceful',
    async () => {
      const before = await invoke('workspace_close_capture');
      const current = await invoke('workspace_close_capture');
      await assert.rejects(execute(before, [fixtureApp(before, 'LFGood').id], 'graceful'), /捕获/);
      await assert.rejects(
        execute(current, [fixtureApp(current, 'LFGood').id], 'force', true),
        /正常关闭/,
      );
      const self = current.apps.find((a) => a.name === 'launchflow');
      assert(self.blocked);
      await assert.rejects(execute(current, [self.id], 'graceful'), /请选择/);
      assert(alive(ok1) && alive(ok2) && alive(stubborn) && alive(untouched));
    },
  );
  await check('Native creation-time mismatch never closes a live fixture', async () => {
    const captured = native({ op: 'workspaceCloseCapture', ownerPid: app.pid });
    assert(captured.ok);
    const target = captured.result.find((a) => a.target.pid === ok1.pid).target;
    const result = native({
      op: 'workspaceClose',
      action: 'graceful',
      ownerPid: app.pid,
      targets: [{ ...target, started: '0' }],
    });
    assert.equal(result.result[0].state, 'stale');
    assert(alive(ok1));
  });
  await check(
    'Graceful close exits two instances, leaves a refusing and an unselected app alive',
    async () => {
      await open();
      // Recapture can discover new user apps: explicitly select fixtures again before any close.
      await page.getByRole('button', { name: '全不选', exact: true }).click();
      await expect(page.getByRole('button', { name: '重新捕获', exact: true })).toBeEnabled();
      await page.getByLabel('关闭 LFGood', { exact: true }).check();
      await expect(page.getByRole('button', { name: '重新捕获', exact: true })).toBeEnabled();
      await page.getByLabel('关闭 LFHold', { exact: true }).check();
      await expect(
        page.getByRole('button', { name: '一键关闭所选应用', exact: true }),
      ).toBeEnabled();
      assert.deepEqual(
        (
          await page
            .locator('.close-app input:checked:not(:disabled)')
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')))
        ).sort(),
        ['关闭 LFGood', '关闭 LFHold'],
      );
      await page.getByRole('button', { name: '一键关闭所选应用', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '强制关闭剩余 1 个', exact: true }),
      ).toBeVisible({ timeout: 20000 });
      assert(!alive(ok1) && !alive(ok2));
      assert(alive(stubborn) && alive(untouched));
      assert.match(await readFile(join(root, 'ok1'), 'utf8'), /close/);
      assert.match(await readFile(join(root, 'ok2'), 'utf8'), /close/);
      assert.match(await readFile(join(root, 'hold'), 'utf8'), /close/);
      await expect(page.locator('.close-toolbar')).toContainText('已选择 1 /');
      await sleep(200);
      await page.screenshot({ path: join(artifacts, 'graceful-result.png') });
    },
  );
  await check(
    'Force requires a separate confirmation and only closes the remaining selected app',
    async () => {
      await page.getByRole('button', { name: '强制关闭剩余 1 个', exact: true }).click();
      await expect(
        page.getByText('未保存的内容可能丢失。只终止本次已尝试正常关闭且仍在运行的进程。'),
      ).toBeVisible();
      await page.getByRole('button', { name: '继续等待', exact: true }).click();
      assert(alive(stubborn));
      await page.getByRole('button', { name: '强制关闭剩余 1 个', exact: true }).click();
      await page.getByRole('button', { name: '确认强制关闭', exact: true }).click();
      await expect.poll(() => alive(stubborn)).toBe(false);
      assert(alive(untouched));
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    },
  );
  await check(
    'A new process is untouched by an old snapshot and inherits selection by executable',
    async () => {
      const capture = await invoke('workspace_close_capture');
      const old = fixtureApp(capture, 'LFOther');
      await only(capture, ['LFOther']);
      const closed = await execute(capture, [old.id], 'graceful');
      assert.equal(fixtureApp(closed, 'LFOther').state, 'closed');
      const replacement = launch(other, 'good', 'replacement');
      await sleep(400);
      const stale = await execute(capture, [old.id], 'graceful');
      assert.equal(fixtureApp(stale, 'LFOther').state, 'closed');
      assert(alive(replacement));
      assert.equal(fixtureApp(await invoke('workspace_close_capture'), 'LFOther').selected, true);
    },
  );
  await check('New windows invalidate forced termination until recapture', async () => {
    const p = launch(hold, 'hold', 'new-window');
    await sleep(350);
    const capture = await invoke('workspace_close_capture');
    await only(capture, ['LFHold']);
    const target = fixtureApp(capture, 'LFHold');
    await execute(capture, [target.id], 'graceful');
    await writeFile(join(root, 'new-window.new'), 'create');
    await sleep(400);
    const result = await execute(capture, [target.id], 'force', true);
    assert.equal(fixtureApp(result, 'LFHold').state, 'stale');
    assert(alive(p));
  });
  await check(
    'Custom global shortcut opens review, reports conflicts, and survives scene refresh',
    async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('关闭工作区快捷键', { exact: true }).fill('Ctrl+Alt+Shift+F9');
      await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
      await expect(page.getByText('关闭工作区快捷键已保存', { exact: true })).toBeVisible();
      const reserved = launch(good, 'reserve', 'reserved');
      await expect
        .poll(async () => readFile(join(root, 'reserved'), 'utf8').catch(() => ''))
        .toBe('ready');
      await assert.rejects(
        invoke('workspace_close_shortcut_save', { shortcut: 'Ctrl+Alt+Shift+F10' }),
        /注册失败/,
      );
      assert.equal((await invoke('workspace_close_shortcut')).shortcut, 'Ctrl+Alt+Shift+F9');
      reserved.kill();
      await assert.rejects(invoke('workspace_close_shortcut_save', { shortcut: 'F9' }), /修饰键/);
      let scene = await invoke('create_scene', { name: 'hotkey-conflict-fixture' });
      scene.triggers = [
        {
          id: 'conflict',
          kind: 'globalHotkey',
          enabled: true,
          config: { shortcut: 'Ctrl+Alt+Shift+F9' },
        },
      ];
      await assert.rejects(invoke('save_scene', { scene }), /关闭工作区/);
      await sleep(500);
      execFileSync(good, ['hotkey'], { windowsHide: true });
      await expect(page.locator('.workspace-close')).toBeVisible();
    },
  );
  await stop();
  await start();
  await check('Shortcut re-registers on restart and can be disabled', async () => {
    assert.equal((await invoke('workspace_close_shortcut')).shortcut, 'Ctrl+Alt+Shift+F9');
    await sleep(500);
    execFileSync(good, ['hotkey'], { windowsHide: true });
    await expect(page.locator('.workspace-close')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新捕获', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await invoke('workspace_close_shortcut_save', { shortcut: '' });
    execFileSync(good, ['hotkey'], { windowsHide: true });
    await sleep(500);
    await expect(page.locator('.workspace-close')).toHaveCount(0);
  });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify({ checks, errors, fixtureDirectory: root }, null, 2),
  );
  await stop();
  for (const p of fixtures) if (alive(p)) p.kill();
}
console.log(JSON.stringify({ passed: checks.length, artifacts }));
