import { describe, expect, it } from 'vitest';
import {
  createNode,
  duplicateNode,
  mergeRun,
  moveNode,
  removeNode,
  validateNode,
  withSequence,
} from './editor';
import type { NodeDefinition, Run, Scene } from './types';
const delay: NodeDefinition = {
  nodeType: 'system.delay',
  name: 'Delay',
  description: '',
  category: 'system',
  fields: [
    { key: 'durationMs', label: '时长', kind: 'number', required: true, options: [], hint: '' },
  ],
  defaults: { durationMs: 1000 },
  waiting: true,
};
function scene(): Scene {
  return {
    schemaVersion: 1,
    id: 'scene',
    name: 'Test',
    description: '',
    version: 1,
    isDefault: false,
    allowCommandsAtStartup: false,
    icon: 'code',
    color: 'green',
    createdAt: '',
    updatedAt: '',
    workflow: { nodes: [], edges: [] },
  };
}
describe('sequence editor', () => {
  it('keeps dependency edges in sync when reordered, duplicated and deleted', () => {
    const a = createNode(delay),
      b = createNode(delay),
      c = createNode(delay);
    const initial = withSequence(scene(), [a, b, c]);
    const moved = moveNode(initial, c.id, 0);
    expect(moved.workflow.edges.map((e) => [e.from, e.to])).toEqual([
      [c.id, a.id],
      [a.id, b.id],
    ]);
    const copy = duplicateNode(moved, a.id);
    expect(copy.workflow.nodes).toHaveLength(4);
    expect(new Set(copy.workflow.nodes.map((n) => n.id)).size).toBe(4);
    const removed = removeNode(copy, a.id);
    expect(removed.workflow.edges.every((e) => e.from !== a.id && e.to !== a.id)).toBe(true);
    expect(removed.workflow.edges).toHaveLength(2);
    expect(initial.workflow.nodes.map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });
  it('does not mutate shared config defaults', () => {
    const a = createNode(delay),
      b = createNode(delay);
    a.config.durationMs = 20;
    expect(b.config.durationMs).toBe(1000);
  });
  it('rejects unsafe URL schemes and invalid timeout/ports', () => {
    const n = createNode(delay);
    n.timeoutMs = 0;
    expect(validateNode(n, delay)).toContain('超时需为 1–86400000 毫秒');
    const def = {
      ...delay,
      fields: [{ key: 'target', label: 'URL', kind: 'url', required: true, options: [], hint: '' }],
    };
    n.config = { target: 'file:///c:/windows' };
    expect(validateNode(n, def).some((e) => e.includes('HTTP'))).toBe(true);
    const port = {
      ...delay,
      fields: [
        { key: 'port', label: '端口', kind: 'number', required: true, options: [], hint: '' },
      ],
    };
    n.config = { port: 65536 };
    expect(validateNode(n, port)).toContain('端口范围为 1–65535');
  });
});
describe('event snapshots', () => {
  const run = (revision: number): Run => ({
    id: 'r',
    sceneId: 'scene',
    sceneName: 'Test',
    sceneVersion: 1,
    sceneSnapshot: scene(),
    status: 'running',
    source: 'manual',
    startedAt: '2026-09-30T00:00:00Z',
    endedAt: null,
    durationMs: 0,
    revision,
    nodeRuns: [],
    error: null,
  });
  it('ignores stale and duplicate events', () => {
    const current = [run(5)];
    expect(mergeRun(current, run(4))).toBe(current);
    expect(mergeRun(current, run(5))).toBe(current);
    expect(mergeRun(current, run(6))[0].revision).toBe(6);
  });
});
