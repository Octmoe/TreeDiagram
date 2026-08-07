import { Type, type Static } from '@sinclair/typebox';
import {
  ChangeSetIdSchema,
  IdSchema,
  IsoTimestampSchema,
  NodeIdSchema,
  ProjectIdSchema,
  SourceAssetIdSchema,
  WorkflowRunIdSchema,
  LIMITS,
  Nullable,
  WorkflowRunStatusSchema,
  WorkflowTypeSchema,
} from './common.js';

export const WorkflowRunSchema = Type.Object(
  {
    id: WorkflowRunIdSchema,
    projectId: ProjectIdSchema,
    changeSetId: Nullable(ChangeSetIdSchema),
    workflowType: WorkflowTypeSchema,
    targetNodeId: Nullable(NodeIdSchema),
    status: WorkflowRunStatusSchema,
    currentStep: Type.String({ maxLength: LIMITS.workflowStep }),
    input: Type.Record(Type.String(), Type.Unknown()),
    checkpoint: Type.Record(Type.String(), Type.Unknown()),
    summary: Nullable(Type.Record(Type.String(), Type.Unknown())),
    error: Nullable(Type.Record(Type.String(), Type.Unknown())),
    provider: Nullable(Type.String()),
    model: Nullable(Type.String()),
    providerResponseId: Nullable(Type.String()),
    usage: Nullable(Type.Record(Type.String(), Type.Unknown())),
    createdAt: IsoTimestampSchema,
    startedAt: Nullable(IsoTimestampSchema),
    updatedAt: IsoTimestampSchema,
    finishedAt: Nullable(IsoTimestampSchema),
  },
  { additionalProperties: false },
);
export type WorkflowRun = Static<typeof WorkflowRunSchema>;

export const StartWorkflowRequestSchema = Type.Object(
  {
    workflowType: WorkflowTypeSchema,
    targetNodeId: Nullable(NodeIdSchema),
    sourceAssetIds: Type.Array(SourceAssetIdSchema, { maxItems: 20 }),
    focusInstruction: Nullable(Type.String({ maxLength: LIMITS.focusInstruction })),
  },
  { additionalProperties: false },
);
export type StartWorkflowRequest = Static<typeof StartWorkflowRequestSchema>;

export const WorkflowListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Nullable(Type.String())),
  },
  { additionalProperties: false },
);
export type WorkflowListQuery = Static<typeof WorkflowListQuerySchema>;
