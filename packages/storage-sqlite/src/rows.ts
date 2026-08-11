import {
  CHANGESET_LEASE_IDLE_TIMEOUT_MS,
  type ApprovalGrant,
  type ChangeSet,
  type ChangeSetLeaseHandoffRequest,
  type ChangeSetWriteLease,
  type DesignChange,
  type NodeDetail,
  type RelationDetail,
  type Release,
} from '@treediagram/contracts';

type Row = Record<string, unknown>;
const text = (row: Row, key: string) => String(row[key]);
const nullable = (row: Row, key: string) => (row[key] == null ? null : String(row[key]));
const json = <T>(row: Row, key: string): T => JSON.parse(text(row, key)) as T;

export function mapNode(row: Row, view: 'working' | 'release'): NodeDetail {
  return {
    node: {
      id: text(row, 'node_id'),
      nodeType: text(row, 'node_type') as NodeDetail['node']['nodeType'],
      createdAt: text(row, 'node_created_at'),
    },
    revision: {
      id: text(row, 'revision_id'),
      nodeId: text(row, 'node_id'),
      revisionNumber: Number(row['revision_number']),
      displayTitle: text(row, 'display_title'),
      contentText: text(row, 'content_text'),
      roles: json<string[]>(row, 'roles_json'),
      attributes: json<Record<string, unknown>>(row, 'attributes_json'),
      approvalState: text(row, 'approval_state') as NodeDetail['revision']['approvalState'],
      epistemicState: nullable(row, 'epistemic_state') as NodeDetail['revision']['epistemicState'],
      reviewState: text(row, 'review_state') as NodeDetail['revision']['reviewState'],
      supersedesRevisionId: nullable(row, 'supersedes_revision_id'),
      createdInChangeSetId: text(row, 'created_in_changeset_id'),
      authorKind: text(row, 'author_kind') as NodeDetail['revision']['authorKind'],
      authorRef: nullable(row, 'author_ref'),
      createdAt: text(row, 'revision_created_at'),
    },
    view,
  };
}

export function mapRelation(row: Row, view: 'working' | 'release'): RelationDetail {
  return {
    relation: {
      id: text(row, 'relation_id'),
      relationType: text(row, 'relation_type') as RelationDetail['relation']['relationType'],
      sourceNodeId: text(row, 'source_node_id'),
      targetNodeId: text(row, 'target_node_id'),
      createdAt: text(row, 'relation_created_at'),
    },
    revision: {
      id: text(row, 'revision_id'),
      relationId: text(row, 'relation_id'),
      revisionNumber: Number(row['revision_number']),
      rationale: text(row, 'rationale'),
      reviewState: text(row, 'review_state') as RelationDetail['revision']['reviewState'],
      supersedesRevisionId: nullable(row, 'supersedes_revision_id'),
      createdInChangeSetId: text(row, 'created_in_changeset_id'),
      authorKind: text(row, 'author_kind') as RelationDetail['revision']['authorKind'],
      authorRef: nullable(row, 'author_ref'),
      createdAt: text(row, 'revision_created_at'),
    },
    view,
  };
}

export const mapChange = (row: Row): DesignChange => ({
  id: text(row, 'id'),
  changeSetId: text(row, 'changeset_id'),
  operation: text(row, 'operation') as DesignChange['operation'],
  entityId: text(row, 'entity_id'),
  baseRevisionId: nullable(row, 'base_revision_id'),
  payload: json<Record<string, unknown>>(row, 'payload_json'),
  status: text(row, 'status') as DesignChange['status'],
  summary: text(row, 'summary'),
  createdByHostSessionRef: text(row, 'created_by_host_session_ref'),
  adoptedRevisionId: nullable(row, 'adopted_revision_id'),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
});

