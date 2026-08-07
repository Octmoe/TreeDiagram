import { Type, type Static } from '@sinclair/typebox';
import {
  ChangeSetStatusSchema,
  ConsistencyIssueCodeSchema,
  ChangeSetIdSchema,
  IdSchema,
  IsoTimestampSchema,
  ProjectIdSchema,
  ReleaseIdSchema,
  ReviewItemIdSchema,
  LIMITS,
  Nullable,
  ReviewEntityKindSchema,
  ReviewItemStatusSchema,
  ReviewVerdictSchema,
} from './common.js';

export const ChangeSetSchema = Type.Object(
  {
    id: ChangeSetIdSchema,
    projectId: ProjectIdSchema,
    baseReleaseId: Nullable(ReleaseIdSchema),
    status: ChangeSetStatusSchema,
    title: Type.String({ maxLength: LIMITS.changeSetTitle }),
    description: Type.String({ maxLength: LIMITS.changeSetDescription }),
    adoptedAt: Nullable(IsoTimestampSchema),
    publishedReleaseId: Nullable(ReleaseIdSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type ChangeSet = Static<typeof ChangeSetSchema>;

export const ChangeSetCountsSchema = Type.Object(
  {
    nodesCreated: Type.Integer({ minimum: 0 }),
    nodesRevised: Type.Integer({ minimum: 0 }),
    nodesRemoved: Type.Integer({ minimum: 0 }),
    relationsCreated: Type.Integer({ minimum: 0 }),
    relationsRevised: Type.Integer({ minimum: 0 }),
    relationsRemoved: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ChangeSetCounts = Static<typeof ChangeSetCountsSchema>;

export const ChangeSetCurrentResponseSchema = Type.Object(
  {
    changeSet: Nullable(ChangeSetSchema),
    counts: Nullable(ChangeSetCountsSchema),
    rootChange: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ChangeSetCurrentResponse = Static<typeof ChangeSetCurrentResponseSchema>;

export const ReviewItemSchema = Type.Object(
  {
    id: ReviewItemIdSchema,
    changeSetId: ChangeSetIdSchema,
    entityKind: ReviewEntityKindSchema,
    entityRevisionId: Nullable(IdSchema),
    reasonCode: Type.String({ minLength: 1, maxLength: LIMITS.reviewReasonCode }),
    status: ReviewItemStatusSchema,
    resolution: Nullable(Type.Record(Type.String(), Type.Unknown())),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type ReviewItem = Static<typeof ReviewItemSchema>;

export const ConsistencyIssueSchema = Type.Object(
  {
    code: ConsistencyIssueCodeSchema,
    severity: Type.Union([Type.Literal('blocking'), Type.Literal('warning')]),
    entityKind: ReviewEntityKindSchema,
    entityRevisionId: Nullable(Type.String()),
    relatedRevisionIds: Type.Array(Type.String()),
    message: Type.String(),
    details: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type ConsistencyIssue = Static<typeof ConsistencyIssueSchema>;

export const CheckConsistencyResponseSchema = Type.Object(
  {
    issues: Type.Array(ConsistencyIssueSchema),
    blockingCount: Type.Integer({ minimum: 0 }),
    warningCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CheckConsistencyResponse = Static<typeof CheckConsistencyResponseSchema>;

export const ResolveReviewItemRequestSchema = Type.Object(
  {
    verdict: ReviewVerdictSchema,
    rationale: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
  },
  { additionalProperties: false },
);
export type ResolveReviewItemRequest = Static<typeof ResolveReviewItemRequestSchema>;

export const BlockReviewItemRequestSchema = Type.Object(
  {
    rationale: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
  },
  { additionalProperties: false },
);
export type BlockReviewItemRequest = Static<typeof BlockReviewItemRequestSchema>;

export const ReviewItemsResponseSchema = Type.Object(
  {
    items: Type.Array(ReviewItemSchema),
    pendingCount: Type.Integer({ minimum: 0 }),
    blockedCount: Type.Integer({ minimum: 0 }),
    resolvedCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ReviewItemsResponse = Static<typeof ReviewItemsResponseSchema>;
