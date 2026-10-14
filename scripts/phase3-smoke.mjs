/** Real WebView2 + Tauri + native UIA acceptance; no third-party desktop apps. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { callNative } from './test-native.mjs';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-phase3-'));
const artifacts = resolve('test-results/phase3');
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
    LAUNCHFLOW_GUI_SECRET_TEST: 'SYNTHETIC_ENV_SECRET_57493',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  },
});
let browser, page, harnessPid;
const checks = [],
  errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
};
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const finish = async (id) => {
  await expect
    .poll(
      async () =>
        ['succeeded', 'failed', 'cancelled'].includes(
          (await invoke('bootstrap')).runs.find((r) => r.id === id)?.status,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  return (await invoke('bootstrap')).runs.find((r) => r.id === id);
};
try {
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(250);
    }
  }
  if (!browser) throw new Error('Desktop did not start');
  const context = browser.contexts()[0];
  page = context.pages()[0] || (await context.waitForEvent('page'));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
  const definitions = (await invoke('bootstrap')).definitions;
  const node = (kind, id, config = {}) => ({
    id,
    type: kind,
    name: id,
    description: '',
    position: { x: 0, y: 0 },
    enabled: true,
    config: {
      ...structuredClone(definitions.find((d) => d.nodeType === kind).defaults),
      ...config,
    },
    retryPolicy: { maxRetries: 0, delayMs: 100 },
    timeoutMs: 10000,
    failurePolicy: 'stopWorkflow',
    platformConstraint: [],
    inputs: {},
    outputs: {},
    metadata: {},
  });
  const window = {
    application: 'launchflow-harness.exe',
    title: 'LaunchFlow Automation Test Harness',
  };
  const locator = (id) => ({ kind: 'accessibility', window, automationId: id });
  const windowLocator = { kind: 'window', window };
  const perform = (id, kind, args = {}) =>
    callNative({
      op: 'perform',
      window,
      locator: id ? locator(id) : null,
      action: { kind, ...args },
    });
  let scene, first;
  await check('20 GUI runners and structured permission status', async () => {
    assert.equal(definitions.filter((d) => d.category === 'gui').length, 20);
    assert.equal((await invoke('automation_permissions')).accessibility, 'granted');
    await page.getByRole('button', { name: '权限与凭据', exact: true }).click();
    await expect(page.getByText('Administrator: On Demand')).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'permissions.png') });
  });
  await check(
    'Launch → Wait Window → Wait Button → Click → Wait Input → Input → Select → Shortcut → Result',
    async () => {
      await invoke('save_profile', {
        profile: {
          schemaVersion: 1,
          id: 'phase3-harness',
          displayName: 'LaunchFlow Test Harness',
          windows: {
            executable: resolve('native/bin/launchflow-harness.exe'),
            processName: 'launchflow-harness.exe',
          },
          macos: { appPath: '', bundleId: '', processName: '' },
          launchArguments: [],
          readyDetection: { kind: 'process', processName: 'launchflow-harness.exe' },
        },
      });
      const nodes = [
        node('application.launch', 'Launch Test App', { applicationId: 'phase3-harness' }),
        node('gui.waitWindow', 'Wait Window', { locators: [windowLocator] }),
        node('gui.waitElement', 'Wait Button', { locators: [locator('start-button')] }),
        node('gui.click', 'Click Button', {
          locators: [locator('deliberately-missing-primary'), locator('start-button')],
        }),
        node('gui.waitElement', 'Wait Input', { locators: [locator('project-input')] }),
        node('gui.inputText', 'Input Text', {
          locators: [locator('project-input')],
          text: 'LaunchFlow Phase 3',
        }),
        node('gui.selectOption', 'Select Option', {
          locators: [locator('environment-choice')],
          option: 'Staging',
        }),
        node('gui.shortcut', 'Shortcut', {
          locators: [locator('project-input')],
          keys: ['Ctrl', 'Enter'],
        }),
        node('gui.waitElement', 'Wait Result', {
          locators: [{ ...locator('result-label'), name: 'Result: LaunchFlow Phase 3 / Staging' }],
        }),
      ];
      scene = await invoke('create_scene', { name: 'Phase 3 · GUI Automation 验收' });
      scene.workflow = {
        nodes,
        edges: nodes.slice(1).map((n, i) => ({
          id: crypto.randomUUID(),
          from: nodes[i].id,
          to: n.id,
          outlet: 'success',
        })),
        annotations: [],
      };
      scene = await invoke('save_scene', { scene });
      first = await finish((await invoke('run_scene', { sceneId: scene.id })).id);
      assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
      const w = (await invoke('automation_windows')).find((w) => w.title === window.title);
      harnessPid = w.pid;
      assert.equal(first.nodeRuns[3].output.automation.locatorUsed, 1);
      assert.equal(first.nodeRuns[3].output.automation.locatorAttempts[0].success, false);
      await writeFile(join(artifacts, 'acceptance-run.json'), JSON.stringify(first, null, 2));
    },
  );
  await check(
    'Moved/resized windows retain semantic locators; Test Action runs exactly one node',
    async () => {
      for (const [kind, config] of [
        ['moveWindow', { x: 240, y: 140 }],
        ['resizeWindow', { width: 920, height: 850 }],
      ]) {
        const single = {
          ...scene,
          workflow: {
            ...scene.workflow,
            nodes: [
              ...scene.workflow.nodes,
              node(`gui.${kind}`, kind, { locators: [windowLocator], ...config }),
            ],
          },
        };
        const run = await finish(
          (await invoke('automation_test_action', { scene: single, nodeId: kind })).id,
        );
        assert.equal(run.status, 'succeeded');
        assert.equal(run.nodeRuns.length, 1);
        assert.equal(run.source, 'actionTest');
      }
      assert.equal(
        (await finish((await invoke('run_scene', { sceneId: scene.id })).id)).status,
        'succeeded',
      );
    },
  );
  await check('Highlight does not click; timeout diagnostics screenshot and Cancel', async () => {
    const info = () => callNative({ op: 'find', window, locator: locator('result-label') });
    const before = await info();
    await invoke('automation_highlight', { config: { locators: [locator('start-button')] } });
    assert.equal((await info()).name, before.name);
    const test = {
      ...scene,
      workflow: {
        nodes: [
          {
            ...node('gui.waitElement', 'Missing', { locators: [locator('missing')] }),
            timeoutMs: 800,
          },
        ],
        edges: [],
        annotations: [],
      },
    };
    const failed = await finish(
      (await invoke('automation_test_action', { scene: test, nodeId: 'Missing' })).id,
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.nodeRuns[0].output.automation.error.code, 'timeout');
    const image = await invoke('automation_image', {
      id: failed.nodeRuns[0].output.automation.screenshot,
      asset: false,
    });
    assert(image.startsWith('data:image/png;base64,'));
    await writeFile(join(artifacts, 'failure-run.json'), JSON.stringify(failed, null, 2));
    test.workflow.nodes[0].timeoutMs = 20000;
    const run = await invoke('automation_test_action', { scene: test, nodeId: 'Missing' });
    await sleep(200);
    await invoke('stop_run', { runId: run.id });
    assert.equal((await finish(run.id)).status, 'cancelled');
  });
  await check('Scoped OCR and image fallbacks use assets, export PNGs with Scene', async () => {
    const make = (locators) => ({
      ...scene,
      workflow: {
        nodes: [node('gui.waitElement', 'Vision', { locators })],
        edges: [],
        annotations: [],
      },
    });
    const ocr = make([{ kind: 'text', window, text: 'VISION TARGET 472', ocr: true }]);
    const run = await finish(
      (await invoke('automation_test_action', { scene: ocr, nodeId: 'Vision' })).id,
    );
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    const bounds = run.nodeRuns[0].output.automation.matchedElement.bounds;
    const w = await callNative({ op: 'window', window });
    const region = {
      x: Math.floor(bounds.x - w.bounds.x) - 3,
      y: Math.floor(bounds.y - w.bounds.y) - 3,
      width: Math.ceil(bounds.width) + 6,
      height: Math.ceil(bounds.height) + 6,
    };
    const asset = await invoke('automation_capture_asset', { window, region });
    const imageScene = make([
      locator('absent-before-image'),
      {
        kind: 'image',
        window,
        assetId: asset.id,
        threshold: 0.93,
        scales: [1],
        region: {
          x: region.x - 10,
          y: region.y - 10,
          width: region.width + 20,
          height: region.height + 20,
        },
      },
    ]);
    const matched = await finish(
      (await invoke('automation_test_action', { scene: imageScene, nodeId: 'Vision' })).id,
    );
    assert.equal(matched.status, 'succeeded', JSON.stringify(matched.error));
    assert.equal(matched.nodeRuns[0].output.automation.locatorUsed, 1);
    await invoke('automation_export', {
      scene: imageScene,
      path: join(artifacts, 'workflow-with-assets.zip'),
    });
  });
  await check(
    'Checkbox, menu/dialog, double/right click, dynamic waits, scrolling and window states',
    async () => {
      const one = async (kind, locators, config = {}) => {
        const snapshot = {
          ...scene,
          workflow: {
            nodes: [node(`gui.${kind}`, kind, { locators, ...config })],
            edges: [],
            annotations: [],
          },
        };
        const run = await finish(
          (await invoke('automation_test_action', { scene: snapshot, nodeId: kind })).id,
        );
        assert.equal(run.status, 'succeeded', `${kind}: ${JSON.stringify(run.error)}`);
        return run;
      };
      const result = () => callNative({ op: 'find', window, locator: locator('result-label') });
      await one('click', [locator('feature-checkbox')]);
      assert.equal((await result()).name, 'Feature enabled');
      const secretRun = await one('inputSecret', [locator('password-input')], {
        secretRef: 'env:LAUNCHFLOW_GUI_SECRET_TEST',
      });
      assert(!JSON.stringify(secretRun).includes('SYNTHETIC_ENV_SECRET_57493'));
      const source = await callNative({ op: 'find', window, locator: locator('start-button') });
      const wb = source.window.bounds;
      const center = {
        x: source.bounds.x + source.bounds.width / 2,
        y: source.bounds.y + source.bounds.height / 2,
      };
      const relative = {
        kind: 'relativeCoordinate',
        window,
        x: (center.x - wb.x) / wb.width,
        y: (center.y - wb.y) / wb.height,
      };
      await one('click', [relative]);
      await one('moveWindow', [windowLocator], { x: wb.x + 35, y: wb.y + 25 });
      await one('click', [relative]);
      await one('click', [
        { kind: 'absoluteCoordinate', window, x: center.x + 35, y: center.y + 25 },
      ]);
      await one('doubleClick', [locator('start-button')]);
      await one('rightClick', [locator('start-button')]);
      await one('pressKey', [windowLocator], { key: 'Escape' });
      await one('selectMenu', [windowLocator], { menuPath: ['File', 'Open Dialog'] });
      const dialog = { ...window, title: 'Harness Dialog' };
      await one('waitWindow', [{ kind: 'window', window: dialog }]);
      await one('click', [
        { kind: 'accessibility', window: dialog, automationId: 'confirm-dialog' },
      ]);
      assert.equal((await result()).name, 'Dialog confirmed');
      await one('click', [locator('dynamic-button')]);
      await one('waitElement', [locator('dynamic-element')]);
      await one('click', [locator('dynamic-element')]);
      await one('waitElementDisappear', [locator('dynamic-element')]);
      await one('scroll', [locator('scroll-area')], { delta: 8 });
      await one('waitElement', [locator('drag-target')]);
      const target = await callNative({ op: 'find', window, locator: locator('drag-target') });
      await one('drag', [locator('drag-target')], {
        endX: target.bounds.x + target.bounds.width / 2 + 70,
        endY: target.bounds.y + target.bounds.height / 2,
      });
      assert.equal((await result()).name, 'Drag received');
      await one('scroll', [locator('scroll-area')], { delta: -20 });
      const shot = await one('screenshot', [windowLocator]);
      assert(shot.nodeRuns[0].output.automation.screenshot);
      await one('maximize', [windowLocator]);
      assert.equal((await callNative({ op: 'window', window })).state, 'maximized');
      await one('minimize', [windowLocator]);
      assert.equal((await callNative({ op: 'window', window })).state, 'minimized');
      await one('activateWindow', [windowLocator]);
      assert.notEqual((await callNative({ op: 'window', window })).state, 'minimized');
    },
  );
  await check('Rendered editor Picker, Highlight and Test Action', async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: /^我的场景/ })).toBeVisible();
    await page.getByRole('button', { name: /^我的场景/ }).click();
    const card = page.locator('.scene-card').filter({ hasText: scene.name });
    await card.getByRole('button', { name: '编辑' }).click();
    await page.getByRole('button', { name: '编辑步骤 Click Button', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test Action', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pick Element', exact: true }).first().click();
    await perform('start-button', 'movePointer');
    await expect
      .poll(async () => (await invoke('automation_session_current'))?.element?.automationId, {
        timeout: 10000,
      })
      .toBe('start-button');
    const el = await callNative({ op: 'find', window, locator: locator('start-button') });
    await callNative({
      op: 'perform',
      window,
      point: { x: el.bounds.x + el.bounds.width / 2, y: el.bounds.y + el.bounds.height / 2 },
      action: { kind: 'click' },
    });
    await expect(
      page.getByRole('heading', { name: 'Element Picker · 单击选择 / Esc 取消' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    await expect(page.getByText('Highlight 已完成')).toBeVisible();
    await page.getByRole('button', { name: 'Test Action', exact: true }).click();
    await expect(page.locator('.action-tools').getByText('已完成', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await page.screenshot({ path: join(artifacts, 'gui-editor.png') });
  });
  await check(
    'Explicit Recorder → Pause → Secret placeholder → editable review → insert Workflow',
    async () => {
      await page.getByRole('button', { name: 'Start Recording', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const recordedWindowLabel = (await invoke('automation_windows'))
        .filter((w) => w.pid === harnessPid)
        .map((w) => `${w.application} · ${w.title}`)[0];
      await dialog
        .getByRole('combobox', { name: '当前桌面窗口', exact: true })
        .fill(recordedWindowLabel);
      await page.getByRole('option', { name: recordedWindowLabel, exact: true }).click();
      await dialog.getByRole('button', { name: 'Start Recording', exact: true }).click();
      await expect(page.getByText('Recording 录制中')).toBeVisible();
      await perform('start-button', 'click');
      await perform('project-input', 'inputText', { text: 'Recorded text' });
      await sleep(500);
      await page.getByRole('button', { name: 'Pause Recording', exact: true }).click();
      await expect(page.getByText('Recording 已暂停')).toBeVisible();
      await perform('project-input', 'inputText', { text: 'IGNORE_WHILE_PAUSED' });
      await page.getByRole('button', { name: '继续录制', exact: true }).click();
      await perform('password-input', 'inputSecret', { text: 'GUI_NEVER_PERSIST_391' });
      await sleep(800);
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByRole('heading', { name: '审阅录制 Actions' })).toBeVisible();
      const session = await invoke('automation_session_current');
      assert(session.actions.some((a) => a.kind === 'inputSecret' && a.secretRef === 'unresolved'));
      assert(!JSON.stringify(session).includes('GUI_NEVER_PERSIST_391'));
      assert(!JSON.stringify(session).includes('IGNORE_WHILE_PAUSED'));
      await writeFile(
        join(artifacts, 'recorded-actions.json'),
        JSON.stringify(session.actions, null, 2),
      );
      await page.screenshot({ path: join(artifacts, 'recorder-review.png') });
      const before = await page.locator('.node-card').count();
      await page.getByRole('button', { name: '确认并插入 Workflow', exact: true }).click();
      await expect
        .poll(() => page.locator('.node-card').count())
        .toBe(before + session.actions.length);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
    },
  );
  await check('Run Detail shows attempts, matched element and duration', async () => {
    await page.getByRole('button', { name: '运行历史', exact: true }).click();
    await page
      .locator('.run-name')
      .filter({ hasText: 'Phase 3 · GUI Automation 验收' })
      .first()
      .click();
    const click = page
      .locator('.node-run')
      .filter({ has: page.locator('summary strong', { hasText: 'Click Button' }) });
    await click.locator('summary').first().click();
    await expect(click.getByText('Automation Debugger')).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'gui-debugger.png') });
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'desktop-acceptance.json'),
    JSON.stringify({ checks, errors, dataDir }, null, 2),
  );
  console.log(`Verified ${checks.length} GUI desktop acceptance flows.`);
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
  if (harnessPid) {
    try {
      process.kill(harnessPid);
    } catch {}
  }
  await browser?.close().catch(() => {});
  app.kill();
}
