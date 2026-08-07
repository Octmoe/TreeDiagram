import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import type {
  ProjectId,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowType,
} from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { parseJsonColumn, optionalRow } from '../row-mappers.js';

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());

export interface WorkflowRunRow {
  id: string;
  project_id: string;
  change_set_id: string | null;
  workflow_type: string;
  target_node_id: string | null;
  status: string;
  current_step: string;
  input_json: string;
  checkpoint_json: string;
  summary_json: string | null;
  error_json: string | null;
  provider: string | null;
  model: string | null;
  provider_response_id: string | null;
  usage_json: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

export function mapWorkflowRunRow(row: WorkflowRunRow): WorkflowRun {
  const ctx = `workflow_run(${row.id})`;
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    changeSetId: row.change_set_id ? asId(row.change_set_id) : null,
    workflowType: row.workflow_type as WorkflowType,
    targetNodeId: row.target_node_id ? asId(row.target_node_id) : null,
    status: row.status as WorkflowRunStatus,
    currentStep: row.current_step,
    input: parseJsonColumn(JsonObjectSchema, row.input_json, ctx),
    checkpoint: parseJsonColumn(JsonObjectSchema, row.checkpoint_json, ctx),
    summary: row.summary_json ? parseJsonColumn(JsonObjectSchema, row.summary_json, ctx) : null,
    error: row.error_json ? parseJsonColumn(JsonObjectSchema, row.error_json, ctx) : null,
    provider: row.provider,
    model: row.model,
    providerResponseId: row.provider_response_id,
    usage: row.usage_json ? parseJsonColumn(JsonObjectSchema, row.usage_json, ctx) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export interface WorkflowRunPatch {
  status?: WorkflowRunStatus;
  currentStep?: string;
  checkpoint?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  provider?: string | null;
  model?: string | null;
  providerResponseId?: string | null;
  usage?: Record<string, unknown> | null;
  changeSetId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export class WorkflowRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(run: WorkflowRun): void {
    this.db
      .prepare(
        `INSERT INTO workflow_run (id, project_id, change_set_id, workflow_type, target_node_id, status,
          current_step, input_json, checkpoint_json, summary_json, error_json, provider, model,
          provider_response_id, usage_json, created_at, started_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.changeSetId,
        run.workflowType,
        run.targetNodeId,
        run.status,
        run.currentStep,
        JSON.stringify(run.input),
        JSON.stringify(run.checkpoint),
        run.summary ? JSON.stringify(run.summary) : null,
        run.error ? JSON.stringify(run.error) : null,
        run.provider,
        run.model,
        run.providerResponseId,
        run.usage ? JSON.stringify(run.usage) : null,
        run.createdAt,
        run.startedAt,
        run.updatedAt,
        run.finishedAt,
      );
  }

  getById(id: string): WorkflowRun | null {
    const row = optionalRow<WorkflowRunRow>(
      this.db.prepare('SELECT * FROM workflow_run WHERE id = ?').get(id),
    );
    return row ? mapWorkflowRunRow(row) : null;
  }

  update(id: string, patch: WorkflowRunPatch, updatedAt: string): void {
    const sets: string[] = ['updated_at = @updatedAt'];
    const params: Record<string, unknown> = { id, updatedAt };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params['status'] = patch.status;
    }
    if (patch.currentStep !== undefined) {
      sets.push('current_step = @currentStep');
      params['currentStep'] = patch.currentStep;
    }
    if (patch.checkpoint !== undefined) {
      sets.push('checkpoint_json = @checkpoint');
      params['checkpoint'] = JSON.stringify(patch.checkpoint);
    }
    if (patch.summary !== undefined) {
      sets.push('summary_json = @summary');
      params['summary'] = patch.summary ? JSON.stringify(patch.summary) : null;
    }
    if (patch.error !== undefined) {
      sets.push('error_json = @error');
      params['error'] = patch.error ? JSON.stringify(patch.error) : null;
    }
    if (patch.provider !== undefined) {
      sets.push('provider = @provider');
      params['provider'] = patch.provider;
    }
    if (patch.model !== undefined) {
      sets.push('model = @model');
      params['model'] = patch.model;
    }
    if (patch.providerResponseId !== undefined) {
      sets.push('provider_response_id = @providerResponseId');
      params['providerResponseId'] = patch.providerResponseId;
    }
    if (patch.usage !== undefined) {
      sets.push('usage_json = @usage');
      params['usage'] = patch.usage ? JSON.stringify(patch.usage) : null;
    }
    if (patch.changeSetId !== undefined) {
      sets.push('change_set_id = @changeSetId');
      params['changeSetId'] = patch.changeSetId;
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = @startedAt');
      params['startedAt'] = patch.startedAt;
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = @finishedAt');
      params['finishedAt'] = patch.finishedAt;
    }
    this.db.prepare(`UPDATE workflow_run SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  listByProject(
    projectId: ProjectId,
    limit: number,
    beforeCreatedAt: string | null,
  ): WorkflowRun[] {
    const rows = (
      beforeCreatedAt
        ? this.db
            .prepare(
              'SELECT * FROM workflow_run WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(projectId, beforeCreatedAt, limit)
        : this.db
            .prepare(
              'SELECT * FROM workflow_run WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
            )
            .all(projectId, limit)
    ) as WorkflowRunRow[];
    return rows.map(mapWorkflowRunRow);
  }

  /** 重启恢复：遗留 queued/running 的运行（§4.6 PROCESS_INTERRUPTED）。 */
  listInterrupted(projectId: ProjectId): WorkflowRun[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_run WHERE project_id = ? AND status IN ('queued','running')")
      .all(projectId) as WorkflowRunRow[];
    return rows.map(mapWorkflowRunRow);
  }

  hasActiveRun(projectId: ProjectId, excludeRunId?: string): boolean {
    // waiting_user 是暂停等待用户的活跃态（API_CONTRACT：running/paused 时 409）。
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM workflow_run
         WHERE project_id = ? AND status IN ('queued','running','waiting_user')
           AND (? IS NULL OR id <> ?)
         LIMIT 1`,
      )
      .get(projectId, excludeRunId ?? null, excludeRunId ?? null);
    return row !== undefined;
  }
}
