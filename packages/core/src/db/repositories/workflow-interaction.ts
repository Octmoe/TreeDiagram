import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import {
  WorkflowAnswerSchema,
  WorkflowClarificationQuestionSchema,
  asId,
  type SourceAssetId,
  type WorkflowAnswer,
  type WorkflowClarificationQuestion,
  type WorkflowMessage,
  type WorkflowMessageId,
  type WorkflowMessageKind,
  type WorkflowMessageRole,
  type WorkflowRunId,
  type WorkflowWait,
  type WorkflowWaitId,
  type WorkflowWaitStatus,
} from '@treediagram/contracts';
import { newId } from '../../ids.js';
import { optionalRow, parseJsonColumn } from '../row-mappers.js';

const QuestionsSchema = Type.Array(WorkflowClarificationQuestionSchema, { maxItems: 20 });
const AnswersSchema = Type.Array(WorkflowAnswerSchema, { maxItems: 20 });
const SourceIdsSchema = Type.Array(Type.String({ minLength: 36, maxLength: 36 }), { maxItems: 20 });

interface WorkflowMessageRow {
  id: string;
  workflow_run_id: string;
  sequence: number;
  role: string;
  kind: string;
  content_text: string;
  questions_json: string;
  answers_json: string;
  source_asset_ids_json: string;
  reply_to_message_id: string | null;
  client_message_id: string | null;
  created_at: string;
}

interface WorkflowWaitRow {
  id: string;
  workflow_run_id: string;
  message_id: string;
  status: string;
  answered_by_message_id: string | null;
  created_at: string;
  answered_at: string | null;
}

