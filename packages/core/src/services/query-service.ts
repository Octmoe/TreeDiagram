import type {
  ApprovalState,
  EpistemicState,
  EventRecord,
  NodeDetail,
  NodeType,
  QueryNodesResponse,
  RelationDetail,
  TreeResponse,
  ViewMode,
} from '@treediagram/contracts';
import type { NodeId, RelationId } from '@treediagram/contracts';
import type { ServiceContext } from './types.js';
import { ChangeSetService } from './change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import type { WorkingSet } from '../domain/working-set.js';

export interface QueryFilters {
  type: NodeType | null;
  role: string | null;
  approval: ApprovalState | null;
  epistemic: EpistemicState | null;
  text: string | null;
  limit: number;
  cursor: string | null;
}

/**
 * 只读查询服务（IMPLEMENTATION_DESIGN §7.6）：release 与 working 两种视图。
 * 树查询只返回展开层级需要的节点；关系查询默认一跳；文本搜索使用 FTS5（LIKE 回退）。
 */
export class QueryService {
  private readonly changeSets: ChangeSetService;

  constructor(private readonly ctx: ServiceContext) {
    this.changeSets = new ChangeSetService(ctx);
  }

  private get db() {
    return this.ctx.db;
  }

  resolveView(project: ProjectRecord, view: ViewMode): WorkingSet {
    if (view === 'working') {
      const live = this.changeSets.getLive(project);
      if (live) return this.changeSets.buildViews(live).working;
    }
    return this.changeSets.buildReleaseView(project);
  }

  /** 树切片：从顶层（或指定父节点）展开 depth 层，只返回所需节点与 contains 边。 */
  getTree(
    project: ProjectRecord,
    view: ViewMode,
    parentNodeId: string | null,
    depth: number,
  ): TreeResponse {
    const ws = this.resolveView(project, view);

    const containsEdges: Array<{ relationId: RelationId; fromNode: NodeId; toNode: NodeId }> = [];
    const revisionToNode = new Map<string, NodeId>();
    for (const [nodeId, revision] of ws.nodeRevisionByNodeId)
      revisionToNode.set(revision.id, nodeId);
    for (const [relationId, revision] of ws.relationRevisionByRelationId) {
      if (ws.relationById.get(relationId)?.relationType !== 'contains') continue;
      const fromNode = revisionToNode.get(revision.fromNodeRevisionId);
      const toNode = revisionToNode.get(revision.toNodeRevisionId);
      if (fromNode && toNode) containsEdges.push({ relationId, fromNode, toNode });
    }
    const childrenOf = new Map<NodeId, NodeId[]>();
    for (const edge of containsEdges) {
      const list = childrenOf.get(edge.fromNode) ?? [];
      list.push(edge.toNode);
      childrenOf.set(edge.fromNode, list);
    }
    const hasParent = new Set(containsEdges.map((e) => e.toNode));

    let frontier: NodeId[];
    if (parentNodeId) {
      frontier = childrenOf.get(parentNodeId as NodeId) ?? [];
    } else {
      frontier = [...ws.nodeById.keys()].filter((id) => !hasParent.has(id));
    }

    const included = new Set<NodeId>();
    let level = frontier;
    for (let d = 0; d < depth && level.length > 0; d++) {
      const next: NodeId[] = [];
      for (const id of level) {
        if (included.has(id)) continue;
        included.add(id);
        next.push(...(childrenOf.get(id) ?? []));
      }
      level = next;
    }

    const nodes: NodeDetail[] = [];
    for (const id of included) {
      const node = ws.nodeById.get(id);
      const revision = ws.nodeRevisionByNodeId.get(id);
      if (node && revision) nodes.push({ node, revision });
    }
    nodes.sort((a, b) => a.revision.displayTitle.localeCompare(b.revision.displayTitle));

    const relations: RelationDetail[] = [];
    for (const edge of containsEdges) {
      if (included.has(edge.fromNode) && included.has(edge.toNode)) {
        const relation = ws.relationById.get(edge.relationId);
        const revision = ws.relationRevisionByRelationId.get(edge.relationId);
        if (relation && revision) relations.push({ relation, revision });
      }
    }
    if (parentNodeId) {
      // 包含父节点与传入父边，便于 UI 定位。
      const parent = ws.nodeById.get(parentNodeId as NodeId);
      const parentRevision = ws.nodeRevisionByNodeId.get(parentNodeId as NodeId);
      if (parent && parentRevision && !included.has(parentNodeId as NodeId)) {
        nodes.unshift({ node: parent, revision: parentRevision });
      }
    }
    return { view, nodes, relations };
  }

  /** 结构化查询：类型/角色/治理/认知过滤 + FTS 文本搜索。 */
  queryNodes(project: ProjectRecord, view: ViewMode, filters: QueryFilters): QueryNodesResponse {
    const ws = this.resolveView(project, view);
    let details: NodeDetail[] = [];
    for (const [nodeId, node] of ws.nodeById) {
      const revision = ws.nodeRevisionByNodeId.get(nodeId);
      if (!revision) continue;
      if (filters.type && node.nodeType !== filters.type) continue;
      if (filters.role && !revision.roles.includes(filters.role)) continue;
      if (filters.approval && revision.approvalState !== filters.approval) continue;
      if (filters.epistemic && revision.epistemicState !== filters.epistemic) continue;
      details.push({ node, revision });
    }

    if (filters.text) {
      const matched = this.textSearch(filters.text);
      const byId = new Map(details.map((d) => [d.revision.id, d] as const));
      details = [];
      for (const id of matched) {
        const detail = byId.get(id as NodeDetail['revision']['id']);
        if (detail) details.push(detail);
      }
    } else {
      details.sort((a, b) => a.revision.createdAt.localeCompare(b.revision.createdAt));
    }

    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    const page = details.slice(offset, offset + filters.limit);
    const nextCursor =
      offset + filters.limit < details.length ? String(offset + filters.limit) : null;
    return { nodes: page, nextCursor };
  }

  /** FTS5 搜索；解析失败时回退 LIKE 并记录日志（§7.6）。 */
  private textSearch(text: string): string[] {
    const tokens = text
      .split(/\s+/)
      .map((t) => t.replace(/["'*()]/g, '').trim())
      .filter((t) => t.length > 0)
      .slice(0, 10);
    if (tokens.length === 0) return [];
    const matchQuery = tokens.map((t) => `"${t}"`).join(' AND ');
    try {
      return this.db.repos.node.ftsSearch(matchQuery, 500);
    } catch (error) {
      console.warn('[treediagram] FTS5 查询失败，回退 LIKE', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.db.repos.node.likeSearch(tokens, 500);
    }
  }

  getEvents(
    project: ProjectRecord,
    after: number,
    limit: number,
  ): { events: EventRecord[]; nextCursor: number } {
    const events = this.db.repos.event.list(project.id, after, limit);
    const nextCursor =
      events.length > 0 ? (events[events.length - 1] as EventRecord).cursor : after;
    return { events, nextCursor };
  }
}
