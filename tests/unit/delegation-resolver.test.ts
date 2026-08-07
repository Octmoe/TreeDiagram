import { describe, expect, it } from 'vitest';
import { resolveDelegation } from '@treediagram/core';
import { asId, type DelegationPolicy } from '@treediagram/contracts';
import { randomUUID } from 'node:crypto';
import { makeNode, makeRelation, wsOf } from '../helpers/workspace.js';

function policy(scopeNodeId: string, mode: 'human_final' | 'ai_managed'): DelegationPolicy {
  return {
    id: asId(randomUUID()),
    projectId: asId(randomUUID()),
    scopeNodeId: asId(scopeNodeId),
    mode,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  };
}

describe('AI 托管解析（§10）', () => {
  it('最近祖先显式策略优先（继承）', () => {
    const root = makeNode('topic');
    const mid = makeNode('topic');
    const leaf = makeNode('claim');
    const c1 = makeRelation('contains', root.revision, mid.revision);
    const c2 = makeRelation('contains', mid.revision, leaf.revision);
    const ws = wsOf([root, mid, leaf], [c1, c2]);

    const rootPolicy = policy(root.node.id, 'ai_managed');
    const midPolicy = policy(mid.node.id, 'human_final');

    const resolved = resolveDelegation(leaf.node.id, ws, [rootPolicy, midPolicy]);
    expect(resolved.mode).toBe('human_final');
    expect(resolved.policyId).toBe(midPolicy.id);
    expect(resolved.inheritedFromNodeId).toBe(mid.node.id);

    const resolvedMid = resolveDelegation(mid.node.id, ws, [rootPolicy, midPolicy]);
    expect(resolvedMid.inheritedFromNodeId).toBeNull();
    expect(resolvedMid.explicitPolicy?.id).toBe(midPolicy.id);
  });

  it('无 policy 默认 human_final', () => {
    const a = makeNode('claim');
    const ws = wsOf([a], []);
    const resolved = resolveDelegation(a.node.id, ws, []);
    expect(resolved.mode).toBe('human_final');
    expect(resolved.policyId).toBeNull();
  });

  it('多父结构回退 human_final 并产生 warning', () => {
    const p1 = makeNode('topic');
    const p2 = makeNode('topic');
    const child = makeNode('claim');
    const c1 = makeRelation('contains', p1.revision, child.revision);
    const c2 = makeRelation('contains', p2.revision, child.revision);
    const ws = wsOf([p1, p2, child], [c1, c2]);
    const p1Policy = policy(p1.node.id, 'ai_managed');

    const resolved = resolveDelegation(child.node.id, ws, [p1Policy]);
    expect(resolved.mode).toBe('human_final');
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it('父链环回退 human_final 并产生 warning', () => {
    const a = makeNode('topic');
    const b = makeNode('topic');
    const c1 = makeRelation('contains', a.revision, b.revision);
    const c2 = makeRelation('contains', b.revision, a.revision);
    const ws = wsOf([a, b], [c1, c2]);
    const resolved = resolveDelegation(a.node.id, ws, []);
    expect(resolved.mode).toBe('human_final');
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });
});
