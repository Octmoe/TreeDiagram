import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { AttentionService } from '@treediagram/attention';
import { CHANGESET_LEASE_IDLE_TIMEOUT_MS } from '@treediagram/contracts';
import { DomainError } from '@treediagram/domain';
import { initializeWorkspace, V2Store } from '@treediagram/storage-sqlite';
import { ToolService } from '@treediagram/mcp';
import { archiveAndClearWorkspace, createWorkspaceArchivePath } from '@treediagram/sidecar/server';

const tempDirs: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'treediagram-v2-test-'));
  tempDirs.push(dir);
  initializeWorkspace(dir, 'V2 test');
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('V2 workspace lifecycle', () => {
  it('allows a design-root candidate to be adopted without a parent in an empty tree', () => {
    const store = new V2Store(workspace());
    try {
      let changeSet = store.beginChangeSet('host-a', 'Create compatible root').changeSet;
      const root = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'goal',
          displayTitle: 'Compatible design root',
          contentText: '',
          roles: ['design-root'],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: null,
          reviewState: 'clean',
        },
        summary: 'Create compatible design root',
      });
      changeSet = root.changeSet;
      let grant = store.issueApprovalGrant('adopt', root.change.id, 'host-a');
      const adopted = store.adoptChange('host-a', root.change.id, grant.token);
      expect(adopted.adoptedChanges).toHaveLength(1);
      expect(store.getWorkspaceSummary()).toEqual(
        expect.objectContaining({ nodeCount: 1, relationCount: 0 }),
      );

      grant = store.issueApprovalGrant('confirm_root', root.change.entityId, 'host-a');
      changeSet = store.confirmRoot('host-a', root.change.entityId, grant.token).changeSet;
      const checked = store.validateChangeSet('host-a', changeSet.id, changeSet.version);
      expect(checked.validation.valid).toBe(true);
    } finally {
      store.close();
    }
  });

  it('archives and clears while another MCP-style database connection remains open', async () => {
    const dir = workspace();
    const statePath = join(dir, '.treediagram');
    const store = new V2Store(dir);
    const heldConnection = new V2Store(dir);
    store.beginChangeSet('archive-owner', 'Preserve this design history');
    const archivePath = createWorkspaceArchivePath(
      dir,
      'a761884f-45dc-4c32-a0b4-0ca8737fe49b',
      new Date('2026-08-11T08:09:10.000Z'),
    );
    expect(archivePath).toBe(join(dir, '.treediagram-archive', '20260811T080910Z-a761884f'));
    try {
      expect(await archiveAndClearWorkspace(store, dir, archivePath)).toBe(archivePath);
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(join(archivePath, 'workspace.json'))).toBe(true);
      expect(existsSync(join(archivePath, 'state-v2.sqlite'))).toBe(true);
      expect(existsSync(join(archivePath, 'archive.json'))).toBe(true);
      expect(store.getWorkspaceSummary()).toEqual(
        expect.objectContaining({
          activeChangeSetId: null,
          currentReleaseId: null,
          nodeCount: 0,
          relationCount: 0,
          consistency: 'empty',
        }),
      );
      expect(heldConnection.getWorkspaceSummary()).toEqual(
        expect.objectContaining({ activeChangeSetId: null, consistency: 'empty' }),
      );

      const restoreRoot = mkdtempSync(join(tmpdir(), 'treediagram-v2-archive-restore-'));
      tempDirs.push(restoreRoot);
      cpSync(archivePath, join(restoreRoot, '.treediagram'), { recursive: true });
      const restored = new V2Store(restoreRoot);
      try {
        expect(restored.getWorkspaceSummary()).toEqual(
          expect.objectContaining({
            activeChangeSetId: expect.any(String),
            consistency: 'empty',
          }),
        );
      } finally {
        restored.close();
      }
    } finally {
      heldConnection.close();
      store.close();
    }
  });

  it('refuses a legacy workspace without modifying it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'treediagram-legacy-guard-'));
    tempDirs.push(dir);
    const stateDir = join(dir, '.treediagram');
    mkdirSync(stateDir);
    const legacy = join(stateDir, 'state.sqlite');
    writeFileSync(legacy, 'legacy-sentinel');
    expect(() => initializeWorkspace(dir, 'must-not-write')).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WORKSPACE_VERSION' }),
    );
    expect(() => new V2Store(dir)).toThrow(DomainError);
  });

  it('adds the lease handoff table when opening an earlier V2 workspace', () => {
    const dir = workspace();
    const previous = new V2Store(dir);
    previous.connection.exec('DROP TABLE changeset_lease_handoff_request');
    previous.close();

    const migrated = new V2Store(dir);
    try {
      const table = migrated.connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'changeset_lease_handoff_request'",
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe('changeset_lease_handoff_request');
    } finally {
      migrated.close();
    }
  });

  it('enforces lease, version, target-bound Grant and publishes an immutable release', async () => {
    const store = new V2Store(workspace());
    try {
      const tools = new ToolService(store);
      let changeSet = store.beginChangeSet('host-a', 'First design').changeSet;
      expect(() => store.beginChangeSet('host-b', 'Competing design')).toThrowError(
        expect.objectContaining({ code: 'CHANGESET_WRITE_LOCKED' }),
      );

      const malformed = await tools.call('design_change_propose', {
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: { nodeType: 'goal' },
        summary: 'broken',
      });
      expect(malformed).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            category: 'agent_recoverable',
            path: expect.stringMatching(/^\/payload/),
          }),
        }),
      );

      const root = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'goal',
          displayTitle: 'Persistent alignment',
          contentText: 'Keep design intent visible.',
          roles: ['root'],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: null,
          reviewState: 'clean',
        },
        summary: 'Create root',
      });
      changeSet = root.changeSet;
      const staleGrant = store.issueApprovalGrant('adopt', root.change.id, 'host-a');

      const child = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'constraint',
          displayTitle: 'Selection is context only',
          contentText: '',
          roles: [],
          attributes: { strength: 'hard' },
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Create constraint',
      });
      changeSet = child.changeSet;
      let grant = store.issueApprovalGrant('adopt', child.change.id, 'host-a');
      expect(() => store.adoptChange('host-a', child.change.id, grant.token)).toThrowError(
        expect.objectContaining({ code: 'CONTAINS_PARENT_REQUIRED' }),
      );
      const relation = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_relation',
        payload: {
          relationType: 'contains',
          sourceNodeId: root.change.entityId,
          targetNodeId: child.change.entityId,
          rationale: 'Root contains constraint',
          reviewState: 'clean',
        },
        summary: 'Connect root',
      });
      changeSet = relation.changeSet;
      expect(() => store.adoptChange('host-a', root.change.id, staleGrant.token)).toThrowError(
        expect.objectContaining({ code: 'APPROVAL_GRANT_STALE' }),
      );

      grant = store.issueApprovalGrant('adopt', root.change.id, 'host-a');
      changeSet = store.adoptChange('host-a', root.change.id, grant.token).changeSet;
      expect(() => store.adoptChange('host-a', root.change.id, grant.token)).toThrowError(
        expect.objectContaining({ code: 'APPROVAL_GRANT_CONSUMED' }),
      );
      grant = store.issueApprovalGrant('confirm_root', root.change.entityId, 'host-a');
      changeSet = store.confirmRoot('host-a', root.change.entityId, grant.token).changeSet;
      grant = store.issueApprovalGrant('adopt', child.change.id, 'host-a');
      const childAdoption = store.adoptChange('host-a', child.change.id, grant.token);
      changeSet = childAdoption.changeSet;
      expect(childAdoption.adoptedChanges.map((change) => change.id)).toEqual([
        child.change.id,
        relation.change.id,
      ]);

      const checked = store.validateChangeSet('host-a', changeSet.id, changeSet.version);
      expect(checked.validation.valid).toBe(true);
      const publish = store.issueApprovalGrant('publish', checked.changeSet.id, 'host-a');
      const release = store.publishRelease(
        'host-a',
        checked.changeSet.id,
        publish.token,
        'First stable design',
      );
      expect(release.version).toBe(1);
      expect(release.nodeRevisionIds).toHaveLength(2);
      expect(store.getWorkspaceSummary()).toEqual(
        expect.objectContaining({ currentReleaseVersion: 1, consistency: 'valid' }),
      );
      expect(() => store.getChangeSet()).toThrowError(
        expect.objectContaining({ code: 'CHANGESET_NOT_FOUND' }),
      );
    } finally {
      store.close();
    }
  });

  it('recovers restart-orphaned and idle-expired leases without losing the ChangeSet', () => {
    const store = new V2Store(workspace());
    try {
      let changeSet = store.beginChangeSet('old-session', 'Recoverable design').changeSet;
      const proposed = store.proposeChange({
        hostSessionRef: 'old-session',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'risk',
          displayTitle: 'Preserve this candidate',
          contentText: 'Lease recovery must not discard pending work.',
          roles: ['finding'],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'supported',
          reviewState: 'clean',
        },
        summary: 'Keep pending work during recovery',
      });
      changeSet = proposed.changeSet;

      expect(store.getLeaseStatus(changeSet.id, 'new-session').state).toBe('foreign_active');
      const beforeSystemBoot = new Date(Date.now() - uptime() * 1000 - 2 * 60_000).toISOString();
      store.connection
        .prepare('UPDATE changeset_write_lease SET renewed_at = ? WHERE changeset_id = ?')
        .run(beforeSystemBoot, changeSet.id);
      expect(store.getLeaseStatus(changeSet.id, 'new-session')).toEqual(
        expect.objectContaining({
          state: 'reclaimable',
          reason: 'previous_system_boot',
          canReclaim: true,
        }),
      );

      const recovered = store.beginChangeSet('new-session', 'Must not replace existing work');
      expect(recovered).toEqual(
        expect.objectContaining({
          recoveredLease: true,
          recoveryReason: 'previous_system_boot',
          changeSet: expect.objectContaining({ id: changeSet.id, version: changeSet.version }),
          lease: expect.objectContaining({ ownerHostSessionRef: 'new-session' }),
        }),
      );
      expect(recovered.changeSet.changes).toEqual([
        expect.objectContaining({ id: proposed.change.id, status: 'proposed' }),
      ]);

      const idleExpiredAt = new Date(
        Date.now() - CHANGESET_LEASE_IDLE_TIMEOUT_MS - 60_000,
      ).toISOString();
      store.connection
        .prepare(
          'UPDATE changeset_write_lease SET owner_host_session_ref = ?, renewed_at = ? WHERE changeset_id = ?',
        )
        .run('idle-session', idleExpiredAt, changeSet.id);
      expect(store.getLeaseStatus(changeSet.id, 'write-session').state).toBe('reclaimable');
      const afterRecovery = store.proposeChange({
        hostSessionRef: 'write-session',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'question',
          displayTitle: 'Continue after recovery',
          contentText: '',
          roles: [],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Verify direct write recovery',
      });
      expect(afterRecovery.changeSet.changes).toHaveLength(2);
      expect(store.getLease(changeSet.id)).toEqual(
        expect.objectContaining({ ownerHostSessionRef: 'write-session' }),
      );
    } finally {
      store.close();
    }
  });

  it('hands an active lease to a requesting Agent only after a fresh Sidecar approval', () => {
    const store = new V2Store(workspace());
    try {
      let changeSet = store.beginChangeSet('sidecar-session', 'Handoff design').changeSet;
      const request = store.requestLeaseHandoff(
        'agent-session',
        changeSet.id,
        'Submit the selected product-shape candidate and its constraint.',
      );
      expect(request).toEqual(
        expect.objectContaining({
          requesterHostSessionRef: 'agent-session',
          ownerHostSessionRef: 'sidecar-session',
          changeSetVersion: changeSet.version,
          status: 'pending',
        }),
      );
      expect(store.getLeaseStatus(changeSet.id, 'agent-session').state).toBe('foreign_active');
      expect(store.listPendingLeaseHandoffRequests(changeSet.id)).toEqual([
        expect.objectContaining({ id: request.id }),
      ]);

      const approved = store.approveLeaseHandoff('sidecar-session', request.id);
      expect(approved.lease.ownerHostSessionRef).toBe('agent-session');
      expect(approved.request).toEqual(
        expect.objectContaining({
          status: 'approved',
          resolvedByHostSessionRef: 'sidecar-session',
        }),
      );
      expect(store.getLeaseStatus(changeSet.id, 'agent-session').state).toBe('owned');
      expect(store.listPendingLeaseHandoffRequests(changeSet.id)).toEqual([]);

      const grant = store.issueApprovalGrant('take_lease', changeSet.id, 'sidecar-session');
      store.takeLease('sidecar-session', changeSet.id, grant.token);
      const staleRequest = store.requestLeaseHandoff(
        'agent-session',
        changeSet.id,
        'Retry after the owner changed.',
      );
      const ownerChange = store.proposeChange({
        hostSessionRef: 'sidecar-session',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'question',
          displayTitle: 'Change while request waits',
          contentText: '',
          roles: [],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Invalidate the pending handoff request',
      });
      changeSet = ownerChange.changeSet;
      expect(store.listPendingLeaseHandoffRequests(changeSet.id)).toEqual([]);
      expect(() => store.approveLeaseHandoff('sidecar-session', staleRequest.id)).toThrowError(
        expect.objectContaining({ code: 'LEASE_HANDOFF_REQUEST_STALE' }),
      );
    } finally {
      store.close();
    }
  });

  it('isolates Attention per session and requires explicit cross-session restore', () => {
    const store = new V2Store(workspace());
    try {
      const attention = new AttentionService(store);
      const beforeNodes = store.getWorkspaceSummary().nodeCount;
      const first = attention.set({
        hostKind: 'codex',
        hostSessionRef: 'session-a',
        clientRef: 'client-1',
        selectedNodeIds: [],
        pinnedNodeIds: [],
        scope: 'node',
        intentHint: 'first',
        expectedVersion: 0,
      });
      expect(
        attention.get({ hostKind: 'codex', hostSessionRef: 'session-b', clientRef: 'client-1' }),
      ).toBeNull();
      expect(attention.listRecoveryCandidates('codex', 'session-b')[0]?.id).toBe(first.id);
      const restored = attention.restore(first.id, {
        hostKind: 'codex',
        hostSessionRef: 'session-b',
        clientRef: 'client-1',
      });
      expect(restored.id).not.toBe(first.id);
      expect(restored.hostSessionRef).toBe('session-b');
      expect(() =>
        attention.set({
          hostKind: 'codex',
          hostSessionRef: 'session-b',
          clientRef: 'client-1',
          expectedVersion: 0,
        }),
      ).toThrowError(expect.objectContaining({ code: 'ATTENTION_VERSION_CONFLICT' }));
      expect(store.getWorkspaceSummary().nodeCount).toBe(beforeNodes);
    } finally {
      store.close();
    }
  });

  it('exposes user-selected candidates as explicit Agent-visible context', async () => {
    const store = new V2Store(workspace());
    try {
      const tools = new ToolService(store);
      let changeSet = store.beginChangeSet('focus-session', 'Candidate focus').changeSet;
      const candidate = store.proposeChange({
        hostSessionRef: 'focus-session',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'goal',
          displayTitle: 'Agent-visible candidate',
          contentText: 'The user explicitly selected this candidate.',
          roles: ['root'],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Create visible candidate',
      });
      changeSet = candidate.changeSet;
      const attention = new AttentionService(store).set({
        hostKind: 'codex',
        hostSessionRef: 'focus-session',
        clientRef: 'codex-agent',
        primaryChangeId: candidate.change.id,
        selectedChangeIds: [candidate.change.id],
        selectedNodeIds: [],
        scope: 'node',
        expectedVersion: 0,
      });
      expect(attention).toEqual(
        expect.objectContaining({
          primaryNodeId: null,
          primaryChangeId: candidate.change.id,
          selectedChangeIds: [candidate.change.id],
        }),
      );

      const read = await tools.call('attention_get', {
        hostKind: 'codex',
        hostSessionRef: 'new-agent-task',
        clientRef: 'codex-agent',
      });
      expect(read).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            hostSessionRef: 'focus-session',
            primaryChangeId: candidate.change.id,
          }),
          summary: expect.stringContaining('来自当前项目最近操作的 Sidecar 会话'),
        }),
      );
      const context = await tools.call('design_context_get', {
        hostKind: 'codex',
        hostSessionRef: 'new-agent-task',
        clientRef: 'codex-agent',
        maxTokens: 4000,
      });
      expect(context).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            attention: expect.objectContaining({ hostSessionRef: 'focus-session' }),
            selectedChanges: [expect.objectContaining({ id: candidate.change.id })],
            pendingChanges: [expect.objectContaining({ id: candidate.change.id })],
          }),
          summary: expect.stringContaining('来自最近操作的 Sidecar 会话'),
        }),
      );
      expect(changeSet.version).toBe(candidate.changeSet.version);
    } finally {
      store.close();
    }
  });

  it('migrates existing V2 Attention tables without losing the workspace', () => {
    const dir = workspace();
    const before = new V2Store(dir);
    before.connection.exec(
      'ALTER TABLE attention_context DROP COLUMN selected_change_ids_json; ALTER TABLE attention_context DROP COLUMN primary_change_id;',
    );
    before.close();

    const migrated = new V2Store(dir);
    try {
      const columns = (
        migrated.connection.pragma('table_info(attention_context)') as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain('primary_change_id');
      expect(columns).toContain('selected_change_ids_json');
      expect(migrated.getWorkspaceSummary().nodeCount).toBe(0);
    } finally {
      migrated.close();
    }
  });

  it('enforces parent-first approval and atomically adopts or discards child contains links', () => {
    const store = new V2Store(workspace());
    try {
      let changeSet = store.beginChangeSet('host-a', 'Dependency order').changeSet;
      const root = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'goal',
          displayTitle: 'Dependency root',
          contentText: '',
          roles: ['root'],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: null,
          reviewState: 'clean',
        },
        summary: 'Create dependency root',
      });
      changeSet = root.changeSet;
      const child = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'constraint',
          displayTitle: 'Dependency child',
          contentText: '',
          roles: [],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Create dependency child',
      });
      changeSet = child.changeSet;
      const relation = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_relation',
        payload: {
          relationType: 'contains',
          sourceNodeId: root.change.entityId,
          targetNodeId: child.change.entityId,
          rationale: 'Attach child',
          reviewState: 'clean',
        },
        summary: 'Attach dependency child',
      });
      changeSet = relation.changeSet;

      let grant = store.issueApprovalGrant('adopt', relation.change.id, 'host-a');
      expect(() => store.adoptChange('host-a', relation.change.id, grant.token)).toThrowError(
        expect.objectContaining({ code: 'CONTAINS_ADOPT_WITH_CHILD' }),
      );
      grant = store.issueApprovalGrant('adopt', child.change.id, 'host-a');
      expect(() => store.adoptChange('host-a', child.change.id, grant.token)).toThrowError(
        expect.objectContaining({ code: 'PARENT_NODE_PENDING' }),
      );
      expect(() => store.validateChangeSet('host-a', changeSet.id, changeSet.version)).toThrowError(
        expect.objectContaining({ code: 'CHANGESET_HAS_PENDING_CHANGES' }),
      );

      grant = store.issueApprovalGrant('adopt', root.change.id, 'host-a');
      changeSet = store.adoptChange('host-a', root.change.id, grant.token).changeSet;
      grant = store.issueApprovalGrant('adopt', child.change.id, 'host-a');
      const adopted = store.adoptChange('host-a', child.change.id, grant.token);
      changeSet = adopted.changeSet;
      expect(adopted.adoptedChanges.map((change) => change.id)).toEqual([
        child.change.id,
        relation.change.id,
      ]);
      expect(changeSet.changes?.filter((change) => change.status === 'proposed')).toHaveLength(0);

      const disposableChild = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_node',
        payload: {
          nodeType: 'risk',
          displayTitle: 'Disposable child',
          contentText: '',
          roles: [],
          attributes: {},
          approvalState: 'tentative',
          epistemicState: 'assumed',
          reviewState: 'clean',
        },
        summary: 'Create disposable child',
      });
      changeSet = disposableChild.changeSet;
      const disposableContains = store.proposeChange({
        hostSessionRef: 'host-a',
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_relation',
        payload: {
          relationType: 'contains',
          sourceNodeId: root.change.entityId,
          targetNodeId: disposableChild.change.entityId,
          rationale: 'Temporary attachment',
          reviewState: 'clean',
        },
        summary: 'Attach disposable child',
      });
      changeSet = store.discardChange(
        'host-a',
        disposableChild.change.id,
        disposableContains.changeSet.version,
      );
      expect(
        changeSet.changes
          ?.filter((change) =>
            [disposableChild.change.id, disposableContains.change.id].includes(change.id),
          )
          .map((change) => change.status),
      ).toEqual(['discarded', 'discarded']);
    } finally {
      store.close();
    }
  });
});
