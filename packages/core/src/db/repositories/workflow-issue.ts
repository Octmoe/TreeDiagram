import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import {
  asId,
  type WorkflowAnswerType,
  type WorkflowIssue,
  type WorkflowIssueGate,
  type WorkflowIssueId,
  type WorkflowIssueKind,
  type WorkflowIssueStatus,
  type WorkflowMessageId,
  type WorkflowRunId,
} from '@treediagram/contracts';
import { newId } from '../../ids.js';
import { DomainError } from '../../errors.js';
import { optionalRow, parseJsonColumn } from '../row-mappers.js';

const StringArraySchema = Type.Array(Type.String(), { maxItems: 20 });
const ResolutionSchema = Type.Record(Type.String(), Type.Unknown());

interface WorkflowIssueRow {
  id: string;
  workflow_run_id: string;
  issue_key: string;
  stage: string;
  kind: string;
  gate: string;
  status: string;
  question_text: string;
  rationale_text: string;
  answer_type: string;
  options_json: string;
  related_refs_json: string;
  opened_by_message_id: string | null;
  answered_by_message_id: string | null;
  resolution_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface WorkflowIssueInput {
  issueId?: WorkflowIssueId | null;
  issueKey: string;
  stage: string;
  kind: WorkflowIssueKind;
  gate: WorkflowIssueGate;
  questionText: string;
  rationaleText: string;
  answerType: WorkflowAnswerType;
  options: string[];
  relatedRefs: string[];
}

function mapIssue(row: WorkflowIssueRow): WorkflowIssue {
  const context = `workflow_issue(${row.id})`;
  return {
    id: asId(row.id),
    workflowRunId: asId(row.workflow_run_id),
    issueKey: row.issue_key,
    stage: row.stage,
    kind: row.kind as WorkflowIssueKind,
    gate: row.gate as WorkflowIssueGate,
    status: row.status as WorkflowIssueStatus,
    questionText: row.question_text,
    rationaleText: row.rationale_text,
    answerType: row.answer_type as WorkflowAnswerType,
    options: parseJsonColumn(StringArraySchema, row.options_json, context),
    relatedRefs: parseJsonColumn(StringArraySchema, row.related_refs_json, context),
    openedByMessageId: row.opened_by_message_id ? asId(row.opened_by_message_id) : null,
    answeredByMessageId: row.answered_by_message_id ? asId(row.answered_by_message_id) : null,
    resolution: row.resolution_json
      ? parseJsonColumn(ResolutionSchema, row.resolution_json, context)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export class WorkflowIssueRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getById(id: string): WorkflowIssue | null {
    const row = optionalRow<WorkflowIssueRow>(
      this.db.prepare('SELECT * FROM workflow_issue WHERE id = ?').get(id),
    );
    return row ? mapIssue(row) : null;
  }

  getByKey(runId: string, issueKey: string): WorkflowIssue | null {
    const row = optionalRow<WorkflowIssueRow>(
      this.db
        .prepare('SELECT * FROM workflow_issue WHERE workflow_run_id = ? AND issue_key = ?')
        .get(runId, issueKey),
    );
    return row ? mapIssue(row) : null;
  }

  listByRun(runId: string): WorkflowIssue[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_issue WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as WorkflowIssueRow[];
    return rows.map(mapIssue);
  }

  listUnresolvedByRun(runId: string, gates?: readonly WorkflowIssueGate[]): WorkflowIssue[] {
    const issues = this.listByRun(runId).filter(
      (issue) => issue.status === 'open' || issue.status === 'answered',
    );
    return gates ? issues.filter((issue) => gates.includes(issue.gate)) : issues;
  }

  upsert(runId: WorkflowRunId, input: WorkflowIssueInput, now: string): WorkflowIssue {
    const byId = input.issueId ? this.getById(input.issueId) : null;
    if (byId && byId.workflowRunId !== runId) {
      throw new DomainError('MODEL_OUTPUT_INVALID', 'workflow issue 不属于当前 run', {
        issueId: input.issueId,
        runId,
      });
    }
    const existing = byId ?? this.getByKey(runId, input.issueKey);
    if (existing) {
      if (existing.status === 'resolved' || existing.status === 'superseded') return existing;
      this.db
        .prepare(
          `UPDATE workflow_issue
           SET stage = ?, kind = ?, gate = ?, status = 'open', question_text = ?,
               rationale_text = ?, answer_type = ?, options_json = ?, related_refs_json = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.stage,
          input.kind,
          input.gate,
          input.questionText,
          input.rationaleText,
          input.answerType,
          JSON.stringify(input.options),
          JSON.stringify(input.relatedRefs),
          now,
          existing.id,
        );
      return this.getById(existing.id)!;
    }

    const id = input.issueId ?? newId<WorkflowIssueId>();
    this.db
      .prepare(
        `INSERT INTO workflow_issue
          (id, workflow_run_id, issue_key, stage, kind, gate, status, question_text,
           rationale_text, answer_type, options_json, related_refs_json, opened_by_message_id,
           answered_by_message_id, resolution_json, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        runId,
        input.issueKey,
        input.stage,
        input.kind,
        input.gate,
        input.questionText,
        input.rationaleText,
        input.answerType,
        JSON.stringify(input.options),
        JSON.stringify(input.relatedRefs),
        now,
        now,
      );
    return this.getById(id)!;
  }

  bindOpeningMessage(issueIds: readonly string[], messageId: WorkflowMessageId, now: string): void {
    const update = this.db.prepare(
      `UPDATE workflow_issue SET opened_by_message_id = ?, updated_at = ?
       WHERE id = ? AND status IN ('open','answered')`,
    );
    for (const issueId of issueIds) update.run(messageId, now, issueId);
  }

  markAnswered(issueIds: readonly string[], messageId: WorkflowMessageId, now: string): void {
    const update = this.db.prepare(
      `UPDATE workflow_issue
       SET status = 'answered', answered_by_message_id = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`,
    );
    for (const issueId of issueIds) update.run(messageId, now, issueId);
  }

  resolve(
    issueIds: readonly string[],
    resolution: Record<string, unknown>,
    now: string,
  ): WorkflowIssue[] {
    const resolved: WorkflowIssue[] = [];
    const update = this.db.prepare(
      `UPDATE workflow_issue
       SET status = 'resolved', resolution_json = ?, updated_at = ?, resolved_at = ?
       WHERE id = ? AND status IN ('open','answered')`,
    );
    for (const issueId of issueIds) {
      update.run(JSON.stringify(resolution), now, now, issueId);
      const issue = this.getById(issueId);
      if (issue?.status === 'resolved') resolved.push(issue);
    }
    return resolved;
  }

  supersede(issueId: string, resolution: Record<string, unknown>, now: string): void {
    this.db
      .prepare(
        `UPDATE workflow_issue
         SET status = 'superseded', resolution_json = ?, updated_at = ?, resolved_at = ?
         WHERE id = ? AND status IN ('open','answered')`,
      )
      .run(JSON.stringify(resolution), now, now, issueId);
  }
}
