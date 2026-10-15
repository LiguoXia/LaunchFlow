/** Real editor, native input hooks and owned fixture windows; isolated user data. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-picker-'));
const artifacts = resolve('test-results/picker');
await mkdir(artifacts, { recursive: true });
const socket = createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const app = spawn(
  process.env.LAUNCHFLOW_TEST_APP || resolve(local.targetDir, 'debug/launchflow.exe'),
  [],
  {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LAUNCHFLOW_TEST_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  },
);
const fixture = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
});
const target = { pid: fixture.pid, title: 'LaunchFlow Automation Test Harness' };
const dialogTarget = { pid: fixture.pid, title: 'Harness Dialog' };
const editor = { pid: app.pid, title: 'LaunchFlow' };
let browser, page;
const checks = [],
  errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const current = () => invoke('automation_session_current');
const perform = (window, id, kind, args = {}) =>
  callNative({
    op: 'perform',
    window,
    locator: id ? { kind: 'accessibility', automationId: id } : null,
    action: { kind, ...args },
  });
const find = (window, id) =>
  callNative({ op: 'find', window, locator: { kind: 'accessibility', automationId: id } });
const clickPoint = (window, bounds) =>
  callNative({
    op: 'perform',
    window,
    point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    action: { kind: 'click' },
  });
const pickerDialog = () =>
  page.getByRole('dialog', { name: 'Element Picker · 单击选择 / Esc 取消', exact: true });
async function startPicker(index = 0) {
  await page.getByRole('button', { name: 'Pick Element', exact: true }).nth(index).click();
  await expect(pickerDialog()).toBeVisible();
  await expect.poll(async () => (await current())?.status, { timeout: 12000 }).toBe('picking');
}
async function choose(window, id) {
  await perform(window, id, 'movePointer');
  await expect
    .poll(
      async () => {
        const s = await current();
        return s?.element?.automationId === id && s.element.window.title === window.title;
      },
      { timeout: 7000 },
    )
    .toBe(true);
  await clickPoint(window, (await find(window, id)).bounds);
  await expect(pickerDialog()).toHaveCount(0);
  await expect.poll(async () => (await current())?.status).toBe('selected');
  return (await current()).locator;
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
}
try {
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(250);
    }
  }
  assert(browser, 'Desktop did not start');
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
  const definitions = (await invoke('bootstrap')).definitions.filter((d) => d.category === 'gui');
  const ordered = [...definitions].sort(
    (a, b) => Number(b.nodeType === 'gui.shortcut') - Number(a.nodeType === 'gui.shortcut'),
  );
  const scene = await invoke('create_scene', { name: '连续拾取回归测试' });
  scene.workflow.nodes = ordered.map((d, i) => ({
    id: `picker-${i}`,
    type: d.nodeType,
    name: d.nodeType,
    description: '',
    position: { x: 0, y: i * 140 },
    enabled: true,
    config: {
      ...d.defaults,
      locators: [
        { kind: 'window', window: { application: 'launchflow-harness.exe', title: target.title } },
      ],
      ...(d.nodeType === 'gui.inputText' ? { text: 'fixture' } : {}),
      ...(d.nodeType === 'gui.selectOption' ? { option: 'Staging' } : {}),
    },
    retryPolicy: { maxRetries: 0, delayMs: 0 },
    timeoutMs: 10000,
    failurePolicy: 'stopWorkflow',
    platformConstraint: [],
    inputs: {},
    outputs: {},
    metadata: {},
  }));
  scene.workflow.edges = scene.workflow.nodes.slice(1).map((n, i) => ({
    id: `edge-${i}`,
    from: scene.workflow.nodes[i].id,
    to: n.id,
    outlet: 'success',
  }));
  await invoke('save_scene', { scene });
  await page.reload();
  await page.getByRole('button', { name: /^我的场景/ }).click();
  await page
    .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await perform(target, null, 'selectMenu', { menuPath: ['File', 'Open Dialog'] });
  assert(await find(dialogTarget, 'confirm-dialog'));

  for (const definition of ordered) {
    await check(`${definition.nodeType}: first pick and re-pick a different window`, async () => {
      await page
        .getByRole('button', { name: `编辑步骤 ${definition.nodeType}`, exact: true })
        .click();
      await startPicker();
      const first = await choose(target, 'start-button');
      assert.equal(first.automationId, 'start-button');
      await startPicker();
      const second = await choose(dialogTarget, 'confirm-dialog');
      assert.equal(second.window.title, dialogTarget.title);
      assert.equal(second.automationId, 'confirm-dialog');
      await expect(
        page.locator('.locator-card').getByRole('textbox', { name: 'Window title', exact: true }),
      ).toHaveValue(dialogTarget.title);
    });
    if (process.argv.includes('--first-only')) break;
  }
  await check('Fallback can be picked repeatedly without changing Primary', async () => {
    await page.getByRole('button', { name: '添加 Fallback', exact: true }).click();
    await startPicker(1);
    await choose(target, 'start-button');
    await startPicker(1);
    await choose(target, 'project-input');
    await expect(
      page
        .locator('.locator-card')
        .nth(0)
        .getByRole('textbox', { name: 'Window title', exact: true }),
    ).toHaveValue(dialogTarget.title);
    await expect(
      page
        .locator('.locator-card')
        .nth(1)
        .getByRole('textbox', { name: 'automationId', exact: true }),
    ).toHaveValue('project-input');
  });
  await check(
    'Real mouse can close Picker after hovering a target; it does not select stale hover',
    async () => {
      const before = await page
        .locator('.locator-card')
        .first()
        .getByRole('textbox', { name: 'automationId', exact: true })
        .inputValue();
      const countBefore = await page.locator('.locator-card').count();
      await startPicker();
      await perform(target, 'start-button', 'movePointer');
      await expect.poll(async () => (await current())?.element?.automationId).toBe('start-button');
      const close = await callNative({
        op: 'find',
        window: editor,
        locator: { kind: 'accessibility', role: 'Button', name: '关闭', frameworkId: 'Chrome' },
      });
      await clickPoint(editor, close.bounds);
      await expect(pickerDialog()).toHaveCount(0);
      await expect.poll(async () => (await current())?.status).toBe('stopped');
      assert.equal((await current()).locator, null);
      await expect(page.locator('.locator-card')).toHaveCount(countBefore);
      await expect(
        page
          .locator('.locator-card')
          .first()
          .getByRole('textbox', { name: 'automationId', exact: true }),
      ).toHaveValue(before);
    },
  );
  await check('Native Escape closes modal and next pick works', async () => {
    await startPicker();
    await perform(target, null, 'pressKey', { key: 'Escape' });
    await expect(pickerDialog()).toHaveCount(0);
    await expect.poll(async () => (await current())?.status).toBe('cancelled');
    await startPicker();
    await choose(target, 'start-button');
  });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'editor.png') });
} catch (e) {
  if (page) {
    await writeFile(
      join(artifacts, 'failure-session.json'),
      JSON.stringify(await current().catch(() => null), null, 2),
    );
    await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  }
  throw e;
} finally {
  await invoke('automation_session_control', { operation: 'stop' }).catch(() => {});
  await sleep(250);
  await browser?.close();
  app.kill();
  fixture.kill();
  await writeFile(join(artifacts, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
}
