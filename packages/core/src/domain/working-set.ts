import type {
  Node,
  NodeId,
  NodeRevision,
  Relation,
  RelationId,
  RelationRevision,
  ReleaseId,
} from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import type { Repositories } from '../db/database.js';
import type { NodeHead, RelationHead } from '../db/repositories/change-set.js';
import type { Release } from '@treediagram/contracts';

/**
 * WorkingSet：纯内存快照（IMPLEMENTATION_DESIGN §6.3）。
 * base Release manifest + ChangeSet heads overlay；构建不修改数据库。
 */
export interface WorkingSet {
  baseReleaseId: ReleaseId | null;
  nodeById: ReadonlyMap<NodeId, Node>;
  relationById: ReadonlyMap<RelationId, Relation>;
  nodeRevisionByNodeId: ReadonlyMap<NodeId, NodeRevision>;
  relationRevisionByRelationId: ReadonlyMap<RelationId, RelationRevision>;
  removedNodeIds: ReadonlySet<NodeId>;
  removedRelationIds: ReadonlySet<RelationId>;
}

export function emptyWorkingSet(): WorkingSet {
  return {
    baseReleaseId: null,
    nodeById: new Map(),
    relationById: new Map(),
    nodeRevisionByNodeId: new Map(),
    relationRevisionByRelationId: new Map(),
    removedNodeIds: new Set(),
    removedRelationIds: new Set(),
  };
}

export interface BuildWorkingSetArgs {
  baseRelease: Release | null;
  nodeHeads: readonly NodeHead[];
  relationHeads: readonly RelationHead[];
  repos: Repositories;
}

export function buildWorkingSet(args: BuildWorkingSetArgs): WorkingSet {
  const { baseRelease, nodeHeads, relationHeads, repos } = args;

  const nodeRevisionByNodeId = new Map<NodeId, NodeRevision>();
  const relationRevisionByRelationId = new Map<RelationId, RelationRevision>();
  const removedNodeIds = new Set<NodeId>();
  const removedRelationIds = new Set<RelationId>();

  if (baseRelease) {
    const nodeRevisions = repos.node.getRevisionsByIds(baseRelease.nodeRevisionIds);
    for (const revisionId of baseRelease.nodeRevisionIds) {
      const revision = nodeRevisions.get(revisionId);
      if (!revision) {
        throw new DomainError('CORRUPT_PERSISTED_DATA', 'Release manifest 引用不存在的节点修订', {
          releaseId: baseRelease.id,
          revisionId,
        });
      }
      nodeRevisionByNodeId.set(revision.nodeId, revision);
    }
    const relationRevisions = repos.relation.getRevisionsByIds(baseRelease.relationRevisionIds);
    for (const revisionId of baseRelease.relationRevisionIds) {
      const revision = relationRevisions.get(revisionId);
      if (!revision) {
        throw new DomainError('CORRUPT_PERSISTED_DATA', 'Release manifest 引用不存在的关系修订', {
          releaseId: baseRelease.id,
          revisionId,
        });
      }
      relationRevisionByRelationId.set(revision.relationId, revision);
    }
  }

  // 覆盖 ChangeSet heads；remove 动作删除对应实体，指向它的关系由 checker 报告（§6.3 规则 3/4）。
  for (const head of nodeHeads) {
    const nodeId = head.nodeId as NodeId;
    if (head.action === 'remove') {
      nodeRevisionByNodeId.delete(nodeId);
      removedNodeIds.add(nodeId);
    } else {
      if (!head.nodeRevisionId) {
        throw new DomainError('CORRUPT_PERSISTED_DATA', 'upsert head 缺少 revision', {
          nodeId: head.nodeId,
        });
      }
      const revision = repos.node.getRevisionById(head.nodeRevisionId);
      if (!revision || revision.nodeId !== nodeId) {
        throw new DomainError('CORRUPT_PERSISTED_DATA', 'node head 的 revision 不属于该 node', {
          nodeId: head.nodeId,
          nodeRevisionId: head.nodeRevisionId,
        });
      }
      nodeRevisionByNodeId.set(nodeId, revision);
      removedNodeIds.delete(nodeId);
    }
  }

  for (const head of relationHeads) {
    const relationId = head.relationId as RelationId;
    if (head.action === 'remove') {
      relationRevisionByRelationId.delete(relationId);
      removedRelationIds.add(relationId);
    } else {
      if (!head.relationRevisionId) {
        throw new DomainError('CORRUPT_PERSISTED_DATA', 'upsert head 缺少 relation revision', {
          relationId: head.relationId,
        });
      }
      const revision = repos.relation.getRevisionById(head.relationRevisionId);
      if (!revision || revision.relationId !== relationId) {
        throw new DomainError(
          'CORRUPT_PERSISTED_DATA',
          'relation head 的 revision 不属于该 relation',
          {
            relationId: head.relationId,
            relationRevisionId: head.relationRevisionId,
          },
        );
      }
      relationRevisionByRelationId.set(relationId, revision);
      removedRelationIds.delete(relationId);
    }
  }

  const nodeIds = [...nodeRevisionByNodeId.keys()];
  const relationIds = [...relationRevisionByRelationId.keys()];
  const nodeById = repos.node.getNodesByIds(nodeIds) as Map<NodeId, Node>;
  const relationById = repos.relation.getRelationsByIds(relationIds) as Map<RelationId, Relation>;

  for (const nodeId of nodeIds) {
    if (!nodeById.has(nodeId)) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', '修订引用的逻辑节点不存在', { nodeId });
    }
  }
  for (const relationId of relationIds) {
    if (!relationById.has(relationId)) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', '修订引用的逻辑关系不存在', { relationId });
    }
  }

  return {
    baseReleaseId: baseRelease ? baseRelease.id : null,
    nodeById,
    relationById,
    nodeRevisionByNodeId,
    relationRevisionByRelationId,
    removedNodeIds,
    removedRelationIds,
  };
}

