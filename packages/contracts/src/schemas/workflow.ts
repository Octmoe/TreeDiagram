import { Type, type Static } from '@sinclair/typebox';
import {
  ChangeSetIdSchema,
  IdSchema,
  IsoTimestampSchema,
  NodeIdSchema,
  ProjectIdSchema,
  SourceAssetIdSchema,
  WorkflowMessageIdSchema,
  WorkflowIssueIdSchema,
  WorkflowRunIdSchema,
  WorkflowWaitIdSchema,
  LIMITS,
  Nullable,
  WorkflowMessageKindSchema,
  WorkflowMessageRoleSchema,
  WorkflowRunStatusSchema,
  WorkflowWaitStatusSchema,
  WorkflowAnswerTypeSchema,
  WorkflowIssueGateSchema,
  WorkflowIssueKindSchema,
  WorkflowIssueStatusSchema,
  WorkflowTypeSchema,
} from './common.js';

export const WorkflowClarificationQuestionSchema = Type.Object(
  {
    id: IdSchema,
    question: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    blocking: Type.Boolean(),
    relatedProposalRefs: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.proposalRef }), {
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);
export type WorkflowClarificationQuestion = Static<typeof WorkflowClarificationQuestionSchema>;

export const WorkflowAnswerSchema = Type.Object(
  {
    questionId: IdSchema,
    answerText: Type.String({ minLength: 1, maxLength: LIMITS.workflowMessage }),
  },
  { additionalProperties: false },
);
export type WorkflowAnswer = Static<typeof WorkflowAnswerSchema>;

export const WorkflowMessageSchema = Type.Object(
  {
    id: WorkflowMessageIdSchema,
    workflowRunId: WorkflowRunIdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    role: WorkflowMessageRoleSchema,
    kind: WorkflowMessageKindSchema,
    contentText: Type.String({ maxLength: LIMITS.workflowMessage }),
    questions: Type.Array(WorkflowClarificationQuestionSchema, { maxItems: 20 }),
    answers: Type.Array(WorkflowAnswerSchema, { maxItems: 20 }),
    sourceAssetIds: Type.Array(SourceAssetIdSchema, { maxItems: 20 }),
    replyToMessageId: Nullable(WorkflowMessageIdSchema),
    clientMessageId: Nullable(IdSchema),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);
export type WorkflowMessage = Static<typeof WorkflowMessageSchema>;

export const WorkflowWaitSchema = Type.Object(
  {
    id: WorkflowWaitIdSchema,
    workflowRunId: WorkflowRunIdSchema,
    messageId: WorkflowMessageIdSchema,
    status: WorkflowWaitStatusSchema,
    answeredByMessageId: Nullable(WorkflowMessageIdSchema),
    createdAt: IsoTimestampSchema,
    answeredAt: Nullable(IsoTimestampSchema),
  },
  { additionalProperties: false },
);
export type WorkflowWait = Static<typeof WorkflowWaitSchema>;

export const WorkflowIssueSchema = Type.Object(
  {
    id: WorkflowIssueIdSchema,
    workflowRunId: WorkflowRunIdSchema,
    issueKey: Type.String({ minLength: 1, maxLength: LIMITS.proposalRef }),
    stage: Type.String({ minLength: 1, maxLength: LIMITS.workflowStep }),
    kind: WorkflowIssueKindSchema,
    gate: WorkflowIssueGateSchema,
    status: WorkflowIssueStatusSchema,
    questionText: Type.String({ minLength: 1, maxLength: LIMITS.rationale }),
    rationaleText: Type.String({ maxLength: LIMITS.rationale }),
    answerType: WorkflowAnswerTypeSchema,
    options: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.displayTitle }), {
      maxItems: 20,
    }),
    relatedRefs: Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.proposalRef }), {
      maxItems: 20,
    }),
    openedByMessageId: Nullable(WorkflowMessageIdSchema),
    answeredByMessageId: Nullable(WorkflowMessageIdSchema),
    resolution: Nullable(Type.Record(Type.String(), Type.Unknown())),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    resolvedAt: Nullable(IsoTimestampSchema),
  },
  { additionalProperties: false },
);
export type WorkflowIssue = Static<typeof WorkflowIssueSchema>;

export const WorkflowConversationSchema = Type.Object(
  {
    messages: Type.Array(WorkflowMessageSchema),
    openWait: Nullable(WorkflowWaitSchema),
    issues: Type.Array(WorkflowIssueSchema),
  },
  { additionalProperties: false },
);
export type WorkflowConversation = Static<typeof WorkflowConversationSchema>;

export const RespondWorkflowRequestSchema = Type.Object(
  {
    waitId: WorkflowWaitIdSchema,
    clientMessageId: IdSchema,
    message: Type.String({ minLength: 1, maxLength: LIMITS.workflowMessage }),
    answers: Type.Array(WorkflowAnswerSchema, { maxItems: 20 }),
    sourceAssetIds: Type.Array(SourceAssetIdSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type RespondWorkflowRequest = Static<typeof RespondWorkflowRequestSchema>;

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
    /** reevaluate 的目标 ChangeSet（§13.5）；其余工作流为 null。 */
    changeSetId: Nullable(ChangeSetIdSchema),
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
