// 枚举集合：所有“状态机/类型”字面量的唯一来源。
// 不使用 TypeScript enum（见 IMPLEMENTATION_DESIGN §3.2）。

export const NODE_TYPES = [
  'topic',
  'claim',
  'goal',
  'constraint',
  'risk',
  'question',
  'option',
  'decision',
  'evidence',
  'validation_method',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const RELATION_TYPES = [
  'contains',
  'depends_on',
  'derived_from',
  'supports',
  'contradicts',
  'constrains',
  'addresses',
  'selects',
  'rejects',
  'supersedes',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const APPROVAL_STATES = ['draft', 'tentative', 'user_confirmed', 'ai_confirmed'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const EPISTEMIC_STATES = ['unexamined', 'assumed', 'supported', 'refuted'] as const;
export type EpistemicState = (typeof EPISTEMIC_STATES)[number];

export const REVIEW_STATES = ['clean', 'required', 'blocked'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const PROJECT_STATES = ['initializing', 'consistent', 'reevaluating', 'blocked'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const AUTHOR_KINDS = ['user', 'agent', 'system'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const SOURCE_KINDS = ['text', 'markdown'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CHANGE_SET_STATUSES = [
  'open',
  'reevaluating',
  'ready',
  'published',
  'abandoned',
] as const;
export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

export const REVIEW_ITEM_STATUSES = ['pending', 'resolved', 'blocked'] as const;
export type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];

export const REVIEW_ENTITY_KINDS = ['project', 'node_revision', 'relation_revision'] as const;
export type ReviewEntityKind = (typeof REVIEW_ENTITY_KINDS)[number];

export const WORKFLOW_TYPES = ['initialize', 'derive', 'grill', 'unbox', 'reevaluate'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const DELEGATION_MODES = ['human_final', 'ai_managed'] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const EVENT_TYPES = [
  'design.invalidated',
  'reevaluation.started',
  'reevaluation.progress',
  'reevaluation.blocked',
  'design.restored',
  'release.published',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVIDENCE_KINDS = [
  'external_source',
  'user_observation',
  'imported_material',
  'agent_argument',
  'thought_experiment',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const CONSTRAINT_STRENGTHS = ['hard', 'soft'] as const;
export type ConstraintStrength = (typeof CONSTRAINT_STRENGTHS)[number];

export const DECISION_IMPORTANCES = ['simple', 'important'] as const;
export type DecisionImportance = (typeof DECISION_IMPORTANCES)[number];

export const REVIEW_VERDICTS = ['valid', 'revise', 'refute', 'supersede', 'unknown'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

// 内置角色（V1_SPEC §4.3）。自定义角色允许存在，仅用于查询与显示。
export const BUILTIN_ROLES = ['root', 'principle', 'requirement', 'finding'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

// root 角色允许挂载的内核类型（IMPLEMENTATION_DESIGN §4.3）。
export const ROOT_ALLOWED_NODE_TYPES = [
  'claim',
  'goal',
  'constraint',
] as const satisfies readonly NodeType[];
export type RootAllowedNodeType = (typeof ROOT_ALLOWED_NODE_TYPES)[number];

// 认知状态仅适用的内核类型（V1_SPEC §4.4）。
export const EPISTEMIC_NODE_TYPES = [
  'claim',
  'constraint',
  'risk',
] as const satisfies readonly NodeType[];
export type EpistemicNodeType = (typeof EPISTEMIC_NODE_TYPES)[number];

export const CONSISTENCY_ISSUE_CODES = [
  // blocking
  'ROOT_MISSING',
  'ROOT_INVALID_TYPE',
  'ROOT_NOT_USER_CONFIRMED',
  'REVIEW_PENDING',
  'REVIEW_BLOCKED',
  'CONTAINS_MULTIPLE_PARENTS',
  'CONTAINS_CYCLE',
  'RELATION_ENDPOINT_MISSING',
  'RELATION_ENDPOINT_TYPE_INVALID',
  'SUPPORTED_WITHOUT_EVIDENCE',
  'IMPORTANT_DECISION_MISSING_QUESTION',
  'IMPORTANT_DECISION_MISSING_OPTIONS',
  'IMPORTANT_DECISION_MISSING_SEARCH_NOTE',
  'DECISION_DEPENDS_ON_REFUTED',
  'BLOCKING_QUESTION',
  'BLOCKING_CONTRADICTION',
  'AI_CONFIRMATION_OUT_OF_SCOPE',
  'ROOT_AI_CONFIRMED',
  // warning
  'ORPHAN_TOP_LEVEL_NODE',
  'ASSUMPTION_WITHOUT_VALIDATION_METHOD',
  'EVIDENCE_LIMITATIONS_EMPTY',
  'SIMPLE_DECISION_HAS_WIDE_IMPACT',
  'UNRESOLVED_NON_BLOCKING_QUESTION',
] as const;
export type ConsistencyIssueCode = (typeof CONSISTENCY_ISSUE_CODES)[number];

export const BLOCKING_ISSUE_CODES = [
  'ROOT_MISSING',
  'ROOT_INVALID_TYPE',
  'ROOT_NOT_USER_CONFIRMED',
  'REVIEW_PENDING',
  'REVIEW_BLOCKED',
  'CONTAINS_MULTIPLE_PARENTS',
  'CONTAINS_CYCLE',
  'RELATION_ENDPOINT_MISSING',
  'RELATION_ENDPOINT_TYPE_INVALID',
  'SUPPORTED_WITHOUT_EVIDENCE',
  'IMPORTANT_DECISION_MISSING_QUESTION',
  'IMPORTANT_DECISION_MISSING_OPTIONS',
  'IMPORTANT_DECISION_MISSING_SEARCH_NOTE',
  'DECISION_DEPENDS_ON_REFUTED',
  'BLOCKING_QUESTION',
  'BLOCKING_CONTRADICTION',
  'AI_CONFIRMATION_OUT_OF_SCOPE',
  'ROOT_AI_CONFIRMED',
] as const satisfies readonly ConsistencyIssueCode[];

export const DOMAIN_ERROR_CODES = [
  'NOT_FOUND',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'STALE_BASE_REVISION',
  'INVALID_STATE_TRANSITION',
  'VALIDATION_FAILED',
  'DESIGN_NOT_CONSISTENT',
  'DESIGN_NOT_INITIALIZED',
  'DESIGN_INCONSISTENT',
  'ROOT_REQUIRES_USER_CONFIRMATION',
  'AI_SCOPE_VIOLATION',
  'RELATION_ENDPOINT_INVALID',
  'CHANGE_SET_ALREADY_EXISTS',
  'WORKFLOW_NOT_RESUMABLE',
  'WORKFLOW_NOT_AVAILABLE',
  'WORKFLOW_ALREADY_RUNNING',
  'MODEL_NOT_CONFIGURED',
  'MODEL_REFUSED',
  'MODEL_PROVIDER_FAILED',
  'MODEL_OUTPUT_INVALID',
  'CORRUPT_PERSISTED_DATA',
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export const AUTH_SCOPES = ['admin', 'consumer'] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];
