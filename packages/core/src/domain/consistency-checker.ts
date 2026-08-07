import type {
  ConsistencyIssue,
  ConsistencyIssueCode,
  DelegationPolicy,
  NodeId,
  NodeRevision,
  NodeType,
  RelationRevision,
  RelationType,
} from '@treediagram/contracts';
import { BLOCKING_ISSUE_CODES, ROOT_ALLOWED_NODE_TYPES } from '@treediagram/contracts';
import {
  activeContainsRelations,
  containsParentsOf,
  endpointNodeId,
  type WorkingSet,
} from './working-set.js';
import { validateRelationEndpointTypes } from './relation-rules.js';

export interface ConsistencyInput {
  workingSet: WorkingSet;
  /** 当前 ChangeSet 的 review item 计数（无 live ChangeSet 时为 0）。 */
  reviewCounts: { pending: number; blocked: number };
  /** 项目全部托管策略（含已撤销；历史 AI 确认的追溯依据）。 */
  policies: readonly DelegationPolicy[];
}

/**
 * 一致性检查器（IMPLEMENTATION_DESIGN §8）：纯函数、只读、不修复数据。
 * 输出去重后的直接阻塞集合 + warnings（不把下游连锁错误重复展开）。
 */
export function checkConsistency(input: ConsistencyInput): ConsistencyIssue[] {
  const ws = input.workingSet;
  const issues: ConsistencyIssue[] = [];
  const seen = new Set<string>();

  const emit = (
    code: ConsistencyIssueCode,
    entityKind: ConsistencyIssue['entityKind'],
    entityRevisionId: string | null,
    relatedRevisionIds: string[],
    message: string,
    details: Record<string, unknown> = {},
  ) => {
    const key = `${code}|${entityKind}|${entityRevisionId ?? ''}|${relatedRevisionIds.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const severity = (BLOCKING_ISSUE_CODES as readonly string[]).includes(code)
      ? ('blocking' as const)
      : ('warning' as const);
    issues.push({ code, severity, entityKind, entityRevisionId, relatedRevisionIds, message, details });
  };

  const nodeTypeOf = (nodeId: NodeId): NodeType | null => ws.nodeById.get(nodeId)?.nodeType ?? null;

  const relationTypeOf = (revision: RelationRevision): RelationType | null =>
    ws.relationById.get(revision.relationId)?.relationType ?? null;

  const activeRevisionIds = new Set<string>();
  for (const revision of ws.nodeRevisionByNodeId.values()) activeRevisionIds.add(revision.id);

  const activeRelationsByType = new Map<RelationType, RelationRevision[]>();
  for (const revision of ws.relationRevisionByRelationId.values()) {
    const type = relationTypeOf(revision);
    if (!type) continue;
    const list = activeRelationsByType.get(type) ?? [];
    list.push(revision);
    activeRelationsByType.set(type, list);
  }
  const relationsOf = (type: RelationType) => activeRelationsByType.get(type) ?? [];

  const revisionIsActive = (revisionId: string) => activeRevisionIds.has(revisionId);
  const endpointActiveNodeType = (revisionId: string): NodeType | null => {
    const nodeId = endpointNodeId(ws, revisionId);
    return nodeId ? nodeTypeOf(nodeId) : null;
  };

  // ---- 1. Root 规则（§4.3） ----
  const roots: NodeRevision[] = [];
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    if (revision.roles.includes('root')) roots.push(revision);
  }
  if (roots.length === 0) {
    emit('ROOT_MISSING', 'project', null, [], 'Release 至少包含一个 root 角色节点');
  }
  for (const root of roots) {
    const type = nodeTypeOf(root.nodeId);
    if (!type || !(ROOT_ALLOWED_NODE_TYPES as readonly string[]).includes(type)) {
      emit('ROOT_INVALID_TYPE', 'node_revision', root.id, [], 'root 角色只能挂在 claim/goal/constraint 上', {
        nodeType: type,
      });
    }
    if (root.approvalState === 'ai_confirmed') {
      emit('ROOT_AI_CONFIRMED', 'node_revision', root.id, [], 'root 不能由 AI 确认');
    } else if (root.approvalState !== 'user_confirmed') {
      emit('ROOT_NOT_USER_CONFIRMED', 'node_revision', root.id, [], 'root 修订必须是 user_confirmed', {
        approvalState: root.approvalState,
      });
    }
  }

  // ---- 2. Review 闸门 ----
  if (input.reviewCounts.pending > 0) {
    emit('REVIEW_PENDING', 'project', null, [], `存在 ${input.reviewCounts.pending} 个待复核项`, {
      pending: input.reviewCounts.pending,
    });
  }
  if (input.reviewCounts.blocked > 0) {
    emit('REVIEW_BLOCKED', 'project', null, [], `存在 ${input.reviewCounts.blocked} 个被阻塞复核项`, {
      blocked: input.reviewCounts.blocked,
    });
  }

  // ---- 3. contains 结构 ----
  const contains = activeContainsRelations(ws);
  const parentsByChildRev = new Map<string, RelationRevision[]>();
  const childrenByParentNode = new Map<NodeId, NodeId[]>();
  for (const [, revision] of contains) {
    const list = parentsByChildRev.get(revision.toNodeRevisionId) ?? [];
    list.push(revision);
    parentsByChildRev.set(revision.toNodeRevisionId, list);
    const parentId = endpointNodeId(ws, revision.fromNodeRevisionId);
    const childId = endpointNodeId(ws, revision.toNodeRevisionId);
    if (parentId && childId) {
      const children = childrenByParentNode.get(parentId) ?? [];
      children.push(childId);
      childrenByParentNode.set(parentId, children);
    }
  }
  for (const [childRevId, parents] of parentsByChildRev) {
    if (parents.length > 1) {
      emit(
        'CONTAINS_MULTIPLE_PARENTS',
        'node_revision',
        childRevId,
        parents.map((p) => p.id),
        '每个活动节点最多一个活动 contains 父关系',
        { parentCount: parents.length },
      );
    }
  }

  // contains 环检测：DFS 三色标记（§8.3）。
  {
    const color = new Map<NodeId, 0 | 1 | 2>();
    const stack: NodeId[] = [];
    const cyclePaths: NodeId[][] = [];
    const visit = (nodeId: NodeId): void => {
      color.set(nodeId, 1);
      stack.push(nodeId);
      for (const child of childrenByParentNode.get(nodeId) ?? []) {
        const c = color.get(child) ?? 0;
        if (c === 0) {
          visit(child);
        } else if (c === 1) {
          const idx = stack.indexOf(child);
          cyclePaths.push([...stack.slice(idx), child]);
        }
      }
      stack.pop();
      color.set(nodeId, 2);
    };
    for (const nodeId of ws.nodeById.keys()) {
      if ((color.get(nodeId) ?? 0) === 0) visit(nodeId);
    }
    const reported = new Set<string>();
    for (const path of cyclePaths) {
      const revisionIds = path
        .map((id) => ws.nodeRevisionByNodeId.get(id)?.id)
        .filter((v): v is NonNullable<typeof v> => v !== undefined);
      const key = [...revisionIds].sort().join(',');
      if (reported.has(key)) continue;
      reported.add(key);
      emit('CONTAINS_CYCLE', 'project', null, revisionIds, 'contains 结构存在环', {
        cycleNodeRevisionIds: revisionIds,
      });
    }
  }

  // ---- 4. 关系端点 ----
  for (const revision of ws.relationRevisionByRelationId.values()) {
    const type = relationTypeOf(revision);
    if (!type) continue;
    const fromOk = revisionIsActive(revision.fromNodeRevisionId);
    const toOk = revisionIsActive(revision.toNodeRevisionId);
    if (!fromOk || !toOk) {
      const missing = [
        ...(fromOk ? [] : [revision.fromNodeRevisionId]),
        ...(toOk ? [] : [revision.toNodeRevisionId]),
      ];
      emit(
        'RELATION_ENDPOINT_MISSING',
        'relation_revision',
        revision.id,
        missing,
        '活动关系端点必须指向工作版本中的活动修订（禁止静默迁移）',
        { relationType: type },
      );
      continue; // 端点缺失时不再级联报类型错误（最小阻塞集合）
    }
    const fromType = endpointActiveNodeType(revision.fromNodeRevisionId);
    const toType = endpointActiveNodeType(revision.toNodeRevisionId);
    if (fromType && toType) {
      const error = validateRelationEndpointTypes(type, fromType, toType);
      if (error) {
        emit('RELATION_ENDPOINT_TYPE_INVALID', 'relation_revision', revision.id, [], error, {
          relationType: type,
          fromType,
          toType,
        });
      }
    }
  }

  // ---- 5. 认知/证据规则 ----
  const supportsRelations = relationsOf('supports');
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    if (revision.epistemicState !== 'supported') continue;
    const hasEvidence = supportsRelations.some(
      (rel) =>
        rel.toNodeRevisionId === revision.id &&
        revisionIsActive(rel.fromNodeRevisionId) &&
        endpointActiveNodeType(rel.fromNodeRevisionId) === 'evidence',
    );
    if (!hasEvidence) {
      emit(
        'SUPPORTED_WITHOUT_EVIDENCE',
        'node_revision',
        revision.id,
        [],
        'supported 状态必须存在活动 Evidence 的 supports 关系',
      );
    }
  }

  // ---- 6. 重要决策规则（§4.5） ----
  const addressesRelations = relationsOf('addresses');
  const selectsRelations = relationsOf('selects');
  const rejectsRelations = relationsOf('rejects');
  const dependsOnRelations = relationsOf('depends_on');
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    if (nodeTypeOf(revision.nodeId) !== 'decision') continue;
    const attrs = revision.attributes as { importance?: string; noAlternativeFound?: boolean; alternativeSearchNote?: string | null };
    if (attrs.importance !== 'important') {
      // SIMPLE_DECISION_HAS_WIDE_IMPACT（warning）
      const dependentCount = dependsOnRelations.filter(
        (rel) => rel.toNodeRevisionId === revision.id,
      ).length;
      if (dependentCount > 3) {
        emit(
          'SIMPLE_DECISION_HAS_WIDE_IMPACT',
          'node_revision',
          revision.id,
          [],
          '标记为 simple 的决策影响面较广，建议升级为重要决策',
          { dependentCount },
        );
      }
      continue;
    }
    const hasQuestion = addressesRelations.some(
      (rel) =>
        rel.fromNodeRevisionId === revision.id &&
        revisionIsActive(rel.toNodeRevisionId) &&
        endpointActiveNodeType(rel.toNodeRevisionId) === 'question',
    );
    if (!hasQuestion) {
      emit(
        'IMPORTANT_DECISION_MISSING_QUESTION',
        'node_revision',
        revision.id,
        [],
        '重要决策必须至少有一条 addresses 指向活动 Question',
      );
    }
    if (attrs.noAlternativeFound === true) {
      if (!attrs.alternativeSearchNote || attrs.alternativeSearchNote.trim().length === 0) {
        emit(
          'IMPORTANT_DECISION_MISSING_SEARCH_NOTE',
          'node_revision',
          revision.id,
          [],
          'noAlternativeFound=true 的重要决策必须说明替代搜索范围',
        );
      }
    } else {
      const hasOptionHandling = [...selectsRelations, ...rejectsRelations].some(
        (rel) =>
          rel.fromNodeRevisionId === revision.id &&
          revisionIsActive(rel.toNodeRevisionId) &&
          endpointActiveNodeType(rel.toNodeRevisionId) === 'option',
      );
      if (!hasOptionHandling) {
        emit(
          'IMPORTANT_DECISION_MISSING_OPTIONS',
          'node_revision',
          revision.id,
          [],
          '重要决策必须至少有一条 selects 或 rejects 指向活动 Option',
        );
      }
    }
  }

  // ---- 7. 已确认决策不依赖 refuted ----
  for (const rel of dependsOnRelations) {
    const fromNodeId = endpointNodeId(ws, rel.fromNodeRevisionId);
    const toRevision = [...ws.nodeRevisionByNodeId.values()].find(
      (r) => r.id === rel.toNodeRevisionId,
    );
    if (!fromNodeId || !toRevision) continue;
    if (nodeTypeOf(fromNodeId) !== 'decision') continue;
    const decisionRevision = ws.nodeRevisionByNodeId.get(fromNodeId);
    if (!decisionRevision) continue;
    if (!['user_confirmed', 'ai_confirmed'].includes(decisionRevision.approvalState)) continue;
    if (toRevision.epistemicState === 'refuted') {
      emit(
        'DECISION_DEPENDS_ON_REFUTED',
        'node_revision',
        decisionRevision.id,
        [rel.id, toRevision.id],
        '已确认决策不能依赖 epistemic=refuted 的活动节点',
      );
    }
  }

  // ---- 8. 阻塞问题/矛盾 ----
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    if (nodeTypeOf(revision.nodeId) !== 'question') continue;
    const blocking = (revision.attributes as { blocking?: boolean }).blocking === true;
    const addressed = addressesRelations.some(
      (rel) => rel.toNodeRevisionId === revision.id && revisionIsActive(rel.fromNodeRevisionId),
    );
    if (blocking && !addressed) {
      emit('BLOCKING_QUESTION', 'node_revision', revision.id, [], '存在标记为 blocking 的未解决 Question');
    } else if (!blocking && !addressed) {
      emit(
        'UNRESOLVED_NON_BLOCKING_QUESTION',
        'node_revision',
        revision.id,
        [],
        '存在未解决的非阻塞 Question',
      );
    }
  }
  for (const rel of relationsOf('contradicts')) {
    if ((rel.attributes as { blocking?: boolean }).blocking === true) {
      emit('BLOCKING_CONTRADICTION', 'relation_revision', rel.id, [], '存在 blocking 矛盾关系');
    }
  }

  // ---- 9. AI 确认可追溯性（§7.9） ----
  const policyById = new Map(input.policies.map((p) => [p.id, p]));
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    if (revision.approvalState !== 'ai_confirmed') continue;
    const auth = revision.authorization;
    const policy = auth ? policyById.get(auth.policyId) : undefined;
    let inScope = false;
    if (policy) {
      // 当前工作树上 policy 作用域必须是节点的祖先或自身。
      let cursor: NodeId | null = revision.nodeId;
      const visited = new Set<NodeId>();
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        if (cursor === policy.scopeNodeId) {
          inScope = true;
          break;
        }
        const parents: NodeId[] = containsParentsOf(ws, cursor);
        cursor = parents.length === 1 ? (parents[0] as NodeId) : null;
      }
    }
    if (!auth || !policy || !inScope) {
      emit(
        'AI_CONFIRMATION_OUT_OF_SCOPE',
        'node_revision',
        revision.id,
        [],
        'ai_confirmed 修订无法追溯到有效托管策略作用域',
        { hasAuthorization: auth !== null, policyFound: policy !== undefined, inScope },
      );
    }
  }
  for (const revision of ws.relationRevisionByRelationId.values()) {
    if (revision.approvalState !== 'ai_confirmed') continue;
    const auth = revision.authorization;
    const policy = auth ? policyById.get(auth.policyId) : undefined;
    if (!auth || !policy) {
      emit(
        'AI_CONFIRMATION_OUT_OF_SCOPE',
        'relation_revision',
        revision.id,
        [],
        'ai_confirmed 关系修订无法追溯到有效托管策略',
        { hasAuthorization: auth !== null, policyFound: policy !== undefined },
      );
    }
  }

  // ---- 10. warnings ----
  for (const revision of ws.nodeRevisionByNodeId.values()) {
    const type = nodeTypeOf(revision.nodeId);
    const hasParent = (parentsByChildRev.get(revision.id) ?? []).length > 0;
    if (!hasParent && !revision.roles.includes('root')) {
      emit(
        'ORPHAN_TOP_LEVEL_NODE',
        'node_revision',
        revision.id,
        [],
        '非 root 节点缺少 contains 父关系（顶层孤立节点）',
        { nodeType: type },
      );
    }
    if (revision.epistemicState === 'assumed') {
      const hasValidationLink = ws.relationRevisionByRelationId.size
        ? [...ws.relationRevisionByRelationId.values()].some(
            (rel) =>
              rel.toNodeRevisionId === revision.id &&
              revisionIsActive(rel.fromNodeRevisionId) &&
              endpointActiveNodeType(rel.fromNodeRevisionId) === 'validation_method',
          )
        : false;
      if (!hasValidationLink) {
        emit(
          'ASSUMPTION_WITHOUT_VALIDATION_METHOD',
          'node_revision',
          revision.id,
          [],
          'assumed 节点没有关联的 ValidationMethod',
        );
      }
    }
    if (type === 'evidence') {
      const limitations = (revision.attributes as { limitations?: string[] }).limitations ?? [];
      if (limitations.length === 0) {
        emit('EVIDENCE_LIMITATIONS_EMPTY', 'node_revision', revision.id, [], 'Evidence 未记录局限');
      }
    }
  }

  return issues;
}
