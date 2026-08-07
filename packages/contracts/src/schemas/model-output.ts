import { Type, type Static } from '@sinclair/typebox';
import { NODE_TYPES, RELATION_TYPES } from '../enums.js';
import {
  EpistemicStateSchema,
  NodeIdSchema,
  NodeRevisionIdSchema,
  RelationIdSchema,
  RelationRevisionIdSchema,
  ReviewItemIdSchema,
  LIMITS,
  Nullable,
  ReviewVerdictSchema,
  RolesSchema,
} from './common.js';
import { NODE_ATTRIBUTES_SCHEMAS } from './node.js';
import { ContradictsAttributesSchema, EmptyRelationAttributesSchema } from './relation.js';

// 模型结构化输出 schema（IMPLEMENTATION_DESIGN §12.4/§12.5）。
// 所有对象 additionalProperties=false、所有字段 required；不适用值用 null 或空数组。

const proposalRefSchema = Type.String({ minLength: 1, maxLength: LIMITS.proposalRef });

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
      attributes: NODE_ATTRIBUTES_SCHEMAS[nodeType],
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
      attributes:
        relationType === 'contradicts'
          ? ContradictsAttributesSchema
          : EmptyRelationAttributesSchema,
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
