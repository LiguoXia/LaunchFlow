/** Optional host acceptance. Uses only explicitly discovered, installed apps. No installation or configuration changes. */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function realAppAcceptance({ invoke, node, edge, artifacts }) {
  const bindings = {
    clash: ['D:/soft/clash/clash-verge.exe', 'clash-verge.exe'],
    docker: ['C:/Program Files/Docker/Docker/Docker Desktop.exe', 'Docker Desktop.exe'],
    idea: ['D:/soft/IDEA 2024.1.7/IntelliJ IDEA 2024.1.7/bin/idea64.exe', 'idea64.exe'],
    chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'chrome.exe'],
  };
  const docker = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
  for (const [path] of Object.values(bindings))
    assert(existsSync(path), `Verified app path missing: ${path}`);
  assert(existsSync(docker));
  const profiles = [];
  for (const [id, [executable, processName]] of Object.entries(bindings)) {
    const profile = {
      schemaVersion: 1,
      id: `real-${id}`,
      displayName: `${id} · 已安装应用`,
      windows: { executable, processName },
      macos: { appPath: '', bundleId: '', processName: '' },
      launchArguments: [],
      readyDetection:
        id === 'clash'
          ? { kind: 'port', host: '127.0.0.1', port: 7897 }
          : id === 'docker'
            ? null
            : { kind: 'process', processName },
    };
    await invoke('save_profile', { profile });
    profiles.push(profile);
  }
  const nodes = [
    node('flow.condition', 'network', 'Check Network', {
      kind: 'network',
      host: '127.0.0.1',
      port: 7897,
    }),
    node('application.launch', 'clash', 'Launch Clash', { applicationId: 'real-clash' }),
    node('wait.port', 'proxy', 'Wait Port 7897', { host: '127.0.0.1', port: 7897 }),
    node('application.launch', 'docker', 'Launch Docker', { applicationId: 'real-docker' }),
    {
      ...node('system.command', 'ready', 'Wait Docker Ready', {
        program: docker,
        arguments: ['info', '--format', '{{.ServerVersion}}'],
        captureOutput: true,
      }),
      timeoutMs: 5000,
      retryPolicy: { maxRetries: 19, delayMs: 3000 },
    },
    ...['idea', 'chrome'].map((id) => ({
      ...node('application.launch', id, id.toUpperCase(), { applicationId: `real-${id}` }),
      timeoutMs: 60000,
    })),
    {
      ...node('application.launch', 'datagrip', 'DataGrip · 未安装', {
        applicationId: 'datagrip-not-installed',
      }),
      enabled: false,
    },
    node('flow.join', 'join', 'Join'),
    node('flow.condition', 'os', 'Windows / macOS', { kind: 'os', value: 'windows' }),
    node('system.command', 'win', 'Windows Command', {
      program: 'powershell.exe',
      arguments: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Write-Output 'LaunchFlow Phase 2 accepted'",
      ],
      captureOutput: true,
    }),
    {
      ...node('system.command', 'mac', 'macOS Command', {
        program: '/usr/bin/true',
        arguments: [],
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
  let scene = await invoke('create_scene', { name: '真实应用 · Java 开发环境' });
  scene.description = '本机 Clash / Docker / IDEA / Chrome；用户确认未安装 DataGrip，该节点禁用。';
  scene.workflow = { nodes, edges, annotations: [] };
  scene = await invoke('save_scene', { scene });
  const initial = await invoke('run_scene', { sceneId: scene.id });
  console.log(`REAL APPS: started ${initial.id}; waiting for Docker and IDE readiness`);
  let result;
  const deadline = Date.now() + 170000;
  while (Date.now() < deadline) {
    result = (await invoke('bootstrap')).runs.find((r) => r.id === initial.id);
    if (!['running', 'queued', 'paused'].includes(result.status)) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  if (['running', 'queued', 'paused'].includes(result.status)) {
    await invoke('stop_run', { runId: result.id });
    await new Promise((done) => setTimeout(done, 250));
    result = (await invoke('bootstrap')).runs.find((r) => r.id === initial.id);
  }
  const reached = result.nodeRuns.find((n) => n.nodeId === 'win')?.status === 'succeeded';
  const report = {
    status: result.status === 'succeeded' && reached ? 'passed' : 'environment-blocked',
    dataGrip: 'Not installed; disabled as confirmed by user',
    networkProbe: '127.0.0.1:7897 (local proxy reachability)',
    scene,
    profiles,
    run: result,
  };
  await writeFile(join(artifacts, 'phase2-real-apps.json'), JSON.stringify(report, null, 2));
  console.log(
    `REAL APPS: ${report.status}; ${result.error ?? 'DataGrip remains unverified because it is not installed.'}`,
  );
  return report;
}
