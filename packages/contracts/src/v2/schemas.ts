import { Type, type TSchema } from '@sinclair/typebox';
import {
  APPROVAL_ACTIONS,
  APPROVAL_STATES,
  ATTENTION_SCOPES,
  CHANGE_OPERATIONS,
  EPISTEMIC_STATES,
  NODE_TYPES,
  RELATION_TYPES,
  REVIEW_STATES,
} from './types.js';
import type {
  ApprovalState,
  AttentionScope,
  ChangeOperation,
  EpistemicState,
  NodeType,
  RelationType,
  ReviewState,
} from './types.js';

const literals = (values: readonly string[]) =>
  Type.Union(values.map((value) => Type.Literal(value)) as unknown as [TSchema, ...TSchema[]]);

export const IdSchema = Type.String({ minLength: 8, maxLength: 96 });
export const HostSessionRefSchema = Type.String({ minLength: 1, maxLength: 256 });
export const NodeTypeSchema = literals(NODE_TYPES);
export const RelationTypeSchema = literals(RELATION_TYPES);
export const ApprovalStateSchema = literals(APPROVAL_STATES);
export const EpistemicStateSchema = literals(EPISTEMIC_STATES);
export const ReviewStateSchema = literals(REVIEW_STATES);
export const AttentionScopeSchema = literals(ATTENTION_SCOPES);
export const ChangeOperationSchema = literals(CHANGE_OPERATIONS);
export const ApprovalActionSchema = literals(APPROVAL_ACTIONS);

export const RevisionContentSchema = Type.Object(
  {
    displayTitle: Type.String({ minLength: 1, maxLength: 240 }),
    contentText: Type.String({ maxLength: 50000 }),
    roles: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    attributes: Type.Record(Type.String(), Type.Unknown()),
    approvalState: Type.Optional(ApprovalStateSchema),
    epistemicState: Type.Optional(Type.Union([EpistemicStateSchema, Type.Null()])),
    reviewState: Type.Optional(ReviewStateSchema),
  },
  { additionalProperties: false },
);

export const CreateNodePayloadSchema = Type.Composite([
  RevisionContentSchema,
  Type.Object({ nodeType: NodeTypeSchema }, { additionalProperties: false }),
]);
export interface CreateNodePayload {
  nodeType: NodeType;
  displayTitle: string;
  contentText: string;
  roles: string[];
  attributes: Record<string, unknown>;
  approvalState?: ApprovalState;
  epistemicState?: EpistemicState | null;
  reviewState?: ReviewState;
}
export const ReviseNodePayloadSchema = RevisionContentSchema;
export type ReviseNodePayload = Omit<CreateNodePayload, 'nodeType'>;

export const CreateRelationPayloadSchema = Type.Object(
  {
    relationType: RelationTypeSchema,
    sourceNodeId: IdSchema,
    targetNodeId: IdSchema,
    rationale: Type.Optional(Type.String({ maxLength: 5000 })),
    reviewState: Type.Optional(ReviewStateSchema),
  },
  { additionalProperties: false },
);
export interface CreateRelationPayload {
  relationType: RelationType;
  sourceNodeId: string;
  targetNodeId: string;
  rationale?: string;
  reviewState?: ReviewState;
}

export const ReviseRelationPayloadSchema = Type.Object(
  {
    rationale: Type.String({ maxLength: 5000 }),
    reviewState: Type.Optional(ReviewStateSchema),
  },
  { additionalProperties: false },
);
export interface ReviseRelationPayload {
  rationale: string;
  reviewState?: ReviewState;
}

export const AttentionSetInputSchema = Type.Object(
  {
    hostKind: Type.String({ minLength: 1, maxLength: 64 }),
    hostSessionRef: HostSessionRefSchema,
    clientRef: Type.String({ minLength: 1, maxLength: 128 }),
    primaryNodeId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
    primaryChangeId: Type.Optional(Type.Union([IdSchema, Type.Null()])),
    selectedNodeIds: Type.Optional(Type.Array(IdSchema, { maxItems: 50, uniqueItems: true })),
    selectedChangeIds: Type.Optional(Type.Array(IdSchema, { maxItems: 50, uniqueItems: true })),
    pinnedNodeIds: Type.Optional(Type.Array(IdSchema, { maxItems: 50, uniqueItems: true })),
    scope: Type.Optional(AttentionScopeSchema),
    intentHint: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
    expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export interface AttentionSetInput {
  hostKind: string;
  hostSessionRef: string;
  clientRef: string;
  primaryNodeId?: string | null;
  primaryChangeId?: string | null;
  selectedNodeIds?: string[];
  selectedChangeIds?: string[];
  pinnedNodeIds?: string[];
  scope?: AttentionScope;
  intentHint?: string | null;
  expectedVersion?: number;
}

export const ProposeChangeInputSchema = Type.Object(
  {
    hostSessionRef: HostSessionRefSchema,
    changeSetId: IdSchema,
    expectedChangeSetVersion: Type.Integer({ minimum: 1 }),
    operation: ChangeOperationSchema,
    entityId: Type.Optional(IdSchema),
    baseRevisionId: Type.Optional(IdSchema),
    payload: Type.Record(Type.String(), Type.Unknown()),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export interface ProposeChangeInput {
  hostSessionRef: string;
  changeSetId: string;
  expectedChangeSetVersion: number;
  operation: ChangeOperation;
  entityId?: string;
  baseRevisionId?: string;
  payload: Record<string, unknown>;
  summary: string;
}
