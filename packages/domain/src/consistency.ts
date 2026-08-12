import {
  hasDesignRootRole,
  type ConsistencyIssue,
  type NodeDetail,
  type RelationDetail,
  type ValidationResult,
} from '@treediagram/contracts';

const ROOT_TYPES = new Set(['goal', 'claim', 'constraint']);

export function checkConsistency(
  nodes: readonly NodeDetail[],
  relations: readonly RelationDetail[],
  now = new Date().toISOString(),
): ValidationResult {
  const issues: ConsistencyIssue[] = [];
  const nodeById = new Map(nodes.map((detail) => [detail.node.id, detail]));
  const roots = nodes.filter((detail) => hasDesignRootRole(detail.revision.roles));

  if (roots.length === 0) {
    issues.push({
      code: 'ROOT_MISSING',
      severity: 'blocking',
      message: '设计必须包含一个根节点。',
    });
  } else if (roots.length > 1) {
    issues.push({
      code: 'ROOT_MULTIPLE',
      severity: 'blocking',
      message: 'V2.0 首版只允许一个根节点。',
    });
  }
  for (const root of roots) {
    if (!ROOT_TYPES.has(root.node.nodeType)) {
      issues.push({
        code: 'ROOT_INVALID_TYPE',
        severity: 'blocking',
        entityId: root.node.id,
        path: '/nodeType',
        message: '根节点必须是 goal、claim 或 constraint。',
      });
    }
    if (root.revision.approvalState !== 'user_confirmed') {
      issues.push({
        code: 'ROOT_NOT_USER_CONFIRMED',
        severity: 'blocking',
        entityId: root.node.id,
        path: '/approvalState',
        message: '根节点必须由用户显式确认。',
      });
    }
  }

  for (const node of nodes) {
    if (node.revision.reviewState !== 'clean') {
      issues.push({
        code: node.revision.reviewState === 'blocked' ? 'REVIEW_BLOCKED' : 'REVIEW_REQUIRED',
        severity: 'blocking',
        entityId: node.node.id,
        path: '/reviewState',
        message: '节点仍需复核，不能发布。',
      });
    }
    if (node.node.nodeType === 'question' && node.revision.attributes['blocking'] === true) {
      issues.push({
        code: 'BLOCKING_QUESTION',
        severity: 'blocking',
        entityId: node.node.id,
        message: '存在尚未解决的阻塞问题。',
      });
    }
    if (node.revision.epistemicState === 'supported') {
      const hasEvidence = relations.some(
        (relation) =>
          relation.relation.relationType === 'supports' &&
          relation.relation.targetNodeId === node.node.id &&
          nodeById.get(relation.relation.sourceNodeId)?.node.nodeType === 'evidence',
      );
      if (!hasEvidence)
        issues.push({
          code: 'SUPPORTED_WITHOUT_EVIDENCE',
          severity: 'blocking',
          entityId: node.node.id,
          message: '标记为 supported 的节点必须有 evidence 支持关系。',
        });
    }
  }

  const parentCounts = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const relation of relations) {
    const { sourceNodeId, targetNodeId, relationType } = relation.relation;
    if (!nodeById.has(sourceNodeId) || !nodeById.has(targetNodeId)) {
      issues.push({
        code: 'RELATION_ENDPOINT_MISSING',
        severity: 'blocking',
        entityId: relation.relation.id,
        message: '关系端点不存在于当前 Working State。',
      });
    }
    if (relation.revision.reviewState !== 'clean') {
      issues.push({
        code: 'RELATION_REVIEW_REQUIRED',
        severity: 'blocking',
        entityId: relation.relation.id,
        message: '关系仍需复核，不能发布。',
      });
    }
    if (relationType === 'contains') {
      parentCounts.set(targetNodeId, (parentCounts.get(targetNodeId) ?? 0) + 1);
      const list = children.get(sourceNodeId) ?? [];
      list.push(targetNodeId);
      children.set(sourceNodeId, list);
    }
  }
  for (const [nodeId, count] of parentCounts) {
    if (count > 1)
      issues.push({
        code: 'CONTAINS_MULTIPLE_PARENTS',
        severity: 'blocking',
        entityId: nodeId,
        message: '一个节点不能有多个 contains 父节点。',
      });
  }
  for (const node of nodes) {
    const parentCount = parentCounts.get(node.node.id) ?? 0;
    const isRoot = hasDesignRootRole(node.revision.roles);
    if (!isRoot && parentCount === 0)
      issues.push({
        code: 'CONTAINS_PARENT_MISSING',
        severity: 'blocking',
        entityId: node.node.id,
        message: '非根节点必须通过 contains 关系挂到设计树中。',
      });
    if (isRoot && parentCount > 0)
      issues.push({
        code: 'ROOT_HAS_CONTAINS_PARENT',
        severity: 'blocking',
        entityId: node.node.id,
        message: '根节点不能再有 contains 父节点。',
      });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const child of children.get(nodeId) ?? []) if (visit(child)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if (nodes.some((node) => visit(node.node.id))) {
    issues.push({
      code: 'CONTAINS_CYCLE',
      severity: 'blocking',
      message: 'contains 关系不能形成环。',
    });
  }

  return { valid: !issues.some((issue) => issue.severity === 'blocking'), issues, checkedAt: now };
}
