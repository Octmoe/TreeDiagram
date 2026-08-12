import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { uptime } from 'node:os';
import {
  CHANGESET_LEASE_HANDOFF_TIMEOUT_MS,
  hasDesignRootRole,
  type ApprovalAction,
  type ApprovalGrant,
  type ChangeSet,
  type ChangeSetLeaseRecoveryReason,
  type ChangeSetLeaseHandoffRequest,
  type ChangeSetLeaseStatus,
  type ChangeSetWriteLease,
  type CreateNodePayload,
  type CreateRelationPayload,
  type DesignChange,
  type NodeDetail,
  type RelationDetail,
  type Release,
  type ReviseNodePayload,
  type ReviseRelationPayload,
  type ValidationResult,
  type WorkspaceMeta,
  type WorkspaceSummary,
} from '@treediagram/contracts';
import type { ProposeChangeInput } from '@treediagram/contracts';
import {
  checkConsistency,
  domainError,
  stableDigest,
  validateChangePayload,
} from '@treediagram/domain';
import { openWorkspaceDatabase } from './workspace.js';
import {
  mapChange,
  mapChangeSet,
  mapGrant,
  mapLease,
  mapLeaseHandoffRequest,
  mapNode,
  mapRelation,
  mapRelease,
  NODE_SELECT,
  RELATION_SELECT,
  RELEASE_NODE_SELECT,
  RELEASE_RELATION_SELECT,
} from './rows.js';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const SYSTEM_BOOTED_AT_MS = Date.now() - uptime() * 1000;
const BOOT_TIME_TOLERANCE_MS = 60_000;

export interface ApprovalTarget {
  digest: string;
  version: number;
  description: string;
}
export interface IssuedGrant {
  token: string;
  grant: ApprovalGrant;
}

export class V2Store {
  readonly connection: Database.Database;
  readonly meta: WorkspaceMeta;

  constructor(workspaceDir: string) {
    const opened = openWorkspaceDatabase(workspaceDir);
    this.connection = opened.db;
    this.meta = opened.meta;
  }

  close(): void {
    this.connection.close();
  }

  dataVersion(): number {
    return Number(this.connection.pragma('data_version', { simple: true }));
  }

  clearWorkspaceDataIfUnchanged(expectedDataVersion: number): boolean {
    return this.connection
      .transaction(() => {
        if (this.dataVersion() !== expectedDataVersion) return false;
        this.connection.exec(`
          DELETE FROM host_session_binding;
          DELETE FROM attention_context;
          DELETE FROM agent_activity;
          DELETE FROM approval_grant;
          DELETE FROM delegation_policy;
          DELETE FROM changeset_lease_handoff_request;
          DELETE FROM changeset_write_lease;
          DELETE FROM release_relation;
          DELETE FROM release_node;
          DELETE FROM working_relation_head;
          DELETE FROM working_node_head;
          DELETE FROM design_change;
          DELETE FROM relation_revision;
          DELETE FROM relation;
          DELETE FROM node_revision;
          DELETE FROM node;
          DELETE FROM release;
          DELETE FROM change_set;
          DELETE FROM event_outbox;
          DELETE FROM sqlite_sequence WHERE name = 'event_outbox';
        `);
        this.connection
          .prepare('UPDATE workspace SET current_release_id = NULL, updated_at = ? WHERE id = ?')
          .run(nowIso(), this.meta.workspaceId);
        return true;
      })
      .immediate();
  }

