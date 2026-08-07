import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DelegationPolicyId, NodeId, WorkflowRun } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { DomainError, ProposalApplier, type Author } from '@treediagram/core';
import { makeTestWorkspace, quickNode, type TestWorkspace } from '../helpers/workspace.js';

/**
 * ProposalApplier 单元测试（IMPLEMENTATION_DESIGN §12.4）：
 * temp ref 解析、审批降级、proposalRef 唯一性、revise 类型不变、端点有效性、事务回滚。
 */

const agentAuthor: Author = { kind: 'agent', ref: 'test-model' };

function fakeRun(ws: TestWorkspace): WorkflowRun {
  const now = ws.clock.now();
  return {
    id: asId(randomUUID()),
    projectId: ws.project.id,
    changeSetId: null,
    workflowType: 'derive',
    targetNodeId: null,
    status: 'running',
    currentStep: 'running/apply_proposal',
    input: {},
    checkpoint: {},
    summary: null,
    error: null,
    provider: 'fake',
    model: 'test-model',
    providerResponseId: null,
    usage: null,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

interface NodeActionOverrides {
  operation?: 'create' | 'revise';
  logicalNodeId?: string | null;
  baseRevisionId?: string | null;
  nodeType?: string;
  roles?: string[];
  approvalSuggestion?: 'draft' | 'tentative' | 'ai_confirmed';
  attributes?: Record<string, unknown>;
}

function nodeAction(ref: string, overrides: NodeActionOverrides = {}) {
  return {
    proposalRef: ref,
    operation: overrides.operation ?? 'create',
    logicalNodeId: overrides.logicalNodeId ?? null,
    baseRevisionId: overrides.baseRevisionId ?? null,
    nodeType: overrides.nodeType ?? 'claim',
    displayTitle: `节点 ${ref}`,
    contentText: `内容 ${ref}`,
    roles: overrides.roles ?? [],
    attributes: overrides.attributes ?? {},
    approvalSuggestion: overrides.approvalSuggestion ?? 'tentative',
    epistemicState: 'assumed',
    rationale: '测试 rationale',
  };
}

function containsAction(ref: string, from: unknown, to: unknown) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from,
    to,
    rationale: '测试 rationale',
    attributes: {},
    approvalSuggestion: 'tentative',
  };
}

function proposal(nodeActions: unknown[], relationActions: unknown[], overrides = {}) {
  return {
    schemaVersion: 1,
    workflowType: 'derive',
    summary: '测试提案',
    nodeActions,
    relationActions,
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
    ...overrides,
  };
}

const NO_POLICY = { effectivePolicy: null };

