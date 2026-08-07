import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type, type Static } from '@sinclair/typebox';
import type { ProjectId, ProjectState, ReleaseId } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { parseJsonColumn, optionalRow } from '../row-mappers.js';
import { DomainError } from '../../errors.js';

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  current_release_id: string | null;
  admin_token_sha256: string;
  consumer_token_sha256: string;
  blocked_reason_json: string | null;
  created_at: string;
  updated_at: string;
}

export const BlockedReasonSchema = Type.Object(
  {
    reasonCode: Type.String(),
    message: Type.String(),
    issues: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type BlockedReason = Static<typeof BlockedReasonSchema>;

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  status: ProjectState;
  currentReleaseId: ReleaseId | null;
  adminTokenSha256: string;
  consumerTokenSha256: string;
  blockedReason: BlockedReason | null;
  createdAt: string;
  updatedAt: string;
}

export function mapProjectRow(row: ProjectRow): ProjectRecord {
  return {
    id: asId(row.id),
    name: row.name,
    status: row.status as ProjectState,
    currentReleaseId: row.current_release_id ? asId(row.current_release_id) : null,
    adminTokenSha256: row.admin_token_sha256,
    consumerTokenSha256: row.consumer_token_sha256,
    blockedReason: row.blocked_reason_json
      ? parseJsonColumn(BlockedReasonSchema, row.blocked_reason_json, 'project.blocked_reason_json')
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: ProjectRecord): void {
    this.db
      .prepare(
        `INSERT INTO project (id, name, status, current_release_id, admin_token_sha256, consumer_token_sha256, blocked_reason_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.status,
        record.currentReleaseId,
        record.adminTokenSha256,
        record.consumerTokenSha256,
        record.blockedReason ? JSON.stringify(record.blockedReason) : null,
        record.createdAt,
        record.updatedAt,
      );
  }

  getSingleton(): ProjectRecord | null {
    const row = optionalRow<ProjectRow>(this.db.prepare('SELECT * FROM project LIMIT 1').get());
    return row ? mapProjectRow(row) : null;
  }

  requireSingleton(): ProjectRecord {
    const project = this.getSingleton();
    if (!project) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', '工作区缺少 singleton project');
    }
    return project;
  }

  updateStatus(
    projectId: ProjectId,
    status: ProjectState,
    blockedReason: BlockedReason | null,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        'UPDATE project SET status = ?, blocked_reason_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, blockedReason ? JSON.stringify(blockedReason) : null, updatedAt, projectId);
  }

  setCurrentRelease(projectId: ProjectId, releaseId: ReleaseId, updatedAt: string): void {
    this.db
      .prepare('UPDATE project SET current_release_id = ?, updated_at = ? WHERE id = ?')
      .run(releaseId, updatedAt, projectId);
  }
}
