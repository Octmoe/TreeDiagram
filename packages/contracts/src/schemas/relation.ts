import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { RelationType } from '../enums.js';
import {
  ApprovalStateSchema,
  AuthorKindSchema,
  IdSchema,
  IsoTimestampSchema,
  LIMITS,
  Nullable,
  RelationTypeSchema,
  AuthorizationSchema,
  UserSettableApprovalStateSchema,
} from './common.js';

// ---- attributes：V1 仅 contradicts 有 { blocking }，其余为空对象（§4.4） ----

export const EmptyRelationAttributesSchema = Type.Object({}, { additionalProperties: false });
export const ContradictsAttributesSchema = Type.Object(
  { blocking: Type.Boolean() },
  { additionalProperties: false },
);
export type ContradictsAttributes = Static<typeof ContradictsAttributesSchema>;

export const RelationAttributesSchema = Type.Union([
  ContradictsAttributesSchema,
  EmptyRelationAttributesSchema,
]);
export type RelationAttributes = Static<typeof RelationAttributesSchema>;

export function checkRelationAttributes(relationType: RelationType, attributes: unknown): boolean {
  if (relationType === 'contradicts') {
    return Value.Check(ContradictsAttributesSchema, attributes);
  }
  return Value.Check(EmptyRelationAttributesSchema, attributes);
}

// ---- DTO ----

export const RelationSchema = Type.Object(
  {
    id: IdSchema,
    projectId: IdSchema,
    relationType: RelationTypeSchema,
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type Relation = Static<typeof RelationSchema>;

export const RelationRevisionSchema = Type.Object(
  {
    id: IdSchema,
    relationId: IdSchema,
    createdInChangeSetId: IdSchema,
    revisionNumber: Type.Integer({ minimum: 1 }),
    fromNodeRevisionId: IdSchema,
    toNodeRevisionId: IdSchema,
    rationaleText: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    attributes: RelationAttributesSchema,
    approvalState: ApprovalStateSchema,
    authorization: Nullable(AuthorizationSchema),
    supersedesRelationRevisionId: Nullable(IdSchema),
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type RelationRevision = Static<typeof RelationRevisionSchema>;

export const RelationDetailSchema = Type.Object(
  {
    relation: RelationSchema,
    revision: RelationRevisionSchema,
  },
  { additionalProperties: false },
);
export type RelationDetail = Static<typeof RelationDetailSchema>;

// ---- 请求 ----

const relationContentFields = {
  fromNodeRevisionId: IdSchema,
  toNodeRevisionId: IdSchema,
  rationaleText: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
  attributes: RelationAttributesSchema,
  approvalState: UserSettableApprovalStateSchema,
} as const;

export const CreateRelationRequestSchema = Type.Object(
  {
    relationType: RelationTypeSchema,
    ...relationContentFields,
  },
  { additionalProperties: false },
);
export type CreateRelationRequest = Static<typeof CreateRelationRequestSchema>;

export const ReviseRelationRequestSchema = Type.Object(
  {
    baseRelationRevisionId: IdSchema,
    ...relationContentFields,
  },
  { additionalProperties: false },
);
export type ReviseRelationRequest = Static<typeof ReviseRelationRequestSchema>;
