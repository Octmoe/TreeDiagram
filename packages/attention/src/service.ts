import { randomUUID } from 'node:crypto';
import type { AgentActivity, AttentionContext, AttentionScope } from '@treediagram/contracts';
import { domainError } from '@treediagram/domain';
import type { V2Store } from '@treediagram/storage-sqlite';

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const nullable = (value: unknown) => (value == null ? null : String(value));

export interface AttentionIdentity {
  hostKind: string;
  hostSessionRef: string;
  clientRef: string;
}

export interface AttentionUpdate extends AttentionIdentity {
  primaryNodeId?: string | null;
  primaryChangeId?: string | null;
  selectedNodeIds?: string[];
  selectedChangeIds?: string[];
  pinnedNodeIds?: string[];
  scope?: AttentionScope;
  intentHint?: string | null;
  expectedVersion?: number;
  updatedBy?: 'user' | 'agent';
}

export interface AgentFocusInput {
  hostSessionRef: string;
  nodeIds: string[];
  phase: AgentActivity['phase'];
  summary: string;
  complete?: boolean;
}

export class AttentionService {
  constructor(private readonly store: V2Store) {}

  get(identity: AttentionIdentity): AttentionContext | null {
    const row = this.store.connection
      .prepare(
        `SELECT * FROM attention_context
      WHERE workspace_id=? AND host_kind=? AND host_session_ref=? AND client_ref=?`,
      )
      .get(
        this.store.meta.workspaceId,
        identity.hostKind,
        identity.hostSessionRef,
        identity.clientRef,
      ) as Row | undefined;
    return row ? this.mapContext(row) : null;
  }

