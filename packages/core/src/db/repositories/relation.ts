import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {
  ApprovalState,
  AuthorKind,
  ProjectId,
  Relation,
  RelationRevision,
  RelationType,
} from '@treediagram/contracts';
import { asId, AuthorizationSchema, RelationAttributesSchema } from '@treediagram/contracts';
import { parseJsonColumn, optionalRow } from '../row-mappers.js';
import { chunkArray, SQLITE_IN_CHUNK_SIZE } from '../chunk.js';

export interface RelationRow {
  id: string;
  project_id: string;
  relation_type: string;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

export interface RelationRevisionRow {
  id: string;
  relation_id: string;
  created_in_change_set_id: string;
  revision_number: number;
  from_node_revision_id: string;
  to_node_revision_id: string;
  rationale_text: string;
  attributes_json: string;
  approval_state: string;
  authorization_json: string | null;
  supersedes_relation_revision_id: string | null;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

export function mapRelationRow(row: RelationRow): Relation {
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    relationType: row.relation_type as RelationType,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

export function mapRelationRevisionRow(row: RelationRevisionRow): RelationRevision {
  const ctx = `relation_revision(${row.id})`;
  return {
    id: asId(row.id),
    relationId: asId(row.relation_id),
    createdInChangeSetId: asId(row.created_in_change_set_id),
    revisionNumber: row.revision_number,
    fromNodeRevisionId: asId(row.from_node_revision_id),
    toNodeRevisionId: asId(row.to_node_revision_id),
    rationaleText: row.rationale_text,
    attributes: parseJsonColumn(RelationAttributesSchema, row.attributes_json, ctx),
    approvalState: row.approval_state as ApprovalState,
    authorization: row.authorization_json
      ? parseJsonColumn(AuthorizationSchema, row.authorization_json, ctx)
      : null,
    supersedesRelationRevisionId: row.supersedes_relation_revision_id
      ? asId(row.supersedes_relation_revision_id)
      : null,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

export class RelationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertRelation(relation: Relation): void {
    this.db
      .prepare(
        'INSERT INTO relation (id, project_id, relation_type, author_kind, author_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        relation.id,
        relation.projectId,
        relation.relationType,
        relation.authorKind,
        relation.authorRef,
        relation.createdAt,
      );
  }

  insertRevision(revision: RelationRevision): void {
    this.db
      .prepare(
        `INSERT INTO relation_revision (id, relation_id, created_in_change_set_id, revision_number,
          from_node_revision_id, to_node_revision_id, rationale_text, attributes_json, approval_state,
          authorization_json, supersedes_relation_revision_id, author_kind, author_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.relationId,
        revision.createdInChangeSetId,
        revision.revisionNumber,
        revision.fromNodeRevisionId,
        revision.toNodeRevisionId,
        revision.rationaleText,
        JSON.stringify(revision.attributes),
        revision.approvalState,
        revision.authorization ? JSON.stringify(revision.authorization) : null,
        revision.supersedesRelationRevisionId,
        revision.authorKind,
        revision.authorRef,
        revision.createdAt,
      );
  }

  getRelationById(id: string): Relation | null {
    const row = optionalRow<RelationRow>(
      this.db.prepare('SELECT * FROM relation WHERE id = ?').get(id),
    );
    return row ? mapRelationRow(row) : null;
  }

  getRevisionById(id: string): RelationRevision | null {
    const row = optionalRow<RelationRevisionRow>(
      this.db.prepare('SELECT * FROM relation_revision WHERE id = ?').get(id),
    );
    return row ? mapRelationRevisionRow(row) : null;
  }

  getRevisionsByIds(ids: readonly string[]): Map<string, RelationRevision> {
    const result = new Map<string, RelationRevision>();
    for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM relation_revision WHERE id IN (${placeholders})`)
        .all(...chunk) as RelationRevisionRow[];
      for (const row of rows) {
        const revision = mapRelationRevisionRow(row);
        result.set(revision.id, revision);
      }
    }
    return result;
  }

  listRevisionsByRelation(relationId: string): RelationRevision[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM relation_revision WHERE relation_id = ? ORDER BY revision_number DESC',
      )
      .all(relationId) as RelationRevisionRow[];
    return rows.map(mapRelationRevisionRow);
  }

  maxRevisionNumber(relationId: string): number {
    const row = this.db
      .prepare('SELECT MAX(revision_number) AS v FROM relation_revision WHERE relation_id = ?')
      .get(relationId) as { v: number | null };
    return row.v ?? 0;
  }

  listRelationsByProject(projectId: ProjectId): Relation[] {
    const rows = this.db
      .prepare('SELECT * FROM relation WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as RelationRow[];
    return rows.map(mapRelationRow);
  }

  getRelationsByIds(ids: readonly string[]): Map<string, Relation> {
    const result = new Map<string, Relation>();
    for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM relation WHERE id IN (${placeholders})`)
        .all(...chunk) as RelationRow[];
      for (const row of rows) {
        const relation = mapRelationRow(row);
        result.set(relation.id, relation);
      }
    }
    return result;
  }

  /** 找到端点触及给定节点修订集合的全部关系修订（影响分析使用）。 */
  listRevisionsTouchingNodeRevisions(nodeRevisionIds: readonly string[]): RelationRevision[] {
    const result: RelationRevision[] = [];
    for (const chunk of chunkArray(nodeRevisionIds, SQLITE_IN_CHUNK_SIZE / 2)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM relation_revision
           WHERE from_node_revision_id IN (${placeholders}) OR to_node_revision_id IN (${placeholders})`,
        )
        .all(...chunk, ...chunk) as RelationRevisionRow[];
      result.push(...rows.map(mapRelationRevisionRow));
    }
    return result;
  }
}