function mapMessage(row: WorkflowMessageRow): WorkflowMessage {
  const context = `workflow_message(${row.id})`;
  return {
    id: asId(row.id),
    workflowRunId: asId(row.workflow_run_id),
    sequence: row.sequence,
    role: row.role as WorkflowMessageRole,
    kind: row.kind as WorkflowMessageKind,
    contentText: row.content_text,
    questions: parseJsonColumn(QuestionsSchema, row.questions_json, context),
    answers: parseJsonColumn(AnswersSchema, row.answers_json, context),
    sourceAssetIds: parseJsonColumn(SourceIdsSchema, row.source_asset_ids_json, context).map((id) =>
      asId<SourceAssetId>(id),
    ),
    replyToMessageId: row.reply_to_message_id ? asId(row.reply_to_message_id) : null,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}

function mapWait(row: WorkflowWaitRow): WorkflowWait {
  return {
    id: asId(row.id),
    workflowRunId: asId(row.workflow_run_id),
    messageId: asId(row.message_id),
    status: row.status as WorkflowWaitStatus,
    answeredByMessageId: row.answered_by_message_id ? asId(row.answered_by_message_id) : null,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

export interface NewClarificationQuestion {
  question: string;
  blocking: boolean;
  relatedProposalRefs: string[];
}

export class WorkflowInteractionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listMessages(runId: string): WorkflowMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_message WHERE workflow_run_id = ? ORDER BY sequence ASC')
      .all(runId) as WorkflowMessageRow[];
    return rows.map(mapMessage);
  }

  getMessage(id: string): WorkflowMessage | null {
    const row = optionalRow<WorkflowMessageRow>(
      this.db.prepare('SELECT * FROM workflow_message WHERE id = ?').get(id),
    );
    return row ? mapMessage(row) : null;
  }

  getByClientMessageId(runId: string, clientMessageId: string): WorkflowMessage | null {
    const row = optionalRow<WorkflowMessageRow>(
      this.db
        .prepare(
          'SELECT * FROM workflow_message WHERE workflow_run_id = ? AND client_message_id = ?',
        )
        .get(runId, clientMessageId),
    );
    return row ? mapMessage(row) : null;
  }

  getOpenWait(runId: string): WorkflowWait | null {
    const row = optionalRow<WorkflowWaitRow>(
      this.db
        .prepare("SELECT * FROM workflow_wait WHERE workflow_run_id = ? AND status = 'open'")
        .get(runId),
    );
    return row ? mapWait(row) : null;
  }

  getWait(id: string): WorkflowWait | null {
    const row = optionalRow<WorkflowWaitRow>(
      this.db.prepare('SELECT * FROM workflow_wait WHERE id = ?').get(id),
    );
    return row ? mapWait(row) : null;
  }

  createAgentWait(
    runId: WorkflowRunId,
    contentText: string,
    questions: NewClarificationQuestion[],
    now: string,
  ): { message: WorkflowMessage; wait: WorkflowWait } {
    const messageId = newId<WorkflowMessageId>();
    const waitId = newId<WorkflowWaitId>();
    const persistedQuestions: WorkflowClarificationQuestion[] = questions.map((question) => ({
      id: newId(),
      question: question.question,
      blocking: question.blocking,
      relatedProposalRefs: question.relatedProposalRefs,
    }));
    this.insertMessage({
      id: messageId,
      runId,
      role: 'agent',
      kind: 'clarification',
      contentText,
      questions: persistedQuestions,
      answers: [],
      sourceAssetIds: [],
      replyToMessageId: null,
      clientMessageId: null,
      now,
    });
    this.db
      .prepare(
        `INSERT INTO workflow_wait
          (id, workflow_run_id, message_id, status, answered_by_message_id, created_at, answered_at)
         VALUES (?, ?, ?, 'open', NULL, ?, NULL)`,
      )
      .run(waitId, runId, messageId, now);
    return {
      message: this.getMessage(messageId)!,
      wait: this.getWait(waitId)!,
    };
  }

  appendUserResponse(input: {
    runId: WorkflowRunId;
    wait: WorkflowWait;
    clientMessageId: string;
    contentText: string;
    answers: WorkflowAnswer[];
    sourceAssetIds: SourceAssetId[];
    now: string;
  }): WorkflowMessage {
    const messageId = newId<WorkflowMessageId>();
    this.insertMessage({
      id: messageId,
      runId: input.runId,
      role: 'user',
      kind: 'response',
      contentText: input.contentText,
      questions: [],
      answers: input.answers,
      sourceAssetIds: input.sourceAssetIds,
      replyToMessageId: input.wait.messageId,
      clientMessageId: input.clientMessageId,
      now: input.now,
    });
    this.db
      .prepare(
        `UPDATE workflow_wait
         SET status = 'answered', answered_by_message_id = ?, answered_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(messageId, input.now, input.wait.id);
    return this.getMessage(messageId)!;
  }

  cancelOpenWaits(runId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE workflow_wait SET status = 'cancelled', answered_at = ?
         WHERE workflow_run_id = ? AND status = 'open'`,
      )
      .run(now, runId);
  }

  private insertMessage(input: {
    id: WorkflowMessageId;
    runId: WorkflowRunId;
    role: WorkflowMessageRole;
    kind: WorkflowMessageKind;
    contentText: string;
    questions: WorkflowClarificationQuestion[];
    answers: WorkflowAnswer[];
    sourceAssetIds: SourceAssetId[];
    replyToMessageId: WorkflowMessageId | null;
    clientMessageId: string | null;
    now: string;
  }): void {
    const sequence = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_message WHERE workflow_run_id = ?',
        )
        .get(input.runId) as { sequence: number }
    ).sequence;
    this.db
      .prepare(
        `INSERT INTO workflow_message
          (id, workflow_run_id, sequence, role, kind, content_text, questions_json, answers_json,
           source_asset_ids_json, reply_to_message_id, client_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        sequence,
        input.role,
        input.kind,
        input.contentText,
        JSON.stringify(input.questions),
        JSON.stringify(input.answers),
        JSON.stringify(input.sourceAssetIds),
        input.replyToMessageId,
        input.clientMessageId,
        input.now,
      );
  }
}
