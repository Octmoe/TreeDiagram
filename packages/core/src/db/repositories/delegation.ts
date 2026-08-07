import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { AuthorKind, DelegationMode, DelegationPolicy, NodeId, ProjectId } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { optionalRow } from '../row-mappers.js';

export interface DelegationPolicyRow {
  id: string;
  project_id: string;
  scope_node_id: string;
  mode: string;
  author_kind: string;
  author_ref: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function mapDelegationRow(row: DelegationPolicyRow): DelegationPolicy {
  return {
    id: asId(row.id),
    projectId: asId(row.project_id),
    scopeNodeId: asId(row.scope_node_id),
    mode: row.mode as DelegationMode,
    authorKind: row.author_kind as AuthorKind,
    authorRef: row.author_ref,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class DelegationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(policy: DelegationPolicy): void {
    this.db
      .prepare(
        `INSERT INTO delegation_policy (id, project_id, scope_node_id, mode, author_kind, author_ref, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.id,
        policy.projectId,
        policy.scopeNodeId,
        policy.mode,
        policy.authorKind,
        policy.authorRef,
        policy.createdAt,
        policy.revokedAt,
      );
  }

  getById(id: string): DelegationPolicy | null {
    const row = optionalRow<DelegationPolicyRow>(
      this.db.prepare('SELECT * FROM delegation_policy WHERE id = ?').get(id),
    );
    return row ? mapDelegationRow(row) : null;
  }

  getActiveByScope(projectId: ProjectId, scopeNodeId: NodeId): DelegationPolicy | null {
    const row = optionalRow<DelegationPolicyRow>(
      this.db
        .prepare(
          'SELECT * FROM delegation_policy WHERE project_id = ? AND scope_node_id = ? AND revoked_at IS NULL',
        )
        .get(projectId, scopeNodeId),
    );
    return row ? mapDelegationRow(row) : null;
  }

  listActiveByProject(projectId: ProjectId): DelegationPolicy[] {
    const rows = this.db
      .prepare('SELECT * FROM delegation_policy WHERE project_id = ? AND revoked_at IS NULL')
      .all(projectId) as DelegationPolicyRow[];
    return rows.map(mapDelegationRow);
  }

  revoke(id: string, revokedAt: string): void {
    this.db
      .prepare('UPDATE delegation_policy SET revoked_at = ? WHERE id = ?')
      .run(revokedAt, id);
  }
}
