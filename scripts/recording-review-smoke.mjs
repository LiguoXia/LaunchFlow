/** Real recorder/session acknowledgement regression in an isolated desktop profile. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { callNative } from './test-native.mjs';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-recording-review-'));
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
const artifacts = resolve('test-results/recording-review');
await mkdir(artifacts, { recursive: true });
const socket = createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const app = spawn(resolve(local.targetDir, 'debug/launchflow.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    LAUNCHFLOW_TEST_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  },
});
const harness = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const locked = process.argv.includes('--locked');
let browser, page;
const checks = [],
  errors = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const review = () => page.getByRole('heading', { name: '审阅录制 Actions', exact: true });
const window = { pid: harness.pid, title: 'LaunchFlow Automation Test Harness' };
async function record(text = 'review fixture') {
  await page.getByRole('button', { name: 'Start Recording', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const recordedWindowLabel = (await invoke('automation_windows'))
    .filter((w) => w.pid === harness.pid)
    .map((w) => `${w.application} · ${w.title}`)[0];
  await dialog
    .getByRole('combobox', { name: '当前桌面窗口', exact: true })
    .fill(recordedWindowLabel);
  await page.getByRole('option', { name: recordedWindowLabel, exact: true }).click();
  await dialog.getByRole('button', { name: 'Start Recording', exact: true }).click();
  await expect(page.getByText('Recording 录制中', { exact: true })).toBeVisible();
  if (text) {
    const target = (await callNative({ op: 'windows' })).find((w) => w.pid === harness.pid);
    execFileSync(foregroundFixture, [String(harness.pid), target.handle, '--caption'], {
      windowsHide: true,
      timeout: 8000,
    });
    await callNative({
      op: 'perform',
      window,
      locator: { kind: 'accessibility', automationId: 'project-input' },
      action: { kind: 'inputText', text },
    });
    await callNative({
      op: 'perform',
      window,
      locator: { kind: 'accessibility', automationId: 'start-button' },
      action: { kind: 'click' },
    });
  }
  await sleep(500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect
    .poll(async () => (await invoke('automation_session_current')).status)
    .toBe('stopped');
  if (text) await expect(review()).toBeVisible();
}
async function revisit() {
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '工作流编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Recording', exact: true })).toBeVisible();
  await sleep(350);
  await expect(review()).toHaveCount(0);
}
try {
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
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  await page.getByLabel('场景名称', { exact: true }).fill('录制审阅回归');
  await page.getByRole('button', { name: '创建场景', exact: true }).click();
  await check('Dismissed real recording does not reopen after editor remount', async () => {
    await record();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await expect(review()).toHaveCount(0);
    const s = await invoke('automation_session_current');
    assert.equal(s.reviewed, true);
    assert.equal(s.actions.length, 0);
    await revisit();
    await revisit();
  });
  await check('Discarded new recording is consumed independently', async () => {
    await record('second review fixture');
    await page.getByRole('button', { name: '放弃录制', exact: true }).click();
    await expect(review()).toHaveCount(0);
    await revisit();
  });
  await check(
    'Inserted recording appears once and stays consumed after webview reload',
    async () => {
      await record('inserted review fixture');
      const count = (await invoke('automation_session_current')).actions.length;
      const before = await page.locator('.node-card').count();
      await page.getByRole('button', { name: '确认并插入 Workflow', exact: true }).click();
      await expect(page.locator('.node-card')).toHaveCount(before + count);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
      await revisit();
      await page.reload();
      await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^我的场景/ }).click();
      await page.locator('.scene-card').getByRole('button', { name: '编辑', exact: true }).click();
      await sleep(350);
      await expect(review()).toHaveCount(0);
      await expect(page.locator('.node-card')).toHaveCount(before + count);
    },
  );
  await check('Empty recording does not open an empty review', async () => {
    await record('');
    await sleep(350);
    await expect(review()).toHaveCount(0);
    await revisit();
  });
  if (!locked)
    await check(
      'Recorded activation and click replay from another foreground window, minimized and maximized',
      async () => {
        const saved = (await invoke('bootstrap')).scenes.find((s) => s.name === '录制审阅回归');
        assert(saved.workflow.nodes.some((n) => n.type === 'gui.activateWindow'));
        assert(saved.workflow.nodes.some((n) => n.type === 'gui.click'));
        const foreground = (await invoke('automation_windows')).find((w) => w.pid === app.pid);
        assert(foreground, 'Isolated LaunchFlow window exists');
        const resultName = async () =>
          (
            await callNative({
              op: 'find',
              window,
              locator: { kind: 'accessibility', automationId: 'result-label' },
            })
          ).name;
        const runs = [];
        for (const state of ['normal', 'minimize', 'maximize', 'normal', 'normal']) {
          const before = await resultName();
          if (state !== 'normal')
            await callNative({ op: 'perform', window, action: { kind: state } });
          execFileSync(foregroundFixture, [String(app.pid), foreground.handle, '--caption'], {
            windowsHide: true,
            timeout: 8000,
          });
          assert.equal(
            (await callNative({ op: 'window', window: { handle: foreground.handle } })).focused,
            true,
          );
          const id = (await invoke('run_scene', { sceneId: saved.id })).id;
          let run;
          await expect
            .poll(
              async () => {
                run = (await invoke('bootstrap')).runs.find((r) => r.id === id);
                return ['succeeded', 'failed', 'cancelled'].includes(run?.status);
              },
              { timeout: 30000 },
            )
            .toBe(true);
          assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
          assert.notEqual(await resultName(), before, 'Recorded click delivered to fixture');
          const focused = run.nodeRuns.find((n) => n.output?.automation?.focus)?.output.automation
            .focus;
          assert.equal(focused?.foregroundMatched, true);
          // Windows may deny the optional grant while accepting activation.
          // Actual foreground ownership and the delivered click are authoritative.
          assert.equal(typeof focused.foregroundGrantAccepted, 'boolean');
          if (state === 'maximize')
            assert.equal((await callNative({ op: 'window', window })).state, 'maximized');
          if (state === 'minimize')
            assert.notEqual((await callNative({ op: 'window', window })).state, 'minimized');
          const diagnostic = JSON.parse(await invoke('diagnostic_log', { runId: id }));
          assert(diagnostic.run.nodes.some((n) => n.automation?.focus?.foregroundMatched === true));
          assert(!JSON.stringify(diagnostic).includes('inserted review fixture'));
          runs.push({ state, diagnostic });
        }
        await writeFile(join(artifacts, 'focus-replay.json'), JSON.stringify(runs, null, 2));
      },
    );
  await check(
    `${locked ? 'Locked desktop focus denial' : 'Native GUI failure'} keeps one error prefix and reaches copied diagnostic log`,
    async () => {
      const scene = structuredClone(
        (await invoke('bootstrap')).scenes.find((s) => s.name === '录制审阅回归'),
      );
      const recorded = scene.workflow.nodes.find((n) => n.type === 'gui.activateWindow');
      const node = {
        ...recorded,
        id: 'invalid-key-fixture',
        type: 'gui.pressKey',
        name: 'Invalid fixture key',
        config: { ...recorded.config, key: 'UnsupportedFixtureKey', captureOnFailure: false },
      };
      scene.workflow.nodes.push(node);
      const id = (await invoke('automation_test_action', { scene, nodeId: node.id })).id;
      let run;
      await expect
        .poll(
          async () => {
            run = (await invoke('bootstrap')).runs.find((r) => r.id === id);
            return run?.status;
          },
          { timeout: 30000 },
        )
        .toBe('failed');
      assert.equal((run.error.match(/GUI automation failed/g) || []).length, 1);
      const report = JSON.parse(await invoke('diagnostic_log', { runId: id }));
      assert.equal(
        report.run.nodes[0].automation.errorCode,
        locked ? 'focusDenied' : 'invalidAction',
      );
      if (locked) {
        assert.equal(report.run.nodes[0].automation.focus.stage, 'foregroundTimeout');
        assert.equal(report.run.nodes[0].automation.focus.foregroundMatched, false);
      }
      await writeFile(join(artifacts, 'failure-diagnostic.json'), JSON.stringify(report, null, 2));
    },
  );
  await page.screenshot({ path: join(artifacts, 'editor.png') });
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw e;
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  harness.kill();
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        checks,
        errors,
        dataDir,
        blockedChecks: locked
          ? [
              'Foreground replay, minimized restore, maximized preservation: desktop is locked (LockApp)',
            ]
          : [],
      },
      null,
      2,
    ),
  );
}
