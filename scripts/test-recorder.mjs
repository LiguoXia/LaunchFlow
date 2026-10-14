import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { callNative, worker } from './test-native.mjs';
import { writeFile } from 'node:fs/promises';
const app = spawn(resolve('native/bin/launchflow-harness.exe'), [], {
  windowsHide: true,
  stdio: 'ignore',
});
const window = { pid: app.pid, title: 'LaunchFlow Automation Test Harness' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (test()) return;
    await pause(50);
  }
  throw new Error('Session event deadline');
}
function session(op) {
  const child = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const events = [];
  child.stdout.on('data', (b) => {
    buffer += b;
    let split;
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line.trim()) {
        const event = JSON.parse(line);
        events.push(event);
        if (process.env.DEBUG_SESSIONS) console.log(JSON.stringify(event));
      }
    }
  });
  child.stdin.write(JSON.stringify({ op, window }) + '\n');
  return { child, events, send: (op) => child.stdin.write(JSON.stringify({ op }) + '\n') };
}
const perform = (id, kind, args = {}) =>
  callNative({
    op: 'perform',
    window,
    locator: id ? { kind: 'accessibility', automationId: id } : {},
    action: { kind, ...args },
  });
let recorder, picker;
try {
  await pause(1200);
  recorder = session('record');
  await until(() => recorder.events.some((e) => e.state === 'recording'));
  await perform('start-button', 'click');
  for (const text of ['h', 'he', 'hel', 'hello'])
    await perform('project-input', 'inputText', { text });
  await until(() =>
    recorder.events.some(
      (event) =>
        event.event === 'actions' &&
        event.actions?.some((action) => action.kind === 'inputText' && action.text === 'hello'),
    ),
  );
  recorder.send('pause');
  await until(() => recorder.events.some((e) => e.state === 'paused'));
  await perform('project-input', 'inputText', { text: 'PAUSED_DO_NOT_RECORD' });
  await pause(300);
  recorder.send('resume');
  await pause(300);
  await perform('password-input', 'inputSecret', { text: 'HIDDEN_VALUE_92851' });
  await pause(1000);
  recorder.send('stop');
  await until(() => recorder.events.some((e) => e.event === 'stopped'));
  const actions = recorder.events.findLast((e) => e.event === 'stopped').actions;
  assert(actions.some((a) => a.kind === 'click'));
  assert.equal(actions.filter((a) => a.kind === 'inputText').length, 1);
  assert(actions.some((a) => a.kind === 'inputText' && a.text === 'hello'));
  assert(actions.some((a) => a.kind === 'inputSecret' && a.secretRef === 'unresolved'));
  const serialized = JSON.stringify(recorder.events);
  assert(!serialized.includes('HIDDEN_VALUE_92851'));
  assert(!serialized.includes('PAUSED_DO_NOT_RECORD'));
  const element = await callNative({
    op: 'find',
    window,
    locator: { kind: 'accessibility', automationId: 'start-button' },
  });
  await perform('start-button', 'movePointer');
  picker = session('pick');
  await until(() =>
    picker.events.some((e) => e.event === 'hover' && e.element.automationId === 'start-button'),
  );
  const rect = element.bounds;
  const resultInfo = () =>
    callNative({
      op: 'find',
      window,
      locator: { kind: 'accessibility', automationId: 'result-label' },
    });
  const beforePick = await resultInfo();
  await callNative({
    op: 'perform',
    window,
    point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    action: { kind: 'click' },
  });
  await until(() => picker.events.some((e) => e.event === 'selected'));
  assert.equal(
    picker.events.find((e) => e.event === 'selected').locator.automationId,
    'start-button',
  );
  await until(() => picker.events.some((e) => e.event === 'stopped'));
  assert.equal(
    (await resultInfo()).name,
    beforePick.name,
    'Picker must consume the real selection click',
  );
  picker = session('pick');
  await until(() => picker.events.some((e) => e.state === 'picking'));
  await perform(null, 'pressKey', { key: 'Escape' });
  await until(() => picker.events.some((e) => e.event === 'cancelled'));
  assert(!picker.events.some((e) => e.event === 'selected'));
  await writeFile('test-results/phase3/recorder-actions.json', JSON.stringify(actions, null, 2));
  console.log(
    'PASS semantic recorder merges text, pauses, masks password; picker consumes selection click and Esc cancels',
  );
} finally {
  recorder?.child.kill();
  picker?.child.kill();
  app.kill();
}
