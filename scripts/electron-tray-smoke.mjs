/** Actual Chromium renderer input after hide-to-tray restoration, in an owned fixture. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { worker } from './test-native.mjs';
const runtime = resolve(
  process.env.LAUNCHFLOW_ELECTRON_TEST_RUNTIME || '.tools/electron-33/electron.exe',
);
await access(runtime).catch(() => {
  throw new Error('Set LAUNCHFLOW_ELECTRON_TEST_RUNTIME to an installed Electron executable');
});
const directory = resolve('test-results/electron-tray');
await mkdir(directory, { recursive: true });
const marker = join(directory, 'fixture-' + Date.now());
const script = resolve('native/windows/tests/ElectronTrayFixture.cjs');
const driver = join(directory, 'ElectronTrayDriver.exe');
await copyFile(worker, join(directory, 'launchflow-automation.exe'));
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${driver}`,
    `/reference:${worker}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    resolve('native/windows/tests/ElectronTrayDriver.cs'),
  ],
  { windowsHide: true },
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = spawn(runtime, [script, marker], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
fixture.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => JSON.parse(await readFile(marker + '.json', 'utf8'));
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Electron fixture condition timed out');
}
try {
  await waitFor(async () => !(await state()).visible);
  const initial = await state();
  const baseline = process.argv.includes('--baseline');
  const stages = [];
  async function activate(oldPath, expectedClicks, expectedActivations, name) {
    const output = execFileSync(
      driver,
      [
        String(initial.pid),
        initial.handle,
        runtime,
        script,
        marker,
        ...(oldPath ? ['--baseline'] : []),
      ],
      { env, encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    await sleep(350);
    const after = await state();
    assert.equal(after.pid, initial.pid);
    assert.equal(after.handle, initial.handle);
    assert.equal(
      after.clicks,
      expectedClicks,
      'The actual Electron renderer must receive the mouse click',
    );
    assert.equal(after.activations, expectedActivations);
    assert.equal(after.rendererVisibility, oldPath ? 'hidden' : 'visible');
    stages.push({ name, after, native: JSON.parse(output.trim()) });
  }
  await activate(
    true,
    0,
    0,
    'Old path shows a ghost HWND but renderer remains hidden and ignores mouse input',
  );
  if (!baseline) {
    await activate(false, 1, 1, 'Repair an already-visible ghost window');
    await writeFile(marker + '.command', 'hide');
    await waitFor(async () => !(await state()).visible);
    await activate(false, 2, 2, 'Restore from a real Electron hide and click the renderer');
    await writeFile(marker + '.command', 'maximize-hide');
    await waitFor(async () => {
      const s = await state();
      return !s.visible && s.maximized;
    });
    await activate(false, 3, 3, 'Repeated tray activation preserves the maximized window');
    assert.equal((await state()).maximized, true);
  }
  const report = { initial, stages, baseline };
  await writeFile(
    join(directory, baseline ? 'baseline.json' : 'report.json'),
    JSON.stringify(report, null, 2),
  );
  for (const stage of stages) console.log('PASS ' + stage.name);
  console.log(
    baseline
      ? 'PASS reproduced old ghost window: input dispatched but renderer received no click'
      : 'PASS application activation restores actual Electron renderer mouse input',
  );
} finally {
  await writeFile(marker + '.command', 'quit');
  await sleep(500);
  fixture.kill();
}
