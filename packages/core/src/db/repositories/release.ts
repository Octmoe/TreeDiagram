import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { AuthorKind, ProjectId, Release } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { optionalRow } from '../row-mappers.js';

export interface ReleaseRow {
  id: string;
  project_id: string;
  version: number;
  root_revision_ids_json: string;
  node_revision_ids_json: string;
  relation_revision_ids_json: string;
  summary: string;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

export function mapReleaseRow(
  row: ReleaseRow,
  parseIds: (raw: string, ctx: string) => string[],
): Release {
  const ctx = `release(${row.id})`;
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    version: row.version,
    rootRevisionIds: parseIds(row.root_revision_ids_json, ctx).map((v) => asId(v)),
    nodeRevisionIds: parseIds(row.node_revision_ids_json, ctx).map((v) => asId(v)),
    relationRevisionIds: parseIds(row.relation_revision_ids_json, ctx).map((v) => asId(v)),
    summary: row.summary,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

export class ReleaseRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly parseIds: (raw: string, ctx: string) => string[],
  ) {}

  insert(release: Release): void {
    this.db
      .prepare(
        `INSERT INTO release (id, project_id, version, root_revision_ids_json, node_revision_ids_json, relation_revision_ids_json, summary, author_kind, author_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.id,
        release.projectId,
        release.version,
        JSON.stringify(release.rootRevisionIds),
        JSON.stringify(release.nodeRevisionIds),
        JSON.stringify(release.relationRevisionIds),
        release.summary,
        release.authorKind,
        release.authorRef,
        release.createdAt,
      );
  }

  getById(id: string): Release | null {
    const row = optionalRow<ReleaseRow>(
      this.db.prepare('SELECT * FROM release WHERE id = ?').get(id),
    );
    return row ? mapReleaseRow(row, this.parseIds) : null;
  }

  getLatestByProject(projectId: ProjectId): Release | null {
    const row = optionalRow<ReleaseRow>(
      this.db
        .prepare('SELECT * FROM release WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .get(projectId),
    );
    return row ? mapReleaseRow(row, this.parseIds) : null;
  }

  nextVersion(projectId: ProjectId): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM release WHERE project_id = ?')
      .get(projectId) as { v: number | null };
    return (row.v ?? 0) + 1;
  }
}
