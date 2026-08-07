import { describe, expect, it } from 'vitest';
import { analyzeImpact, impactEscapesScope, type ImpactResult } from '@treediagram/core';
import { makeNode, makeRelation, wsOf } from '../helpers/workspace.js';
import type { NodeHead } from '@treediagram/core';

function headOf(nodeId: string, revisionId: string | null, action: 'upsert' | 'remove'): NodeHead {
  return { nodeId, nodeRevisionId: revisionId, action };
}

describe('影响闭包分析（§9.1）', () => {
  it('被替代修订的关系进入影响集', () => {
    // base: A --depends_on--> B；working: B 被修订为 B'
    const a = makeNode('claim');
    const b = makeNode('claim');
    const dep = makeRelation('depends_on', a.revision, b.revision);
    const base = wsOf([a, b], [dep]);

    const bNew = makeNode('claim');
    bNew.node.id = b.node.id;
    bNew.revision.nodeId = b.node.id;
    bNew.revision.revisionNumber = 2;
    bNew.revision.supersedesRevisionId = b.revision.id;
    const working = wsOf([a, bNew], [dep]);

    const impact = analyzeImpact(
      base,
      working,
      [headOf(b.node.id, bNew.revision.id, 'upsert')],
      [],
    );
    expect(impact.affectedNodeIds.has(b.node.id)).toBe(true);
    expect(impact.affectedRelationIds.has(dep.relation.id)).toBe(true);
    // 依赖者 A 通过反向 depends_on 进入闭包
    expect(impact.affectedNodeIds.has(a.node.id)).toBe(true);
  });

  it('contains 结构后代进入影响集', () => {
    const parent = makeNode('topic');
    const child = makeNode('claim');
    const grandchild = makeNode('claim');
    const c1 = makeRelation('contains', parent.revision, child.revision);
    const c2 = makeRelation('contains', child.revision, grandchild.revision);
    const base = wsOf([parent, child, grandchild], [c1, c2]);

    const parentNew = makeNode('topic');
    parentNew.node.id = parent.node.id;
    parentNew.revision.nodeId = parent.node.id;
    parentNew.revision.revisionNumber = 2;
    const working = wsOf([parentNew, child, grandchild], [c1, c2]);

    const impact = analyzeImpact(
      base,
      working,
      [headOf(parent.node.id, parentNew.revision.id, 'upsert')],
      [],
    );
    expect(impact.affectedNodeIds.has(child.node.id)).toBe(true);
    expect(impact.affectedNodeIds.has(grandchild.node.id)).toBe(true);
  });

  it('contradicts 两端都加入', () => {
    const a = makeNode('claim');
    const b = makeNode('claim');
    const rel = makeRelation('contradicts', a.revision, b.revision, { blocking: false });
    const base = wsOf([a, b], [rel]);

    const aNew = makeNode('claim');
    aNew.node.id = a.node.id;
    aNew.revision.nodeId = a.node.id;
    aNew.revision.revisionNumber = 2;
    const working = wsOf([aNew, b], [rel]);

    const impact = analyzeImpact(
      base,
      working,
      [headOf(a.node.id, aNew.revision.id, 'upsert')],
      [],
    );
    expect(impact.affectedNodeIds.has(b.node.id)).toBe(true);
  });

  it('root change 覆盖全树（§9.2）', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim');
    const b = makeNode('claim');
    const rel = makeRelation('depends_on', a.revision, b.revision);
    const base = wsOf([root, a, b], [rel]);

    const rootNew = makeNode('claim', { roles: ['root'] });
    rootNew.node.id = root.node.id;
    rootNew.revision.nodeId = root.node.id;
    rootNew.revision.revisionNumber = 2;
    const working = wsOf([rootNew, a, b], [rel]);

    const impact = analyzeImpact(
      base,
      working,
      [headOf(root.node.id, rootNew.revision.id, 'upsert')],
      [],
    );
    expect(impact.rootChange).toBe(true);
    expect(impact.affectedNodeIds.size).toBe(3);
    expect(impact.affectedRelationIds.size).toBe(1);
  });

  it('root 角色移出也视为 root change', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const base = wsOf([root], []);
    const demoted = makeNode('claim', { roles: [] });
    demoted.node.id = root.node.id;
    demoted.revision.nodeId = root.node.id;
    demoted.revision.revisionNumber = 2;
    const working = wsOf([demoted], []);
    const impact = analyzeImpact(
      base,
      working,
      [headOf(root.node.id, demoted.revision.id, 'upsert')],
      [],
    );
    expect(impact.rootChange).toBe(true);
  });
});

describe('影响越界检测（§10）', () => {
  it('闭包在托管子树内不越界，越出则越界', () => {
    const scope = makeNode('topic');
    const inside = makeNode('claim');
    const outside = makeNode('claim');
    const c1 = makeRelation('contains', scope.revision, inside.revision);
    const working = wsOf([scope, inside, outside], [c1]);

    const insideImpact: ImpactResult = {
      rootChange: false,
      affectedNodeIds: new Set([inside.node.id]),
      affectedRelationIds: new Set(),
    };
    expect(impactEscapesScope(insideImpact, working, scope.node.id)).toBe(false);

    const outsideImpact: ImpactResult = {
      rootChange: false,
      affectedNodeIds: new Set([inside.node.id, outside.node.id]),
      affectedRelationIds: new Set(),
    };
    expect(impactEscapesScope(outsideImpact, working, scope.node.id)).toBe(true);

    const rootImpact: ImpactResult = {
      rootChange: true,
      affectedNodeIds: new Set(),
      affectedRelationIds: new Set(),
    };
    expect(impactEscapesScope(rootImpact, working, scope.node.id)).toBe(true);
  });
});
