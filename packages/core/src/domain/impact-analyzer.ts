import type { NodeId, NodeRevision, RelationId, RelationRevision } from '@treediagram/contracts';
import type { NodeHead, RelationHead } from '../db/repositories/change-set.js';
import { containsChildrenOf, endpointNodeId, type WorkingSet } from './working-set.js';
import { IMPACT_REVERSE_TRAVERSAL_TYPES } from './relation-rules.js';

export interface ImpactResult {
  rootChange: boolean;
  affectedNodeIds: ReadonlySet<NodeId>;
  affectedRelationIds: ReadonlySet<RelationId>;
}

/**
 * 影响闭包分析（IMPLEMENTATION_DESIGN §9.1/§9.2）。
 * base = 覆盖前（base Release 视图），working = 覆盖后工作版本。
 */
export function analyzeImpact(
  base: WorkingSet,
  working: WorkingSet,
  nodeHeads: readonly NodeHead[],
  relationHeads: readonly RelationHead[],
): ImpactResult {
  // ---- root change 检测（§4.3：新增/删除/内容修订/角色移入移出全是 root change） ----
  let rootChange = false;
  const isRootRevision = (revision: NodeRevision | undefined) =>
    revision !== undefined && revision.roles.includes('root');
  for (const head of nodeHeads) {
    const nodeId = head.nodeId as NodeId;
    const baseRevision = base.nodeRevisionByNodeId.get(nodeId);
    const newRevision = working.nodeRevisionByNodeId.get(nodeId);
    if (isRootRevision(baseRevision) || isRootRevision(newRevision)) {
      rootChange = true;
      break;
    }
  }

  if (rootChange) {
    // root change：全部活动修订进入复核集合（§9.2）。
    return {
      rootChange: true,
      affectedNodeIds: new Set(working.nodeRevisionByNodeId.keys()),
      affectedRelationIds: new Set(working.relationRevisionByRelationId.keys()),
    };
  }

  const affectedNodes = new Set<NodeId>();
  const affectedRelations = new Set<RelationId>();

  // 修订 -> 逻辑节点映射（base 与 working 的并集，用于解析被替代修订）。
  const revisionToNode = new Map<string, NodeId>();
  for (const [nodeId, revision] of base.nodeRevisionByNodeId)
    revisionToNode.set(revision.id, nodeId);
  for (const [nodeId, revision] of working.nodeRevisionByNodeId)
    revisionToNode.set(revision.id, nodeId);

  // 全部关系修订：working 优先，base 补充（用于发现端点被替代的关系）。
  const allRelations = new Map<RelationId, RelationRevision>();
  for (const [id, rev] of base.relationRevisionByRelationId) allRelations.set(id, rev);
  for (const [id, rev] of working.relationRevisionByRelationId) allRelations.set(id, rev);

  const relationTypeOf = (relationId: RelationId) =>
    working.relationById.get(relationId)?.relationType ??
    base.relationById.get(relationId)?.relationType ??
    null;

  // ---- 初始集合：ChangeSet 中新增/修订/删除的节点与关系 ----
  for (const head of nodeHeads) affectedNodes.add(head.nodeId as NodeId);
  for (const head of relationHeads) affectedRelations.add(head.relationId as RelationId);

  // ---- 任一端点指向被替代 revision 的关系 ----
  const supersededRevisionIds = new Set<string>();
  for (const head of nodeHeads) {
    if (head.action === 'upsert' && head.nodeRevisionId) {
      const baseRevision = base.nodeRevisionByNodeId.get(head.nodeId as NodeId);
      if (baseRevision && baseRevision.id !== head.nodeRevisionId) {
        supersededRevisionIds.add(baseRevision.id);
      }
    }
    if (head.action === 'remove') {
      const baseRevision = base.nodeRevisionByNodeId.get(head.nodeId as NodeId);
      if (baseRevision) supersededRevisionIds.add(baseRevision.id);
    }
  }
  for (const [relationId, revision] of allRelations) {
    if (
      supersededRevisionIds.has(revision.fromNodeRevisionId) ||
      supersededRevisionIds.has(revision.toNodeRevisionId)
    ) {
      affectedRelations.add(relationId);
      const fromNode = revisionToNode.get(revision.fromNodeRevisionId);
      const toNode = revisionToNode.get(revision.toNodeRevisionId);
      if (fromNode) affectedNodes.add(fromNode);
      if (toNode) affectedNodes.add(toNode);
    }
  }

  // ---- 反向依赖遍历 + contains 后代 + contradicts 两端 + selects/rejects 扩展（至不动点） ----
  let changed = true;
  while (changed) {
    changed = false;
    const grow = (nodes: Iterable<NodeId | null | undefined>, relations: Iterable<RelationId>) => {
      for (const n of nodes) {
        if (n && !affectedNodes.has(n)) {
          affectedNodes.add(n);
          changed = true;
        }
      }
      for (const r of relations) {
        if (!affectedRelations.has(r)) {
          affectedRelations.add(r);
          changed = true;
        }
      }
    };

    for (const [relationId, revision] of allRelations) {
      const type = relationTypeOf(relationId);
      if (!type) continue;
      const fromNode = revisionToNode.get(revision.fromNodeRevisionId);
      const toNode = revisionToNode.get(revision.toNodeRevisionId);

      // 反向 depends_on/derived_from/supports/constrains/addresses：被依赖者受影响 -> 依赖者受影响
      if (
        (IMPACT_REVERSE_TRAVERSAL_TYPES as readonly string[]).includes(type) &&
        toNode &&
        affectedNodes.has(toNode)
      ) {
        grow([fromNode], [relationId]);
      }
      // 已受影响关系的两端节点一并加入
      if (affectedRelations.has(relationId)) {
        grow([fromNode, toNode], []);
      }
      // contradicts 两端同时加入
      if (
        type === 'contradicts' &&
        ((fromNode && affectedNodes.has(fromNode)) || (toNode && affectedNodes.has(toNode)))
      ) {
        grow([fromNode, toNode], [relationId]);
      }
      // selects/rejects 变化：Decision、Option 与对应 Question（§9.1）
      if ((type === 'selects' || type === 'rejects') && affectedRelations.has(relationId)) {
        grow([fromNode, toNode], []);
        if (fromNode) {
          const fromRevision = working.nodeRevisionByNodeId.get(fromNode)?.id;
          for (const [relId2, rel2] of allRelations) {
            if (
              relationTypeOf(relId2) === 'addresses' &&
              rel2.fromNodeRevisionId === fromRevision
            ) {
              grow([revisionToNode.get(rel2.toNodeRevisionId)], [relId2]);
            }
          }
        }
      }
    }

    // contains 向下结构后代
    for (const nodeId of [...affectedNodes]) {
      grow(containsChildrenOf(working, nodeId), []);
    }
  }

  return {
    rootChange: false,
    affectedNodeIds: affectedNodes,
    affectedRelationIds: affectedRelations,
  };
}

/** 影响闭包是否越出 ai_managed 作用域（§10）：任一受影响节点不在托管子树内即为越界。 */
export function impactEscapesScope(
  impact: ImpactResult,
  working: WorkingSet,
  scopeNodeId: NodeId,
): boolean {
  if (impact.rootChange) return true;
  const scopeDescendants = new Set<NodeId>([scopeNodeId]);
  const queue = [scopeNodeId];
  while (queue.length > 0) {
    const current = queue.pop() as NodeId;
    for (const child of containsChildrenOf(working, current)) {
      if (!scopeDescendants.has(child)) {
        scopeDescendants.add(child);
        queue.push(child);
      }
    }
  }
  for (const nodeId of impact.affectedNodeIds) {
    if (!scopeDescendants.has(nodeId)) return true;
  }
  // root 节点越界单独由 rootChange 覆盖；关系端点越界已通过节点覆盖。
  return false;
}

export { endpointNodeId };
