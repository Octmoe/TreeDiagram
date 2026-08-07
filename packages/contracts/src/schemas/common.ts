import { Type, type Static, type TLiteral, type TSchema } from '@sinclair/typebox';
import type {
  ChangeSetId,
  DelegationPolicyId,
  NodeId,
  NodeRevisionId,
  ProjectId,
  RelationId,
  RelationRevisionId,
  ReleaseId,
  ReviewItemId,
  SourceAssetId,
  WorkflowRunId,
} from '../ids.js';
import {
  APPROVAL_STATES,
  AUTH_SCOPES,
  AUTHOR_KINDS,
  CHANGE_SET_STATUSES,
  CONSISTENCY_ISSUE_CODES,
  CONSTRAINT_STRENGTHS,
  DECISION_IMPORTANCES,
  DELEGATION_MODES,
  EPISTEMIC_STATES,
  EVENT_TYPES,
  EVIDENCE_KINDS,
  NODE_TYPES,
  PROJECT_STATES,
  RELATION_TYPES,
  REVIEW_ENTITY_KINDS,
  REVIEW_ITEM_STATUSES,
  REVIEW_VERDICTS,
  SOURCE_KINDS,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TYPES,
} from '../enums.js';

// 注意：不使用 JSON Schema format 关键字（Fastify 默认 ajv 未注册 ajv-formats）。
export const IdSchema = Type.String({ minLength: 36, maxLength: 36 });
export const IsoTimestampSchema = Type.String({ minLength: 20, maxLength: 40 });

// 品牌 ID schema：静态类型即品牌类型，JSON Schema 层面仍是普通 string。
const idShape = { type: 'string', minLength: 36, maxLength: 36 } as const;
export const ProjectIdSchema = Type.Unsafe<ProjectId>(idShape);
export const NodeIdSchema = Type.Unsafe<NodeId>(idShape);
export const NodeRevisionIdSchema = Type.Unsafe<NodeRevisionId>(idShape);
export const RelationIdSchema = Type.Unsafe<RelationId>(idShape);
export const RelationRevisionIdSchema = Type.Unsafe<RelationRevisionId>(idShape);
export const ChangeSetIdSchema = Type.Unsafe<ChangeSetId>(idShape);
export const ReleaseIdSchema = Type.Unsafe<ReleaseId>(idShape);
export const SourceAssetIdSchema = Type.Unsafe<SourceAssetId>(idShape);
export const DelegationPolicyIdSchema = Type.Unsafe<DelegationPolicyId>(idShape);
export const WorkflowRunIdSchema = Type.Unsafe<WorkflowRunId>(idShape);
export const ReviewItemIdSchema = Type.Unsafe<ReviewItemId>(idShape);

// 领域字符串上限（HTTP contract 统一口径）。
export const LIMITS = {
  displayTitle: 200,
  contentText: 20000,
  rationale: 4000,
  summary: 4000,
  role: 64,
  rolesMaxItems: 20,
  authorRef: 128,
  projectName: 200,
  changeSetTitle: 200,
  changeSetDescription: 4000,
  originalName: 512,
  mediaType: 128,
  proposalRef: 64,
  workflowStep: 64,
  reviewReasonCode: 64,
  focusInstruction: 4000,
  blockedReason: 4000,
} as const;

function literals<T extends readonly string[]>(
  values: T,
): { -readonly [K in keyof T]: TLiteral<T[K] & string> } {
  return values.map((v) => Type.Literal(v)) as { -readonly [K in keyof T]: TLiteral<T[K] & string> };
}

export const NodeTypeSchema = Type.Union(literals(NODE_TYPES));
export const RelationTypeSchema = Type.Union(literals(RELATION_TYPES));
export const ApprovalStateSchema = Type.Union(literals(APPROVAL_STATES));
export const EpistemicStateSchema = Type.Union(literals(EPISTEMIC_STATES));
export const ProjectStateSchema = Type.Union(literals(PROJECT_STATES));
export const AuthorKindSchema = Type.Union(literals(AUTHOR_KINDS));
export const SourceKindSchema = Type.Union(literals(SOURCE_KINDS));
export const ChangeSetStatusSchema = Type.Union(literals(CHANGE_SET_STATUSES));
export const ReviewItemStatusSchema = Type.Union(literals(REVIEW_ITEM_STATUSES));
export const ReviewEntityKindSchema = Type.Union(literals(REVIEW_ENTITY_KINDS));
export const WorkflowTypeSchema = Type.Union(literals(WORKFLOW_TYPES));
export const WorkflowRunStatusSchema = Type.Union(literals(WORKFLOW_RUN_STATUSES));
export const DelegationModeSchema = Type.Union(literals(DELEGATION_MODES));
export const EventTypeSchema = Type.Union(literals(EVENT_TYPES));
export const EvidenceKindSchema = Type.Union(literals(EVIDENCE_KINDS));
export const ConstraintStrengthSchema = Type.Union(literals(CONSTRAINT_STRENGTHS));
export const DecisionImportanceSchema = Type.Union(literals(DECISION_IMPORTANCES));
export const ReviewVerdictSchema = Type.Union(literals(REVIEW_VERDICTS));
export const ConsistencyIssueCodeSchema = Type.Union(literals(CONSISTENCY_ISSUE_CODES));
export const AuthScopeSchema = Type.Union(literals(AUTH_SCOPES));

/** 用户/API 侧可指定的治理状态：ai_confirmed 只能由 ProposalApplier 带授权写入。 */
export const USER_SETTABLE_APPROVAL_STATES = ['draft', 'tentative', 'user_confirmed'] as const;
export const UserSettableApprovalStateSchema = Type.Union(
  literals(USER_SETTABLE_APPROVAL_STATES),
);

export const RolesSchema = Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.role }), {
  maxItems: LIMITS.rolesMaxItems,
});

export const AuthorizationSchema = Type.Object(
  {
    workflowRunId: WorkflowRunIdSchema,
    policyId: DelegationPolicyIdSchema,
  },
  { additionalProperties: false },
);
export type Authorization = Static<typeof AuthorizationSchema>;

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