// ---- WorkingSet 只读辅助 ----

export function revisionToNodeId(ws: WorkingSet, revisionId: string): NodeId | null {
  for (const [nodeId, revision] of ws.nodeRevisionByNodeId) {
    if (revision.id === revisionId) return nodeId;
  }
  return null;
}

/** 当前活动 contains 关系（relation type = contains）。 */
export function activeContainsRelations(ws: WorkingSet): Array<[RelationId, RelationRevision]> {
  const result: Array<[RelationId, RelationRevision]> = [];
  for (const [relationId, revision] of ws.relationRevisionByRelationId) {
    if (ws.relationById.get(relationId)?.relationType === 'contains') {
      result.push([relationId, revision]);
    }
  }
  return result;
}

/** 解析修订端点到逻辑节点（端点必须是某节点在工作版本中的活动修订，否则为 null）。 */
export function endpointNodeId(ws: WorkingSet, nodeRevisionId: string): NodeId | null {
  return revisionToNodeId(ws, nodeRevisionId);
}

/** contains 父链：child nodeId -> parent nodeId（唯一父时）；多父返回数组长度 >1。 */
export function containsParentsOf(ws: WorkingSet, nodeId: NodeId): NodeId[] {
  const childRevision = ws.nodeRevisionByNodeId.get(nodeId);
  if (!childRevision) return [];
  const parents: NodeId[] = [];
  for (const [, revision] of activeContainsRelations(ws)) {
    if (revision.toNodeRevisionId === childRevision.id) {
      const parentId = endpointNodeId(ws, revision.fromNodeRevisionId);
      if (parentId) parents.push(parentId);
    }
  }
  return parents;
}

/** contains 子节点集合：parent nodeId -> child nodeIds。 */
export function containsChildrenOf(ws: WorkingSet, nodeId: NodeId): NodeId[] {
  const parentRevision = ws.nodeRevisionByNodeId.get(nodeId);
  if (!parentRevision) return [];
  const children: NodeId[] = [];
  for (const [, revision] of activeContainsRelations(ws)) {
    if (revision.fromNodeRevisionId === parentRevision.id) {
      const childId = endpointNodeId(ws, revision.toNodeRevisionId);
      if (childId) children.push(childId);
    }
  }
  return children;
}
