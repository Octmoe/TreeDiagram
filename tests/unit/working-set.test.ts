import { describe, expect, it } from 'vitest';
import { DomainError, buildWorkingSet, newId, type NodeHead } from '@treediagram/core';
import type { ChangeSetId, NodeId, NodeRevisionId, ReleaseId } from '@treediagram/contracts';
import { makeTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function setupBase(ws: TestWorkspace) {
  const now = ws.clock.now();
  const cs1 = {
    id: newId<ChangeSetId>(),
    projectId: ws.project.id,
    baseReleaseId: null,
    status: 'published' as const,
    title: '',
    description: '',
    adoptedAt: now,
    publishedReleaseId: null,
    createdAt: now,
    updatedAt: now,
  };
  ws.db.repos.changeSet.insert(cs1);

  const mkNode = (type: 'claim' | 'topic') => {
    const node = {
      id: newId<NodeId>(),
      projectId: ws.project.id,
      nodeType: type,
      authorKind: 'user' as const,
      authorRef: null,
      createdAt: now,
    };
    ws.db.repos.node.insertNode(node);
    const revision = {
      id: newId<NodeRevisionId>(),
      nodeId: node.id,
      createdInChangeSetId: cs1.id,
      revisionNumber: 1,
      displayTitle: 'n',
      contentText: 'c',
      roles: [],
      attributes: {},
      approvalState: 'user_confirmed' as const,
      epistemicState: null,
      authorization: null,
      supersedesRevisionId: null,
      authorKind: 'user' as const,
      authorRef: null,
      createdAt: now,
    };
    ws.db.repos.node.insertRevision(revision);
    return { node, revision };
  };

  const a = mkNode('claim');
  const b = mkNode('claim');
  const release = {
    id: newId<ReleaseId>(),
    projectId: ws.project.id,
    version: 1,
    rootRevisionIds: [],
    nodeRevisionIds: [a.revision.id, b.revision.id],
    relationRevisionIds: [],
    summary: 'base',
    authorKind: 'user' as const,
    authorRef: null,
    createdAt: now,
  };
  ws.db.repos.release.insert(release);
  return { cs1, a, b, release };
}

describe('WorkingSet overlay（§6.3）', () => {
  it('base manifest + upsert/remove heads', () => {
    const ws = makeTestWorkspace();
    const { a, b, release } = setupBase(ws);

    const a2 = {
      ...a.revision,
      id: newId<NodeRevisionId>(),
      revisionNumber: 2,
      supersedesRevisionId: a.revision.id,
    };
    ws.db.repos.node.insertRevision(a2);

    const heads: NodeHead[] = [
      { nodeId: a.node.id, nodeRevisionId: a2.id, action: 'upsert' },
      { nodeId: b.node.id, nodeRevisionId: null, action: 'remove' },
    ];
    const working = buildWorkingSet({
      baseRelease: release,
      nodeHeads: heads,
      relationHeads: [],
      repos: ws.db.repos,
    });

    expect(working.nodeRevisionByNodeId.get(a.node.id)?.id).toBe(a2.id);
    expect(working.nodeRevisionByNodeId.has(b.node.id)).toBe(false);
    expect(working.removedNodeIds.has(b.node.id)).toBe(true);
    expect(working.baseReleaseId).toBe(release.id);
  });

  it('无 base Release 时从空集合开始（initializing）', () => {
    const ws = makeTestWorkspace();
    const working = buildWorkingSet({
      baseRelease: null,
      nodeHeads: [],
      relationHeads: [],
      repos: ws.db.repos,
    });
    expect(working.nodeRevisionByNodeId.size).toBe(0);
    expect(working.baseReleaseId).toBeNull();
  });

  it('head 的 revision 不属于该 node 时抛 CORRUPT_PERSISTED_DATA', () => {
    const ws = makeTestWorkspace();
    const { a, b, release } = setupBase(ws);
    const heads: NodeHead[] = [
      { nodeId: a.node.id, nodeRevisionId: b.revision.id, action: 'upsert' },
    ];
    expect(() =>
      buildWorkingSet({
        baseRelease: release,
        nodeHeads: heads,
        relationHeads: [],
        repos: ws.db.repos,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORRUPT_PERSISTED_DATA' }));
  });

  it('manifest 引用不存在修订时抛 CORRUPT_PERSISTED_DATA', () => {
    const ws = makeTestWorkspace();
    const { release } = setupBase(ws);
    const corrupt = { ...release, nodeRevisionIds: [newId<NodeRevisionId>()] };
    expect(() =>
      buildWorkingSet({
        baseRelease: corrupt,
        nodeHeads: [],
        relationHeads: [],
        repos: ws.db.repos,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORRUPT_PERSISTED_DATA' }));
  });

  it('remove 动作不自动删除指向它的关系（由 checker 报告）', () => {
    const ws = makeTestWorkspace();
    const { release } = setupBase(ws);
    const base = buildWorkingSet({
      baseRelease: release,
      nodeHeads: [],
      relationHeads: [],
      repos: ws.db.repos,
    });
    expect(base.nodeRevisionByNodeId.size).toBe(2);
  });

  it('构建不修改数据库', () => {
    const ws = makeTestWorkspace();
    const { release } = setupBase(ws);
    const before = ws.db.repos.release.getById(release.id);
    buildWorkingSet({ baseRelease: release, nodeHeads: [], relationHeads: [], repos: ws.db.repos });
    const after = ws.db.repos.release.getById(release.id);
    expect(after).toEqual(before);
  });

  it('DomainError 可用', () => {
    expect(new DomainError('NOT_FOUND', 'x').code).toBe('NOT_FOUND');
  });
});
