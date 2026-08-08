import { Value } from '@sinclair/typebox/value';
import {
  DesignProposalSchema,
  asId,
  type ChangeSetId,
  type ConsistencyIssue,
  type DelegationPolicy,
  type DesignProposal,
  type Node,
  type NodeId,
  type NodeRevision,
  type ProjectId,
  type Relation,
  type RelationId,
  type RelationRevision,
} from '@treediagram/contracts';
import { checkConsistency } from '../domain/consistency-checker.js';
import type { WorkingSet } from '../domain/working-set.js';
import { DomainError } from '../errors.js';

export interface ProposalInteractionRequest {
  issueKey: string;
  questionText: string;
  rationaleText: string;
  relatedRefs: string[];
}

export interface ProposalPreflightResult {
  projected: WorkingSet;
  issues: ConsistencyIssue[];
  newBlockingIssues: ConsistencyIssue[];
  hardBlockingIssues: ConsistencyIssue[];
  approvalIssues: ConsistencyIssue[];
  interactionRequests: ProposalInteractionRequest[];
}

export interface ProposalPreflightInput {
  projectId: ProjectId;
  workingSet: WorkingSet;
  proposal: unknown;
  reviewCounts: { pending: number; blocked: number };
  policies: readonly DelegationPolicy[];
}

const SYNTHETIC_CHANGE_SET_ID = asId<ChangeSetId>('00000000-0000-4000-8000-000000000000');
const APPROVAL_CODES = new Set(['ROOT_NOT_USER_CONFIRMED']);
const INTERACTION_CODES = new Set(['BLOCKING_QUESTION', 'BLOCKING_CONTRADICTION']);

function assertProposal(value: unknown): asserts value is DesignProposal {
  if (Value.Check(DesignProposalSchema, value)) return;
  const first = [...Value.Errors(DesignProposalSchema, value)][0];
  throw new DomainError('MODEL_OUTPUT_INVALID', 'preflight proposal 未通过 schema 校验', {
    path: first?.path,
    message: first?.message,
  });
}

function syntheticId(kind: string, ref: string): string {
  return `proposal:${kind}:${ref}`;
}

function issueKey(issue: ConsistencyIssue): string {
  return `${issue.code}|${issue.entityKind}|${issue.entityRevisionId ?? ''}`;
}

/**
 * 纯内存投影模型提案。它不会创建 ChangeSet 或写入任何领域实体，因而可安全地在
 * 用户澄清和自动修复之前运行完整一致性检查。
 */
