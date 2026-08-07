import type { NodeType, RelationType } from '@treediagram/contracts';

/**
 * 关系端点类型矩阵（IMPLEMENTATION_DESIGN §4.4）。
 * 返回错误消息；null 表示合法。
 */
export function validateRelationEndpointTypes(
  relationType: RelationType,
  fromType: NodeType,
  toType: NodeType,
): string | null {
  switch (relationType) {
    case 'contains':
    case 'depends_on':
    case 'derived_from':
      return null;
    case 'supports': {
      if (fromType !== 'evidence') return 'supports 的 from 必须是 evidence';
      if (!['claim', 'constraint', 'risk'].includes(toType))
        return 'supports 的 to 必须是 claim/constraint/risk';
      return null;
    }
    case 'contradicts': {
      if (fromType === 'topic' || toType === 'topic')
        return 'contradicts 的两端都不能是 topic';
      return null;
    }
    case 'constrains': {
      if (fromType !== 'constraint') return 'constrains 的 from 必须是 constraint';
      if (toType === 'evidence') return 'constrains 的 to 不能是 evidence';
      return null;
    }
    case 'addresses': {
      if (!['option', 'decision', 'validation_method'].includes(fromType))
        return 'addresses 的 from 必须是 option/decision/validation_method';
      if (toType !== 'question') return 'addresses 的 to 必须是 question';
      return null;
    }
    case 'selects':
    case 'rejects': {
      if (fromType !== 'decision') return `${relationType} 的 from 必须是 decision`;
      if (toType !== 'option') return `${relationType} 的 to 必须是 option`;
      return null;
    }
    case 'supersedes': {
      // V1 兼容定义：同一内核类型（§4.4 “同类或兼容设计节点”）。
      if (fromType !== toType) return 'supersedes 的两端必须是同一内核类型';
      return null;
    }
  }
}

/** 反向 depends_on 遍历用于影响分析的关系集合（§9.1）。 */
export const IMPACT_REVERSE_TRAVERSAL_TYPES = [
  'depends_on',
  'derived_from',
  'supports',
  'constrains',
  'addresses',
] as const satisfies readonly RelationType[];
