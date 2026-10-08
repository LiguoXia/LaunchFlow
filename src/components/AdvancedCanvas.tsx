import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type ReactFlowInstance,
  type Node as CanvasNode,
  type Edge as CanvasEdge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Copy,
  ClipboardPaste,
  Trash2,
  Undo2,
  Redo2,
  LayoutGrid,
  Group,
  MessageSquare,
  Settings2,
  Power,
} from 'lucide-react';
import type { CanvasAnnotation, Scene, WorkflowNode } from '../domain/types';
import {
  autoLayout,
  copySelection,
  pasteSelection,
  removeSelection,
  type GraphClipboard,
} from '../domain/graph';
import { Modal } from './ui';
import WorkflowNodeIcon from './WorkflowNodeIcon';
type TaskData = { node: WorkflowNode };
function TaskNode({ data }: { data: TaskData }) {
  const n = data.node;
  const outlets = n.type === 'flow.condition' ? ['true', 'false'] : ['success'];
  if (n.failurePolicy === 'failureBranch') outlets.push('failure');
  return (
    <div className={`dag-node ${n.enabled ? '' : 'disabled'}`}>
      <Handle type="target" position={Position.Left} />
      <div className="dag-node-title">
        <WorkflowNodeIcon node={n} />
        <strong>{n.name}</strong>
      </div>
      <small>
        {n.type} · {n.enabled ? `${n.timeoutMs / 1000}s` : '已禁用'}
      </small>
      {outlets.map((p, i) => (
        <div
          className="dag-outlet"
          key={p}
          style={{ top: `${((i + 1) * 100) / (outlets.length + 1)}%` }}
        >
          <span>{p === 'success' ? '' : p}</span>
          <Handle type="source" position={Position.Right} id={p} style={{ top: 0 }} />
        </div>
      ))}
    </div>
  );
}
function AnnotationNode({ data }: NodeProps<CanvasNode<{ annotation: CanvasAnnotation }>>) {
  return (
    <div className={`dag-annotation ${data.annotation.kind}`}>
      <strong>{data.annotation.text}</strong>
      <small>{data.annotation.kind === 'group' ? '分组 · 拖动一起移动' : '注释 · 双击编辑'}</small>
    </div>
  );
}
const nodeTypes = { task: TaskNode, annotation: AnnotationNode };
export default function AdvancedCanvas({
  scene,
  onChange,
  onSelect,
  selected,
  onSettings,
  undo,
  redo,
  canUndo,
  canRedo,
  disabled,
}: {
  scene: Scene;
  onChange: (scene: Scene) => void;
  onSelect: (id: string) => void;
  selected: string | null;
  onSettings: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
}) {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [ids, setIds] = useState<Set<string>>(new Set());
  const clipboard = useRef<GraphClipboard | null>(null);
  const [annotation, setAnnotation] = useState<CanvasAnnotation | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const layout = () => {
    onChange(autoLayout(scene));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void flow.current?.fitView({ padding: 0.12, duration: 180 })),
    );
  };
  const selectionChanged = useCallback(
    ({ nodes, edges }: { nodes: CanvasNode[]; edges: CanvasEdge[] }) =>
      setIds((old) => {
        const next = new Set([...nodes, ...edges].map((n) => n.id));
        return old.size === next.size && [...old].every((id) => next.has(id)) ? old : next;
      }),
    [],
  );
  useEffect(() => {
    setNodes((old) => [
      ...(scene.workflow.annotations ?? []).map((a) => ({
        id: a.id,
        type: 'annotation',
        position: a.position,
        data: { annotation: a },
        style: { width: a.width, height: a.height },
        zIndex: a.kind === 'group' ? -1 : 0,
        selected: old.find((n) => n.id === a.id)?.selected ?? false,
      })),
      ...scene.workflow.nodes.map((n) => ({
        id: n.id,
        type: 'task',
        position: n.position,
        data: { node: n },
        selected: old.find((x) => x.id === n.id)?.selected ?? n.id === selected,
      })),
    ]);
    setEdges((old) =>
      scene.workflow.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: e.outlet ?? 'success',
        label: (e.outlet ?? 'success') === 'success' ? '' : e.outlet,
        selected: old.find((x) => x.id === e.id)?.selected ?? false,
        type: 'smoothstep',
      })),
    );
  }, [scene.workflow, selected]);
  const copy = () => {
    clipboard.current = copySelection(scene, ids);
  };
  const paste = (duplicate = false) => {
    const source = duplicate ? copySelection(scene, ids) : clipboard.current;
    if (!source || disabled) return;
    const next = pasteSelection(scene, source);
    onChange(next.scene);
    setIds(new Set(next.ids));
  };
  const remove = () => {
    if (!disabled) onChange(removeSelection(scene, ids));
  };
  const group = () => {
    const members = scene.workflow.nodes.filter((n) => ids.has(n.id));
    if (!members.length) return;
    const x = Math.min(...members.map((n) => n.position.x)) - 24,
      y = Math.min(...members.map((n) => n.position.y)) - 45;
    onChange({
      ...scene,
      workflow: {
        ...scene.workflow,
        annotations: [
          ...(scene.workflow.annotations ?? []),
          {
            id: crypto.randomUUID(),
            kind: 'group',
            text: '节点分组',
            position: { x, y },
            width: Math.max(...members.map((n) => n.position.x)) + 254 - x,
            height: Math.max(...members.map((n) => n.position.y)) + 134 - y,
            nodeIds: members.map((n) => n.id),
          },
        ],
      },
    });
  };
  const toggle = () =>
    onChange({
      ...scene,
      workflow: {
        ...scene.workflow,
        nodes: scene.workflow.nodes.map((n) => (ids.has(n.id) ? { ...n, enabled: !n.enabled } : n)),
      },
    });
  return (
    <section
      className="advanced-canvas"
      onKeyDown={(e) => {
        if (
          disabled ||
          (e.target instanceof HTMLElement &&
            e.target.closest('input,textarea,select,[contenteditable]'))
        )
          return;
        if (e.ctrlKey || e.metaKey) {
          const key = e.key.toLowerCase();
          if (['c', 'v', 'd', 'z', 'y'].includes(key)) {
            e.preventDefault();
            e.stopPropagation();
            if (key === 'c') copy();
            if (key === 'v') paste();
            if (key === 'd') paste(true);
            if (key === 'z') e.shiftKey ? redo() : undo();
            if (key === 'y') redo();
          }
        }
      }}
      tabIndex={0}
    >
      <div className="canvas-toolbar">
        <span>
          {scene.workflow.nodes.length} 个节点 · {scene.workflow.edges.length} 条边
        </span>
        <div>
          {[
            [Undo2, '撤销', undo, !canUndo],
            [Redo2, '重做', redo, !canRedo],
            [Copy, '复制选中节点', copy, !ids.size],
            [ClipboardPaste, '粘贴节点', () => paste(), false],
            [Copy, '复制为新节点', () => paste(true), !ids.size],
            [Trash2, '删除选中内容', remove, !ids.size],
            [Group, '创建分组', group, !ids.size],
            [Power, '启用或禁用选中节点', toggle, !ids.size],
            [
              MessageSquare,
              '添加注释',
              () =>
                setAnnotation({
                  id: crypto.randomUUID(),
                  kind: 'comment',
                  text: '流程说明',
                  position: { x: 60, y: 30 },
                  width: 240,
                  height: 100,
                  nodeIds: [],
                }),
              false,
            ],
            [LayoutGrid, '自动布局', layout, false],
            [Settings2, '场景设置', onSettings, false],
          ].map(([Icon, label, action, inactive]) => {
            const I = Icon as typeof Copy;
            return (
              <button
                key={String(label)}
                className="icon-button"
                aria-label={String(label)}
                title={String(label)}
                disabled={disabled || Boolean(inactive)}
                onClick={action as () => void}
              >
                <I size={16} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="flow-surface">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.15}
          maxZoom={2}
          selectionOnDrag
          panOnDrag={[1, 2]}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Control', 'Meta']}
          deleteKeyCode={disabled ? null : ['Backspace', 'Delete']}
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          edgesReconnectable={false}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onNodesChange={(changes) => setNodes((old) => applyNodeChanges(changes, old))}
          onEdgesChange={(changes) => setEdges((old) => applyEdgeChanges(changes, old))}
          onSelectionChange={selectionChanged}
          onNodeClick={(_, node) => {
            if (node.type === 'task') onSelect(node.id);
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.type === 'annotation')
              setAnnotation(
                (scene.workflow.annotations ?? []).find((a) => a.id === node.id) ?? null,
              );
          }}
          onNodeDragStop={(_, dragged, draggedNodes) => {
            const positions = new Map(draggedNodes.map((n) => [n.id, n.position]));
            positions.set(dragged.id, dragged.position);
            const moved = scene.workflow.nodes.map((n) => ({
              ...n,
              position: positions.get(n.id) ?? n.position,
            }));
            const annotations = (scene.workflow.annotations ?? []).map((a) => {
              const pos = positions.get(a.id);
              if (!pos) return a;
              const dx = pos.x - a.position.x,
                dy = pos.y - a.position.y;
              for (const n of moved) {
                if (a.nodeIds.includes(n.id) && !positions.has(n.id))
                  n.position = { x: n.position.x + dx, y: n.position.y + dy };
              }
              return { ...a, position: pos };
            });
            onChange({ ...scene, workflow: { ...scene.workflow, nodes: moved, annotations } });
          }}
          onConnect={(c) => {
            if (disabled || !c.source || !c.target) return;
            const outlet = c.sourceHandle ?? 'success';
            if (
              scene.workflow.edges.some(
                (e) =>
                  e.from === c.source && e.to === c.target && (e.outlet ?? 'success') === outlet,
              )
            )
              return;
            onChange({
              ...scene,
              workflow: {
                ...scene.workflow,
                edges: [
                  ...scene.workflow.edges,
                  { id: crypto.randomUUID(), from: c.source, to: c.target, outlet },
                ],
              },
            });
          }}
          onDelete={({ nodes, edges }) => {
            if (!disabled)
              onChange(removeSelection(scene, new Set([...nodes, ...edges].map((n) => n.id))));
          }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.type === 'annotation' ? '#e5ebe6' : '#6b9d80')}
          />
        </ReactFlow>
      </div>
      <div className="canvas-help">
        拖动端点连线 · Shift 框选 · 中键 / 右键平移 · Ctrl/Cmd+C/V 复制粘贴 · 双击注释或分组修改文字
      </div>
      {annotation && (
        <Modal
          title={annotation.kind === 'group' ? '分组名称' : '流程注释'}
          onClose={() => setAnnotation(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onChange({
                ...scene,
                workflow: {
                  ...scene.workflow,
                  annotations: [
                    ...(scene.workflow.annotations ?? []).filter((a) => a.id !== annotation.id),
                    annotation,
                  ],
                },
              });
              setAnnotation(null);
            }}
          >
            <div className="modal-body form-stack">
              <label>
                内容
                <textarea
                  aria-label="内容"
                  autoFocus
                  value={annotation.text}
                  onChange={(e) => setAnnotation({ ...annotation, text: e.target.value })}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button className="button primary">保存注释</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