  /**
   * Resolve the latest user-visible focus for an Agent in this project.
   *
   * Attention rows remain session-isolated for UI recovery and concurrent tabs, but a Codex task
   * must not miss a newer Sidecar selection merely because the visible tab belongs to another
   * task session. The named `<hostKind>-agent` channel is therefore projected across sessions and
   * the most recently updated row wins. Project isolation is still guaranteed by workspace_id.
   */
  getAgentVisible(identity: AttentionIdentity): AttentionContext | null {
    this.validateIdentity(identity);
    const row = this.store.connection
      .prepare(
        `SELECT * FROM attention_context
      WHERE workspace_id=? AND host_kind=? AND client_ref=?
      ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(this.store.meta.workspaceId, identity.hostKind, `${identity.hostKind}-agent`) as
      Row | undefined;
    return row ? this.mapContext(row) : this.get(identity);
  }

  set(input: AttentionUpdate): AttentionContext {
    this.validateIdentity(input);
    return this.store.connection.transaction(() => {
      const existing = this.get(input);
      if (
        input.expectedVersion !== undefined &&
        (existing?.version ?? 0) !== input.expectedVersion
      ) {
        throw domainError(
          'ATTENTION_VERSION_CONFLICT',
          'state_conflict',
          'Attention Context version 已变化。',
          {
            path: '/expectedVersion',
            expected: existing?.version ?? 0,
            actual: input.expectedVersion,
            retryable: true,
            suggestedAction: '重新读取 attention_get 后合并用户当前选择。',
          },
        );
      }
      let primaryNodeId =
        input.primaryNodeId !== undefined ? input.primaryNodeId : (existing?.primaryNodeId ?? null);
      let primaryChangeId =
        input.primaryChangeId !== undefined
          ? input.primaryChangeId
          : (existing?.primaryChangeId ?? null);
      if (input.primaryNodeId) primaryChangeId = null;
      if (input.primaryChangeId) primaryNodeId = null;
      const selectedNodeIds = input.selectedNodeIds ?? existing?.selectedNodeIds ?? [];
      const selectedChangeIds = input.selectedChangeIds ?? existing?.selectedChangeIds ?? [];
      const pinnedNodeIds = input.pinnedNodeIds ?? existing?.pinnedNodeIds ?? [];
      const scope = input.scope ?? existing?.scope ?? 'node';
      const intentHint =
        input.intentHint !== undefined ? input.intentHint : (existing?.intentHint ?? null);
      this.assertNodes([
        ...selectedNodeIds,
        ...pinnedNodeIds,
        ...(primaryNodeId ? [primaryNodeId] : []),
      ]);
      this.assertChanges([...selectedChangeIds, ...(primaryChangeId ? [primaryChangeId] : [])]);
      if (scope === 'comparison' && selectedNodeIds.length + selectedChangeIds.length < 2) {
        throw domainError(
          'COMPARISON_REQUIRES_MULTIPLE_NODES',
          'agent_recoverable',
          'comparison scope 至少需要两个已选节点或候选。',
          {
            path: '/scope',
            expected: 'at least 2',
            actual: selectedNodeIds.length + selectedChangeIds.length,
            retryable: true,
          },
        );
      }
      const id = existing?.id ?? randomUUID();
      const version = (existing?.version ?? 0) + 1;
      const now = new Date().toISOString();
      const updatedBy = input.updatedBy ?? 'user';
      this.store.connection
        .prepare(
          `INSERT INTO attention_context
        (id,workspace_id,host_kind,host_session_ref,client_ref,primary_node_id,primary_change_id,selected_node_ids_json,selected_change_ids_json,pinned_node_ids_json,scope,intent_hint,updated_by,version,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,host_kind,host_session_ref,client_ref) DO UPDATE SET
          primary_node_id=excluded.primary_node_id, primary_change_id=excluded.primary_change_id,
          selected_node_ids_json=excluded.selected_node_ids_json,
          selected_change_ids_json=excluded.selected_change_ids_json,
          pinned_node_ids_json=excluded.pinned_node_ids_json, scope=excluded.scope,
          intent_hint=excluded.intent_hint, updated_by=excluded.updated_by,
          version=excluded.version, updated_at=excluded.updated_at`,
        )
        .run(
          id,
          this.store.meta.workspaceId,
          input.hostKind,
          input.hostSessionRef,
          input.clientRef,
          primaryNodeId,
          primaryChangeId,
          JSON.stringify([...new Set(selectedNodeIds)]),
          JSON.stringify([...new Set(selectedChangeIds)]),
          JSON.stringify([...new Set(pinnedNodeIds)]),
          scope,
          intentHint,
          updatedBy,
          version,
          now,
        );
      this.store.connection
        .prepare(
          `INSERT INTO host_session_binding (id,host_kind,host_session_ref,context_id,created_at)
        VALUES (?,?,?,?,?) ON CONFLICT(host_kind,host_session_ref) DO UPDATE SET context_id=excluded.context_id`,
        )
        .run(randomUUID(), input.hostKind, input.hostSessionRef, id, now);
      this.store.emit(
        'attention.updated',
        {
          contextId: id,
          hostKind: input.hostKind,
          hostSessionRef: input.hostSessionRef,
          clientRef: input.clientRef,
          version,
          primaryNodeId,
          primaryChangeId,
          selectedNodeIds,
          selectedChangeIds,
          pinnedNodeIds,
          scope,
          updatedBy,
        },
        'attention',
      );
      if (!existing)
        this.store.emit('host.session.bound', {
          hostKind: input.hostKind,
          hostSessionRef: input.hostSessionRef,
          contextId: id,
        });
      return this.get(input)!;
    })();
  }

  pin(identity: AttentionIdentity, nodeIds: string[], expectedVersion?: number): AttentionContext {
    const existing = this.get(identity);
    const pinnedNodeIds = [...new Set([...(existing?.pinnedNodeIds ?? []), ...nodeIds])];
    return this.set({
      ...identity,
      pinnedNodeIds,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      updatedBy: 'user',
    });
  }

  clear(identity: AttentionIdentity, expectedVersion?: number): AttentionContext {
    return this.set({
      ...identity,
      primaryNodeId: null,
      primaryChangeId: null,
      selectedNodeIds: [],
      selectedChangeIds: [],
      pinnedNodeIds: [],
      scope: 'node',
      intentHint: null,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      updatedBy: 'user',
    });
  }

  listRecoveryCandidates(
    hostKind: string,
    newHostSessionRef: string,
    limit = 5,
  ): AttentionContext[] {
    const rows = this.store.connection
      .prepare(
        `SELECT * FROM attention_context
      WHERE workspace_id=? AND host_kind=? AND host_session_ref<>?
      ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(
        this.store.meta.workspaceId,
        hostKind,
        newHostSessionRef,
        Math.max(1, Math.min(limit, 20)),
      ) as Row[];
    return rows.map((row) => this.mapContext(row));
  }

  restore(sourceContextId: string, identity: AttentionIdentity): AttentionContext {
    const row = this.store.connection
      .prepare('SELECT * FROM attention_context WHERE id=? AND workspace_id=?')
      .get(sourceContextId, this.store.meta.workspaceId) as Row | undefined;
    if (!row)
      throw domainError(
        'ATTENTION_CONTEXT_NOT_FOUND',
        'agent_recoverable',
        '找不到可恢复的 Attention Context。',
        { actual: sourceContextId, retryable: true },
      );
    const source = this.mapContext(row);
    if (source.hostSessionRef === identity.hostSessionRef)
      return this.set({
        ...identity,
        primaryNodeId: source.primaryNodeId,
        primaryChangeId: source.primaryChangeId,
        selectedNodeIds: source.selectedNodeIds,
        selectedChangeIds: source.selectedChangeIds,
        pinnedNodeIds: source.pinnedNodeIds,
        scope: source.scope,
        intentHint: source.intentHint,
        updatedBy: 'user',
      });
    return this.set({
      ...identity,
      primaryNodeId: source.primaryNodeId,
      primaryChangeId: source.primaryChangeId,
      selectedNodeIds: source.selectedNodeIds,
      selectedChangeIds: source.selectedChangeIds,
      pinnedNodeIds: source.pinnedNodeIds,
      scope: source.scope,
      intentHint: source.intentHint,
      updatedBy: 'user',
    });
  }

  setAgentFocus(input: AgentFocusInput): AgentActivity {
    this.assertNodes(input.nodeIds);
    const now = new Date().toISOString();
    this.store.connection
      .prepare('UPDATE agent_activity SET ended_at=? WHERE host_session_ref=? AND ended_at IS NULL')
      .run(now, input.hostSessionRef);
    const id = randomUUID();
    this.store.connection
      .prepare(
        'INSERT INTO agent_activity (id,host_session_ref,node_ids_json,phase,summary,started_at,ended_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.hostSessionRef,
        JSON.stringify([...new Set(input.nodeIds)]),
        input.phase,
        input.summary,
        now,
        input.complete ? now : null,
      );
    this.store.emit(
      'agent.focus.changed',
      {
        activityId: id,
        hostSessionRef: input.hostSessionRef,
        nodeIds: input.nodeIds,
        phase: input.phase,
        summary: input.summary,
        complete: input.complete ?? false,
      },
      'attention',
    );
    return this.latestAgentFocus(input.hostSessionRef)!;
  }

  latestAgentFocus(hostSessionRef: string): AgentActivity | null {
    const row = this.store.connection
      .prepare(
        'SELECT * FROM agent_activity WHERE host_session_ref=? ORDER BY started_at DESC LIMIT 1',
      )
      .get(hostSessionRef) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      hostSessionRef: String(row['host_session_ref']),
      nodeIds: parse<string[]>(row['node_ids_json']),
      phase: String(row['phase']) as AgentActivity['phase'],
      summary: String(row['summary']),
      startedAt: String(row['started_at']),
      endedAt: nullable(row['ended_at']),
    };
  }

