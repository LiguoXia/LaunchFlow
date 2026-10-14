import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'lf-focus-'));
const worker = resolve(
  process.env.LAUNCHFLOW_TEST_NATIVE_WORKER || 'native/bin/launchflow-automation.exe',
);
const exe = join(directory, 'WindowFocusTests.exe');
copyFileSync(worker, join(directory, 'launchflow-automation.exe'));
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${exe}`,
    `/reference:${worker}`,
    resolve('native/windows/tests/WindowFocusTests.cs'),
  ],
  { windowsHide: true },
);
const output = execFileSync(exe, [], { encoding: 'utf8', windowsHide: true });
console.log(output);
mkdirSync('test-results/gui-focus', { recursive: true });
writeFileSync('test-results/gui-focus/native-unit.txt', output);
