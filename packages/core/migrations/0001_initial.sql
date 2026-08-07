CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing','consistent','reevaluating','blocked')),
  current_release_id TEXT REFERENCES release(id),
  admin_token_sha256 TEXT NOT NULL,
  consumer_token_sha256 TEXT NOT NULL,
  blocked_reason_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_asset (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','markdown')),
  original_name TEXT,
  media_type TEXT NOT NULL,
  content_text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX source_asset_project_idx ON source_asset(project_id, created_at);

CREATE TABLE release (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  version INTEGER NOT NULL,
  root_revision_ids_json TEXT NOT NULL,
  node_revision_ids_json TEXT NOT NULL,
  relation_revision_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
);

CREATE TABLE change_set (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  base_release_id TEXT REFERENCES release(id),
  status TEXT NOT NULL CHECK (status IN ('open','reevaluating','ready','published','abandoned')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  adopted_at TEXT,
  published_release_id TEXT REFERENCES release(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_live_change_set_per_project
  ON change_set(project_id)
  WHERE status IN ('open','reevaluating','ready');

CREATE TABLE node (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  node_type TEXT NOT NULL CHECK (node_type IN (
    'topic','claim','goal','constraint','risk','question','option','decision','evidence','validation_method'
  )),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX node_project_type_idx ON node(project_id, node_type);

CREATE TABLE node_revision (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node(id),
  created_in_change_set_id TEXT NOT NULL REFERENCES change_set(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  display_title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('draft','tentative','user_confirmed','ai_confirmed')),
  epistemic_state TEXT CHECK (epistemic_state IN ('unexamined','assumed','supported','refuted')),
  authorization_json TEXT,
  supersedes_revision_id TEXT REFERENCES node_revision(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(node_id, revision_number)
);
CREATE INDEX node_revision_node_idx ON node_revision(node_id, revision_number DESC);
CREATE INDEX node_revision_supersedes_idx ON node_revision(supersedes_revision_id);

CREATE TABLE relation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'contains','depends_on','derived_from','supports','contradicts','constrains','addresses','selects','rejects','supersedes'
  )),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX relation_project_type_idx ON relation(project_id, relation_type);

CREATE TABLE relation_revision (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES relation(id),
  created_in_change_set_id TEXT NOT NULL REFERENCES change_set(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  from_node_revision_id TEXT NOT NULL REFERENCES node_revision(id),
  to_node_revision_id TEXT NOT NULL REFERENCES node_revision(id),
  rationale_text TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('draft','tentative','user_confirmed','ai_confirmed')),
  authorization_json TEXT,
  supersedes_relation_revision_id TEXT REFERENCES relation_revision(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_ref TEXT,
  created_at TEXT NOT NULL,
  CHECK (from_node_revision_id <> to_node_revision_id),
  UNIQUE(relation_id, revision_number)
);
CREATE INDEX relation_revision_from_idx ON relation_revision(from_node_revision_id);
CREATE INDEX relation_revision_to_idx ON relation_revision(to_node_revision_id);

CREATE TABLE change_set_node_head (
  change_set_id TEXT NOT NULL REFERENCES change_set(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES node(id),
  node_revision_id TEXT REFERENCES node_revision(id),
  action TEXT NOT NULL CHECK (action IN ('upsert','remove')),
  PRIMARY KEY(change_set_id, node_id),
  CHECK (
    (action = 'upsert' AND node_revision_id IS NOT NULL) OR
    (action = 'remove' AND node_revision_id IS NULL)
  )
);

CREATE TABLE change_set_relation_head (
  change_set_id TEXT NOT NULL REFERENCES change_set(id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL REFERENCES relation(id),
  relation_revision_id TEXT REFERENCES relation_revision(id),
  action TEXT NOT NULL CHECK (action IN ('upsert','remove')),
  PRIMARY KEY(change_set_id, relation_id),
  CHECK (
    (action = 'upsert' AND relation_revision_id IS NOT NULL) OR
    (action = 'remove' AND relation_revision_id IS NULL)
  )
);

CREATE TABLE delegation_policy (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  scope_node_id TEXT NOT NULL REFERENCES node(id),
  mode TEXT NOT NULL CHECK (mode IN ('human_final','ai_managed')),
  author_kind TEXT NOT NULL CHECK (author_kind = 'user'),
  author_ref TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX one_active_policy_per_scope
  ON delegation_policy(project_id, scope_node_id)
  WHERE revoked_at IS NULL;

CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  change_set_id TEXT REFERENCES change_set(id),
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('initialize','derive','grill','unbox','reevaluate')),
  target_node_id TEXT REFERENCES node(id),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_user','succeeded','failed','cancelled')),
  current_step TEXT NOT NULL,
  input_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  summary_json TEXT,
  error_json TEXT,
  provider TEXT,
  model TEXT,
  provider_response_id TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX workflow_run_project_idx ON workflow_run(project_id, created_at DESC);

CREATE TABLE review_item (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_set(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('project','node_revision','relation_revision')),
  entity_revision_id TEXT,
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','resolved','blocked')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX review_item_change_set_idx ON review_item(change_set_id, status);
CREATE UNIQUE INDEX review_item_unique_reason_idx
  ON review_item(
    change_set_id,
    entity_kind,
    COALESCE(entity_revision_id, ''),
    reason_code
  );

CREATE TABLE event_outbox (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES project(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'design.invalidated','reevaluation.started','reevaluation.progress','reevaluation.blocked','design.restored','release.published'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX event_outbox_project_cursor_idx ON event_outbox(project_id, cursor);

-- 全文搜索（IMPLEMENTATION_DESIGN §7.6）：索引当前视图修订的标题与正文。
CREATE VIRTUAL TABLE node_revision_fts USING fts5(
  revision_id UNINDEXED,
  display_title,
  content_text
);
