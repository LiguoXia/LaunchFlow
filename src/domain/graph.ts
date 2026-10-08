import type { Scene, WorkflowNode, Edge, CanvasAnnotation } from './types';
export function isSequence(scene: Scene) {
  const { nodes, edges } = scene.workflow;
  if (!nodes.length) return !edges.length;
  if (
    nodes.some((n) => n.type === 'flow.condition') ||
    edges.length !== nodes.length - 1 ||
    edges.some((e) => (e.outlet ?? 'success') !== 'success') ||
    nodes.some(
      (n) =>
        edges.filter((e) => e.from === n.id).length > 1 ||
        edges.filter((e) => e.to === n.id).length > 1,
    )
  )
    return false;
  const ordered = chainNodes(scene);
  return ordered.length === nodes.length;
}
function chainNodes(scene: Scene): WorkflowNode[] {
  const { nodes, edges } = scene.workflow;
  const roots = nodes.filter((n) => !edges.some((e) => e.to === n.id));
  if (roots.length !== 1) return [];
  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  let current: WorkflowNode | undefined = roots[0];
  while (current && !seen.has(current.id)) {
    ordered.push(current);
    seen.add(current.id);
    const next = edges.find((e) => e.from === current!.id)?.to;
    current = nodes.find((n) => n.id === next);
  }
  return ordered;
}
export function sequenceNodes(scene: Scene): WorkflowNode[] {
  return isSequence(scene) ? chainNodes(scene) : scene.workflow.nodes;
}
export function autoLayout(scene: Scene): Scene {
  const { nodes, edges } = scene.workflow;
  const levels = new Map<string, number>();
  const pending = new Set(nodes.map((n) => n.id));
  for (let pass = 0; pass < nodes.length; pass++)
    for (const id of pending) {
      const parents = edges.filter((e) => e.to === id).map((e) => e.from);
      if (parents.every((p) => levels.has(p))) {
        levels.set(id, parents.length ? Math.max(...parents.map((p) => levels.get(p)!)) + 1 : 0);
        pending.delete(id);
      }
    }
  const rows = new Map<number, number>();
  const laid = nodes.map((n) => {
    const level = levels.get(n.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { ...n, position: { x: level * 300 + 40, y: row * 155 + 70 } };
  });
  return {
    ...scene,
    workflow: {
      ...scene.workflow,
      nodes: laid,
      annotations: (scene.workflow.annotations ?? []).map((a) => {
        const members = laid.filter((n) => a.nodeIds.includes(n.id));
        if (a.kind !== 'group' || !members.length) return a;
        const x = Math.min(...members.map((n) => n.position.x)) - 24,
          y = Math.min(...members.map((n) => n.position.y)) - 45;
        return {
          ...a,
          position: { x, y },
          width: Math.max(...members.map((n) => n.position.x)) + 254 - x,
          height: Math.max(...members.map((n) => n.position.y)) + 134 - y,
        };
      }),
    },
  };
}
export interface GraphClipboard {
  nodes: WorkflowNode[];
  edges: Edge[];
  annotations: CanvasAnnotation[];
}
export function copySelection(scene: Scene, ids: Set<string>): GraphClipboard {
  return structuredClone({
    nodes: scene.workflow.nodes.filter((n) => ids.has(n.id)),
    edges: scene.workflow.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    annotations: (scene.workflow.annotations ?? []).filter((a) => ids.has(a.id)),
  });
}
export function pasteSelection(
  scene: Scene,
  clipboard: GraphClipboard,
): { scene: Scene; ids: string[] } {
  const mapping = new Map(
    [...clipboard.nodes, ...clipboard.annotations].map((n) => [n.id, crypto.randomUUID()]),
  );
  const remap = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(/\$\{node\.([^}]+?)\.output(?=[.}])/g, (reference, id: string) =>
          mapping.has(id) ? '${node.' + mapping.get(id) + '.output' : reference,
        )
      : Array.isArray(value)
        ? value.map(remap)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
          : value;
  const nodes = clipboard.nodes.map((n) => ({
    ...structuredClone(n),
    id: mapping.get(n.id)!,
    name: `${n.name} 副本`,
    config: remap(n.config) as WorkflowNode['config'],
    position: { x: n.position.x + 45, y: n.position.y + 45 },
  }));
  const edges = clipboard.edges.map((e) => ({
    ...e,
    id: crypto.randomUUID(),
    from: mapping.get(e.from)!,
    to: mapping.get(e.to)!,
  }));
  const annotations = clipboard.annotations.map((a) => ({
    ...a,
    id: mapping.get(a.id)!,
    position: { x: a.position.x + 45, y: a.position.y + 45 },
    nodeIds: a.nodeIds.flatMap((id) => (mapping.has(id) ? [mapping.get(id)!] : [])),
  }));
  return {
    scene: {
      ...scene,
      workflow: {
        nodes: [...scene.workflow.nodes, ...nodes],
        edges: [...scene.workflow.edges, ...edges],
        annotations: [...(scene.workflow.annotations ?? []), ...annotations],
      },
    },
    ids: [...mapping.values()],
  };
}
export function removeSelection(scene: Scene, ids: Set<string>): Scene {
  return {
    ...scene,
    workflow: {
      nodes: scene.workflow.nodes.filter((n) => !ids.has(n.id)),
      edges: scene.workflow.edges.filter(
        (e) => !ids.has(e.id) && !ids.has(e.from) && !ids.has(e.to),
      ),
      annotations: (scene.workflow.annotations ?? [])
        .filter((a) => !ids.has(a.id))
        .map((a) => ({ ...a, nodeIds: a.nodeIds.filter((id) => !ids.has(id)) })),
    },
  };
}
