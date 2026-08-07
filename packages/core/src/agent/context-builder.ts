import type { NodeDetail, RelationDetail, SourceAsset } from '@treediagram/contracts';
import type { NodeId } from '@treediagram/contracts';
import type { WorkingSet } from '../domain/working-set.js';
import { endpointNodeId } from '../domain/working-set.js';

/**
 * ContextBuilder（IMPLEMENTATION_DESIGN §12.3/§12.6）：
 * 确定性代码查询数据库构建完整上下文；Source、节点正文、Evidence 等不可信内容
 * 一律放入独立 JSON data 字段，绝不拼接成 system/developer 指令。
 */

export interface UntrustedNodeView {
  nodeId: string;
  revisionId: string;
  nodeType: string;
  displayTitle: string;
  contentText: string;
  roles: string[];
  approvalState: string;
  epistemicState: string | null;
  attributes: Record<string, unknown>;
}

export interface UntrustedRelationView {
  relationId: string;
  revisionId: string;
  relationType: string;
  fromNodeId: string;
  toNodeId: string;
  rationaleText: string;
  approvalState: string;
}

export function nodeViewOf(ws: WorkingSet, nodeId: NodeId): UntrustedNodeView | null {
  const node = ws.nodeById.get(nodeId);
  const revision = ws.nodeRevisionByNodeId.get(nodeId);
  if (!node || !revision) return null;
  return {
    nodeId: node.id,
    revisionId: revision.id,
    nodeType: node.nodeType,
    displayTitle: revision.displayTitle,
    contentText: revision.contentText,
    roles: revision.roles,
    approvalState: revision.approvalState,
    epistemicState: revision.epistemicState,
    attributes: revision.attributes as Record<string, unknown>,
  };
}

function relationViewOf(ws: WorkingSet, detail: RelationDetail): UntrustedRelationView | null {
  const fromNodeId = endpointNodeId(ws, detail.revision.fromNodeRevisionId);
  const toNodeId = endpointNodeId(ws, detail.revision.toNodeRevisionId);
  if (!fromNodeId || !toNodeId) return null;
  return {
    relationId: detail.relation.id,
    revisionId: detail.revision.id,
    relationType: detail.relation.relationType,
    fromNodeId,
    toNodeId,
    rationaleText: detail.revision.rationaleText,
    approvalState: detail.revision.approvalState,
  };
}

/** 祖先链：沿 contains 边向上（多级，去环）。 */
function ancestorChainOf(ws: WorkingSet, nodeId: NodeId): UntrustedNodeView[] {
  const chain: UntrustedNodeView[] = [];
  const visited = new Set<string>([nodeId]);
  let current: NodeId | undefined = nodeId;
  while (current) {
    let parent: NodeId | undefined;
    for (const [relationId, revision] of ws.relationRevisionByRelationId) {
      if (ws.relationById.get(relationId)?.relationType !== 'contains') continue;
      const toNode = endpointNodeId(ws, revision.toNodeRevisionId);
      if (toNode !== current) continue;
      const fromNode = endpointNodeId(ws, revision.fromNodeRevisionId);
      if (fromNode && !visited.has(fromNode)) {
        parent = fromNode;
        break;
      }
    }
    if (!parent) break;
    visited.add(parent);
    const view = nodeViewOf(ws, parent);
    if (view) chain.push(view);
    current = parent;
  }
  return chain;
}

/** Initialize 上下文（§13.1）：全部指定 Source 原文。 */
export function buildInitializeContext(sources: SourceAsset[]): Record<string, unknown> {
  return {
    task: 'initialize',
    data: {
      sources: sources.map((s) => ({
        sourceAssetId: s.id,
        kind: s.kind,
        originalName: s.originalName,
        contentText: s.contentText,
      })),
    },
  };
}

/** Derive 上下文（§13.2）：roots、祖先链、一跳关系、直接子节点摘要、相关 evidence/constraint/decision。 */ export function buildDeriveContext(
  ws: WorkingSet,
  targetNodeId: NodeId,
  focusInstruction: string | null,
): Record<string, unknown> {
  const target = nodeViewOf(ws, targetNodeId);
  const roots: UntrustedNodeView[] = [];
  for (const [id] of ws.nodeById) {
    const view = nodeViewOf(ws, id);
    if (view?.roles.includes('root')) roots.push(view);
  }
  const ancestors = ancestorChainOf(ws, targetNodeId);

  const oneHopRelations: UntrustedRelationView[] = [];
  const children: UntrustedNodeView[] = [];
  const related: UntrustedNodeView[] = [];
  for (const [relationId, revision] of ws.relationRevisionByRelationId) {
    const relation = ws.relationById.get(relationId);
    if (!relation) continue;
    const fromNode = endpointNodeId(ws, revision.fromNodeRevisionId);
    const toNode = endpointNodeId(ws, revision.toNodeRevisionId);
    if (!fromNode || !toNode) continue;
    if (fromNode !== targetNodeId && toNode !== targetNodeId) continue;
    const view = relationViewOf(ws, { relation, revision });
    if (view) oneHopRelations.push(view);
    if (relation.relationType === 'contains' && fromNode === targetNodeId) {
      const child = nodeViewOf(ws, toNode);
      if (child) children.push(child);
    }
    const other = fromNode === targetNodeId ? toNode : fromNode;
    const otherNode = ws.nodeById.get(other);
    if (
      otherNode &&
      ['evidence', 'constraint', 'decision'].includes(otherNode.nodeType) &&
      other !== targetNodeId
    ) {
      const relatedView = nodeViewOf(ws, other);
      if (relatedView) related.push(relatedView);
    }
  }

  return {
    task: 'derive',
    data: {
      focusInstruction,
      target,
      roots,
      ancestors,
      oneHopRelations,
      children: children.map((c) => ({
        ...c,
        contentText: c.contentText.slice(0, 500), // 子节点摘要
      })),
      related,
    },
  };
}

