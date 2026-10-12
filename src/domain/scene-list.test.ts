import { describe, expect, it } from 'vitest';
import { moveScene, orderScenes } from './scene-list';

describe('scene order', () => {
  it('moves to either side of a card without losing scenes outside a search result', () => {
    const all = ['A', 'hidden', 'B', 'C'];
    expect(moveScene(all, 'C', 'A', 'before')).toEqual(['C', 'A', 'hidden', 'B']);
    expect(moveScene(all, 'A', 'C', 'after')).toEqual(['hidden', 'B', 'C', 'A']);
    expect(moveScene(all, 'A', 'B', 'before')).toEqual(['hidden', 'A', 'B', 'C']);
    expect(all).toEqual(['A', 'hidden', 'B', 'C']);
  });
  it('ignores self drops and missing scene IDs', () => {
    for (const [source, target] of [
      ['A', 'A'],
      ['missing', 'B'],
      ['A', 'missing'],
    ])
      expect(moveScene(['A', 'B'], source, target, 'after')).toEqual(['A', 'B']);
  });
  it('applies an acknowledgement to current scene objects without restoring stale fields', () => {
    const scenes = [
      { id: 'A', name: 'Renamed' },
      { id: 'new', name: 'Created' },
      { id: 'B', name: 'B' },
    ];
    const ordered = orderScenes(scenes, ['B', 'deleted', 'A']);
    expect(ordered.map((s) => s.id)).toEqual(['B', 'A', 'new']);
    expect(ordered[1]).toBe(scenes[0]);
  });
});