export const mapChangeSet = (row: Row, changes?: DesignChange[]): ChangeSet => {
  const result: ChangeSet = {
    id: text(row, 'id'),
    status: text(row, 'status') as ChangeSet['status'],
    title: text(row, 'title'),
    description: text(row, 'description'),
    version: Number(row['version']),
    baseReleaseId: nullable(row, 'base_release_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  if (changes !== undefined) result.changes = changes;
  return result;
};

export const mapLease = (row: Row): ChangeSetWriteLease => {
  const renewedAt = text(row, 'renewed_at');
  return {
    changeSetId: text(row, 'changeset_id'),
    ownerHostSessionRef: text(row, 'owner_host_session_ref'),
    baseVersion: Number(row['base_version']),
    acquiredAt: text(row, 'acquired_at'),
    renewedAt,
    expiresAt: new Date(Date.parse(renewedAt) + CHANGESET_LEASE_IDLE_TIMEOUT_MS).toISOString(),
  };
};

export const mapLeaseHandoffRequest = (row: Row): ChangeSetLeaseHandoffRequest => ({
  id: text(row, 'id'),
  changeSetId: text(row, 'changeset_id'),
  requesterHostSessionRef: text(row, 'requester_host_session_ref'),
  ownerHostSessionRef: text(row, 'owner_host_session_ref'),
  changeSetVersion: Number(row['changeset_version']),
  purpose: text(row, 'purpose'),
  status: text(row, 'status') as ChangeSetLeaseHandoffRequest['status'],
  createdAt: text(row, 'created_at'),
  expiresAt: text(row, 'expires_at'),
  resolvedAt: nullable(row, 'resolved_at'),
  resolvedByHostSessionRef: nullable(row, 'resolved_by_host_session_ref'),
});

export const mapGrant = (row: Row): ApprovalGrant => ({
  id: text(row, 'id'),
  action: text(row, 'action') as ApprovalGrant['action'],
  targetDigest: text(row, 'target_digest'),
  expectedVersion: Number(row['expected_version']),
  hostSessionRef: nullable(row, 'host_session_ref'),
  expiresAt: text(row, 'expires_at'),
  consumedAt: nullable(row, 'consumed_at'),
});

export const mapRelease = (
  row: Row,
  nodeIds: string[],
  relationIds: string[],
  roots: string[],
): Release => ({
  id: text(row, 'id'),
  version: Number(row['version']),
  summary: text(row, 'summary'),
  createdAt: text(row, 'created_at'),
  nodeRevisionIds: nodeIds,
  relationRevisionIds: relationIds,
  rootRevisionIds: roots,
});

export const NODE_SELECT = `
SELECT n.id AS node_id, n.node_type, n.created_at AS node_created_at,
       r.id AS revision_id, r.revision_number, r.display_title, r.content_text,
       r.roles_json, r.attributes_json, r.approval_state, r.epistemic_state,
       r.review_state, r.supersedes_revision_id, r.created_in_changeset_id,
       r.author_kind, r.author_ref, r.created_at AS revision_created_at
FROM working_node_head h
JOIN node n ON n.id = h.node_id
JOIN node_revision r ON r.id = h.revision_id`;

export const RELEASE_NODE_SELECT = `
SELECT n.id AS node_id, n.node_type, n.created_at AS node_created_at,
       r.id AS revision_id, r.revision_number, r.display_title, r.content_text,
       r.roles_json, r.attributes_json, r.approval_state, r.epistemic_state,
       r.review_state, r.supersedes_revision_id, r.created_in_changeset_id,
       r.author_kind, r.author_ref, r.created_at AS revision_created_at
FROM release_node h
JOIN node n ON n.id = h.node_id
JOIN node_revision r ON r.id = h.revision_id`;

export const RELATION_SELECT = `
SELECT rel.id AS relation_id, rel.relation_type, rel.source_node_id, rel.target_node_id,
       rel.created_at AS relation_created_at, r.id AS revision_id, r.revision_number,
       r.rationale, r.review_state, r.supersedes_revision_id, r.created_in_changeset_id,
       r.author_kind, r.author_ref, r.created_at AS revision_created_at
FROM working_relation_head h
JOIN relation rel ON rel.id = h.relation_id
JOIN relation_revision r ON r.id = h.revision_id`;

export const RELEASE_RELATION_SELECT = `
SELECT rel.id AS relation_id, rel.relation_type, rel.source_node_id, rel.target_node_id,
       rel.created_at AS relation_created_at, r.id AS revision_id, r.revision_number,
       r.rationale, r.review_state, r.supersedes_revision_id, r.created_in_changeset_id,
       r.author_kind, r.author_ref, r.created_at AS revision_created_at
FROM release_relation h
JOIN relation rel ON rel.id = h.relation_id
JOIN relation_revision r ON r.id = h.revision_id`;
