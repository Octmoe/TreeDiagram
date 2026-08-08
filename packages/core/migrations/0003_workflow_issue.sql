CREATE TABLE workflow_issue (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'ambiguity','decision','approval','inconsistency','external_dependency'
  )),
  gate TEXT NOT NULL CHECK (gate IN ('before_proposal','before_apply','before_release')),
  status TEXT NOT NULL CHECK (status IN ('open','answered','resolved','superseded')),
  question_text TEXT NOT NULL,
  rationale_text TEXT NOT NULL,
  answer_type TEXT NOT NULL CHECK (answer_type IN (
    'free_text','single_choice','multiple_choice','confirmation'
  )),
  options_json TEXT NOT NULL,
  related_refs_json TEXT NOT NULL,
  opened_by_message_id TEXT REFERENCES workflow_message(id),
  answered_by_message_id TEXT REFERENCES workflow_message(id),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(workflow_run_id, issue_key)
);

CREATE INDEX workflow_issue_run_status_idx
  ON workflow_issue(workflow_run_id, status, gate);
