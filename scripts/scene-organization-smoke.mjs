/** Real Windows WebView2 + IPC + SQLite, using only disposable scenes and delay steps. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-scene-organization-'));
const artifacts = resolve('test-results/scene-organization');
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
let app, browser, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const resync = () => invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
const card = (scene) => page.locator(`.sortable-scene[data-scene-id="${scene.id}"]`);
const names = () => page.locator('.sortable-scene h3');
const quickNames = () => page.locator('.quick-launch-card strong');
const scenesPage = () => page.getByRole('button', { name: /^我的场景/ }).click();
const home = () => page.getByRole('button', { name: '概览', exact: true }).click();
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};

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

try {
  await start();
  const initial = await invoke('bootstrap');
  assert.equal(initial.scenes.length, 0, 'Test data must be isolated');
  await invoke('save_settings', { settings: { ...initial.settings, notifications: false } });
  const definition = initial.definitions.find((d) => d.nodeType === 'system.delay');
  async function seed(name) {
    let scene = await invoke('create_scene', { name });
    scene.workflow.nodes = [
      {
        id: `delay-${scene.id}`,
        type: definition.nodeType,
        name: '短暂等待',
        description: '',
        position: { x: 0, y: 0 },
        enabled: true,
        config: { ...definition.defaults, durationMs: 50 },
        retryPolicy: { maxRetries: 0, delayMs: 0 },
        timeoutMs: 5000,
        failurePolicy: 'stopWorkflow',
        platformConstraint: [],
        inputs: {},
        outputs: {},
        metadata: {},
      },
    ];
    return invoke('save_scene', { scene });
  }
  let a = await seed('工作 · A');
  const b = await seed('阅读 · B');
  let c = await seed('工作 · C');
  c.parameters = [
    {
      name: 'environment',
      kind: 'select',
      description: '运行环境',
      required: true,
      defaultValue: '测试',
      options: ['测试', '开发'],
      validation: {},
    },
  ];
  c = await invoke('save_scene', { scene: c });
  await invoke('save_draft', { scene: { ...a, description: '未完成的草稿' } });
  await invoke('set_default_scene', { sceneId: b.id });
  await resync();
  await expect(page.locator('.quick-launch-empty')).toBeVisible();

  await check(
    'Lightning actions immediately add shortcuts without changing default, versions or drafts',
    async () => {
      await scenesPage();
      await expect(names()).toHaveText([a.name, b.name, c.name]);
      for (const scene of [a, c]) {
        await card(scene).getByRole('button', { name: '添加至快捷启动', exact: true }).click();
        await expect(
          card(scene).getByRole('button', { name: '取消快捷启动', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(card(scene).locator('.scene-quick-toggle svg')).toHaveAttribute(
          'fill',
          'currentColor',
        );
      }
      const icons = await card(a)
        .locator('.scene-action-icons button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      assert.deepEqual(icons.slice(0, 3), ['重命名场景', '取消快捷启动', '设为默认启动场景']);
      await home();
      await expect(quickNames()).toHaveText([a.name, c.name]);
      const state = await invoke('bootstrap');
      assert.equal(state.scenes.find((s) => s.isDefault).id, b.id);
      assert.equal(state.scenes.find((s) => s.id === a.id).version, a.version);
      assert.equal((await invoke('get_draft', { sceneId: a.id })).description, '未完成的草稿');
    },
  );

  await check(
    'Physical drag works in filtered results and across rows, with keyboard sorting',
    async () => {
      await scenesPage();
      await page.getByRole('textbox', { name: '搜索场景', exact: true }).fill('工作');
      await card(c)
        .locator('.scene-drag-handle')
        .dragTo(card(a), { targetPosition: { x: 10, y: 60 } });
      await expect(names()).toHaveText([c.name, a.name]);
      assert.deepEqual((await invoke('bootstrap')).scenePreferences.order, [c.id, a.id, b.id]);
      await page.getByRole('textbox', { name: '搜索场景', exact: true }).fill('');
      // Larger readable cards put the second row below the fold. Scroll before grabbing,
      // so WebView2 does not scroll the page while the native drag is in progress.
      await card(b).scrollIntoViewIfNeeded();
      const box = await card(b).boundingBox();
      await card(a)
        .locator('.scene-drag-handle')
        .dragTo(card(b), { targetPosition: { x: box.width - 10, y: 60 } });
      await expect(names()).toHaveText([c.name, b.name, a.name]);
      await card(a).locator('.scene-drag-handle').press('Alt+ArrowLeft');
      await expect(names()).toHaveText([c.name, a.name, b.name]);
      await page.screenshot({ path: join(artifacts, 'scenes-light.png') });
      await home();
      await expect(quickNames()).toHaveText([c.name, a.name]);
    },
  );

  await check(
    'Late bootstrap cannot undo a confirmed toggle; a rejected write retains confirmed state',
    async () => {
      await scenesPage();
      await page.evaluate(() => {
        const original = window.fetch;
        window.__testOriginalFetch = original;
        let hold = true;
        window.fetch = async (input, ...args) => {
          const result = await original(input, ...args);
          if (new URL(String(input)).pathname === '/bootstrap' && hold) {
            hold = false;
            return new Promise((resolve) => {
              window.__releaseOldBootstrap = () => resolve(result);
            });
          }
          return result;
        };
      });
      await resync();
      await expect
        .poll(() => page.evaluate(() => typeof window.__releaseOldBootstrap))
        .toBe('function');
      await card(a).getByRole('button', { name: '取消快捷启动', exact: true }).click();
      await expect(card(a).locator('.scene-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.evaluate(() => window.__releaseOldBootstrap());
      await sleep(400);
      await expect(card(a).locator('.scene-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.evaluate(() => {
        const original = window.__testOriginalFetch;
        let reject = true;
        window.fetch = async (input, ...args) => {
          if (new URL(String(input)).pathname === '/set_scene_quick_launch' && reject) {
            reject = false;
            return new Response(JSON.stringify('TEST: 偏好保存失败'), {
              headers: { 'content-type': 'application/json', 'Tauri-Response': 'error' },
            });
          }
          return original(input, ...args);
        };
      });
      await card(a).getByRole('button', { name: '添加至快捷启动', exact: true }).click();
      await expect(page.getByText('TEST: 偏好保存失败', { exact: true })).toBeVisible();
      await expect(card(a).locator('.scene-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.evaluate(() => {
        window.fetch = window.__testOriginalFetch;
      });
      await card(a).getByRole('button', { name: '添加至快捷启动', exact: true }).click();
      await expect(card(a).locator('.scene-quick-toggle')).toHaveAttribute('aria-pressed', 'true');
    },
  );

  await check(
    'Renaming a shortcut updates the overview and keeps its custom position',
    async () => {
      await card(a).getByRole('button', { name: '重命名场景', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '重命名场景', exact: true });
      await dialog.getByLabel('场景名称', { exact: true }).fill('日常 · A');
      await dialog.getByRole('button', { name: '确定', exact: true }).click();
      a = { ...a, name: '日常 · A' };
      await expect(names()).toHaveText([c.name, a.name, b.name]);
      await home();
      await expect(quickNames()).toHaveText([c.name, a.name]);
    },
  );

  await check(
    'Restart restores ordering and shortcuts; launch runs the real workflow and preserves parameter prompts',
    async () => {
      await stop();
      await start();
      await expect(quickNames()).toHaveText([c.name, a.name]);
      await scenesPage();
      await expect(names()).toHaveText([c.name, a.name, b.name]);
      await home();
      await page.getByRole('button', { name: `启动「${a.name}」`, exact: true }).click();
      await expect
        .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.sceneId === a.id)?.status)
        .toBe('succeeded');
      await home();
      await page.getByRole('button', { name: `启动「${c.name}」`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `运行配置 · ${c.name}`, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('combobox')).toHaveValue('测试');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal((await invoke('bootstrap')).runs.filter((r) => r.sceneId === c.id).length, 0);
      await page.screenshot({ path: join(artifacts, 'home-light.png') });
    },
  );

  await check(
    'Copy appends without inheriting shortcuts; delete and cancel remove shortcuts immediately',
    async () => {
      await scenesPage();
      await card(a).getByRole('button', { name: '复制场景', exact: true }).click();
      await expect(names()).toHaveCount(4);
      const state = await invoke('bootstrap');
      const copy = state.scenes[3];
      assert(!state.scenePreferences.quickLaunchIds.includes(copy.id));
      await card(c).getByRole('button', { name: '删除场景', exact: true }).click();
      await page
        .getByRole('dialog', { name: '删除场景？', exact: true })
        .getByRole('button', { name: '确认删除', exact: true })
        .click();
      await expect(names()).toHaveText([a.name, b.name, copy.name]);
      await home();
      await expect(quickNames()).toHaveText([a.name]);
      await scenesPage();
      await card(a).getByRole('button', { name: '取消快捷启动', exact: true }).click();
      await expect(card(a).locator('.scene-quick-toggle')).toHaveAttribute('aria-pressed', 'false');
      await home();
      await expect(page.locator('.quick-launch-empty')).toBeVisible();
      await stop();
      await start();
      await expect(page.locator('.quick-launch-empty')).toBeVisible();
    },
  );

  await check('Light/dark and narrow layouts keep names and controls inside cards', async () => {
    await invoke('set_scene_quick_launch', { sceneId: a.id, enabled: true });
    await invoke('set_scene_quick_launch', { sceneId: b.id, enabled: true });
    await resync();
    await expect(quickNames()).toHaveText([a.name, b.name]);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [1240, 920]) {
        await page.setViewportSize({ width, height: width === 920 ? 640 : 820 });
        for (const view of ['home', 'scenes']) {
          await page
            .getByRole('button', {
              name: view === 'home' ? '概览' : /^我的场景/,
              exact: view === 'home',
            })
            .dispatchEvent('click');
          await expect(page.locator(`.${view}-page`)).toBeVisible();
          await sleep(250);
          const overflow = await page
            .locator(view === 'home' ? '.quick-launch-card' : '.sortable-scene')
            .evaluateAll((cards) => cards.some((el) => el.scrollWidth > el.clientWidth + 1));
          assert.equal(overflow, false, `${theme}/${width}/${view} overflow`);
          await page.screenshot({ path: join(artifacts, `${view}-${theme}-${width}.png`) });
        }
      }
    }
  });
  assert.deepEqual(errors, []);
} catch (error) {
  await page?.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        passed: !process.exitCode,
        checks,
        pageErrors: errors,
        dataDir,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await stop();
}
