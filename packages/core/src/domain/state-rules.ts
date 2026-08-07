import type {
  ApprovalState,
  Authorization,
  ChangeSetStatus,
  EpistemicState,
  NodeType,
  ProjectState,
  WorkflowRunStatus,
} from '@treediagram/contracts';
import {
  EPISTEMIC_NODE_TYPES,
  ROOT_ALLOWED_NODE_TYPES,
  type DecisionAttributes,
  type EvidenceAttributes,
} from '@treediagram/contracts';
import { DomainError } from '../errors.js';

/**
 * 状态迁移与治理写入规则（IMPLEMENTATION_DESIGN §4.6）。
 * 这些函数只做校验/计算下一状态，不触碰数据库。
 */

// ---- Project 状态机 ----

export type ProjectCommand =
  | 'adopt_first'
  | 'publish_first'
  | 'abandon_initializing'
  | 'save_candidate'
  | 'adopt'
  | 'block'
  | 'resume'
  | 'mark_ready'
  | 'publish'
  | 'abandon_with_base'
  | 'abandon_without_base';

export function nextProjectState(current: ProjectState, command: ProjectCommand): ProjectState {
  const table: Record<ProjectCommand, Partial<Record<ProjectState, ProjectState>>> = {
    adopt_first: { initializing: 'reevaluating' },
    publish_first: { initializing: 'consistent' },
    abandon_initializing: { initializing: 'initializing' },
    save_candidate: { consistent: 'consistent' },
    adopt: { consistent: 'reevaluating' },
    block: { reevaluating: 'blocked' },
    resume: { blocked: 'reevaluating' },
    mark_ready: { reevaluating: 'reevaluating' },
    publish: { reevaluating: 'consistent' },
    abandon_with_base: { reevaluating: 'consistent', blocked: 'consistent' },
    abandon_without_base: { reevaluating: 'initializing', blocked: 'initializing' },
  };
  const next = table[command][current];
  if (!next) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `project 状态 ${current} 不允许命令 ${command}`,
      {
        current,
        command,
      },
    );
  }
  return next;
}

// ---- ChangeSet 状态机 ----

export function assertChangeSetTransition(current: ChangeSetStatus, next: ChangeSetStatus): void {
  const allowed: Record<ChangeSetStatus, readonly ChangeSetStatus[]> = {
    open: ['reevaluating', 'abandoned'],
    reevaluating: ['reevaluating', 'ready', 'abandoned'],
    ready: ['reevaluating', 'published', 'abandoned'],
    published: [],
    abandoned: [],
  };
  if (!allowed[current].includes(next)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `changeSet 状态 ${current} 不允许迁移到 ${next}`,
      { current, next },
    );
  }
}

export const LIVE_CHANGE_SET_STATUSES = ['open', 'reevaluating', 'ready'] as const;

// ---- WorkflowRun 状态机 ----

export function assertWorkflowRunTransition(
  current: WorkflowRunStatus,
  next: WorkflowRunStatus,
): void {
  const allowed: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
    queued: ['running', 'cancelled', 'waiting_user'],
    running: ['succeeded', 'failed', 'waiting_user', 'cancelled'],
    waiting_user: ['running', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[current].includes(next)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `workflowRun 状态 ${current} 不允许迁移到 ${next}`,
      { current, next },
    );
  }
}

// ---- 治理/认知写入规则 ----

export interface RevisionWriteRules {
  nodeType: NodeType;
  roles: readonly string[];
  approvalState: ApprovalState;
  epistemicState: EpistemicState | null;
  authorization: Authorization | null;
  authorKind: 'user' | 'agent' | 'system';
  attributes: unknown;
}

