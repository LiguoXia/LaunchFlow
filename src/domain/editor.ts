import type { NodeDefinition, Run, Scene, WorkflowNode } from './types';
import { sequenceNodes } from './graph';

export function createNode(definition: NodeDefinition): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    type: definition.nodeType,
    name: definition.name,
    description: '',
    position: { x: 0, y: 0 },
    enabled: true,
    config: structuredClone(definition.defaults),
    retryPolicy: { maxRetries: 0, delayMs: 0 },
    timeoutMs: 60000,
    failurePolicy: 'stopWorkflow',
    platformConstraint: [],
    inputs: {},
    outputs: {},
    metadata: {},
  };
}
export function withSequence(scene: Scene, nodes: WorkflowNode[]): Scene {
  return {
    ...scene,
    workflow: {
      ...scene.workflow,
      nodes: nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 120 } })),
      edges: nodes.slice(1).map((n, i) => ({
        id: `${nodes[i].id}--${n.id}`,
        from: nodes[i].id,
        to: n.id,
        outlet: 'success',
      })),
    },
  };
}
export function moveNode(scene: Scene, id: string, index: number): Scene {
  const nodes = [...sequenceNodes(scene)];
  const previous = nodes.findIndex((n) => n.id === id);
  if (previous < 0 || index < 0 || index >= nodes.length) return scene;
  const [node] = nodes.splice(previous, 1);
  nodes.splice(index, 0, node);
  return withSequence(scene, nodes);
}
export function duplicateNode(scene: Scene, id: string): Scene {
  const nodes = [...sequenceNodes(scene)];
  const index = nodes.findIndex((n) => n.id === id);
  if (index < 0) return scene;
  nodes.splice(index + 1, 0, {
    ...structuredClone(nodes[index]),
    id: crypto.randomUUID(),
    name: `${nodes[index].name} 副本`,
  });
  return withSequence(scene, nodes);
}
export function removeNode(scene: Scene, id: string): Scene {
  return withSequence(
    scene,
    sequenceNodes(scene).filter((n) => n.id !== id),
  );
}
export function validateNode(node: WorkflowNode, definition?: NodeDefinition): string[] {
  if (!definition) return ['未知节点类型'];
  const errors: string[] = [];
  if (!node.name.trim()) errors.push('请输入节点名称');
  if (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1 || node.timeoutMs > 86400000)
    errors.push('超时需为 1–86400000 毫秒');
  for (const f of definition.fields) {
    const value = node.config[f.key];
    if (typeof value === 'string' && value.includes('${')) continue;
    if (f.required && (value === undefined || value === null || value === ''))
      errors.push(`请填写${f.label}`);
    if (f.kind === 'number' && value !== undefined && value !== null && !Number.isInteger(value))
      errors.push(`${f.label}需为非负整数`);
    if (f.key === 'port' && (Number(value) < 1 || Number(value) > 65535))
      errors.push('端口范围为 1–65535');
    if (f.kind === 'url' && value) {
      try {
        const url = new URL(String(value));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          errors.push('URL 需为不含凭据的 HTTP(S) 地址');
      } catch {
        errors.push('请输入有效 URL');
      }
    }
  }
  return errors;
}
export function mergeRun(runs: Run[], run: Run): Run[] {
  const current = runs.find((r) => r.id === run.id);
  if (current && current.revision >= run.revision) return runs;
  return [run, ...runs.filter((r) => r.id !== run.id)]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 300);
}
export function mergeRuns(previous: Run[], incoming: Run[]): Run[] {
  // Bootstrap is authoritative for deletions, but never overwrites a newer event revision.
  return incoming.map((run) => {
    const existing = previous.find((r) => r.id === run.id);
    return existing && existing.revision > run.revision ? existing : run;
  });
}
export function formatDuration(ms: number): string {
  return ms < 1000
    ? `${ms} ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}
export function dateLabel(value?: string | null): string {
  return value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚未运行';
}
