/** Owned Chromium fixture only; never opens or types into a user's Codex chat. */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { callNative, worker } from './test-native.mjs';

const output = resolve('test-results/recorded-restart');
await mkdir(output, { recursive: true });
const focusFixture = resolve(output, 'ForegroundFixture.exe');
execFileSync(
  resolve(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    `/out:${focusFixture}`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve('native/windows/Common.cs'),
    resolve('native/windows/tests/ForegroundFixture.cs'),
  ],
  { windowsHide: true },
);
const title = `LaunchFlow Restart Fixture ${process.pid}`;
const checks = [];
let browser, page, recorder, scope;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error('Restart fixture timeout');
}
async function open(id) {
  browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: ['--force-renderer-accessibility', '--window-size=900,700'],
  });
  page = await browser.newPage();
  await page.setContent(`<title>${title}</title>
    <main role="group" id="${id}" class="editor-surface">
      <div role="textbox" contenteditable="true" class="ProseMirror"
        style="margin:50px;min-height:160px;border:1px solid;padding:20px"
        onfocus="this.classList.add('ProseMirror-focused')"
        onblur="this.classList.remove('ProseMirror-focused')"></div>
    </main><button id="outside">Outside the editor</button>`);
  await until(async () => {
    const windows = await callNative({ op: 'windows' });
    const found = windows.find((w) => w.title.includes(title));
    if (!found) return false;
    scope = { application: found.application, title: found.title, className: found.className };
    execFileSync(focusFixture, [String(found.pid), String(found.handle)], { windowsHide: true });
    return true;
  });
}
const find = (locator) => callNative({ op: 'find', window: scope, locator });
async function replay(locator, text) {
  // Match Rust's resolve + transient runtime ID revalidation, in separate worker processes.
  const target = await find(locator);
  await callNative({
    op: 'perform',
    window: scope,
    locator: { ...locator, runtimeId: target.runtimeId },
    action: { kind: 'inputText', text },
  });
  assert.equal(await page.locator('[contenteditable]').first().innerText(), text);
  return target;
}
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log('PASS ' + name);
}
function oldLocator(info) {
  const attrs = ({ role, name, automationId, className, frameworkId, secure }) => ({
    role,
    name: '',
    automationId,
    className,
    frameworkId,
    secure,
  });
  return {
    kind: 'accessibility',
    window: scope,
    ...attrs(info),
    ancestorPath: info.ancestorPath.map(attrs),
  };
}
const events = [];
let failure;
try {
  await open('_r_g9_');
  await page.locator('[contenteditable]').focus();
  const original = await find({
    kind: 'accessibility',
    role: 'Edit',
    className: 'ProseMirror ProseMirror-focused',
  });
  const legacy = oldLocator(original);
  assert(legacy.ancestorPath.some((a) => a.automationId === '_r_g9_'));
  assert.equal(original.frameworkId, 'Chrome');
  await writeFile(resolve(output, 'legacy-locator.json'), JSON.stringify(legacy, null, 2));
  await check('Original recorded locator works during the initial session', () =>
    replay(legacy, '首次输入中文'),
  );

  recorder = spawn(worker, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  recorder.stdout.on('data', (b) => {
    buffer += b;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  recorder.stdin.write(JSON.stringify({ op: 'record', window: scope }) + '\n');
  await until(() => events.some((e) => e.state === 'recording'));
  await replay(legacy, '保存后重启仍可输入中文');
  await until(() => events.some((e) => e.actions?.some((a) => a.kind === 'inputText')));
  recorder.stdin.write(JSON.stringify({ op: 'stop' }) + '\n');
  await until(() => events.some((e) => e.event === 'stopped'));
  const action = events
    .findLast((e) => e.event === 'stopped')
    .actions.findLast((a) => a.kind === 'inputText');
  await writeFile(resolve(output, 'saved-action.json'), JSON.stringify(action, null, 2));
  await browser.close();
  browser = null;
  await open('_r_z81_');
  const savedLegacy = JSON.parse(await readFile(resolve(output, 'legacy-locator.json'), 'utf8'));
  const saved = JSON.parse(await readFile(resolve(output, 'saved-action.json'), 'utf8'));
  await check(
    'Legacy scene survives browser restart, changed React ID and unfocused editor',
    async () => {
      await page.locator('#outside').focus();
      const target = await replay(savedLegacy, '旧场景重启回放成功');
      assert.notDeepEqual(target.runtimeId, original.runtimeId);
    },
  );
  await check('New recording stores stable Chromium attributes', async () => {
    assert(!JSON.stringify(saved.locators).includes('_r_g9_'));
    assert(!saved.locators[0].className.includes('ProseMirror-focused'));
    assert(saved.locators[0].className.includes('ProseMirror'));
  });
  await check('Persisted new recording replays after a second browser restart', async () => {
    await browser.close();
    browser = null;
    await open('_r_b2_');
    await replay(saved.locators[0], saved.text.trim());
  });
  await check('Stable ancestor IDs remain mandatory', async () => {
    await page.locator('main').evaluate((e) => (e.id = 'different-stable-id'));
    const strict = structuredClone(savedLegacy);
    strict.ancestorPath.find((a) => a.automationId === '_r_g9_').automationId =
      'required-stable-id';
    await assert.rejects(find(strict), (e) => e.detail?.code === 'notFound');
  });
  await check('Two indistinguishable editors are rejected without typing', async () => {
    await page.locator('[contenteditable]').evaluate((e) => e.after(e.cloneNode(true)));
    const before = await page.locator('[contenteditable]').allInnerTexts();
    await assert.rejects(
      replay(savedLegacy, 'MUST_NOT_TYPE'),
      (e) => e.detail?.code === 'ambiguous',
    );
    assert.deepEqual(await page.locator('[contenteditable]').allInnerTexts(), before);
  });
} catch (e) {
  failure = String(e);
  throw e;
} finally {
  recorder?.kill();
  await browser?.close();
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        checks,
        failure,
        scope:
          'Owned Microsoft Edge Chromium contenteditable fixture, real Windows UIA and keyboard input; no user chats touched.',
      },
      null,
      2,
    ),
  );
}
