import type { DelegationMode, DelegationPolicy, NodeId } from '@treediagram/contracts';
import { containsParentsOf, type WorkingSet } from './working-set.js';

export interface DelegationResolutionResult {
  nodeId: NodeId;
  mode: DelegationMode;
  policyId: string | null;
  inheritedFromNodeId: NodeId | null;
  explicitPolicy: DelegationPolicy | null;
  warnings: string[];
}

/**
 * AI 托管解析（IMPLEMENTATION_DESIGN §10）：
 * 沿 contains 唯一父链向上找最近的未撤销显式 policy；无 policy 默认 human_final；
 * 结构不一致（多父/环）时返回 human_final 并产生 warning。
 */
export function resolveDelegation(
  nodeId: NodeId,
  workingSet: WorkingSet,
  activePolicies: readonly DelegationPolicy[],
): DelegationResolutionResult {
  const warnings: string[] = [];
  const policyByScope = new Map(activePolicies.map((p) => [p.scopeNodeId, p]));

  const explicit = policyByScope.get(nodeId) ?? null;
  let cursor: NodeId | null = nodeId;
  const visited = new Set<NodeId>();

  while (cursor !== null) {
    if (visited.has(cursor)) {
      warnings.push('contains 父链存在环，托管解析回退 human_final');
      return {
        nodeId,
        mode: 'human_final',
        policyId: null,
        inheritedFromNodeId: null,
        explicitPolicy: null,
        warnings,
      };
    }
    visited.add(cursor);

    const policy = policyByScope.get(cursor);
    if (policy) {
      return {
        nodeId,
        mode: policy.mode,
        policyId: policy.id,
        inheritedFromNodeId: cursor === nodeId ? null : cursor,
        explicitPolicy: explicit,
        warnings,
      };
    }

    const parents = containsParentsOf(workingSet, cursor);
    if (parents.length === 0) {
      cursor = null;
    } else if (parents.length > 1) {
      warnings.push('节点存在多个 contains 父，托管解析回退 human_final');
      return {
        nodeId,
        mode: 'human_final',
        policyId: null,
        inheritedFromNodeId: null,
        explicitPolicy: explicit,
        warnings,
      };
    } else {
      cursor = parents[0] as NodeId;
    }
  }

  return {
    nodeId,
    mode: 'human_final',
    policyId: null,
    inheritedFromNodeId: null,
    explicitPolicy: explicit,
    warnings,
  };
}
