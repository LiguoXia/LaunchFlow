/** Phase 2 acceptance uses real Tauri IPC, native child apps, TCP sockets and UI events. */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { createServer } from 'node:net';
import { copyFile, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function phase2({ invoke, page, target, dataDir, artifacts, check }) {
  const fixture = resolve(target, 'debug/launchflow-fixture.exe');
  const definitions = (await invoke('bootstrap')).definitions;
  const node = (type, id, name, config = {}) => ({
    id,
    type,
    name,
    description: '',
    position: { x: 0, y: 0 },
    enabled: true,
    config: {
      ...structuredClone(definitions.find((d) => d.nodeType === type).defaults),
      ...config,
    },
    retryPolicy: { maxRetries: 0, delayMs: 100 },
    timeoutMs: 10000,
    failurePolicy: 'stopWorkflow',
    platformConstraint: [],
    inputs: {},
    outputs: {},
    metadata: {},
  });
  const edge = (from, to, outlet = 'success') => ({ id: crypto.randomUUID(), from, to, outlet });
  const create = async (name, nodes, edges = []) => {
    let scene = await invoke('create_scene', { name });
    scene.workflow = { nodes, edges, annotations: [] };
    return invoke('save_scene', { scene });
  };
  const finish = async (id) => {
    await expect
      .poll(
        async () =>
          ['succeeded', 'failed', 'cancelled'].includes(
            (await invoke('bootstrap')).runs.find((r) => r.id === id)?.status,
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    return (await invoke('bootstrap')).runs.find((r) => r.id === id);
  };
  const freePort = async (preferred = 0) => {
    const s = createServer((socket) => socket.destroy());
    await new Promise((done, reject) => {
      s.once('error', reject);
      s.listen(preferred, '127.0.0.1', done);
    });
    const port = s.address().port;
    await new Promise((done) => s.close(done));
    return port;
  };
  const probe = createServer((socket) => socket.destroy());
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  let acceptance;
  try {
    await check(
      'Phase 2 native fixture DAG: network, proxy port, Docker readiness, parallel apps, Join and OS command',
      async () => {
        const proxyPort = await freePort(7897).catch(() => freePort());
        const dockerPort = await freePort();
        const profiles = [];
        const ports = {
          clash: proxyPort,
          docker: dockerPort,
          idea: await freePort(),
          datagrip: await freePort(),
          chrome: await freePort(),
        };
        for (const id of ['clash', 'docker', 'idea', 'datagrip', 'chrome']) {
          const binary = join(dataDir, `${id}-fixture.exe`);
          await copyFile(fixture, binary);
          const profile = {
            schemaVersion: 1,
            id: `fixture-${id}`,
            displayName: `${id} · 本机验收程序`,
            windows: { executable: binary, processName: `${id}-fixture.exe` },
            macos: { appPath: '', bundleId: '', processName: '' },
            launchArguments: [
              'serve-fixed',
              String(ports[id]),
              join(dataDir, `${id}.pid`),
              '30000',
              id === 'docker' ? '1700' : '220',
            ],
            readyDetection:
              id === 'docker' ? null : { kind: 'port', host: '127.0.0.1', port: ports[id] },
          };
          await invoke('save_profile', { profile });
          profiles.push(profile);
        }
        const nodes = [
          node('flow.condition', 'network', 'Check Network', {
            kind: 'network',
            host: '127.0.0.1',
            port: probe.address().port,
          }),
          node('application.launch', 'clash', 'Launch Clash', { applicationId: 'fixture-clash' }),
          node('wait.port', 'proxy', 'Wait Port 7897', { host: '127.0.0.1', port: '${proxyPort}' }),
          node('application.launch', 'docker', 'Launch Docker', {
            applicationId: 'fixture-docker',
          }),
          {
            ...node('wait.port', 'ready', 'Wait Docker Ready', {
              host: '127.0.0.1',
              port: dockerPort,
            }),
            timeoutMs: 900,
            retryPolicy: { maxRetries: 3, delayMs: 100 },
          },
          ...['idea', 'datagrip', 'chrome'].map((id) =>
            node('application.launch', id, id.toUpperCase(), { applicationId: `fixture-${id}` }),
          ),
          node('flow.join', 'join', 'Join'),
          node('flow.condition', 'os', 'Windows / macOS', { kind: 'os', value: 'windows' }),
          node('system.command', 'win', 'Windows Command', {
            program: fixture,
            arguments: ['echo', 'Phase 2 accepted', '${run.id}'],
            captureOutput: true,
          }),
          {
            ...node('system.command', 'mac', 'macOS Command', {
              program: '/bin/echo',
              arguments: ['Phase 2 accepted'],
              captureOutput: true,
            }),
            platformConstraint: ['macos'],
          },
        ];
        const edges = [
          edge('network', 'clash', 'true'),
          edge('clash', 'proxy'),
          edge('proxy', 'docker'),
          edge('docker', 'ready'),
          ...['idea', 'datagrip', 'chrome'].flatMap((id) => [edge('ready', id), edge(id, 'join')]),
          edge('join', 'os'),
          edge('os', 'win', 'true'),
          edge('os', 'mac', 'false'),
        ];
        nodes.forEach((n, i) => {
          n.position = { x: Math.floor(i / 3) * 300, y: (i % 3) * 155 };
        });
        let scene = await invoke('create_scene', { name: 'Phase 2 · 开发环境 DAG 验收' });
        scene.description = '真实进程与 TCP 验收；五个第三方应用使用独立命名的本机测试程序。';
        scene.workflow = { nodes: [...nodes].reverse(), edges, annotations: [] };
        scene.parameters = [
          {
            name: 'proxyPort',
            kind: 'number',
            description: 'Clash 本机监听端口',
            required: true,
            defaultValue: proxyPort,
            options: [],
            validation: { min: 1, max: 65535 },
          },
        ];
        acceptance = await invoke('save_scene', { scene });
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: /^我的场景/ }).click();
        const card = page.locator('.scene-card').filter({ hasText: acceptance.name });
        await card.getByRole('button', { name: /编辑/ }).click();
        await expect(page.locator('.react-flow')).toBeVisible();
        await page.getByRole('button', { name: '自动布局', exact: true }).click();
        await page.screenshot({ path: join(artifacts, 'phase2-canvas.png') });
        await page.getByRole('button', { name: '保存并运行', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText('运行配置');
        await page.getByRole('button', { name: '开始运行', exact: true }).click();
        await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
        const running = (await invoke('bootstrap')).runs.find((r) => r.sceneId === acceptance.id);
        const ignored = await invoke('run_scene', {
          sceneId: acceptance.id,
          parameters: { proxyPort },
        });
        assert.equal(running.id, ignored.id);
        await expect(page.getByText('工作环境已就绪', { exact: true })).toBeVisible({
          timeout: 20000,
        });
        const result = await finish(running.id);
        assert.equal(result.status, 'succeeded', result.error);
        assert.equal(result.nodeRuns.find((n) => n.nodeId === 'mac').status, 'skipped');
        assert(result.nodeRuns.find((n) => n.nodeId === 'ready').retryCount >= 1);
        const parallel = result.nodeRuns.filter((n) =>
          ['idea', 'datagrip', 'chrome'].includes(n.nodeId),
        );
        assert(
          parallel.every((a) => parallel.every((b) => a.startedAt < b.endedAt)),
          'native launches overlap',
        );
        const joined = result.nodeRuns.find((n) => n.nodeId === 'join');
        assert(parallel.every((n) => joined.startedAt >= n.endedAt));
        for (const id of ['clash', 'docker', 'idea', 'datagrip', 'chrome'])
          assert(Number(await readFile(join(dataDir, `${id}.pid`), 'utf8')) > 0);
        acceptance = (await invoke('bootstrap')).scenes.find((s) => s.id === acceptance.id);
        await writeFile(
          join(artifacts, 'phase2-acceptance-scene.json'),
          JSON.stringify(
            { scene: acceptance, profiles, port7897Used: proxyPort === 7897 },
            null,
            2,
          ),
        );
        await writeFile(
          join(artifacts, 'phase2-acceptance-run.json'),
          JSON.stringify(result, null, 2),
        );
        await page.screenshot({ path: join(artifacts, 'phase2-run.png') });
      },
    );
    await check(
      'Advanced canvas copy, paste, group, disable, comment, undo and redo use the same model',
      async () => {
        await page.getByRole('button', { name: '工作流编辑器', exact: true }).click();
        await page.locator('.react-flow__node[data-id="idea"]').click();
        await page
          .locator('.react-flow__node[data-id="datagrip"]')
          .click({ modifiers: ['Control'] });
        await page.getByRole('button', { name: '复制选中节点', exact: true }).click();
        await page.getByRole('button', { name: '粘贴节点', exact: true }).click();
        await expect(page.locator('.react-flow__node-task')).toHaveCount(14);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await expect(page.locator('.react-flow__node-task')).toHaveCount(12);
        await page.getByRole('button', { name: '重做', exact: true }).click();
        await expect(page.locator('.react-flow__node-task')).toHaveCount(14);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await page.locator('.react-flow__node[data-id="idea"]').click();
        await page
          .locator('.react-flow__node[data-id="datagrip"]')
          .click({ modifiers: ['Control'] });
        await page.getByRole('button', { name: '创建分组', exact: true }).click();
        await expect(page.locator('.dag-annotation.group')).toHaveCount(1);
        await page.locator('.react-flow__node[data-id="idea"]').click();
        await page.getByRole('button', { name: '启用或禁用选中节点', exact: true }).click();
        await expect(page.locator('.react-flow__node[data-id="idea"] .dag-node')).toHaveClass(
          /disabled/,
        );
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await expect(page.locator('.react-flow__node[data-id="idea"] .dag-node')).not.toHaveClass(
          /disabled/,
        );
        await page.getByRole('button', { name: '添加注释', exact: true }).click();
        await page.getByLabel('内容', { exact: true }).fill('真实并行启动，Join 等待全部有效分支');
        await page.getByRole('button', { name: '保存注释', exact: true }).click();
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText('场景已保存', { exact: true })).toBeVisible();
        const saved = (await invoke('bootstrap')).scenes.find((s) => s.id === acceptance.id);
        assert.equal(saved.workflow.annotations.length, 2);
        assert.equal(saved.workflow.edges.length, 13);
      },
    );
    await check(
      'Pause and resume buttons stop new scheduling; cancellation updates history',
      async () => {
        const s = await create(
          'Phase 2 Pause',
          [
            node('system.delay', 'a', 'Current task', { durationMs: 1500 }),
            node('system.delay', 'b', 'Next task', { durationMs: 4000 }),
          ],
          [edge('a', 'b')],
        );
        const r = await invoke('run_scene', { sceneId: s.id });
        await page
          .getByRole('button', { name: /^运行历史/ })
          .first()
          .click();
        await page.getByRole('button', { name: /Phase 2 Pause/ }).click();
        await page.getByRole('button', { name: '暂停', exact: true }).click();
        await new Promise((done) => setTimeout(done, 1700));
        let current = (await invoke('bootstrap')).runs.find((x) => x.id === r.id);
        assert.equal(current.status, 'paused');
        assert.equal(current.nodeRuns[0].status, 'succeeded');
        assert.equal(current.nodeRuns[1].status, 'pending');
        await page.getByRole('button', { name: '恢复', exact: true }).click();
        await expect
          .poll(
            async () =>
              (await invoke('bootstrap')).runs.find((x) => x.id === r.id)?.nodeRuns[1].status,
          )
          .toBe('waiting');
        await page.getByRole('button', { name: '停止运行', exact: true }).click();
        assert.equal((await finish(r.id)).status, 'cancelled');
      },
    );
    await check('Real IPC Queue and Restart policies preserve serial scene execution', async () => {
      for (const policy of ['queue', 'restart']) {
        let s = await create(`Phase 2 ${policy}`, [
          node('system.delay', 'a', 'Wait', { durationMs: 450 }),
        ]);
        s.concurrentRunPolicy = policy;
        s = await invoke('save_scene', { scene: s });
        const first = await invoke('run_scene', { sceneId: s.id });
        const second = await invoke('run_scene', { sceneId: s.id });
        assert.notEqual(first.id, second.id);
        assert.equal(second.status, 'queued');
        const a = await finish(first.id),
          b = await finish(second.id);
        assert.equal(a.status, policy === 'restart' ? 'cancelled' : 'succeeded');
        assert.equal(b.status, 'succeeded');
      }
    });
    await check('Failure recovery preserves side effects through the recovery UI', async () => {
      const marker = join(dataDir, 'recovery-count');
      const s = await create(
        'Phase 2 Recovery',
        [
          node('system.command', 'a', 'Once', { program: fixture, arguments: ['append', marker] }),
          node('system.command', 'b', 'Fail once', {
            program: fixture,
            arguments: ['fail-once', join(dataDir, 'failure-marker')],
          }),
          node('system.delay', 'c', 'Continue', { durationMs: 0 }),
        ],
        [edge('a', 'b'), edge('b', 'c')],
      );
      const first = await finish((await invoke('run_scene', { sceneId: s.id })).id);
      assert.equal(first.status, 'failed');
      await page
        .getByRole('button', { name: /^运行历史/ })
        .first()
        .click();
      await page.getByRole('button', { name: /Phase 2 Recovery/ }).click();
      await page.getByRole('button', { name: '从失败处继续', exact: true }).click();
      await expect(page.getByRole('heading',{name:'确认恢复中的敏感操作',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'确认',exact:true}).click();
      await expect(page.getByText('工作环境已就绪', { exact: true })).toBeVisible();
      const next = (await invoke('bootstrap')).runs.find((r) => r.resumedFrom === first.id);
      assert.equal(next.status, 'succeeded');
      assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
    });
    await check(
      'Missing required parameters are collected by Run Configuration before execution',
      async () => {
        let s = await invoke('create_scene', { name: 'Phase 2 Required' });
        s.workflow.nodes = [
          node('system.command', 'echo', 'Parameter echo', {
            program: fixture,
            arguments: ['echo', '${project}'],
            captureOutput: true,
          }),
        ];
        s.parameters = [
          {
            name: 'project',
            kind: 'string',
            description: '必填项目名',
            required: true,
            defaultValue: null,
            options: [],
            validation: {},
          },
        ];
        s = await invoke('save_scene', { scene: s });
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: /^我的场景/ }).click();
        await page
          .locator('.scene-card')
          .filter({ hasText: 'Phase 2 Required' })
          .filter({ hasText: '1 个任务' })
          .getByRole('button', { name: '运行', exact: true })
          .click();
        await expect(page.getByRole('dialog')).toContainText('运行配置');
        await page.getByRole('dialog').getByRole('textbox').fill('literal & $(no-eval)');
        await page.getByRole('button', { name: '开始运行', exact: true }).click();
        await expect(page.getByText('工作环境已就绪', { exact: true })).toBeVisible();
        const r = (await invoke('bootstrap')).runs.find((r) => r.sceneId === s.id);
        assert.equal(r.nodeRuns[0].stdout, 'literal & $(no-eval)');
      },
    );
    await check('OS global shortcut registers and actually triggers a workflow', async () => {
      let s = await create('Phase 2 Hotkey', [
        node('system.delay', 'a', 'Hotkey', { durationMs: 10 }),
      ]);
      s.triggers = [
        {
          id: 'hotkey',
          kind: 'globalHotkey',
          enabled: true,
          config: { shortcut: 'Ctrl+Alt+Shift+F11' },
          parameters: {},
        },
      ];
      s = await invoke('save_scene', { scene: s });
      await expect
        .poll(
          async () =>
            (await invoke('bootstrap')).triggerStatuses.find(
              (t) => t.sceneId === s.id && t.triggerId === 'hotkey',
            )?.kind,
        )
        .toBe('ready');
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$keys = New-Object -ComObject WScript.Shell; $keys.SendKeys('^%+{F11}')",
        ],
        { windowsHide: true },
      );
      await expect
        .poll(
          async () =>
            (await invoke('bootstrap')).runs.filter(
              (r) => r.sceneId === s.id && r.source === 'globalHotkey' && r.status === 'succeeded',
            ).length,
        )
        .toBe(1);
      s.triggers = [];
      await invoke('save_scene', { scene: s });
    });
    if (process.env.LAUNCHFLOW_REAL_APPS === '1') {
      const { realAppAcceptance } = await import('./real-app-acceptance.mjs');
      await realAppAcceptance({ invoke, node, edge, artifacts });
    }
  } catch (error) {
    await page.screenshot({ path: join(artifacts, 'phase2-failure.png') }).catch(() => {});
    await writeFile(
      join(artifacts, 'phase2-failure.txt'),
      `${String(error)}\n${await page
        .locator('body')
        .innerText()
        .catch(() => '(unavailable)')}`,
    );
    throw error;
  } finally {
    probe.closeAllConnections?.();
    await new Promise((done) => probe.close(done));
  }
}
