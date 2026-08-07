import { Type, type Static } from '@sinclair/typebox';
import {
  AuthorKindSchema,
  DelegationModeSchema,
  IdSchema,
  IsoTimestampSchema,
  NodeIdSchema,
  ProjectIdSchema,
  ReleaseIdSchema,
  SourceAssetIdSchema,
  DelegationPolicyIdSchema,
  LIMITS,
  Nullable,
  ProjectStateSchema,
  SourceKindSchema,
} from './common.js';

export const ProjectSummarySchema = Type.Object(
  {
    id: ProjectIdSchema,
    name: Type.String({ minLength: 1, maxLength: LIMITS.projectName }),
    status: ProjectStateSchema,
    currentReleaseId: Nullable(ReleaseIdSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type ProjectSummary = Static<typeof ProjectSummarySchema>;

export const ProjectStatusResponseSchema = Type.Object(
  {
    status: ProjectStateSchema,
    currentReleaseId: Nullable(ReleaseIdSchema),
    currentReleaseVersion: Nullable(Type.Integer({ minimum: 1 })),
    blockedReason: Nullable(Type.String({ maxLength: LIMITS.blockedReason })),
  },
  { additionalProperties: false },
);
export type ProjectStatusResponse = Static<typeof ProjectStatusResponseSchema>;

// ---- Source Asset ----

export const SourceAssetMetaSchema = Type.Object(
  {
    id: SourceAssetIdSchema,
    projectId: ProjectIdSchema,
    kind: SourceKindSchema,
    originalName: Nullable(Type.String({ maxLength: LIMITS.originalName })),
    mediaType: Type.String({ maxLength: LIMITS.mediaType }),
    sha256: Type.String({ minLength: 64, maxLength: 64 }),
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type SourceAssetMeta = Static<typeof SourceAssetMetaSchema>;

export const SourceAssetSchema = Type.Intersect([
  SourceAssetMetaSchema,
  Type.Object({ contentText: Type.String() }),
]);
export type SourceAsset = Static<typeof SourceAssetSchema>;

export const CreateSourceRequestSchema = Type.Object(
  {
    kind: SourceKindSchema,
    originalName: Nullable(Type.String({ minLength: 1, maxLength: LIMITS.originalName })),
    mediaType: Type.String({ minLength: 1, maxLength: LIMITS.mediaType }),
    contentText: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type CreateSourceRequest = Static<typeof CreateSourceRequestSchema>;

// ---- Delegation ----

export const DelegationPolicySchema = Type.Object(
  {
    id: DelegationPolicyIdSchema,
    projectId: ProjectIdSchema,
    scopeNodeId: NodeIdSchema,
    mode: DelegationModeSchema,
    authorKind: AuthorKindSchema,
    authorRef: Nullable(Type.String({ maxLength: LIMITS.authorRef })),
    createdAt: IsoTimestampSchema,
    revokedAt: Nullable(IsoTimestampSchema),
  },
  { additionalProperties: false },
);
export type DelegationPolicy = Static<typeof DelegationPolicySchema>;

export const SetDelegationRequestSchema = Type.Object(
  { mode: DelegationModeSchema },
  { additionalProperties: false },
);
export type SetDelegationRequest = Static<typeof SetDelegationRequestSchema>;

/** 节点视角的托管解析结果：生效模式与来源。 */
export const DelegationResolutionSchema = Type.Object(
  {
    nodeId: NodeIdSchema,
    mode: DelegationModeSchema,
    policyId: Nullable(DelegationPolicyIdSchema),
    inheritedFromNodeId: Nullable(NodeIdSchema),
    explicitPolicy: Nullable(DelegationPolicySchema),
    warnings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type DelegationResolution = Static<typeof DelegationResolutionSchema>;