export function preflightProposal(input: ProposalPreflightInput): ProposalPreflightResult {
  assertProposal(input.proposal);
  const proposal = input.proposal;
  const nodeById = new Map(input.workingSet.nodeById);
  const relationById = new Map(input.workingSet.relationById);
  const nodeRevisionByNodeId = new Map(input.workingSet.nodeRevisionByNodeId);
  const relationRevisionByRelationId = new Map(input.workingSet.relationRevisionByRelationId);
  const nodeRevisionByRef = new Map<string, string>();
  const relationRevisionByRef = new Map<string, string>();
  const refs = new Set<string>();

  for (const action of [...proposal.nodeActions, ...proposal.relationActions]) {
    if (refs.has(action.proposalRef)) {
      throw new DomainError('MODEL_OUTPUT_INVALID', 'proposalRef 重复', {
        proposalRef: action.proposalRef,
      });
    }
    refs.add(action.proposalRef);
  }

  for (const action of proposal.nodeActions) {
    let nodeId: NodeId;
    let revisionNumber = 1;
    let supersedesRevisionId = null;
    if (action.operation === 'create') {
      nodeId = asId<NodeId>(syntheticId('node', action.proposalRef));
      const node: Node = {
        id: nodeId,
        projectId: input.projectId,
        nodeType: action.nodeType,
        authorKind: 'agent',
        authorRef: 'preflight',
        createdAt: '1970-01-01T00:00:00.000Z',
      };
      nodeById.set(nodeId, node);
    } else {
      if (!action.logicalNodeId || !action.baseRevisionId) {
        throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 缺少 node/base revision', {
          proposalRef: action.proposalRef,
        });
      }
      nodeId = action.logicalNodeId;
      const node = nodeById.get(nodeId);
      const base = nodeRevisionByNodeId.get(nodeId);
      if (
        !node ||
        !base ||
        base.id !== action.baseRevisionId ||
        node.nodeType !== action.nodeType
      ) {
        throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 节点不是当前活动基线', {
          proposalRef: action.proposalRef,
          logicalNodeId: action.logicalNodeId,
          baseRevisionId: action.baseRevisionId,
        });
      }
      revisionNumber = base.revisionNumber + 1;
      supersedesRevisionId = base.id;
    }
    const revisionId = asId<NodeRevision['id']>(syntheticId('node-revision', action.proposalRef));
    const revision: NodeRevision = {
      id: revisionId,
      nodeId,
      createdInChangeSetId: SYNTHETIC_CHANGE_SET_ID,
      revisionNumber,
      displayTitle: action.displayTitle,
      contentText: action.contentText,
      roles: action.roles,
      attributes: action.attributes ?? {},
      approvalState:
        action.approvalSuggestion === 'ai_confirmed' ? 'tentative' : action.approvalSuggestion,
      epistemicState: action.epistemicState,
      authorization: null,
      supersedesRevisionId,
      authorKind: 'agent',
      authorRef: 'preflight',
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    nodeRevisionByNodeId.set(nodeId, revision);
    nodeRevisionByRef.set(action.proposalRef, revisionId);
  }

  const resolveEndpoint = (endpoint: { refKind: string; ref: string }): string => {
    if (endpoint.refKind === 'proposal') {
      const revisionId = nodeRevisionByRef.get(endpoint.ref);
      if (!revisionId) {
        throw new DomainError('MODEL_OUTPUT_INVALID', '关系引用未知 proposal node ref', {
          ref: endpoint.ref,
        });
      }
      return revisionId;
    }
    return endpoint.ref;
  };

  for (const action of proposal.relationActions) {
    let relationId: RelationId;
    let revisionNumber = 1;
    let supersedesRelationRevisionId = null;
    if (action.operation === 'create') {
      relationId = asId<RelationId>(syntheticId('relation', action.proposalRef));
      const relation: Relation = {
        id: relationId,
        projectId: input.projectId,
        relationType: action.relationType,
        authorKind: 'agent',
        authorRef: 'preflight',
        createdAt: '1970-01-01T00:00:00.000Z',
      };
      relationById.set(relationId, relation);
    } else {
      if (!action.logicalRelationId || !action.baseRelationRevisionId) {
        throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 缺少 relation/base revision', {
          proposalRef: action.proposalRef,
        });
      }
      relationId = action.logicalRelationId;
      const relation = relationById.get(relationId);
      const base = relationRevisionByRelationId.get(relationId);
      if (
        !relation ||
        !base ||
        base.id !== action.baseRelationRevisionId ||
        relation.relationType !== action.relationType
      ) {
        throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 关系不是当前活动基线', {
          proposalRef: action.proposalRef,
          logicalRelationId: action.logicalRelationId,
          baseRelationRevisionId: action.baseRelationRevisionId,
        });
      }
      revisionNumber = base.revisionNumber + 1;
      supersedesRelationRevisionId = base.id;
    }
    const revisionId = asId<RelationRevision['id']>(
      syntheticId('relation-revision', action.proposalRef),
    );
    relationRevisionByRelationId.set(relationId, {
      id: revisionId,
      relationId,
      createdInChangeSetId: SYNTHETIC_CHANGE_SET_ID,
      revisionNumber,
      fromNodeRevisionId: asId(resolveEndpoint(action.from)),
      toNodeRevisionId: asId(resolveEndpoint(action.to)),
      rationaleText: action.rationale,
      attributes: action.attributes ?? {},
      approvalState:
        action.approvalSuggestion === 'ai_confirmed' ? 'tentative' : action.approvalSuggestion,
      authorization: null,
      supersedesRelationRevisionId,
      authorKind: 'agent',
      authorRef: 'preflight',
      createdAt: '1970-01-01T00:00:00.000Z',
    });
    relationRevisionByRef.set(action.proposalRef, revisionId);
  }

  const projected: WorkingSet = {
    baseReleaseId: input.workingSet.baseReleaseId,
    nodeById,
    relationById,
    nodeRevisionByNodeId,
    relationRevisionByRelationId,
    removedNodeIds: new Set(input.workingSet.removedNodeIds),
    removedRelationIds: new Set(input.workingSet.removedRelationIds),
  };
  const baselineIssues = checkConsistency({
    workingSet: input.workingSet,
    reviewCounts: input.reviewCounts,
    policies: input.policies,
  });
  const baselineKeys = new Set(baselineIssues.map(issueKey));
  const issues = checkConsistency({
    workingSet: projected,
    reviewCounts: input.reviewCounts,
    policies: input.policies,
  });
  const syntheticRevisionIds = new Set([
    ...nodeRevisionByRef.values(),
    ...relationRevisionByRef.values(),
  ]);
  const newBlockingIssues = issues.filter(
    (issue) =>
      issue.severity === 'blocking' &&
      ((issue.code === 'ROOT_MISSING' && proposal.workflowType === 'initialize') ||
        !baselineKeys.has(issueKey(issue)) ||
        (issue.entityRevisionId !== null && syntheticRevisionIds.has(issue.entityRevisionId)) ||
        issue.relatedRevisionIds.some((id) => syntheticRevisionIds.has(id))),
  );
  const approvalIssues = newBlockingIssues.filter((issue) => APPROVAL_CODES.has(issue.code));
  const interactionIssues = newBlockingIssues.filter((issue) => INTERACTION_CODES.has(issue.code));
  const hardBlockingIssues = newBlockingIssues.filter(
    (issue) => !APPROVAL_CODES.has(issue.code) && !INTERACTION_CODES.has(issue.code),
  );
  const nodeActionByRevisionId = new Map(
    proposal.nodeActions.map((action) => [nodeRevisionByRef.get(action.proposalRef), action]),
  );
  const relationActionByRevisionId = new Map(
    proposal.relationActions.map((action) => [
      relationRevisionByRef.get(action.proposalRef),
      action,
    ]),
  );
  const interactionRequests = interactionIssues.map((issue) => {
    const nodeAction = issue.entityRevisionId
      ? nodeActionByRevisionId.get(issue.entityRevisionId)
      : undefined;
    const relationAction = issue.entityRevisionId
      ? relationActionByRevisionId.get(issue.entityRevisionId)
      : undefined;
    const proposalRef = nodeAction?.proposalRef ?? relationAction?.proposalRef;
    return {
      issueKey: `preflight-${issue.code.toLowerCase()}-${proposalRef ?? 'graph'}`.slice(0, 64),
      questionText:
        nodeAction?.nodeType === 'question'
          ? nodeAction.displayTitle
          : `提案中仍存在需要裁决的阻塞分歧（${issue.code}），请说明应采用的方向。`,
      rationaleText: issue.message,
      relatedRefs: proposalRef ? [proposalRef] : [],
    };
  });

  return {
    projected,
    issues,
    newBlockingIssues,
    hardBlockingIssues,
    approvalIssues,
    interactionRequests,
  };
}
