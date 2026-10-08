/** Default tests never request UAC. --approve adds real UAC with disposable fixture windows. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const directory = await mkdtemp(join(tmpdir(), 'lf-close-admin-'));
const artifacts = resolve('test-results/workspace-close-admin');
await mkdir(artifacts, { recursive: true });
const worker = resolve('native/bin/launchflow-automation.exe');
const csc = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const tests = join(directory, 'Tests.exe');
execFileSync(
  csc,
  ['/nologo', `/out:${tests}`, resolve('native/windows/tests/WorkspaceCloseTests.cs')],
  { windowsHide: true },
);
const checks = [execFileSync(tests, [worker], { encoding: 'utf8', windowsHide: true }).trim()];
console.log(checks[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
async function native(request) {
  return new Promise((done, reject) => {
    const child = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('Native close timeout'));
    }, 180000);
    child.stdout.on('data', (b) => (output += b));
    child.on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timeout);
      try {
        const r = JSON.parse(output);
        assert(r.ok, JSON.stringify(r.error));
        done(r.result);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
let marker;
try {
  if (process.argv.includes('--approve')) {
    const source = join(directory, 'Fixture.cs'),
      exe = join(directory, 'LFAdminCloseFixture.exe');
    marker = join(directory, 'fixture');
    await writeFile(
      source,
      `using System;using System.IO;using System.Windows.Forms;using System.Diagnostics;class Fixture{[STAThread]static void Main(string[]a){var f=new Form{Text="LaunchFlow 管理员关闭验收",Width=420,Height=130};bool exit=false;var start=DateTime.UtcNow;f.FormClosing+=(s,e)=>{File.AppendAllText(a[0]+".closed","close\\n");if(a[1]=="hold"&&!exit)e.Cancel=true;};var timer=new Timer{Interval=200};timer.Tick+=(s,e)=>{if(File.Exists(a[0]+".stop")||(DateTime.UtcNow-start).TotalMinutes>5){exit=true;f.Close();}};timer.Start();File.WriteAllText(a[0]+".pid",Process.GetCurrentProcess().Id.ToString());Application.Run(f);}}`,
    );
    execFileSync(
      csc,
      ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', `/out:${exe}`, source],
      { windowsHide: true },
    );
    for (const mode of ['good', 'hold']) {
      const receipt = marker + '-' + mode;
      console.log(`请为独立 ${mode} 测试窗口和接下来的关闭操作确认 Windows UAC；脚本不会代点。`);
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; Start-Process -FilePath ${quote(exe)} -Verb RunAs -WindowStyle Hidden -ArgumentList @(${quote('"' + receipt + '"')},${quote(mode)})`,
        ],
        { windowsHide: true },
      );
      let row;
      for (let i = 0; i < 40 && !row; i++) {
        await sleep(250);
        row = (await native({ op: 'workspaceCloseCapture', ownerPid: process.pid })).find(
          (r) => r.executable.toLowerCase() === exe.toLowerCase(),
        );
      }
      assert(row && !row.blocked, 'Elevated fixture must be capturable');
      let result = await native({
        op: 'workspaceClose',
        action: 'graceful',
        ownerPid: process.pid,
        targets: [row.target],
      });
      assert.equal(result[0].state, 'pending', JSON.stringify(result));
      await sleep(600);
      assert((await readFile(receipt + '.closed', 'utf8')).includes('close'));
      result = await native({
        op: 'workspaceClose',
        action: 'status',
        ownerPid: process.pid,
        targets: [row.target],
      });
      if (mode === 'hold') {
        assert.equal(result[0].state, 'pending');
        console.log('正常退出已由测试窗口拒绝；现在显式验收强制关闭，请确认下一次 UAC。');
        result = await native({
          op: 'workspaceClose',
          action: 'force',
          ownerPid: process.pid,
          targets: [row.target],
        });
      }
      assert.equal(result[0].state, 'closed', JSON.stringify(result));
      checks.push(
        `Actual elevated ${mode === 'good' ? 'graceful close' : 'graceful-first explicit force fallback'}`,
      );
    }
  }
} finally {
  if (marker)
    for (const mode of ['good', 'hold']) await writeFile(marker + '-' + mode + '.stop', 'cleanup');
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        checks,
        realUacTested: process.argv.includes('--approve'),
        note: 'Default run tests routing with authorization response fixtures, without elevating or closing user applications.',
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ checks, uac: process.argv.includes('--approve') }));
