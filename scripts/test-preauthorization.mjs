/** --approve requires a human to approve one genuine UAC prompt. Default is read-only/unelevated. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const artifacts = resolve('test-results/preauthorization');
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'launchflow-authorization-'));
const worker = resolve('native/bin/launchflow-automation.exe');
const csc = join(
  process.env.WINDIR || 'C:/Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const checks = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export function callApplication(request, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('Application broker timeout'));
    }, timeout);
    child.stdout.on('data', (b) => (output += b));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (!result.ok) throw Error(result.error.message);
        resolve(result.result);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.on('error', () => {});
  });
}
const pass = (name) => {
  checks.push(name);
  console.log('PASS ' + name);
};
const unit = join(directory, 'AuthorizationTests.exe');
execFileSync(
  csc,
  [
    '/nologo',
    '/reference:Microsoft.CSharp.dll',
    `/out:${unit}`,
    resolve('native/windows/tests/AuthorizationTests.cs'),
  ],
  { windowsHide: true },
);
const output = execFileSync(unit, [worker, join(directory, 'missing.exe'), directory], {
  encoding: 'utf8',
  windowsHide: true,
});
console.log(output.trim());
pass('Native ACL and input validation');
const source = join(directory, 'Fixture.cs'),
  executable = join(directory, '授权 测试.exe'),
  marker = join(directory, 'receipt.jsonl');
await writeFile(
  source,
  `using System; using System.IO; using System.Security.Principal; using System.Web.Script.Serialization; class Fixture {static void Main(string[] args) {File.AppendAllText(args[0],new JavaScriptSerializer().Serialize(new {elevated=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),args=args})+Environment.NewLine);System.Threading.Thread.Sleep(750);}}`,
);
execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/reference:System.Web.Extensions.dll',
    `/out:${executable}`,
    source,
  ],
  { windowsHide: true },
);
const profileId = 'preauthorization-acceptance-' + randomUUID();
const request = {
  profileId,
  executable,
  arguments: [marker, '中文 空格', '', 'trailing\\', 'literal %PATH% & $(Arg0)'],
};
const op = (name, extra = {}) =>
  callApplication({ ...request, ...extra, op: 'applicationAuthorization' + name });
assert.equal((await op('Status')).state, 'notAuthorized');
await assert.rejects(() => op('Run'), /尚未预授权|已撤销/);
pass('No implicit registration or UAC on missing grant');
let granted = false;
try {
  if (process.argv.includes('--approve')) {
    console.log(
      'ACTION REQUIRED: approve the Windows UAC prompt for LaunchFlow authorization test. No automatic clicking.',
    );
    const status = await op('Grant');
    granted = true;
    assert.equal(status.state, 'authorized');
    pass('Real UAC registration and protected task/config validation');
    const original = await readFile(executable);
    for (let i = 0; i < 2; i++) {
      assert.equal((await op('Run')).launched, true);
      await delay(1000);
    }
    const rows = (await readFile(marker, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((x) => JSON.parse(x));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.elevated, true);
      assert.deepEqual(row.args, request.arguments);
    }
    pass('Two genuine elevated launches without another UAC prompt, with literal fixed arguments');
    await assert.rejects(
      () => op('Run', { arguments: [...request.arguments, 'unauthorized-extra'] }),
      /参数.*变更/,
    );
    pass('Runtime argument changes rejected');
    await writeFile(executable, Buffer.concat([original, Buffer.from('changed')]));
    assert.equal((await op('Status')).state, 'changed');
    await assert.rejects(() => op('Run'), /文件已更新或变更/);
    // Bypass the unelevated client's checks deliberately: the protected runner must still reject.
    const nonce = randomUUID().replaceAll('-', '');
    const taskPath = status.taskPath;
    const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask(${quote(taskPath)}); $null=$t.Run(${quote(nonce)})`,
      ],
      { windowsHide: true },
    );
    const parts = taskPath.split('\\').filter(Boolean),
      key = parts[1].slice(4);
    const receipt = join(process.env.ProgramData, parts[0], key + '.' + nonce + '.receipt');
    for (let i = 0; i < 100; i++) {
      try {
        await access(receipt);
        break;
      } catch {
        await delay(100);
      }
    }
    const rejected = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /文件已更新或变更/);
    await writeFile(executable, original);
    pass('Protected runner rejects changed EXE even when task is invoked directly');
    // A read/execute/delete grant must not allow an unelevated user to change the task.
    const permission = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask(${quote(taskPath)}); try { $t.Enabled=$false; 'unexpected-write' } catch { $_.Exception.HResult }`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    ).trim();
    assert.equal(permission, '-2147024891');
    pass('Unelevated task modification denied');
    await op('Revoke');
    granted = false;
    assert.equal((await op('Status')).state, 'notAuthorized');
    await assert.rejects(() => op('Run'), /尚未预授权|已撤销/);
    pass('Unelevated revocation removes grant and prevents subsequent launch');
  } else
    console.log(
      'Real registration/launch test not run: use --approve with a human at the desktop.',
    );
} finally {
  if (process.argv.includes('--approve')) await op('Revoke');
  await writeFile(
    join(artifacts, 'native-report.json'),
    JSON.stringify(
      { checks, profileId, directory, manualConsentRequested: process.argv.includes('--approve') },
      null,
      2,
    ),
  );
}
