export const WORKSPACE_FORMAT = 'treediagram-v2' as const;
export const WORKSPACE_VERSION = 2 as const;

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

export const APPROVAL_STATES = ['draft', 'tentative', 'user_confirmed', 'agent_confirmed'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const EPISTEMIC_STATES = ['unexamined', 'assumed', 'supported', 'refuted'] as const;
export type EpistemicState = (typeof EPISTEMIC_STATES)[number];
export const REVIEW_STATES = ['clean', 'required', 'blocked'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const ATTENTION_SCOPES = ['node', 'subtree', 'related', 'comparison'] as const;
export type AttentionScope = (typeof ATTENTION_SCOPES)[number];

export const CHANGE_OPERATIONS = [
  'create_node',
  'revise_node',
  'remove_node',
  'create_relation',
  'revise_relation',
  'remove_relation',
] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];
export const CHANGE_STATUSES = ['proposed', 'adopted', 'discarded'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export const CHANGESET_STATUSES = ['open', 'ready', 'published', 'abandoned'] as const;
export type ChangeSetStatus = (typeof CHANGESET_STATUSES)[number];

export const TOOL_ERROR_CATEGORIES = [
  'agent_recoverable',
  'user_input_required',
  'state_conflict',
  'permission_required',
  'infrastructure_failure',
] as const;
export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

export const APPROVAL_ACTIONS = [
  'adopt',
  'publish',
  'confirm_root',
  'expand_delegation',
  'take_lease',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export interface WorkspaceMeta {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  workspaceId: string;
  displayName: string;
  createdAt: string;
}

export interface WorkspaceSummary extends WorkspaceMeta {
  activeChangeSetId: string | null;
  currentReleaseId: string | null;
  currentReleaseVersion: number | null;
  nodeCount: number;
  relationCount: number;
  consistency: 'empty' | 'valid' | 'invalid';
}

export interface NodeRecord {
  id: string;
  nodeType: NodeType;
  createdAt: string;
}
export interface NodeRevision {
  id: string;
  nodeId: string;
  revisionNumber: number;
  displayTitle: string;
  contentText: string;
  roles: string[];
  attributes: Record<string, unknown>;
  approvalState: ApprovalState;
  epistemicState: EpistemicState | null;
  reviewState: ReviewState;
  supersedesRevisionId: string | null;
  createdInChangeSetId: string;
  authorKind: 'user' | 'agent' | 'system';
  authorRef: string | null;
  createdAt: string;
}
export interface NodeDetail {
  node: NodeRecord;
  revision: NodeRevision;
  view: 'working' | 'release';
}

export interface RelationRecord {
  id: string;
  relationType: RelationType;
  sourceNodeId: string;
  targetNodeId: string;
  createdAt: string;
}
export interface RelationRevision {
  id: string;
  relationId: string;
  revisionNumber: number;
  rationale: string;
  reviewState: ReviewState;
  supersedesRevisionId: string | null;
  createdInChangeSetId: string;
  authorKind: 'user' | 'agent' | 'system';
  authorRef: string | null;
  createdAt: string;
}
export interface RelationDetail {
  relation: RelationRecord;
  revision: RelationRevision;
  view: 'working' | 'release';
}

export interface DesignChange {
  id: string;
  changeSetId: string;
  operation: ChangeOperation;
  entityId: string;
  baseRevisionId: string | null;
  payload: Record<string, unknown>;
  status: ChangeStatus;
  summary: string;
  createdByHostSessionRef: string;
  createdAt: string;
  updatedAt: string;
  adoptedRevisionId: string | null;
}

export interface ChangeSet {
  id: string;
  status: ChangeSetStatus;
  title: string;
  description: string;
  version: number;
  baseReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
  changes?: DesignChange[];
}

export interface ChangeSetWriteLease {
  changeSetId: string;
  ownerHostSessionRef: string;
  baseVersion: number;
  acquiredAt: string;
  renewedAt: string;
}

export interface Release {
  id: string;
  version: number;
  rootRevisionIds: string[];
  nodeRevisionIds: string[];
  relationRevisionIds: string[];
  summary: string;
  createdAt: string;
}

export interface AttentionContext {
  id: string;
  workspaceId: string;
  hostKind: string;
  hostSessionRef: string;
  clientRef: string;
  primaryNodeId: string | null;
  primaryChangeId: string | null;
  selectedNodeIds: string[];
  selectedChangeIds: string[];
  pinnedNodeIds: string[];
  scope: AttentionScope;
  intentHint: string | null;
  updatedBy: 'user' | 'agent';
  version: number;
  updatedAt: string;
}

export interface AgentActivity {
  id: string;
  hostSessionRef: string;
  nodeIds: string[];
  phase: 'reading' | 'proposing' | 'validating' | 'idle';
  summary: string;
  startedAt: string;
  endedAt: string | null;
}

export interface ApprovalGrant {
  id: string;
  action: ApprovalAction;
  targetDigest: string;
  expectedVersion: number;
  hostSessionRef: string | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface ConsistencyIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  entityId?: string;
  path?: string;
}
export interface ValidationResult {
  valid: boolean;
  issues: ConsistencyIssue[];
  checkedAt: string;
}

export interface ContextPackage {
  attention: AttentionContext | null;
  focus: NodeDetail[];
  selectedChanges: DesignChange[];
  rootPath: NodeDetail[];
  pinned: NodeDetail[];
  related: RelationDetail[];
  relevant: NodeDetail[];
  pendingChanges: DesignChange[];
  truncated: boolean;
  estimatedTokens: number;
  summary: string;
}

export interface ToolError {
  code: string;
  category: ToolErrorCategory;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
  retryable: boolean;
  suggestedAction?: string;
}
export type ToolResult<T> =
  { ok: true; data: T; summary: string } | { ok: false; error: ToolError };

export interface EventRecord {
  cursor: number;
  eventType:
    | 'attention.updated'
    | 'agent.focus.changed'
    | 'changeset.updated'
    | 'design.validation.changed'
    | 'design.invalidated'
    | 'release.published'
    | 'host.session.bound';
  payload: Record<string, unknown>;
  createdAt: string;
}
