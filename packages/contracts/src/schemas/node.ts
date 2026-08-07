import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { NodeType } from '../enums.js';
import {
  ApprovalStateSchema,
  AuthorKindSchema,
  ConstraintStrengthSchema,
  DecisionImportanceSchema,
  EpistemicStateSchema,
  EvidenceKindSchema,
  ChangeSetIdSchema,
  IdSchema,
  IsoTimestampSchema,
  NodeIdSchema,
  NodeRevisionIdSchema,
  ProjectIdSchema,
  SourceAssetIdSchema,
  LIMITS,
  NodeTypeSchema,
  Nullable,
  RolesSchema,
  AuthorizationSchema,
  UserSettableApprovalStateSchema,
} from './common.js';

// ---- 类型专属 attributes（IMPLEMENTATION_DESIGN §4.2），全部封闭对象 ----

export const TopicAttributesSchema = Type.Object({}, { additionalProperties: false });
export const ClaimAttributesSchema = Type.Object({}, { additionalProperties: false });
export const GoalAttributesSchema = Type.Object(
  { priorityNote: Nullable(Type.String({ maxLength: LIMITS.rationale })) },
  { additionalProperties: false },
);
export const ConstraintAttributesSchema = Type.Object(
  { strength: ConstraintStrengthSchema },
  { additionalProperties: false },
);
export const RiskAttributesSchema = Type.Object(
  { impactNote: Nullable(Type.String({ maxLength: LIMITS.rationale })) },
  { additionalProperties: false },
);
export const QuestionAttributesSchema = Type.Object(
  { blocking: Type.Boolean() },
  { additionalProperties: false },
);
export const OptionAttributesSchema = Type.Object({}, { additionalProperties: false });
export const DecisionAttributesSchema = Type.Object(
  {
    importance: DecisionImportanceSchema,
    noAlternativeFound: Type.Boolean(),
    alternativeSearchNote: Nullable(Type.String({ maxLength: LIMITS.rationale })),
  },
  { additionalProperties: false },
);
export const EvidenceAttributesSchema = Type.Object(
  {
    evidenceKind: EvidenceKindSchema,
    sourceAssetId: Nullable(SourceAssetIdSchema),
    method: Type.String({ maxLength: LIMITS.rationale }),
    premises: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.rationale }), {
      maxItems: 50,
    }),
    limitations: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.rationale }), {
      maxItems: 50,
    }),
  },
  { additionalProperties: false },
);
export const ValidationMethodAttributesSchema = Type.Object(
  {
    method: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    expectedSignal: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    successInterpretation: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    failureInterpretation: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
  },
  { additionalProperties: false },
);

export const NODE_ATTRIBUTES_SCHEMAS = {
  topic: TopicAttributesSchema,
  claim: ClaimAttributesSchema,
  goal: GoalAttributesSchema,
  constraint: ConstraintAttributesSchema,
  risk: RiskAttributesSchema,
  question: QuestionAttributesSchema,
  option: OptionAttributesSchema,
  decision: DecisionAttributesSchema,
  evidence: EvidenceAttributesSchema,
  validation_method: ValidationMethodAttributesSchema,
} as const satisfies Record<NodeType, TSchema>;

export type TopicAttributes = Static<typeof TopicAttributesSchema>;
export type GoalAttributes = Static<typeof GoalAttributesSchema>;
export type ConstraintAttributes = Static<typeof ConstraintAttributesSchema>;
export type RiskAttributes = Static<typeof RiskAttributesSchema>;
export type QuestionAttributes = Static<typeof QuestionAttributesSchema>;
export type DecisionAttributes = Static<typeof DecisionAttributesSchema>;
export type EvidenceAttributes = Static<typeof EvidenceAttributesSchema>;
export type ValidationMethodAttributes = Static<typeof ValidationMethodAttributesSchema>;

export type NodeAttributes =
  | TopicAttributes
  | Record<string, never>
  | GoalAttributes
  | ConstraintAttributes
  | RiskAttributes
  | QuestionAttributes
  | DecisionAttributes
  | EvidenceAttributes
  | ValidationMethodAttributes;

export const NodeAttributesSchema = Type.Union([
  TopicAttributesSchema,
  GoalAttributesSchema,
  ConstraintAttributesSchema,
  RiskAttributesSchema,
  QuestionAttributesSchema,
  DecisionAttributesSchema,
  EvidenceAttributesSchema,
  ValidationMethodAttributesSchema,
]);

/** 按内核类型校验 attributes（JSON 列写入前必须调用）。 */
export function checkNodeAttributes(nodeType: NodeType, attributes: unknown): boolean {
  return Value.Check(NODE_ATTRIBUTES_SCHEMAS[nodeType], attributes);
}

// ---- DTO ----

export const NodeSchema = Type.Object(
  {
    id: NodeIdSchema,
    projectId: ProjectIdSchema,
    nodeType: NodeTypeSchema,
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type Node = Static<typeof NodeSchema>;

export const NodeRevisionSchema = Type.Object(
  {
    id: NodeRevisionIdSchema,
    nodeId: NodeIdSchema,
    createdInChangeSetId: ChangeSetIdSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    displayTitle: Type.String({ minLength: 1, maxLength: LIMITS.displayTitle }),
    contentText: Type.String({ maxLength: LIMITS.contentText }),
    roles: RolesSchema,
    attributes: NodeAttributesSchema,
    approvalState: ApprovalStateSchema,
    epistemicState: Nullable(EpistemicStateSchema),
    authorization: Nullable(AuthorizationSchema),
    supersedesRevisionId: Nullable(NodeRevisionIdSchema),
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type NodeRevision = Static<typeof NodeRevisionSchema>;

/** 检查器/UI 使用的组合视图：逻辑节点 + 当前视图下的修订。 */
export const NodeDetailSchema = Type.Object(
  {
    node: NodeSchema,
    revision: NodeRevisionSchema,
  },
  { additionalProperties: false },
);
export type NodeDetail = Static<typeof NodeDetailSchema>;

// ---- 请求 ----

const revisionContentFields = {
  displayTitle: Type.String({ minLength: 1, maxLength: LIMITS.displayTitle }),
  contentText: Type.String({ maxLength: LIMITS.contentText }),
  roles: RolesSchema,
  attributes: NodeAttributesSchema,
  approvalState: UserSettableApprovalStateSchema,
  epistemicState: Nullable(EpistemicStateSchema),
} as const;

export const CreateNodeRequestSchema = Type.Object(
  {
    nodeType: NodeTypeSchema,
    ...revisionContentFields,
  },
  { additionalProperties: false },
);
export type CreateNodeRequest = Static<typeof CreateNodeRequestSchema>;

export const ReviseNodeRequestSchema = Type.Object(
  {
    baseRevisionId: IdSchema,
    ...revisionContentFields,
  },
  { additionalProperties: false },
);
export type ReviseNodeRequest = Static<typeof ReviseNodeRequestSchema>;
