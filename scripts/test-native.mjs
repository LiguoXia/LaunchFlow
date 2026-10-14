import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const suffix = process.platform === 'win32' ? '.exe' : '';
export const worker = resolve(
  process.env.LAUNCHFLOW_TEST_NATIVE_WORKER || 'native/bin/launchflow-automation' + suffix,
);
export function callNative(request, timeout = 15000) {
  return new Promise((done, reject) => {
    const child = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '',
      error = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native timeout: ' + request.op));
    }, timeout);
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (error += b));
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output.trim());
        if (!result.ok)
          reject(Object.assign(new Error(result.error.message), { detail: result.error }));
        else done(result.result);
      } catch (e) {
        reject(new Error(String(e) + ' ' + error + ' ' + output));
      }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
if (
  process.argv[1] ===
    new URL(import.meta.url).pathname
      .replace(/^\/(\w:)/, '$1')
      .replaceAll('/', process.platform === 'win32' ? '\\' : '/') ||
  process.argv.includes('--run')
) {
  const harness = spawn(resolve('native/bin/launchflow-harness' + suffix), [], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const window = {
    pid: harness.pid,
    title: 'LaunchFlow Automation Test Harness',
  };
  const locator = (id) => ({ kind: 'accessibility', automationId: id });
  const request = (op, extra = {}) => ({ op, window, ...extra });
  const perform = (id, kind, extra = {}) =>
    callNative(request('perform', { locator: id ? locator(id) : {}, action: { kind, ...extra } }));
  try {
    await new Promise((r) => setTimeout(r, 1200));
    assert((await callNative(request('window'))).title.includes('Harness'));
    const elements = await callNative(request('elements'));
    console.log('Native UIA elements:', elements.length);
    assert(elements.some((e) => e.automationId === 'password-input' && e.secure));
    await perform('start-button', 'click');
    await perform('project-input', 'inputText', { text: 'LaunchFlow native acceptance' });
    await perform('environment-choice', 'selectOption', { option: 'Staging' });
    await perform('project-input', 'shortcut', { keys: ['Ctrl', 'Enter'] });
    const result = await callNative(
      request('find', { locator: { kind: 'accessibility', automationId: 'result-label' } }),
    );
    assert.equal(result.name, 'Result: LaunchFlow native acceptance / Staging');
    await perform(null, 'moveWindow', { x: 210, y: 130 });
    await perform(null, 'resizeWindow', { width: 900, height: 850 });
    await perform('start-button', 'click');
    await callNative(request('highlight', { locator: locator('start-button'), durationMs: 300 }));
    await mkdir('test-results/phase3', { recursive: true });
    const path = resolve('test-results/phase3/native-window.png');
    await callNative(request('capture', { path }));
    const ocr = await callNative(request('ocr', { path }));
    console.log('OCR words:', ocr.words.length);
    assert(ocr.words.some((w) => w.text.includes('LaunchFlow')));
    await writeFile('test-results/phase3/native-elements.json', JSON.stringify(elements, null, 2));
    console.log('PASS native semantic actions, move/resize, highlight, screenshot and OCR');
  } finally {
    harness.kill();
  }
}
