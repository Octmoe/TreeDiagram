import { Type, type Static } from '@sinclair/typebox';
import {
  IdSchema,
  IsoTimestampSchema,
  LIMITS,
  Nullable,
  WorkflowRunStatusSchema,
  WorkflowTypeSchema,
} from './common.js';

export const WorkflowRunSchema = Type.Object(
  {
    id: IdSchema,
    projectId: IdSchema,
    changeSetId: Nullable(IdSchema),
    workflowType: WorkflowTypeSchema,
    targetNodeId: Nullable(IdSchema),
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
    targetNodeId: Nullable(IdSchema),
    sourceAssetIds: Type.Array(IdSchema, { maxItems: 20 }),
    focusInstruction: Nullable(Type.String({ maxLength: LIMITS.focusInstruction })),
  },
  { additionalProperties: false },
);
export type StartWorkflowRequest = Static<typeof StartWorkflowRequestSchema>;

export const WorkflowListQuerySchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
    cursor: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type WorkflowListQuery = Static<typeof WorkflowListQuerySchema>;
