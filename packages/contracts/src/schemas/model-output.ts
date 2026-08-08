import { Type, type Static } from '@sinclair/typebox';
import { NODE_TYPES, RELATION_TYPES } from '../enums.js';
import {
  EpistemicStateSchema,
  NodeIdSchema,
  NodeRevisionIdSchema,
  RelationIdSchema,
  RelationRevisionIdSchema,
  ReviewItemIdSchema,
  WorkflowAnswerTypeSchema,
  WorkflowIssueGateSchema,
  WorkflowIssueIdSchema,
  WorkflowIssueKindSchema,
  LIMITS,
  Nullable,
  ReviewVerdictSchema,
  RolesSchema,
} from './common.js';
import { NODE_ATTRIBUTES_SCHEMAS } from './node.js';
import { ContradictsAttributesSchema } from './relation.js';

// 模型结构化输出 schema（IMPLEMENTATION_DESIGN §12.4/§12.5）。
// 所有对象 additionalProperties=false、所有字段 required；不适用值用 null 或空数组。

const proposalRefSchema = Type.String({ minLength: 1, maxLength: LIMITS.proposalRef });

/**
 * 空 attributes 的节点类型（topic/claim/option）与非 contradicts 关系：
 * 模型输出契约中用 null 表示「无属性」，proposal-applier 落库时归一为 {}。
 * 原因：DeepSeek 等严格 provider 拒绝「无 properties 的对象 schema」，无法在
 * strict json_schema 中表达空对象；null 是所有 provider 都支持的形态。
 */
const EMPTY_ATTRIBUTES_NODE_TYPES: ReadonlySet<string> = new Set(['topic', 'claim', 'option']);

const nodeActionVariants = NODE_TYPES.map((nodeType) =>
  Type.Object(
    {
      proposalRef: proposalRefSchema,
      operation: Type.Union([Type.Literal('create'), Type.Literal('revise')]),
      logicalNodeId: Nullable(NodeIdSchema),
      baseRevisionId: Nullable(NodeRevisionIdSchema),
      nodeType: Type.Literal(nodeType),
      displayTitle: Type.String({ minLength: 1, maxLength: LIMITS.displayTitle }),
      contentText: Type.String({ maxLength: LIMITS.contentText }),
      roles: RolesSchema,
      attributes: EMPTY_ATTRIBUTES_NODE_TYPES.has(nodeType)
        ? Type.Null()
        : NODE_ATTRIBUTES_SCHEMAS[nodeType],
      approvalSuggestion: Type.Union([
        Type.Literal('draft'),
        Type.Literal('tentative'),
        Type.Literal('ai_confirmed'),
      ]),
      epistemicState: Nullable(EpistemicStateSchema),
      rationale: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    },
    { additionalProperties: false },
  ),
);

export const ProposalNodeActionSchema = Type.Union(nodeActionVariants);
export type ProposalNodeAction = Static<typeof ProposalNodeActionSchema>;

const endpointRefSchema = Type.Object(
  {
    refKind: Type.Union([Type.Literal('existing_revision'), Type.Literal('proposal')]),
    ref: Type.String({ minLength: 1, maxLength: LIMITS.proposalRef + 36 }),
  },
  { additionalProperties: false },
);

const relationActionVariants = RELATION_TYPES.map((relationType) =>
  Type.Object(
    {
      proposalRef: proposalRefSchema,
      operation: Type.Union([Type.Literal('create'), Type.Literal('revise')]),
      logicalRelationId: Nullable(RelationIdSchema),
      baseRelationRevisionId: Nullable(RelationRevisionIdSchema),
      relationType: Type.Literal(relationType),
      from: endpointRefSchema,
      to: endpointRefSchema,
      rationale: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
      // 非 contradicts 关系无属性：契约中为 null（见上方 EMPTY_ATTRIBUTES_NODE_TYPES 注释）
      attributes: relationType === 'contradicts' ? ContradictsAttributesSchema : Type.Null(),
      approvalSuggestion: Type.Union([
        Type.Literal('draft'),
        Type.Literal('tentative'),
        Type.Literal('ai_confirmed'),
      ]),
    },
    { additionalProperties: false },
  ),
);

