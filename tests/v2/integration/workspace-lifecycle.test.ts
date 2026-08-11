import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttentionService } from '@treediagram/attention';
import { DomainError } from '@treediagram/domain';
import { initializeWorkspace, V2Store } from '@treediagram/storage-sqlite';
import { ToolService } from '@treediagram/mcp';

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
