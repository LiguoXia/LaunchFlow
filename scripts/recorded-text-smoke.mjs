/** Owned WPF input: Chinese TextPattern capture and verified Unicode fallback. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { callNative, worker } from './test-native.mjs';
const directory = await mkdtemp(join(tmpdir(), 'lf-chinese-text-'));
const artifacts = resolve('test-results/recorded-text');
await mkdir(artifacts, { recursive: true });
const framework = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
const compile = (name, sources, refs) => {
  const output = join(directory, name + '.exe');
  execFileSync(
    join(framework, 'csc.exe'),
    [
      '/nologo',
      `/out:${output}`,
      ...refs.map((p) => '/reference:' + p),
      ...sources.map((p) => resolve(p)),
    ],
    { windowsHide: true },
  );
  return output;
};
const fixture = compile(
  'TextInputFixture',
  ['native/windows/Common.cs', 'native/windows/tests/TextInputFixture.cs'],
  [
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
  ],
);
const focus = compile(
  'ForegroundFixture',
  ['native/windows/Common.cs', 'native/windows/tests/ForegroundFixture.cs'],
  ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'],
);
const marker = join(directory, 'input');
const app = spawn(fixture, [marker], { windowsHide: true, stdio: 'ignore' });
const window = { pid: app.pid, title: 'LaunchFlow Chinese Text Fixture' };
const locator = { kind: 'accessibility', automationId: 'chinese-input' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error('Text fixture timeout');
}
const value = async () => readFile(marker + '.txt', 'utf8').catch(() => '');
const checks = [],
  errors = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
};
let recorder;
function session() {
  const child = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const events = [];
  child.stdout.on('data', (b) => {
    buffer += b;
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  child.stdin.write(JSON.stringify({ op: 'record', window }) + '\n');
  return { child, events, send: (op) => child.stdin.write(JSON.stringify({ op }) + '\n') };
}
const perform = (action, target = locator) =>
  callNative({ op: 'perform', window, locator: target, action });
try {
  await until(async () => (await callNative({ op: 'windows' })).some((w) => w.pid === app.pid));
  const target = (await callNative({ op: 'windows' })).find((w) => w.pid === app.pid);
  execFileSync(focus, [String(app.pid), target.handle, '--caption'], {
    windowsHide: true,
    timeout: 8000,
  });
  recorder = session();
  await until(() => recorder.events.some((e) => e.state === 'recording'));
  const chinese = '中文录制测试，今天开始工作。';
  await check(
    'Chinese TextPattern input is captured even when ValuePattern reports empty and SetValue does nothing',
    async () => {
      await perform({ kind: 'inputText', text: chinese });
      assert.equal(await value(), chinese);
      await until(() =>
        recorder.events.some((e) =>
          e.actions?.some((a) => a.kind === 'inputText' && a.text.trim() === chinese),
        ),
      );
    },
  );
  await check(
    'Continued Chinese edits after a pause update the last text action with stable locators',
    async () => {
      await sleep(1700);
      const beforeCount = recorder.events
        .findLast((e) => e.actions)
        .actions.filter((a) => a.kind === 'inputText').length;
      await writeFile(marker + '.append', '完成');
      await until(() =>
        recorder.events
          .findLast((e) => e.actions)
          ?.actions.some((a) => a.kind === 'inputText' && a.text.trim() === chinese + '完成'),
      );
      const inputs = recorder.events
        .findLast((e) => e.actions)
        .actions.filter((a) => a.kind === 'inputText');
      assert.equal(inputs.length, beforeCount);
      assert.equal(inputs[0].locators[0].name, '');
    },
  );
  await check(
    'Paused recording excludes text and resumed recording does not copy paused content',
    async () => {
      recorder.send('pause');
      await until(() => recorder.events.some((e) => e.state === 'paused'));
      await perform({ kind: 'inputText', text: 'PAUSED_PRIVATE_FIXTURE' });
      await sleep(300);
      recorder.send('resume');
      await until(() => recorder.events.filter((e) => e.state === 'recording').length === 2);
      await perform({ kind: 'inputText', text: '恢复后的中文' });
      await sleep(300);
      assert(!JSON.stringify(recorder.events).includes('PAUSED_PRIVATE_FIXTURE'));
    },
  );
  recorder.send('stop');
  await until(() => recorder.events.some((e) => e.event === 'stopped'));
  const actions = recorder.events.findLast((e) => e.event === 'stopped').actions;
  const text = actions.filter((a) => a.kind === 'inputText').at(-1);
  await check(
    'Recorded Chinese action replays into the real input field and verifies the resulting text',
    async () => {
      assert(text);
      await perform({ kind: 'inputText', text: '临时内容' });
      const { locators, ...action } = text;
      await perform(action, locators[0]);
      assert.equal((await value()).trim(), String(text.text).trim());
    },
  );
  await check('Whole-window text target is rejected before typing', async () => {
    const before = await value();
    let failure;
    try {
      await perform(
        { kind: 'inputText', text: 'MUST_NOT_TYPE' },
        { kind: 'accessibility', role: 'Window' },
      );
    } catch (e) {
      failure = e;
    }
    assert.equal(failure?.detail?.code, 'impreciseTextTarget');
    assert.equal(await value(), before);
  });
  await writeFile(join(artifacts, 'actions.json'), JSON.stringify(actions, null, 2));
} catch (error) {
  errors.push(String(error));
  throw error;
} finally {
  await writeFile(join(artifacts, 'events.json'), JSON.stringify(recorder?.events ?? [], null, 2));
  recorder?.child.kill();
  await writeFile(marker + '.stop', '');
  app.kill();
  await writeFile(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        checks,
        errors,
        scope:
          'Own fixture only. Chinese Unicode commit and TextPattern fallback; not an actual WeChat chat or physical IME candidate test.',
      },
      null,
      2,
    ),
  );
}
