import { describe, it, expect } from 'vitest';
import {
  autoLayout,
  copySelection,
  pasteSelection,
  removeSelection,
  isSequence,
  sequenceNodes,
} from './graph';
import { createNode, moveNode } from './editor';
import type { Scene } from './types';
const make = (): Scene => ({
  schemaVersion: 1,
  id: 'scene',
  name: 'DAG',
  description: '',
  icon: 'code',
  color: 'green',
  version: 1,
  isDefault: false,
  allowCommandsAtStartup: false,
  createdAt: '',
  updatedAt: '',
  workflow: {
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({
      ...createNode({
        nodeType: 'system.delay',
        name: id,
        description: '',
        category: 'system',
        fields: [],
        defaults: { durationMs: 0 },
        waiting: true,
      }),
      id,
    })),
    edges: [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ].map(([from, to]) => ({ id: from + to, from, to, outlet: 'success' })),
    annotations: [
      {
        id: 'group',
        kind: 'group',
        text: 'parallel',
        position: { x: 0, y: 0 },
        width: 500,
        height: 400,
        nodeIds: ['b', 'c'],
      },
    ],
  },
});
describe('one workflow model', () => {
  it('auto layout honors dependencies without changing edges', () => {
    const s = make();
    const out = autoLayout(s);
    expect(out.workflow.edges).toEqual(s.workflow.edges);
    const n = Object.fromEntries(out.workflow.nodes.map((n) => [n.id, n]));
    expect(n.b.position.x).toBe(n.c.position.x);
    expect(n.d.position.x).toBeGreaterThan(n.b.position.x);
    expect(n.b.position.y).not.toBe(n.c.position.y);
    expect(isSequence(out)).toBe(false);
  });
  it('copy paste remaps internal edges and groups without connecting originals', () => {
    const s = make();
    const copied = copySelection(s, new Set(['a', 'b', 'group']));
    const out = pasteSelection(s, copied);
    expect(out.scene.workflow.nodes).toHaveLength(6);
    expect(out.scene.workflow.edges).toHaveLength(5);
    const edge = out.scene.workflow.edges.at(-1)!;
    expect(['a', 'b']).not.toContain(edge.from);
    expect(out.scene.workflow.annotations?.at(-1)?.nodeIds).toHaveLength(1);
  });
  it('delete removes incident edges and stale group membership', () => {
    const out = removeSelection(make(), new Set(['b']));
    expect(out.workflow.nodes).toHaveLength(3);
    expect(out.workflow.edges).toHaveLength(2);
    expect(out.workflow.annotations?.[0].nodeIds).toEqual(['c']);
  });
  it('pasted nodes consume pasted upstream outputs and retain external references', () => {
    const s = make();
    s.workflow.nodes[1].config = {
      arguments: ['${node.a.output.stdout}', 'prefix ${node.c.output.code}'],
      nested: { value: '${node.a.output}' },
    };
    const out = pasteSelection(s, copySelection(s, new Set(['a', 'b']))).scene;
    const a = out.workflow.nodes[4],
      b = out.workflow.nodes[5];
    expect(b.config).toEqual({
      arguments: ['${node.' + a.id + '.output.stdout}', 'prefix ${node.c.output.code}'],
      nested: { value: '${node.' + a.id + '.output}' },
    });
  });
  it('simple view follows edges even when storage array is reversed and rejects disconnected cycles', () => {
    const s = make();
    s.workflow.edges = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ].map(([from, to]) => ({ id: from + to, from, to }));
    s.workflow.nodes.reverse();
    expect(isSequence(s)).toBe(true);
    expect(sequenceNodes(s).map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(moveNode(s, 'd', 0).workflow.edges.map((e) => e.from + e.to)).toEqual([
      'da',
      'ab',
      'bc',
    ]);
    s.workflow.edges = [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'ba', from: 'b', to: 'a' },
      { id: 'cd', from: 'c', to: 'd' },
    ];
    expect(isSequence(s)).toBe(false);
  });
});
