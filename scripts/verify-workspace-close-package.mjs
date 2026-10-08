import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const root = resolve('artifacts/workspace-close');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const folder = join(root, 'windows', `LaunchFlow-${manifest.version}-windows-x64`);
const checks = [];
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
for (const f of manifest.files) {
  assert.equal(await hash(join(root, f.file)), f.sha256);
  checks.push(`SHA256 ${f.file}`);
}
for (const name of ['automation', 'authorized', 'harness']) {
  assert.equal(
    await hash(join(folder, 'native', `launchflow-${name}.exe`)),
    await hash(`native/bin/launchflow-${name}.exe`),
  );
}
checks.push('Packaged native executables match the tested source binaries');
const report = JSON.parse(await readFile('test-results/workspace-close/report.json', 'utf8'));
const fixture = spawn(
  join(report.fixtureDirectory, 'LFGood.exe'),
  ['good', join(report.fixtureDirectory, 'package-close')],
  { windowsHide: false, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const worker = (request) =>
  JSON.parse(
    execFileSync(join(folder, 'native/launchflow-automation.exe'), [], {
      input: JSON.stringify(request) + '\n',
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
try {
  await sleep(400);
  const capture = worker({ op: 'workspaceCloseCapture', ownerPid: process.pid });
  assert(capture.ok);
  const row = capture.result.find((a) => a.target.pid === fixture.pid);
  assert(row);
  assert(!row.blocked);
  const request = { op: 'workspaceClose', ownerPid: process.pid, targets: [row.target] };
  const started = worker({ ...request, action: 'graceful' });
  assert(started.ok);
  await sleep(500);
  assert.equal(worker({ ...request, action: 'status' }).result[0].state, 'closed');
  assert.match(await readFile(join(report.fixtureDirectory, 'package-close'), 'utf8'), /close/);
  checks.push('Packaged worker captured and gracefully closed only its independent fixture');
} finally {
  fixture.kill();
}
const evidence = join(root, 'evidence');
await mkdir(evidence, { recursive: true });
for (const name of ['report.json', 'capture.png', 'graceful-result.png'])
  await copyFile(join('test-results/workspace-close', name), join(evidence, name));
await copyFile(
  'test-results/preauthorization/desktop/desktop-report.json',
  join(evidence, 'uac-desktop-report.json'),
);
await copyFile(
  'test-results/preauthorization/native-report.json',
  join(evidence, 'native-authorization-report.json'),
);
await writeFile(
  join(evidence, 'package-verification.json'),
  JSON.stringify(
    { version: manifest.version, checks, verifiedAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log(JSON.stringify({ version: manifest.version, checks }, null, 2));
