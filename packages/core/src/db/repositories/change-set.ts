import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { ChangeSet, ChangeSetStatus, ProjectId } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { optionalRow } from '../row-mappers.js';

export interface ChangeSetRow {
  id: string;
  project_id: string;
  base_release_id: string | null;
  status: string;
  title: string;
  description: string;
  adopted_at: string | null;
  published_release_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NodeHeadRow {
  change_set_id: string;
  node_id: string;
  node_revision_id: string | null;
  action: string;
}

export interface RelationHeadRow {
  change_set_id: string;
  relation_id: string;
  relation_revision_id: string | null;
  action: string;
}

export interface NodeHead {
  nodeId: string;
  nodeRevisionId: string | null;
  action: 'upsert' | 'remove';
}

export interface RelationHead {
  relationId: string;
  relationRevisionId: string | null;
  action: 'upsert' | 'remove';
}

export function mapChangeSetRow(row: ChangeSetRow): ChangeSet {
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    baseReleaseId: row.base_release_id ? asId(row.base_release_id) : null,
    status: row.status as ChangeSetStatus,
    title: row.title,
    description: row.description,
    adoptedAt: row.adopted_at,
    publishedReleaseId: row.published_release_id ? asId(row.published_release_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChangeSetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(changeSet: ChangeSet): void {
    this.db
      .prepare(
        `INSERT INTO change_set (id, project_id, base_release_id, status, title, description, adopted_at, published_release_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        changeSet.id,
        changeSet.projectId,
        changeSet.baseReleaseId,
        changeSet.status,
        changeSet.title,
        changeSet.description,
        changeSet.adoptedAt,
        changeSet.publishedReleaseId,
        changeSet.createdAt,
        changeSet.updatedAt,
      );
  }

  getById(id: string): ChangeSet | null {
    const row = optionalRow<ChangeSetRow>(
      this.db.prepare('SELECT * FROM change_set WHERE id = ?').get(id),
    );
    return row ? mapChangeSetRow(row) : null;
  }

  /** 每项目至多一个 live ChangeSet（open/reevaluating/ready），由 partial unique index 保证。 */
  getLiveByProject(projectId: ProjectId): ChangeSet | null {
    const row = optionalRow<ChangeSetRow>(
      this.db
        .prepare(
          "SELECT * FROM change_set WHERE project_id = ? AND status IN ('open','reevaluating','ready') LIMIT 1",
        )
        .get(projectId),
    );
    return row ? mapChangeSetRow(row) : null;
  }

  updateStatus(
    id: string,
    status: ChangeSetStatus,
    updatedAt: string,
    extra: { adoptedAt?: string | null; publishedReleaseId?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE change_set SET status = ?, updated_at = ?,
           adopted_at = COALESCE(?, adopted_at),
           published_release_id = COALESCE(?, published_release_id)
         WHERE id = ?`,
      )
      .run(status, updatedAt, extra.adoptedAt ?? null, extra.publishedReleaseId ?? null, id);
  }

  // ---- heads ----

  upsertNodeHead(changeSetId: string, head: NodeHead): void {
    this.db
      .prepare(
        `INSERT INTO change_set_node_head (change_set_id, node_id, node_revision_id, action)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(change_set_id, node_id)
         DO UPDATE SET node_revision_id = excluded.node_revision_id, action = excluded.action`,
      )
      .run(changeSetId, head.nodeId, head.nodeRevisionId, head.action);
  }

  upsertRelationHead(changeSetId: string, head: RelationHead): void {
    this.db
      .prepare(
        `INSERT INTO change_set_relation_head (change_set_id, relation_id, relation_revision_id, action)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(change_set_id, relation_id)
         DO UPDATE SET relation_revision_id = excluded.relation_revision_id, action = excluded.action`,
      )
      .run(changeSetId, head.relationId, head.relationRevisionId, head.action);
  }

  getNodeHead(changeSetId: string, nodeId: string): NodeHead | null {
    const row = optionalRow<NodeHeadRow>(
      this.db
        .prepare('SELECT * FROM change_set_node_head WHERE change_set_id = ? AND node_id = ?')
        .get(changeSetId, nodeId),
    );
    return row
      ? {
          nodeId: row.node_id,
          nodeRevisionId: row.node_revision_id,
          action: row.action as 'upsert' | 'remove',
        }
      : null;
  }

  getRelationHead(changeSetId: string, relationId: string): RelationHead | null {
    const row = optionalRow<RelationHeadRow>(
      this.db
        .prepare(
          'SELECT * FROM change_set_relation_head WHERE change_set_id = ? AND relation_id = ?',
        )
        .get(changeSetId, relationId),
    );
    return row
      ? {
          relationId: row.relation_id,
          relationRevisionId: row.relation_revision_id,
          action: row.action as 'upsert' | 'remove',
        }
      : null;
  }

  deleteNodeHead(changeSetId: string, nodeId: string): void {
    this.db
      .prepare('DELETE FROM change_set_node_head WHERE change_set_id = ? AND node_id = ?')
      .run(changeSetId, nodeId);
  }

  deleteRelationHead(changeSetId: string, relationId: string): void {
    this.db
      .prepare('DELETE FROM change_set_relation_head WHERE change_set_id = ? AND relation_id = ?')
      .run(changeSetId, relationId);
  }

  listNodeHeads(changeSetId: string): NodeHead[] {
    const rows = this.db
      .prepare('SELECT * FROM change_set_node_head WHERE change_set_id = ?')
      .all(changeSetId) as NodeHeadRow[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      nodeRevisionId: r.node_revision_id,
      action: r.action as 'upsert' | 'remove',
    }));
  }

  listRelationHeads(changeSetId: string): RelationHead[] {
    const rows = this.db
      .prepare('SELECT * FROM change_set_relation_head WHERE change_set_id = ?')
      .all(changeSetId) as RelationHeadRow[];
    return rows.map((r) => ({
      relationId: r.relation_id,
      relationRevisionId: r.relation_revision_id,
      action: r.action as 'upsert' | 'remove',
    }));
  }
}