  private assertNodes(nodeIds: string[]): void {
    for (const nodeId of new Set(nodeIds)) this.store.getNode(nodeId);
  }

  private assertChanges(changeIds: string[]): void {
    for (const changeId of new Set(changeIds)) {
      const row = this.store.connection
        .prepare('SELECT 1 FROM design_change WHERE id = ?')
        .get(changeId);
      if (!row)
        throw domainError('CHANGE_NOT_FOUND', 'agent_recoverable', `候选变更不存在: ${changeId}`, {
          path: '/selectedChangeIds',
          actual: changeId,
          retryable: true,
          suggestedAction: '刷新 ChangeSet 并使用当前候选 ID。',
        });
    }
  }

  private validateIdentity(identity: AttentionIdentity): void {
    for (const [path, value, max] of [
      ['hostKind', identity.hostKind, 64],
      ['hostSessionRef', identity.hostSessionRef, 256],
      ['clientRef', identity.clientRef, 128],
    ] as const) {
      if (!value.trim() || value.length > max)
        throw domainError(
          'ATTENTION_IDENTITY_INVALID',
          'agent_recoverable',
          `${path} 不能为空且长度不能超过 ${max}。`,
          { path: `/${path}`, actual: value, retryable: true },
        );
    }
  }

  private mapContext(row: Row): AttentionContext {
    return {
      id: String(row['id']),
      workspaceId: String(row['workspace_id']),
      hostKind: String(row['host_kind']),
      hostSessionRef: String(row['host_session_ref']),
      clientRef: String(row['client_ref']),
      primaryNodeId: nullable(row['primary_node_id']),
      primaryChangeId: nullable(row['primary_change_id']),
      selectedNodeIds: parse<string[]>(row['selected_node_ids_json']),
      selectedChangeIds: parse<string[]>(row['selected_change_ids_json'] ?? '[]'),
      pinnedNodeIds: parse<string[]>(row['pinned_node_ids_json']),
      scope: String(row['scope']) as AttentionScope,
      intentHint: nullable(row['intent_hint']),
      updatedBy: String(row['updated_by']) as 'user' | 'agent',
      version: Number(row['version']),
      updatedAt: String(row['updated_at']),
    };
  }
}