  emit(
    eventType: string,
    payload: Record<string, unknown>,
    retention: 'attention' | 'audit' = 'audit',
  ): void {
    this.connection
      .prepare(
        'INSERT INTO event_outbox (event_type, retention_class, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(eventType, retention, JSON.stringify(payload), nowIso());
  }

  getWorkspaceSummary(): WorkspaceSummary {
    const workspace = this.connection
      .prepare(
        `
      SELECT w.current_release_id, r.version AS release_version
      FROM workspace w LEFT JOIN release r ON r.id = w.current_release_id WHERE w.id = ?`,
      )
      .get(this.meta.workspaceId) as {
      current_release_id: string | null;
      release_version: number | null;
    };
    const active = this.connection
      .prepare("SELECT id FROM change_set WHERE status IN ('open','ready') LIMIT 1")
      .get() as { id: string } | undefined;
    const nodeCount = Number(
      (
        this.connection.prepare('SELECT COUNT(*) AS count FROM working_node_head').get() as {
          count: number;
        }
      ).count,
    );
    const relationCount = Number(
      (
        this.connection.prepare('SELECT COUNT(*) AS count FROM working_relation_head').get() as {
          count: number;
        }
      ).count,
    );
    const validation = nodeCount === 0 ? null : this.validateWorkingState();
    return {
      ...this.meta,
      activeChangeSetId: active?.id ?? null,
      currentReleaseId: workspace.current_release_id,
      currentReleaseVersion: workspace.release_version,
      nodeCount,
      relationCount,
      consistency: nodeCount === 0 ? 'empty' : validation!.valid ? 'valid' : 'invalid',
    };
  }

  listNodes(view: 'working' | 'release' = 'working', releaseId?: string): NodeDetail[] {
    if (view === 'working') {
      return (
        this.connection.prepare(`${NODE_SELECT} ORDER BY r.display_title, n.id`).all() as Row[]
      ).map((row) => mapNode(row, 'working'));
    }
    const id = releaseId ?? this.currentReleaseId();
    if (!id) return [];
    return (
      this.connection
        .prepare(`${RELEASE_NODE_SELECT} WHERE h.release_id = ? ORDER BY r.display_title, n.id`)
        .all(id) as Row[]
    ).map((row) => mapNode(row, 'release'));
  }

  getNode(nodeId: string, view: 'working' | 'release' = 'working', releaseId?: string): NodeDetail {
    const row =
      view === 'working'
        ? (this.connection.prepare(`${NODE_SELECT} WHERE n.id = ?`).get(nodeId) as Row | undefined)
        : (this.connection
            .prepare(`${RELEASE_NODE_SELECT} WHERE h.release_id = ? AND n.id = ?`)
            .get(releaseId ?? this.currentReleaseId(), nodeId) as Row | undefined);
    if (!row)
      throw domainError(
        'NODE_NOT_FOUND',
        'agent_recoverable',
        `节点不存在于 ${view} 视图: ${nodeId}`,
        {
          path: '/nodeId',
          actual: nodeId,
          retryable: true,
          suggestedAction: '刷新设计树并使用当前节点 ID。',
        },
      );
    return mapNode(row, view);
  }

  listRelations(view: 'working' | 'release' = 'working', releaseId?: string): RelationDetail[] {
    if (view === 'working')
      return (
        this.connection.prepare(`${RELATION_SELECT} ORDER BY rel.created_at, rel.id`).all() as Row[]
      ).map((row) => mapRelation(row, 'working'));
    const id = releaseId ?? this.currentReleaseId();
    if (!id) return [];
    return (
      this.connection
        .prepare(
          `${RELEASE_RELATION_SELECT} WHERE h.release_id = ? ORDER BY rel.created_at, rel.id`,
        )
        .all(id) as Row[]
    ).map((row) => mapRelation(row, 'release'));
  }

  getRelationsForNode(nodeId: string, view: 'working' | 'release' = 'working'): RelationDetail[] {
    return this.listRelations(view).filter(
      (item) => item.relation.sourceNodeId === nodeId || item.relation.targetNodeId === nodeId,
    );
  }

  queryNodes(query: string, view: 'working' | 'release' = 'working', limit = 50): NodeDetail[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return this.listNodes(view).slice(0, limit);
    return this.listNodes(view)
      .filter(
        (item) =>
          item.revision.displayTitle.toLocaleLowerCase().includes(normalized) ||
          item.revision.contentText.toLocaleLowerCase().includes(normalized) ||
          item.revision.roles.some((role) => role.toLocaleLowerCase().includes(normalized)),
      )
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getChangeSet(changeSetId?: string): ChangeSet {
    const row = changeSetId
      ? (this.connection.prepare('SELECT * FROM change_set WHERE id = ?').get(changeSetId) as
          Row | undefined)
      : (this.connection
          .prepare(
            "SELECT * FROM change_set WHERE status IN ('open','ready') ORDER BY created_at DESC LIMIT 1",
          )
          .get() as Row | undefined);
    if (!row)
      throw domainError('CHANGESET_NOT_FOUND', 'agent_recoverable', '没有找到活动 ChangeSet。', {
        retryable: true,
        suggestedAction: '调用 changeset_begin 创建一个活动 ChangeSet。',
      });
    const changes = (
      this.connection
        .prepare('SELECT * FROM design_change WHERE changeset_id = ? ORDER BY created_at, id')
        .all(String(row['id'])) as Row[]
    ).map(mapChange);
    return mapChangeSet(row, changes);
  }

  getLease(changeSetId: string): ChangeSetWriteLease | null {
    const row = this.connection
      .prepare('SELECT * FROM changeset_write_lease WHERE changeset_id = ?')
      .get(changeSetId) as Row | undefined;
    return row ? mapLease(row) : null;
  }

  getLeaseStatus(changeSetId: string, hostSessionRef: string): ChangeSetLeaseStatus {
    const lease = this.getLease(changeSetId);
    if (!lease)
      return {
        state: 'reclaimable',
        reason: 'missing',
        currentHostSessionRef: hostSessionRef,
        lease: null,
        canWrite: false,
        canReclaim: true,
      };
    if (lease.ownerHostSessionRef === hostSessionRef)
      return {
        state: 'owned',
        reason: null,
        currentHostSessionRef: hostSessionRef,
        lease,
        canWrite: true,
        canReclaim: false,
      };
    const renewedAtMs = Date.parse(lease.renewedAt);
    const reason: ChangeSetLeaseRecoveryReason =
      renewedAtMs < SYSTEM_BOOTED_AT_MS - BOOT_TIME_TOLERANCE_MS
        ? 'previous_system_boot'
        : Date.now() >= Date.parse(lease.expiresAt)
          ? 'expired'
          : null;
    return {
      state: reason ? 'reclaimable' : 'foreign_active',
      reason,
      currentHostSessionRef: hostSessionRef,
      lease,
      canWrite: false,
      canReclaim: Boolean(reason),
    };
  }

  getLeaseHandoffRequest(requestId: string): ChangeSetLeaseHandoffRequest {
    const row = this.connection
      .prepare('SELECT * FROM changeset_lease_handoff_request WHERE id = ?')
      .get(requestId) as Row | undefined;
    if (!row)
      throw domainError(
        'LEASE_HANDOFF_REQUEST_NOT_FOUND',
        'agent_recoverable',
        `未找到 lease 交接请求: ${requestId}`,
        { retryable: false },
      );
    return mapLeaseHandoffRequest(row);
  }

  listPendingLeaseHandoffRequests(changeSetId: string): ChangeSetLeaseHandoffRequest[] {
    const changeSet = this.getChangeSet(changeSetId);
    const lease = this.getLease(changeSetId);
    if (!lease) return [];
    return (
      this.connection
        .prepare(
          `SELECT * FROM changeset_lease_handoff_request
           WHERE changeset_id = ? AND status = 'pending' AND expires_at > ?
             AND owner_host_session_ref = ? AND changeset_version = ?
           ORDER BY created_at DESC`,
        )
        .all(changeSetId, nowIso(), lease.ownerHostSessionRef, changeSet.version) as Row[]
    ).map(mapLeaseHandoffRequest);
  }

  requestLeaseHandoff(
    requesterHostSessionRef: string,
    changeSetId: string,
    purpose: string,
  ): ChangeSetLeaseHandoffRequest {
    const normalizedPurpose = purpose.trim();
    if (!normalizedPurpose || normalizedPurpose.length > 240)
      throw domainError(
        'LEASE_HANDOFF_PURPOSE_INVALID',
        'agent_recoverable',
        'lease 交接请求必须提供 1 到 240 个字符的用途说明。',
        { path: '/purpose', retryable: true },
      );
    const changeSet = this.getChangeSet(changeSetId);
    const leaseStatus = this.getLeaseStatus(changeSetId, requesterHostSessionRef);
    if (leaseStatus.state === 'owned')
      throw domainError(
        'LEASE_ALREADY_OWNED',
        'agent_recoverable',
        '当前 Agent 会话已经持有写入权，无需请求交接。',
        { retryable: true, suggestedAction: '重新读取 ChangeSet 版本后继续提案。' },
      );
    if (leaseStatus.state === 'reclaimable')
      throw domainError(
        'LEASE_RECOVERABLE_WITHOUT_HANDOFF',
        'agent_recoverable',
        '旧 lease 已可安全恢复，无需请求用户接管。',
        { retryable: true, suggestedAction: '调用 changeset_begin 恢复原 ChangeSet。' },
      );
    const lease = leaseStatus.lease!;
    return this.connection.transaction(() => {
      const now = nowIso();
      this.connection
        .prepare(
          `UPDATE changeset_lease_handoff_request
           SET status = 'expired', resolved_at = ?
           WHERE changeset_id = ? AND status = 'pending' AND expires_at <= ?`,
        )
        .run(now, changeSetId, now);
      const existing = this.connection
        .prepare(
          `SELECT * FROM changeset_lease_handoff_request
           WHERE changeset_id = ? AND requester_host_session_ref = ? AND status = 'pending'
             AND owner_host_session_ref = ? AND changeset_version = ? AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(
          changeSetId,
          requesterHostSessionRef,
          lease.ownerHostSessionRef,
          changeSet.version,
          now,
        ) as Row | undefined;
      if (existing) {
        const expiresAt = new Date(Date.now() + CHANGESET_LEASE_HANDOFF_TIMEOUT_MS).toISOString();
        this.connection
          .prepare(
            'UPDATE changeset_lease_handoff_request SET purpose = ?, expires_at = ? WHERE id = ?',
          )
          .run(normalizedPurpose, expiresAt, String(existing['id']));
        return this.getLeaseHandoffRequest(String(existing['id']));
      }
      this.connection
        .prepare(
          `UPDATE changeset_lease_handoff_request
           SET status = 'superseded', resolved_at = ?
           WHERE changeset_id = ? AND status = 'pending'`,
        )
        .run(now, changeSetId);
      const requestId = randomUUID();
      const expiresAt = new Date(Date.now() + CHANGESET_LEASE_HANDOFF_TIMEOUT_MS).toISOString();
      this.connection
        .prepare(
          `INSERT INTO changeset_lease_handoff_request
           (id,changeset_id,requester_host_session_ref,owner_host_session_ref,changeset_version,
            purpose,status,created_at,expires_at,resolved_at,resolved_by_host_session_ref)
           VALUES (?,?,?,?,?,?,'pending',?,?,NULL,NULL)`,
        )
        .run(
          requestId,
          changeSetId,
          requesterHostSessionRef,
          lease.ownerHostSessionRef,
          changeSet.version,
          normalizedPurpose,
          now,
          expiresAt,
        );
      this.emit('changeset.updated', {
        changeSetId,
        action: 'lease_handoff_requested',
        requestId,
        requesterHostSessionRef,
      });
      return this.getLeaseHandoffRequest(requestId);
    })();
  }

  beginChangeSet(
    hostSessionRef: string,
    title: string,
    description = '',
  ): {
    changeSet: ChangeSet;
    lease: ChangeSetWriteLease;
    recoveredLease: boolean;
    recoveryReason: ChangeSetLeaseRecoveryReason;
  } {
    return this.connection.transaction(() => {
      const active = this.connection
        .prepare("SELECT id FROM change_set WHERE status IN ('open','ready') LIMIT 1")
        .get() as { id: string } | undefined;
      if (active) {
        const existing = this.getChangeSet(active.id);
        const leaseStatus = this.getLeaseStatus(active.id, hostSessionRef);
        if (leaseStatus.state === 'foreign_active') {
          throw domainError(
            'CHANGESET_WRITE_LOCKED',
            'state_conflict',
            `活动 ChangeSet 由另一个宿主会话持有: ${leaseStatus.lease?.ownerHostSessionRef ?? 'unknown'}`,
            {
              actual: leaseStatus.lease?.ownerHostSessionRef,
              expected: hostSessionRef,
              retryable: false,
              suggestedAction:
                '调用 changeset_lease_handoff_request 登记请求，等待用户在 Sidecar 点击“交给此 Agent”。',
            },
          );
        }
        if (leaseStatus.state === 'reclaimable') {
          const lease = this.recoverLease(active.id, hostSessionRef, existing.version, leaseStatus);
          this.emit('changeset.updated', {
            changeSetId: active.id,
            action: 'lease_recovered',
            hostSessionRef,
            previousOwnerHostSessionRef: leaseStatus.lease?.ownerHostSessionRef ?? null,
            reason: leaseStatus.reason,
          });
          return {
            changeSet: existing,
            lease,
            recoveredLease: true,
            recoveryReason: leaseStatus.reason,
          };
        }
        this.renewLease(active.id, existing.version);
        return {
          changeSet: existing,
          lease: this.getLease(active.id)!,
          recoveredLease: false,
          recoveryReason: null,
        };
      }
      const id = randomUUID();
      const now = nowIso();
      const baseReleaseId = this.currentReleaseId();
      this.connection
        .prepare(
          "INSERT INTO change_set (id,status,title,description,version,base_release_id,created_at,updated_at) VALUES (?,'open',?,?,1,?,?,?)",
        )
        .run(id, title.trim() || 'Design changes', description, baseReleaseId, now, now);
      this.connection
        .prepare(
          'INSERT INTO changeset_write_lease (changeset_id,owner_host_session_ref,base_version,acquired_at,renewed_at) VALUES (?,?,1,?,?)',
        )
        .run(id, hostSessionRef, now, now);
      this.emit('changeset.updated', { changeSetId: id, action: 'begun', hostSessionRef });
      return {
        changeSet: this.getChangeSet(id),
        lease: this.getLease(id)!,
        recoveredLease: false,
        recoveryReason: null,
      };
    })();
  }

  proposeChange(input: ProposeChangeInput): { change: DesignChange; changeSet: ChangeSet } {
    validateChangePayload(input.operation, input.payload);
    return this.connection.transaction(() => {
      const changeSet = this.assertWriter(
        input.changeSetId,
        input.hostSessionRef,
        input.expectedChangeSetVersion,
      );
      if (changeSet.status === 'ready')
        this.connection
          .prepare("UPDATE change_set SET status = 'open' WHERE id = ?")
          .run(changeSet.id);
      const creating = input.operation === 'create_node' || input.operation === 'create_relation';
      const entityId = input.entityId ?? (creating ? randomUUID() : '');
      if (!entityId)
        throw domainError('ENTITY_ID_REQUIRED', 'agent_recoverable', '该操作必须提供 entityId。', {
          path: '/entityId',
          retryable: true,
          suggestedAction: '读取当前实体后使用其 ID 重试。',
        });
      if (!creating) this.assertCurrentBase(input.operation, entityId, input.baseRevisionId);
      if (creating && input.baseRevisionId !== undefined)
        throw domainError(
          'BASE_REVISION_NOT_ALLOWED',
          'agent_recoverable',
          '创建操作不能提供 baseRevisionId。',
          { path: '/baseRevisionId', actual: input.baseRevisionId, retryable: true },
        );
      if (input.payload['approvalState'] === 'user_confirmed') {
        throw domainError(
          'USER_CONFIRMATION_REQUIRED',
          'permission_required',
          'Agent 提案不能声明用户已确认；请先使用 tentative，再由用户显式确认根节点。',
          {
            path: '/payload/approvalState',
            retryable: false,
            suggestedAction: '将 approvalState 改为 tentative，采用后请求用户确认。',
          },
        );
      }
      if (input.operation === 'create_relation')
        this.assertRelationEndpointsResolvable(input.changeSetId, input.payload);
      const id = randomUUID();
      const now = nowIso();
      this.connection
        .prepare(
          `INSERT INTO design_change
        (id,changeset_id,operation,entity_id,base_revision_id,payload_json,status,summary,created_by_host_session_ref,adopted_revision_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'proposed',?,?,NULL,?,?)`,
        )
        .run(
          id,
          input.changeSetId,
          input.operation,
          entityId,
          input.baseRevisionId ?? null,
          JSON.stringify(input.payload),
          input.summary,
          input.hostSessionRef,
          now,
          now,
        );
      this.bumpChangeSet(input.changeSetId, now);
      this.emit('changeset.updated', {
        changeSetId: input.changeSetId,
        changeId: id,
        action: 'proposed',
      });
      return { change: this.getChange(id), changeSet: this.getChangeSet(input.changeSetId) };
    })();
  }

  reviseProposedChange(
    hostSessionRef: string,
    changeId: string,
    expectedVersion: number,
    payload: Record<string, unknown>,
    summary: string,
  ): { change: DesignChange; changeSet: ChangeSet } {
    const current = this.getChange(changeId);
    validateChangePayload(current.operation, payload);
    return this.connection.transaction(() => {
      this.assertWriter(current.changeSetId, hostSessionRef, expectedVersion);
      const fresh = this.getChange(changeId);
      if (fresh.status !== 'proposed')
        throw domainError(
          'CHANGE_NOT_REVISABLE',
          'state_conflict',
          '只有 proposed 候选可以修订。',
          { actual: fresh.status, retryable: false },
        );
      if (fresh.operation === 'create_relation')
        this.assertRelationEndpointsResolvable(fresh.changeSetId, payload);
      const now = nowIso();
      this.connection
        .prepare(
          'UPDATE design_change SET payload_json = ?, summary = ?, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(payload), summary, now, changeId);
      this.bumpChangeSet(current.changeSetId, now);
      this.emit('changeset.updated', {
        changeSetId: current.changeSetId,
        changeId,
        action: 'revised',
      });
      return {
        change: this.getChange(changeId),
        changeSet: this.getChangeSet(current.changeSetId),
      };
    })();
  }

  discardChange(hostSessionRef: string, changeId: string, expectedVersion: number): ChangeSet {
    const current = this.getChange(changeId);
    return this.connection.transaction(() => {
      this.assertWriter(current.changeSetId, hostSessionRef, expectedVersion);
      if (this.getChange(changeId).status !== 'proposed')
        throw domainError(
          'CHANGE_NOT_DISCARDABLE',
          'state_conflict',
          '只有 proposed 候选可以丢弃。',
          { retryable: false },
        );
      const bundledContains =
        current.operation === 'create_node'
          ? this.proposedContainsAttachments(current.changeSetId, current.entityId)
          : [];
      if (current.operation === 'create_node') {
        const bundledIds = new Set(bundledContains.map((change) => change.id));
        const dependents = (this.getChangeSet(current.changeSetId).changes ?? []).filter(
          (change) =>
            change.status === 'proposed' &&
            change.operation === 'create_relation' &&
            !bundledIds.has(change.id) &&
            (change.payload['sourceNodeId'] === current.entityId ||
              change.payload['targetNodeId'] === current.entityId),
        );
        if (dependents.length)
          throw domainError(
            'CHANGE_DEPENDENTS_PENDING',
            'state_conflict',
            '该节点仍被候选关系引用，不能先丢弃节点。',
            {
              actual: dependents.map((change) => ({ id: change.id, summary: change.summary })),
              retryable: true,
              suggestedAction: '先丢弃或修订这些关系，再丢弃节点。',
            },
          );
      }
      const now = nowIso();
      this.connection
        .prepare("UPDATE design_change SET status = 'discarded', updated_at = ? WHERE id = ?")
        .run(now, changeId);
      for (const attachment of bundledContains) {
        this.connection
          .prepare("UPDATE design_change SET status = 'discarded', updated_at = ? WHERE id = ?")
          .run(now, attachment.id);
      }
      this.bumpChangeSet(current.changeSetId, now);
      this.emit('changeset.updated', {
        changeSetId: current.changeSetId,
        changeId,
        action: 'discarded',
        bundledChangeIds: bundledContains.map((change) => change.id),
      });
      return this.getChangeSet(current.changeSetId);
    })();
  }

  validateChangeSet(
    hostSessionRef: string,
    changeSetId: string,
    expectedVersion: number,
  ): { changeSet: ChangeSet; validation: ValidationResult } {
    return this.connection.transaction(() => {
      this.assertWriter(changeSetId, hostSessionRef, expectedVersion);
      this.assertNoPendingChanges(changeSetId);
      const validation = this.validateWorkingState();
      const now = nowIso();
      this.connection
        .prepare(
          'UPDATE change_set SET status = ?, version = version + 1, updated_at = ? WHERE id = ?',
        )
        .run(validation.valid ? 'ready' : 'open', now, changeSetId);
      this.syncLeaseVersion(changeSetId, now);
      this.emit('design.validation.changed', {
        changeSetId,
        valid: validation.valid,
        issues: validation.issues,
      });
      return { changeSet: this.getChangeSet(changeSetId), validation };
    })();
  }

  validateWorkingState(): ValidationResult {
    return checkConsistency(this.listNodes('working'), this.listRelations('working'));
  }

  getApprovalTarget(action: ApprovalAction, targetId: string): ApprovalTarget {
    if (action === 'adopt') {
      const change = this.getChange(targetId);
      const changeSet = this.getChangeSet(change.changeSetId);
      return {
        digest: stableDigest({ action, change, changeSetVersion: changeSet.version }),
        version: changeSet.version,
        description: change.summary,
      };
    }
    if (action === 'publish') {
      const changeSet = this.getChangeSet(targetId);
      const heads = {
        nodes: this.listNodes()
          .map((item) => item.revision.id)
          .sort(),
        relations: this.listRelations()
          .map((item) => item.revision.id)
          .sort(),
      };
      return {
        digest: stableDigest({ action, changeSetId: targetId, version: changeSet.version, heads }),
        version: changeSet.version,
        description: `发布 ${changeSet.title}`,
      };
    }
    if (action === 'confirm_root') {
      const node = this.getNode(targetId);
      const changeSet = this.getChangeSet();
      return {
        digest: stableDigest({
          action,
          nodeRevisionId: node.revision.id,
          changeSetVersion: changeSet.version,
        }),
        version: changeSet.version,
        description: `确认根节点：${node.revision.displayTitle}`,
      };
    }
    if (action === 'take_lease') {
      const changeSet = this.getChangeSet(targetId);
      const lease = this.getLease(targetId);
      return {
        digest: stableDigest({
          action,
          changeSetId: targetId,
          owner: lease?.ownerHostSessionRef ?? null,
          version: changeSet.version,
        }),
        version: changeSet.version,
        description: `接管 ${changeSet.title} 的写入权`,
      };
    }
    const [nodeId, mode] = targetId.split(':');
    if (!nodeId || mode !== 'agent_managed')
      throw domainError('INVALID_DELEGATION_TARGET', 'agent_recoverable', '托管目标格式无效。', {
        path: '/targetId',
        expected: '<nodeId>:agent_managed',
        actual: targetId,
        retryable: true,
      });
    const changeSet = this.getChangeSet();
    const existing = this.connection
      .prepare('SELECT mode FROM delegation_policy WHERE node_id = ?')
      .get(nodeId) as { mode: string } | undefined;
    return {
      digest: stableDigest({
        action,
        nodeId,
        mode,
        previous: existing?.mode ?? 'human_final',
        version: changeSet.version,
      }),
      version: changeSet.version,
      description: `扩大 Agent 托管范围：${nodeId}`,
    };
  }

  issueApprovalGrant(
    action: ApprovalAction,
    targetId: string,
    hostSessionRef: string | null,
    ttlSeconds = 180,
  ): IssuedGrant {
    const target = this.getApprovalTarget(action, targetId);
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(
      Date.now() + Math.max(30, Math.min(ttlSeconds, 600)) * 1000,
    ).toISOString();
    this.connection
      .prepare(
        `INSERT INTO approval_grant
      (id,token_sha256,action,target_digest,expected_version,host_session_ref,expires_at,consumed_at,created_at)
      VALUES (?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        id,
        tokenHash(token),
        action,
        target.digest,
        target.version,
        hostSessionRef,
        expiresAt,
        createdAt,
      );
    const row = this.connection.prepare('SELECT * FROM approval_grant WHERE id = ?').get(id) as Row;
    return { token, grant: mapGrant(row) };
  }

  adoptChange(
    hostSessionRef: string,
    changeId: string,
    approvalToken: string,
  ): { change: DesignChange; changeSet: ChangeSet; adoptedChanges: DesignChange[] } {
    return this.connection.transaction(() => {
      const change = this.getChange(changeId);
      const target = this.getApprovalTarget('adopt', changeId);
      this.consumeGrant('adopt', approvalToken, target, hostSessionRef);
      this.assertWriter(change.changeSetId, hostSessionRef, target.version);
      if (change.status !== 'proposed')
        throw domainError(
          'CHANGE_NOT_ADOPTABLE',
          'state_conflict',
          '只有 proposed 候选可以采用。',
          { actual: change.status, retryable: false },
        );
      const changeSetChanges = this.getChangeSet(change.changeSetId).changes ?? [];
      if (
        change.operation === 'create_relation' &&
        change.payload['relationType'] === 'contains' &&
        changeSetChanges.some((candidate) => {
          const roles = Array.isArray(candidate.payload['roles']) ? candidate.payload['roles'] : [];
          return (
            candidate.status === 'proposed' &&
            candidate.operation === 'create_node' &&
            candidate.entityId === change.payload['targetNodeId'] &&
            !hasDesignRootRole(roles)
          );
        })
      )
        throw domainError(
          'CONTAINS_ADOPT_WITH_CHILD',
          'state_conflict',
          '新子节点的 contains 关系必须随子节点一起采用。',
          {
            actual: change.id,
            retryable: true,
            suggestedAction: '在 Sidecar 中批准对应的子节点；挂载关系会在同一事务中采用。',
          },
        );
      let bundledContains: DesignChange[] = [];
      if (change.operation === 'create_node') {
        const roles = Array.isArray(change.payload['roles']) ? change.payload['roles'] : [];
        const isRoot = hasDesignRootRole(roles);
        bundledContains = this.proposedContainsAttachments(change.changeSetId, change.entityId);
        if (!isRoot && bundledContains.length !== 1)
          throw domainError(
            bundledContains.length ? 'CONTAINS_PARENT_AMBIGUOUS' : 'CONTAINS_PARENT_REQUIRED',
            'state_conflict',
            bundledContains.length
              ? '新子节点必须且只能有一个 contains 父节点。'
              : '非根节点必须先声明 contains 父节点才能采用。',
            {
              actual: bundledContains.map((candidate) => candidate.id),
              expected: 1,
              retryable: true,
              suggestedAction: bundledContains.length
                ? '保留一个指向该子节点的 contains 候选，并丢弃或修订其余候选。'
                : '让 Agent 提出一条从预期父节点指向该子节点的 contains 关系。',
            },
          );
        if (!isRoot) {
          const parentId = bundledContains[0]!.payload['sourceNodeId'];
          const parentReady =
            typeof parentId === 'string' &&
            this.connection
              .prepare('SELECT 1 FROM working_node_head WHERE node_id = ?')
              .get(parentId);
          if (!parentReady)
            throw domainError(
              'PARENT_NODE_PENDING',
              'state_conflict',
              '必须先采用父节点，才能采用子节点。',
              {
                actual: parentId,
                retryable: true,
                suggestedAction: '先在 Sidecar 中批准父节点，再批准该子节点。',
              },
            );
        }
        if (isRoot) bundledContains = [];
      }
      if (change.operation === 'create_relation') {
        const missingEndpointIds = this.missingWorkingRelationEndpointIds(change.payload);
        if (missingEndpointIds.length)
          throw domainError(
            'CHANGE_DEPENDENCY_PENDING',
            'state_conflict',
            '关系的起点和终点必须先进入 Working State。',
            {
              actual: missingEndpointIds,
              retryable: true,
              suggestedAction: '先采用关系引用的候选节点，再采用该关系。',
            },
          );
      }
      this.assertCurrentBase(change.operation, change.entityId, change.baseRevisionId ?? undefined);
      const adoptedRevisionId = this.applyChange(change, hostSessionRef);
      const now = nowIso();
      this.connection
        .prepare(
          "UPDATE design_change SET status = 'adopted', adopted_revision_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(adoptedRevisionId, now, changeId);
      const bundledAdopted: DesignChange[] = [];
      for (const attachment of bundledContains) {
        this.assertCurrentBase(
          attachment.operation,
          attachment.entityId,
          attachment.baseRevisionId ?? undefined,
        );
        const attachmentRevisionId = this.applyChange(attachment, hostSessionRef);
        this.connection
          .prepare(
            "UPDATE design_change SET status = 'adopted', adopted_revision_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(attachmentRevisionId, now, attachment.id);
        bundledAdopted.push(this.getChange(attachment.id));
      }
      this.bumpChangeSet(change.changeSetId, now);
      this.emit('changeset.updated', {
        changeSetId: change.changeSetId,
        changeId,
        action: 'adopted',
        adoptedRevisionId,
        bundledChangeIds: bundledAdopted.map((candidate) => candidate.id),
      });
      const adoptedChange = this.getChange(changeId);
      return {
        change: adoptedChange,
        changeSet: this.getChangeSet(change.changeSetId),
        adoptedChanges: [adoptedChange, ...bundledAdopted],
      };
    })();
  }

  confirmRoot(
    hostSessionRef: string,
    nodeId: string,
    approvalToken: string,
  ): { node: NodeDetail; changeSet: ChangeSet } {
    return this.connection.transaction(() => {
      const target = this.getApprovalTarget('confirm_root', nodeId);
      this.consumeGrant('confirm_root', approvalToken, target, hostSessionRef);
      const changeSet = this.getChangeSet();
      this.assertWriter(changeSet.id, hostSessionRef, target.version);
      const current = this.getNode(nodeId);
      if (!hasDesignRootRole(current.revision.roles))
        throw domainError(
          'NODE_NOT_ROOT',
          'agent_recoverable',
          '只能确认带 root 或 design-root role 的节点。',
          {
            actual: nodeId,
            retryable: true,
          },
        );
      const revisionId = randomUUID();
      const now = nowIso();
      this.connection
        .prepare(
          `INSERT INTO node_revision
        (id,node_id,revision_number,display_title,content_text,roles_json,attributes_json,approval_state,epistemic_state,review_state,supersedes_revision_id,created_in_changeset_id,author_kind,author_ref,created_at)
        VALUES (?,?,?,?,?,?,?,'user_confirmed',?,?,?,?, 'user', ?, ?)`,
        )
        .run(
          revisionId,
          nodeId,
          current.revision.revisionNumber + 1,
          current.revision.displayTitle,
          current.revision.contentText,
          JSON.stringify(current.revision.roles),
          JSON.stringify(current.revision.attributes),
          current.revision.epistemicState,
          current.revision.reviewState,
          current.revision.id,
          changeSet.id,
          hostSessionRef,
          now,
        );
      this.connection
        .prepare('UPDATE working_node_head SET revision_id = ? WHERE node_id = ?')
        .run(revisionId, nodeId);
      this.bumpChangeSet(changeSet.id, now);
      this.emit('changeset.updated', {
        changeSetId: changeSet.id,
        nodeId,
        action: 'root_confirmed',
      });
      return { node: this.getNode(nodeId), changeSet: this.getChangeSet(changeSet.id) };
    })();
  }

  publishRelease(
    hostSessionRef: string,
    changeSetId: string,
    approvalToken: string,
    summary: string,
  ): Release {
    return this.connection.transaction(() => {
      const target = this.getApprovalTarget('publish', changeSetId);
      this.consumeGrant('publish', approvalToken, target, hostSessionRef);
      const changeSet = this.assertWriter(changeSetId, hostSessionRef, target.version);
      if (changeSet.status !== 'ready')
        throw domainError(
          'CHANGESET_NOT_READY',
          'state_conflict',
          'ChangeSet 必须先通过 changeset_validate。',
          { actual: changeSet.status, expected: 'ready', retryable: true },
        );
      this.assertNoPendingChanges(changeSetId);
      const validation = this.validateWorkingState();
      if (!validation.valid)
        throw domainError(
          'DESIGN_INVALID',
          'user_input_required',
          'Working State 未通过一致性检查，不能发布。',
          {
            actual: validation.issues,
            retryable: false,
            suggestedAction: '修复阻塞问题后重新校验。',
          },
        );
      const id = randomUUID();
      const now = nowIso();
      const version = Number(
        (
          this.connection
            .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM release')
            .get() as { version: number }
        ).version,
      );
      this.connection
        .prepare('INSERT INTO release (id,version,summary,created_at) VALUES (?,?,?,?)')
        .run(id, version, summary.trim() || changeSet.title, now);
      this.connection
        .prepare(
          'INSERT INTO release_node (release_id,node_id,revision_id) SELECT ?,node_id,revision_id FROM working_node_head',
        )
        .run(id);
      this.connection
        .prepare(
          'INSERT INTO release_relation (release_id,relation_id,revision_id) SELECT ?,relation_id,revision_id FROM working_relation_head',
        )
        .run(id);
      this.connection
        .prepare("UPDATE change_set SET status = 'published', updated_at = ? WHERE id = ?")
        .run(now, changeSetId);
      this.connection
        .prepare('DELETE FROM changeset_write_lease WHERE changeset_id = ?')
        .run(changeSetId);
      this.connection
        .prepare('UPDATE workspace SET current_release_id = ?, updated_at = ? WHERE id = ?')
        .run(id, now, this.meta.workspaceId);
      this.emit('release.published', { releaseId: id, version, changeSetId });
      return this.getRelease(id);
    })();
  }

  takeLease(
    hostSessionRef: string,
    changeSetId: string,
    approvalToken: string,
  ): ChangeSetWriteLease {
    return this.connection.transaction(() => {
      const target = this.getApprovalTarget('take_lease', changeSetId);
      this.consumeGrant('take_lease', approvalToken, target, hostSessionRef, false);
      const lease = this.claimLease(changeSetId, hostSessionRef, target.version);
      const now = nowIso();
      this.connection
        .prepare(
          `UPDATE changeset_lease_handoff_request
           SET status = 'superseded', resolved_at = ?, resolved_by_host_session_ref = ?
           WHERE changeset_id = ? AND status = 'pending'`,
        )
        .run(now, hostSessionRef, changeSetId);
      this.emit('changeset.updated', { changeSetId, action: 'lease_taken', hostSessionRef });
      return lease;
    })();
  }

  approveLeaseHandoff(
    approvingHostSessionRef: string,
    requestId: string,
  ): { request: ChangeSetLeaseHandoffRequest; lease: ChangeSetWriteLease } {
    const request = this.getLeaseHandoffRequest(requestId);
    if (request.status !== 'pending')
      throw domainError(
        'LEASE_HANDOFF_REQUEST_RESOLVED',
        'state_conflict',
        '该 lease 交接请求已经处理。',
        { actual: request.status, retryable: false },
      );
    if (request.expiresAt <= nowIso()) {
      this.connection
        .prepare(
          `UPDATE changeset_lease_handoff_request
           SET status = 'expired', resolved_at = ?, resolved_by_host_session_ref = ? WHERE id = ?`,
        )
        .run(nowIso(), approvingHostSessionRef, requestId);
      throw domainError(
        'LEASE_HANDOFF_REQUEST_EXPIRED',
        'state_conflict',
        '该 lease 交接请求已过期。',
        { retryable: false, suggestedAction: '请 Agent 重新读取 ChangeSet 并发起新请求。' },
      );
    }
    const changeSet = this.getChangeSet(request.changeSetId);
    const lease = this.getLease(request.changeSetId);
    if (
      !lease ||
      lease.ownerHostSessionRef !== request.ownerHostSessionRef ||
      changeSet.version !== request.changeSetVersion
    ) {
      this.connection
        .prepare(
          `UPDATE changeset_lease_handoff_request
           SET status = 'superseded', resolved_at = ?, resolved_by_host_session_ref = ? WHERE id = ?`,
        )
        .run(nowIso(), approvingHostSessionRef, requestId);
      throw domainError(
        'LEASE_HANDOFF_REQUEST_STALE',
        'state_conflict',
        'ChangeSet owner 或版本已变化，旧交接请求失效。',
        {
          expected: {
            ownerHostSessionRef: request.ownerHostSessionRef,
            version: request.changeSetVersion,
          },
          actual: {
            ownerHostSessionRef: lease?.ownerHostSessionRef ?? null,
            version: changeSet.version,
          },
          retryable: false,
          suggestedAction: '请 Agent 重新读取 ChangeSet 并发起新请求。',
        },
      );
    }
    const grant = this.issueApprovalGrant(
      'take_lease',
      request.changeSetId,
      request.requesterHostSessionRef,
    );
    const transferredLease = this.takeLease(
      request.requesterHostSessionRef,
      request.changeSetId,
      grant.token,
    );
    const resolvedAt = nowIso();
    this.connection
      .prepare(
        `UPDATE changeset_lease_handoff_request
         SET status = 'approved', resolved_at = ?, resolved_by_host_session_ref = ? WHERE id = ?`,
      )
      .run(resolvedAt, approvingHostSessionRef, requestId);
    this.emit('changeset.updated', {
      changeSetId: request.changeSetId,
      action: 'lease_handoff_approved',
      requestId,
      requesterHostSessionRef: request.requesterHostSessionRef,
      approvingHostSessionRef,
    });
    return { request: this.getLeaseHandoffRequest(requestId), lease: transferredLease };
  }

  setDelegationPolicy(
    hostSessionRef: string,
    nodeId: string,
    mode: 'human_final' | 'agent_managed',
    approvalToken?: string,
  ): void {
    this.connection.transaction(() => {
      if (mode === 'agent_managed') {
        if (!approvalToken)
          throw domainError(
            'APPROVAL_REQUIRED',
            'permission_required',
            '扩大 Agent 托管范围需要用户授权。',
            { retryable: false },
          );
        const target = this.getApprovalTarget('expand_delegation', `${nodeId}:${mode}`);
        this.consumeGrant('expand_delegation', approvalToken, target, hostSessionRef);
      }
      this.getNode(nodeId);
      const now = nowIso();
      this.connection
        .prepare(
          `INSERT INTO delegation_policy (node_id,mode,updated_at) VALUES (?,?,?)
        ON CONFLICT(node_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`,
        )
        .run(nodeId, mode, now);
      this.emit('changeset.updated', { nodeId, action: 'delegation_changed', mode });
    })();
  }

  getRelease(releaseId?: string): Release {
    const id = releaseId ?? this.currentReleaseId();
    if (!id)
      throw domainError('RELEASE_NOT_FOUND', 'agent_recoverable', '尚未发布任何 Release。', {
        retryable: false,
      });
    const row = this.connection.prepare('SELECT * FROM release WHERE id = ?').get(id) as
      Row | undefined;
    if (!row)
      throw domainError('RELEASE_NOT_FOUND', 'agent_recoverable', `Release 不存在: ${id}`, {
        retryable: true,
      });
    const nodes = this.listNodes('release', id);
    const relations = this.listRelations('release', id);
    return mapRelease(
      row,
      nodes.map((item) => item.revision.id),
      relations.map((item) => item.revision.id),
      nodes
        .filter((item) => hasDesignRootRole(item.revision.roles))
        .map((item) => item.revision.id),
    );
  }

  listEvents(after = 0, limit = 100): Row[] {
    return this.connection
      .prepare(
        'SELECT cursor,event_type,payload_json,created_at FROM event_outbox WHERE cursor > ? ORDER BY cursor LIMIT ?',
      )
      .all(after, Math.max(1, Math.min(limit, 500))) as Row[];
  }

  private getChange(changeId: string): DesignChange {
    const row = this.connection
      .prepare('SELECT * FROM design_change WHERE id = ?')
      .get(changeId) as Row | undefined;
    if (!row)
      throw domainError('CHANGE_NOT_FOUND', 'agent_recoverable', `候选变更不存在: ${changeId}`, {
        path: '/changeId',
        actual: changeId,
        retryable: true,
        suggestedAction: '刷新当前 ChangeSet 后重试。',
      });
    return mapChange(row);
  }

  private currentReleaseId(): string | null {
    const row = this.connection
      .prepare('SELECT current_release_id FROM workspace WHERE id = ?')
      .get(this.meta.workspaceId) as { current_release_id: string | null };
    return row.current_release_id;
  }

  private assertWriter(
    changeSetId: string,
    hostSessionRef: string,
    expectedVersion: number,
  ): ChangeSet {
    const changeSet = this.getChangeSet(changeSetId);
    if (changeSet.status !== 'open' && changeSet.status !== 'ready')
      throw domainError(
        'CHANGESET_NOT_WRITABLE',
        'state_conflict',
        'ChangeSet 已关闭，不能继续写入。',
        { actual: changeSet.status, retryable: false },
      );
    if (changeSet.version !== expectedVersion)
      throw domainError(
        'CHANGESET_VERSION_CONFLICT',
        'state_conflict',
        'ChangeSet version 已变化。',
        {
          path: '/expectedChangeSetVersion',
          expected: changeSet.version,
          actual: expectedVersion,
          retryable: true,
          suggestedAction: '刷新 ChangeSet，重新判断候选后重试。',
        },
      );
    const leaseStatus = this.getLeaseStatus(changeSetId, hostSessionRef);
    if (leaseStatus.state === 'reclaimable') {
      this.recoverLease(changeSetId, hostSessionRef, changeSet.version, leaseStatus);
      this.emit('changeset.updated', {
        changeSetId,
        action: 'lease_recovered',
        hostSessionRef,
        previousOwnerHostSessionRef: leaseStatus.lease?.ownerHostSessionRef ?? null,
        reason: leaseStatus.reason,
      });
    } else if (leaseStatus.state === 'foreign_active') {
      throw domainError(
        'CHANGESET_WRITE_LOCKED',
        'state_conflict',
        '当前宿主会话不持有写入 lease。',
        {
          expected: leaseStatus.lease?.ownerHostSessionRef,
          actual: hostSessionRef,
          retryable: false,
          suggestedAction:
            '调用 changeset_lease_handoff_request 登记请求，等待用户在 Sidecar 点击“交给此 Agent”。',
        },
      );
    }
    return changeSet;
  }

  private assertCurrentBase(
    operation: DesignChange['operation'],
    entityId: string,
    baseRevisionId?: string,
  ): void {
    if (operation === 'create_node' || operation === 'create_relation') return;
    const table = operation.endsWith('node') ? 'working_node_head' : 'working_relation_head';
    const key = operation.endsWith('node') ? 'node_id' : 'relation_id';
    const row = this.connection
      .prepare(`SELECT revision_id FROM ${table} WHERE ${key} = ?`)
      .get(entityId) as { revision_id: string } | undefined;
    if (!row)
      throw domainError(
        'ENTITY_NOT_FOUND',
        'agent_recoverable',
        `当前 Working State 中不存在实体: ${entityId}`,
        { path: '/entityId', actual: entityId, retryable: true },
      );
    if (!baseRevisionId)
      throw domainError(
        'BASE_REVISION_REQUIRED',
        'agent_recoverable',
        '修订或删除必须提供 baseRevisionId。',
        { path: '/baseRevisionId', expected: row.revision_id, retryable: true },
      );
    if (row.revision_id !== baseRevisionId)
      throw domainError('STALE_BASE_REVISION', 'state_conflict', '实体修订已变化。', {
        path: '/baseRevisionId',
        expected: row.revision_id,
        actual: baseRevisionId,
        retryable: true,
        suggestedAction: '重新读取实体并基于最新 Revision 提案。',
      });
  }

  private missingWorkingRelationEndpointIds(payload: Record<string, unknown>): string[] {
    const endpointIds = [payload['sourceNodeId'], payload['targetNodeId']].filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    return endpointIds.filter((nodeId) => {
      const row = this.connection
        .prepare('SELECT 1 FROM working_node_head WHERE node_id = ?')
        .get(nodeId);
      return !row;
    });
  }

  private proposedContainsAttachments(changeSetId: string, targetNodeId: string): DesignChange[] {
    return (this.getChangeSet(changeSetId).changes ?? []).filter(
      (change) =>
        change.status === 'proposed' &&
        change.operation === 'create_relation' &&
        change.payload['relationType'] === 'contains' &&
        change.payload['targetNodeId'] === targetNodeId,
    );
  }

  private assertRelationEndpointsResolvable(
    changeSetId: string,
    payload: Record<string, unknown>,
  ): void {
    const missing = this.missingWorkingRelationEndpointIds(payload);
    if (!missing.length) return;
    const proposedNodeIds = new Set(
      (this.getChangeSet(changeSetId).changes ?? [])
        .filter((change) => change.status === 'proposed' && change.operation === 'create_node')
        .map((change) => change.entityId),
    );
    const unresolved = missing.filter((nodeId) => !proposedNodeIds.has(nodeId));
    if (!unresolved.length) return;
    throw domainError(
      'RELATION_ENDPOINT_UNRESOLVED',
      'agent_recoverable',
      '关系端点必须是 Working 节点或同一 ChangeSet 中待采用的新节点。',
      {
        path: '/payload',
        actual: unresolved,
        retryable: true,
        suggestedAction: '修正端点 ID，或先提出相应的 create_node 候选。',
      },
    );
  }

  private assertNoPendingChanges(changeSetId: string): void {
    const pending = (this.getChangeSet(changeSetId).changes ?? []).filter(
      (change) => change.status === 'proposed',
    );
    if (!pending.length) return;
    throw domainError(
      'CHANGESET_HAS_PENDING_CHANGES',
      'state_conflict',
      'ChangeSet 仍有未处理的候选，不能校验或发布。',
      {
        actual: pending.map((change) => ({
          id: change.id,
          operation: change.operation,
          summary: change.summary,
        })),
        retryable: true,
        suggestedAction: '逐条采用、修订或丢弃所有候选后重试。',
      },
    );
  }

  private bumpChangeSet(changeSetId: string, now: string): void {
    this.connection
      .prepare(
        "UPDATE change_set SET version = version + 1, status = 'open', updated_at = ? WHERE id = ?",
      )
      .run(now, changeSetId);
    this.syncLeaseVersion(changeSetId, now);
  }

  private syncLeaseVersion(changeSetId: string, now: string): void {
    this.connection
      .prepare(
        'UPDATE changeset_write_lease SET base_version = (SELECT version FROM change_set WHERE id = ?), renewed_at = ? WHERE changeset_id = ?',
      )
      .run(changeSetId, now, changeSetId);
  }

  private claimLease(
    changeSetId: string,
    hostSessionRef: string,
    baseVersion: number,
  ): ChangeSetWriteLease {
    const now = nowIso();
    this.connection
      .prepare(
        `INSERT INTO changeset_write_lease
        (changeset_id,owner_host_session_ref,base_version,acquired_at,renewed_at) VALUES (?,?,?,?,?)
        ON CONFLICT(changeset_id) DO UPDATE SET owner_host_session_ref=excluded.owner_host_session_ref,
          base_version=excluded.base_version, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at`,
      )
      .run(changeSetId, hostSessionRef, baseVersion, now, now);
    return this.getLease(changeSetId)!;
  }

  private recoverLease(
    changeSetId: string,
    hostSessionRef: string,
    baseVersion: number,
    staleStatus: ChangeSetLeaseStatus,
  ): ChangeSetWriteLease {
    const now = nowIso();
    const updated = staleStatus.lease
      ? this.connection
          .prepare(
            `UPDATE changeset_write_lease
             SET owner_host_session_ref = ?, base_version = ?, acquired_at = ?, renewed_at = ?
             WHERE changeset_id = ? AND owner_host_session_ref = ? AND renewed_at = ?`,
          )
          .run(
            hostSessionRef,
            baseVersion,
            now,
            now,
            changeSetId,
            staleStatus.lease.ownerHostSessionRef,
            staleStatus.lease.renewedAt,
          ).changes
      : this.connection
          .prepare(
            `INSERT OR IGNORE INTO changeset_write_lease
             (changeset_id,owner_host_session_ref,base_version,acquired_at,renewed_at)
             VALUES (?,?,?,?,?)`,
          )
          .run(changeSetId, hostSessionRef, baseVersion, now, now).changes;
    const lease = this.getLease(changeSetId);
    if (updated === 1 && lease?.ownerHostSessionRef === hostSessionRef) return lease;
    throw domainError(
      'CHANGESET_WRITE_LOCKED',
      'state_conflict',
      'lease 在恢复期间已由其他会话更新。',
      {
        expected: lease?.ownerHostSessionRef,
        actual: hostSessionRef,
        retryable: true,
        suggestedAction: '重新读取 design_changeset_get；只有 reclaimable lease 可以自动恢复。',
      },
    );
  }

  private renewLease(changeSetId: string, baseVersion: number): void {
    this.connection
      .prepare(
        'UPDATE changeset_write_lease SET base_version = ?, renewed_at = ? WHERE changeset_id = ?',
      )
      .run(baseVersion, nowIso(), changeSetId);
  }

  private consumeGrant(
    action: ApprovalAction,
    token: string,
    target: ApprovalTarget,
    hostSessionRef: string,
    requireSession = true,
  ): void {
    const row = this.connection
      .prepare('SELECT * FROM approval_grant WHERE token_sha256 = ?')
      .get(tokenHash(token)) as Row | undefined;
    if (!row)
      throw domainError('APPROVAL_GRANT_INVALID', 'permission_required', 'ApprovalGrant 无效。', {
        retryable: false,
      });
    const grant = mapGrant(row);
    if (grant.consumedAt)
      throw domainError(
        'APPROVAL_GRANT_CONSUMED',
        'permission_required',
        'ApprovalGrant 已使用。',
        { retryable: false },
      );
    if (grant.expiresAt <= nowIso())
      throw domainError('APPROVAL_GRANT_EXPIRED', 'permission_required', 'ApprovalGrant 已过期。', {
        retryable: false,
        suggestedAction: '请用户重新检查目标并再次确认。',
      });
    if (
      grant.action !== action ||
      grant.targetDigest !== target.digest ||
      grant.expectedVersion !== target.version
    ) {
      throw domainError(
        'APPROVAL_GRANT_STALE',
        'permission_required',
        '目标内容或版本已变化，旧授权立即失效。',
        {
          expected: target,
          actual: grant,
          retryable: false,
          suggestedAction: '请用户重新检查最新差异并再次确认。',
        },
      );
    }
    if (requireSession && grant.hostSessionRef && grant.hostSessionRef !== hostSessionRef)
      throw domainError(
        'APPROVAL_GRANT_SESSION_MISMATCH',
        'permission_required',
        '授权不属于当前宿主会话。',
        { retryable: false },
      );
    this.connection
      .prepare('UPDATE approval_grant SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(nowIso(), grant.id);
  }

  private applyChange(change: DesignChange, authorRef: string): string | null {
    const payload = change.payload;
    const now = nowIso();
    switch (change.operation) {
      case 'create_node': {
        const item = payload as unknown as CreateNodePayload;
        const revisionId = randomUUID();
        this.connection
          .prepare('INSERT INTO node (id,node_type,created_at,deleted_at) VALUES (?,?,?,NULL)')
          .run(change.entityId, item.nodeType, now);
        this.insertNodeRevision(
          revisionId,
          change.entityId,
          1,
          item,
          null,
          change.changeSetId,
          authorRef,
          now,
        );
        this.connection
          .prepare('INSERT INTO working_node_head (node_id,revision_id) VALUES (?,?)')
          .run(change.entityId, revisionId);
        return revisionId;
      }
      case 'revise_node': {
        const item = payload as unknown as ReviseNodePayload;
        const current = this.getNode(change.entityId);
        const revisionId = randomUUID();
        this.insertNodeRevision(
          revisionId,
          change.entityId,
          current.revision.revisionNumber + 1,
          item,
          current.revision.id,
          change.changeSetId,
          authorRef,
          now,
        );
        this.connection
          .prepare('UPDATE working_node_head SET revision_id = ? WHERE node_id = ?')
          .run(revisionId, change.entityId);
        return revisionId;
      }
      case 'remove_node':
        this.connection
          .prepare(
            'DELETE FROM working_relation_head WHERE relation_id IN (SELECT id FROM relation WHERE source_node_id = ? OR target_node_id = ?)',
          )
          .run(change.entityId, change.entityId);
        this.connection
          .prepare('DELETE FROM working_node_head WHERE node_id = ?')
          .run(change.entityId);
        this.connection
          .prepare('UPDATE node SET deleted_at = ? WHERE id = ?')
          .run(now, change.entityId);
        return null;
      case 'create_relation': {
        const item = payload as unknown as CreateRelationPayload;
        this.getNode(item.sourceNodeId);
        this.getNode(item.targetNodeId);
        const revisionId = randomUUID();
        this.connection
          .prepare(
            'INSERT INTO relation (id,relation_type,source_node_id,target_node_id,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)',
          )
          .run(change.entityId, item.relationType, item.sourceNodeId, item.targetNodeId, now);
        this.insertRelationRevision(
          revisionId,
          change.entityId,
          1,
          item.rationale ?? '',
          item.reviewState ?? 'clean',
          null,
          change.changeSetId,
          authorRef,
          now,
        );
        this.connection
          .prepare('INSERT INTO working_relation_head (relation_id,revision_id) VALUES (?,?)')
          .run(change.entityId, revisionId);
        return revisionId;
      }
      case 'revise_relation': {
        const item = payload as unknown as ReviseRelationPayload;
        const currentRow = this.connection
          .prepare(
            'SELECT r.* FROM working_relation_head h JOIN relation_revision r ON r.id=h.revision_id WHERE h.relation_id=?',
          )
          .get(change.entityId) as Row;
        const revisionId = randomUUID();
        this.insertRelationRevision(
          revisionId,
          change.entityId,
          Number(currentRow['revision_number']) + 1,
          item.rationale,
          item.reviewState ?? 'clean',
          String(currentRow['id']),
          change.changeSetId,
          authorRef,
          now,
        );
        this.connection
          .prepare('UPDATE working_relation_head SET revision_id = ? WHERE relation_id = ?')
          .run(revisionId, change.entityId);
        return revisionId;
      }
      case 'remove_relation':
        this.connection
          .prepare('DELETE FROM working_relation_head WHERE relation_id = ?')
          .run(change.entityId);
        this.connection
          .prepare('UPDATE relation SET deleted_at = ? WHERE id = ?')
          .run(now, change.entityId);
        return null;
    }
  }

  private insertNodeRevision(
    id: string,
    nodeId: string,
    revisionNumber: number,
    item: ReviseNodePayload,
    supersedes: string | null,
    changeSetId: string,
    authorRef: string,
    now: string,
  ): void {
    this.connection
      .prepare(
        `INSERT INTO node_revision
      (id,node_id,revision_number,display_title,content_text,roles_json,attributes_json,approval_state,epistemic_state,review_state,supersedes_revision_id,created_in_changeset_id,author_kind,author_ref,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'agent', ?, ?)`,
      )
      .run(
        id,
        nodeId,
        revisionNumber,
        item.displayTitle,
        item.contentText,
        JSON.stringify(item.roles),
        JSON.stringify(item.attributes),
        item.approvalState ?? 'tentative',
        item.epistemicState ?? null,
        item.reviewState ?? 'clean',
        supersedes,
        changeSetId,
        authorRef,
        now,
      );
  }

  private insertRelationRevision(
    id: string,
    relationId: string,
    revisionNumber: number,
    rationale: string,
    reviewState: string,
    supersedes: string | null,
    changeSetId: string,
    authorRef: string,
    now: string,
  ): void {
    this.connection
      .prepare(
        `INSERT INTO relation_revision
      (id,relation_id,revision_number,rationale,review_state,supersedes_revision_id,created_in_changeset_id,author_kind,author_ref,created_at)
      VALUES (?,?,?,?,?,?,?, 'agent', ?, ?)`,
      )
      .run(
        id,
        relationId,
        revisionNumber,
        rationale,
        reviewState,
        supersedes,
        changeSetId,
        authorRef,
        now,
      );
  }
}
