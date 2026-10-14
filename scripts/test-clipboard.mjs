/** Known synthetic clipboard content must survive the short-lived worker's exit. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { callNative } from './test-native.mjs';
const text = '  LaunchFlow 中文\n第二行 🧪\r\n引号 " 与 $()\n';
let reader;
const dir = await mkdtemp(join(tmpdir(), 'lf-clipboard-'));
if (process.platform === 'win32') {
  reader = join(dir, 'ClipboardFixture.exe');
  execFileSync(
    join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      `/out:${reader}`,
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Web.Extensions.dll',
      resolve('native/windows/tests/ClipboardFixture.cs'),
    ],
    { windowsHide: true },
  );
}
const copied = await callNative({ op: 'clipboardCopyText', text });
assert.equal(copied.copied, true);
const read = () =>
  process.platform === 'win32'
    ? JSON.parse(execFileSync(reader, [], { encoding: 'utf8', windowsHide: true }))
    : execFileSync('pbpaste', [], {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'en_US.UTF-8' },
      });
assert.equal(read(), text);
console.log(
  'PASS Unicode, whitespace and multiline text remain in the clipboard after the worker exits',
);
await assert.rejects(callNative({ op: 'clipboardCopyText', text: 'invalid\0text' }));
assert.equal(read(), text);
console.log('PASS Invalid text fails without clearing the last copied text');
if (process.platform === 'win32') {
  const marker = join(dir, 'locked');
  const locker = spawn(reader, [marker], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await access(marker);
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    await assert.rejects(
      callNative({ op: 'clipboardCopyText', text: 'must not replace content' }),
      (e) => e.detail?.code === 'clipboardBusy',
    );
    console.log('PASS Busy clipboard reports failure rather than a false copy success');
  } finally {
    locker.kill();
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(read(), text);
}
