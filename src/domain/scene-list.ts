export function moveScene(
  order: readonly string[],
  sceneId: string,
  targetId: string,
  placement: 'before' | 'after',
): string[] {
  if (sceneId === targetId || !order.includes(sceneId) || !order.includes(targetId))
    return [...order];
  const next = order.filter((id) => id !== sceneId);
  next.splice(next.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, sceneId);
  return next;
}

export function orderScenes<T extends { id: string }>(scenes: T[], order: string[]): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...scenes].sort(
    (a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length),
  );
}
