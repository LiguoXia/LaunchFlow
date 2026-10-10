/** Own password fixture only: raw-view discovery, old QQ proxy locators, privacy and guards. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { callNative, worker } from './test-native.mjs';
const directory = await mkdtemp(join(tmpdir(), 'lf-secret-input-'));
const artifacts = resolve('test-results/recorded-secret');
await mkdir(artifacts, { recursive: true });
const framework = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
const refs = [
  'System.Web.Extensions.dll',
  'System.Xaml.dll',
  ...[
    'WindowsBase.dll',
    'PresentationFramework.dll',
    'PresentationCore.dll',
    'UIAutomationClient.dll',
    'UIAutomationTypes.dll',
    'UIAutomationProvider.dll',
  ].map((p) => join(framework, 'WPF', p)),
];
function compile(name, sources, references) {
  const output = join(directory, name + '.exe');
  execFileSync(
    join(framework, 'csc.exe'),
    [
      '/nologo',
      `/out:${output}`,
      ...references.map((p) => '/reference:' + p),
      ...sources.map((p) => resolve(p)),
    ],
    { windowsHide: true },
  );
  return output;
}
await copyFile(worker, join(directory, 'launchflow-automation.exe'));
const unit = compile(
  'RecordedSecretTests',
  ['native/windows/tests/RecordedSecretTests.cs'],
  [...refs, worker],
);
console.log(execFileSync(unit, [], { encoding: 'utf8', windowsHide: true }));
const fixture = compile(
  'SecretInputFixture',
  ['native/windows/Common.cs', 'native/windows/tests/SecretInputFixture.cs'],
  refs,
);
const marker = join(directory, 'secret');
const app = spawn(fixture, [marker], { windowsHide: true, stdio: 'ignore' });
const window = { pid: app.pid, title: 'LaunchFlow Secret Input Fixture' };
const legacy = {
  kind: 'accessibility',
  window: { className: 'Chrome_WidgetWin_1' },
  role: 'Edit',
  name: '',
  automationId: '',
  className: 'Edit',
  frameworkId: 'Win32',
  ancestorPath: [],
};
const broad = { kind: 'accessibility', role: 'Edit', secure: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error('Secret fixture timeout');
}
const checks = [],
  errors = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
const perform = (locator, action) => callNative({ op: 'perform', window, locator, action });
const value = () => readFile(marker + '.value', 'utf8').catch(() => '');
let recorder;
try {
  await until(async () => (await callNative({ op: 'windows' })).some((w) => w.pid === app.pid));
  await check(
    'Delayed raw-view password provider resolves with the legacy QQ proxy locator',
    async () => {
      await perform({ kind: 'accessibility', automationId: 'prepare' }, { kind: 'click' });
      const target = await callNative({ op: 'find', window, locator: legacy, secureInput: true });
      assert(target.secure);
      assert.equal(target.automationId, 'raw-secret');
      const elements = await callNative({ op: 'elements', window });
      assert(!elements.some((e) => e.automationId === 'raw-secret'));
      await perform(
        { ...legacy, runtimeId: target.runtimeId },
        { kind: 'inputSecret', text: 'SYNTHETIC_SECRET_中文' },
      );
      await until(async () => (await value()) === 'SYNTHETIC_SECRET_中文');
    },
  );
  await check(
    'Recording stores a Secret reference and a secure locator without the typed value',
    async () => {
      recorder = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '';
      const events = [];
      recorder.stdout.on('data', (b) => {
        buffer += b;
        let n;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          if (line.trim()) events.push(JSON.parse(line));
        }
      });
      recorder.stdin.write(JSON.stringify({ op: 'record', window }) + '\n');
      await until(() => events.some((e) => e.state === 'recording'));
      await writeFile(marker + '.record', '');
      await sleep(250);
      await perform(
        { kind: 'accessibility', automationId: 'username' },
        { kind: 'inputText', text: 'FIXTURE_USER' },
      );
      await perform(
        { kind: 'accessibility', automationId: 'record-secret' },
        { kind: 'inputSecret', text: 'RECORDING_PRIVATE_FIXTURE' },
      );
      await until(() => events.some((e) => e.actions?.some((a) => a.kind === 'inputSecret')));
      recorder.stdin.write(JSON.stringify({ op: 'stop' }) + '\n');
      await until(() => events.some((e) => e.event === 'stopped'));
      const actions = events.findLast((e) => e.event === 'stopped').actions;
      const secret = actions.find((a) => a.kind === 'inputSecret');
      assert(secret);
      assert.equal(secret.secretRef, 'unresolved');
      assert(secret.locators[0].secure);
      assert(!JSON.stringify(events).includes('RECORDING_PRIVATE_FIXTURE'));
      assert(!JSON.stringify(events).includes('SYNTHETIC_SECRET_中文'));
      await writeFile(join(artifacts, 'actions.json'), JSON.stringify(actions, null, 2));
      await unlink(marker + '.record');
      await writeFile(marker + '.raw', '');
    },
  );
  await check('Two secure fields are ambiguous and receive no input', async () => {
    await writeFile(marker + '.ambiguous', '');
    await sleep(250);
    const before = await value();
    await assert.rejects(
      perform(broad, { kind: 'inputSecret', text: 'MUST_NOT_TYPE' }),
      (e) => e.detail?.code === 'ambiguous',
    );
    assert.equal(await value(), before);
  });
  await check('A regular username or hidden password cannot satisfy a Secret locator', async () => {
    await assert.rejects(
      perform(
        { kind: 'accessibility', automationId: 'username' },
        { kind: 'inputSecret', text: 'MUST_NOT_TYPE' },
      ),
      (e) => e.detail?.code === 'notFound',
    );
    await writeFile(marker + '.hide', '');
    await sleep(250);
    await assert.rejects(
      perform(broad, { kind: 'inputSecret', text: 'MUST_NOT_TYPE' }),
      (e) => e.detail?.code === 'notFound',
    );
    assert.equal(await readFile(marker + '.user', 'utf8'), 'FIXTURE_USER');
  });
  await check(
    'A focused offscreen password proxy resolves, but an unfocused one is rejected',
    async () => {
      await unlink(marker + '.hide');
      await unlink(marker + '.ambiguous');
      await writeFile(marker + '.proxy', '');
      await writeFile(marker + '.proxy-focus', '');
      await sleep(250);
      const locator = { kind: 'accessibility', automationId: 'offscreen-secret' };
      const target = await callNative({ op: 'find', window, locator, secureInput: true });
      assert(target.secure);
      assert(target.offscreen);
      await perform(
        { ...locator, runtimeId: target.runtimeId },
        { kind: 'inputSecret', text: 'FOCUSED_PROXY_SECRET' },
      );
      await until(async () => (await value()) === 'FOCUSED_PROXY_SECRET');
      await unlink(marker + '.proxy-focus');
      await writeFile(marker + '.proxy-blur', '');
      await sleep(250);
      await assert.rejects(
        callNative({ op: 'find', window, locator, secureInput: true }),
        (e) => e.detail?.code === 'notFound',
      );
    },
  );
} catch (error) {
  errors.push(String(error));
  throw error;
} finally {
  recorder?.kill();
  await writeFile(marker + '.stop', '');
  app.kill();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
}
