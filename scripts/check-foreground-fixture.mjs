import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callNative } from './test-native.mjs';
const directory = mkdtempSync(join(tmpdir(), 'lf-foreground-'));
const exe = join(directory, 'ForegroundFixture.exe');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${exe}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/Common.cs'),
    resolve('native/windows/tests/ForegroundFixture.cs'),
  ],
  { windowsHide: true },
);
const harness = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
});
try {
  await new Promise((r) => setTimeout(r, 1000));
  const window = (await callNative({ op: 'windows' })).find((w) => w.pid === harness.pid);
  console.log(
    execFileSync(exe, [String(harness.pid), window.handle], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    }),
  );
} finally {
  harness.kill();
}
