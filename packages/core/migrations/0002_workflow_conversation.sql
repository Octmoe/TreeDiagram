CREATE TABLE workflow_message (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent','user','system')),
  kind TEXT NOT NULL CHECK (kind IN ('clarification','response','notice')),
  content_text TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  source_asset_ids_json TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES workflow_message(id),
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_run_id, sequence)
);

CREATE UNIQUE INDEX workflow_message_client_id_idx
  ON workflow_message(workflow_run_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX workflow_message_run_idx
  ON workflow_message(workflow_run_id, sequence);

CREATE TABLE workflow_wait (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES workflow_message(id),
  status TEXT NOT NULL CHECK (status IN ('open','answered','cancelled')),
  answered_by_message_id TEXT REFERENCES workflow_message(id),
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE UNIQUE INDEX workflow_wait_one_open_idx
  ON workflow_wait(workflow_run_id)
  WHERE status = 'open';
