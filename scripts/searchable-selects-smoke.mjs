/** Real editor/IPC/database coverage. Uses isolated data and only owned test windows. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-search-selects-'));
const artifacts = resolve('test-results/searchable-selects');
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
const fixture = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [],
  errors = [];
let browser, page;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const resync = () => invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
const combobox = (name) => page.getByRole('combobox', { name, exact: true });
const option = (value) => page.locator(`[role="option"][data-option-value="${value}"]`);
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const add = (name) =>
  page
    .locator('.palette-item')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
const edit = async (scene) => {
  await page.getByRole('button', { name: /^我的场景/ }).click();
  await page
    .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
    .getByRole('button', { name: '编辑', exact: true })
    .click();
};
const save = async (id) => {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
  return (await invoke('bootstrap')).scenes.find((s) => s.id === id);
};
async function sortedOptions() {
  const labels = await page
    .getByRole('option')
    .evaluateAll((els) => els.map((e) => e.querySelector('span > span')?.textContent));
  assert(labels.length > 1);
  const collator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });
  assert.deepEqual(labels, [...labels].sort(collator.compare));
  return labels;
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
  const profiles = [
    ['wx', '微信', 'Weixin.exe'],
    ['cdx-b', 'Codex', 'ChatGPT.exe'],
    ['bd', '百度', 'baidu.exe'],
    ['vsc', 'Visual Studio Code', 'Code.exe'],
    ['cdx-a', 'Codex', 'Other.exe'],
    ['ali', '阿里', 'ali.exe'],
    ['code10', 'Code 10', 'Code10.exe'],
    ['code2', 'Code 2', 'Code2.exe'],
  ];
  for (const [id, displayName, processName] of profiles)
    await invoke('save_profile', {
      profile: {
        schemaVersion: 1,
        id,
        displayName,
        windows: { executable: `C:\\LaunchFlowTest\\${processName}`, processName },
        macos: { appPath: `/Applications/${displayName}.app`, processName, bundleId: `test.${id}` },
        launchArguments: [],
        readyDetection: null,
      },
    });
  const children = [];
  for (const name of ['Zulu Child', '阿里子流程', 'Alpha Child', '微信子流程'])
    children.push(await invoke('create_scene', { name }));
  let scene = await invoke('create_scene', { name: '搜索下拉框验证' });
  await resync();
  await edit(scene);
  await add('启动应用');
  const application = combobox('应用');
  await check(
    'Application choices are sorted, including Chinese pinyin, numbers and duplicate names',
    async () => {
      await application.click();
      await expect(page.getByRole('option')).toHaveCount(profiles.length);
      await sortedOptions();
      await expect(option('cdx-a')).toBeVisible();
      await expect(option('cdx-b')).toBeVisible();
      await page.screenshot({ path: join(artifacts, 'applications-light.png') });
    },
  );
  await check(
    'Fuzzy names, executable aliases, width and case filter without changing stored values',
    async () => {
      await application.fill('ＣＤＸ');
      await expect(page.getByRole('option')).toHaveCount(2);
      await application.fill('chatgpt');
      await expect(page.getByRole('option')).toHaveCount(1);
      await option('cdx-b').click();
      await expect(application).toHaveValue('Codex');
      await expect(application).toHaveAttribute('aria-expanded', 'false');
      await application.fill('没有这个应用');
      await expect(page.getByText('没有匹配项', { exact: true })).toBeVisible();
      await application.press('Escape');
      await expect(application).toHaveValue('Codex');
      await application.click();
      await application.fill('vsc');
      await application.press('Tab');
      await expect(application).toHaveValue('Codex');
      scene = await save(scene.id);
      assert.equal(scene.workflow.nodes[0].config.applicationId, 'cdx-b');
    },
  );
  await check('IME confirmation, keyboard choice, clear and empty-value enums work', async () => {
    await application.click();
    await application.fill('微');
    await expect(option('wx')).toBeVisible();
    await application.dispatchEvent('compositionstart');
    await application.press('Enter');
    await expect(application).toHaveAttribute('aria-expanded', 'true');
    await application.dispatchEvent('compositionend');
    await application.press('Enter');
    await expect(application).toHaveValue('微信');
    await page.getByRole('button', { name: '清除应用', exact: true }).click();
    await expect(application).toHaveValue('');
    await application.click();
    await application.fill('cdx');
    await application.press('ArrowDown');
    await application.press('Enter');
    scene = await save(scene.id);
    assert.equal(scene.workflow.nodes[0].config.applicationId, 'cdx-b');
    const platform = combobox('运行平台');
    await platform.click();
    await platform.fill('mac');
    await option('macos').click();
    await platform.click();
    await option('').click();
    scene = await save(scene.id);
    assert.deepEqual(scene.workflow.nodes[0].platformConstraint, []);
  });
  await check('Subscene choices sort and search, retaining the chosen scene ID', async () => {
    await add('运行子流程');
    const child = combobox('子场景');
    await child.click();
    await sortedOptions();
    await child.fill('ac');
    const selected = children.find((s) => s.name === 'Alpha Child');
    await option(selected.id).click();
    scene = await save(scene.id);
    assert.equal(
      scene.workflow.nodes.find((n) => n.type === 'flow.subflow').config.sceneId,
      selected.id,
    );
  });
  await check('Window choices sort and search; saved selectors use stable identities', async () => {
    await add('激活窗口');
    const win = combobox('桌面与托盘窗口');
    await win.click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 15000 });
    await sortedOptions();
    const windows = await invoke('automation_windows', { includeHidden: true });
    const owned = windows.find((w) => w.pid === fixture.pid);
    assert(owned);
    await win.fill('lf harness');
    await expect(option(owned.handle)).toBeVisible();
    await option(owned.handle).click();
    scene = await save(scene.id);
    const target = scene.workflow.nodes.find((n) => n.type === 'gui.activateWindow').config
      .locators[0].window;
    assert.equal(target.application, owned.application);
    assert.equal(target.title, owned.title);
    assert.equal(target.pid, undefined);
    assert.equal(target.handle, undefined);
    await edit(scene);
    await page
      .locator(
        `.react-flow__node[data-id="${scene.workflow.nodes.find((n) => n.type === 'gui.activateWindow').id}"]`,
      )
      .click();
    await expect(win).toHaveValue(`${owned.application} · ${owned.title}`);
    await win.fill('不会匹配的窗口');
    await page.getByText('Application', { exact: true }).click();
    await expect(win).toHaveValue(`${owned.application} · ${owned.title}`);
    await page.locator(`.react-flow__node[data-id="${scene.workflow.nodes[0].id}"]`).click();
    await expect(application).toHaveValue('Codex');
  });
  await check(
    'Dropdown fits a narrow dark editor without clipping or horizontal overflow',
    async () => {
      await page.setViewportSize({ width: 1024, height: 720 });
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      await application.click();
      const list = page.getByRole('listbox');
      const box = await list.boundingBox();
      assert(
        box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 720,
      );
      await page.screenshot({ path: join(artifacts, 'applications-dark-narrow.png') });
      await option('wx').click();
      await expect(application).toHaveValue('微信');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    },
  );
  await check(
    'Required choices inside native dialogs stay clickable and require a committed selection',
    async () => {
      let runScene = await invoke('create_scene', { name: '必填搜索参数' });
      const delay = (await invoke('bootstrap')).definitions.find(
        (d) => d.nodeType === 'system.delay',
      );
      runScene.workflow.nodes = [
        {
          ...scene.workflow.nodes[0],
          id: 'delay',
          type: delay.nodeType,
          name: 'Delay',
          config: { durationMs: 1 },
        },
      ];
      runScene.parameters = [
        {
          name: 'project',
          kind: 'select',
          description: '测试参数',
          required: true,
          defaultValue: null,
          options: ['Zulu', 'Alpha', 'Beta'],
          validation: {},
        },
      ];
      runScene = await invoke('save_scene', { scene: runScene });
      await resync();
      await page.getByRole('button', { name: /^我的场景/ }).click();
      await page
        .locator(`.sortable-scene[data-scene-id="${runScene.id}"]`)
        .getByRole('button', { name: '运行', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: `运行配置 · ${runScene.name}` });
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole('combobox', { name: 'project', exact: true });
      await input.fill('Alpha');
      assert.equal(await input.evaluate((el) => el.validity.valid), false);
      await dialog.getByRole('button', { name: '开始运行', exact: true }).click();
      await expect(dialog).toBeVisible();
      await input.click();
      await input.fill('Alpha');
      await option('Alpha').click();
      assert.equal(await input.evaluate((el) => el.validity.valid), true);
      await input.click();
      await input.press('Escape');
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue('Alpha');
      await input.click();
      await page.screenshot({ path: join(artifacts, 'required-select-dialog.png') });
      await option('Beta').click();
      await dialog.getByRole('button', { name: '开始运行', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect
        .poll(async () => {
          const run = (await invoke('bootstrap')).runs.find((r) => r.sceneId === runScene.id);
          return run?.status;
        })
        .toBe('succeeded');
      const run = (await invoke('bootstrap')).runs.find((r) => r.sceneId === runScene.id);
      assert.equal(run.parameterSnapshot['project'], 'Beta');
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`${checks.length} searchable select acceptance checks passed`);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  fixture.kill();
}