export const ProposalRelationActionSchema = Type.Union(relationActionVariants);
export type ProposalRelationAction = Static<typeof ProposalRelationActionSchema>;

export const ProposalQuestionSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    blocking: Type.Boolean(),
    relatedProposalRefs: Type.Array(proposalRefSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type ProposalQuestion = Static<typeof ProposalQuestionSchema>;

const stopReasonSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('needs_user'),
  Type.Literal('insufficient_context'),
]);

export const WorkflowReadinessIssueSchema = Type.Object(
  {
    issueId: Nullable(WorkflowIssueIdSchema),
    issueKey: Type.String({ minLength: 1, maxLength: LIMITS.proposalRef }),
    kind: WorkflowIssueKindSchema,
    gate: WorkflowIssueGateSchema,
    question: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    rationale: Type.String({ maxLength: LIMITS.rationale }),
    answerType: WorkflowAnswerTypeSchema,
    options: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.displayTitle }), {
      maxItems: 20,
    }),
    relatedRefs: Type.Array(proposalRefSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type WorkflowReadinessIssue = Static<typeof WorkflowReadinessIssueSchema>;

/**
 * 提案生成之前的独立就绪评估。它刻意不包含任何 node/relation action，避免模型在
 * 同一结构化回合中一边声明信息不足、一边提交基于猜测的图谱修改。
 */
export const WorkflowReadinessSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workflowType: Type.Union([
      Type.Literal('initialize'),
      Type.Literal('derive'),
      Type.Literal('grill'),
      Type.Literal('unbox'),
      Type.Literal('reevaluate'),
    ]),
    summary: Type.String({ maxLength: LIMITS.summary }),
    normalizedBrief: Type.String({ minLength: 1, maxLength: LIMITS.contentText }),
    readiness: Type.Union([
      Type.Literal('ready'),
      Type.Literal('needs_user'),
      Type.Literal('insufficient_context'),
    ]),
    issues: Type.Array(WorkflowReadinessIssueSchema, { maxItems: 20 }),
    resolvedIssueIds: Type.Array(WorkflowIssueIdSchema, { maxItems: 20 }),
    assumptions: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.rationale }), {
      maxItems: 50,
    }),
    warnings: Type.Array(Type.String({ maxLength: LIMITS.rationale }), { maxItems: 50 }),
  },
  { additionalProperties: false },
);
export type WorkflowReadiness = Static<typeof WorkflowReadinessSchema>;

export const DesignProposalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workflowType: Type.Union([
      Type.Literal('initialize'),
      Type.Literal('derive'),
      Type.Literal('grill'),
      Type.Literal('unbox'),
    ]),
    summary: Type.String({ maxLength: LIMITS.summary }),
    nodeActions: Type.Array(ProposalNodeActionSchema, { maxItems: 100 }),
    relationActions: Type.Array(ProposalRelationActionSchema, { maxItems: 300 }),
    questionsForUser: Type.Array(ProposalQuestionSchema, { maxItems: 20 }),
    warnings: Type.Array(Type.String({ maxLength: LIMITS.rationale }), { maxItems: 50 }),
    stopReason: stopReasonSchema,
  },
  { additionalProperties: false },
);
export type DesignProposal = Static<typeof DesignProposalSchema>;

export const ReevaluationItemResultSchema = Type.Object(
  {
    reviewItemId: ReviewItemIdSchema,
    verdict: ReviewVerdictSchema,
    rationale: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    replacementProposalRef: Nullable(proposalRefSchema),
    relationMigrationProposalRefs: Type.Array(proposalRefSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type ReevaluationItemResult = Static<typeof ReevaluationItemResultSchema>;

export const ReevaluationBatchResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    summary: Type.String({ maxLength: LIMITS.summary }),
    results: Type.Array(ReevaluationItemResultSchema, { minItems: 1, maxItems: 20 }),
    nodeActions: Type.Array(ProposalNodeActionSchema, { maxItems: 100 }),
    relationActions: Type.Array(ProposalRelationActionSchema, { maxItems: 300 }),
    questionsForUser: Type.Array(ProposalQuestionSchema, { maxItems: 20 }),
    stopReason: stopReasonSchema,
  },
  { additionalProperties: false },
);
export type ReevaluationBatchResult = Static<typeof ReevaluationBatchResultSchema>;
