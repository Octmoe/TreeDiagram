import type { RelationDetail } from '@treediagram/contracts';

export function impactClosure(
  seedNodeIds: readonly string[],
  relations: readonly RelationDetail[],
): string[] {
  const impacted = new Set(seedNodeIds);
  const queue = [...seedNodeIds];
  const propagating = new Set([
    'depends_on',
    'derived_from',
    'constrains',
    'supports',
    'contradicts',
    'violates',
    'causes',
    'amplifies',
    'mitigates',
    'reveals',
  ]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const relation of relations) {
      if (!propagating.has(relation.relation.relationType)) continue;
      const next =
        relation.relation.targetNodeId === current
          ? relation.relation.sourceNodeId
          : relation.relation.sourceNodeId === current
            ? relation.relation.targetNodeId
            : null;
      if (next && !impacted.has(next)) {
        impacted.add(next);
        queue.push(next);
      }
    }
  }
  return [...impacted];
}
