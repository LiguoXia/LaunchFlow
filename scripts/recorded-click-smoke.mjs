/** Isolated custom-drawn window: record real physical clicks, replay after moving, reject old root clicks. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { callNative, worker } from './test-native.mjs';
const directory = await mkdtemp(join(tmpdir(), 'lf-canvas-click-'));
const artifacts = resolve('test-results/recorded-click');
await mkdir(artifacts, { recursive: true });
const csc = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compile = (name, sources, refs = []) => {
  const output = join(directory, name + '.exe');
  execFileSync(
    csc,
    [
      '/nologo',
      `/out:${output}`,
      ...refs.map((r) => '/reference:' + r),
      ...sources.map((source) => resolve(source)),
    ],
    { windowsHide: true },
  );
  return output;
};
await copyFile(worker, join(directory, 'launchflow-automation.exe'));
const unit = compile(
  'RecordedPointerTests',
  ['native/windows/tests/RecordedPointerTests.cs'],
  [worker],
);
const unitOutput = execFileSync(unit, [], { encoding: 'utf8', windowsHide: true });
console.log(unitOutput);
await writeFile(join(artifacts, 'unit.txt'), unitOutput);
const refs = ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'];
const fixture = compile(
  'CanvasClickFixture',
  ['native/windows/Common.cs', 'native/windows/tests/CanvasClickFixture.cs'],
  refs,
);
const focus = compile(
  'ForegroundFixture',
  ['native/windows/Common.cs', 'native/windows/tests/ForegroundFixture.cs'],
  refs,
);
const marker = join(directory, 'canvas');
const canvas = spawn(fixture, [marker], { windowsHide: true, stdio: 'ignore' });
const window = { pid: canvas.pid, title: 'LaunchFlow Canvas Click Fixture' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => JSON.parse(await readFile(marker + '.json', 'utf8'));
const checks = [],
  errors = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const perform = (point, action = { kind: 'click' }) =>
  callNative({ op: 'perform', window, point, action });
let recorder, app, browser, page;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function finish(id) {
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
  return run;
}
try {
  await expect
    .poll(async () => {
      try {
        return (await state()).handle;
      } catch {
        return '';
      }
    })
    .not.toBe('');
  execFileSync(focus, [String(canvas.pid), (await state()).handle], {
    windowsHide: true,
    timeout: 8000,
  });
  assert(
    (await callNative({ op: 'windows' })).some(
      (w) => w.pid === canvas.pid && w.title === window.title,
    ),
    'Visible canvas fixture must be discoverable by the recorder',
  );
  const events = [];
  let buffer = '';
  recorder = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  recorder.stdout.on('data', (b) => {
    buffer += b;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.ok === false || event.error)
          console.log('Recorder diagnostic:', JSON.stringify(event));
      }
    }
  });
  recorder.stdin.write(JSON.stringify({ op: 'record', window }) + '\n');
  await expect
    .poll(() => events.some((e) => e.state === 'recording'), { timeout: 10000 })
    .toBe(true);
  let actions;
  await check(
    'Record three off-center clicks on one custom canvas without coalescing or window-center locators',
    async () => {
      for (const name of ['left', 'right', 'left']) await perform((await state())[name]);
      await expect
        .poll(
          () =>
            events
              .filter((e) => e.event === 'actions')
              .at(-1)
              ?.actions.filter((a) => a.kind === 'click').length,
        )
        .toBe(3);
      recorder.stdin.write(JSON.stringify({ op: 'stop' }) + '\n');
      await expect
        .poll(() => events.some((e) => e.event === 'stopped'), { timeout: 15000 })
        .toBe(true);
      actions = events.find((e) => e.event === 'stopped').actions;
      const clicks = actions.filter((a) => a.kind === 'click');
      assert(clicks.every((a) => a.locators[0].kind === 'relativeCoordinate'));
      assert(clicks[0].locators[0].x < 0.3 && clicks[1].locators[0].x > 0.7);
      assert.deepEqual((await state()).clicks, ['left', 'right', 'left']);
      await writeFile(join(artifacts, 'recorded-actions.json'), JSON.stringify(actions, null, 2));
    },
  );
  await check(
    'Replay recorded positions after moving the actual window, with hover and click delivery diagnostics',
    async () => {
      await perform(null, { kind: 'moveWindow', x: 480, y: 260 });
      for (const a of actions.filter((a) => a.kind === 'click')) {
        const r = (await callNative({ op: 'window', window })).bounds,
          l = a.locators[0];
        const result = await perform({ x: r.x + l.x * r.width, y: r.y + l.y * r.height });
        assert.equal(result.pointer.hitTestMatched, true);
        assert.equal(result.pointer.inputEventsSent, 2);
        assert.equal(result.pointer.stage, 'inputDispatched');
      }
      assert.deepEqual((await state()).clicks, ['left', 'right', 'left', 'left', 'right', 'left']);
    },
  );
  await check(
    'Old whole-window click reports impreciseClickTarget and sends no click',
    async () => {
      const before = (await state()).clicks.length;
      await assert.rejects(
        callNative({
          op: 'perform',
          window,
          locator: { kind: 'accessibility', role: 'Window' },
          action: { kind: 'click' },
        }),
        (e) =>
          e.detail?.code === 'impreciseClickTarget' &&
          e.detail.details.pointer.targetRole === 'Window',
      );
      assert.equal((await state()).clicks.length, before);
    },
  );
  await check('A foreground target covered by another window blocks coordinate input', async () => {
    const before = (await state()).clicks.length;
    await writeFile(marker + '.cover', 'cover');
    await sleep(400);
    await assert.rejects(
      perform((await state()).left),
      (e) => e.detail?.code === 'targetObscured' && e.detail.details.pointer.inputEventsSent === 0,
    );
    assert.equal((await state()).clicks.length, before);
    await unlink(marker + '.cover');
    await sleep(300);
  });
  await check(
    'Picker captures the actual point on a custom canvas without clicking it',
    async () => {
      const point = (await state()).left;
      await perform(point, { kind: 'movePointer' });
      const pickEvents = [];
      let pending = '';
      recorder = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      recorder.stdout.on('data', (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line.trim()) pickEvents.push(JSON.parse(line));
        }
      });
      recorder.stdin.write(JSON.stringify({ op: 'pick', window }) + '\n');
      await expect
        .poll(() => pickEvents.some((e) => e.event === 'hover'), { timeout: 10000 })
        .toBe(true);
      const before = (await state()).clicks.length;
      await perform(point);
      await expect
        .poll(() => pickEvents.some((e) => e.event === 'selected'), { timeout: 10000 })
        .toBe(true);
      const selected = pickEvents.find((e) => e.event === 'selected');
      assert.equal(selected.locator.kind, 'relativeCoordinate');
      assert(selected.locator.x < 0.3);
      assert.equal((await state()).clicks.length, before);
      await expect
        .poll(() => pickEvents.some((e) => e.event === 'stopped'), { timeout: 15000 })
        .toBe(true);
    },
  );
  const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  app = spawn(resolve(local.targetDir, 'debug/launchflow.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LAUNCHFLOW_TEST_DATA_DIR: join(directory, 'profile'),
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
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await check(
    'Saved workflow replays recorded canvas clicks through Tauri/Rust and exports pointer diagnostics',
    async () => {
      const data = await invoke('bootstrap');
      let scene = await invoke('create_scene', { name: 'Custom canvas recording regression' });
      const nodes = actions.map((a, i) => {
        const { kind, ...config } = a;
        return {
          id: 'recorded-' + i,
          type: 'gui.' + kind,
          name: kind,
          description: '',
          position: { x: 0, y: 0 },
          enabled: true,
          config: {
            ...data.definitions.find((d) => d.nodeType === 'gui.' + kind).defaults,
            ...config,
          },
          retryPolicy: { maxRetries: 0, delayMs: 100 },
          timeoutMs: 10000,
          failurePolicy: 'stopWorkflow',
          platformConstraint: [],
          inputs: {},
          outputs: {},
          metadata: {},
        };
      });
      scene.workflow = {
        nodes,
        edges: nodes
          .slice(1)
          .map((n, i) => ({ id: 'edge-' + i, from: nodes[i].id, to: n.id, outlet: 'success' })),
        annotations: [],
      };
      scene = await invoke('save_scene', { scene });
      const host = (await invoke('automation_windows')).find((w) => w.pid === app.pid);
      execFileSync(focus, [String(app.pid), host.handle, '--caption'], {
        windowsHide: true,
        timeout: 8000,
      });
      const run = await finish((await invoke('run_scene', { sceneId: scene.id })).id);
      assert.equal(run.status, 'succeeded', run.error);
      assert.deepEqual((await state()).clicks.slice(-3), ['left', 'right', 'left']);
      assert.equal((await state()).clicks.length, 9);
      const diagnostic = JSON.parse(await invoke('diagnostic_log', { runId: run.id }));
      assert.equal(
        diagnostic.run.nodes.filter(
          (n) =>
            n.kind === 'gui.click' &&
            n.automation.pointer.hitTestMatched &&
            n.automation.pointer.inputEventsSent === 2,
        ).length,
        3,
      );
      assert(!JSON.stringify(diagnostic).includes('CanvasClickFixture'));
      await writeFile(
        join(artifacts, 'workflow-diagnostic.json'),
        JSON.stringify(diagnostic, null, 2),
      );
      const legacy = {
        ...nodes[1],
        id: 'legacy',
        config: {
          locators: [{ kind: 'accessibility', window, role: 'Window' }],
          captureOnFailure: false,
        },
      };
      scene.workflow.nodes.push(legacy);
      const failed = await finish(
        (await invoke('automation_test_action', { scene, nodeId: 'legacy' })).id,
      );
      assert.equal(failed.status, 'failed');
      assert(failed.error.includes('impreciseClickTarget'));
      assert.equal((await state()).clicks.length, 9);
      await writeFile(
        join(artifacts, 'legacy-diagnostic.json'),
        await invoke('diagnostic_log', { runId: failed.id }),
      );
    },
  );
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  recorder?.kill();
  await browser?.close().catch(() => {});
  app?.kill();
  canvas.kill();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
}
