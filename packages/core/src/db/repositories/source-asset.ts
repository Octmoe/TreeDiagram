import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  AuthorKind,
  ProjectId,
  SourceAsset,
  SourceAssetMeta,
  SourceKind,
} from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { optionalRow } from '../row-mappers.js';

export interface SourceAssetRow {
  id: string;
  project_id: string;
  kind: string;
  original_name: string | null;
  media_type: string;
  content_text: string;
  sha256: string;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

function mapMeta(row: SourceAssetRow): SourceAssetMeta {
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    kind: row.kind as SourceKind,
    originalName: row.original_name,
    mediaType: row.media_type,
    sha256: row.sha256,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

export class SourceAssetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(asset: SourceAsset): void {
    this.db
      .prepare(
        `INSERT INTO source_asset (id, project_id, kind, original_name, media_type, content_text, sha256, author_kind, author_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.id,
        asset.projectId,
        asset.kind,
        asset.originalName,
        asset.mediaType,
        asset.contentText,
        asset.sha256,
        asset.authorKind,
        asset.authorRef,
        asset.createdAt,
      );
  }

  getById(id: string): SourceAsset | null {
    const row = optionalRow<SourceAssetRow>(
      this.db.prepare('SELECT * FROM source_asset WHERE id = ?').get(id),
    );
    return row ? { ...mapMeta(row), contentText: row.content_text } : null;
  }

  listByProject(projectId: ProjectId): SourceAssetMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM source_asset WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as SourceAssetRow[];
    return rows.map(mapMeta);
  }

  getContentByIds(ids: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, content_text FROM source_asset WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; content_text: string }>;
    for (const row of rows) result.set(row.id, row.content_text);
    return result;
  }
}
