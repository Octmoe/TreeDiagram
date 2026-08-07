import type { NodeId, ReviewItem } from '@treediagram/contracts';
import type { WorkingSet } from '../domain/working-set.js';
import { endpointNodeId } from '../domain/working-set.js';

/**
 * 复核批次排序（IMPLEMENTATION_DESIGN §12.5）：
 * 批次按 depends_on 强连通分量的逆依赖顺序处理——被依赖者先复核，依赖者后复核。
 * node 类型的 item 映射到其逻辑节点；relation 类型的 item 映射到 from 端节点（回退 to 端）。
 * 同 SCC 内与无关节点保持仓库返回的稳定顺序（created_at 升序）。
 */

function representativeNode(ws: WorkingSet, item: ReviewItem): NodeId | null {
  if (!item.entityRevisionId) return null;
  if (item.entityKind === 'node_revision') {
    for (const [nodeId, revision] of ws.nodeRevisionByNodeId) {
      if (revision.id === item.entityRevisionId) return nodeId;
    }
    // 被替代的修订：通过全部关系端点反查不到，放弃映射
    return null;
  }
  for (const revision of ws.relationRevisionByRelationId.values()) {
    if (revision.id === item.entityRevisionId) {
      return (
        endpointNodeId(ws, revision.fromNodeRevisionId) ??
        endpointNodeId(ws, revision.toNodeRevisionId)
      );
    }
  }
  return null;
}

export function orderReviewItemsByDependency(
  items: readonly ReviewItem[],
  ws: WorkingSet,
): ReviewItem[] {
  const nodeOfItem = new Map<string, NodeId | null>();
  const involved = new Set<NodeId>();
  for (const item of items) {
    const nodeId = representativeNode(ws, item);
    nodeOfItem.set(item.id, nodeId);
    if (nodeId) involved.add(nodeId);
  }
  if (involved.size === 0) return [...items];

  // 处理序边：B -> A 当且仅当 A depends_on B（被依赖者 B 先处理）。
  const successors = new Map<NodeId, NodeId[]>();
  const addEdge = (from: NodeId, to: NodeId) => {
    const list = successors.get(from) ?? [];
    list.push(to);
    successors.set(from, list);
  };
  for (const [relationId, revision] of ws.relationRevisionByRelationId) {
    if (ws.relationById.get(relationId)?.relationType !== 'depends_on') continue;
    const dependent = endpointNodeId(ws, revision.fromNodeRevisionId);
    const dependency = endpointNodeId(ws, revision.toNodeRevisionId);
    if (!dependent || !dependency) continue;
    if (!involved.has(dependent) || !involved.has(dependency)) continue;
    if (dependent === dependency) continue;
    addEdge(dependency, dependent);
  }

  // Tarjan SCC
  const indexOf = new Map<NodeId, number>();
  const lowLink = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const sccs: NodeId[][] = [];
  let nextIndex = 0;

  const strongConnect = (v: NodeId): void => {
    indexOf.set(v, nextIndex);
    lowLink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of [...(successors.get(v) ?? [])].sort()) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        lowLink.set(v, Math.min(lowLink.get(v)!, lowLink.get(w)!));
      } else if (onStack.has(w)) {
        lowLink.set(v, Math.min(lowLink.get(v)!, indexOf.get(w)!));
      }
    }
    if (lowLink.get(v) === indexOf.get(v)) {
      const scc: NodeId[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      sccs.push(scc);
    }
  };
  for (const v of [...involved].sort()) {
    if (!indexOf.has(v)) strongConnect(v);
  }

  // 凝聚图拓扑排序（依赖者先）：Kahn，确定性 tie-break 按最小节点 id。
  const sccOfNode = new Map<NodeId, number>();
  sccs.forEach((scc, i) => scc.forEach((n) => sccOfNode.set(n, i)));
  const indegree = new Array<number>(sccs.length).fill(0);
  const sccEdges = new Map<number, Set<number>>();
  for (const [from, tos] of successors) {
    const fromScc = sccOfNode.get(from)!;
    for (const to of tos) {
      const toScc = sccOfNode.get(to)!;
      if (fromScc !== toScc && !sccEdges.get(fromScc)?.has(toScc)) {
        if (!sccEdges.has(fromScc)) sccEdges.set(fromScc, new Set());
        sccEdges.get(fromScc)!.add(toScc);
        indegree[toScc]! += 1;
      }
    }
  }
  const sccOrder: number[] = [];
  // 确定性：按 SCC 内最小节点 id 字典序排序
  const sccKey = (i: number) => sccs[i]!.map(String).sort()[0]!;
  const ready = sccs
    .map((_, i) => i)
    .filter((i) => indegree[i] === 0)
    .sort((a, b) => sccKey(a).localeCompare(sccKey(b)));
  while (ready.length > 0) {
    const current = ready.shift()!;
    sccOrder.push(current);
    for (const next of [...(sccEdges.get(current) ?? [])].sort((a, b) =>
      sccKey(a).localeCompare(sccKey(b)),
    )) {
      indegree[next]! -= 1;
      if (indegree[next] === 0) {
        ready.push(next);
        ready.sort((a, b) => sccKey(a).localeCompare(sccKey(b)));
      }
    }
  }

  const nodeRank = new Map<NodeId, number>();
  sccOrder.forEach((sccId, rank) => sccs[sccId]!.forEach((n) => nodeRank.set(n, rank)));

  // 稳定排序：无映射 item 保持原位在前；其余按 SCC 秩、组内保持原顺序。
  return [...items].sort((a, b) => {
    const na = nodeOfItem.get(a.id) ?? null;
    const nb = nodeOfItem.get(b.id) ?? null;
    const ra = na === null ? -1 : (nodeRank.get(na) ?? -1);
    const rb = nb === null ? -1 : (nodeRank.get(nb) ?? -1);
    return ra - rb; // 同秩保持原顺序（Array.prototype.sort 稳定）
  });
}