/** 目标节点的 contains 子树（BFS，去环）。 */
function subtreeOf(
  ws: WorkingSet,
  rootId: NodeId,
): {
  nodes: UntrustedNodeView[];
  nodeIds: Set<string>;
} {
  const nodeIds = new Set<string>([rootId]);
  const nodes: UntrustedNodeView[] = [];
  const queue: NodeId[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const view = nodeViewOf(ws, current);
    if (view) nodes.push(view);
    for (const [relationId, revision] of ws.relationRevisionByRelationId) {
      if (ws.relationById.get(relationId)?.relationType !== 'contains') continue;
      const fromNode = endpointNodeId(ws, revision.fromNodeRevisionId);
      const toNode = endpointNodeId(ws, revision.toNodeRevisionId);
      if (fromNode === current && toNode && !nodeIds.has(toNode)) {
        nodeIds.add(toNode);
        queue.push(toNode);
      }
    }
  }
  return { nodes, nodeIds };
}

/** Grill 上下文（§13.3）：目标子树全量 + roots + 跨分支关系。 */
export function buildGrillContext(
  ws: WorkingSet,
  targetNodeId: NodeId,
  focusInstruction: string | null,
): Record<string, unknown> {
  const { nodes: subtree, nodeIds } = subtreeOf(ws, targetNodeId);
  const roots: UntrustedNodeView[] = [];
  for (const [id] of ws.nodeById) {
    const view = nodeViewOf(ws, id);
    if (view?.roles.includes('root')) roots.push(view);
  }
  const ancestors = ancestorChainOf(ws, targetNodeId);
  const crossBranchRelations: UntrustedRelationView[] = [];
  for (const [relationId, revision] of ws.relationRevisionByRelationId) {
    const relation = ws.relationById.get(relationId);
    if (!relation) continue;
    const fromNode = endpointNodeId(ws, revision.fromNodeRevisionId);
    const toNode = endpointNodeId(ws, revision.toNodeRevisionId);
    if (!fromNode || !toNode) continue;
    const fromInside = nodeIds.has(fromNode);
    const toInside = nodeIds.has(toNode);
    if (fromInside === toInside) continue; // 只保留跨界关系
    const view = relationViewOf(ws, { relation, revision });
    if (view) crossBranchRelations.push(view);
  }
  return {
    task: 'grill',
    data: {
      focusInstruction,
      target: nodeViewOf(ws, targetNodeId),
      roots,
      ancestors,
      subtree,
      crossBranchRelations,
    },
  };
}

/** Unbox 上下文（§13.4）：roots、全部非 root 约束、顶层结构摘要、探索容器。 */ export function buildUnboxContext(
  ws: WorkingSet,
  container: { nodeId: string; revisionId: string },
  focusInstruction: string | null,
): Record<string, unknown> {
  const roots: UntrustedNodeView[] = [];
  const constraints: UntrustedNodeView[] = [];
  for (const [id] of ws.nodeById) {
    const view = nodeViewOf(ws, id);
    if (!view) continue;
    if (view.roles.includes('root')) roots.push(view);
    else if (view.nodeType === 'constraint') constraints.push(view);
  }
  const rootIds = new Set(roots.map((r) => r.nodeId));
  const topLevel: UntrustedNodeView[] = [];
  for (const [relationId, revision] of ws.relationRevisionByRelationId) {
    if (ws.relationById.get(relationId)?.relationType !== 'contains') continue;
    const fromNode = endpointNodeId(ws, revision.fromNodeRevisionId);
    const toNode = endpointNodeId(ws, revision.toNodeRevisionId);
    if (!fromNode || !toNode || !rootIds.has(fromNode)) continue;
    const child = nodeViewOf(ws, toNode);
    if (child) {
      topLevel.push({ ...child, contentText: child.contentText.slice(0, 500) });
    }
  }
  return {
    task: 'unbox',
    data: {
      focusInstruction,
      container,
      roots,
      constraints,
      topLevel,
    },
  };
}

/** 单个 review item 的不可信视图（由调用方从数据库组装，含被替代修订的内容）。 */
export interface ReevaluationItemView {
  reviewItemId: string;
  entityKind: string;
  reasonCode: string;
  /** node item：节点修订内容；relation item：关系修订内容与端点标题。 */
  entity: Record<string, unknown> | null;
}

/** Reevaluate 批次上下文（§13.5）：批次 item 全量内容 + roots 定向。 */
export function buildReevaluationContext(
  changeSetId: string,
  roots: UntrustedNodeView[],
  items: ReevaluationItemView[],
): Record<string, unknown> {
  return {
    task: 'reevaluate',
    data: {
      changeSetId,
      roots,
      items,
    },
  };
}