describe('ProposalApplier（§12.4）', () => {
  it('create 节点 + proposal temp ref 关系端点解析', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    const run = fakeRun(ws);
    const result = applier.apply(
      ws.project,
      run,
      proposal(
        [nodeAction('parent'), nodeAction('child')],
        [
          containsAction(
            'r1',
            { refKind: 'proposal', ref: 'parent' },
            { refKind: 'proposal', ref: 'child' },
          ),
        ],
      ),
      NO_POLICY,
      agentAuthor,
    );
    expect(result.nodeCount).toBe(2);
    expect(result.relationCount).toBe(1);
    expect(result.downgradedCount).toBe(0);
    const relationRevision = ws.db.repos.relation.getRevisionById(
      result.appliedRelationRevisionIds[0]!,
    );
    expect(relationRevision?.fromNodeRevisionId).toBe(result.appliedNodeRevisionIds[0]);
    expect(relationRevision?.toNodeRevisionId).toBe(result.appliedNodeRevisionIds[1]);
    // 提案在事务内写入 live ChangeSet
    expect(ws.services.changeSets.getLive(ws.project)).not.toBeNull();
  });

  it('existing_revision 端点指向当前活动修订', () => {
    const ws = makeTestWorkspace();
    const parent = quickNode(ws, { title: '既有父节点' });
    const applier = new ProposalApplier(ws.ctx);
    const result = applier.apply(
      ws.project,
      fakeRun(ws),
      proposal(
        [nodeAction('child')],
        [
          containsAction(
            'r1',
            { refKind: 'existing_revision', ref: parent.revision.id },
            { refKind: 'proposal', ref: 'child' },
          ),
        ],
      ),
      NO_POLICY,
      agentAuthor,
    );
    const relationRevision = ws.db.repos.relation.getRevisionById(
      result.appliedRelationRevisionIds[0]!,
    );
    expect(relationRevision?.fromNodeRevisionId).toBe(parent.revision.id);
  });

  it('revise：类型不变时可修订既有节点', () => {
    const ws = makeTestWorkspace();
    const original = quickNode(ws, { title: '原始节点' });
    const applier = new ProposalApplier(ws.ctx);
    const result = applier.apply(
      ws.project,
      fakeRun(ws),
      proposal(
        [
          nodeAction('rev1', {
            operation: 'revise',
            logicalNodeId: original.node.id,
            baseRevisionId: original.revision.id,
          }),
        ],
        [],
      ),
      NO_POLICY,
      agentAuthor,
    );
    expect(result.nodeCount).toBe(1);
    const newRevision = ws.db.repos.node.getRevisionById(result.appliedNodeRevisionIds[0]!);
    expect(newRevision?.nodeId).toBe(original.node.id);
    expect(newRevision?.supersedesRevisionId).toBe(original.revision.id);
  });

  it('revise：改变 nodeType 抛 MODEL_OUTPUT_INVALID', () => {
    const ws = makeTestWorkspace();
    const goal = quickNode(ws, { nodeType: 'goal', title: '目标' });
    const applier = new ProposalApplier(ws.ctx);
    expect(() =>
      applier.apply(
        ws.project,
        fakeRun(ws),
        proposal(
          [
            nodeAction('rev1', {
              operation: 'revise',
              logicalNodeId: goal.node.id,
              baseRevisionId: goal.revision.id,
              nodeType: 'claim', // 原类型是 goal
            }),
          ],
          [],
        ),
        NO_POLICY,
        agentAuthor,
      ),
    ).toThrowError(DomainError);
  });

  it('proposalRef 重复抛 MODEL_OUTPUT_INVALID 且不写入任何内容', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    expect(() =>
      applier.apply(
        ws.project,
        fakeRun(ws),
        proposal([nodeAction('dup'), nodeAction('dup')], []),
        NO_POLICY,
        agentAuthor,
      ),
    ).toThrowError(DomainError);
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(0);
  });

  it('关系端点引用未知 proposalRef 抛 MODEL_OUTPUT_INVALID 且整体回滚', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    expect(() =>
      applier.apply(
        ws.project,
        fakeRun(ws),
        proposal(
          [nodeAction('child')],
          [
            containsAction(
              'r1',
              { refKind: 'proposal', ref: 'nonexistent' },
              { refKind: 'proposal', ref: 'child' },
            ),
          ],
        ),
        NO_POLICY,
        agentAuthor,
      ),
    ).toThrowError(DomainError);
    // 事务回滚：节点也不应残留
    expect(ws.db.repos.node.listNodesByProject(ws.project.id)).toHaveLength(0);
  });

  it('关系端点引用不活动的 existing_revision 抛 MODEL_OUTPUT_INVALID', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    expect(() =>
      applier.apply(
        ws.project,
        fakeRun(ws),
        proposal(
          [nodeAction('child')],
          [
            containsAction(
              'r1',
              { refKind: 'existing_revision', ref: randomUUID() },
              { refKind: 'proposal', ref: 'child' },
            ),
          ],
        ),
        NO_POLICY,
        agentAuthor,
      ),
    ).toThrowError(DomainError);
  });

  it('无托管策略时 ai_confirmed 降级为 tentative', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    const result = applier.apply(
      ws.project,
      fakeRun(ws),
      proposal([nodeAction('n1', { approvalSuggestion: 'ai_confirmed' })], []),
      NO_POLICY,
      agentAuthor,
    );
    expect(result.downgradedCount).toBe(1);
    const revision = ws.db.repos.node.getRevisionById(result.appliedNodeRevisionIds[0]!);
    expect(revision?.approvalState).toBe('tentative');
    expect(revision?.authorization).toBeNull();
  });

  it('ai_managed 策略下 ai_confirmed 保留并绑定授权', () => {
    const ws = makeTestWorkspace();
    const run = fakeRun(ws);
    const policy = {
      id: asId<DelegationPolicyId>(randomUUID()),
      projectId: ws.project.id,
      scopeNodeId: asId<NodeId>(randomUUID()),
      mode: 'ai_managed' as const,
      authorKind: 'user' as const,
      authorRef: null,
      createdAt: ws.clock.now(),
      revokedAt: null,
    };
    const applier = new ProposalApplier(ws.ctx);
    const result = applier.apply(
      ws.project,
      run,
      proposal([nodeAction('n1', { approvalSuggestion: 'ai_confirmed' })], []),
      { effectivePolicy: policy },
      agentAuthor,
    );
    expect(result.downgradedCount).toBe(0);
    const revision = ws.db.repos.node.getRevisionById(result.appliedNodeRevisionIds[0]!);
    expect(revision?.approvalState).toBe('ai_confirmed');
    expect(revision?.authorization).toEqual({ workflowRunId: run.id, policyId: policy.id });
  });

  it('schema 不合法（缺字段）抛 MODEL_OUTPUT_INVALID', () => {
    const ws = makeTestWorkspace();
    const applier = new ProposalApplier(ws.ctx);
    expect(() =>
      applier.apply(ws.project, fakeRun(ws), { schemaVersion: 1 }, NO_POLICY, agentAuthor),
    ).toThrowError(DomainError);
  });
});
