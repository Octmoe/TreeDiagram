import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import type {
  ApprovalState,
  AuthorKind,
  EpistemicState,
  Node,
  NodeRevision,
  NodeType,
  ProjectId,
} from '@treediagram/contracts';
import {
  asId,
  AuthorizationSchema,
  NodeAttributesSchema,
  RolesSchema,
} from '@treediagram/contracts';
import { parseJsonColumn, optionalRow } from '../row-mappers.js';
import { chunkArray, SQLITE_IN_CHUNK_SIZE } from '../chunk.js';

export interface NodeRow {
  id: string;
  project_id: string;
  node_type: string;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

export interface NodeRevisionRow {
  id: string;
  node_id: string;
  created_in_change_set_id: string;
  revision_number: number;
  display_title: string;
  content_text: string;
  roles_json: string;
  attributes_json: string;
  approval_state: string;
  epistemic_state: string | null;
  authorization_json: string | null;
  supersedes_revision_id: string | null;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
}

export function mapNodeRow(row: NodeRow): Node {
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    nodeType: row.node_type as NodeType,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

export function mapNodeRevisionRow(row: NodeRevisionRow): NodeRevision {
  const ctx = `node_revision(${row.id})`;
  return {
    id: asId(row.id),
    nodeId: asId(row.node_id),
    createdInChangeSetId: asId(row.created_in_change_set_id),
    revisionNumber: row.revision_number,
    displayTitle: row.display_title,
    contentText: row.content_text,
    roles: parseJsonColumn(RolesSchema, row.roles_json, ctx),
    attributes: parseJsonColumn(NodeAttributesSchema, row.attributes_json, ctx),
    approvalState: row.approval_state as ApprovalState,
    epistemicState: row.epistemic_state ? (row.epistemic_state as EpistemicState) : null,
    authorization: row.authorization_json
      ? parseJsonColumn(AuthorizationSchema, row.authorization_json, ctx)
      : null,
    supersedesRevisionId: row.supersedes_revision_id ? asId(row.supersedes_revision_id) : null,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
  };
}

const IdArraySchema = Type.Array(Type.String());

export class NodeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertNode(node: Node): void {
    this.db
      .prepare(
        'INSERT INTO node (id, project_id, node_type, author_kind, author_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(node.id, node.projectId, node.nodeType, node.authorKind, node.authorRef, node.createdAt);
  }

  insertRevision(revision: NodeRevision): void {
    this.db
      .prepare(
        `INSERT INTO node_revision (id, node_id, created_in_change_set_id, revision_number, display_title, content_text,
          roles_json, attributes_json, approval_state, epistemic_state, authorization_json,
          supersedes_revision_id, author_kind, author_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.id,
        revision.nodeId,
        revision.createdInChangeSetId,
        revision.revisionNumber,
        revision.displayTitle,
        revision.contentText,
        JSON.stringify(revision.roles),
        JSON.stringify(revision.attributes),
        revision.approvalState,
        revision.epistemicState,
        revision.authorization ? JSON.stringify(revision.authorization) : null,
        revision.supersedesRevisionId,
        revision.authorKind,
        revision.authorRef,
        revision.createdAt,
      );
    this.ftsUpsert(revision.id, revision.displayTitle, revision.contentText);
  }

  getNodeById(id: string): Node | null {
    const row = optionalRow<NodeRow>(this.db.prepare('SELECT * FROM node WHERE id = ?').get(id));
    return row ? mapNodeRow(row) : null;
  }

  getRevisionById(id: string): NodeRevision | null {
    const row = optionalRow<NodeRevisionRow>(
      this.db.prepare('SELECT * FROM node_revision WHERE id = ?').get(id),
    );
    return row ? mapNodeRevisionRow(row) : null;
  }

  getRevisionsByIds(ids: readonly string[]): Map<string, NodeRevision> {
    const result = new Map<string, NodeRevision>();
    for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM node_revision WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRevisionRow[];
      for (const row of rows) {
        const revision = mapNodeRevisionRow(row);
        result.set(revision.id, revision);
      }
    }
    return result;
  }

  listRevisionsByNode(nodeId: string): NodeRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM node_revision WHERE node_id = ? ORDER BY revision_number DESC')
      .all(nodeId) as NodeRevisionRow[];
    return rows.map(mapNodeRevisionRow);
  }

  maxRevisionNumber(nodeId: string): number {
    const row = this.db
      .prepare('SELECT MAX(revision_number) AS v FROM node_revision WHERE node_id = ?')
      .get(nodeId) as { v: number | null };
    return row.v ?? 0;
  }

  listNodesByProject(projectId: ProjectId): Node[] {
    const rows = this.db
      .prepare('SELECT * FROM node WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as NodeRow[];
    return rows.map(mapNodeRow);
  }

  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const result = new Map<string, Node>();
    for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM node WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = mapNodeRow(row);
        result.set(node.id, node);
      }
    }
    return result;
  }

  /** 校验一组 ID 数组的持久化 JSON。 */
  parseIdArray(raw: string, context: string): string[] {
    return parseJsonColumn(IdArraySchema, raw, context);
  }

  // ---- FTS5 ----

  ftsUpsert(revisionId: string, title: string, content: string): void {
    this.db.prepare('DELETE FROM node_revision_fts WHERE revision_id = ?').run(revisionId);
    this.db
      .prepare(
        'INSERT INTO node_revision_fts (revision_id, display_title, content_text) VALUES (?, ?, ?)',
      )
      .run(revisionId, title, content);
  }

  ftsSearch(query: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        'SELECT revision_id FROM node_revision_fts WHERE node_revision_fts MATCH ? ORDER BY rank LIMIT ?',
      )
      .all(query, limit) as Array<{ revision_id: string }>;
    return rows.map((r) => r.revision_id);
  }

  /** FTS 不可用/查询语法失败时的 LIKE 兼容回退（§7.6）。 */
  likeSearch(tokens: readonly string[], limit: number): string[] {
    if (tokens.length === 0) return [];
    const clauses = tokens.map(() => '(display_title LIKE ? OR content_text LIKE ?)').join(' AND ');
    const params = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
    const rows = this.db
      .prepare(`SELECT id FROM node_revision WHERE ${clauses} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
