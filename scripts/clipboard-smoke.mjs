/** Editor -> saved workflow -> native clipboard -> actual Ctrl+V in an owned input field. */
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const dataDir = await mkdtemp(join(tmpdir(), 'lf-clipboard-editor-'));
const artifacts = resolve('test-results/clipboard');
await mkdir(artifacts, { recursive: true });
const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const inputFixture = join(dataDir, 'ClipboardFixture.exe');
execFileSync(
  compiler,
  [
    '/nologo',
    `/out:${inputFixture}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/tests/ClipboardFixture.cs'),
  ],
  { windowsHide: true },
);
const foreground = join(dataDir, 'ForegroundFixture.exe');
execFileSync(
  compiler,
  [
    '/nologo',
    `/out:${foreground}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/Common.cs'),
    resolve('native/windows/tests/ForegroundFixture.cs'),
  ],
  { windowsHide: true },
);
const marker = join(dataDir, 'pasted.json');
const fixture = spawn(inputFixture, ['paste', marker], { windowsHide: true, stdio: 'ignore' });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(250);
    }
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible({
    timeout: 15000,
  });
  let scene = await invoke('create_scene', { name: '剪贴板步骤验证' });
  await invoke('plugin:event|emit', { event: 'launchflow://resync', payload: null });
  await page.getByRole('button', { name: /^我的场景/ }).click();
  await page
    .locator(`.sortable-scene[data-scene-id="${scene.id}"]`)
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page
    .locator('.palette-item')
    .filter({ has: page.getByText('复制文本', { exact: true }) })
    .click();
  const text = '  工作流中文\n第二行 🧪\n引号 " 与 $()\n';
  const field = page.getByLabel(/^需要复制的文本/);
  await expect(field).toBeVisible();
  await field.fill(text);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
  scene = (await invoke('bootstrap')).scenes.find((s) => s.id === scene.id);
  assert.equal(scene.workflow.nodes.length, 1);
  assert.equal(scene.workflow.nodes[0].type, 'clipboard.copyText');
  assert.deepEqual(scene.workflow.nodes[0].config, { text });
  await page.screenshot({ path: join(artifacts, 'copy-text-editor.png') });
  console.log(
    'PASS Editor adds a copy-text component with only its multiline text configuration and saves it exactly',
  );
  const scope = { pid: fixture.pid, title: 'LaunchFlow Clipboard Paste Fixture' };
  function gui(kind, id, extra = {}) {
    return {
      ...structuredClone(scene.workflow.nodes[0]),
      id,
      type: `gui.${kind}`,
      name: id,
      config: { locators: [{ kind: 'window', window: scope }], ...extra },
      timeoutMs: 10000,
    };
  }
  scene.workflow.nodes.push(
    gui('activateWindow', 'activate-input'),
    gui('shortcut', 'paste-text', { keys: ['Ctrl', 'V'] }),
  );
  scene.workflow.edges = scene.workflow.nodes.slice(1).map((node, i) => ({
    id: `edge-${i}`,
    from: scene.workflow.nodes[i].id,
    to: node.id,
    outlet: 'success',
  }));
  scene = await invoke('save_scene', { scene });
  const window = (await callNative({ op: 'windows' })).find((w) => w.pid === app.pid);
  assert(window);
  execFileSync(foreground, [String(app.pid), window.handle, '--caption'], { windowsHide: true });
  const started = await invoke('run_scene', { sceneId: scene.id, approved: true });
  let run;
  await expect
    .poll(
      async () => {
        run = (await invoke('bootstrap')).runs.find((r) => r.id === started.id);
        return ['succeeded', 'failed', 'cancelled'].includes(run?.status);
      },
      { timeout: 15000 },
    )
    .toBe(true);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.nodeRuns));
  await expect.poll(async () => JSON.parse(await readFile(marker, 'utf8'))).toBe(text);
  assert.equal(run.nodeRuns[0].output.copied, true);
  assert(!JSON.stringify(run.nodeRuns[0].output).includes(text));
  await writeFile(join(artifacts, 'copy-and-paste-run.json'), JSON.stringify(run, null, 2));
  console.log(
    'PASS Saved workflow copies its configured text and actual Ctrl+V pastes it into the owned input field',
  );
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  fixture.kill();
}
