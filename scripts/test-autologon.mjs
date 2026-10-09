import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'lf-autologon-'));
const worker = resolve('native/bin/launchflow-automation.exe');
const exe = join(directory, 'AutoLogonTests.exe');
copyFileSync(worker, join(directory, 'launchflow-automation.exe'));
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${exe}`,
    `/reference:${worker}`,
    resolve('native/windows/tests/AutoLogonTests.cs'),
  ],
  { windowsHide: true },
);
const output = execFileSync(exe, [], { encoding: 'utf8', windowsHide: true });
console.log(output);
mkdirSync('test-results/autologon', { recursive: true });
writeFileSync('test-results/autologon/native-unit.txt', output);
if (process.argv.includes('--ui')) {
  const ui = join(directory, 'AutoLogonUiTests.exe');
  execFileSync(
    join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      `/out:${ui}`,
      '/main:AutoLogonUiTests',
      `/reference:${worker}`,
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Drawing.dll',
      resolve('native/windows/tests/AutoLogonTests.cs'),
      resolve('native/windows/tests/AutoLogonUiTests.cs'),
    ],
    { windowsHide: true },
  );
  const output = execFileSync(ui, [resolve('test-results/autologon')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  console.log(output);
  writeFileSync('test-results/autologon/native-ui.txt', output);
}
