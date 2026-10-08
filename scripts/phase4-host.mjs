/** Opt-in host acceptance: real installed apps, an explicitly approved local backend fixture, and idle measurements. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
const local = JSON.parse((await readFile('.local/build.json', 'utf8')).replace(/^\uFEFF/, ''));
const binary = resolve(local.targetDir, 'debug/launchflow.exe');
const artifacts = resolve('test-results/phase4');
const downstreamOnly = process.argv.includes('--downstream');
const idleOnly = process.argv.includes('--idle');
const evidenceName = downstreamOnly ? 'real-workflow-downstream' : 'real-workflow';
await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(join(tmpdir(), 'launchflow-host-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, browser, page, definitions;
const errors = [];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function start(args = []) {
  const p = await port();
  app = spawn(binary, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LAUNCHFLOW_TEST_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${p}`,
    },
  });
  for (let i = 0; i < 120 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
    } catch {
      await sleep(250);
    }
  }
  if (!browser) throw Error('Desktop did not start');
  const c = browser.contexts()[0];
  page = c.pages()[0] || (await c.waitForEvent('page'));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__?.invoke);
  await expect(page.getByRole('button', { name: '概览', exact: true })).toBeVisible();
  definitions = (await invoke('bootstrap')).definitions;
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = null;
  app?.kill();
  await sleep(800);
}
const node = (type, id, config = {}, extra = {}) => ({
  id,
  type,
  name: id,
  description: '',
  position: { x: 100, y: 100 },
  enabled: true,
  config: { ...structuredClone(definitions.find((d) => d.nodeType === type).defaults), ...config },
  retryPolicy: { maxRetries: 0, delayMs: 1000 },
  timeoutMs: 30000,
  failurePolicy: 'stopWorkflow',
  platformConstraint: [],
  inputs: {},
  outputs: {},
  metadata: {},
  ...extra,
});
const edge = (from, to, outlet = 'success') => ({ id: crypto.randomUUID(), from, to, outlet });
async function finish(id) {
  for (let i = 0; i < 180; i++) {
    const r = (await invoke('bootstrap')).runs.find((r) => r.id === id);
    if (['succeeded', 'failed', 'cancelled'].includes(r?.status)) return r;
    if (i % 10 === 0)
      console.log(
        'Workflow: ' +
          r.nodeRuns
            .filter((n) => ['running', 'waiting', 'retrying'].includes(n.status))
            .map((n) => n.nodeId + ':' + n.status)
            .join(', '),
      );
    await sleep(1000);
  }
  await invoke('cancel_run', { runId: id });
  throw Error('Host workflow timed out');
}
function processSnapshot() {
  const script = `$all = Get-CimInstance Win32_Process; $ids = @(${app.pid}); do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while ($next.Count -gt 0); @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,@{n='cpuSeconds';e={$_.CPU}},@{n='workingSetBytes';e={$_.WorkingSet64}},@{n='privateBytes';e={$_.PrivateMemorySize64}}) | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
}
async function dbSnapshot() {
  const result = {};
  for (const f of await readdir(dataDir)) {
    if (/\.(db|sqlite)(-wal|-shm)?$/.test(f)) {
      const p = join(dataDir, f),
        s = await stat(p);
      result[f] = {
        bytes: s.size,
        modified: s.mtimeMs,
        sha256: createHash('sha256')
          .update(await readFile(p))
          .digest('hex'),
      };
    }
  }
  return result;
}
async function performance() {
  await sleep(5000);
  await page.evaluate(async () => {
    window.__idleEvents = {};
    for (const event of ['run', 'trigger', 'resync', 'error', 'automationSession']) {
      window.__idleEvents[event] = 0;
      await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: 'launchflow://' + event,
        target: { kind: 'Any' },
        handler: window.__TAURI_INTERNALS__.transformCallback(() => window.__idleEvents[event]++),
      });
    }
  });
  const before = processSnapshot(),
    dbBefore = await dbSnapshot(),
    began = performanceNow();
  console.log('Measuring 60 seconds of quiet desktop idle time');
  await sleep(60000);
  const elapsed = (performanceNow() - began) / 1000,
    after = processSnapshot(),
    dbAfter = await dbSnapshot();
  const cpu = after.reduce(
    (sum, p) =>
      sum + Math.max(0, p.cpuSeconds - (before.find((b) => b.Id === p.Id)?.cpuSeconds || 0)),
    0,
  );
  const result = {
    version: '0.4.0',
    build: 'debug; WebView2 CDP enabled',
    durationSeconds: elapsed,
    logicalProcessors: cpus().length,
    cpuPercentOneCore: (cpu / elapsed) * 100,
    cpuPercentTotalCapacity: (cpu / elapsed / cpus().length) * 100,
    workingSetBytes: after.reduce((s, p) => s + p.workingSetBytes, 0),
    privateBytes: after.reduce((s, p) => s + p.privateBytes, 0),
    processes: after.map((p) => ({
      ...p,
      idleCpuSeconds: Math.max(
        0,
        p.cpuSeconds - (before.find((b) => b.Id === p.Id)?.cpuSeconds || 0),
      ),
    })),
    events: await page.evaluate(() => window.__idleEvents),
    databaseUnchanged: JSON.stringify(dbBefore) === JSON.stringify(dbAfter),
    databaseFiles: dbAfter,
    triggerIntervalSeconds: 5,
    retentionIntervalSeconds: 900,
    limitations:
      'Short debug-build sample; summed working sets include shared pages. Not a battery or release-build benchmark.',
  };
  await writeFile(
    join(artifacts, idleOnly ? 'performance-idle.json' : 'performance.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(
    'PERFORMANCE ' +
      JSON.stringify({
        cpuPercentOneCore: result.cpuPercentOneCore,
        privateMiB: result.privateBytes / 1048576,
        events: result.events,
        databaseUnchanged: result.databaseUnchanged,
      }),
  );
}
const performanceNow = () => Number(process.hrtime.bigint()) / 1e6;
const backendPort = await port(),
  pidFile = join(dataDir, 'backend.pid'),
  visits = join(dataDir, 'browser-visited.json');
try {
  await start(idleOnly ? ['--startup'] : []);
  const boot = await invoke('bootstrap');
  await invoke('save_settings', {
    settings: { ...boot.settings, notifications: false, startupDelaySeconds: 0 },
  });
  if (idleOnly) {
    assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), false);
    await performance();
  } else {
    const bindings = {
      clash: ['D:/soft/clash/clash-verge.exe', 'clash-verge.exe'],
      docker: ['C:/Program Files/Docker/Docker/Docker Desktop.exe', 'Docker Desktop.exe'],
      idea: ['D:/soft/IDEA 2024.1.7/IntelliJ IDEA 2024.1.7/bin/idea64.exe', 'idea64.exe'],
      chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'chrome.exe'],
      backend: [process.execPath, 'node.exe'],
    };
    const fixture = join(dataDir, 'backend.mjs');
    await writeFile(
      fixture,
      `import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';const server=createServer((req,res)=>{if(req.url==='/dev')writeFileSync(${JSON.stringify(visits)},JSON.stringify({path:req.url,at:new Date().toISOString()}));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><title>LaunchFlow local acceptance</title><h1>LaunchFlow Phase 4</h1><p>Independent local acceptance service. No project or credentials.</p>');});server.listen(${backendPort},'127.0.0.1',()=>writeFileSync(${JSON.stringify(pidFile)},String(process.pid)));setTimeout(()=>server.close(()=>process.exit(0)),600000);`,
    );
    for (const [id, [executable, processName]] of Object.entries(bindings)) {
      assert(existsSync(executable));
      await invoke('save_profile', {
        profile: {
          schemaVersion: 1,
          id: 'host-' + id,
          displayName: id + ' · 本机验收',
          windows: { executable, processName },
          macos: { appPath: '', bundleId: '', processName: '' },
          launchArguments: [],
          readyDetection: id === 'backend' ? null : { kind: 'process', processName },
        },
      });
    }
    const capture = await invoke('workspace_capture');
    const display = capture.displays.find((d) => d.primary) || capture.displays[0];
    assert(display);
    const layout = ['idea', 'chrome'].map((id, i) => ({
      applicationId: 'host-' + id,
      identity: { application: bindings[id][1], title: '', className: '', pid: null, handle: null },
      display,
      bounds: display.workArea,
      relative: { x: i ? 0.66 : 0, y: 0, width: i ? 0.34 : 0.66, height: 1 },
      state: 'normal',
    }));
    const locators = [
      { kind: 'accessibility', window: { application: 'idea64.exe' }, role: 'Window' },
    ];
    const nodes = [
      node('flow.condition', 'Network Ready', {
        kind: 'network',
        host: 'www.microsoft.com',
        port: 443,
      }),
      node('application.launch', 'Launch Proxy', { applicationId: 'host-clash' }),
      node('wait.port', 'Wait Proxy', { host: '127.0.0.1', port: 7897 }),
      node('application.launch', 'Launch Docker', { applicationId: 'host-docker' }),
      node(
        'system.command',
        'Docker Ready',
        {
          program: 'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
          arguments: ['info', '--format', '{{.ServerVersion}}'],
          captureOutput: true,
        },
        { timeoutMs: 5000, retryPolicy: { maxRetries: 20, delayMs: 4000 } },
      ),
      ...['idea', 'chrome'].map((id) =>
        node('application.launch', id, { applicationId: 'host-' + id }, { timeoutMs: 60000 }),
      ),
      node(
        'application.launch',
        'DataGrip · 未安装',
        { applicationId: 'not-installed' },
        { enabled: false },
      ),
      node('flow.join', 'Join'),
      node('gui.waitWindow', 'IDEA Window', { locators }, { timeoutMs: 60000 }),
      node('gui.activateWindow', 'IDEA Activate', { locators }),
      node('gui.shortcut', 'IDEA Action Search', { locators, keys: ['Ctrl', 'Shift', 'A'] }),
      node('system.delay', 'Allow Action UI', { durationMs: 600 }),
      node('gui.pressKey', 'IDEA Close Action Search', { locators, key: 'Escape' }),
      node('application.launch', 'Start Independent Backend', {
        applicationId: 'host-backend',
        arguments: [fixture],
        alreadyRunning: 'newInstance',
      }),
      node('wait.port', 'Wait Backend Port', { host: '127.0.0.1', port: backendPort }),
      node('application.open.url', 'Open Development URL', {
        target: `http://127.0.0.1:${backendPort}/dev`,
      }),
      node('system.delay', 'Allow Browser Window', { durationMs: 1500 }),
      node('workspace.restore', 'Restore Workspace', {
        mode: 'relative',
        profiles: [
          {
            name: 'Laptop',
            condition: { count: capture.displays.length, displayNames: [] },
            windows: layout,
          },
        ],
      }),
    ];
    const edges = [
      edge(nodes[0].id, nodes[1].id, 'true'),
      ...nodes.slice(1, 4).map((n, i) => edge(n.id, nodes[i + 2].id)),
      ...['idea', 'chrome', 'DataGrip · 未安装'].flatMap((id) => [
        edge('Docker Ready', id),
        edge(id, 'Join'),
      ]),
      ...nodes.slice(8, -1).map((n, i) => edge(n.id, nodes[i + 9].id)),
    ];
    let scene = await invoke('create_scene', { name: 'Phase 4 · 真实开发环境验收' });
    const selectedNodes = downstreamOnly ? nodes.slice(5) : nodes;
    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    scene.workflow = {
      nodes: selectedNodes,
      edges: edges.filter((e) => selectedIds.has(e.from) && selectedIds.has(e.to)),
      annotations: [],
    };
    scene.sensitiveActionPolicy = 'allowForThisScene';
    scene.description =
      '已授权的本机验收。DataGrip 未安装；后端为独立本地验收服务；IDEA 仅打开并关闭动作搜索，不编辑项目。';
    scene = await invoke('save_scene', { scene });
    await invoke('set_default_scene', { sceneId: scene.id });
    await stop();
    await start(['--startup']);
    assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), false);
    await expect
      .poll(async () => (await invoke('bootstrap')).runs.find((r) => r.sceneId === scene.id)?.id, {
        timeout: 10000,
      })
      .toBeTruthy();
    const initial = (await invoke('bootstrap')).runs.find((r) => r.sceneId === scene.id);
    const run = await finish(initial.id);
    const result = {
      version: '0.4.0',
      scope: downstreamOnly
        ? 'Independent downstream check after Docker readiness failed; does not establish full workflow success'
        : 'Full real application workflow',
      testedAt: new Date().toISOString(),
      invocation: '--startup (login-equivalent entry point; no actual OS logout/login)',
      hiddenAtStartup: true,
      notifications: 'disabled for automated host test; notification wiring reviewed separately',
      backend: 'independent local acceptance service, explicitly selected by user',
      dataGrip: 'not installed, disabled',
      displayCount: capture.displays.length,
      status: run.status,
      nodeResults: run.nodeRuns.map((n) => ({
        node: n.nodeId,
        status: n.status,
        retryCount: n.retryCount,
        error: n.error,
        output: n.output,
      })),
      error: run.error,
      errors,
    };
    await writeFile(join(artifacts, evidenceName + '.json'), JSON.stringify(result, null, 2));
    if (run.status === 'succeeded') {
      await expect.poll(() => existsSync(visits), { timeout: 10000 }).toBe(true);
      result.browserVisited = JSON.parse(await readFile(visits, 'utf8'));
      const final = await invoke('workspace_capture');
      result.restoredApplications = final.windows
        .filter((w) => ['idea64.exe', 'chrome.exe'].includes(w.identity.application))
        .map((w) => ({ application: w.identity.application, bounds: w.bounds }));
    }
    await writeFile(join(artifacts, evidenceName + '.json'), JSON.stringify(result, null, 2));
    console.log('REAL WORKFLOW ' + run.status + (run.error ? ' ' + run.error : ''));
    if (!downstreamOnly) await performance();
    const shown = spawn(binary, [], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, LAUNCHFLOW_TEST_DATA_DIR: dataDir },
    });
    await new Promise((r) => shown.once('exit', r));
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '运行历史', exact: true })
      .click();
    await page.screenshot({ path: join(artifacts, evidenceName + '.png') });
    assert.equal(run.status, 'succeeded', run.error);
    assert.deepEqual(errors, []);
  }
} finally {
  await stop();
  if (existsSync(pidFile)) {
    const pid = Number(await readFile(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid);
      } catch {}
    }
  }
}
