export const V2_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL CHECK (format = 'treediagram-v2'),
  version INTEGER NOT NULL CHECK (version = 2),
  display_name TEXT NOT NULL,
  current_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE change_set (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open','ready','published','abandoned')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  version INTEGER NOT NULL,
  base_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_changeset ON change_set((1)) WHERE status IN ('open','ready');

CREATE TABLE node (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE node_revision (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node(id),
  revision_number INTEGER NOT NULL,
  display_title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  approval_state TEXT NOT NULL,
  epistemic_state TEXT,
  review_state TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES node_revision(id),
  created_in_changeset_id TEXT NOT NULL REFERENCES change_set(id),
  author_kind TEXT NOT NULL,
  author_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(node_id, revision_number)
);
CREATE TABLE working_node_head (
  node_id TEXT PRIMARY KEY REFERENCES node(id),
  revision_id TEXT NOT NULL REFERENCES node_revision(id)
);

CREATE TABLE relation (
  id TEXT PRIMARY KEY,
  relation_type TEXT NOT NULL,
  source_node_id TEXT NOT NULL REFERENCES node(id),
  target_node_id TEXT NOT NULL REFERENCES node(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE relation_revision (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES relation(id),
  revision_number INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  review_state TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES relation_revision(id),
  created_in_changeset_id TEXT NOT NULL REFERENCES change_set(id),
  author_kind TEXT NOT NULL,
  author_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(relation_id, revision_number)
);
CREATE TABLE working_relation_head (
  relation_id TEXT PRIMARY KEY REFERENCES relation(id),
  revision_id TEXT NOT NULL REFERENCES relation_revision(id)
);

CREATE TABLE design_change (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES change_set(id),
  operation TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','adopted','discarded')),
  summary TEXT NOT NULL,
  created_by_host_session_ref TEXT NOT NULL,
  adopted_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX design_change_changeset_idx ON design_change(changeset_id, created_at);

CREATE TABLE changeset_write_lease (
  changeset_id TEXT PRIMARY KEY REFERENCES change_set(id) ON DELETE CASCADE,
  owner_host_session_ref TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL
);

CREATE TABLE release (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE release_node (
  release_id TEXT NOT NULL REFERENCES release(id),
  node_id TEXT NOT NULL REFERENCES node(id),
  revision_id TEXT NOT NULL REFERENCES node_revision(id),
  PRIMARY KEY(release_id, node_id)
);
CREATE TABLE release_relation (
  release_id TEXT NOT NULL REFERENCES release(id),
  relation_id TEXT NOT NULL REFERENCES relation(id),
  revision_id TEXT NOT NULL REFERENCES relation_revision(id),
  PRIMARY KEY(release_id, relation_id)
);

CREATE TABLE attention_context (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  host_kind TEXT NOT NULL,
  host_session_ref TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  primary_node_id TEXT,
  primary_change_id TEXT,
  selected_node_ids_json TEXT NOT NULL,
  selected_change_ids_json TEXT NOT NULL DEFAULT '[]',
  pinned_node_ids_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  intent_hint TEXT,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, host_kind, host_session_ref, client_ref)
);
CREATE INDEX attention_session_idx ON attention_context(host_kind, host_session_ref, updated_at DESC);

CREATE TABLE host_session_binding (
  id TEXT PRIMARY KEY,
  host_kind TEXT NOT NULL,
  host_session_ref TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES attention_context(id),
  created_at TEXT NOT NULL,
  UNIQUE(host_kind, host_session_ref)
);

CREATE TABLE agent_activity (
  id TEXT PRIMARY KEY,
  host_session_ref TEXT NOT NULL,
  node_ids_json TEXT NOT NULL,
  phase TEXT NOT NULL,
  summary TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX agent_activity_session_idx ON agent_activity(host_session_ref, started_at DESC);

CREATE TABLE approval_grant (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  host_session_ref TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE delegation_policy (
  node_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('human_final','agent_managed')),
  updated_at TEXT NOT NULL
);

CREATE TABLE event_outbox (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK (retention_class IN ('attention','audit')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
