import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asId, type ReviewItem } from '@treediagram/contracts';
import { orderReviewItemsByDependency } from '@treediagram/core';
import { makeNode, makeRelation, wsOf } from '../helpers/workspace.js';

/**
 * 批次排序单元测试（§12.5）：depends_on SCC 逆依赖序——被依赖者先复核。
 */

function item(
  id: string,
  entityKind: ReviewItem['entityKind'],
  entityRevisionId: string,
): ReviewItem {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: asId(id),
    changeSetId: asId(randomUUID()),
    entityKind,
    entityRevisionId: asId(entityRevisionId),
    reasonCode: 'CHANGED',
    status: 'pending',
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('orderReviewItemsByDependency（§12.5）', () => {
  it('被依赖者排在依赖者之前', () => {
    const a = makeNode('claim');
    const b = makeNode('claim');
    // A depends_on B
    const dep = makeRelation('depends_on', a.revision, b.revision);
    const ws = wsOf([a, b], [dep]);
    // item 顺序故意让 A 在前（created_at 升序时依赖者先出现）
    const items = [
      item(randomUUID(), 'node_revision', a.revision.id),
      item(randomUUID(), 'node_revision', b.revision.id),
    ];
    const ordered = orderReviewItemsByDependency(items, ws);
    expect(ordered[0]!.entityRevisionId).toBe(b.revision.id);
    expect(ordered[1]!.entityRevisionId).toBe(a.revision.id);
  });

  it('依赖环（SCC）内保持稳定顺序且不丢项', () => {
    const a = makeNode('claim');
    const b = makeNode('claim');
    const c = makeNode('claim');
    // A → B → C → A 环
    const r1 = makeRelation('depends_on', a.revision, b.revision);
    const r2 = makeRelation('depends_on', b.revision, c.revision);
    const r3 = makeRelation('depends_on', c.revision, a.revision);
    const ws = wsOf([a, b, c], [r1, r2, r3]);
    const items = [
      item(randomUUID(), 'node_revision', a.revision.id),
      item(randomUUID(), 'node_revision', b.revision.id),
      item(randomUUID(), 'node_revision', c.revision.id),
    ];
    const ordered = orderReviewItemsByDependency(items, ws);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((i) => i.id))).toEqual(new Set(items.map((i) => i.id)));
    // 同 SCC：保持输入顺序
    expect(ordered.map((i) => i.entityRevisionId)).toEqual([
      a.revision.id,
      b.revision.id,
      c.revision.id,
    ]);
  });

  it('链式依赖完全逆序；无依赖关系保持原顺序', () => {
    const a = makeNode('claim');
    const b = makeNode('claim');
    const c = makeNode('claim');
    // A depends_on B，B depends_on C
    const r1 = makeRelation('depends_on', a.revision, b.revision);
    const r2 = makeRelation('depends_on', b.revision, c.revision);
    const ws = wsOf([a, b, c], [r1, r2]);
    const items = [
      item(randomUUID(), 'node_revision', a.revision.id),
      item(randomUUID(), 'node_revision', b.revision.id),
      item(randomUUID(), 'node_revision', c.revision.id),
    ];
    const ordered = orderReviewItemsByDependency(items, ws);
    expect(ordered.map((i) => i.entityRevisionId)).toEqual([
      c.revision.id,
      b.revision.id,
      a.revision.id,
    ]);
  });
});