/** 修订字段级领域校验（schema 之外）。 */
export function assertRevisionWriteAllowed(input: RevisionWriteRules): void {
  const isRoot = input.roles.includes('root');

  if (isRoot && !(ROOT_ALLOWED_NODE_TYPES as readonly string[]).includes(input.nodeType)) {
    throw new DomainError('VALIDATION_FAILED', '只有 claim/goal/constraint 可以携带 root 角色', {
      nodeType: input.nodeType,
    });
  }

  if (
    input.epistemicState !== null &&
    !(EPISTEMIC_NODE_TYPES as readonly string[]).includes(input.nodeType)
  ) {
    throw new DomainError('VALIDATION_FAILED', 'epistemic 状态仅适用于 claim/constraint/risk', {
      nodeType: input.nodeType,
      epistemicState: input.epistemicState,
    });
  }

  // authorization 与 approval 的绑定（§5.2 注释：ai_confirmed 时必须为 {workflowRunId, policyId}，其他状态必须为 null）。
  if (input.approvalState === 'ai_confirmed') {
    if (!input.authorization) {
      throw new DomainError(
        'AI_SCOPE_VIOLATION',
        'ai_confirmed 必须携带 workflowRunId 与 policyId 授权',
      );
    }
    if (input.authorKind !== 'agent') {
      throw new DomainError('AI_SCOPE_VIOLATION', 'ai_confirmed 只能由 agent 主体写入');
    }
  } else if (input.authorization !== null) {
    throw new DomainError('VALIDATION_FAILED', '非 ai_confirmed 状态不得携带 authorization', {
      approvalState: input.approvalState,
    });
  }

  if (input.authorKind === 'agent' && input.approvalState === 'user_confirmed') {
    throw new DomainError('AI_SCOPE_VIOLATION', 'Agent 永远不能创建 user_confirmed');
  }

  if (isRoot && input.approvalState === 'ai_confirmed') {
    throw new DomainError('ROOT_REQUIRES_USER_CONFIRMATION', 'root 不能由 AI 确认');
  }
}

/** Evidence attributes 领域规则（§4.2）。 */
export function assertEvidenceAttributesValid(attributes: unknown): void {
  const attrs = attributes as EvidenceAttributes;
  if (attrs.evidenceKind === 'imported_material' && !attrs.sourceAssetId) {
    throw new DomainError('VALIDATION_FAILED', 'imported_material 必须引用 sourceAssetId');
  }
  if (attrs.evidenceKind === 'agent_argument' || attrs.evidenceKind === 'thought_experiment') {
    if (attrs.method.trim().length === 0) {
      throw new DomainError('VALIDATION_FAILED', `${attrs.evidenceKind} 必须提供非空 method`);
    }
    if (attrs.premises.length === 0) {
      throw new DomainError('VALIDATION_FAILED', `${attrs.evidenceKind} 至少需要一个 premise`);
    }
    if (attrs.limitations.length === 0) {
      throw new DomainError('VALIDATION_FAILED', `${attrs.evidenceKind} 至少需要一个 limitation`);
    }
  }
}

/** Decision attributes 领域规则（§4.5 规则 3/4 的写入侧）。 */
export function assertDecisionAttributesValid(attributes: unknown, contentText: string): void {
  const attrs = attributes as DecisionAttributes;
  if (attrs.importance === 'important') {
    if (
      attrs.noAlternativeFound &&
      (!attrs.alternativeSearchNote || attrs.alternativeSearchNote.trim().length === 0)
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'noAlternativeFound=true 的重要决策必须提供 alternativeSearchNote',
      );
    }
    if (contentText.trim().length === 0) {
      throw new DomainError('VALIDATION_FAILED', '重要决策的 contentText 必须包含理由，不允许空白');
    }
  }
}

/** 按类型分发 attributes 领域规则。 */
export function assertTypeAttributeRules(
  nodeType: NodeType,
  attributes: unknown,
  contentText: string,
): void {
  if (nodeType === 'evidence') assertEvidenceAttributesValid(attributes);
  if (nodeType === 'decision') assertDecisionAttributesValid(attributes, contentText);
}
